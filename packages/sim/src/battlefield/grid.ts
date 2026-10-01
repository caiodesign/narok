import { defaultPlacement, gridCoordinates, gridPosition, PositionError, shapeOffsets } from '@narok/data';
import type { Content, GridConfig, ShapeId } from '@narok/data';
import { SimError } from '../errors';
import type { Actor, ActorId, PositionId } from '../types';
import type { Battlefield } from './types';

/**
 * The position codec lives in `@narok/data` (ruling R163) and is re-exported
 * from here unchanged, so `./battlefield/grid` keeps serving every importer.
 */
export { gridCoordinates, gridPosition, defaultPlacement };

/**
 * Decodes a position the caller supplied, raising the engine's own error
 * (ruling R165): a malformed id is `INVALID_INPUT` at field `position` with the
 * codec's message — exactly the `SimError` the codec raised before it moved —
 * so `validatePendingRules` can still re-field it under `pendingRules`.
 */
function decodeInput(position: PositionId): { column: number; row: number } {
  try {
    return gridCoordinates(position);
  } catch (error) {
    if (error instanceof PositionError) throw new SimError(error.code, error.field, error.message);
    throw error;
  }
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
      const { column, row } = decodeInput(position);
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
