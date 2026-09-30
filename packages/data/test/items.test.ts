import fc from 'fast-check';
import { expect, test } from 'vitest';

import { BASE_BAND_PPM, bonusCount, stackBonuses, valueTier } from '../src/items';
import { prototypeDefinition } from '../src/prototype';
import type { BonusDefinition, Content, RolledBonus } from '../src/types';
import { ContentError, validateContent } from '../src/validate';

/** A structurally complete `Content` built from the prototype table, deep-cloned per test. */
function baseContent(): Content {
  return structuredClone({
    ...prototypeDefinition,
    version: 'test-version',
    gridHash: 'test-grid-hash',
  });
}

function expectInvalidContent(value: unknown, field: string): void {
  let caught: unknown;
  try {
    validateContent(value);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ContentError);
  expect((caught as ContentError).code).toBe('INVALID_CONTENT');
  expect((caught as ContentError).field).toBe(field);
}

test('accepts the prototype item and bonus tables', () => {
  const content = validateContent(baseContent());
  expect(Object.keys(content.items).length).toBeGreaterThan(0);
  expect(Object.keys(content.bonuses).length).toBeGreaterThan(0);
});

test('rarities carry the layer-1 bonus counts, Legendary protection and base band widths', () => {
  const { rarities } = validateContent(baseContent());
  expect(rarities).toEqual({
    common: { bonusCount: 0, protected: false, ppm: 5_000 },
    uncommon: { bonusCount: 1, protected: false, ppm: 2_000 },
    rare: { bonusCount: 2, protected: false, ppm: 500 },
    epic: { bonusCount: 3, protected: false, ppm: 100 },
    legendary: { bonusCount: 4, protected: true, ppm: 10 },
  });
  expect(['common', 'uncommon', 'rare', 'epic', 'legendary'].map((r) => bonusCount(r as never)))
    .toEqual([0, 1, 2, 3, 4]);
  expect(BASE_BAND_PPM).toBe(7_610);
  const altered = baseContent();
  altered.rarities.epic.ppm = 101;
  expectInvalidContent(altered, 'rarities.epic.ppm');
});

test('a drop multiplier whose scaled band sum exceeds 1,000,000 ppm is refused (Part 3 §2.3)', () => {
  const id = Object.keys(baseContent().monsters).sort()[0];
  // 7,610 * 131 = 996,910 fits; 7,610 * 132 = 1,004,520 does not.
  const fits = baseContent();
  fits.monsters[id].dropMultiplier = 131;
  expect(validateContent(fits).monsters[id].dropMultiplier).toBe(131);
  const overruns = baseContent();
  overruns.monsters[id].dropMultiplier = 132;
  expectInvalidContent(overruns, `monsters.${id}.dropMultiplier`);
  const fractional = baseContent();
  fractional.monsters[id].dropMultiplier = 2.5;
  expectInvalidContent(fractional, `monsters.${id}.dropMultiplier`);
});

test('pity ships with the guarantee disabled and no threshold chosen (Part 3 §2.4)', () => {
  expect(validateContent(baseContent()).pity).toEqual({
    guaranteeEnabled: false, epicPlusThreshold: null, legendaryThreshold: null,
  });
  const disabledWithThreshold = baseContent();
  disabledWithThreshold.pity = { guaranteeEnabled: false, epicPlusThreshold: 10, legendaryThreshold: null };
  expectInvalidContent(disabledWithThreshold, 'pity.epicPlusThreshold');
  const enabledWithout = baseContent();
  enabledWithout.pity = { guaranteeEnabled: true, epicPlusThreshold: 10, legendaryThreshold: null };
  expectInvalidContent(enabledWithout, 'pity.legendaryThreshold');
  const enabled = baseContent();
  enabled.pity = { guaranteeEnabled: true, epicPlusThreshold: 10, legendaryThreshold: 20 };
  expect(validateContent(enabled).pity.legendaryThreshold).toBe(20);
  const missing = baseContent() as Partial<Content>;
  delete missing.pity;
  expectInvalidContent(missing, 'pity');
});

test('every monster draws gold over exactly its A-era raw gold', () => {
  const { monsters } = validateContent(baseContent());
  for (const monster of Object.values(monsters)) {
    expect(monster.goldMin).toBe(monster.rawGold);
    expect(monster.goldMax).toBe(monster.rawGold);
  }
});

test('no definition carries a price while prices are deferred', () => {
  const { items } = validateContent(baseContent());
  for (const item of Object.values(items)) expect(item.basePrice).toBeNull();
});

test('rejects a fittingBonuses entry naming no bonus', () => {
  const value = baseContent();
  value.items['guardian-sword'].fittingBonuses = ['no-such-bonus'];
  expectInvalidContent(value, 'items.guardian-sword.fittingBonuses.0');
});

test('rejects a slot pool holding only three distinct identities', () => {
  const value = baseContent();
  const inCloakPool = Object.values(value.bonuses)
    .filter((bonus) => bonus.slots.includes('cloak'))
    .map((bonus) => bonus.id)
    .sort();
  for (const id of inCloakPool.slice(3)) {
    const bonus = value.bonuses[id]!;
    bonus.slots = bonus.slots.filter((slot) => slot !== 'cloak');
  }
  expectInvalidContent(value, 'pools.cloak');
});

test('rejects a spans array shorter than ceil(maxMonsterLevel / 10)', () => {
  const value = baseContent();
  value.monsters['briar-boar'].level = 11;
  const [id] = Object.keys(value.bonuses).sort();
  value.bonuses[id!]!.spans = value.bonuses[id!]!.spans.slice(0, 1);
  expectInvalidContent(value, `bonuses.${id}.spans`);
});

test('rejects a non-weapon definition that sets basicIntervalMs', () => {
  const value = baseContent();
  value.items['leather-cap'].basicIntervalMs = 1_000;
  expectInvalidContent(value, 'items.leather-cap.basicIntervalMs');
});

test('rejects a bonus whose kind lacks a stacking rule', () => {
  const value = baseContent();
  delete (value.bonuses.crit as Partial<BonusDefinition>).stacking;
  expectInvalidContent(value, 'bonuses.crit.stacking');
});

test('rejects a placeholder price', () => {
  const value = baseContent();
  value.items['leather-cap'].basePrice = 10;
  expectInvalidContent(value, 'items.leather-cap.basePrice');
});

test('rejects a level requirement off the tier ladder', () => {
  const value = baseContent();
  value.items['leather-cap'].levelRequirement = 5;
  expectInvalidContent(value, 'items.leather-cap.levelRequirement');
});

test('value tier is ceil(itemLevel / 10)', () => {
  expect([1, 10, 11, 20, 50].map(valueTier)).toEqual([1, 1, 2, 2, 5]);
});

/** Legal item sets: each item carries distinct identities with values inside tier 1 spans. */
function itemSets(bonuses: Record<string, BonusDefinition>): fc.Arbitrary<RolledBonus[][]> {
  const ids = Object.keys(bonuses).sort();
  const rolled = (id: string) => {
    const span = bonuses[id]!.spans[0]!;
    return fc.integer({ min: span.min, max: span.max }).map((value) => ({ bonusId: id, value }));
  };
  const item = fc.uniqueArray(fc.constantFrom(...ids), { maxLength: 4 })
    .chain((chosen) => fc.tuple(...chosen.map(rolled)))
    .map((list) => list as RolledBonus[]);
  return fc.array(item, { maxLength: 8 });
}

test('sum stacking is independent of item order; max never exceeds the largest single value', () => {
  const { bonuses } = validateContent(baseContent());
  fc.assert(fc.property(itemSets(bonuses), fc.nat(), (items, rotation) => {
    const shift = items.length === 0 ? 0 : rotation % items.length;
    const reordered = [...items.slice(shift), ...items.slice(0, shift)].reverse();
    const forward = stackBonuses(items.flat(), bonuses);
    const backward = stackBonuses(reordered.flat(), bonuses);
    for (const [id, total] of Object.entries(forward)) {
      const values = items.flat().filter((b) => b.bonusId === id).map((b) => b.value);
      if (bonuses[id]!.stacking === 'sum') {
        expect(backward[id]).toBe(total);
      } else {
        expect(total).toBeLessThanOrEqual(Math.max(...values));
      }
    }
  }));
});
