import fc from 'fast-check';
import { expect, test } from 'vitest';

import { bonusCount, stackBonuses, valueTier } from '../src/items';
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

test('rarities carry the layer-1 bonus counts and Legendary protection', () => {
  const { rarities } = validateContent(baseContent());
  expect(rarities).toEqual({
    common: { bonusCount: 0, protected: false },
    uncommon: { bonusCount: 1, protected: false },
    rare: { bonusCount: 2, protected: false },
    epic: { bonusCount: 3, protected: false },
    legendary: { bonusCount: 4, protected: true },
  });
  expect(['common', 'uncommon', 'rare', 'epic', 'legendary'].map((r) => bonusCount(r as never)))
    .toEqual([0, 1, 2, 3, 4]);
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
