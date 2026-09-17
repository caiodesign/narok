import type { ClassDefinition } from '@narok/data';
import type { DerivedStats } from './types';

/**
 * Multiplies two integers, throwing when the exact product would fall outside the
 * safe-integer range. Called before every product in {@link damage} so overflow is
 * caught at the arithmetic site rather than silently truncated by floating point.
 * Throws a plain `RangeError`; translation to `SimError('UNSAFE_INTEGER', ...)`
 * happens at public simulation boundaries in a later task.
 */
function multiplySafe(a: number, b: number): number {
  const product = a * b;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(`unsafe product: ${a} * ${b}`);
  }
  return product;
}

/** Applies a basis-point factor (`10,000 = 100%`) to `value`, flooring the result. */
function scale(value: number, bp: number): number {
  return Math.floor(multiplySafe(value, bp) / 10000);
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Computes a class definition's derived combat stats. Uses the parent's formulas with
 * final flooring for HP/MP/ATK/MATK/DEF/MDEF and a ceiling with a 300 ms minimum for
 * the basic attack interval. Pure arithmetic; never rolls random numbers.
 */
export function derive(definition: ClassDefinition): DerivedStats {
  const { level, attributes, baseHp, hpPerLevel, baseMp, mpPerLevel,
    weaponAtk, weaponMatk, armorDef, armorMdef, basicIntervalMs, basicRange, basicKind } = definition;
  const { str, agi, vit, int, dex, luk } = attributes;

  const maxHp = Math.floor(((baseHp + hpPerLevel * level) * (100 + vit)) / 100);
  const maxMp = Math.floor(((baseMp + mpPerLevel * level) * (100 + int)) / 100);
  const atk = basicKind === 'physical' && basicRange > 1
    ? weaponAtk + dex + Math.floor(str / 5) + Math.floor(luk / 5) // RangedATK
    : weaponAtk + str + Math.floor(dex / 5) + Math.floor(luk / 5); // MeleeATK
  const matk = weaponMatk + int + Math.floor(int / 2);
  const def = armorDef + Math.floor(vit / 2);
  const mdef = armorMdef + Math.floor(int / 2);
  const hit = level + dex;
  const flee = level + agi;
  const critBp = Math.min(10_000, Math.floor(luk / 3) * 100);
  const intervalMs = Math.max(
    300,
    Math.ceil((basicIntervalMs * 100) / (100 + agi + Math.floor(dex / 4))),
  );

  return { maxHp, maxMp, atk, matk, def, mdef, hit, flee, critBp, intervalMs };
}

export interface DamageInput {
  offense: number;
  powerBp: number;
  elementBp: number;
  familyBp: number;
  varianceBp: number;
  critical: boolean;
  defense: number;
  hit: boolean;
}

/**
 * Computes damage per the milestone A spec §4: zero immediately for a miss, otherwise
 * skill power, element, family, and variance factors are applied in order (flooring
 * after each), then a 1.5x crit multiplier, then defense mitigation with a minimum of
 * one damage. Random rolls (crit/accuracy/variance) are the caller's responsibility.
 */
export function damage(input: DamageInput): number {
  const { offense, powerBp, elementBp, familyBp, varianceBp, critical, defense, hit } = input;
  if (!hit) return 0;

  assertNonNegativeInteger(offense, 'offense');
  assertNonNegativeInteger(powerBp, 'powerBp');
  assertNonNegativeInteger(elementBp, 'elementBp');
  assertNonNegativeInteger(familyBp, 'familyBp');
  assertNonNegativeInteger(varianceBp, 'varianceBp');
  assertNonNegativeInteger(defense, 'defense');

  let raw = scale(offense, powerBp);
  raw = scale(raw, elementBp);
  raw = scale(raw, familyBp);
  raw = scale(raw, varianceBp);
  if (critical) raw = scale(raw, 15_000);

  return Math.max(1, Math.floor(multiplySafe(raw, 100) / (100 + defense)));
}

/** Returns the actual restoration a heal would apply, capped at missing HP. */
export function effectiveHeal(hp: number, maxHp: number, requested: number): number {
  return Math.max(0, Math.min(maxHp - hp, requested));
}
