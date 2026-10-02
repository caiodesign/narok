import { content as bundled } from '@narok/data';
import type { ItemInstance, ProgressionTables, SkillId } from '@narok/data';
import { pointBudget, statStepCost } from './levels';
import { clampResources } from './resources';
import { ATTRIBUTE_KEYS, cloneProgress, fail, guard, isCount, rule } from './types';
import type { AttributeKey, AutoSpendTemplate, Character, Progress, Result, TownContext } from './types';

/**
 * Manual allocation, auto-spend, skill ranks and respec (Part 3 §5.2–§5.4).
 * Every command is pure: it returns a new character or one failure, and never
 * changes its arguments — so a refusal commits nothing.
 */

/**
 * Applies a staged allocation (Part 3 §5.3): a delta vector plus the cost the
 * client quoted, validated in §5.3's order and rejected whole on the first
 * failure — the version, the town, non-negative integer deltas, the cap of 99,
 * the cost replayed point by point in ascending order, then affordability.
 * Raising attributes only raises Max HP and MP, so current HP and MP are
 * unchanged (spec §4.1 option (a)): an allocation never heals.
 */
export function applyAllocation(
  character: Character,
  delta: Partial<Record<AttributeKey, number>>,
  quotedCost: number,
  ctx: Pick<TownContext, 'content' | 'stateVersion' | 'expectedStateVersion' | 'inTown'>,
): Result<Character> {
  const refused = guard(ctx);
  if (refused !== null) return refused;
  for (const key of Object.keys(delta)) {
    if (!(ATTRIBUTE_KEYS as readonly string[]).includes(key)) return fail('VALIDATION', `delta.${key}`);
    if (!isCount(delta[key as AttributeKey])) return fail('VALIDATION', `delta.${key}`);
  }
  if (!isCount(quotedCost)) return fail('VALIDATION', 'quotedCost');
  const cap = ctx.content.progression.attributeCap;
  for (const key of ATTRIBUTE_KEYS) {
    if (character.attributes[key] + (delta[key] ?? 0) > cap) return rule('CAP_EXCEEDED');
  }
  let cost = 0;
  for (const key of ATTRIBUTE_KEYS) {
    const from = character.attributes[key];
    for (let value = from; value < from + (delta[key] ?? 0); value += 1) cost += statStepCost(value);
  }
  if (cost !== quotedCost) return rule('COST_MISMATCH');
  if (cost > character.statPoints) return rule('INSUFFICIENT_POINTS');

  const next = cloneProgress(character);
  for (const key of ATTRIBUTE_KEYS) next.attributes[key] += delta[key] ?? 0;
  next.statPoints -= cost;
  return { ok: true, next };
}

/**
 * Stat auto-spend (layer-1 §5.5; Part 3 §5.2; ruling R136). Targets are taken
 * strictly in order: each is raised one point at a time until it reaches its
 * value or the cap, and the first point that cannot be afforded stops the
 * whole pass — the points are carried forward rather than spent on a later
 * target, so the build is never reordered by what happens to be cheap. With
 * every target met, the remainder attribute takes what is affordable. No
 * template means no spending: the points accumulate.
 */
export function autoSpend<T extends Progress>(progress: T, tables: ProgressionTables = bundled.progression): T {
  const template = progress.autoSpendTemplate;
  if (template === null) return progress;
  const next = cloneProgress(progress);
  const raise = (attribute: AttributeKey, target: number): boolean => {
    while (next.attributes[attribute] < Math.min(target, tables.attributeCap)) {
      const cost = statStepCost(next.attributes[attribute]);
      if (cost > next.statPoints) return false;
      next.statPoints -= cost;
      next.attributes[attribute] += 1;
    }
    return true;
  };
  for (const target of template.targets) {
    if (!raise(target.attribute, target.value)) return next;
  }
  if (template.remainder !== null) raise(template.remainder, tables.attributeCap);
  return next;
}

/**
 * Validates an auto-spend template (ruling R136) and returns a copy: at most
 * one target per attribute, each value in 1..cap, and a remainder that is an
 * attribute or `null`. Shared with the simulation's checkpoint validation.
 */
export function validateAutoSpendTemplate(
  value: unknown,
  cap: number,
): Result<AutoSpendTemplate | null> {
  if (value === null) return { ok: true, next: null };
  if (typeof value !== 'object' || Array.isArray(value)) return fail('VALIDATION', 'template');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.targets) || record.targets.length > ATTRIBUTE_KEYS.length) {
    return fail('VALIDATION', 'template.targets');
  }
  const targets: AutoSpendTemplate['targets'] = [];
  for (const [index, raw] of record.targets.entries()) {
    const field = `template.targets.${index}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('VALIDATION', field);
    const entry = raw as Record<string, unknown>;
    if (!(ATTRIBUTE_KEYS as readonly unknown[]).includes(entry.attribute)
      || targets.some((target) => target.attribute === entry.attribute)) {
      return fail('VALIDATION', `${field}.attribute`);
    }
    if (!isCount(entry.value) || entry.value < 1 || entry.value > cap) return fail('VALIDATION', `${field}.value`);
    targets.push({ attribute: entry.attribute as AttributeKey, value: entry.value });
  }
  if (record.remainder !== null && !(ATTRIBUTE_KEYS as readonly unknown[]).includes(record.remainder)) {
    return fail('VALIDATION', 'template.remainder');
  }
  return { ok: true, next: { targets, remainder: record.remainder as AttributeKey | null } };
}

/**
 * Sets or clears (`null`) the auto-spend template. A town-only edit (Part 3
 * §4): the hunt runs on the template checkpointed at its start, so it can
 * never diverge from the player's intent mid-hunt.
 */
export function setAutoSpendTemplate(
  character: Character,
  template: AutoSpendTemplate | null,
  ctx: Pick<TownContext, 'content' | 'stateVersion' | 'expectedStateVersion' | 'inTown'>,
): Result<Character> {
  const refused = guard(ctx);
  if (refused !== null) return refused;
  const checked = validateAutoSpendTemplate(template, ctx.content.progression.attributeCap);
  if (!checked.ok) return checked;
  return { ok: true, next: { ...cloneProgress(character), autoSpendTemplate: checked.next } };
}

/**
 * Raises one skill to `targetRank` (layer-1 §5.3; ruling R139): one skill
 * point per rank, at most `maxSkillRank`, only a skill of the character's
 * class, and only upward — ranks come back through respec alone.
 */
export function upgradeSkill(
  character: Character,
  skillId: SkillId,
  targetRank: number,
  ctx: Pick<TownContext, 'content' | 'stateVersion' | 'expectedStateVersion' | 'inTown'>,
): Result<Character> {
  const refused = guard(ctx);
  if (refused !== null) return refused;
  if (!ctx.content.classes[character.classId].skills.includes(skillId)) return fail('VALIDATION', 'skillId');
  const current = character.skillRanks[skillId] ?? 0;
  if (!isCount(targetRank) || targetRank <= current) return fail('VALIDATION', 'targetRank');
  if (targetRank > ctx.content.progression.maxSkillRank) return rule('CAP_EXCEEDED');
  const cost = targetRank - current;
  if (cost > character.skillPoints) return rule('INSUFFICIENT_POINTS');
  const next = cloneProgress(character);
  next.skillRanks[skillId] = targetRank;
  next.skillPoints -= cost;
  return { ok: true, next };
}

export type RespecScope = 'attributes' | 'skills' | 'both';

/**
 * A free town respec (layer-1 §5.3; Part 3 §5.4; ruling R139). It refunds
 * exactly the points earned — the budget of the levels awarded, never more,
 * so a second respec returns the same state — resets attributes to 1 and
 * ranks to 0, and then applies the one HP/MP rule: absolute values preserved,
 * clamped to the new maxima, never raised. Equipment is untouched: its
 * eligibility depends on level and class only.
 */
export function respec(
  character: Character,
  scope: RespecScope,
  equipped: readonly ItemInstance[],
  ctx: TownContext,
): Result<Character> {
  const refused = guard(ctx);
  if (refused !== null) return refused;
  if (scope !== 'attributes' && scope !== 'skills' && scope !== 'both') return fail('VALIDATION', 'scope');
  const budget = pointBudget(character.awardedLevels, ctx.content.progression);
  const next = cloneProgress(character);
  if (scope !== 'skills') {
    for (const key of ATTRIBUTE_KEYS) next.attributes[key] = 1;
    next.statPoints = budget.statPoints;
  }
  if (scope !== 'attributes') {
    next.skillRanks = {};
    next.skillPoints = budget.skillPoints;
  }
  const clamped = clampResources(next, ctx.maxima(next, equipped));
  if (!clamped.ok) return clamped;
  return { ok: true, next: { ...next, ...clamped.next } };
}

/**
 * Revalidates saved strategy rules against skill ranks (Part 3 §5.4; ruling
 * R139): a rule naming a skill now at rank 0 is disabled — kept, with its
 * condition and position — and reported, so a respec can never silently
 * empty a preset. Already-disabled rules are not reported again.
 */
export function revalidateRules<R extends { skillId: SkillId; enabled: boolean }>(
  rules: readonly R[],
  ranks: Partial<Record<SkillId, number>>,
): { rules: R[]; disabled: SkillId[] } {
  const disabled: SkillId[] = [];
  const next = rules.map((entry) => {
    if (!entry.enabled || (ranks[entry.skillId] ?? 0) > 0) return { ...entry };
    if (!disabled.includes(entry.skillId)) disabled.push(entry.skillId);
    return { ...entry, enabled: false };
  });
  return { rules: next, disabled };
}
