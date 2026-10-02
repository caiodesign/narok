import { content as bundled } from '@narok/data';
import type { ClassId, ProgressionTables } from '@narok/data';
import { cloneProgress } from './types';
import type { Character, Progress } from './types';

/**
 * Levelling and point budgets (layer-1 §5.3, §5.4; Part 3 §5.1). Every
 * function reads the compiled `content.progression` tables — the exponent is
 * evaluated at build time only (ruling R134). `tables` defaults to the bundled
 * content for tests and tools; a hunt or a town command passes the tables of
 * the content it is pinned to.
 */

/** EXP from `level` to `level + 1`, or `null` at the level cap. */
export function expToNext(level: number, tables: ProgressionTables = bundled.progression): number | null {
  if (!Number.isSafeInteger(level) || level < 1 || level > tables.levelCap) {
    throw new RangeError(`level ${level} is outside 1..${tables.levelCap}`);
  }
  return level === tables.levelCap ? null : tables.expToNext[level - 1]!;
}

/** Every point a character of `level` has earned: the creation grant plus each level reached. */
export function pointBudget(
  level: number,
  tables: ProgressionTables = bundled.progression,
): { statPoints: number; skillPoints: number } {
  if (!Number.isSafeInteger(level) || level < 1 || level > tables.levelCap) {
    throw new RangeError(`level ${level} is outside 1..${tables.levelCap}`);
  }
  let statPoints = 0;
  let skillPoints = 0;
  for (let index = 0; index < level; index += 1) {
    statPoints += tables.statPoints[index]!;
    skillPoints += tables.skillPoints[index]!;
  }
  return { statPoints, skillPoints };
}

/** Raising an attribute from `value` to `value + 1` costs `2 + floor((value - 1) / 10)` (layer-1 §5.4). */
export function statStepCost(value: number): number {
  return 2 + Math.floor((value - 1) / 10);
}

/** The cost of raising an attribute from `from` to `to`, replayed one point at a time in ascending order. */
export function statCost(from: number, to: number): number {
  let cost = 0;
  for (let value = from; value < to; value += 1) cost += statStepCost(value);
  return cost;
}

/** A character at creation: level 1, every attribute 1, the creation grant awarded (layer-1 §5.3, §5.4). */
export function createProgress(tables: ProgressionTables = bundled.progression): Progress {
  return {
    level: 1,
    exp: 0,
    expCarry: 0,
    attributes: { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 },
    statPoints: tables.statPoints[0]!,
    skillPoints: tables.skillPoints[0]!,
    skillRanks: {},
    awardedLevels: 1,
    autoSpendTemplate: null,
  };
}

/**
 * A new character before its resources are known: it starts at full HP and MP,
 * which only the caller's derivation can compute.
 */
export function createCharacter(
  id: string,
  classId: ClassId,
  tables: ProgressionTables = bundled.progression,
): Omit<Character, 'hp' | 'mp'> {
  return { id, classId, ...createProgress(tables) };
}

/**
 * Grants the points of every level reached but not yet awarded, and records
 * it (layer-1 §5.3: "reaching a level grants its points once"). Idempotent: a
 * replay after a retry or a migration finds nothing left to award.
 */
export function awardLevels<T extends Progress>(progress: T, tables: ProgressionTables = bundled.progression): T {
  const next = cloneProgress(progress);
  for (let level = next.awardedLevels + 1; level <= next.level; level += 1) {
    next.statPoints += tables.statPoints[level - 1]!;
    next.skillPoints += tables.skillPoints[level - 1]!;
    next.awardedLevels = level;
  }
  return next;
}

/**
 * Adds EXP and takes every level-up it pays for, granting each new level's
 * points (ruling R134). There is no de-levelling path (layer-1 §5.6). At the
 * cap EXP no longer accumulates: `exp` stays 0, so no hidden pool grows
 * without bound for a cap raise to release at once.
 */
export function gainExp<T extends Progress>(progress: T, amount: number, tables: ProgressionTables = bundled.progression): T {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('EXP gained must be a non-negative integer');
  const next = cloneProgress(progress);
  if (next.level >= tables.levelCap) return awardLevels(next, tables);
  next.exp += amount;
  for (;;) {
    const needed = expToNext(next.level, tables);
    if (needed === null) {
      next.exp = 0;
      break;
    }
    if (next.exp < needed) break;
    next.exp -= needed;
    next.level += 1;
  }
  return awardLevels(next, tables);
}

/**
 * The fixed denominator of `expCarry` (ruling R135): the least common multiple
 * of `10_000 * members` over the party sizes 1–3 (layer-1 §5.1), so the carry
 * means the same fraction whatever party a character hunts in next.
 */
export const EXP_SHARE_DENOMINATOR = 60_000;

/**
 * One eligible member's share of one kill (layer-1 §5.3; Part 3 §5.1): each
 * member receives `rawExp * (1 + 0.1 * (members - 1)) / members`, computed in
 * integer basis points and floored, the remainder carried in `expCarry` —
 * so EXP totals do not depend on how a hunt is cut into segments, and many
 * small kills pay what their exact sum would.
 */
export function splitExp(rawExp: number, members: number, carry: number): { exp: number; carry: number } {
  if (!Number.isSafeInteger(members) || members < 1 || members > 3) throw new RangeError('a party has 1 to 3 members');
  if (!Number.isSafeInteger(rawExp) || rawExp < 0) throw new RangeError('raw EXP must be a non-negative integer');
  if (!Number.isSafeInteger(carry) || carry < 0 || carry >= EXP_SHARE_DENOMINATOR) {
    throw new RangeError(`expCarry must be in [0, ${EXP_SHARE_DENOMINATOR})`);
  }
  const shareBp = 10_000 + 1_000 * (members - 1); // layer-1 §5.3
  const total = rawExp * shareBp * (EXP_SHARE_DENOMINATOR / (10_000 * members)) + carry;
  if (!Number.isSafeInteger(total)) throw new RangeError('EXP share exceeds the safe-integer range');
  return { exp: Math.floor(total / EXP_SHARE_DENOMINATOR), carry: total % EXP_SHARE_DENOMINATOR };
}
