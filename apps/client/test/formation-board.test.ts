/**
 * The Formation board's geometry is not hand-drawn: it is computed from the
 * grid the simulation actually publishes. These tests pin it to the numbers
 * `codex-examples/realm-refined/strategy.html` draws by hand, so a computed
 * board and the approved one are the same board.
 *
 * Every expected value below is read off the mockup's own markup:
 * `#f-cell` is the diamond `M0-31 62 0 0 31-62 0Z`; the cells it places are at
 * `translate(380 250)` ("row 3, column 3" = 0-indexed (2,2)),
 * `translate(318 281)` ("row 4 column 3" = (2,3)) and
 * `translate(194 281)` ("row 5 column 2" = (1,4)); the board outline is
 * `M380 95 690 250 380 405 70 250Z`; the party half is
 * `M194 188 504 343 380 405 70 250Z`; the neutral lane is
 * `M256 157 566 312 504 343 194 188Z`.
 */
import { describe, expect, test } from 'vitest';
import { boardOutline, cellCentre, rowBand, HALF_HEIGHT, HALF_WIDTH } from '../src/hud/strategy/board';

const GRID = { width: 5, height: 5, playerRows: [3, 4], enemyRows: [0, 1] };

describe('the formation board projection', () => {
  test('a cell lands where the mockup draws it', () => {
    expect(cellCentre(2, 2)).toEqual({ x: 380, y: 250 });
    expect(cellCentre(2, 3)).toEqual({ x: 318, y: 281 });
    expect(cellCentre(1, 4)).toEqual({ x: 194, y: 281 });
  });

  test('the diamond is the mockup’s #f-cell: 124 wide, 62 tall', () => {
    expect(HALF_WIDTH).toBe(62);
    expect(HALF_HEIGHT).toBe(31);
  });

  test('the board outline is the mockup’s tile quad', () => {
    expect(boardOutline(GRID)).toEqual([
      { x: 380, y: 95 },
      { x: 690, y: 250 },
      { x: 380, y: 405 },
      { x: 70, y: 250 },
    ]);
  });

  test('the party rows shade exactly the mockup’s ally half', () => {
    expect(rowBand(GRID, 3, 4)).toEqual([
      { x: 194, y: 188 },
      { x: 504, y: 343 },
      { x: 380, y: 405 },
      { x: 70, y: 250 },
    ]);
  });

  test('the neutral lane is the one row that is neither side’s', () => {
    expect(rowBand(GRID, 2, 2)).toEqual([
      { x: 256, y: 157 },
      { x: 566, y: 312 },
      { x: 504, y: 343 },
      { x: 194, y: 188 },
    ]);
  });

  test('a band of the enemy rows is the mockup’s far shading', () => {
    expect(rowBand(GRID, 0, 1)).toEqual([
      { x: 380, y: 95 },
      { x: 690, y: 250 },
      { x: 566, y: 312 },
      { x: 256, y: 157 },
    ]);
  });
});
