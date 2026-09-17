import { expect, test } from 'vitest';
import { createGrid, defaultPlacement, gridPosition as pos } from '../src/battlefield/grid';
import { SimError } from '../src/errors';
import { actor } from './fixtures';
import type { GridConfig } from '@narok/data';

const defaultGrid: GridConfig = {
  width: 5, height: 5, playerRows: [3,4], enemyRows: [0,1], moveMs: 500, maxEnemies: 5,
};

function expectSimError(action: () => void): SimError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SimError);
    return error as SimError;
  }
  throw new Error('expected action to throw a SimError');
}

test('takes the deterministic detour around a friendly blocker', () => {
  const grid = createGrid({ width: 5, height: 5, playerRows: [3,4],
    enemyRows: [0,1], moveMs: 500, maxEnemies: 5 });
  const mover = actor({ id: 'p0', position: pos(2,3) });
  const blocker = actor({ id: 'p1', position: pos(2,2) });
  const target = actor({ id: 'e0', side: 'enemy', position: pos(2,1) });
  expect(grid.nextStep(mover, target, 1, [mover,blocker,target])).toBe(pos(1,3));
});
test('square clips at the right edge without wrapping', () => {
  const grid = createGrid({ width: 5, height: 5, playerRows: [3,4],
    enemyRows: [0,1], moveMs: 500, maxEnemies: 5 });
  const a = actor({ id: 'e0', side: 'enemy', position: pos(4,0) });
  const b = actor({ id: 'e1', side: 'enemy', position: pos(0,1) });
  const c = actor({ id: 'e2', side: 'enemy', position: pos(4,1) });
  expect(grid.affected(a, 'square', [a,b,c])).toEqual(['e0','e2']);
});

test('a target already in range is reachable even when surrounded', () => {
  const grid = createGrid(defaultGrid);
  const mover = actor({ id: 'p0', position: pos(2,2) });
  const target = actor({ id: 'e0', side: 'enemy', position: pos(2,1) });
  const surroundUp = actor({ id: 'e1', side: 'enemy', position: pos(2,0) });
  const surroundLeft = actor({ id: 'e2', side: 'enemy', position: pos(1,1) });
  const surroundRight = actor({ id: 'e3', side: 'enemy', position: pos(3,1) });
  const actors = [mover, target, surroundUp, surroundLeft, surroundRight];
  expect(grid.nextStep(mover, target, 1, actors)).toBeNull();
  expect(grid.canReach(mover, target, 1, actors)).toBe(true);
});

test('returns null and cannot reach when every in-range cell is occupied', () => {
  const grid = createGrid(defaultGrid);
  const mover = actor({ id: 'p0', position: pos(2,4) });
  const target = actor({ id: 'e0', side: 'enemy', position: pos(2,1) });
  const blockUp = actor({ id: 'e1', side: 'enemy', position: pos(2,0) });
  const blockLeft = actor({ id: 'e2', side: 'enemy', position: pos(1,1) });
  const blockRight = actor({ id: 'e3', side: 'enemy', position: pos(3,1) });
  const blockDown = actor({ id: 'p1', position: pos(2,2) });
  const actors = [mover, target, blockUp, blockLeft, blockRight, blockDown];
  expect(grid.nextStep(mover, target, 1, actors)).toBeNull();
  expect(grid.canReach(mover, target, 1, actors)).toBe(false);
});

test('dead actors never block movement', () => {
  const grid = createGrid(defaultGrid);
  const mover = actor({ id: 'p0', position: pos(2,3) });
  const target = actor({ id: 'e0', side: 'enemy', position: pos(0,3) });
  const corpse = actor({ id: 'd0', side: 'enemy', hp: 0, position: pos(1,3) });
  expect(grid.nextStep(mover, target, 1, [mover, target, corpse])).toBe(pos(1,3));
});

test('validatePlacement rejects duplicate positions', () => {
  const grid = createGrid(defaultGrid);
  const error = expectSimError(() => grid.validatePlacement([pos(1,4), pos(1,4)], 'party'));
  expect(error.code).toBe('INVALID_INPUT');
});

test('validatePlacement rejects a position outside the requested zone', () => {
  const grid = createGrid(defaultGrid);
  const error = expectSimError(() => grid.validatePlacement([pos(2,0)], 'party'));
  expect(error.code).toBe('INVALID_INPUT');
});

test('validatePlacement rejects an empty roster and an oversized enemy roster', () => {
  const grid = createGrid(defaultGrid);
  expect(expectSimError(() => grid.validatePlacement([], 'party')).code).toBe('INVALID_INPUT');
  const tooMany = [pos(0,0), pos(1,0), pos(2,0), pos(3,0), pos(4,0), pos(0,1)];
  expect(expectSimError(() => grid.validatePlacement(tooMany, 'enemy')).code).toBe('INVALID_INPUT');
});

test('validatePlacement rejects an out-of-board position', () => {
  const grid = createGrid(defaultGrid);
  const error = expectSimError(() => grid.validatePlacement([pos(5,3)], 'party'));
  expect(error.code).toBe('INVALID_INPUT');
});

test('defaultPlacement seats the first Guardian at (2,3) and fills the rest in order', () => {
  expect(defaultPlacement(['guardian', 'cleric', 'ranger'])).toEqual({
    p0: pos(2, 3), p1: pos(1, 4), p2: pos(3, 4),
  });
});

test('defaultPlacement without a Guardian uses the plain three-cell list in order', () => {
  expect(defaultPlacement(['cleric', 'ranger', 'arcanist'])).toEqual({
    p0: pos(1, 4), p1: pos(3, 4), p2: pos(2, 4),
  });
});

test('defaultPlacement seats a later Guardian at (2,3) while others still use roster order', () => {
  expect(defaultPlacement(['cleric', 'guardian'])).toEqual({
    p0: pos(1, 4), p1: pos(2, 3),
  });
});

test('defaultPlacement handles a single-member roster', () => {
  expect(defaultPlacement(['guardian'])).toEqual({ p0: pos(2, 3) });
  expect(defaultPlacement(['cleric'])).toEqual({ p0: pos(1, 4) });
});

test('supports the alternate 6x6 automated-test board', () => {
  const grid = createGrid({ width: 6, height: 6, playerRows: [4,5],
    enemyRows: [0,1], moveMs: 500, maxEnemies: 5 });
  const mover = actor({ id: 'p0', position: pos(2,5) });
  const target = actor({ id: 'e0', side: 'enemy', position: pos(2,0) });
  const actors = [mover, target];
  expect(grid.canReach(mover, target, 1, actors)).toBe(true);
  expect(grid.nextStep(mover, target, 1, actors)).toBe(pos(2,4));
  expect(grid.placementSlots('enemy')).toContain(pos(5,1));
  expect(() => grid.validatePlacement([pos(2,5)], 'party')).not.toThrow();
});
