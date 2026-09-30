import type { BonusDefinition, Rarity, RarityDefinition, RolledBonus, Slot } from './types';

/** Every rarity in ascending order — the order the band ladder is built in (Part 3 §2.3). */
export const RARITIES: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/**
 * Rolled-bonus counts and drop protection per rarity (layer-1 §7.1, §7.5; Part
 * 3 §1.1). Fixed rules, not balance inputs: content must carry exactly this
 * table (ruling R125), so {@link bonusCount} cannot disagree with a pinned
 * `content.rarities`.
 */
export const RARITY_RULES: Readonly<Record<Rarity, Readonly<RarityDefinition>>> = {
  common: { bonusCount: 0, protected: false },
  uncommon: { bonusCount: 1, protected: false },
  rare: { bonusCount: 2, protected: false },
  epic: { bonusCount: 3, protected: false },
  legendary: { bonusCount: 4, protected: true },
};

/** Level requirement of each base tier, index = tier - 1 (layer-1 §7.1). */
export const TIER_LEVEL_REQUIREMENTS: readonly number[] = [1, 10, 20, 30, 40];

/** Number of rolled bonuses an instance of `rarity` carries. */
export function bonusCount(rarity: Rarity): number {
  return RARITY_RULES[rarity].bonusCount;
}

/**
 * Bonus value tier of an item level: `ceil(itemLevel / 10)`, indexing a
 * bonus's `spans` at `valueTier - 1` (assumes Part 3 §8 #3; revisit if the
 * owner decides otherwise).
 */
export function valueTier(itemLevel: number): number {
  return Math.ceil(itemLevel / 10);
}

/**
 * Whether a definition declared for `definitionSlot` may occupy `slot`. The two
 * accessory slots are interchangeable, so the same definition may occupy both
 * (Part 3 §1.1; ruling R123); every other slot matches only itself.
 */
export function slotAccepts(definitionSlot: Slot, slot: Slot): boolean {
  const accessory = (s: Slot) => s === 'accessory1' || s === 'accessory2';
  return definitionSlot === slot || (accessory(definitionSlot) && accessory(slot));
}

/**
 * Stacks rolled bonuses across items, one total per bonus identity, by that
 * bonus's declared `stacking` rule: `sum` adds every value, `max` keeps the
 * largest (layer-1 §7.1; ruling R124). Identities are the unit of stacking —
 * two different identities feeding the same stat are combined later, by the
 * loadout, never here. Every `bonusId` must exist in `bonuses`.
 */
export function stackBonuses(
  rolled: readonly RolledBonus[],
  bonuses: Readonly<Record<string, BonusDefinition>>,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const { bonusId, value } of rolled) {
    const bonus = bonuses[bonusId];
    if (bonus === undefined) throw new RangeError(`unknown bonus ${bonusId}`);
    const current = totals[bonusId];
    if (current === undefined) totals[bonusId] = value;
    else totals[bonusId] = bonus.stacking === 'sum' ? current + value : Math.max(current, value);
  }
  return totals;
}
