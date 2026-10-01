import type {
  Attributes,
  ClassDefinition,
  ClassId,
  Content,
  Element,
  MonsterDefinition,
  RecipeDefinition,
  RecipeId,
  ShapeId,
  SkillDefinition,
  SkillId,
} from '@narok/data';
import { RARITY_RULES, content } from '@narok/data';
import { createGrid, gridPosition } from '../src/battlefield/grid';
import type { Battlefield } from '../src/battlefield/types';
import { schedule } from '../src/scheduler';
import { defaultBag, emptyDropMetrics, starterLoot } from '../src/rewards';
import type { Actor, ActorId, LabInput, Metrics, SimState, Strategy } from '../src/types';

/**
 * Contract §6 engine-stress fixture. A deliberately non-gameplay scenario used only
 * to measure sustained dispatcher throughput over a real 12/24 hour horizon: three
 * party members and five monsters, each with a 10,000,000 HP budget, zero MP, a
 * 300 ms basic-attack interval, damage fixed at one point per landed hit, range ten
 * (already mutually in range so nobody ever needs to move), and no healing, status
 * effects or skills. This is test setup content — separately versioned from real
 * player content — never a hidden gameplay option (ruling per task 8 rulings R49).
 */

/** Every actor's basic attack lands for exactly one point of damage (see math below). */
const STRESS_HP = 10_000_000;
const STRESS_INTERVAL_MS = 300;
const STRESS_RANGE = 10;
/** Chosen so `damage()`'s `max(1, floor(raw * 100 / (100 + defense)))` always floors to 1,
 * regardless of variance/crit, keeping every landed hit's arithmetic bounded and exact. */
const STRESS_DEFENSE = 10_000;
const STRESS_ATK = 50;
const STRESS_LEVEL = 1;
const STRESS_HIT = 999;
const STRESS_FLEE = 0;
/**
 * Fixed at exactly 24 hours + 1 ms by contract §6 — not a tunable "later than
 * whatever horizon gets requested" value, and this fixture does not itself enforce
 * any ceiling on the horizon it is driven to. It only stays clear of the deadline in
 * practice because `tools/balance/src/args.ts`'s `parseHoursList` rejects any
 * `benchmark --hours` value above 24 (ruling R72) before this fixture ever runs. A
 * caller that drives this state directly (bypassing that CLI validation) past 24h
 * will hit a real `stalemate` stop here, same as any other encounter deadline.
 */
export const STRESS_ENCOUNTER_LIMIT_MS = 24 * 60 * 60 * 1000 + 1;

export const STRESS_CONTENT_VERSION = 'engine-stress-1';
export const STRESS_GRID_HASH = 'engine-stress-grid-1';

const CLASS_IDS: readonly ClassId[] = ['guardian', 'cleric', 'ranger', 'arcanist'];
const SKILL_IDS: readonly SkillId[] = [
  'taunt', 'cleave', 'heal', 'smite', 'double-shot', 'arrow-rain', 'fire-bolt', 'frost-nova',
];
const RECIPE_IDS: readonly RecipeId[] = ['melee', 'ranged', 'clustered'];
const ELEMENTS: readonly Element[] = ['neutral', 'fire', 'water', 'earth', 'wind'];
const SHAPE_IDS: readonly ShapeId[] = ['single', 'cleave', 'square', 'plus'];

const ZERO_ATTRIBUTES: Attributes = { str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0 };

/**
 * Structurally-typed filler content (ruling: "separately versioned test content").
 * None of these class/skill/monster/recipe entries are read at dispatch time by this
 * fixture's actors (they carry no skills and never move), so their numbers are inert
 * placeholders that only exist to satisfy `Content`'s shape; the only content field the
 * dispatcher actually reads for a basic-attack-only fight is `elements`, populated below
 * with full neutral-vs-neutral potency.
 */
function buildFillerContent(): Content {
  const skills = Object.fromEntries(
    SKILL_IDS.map((id): [SkillId, SkillDefinition] => [
      id,
      {
        id,
        mp: 0,
        cooldownMs: 1,
        baseCastMs: 0,
        range: 1,
        shape: 'single',
        powerBp: 10_000,
        hits: 1,
        effect: 'damage',
        damageKind: 'physical',
        element: 'neutral',
        slowBp: 0,
        durationMs: 0,
      },
    ]),
  ) as Record<SkillId, SkillDefinition>;

  const classes = Object.fromEntries(
    CLASS_IDS.map((id): [ClassId, ClassDefinition] => [
      id,
      {
        id,
        attributes: { ...ZERO_ATTRIBUTES },
        level: STRESS_LEVEL,
        baseHp: 1,
        hpPerLevel: 0,
        baseMp: 0,
        mpPerLevel: 0,
        weaponAtk: 0,
        weaponMatk: 0,
        armorDef: 0,
        armorMdef: 0,
        basicIntervalMs: STRESS_INTERVAL_MS,
        basicRange: 1,
        basicKind: 'physical',
        skills: [],
      },
    ]),
  ) as Record<ClassId, ClassDefinition>;

  const monsters: Record<string, MonsterDefinition> = {};

  const recipes = Object.fromEntries(
    RECIPE_IDS.map((id): [RecipeId, RecipeDefinition] => [id, { id, weight: 1, monsters: [] }]),
  ) as Record<RecipeId, RecipeDefinition>;

  const shapes = Object.fromEntries(
    SHAPE_IDS.map((id): [ShapeId, [number, number][]] => [id, [[0, 0]]]),
  ) as Record<ShapeId, [number, number][]>;

  const elements = Object.fromEntries(
    ELEMENTS.map((left): [Element, Record<Element, number>] => [
      left,
      Object.fromEntries(ELEMENTS.map((right): [Element, number] => [right, 10_000])) as Record<
        Element,
        number
      >,
    ]),
  ) as Record<Element, Record<Element, number>>;

  return {
    version: STRESS_CONTENT_VERSION,
    gridHash: STRESS_GRID_HASH,
    grid: { width: 5, height: 4, playerRows: [3], enemyRows: [0], moveMs: 1_000, maxEnemies: 5 },
    classes,
    skills,
    monsters,
    recipes,
    shapes,
    elements,
    walkMs: 1,
    regenMs: 1,
    encounterLimitMs: STRESS_ENCOUNTER_LIMIT_MS,
    respawnMs: 1,
    townReturnTravelMs: null,
    // Inert: the stress fight equips nothing and rolls no drops.
    items: {},
    bonuses: {},
    rarities: structuredClone(RARITY_RULES),
    onboardingGrant: {} as Content['onboardingGrant'],
    pity: { guaranteeEnabled: false, epicPlusThreshold: null, legendaryThreshold: null },
    // Inert too: the stress fight carries no progression and drinks nothing.
    progression: structuredClone(content.progression),
    consumables: {},
    potionCooldownMs: content.potionCooldownMs,
    starterKit: {} as Content['starterKit'],
  };
}

function stressActor(id: ActorId, side: Actor['side'], column: number, row: number): Actor {
  return {
    id,
    side,
    definitionId: side === 'party' ? 'stress-party' : 'stress-enemy',
    level: STRESS_LEVEL,
    family: 'humanoid',
    element: 'neutral',
    attributes: { ...ZERO_ATTRIBUTES },
    stats: {
      maxHp: STRESS_HP,
      maxMp: 0,
      atk: STRESS_ATK,
      matk: 0,
      def: STRESS_DEFENSE,
      mdef: STRESS_DEFENSE,
      hit: STRESS_HIT,
      flee: STRESS_FLEE,
      critBp: 0,
      intervalMs: STRESS_INTERVAL_MS,
    },
    hp: STRESS_HP,
    mp: 0,
    position: gridPosition(column, row),
    basicKind: 'physical',
    basicRange: STRESS_RANGE,
    skills: [],
    cooldowns: {},
    statuses: [],
    threat: {},
    forcedTarget: null,
    currentTarget: null,
    pendingCast: null,
    actionToken: 0,
  };
}

export interface StressFixture {
  content: Content;
  battlefield: Battlefield;
  state: SimState;
}

/**
 * Builds the engine-stress fixture (contract §6): three party members and five
 * monsters at legal, distinct, already-in-range cells, already `fighting`, first
 * decisions scheduled at `+1 ms`, and — critically — no `regen` entry ever scheduled
 * (the dedicated omission that disables regeneration for this fixture only; ordinary
 * gameplay always schedules one in `startState`). Built without calling
 * `createSimulation`/`startState`/`validateContent` so the fixture is free to omit
 * regen and to assign actor stats directly, independent of the filler content's
 * numbers (task 8 rulings R49). `seed` defaults to 1 (any valid RNG seed works; the
 * only draws are basic-attack crit/accuracy/variance rolls).
 */
export function buildStressFixture(seed = 1): StressFixture {
  const content = buildFillerContent();
  const battlefield = createGrid(content.grid, content.shapes);

  const partyPositions: [number, number][] = [[0, 3], [1, 3], [2, 3]];
  const enemyPositions: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];

  const actors: Record<ActorId, Actor> = {};
  const metricsActors: Metrics['actors'] = {};
  const partyIds: ActorId[] = ['p0', 'p1', 'p2'];
  const enemyIds: ActorId[] = ['e0', 'e1', 'e2', 'e3', 'e4'];

  partyIds.forEach((id, index) => {
    const [column, row] = partyPositions[index];
    actors[id] = stressActor(id, 'party', column, row);
    metricsActors[id] = { damageDealt: 0, damageReceived: 0, healingDone: 0 };
  });
  enemyIds.forEach((id, index) => {
    const [column, row] = enemyPositions[index];
    actors[id] = stressActor(id, 'enemy', column, row);
    metricsActors[id] = { damageDealt: 0, damageReceived: 0, healingDone: 0 };
  });

  const strategies: Record<ActorId, Strategy> = {};
  for (const id of partyIds) strategies[id] = { rules: [], target: { kind: 'nearest' } };

  const input: LabInput = {
    seed,
    classes: ['guardian', 'guardian', 'guardian'],
    recipe: 'melee',
    placement: {
      p0: gridPosition(...partyPositions[0]),
      p1: gridPosition(...partyPositions[1]),
      p2: gridPosition(...partyPositions[2]),
    },
    strategies,
    rest: { hpStart: 0, mpStart: 0 },
    wipeLimit: 1,
  };

  const state: SimState = {
    schemaVersion: 1,
    simulationVersion: 'b1',
    contentVersion: content.version,
    gridHash: content.gridHash,
    nowMs: 0,
    rng: seed,
    nextQueueSeq: 0,
    nextDomainSeq: 0,
    epoch: 0,
    encounterCount: 1,
    encounterStartedAt: 0,
    phase: 'fighting',
    stopReason: null,
    input,
    pendingRules: null,
    nextRewardSeq: 0,
    pendingRewards: [],
    dropProtection: { epicPlus: 0, legendary: 0 },
    lootPresetSnapshot: starterLoot(),
    pendingLoot: [],
    bagState: defaultBag(),
    progression: null,
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
  };

  for (const id of [...partyIds, ...enemyIds]) {
    schedule(state, { at: 1, kind: 'act', actorId: id, epoch: 0, token: 0 });
  }
  schedule(state, {
    at: STRESS_ENCOUNTER_LIMIT_MS, kind: 'deadline', actorId: '', epoch: 0, token: null,
  });

  return { content, battlefield, state };
}
