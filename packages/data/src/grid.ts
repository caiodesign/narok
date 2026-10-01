/**
 * The position codec and the default party placement (ruling R163).
 *
 * Both are content, not engine: the codec is the board's own coordinate
 * notation and the placement is spec §8's seating, built from nothing but the
 * roster's class ids. They live here, beside `GridConfig` and
 * `shapeOffsets`, so a client that ships no simulation can still draw a board
 * and seat a setup draft. `@narok/sim` imports and re-exports all three
 * unchanged — there is one implementation and no copy.
 *
 * R106's intent is untouched: decoding stays out of the resolver, the strategy
 * layer and the log. Its letter now reads "any component that draws a spatial
 * view" (the battlefield adapter, the renderers and the setup board).
 */
import type { ActorId, ClassId, PositionId } from './types';

const POSITION_PATTERN = /^(\d+),(\d+)$/;

/**
 * Thrown by {@link gridCoordinates} on a malformed id (ruling R165). It carries
 * the same code, field and message the engine's `SimError` did, and the
 * simulation translates it back into exactly that `SimError` at its boundary,
 * so no error the simulation raises changes.
 */
export class PositionError extends Error {
  readonly code = 'INVALID_INPUT' as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'PositionError';
    this.field = field;
  }
}

/** Encodes board coordinates as an opaque {@link PositionId}. Zero-based, non-negative. */
export function gridPosition(column: number, row: number): PositionId {
  return `${column},${row}` as PositionId;
}

/** Decodes a {@link PositionId} back into board coordinates. Throws {@link PositionError} on malformed input. */
export function gridCoordinates(position: PositionId): { column: number; row: number } {
  const match = POSITION_PATTERN.exec(position);
  if (!match) {
    throw new PositionError('position', `malformed position id "${position}"`);
  }
  return { column: Number(match[1]), row: Number(match[2]) };
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
