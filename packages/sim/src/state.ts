import { CONSUMABLE_STACK_MAX, RARITIES } from '@narok/data';
import type { ClassId, Content, ItemInstance, RecipeId, RolledBonus, SkillId, Slot } from '@narok/data';
import { EXP_SHARE_DENOMINATOR, expToNext, validateAutoSpendTemplate } from '@narok/progression';
import type { Progress } from '@narok/progression';
import { LootPresetError, validateLootPreset, type LootPreset } from '@narok/loot';
import { SimError, type SimErrorCode } from './errors';
import { defaultBag, emptyDropMetrics, starterLoot } from './rewards';
import { schedule } from './scheduler';
import { refreshPartyActor, resolveLoadout } from './loadout';
import { derive } from './math';
import type { Battlefield } from './battlefield/types';
import type {
  Actor,
  ActorId,
  BagState,
  Condition,
  DropProtection,
  HuntCharacter,
  HuntSetup,
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

  const wipeLimit = requireInt(record.wipeLimit, 'input.wipeLimit', WIPE_LIMIT_RANGE[0], WIPE_LIMIT_RANGE[1]);
  const seed = requireInt(record.seed, 'input.seed', 1, 4294967295);
  const recipe = requireOneOf(record.recipe, 'input.recipe', RECIPE_IDS);

  return { seed, classes, recipe, placement, strategies, rest, wipeLimit };
}

/**
 * The wipe limit (layer-1 §5.6; Part 3 §5.5): the total number of wipes a hunt
 * allows — not retries on top of one — one to five, and one for a strategy
 * preset that has not chosen (ruling R140). `validateLabInput` enforces the range.
 */
export const DEFAULT_WIPE_LIMIT = 1;
export const WIPE_LIMIT_RANGE: readonly [number, number] = [1, 5];

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

/** A generous bound on counters and bag sizes, well inside the safe-integer range. */
const MAX_COUNT = 1_000_000_000_000;
/** Consumable ids are content ids: lowercase ASCII, so no key can reach an object prototype. */
const CONSUMABLE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function checkInt(value: unknown, field: string, code: SimErrorCode, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new SimError(code, field, `expected an integer between ${min} and ${max}`);
  }
  return value;
}

function checkRecord(value: unknown, field: string, code: SimErrorCode): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SimError(code, field, 'expected an object');
  }
  return value as Record<string, unknown>;
}

/**
 * The bag a hunt may assume (part 3 §2.5). Shared by `start` (`INVALID_INPUT`)
 * and snapshot decoding (`INVALID_STATE`); returns a fresh copy.
 */
export function validateBag(value: unknown, field: string, code: SimErrorCode): BagState {
  const record = checkRecord(value, field, code);
  const capacity = checkInt(record.capacity, `${field}.capacity`, code, 0, MAX_COUNT);
  const usedSlots = checkInt(record.usedSlots, `${field}.usedSlots`, code, 0, capacity);
  const headroomRecord = checkRecord(record.stackHeadroom, `${field}.stackHeadroom`, code);
  const stackHeadroom: Record<string, number> = {};
  for (const id of Object.keys(headroomRecord).sort()) {
    if (!CONSUMABLE_ID.test(id)) throw new SimError(code, `${field}.stackHeadroom`, 'expected consumable ids');
    stackHeadroom[id] = checkInt(headroomRecord[id], `${field}.stackHeadroom.${id}`, code, 0, CONSUMABLE_STACK_MAX);
  }
  return { capacity, usedSlots, stackHeadroom };
}

/** The bad-luck counters (part 3 §2.4); returns a fresh copy. */
export function validateProtection(value: unknown, field: string, code: SimErrorCode): DropProtection {
  const record = checkRecord(value, field, code);
  return {
    epicPlus: checkInt(record.epicPlus, `${field}.epicPlus`, code, 0, MAX_COUNT),
    legendary: checkInt(record.legendary, `${field}.legendary`, code, 0, MAX_COUNT),
  };
}

/** A loot filter, through the one validator `packages/loot` exports; returns a deep copy. */
export function validateLoot(value: unknown, field: string, code: SimErrorCode): LootPreset {
  try {
    return validateLootPreset(value);
  } catch (error) {
    if (error instanceof LootPresetError) {
      throw new SimError(code, error.field === '$' ? field : `${field}.${error.field}`, error.message);
    }
    throw error;
  }
}

const SLOTS: readonly Slot[] = ['weapon', 'offhand', 'head', 'body', 'cloak', 'shoes', 'accessory1', 'accessory2'];
const ATTRIBUTES = ['str', 'agi', 'vit', 'int', 'dex', 'luk'] as const;

function checkString(value: unknown, field: string, code: SimErrorCode): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new SimError(code, field, 'expected a non-empty string');
  }
  return value;
}

function checkBoolean(value: unknown, field: string, code: SimErrorCode): boolean {
  if (typeof value !== 'boolean') throw new SimError(code, field, 'expected a boolean');
  return value;
}

/**
 * A character's progression (Part 3 §5; ruling R140) against pinned content:
 * a level within the cap, EXP short of the next level (none at the cap), a
 * carry below its denominator, attributes within 1..cap, ranks only of the
 * class's skills, awarded levels never past the level, and a valid template.
 * Shared by `start` (`INVALID_INPUT`) and snapshot decoding (`INVALID_STATE`);
 * returns a fresh copy.
 */
export function validateProgress(
  value: unknown, field: string, code: SimErrorCode, classId: ClassId, content: Content,
): Progress {
  const record = checkRecord(value, field, code);
  const tables = content.progression;
  const level = checkInt(record.level, `${field}.level`, code, 1, tables.levelCap);
  const needed = expToNext(level, tables);
  const exp = checkInt(record.exp, `${field}.exp`, code, 0, needed === null ? 0 : needed - 1);
  const expCarry = checkInt(record.expCarry, `${field}.expCarry`, code, 0, EXP_SHARE_DENOMINATOR - 1);
  const attributesRecord = checkRecord(record.attributes, `${field}.attributes`, code);
  if (Object.keys(attributesRecord).length !== ATTRIBUTES.length) {
    throw new SimError(code, `${field}.attributes`, 'expected exactly the six attributes');
  }
  const attributes = { str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0 };
  for (const key of ATTRIBUTES) {
    attributes[key] = checkInt(attributesRecord[key], `${field}.attributes.${key}`, code, 1, tables.attributeCap);
  }
  const statPoints = checkInt(record.statPoints, `${field}.statPoints`, code, 0, MAX_COUNT);
  const skillPoints = checkInt(record.skillPoints, `${field}.skillPoints`, code, 0, MAX_COUNT);
  const ranksRecord = checkRecord(record.skillRanks, `${field}.skillRanks`, code);
  const skillRanks: Partial<Record<SkillId, number>> = {};
  for (const skillId of Object.keys(ranksRecord).sort()) {
    if (!content.classes[classId].skills.includes(skillId as SkillId)) {
      throw new SimError(code, `${field}.skillRanks.${skillId}`, `not a skill of ${classId}`);
    }
    skillRanks[skillId as SkillId] = checkInt(
      ranksRecord[skillId], `${field}.skillRanks.${skillId}`, code, 0, tables.maxSkillRank,
    );
  }
  const awardedLevels = checkInt(record.awardedLevels, `${field}.awardedLevels`, code, 1, level);
  const template = validateAutoSpendTemplate(record.autoSpendTemplate, tables.attributeCap);
  if (!template.ok) {
    throw new SimError(code, `${field}.autoSpendTemplate${template.field.slice('template'.length)}`, 'invalid auto-spend template');
  }
  return {
    level, exp, expCarry, attributes, statPoints, skillPoints, skillRanks, awardedLevels,
    autoSpendTemplate: template.next,
  };
}

function validateBonuses(value: unknown, field: string, code: SimErrorCode): RolledBonus[] {
  if (!Array.isArray(value)) throw new SimError(code, field, 'expected an array');
  return value.map((raw, index) => {
    const bonus = checkRecord(raw, `${field}.${index}`, code);
    return {
      bonusId: checkString(bonus.bonusId, `${field}.${index}.bonusId`, code),
      value: checkInt(bonus.value, `${field}.${index}.value`, code, 0, MAX_COUNT),
    };
  });
}

/** One worn instance's shape; its content legality is `resolveLoadout`'s to judge. */
function validateInstance(value: unknown, field: string, code: SimErrorCode): ItemInstance {
  const record = checkRecord(value, field, code);
  if (!(RARITIES as readonly unknown[]).includes(record.rarity)) throw new SimError(code, `${field}.rarity`, 'unknown rarity');
  if (record.tradeable !== false) throw new SimError(code, `${field}.tradeable`, 'beta equipment is not tradeable');
  const equippedRecord = checkRecord(record.equipped, `${field}.equipped`, code);
  if (!(SLOTS as readonly unknown[]).includes(equippedRecord.slot)) {
    throw new SimError(code, `${field}.equipped.slot`, 'unknown slot');
  }
  const sourceRecord = checkRecord(record.source, `${field}.source`, code);
  const source = Object.hasOwn(sourceRecord, 'grantId')
    ? { grantId: checkString(sourceRecord.grantId, `${field}.source.grantId`, code) }
    : {
      huntId: checkString(sourceRecord.huntId, `${field}.source.huntId`, code),
      rewardSeq: checkInt(sourceRecord.rewardSeq, `${field}.source.rewardSeq`, code, 0, MAX_COUNT),
    };
  return {
    id: checkString(record.id, `${field}.id`, code),
    accountId: checkString(record.accountId, `${field}.accountId`, code),
    definitionId: checkString(record.definitionId, `${field}.definitionId`, code),
    contentVersion: checkString(record.contentVersion, `${field}.contentVersion`, code),
    rarity: record.rarity as ItemInstance['rarity'],
    itemLevel: checkInt(record.itemLevel, `${field}.itemLevel`, code, 1, MAX_COUNT),
    bonuses: validateBonuses(record.bonuses, `${field}.bonuses`, code),
    tradeable: false,
    locked: checkBoolean(record.locked, `${field}.locked`, code),
    protected: checkBoolean(record.protected, `${field}.protected`, code),
    equipped: {
      characterId: checkString(equippedRecord.characterId, `${field}.equipped.characterId`, code),
      slot: equippedRecord.slot as Slot,
    },
    boundTo: record.boundTo === null ? null : checkString(record.boundTo, `${field}.boundTo`, code),
    source,
  };
}

/**
 * The items one character wears (ruling R140): well-formed instances, all
 * worn by that character and bound to no one else, composing into a legal
 * loadout under pinned content (`resolveLoadout`, Part 3 §1.4).
 */
export function validateEquipped(
  value: unknown, field: string, code: SimErrorCode, characterId: string, content: Content,
): ItemInstance[] {
  if (!Array.isArray(value) || value.length > SLOTS.length) {
    throw new SimError(code, field, 'expected at most one item per slot');
  }
  const items = value.map((raw, index) => validateInstance(raw, `${field}.${index}`, code));
  items.forEach((item, index) => {
    if (item.equipped!.characterId !== characterId) {
      throw new SimError(code, `${field}.${index}.equipped.characterId`, 'worn by another character');
    }
    if (item.boundTo !== null && item.boundTo !== characterId) {
      throw new SimError(code, `${field}.${index}.boundTo`, 'bound to another character');
    }
  });
  try {
    resolveLoadout(items, content);
  } catch (error) {
    if (error instanceof SimError) {
      throw new SimError(code, `${field}${error.field.slice('items'.length)}`, error.message);
    }
    throw error;
  }
  return items;
}

/** A checkpointed {@link HuntCharacter} (ruling R140); returns a fresh copy. */
export function validateHuntCharacter(
  value: unknown, field: string, code: SimErrorCode, classId: ClassId, content: Content,
): HuntCharacter {
  const record = checkRecord(value, field, code);
  const characterId = checkString(record.characterId, `${field}.characterId`, code);
  const progress = validateProgress(record, field, code, classId, content);
  const equipped = validateEquipped(record.equipped, `${field}.equipped`, code, characterId, content);
  return { ...progress, characterId, equipped };
}

/**
 * A party record keyed by exactly the roster ids, each naming a distinct
 * character (ruling R140). Shared by `start` and snapshot decoding.
 */
export function checkPartyKeys(
  record: Record<string, unknown>, field: string, code: SimErrorCode, rosterIds: readonly string[],
  characterIdOf: (entry: unknown) => unknown,
): void {
  const keys = Object.keys(record);
  if (keys.length !== rosterIds.length || !rosterIds.every((id) => Object.hasOwn(record, id))) {
    throw new SimError(code, field, 'expected exactly the roster ids');
  }
  const seen = new Set<unknown>();
  for (const id of rosterIds) {
    const characterId = characterIdOf(record[id]);
    if (seen.has(characterId)) throw new SimError(code, `${field}.${id}.characterId`, 'duplicate character');
    seen.add(characterId);
  }
}

/**
 * Builds a fresh experiment `SimState` (ruling R21): validates `input` (also
 * yielding a deep clone independent of the caller's object graph), creates
 * full-resource party actors from the roster's class definitions, zeroes
 * metrics/sequences, and schedules the first walk completion and the first
 * global regen tick.
 */
export function startState(
  content: Content,
  battlefield: Battlefield,
  input: LabInput,
  setup: HuntSetup = {},
): SimState {
  const validatedInput = validateLabInput(input, content, battlefield);
  const setupRecord = checkRecord(setup, 'setup', 'INVALID_INPUT');
  const lootPresetSnapshot = setupRecord.loot === undefined
    ? starterLoot()
    : validateLoot(setupRecord.loot, 'setup.loot', 'INVALID_INPUT');
  const bagState = setupRecord.bag === undefined ? defaultBag() : validateBag(setupRecord.bag, 'setup.bag', 'INVALID_INPUT');
  const dropProtection = setupRecord.dropProtection === undefined
    ? { epicPlus: 0, legendary: 0 }
    : validateProtection(setupRecord.dropProtection, 'setup.dropProtection', 'INVALID_INPUT');

  // R140: a hunt with characters checkpoints their progression; a lab run has none.
  const rosterIds = validatedInput.classes.map((_, index) => `p${index}`);
  let progression: Record<ActorId, HuntCharacter> | null = null;
  const resources: Record<ActorId, { hp: number; mp: number }> = {};
  if (setupRecord.party !== undefined) {
    const partyRecord = checkRecord(setupRecord.party, 'setup.party', 'INVALID_INPUT');
    checkPartyKeys(partyRecord, 'setup.party', 'INVALID_INPUT', rosterIds,
      (entry) => (typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).characterId : entry));
    const characters: Record<ActorId, HuntCharacter> = {};
    rosterIds.forEach((id, index) => {
      const field = `setup.party.${id}`;
      const member = checkRecord(partyRecord[id], field, 'INVALID_INPUT');
      const characterId = checkString(member.characterId, `${field}.characterId`, 'INVALID_INPUT');
      const classId = validatedInput.classes[index];
      characters[id] = {
        ...validateProgress(member.progress, `${field}.progress`, 'INVALID_INPUT', classId, content),
        characterId,
        equipped: validateEquipped(member.equipped, `${field}.equipped`, 'INVALID_INPUT', characterId, content),
      };
      resources[id] = {
        hp: checkInt(member.hp, `${field}.hp`, 'INVALID_INPUT', 1, MAX_COUNT),
        mp: checkInt(member.mp, `${field}.mp`, 'INVALID_INPUT', 0, MAX_COUNT),
      };
    });
    progression = characters;
  }

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
    if (progression !== null) {
      // A hunt starts from the character's absolute resources, never a free refill (layer-1 §4.5).
      actors[id].hp = resources[id].hp;
      actors[id].mp = resources[id].mp;
      refreshPartyActor(actors[id], progression[id], content);
    }
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
      drops: emptyDropMetrics(),
    },
    // A new hunt is a new reward namespace, so its ordinals start again (part 2 §2).
    nextRewardSeq: 0,
    pendingRewards: [],
    dropProtection,
    lootPresetSnapshot,
    pendingLoot: [],
    bagState,
    progression,
  };

  schedule(state, { at: content.walkMs, kind: 'transition', actorId: '', epoch: null, token: null });
  schedule(state, { at: content.regenMs, kind: 'regen', actorId: '', epoch: null, token: null });

  return state;
}
