/**
 * Client-side pre-flight feedback for a draft (ruling R55; part 4 §1 "Lost").
 *
 * It runs while the player edits, so a cell outside the party rows or an
 * out-of-range threshold is flagged before anything is sent. It is feedback
 * only: the server's validation is the one that counts (layer-1 §8.1), and a
 * draft this module accepts may still be refused. Every refusal the client
 * renders from a command comes from the server's stable code, localised as
 * `serverError.<CODE>` through `i18n.ts` — never from this module and never
 * from client English. This module, likewise, returns only `{field,
 * messageKey}` pairs keyed under `validation.*`.
 *
 * Two entry points: `validateLabInput` for the laboratory's experiment, which
 * also names a seed, a recipe and a roster; `validatePresetDraft` for a saved
 * strategy preset, whose party is the account's characters and whose seed is
 * the server's, so it checks placement, rules and rest only.
 */
import type { Content } from '@narok/data';
import type { LabInput } from '@narok/sim';

export interface ValidationIssue {
  field: string;
  messageKey: string;
}

const POSITION_PATTERN = /^(\d+),(\d+)$/;

/** Declared threshold ranges for skills whose rule condition carries a `value` (mirrors `packages/sim/src/state.ts`'s `validateCondition`). */
export const RULE_VALUE_RANGES: Partial<Record<string, [number, number]>> = {
  heal: [1, 99],
  cleave: [1, 5],
  'arrow-rain': [1, 5],
  'frost-nova': [1, 5],
};

/** The bounds a rule's threshold control must not let the operator leave. */
export function ruleValueRange(skillId: string): [number, number] | null {
  return RULE_VALUE_RANGES[skillId] ?? null;
}

/**
 * Ruling R76 (binding, supersedes R55 on these bounds): `packages/sim` is the
 * source of truth and is not exported/importable here, so these are duplicated
 * from `packages/sim/src/state.ts`'s `validateLabInput` (lines ~196-200) —
 * `requireInt(restRecord.hpStart, ..., 0, 89)`, `requireInt(restRecord.mpStart,
 * ..., 0, 79)`. The fixed rest EXIT threshold is 90/80 (R34): a start threshold
 * at or above exit would begin resting and immediately exit. There is no wipe
 * limit: a wipe ends the hunt (owner decision 2026-09-30).
 * `test/controls.test.tsx`'s sweep test calls the real sim at every boundary so
 * this cannot silently drift from `state.ts` again.
 */
const REST_HP_START_RANGE: readonly [number, number] = [0, 89];
const REST_MP_START_RANGE: readonly [number, number] = [0, 79];

function parsePosition(position: string): { column: number; row: number } | null {
  const match = POSITION_PATTERN.exec(position);
  if (!match) return null;
  return { column: Number(match[1]), row: Number(match[2]) };
}

/** What a strategy preset holds (payload schema version 1), with the party it is drafted for. */
export type PresetDraft = Pick<LabInput, 'classes' | 'placement' | 'strategies' | 'rest'>;

export function validateLabInput(input: LabInput, content: Content): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (input.classes.length < 1 || input.classes.length > 3) {
    issues.push({ field: 'classes', messageKey: 'validation.rosterSize' });
  }
  input.classes.forEach((classId, index) => {
    if (!Object.hasOwn(content.classes, classId)) {
      issues.push({ field: `classes.${index}`, messageKey: 'validation.unknownClass' });
    }
  });

  if (!Number.isInteger(input.seed) || input.seed < 1 || input.seed > 4_294_967_295) {
    issues.push({ field: 'seed', messageKey: 'validation.seedRange' });
  }

  const knownRecipes = new Set<string>([...Object.keys(content.recipes), 'mixed']);
  if (!knownRecipes.has(input.recipe)) {
    issues.push({ field: 'recipe', messageKey: 'validation.unknownRecipe' });
  }

  issues.push(...validatePresetDraft(input, content));
  return issues;
}

/** Placement, rest and rules: the parts of a draft a saved preset carries. */
export function validatePresetDraft(input: PresetDraft, content: Content): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const rosterIds = input.classes.map((_, index) => `p${index}`);
  const placementKeys = Object.keys(input.placement);
  const hasEveryRosterId = rosterIds.every((id) => Object.hasOwn(input.placement, id));
  if (placementKeys.length !== rosterIds.length || !hasEveryRosterId) {
    issues.push({ field: 'placement', messageKey: 'validation.unknownPlacement' });
  }

  const seenCells = new Set<string>();
  for (const id of rosterIds) {
    const cell = input.placement[id];
    if (cell === undefined) continue;
    const field = `placement.${id}`;
    if (seenCells.has(cell)) {
      issues.push({ field, messageKey: 'validation.duplicatePlacement' });
      continue;
    }
    seenCells.add(cell);
    const parsed = parsePosition(cell);
    const inBounds =
      parsed !== null &&
      parsed.column >= 0 &&
      parsed.column < content.grid.width &&
      parsed.row >= 0 &&
      parsed.row < content.grid.height;
    const onPartySide = parsed !== null && content.grid.playerRows.includes(parsed.row);
    if (!inBounds || !onPartySide) {
      issues.push({ field, messageKey: 'validation.invalidCell' });
    }
  }

  if (
    !Number.isInteger(input.rest.hpStart) ||
    input.rest.hpStart < REST_HP_START_RANGE[0] ||
    input.rest.hpStart > REST_HP_START_RANGE[1]
  ) {
    issues.push({ field: 'rest.hpStart', messageKey: 'validation.restRange' });
  }
  if (
    !Number.isInteger(input.rest.mpStart) ||
    input.rest.mpStart < REST_MP_START_RANGE[0] ||
    input.rest.mpStart > REST_MP_START_RANGE[1]
  ) {
    issues.push({ field: 'rest.mpStart', messageKey: 'validation.restRange' });
  }

  for (const id of rosterIds) {
    const strategy = input.strategies[id];
    if (!strategy) continue;
    strategy.rules.forEach((rule, index) => {
      const range = RULE_VALUE_RANGES[rule.skillId];
      if (!range) return;
      const condition = rule.condition;
      if (!('value' in condition)) return;
      const [min, max] = range;
      if (condition.value < min || condition.value > max) {
        issues.push({
          field: `strategies.${id}.rules.${index}.condition.value`,
          messageKey: 'validation.ruleThreshold',
        });
      }
    });
    if (strategy.target.kind === 'attacking' && !rosterIds.includes(strategy.target.partyId)) {
      issues.push({ field: `strategies.${id}.target.partyId`, messageKey: 'validation.unknownTargetParty' });
    }
  }

  return issues;
}
