import { content } from '@narok/data';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import {
  EXP_SHARE_DENOMINATOR, awardLevels, createProgress, expToNext, gainExp, pointBudget, splitExp, statCost,
} from '../src/index';

test('the parent curves are exact at the beta cap', () => {
  expect(statCost(1, 99)).toBe(628);
  expect(pointBudget(50)).toEqual({ statPoints: 412, skillPoints: 13 });
  expect(pointBudget(1)).toEqual({ statPoints: 30, skillPoints: 1 });
});

test('EXP to next level reads the compiled table and ends at the cap', () => {
  expect(expToNext(1)).toBe(50);
  expect(expToNext(2)).toBe(229);
  expect(expToNext(49)).toBe(content.progression.expToNext[48]);
  expect(expToNext(50)).toBeNull();
});

test('one skill point at creation and one at every fourth level; stat points 3 + floor(L / 5)', () => {
  expect(pointBudget(3)).toEqual({ statPoints: 30 + 3 + 3, skillPoints: 1 });
  expect(pointBudget(4)).toEqual({ statPoints: 30 + 3 + 3 + 3, skillPoints: 2 });
  expect(pointBudget(5).statPoints - pointBudget(4).statPoints).toBe(4);
  expect(pointBudget(48).skillPoints).toBe(13);
  expect(pointBudget(47).skillPoints).toBe(12);
});

test('a new character starts at level 1 with all attributes 1 and the creation grant', () => {
  expect(createProgress()).toEqual({
    level: 1, exp: 0, expCarry: 0,
    attributes: { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 },
    statPoints: 30, skillPoints: 1, skillRanks: {}, awardedLevels: 1, autoSpendTemplate: null,
  });
});

test('gaining EXP levels up through several levels at once and grants each level exactly once', () => {
  const start = createProgress();
  const next = gainExp(start, 50 + 229 + 10);
  expect(next.level).toBe(3);
  expect(next.exp).toBe(10);
  expect(next.awardedLevels).toBe(3);
  expect(next.statPoints).toBe(36);
  expect(start.level).toBe(1);
  // A retry or migration replaying the award grants nothing twice.
  expect(awardLevels(next)).toEqual(next);
});

test('awarded-level tracking grants a migrated level that was never awarded, once', () => {
  const migrated = { ...createProgress(), level: 8 };
  const awarded = awardLevels(migrated);
  expect(awarded.statPoints).toBe(pointBudget(8).statPoints);
  expect(awarded.skillPoints).toBe(pointBudget(8).skillPoints);
  expect(awardLevels(awarded)).toEqual(awarded);
});

test('EXP stops at the cap: no level past 50 and nothing accumulates there', () => {
  const capped = gainExp(createProgress(), 100_000_000);
  expect(capped.level).toBe(50);
  expect(capped.exp).toBe(0);
  expect(capped.statPoints).toBe(412);
  expect(gainExp(capped, 1_000)).toEqual(capped);
});

test('the party split is monsterExp * (1 + 0.1 * (members - 1)) / members in integer basis points', () => {
  expect(splitExp(30, 1, 0)).toEqual({ exp: 30, carry: 0 });
  // 30 * 1.1 / 2 = 16.5: the half is carried, then paid on the next kill.
  const first = splitExp(30, 2, 0);
  expect(first.exp).toBe(16);
  const second = splitExp(30, 2, first.carry);
  expect(second).toEqual({ exp: 17, carry: 0 });
  // 30 * 1.2 / 3 = 12 exactly.
  expect(splitExp(30, 3, 0)).toEqual({ exp: 12, carry: 0 });
  expect(EXP_SHARE_DENOMINATOR).toBe(60_000);
});

test('many kills award what their exact sum would, whatever the party size', () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 3 }),
    fc.array(fc.integer({ min: 0, max: 10_000 }), { maxLength: 40 }),
    (members, kills) => {
      let carry = 0;
      let total = 0;
      for (const rawExp of kills) {
        const share = splitExp(rawExp, members, carry);
        total += share.exp;
        carry = share.carry;
        expect(carry).toBeGreaterThanOrEqual(0);
        expect(carry).toBeLessThan(EXP_SHARE_DENOMINATOR);
      }
      const exact = kills.reduce((sum, rawExp) => sum + rawExp, 0) * (10_000 + 1_000 * (members - 1));
      expect(total).toBe(Math.floor(exact / (10_000 * members)));
    },
  ));
});
