import type {
  Attributes,
  ClassDefinition,
  ClassId,
  Content,
  DamageKind,
  Element,
  Family,
  GridConfig,
  MonsterDefinition,
  RecipeDefinition,
  RecipeId,
  ShapeId,
  SkillDefinition,
  SkillId,
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
  };
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
  };
}
