import { describe, expect, test } from 'vitest';
import { content } from '@narok/data';
import type { LabInput, Phase, PublicActor, StopReason } from '@narok/sim';
import { gridPosition } from '@narok/sim';
import { resources, SUPPORTED_LANGUAGES, type SupportedLanguage } from '../src/i18n';
import { validateLabInput } from '../src/validation';
import type { WorkerErrorCode } from '../src/worker-contract';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') keys.push(path);
    else keys.push(...flatten(value, path));
  }
  return keys;
}

function values(tree: Tree, prefix = ''): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') out.push([path, value]);
    else out.push(...values(value, path));
  }
  return out;
}

function treeOf(language: SupportedLanguage): Tree {
  return resources[language].translation as unknown as Tree;
}

function has(language: SupportedLanguage, key: string): boolean {
  return flatten(treeOf(language)).includes(key);
}

describe('locale resources', () => {
  test('EN and PT-BR expose exactly the same key set in both directions', () => {
    const en = new Set(flatten(treeOf('en')));
    const ptBR = new Set(flatten(treeOf('pt-BR')));

    const missingFromPtBr = [...en].filter((key) => !ptBR.has(key)).sort();
    const missingFromEn = [...ptBR].filter((key) => !en.has(key)).sort();

    expect(missingFromPtBr).toEqual([]);
    expect(missingFromEn).toEqual([]);
  });

  test('no translated value is an empty string', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const empty = values(treeOf(language))
        .filter(([, value]) => value.trim() === '')
        .map(([key]) => key);
      expect(empty).toEqual([]);
    }
  });

  test('every class, skill, monster and recipe in the bound content is named in both languages', () => {
    const ids = [
      ...Object.keys(content.classes).map((id) => `class.${id}`),
      ...Object.keys(content.skills).map((id) => `skill.${id}`),
      ...Object.keys(content.monsters).map((id) => `monster.${id}`),
      ...Object.keys(content.recipes).map((id) => `recipe.${id}`),
      'recipe.mixed',
      // R83: `casting` is `SkillId | 'basic' | null`, so 'basic' needs its own key.
      'skill.basic',
    ];
    for (const language of SUPPORTED_LANGUAGES) {
      expect(ids.filter((key) => !has(language, key))).toEqual([]);
    }
  });

  test('every worker/sim error code, phase, stop reason and target reason has a key', () => {
    // Typed as an exhaustive Record so a code added to the union fails to compile
    // here rather than silently reaching the UI untranslated.
    const errorCodes: Record<WorkerErrorCode, true> = {
      INVALID_CONTENT: true,
      INVALID_INPUT: true,
      INVALID_STATE: true,
      WRONG_VERSION: true,
      TIME_REWIND: true,
      UNSAFE_INTEGER: true,
      LOOP_DETECTED: true,
      STALE_GENERATION: true,
      PROTOCOL: true,
      INTERNAL: true,
    };
    const phases: Record<Phase, true> = {
      walking: true,
      fighting: true,
      resting: true,
      respawning: true,
      stopped: true,
    };
    const stopReasons: Record<StopReason, true> = {
      'wipe-limit': true,
      stalemate: true,
      operator: true,
      retreat: true,
      'potion-floor': true,
    };
    const targetReasons: Record<NonNullable<PublicActor['targetReason']>, true> = {
      forced: true,
      threat: true,
      priority: true,
    };

    const keys = [
      ...Object.keys(errorCodes).map((code) => `error.${code}`),
      ...Object.keys(phases).map((phase) => `phase.${phase}`),
      ...Object.keys(stopReasons).map((reason) => `stopReason.${reason}`),
      ...Object.keys(targetReasons).map((reason) => `targetReason.${reason}`),
    ];
    for (const language of SUPPORTED_LANGUAGES) {
      expect(keys.filter((key) => !has(language, key))).toEqual([]);
    }
  });

  test('every validation key the client can actually produce is translated', () => {
    const broken: LabInput[] = [
      {
        seed: 0,
        classes: [],
        recipe: 'nope' as LabInput['recipe'],
        placement: { p9: gridPosition(0, 0) },
        strategies: {},
        rest: { hpStart: 95, mpStart: 95 },
        wipeLimit: 9,
      },
      {
        seed: 1,
        classes: ['guardian', 'cleric'],
        recipe: 'mixed',
        placement: { p0: gridPosition(0, 0), p1: gridPosition(0, 0) },
        strategies: {
          p0: { rules: [{ skillId: 'cleave', enabled: true, condition: { kind: 'targets-at-least', value: 99 } }], target: { kind: 'attacking', partyId: 'p7' } },
          p1: { rules: [], target: { kind: 'nearest' } },
        },
        rest: { hpStart: 50, mpStart: 30 },
        wipeLimit: 1,
      },
      {
        seed: 1,
        classes: ['kobold' as LabInput['classes'][number]],
        recipe: 'mixed',
        placement: { p0: gridPosition(2, 3) },
        strategies: { p0: { rules: [], target: { kind: 'nearest' } } },
        rest: { hpStart: 50, mpStart: 30 },
        wipeLimit: 1,
      },
    ];

    const produced = new Set(broken.flatMap((input) => validateLabInput(input, content)).map((issue) => issue.messageKey));
    expect(produced.size).toBeGreaterThanOrEqual(10);
    for (const language of SUPPORTED_LANGUAGES) {
      expect([...produced].filter((key) => !has(language, key)).sort()).toEqual([]);
    }
  });
});
