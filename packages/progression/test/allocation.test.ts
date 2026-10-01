import { content } from '@narok/data';
import type { Attributes } from '@narok/data';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import {
  applyAllocation, autoSpend, createCharacter, gainExp, pointBudget, respec, revalidateRules, setAutoSpendTemplate,
  statCost, upgradeSkill,
} from '../src/index';
import type { Character, MaximaOf, TownContext } from '../src/index';

const KEYS = ['str', 'agi', 'vit', 'int', 'dex', 'luk'] as const;

/** Max HP grows with VIT and Max MP with INT, so a respec visibly lowers both. */
const maxima: MaximaOf = (character) => ({
  maxHp: 100 + 10 * character.attributes.vit,
  maxMp: 50 + 5 * character.attributes.int,
});

function town(overrides: Partial<TownContext> = {}): TownContext {
  return { content, stateVersion: 7, expectedStateVersion: 7, inTown: true, maxima, ...overrides };
}

function hero(overrides: Partial<Character> = {}): Character {
  return { ...createCharacter('c1', 'cleric'), hp: 110, mp: 55, ...overrides };
}

type Expected = { ok: false; code: string; field: string } | { ok: true; cost: number };

/** The independent oracle: Part 3 §5.3's six checks in order, the cost replayed point by point. */
function expected(character: Character, delta: Record<string, number>, quoted: number, ctx: TownContext): Expected {
  if (ctx.expectedStateVersion !== ctx.stateVersion) {
    return { ok: false, code: 'CONFLICT_STATE_VERSION', field: 'expectedStateVersion' };
  }
  if (!ctx.inTown) return { ok: false, code: 'RULE_VIOLATION', field: 'TOWN_ONLY' };
  for (const key of KEYS) {
    if (character.attributes[key] + (delta[key] ?? 0) > 99) {
      return { ok: false, code: 'RULE_VIOLATION', field: 'CAP_EXCEEDED' };
    }
  }
  let cost = 0;
  for (const key of KEYS) {
    const from = character.attributes[key];
    for (let value = from; value < from + (delta[key] ?? 0); value += 1) cost += 2 + Math.floor((value - 1) / 10);
  }
  if (cost !== quoted) return { ok: false, code: 'RULE_VIOLATION', field: 'COST_MISMATCH' };
  if (cost > character.statPoints) return { ok: false, code: 'RULE_VIOLATION', field: 'INSUFFICIENT_POINTS' };
  return { ok: true, cost };
}

test('a staged allocation commits every point at the quoted cost or nothing, with one code in §5.3 order', () => {
  const attribute = fc.integer({ min: 1, max: 99 });
  fc.assert(fc.property(
    fc.record({ str: attribute, agi: attribute, vit: attribute, int: attribute, dex: attribute, luk: attribute }),
    fc.integer({ min: 0, max: 700 }),
    fc.dictionary(fc.constantFrom(...KEYS), fc.integer({ min: 0, max: 60 })),
    fc.option(fc.integer({ min: 0, max: 700 }), { nil: undefined }),
    fc.boolean(),
    fc.boolean(),
    (attributes: Attributes, statPoints, delta, wrongQuote, stale, away) => {
      const character = hero({ attributes, statPoints });
      const before = structuredClone(character);
      const ctx = town({ expectedStateVersion: stale ? 6 : 7, inTown: !away });
      // Quote the true cost unless a wrong one was drawn (one past the cap has none).
      const truth = expected({ ...character, statPoints: Number.MAX_SAFE_INTEGER }, delta, 0, town());
      const trueCost = truth.ok ? truth.cost : 0;
      const quoted = wrongQuote ?? trueCost;
      const want = expected(character, delta, quoted, ctx);
      const result = applyAllocation(character, delta, quoted, ctx);
      expect(character).toEqual(before);
      if (!want.ok) {
        expect(result).toEqual(want);
        return;
      }
      if (!result.ok) throw new Error(`expected a commit, got ${result.field}`);
      for (const key of KEYS) expect(result.next.attributes[key]).toBe(attributes[key] + (delta[key] ?? 0));
      expect(result.next.statPoints).toBe(statPoints - quoted);
      let replayed = 0;
      for (const key of KEYS) replayed += statCost(attributes[key], result.next.attributes[key]);
      expect(replayed).toBe(quoted);
      expect(result.next.hp).toBe(character.hp);
    },
  ), { numRuns: 500 });
});

test('a negative, fractional or unknown delta is a validation failure with its field', () => {
  expect(applyAllocation(hero(), { str: -1 }, 0, town())).toEqual({ ok: false, code: 'VALIDATION', field: 'delta.str' });
  expect(applyAllocation(hero(), { dex: 1.5 }, 0, town())).toEqual({ ok: false, code: 'VALIDATION', field: 'delta.dex' });
  expect(applyAllocation(hero(), { cha: 1 } as never, 0, town())).toEqual({ ok: false, code: 'VALIDATION', field: 'delta.cha' });
  expect(applyAllocation(hero(), { str: 1 }, -2, town())).toEqual({ ok: false, code: 'VALIDATION', field: 'quotedCost' });
  // Version and town come before the input is read (§5.3 order).
  expect(applyAllocation(hero(), { str: -1 }, 0, town({ inTown: false })))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'TOWN_ONLY' });
});

test('auto-spend follows ordered targets, respects the cap, and carries unaffordable points forward', () => {
  const base = { ...createCharacter('c1', 'ranger'), hp: 1, mp: 1 };
  const template = {
    targets: [{ attribute: 'dex' as const, value: 11 }, { attribute: 'agi' as const, value: 6 }],
    remainder: 'vit' as const,
  };
  const set = setAutoSpendTemplate(base, template, town());
  if (!set.ok) throw new Error(set.field);
  const spent = autoSpend(set.next);
  // DEX 1 -> 11 costs 9 x 2 + 2 (20) and AGI 1 -> 6 costs 5 x 2 (10): the 30
  // creation points are gone and VIT is untouched.
  expect(spent.attributes).toMatchObject({ dex: 11, agi: 6, vit: 1 });
  expect(spent.statPoints).toBe(0);
  // At DEX 11 a point costs 3: with 2 points it is unaffordable and carried —
  // never spent on the later AGI target, which a point would still afford.
  const carried = autoSpend({
    ...set.next,
    autoSpendTemplate: { ...template, targets: [{ attribute: 'dex', value: 12 }, { attribute: 'agi', value: 6 }] },
    attributes: { ...set.next.attributes, dex: 11 },
    statPoints: 2,
  });
  expect(carried.attributes).toMatchObject({ dex: 11, agi: 1, vit: 1 });
  expect(carried.statPoints).toBe(2);
  // Targets met, the remainder takes what is left, up to the cap.
  const remainder = autoSpend({ ...set.next, attributes: { ...set.next.attributes, dex: 11, agi: 6, vit: 98 }, statPoints: 50 });
  expect(remainder.attributes.vit).toBe(99);
  expect(remainder.statPoints).toBe(50 - 11);
  // No template, no spending: points accumulate (layer-1 §5.5).
  expect(autoSpend(base)).toEqual(base);
});

test('the auto-spend template is a town-only edit with a validated shape', () => {
  const base = hero();
  expect(setAutoSpendTemplate(base, null, town({ inTown: false })))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'TOWN_ONLY' });
  expect(setAutoSpendTemplate(base, { targets: [{ attribute: 'dex', value: 100 }], remainder: null }, town()))
    .toEqual({ ok: false, code: 'VALIDATION', field: 'template.targets.0.value' });
  expect(setAutoSpendTemplate(base, { targets: [], remainder: 'cha' } as never, town()))
    .toEqual({ ok: false, code: 'VALIDATION', field: 'template.remainder' });
  const cleared = setAutoSpendTemplate({ ...base, autoSpendTemplate: { targets: [], remainder: 'int' } }, null, town());
  expect(cleared.ok && cleared.next.autoSpendTemplate).toBeNull();
});

test('skill points buy ranks one point each, up to rank five, town only', () => {
  const leveled: Character = { ...hero(), ...gainExp(hero(), 200_000) };
  expect(leveled.skillPoints).toBeGreaterThanOrEqual(3);
  const up = upgradeSkill(leveled, 'heal', 2, town());
  if (!up.ok) throw new Error(up.field);
  expect(up.next.skillRanks.heal).toBe(2);
  expect(up.next.skillPoints).toBe(leveled.skillPoints - 2);
  expect(upgradeSkill(leveled, 'heal', 6, town())).toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'CAP_EXCEEDED' });
  expect(upgradeSkill(leveled, 'cleave', 1, town())).toEqual({ ok: false, code: 'VALIDATION', field: 'skillId' });
  expect(upgradeSkill(up.next, 'heal', 2, town())).toEqual({ ok: false, code: 'VALIDATION', field: 'targetRank' });
  expect(upgradeSkill(hero(), 'heal', 2, town()))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'INSUFFICIENT_POINTS' });
  expect(upgradeSkill(leveled, 'heal', 1, town({ inTown: false })))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'TOWN_ONLY' });
});

test('respec refunds earned points only, heals nothing, and is town only', () => {
  const leveled: Character = { ...hero(), ...gainExp(hero(), 20_000) };
  const budget = pointBudget(leveled.awardedLevels);
  const spent = applyAllocation(leveled, { vit: 15, int: 5 }, statCost(1, 16) + statCost(1, 6), town());
  if (!spent.ok) throw new Error(spent.field);
  const ranked = upgradeSkill(spent.next, 'heal', 1, town());
  if (!ranked.ok) throw new Error(ranked.field);
  // Wounded under a high Max HP: the respec lowers the maximum and must not raise HP.
  const wounded = { ...ranked.next, hp: 250, mp: 20 };
  const reset = respec(wounded, 'both', [], town());
  if (!reset.ok) throw new Error(reset.field);
  expect(reset.next.attributes).toEqual({ str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 });
  expect(reset.next.statPoints).toBe(budget.statPoints);
  expect(reset.next.skillPoints).toBe(budget.skillPoints);
  expect(reset.next.skillRanks).toEqual({});
  expect(reset.next.hp).toBe(110); // clamped to the new Max HP of 100 + 10, never raised
  expect(reset.next.mp).toBe(20); // under the new maximum: preserved absolute
  // A second respec duplicates nothing.
  const again = respec(reset.next, 'both', [], town());
  expect(again.ok && again.next).toEqual(reset.next);
  expect(respec(wounded, 'both', [], town({ inTown: false })))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'TOWN_ONLY' });
  expect(respec(wounded, 'both', [], town({ expectedStateVersion: 3 })))
    .toEqual({ ok: false, code: 'CONFLICT_STATE_VERSION', field: 'expectedStateVersion' });
  const statsOnly = respec(wounded, 'attributes', [], town());
  expect(statsOnly.ok && statsOnly.next.skillRanks).toEqual({ heal: 1 });
  expect(respec(wounded, 'everything' as never, [], town())).toEqual({ ok: false, code: 'VALIDATION', field: 'scope' });
});

test('a respec disables, never deletes, the preset rules of skills now at rank zero, and reports them', () => {
  const rules = [
    { skillId: 'heal' as const, enabled: true, condition: { kind: 'ally-hp-below', value: 60 } },
    { skillId: 'smite' as const, enabled: true, condition: { kind: 'always' } },
    { skillId: 'smite' as const, enabled: false, condition: { kind: 'always' } },
  ];
  const checked = revalidateRules(rules, { heal: 2 });
  expect(checked.rules).toHaveLength(3);
  expect(checked.rules.map((rule) => rule.enabled)).toEqual([true, false, false]);
  expect(checked.rules[1]!.condition).toEqual(rules[1]!.condition);
  expect(checked.disabled).toEqual(['smite']);
  expect(rules[1]!.enabled).toBe(true);
});
