import type { ClassId, Content, RecipeId, SkillId } from '@narok/data';
import { SimError } from './errors';
import { schedule } from './scheduler';
import { derive } from './math';
import type { Battlefield } from './battlefield/types';
import type {
  Actor,
  ActorId,
  Condition,
  LabInput,
  Metrics,
  PendingRules,
  PositionId,
  Rule,
  SimState,
  Strategy,
  TargetMode,
} from './types';

const CLASS_IDS: readonly ClassId[] = ['guardian', 'cleric', 'ranger', 'arcanist'];
const RECIPE_IDS: readonly (RecipeId | 'mixed')[] = ['melee', 'ranged', 'clustered', 'mixed'];
const PRIORITY_TARGET_KINDS = ['lowest-hp', 'highest-hp', 'highest-level', 'nearest'] as const;
/** Skills whose only legal enabled condition is `always`. */
const ALWAYS_ONLY_SKILLS: readonly SkillId[] = ['smite', 'double-shot', 'fire-bolt'];
/** Damaging AoE skills that pair with `always` or `targets-at-least`. */
const AOE_THRESHOLD_SKILLS: readonly SkillId[] = ['cleave', 'arrow-rain', 'frost-nova'];

function failInput(field: string, message: string): never {
  throw new SimError('INVALID_INPUT', field, message);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    failInput(field, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) failInput(field, 'expected an array');
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') failInput(field, 'expected a string');
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') failInput(field, 'expected a boolean');
  return value;
}

function requireOneOf<T extends string>(value: unknown, field: string, options: readonly T[]): T {
  const candidate = requireString(value, field);
  if (!options.includes(candidate as T)) {
    failInput(field, `expected one of ${options.join(', ')}`);
  }
  return candidate as T;
}

function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    failInput(field, 'expected an integer');
  }
  if (value < min || value > max) failInput(field, `expected an integer between ${min} and ${max}`);
  return value;
}

function validateCondition(value: unknown, field: string, skillId: SkillId): Condition {
  const record = requireRecord(value, field);
  const kind = requireString(record.kind, `${field}.kind`);
  if (skillId === 'heal') {
    if (kind !== 'ally-hp-below') failInput(`${field}.kind`, 'heal requires ally-hp-below');
    return { kind: 'ally-hp-below', value: requireInt(record.value, `${field}.value`, 1, 99) };
  }
  if (skillId === 'taunt') {
    if (kind !== 'ally-targeted') failInput(`${field}.kind`, 'taunt requires ally-targeted');
    return { kind: 'ally-targeted' };
  }
  if (AOE_THRESHOLD_SKILLS.includes(skillId)) {
    if (kind === 'always') return { kind: 'always' };
    if (kind === 'targets-at-least') {
      return { kind: 'targets-at-least', value: requireInt(record.value, `${field}.value`, 1, 5) };
    }
    failInput(`${field}.kind`, 'expected always or targets-at-least');
  }
  if (ALWAYS_ONLY_SKILLS.includes(skillId)) {
    if (kind !== 'always') failInput(`${field}.kind`, 'expected always');
    return { kind: 'always' };
  }
  failInput(field, `no condition rule defined for skill ${skillId}`);
}

function validateTarget(value: unknown, field: string, rosterIds: readonly ActorId[]): TargetMode {
  const record = requireRecord(value, field);
  const kind = requireString(record.kind, `${field}.kind`);
  if (kind === 'attacking') {
    const partyId = requireString(record.partyId, `${field}.partyId`);
    if (!rosterIds.includes(partyId)) failInput(`${field}.partyId`, 'partyId must be a roster id');
    return { kind: 'attacking', partyId };
  }
  if ((PRIORITY_TARGET_KINDS as readonly string[]).includes(kind)) {
    return { kind: kind as (typeof PRIORITY_TARGET_KINDS)[number] };
  }
  failInput(`${field}.kind`, 'expected a valid target mode');
}

function validateStrategy(
  value: unknown,
  field: string,
  classId: ClassId,
  content: Content,
  rosterIds: readonly ActorId[],
): Strategy {
  const record = requireRecord(value, field);
  const rulesRaw = requireArray(record.rules, `${field}.rules`);
  const classSkills = content.classes[classId].skills;
  if (rulesRaw.length !== classSkills.length) {
    failInput(`${field}.rules`, `expected exactly ${classSkills.length} rules`);
  }
  const seen = new Set<SkillId>();
  const rules: Rule[] = rulesRaw.map((raw, index) => {
    const ruleField = `${field}.rules.${index}`;
    const ruleRecord = requireRecord(raw, ruleField);
    const skillId = requireString(ruleRecord.skillId, `${ruleField}.skillId`) as SkillId;
    if (!classSkills.includes(skillId)) {
      failInput(`${ruleField}.skillId`, `${skillId} is not a skill of ${classId}`);
    }
    if (seen.has(skillId)) failInput(`${ruleField}.skillId`, `duplicate skill ${skillId}`);
    seen.add(skillId);
    const enabled = requireBoolean(ruleRecord.enabled, `${ruleField}.enabled`);
    const condition = validateCondition(ruleRecord.condition, `${ruleField}.condition`, skillId);
    return { skillId, enabled, condition };
  });
  const target = validateTarget(record.target, `${field}.target`, rosterIds);
  return { rules, target };
}

/**
 * Validates an unknown value as a {@link LabInput} per contract §3 / ruling R21,
 * throwing `SimError('INVALID_INPUT', fieldPath)` on any violation, and returns a
 * freshly-built object sharing no references with `value`. Used directly by
 * {@link startState} (which both validates and deep-clones the caller's input in
 * one pass) and by `decodeSnapshot`'s nested `state.input` validation.
 */
export function validateLabInput(value: unknown, content: Content, battlefield: Battlefield): LabInput {
  const record = requireRecord(value, 'input');

  const classesRaw = requireArray(record.classes, 'input.classes');
  if (classesRaw.length < 1 || classesRaw.length > 3) {
    failInput('input.classes', 'expected 1 to 3 classes');
  }
  const classes = classesRaw.map((raw, index) => requireOneOf(raw, `input.classes.${index}`, CLASS_IDS));
  const rosterIds: ActorId[] = classes.map((_, index) => `p${index}`);

  const placementRecord = requireRecord(record.placement, 'input.placement');
  const placementKeys = Object.keys(placementRecord);
  if (
    placementKeys.length !== rosterIds.length ||
    !rosterIds.every((id) => Object.hasOwn(placementRecord, id)) ||
    !placementKeys.every((key) => rosterIds.includes(key))
  ) {
    failInput('input.placement', 'placement keys must exactly match the roster ids');
  }
  const placement: Record<ActorId, PositionId> = {};
  const rawPositions: PositionId[] = [];
  for (const id of rosterIds) {
    const position = requireString(placementRecord[id], `input.placement.${id}`) as PositionId;
    placement[id] = position;
    rawPositions.push(position);
  }
  battlefield.validatePlacement(rawPositions, 'party');

  const strategiesRecord = requireRecord(record.strategies, 'input.strategies');
  const strategyKeys = Object.keys(strategiesRecord);
  if (
    strategyKeys.length !== rosterIds.length ||
    !rosterIds.every((id) => Object.hasOwn(strategiesRecord, id)) ||
    !strategyKeys.every((key) => rosterIds.includes(key))
  ) {
    failInput('input.strategies', 'strategies keys must exactly match the roster ids');
  }
  const strategies: Record<ActorId, Strategy> = {};
  rosterIds.forEach((id, index) => {
    strategies[id] = validateStrategy(
      strategiesRecord[id],
      `input.strategies.${id}`,
      classes[index],
      content,
      rosterIds,
    );
  });

  const restRecord = requireRecord(record.rest, 'input.rest');
  const rest = {
    hpStart: requireInt(restRecord.hpStart, 'input.rest.hpStart', 0, 89),
    mpStart: requireInt(restRecord.mpStart, 'input.rest.mpStart', 0, 79),
  };

  const wipeLimit = requireInt(record.wipeLimit, 'input.wipeLimit', 1, 5);
  const seed = requireInt(record.seed, 'input.seed', 1, 4294967295);
  const recipe = requireOneOf(record.recipe, 'input.recipe', RECIPE_IDS);

  return { seed, classes, recipe, placement, strategies, rest, wipeLimit };
}

/** The four fields a strategy preset holds (owner decision 2026-09-25), and nothing else. */
const PENDING_RULE_KEYS: readonly (keyof PendingRules)[] = ['placement', 'strategies', 'rest', 'wipeLimit'];

/**
 * Validates an unknown value as {@link PendingRules} for the roster of `input`
 * (ruling R115). There is one validator, not two: the rules are merged over
 * the running input and handed to {@link validateLabInput}, so a queued set
 * that could not start a hunt can never be queued either. Field paths are
 * reported under `pendingRules.` and the result shares no references with
 * `value`.
 */
export function validatePendingRules(
  value: unknown,
  input: LabInput,
  content: Content,
  battlefield: Battlefield,
): PendingRules {
  const record = requireRecord(value, 'pendingRules');
  for (const key of Object.keys(record)) {
    if (!(PENDING_RULE_KEYS as readonly string[]).includes(key)) {
      failInput(`pendingRules.${key}`, 'not a field a strategy preset holds');
    }
  }

  let merged: LabInput;
  try {
    merged = validateLabInput(
      {
        seed: input.seed,
        classes: input.classes,
        recipe: input.recipe,
        placement: record.placement,
        strategies: record.strategies,
        rest: record.rest,
        wipeLimit: record.wipeLimit,
      },
      content,
      battlefield,
    );
  } catch (error) {
    if (error instanceof SimError && error.code === 'INVALID_INPUT') {
      const field = error.field.startsWith('input.')
        ? `pendingRules.${error.field.slice('input.'.length)}`
        : `pendingRules.${error.field}`;
      throw new SimError('INVALID_INPUT', field, error.message);
    }
    throw error;
  }

  return {
    placement: merged.placement,
    strategies: merged.strategies,
    rest: merged.rest,
    wipeLimit: merged.wipeLimit,
  };
}

/** Spec §6 default rule tables (R22), all rules enabled. */
export function defaultStrategy(classId: ClassId): Strategy {
  switch (classId) {
    case 'guardian':
      return {
        rules: [
          { skillId: 'taunt', enabled: true, condition: { kind: 'ally-targeted' } },
          { skillId: 'cleave', enabled: true, condition: { kind: 'targets-at-least', value: 2 } },
        ],
        target: { kind: 'nearest' },
      };
    case 'cleric':
      return {
        rules: [
          { skillId: 'heal', enabled: true, condition: { kind: 'ally-hp-below', value: 60 } },
          { skillId: 'smite', enabled: true, condition: { kind: 'always' } },
        ],
        target: { kind: 'lowest-hp' },
      };
    case 'ranger':
      return {
        rules: [
          { skillId: 'arrow-rain', enabled: true, condition: { kind: 'targets-at-least', value: 3 } },
          { skillId: 'double-shot', enabled: true, condition: { kind: 'always' } },
        ],
        target: { kind: 'lowest-hp' },
      };
    case 'arcanist':
      return {
        rules: [
          { skillId: 'frost-nova', enabled: true, condition: { kind: 'targets-at-least', value: 3 } },
          { skillId: 'fire-bolt', enabled: true, condition: { kind: 'always' } },
        ],
        target: { kind: 'lowest-hp' },
      };
  }
}

/**
 * Builds a fresh experiment `SimState` (ruling R21): validates `input` (also
 * yielding a deep clone independent of the caller's object graph), creates
 * full-resource party actors from the roster's class definitions, zeroes
 * metrics/sequences, and schedules the first walk completion and the first
 * global regen tick.
 */
export function startState(content: Content, battlefield: Battlefield, input: LabInput): SimState {
  const validatedInput = validateLabInput(input, content, battlefield);

  const actors: Record<ActorId, Actor> = {};
  const metricsActors: Metrics['actors'] = {};
  validatedInput.classes.forEach((classId, index) => {
    const id = `p${index}`;
    const definition = content.classes[classId];
    const stats = derive(definition);
    actors[id] = {
      id,
      side: 'party',
      definitionId: classId,
      level: definition.level,
      family: 'humanoid',
      element: 'neutral',
      attributes: { ...definition.attributes },
      stats,
      hp: stats.maxHp,
      mp: stats.maxMp,
      position: validatedInput.placement[id],
      basicKind: definition.basicKind,
      basicRange: definition.basicRange,
      skills: [...definition.skills],
      cooldowns: {},
      statuses: [],
      threat: {},
      forcedTarget: null,
      currentTarget: null,
      pendingCast: null,
      actionToken: 0,
    };
    metricsActors[id] = { damageDealt: 0, damageReceived: 0, healingDone: 0 };
  });

  const state: SimState = {
    schemaVersion: 1,
    simulationVersion: 'b1',
    contentVersion: content.version,
    gridHash: content.gridHash,
    nowMs: 0,
    rng: validatedInput.seed,
    nextQueueSeq: 0,
    nextDomainSeq: 0,
    epoch: 0,
    encounterCount: 0,
    encounterStartedAt: null,
    phase: 'walking',
    stopReason: null,
    input: validatedInput,
    pendingRules: null,
    actors,
    queue: [],
    metrics: {
      kills: 0,
      wins: 0,
      wipes: 0,
      rawExp: 0,
      rawGold: 0,
      damageDealt: 0,
      effectiveHealing: 0,
      walkMs: 0,
      fightMs: 0,
      restMs: 0,
      respawnMs: 0,
      actors: metricsActors,
    },
  };

  schedule(state, { at: content.walkMs, kind: 'transition', actorId: '', epoch: null, token: null });
  schedule(state, { at: content.regenMs, kind: 'regen', actorId: '', epoch: null, token: null });

  return state;
}
