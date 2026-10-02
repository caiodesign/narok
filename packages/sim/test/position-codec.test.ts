/**
 * The position codec and the content-derived defaults moved to `@narok/data`
 * (milestone B Task 8, rulings R163 and R165). The simulation re-exports the
 * very same functions, and every error it raises over a malformed position is
 * byte-for-byte the `SimError` it raised before the move.
 */
import * as data from '@narok/data';
import { describe, expect, test } from 'vitest';
import * as sim from '../src/index';
import { SimError } from '../src/errors';
import type { PendingRules, PositionId } from '../src/types';
import { lab, labInput } from './fixtures';

function refusal(run: () => unknown): { error: unknown; code: string; field: string; message: string } {
  try {
    run();
  } catch (error) {
    const { code, field, message } = error as { code: string; field: string; message: string };
    return { error, code, field, message };
  }
  throw new Error('expected a refusal');
}

describe('one implementation (R163)', () => {
  test('@narok/sim re-exports the codec and both defaults from @narok/data unchanged', () => {
    expect(sim.gridPosition).toBe(data.gridPosition);
    expect(sim.gridCoordinates).toBe(data.gridCoordinates);
    expect(sim.defaultPlacement).toBe(data.defaultPlacement);
    expect(sim.defaultStrategy).toBe(data.defaultStrategy);
  });
});

describe('a malformed position is still the engine error it was (R165)', () => {
  const malformed = 'nine,nine' as PositionId;

  test('start: INVALID_INPUT at field "position", as a SimError', () => {
    const base = labInput();
    const result = refusal(() => lab().start({ ...base, placement: { ...base.placement, p0: malformed } }));
    expect(result.error).toBeInstanceOf(SimError);
    expect([result.code, result.field, result.message]).toEqual([
      'INVALID_INPUT',
      'position',
      'malformed position id "nine,nine"',
    ]);
  });

  test('queueRules: re-fielded under pendingRules, as before the move', () => {
    const simulation = lab();
    const base = labInput();
    const rules: PendingRules = {
      placement: { ...base.placement, p0: malformed },
      strategies: base.strategies,
      rest: base.rest,
    };
    const result = refusal(() => simulation.queueRules(simulation.start(base), rules));
    expect(result.error).toBeInstanceOf(SimError);
    expect([result.code, result.field]).toEqual(['INVALID_INPUT', 'pendingRules.position']);
  });

  test('the codec itself raises PositionError with the same code, field and message', () => {
    const result = refusal(() => data.gridCoordinates(malformed));
    expect(result.error).toBeInstanceOf(data.PositionError);
    expect([result.code, result.field, result.message]).toEqual([
      'INVALID_INPUT',
      'position',
      'malformed position id "nine,nine"',
    ]);
  });
});
