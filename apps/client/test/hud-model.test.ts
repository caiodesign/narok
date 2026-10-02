/**
 * `isLowMp`, the HUD's low-mana cue. These cases lived in the laboratory shell's
 * `app.test.tsx`, which moved to `apps/lab` with the laboratory (milestone B
 * Task 8); the helper is the client's own (`src/hud/model.ts`), so its cases
 * stay here, unchanged.
 */
import { describe, expect, test } from 'vitest';
import { gridPosition } from '@narok/data';
import type { PublicActor } from '@narok/sim';
import { isLowMp } from '../src/hud/model';

/** The projected actor fields these helpers read; everything else is filler. */
function actor(overrides: Partial<PublicActor> = {}): PublicActor {
  return {
    id: 'p1',
    definitionId: 'cleric',
    side: 'party',
    position: gridPosition(2, 3),
    hp: 180,
    mp: 100,
    maxHp: 180,
    maxMp: 400,
    currentTarget: null,
    casting: null,
    targetReason: null,
    cooldowns: {},
    ...overrides,
  };
}

describe('isLowMp', () => {
  test('the threshold is exclusive: exactly a quarter is not yet low', () => {
    expect(isLowMp(actor({ mp: 100, maxMp: 400 }))).toBe(false);
  });

  test('a hair either side of the threshold decides it', () => {
    expect(isLowMp(actor({ mp: 99, maxMp: 400 }))).toBe(true);
    expect(isLowMp(actor({ mp: 101, maxMp: 400 }))).toBe(false);
  });

  test('empty is low and full is not', () => {
    expect(isLowMp(actor({ mp: 0, maxMp: 400 }))).toBe(true);
    expect(isLowMp(actor({ mp: 400, maxMp: 400 }))).toBe(false);
  });

  /**
   * A class with no mana pool is not a depleted caster, and the ratio must
   * never be computed: `0 / 0` is `NaN`, which compares false and would read as
   * "not low" by accident rather than by decision.
   */
  test('an actor with no mana pool is never low', () => {
    expect(isLowMp(actor({ mp: 0, maxMp: 0 }))).toBe(false);
    expect(isLowMp(actor({ mp: 0, maxMp: -1 }))).toBe(false);
  });
});
