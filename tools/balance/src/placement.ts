import type { ClassId } from '@narok/data';
import { defaultPlacement, gridPosition } from '@narok/sim';
import type { ActorId, PositionId } from '@narok/sim';
import type { PlacementName } from './types';

/** Front-line cells in roster order (spec §12, rulings R47/R48). */
const FRONT_CELLS: readonly [number, number][] = [[1, 3], [2, 3], [3, 3]];
/** Spread cells in roster order (spec §12, rulings R47/R48). */
const SPREAD_CELLS: readonly [number, number][] = [[0, 3], [2, 4], [4, 3]];

/**
 * Builds a party placement by name (rulings R48): `default` defers to the sim's own
 * class-aware `defaultPlacement`; `front`/`spread` assign the named fixed cells in
 * roster order, truncated to the roster size (both lists already hold exactly the
 * maximum roster size of three, so "truncated" just means "sliced to `classes.length`
 * by `forEach` never running past it").
 */
export function buildPlacement(name: PlacementName, classes: ClassId[]): Record<ActorId, PositionId> {
  if (name === 'default') return defaultPlacement(classes);
  const cells = name === 'front' ? FRONT_CELLS : SPREAD_CELLS;
  const placement: Record<ActorId, PositionId> = {};
  classes.forEach((_classId, index) => {
    const [column, row] = cells[index];
    placement[`p${index}`] = gridPosition(column, row);
  });
  return placement;
}

/**
 * Deterministic, order-independent placement serialization used for the CSV
 * `placement` field: sorted `id:position` pairs joined with `;`. Derivable purely
 * from `LabInput.placement`, so it stays correct for any placement — named preset or
 * otherwise — without `runBatch` needing to know which preset built it.
 */
export function formatPlacement(placement: Record<ActorId, PositionId>): string {
  return Object.keys(placement)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((id) => `${id}:${placement[id]}`)
    .join(';');
}
