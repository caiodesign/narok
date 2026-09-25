import { content, validateContent } from '@narok/data';
import type { ClassId } from '@narok/data';
import type {
  Actor,
  ActorId,
  AdvanceOptions,
  AdvanceResult,
  Context,
  DomainEvent,
  LabInput,
  Metrics,
  SimState,
  Simulation,
  Strategy,
} from '../src/types';
import { derive } from '../src/math';
import { defaultPlacement, gridPosition, createGrid } from '../src/battlefield/grid';
import { defaultStrategy, startState } from '../src/state';
import { drawBelow } from '../src/rng';
import { schedule } from '../src/scheduler';
import { createSimulation } from '../src/index';

/**
 * Builds a living party Guardian `p0` fixture with preset stats derived from the
 * Guardian class definition via `derive()`.
 *
 * Every call returns fresh objects (no shared references across calls); pass
 * `overrides` to replace top-level fields explicitly.
 */
export function actor(overrides: Partial<Actor> = {}): Actor {
  const stats = derive(content.classes.guardian);
  const base: Actor = {
    id: 'p0',
    side: 'party',
    definitionId: 'guardian',
    level: 10,
    family: 'humanoid',
    element: 'neutral',
    attributes: { str: 11, agi: 1, vit: 11, int: 1, dex: 6, luk: 1 },
    stats,
    hp: stats.maxHp,
    mp: stats.maxMp,
    position: gridPosition(2, 3),
    basicKind: 'physical',
    basicRange: 1,
    skills: ['taunt', 'cleave'],
    cooldowns: {},
    statuses: [],
    threat: {},
    forcedTarget: null,
    currentTarget: null,
    pendingCast: null,
    actionToken: 0,
  };
  return { ...base, ...overrides };
}

/**
 * Default lab experiment input: seed 1, Guardian/Cleric/Ranger, mixed recipe,
 * default placement/strategies, rest 50/30, wipe limit one. `overrides` are
 * shallow; every call builds fresh nested objects (no shared references).
 */
export function labInput(overrides: Partial<LabInput> = {}): LabInput {
  const classes: ClassId[] = ['guardian', 'cleric', 'ranger'];
  const strategies: Record<ActorId, Strategy> = {};
  classes.forEach((classId, index) => {
    strategies[`p${index}`] = defaultStrategy(classId);
  });
  const base: LabInput = {
    seed: 1,
    classes,
    recipe: 'mixed',
    placement: defaultPlacement(classes),
    strategies,
    rest: { hpStart: 50, mpStart: 30 },
    wipeLimit: 1,
  };
  return { ...base, ...overrides };
}

/**
 * Manually assembles the first melee encounter at 2,000 ms (ruling R24): the
 * seed-1 default party at its default placement, three Briar Boars at
 * `(1,1),(2,1),(3,1)`, encounter epoch 0, `rng` already advanced past the
 * recipe roll, and first act decisions queued for 2,500 ms. Built without
 * calling any lifecycle/advance logic so handler tests do not depend on the
 * dispatcher (tasks 6/7).
 */
export function fightFixture(): SimState {
  const input = labInput();
  const placement = defaultPlacement(input.classes);

  const actors: Record<ActorId, Actor> = {};
  const metricsActors: Metrics['actors'] = {};

  input.classes.forEach((classId, index) => {
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
      position: placement[id],
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

  const monster = content.monsters['briar-boar'];
  const enemyPositions = [gridPosition(1, 1), gridPosition(2, 1), gridPosition(3, 1)];
  (['e0', 'e1', 'e2'] as const).forEach((id, index) => {
    actors[id] = {
      id,
      side: 'enemy',
      definitionId: monster.id,
      level: monster.level,
      family: monster.family,
      element: monster.element,
      attributes: { str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0 },
      stats: {
        maxHp: monster.hp,
        maxMp: monster.mp,
        atk: monster.atk,
        matk: monster.matk,
        def: monster.def,
        mdef: monster.mdef,
        hit: monster.hit,
        flee: monster.flee,
        critBp: 0,
        intervalMs: monster.intervalMs,
      },
      hp: monster.hp,
      mp: monster.mp,
      position: enemyPositions[index],
      basicKind: 'physical',
      basicRange: monster.range,
      skills: [],
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
    nowMs: 2_000,
    rng: drawBelow(1, 3).state,
    nextQueueSeq: 0,
    nextDomainSeq: 0,
    epoch: 0,
    encounterCount: 1,
    encounterStartedAt: 2_000,
    phase: 'fighting',
    stopReason: null,
    input,
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
      walkMs: 2_000,
      fightMs: 0,
      restMs: 0,
      respawnMs: 0,
      actors: metricsActors,
    },
  };

  for (const id of ['p0', 'p1', 'p2', 'e0', 'e1', 'e2']) {
    schedule(state, { at: 2_500, kind: 'act', actorId: id, epoch: 0, token: 0 });
  }
  schedule(state, { at: 122_000, kind: 'deadline', actorId: '', epoch: 0, token: null });
  schedule(state, { at: 5_000, kind: 'regen', actorId: '', epoch: null, token: null });

  return state;
}

/**
 * A freshly started experiment with its first walk already elapsed (ruling R34):
 * `nowMs` sits exactly at `content.walkMs`, `phase` is `'walking'`, and the queue
 * still holds the original walk-complete `transition` and the first `regen` tick.
 * `transition(state, ctx)` spawns the encounter from here — deterministically for
 * a fixed recipe (no RNG drawn) or from exactly one bounded roll for `'mixed'`.
 * `overrides` are forwarded to {@link labInput} (e.g. `{ recipe: 'mixed', seed: 7 }`).
 */
export function walkCompleteState(overrides: Partial<LabInput> = {}): SimState {
  const battlefield = createGrid(content.grid, content.shapes);
  const state = startState(content, battlefield, labInput(overrides));
  state.nowMs = content.walkMs;
  return state;
}

/**
 * Binds validated prototype content and its grid/shapes for handler tests. The
 * returned `emit` assigns the next `nextDomainSeq` and appends the complete
 * `DomainEvent` to `events`.
 */
export function context(state: SimState, events: DomainEvent[]): Context {
  return {
    content,
    battlefield: createGrid(content.grid, content.shapes),
    emit(event) {
      events.push({ ...event, seq: state.nextDomainSeq++ });
    },
  };
}

/**
 * The public laboratory simulation (ruling R44): validated generated content bound
 * to its own grid/shapes. Every call returns an independent facade over the same
 * immutable content, so tests never share mutable simulation state.
 */
export function lab(): Simulation {
  const validated = validateContent(content);
  return createSimulation(validated, createGrid(validated.grid, validated.shapes));
}

/**
 * A default experiment advanced to exactly 2,000 ms (ruling R44): the first walk has
 * completed and the first encounter has spawned, but the first decisions (2,500 ms)
 * have not run yet.
 */
export function atFight(): SimState {
  const sim = lab();
  return runTo(sim, sim.start(labInput()), 2_000).state;
}

/**
 * Popped-entry counter used to prove a yielded `advance` iteration made progress.
 * `nextQueueSeq` only ever grows (one per `schedule`) and `queue.length` only shrinks
 * by a pop or an epoch prune, so `nextQueueSeq - queue.length` strictly increases
 * whenever the dispatcher consumed at least one queued entry — which a work-budget
 * yield always does — and is unchanged by scheduling alone.
 */
function poppedCount(state: SimState): number {
  return state.nextQueueSeq - state.queue.length;
}

/**
 * Drives `advance` to an absolute target across work-budget yields (ruling R44),
 * concatenating the domain events of every segment in order. Throws when an
 * iteration returns `reachedTarget: false` without consuming a queued entry or
 * moving the clock, so a budget that cannot make progress fails loudly instead of
 * spinning.
 */
export function runTo(
  sim: Simulation,
  state: SimState,
  untilMs: number,
  options?: AdvanceOptions,
): AdvanceResult {
  const events: DomainEvent[] = [];
  let current = state;
  for (;;) {
    const beforeNowMs = current.nowMs;
    const beforePopped = poppedCount(current);
    const result = sim.advance(current, untilMs, options);
    for (const event of result.events) events.push(event);
    current = result.state;
    if (result.reachedTarget) return { state: current, events, reachedTarget: true };
    if (current.nowMs <= beforeNowMs && poppedCount(current) <= beforePopped) {
      throw new Error(`advance made no progress at ${current.nowMs} ms toward ${untilMs} ms`);
    }
  }
}
