import type { Content } from '@narok/data';
import { decide, resolveCast } from './actions';
import { expire } from './effects';
import { SimError } from './errors';
import { deadline, finishEncounter, regenerate, transition } from './lifecycle';
import { compareScheduled, isStale, takeNext } from './scheduler';
import { compareIds } from './effects';
import type { Battlefield } from './battlefield/types';
import type {
  Actor,
  ActorId,
  AdvanceOptions,
  AdvanceResult,
  Context,
  DomainEvent,
  LabInput,
  Metrics,
  ScheduledEvent,
  SimState,
} from './types';

/** Contract §5 default work budget: popped entries per `advance` call, stale included. */
const DEFAULT_WORK_BUDGET = 10_000;

/** Deep-copies one actor field by field; never object spread of the runtime actor. */
function cloneActor(actor: Actor): Actor {
  return {
    id: actor.id,
    side: actor.side,
    definitionId: actor.definitionId,
    level: actor.level,
    family: actor.family,
    element: actor.element,
    attributes: { ...actor.attributes },
    stats: { ...actor.stats },
    hp: actor.hp,
    mp: actor.mp,
    position: actor.position,
    basicKind: actor.basicKind,
    basicRange: actor.basicRange,
    skills: [...actor.skills],
    cooldowns: { ...actor.cooldowns },
    statuses: actor.statuses.map((status) => ({ ...status })),
    threat: { ...actor.threat },
    forcedTarget: actor.forcedTarget === null ? null : { ...actor.forcedTarget },
    currentTarget: actor.currentTarget,
    pendingCast:
      actor.pendingCast === null
        ? null
        : { ...actor.pendingCast, targets: [...actor.pendingCast.targets] },
    actionToken: actor.actionToken,
  };
}

function cloneInput(input: LabInput): LabInput {
  const placement: LabInput['placement'] = {};
  for (const id of Object.keys(input.placement)) placement[id] = input.placement[id];
  const strategies: LabInput['strategies'] = {};
  for (const id of Object.keys(input.strategies)) {
    const strategy = input.strategies[id];
    strategies[id] = {
      rules: strategy.rules.map((rule) => ({
        skillId: rule.skillId,
        enabled: rule.enabled,
        condition: { ...rule.condition },
      })),
      target: { ...strategy.target },
    };
  }
  return {
    seed: input.seed,
    classes: [...input.classes],
    recipe: input.recipe,
    placement,
    strategies,
    rest: { ...input.rest },
    wipeLimit: input.wipeLimit,
  };
}

function cloneMetrics(metrics: Metrics): Metrics {
  const actors: Metrics['actors'] = {};
  for (const id of Object.keys(metrics.actors)) actors[id] = { ...metrics.actors[id] };
  return {
    kills: metrics.kills,
    wins: metrics.wins,
    wipes: metrics.wipes,
    rawExp: metrics.rawExp,
    rawGold: metrics.rawGold,
    damageDealt: metrics.damageDealt,
    effectiveHealing: metrics.effectiveHealing,
    walkMs: metrics.walkMs,
    fightMs: metrics.fightMs,
    restMs: metrics.restMs,
    respawnMs: metrics.respawnMs,
    actors,
  };
}

/**
 * Purpose-built deep clone of a `SimState` (ruling R41). Deliberately not
 * `structuredClone` or a JSON round trip: the sim package reads no host globals,
 * and an explicit field-by-field copy keeps the clone's cost and shape auditable.
 * `start`, `advance` and `stop` clone once per call so internal handlers may
 * mutate freely without ever touching the caller's object graph.
 */
export function cloneState(state: SimState): SimState {
  const actors: Record<ActorId, Actor> = {};
  for (const id of Object.keys(state.actors)) actors[id] = cloneActor(state.actors[id]);
  return {
    schemaVersion: state.schemaVersion,
    simulationVersion: state.simulationVersion,
    contentVersion: state.contentVersion,
    gridHash: state.gridHash,
    nowMs: state.nowMs,
    rng: state.rng,
    nextQueueSeq: state.nextQueueSeq,
    nextDomainSeq: state.nextDomainSeq,
    epoch: state.epoch,
    encounterCount: state.encounterCount,
    encounterStartedAt: state.encounterStartedAt,
    phase: state.phase,
    stopReason: state.stopReason,
    input: cloneInput(state.input),
    actors,
    queue: state.queue.map((event): ScheduledEvent => ({ ...event })),
    metrics: cloneMetrics(state.metrics),
  };
}

/**
 * Rejects a state this simulation cannot run (ruling R41): schema, simulation,
 * content and grid identity must match the bound content exactly, so a snapshot
 * from different content never silently continues against new numbers.
 */
function assertCompatible(state: SimState, content: Content): void {
  if (state.schemaVersion !== 1) {
    throw new SimError('WRONG_VERSION', 'state.schemaVersion', 'expected schema version 1');
  }
  if (state.simulationVersion !== 'a1') {
    throw new SimError('WRONG_VERSION', 'state.simulationVersion', 'expected simulation version a1');
  }
  if (state.contentVersion !== content.version) {
    throw new SimError('WRONG_VERSION', 'state.contentVersion', 'state was produced by different content');
  }
  if (state.gridHash !== content.gridHash) {
    throw new SimError('WRONG_VERSION', 'state.gridHash', 'state was produced by a different grid');
  }
}

/** Reads and range-checks the caller's advance options (contract §3/§5 defaults). */
function readOptions(options: AdvanceOptions): { collect: 'events' | 'summary'; budget: number } {
  const collect = options.collect ?? 'events';
  if (collect !== 'events' && collect !== 'summary') {
    throw new SimError('INVALID_INPUT', 'options.collect', 'expected events or summary');
  }
  const budget = options.maxScheduledEvents ?? DEFAULT_WORK_BUDGET;
  if (!Number.isSafeInteger(budget)) {
    throw new SimError('UNSAFE_INTEGER', 'options.maxScheduledEvents', 'expected a safe integer');
  }
  if (budget < 1) {
    throw new SimError('INVALID_INPUT', 'options.maxScheduledEvents', 'expected at least one event');
  }
  return { collect, budget };
}

/**
 * Adds `delta` elapsed milliseconds to the metric of the phase the state is in
 * *before* the clock moves (ruling R41). A stopped experiment accrues nothing.
 * Integer addition only, so any split of the same horizon totals identically.
 */
function accrue(state: SimState, delta: number): void {
  if (delta === 0) return;
  switch (state.phase) {
    case 'walking':
      state.metrics.walkMs += delta;
      return;
    case 'fighting':
      state.metrics.fightMs += delta;
      return;
    case 'resting':
      state.metrics.restMs += delta;
      return;
    case 'respawning':
      state.metrics.respawnMs += delta;
      return;
    case 'stopped':
      return;
  }
}

/**
 * Post-dispatch consistency checks (ruling R41). Resource bounds and occupancy are
 * a single O(actors) pass; the queue check reads only `queue[0]` because the queue
 * is kept in canonical `compareScheduled` order at all times (`schedule` inserts in
 * place and `decodeSnapshot` rejects an out-of-order queue), so the earliest entry
 * is the only one that can sit in the past.
 */
function assertInvariants(state: SimState, previousNowMs: number): void {
  if (state.nowMs < previousNowMs) {
    throw new SimError('INVALID_STATE', 'nowMs', 'simulation time moved backwards');
  }
  const occupied = new Map<string, ActorId>();
  // ASCII id order (never raw `Object.keys` insertion order, per the codebase-wide
  // determinism convention in `livingActors`/`project`): so which actor's id is
  // named in a position-collision error is reproducible regardless of construction
  // or decode order.
  for (const id of Object.keys(state.actors).sort(compareIds)) {
    const actor = state.actors[id];
    if (actor.hp < 0 || actor.hp > actor.stats.maxHp) {
      throw new SimError('INVALID_STATE', `actors.${id}.hp`, 'hp left the 0..maxHp range');
    }
    if (actor.mp < 0 || actor.mp > actor.stats.maxMp) {
      throw new SimError('INVALID_STATE', `actors.${id}.mp`, 'mp left the 0..maxMp range');
    }
    if (actor.hp <= 0) continue;
    const owner = occupied.get(actor.position);
    if (owner !== undefined) {
      throw new SimError('INVALID_STATE', `actors.${id}.position`, `shares a cell with ${owner}`);
    }
    occupied.set(actor.position, id);
  }
  const earliest = state.queue[0];
  if (earliest !== undefined && earliest.at < state.nowMs) {
    throw new SimError('INVALID_STATE', 'queue.0.at', 'a queued entry is scheduled in the past');
  }
}

/** Routes one due, non-stale entry to its handler (ruling R41's dispatch table). */
function dispatch(state: SimState, ctx: Context, entry: ScheduledEvent): void {
  switch (entry.kind) {
    case 'expire':
      expire(state, entry.actorId);
      return;
    case 'regen':
      regenerate(state, ctx);
      return;
    case 'resolve':
      resolveCast(state, entry.actorId, ctx);
      // Encounter completion is the dispatcher's job: the resolver stays free of
      // lifecycle, and a kill resolving at the deadline instant therefore wins
      // before the same-time `deadline` entry (priority 20 before 40) can run.
      finishEncounter(state, ctx);
      return;
    case 'act':
      decide(state, entry.actorId, ctx);
      return;
    case 'deadline':
      deadline(state, ctx);
      return;
    case 'transition':
      transition(state, ctx);
      return;
  }
}

/**
 * Bounded event dispatcher (contract §5, ruling R41). Drains every queued entry at
 * or before `untilMs` in canonical order, accruing phase time whenever the clock
 * moves, until the target is reached, the experiment stops, or the work budget is
 * exhausted. Never mutates `state`, `content` or `battlefield`; never reads wall
 * time or `Math.random()`.
 *
 * Returns `reachedTarget: false` only on a work-budget yield with due entries
 * still queued — the caller resumes with the same absolute target and loses
 * neither events nor RNG draws. A stopped experiment keeps its exact stop time and
 * accrues no further time, regen or events, so advancing it again is a no-op.
 */
export function advance(
  content: Content,
  battlefield: Battlefield,
  state: SimState,
  untilMs: number,
  options: AdvanceOptions = {},
): AdvanceResult {
  assertCompatible(state, content);
  if (!Number.isSafeInteger(untilMs)) {
    throw new SimError('UNSAFE_INTEGER', 'untilMs', 'expected a safe integer');
  }
  if (untilMs < state.nowMs) {
    throw new SimError('TIME_REWIND', 'untilMs', 'target is before the current simulation time');
  }
  const { collect, budget } = readOptions(options);

  // A stopped experiment accrues no time, regen or events (spec §10): checked on
  // the caller's own `state`, before cloning, and never re-checked on `working`
  // until inside the loop below. (Narrowing `working.phase !== 'stopped'` here,
  // ahead of the loop, would incorrectly persist across the loop's `dispatch`
  // call — a known TypeScript limitation where property narrowing survives a
  // function call that mutates the referenced object through an alias — and make
  // the real mid-drain stop check below appear unreachable. Reading the
  // not-yet-cloned `state` instead keeps that later check honest.)
  if (state.phase === 'stopped') {
    const working = cloneState(state);
    working.queue.sort(compareScheduled);
    return { state: working, events: [], reachedTarget: true };
  }

  const working = cloneState(state);
  const events: DomainEvent[] = [];
  const ctx: Context = {
    content,
    battlefield,
    emit(event) {
      // The domain sequence is allocated in both collection modes; only retention
      // differs, so summary and event runs produce identical states.
      const complete: DomainEvent = { ...event, seq: working.nextDomainSeq++ };
      if (collect === 'events') events.push(complete);
    },
  };

  const finish = (reachedTarget: boolean): AdvanceResult => {
    working.queue.sort(compareScheduled);
    return { state: working, events, reachedTarget };
  };

  let processed = 0;
  while (processed < budget) {
    const entry = working.queue[0];
    if (entry === undefined || entry.at > untilMs) break;

    takeNext(working);
    processed += 1;
    if (entry.at < working.nowMs) {
      throw new SimError('INVALID_STATE', 'queue.0.at', 'a queued entry is scheduled in the past');
    }
    const previousNowMs = working.nowMs;
    accrue(working, entry.at - previousNowMs);
    working.nowMs = entry.at;

    if (isStale(working, entry)) continue;
    dispatch(working, ctx, entry);
    assertInvariants(working, previousNowMs);

    if (working.phase === 'stopped') return finish(true);
  }

  const remaining = working.queue[0];
  if (remaining !== undefined && remaining.at <= untilMs) return finish(false);

  accrue(working, untilMs - working.nowMs);
  working.nowMs = untilMs;
  return finish(true);
}
