import { fail } from './types';
import type { Maxima, Resources, Result } from './types';

/**
 * The one rule for every change of Max HP or Max MP (spec §4.1 option (a);
 * Part 3 §5.4, §8 #12): current HP and MP keep their absolute values and are
 * clamped to the new maxima. A raised maximum therefore heals nothing — equip
 * cycling cannot restore resources — and the same rule serves level-up, equip,
 * unequip, respec and content migration.
 */
export function clampResources(current: Resources, max: Maxima): Result<Resources> {
  if (!Number.isSafeInteger(current.hp) || current.hp < 0) return fail('VALIDATION', 'hp');
  if (!Number.isSafeInteger(current.mp) || current.mp < 0) return fail('VALIDATION', 'mp');
  if (!Number.isSafeInteger(max.maxHp) || max.maxHp < 1) return fail('VALIDATION', 'maxHp');
  if (!Number.isSafeInteger(max.maxMp) || max.maxMp < 0) return fail('VALIDATION', 'maxMp');
  return { ok: true, next: { hp: Math.min(current.hp, max.maxHp), mp: Math.min(current.mp, max.maxMp) } };
}
