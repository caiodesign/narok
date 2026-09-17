import { expect, test } from 'vitest';
import { content } from '@narok/data';
import { derive, damage, effectiveHeal } from '../src/math';

test('Guardian formulas use explicit rounding', () => {
  expect(derive(content.classes.guardian)).toMatchObject({
    maxHp: 277, maxMp: 60, atk: 37, def: 17, intervalMs: 1569,
  });
});

test('power then defense and actual restoration', () => {
  expect(damage({
    offense: 100, powerBp: 12000, elementBp: 10000,
    familyBp: 10000, varianceBp: 10000, critical: false,
    defense: 20, hit: true,
  })).toBe(100);
  expect(effectiveHeal(95, 100, 82)).toBe(5);
  expect(effectiveHeal(100, 100, 82)).toBe(0);
});

test('derive computes full stats for every class (golden)', () => {
  expect(derive(content.classes.guardian)).toEqual({
    maxHp: 277, maxMp: 60, atk: 37, matk: 1, def: 17, mdef: 3,
    hit: 16, flee: 11, critBp: 0, intervalMs: 1569,
  });
  expect(derive(content.classes.cleric)).toEqual({
    maxHp: 180, maxMp: 174, atk: 11, matk: 46, def: 8, mdef: 16,
    hit: 11, flee: 11, critBp: 0, intervalMs: 1783,
  });
  expect(derive(content.classes.ranger)).toEqual({
    maxHp: 201, maxMp: 90, atk: 44, matk: 1, def: 9, mdef: 3,
    hit: 26, flee: 16, critBp: 0, intervalMs: 1273,
  });
  expect(derive(content.classes.arcanist)).toEqual({
    maxHp: 159, maxMp: 197, atk: 7, matk: 49, def: 7, mdef: 16,
    hit: 16, flee: 11, critBp: 0, intervalMs: 1863,
  });
});

test('ranged basic attack uses DEX-based ATK instead of STR', () => {
  expect(derive(content.classes.ranger)).toMatchObject({ atk: 44 });
});

test('higher defense never increases damage (monotonic)', () => {
  const damageAt = (defense: number) => damage({
    offense: 200, powerBp: 10000, elementBp: 10000, familyBp: 10000,
    varianceBp: 10000, critical: false, defense, hit: true,
  });
  const defenses = [0, 10, 50, 100, 250, 1000];
  let previous = Number.POSITIVE_INFINITY;
  for (const defense of defenses) {
    const result = damageAt(defense);
    expect(result).toBeLessThanOrEqual(previous);
    previous = result;
  }
});

test('a missed hit deals zero damage', () => {
  expect(damage({
    offense: 500, powerBp: 20000, elementBp: 15000, familyBp: 15000,
    varianceBp: 11000, critical: true, defense: 0, hit: false,
  })).toBe(0);
});

test('damage is never rounded below one on a hit', () => {
  expect(damage({
    offense: 10, powerBp: 10000, elementBp: 10000, familyBp: 10000,
    varianceBp: 10000, critical: false, defense: 1_000_000, hit: true,
  })).toBe(1);
});

test('an unsafe intermediate product throws RangeError', () => {
  expect(() => damage({
    offense: 100_000_000_000, powerBp: 100_000, elementBp: 10000,
    familyBp: 10000, varianceBp: 10000, critical: false, defense: 10, hit: true,
  })).toThrow(RangeError);
});

test('damage rejects negative or non-integer numeric inputs', () => {
  const base = {
    offense: 100, powerBp: 10000, elementBp: 10000, familyBp: 10000,
    varianceBp: 10000, critical: false, defense: 10, hit: true,
  };
  expect(() => damage({ ...base, offense: -1 })).toThrow(RangeError);
  expect(() => damage({ ...base, offense: 1.5 })).toThrow(RangeError);
  expect(() => damage({ ...base, defense: -5 })).toThrow(RangeError);
});

test('magical defense mitigates a magic attacker using MATK/MDEF', () => {
  const attacker = derive(content.classes.cleric);
  const defender = derive(content.classes.guardian);
  expect(damage({
    offense: attacker.matk, powerBp: 10000, elementBp: 10000, familyBp: 10000,
    varianceBp: 10000, critical: false, defense: defender.mdef, hit: true,
  })).toBe(44);
});

test('damage scales for every element pair in the chart', () => {
  const expectedByBp: Record<number, number> = { 7500: 75, 10000: 100, 15000: 150 };
  const elements = content.elements;
  for (const attacker of Object.keys(elements) as (keyof typeof elements)[]) {
    const row = elements[attacker];
    for (const defender of Object.keys(row) as (keyof typeof row)[]) {
      const elementBp = row[defender];
      const result = damage({
        offense: 100, powerBp: 10000, elementBp, familyBp: 10000,
        varianceBp: 10000, critical: false, defense: 0, hit: true,
      });
      expect(result).toBe(expectedByBp[elementBp]);
    }
  }
});
