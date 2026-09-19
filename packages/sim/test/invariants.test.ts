import fc from 'fast-check';
import { expect, test } from 'vitest';
import { content } from '@narok/data';
import { gridCoordinates, gridPosition } from '../src/battlefield/grid';
import { SimError } from '../src/errors';
import { derive } from '../src/math';
import { finishEncounter } from '../src/lifecycle';
import { schedule } from '../src/scheduler';
import { defaultStrategy } from '../src/state';
import type { Actor, LabInput, Metrics, PositionId, SimState } from '../src/types';
import { actor, context, fightFixture, lab, labInput, runTo } from './fixtures';

/** Highest seed `validateLabInput` accepts (a nonzero uint32). */
const MAX_SEED = 4_294_967_295;
/** Property horizon: long enough for several encounters, short enough for 100 cases. */
const PROPERTY_HORIZON = 20_000;

const sim = lab();

/** A one-cleric roster, so a hand-built duel state is still a legal, encodable state. */
function soloInput(): LabInput {
  return labInput({
    classes: ['cleric'],
    placement: { p0: gridPosition(1, 4) },
    strategies: { p0: defaultStrategy('cleric') },
  });
}

function boar(id: string, hp: number, position: PositionId): Actor {
  const monster = content.monsters['briar-boar'];
  return actor({
    id,
    side: 'enemy',
    definitionId: monster.id,
    level: monster.level,
    family: monster.family,
    element: monster.element,
    attributes: { str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0 },
    stats: {
      maxHp: hp, maxMp: monster.mp, atk: monster.atk, matk: monster.matk,
      def: monster.def, mdef: monster.mdef, hit: monster.hit, flee: monster.flee,
      critBp: 0, intervalMs: monster.intervalMs,
    },
    hp,
    mp: monster.mp,
    position,
    basicKind: 'physical',
    basicRange: monster.range,
    skills: [],
  });
}

/**
 * A hand-built one-versus-one encounter that started at 2,000 ms: a full-resource
 * Cleric at `(1,4)` and one Briar Boar at `(1,1)`, three cells away and inside the
 * Cleric's four-cell basic range. The Cleric's basic is magic, so a resolution
 * always lands and the boundary tests below never depend on an accuracy roll.
 */
function duelState(nowMs: number, enemyHp: number): SimState {
  const definition = content.classes.cleric;
  const stats = derive(definition);
  const caster = actor({
    id: 'p0',
    definitionId: 'cleric',
    level: definition.level,
    attributes: { ...definition.attributes },
    stats,
    hp: stats.maxHp,
    mp: stats.maxMp,
    position: gridPosition(1, 4),
    basicKind: definition.basicKind,
    basicRange: definition.basicRange,
    skills: [...definition.skills],
  });
  const zero = { damageDealt: 0, damageReceived: 0, healingDone: 0 };
  const metrics: Metrics = {
    kills: 0, wins: 0, wipes: 0, rawExp: 0, rawGold: 0, damageDealt: 0, effectiveHealing: 0,
    walkMs: 2_000, fightMs: 0, restMs: 0, respawnMs: 0,
    actors: { p0: { ...zero }, e0: { ...zero } },
  };
  return {
    schemaVersion: 1,
    simulationVersion: 'a1',
    contentVersion: content.version,
    gridHash: content.gridHash,
    nowMs,
    rng: 1,
    nextQueueSeq: 0,
    nextDomainSeq: 0,
    epoch: 0,
    encounterCount: 1,
    encounterStartedAt: 2_000,
    phase: 'fighting',
    stopReason: null,
    input: soloInput(),
    actors: { p0: caster, e0: boar('e0', enemyHp, gridPosition(1, 1)) },
    queue: [],
    metrics,
  };
}

/** Arms `p0`'s pending basic attack on `e0`, resolving at `completesAt`. */
function armBasic(state: SimState, completesAt: number): void {
  const caster = state.actors.p0;
  caster.actionToken = 1;
  caster.currentTarget = 'e0';
  caster.pendingCast = {
    skillId: 'basic', targets: ['e0'], startedAt: state.nowMs, completesAt, token: 1,
  };
  schedule(state, { at: completesAt, kind: 'resolve', actorId: 'p0', epoch: 0, token: 1 });
}

function expectSimError(operation: () => unknown, code: string, field: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SimError);
    expect((error as SimError).code).toBe(code);
    expect((error as SimError).field).toBe(field);
    return;
  }
  throw new Error(`expected a SimError ${code} at ${field}`);
}

test('any seed splits anywhere without changing state or events', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: MAX_SEED }),
      fc.integer({ min: 1, max: PROPERTY_HORIZON - 1 }),
      (seed, splitAt) => {
        const initial = sim.start(labInput({ seed }));
        const direct = runTo(sim, initial, PROPERTY_HORIZON);
        const left = runTo(sim, initial, splitAt);
        const right = runTo(sim, sim.decode(sim.encode(left.state)), PROPERTY_HORIZON);
        expect(sim.encode(right.state)).toBe(sim.encode(direct.state));
        expect([...left.events, ...right.events]).toEqual(direct.events);
      },
    ),
    { numRuns: 100 },
  );
});

test('any seed agrees across summary collection and a one-event work budget', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: MAX_SEED }), (seed) => {
      const initial = sim.start(labInput({ seed }));
      const direct = runTo(sim, initial, PROPERTY_HORIZON);
      const summary = runTo(sim, initial, PROPERTY_HORIZON, { collect: 'summary' });
      const yielded = runTo(sim, initial, PROPERTY_HORIZON, { maxScheduledEvents: 1 });
      expect(summary.events).toEqual([]);
      expect(sim.encode(summary.state)).toBe(sim.encode(direct.state));
      expect(sim.encode(yielded.state)).toBe(sim.encode(direct.state));
      expect(yielded.events).toEqual(direct.events);
    }),
    { numRuns: 100 },
  );
});

test('a kill resolving exactly at the encounter deadline wins', () => {
  const deadlineAt = 2_000 + content.encounterLimitMs;
  expect(deadlineAt).toBe(122_000);
  const state = duelState(deadlineAt - 1, 1);
  armBasic(state, deadlineAt);
  schedule(state, { at: deadlineAt, kind: 'deadline', actorId: '', epoch: 0, token: null });

  const result = sim.advance(state, deadlineAt);

  // resolve (priority 20) runs before deadline (40) at the same timestamp, and
  // finishEncounter then invalidates the epoch the deadline entry was queued under.
  expect(result.events.map((event) => [event.kind, event.at, event.reason])).toEqual([
    ['damage', deadlineAt, 'basic'],
    ['death', deadlineAt, null],
    ['win', deadlineAt, null],
    ['phase', deadlineAt, 'walking'],
  ]);
  expect(result.state.phase).toBe('walking');
  expect(result.state.stopReason).toBeNull();
  expect(result.state.metrics.wins).toBe(1);
  expect(result.state.metrics.kills).toBe(1);
  expect(result.state.metrics.rawExp).toBe(30);
  expect(result.state.metrics.rawGold).toBe(3);
  expect(result.state.metrics.fightMs).toBe(1);
  // The deadline entry is gone, not merely ignored, and only the walk remains.
  expect(result.state.queue.map((event) => [event.kind, event.at, event.epoch])).toEqual([
    ['transition', deadlineAt + content.walkMs, null],
  ]);
  expect(result.reachedTarget).toBe(true);
  expect(result.state.nowMs).toBe(deadlineAt);
});

test('an undecided encounter at the exact deadline stops as a stalemate after its resolutions', () => {
  const deadlineAt = 2_000 + content.encounterLimitMs;
  const state = duelState(deadlineAt - 1, 500);
  armBasic(state, deadlineAt);
  schedule(state, { at: deadlineAt, kind: 'deadline', actorId: '', epoch: 0, token: null });

  const result = sim.advance(state, deadlineAt);

  expect(result.events.map((event) => [event.kind, event.at, event.reason])).toEqual([
    ['damage', deadlineAt, 'basic'],
    ['stop', deadlineAt, 'stalemate'],
  ]);
  expect(result.state.phase).toBe('stopped');
  expect(result.state.stopReason).toBe('stalemate');
  expect(result.state.queue).toEqual([]);
  expect(result.state.metrics.wins).toBe(0);
  expect(result.state.metrics.wipes).toBe(0);
  expect(result.state.metrics.kills).toBe(0);
  expect(result.state.nowMs).toBe(deadlineAt);
  expect(result.reachedTarget).toBe(true);
});

test('a stun expiring exactly at a cast completion lets the cast resolve', () => {
  const state = duelState(2_999, 500);
  armBasic(state, 3_000);
  state.actors.p0.statuses = [
    { id: 'stun:e0', sourceId: 'e0', kind: 'stun', valueBp: 0, expiresAt: 3_000 },
  ];
  schedule(state, { at: 3_000, kind: 'expire', actorId: 'p0', epoch: 0, token: null });

  const result = sim.advance(state, 3_000);

  // expire (priority 0) precedes resolve (20) at 3,000 ms, so the stun is already gone.
  expect(result.events.map((event) => [event.kind, event.at])).toEqual([['damage', 3_000]]);
  expect(result.state.actors.p0.statuses).toEqual([]);
  expect(result.state.actors.p0.pendingCast).toBeNull();
});

test('a stun expiring one millisecond later postpones the whole cast', () => {
  const state = duelState(2_999, 500);
  armBasic(state, 3_000);
  state.actors.p0.statuses = [
    { id: 'stun:e0', sourceId: 'e0', kind: 'stun', valueBp: 0, expiresAt: 3_001 },
  ];
  schedule(state, { at: 3_001, kind: 'expire', actorId: 'p0', epoch: 0, token: null });

  const postponed = sim.advance(state, 3_000);
  expect(postponed.events).toEqual([]);
  expect(postponed.state.actors.p0.pendingCast?.completesAt).toBe(3_001);
  expect(postponed.state.actors.e0.hp).toBe(500);

  const resumed = sim.advance(postponed.state, 3_001);
  expect(resumed.events.map((event) => [event.kind, event.at])).toEqual([['damage', 3_001]]);
  expect(resumed.state.actors.p0.statuses).toEqual([]);
});

test('stale entries are skipped but still spend the work budget', () => {
  const state = duelState(2_999, 500);
  armBasic(state, 3_000);
  // A superseded cast: the actor moved on to token 2, so the queued resolve is stale.
  state.actors.p0.actionToken = 2;
  // A genuine entry at the same instant, but at a lower-priority queue kind ('act'
  // is 30, 'resolve' is 20 — scheduler.ts), so canonical order still pops the
  // stale resolve first within a one-entry budget and this one stays queued.
  schedule(state, { at: 3_000, kind: 'act', actorId: 'e0', epoch: 0, token: null });

  const result = sim.advance(state, 3_000, { maxScheduledEvents: 1 });

  expect(result.reachedTarget).toBe(false);
  expect(result.state.nowMs).toBe(3_000);
  expect(result.events).toEqual([]);
  // The budget was spent on the popped stale resolve; the act entry is still queued.
  expect(result.state.queue.map((event) => [event.kind, event.at])).toEqual([['act', 3_000]]);
  expect(result.state.actors.e0.hp).toBe(500);
});

test('phase time accrues on every clock move, including between arbitrary targets', () => {
  const started = sim.start(labInput());
  const walking = sim.advance(started, 1_234).state;
  expect(walking.metrics).toMatchObject({ walkMs: 1_234, fightMs: 0, restMs: 0, respawnMs: 0 });

  const spawned = sim.advance(walking, 2_000).state;
  expect(spawned.phase).toBe('fighting');
  expect(spawned.metrics).toMatchObject({ walkMs: 2_000, fightMs: 0 });

  const fighting = sim.advance(spawned, 2_400).state;
  expect(fighting.metrics).toMatchObject({ walkMs: 2_000, fightMs: 400 });

  // The same horizon reached in one call totals identically.
  const direct = sim.advance(started, 2_400).state;
  expect(direct.metrics).toEqual(fighting.metrics);
});

test('resource, occupancy and queue invariants are asserted after each dispatch', () => {
  const overHealed = duelState(2_999, 500);
  armBasic(overHealed, 3_000);
  overHealed.actors.p0.hp = overHealed.actors.p0.stats.maxHp + 1;
  expectSimError(() => sim.advance(overHealed, 3_000), 'INVALID_STATE', 'actors.p0.hp');

  const overCharged = duelState(2_999, 500);
  armBasic(overCharged, 3_000);
  overCharged.actors.p0.mp = -1;
  expectSimError(() => sim.advance(overCharged, 3_000), 'INVALID_STATE', 'actors.p0.mp');

  const stacked = duelState(2_999, 500);
  armBasic(stacked, 3_000);
  stacked.actors.e0.position = stacked.actors.p0.position;
  expectSimError(() => sim.advance(stacked, 3_000), 'INVALID_STATE', 'actors.p0.position');

  const rewound = duelState(2_999, 500);
  armBasic(rewound, 3_000);
  // Bypasses `schedule`, which refuses a non-future entry, to plant a past-due one.
  rewound.queue.unshift({
    at: 2_500, kind: 'expire', actorId: 'p0', seq: rewound.nextQueueSeq++, epoch: 0, token: null,
  });
  expectSimError(() => sim.advance(rewound, 3_000), 'INVALID_STATE', 'queue.0.at');
});

test('incompatible states and targets are rejected with documented codes', () => {
  const state = sim.start(labInput());
  expectSimError(
    () => sim.advance({ ...state, schemaVersion: 2 as unknown as 1 }, 10),
    'WRONG_VERSION',
    'state.schemaVersion',
  );
  expectSimError(
    () => sim.advance({ ...state, simulationVersion: 'a2' as unknown as 'a1' }, 10),
    'WRONG_VERSION',
    'state.simulationVersion',
  );
  expectSimError(
    () => sim.advance({ ...state, contentVersion: 'other' }, 10),
    'WRONG_VERSION',
    'state.contentVersion',
  );
  expectSimError(
    () => sim.advance({ ...state, gridHash: 'other' }, 10),
    'WRONG_VERSION',
    'state.gridHash',
  );

  const moved = sim.advance(state, 5_000).state;
  expectSimError(() => sim.advance(moved, 4_999), 'TIME_REWIND', 'untilMs');
  expectSimError(() => sim.advance(moved, 5_000.5), 'UNSAFE_INTEGER', 'untilMs');
  expectSimError(
    () => sim.advance(moved, Number.MAX_SAFE_INTEGER + 2),
    'UNSAFE_INTEGER',
    'untilMs',
  );
  expectSimError(
    () => sim.advance(moved, 10_000, { maxScheduledEvents: 0 }),
    'INVALID_INPUT',
    'options.maxScheduledEvents',
  );
  expectSimError(
    () => sim.advance(moved, 10_000, { maxScheduledEvents: 1.5 }),
    'UNSAFE_INTEGER',
    'options.maxScheduledEvents',
  );
  expectSimError(
    () => sim.advance(moved, 10_000, { collect: 'none' as unknown as 'events' }),
    'INVALID_INPUT',
    'options.collect',
  );
});

// ---------------------------------------------------------------------------
// Spec section 13 exact-boundary coverage not already proven elsewhere (R70).
//
// Already covered, and deliberately not duplicated here:
//   status expiry  - 'a stun expiring exactly at a cast completion lets the cast
//                    resolve' / '... one millisecond later postpones the whole
//                    cast' (this file) and effects.test.ts 'expire drops records
//                    at their expiry and keeps later ones'
//   cast completion- the same two stun-boundary tests, plus actions.test.ts
//                    'a stun at completion postpones the cast, keeping its token,
//                    MP and cooldown'
//   encounter timeout- 'a kill resolving exactly at the encounter deadline wins'
//                    and 'an undecided encounter at the exact deadline stops as a
//                    stalemate after its resolutions' (this file)
//   rest exit      - lifecycle.test.ts 'rest exit requires 90% hp: 89% does not
//                    exit, 90% does' and '... 80% mp: 79% does not exit, 80% does'
//   overlapping live units - 'resource, occupancy and queue invariants are
//                    asserted after each dispatch' (this file) and lifecycle.test.ts
//                    'R92: a win revives a corpse an ally stands on without
//                    stacking two living actors'
//   wrapping shapes- grid.test.ts 'square clips at the right edge without wrapping'
//                    and actions.test.ts 'frost nova clips its plus shape ...' /
//                    'cleave clips at the board edge ...'
//   work-budget yield - 'any seed agrees across summary collection and a one-event
//                    work budget' (this file), which compares the encoded state,
//                    RNG included, and the full ordered event log
// ---------------------------------------------------------------------------

test('the regen tick applies at exactly its instant, never a millisecond early', () => {
  const state = duelState(4_000, 500);
  const wounded = state.actors.p0.stats.maxHp - 50;
  state.actors.p0.hp = wounded;
  schedule(state, { at: content.regenMs, kind: 'regen', actorId: '', epoch: null, token: null });

  const early = sim.advance(state, content.regenMs - 1);
  expect(early.events).toEqual([]);
  expect(early.state.actors.p0.hp).toBe(wounded);

  const onTick = sim.advance(early.state, content.regenMs);
  expect(onTick.events.map((event) => [event.kind, event.at, event.reason])).toEqual([
    ['regen', content.regenMs, 'hp'],
  ]);
  expect(onTick.state.actors.p0.hp).toBe(wounded + (onTick.events[0].amount ?? 0));
  // The successor tick is booked exactly one interval on, not relative to the target.
  expect(onTick.state.queue.some((event) => event.kind === 'regen' && event.at === 2 * content.regenMs)).toBe(true);
});

test('a hit that brings HP to exactly zero is a death; one point short is not', () => {
  // The Cleric's basic is magic: it always lands and, from a fixed RNG state,
  // deals a fixed amount that does not depend on the defender's HP total — so
  // the same resolution can be replayed against two totals one point apart.
  const probeState = duelState(2_999, 10_000);
  armBasic(probeState, 3_000);
  const probe = sim.advance(probeState, 3_000);
  const dealt = probe.events.find((event) => event.kind === 'damage')?.amount ?? 0;
  expect(dealt).toBeGreaterThan(0);

  const survivesState = duelState(2_999, dealt + 1);
  armBasic(survivesState, 3_000);
  const survives = sim.advance(survivesState, 3_000);
  expect(survives.state.actors.e0.hp).toBe(1);
  expect(survives.events.some((event) => event.kind === 'death')).toBe(false);
  expect(survives.state.phase).toBe('fighting');
  expect(survives.state.metrics.kills).toBe(0);

  const diesState = duelState(2_999, dealt);
  armBasic(diesState, 3_000);
  const dies = sim.advance(diesState, 3_000);
  expect(dies.events.filter((event) => event.kind === 'death').map((event) => [event.actorId, event.at])).toEqual([
    ['e0', 3_000],
  ]);
  expect(dies.state.metrics.kills).toBe(1);
  // The last enemy died, so the encounter is decided and its actor is cleared.
  expect(Object.hasOwn(dies.state.actors, 'e0')).toBe(false);
  expect(dies.state.metrics.wins).toBe(1);
});

test('a respawn completes at exactly its instant, not a millisecond before', () => {
  const state = fightFixture();
  state.input.wipeLimit = 2; // not the final wipe, so the party respawns instead of stopping
  for (const id of ['p0', 'p1', 'p2'] as const) state.actors[id].hp = 0;
  finishEncounter(state, context(state, []));
  expect(state.phase).toBe('respawning');

  const respawnAt = state.nowMs + content.respawnMs;
  expect(state.queue.some((event) => event.kind === 'transition' && event.at === respawnAt)).toBe(true);

  const early = sim.advance(state, respawnAt - 1);
  expect(early.state.phase).toBe('respawning');
  expect(early.state.actors.p0.hp).toBe(0);
  // Regen ticks keep firing while respawning but restore nothing (spec section 10).
  expect(early.events).toEqual([]);

  const onTime = sim.advance(early.state, respawnAt);
  expect(onTime.state.phase).toBe('walking');
  expect(onTime.events.map((event) => [event.kind, event.at, event.reason])).toEqual([
    ['phase', respawnAt, 'walking'],
  ]);
  for (const id of ['p0', 'p1', 'p2'] as const) {
    const member = onTime.state.actors[id];
    expect(member.hp).toBe(member.stats.maxHp);
    expect(member.mp).toBe(member.stats.maxMp);
  }
});

test('combat APIs publish opaque cell ids, never coordinates', () => {
  const run = runTo(sim, sim.start(labInput()), PROPERTY_HORIZON);

  const located = run.events.filter((event) => event.position !== null);
  expect(located.length).toBeGreaterThan(0);
  for (const event of located) {
    const position = event.position as PositionId;
    expect(typeof position).toBe('string');
    // Only the grid adapter converts: a published id round-trips through it, and
    // the event itself never carries the column/row the adapter works in.
    const { column, row } = gridCoordinates(position);
    expect(gridPosition(column, row)).toBe(position);
  }
  for (const event of run.events) {
    expect(Object.keys(event).filter((key) => key === 'column' || key === 'row')).toEqual([]);
  }
  for (const entry of sim.project(run.state).actors) {
    expect(typeof entry.position).toBe('string');
    expect(Object.keys(entry).filter((key) => key === 'column' || key === 'row')).toEqual([]);
  }
});

test('advancing to the current time is a legal no-op', () => {
  const state = sim.advance(sim.start(labInput()), 5_000).state;
  const result = sim.advance(state, 5_000);
  expect(result.reachedTarget).toBe(true);
  expect(result.events).toEqual([]);
  expect(sim.encode(result.state)).toBe(sim.encode(state));
});
