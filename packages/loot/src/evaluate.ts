/**
 * The loot filter (milestone B part 3 §3.3; layer-1 §7.5; UI spec §6).
 *
 * One pure function, shared by the server, the simulation and the client
 * preview, so "the preview runs the actual evaluator" is true by construction
 * (spec §4.1's `packages/loot` recommendation; revisit if the owner decides
 * otherwise). It imports only `@narok/data` *types*: the runtime content
 * bundle never reaches a client through this package, which is why the rarity
 * ladder is restated here and a test pins it to the content rules.
 */
import { EQUIPMENT_SLOTS } from '@narok/data';
import type { Rarity, Slot } from '@narok/data';
import type {
  Disposition,
  DropDescriptor,
  LootAction,
  LootCategory,
  LootCondition,
  LootException,
  LootPreset,
} from './types';

/** Bumped when {@link LootPreset}'s shape changes; stored beside every saved payload. */
export const LOOT_PRESET_SCHEMA_VERSION = 1;

/** Ascending rarity, the order `minRarity` compares in (layer-1 §7.2). Pinned to `RARITIES` by test. */
export const LOOT_RARITIES: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
/** The one protected rarity (layer-1 §7.5): always Keep, never overridden. Pinned by test. */
const PROTECTED_RARITY: Rarity = 'legendary';
export const LOOT_CATEGORIES: readonly LootCategory[] = ['equipment', 'consumable'];
export const LOOT_ACTIONS: readonly LootAction[] = ['keep', 'auto-sell', 'ignore'];
const SLOTS: readonly Slot[] = EQUIPMENT_SLOTS;
const CONDITION_KEYS: readonly (keyof LootCondition)[] = [
  'category', 'slot', 'minRarity', 'minBonusCount', 'bonusId', 'minItemLevel',
];
/**
 * An input bound, not a balance number (ruling R129): a preset is read on
 * every drop, so its exception list is finite. Generous for a hand-edited list.
 */
export const MAX_LOOT_EXCEPTIONS = 50;
/** The largest bonus count any rarity rolls (Legendary, layer-1 §7.1). */
const MAX_BONUS_COUNT = 4;
/** Item level equals monster level, which content bounds at 99. */
const MAX_ITEM_LEVEL = 99;

function rank(rarity: Rarity): number {
  return LOOT_RARITIES.indexOf(rarity);
}

function matches(when: LootCondition, drop: DropDescriptor): boolean {
  if (when.category !== undefined && drop.category !== when.category) return false;
  if (when.slot !== undefined && drop.slot !== when.slot) return false;
  if (when.minRarity !== undefined && (drop.rarity === null || rank(drop.rarity) < rank(when.minRarity))) return false;
  if (when.minBonusCount !== undefined && drop.bonusIds.length < when.minBonusCount) return false;
  if (when.bonusId !== undefined && !drop.bonusIds.includes(when.bonusId)) return false;
  if (when.minItemLevel !== undefined && drop.itemLevel < when.minItemLevel) return false;
  return true;
}

/**
 * The disposition of one drop under `preset`, by part 3 §3.3's precedence:
 *
 * 1. Protection — a Legendary is kept and marked protected; nothing below can
 *    turn it into Auto-sell or Ignore.
 * 2. Ordered exceptions, top to bottom; the first match wins.
 * 3. The rarity rule for equipment, then the mandatory per-category fallback.
 *
 * Pure: reads its arguments, writes nothing, and never looks at the bag — a
 * Keep that does not fit is the caller's bag-full policy, not the filter's.
 */
export function evaluate(drop: DropDescriptor, preset: LootPreset): Disposition {
  if (drop.category === 'equipment' && drop.rarity === PROTECTED_RARITY) {
    return { action: 'keep', matched: 'protected' };
  }
  for (let index = 0; index < preset.exceptions.length; index++) {
    const exception = preset.exceptions[index];
    if (matches(exception.when, drop)) return { action: exception.action, matched: { exception: index } };
  }
  const byRarity = drop.category === 'equipment' && drop.rarity !== null ? preset.rarity[drop.rarity] : undefined;
  return { action: byRarity ?? preset.fallback[drop.category], matched: 'default' };
}

/** A refused preset, with the bounded field path of the first problem. */
export class LootPresetError extends Error {
  readonly code = 'INVALID_LOOT_PRESET' as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'LootPresetError';
    this.field = field;
  }
}

function fail(field: string, message: string): never {
  throw new LootPresetError(field, message);
}

function record(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    // The root is reported as `$`, every other object by its path.
    fail(field === '' ? '$' : field, 'expected an object');
  }
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!keys.includes(key)) fail(field === '' ? key : `${field}.${key}`, 'unknown key');
  }
  return result;
}

function oneOf<T extends string>(value: unknown, field: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) fail(field, `expected one of ${options.join(', ')}`);
  return value as T;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(field, `expected an integer between ${min} and ${max}`);
  }
  return value;
}

function validateCondition(value: unknown, field: string): LootCondition {
  const raw = record(value, field, CONDITION_KEYS);
  const when: LootCondition = {};
  if (raw.category !== undefined) when.category = oneOf(raw.category, `${field}.category`, LOOT_CATEGORIES);
  if (raw.slot !== undefined) when.slot = oneOf(raw.slot, `${field}.slot`, SLOTS);
  if (raw.minRarity !== undefined) when.minRarity = oneOf(raw.minRarity, `${field}.minRarity`, LOOT_RARITIES);
  if (raw.minBonusCount !== undefined) {
    when.minBonusCount = integer(raw.minBonusCount, `${field}.minBonusCount`, 0, MAX_BONUS_COUNT);
  }
  if (raw.bonusId !== undefined) {
    if (typeof raw.bonusId !== 'string' || raw.bonusId.length === 0 || raw.bonusId.length > 64) {
      fail(`${field}.bonusId`, 'expected a bonus id');
    }
    when.bonusId = raw.bonusId;
  }
  if (raw.minItemLevel !== undefined) {
    when.minItemLevel = integer(raw.minItemLevel, `${field}.minItemLevel`, 1, MAX_ITEM_LEVEL);
  }
  if (Object.keys(when).length === 0) fail(field, 'expected at least one condition');
  return when;
}

/**
 * Validates a preset payload and returns a deep copy, so a snapshot taken from
 * it can never be reached by a later edit to the caller's object. Unknown keys
 * are refused, which is what keeps material conditions out until they exist.
 */
export function validateLootPreset(value: unknown): LootPreset {
  const raw = record(value, '', ['exceptions', 'rarity', 'fallback']);

  if (!Array.isArray(raw.exceptions)) fail('exceptions', 'expected an array');
  if (raw.exceptions.length > MAX_LOOT_EXCEPTIONS) fail('exceptions', `expected at most ${MAX_LOOT_EXCEPTIONS}`);
  const exceptions: LootException[] = raw.exceptions.map((entry, index) => {
    const field = `exceptions.${index}`;
    const exception = record(entry, field, ['when', 'action']);
    return {
      when: validateCondition(exception.when, `${field}.when`),
      action: oneOf(exception.action, `${field}.action`, LOOT_ACTIONS),
    };
  });

  const rarityRaw = record(raw.rarity, 'rarity', LOOT_RARITIES);
  const rarity: Partial<Record<Rarity, LootAction>> = {};
  for (const id of LOOT_RARITIES) {
    if (rarityRaw[id] !== undefined) rarity[id] = oneOf(rarityRaw[id], `rarity.${id}`, LOOT_ACTIONS);
  }

  if (raw.fallback === undefined) fail('fallback', 'a fallback for every supported category is mandatory');
  const fallbackRaw = record(raw.fallback, 'fallback', LOOT_CATEGORIES);
  const fallback = {} as Record<LootCategory, LootAction>;
  for (const category of LOOT_CATEGORIES) {
    fallback[category] = oneOf(fallbackRaw[category], `fallback.${category}`, LOOT_ACTIONS);
  }

  return { exceptions, rarity, fallback };
}

/**
 * The starter filter (layer-1 §7.5): auto-sell Common equipment; keep
 * Uncommon and better and every supported consumable, with an explicit
 * fallback for each category.
 */
export const STARTER_LOOT_PRESET: LootPreset = {
  exceptions: [],
  rarity: { common: 'auto-sell' },
  fallback: { equipment: 'keep', consumable: 'keep' },
};
