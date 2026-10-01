import type { Attributes, ClassId, Content, ItemInstance, SkillId } from '@narok/data';

/**
 * The wire codes a progression rule can answer with (ruling R133). Part 3
 * §5.3's six names are rule identifiers, not wire codes: `STALE_STATE` is
 * `CONFLICT_STATE_VERSION`, `INVALID_INPUT` is `VALIDATION`, and every other
 * rule is `RULE_VIOLATION` with the rule's name in `field` — so Part 1 P-39's
 * bounded code set still holds. An item that is not the account's answers
 * `NOT_OWNED`, the bounded code that already exists for it.
 */
export type ProgressionCode = 'CONFLICT_STATE_VERSION' | 'VALIDATION' | 'RULE_VIOLATION' | 'NOT_OWNED';

/**
 * The rule identifiers carried in `field` with `RULE_VIOLATION` (ruling R133):
 * Part 3 §5.3's four, and the equip, bag and potion rules of §3–§4.
 */
export type RuleName =
  | 'TOWN_ONLY' | 'CAP_EXCEEDED' | 'COST_MISMATCH' | 'INSUFFICIENT_POINTS'
  | 'SLOT_MISMATCH' | 'CLASS_RESTRICTION' | 'LEVEL_REQUIREMENT' | 'CHARACTER_BOUND' | 'ITEM_EQUIPPED'
  | 'TWO_HANDED' | 'SLOT_EMPTY' | 'BAG_FULL'
  | 'POTION_COOLDOWN' | 'NO_POTION' | 'CHARACTER_DEAD';

export type Failure = { ok: false; code: ProgressionCode; field: string };
export type Result<T> = { ok: true; next: T } | Failure;

export type AttributeKey = keyof Attributes;
export const ATTRIBUTE_KEYS: readonly AttributeKey[] = ['str', 'agi', 'vit', 'int', 'dex', 'luk'];

/**
 * Ordered build targets (layer-1 §5.5): raise each target's attribute to its
 * value in order, then put whatever remains into `remainder` (or keep it).
 */
export interface AutoSpendTemplate {
  targets: { attribute: AttributeKey; value: number }[];
  remainder: AttributeKey | null;
}

/**
 * A character's progression (Part 3 §5): the fields a hunt checkpoints and the
 * town commands change. `attributes` are the allocated values, all starting at
 * 1 (layer-1 §5.4); `exp` is the EXP into the current level; `expCarry` is the
 * party-split remainder in 1/60,000ths of an EXP point (ruling R135);
 * `awardedLevels` is the highest level whose points have been granted, so a
 * retry or migration grants each level exactly once (layer-1 §5.3; ruling R134).
 * `autoSpendTemplate` `null` means auto-spend is off and points accumulate.
 */
export interface Progress {
  level: number; exp: number; expCarry: number;
  attributes: Attributes; statPoints: number; skillPoints: number;
  skillRanks: Partial<Record<SkillId, number>>;
  awardedLevels: number;
  autoSpendTemplate: AutoSpendTemplate | null;
}

/** A character in town: its progression plus identity and its absolute current resources. */
export interface Character extends Progress {
  id: string; classId: ClassId; hp: number; mp: number;
}

export interface Maxima { maxHp: number; maxMp: number }
export interface Resources { hp: number; mp: number }

/**
 * Max HP and MP of a character wearing `equipped`. Injected rather than
 * imported: the one derivation lives in `packages/sim` (`resolveLoadout` +
 * `deriveCharacter`), which itself imports this package for its level-ups, so
 * `@narok/sim`'s `characterMaxima(content)` is the production value.
 */
export type MaximaOf = (character: Character, equipped: readonly ItemInstance[]) => Maxima;

/**
 * What every guarded town command is checked against (Part 3 §5.3 steps 1–2):
 * the account's current state version and the one the command was built on,
 * and whether the account is in town with the character in no active hunt.
 */
export interface TownContext {
  content: Content;
  stateVersion: number; expectedStateVersion: number; inTown: boolean;
  maxima: MaximaOf;
}

/**
 * The shared account bag (Part 3 §3.1; layer-1 §7.5): every owned equipment
 * instance, equipped or not — only unequipped ones take a slot — and the total
 * units held of each consumable (ruling R137).
 */
export interface Bag {
  accountId: string; capacity: number;
  items: ItemInstance[];
  consumables: Record<string, number>;
}

export function fail(code: ProgressionCode, field: string): Failure {
  return { ok: false, code, field };
}

export function rule(name: RuleName): Failure {
  return { ok: false, code: 'RULE_VIOLATION', field: name };
}

/** Part 3 §5.3 steps 1–2, in order: a stale version first, then the town-only rule. */
export function guard(ctx: Pick<TownContext, 'stateVersion' | 'expectedStateVersion' | 'inTown'>): Failure | null {
  if (ctx.expectedStateVersion !== ctx.stateVersion) return fail('CONFLICT_STATE_VERSION', 'expectedStateVersion');
  if (!ctx.inTown) return rule('TOWN_ONLY');
  return null;
}

export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function cloneProgress<T extends Progress>(progress: T): T {
  return {
    ...progress,
    attributes: { ...progress.attributes },
    skillRanks: { ...progress.skillRanks },
    autoSpendTemplate: progress.autoSpendTemplate === null
      ? null
      : {
        targets: progress.autoSpendTemplate.targets.map((target) => ({ ...target })),
        remainder: progress.autoSpendTemplate.remainder,
      },
  };
}
