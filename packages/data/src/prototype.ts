import { RARITY_RULES } from './items';
import type {
  BonusDefinition,
  BonusKind,
  ClassDefinition,
  ClassId,
  ConsumableDefinition,
  Content,
  Element,
  Family,
  Handedness,
  ItemDefinition,
  MonsterDefinition,
  OnboardingGrant,
  RecipeDefinition,
  RecipeId,
  ShapeId,
  SkillDefinition,
  SkillId,
  Slot,
  StarterKit,
  StarterWeapon,
} from './types';
import { IDUN_APPLE_ID } from './types';

/** Prototype map identifier. Not a {@link Content} field; the map is fixed for milestone A. */
export const mapId = 'meadow-lab';

/** World-space offsets for each skill shape, anchored on the primary target. */
export const shapeOffsets: Record<ShapeId, [number, number][]> = {
  single: [[0, 0]],
  cleave: [[-1, 0], [0, 0], [1, 0]],
  square: [[0, 0], [1, 0], [0, 1], [1, 1]],
  plus: [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]],
};

const classes: Record<ClassId, ClassDefinition> = {
  guardian: {
    id: 'guardian',
    attributes: { str: 11, agi: 1, vit: 11, int: 1, dex: 6, luk: 1 },
    level: 10,
    baseHp: 100,
    hpPerLevel: 15,
    baseMp: 30,
    mpPerLevel: 3,
    weaponAtk: 25,
    weaponMatk: 0,
    armorDef: 12,
    armorMdef: 3,
    basicIntervalMs: 1_600,
    basicRange: 1,
    basicKind: 'physical',
    skills: ['taunt', 'cleave'],
  },
  cleric: {
    id: 'cleric',
    attributes: { str: 1, agi: 1, vit: 6, int: 16, dex: 1, luk: 1 },
    level: 10,
    baseHp: 70,
    hpPerLevel: 10,
    baseMp: 70,
    mpPerLevel: 8,
    weaponAtk: 10,
    weaponMatk: 22,
    armorDef: 5,
    armorMdef: 8,
    basicIntervalMs: 1_800,
    basicRange: 4,
    basicKind: 'magic',
    skills: ['heal', 'smite', 'revive'],
  },
  ranger: {
    id: 'ranger',
    attributes: { str: 1, agi: 6, vit: 6, int: 1, dex: 16, luk: 1 },
    level: 10,
    baseHp: 80,
    hpPerLevel: 11,
    baseMp: 40,
    mpPerLevel: 5,
    weaponAtk: 28,
    weaponMatk: 0,
    armorDef: 6,
    armorMdef: 3,
    basicIntervalMs: 1_400,
    basicRange: 4,
    basicKind: 'physical',
    skills: ['double-shot', 'arrow-rain'],
  },
  arcanist: {
    id: 'arcanist',
    attributes: { str: 1, agi: 1, vit: 6, int: 16, dex: 6, luk: 1 },
    level: 10,
    baseHp: 60,
    hpPerLevel: 9,
    baseMp: 80,
    mpPerLevel: 9,
    weaponAtk: 5,
    weaponMatk: 25,
    armorDef: 4,
    armorMdef: 8,
    basicIntervalMs: 1_900,
    basicRange: 4,
    basicKind: 'magic',
    skills: ['fire-bolt', 'frost-nova'],
  },
};

/** Every skill but Revive, whose open inputs below read Heal's (owner placeholder 2026-09-30). */
const baseSkills: Record<Exclude<SkillId, 'revive'>, SkillDefinition> = {
  taunt: {
    id: 'taunt',
    mp: 8,
    cooldownMs: 8_000,
    baseCastMs: 0,
    range: 4,
    shape: 'single',
    powerBp: 0,
    hits: 1,
    effect: 'taunt',
    damageKind: 'magic',
    element: 'neutral',
    slowBp: 0,
    durationMs: 4_000,
  },
  cleave: {
    id: 'cleave',
    mp: 6,
    cooldownMs: 4_000,
    baseCastMs: 0,
    range: 1,
    shape: 'cleave',
    powerBp: 12_000,
    hits: 1,
    effect: 'damage',
    damageKind: 'physical',
    element: 'neutral',
    slowBp: 0,
    durationMs: 0,
  },
  heal: {
    id: 'heal',
    mp: 8,
    cooldownMs: 2_500,
    baseCastMs: 800,
    range: 4,
    shape: 'single',
    powerBp: 0,
    hits: 1,
    effect: 'heal',
    damageKind: 'magic',
    element: 'neutral',
    slowBp: 0,
    durationMs: 0,
  },
  smite: {
    id: 'smite',
    mp: 7,
    cooldownMs: 3_000,
    baseCastMs: 600,
    range: 4,
    shape: 'single',
    powerBp: 10_000,
    hits: 1,
    effect: 'damage',
    damageKind: 'magic',
    element: 'neutral',
    slowBp: 0,
    durationMs: 0,
  },
  'double-shot': {
    id: 'double-shot',
    mp: 6,
    cooldownMs: 3_000,
    baseCastMs: 0,
    range: 4,
    shape: 'single',
    powerBp: 7_000,
    hits: 2,
    effect: 'damage',
    damageKind: 'physical',
    element: 'neutral',
    slowBp: 0,
    durationMs: 0,
  },
  'arrow-rain': {
    id: 'arrow-rain',
    mp: 12,
    cooldownMs: 6_000,
    baseCastMs: 700,
    range: 4,
    shape: 'square',
    powerBp: 8_000,
    hits: 1,
    effect: 'damage',
    damageKind: 'physical',
    element: 'neutral',
    slowBp: 0,
    durationMs: 0,
  },
  'fire-bolt': {
    id: 'fire-bolt',
    mp: 8,
    cooldownMs: 3_000,
    baseCastMs: 900,
    range: 4,
    shape: 'single',
    powerBp: 13_000,
    hits: 1,
    effect: 'damage',
    damageKind: 'magic',
    element: 'fire',
    slowBp: 0,
    durationMs: 0,
  },
  'frost-nova': {
    id: 'frost-nova',
    mp: 12,
    cooldownMs: 6_000,
    baseCastMs: 900,
    range: 4,
    shape: 'plus',
    powerBp: 8_000,
    hits: 1,
    effect: 'damage',
    damageKind: 'magic',
    element: 'water',
    slowBp: 3_000,
    durationMs: 5_000,
  },
};

/** Milestone A's monster fields; the B drop fields are added below from {@link OPEN_CONTENT_INPUTS}. */
type MonsterBase = Omit<MonsterDefinition,
  'equipment' | 'consumables' | 'dropMultiplier' | 'goldMin' | 'goldMax'>;

const monsterBases: Record<string, MonsterBase> = {
  'briar-boar': {
    id: 'briar-boar',
    level: 10,
    family: 'beast',
    element: 'earth',
    hp: 180,
    mp: 0,
    atk: 26,
    matk: 0,
    def: 10,
    mdef: 4,
    hit: 18,
    flee: 14,
    intervalMs: 1_800,
    range: 1,
    rawExp: 30,
    rawGold: 3,
  },
  'reed-slinger': {
    id: 'reed-slinger',
    level: 10,
    family: 'plant',
    element: 'wind',
    hp: 110,
    mp: 0,
    atk: 22,
    matk: 0,
    def: 4,
    mdef: 6,
    hit: 22,
    flee: 16,
    intervalMs: 2_000,
    range: 4,
    rawExp: 30,
    rawGold: 3,
  },
  mossling: {
    id: 'mossling',
    level: 10,
    family: 'plant',
    element: 'earth',
    hp: 75,
    mp: 0,
    atk: 16,
    matk: 0,
    def: 3,
    mdef: 3,
    hit: 16,
    flee: 12,
    intervalMs: 1_700,
    range: 1,
    rawExp: 18,
    rawGold: 2,
  },
};

/**
 * OPEN CONTENT INPUTS — provisional, pending owner balance.
 *
 * Part 3 §8 (#2, #3, #8) and layer-1 §7.1–§7.2 leave every equipment and bonus
 * number open: base stats, bonus pools and spans, stacking choices, drop
 * multipliers, monster equipment lists and the onboarding grant's fixed value.
 * Validation, loadout composition and later drop tests need real content, so
 * the prototype table below is built from exactly these values and nothing
 * else (controller ruling, task 5). They are placeholders to exercise
 * structure, chosen small and at the lowest tier only; tests assert structure
 * and composition, never these particular numbers. Replace them with measured
 * values; do not cite them as balance.
 *
 * Not open, and therefore not listed: rarity bonus counts, protection and
 * base band widths in ppm (layer-1 §7.1, §7.2, §7.5), the 1/10/20/30/40 tier ladder (layer-1 §7.1), gold
 * ranges (`goldMin = goldMax = rawGold`, so B's gold draw banks A's gold
 * exactly), `basePrice` (`null`: prices are deferred, spec §4.0), and the class
 * weapons' ATK/MATK/interval/range/kind, which copy each class's milestone A
 * weapon fields so an equipped tier-1 class weapon is exactly A's baseline.
 */
export const OPEN_CONTENT_INPUTS = {
  /** Handedness of each class weapon; the bow and the staff are two-handed. */
  weaponHandedness: {
    guardian: 'one-handed', cleric: 'one-handed', ranger: 'two-handed', arcanist: 'two-handed',
  } satisfies Record<ClassId, Handedness>,
  /** Tier-1 armour of each non-weapon definition. Accessories carry bonuses only (Part 3 §1.1). */
  armour: {
    'wooden-buckler': { armorDef: 2, armorMdef: 0 },
    'leather-cap': { armorDef: 1, armorMdef: 1 },
    'padded-vest': { armorDef: 3, armorMdef: 1 },
    'wool-cloak': { armorDef: 1, armorMdef: 1 },
    'leather-boots': { armorDef: 1, armorMdef: 0 },
    'copper-ring': { armorDef: 0, armorMdef: 0 },
    'bone-charm': { armorDef: 0, armorMdef: 0 },
  },
  /**
   * Per-kind tier-1 value span (flat points, or basis points where the unit is
   * `bp`), stacking rule and pool membership. Every family/element variant is
   * its own identity sharing its kind's span (assumes Part 3 §8 #2; revisit if
   * the owner decides otherwise). Only tier 1 is authored:
   * `ceil(maxMonsterLevel / 10)` is 1 for the prototype map.
   */
  bonusKinds: {
    attribute: { span: { min: 1, max: 3 }, stacking: 'sum', slots: ['weapon', 'offhand', 'head', 'body', 'cloak', 'shoes', 'accessory1', 'accessory2'] },
    'atk-pct': { span: { min: 100, max: 300 }, stacking: 'sum', slots: ['weapon', 'accessory1', 'accessory2'] },
    'matk-pct': { span: { min: 100, max: 300 }, stacking: 'sum', slots: ['weapon', 'accessory1', 'accessory2'] },
    'family-damage': { span: { min: 200, max: 500 }, stacking: 'sum', slots: ['weapon', 'accessory1', 'accessory2'] },
    'element-damage': { span: { min: 200, max: 500 }, stacking: 'sum', slots: ['weapon', 'accessory1', 'accessory2'] },
    'element-resist': { span: { min: 300, max: 800 }, stacking: 'max', slots: ['offhand', 'head', 'body', 'cloak', 'shoes'] },
    crit: { span: { min: 100, max: 300 }, stacking: 'sum', slots: ['weapon', 'head', 'accessory1', 'accessory2'] },
    'attack-speed': { span: { min: 200, max: 500 }, stacking: 'max', slots: ['weapon', 'shoes', 'accessory1', 'accessory2'] },
    'max-hp': { span: { min: 200, max: 500 }, stacking: 'sum', slots: ['offhand', 'head', 'body', 'cloak', 'shoes'] },
    'hp-regen': { span: { min: 1, max: 3 }, stacking: 'sum', slots: ['body', 'cloak', 'accessory1', 'accessory2'] },
    'mp-regen': { span: { min: 1, max: 2 }, stacking: 'sum', slots: ['head', 'cloak', 'accessory1', 'accessory2'] },
    'heal-power': { span: { min: 200, max: 500 }, stacking: 'sum', slots: ['weapon', 'accessory1', 'accessory2'] },
  } satisfies Record<BonusKind, { span: { min: number; max: number }; stacking: 'sum' | 'max'; slots: Slot[] }>,
  /** Fitting bonuses (rolled at weight 2) of each definition. */
  fittingBonuses: {
    'guardian-sword': ['str', 'atk-pct'],
    'cleric-mace': ['heal-power', 'int'],
    'ranger-bow': ['dex', 'crit'],
    'arcanist-staff': ['int', 'matk-pct'],
    'wooden-buckler': ['vit', 'max-hp'],
    'leather-cap': ['int', 'mp-regen'],
    'padded-vest': ['vit', 'max-hp'],
    'wool-cloak': ['agi', 'hp-regen'],
    'leather-boots': ['agi', 'attack-speed'],
    'copper-ring': ['luk', 'crit'],
    'bone-charm': ['dex', 'hp-regen'],
  } satisfies Record<string, string[]>,
  /** Every monster lists every prototype definition, at the normal multiplier (layer-1 §7.2: normal x1). */
  dropMultiplier: 1,
  /**
   * Onboarding grant (Part 3 §8 #11): each class's weapon at item level 1 with
   * its first fitting bonus fixed at that bonus's tier-1 span maximum.
   */
  onboardingBonusValue: 'tier-1 span max',
  /**
   * Bad-luck protection (Part 3 §2.4, §8; layer-1 §7.3): the counters accrue,
   * the guarantee stays off, and no threshold is chosen. Thresholds and the
   * eligibility weighting are resolved from `tools/balance` wait
   * distributions before expanded beta, not before B ships.
   */
  pity: { guaranteeEnabled: false, epicPlusThreshold: null, legendaryThreshold: null },
  /**
   * The Cleric's Revive (owner decision 2026-09-30; ruling R153). What it
   * restores is stated — exactly what Idun's Apple restores — but its MP
   * cost, cast time, cooldown and range are owner placeholders (2026-09-30),
   * "to be discussed", not stated values: a 3 s cast, no cooldown, and Heal's MP cost ("not so
   * expensive") and range.
   */
  revive: {
    mp: baseSkills.heal.mp, baseCastMs: 3_000, cooldownMs: 0, range: baseSkills.heal.range,
  },
  /**
   * Idun's Apple's sources (owner decision 2026-09-30). The owner intends
   * monster drops, quest rewards and player and NPC sale, following the
   * milestones. None is in milestone B: no drop chance is set, so no monster
   * drops it, and nothing may price it (spec §4.0).
   */
  idunApple: { monsterDropPpm: null },
  /**
   * The starter kit's weapon (Part 3 §8 #10; ruling R141): layer-1 §7.6 names
   * only "class starter weapon". Each class's tier-1 weapon as a Common at item
   * level 1 — no bonus, so the onboarding Uncommon is strictly better than it
   * (Part 3 §6) — is a reading, not a stated value.
   */
  starterWeapon: { rarity: 'common', itemLevel: 1 },
} as const;

/**
 * The levelling rules the build compiles into `content.progression` (ruling
 * R134). Every value is stated, not chosen: beta cap 50 and EXP to next
 * `floor(50 * level^2.2)` (layer-1 §5.3, Part 3 §5.1), one skill point at
 * creation and one at every fourth level (layer-1 §5.3), 30 stat points at
 * creation and `3 + floor(L / 5)` on reaching `L > 1`, allocation cap 99
 * (layer-1 §5.4), and five ranks per skill (layer-1 §5.2). The exponent is
 * evaluated by `packages/data/scripts/progression.ts` only; nothing at runtime
 * reads this object.
 */
export const PROGRESSION_SOURCE = {
  levelCap: 50,
  expBase: 50,
  expExponent: 2.2,
  creationStatPoints: 30,
  levelStatPoints: 3,
  levelStatDivisor: 5,
  creationSkillPoints: 1,
  skillPointEveryLevels: 4,
  attributeCap: 99,
  maxSkillRank: 5,
} as const;

const skills: Record<SkillId, SkillDefinition> = {
  ...baseSkills,
  // Owner decision 2026-09-30: the Cleric's revive spell (ruling R153).
  // `powerBp` is unused: it restores what Idun's Apple restores.
  revive: {
    id: 'revive',
    ...OPEN_CONTENT_INPUTS.revive,
    shape: 'single',
    powerBp: 0,
    hits: 1,
    effect: 'revive',
    damageKind: 'magic',
    element: 'neutral',
    slowBp: 0,
    durationMs: 0,
  },
};

const ATTRIBUTE_KEYS = ['str', 'agi', 'vit', 'int', 'dex', 'luk'] as const;
const FAMILY_VARIANTS: readonly Family[] = ['beast', 'undead', 'demon', 'plant', 'insect', 'humanoid'];
const ELEMENT_VARIANTS: readonly Element[] = ['fire', 'water', 'earth', 'wind'];

function bonus(
  id: string,
  kind: BonusKind,
  target: Partial<Pick<BonusDefinition, 'attribute' | 'family' | 'element'>> = {},
): BonusDefinition {
  const rule = OPEN_CONTENT_INPUTS.bonusKinds[kind];
  const flat = kind === 'attribute' || kind === 'hp-regen' || kind === 'mp-regen';
  return {
    id,
    kind,
    unit: flat ? 'flat' : 'bp',
    attribute: target.attribute ?? null,
    family: target.family ?? null,
    element: target.element ?? null,
    slots: [...rule.slots],
    spans: [{ ...rule.span }],
    stacking: rule.stacking,
  };
}

const bonusList: BonusDefinition[] = [
  ...ATTRIBUTE_KEYS.map((attribute) => bonus(attribute, 'attribute', { attribute })),
  bonus('atk-pct', 'atk-pct'),
  bonus('matk-pct', 'matk-pct'),
  ...FAMILY_VARIANTS.map((family) => bonus(`${family}-damage`, 'family-damage', { family })),
  ...ELEMENT_VARIANTS.map((element) => bonus(`${element}-damage`, 'element-damage', { element })),
  ...ELEMENT_VARIANTS.map((element) => bonus(`${element}-resist`, 'element-resist', { element })),
  bonus('crit', 'crit'),
  bonus('attack-speed', 'attack-speed'),
  bonus('max-hp', 'max-hp'),
  bonus('hp-regen', 'hp-regen'),
  bonus('mp-regen', 'mp-regen'),
  bonus('heal-power', 'heal-power'),
];

const bonuses: Record<string, BonusDefinition> = Object.fromEntries(
  bonusList.map((entry) => [entry.id, entry]),
);

type DefinitionId = keyof typeof OPEN_CONTENT_INPUTS.fittingBonuses;

const CLASS_WEAPONS = {
  guardian: 'guardian-sword', cleric: 'cleric-mace', ranger: 'ranger-bow', arcanist: 'arcanist-staff',
} as const satisfies Record<ClassId, DefinitionId>;

/** A tier-1 class weapon carrying its class's milestone A weapon fields verbatim. */
function classWeapon(classId: ClassId): ItemDefinition {
  const id = CLASS_WEAPONS[classId];
  const cls = classes[classId];
  return {
    id,
    slot: 'weapon',
    tier: 1,
    levelRequirement: 1,
    classes: [classId],
    handedness: OPEN_CONTENT_INPUTS.weaponHandedness[classId],
    weaponAtk: cls.weaponAtk,
    weaponMatk: cls.weaponMatk,
    armorDef: 0,
    armorMdef: 0,
    basicIntervalMs: cls.basicIntervalMs,
    basicRange: cls.basicRange,
    basicKind: cls.basicKind,
    basePrice: null,
    fittingBonuses: [...OPEN_CONTENT_INPUTS.fittingBonuses[id]],
  };
}

/** A tier-1 non-weapon definition usable by any class. */
function gear(id: keyof typeof OPEN_CONTENT_INPUTS.armour, slot: Exclude<Slot, 'weapon'>): ItemDefinition {
  return {
    id,
    slot,
    tier: 1,
    levelRequirement: 1,
    classes: null,
    handedness: slot === 'offhand' ? 'offhand' : 'none',
    weaponAtk: 0,
    weaponMatk: 0,
    ...OPEN_CONTENT_INPUTS.armour[id],
    basicIntervalMs: null,
    basicRange: null,
    basicKind: null,
    basePrice: null,
    fittingBonuses: [...OPEN_CONTENT_INPUTS.fittingBonuses[id]],
  };
}

const CLASS_IDS: readonly ClassId[] = ['guardian', 'cleric', 'ranger', 'arcanist'];

const itemList: ItemDefinition[] = [
  ...CLASS_IDS.map(classWeapon),
  gear('wooden-buckler', 'offhand'),
  gear('leather-cap', 'head'),
  gear('padded-vest', 'body'),
  gear('wool-cloak', 'cloak'),
  gear('leather-boots', 'shoes'),
  gear('copper-ring', 'accessory1'),
  gear('bone-charm', 'accessory2'),
];

const items: Record<string, ItemDefinition> = Object.fromEntries(
  itemList.map((entry) => [entry.id, entry]),
);

const monsters: Record<string, MonsterDefinition> = Object.fromEntries(
  Object.entries(monsterBases).map(([id, base]) => [id, {
    ...base,
    equipment: itemList.map((entry) => entry.id).sort(),
    // No drop chance is stated for any potion (layer-1 §7.2 names the roll only),
    // so no monster drops one yet (ruling R126).
    consumables: [],
    dropMultiplier: OPEN_CONTENT_INPUTS.dropMultiplier,
    goldMin: base.rawGold,
    goldMax: base.rawGold,
  }]),
);

function onboarding(classId: ClassId): OnboardingGrant {
  const weapon = items[CLASS_WEAPONS[classId]]!;
  const bonusId = weapon.fittingBonuses[0]!;
  return {
    definitionId: weapon.id,
    rarity: 'uncommon',
    itemLevel: 1,
    bonuses: [{ bonusId, value: bonuses[bonusId]!.spans[0]!.max }],
  };
}

const onboardingGrant = Object.fromEntries(
  CLASS_IDS.map((classId) => [classId, onboarding(classId)]),
) as Record<ClassId, OnboardingGrant>;

/**
 * The two potions (layer-1 §7.6): Small HP Potion heals 25% of Max HP, Small
 * MP Potion restores 20% of Max MP. Idun's Apple (owner decision 2026-09-30)
 * returns a fallen member at 50% of its Max HP; its sources are open
 * ({@link OPEN_CONTENT_INPUTS}). No price: prices are deferred (spec §4.0).
 */
const consumables: Record<string, ConsumableDefinition> = {
  'small-hp-potion': { id: 'small-hp-potion', resource: 'hp', restoreBp: 2_500 },
  'small-mp-potion': { id: 'small-mp-potion', resource: 'mp', restoreBp: 2_000 },
  [IDUN_APPLE_ID]: { id: IDUN_APPLE_ID, resource: 'revive', restoreBp: 5_000 },
};

function starterWeapon(classId: ClassId): StarterWeapon {
  return {
    definitionId: CLASS_WEAPONS[classId],
    rarity: OPEN_CONTENT_INPUTS.starterWeapon.rarity,
    itemLevel: OPEN_CONTENT_INPUTS.starterWeapon.itemLevel,
    bonuses: [],
  };
}

/** Layer-1 §7.6's proposed kit: 20 Small HP Potions (first slot only) and a class weapon per slot. */
const starterKit: StarterKit = {
  potions: [{ consumableId: 'small-hp-potion', quantity: 20 }],
  weapons: Object.fromEntries(CLASS_IDS.map((classId) => [classId, starterWeapon(classId)])) as Record<ClassId, StarterWeapon>,
};

const recipes: Record<RecipeId, RecipeDefinition> = {
  melee: {
    id: 'melee',
    weight: 1,
    monsters: [
      { monsterId: 'briar-boar', column: 1, row: 1 },
      { monsterId: 'briar-boar', column: 2, row: 1 },
      { monsterId: 'briar-boar', column: 3, row: 1 },
    ],
  },
  ranged: {
    id: 'ranged',
    weight: 1,
    monsters: [
      { monsterId: 'briar-boar', column: 2, row: 1 },
      { monsterId: 'reed-slinger', column: 0, row: 0 },
      { monsterId: 'reed-slinger', column: 4, row: 0 },
    ],
  },
  clustered: {
    id: 'clustered',
    weight: 1,
    monsters: [
      { monsterId: 'mossling', column: 1, row: 0 },
      { monsterId: 'mossling', column: 2, row: 0 },
      { monsterId: 'mossling', column: 3, row: 0 },
      { monsterId: 'mossling', column: 1, row: 1 },
      { monsterId: 'mossling', column: 2, row: 1 },
    ],
  },
};

const elements: Record<Element, Record<Element, number>> = {
  neutral: { neutral: 10_000, fire: 10_000, water: 10_000, earth: 10_000, wind: 10_000 },
  fire: { neutral: 10_000, fire: 10_000, water: 7_500, earth: 15_000, wind: 10_000 },
  water: { neutral: 10_000, fire: 15_000, water: 10_000, earth: 10_000, wind: 7_500 },
  earth: { neutral: 10_000, fire: 7_500, water: 10_000, earth: 10_000, wind: 15_000 },
  wind: { neutral: 10_000, fire: 10_000, water: 15_000, earth: 7_500, wind: 10_000 },
};

/**
 * Source content definitions, minus the digest fields computed by
 * `packages/data/scripts/build-content.ts`. See the milestone A spec for provenance
 * of every milestone A numeric value, and {@link OPEN_CONTENT_INPUTS} for the
 * provisional equipment values milestone B adds. `progression` is absent: the
 * build compiles it from {@link PROGRESSION_SOURCE} (ruling R134).
 */
export const prototypeDefinition: Omit<Content, 'version' | 'gridHash' | 'progression'> = {
  grid: {
    width: 5,
    height: 5,
    playerRows: [3, 4],
    enemyRows: [0, 1],
    moveMs: 500,
    maxEnemies: 5,
  },
  classes,
  skills,
  monsters,
  recipes,
  shapes: shapeOffsets,
  elements,
  walkMs: 2_000,
  regenMs: 5_000,
  encounterLimitMs: 120_000,
  // Owner decision 2026-09-25 (spec §4.0.1): ten seconds, against a 2 s walk.
  townReturnTravelMs: 10_000,
  items,
  bonuses,
  rarities: structuredClone(RARITY_RULES),
  onboardingGrant,
  pity: { ...OPEN_CONTENT_INPUTS.pity },
  consumables,
  // Layer-1 §6.6: one shared 10-second potion cooldown per character.
  potionCooldownMs: 10_000,
  starterKit,
};
