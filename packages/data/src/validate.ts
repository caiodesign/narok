import {
  BAND_DRAW_SPACE, BASE_BAND_PPM, RARITIES, RARITY_RULES, TIER_LEVEL_REQUIREMENTS, bonusCount, valueTier,
} from './items';
import type {
  Attributes,
  BonusDefinition,
  BonusKind,
  ClassDefinition,
  ClassId,
  ConsumableDrop,
  Content,
  DamageKind,
  Element,
  Family,
  GridConfig,
  Handedness,
  ItemDefinition,
  MonsterDefinition,
  OnboardingGrant,
  PityConfig,
  Rarity,
  RarityDefinition,
  RecipeDefinition,
  RecipeId,
  ShapeId,
  SkillDefinition,
  SkillId,
  Slot,
} from './types';

/** Thrown by {@link validateContent} for any structurally invalid content value. */
export class ContentError extends Error {
  readonly code = 'INVALID_CONTENT' as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ContentError';
    this.field = field;
  }
}

const CLASS_IDS: readonly ClassId[] = ['guardian', 'cleric', 'ranger', 'arcanist'];
const SKILL_IDS: readonly SkillId[] = [
  'taunt', 'cleave', 'heal', 'smite', 'double-shot', 'arrow-rain', 'fire-bolt', 'frost-nova',
];
const RECIPE_IDS: readonly RecipeId[] = ['melee', 'ranged', 'clustered'];
const ELEMENTS: readonly Element[] = ['neutral', 'fire', 'water', 'earth', 'wind'];
const SHAPE_IDS: readonly ShapeId[] = ['single', 'cleave', 'square', 'plus'];
const DAMAGE_KINDS: readonly DamageKind[] = ['physical', 'magic'];
const FAMILIES: readonly Family[] = ['beast', 'undead', 'demon', 'plant', 'insect', 'humanoid'];
const EFFECTS: readonly SkillDefinition['effect'][] = ['damage', 'heal', 'taunt'];

function fail(field: string, message: string): never {
  throw new ContentError(field, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail(field, 'expected an object');
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(field, 'expected an array');
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(field, 'expected a string');
  return value;
}

function requireOneOf<T extends string>(value: unknown, field: string, options: readonly T[]): T {
  const candidate = requireString(value, field);
  if (!options.includes(candidate as T)) {
    fail(field, `expected one of ${options.join(', ')}`);
  }
  return candidate as T;
}

function requireSafeInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    fail(field, 'expected a finite safe integer');
  }
  if (value < min || value > max) {
    fail(field, `expected an integer between ${min} and ${max}`);
  }
  return value;
}

/** Validates an object with exactly the given keys, one entry per id. */
function requireKeyedRecord<K extends string, V>(
  value: unknown,
  field: string,
  ids: readonly K[],
  validateEntry: (raw: unknown, entryField: string, id: K) => V,
): Record<K, V> {
  const record = requireRecord(value, field);
  const result = {} as Record<K, V>;
  for (const id of ids) {
    if (!(id in record)) fail(`${field}.${id}`, `missing entry ${id}`);
    result[id] = validateEntry(record[id], `${field}.${id}`, id);
  }
  return result;
}

function requireRowList(value: unknown, field: string, height: number): number[] {
  const raw = requireArray(value, field);
  if (raw.length === 0) fail(field, 'expected at least one row');
  const seen = new Set<number>();
  return raw.map((entry, index) => {
    const row = requireSafeInt(entry, `${field}.${index}`, 0, height - 1);
    if (seen.has(row)) fail(`${field}.${index}`, `duplicate row ${row}`);
    seen.add(row);
    return row;
  });
}

function validateAttributes(value: unknown, field: string): Attributes {
  const record = requireRecord(value, field);
  return {
    str: requireSafeInt(record.str, `${field}.str`, 0, 999),
    agi: requireSafeInt(record.agi, `${field}.agi`, 0, 999),
    vit: requireSafeInt(record.vit, `${field}.vit`, 0, 999),
    int: requireSafeInt(record.int, `${field}.int`, 0, 999),
    dex: requireSafeInt(record.dex, `${field}.dex`, 0, 999),
    luk: requireSafeInt(record.luk, `${field}.luk`, 0, 999),
  };
}

function validateGrid(value: unknown, field: string): GridConfig {
  const record = requireRecord(value, field);
  const width = requireSafeInt(record.width, `${field}.width`, 4, 8);
  const height = requireSafeInt(record.height, `${field}.height`, 4, 8);
  const playerRows = requireRowList(record.playerRows, `${field}.playerRows`, height);
  const enemyRows = requireRowList(record.enemyRows, `${field}.enemyRows`, height);
  if (playerRows.length * width < 3) {
    fail(`${field}.playerRows`, 'expected at least three player spawn cells');
  }
  if (enemyRows.length * width < 5) {
    fail(`${field}.enemyRows`, 'expected at least five enemy spawn cells');
  }
  const moveMs = requireSafeInt(record.moveMs, `${field}.moveMs`, 1, 1_000_000);
  const maxEnemies = requireSafeInt(record.maxEnemies, `${field}.maxEnemies`, 1, 100);
  return { width, height, playerRows, enemyRows, moveMs, maxEnemies };
}

function validateOffsets(value: unknown, field: string): [number, number][] {
  const raw = requireArray(value, field);
  if (raw.length === 0) fail(field, 'expected at least one offset');
  return raw.map((entry, index) => {
    const pair = requireArray(entry, `${field}.${index}`);
    if (pair.length !== 2) fail(`${field}.${index}`, 'expected a [column,row] pair');
    const column = requireSafeInt(pair[0], `${field}.${index}.0`, -10, 10);
    const row = requireSafeInt(pair[1], `${field}.${index}.1`, -10, 10);
    return [column, row] as [number, number];
  });
}

function validateSkill(value: unknown, field: string, id: SkillId): SkillDefinition {
  const record = requireRecord(value, field);
  const declaredId = requireOneOf(record.id, `${field}.id`, SKILL_IDS);
  if (declaredId !== id) fail(`${field}.id`, `expected id ${id}`);
  return {
    id,
    mp: requireSafeInt(record.mp, `${field}.mp`, 0, 1_000),
    cooldownMs: requireSafeInt(record.cooldownMs, `${field}.cooldownMs`, 1, 1_000_000),
    baseCastMs: requireSafeInt(record.baseCastMs, `${field}.baseCastMs`, 0, 1_000_000),
    range: requireSafeInt(record.range, `${field}.range`, 1, 20),
    shape: requireOneOf(record.shape, `${field}.shape`, SHAPE_IDS),
    powerBp: requireSafeInt(record.powerBp, `${field}.powerBp`, 0, 1_000_000),
    hits: requireSafeInt(record.hits, `${field}.hits`, 1, 10),
    effect: requireOneOf(record.effect, `${field}.effect`, EFFECTS),
    damageKind: requireOneOf(record.damageKind, `${field}.damageKind`, DAMAGE_KINDS),
    element: requireOneOf(record.element, `${field}.element`, ELEMENTS),
    slowBp: requireSafeInt(record.slowBp, `${field}.slowBp`, 0, 10_000),
    durationMs: requireSafeInt(record.durationMs, `${field}.durationMs`, 0, 1_000_000),
  };
}

function validateClass(
  value: unknown,
  field: string,
  id: ClassId,
  skills: Record<SkillId, SkillDefinition>,
): ClassDefinition {
  const record = requireRecord(value, field);
  const declaredId = requireOneOf(record.id, `${field}.id`, CLASS_IDS);
  if (declaredId !== id) fail(`${field}.id`, `expected id ${id}`);
  const skillList = requireArray(record.skills, `${field}.skills`);
  const resolvedSkills = skillList.map((entry, index) => {
    const skillId = requireString(entry, `${field}.skills.${index}`) as SkillId;
    if (!(skillId in skills)) fail(`${field}.skills.${index}`, `unknown skill id ${skillId}`);
    return skillId;
  });
  return {
    id,
    attributes: validateAttributes(record.attributes, `${field}.attributes`),
    level: requireSafeInt(record.level, `${field}.level`, 1, 99),
    baseHp: requireSafeInt(record.baseHp, `${field}.baseHp`, 1, 1_000_000),
    hpPerLevel: requireSafeInt(record.hpPerLevel, `${field}.hpPerLevel`, 0, 100_000),
    baseMp: requireSafeInt(record.baseMp, `${field}.baseMp`, 0, 1_000_000),
    mpPerLevel: requireSafeInt(record.mpPerLevel, `${field}.mpPerLevel`, 0, 100_000),
    weaponAtk: requireSafeInt(record.weaponAtk, `${field}.weaponAtk`, 0, 100_000),
    weaponMatk: requireSafeInt(record.weaponMatk, `${field}.weaponMatk`, 0, 100_000),
    armorDef: requireSafeInt(record.armorDef, `${field}.armorDef`, 0, 100_000),
    armorMdef: requireSafeInt(record.armorMdef, `${field}.armorMdef`, 0, 100_000),
    basicIntervalMs: requireSafeInt(record.basicIntervalMs, `${field}.basicIntervalMs`, 1, 1_000_000),
    basicRange: requireSafeInt(record.basicRange, `${field}.basicRange`, 1, 20),
    basicKind: requireOneOf(record.basicKind, `${field}.basicKind`, DAMAGE_KINDS),
    skills: resolvedSkills,
  };
}

function validateMonster(value: unknown, field: string, id: string): MonsterDefinition {
  const record = requireRecord(value, field);
  const declaredId = requireString(record.id, `${field}.id`);
  if (declaredId !== id) fail(`${field}.id`, `expected id ${id}`);
  const goldMin = requireSafeInt(record.goldMin, `${field}.goldMin`, 0, 1_000_000);
  const goldMax = requireSafeInt(record.goldMax, `${field}.goldMax`, 0, 1_000_000);
  if (goldMin > goldMax) fail(`${field}.goldMax`, 'expected goldMin <= goldMax');
  return {
    id,
    level: requireSafeInt(record.level, `${field}.level`, 1, 99),
    family: requireOneOf(record.family, `${field}.family`, FAMILIES),
    element: requireOneOf(record.element, `${field}.element`, ELEMENTS),
    hp: requireSafeInt(record.hp, `${field}.hp`, 1, 100_000_000),
    mp: requireSafeInt(record.mp, `${field}.mp`, 0, 100_000_000),
    atk: requireSafeInt(record.atk, `${field}.atk`, 0, 1_000_000),
    matk: requireSafeInt(record.matk, `${field}.matk`, 0, 1_000_000),
    def: requireSafeInt(record.def, `${field}.def`, 0, 1_000_000),
    mdef: requireSafeInt(record.mdef, `${field}.mdef`, 0, 1_000_000),
    hit: requireSafeInt(record.hit, `${field}.hit`, 0, 1_000),
    flee: requireSafeInt(record.flee, `${field}.flee`, 0, 1_000),
    intervalMs: requireSafeInt(record.intervalMs, `${field}.intervalMs`, 1, 1_000_000),
    range: requireSafeInt(record.range, `${field}.range`, 1, 20),
    rawExp: requireSafeInt(record.rawExp, `${field}.rawExp`, 0, 1_000_000),
    rawGold: requireSafeInt(record.rawGold, `${field}.rawGold`, 0, 1_000_000),
    // References into `items` are checked by validateItemContent.
    equipment: requireArray(record.equipment, `${field}.equipment`).map((entry, index) =>
      requireString(entry, `${field}.equipment.${index}`)),
    consumables: validateConsumables(record.consumables, `${field}.consumables`),
    dropMultiplier: validateDropMultiplier(record.dropMultiplier, `${field}.dropMultiplier`),
    goldMin,
    goldMax,
  };
}

/**
 * A monster's drop multiplier scales every rarity band's width (Part 3 §2.3).
 * It stays an integer (ruling R130): band edges stay integral in ppm, and the
 * spec's "roughly 2–3" for tougher monsters needs no finer grain. Refused when
 * the scaled bands would overrun the band draw's 1,000,000 ppm space.
 */
function validateDropMultiplier(value: unknown, field: string): number {
  const multiplier = requireSafeInt(value, field, 1, 1_000);
  if (BASE_BAND_PPM * multiplier > BAND_DRAW_SPACE) {
    fail(field, `scaled band sum ${BASE_BAND_PPM * multiplier} ppm exceeds ${BAND_DRAW_SPACE}`);
  }
  return multiplier;
}

/**
 * A monster's separate consumable roll (layer-1 §7.2), one `ppm` chance per
 * consumable id, together at most 1,000,000 (ruling R126). Consumable
 * definitions do not exist yet, so ids are checked for shape only.
 */
function validateConsumables(value: unknown, field: string): ConsumableDrop[] {
  let total = 0;
  const seen = new Set<string>();
  return requireArray(value, field).map((entry, index) => {
    const entryField = `${field}.${index}`;
    const record = requireRecord(entry, entryField);
    const consumableId = requireString(record.consumableId, `${entryField}.consumableId`);
    if (seen.has(consumableId)) fail(`${entryField}.consumableId`, `duplicate consumable ${consumableId}`);
    seen.add(consumableId);
    const ppm = requireSafeInt(record.ppm, `${entryField}.ppm`, 1, 1_000_000);
    total += ppm;
    if (total > 1_000_000) fail(`${entryField}.ppm`, 'consumable chances exceed 1,000,000 ppm');
    return { consumableId, ppm };
  });
}

function validateMonsters(value: unknown, field: string): Record<string, MonsterDefinition> {
  const record = requireRecord(value, field);
  const ids = Object.keys(record);
  if (ids.length === 0) fail(field, 'expected at least one monster');
  const result: Record<string, MonsterDefinition> = {};
  for (const id of ids) {
    result[id] = validateMonster(record[id], `${field}.${id}`, id);
  }
  return result;
}

function validateRecipe(
  value: unknown,
  field: string,
  id: RecipeId,
  monsters: Record<string, MonsterDefinition>,
  grid: GridConfig,
): RecipeDefinition {
  const record = requireRecord(value, field);
  const declaredId = requireOneOf(record.id, `${field}.id`, RECIPE_IDS);
  if (declaredId !== id) fail(`${field}.id`, `expected id ${id}`);
  const weight = requireSafeInt(record.weight, `${field}.weight`, 1, 1_000);
  const monsterList = requireArray(record.monsters, `${field}.monsters`);
  if (monsterList.length === 0) fail(`${field}.monsters`, 'expected at least one monster');
  if (monsterList.length > 5) fail(`${field}.monsters`, 'expected at most five monsters');
  if (monsterList.length > grid.maxEnemies) {
    fail(`${field}.monsters`, `expected at most ${grid.maxEnemies} monsters`);
  }
  const seenCells = new Set<string>();
  const resolvedMonsters = monsterList.map((entry, index) => {
    const entryField = `${field}.monsters.${index}`;
    const monsterEntry = requireRecord(entry, entryField);
    const monsterId = requireString(monsterEntry.monsterId, `${entryField}.monsterId`);
    if (!(monsterId in monsters)) fail(`${entryField}.monsterId`, `unknown monster ${monsterId}`);
    const column = requireSafeInt(monsterEntry.column, `${entryField}.column`, 0, grid.width - 1);
    const row = requireSafeInt(monsterEntry.row, `${entryField}.row`, 0, grid.height - 1);
    if (!grid.enemyRows.includes(row)) fail(`${entryField}.row`, 'expected a row inside grid.enemyRows');
    const cellKey = `${column},${row}`;
    if (seenCells.has(cellKey)) fail(entryField, `duplicate spawn cell (${cellKey})`);
    seenCells.add(cellKey);
    return { monsterId, column, row };
  });
  return { id, weight, monsters: resolvedMonsters };
}

// ---------------------------------------------------------------------------
// Equipment content (Part 3 §1.5)
// ---------------------------------------------------------------------------

const SLOTS: readonly Slot[] = [
  'weapon', 'offhand', 'head', 'body', 'cloak', 'shoes', 'accessory1', 'accessory2',
];
const HANDEDNESS: readonly Handedness[] = ['one-handed', 'two-handed', 'offhand', 'none'];
const ATTRIBUTE_KEYS: readonly (keyof Attributes)[] = ['str', 'agi', 'vit', 'int', 'dex', 'luk'];
/**
 * Every `BonusKind` with a composition path in Part 3 §1.4 — a `ResolvedLoadout`
 * field (`packages/sim/src/loadout.ts`) and, for the combat-time kinds, the
 * `offenseBonusBp`/`resistBp` steps of `damage()`. A kind outside this list has
 * no combat formula and is refused (layer-1 §7.1: "Every implemented bonus
 * requires a defined stacking rule and combat formula").
 */
const COMPOSED_BONUS_KINDS: readonly BonusKind[] = [
  'attribute', 'atk-pct', 'matk-pct', 'family-damage', 'element-damage', 'element-resist',
  'crit', 'attack-speed', 'max-hp', 'hp-regen', 'mp-regen', 'heal-power',
];
const FLAT_BONUS_KINDS: readonly BonusKind[] = ['attribute', 'hp-regen', 'mp-regen'];
const STACKING: readonly BonusDefinition['stacking'][] = ['sum', 'max'];
/** The largest rolled-bonus count any rarity carries: a slot pool must supply this many identities. */
const MAX_BONUS_COUNT = Math.max(...RARITIES.map(bonusCount));

function requireNullOr<T>(value: unknown, validate: () => T): T | null {
  return value === null ? null : validate();
}

function requireUniqueIds(value: unknown, field: string, known: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  return requireArray(value, field).map((entry, index) => {
    const id = requireString(entry, `${field}.${index}`);
    if (!(id in known)) fail(`${field}.${index}`, `unknown id ${id}`);
    if (seen.has(id)) fail(`${field}.${index}`, `duplicate id ${id}`);
    seen.add(id);
    return id;
  });
}

function validateBonus(value: unknown, field: string, id: string, tiers: number): BonusDefinition {
  const record = requireRecord(value, field);
  const declaredId = requireString(record.id, `${field}.id`);
  if (declaredId !== id) fail(`${field}.id`, `expected id ${id}`);
  const kind = requireOneOf(record.kind, `${field}.kind`, COMPOSED_BONUS_KINDS);
  const unit = requireOneOf(record.unit, `${field}.unit`, ['flat', 'bp'] as const);
  if (unit !== (FLAT_BONUS_KINDS.includes(kind) ? 'flat' : 'bp')) {
    fail(`${field}.unit`, `unit ${unit} does not compose for kind ${kind}`);
  }
  const attribute = requireNullOr(record.attribute, () =>
    requireOneOf(record.attribute, `${field}.attribute`, ATTRIBUTE_KEYS));
  if ((attribute !== null) !== (kind === 'attribute')) {
    fail(`${field}.attribute`, 'expected an attribute exactly for kind attribute');
  }
  const family = requireNullOr(record.family, () =>
    requireOneOf(record.family, `${field}.family`, FAMILIES));
  if ((family !== null) !== (kind === 'family-damage')) {
    fail(`${field}.family`, 'expected a family exactly for kind family-damage');
  }
  const element = requireNullOr(record.element, () =>
    requireOneOf(record.element, `${field}.element`, ELEMENTS));
  if ((element !== null) !== (kind === 'element-damage' || kind === 'element-resist')) {
    fail(`${field}.element`, 'expected an element exactly for the element kinds');
  }
  const slotList = requireArray(record.slots, `${field}.slots`);
  if (slotList.length === 0) fail(`${field}.slots`, 'expected at least one slot');
  const slots = slotList.map((entry, index) => requireOneOf(entry, `${field}.slots.${index}`, SLOTS));
  if (new Set(slots).size !== slots.length) fail(`${field}.slots`, 'duplicate slot');
  // Value tier = ceil(itemLevel / 10) indexes spans (assumes Part 3 §8 #3).
  const spanList = requireArray(record.spans, `${field}.spans`);
  if (spanList.length < tiers) fail(`${field}.spans`, `expected at least ${tiers} value tiers`);
  const spans = spanList.map((entry, index) => {
    const spanField = `${field}.spans.${index}`;
    const span = requireRecord(entry, spanField);
    const min = requireSafeInt(span.min, `${spanField}.min`, 0, 1_000_000);
    const max = requireSafeInt(span.max, `${spanField}.max`, 0, 1_000_000);
    if (min > max) fail(spanField, 'expected min <= max');
    return { min, max };
  });
  const stacking = requireOneOf(record.stacking, `${field}.stacking`, STACKING);
  return { id, kind, unit, attribute, family, element, slots, spans, stacking };
}

function validateItem(
  value: unknown,
  field: string,
  id: string,
  bonuses: Record<string, BonusDefinition>,
): ItemDefinition {
  const record = requireRecord(value, field);
  const declaredId = requireString(record.id, `${field}.id`);
  if (declaredId !== id) fail(`${field}.id`, `expected id ${id}`);
  const slot = requireOneOf(record.slot, `${field}.slot`, SLOTS);
  const tier = requireSafeInt(record.tier, `${field}.tier`, 1, 5) as ItemDefinition['tier'];
  const levelRequirement = requireSafeInt(record.levelRequirement, `${field}.levelRequirement`, 1, 99);
  if (levelRequirement !== TIER_LEVEL_REQUIREMENTS[tier - 1]) {
    fail(`${field}.levelRequirement`, `expected ${TIER_LEVEL_REQUIREMENTS[tier - 1]} for tier ${tier}`);
  }
  const classes = requireNullOr(record.classes, () => {
    const list = requireArray(record.classes, `${field}.classes`);
    if (list.length === 0) fail(`${field}.classes`, 'expected null or at least one class');
    const ids = list.map((entry, index) => requireOneOf(entry, `${field}.classes.${index}`, CLASS_IDS));
    if (new Set(ids).size !== ids.length) fail(`${field}.classes`, 'duplicate class');
    return ids;
  });
  const handedness = requireOneOf(record.handedness, `${field}.handedness`, HANDEDNESS);
  const expectedHands: readonly Handedness[] = slot === 'weapon'
    ? ['one-handed', 'two-handed']
    : slot === 'offhand' ? ['offhand'] : ['none'];
  if (!expectedHands.includes(handedness)) {
    fail(`${field}.handedness`, `expected ${expectedHands.join(' or ')} for slot ${slot}`);
  }
  const weapon = slot === 'weapon';
  // The basic-attack fields are non-null exactly for weapons (Part 3 §1.5).
  const weaponField = <T>(key: string, validate: () => T): T | null => {
    if (weapon) return validate();
    if (record[key] !== null) fail(`${field}.${key}`, 'expected null outside the weapon slot');
    return null;
  };
  const basicIntervalMs = weaponField('basicIntervalMs', () =>
    requireSafeInt(record.basicIntervalMs, `${field}.basicIntervalMs`, 1, 1_000_000));
  const basicRange = weaponField('basicRange', () =>
    requireSafeInt(record.basicRange, `${field}.basicRange`, 1, 20));
  const basicKind = weaponField('basicKind', () =>
    requireOneOf(record.basicKind, `${field}.basicKind`, DAMAGE_KINDS));
  // Prices are deferred (spec §4.0; ruling R126): no placeholder price may reach a sale.
  if (record.basePrice !== null) fail(`${field}.basePrice`, 'expected null while prices are deferred');
  const fittingBonuses = requireUniqueIds(record.fittingBonuses, `${field}.fittingBonuses`, bonuses);
  fittingBonuses.forEach((bonusId, index) => {
    if (!bonuses[bonusId]!.slots.includes(slot)) {
      fail(`${field}.fittingBonuses.${index}`, `bonus ${bonusId} is not in the ${slot} pool`);
    }
  });
  // Part 3 §1.1: only a weapon supplies weapon stats; weapons and accessories supply no armour.
  const armoured = !weapon && slot !== 'accessory1' && slot !== 'accessory2';
  const stat = (key: string, supplied: boolean): number => {
    const amount = requireSafeInt(record[key], `${field}.${key}`, 0, 100_000);
    if (!supplied && amount !== 0) fail(`${field}.${key}`, `expected 0 for slot ${slot}`);
    return amount;
  };
  return {
    id,
    slot,
    tier,
    levelRequirement,
    classes,
    handedness,
    weaponAtk: stat('weaponAtk', weapon),
    weaponMatk: stat('weaponMatk', weapon),
    armorDef: stat('armorDef', armoured),
    armorMdef: stat('armorMdef', armoured),
    basicIntervalMs,
    basicRange,
    basicKind,
    basePrice: null,
    fittingBonuses,
  };
}

function validateRarity(value: unknown, field: string, id: Rarity): RarityDefinition {
  const record = requireRecord(value, field);
  // Fixed by layer-1 §7.1 and §7.5 (ruling R125): content carries these exact rules.
  const bonusCountValue = requireSafeInt(record.bonusCount, `${field}.bonusCount`, 0, 4);
  if (bonusCountValue !== bonusCount(id)) fail(`${field}.bonusCount`, `expected ${bonusCount(id)}`);
  if (record.protected !== RARITY_RULES[id].protected) {
    fail(`${field}.protected`, `expected ${RARITY_RULES[id].protected}`);
  }
  // R130: the base band widths are layer-1 §7.2's, so the ladder has one source.
  const ppm = requireSafeInt(record.ppm, `${field}.ppm`, 1, BAND_DRAW_SPACE);
  if (ppm !== RARITY_RULES[id].ppm) fail(`${field}.ppm`, `expected ${RARITY_RULES[id].ppm}`);
  return { bonusCount: bonusCountValue, protected: RARITY_RULES[id].protected, ppm };
}

function validateOnboardingGrant(
  value: unknown,
  field: string,
  classId: ClassId,
  items: Record<string, ItemDefinition>,
  bonuses: Record<string, BonusDefinition>,
): OnboardingGrant {
  const record = requireRecord(value, field);
  const definitionId = requireString(record.definitionId, `${field}.definitionId`);
  const definition = items[definitionId];
  if (definition === undefined) fail(`${field}.definitionId`, `unknown item ${definitionId}`);
  if (definition.classes !== null && !definition.classes.includes(classId)) {
    fail(`${field}.definitionId`, `item ${definitionId} is not usable by ${classId}`);
  }
  // Owner decision 2026-09-21 (Part 3 §8 #11): a fixed Uncommon at item level 1.
  const rarity = requireOneOf(record.rarity, `${field}.rarity`, ['uncommon'] as const);
  const itemLevel = requireSafeInt(record.itemLevel, `${field}.itemLevel`, 1, 1);
  const list = requireArray(record.bonuses, `${field}.bonuses`);
  if (list.length !== bonusCount(rarity)) fail(`${field}.bonuses`, `expected ${bonusCount(rarity)} bonus`);
  const tier = valueTier(itemLevel);
  const rolled = list.map((entry, index) => {
    const entryField = `${field}.bonuses.${index}`;
    const bonusRecord = requireRecord(entry, entryField);
    const bonusId = requireString(bonusRecord.bonusId, `${entryField}.bonusId`);
    const bonus = bonuses[bonusId];
    if (bonus === undefined || !bonus.slots.includes(definition.slot)) {
      fail(`${entryField}.bonusId`, `bonus ${bonusId} is not in the ${definition.slot} pool`);
    }
    const span = bonus.spans[tier - 1]!;
    return { bonusId, value: requireSafeInt(bonusRecord.value, `${entryField}.value`, span.min, span.max) };
  });
  return { definitionId, rarity, itemLevel, bonuses: rolled };
}

/**
 * Validates the equipment half of `Content` (Part 3 §1.5) and the monster
 * equipment references into it: bonuses (a composed kind, a stacking rule and
 * `ceil(maxMonsterLevel / 10)` spans each), every slot pool holding at least as
 * many distinct identities as a Legendary rolls, item definitions, the fixed
 * rarity rules and the onboarding grant.
 */
export function validateItemContent(
  root: Record<string, unknown>,
  monsters: Record<string, MonsterDefinition>,
): Pick<Content, 'items' | 'bonuses' | 'rarities' | 'onboardingGrant'> {
  const maxMonsterLevel = Math.max(...Object.values(monsters).map((monster) => monster.level));
  const tiers = valueTier(maxMonsterLevel);

  const bonusRecord = requireRecord(root.bonuses, 'bonuses');
  const bonuses: Record<string, BonusDefinition> = {};
  for (const id of Object.keys(bonusRecord).sort()) {
    bonuses[id] = validateBonus(bonusRecord[id], `bonuses.${id}`, id, tiers);
  }
  // Each family/element variant is its own identity (assumes Part 3 §8 #2), so
  // an identity is a bonus id; without MAX_BONUS_COUNT of them a Legendary of
  // that slot is unrollable (Part 3 §1.3).
  for (const slot of SLOTS) {
    const pool = Object.values(bonuses).filter((bonus) => bonus.slots.includes(slot));
    if (pool.length < MAX_BONUS_COUNT) {
      fail(`pools.${slot}`, `expected at least ${MAX_BONUS_COUNT} bonus identities, found ${pool.length}`);
    }
  }

  const itemRecord = requireRecord(root.items, 'items');
  const items: Record<string, ItemDefinition> = {};
  for (const id of Object.keys(itemRecord).sort()) {
    items[id] = validateItem(itemRecord[id], `items.${id}`, id, bonuses);
  }

  for (const monster of Object.values(monsters)) {
    monster.equipment.forEach((itemId, index) => {
      if (!(itemId in items)) fail(`monsters.${monster.id}.equipment.${index}`, `unknown item ${itemId}`);
    });
  }

  const rarities = requireKeyedRecord(root.rarities, 'rarities', RARITIES, (raw, entryField, id) =>
    validateRarity(raw, entryField, id),
  );
  const onboardingGrant = requireKeyedRecord(root.onboardingGrant, 'onboardingGrant', CLASS_IDS,
    (raw, entryField, id) => validateOnboardingGrant(raw, entryField, id, items, bonuses),
  );
  return { items, bonuses, rarities, onboardingGrant };
}

/**
 * Bad-luck protection (Part 3 §2.4). The thresholds are an open input: a
 * disabled guarantee carries none, and an enabled one requires both, so no
 * threshold can be substituted for a missing decision.
 */
function validatePity(value: unknown, field: string): PityConfig {
  const record = requireRecord(value, field);
  if (typeof record.guaranteeEnabled !== 'boolean') fail(`${field}.guaranteeEnabled`, 'expected a boolean');
  const enabled = record.guaranteeEnabled;
  const threshold = (key: 'epicPlusThreshold' | 'legendaryThreshold'): number | null => {
    if (!enabled) {
      if (record[key] !== null) fail(`${field}.${key}`, 'a disabled guarantee carries no threshold');
      return null;
    }
    return requireSafeInt(record[key], `${field}.${key}`, 1, 1_000_000_000);
  };
  return {
    guaranteeEnabled: enabled,
    epicPlusThreshold: threshold('epicPlusThreshold'),
    legendaryThreshold: threshold('legendaryThreshold'),
  };
}

export function validateContent(value: unknown): Content {
  const root = requireRecord(value, '$');
  const version = requireString(root.version, 'version');
  const gridHash = requireString(root.gridHash, 'gridHash');
  const grid = validateGrid(root.grid, 'grid');
  const shapes = requireKeyedRecord(root.shapes, 'shapes', SHAPE_IDS, (raw, entryField) =>
    validateOffsets(raw, entryField),
  );
  const skills = requireKeyedRecord(root.skills, 'skills', SKILL_IDS, (raw, entryField, id) =>
    validateSkill(raw, entryField, id),
  );
  const classes = requireKeyedRecord(root.classes, 'classes', CLASS_IDS, (raw, entryField, id) =>
    validateClass(raw, entryField, id, skills),
  );
  const monsters = validateMonsters(root.monsters, 'monsters');
  const recipes = requireKeyedRecord(root.recipes, 'recipes', RECIPE_IDS, (raw, entryField, id) =>
    validateRecipe(raw, entryField, id, monsters, grid),
  );
  const elements = requireKeyedRecord(root.elements, 'elements', ELEMENTS, (raw, entryField) =>
    requireKeyedRecord(raw, entryField, ELEMENTS, (raw2, entryField2) =>
      requireSafeInt(raw2, entryField2, 0, 1_000_000),
    ),
  );
  const walkMs = requireSafeInt(root.walkMs, 'walkMs', 1, 1_000_000);
  const regenMs = requireSafeInt(root.regenMs, 'regenMs', 1, 1_000_000);
  const encounterLimitMs = requireSafeInt(root.encounterLimitMs, 'encounterLimitMs', 1, 100_000_000);
  const respawnMs = requireSafeInt(root.respawnMs, 'respawnMs', 1, 1_000_000);
  // R114: an explicit `null` marks the open input; a missing key is still refused.
  const townReturnTravelMs = root.townReturnTravelMs === null
    ? null
    : requireSafeInt(root.townReturnTravelMs, 'townReturnTravelMs', 1, 100_000_000);
  const equipment = validateItemContent(root, monsters);
  const pity = validatePity(root.pity, 'pity');
  return {
    version,
    gridHash,
    grid,
    classes,
    skills,
    monsters,
    recipes,
    shapes,
    elements,
    walkMs,
    regenMs,
    encounterLimitMs,
    respawnMs,
    townReturnTravelMs,
    ...equipment,
    pity,
  };
}
