import { shapeOffsets } from '@narok/data';
import type { ClassId, Content, GridConfig, ShapeId } from '@narok/data';
import { SimError } from '../errors';
import type { Actor, ActorId, PositionId } from '../types';
import type { Battlefield } from './types';

const POSITION_PATTERN = /^(\d+),(\d+)$/;

/** Encodes board coordinates as an opaque {@link PositionId}. Zero-based, non-negative. */
export function gridPosition(column: number, row: number): PositionId {
  return `${column},${row}` as PositionId;
}

/** Decodes a {@link PositionId} back into board coordinates. Throws on malformed input. */
export function gridCoordinates(position: PositionId): { column: number; row: number } {
  const match = POSITION_PATTERN.exec(position);
  if (!match) {
    throw new SimError('INVALID_INPUT', 'position', `malformed position id "${position}"`);
  }
  return { column: Number(match[1]), row: Number(match[2]) };
}

/** Neighbor exploration order for BFS: up, left, right, down. */
function neighborsOf(column: number, row: number): [number, number][] {
  return [
    [column, row - 1],
    [column - 1, row],
    [column + 1, row],
    [column, row + 1],
  ];
}

/**
 * Builds a {@link Battlefield} for the given grid geometry. Coordinates exist only in
 * this adapter (plus fixture construction and the renderer); combat consumes actor IDs
 * and opaque {@link PositionId} values only. Omitted `shapes` default to the prototype's
 * exported offsets; application/CLI composition should pass the bound content's shapes.
 */
export function createGrid(config: GridConfig, shapes: Content['shapes'] = shapeOffsets): Battlefield {
  const inBounds = (column: number, row: number): boolean =>
    column >= 0 && column < config.width && row >= 0 && row < config.height;

  function distance(a: PositionId, b: PositionId): number {
    const ca = gridCoordinates(a);
    const cb = gridCoordinates(b);
    return Math.abs(ca.column - cb.column) + Math.abs(ca.row - cb.row);
  }

  function inRange(a: PositionId, b: PositionId, range: number): boolean {
    return distance(a, b) <= range;
  }

  function placementSlots(side: Actor['side']): PositionId[] {
    const rows = [...(side === 'party' ? config.playerRows : config.enemyRows)].sort((a, b) => a - b);
    const slots: PositionId[] = [];
    for (const row of rows) {
      for (let column = 0; column < config.width; column++) {
        slots.push(gridPosition(column, row));
      }
    }
    return slots;
  }

  function nextStep(actor: Actor, target: Actor, range: number, actors: Actor[]): PositionId | null {
    if (inRange(actor.position, target.position, range)) return null;

    const occupied = new Set<string>([target.position]);
    for (const other of actors) {
      if (other.hp <= 0) continue;
      if (other.id === actor.id) continue;
      occupied.add(other.position);
    }

    const start = gridCoordinates(actor.position);
    const visited = new Set<string>([actor.position]);
    const queue: { column: number; row: number; firstStep: PositionId | null }[] = [
      { column: start.column, row: start.row, firstStep: null },
    ];

    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const [column, row] of neighborsOf(node.column, node.row)) {
        if (!inBounds(column, row)) continue;
        const id = gridPosition(column, row);
        if (visited.has(id)) continue;
        if (occupied.has(id)) continue;
        visited.add(id);
        const firstStep = node.firstStep ?? id;
        if (inRange(id, target.position, range)) return firstStep;
        queue.push({ column, row, firstStep });
      }
    }
    return null;
  }

  function canReach(actor: Actor, target: Actor, range: number, actors: Actor[]): boolean {
    if (inRange(actor.position, target.position, range)) return true;
    return nextStep(actor, target, range, actors) !== null;
  }

  function affected(primary: Actor, shape: ShapeId, eligible: Actor[]): ActorId[] {
    const offsets = shapes[shape];
    const anchor = gridCoordinates(primary.position);
    const cells = new Set<string>();
    for (const [deltaColumn, deltaRow] of offsets) {
      const column = anchor.column + deltaColumn;
      const row = anchor.row + deltaRow;
      if (!inBounds(column, row)) continue;
      cells.add(gridPosition(column, row));
    }
    return eligible
      .filter((entry) => entry.hp > 0 && cells.has(entry.position))
      .map((entry) => entry.id)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  function validatePlacement(positions: PositionId[], side: Actor['side']): void {
    if (positions.length === 0) {
      throw new SimError('INVALID_INPUT', 'placement', 'expected at least one placement position');
    }
    if (side === 'enemy' && positions.length > config.maxEnemies) {
      throw new SimError(
        'INVALID_INPUT',
        'placement',
        `expected at most ${config.maxEnemies} enemy positions`,
      );
    }
    const zoneRows = side === 'party' ? config.playerRows : config.enemyRows;
    const seen = new Set<string>();
    positions.forEach((position, index) => {
      const field = `placement.${index}`;
      if (seen.has(position)) {
        throw new SimError('INVALID_INPUT', field, `duplicate position ${position}`);
      }
      seen.add(position);
      const { column, row } = gridCoordinates(position);
      if (!inBounds(column, row)) {
        throw new SimError('INVALID_INPUT', field, `position ${position} is out of board`);
      }
      if (!zoneRows.includes(row)) {
        throw new SimError('INVALID_INPUT', field, `position ${position} is outside the ${side} zone`);
      }
    });
  }

  return { distance, inRange, placementSlots, nextStep, canReach, affected, validatePlacement };
}

/**
 * Default party placement per spec §8: the first Guardian (if any) takes `(2,3)`;
 * every other roster member takes the next unoccupied cell from
 * `(1,4),(3,4),(2,4)` in roster order. With no Guardian, all members draw from
 * that same three-cell list. Actor ids follow roster order (`p0`, `p1`, ...).
 */
export function defaultPlacement(classes: ClassId[]): Record<ActorId, PositionId> {
  const placement: Record<ActorId, PositionId> = {};
  const occupied = new Set<PositionId>();
  const guardianIndex = classes.indexOf('guardian');
  if (guardianIndex !== -1) {
    const position = gridPosition(2, 3);
    placement[`p${guardianIndex}`] = position;
    occupied.add(position);
  }
  const candidates = [gridPosition(1, 4), gridPosition(3, 4), gridPosition(2, 4)];
  let candidateIndex = 0;
  classes.forEach((_, index) => {
    if (index === guardianIndex) return;
    while (candidateIndex < candidates.length && occupied.has(candidates[candidateIndex])) {
      candidateIndex++;
    }
    const position = candidates[candidateIndex];
    placement[`p${index}`] = position;
    occupied.add(position);
    candidateIndex++;
  });
  return placement;
}
