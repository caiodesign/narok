import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { RARITIES, RARITY_RULES } from '@narok/data';
import {
  evaluate,
  LOOT_ACTIONS,
  LOOT_CATEGORIES,
  LOOT_RARITIES,
  LootPresetError,
  STARTER_LOOT_PRESET,
  validateLootPreset,
  type DropDescriptor,
  type LootPreset,
} from '../src/index';
import vectorFile from './vectors.json';

interface VectorCase {
  rule: string;
  preset: string;
  drop: string;
  expected: unknown;
}
interface Vectors {
  drops: Record<string, DropDescriptor>;
  presets: Record<string, LootPreset>;
  cases: VectorCase[];
}
const vectors = vectorFile as unknown as Vectors;

describe('the committed vectors (B-14: the preview and the server run this one function)', () => {
  test.each(vectors.cases.map((entry) => [`${entry.rule}: ${entry.drop} under ${entry.preset}`, entry] as const))(
    '%s',
    (_name, entry) => {
      const preset = validateLootPreset(vectors.presets[entry.preset]);
      expect(evaluate(vectors.drops[entry.drop], preset)).toEqual(entry.expected);
    },
  );

  test('every precedence rule and every supported condition has a matching and a failing vector', () => {
    const rules = new Set(vectors.cases.map((entry) => entry.rule));
    for (const rule of [
      'protection', 'first-match', 'default', 'fallback',
      'condition:category', 'condition:slot', 'condition:min-rarity', 'condition:min-bonus-count',
      'condition:bonus-id', 'condition:min-item-level',
    ]) {
      expect(rules).toContain(rule);
    }
    for (const rule of [...rules].filter((name) => name.startsWith('condition:'))) {
      const outcomes = vectors.cases.filter((entry) => entry.rule === rule).map((entry) => JSON.stringify(entry.expected));
      expect(outcomes.some((text) => text.includes('exception'))).toBe(true);
      expect(outcomes.some((text) => text.includes('default'))).toBe(true);
    }
  });

  test('every committed preset validates, and the starter filter is one of them', () => {
    for (const preset of Object.values(vectors.presets)) expect(() => validateLootPreset(preset)).not.toThrow();
    expect(vectors.presets.starter).toEqual(STARTER_LOOT_PRESET);
  });
});

const rarity = fc.constantFrom(...RARITIES);
const action = fc.constantFrom(...LOOT_ACTIONS);
const condition = fc.record(
  {
    category: fc.constantFrom(...LOOT_CATEGORIES),
    slot: fc.constantFrom('weapon', 'body', 'accessory1'),
    minRarity: rarity,
    minBonusCount: fc.integer({ min: 0, max: 4 }),
    bonusId: fc.constantFrom('crit', 'str', 'vit'),
    minItemLevel: fc.integer({ min: 1, max: 30 }),
  },
  { requiredKeys: [] },
).filter((when) => Object.keys(when).length > 0);
const preset: fc.Arbitrary<LootPreset> = fc.record({
  exceptions: fc.array(fc.record({ when: condition, action }), { maxLength: 6 }),
  rarity: fc.dictionary(rarity, action),
  fallback: fc.record({ equipment: action, consumable: action }),
});
const equipment: fc.Arbitrary<DropDescriptor> = fc.record({
  category: fc.constant('equipment' as const),
  definitionId: fc.constant('padded-vest'),
  slot: fc.constantFrom('weapon', 'body', 'accessory1'),
  rarity,
  bonusIds: fc.uniqueArray(fc.constantFrom('crit', 'str', 'vit', 'agi'), { maxLength: 4 }),
  itemLevel: fc.integer({ min: 1, max: 30 }),
});

describe('precedence as properties', () => {
  test('a Legendary drop is kept as protected under any exception list, rarity rule and fallback', () => {
    fc.assert(
      fc.property(preset, equipment, (candidate, drop) => {
        const legendary = { ...drop, rarity: 'legendary' as const };
        expect(evaluate(legendary, validateLootPreset(candidate))).toEqual({ action: 'keep', matched: 'protected' });
      }),
    );
  });

  test('every drop gets a disposition, and an exception match is always the first matching index', () => {
    fc.assert(
      fc.property(preset, equipment, (candidate, drop) => {
        const result = evaluate(drop, validateLootPreset(candidate));
        expect(LOOT_ACTIONS).toContain(result.action);
        if (typeof result.matched === 'object') {
          const index = result.matched.exception;
          expect(result.action).toBe(candidate.exceptions[index].action);
          // The winner matches on its own, and nothing before it does.
          const alone = (at: number) => evaluate(drop, { ...candidate, exceptions: [candidate.exceptions[at]] }).matched;
          expect(alone(index)).toEqual({ exception: 0 });
          for (let earlier = 0; earlier < index; earlier++) expect(alone(earlier)).not.toEqual({ exception: 0 });
        }
      }),
    );
  });

  test('evaluation is pure: the drop and the preset are never written to', () => {
    fc.assert(
      fc.property(preset, equipment, (candidate, drop) => {
        const presetBefore = JSON.stringify(candidate);
        const dropBefore = JSON.stringify(drop);
        evaluate(drop, candidate);
        expect(JSON.stringify(candidate)).toBe(presetBefore);
        expect(JSON.stringify(drop)).toBe(dropBefore);
      }),
    );
  });
});

describe('the preset shape', () => {
  function field(run: () => unknown): string {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(LootPresetError);
      return (error as LootPresetError).field;
    }
    throw new Error('expected a LootPresetError');
  }

  test('material conditions and categories are absent (layer-1 §7.5: reserved until materials exist)', () => {
    expect(LOOT_CATEGORIES).toEqual(['equipment', 'consumable']);
    const withMaterial = { ...STARTER_LOOT_PRESET, exceptions: [{ when: { material: 'ore' }, action: 'keep' }] };
    expect(field(() => validateLootPreset(withMaterial))).toBe('exceptions.0.when.material');
    const materialCategory = { ...STARTER_LOOT_PRESET, exceptions: [{ when: { category: 'material' }, action: 'keep' }] };
    expect(field(() => validateLootPreset(materialCategory))).toBe('exceptions.0.when.category');
    const materialFallback = { ...STARTER_LOOT_PRESET, fallback: { equipment: 'keep', consumable: 'keep', material: 'keep' } };
    expect(field(() => validateLootPreset(materialFallback))).toBe('fallback.material');
  });

  test('the fallback is mandatory for every supported category', () => {
    expect(field(() => validateLootPreset({ ...STARTER_LOOT_PRESET, fallback: { equipment: 'keep' } }))).toBe(
      'fallback.consumable',
    );
    expect(field(() => validateLootPreset({ exceptions: [], rarity: {} }))).toBe('fallback');
  });

  test('refuses an empty condition, an unknown action, an unknown rarity and an extra key', () => {
    expect(field(() => validateLootPreset({ ...STARTER_LOOT_PRESET, exceptions: [{ when: {}, action: 'keep' }] }))).toBe(
      'exceptions.0.when',
    );
    expect(field(() => validateLootPreset({ ...STARTER_LOOT_PRESET, rarity: { common: 'sell' } }))).toBe('rarity.common');
    expect(field(() => validateLootPreset({ ...STARTER_LOOT_PRESET, rarity: { mythic: 'keep' } }))).toBe('rarity.mythic');
    expect(field(() => validateLootPreset({ ...STARTER_LOOT_PRESET, extra: true }))).toBe('extra');
    expect(
      field(() => validateLootPreset({ ...STARTER_LOOT_PRESET, exceptions: [{ when: { minBonusCount: 5 }, action: 'keep' }] })),
    ).toBe('exceptions.0.when.minBonusCount');
  });

  test('returns a deep copy, so a later edit to the caller object cannot reach a snapshot', () => {
    const source = structuredClone(vectors.presets.ordered) as LootPreset;
    const copy = validateLootPreset(source);
    source.exceptions[0].action = 'ignore';
    source.fallback.equipment = 'ignore';
    expect(copy.exceptions[0].action).toBe('keep');
    expect(copy.fallback.equipment).toBe('keep');
  });

  test("the evaluator's own rarity ladder and protection agree with the content rules", () => {
    expect(LOOT_RARITIES).toEqual(RARITIES);
    const protectedRarities = RARITIES.filter((id) => RARITY_RULES[id].protected);
    expect(protectedRarities).toEqual(['legendary']);
  });
});
