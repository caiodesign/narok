import type { Rarity, Slot } from '@narok/data';

/**
 * The drop categories the filter supports (layer-1 §7.5, part 3 §3.3).
 * Materials are reserved: they have no category, no condition and no UI until
 * materials exist, so a preset naming one is refused rather than ignored.
 */
export type LootCategory = 'equipment' | 'consumable';

/** Keep, Auto-sell or Ignore (layer-1 §7.5). Auto-sell consumes no bag slot. */
export type LootAction = 'keep' | 'auto-sell' | 'ignore';

/**
 * What the filter sees of one drop — the rolled outcome and nothing of the
 * account. `slot` and `rarity` are `null` for a consumable; a condition on a
 * field the drop lacks does not match.
 */
export interface DropDescriptor {
  category: LootCategory;
  definitionId: string;
  slot: Slot | null;
  rarity: Rarity | null;
  /** The rolled bonus identities; its length is the bonus count. */
  bonusIds: string[];
  itemLevel: number;
}

/**
 * One exception's conditions, all of which must hold (part 3 §3.3's six
 * supported conditions). At least one is present; there is deliberately no
 * material condition.
 */
export interface LootCondition {
  category?: LootCategory;
  slot?: Slot;
  minRarity?: Rarity;
  minBonusCount?: number;
  bonusId?: string;
  minItemLevel?: number;
}

export interface LootException {
  when: LootCondition;
  action: LootAction;
}

/**
 * A loot preset's payload (schema version {@link LOOT_PRESET_SCHEMA_VERSION}).
 * Precedence, in order: protection, `exceptions` top to bottom, the `rarity`
 * rule for equipment, then the mandatory per-category `fallback`, so an
 * unmatched drop always has a disposition.
 */
export interface LootPreset {
  exceptions: LootException[];
  rarity: Partial<Record<Rarity, LootAction>>;
  fallback: Record<LootCategory, LootAction>;
}

/** Which rule decided: protection, the exception at an index, or the rarity/default rule. */
export type LootMatch = 'protected' | { exception: number } | 'default';

export interface Disposition {
  action: LootAction;
  matched: LootMatch;
}
