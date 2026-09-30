export type ClassId = 'guardian' | 'cleric' | 'ranger' | 'arcanist';
export type SkillId = 'taunt' | 'cleave' | 'heal' | 'smite'
  | 'double-shot' | 'arrow-rain' | 'fire-bolt' | 'frost-nova';
export type RecipeId = 'melee' | 'ranged' | 'clustered';
export type Element = 'neutral' | 'fire' | 'water' | 'earth' | 'wind';
export type Family = 'beast' | 'undead' | 'demon' | 'plant' | 'insect' | 'humanoid';
export type ShapeId = 'single' | 'cleave' | 'square' | 'plus';
export type DamageKind = 'physical' | 'magic';
export interface Attributes {
  str: number; agi: number; vit: number; int: number; dex: number; luk: number;
}
export interface GridConfig {
  width: number; height: number; playerRows: number[]; enemyRows: number[];
  moveMs: number; maxEnemies: number;
}
export interface ClassDefinition {
  id: ClassId; attributes: Attributes; level: number;
  baseHp: number; hpPerLevel: number; baseMp: number; mpPerLevel: number;
  weaponAtk: number; weaponMatk: number; armorDef: number; armorMdef: number;
  basicIntervalMs: number; basicRange: number; basicKind: DamageKind;
  skills: SkillId[];
}
export interface SkillDefinition {
  id: SkillId; mp: number; cooldownMs: number; baseCastMs: number;
  range: number; shape: ShapeId; powerBp: number; hits: number;
  effect: 'damage' | 'heal' | 'taunt'; damageKind: DamageKind;
  element: Element; slowBp: number; durationMs: number;
}
export interface MonsterDefinition {
  id: string; level: number; family: Family; element: Element;
  hp: number; mp: number; atk: number; matk: number; def: number; mdef: number;
  hit: number; flee: number; intervalMs: number; range: number;
  rawExp: number; rawGold: number;
  /** Definition ids this monster can drop (Part 3 §2.2); the roll sorts them by id. */
  equipment: string[];
  /** The separate consumable roll (layer-1 §7.2), in parts per million (ruling R126). */
  consumables: ConsumableDrop[];
  /** Scales every rarity band width (Part 3 §2.3); normal 1. */
  dropMultiplier: number;
  /** Inclusive gold range of the per-kill gold draw (Part 3 §2.2 step 5). */
  goldMin: number; goldMax: number;
}
export interface ConsumableDrop { consumableId: string; ppm: number }
export interface RecipeDefinition {
  id: RecipeId; weight: number;
  monsters: { monsterId: string; column: number; row: number }[];
}
// Equipment model, exactly as Part 3 §1.2 declares it (layer-1 §7.1), except
// that `basePrice` is `number | null`: prices are deferred (spec §4.0), so every
// definition carries `null` and validation refuses a number (ruling R126).
export type Slot = 'weapon' | 'offhand' | 'head' | 'body' | 'cloak' | 'shoes'
  | 'accessory1' | 'accessory2';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export type Handedness = 'one-handed' | 'two-handed' | 'offhand' | 'none';

export interface ItemDefinition {
  id: string; slot: Slot; tier: 1 | 2 | 3 | 4 | 5; levelRequirement: number;
  classes: ClassId[] | null;              // null = any class
  handedness: Handedness;
  weaponAtk: number; weaponMatk: number; armorDef: number; armorMdef: number;
  basicIntervalMs: number | null; basicRange: number | null; basicKind: DamageKind | null;
  basePrice: number | null;                // gold, before the rarity multiplier; null while prices are deferred
  fittingBonuses: string[];                // BonusDefinition ids rolled at weight x2
}

export type BonusKind = 'attribute' | 'atk-pct' | 'matk-pct' | 'family-damage'
  | 'element-damage' | 'element-resist' | 'crit' | 'attack-speed' | 'max-hp'
  | 'hp-regen' | 'mp-regen' | 'heal-power';

export interface BonusDefinition {
  id: string; kind: BonusKind; unit: 'flat' | 'bp';
  attribute: keyof Attributes | null; family: Family | null; element: Element | null;
  slots: Slot[];                           // pool membership, slot-specific (layer-1 §7.1)
  spans: { min: number; max: number }[];   // index = valueTier - 1
  stacking: 'sum' | 'max';                 // mandatory per bonus (layer-1 §7.1)
}

export interface RolledBonus { bonusId: string; value: number }

/** Per-rarity roll rules (Part 3 §1.1): fixed by layer-1 §7.1 and §7.5. */
export interface RarityDefinition { bonusCount: number; protected: boolean; ppm: number }

/**
 * Bad-luck protection (Part 3 §2.4). B ships the plumbing enabled and the
 * guarantee disabled: counters accrue whatever this says, and only
 * `guaranteeEnabled` lets them change a roll. The thresholds are an OPEN
 * INPUT — `null` until chosen from measured wait distributions, before
 * expanded beta — and are required exactly when the guarantee is enabled.
 */
export interface PityConfig {
  guaranteeEnabled: boolean;
  /** Eligible opportunities after which an Epic-or-better is guaranteed. */
  epicPlusThreshold: number | null;
  /** Eligible opportunities after which a Legendary is guaranteed. */
  legendaryThreshold: number | null;
}

/**
 * An account-owned item (Part 3 §1.2). Not content: it lives here so the
 * definition and the instance that resolves through it share one vocabulary.
 */
export interface ItemInstance {
  id: string; accountId: string; definitionId: string; contentVersion: string;
  rarity: Rarity; itemLevel: number;       // = dropping monster level (layer-1 §7.2)
  bonuses: RolledBonus[];                  // length === bonusCount(rarity), identities distinct
  tradeable: false;                        // all beta equipment (layer-1 §7.1)
  locked: boolean;                         // user flag; excluded from bulk sale (UI §6)
  protected: boolean;                      // assigned at acquisition; Legendary => true
  equipped: { characterId: string; slot: Slot } | null;
  source: { huntId: string; rewardSeq: number } | { grantId: string };
}

/**
 * The fixed first-equipment grant for one class (owner decision 2026-09-21,
 * Part 3 §8 #11): one definition, rarity `uncommon`, item level 1, one fixed
 * bonus at a fixed value — rolled by nothing.
 */
export interface OnboardingGrant {
  definitionId: string; rarity: Rarity; itemLevel: number; bonuses: RolledBonus[];
}

export interface Content {
  version: string; gridHash: string; grid: GridConfig;
  classes: Record<ClassId, ClassDefinition>;
  skills: Record<SkillId, SkillDefinition>;
  monsters: Record<string, MonsterDefinition>;
  recipes: Record<RecipeId, RecipeDefinition>;
  shapes: Record<ShapeId, [number, number][]>;
  elements: Record<Element, Record<Element, number>>;
  walkMs: number; regenMs: number; encounterLimitMs: number; respawnMs: number;
  /**
   * Duration of the simulated travel segment a stop consumes on its way back to
   * town (owner decision 2026-09-21, spec §4.0; ruling R114). OPEN CONTENT INPUT:
   * `null` until the owner chooses the number — neither layer-1 nor the
   * milestone B parts give one, and part 3 §8 #9 only bounds it below by the
   * map's walk interval. Nothing may substitute a default for it.
   */
  townReturnTravelMs: number | null;
  items: Record<string, ItemDefinition>;
  bonuses: Record<string, BonusDefinition>;
  rarities: Record<Rarity, RarityDefinition>;
  onboardingGrant: Record<ClassId, OnboardingGrant>;
  pity: PityConfig;
}
