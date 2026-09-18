/**
 * Client-side pre-validation for a draft `LabInput` (ruling R55). Runs before
 * `start` is enabled so the operator gets immediate feedback; the worker's real
 * `Simulation.start` still performs full authoritative validation regardless.
 *
 * Returns `{field, messageKey}[]` — i18n keys under `validation.*`, never English
 * sentences, so Task 10 can localize this list without touching this module.
 */
import type { Content } from '@narok/data';
import type { LabInput } from '@narok/sim';

export interface ValidationIssue {
  field: string;
  messageKey: string;
}

const POSITION_PATTERN = /^(\d+),(\d+)$/;

/** Declared threshold ranges for skills whose rule condition carries a `value` (mirrors `packages/sim/src/state.ts`'s `validateCondition`). */
const RULE_VALUE_RANGES: Partial<Record<string, [number, number]>> = {
  heal: [1, 99],
  cleave: [1, 5],
  'arrow-rain': [1, 5],
  'frost-nova': [1, 5],
};

function parsePosition(position: string): { column: number; row: number } | null {
  const match = POSITION_PATTERN.exec(position);
  if (!match) return null;
  return { column: Number(match[1]), row: Number(match[2]) };
}

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

  if (input.rest.hpStart < 0 || input.rest.hpStart > 100) {
    issues.push({ field: 'rest.hpStart', messageKey: 'validation.restRange' });
  }
  if (input.rest.mpStart < 0 || input.rest.mpStart > 100) {
    issues.push({ field: 'rest.mpStart', messageKey: 'validation.restRange' });
  }

  if (!Number.isInteger(input.wipeLimit) || input.wipeLimit < 1) {
    issues.push({ field: 'wipeLimit', messageKey: 'validation.wipeLimit' });
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
