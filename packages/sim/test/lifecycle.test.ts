import { expect, test } from 'vitest';
import { IDUN_APPLE_ID, content } from '@narok/data';
import type { ClassId, RecipeId } from '@narok/data';
import { transition, regenerate, finishEncounter, deadline } from '../src/lifecycle';
import { drawBelow } from '../src/rng';
import { schedule } from '../src/scheduler';
import { encodeSnapshot, decodeSnapshot } from '../src/snapshot';
import { gridPosition } from '../src/battlefield/grid';
import { derive } from '../src/math';
import { defaultStrategy } from '../src/state';
import { fightFixture, walkCompleteState, context, actor, atFight, lab, labInput, rewardFields, runTo } from './fixtures';
import { emptyDropMetrics } from '../src/rewards';
import type { Actor, ActorId, DomainEvent, Metrics, PendingRules, Phase, SimState } from '../src/types';

function summary(events: DomainEvent[]): unknown[][] {
  return events.map((e) => [e.kind, e.actorId, e.targetId, e.amount, e.reason]);
}

/** A minimal, hand-built party-only state for isolated `regenerate` tests. Round
 * `maxHp`/`maxMp` (1,000) and zero attributes give predictable base amounts
 * (`hpBase = mpBase = 10`) so exact-percentage boundaries are easy to hit. */
function multiActorState(
  phase: Phase,
  members: { id: ActorId; hp: number; mp: number; maxMp?: number }[],
): SimState {
  const actors: Record<ActorId, Actor> = {};
  const metricsActors: Metrics['actors'] = {};
  for (const m of members) {
    actors[m.id] = actor({
      id: m.id,
      hp: m.hp,
      mp: m.mp,
      stats: { ...derive(content.classes.guardian), maxHp: 1_000, maxMp: m.maxMp ?? 1_000 },
      attributes: { str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0 },
    });
    metricsActors[m.id] = { damageDealt: 0, damageReceived: 0, healingDone: 0 };
  }
  return {
    schemaVersion: 1,
    simulationVersion: 'b1',
    contentVersion: content.version,
    gridHash: content.gridHash,
    nowMs: 10_000,
    rng: 1,
    nextQueueSeq: 0,
    nextDomainSeq: 0,
    epoch: 0,
    encounterCount: 1,
    encounterStartedAt: null,
    phase,
    stopReason: null,
    input: labInput({ rest: { hpStart: 50, mpStart: 50 } }),
    pendingRules: null,
    ...rewardFields(),
    actors,
    queue: [],
    metrics: {
      kills: 0, wins: 0, wipes: 0, rawExp: 0, rawGold: 0, damageDealt: 0, effectiveHealing: 0,
      walkMs: 0, fightMs: 0, restMs: 0, consumed: {}, actors: metricsActors,
      drops: emptyDropMetrics(),
    },
  };
}

function soloState(phase: Phase, hp: number, mp: number, maxMp?: number): SimState {
  return multiActorState(phase, [{ id: 'p0', hp, mp, maxMp }]);
}

test('a full wipe stops the hunt with wipe and returns the party to town (R154)', () => {
  const state = fightFixture();
  for (const a of Object.values(state.actors).filter(a => a.side === 'party')) a.hp = 0;
  finishEncounter(state, context(state, []));
  expect(state.phase).toBe('stopped');
  expect(state.stopReason).toBe('wipe');
  expect(state.metrics.wipes).toBe(1);
  expect(state.queue).toEqual([]);
});
test('a member dead at a won encounter stays dead with its MP kept (R151)', () => {
  const state = fightFixture();
  state.actors.p1.hp = 0;
  state.actors.p1.mp = 3;
  for (const a of Object.values(state.actors).filter(a => a.side === 'enemy')) a.hp = 0;
  finishEncounter(state, context(state, []));
  expect(state.metrics.wins).toBe(1);
  expect(state.actors.p1.hp).toBe(0);
  expect(state.actors.p1.mp).toBe(3);
});

// ---------------------------------------------------------------------------
// finishEncounter: decided-encounter gating, wipe path, win path
// ---------------------------------------------------------------------------

test('finishEncounter is a no-op while both sides still have a living actor', () => {
  const state = fightFixture();
  finishEncounter(state, context(state, []));
  expect(state.phase).toBe('fighting');
  expect(state.metrics.wins).toBe(0);
  expect(state.metrics.wipes).toBe(0);
});

test('finishEncounter only records one win even if called again for a stale resolution', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  for (const a of Object.values(state.actors)) if (a.side === 'enemy') a.hp = 0;
  finishEncounter(state, ctx);
  expect(state.metrics.wins).toBe(1);
  const winsAfterFirst = events.filter((e) => e.kind === 'win').length;

  finishEncounter(state, ctx); // as if the dispatcher ran it again for a same-time stale resolve
  expect(state.metrics.wins).toBe(1);
  expect(events.filter((e) => e.kind === 'win').length).toBe(winsAfterFirst);
});

test('a double KO records a wipe, never a win', () => {
  const state = fightFixture();
  for (const a of Object.values(state.actors)) a.hp = 0;
  const events: DomainEvent[] = [];
  finishEncounter(state, context(state, events));
  expect(state.metrics.wipes).toBe(1);
  expect(state.metrics.wins).toBe(0);
  expect(events.some((e) => e.kind === 'win')).toBe(false);
});

test('finishEncounter bumps the epoch so stale queued work cannot resolve later', () => {
  const state = fightFixture();
  const before = state.epoch;
  for (const a of Object.values(state.actors)) if (a.side === 'enemy') a.hp = 0;
  finishEncounter(state, context(state, []));
  expect(state.epoch).toBe(before + 1);
});

test('encounter exit deletes enemy actors and their metrics entries', () => {
  const state = fightFixture();
  for (const a of Object.values(state.actors)) if (a.side === 'enemy') a.hp = 0;
  finishEncounter(state, context(state, []));
  expect(Object.keys(state.actors).sort()).toEqual(['p0', 'p1', 'p2']);
  expect(Object.keys(state.metrics.actors).sort()).toEqual(['p0', 'p1', 'p2']);
});

test('encounter exit prunes stale-epoch queue entries but keeps epoch-null ones, staying decodable', () => {
  const state = fightFixture();
  const ctx = context(state, []);
  const epochBeforeExit = state.epoch;

  // Extra epoch-scoped entries referencing enemies that are about to be deleted,
  // on top of fightFixture's own act/deadline entries for every actor.
  schedule(state, {
    at: state.nowMs + 100, kind: 'resolve', actorId: 'e0', epoch: state.epoch,
    token: state.actors.e0.actionToken,
  });
  schedule(state, { at: state.nowMs + 200, kind: 'expire', actorId: 'e1', epoch: state.epoch, token: null });

  for (const a of Object.values(state.actors)) if (a.side === 'enemy') a.hp = 0;
  finishEncounter(state, ctx);

  expect(state.epoch).toBe(epochBeforeExit + 1);
  // (a) no surviving queue entry references a now-deleted (or any unknown) actor.
  for (const event of state.queue) {
    if (event.actorId !== '') expect(Object.hasOwn(state.actors, event.actorId)).toBe(true);
  }
  // every entry carrying the old, now-stale epoch is gone.
  expect(state.queue.some((event) => event.epoch !== null && event.epoch !== state.epoch)).toBe(false);
  // the round trip that would otherwise reject a dangling actor reference succeeds.
  const decoded = decodeSnapshot(encodeSnapshot(state), content, ctx.battlefield);
  expect(decoded.epoch).toBe(state.epoch);

  // (b) epoch-null entries (the regen tick, and win's scheduled walking transition) survive.
  expect(state.queue.some((event) => event.kind === 'regen' && event.epoch === null)).toBe(true);
  expect(state.queue.some((event) => event.kind === 'transition' && event.epoch === null)).toBe(true);
});

test('cooldown timestamps survive both win and wipe cleanup', () => {
  const winState = fightFixture();
  winState.actors.p0.cooldowns.cleave = 2_500;
  for (const a of Object.values(winState.actors)) if (a.side === 'enemy') a.hp = 0;
  finishEncounter(winState, context(winState, []));
  expect(winState.actors.p0.cooldowns.cleave).toBe(2_500);

  const wipeState = fightFixture();
  wipeState.actors.p0.cooldowns.cleave = 2_500;
  for (const a of Object.values(wipeState.actors)) if (a.side === 'party') a.hp = 0;
  finishEncounter(wipeState, context(wipeState, []));
  expect(wipeState.actors.p0.cooldowns.cleave).toBe(2_500);
});

test('a zero-MP actor never triggers a rest start from its MP threshold', () => {
  const state = fightFixture();
  state.input.rest = { hpStart: 0, mpStart: 50 };
  state.actors.p0.stats = { ...state.actors.p0.stats, maxMp: 0 };
  state.actors.p0.mp = 0;
  for (const a of Object.values(state.actors)) if (a.side === 'enemy') a.hp = 0;
  finishEncounter(state, context(state, []));
  expect(state.phase).toBe('walking');
});

// ---------------------------------------------------------------------------
// finishEncounter: re-seating the party so a revival cannot stack live actors
// ---------------------------------------------------------------------------

/** Every cell held by a living actor, so a duplicate is visible as a shorter set. */
function livingCells(state: SimState): string[] {
  return Object.values(state.actors)
    .filter((entry) => entry.hp > 0)
    .map((entry) => entry.position as string);
}

/**
 * Regression for ruling R92. A corpse does not occupy its cell — `executeMove`
 * tests occupancy with `livingActors` and `assertInvariants` skips any actor at
 * `hp <= 0` — so an ally may legally step onto a fallen member. Reviving that
 * member *in place* then left two living actors on one cell and the next
 * `assertInvariants` threw `INVALID_STATE actors.pN.position "shares a cell with
 * pM"`; it aborted `pnpm balance matrix` on 934 of 30,600 cells. Encounter exit
 * re-seats the party at `input.placement`, which `startState` validated
 * collision-free, exactly as `spawnEncounter` already did. A win no longer
 * revives anyone (ruling R151), but the re-seat still runs and must leave no
 * two living actors on one cell.
 */
test('R92: a win with a corpse under an ally re-seats the party; the corpse stays dead and nothing stacks', () => {
  const sim = lab();
  const state = fightFixture();
  const placement = state.input.placement;

  // p0 (Guardian) fell on its own seat (2,3) and p1 (Cleric) stepped onto the
  // corpse; only e0 is still standing, one point from death.
  state.actors.p0.hp = 0;
  state.actors.p1.position = placement.p0;
  state.actors.e1.hp = 0;
  state.actors.e2.hp = 0;
  state.actors.e0.hp = 1;

  // The Cleric's basic is magic, so the killing blow never depends on an
  // accuracy roll; (2,3) to e0's (2,1) is two cells, inside its four-cell range.
  state.actors.p1.actionToken = 1;
  state.actors.p1.currentTarget = 'e0';
  state.actors.p1.pendingCast = {
    skillId: 'basic', targets: ['e0'], startedAt: 2_000, completesAt: 2_100, token: 1,
  };
  schedule(state, { at: 2_100, kind: 'resolve', actorId: 'p1', epoch: 0, token: 1 });

  const result = sim.advance(state, 2_100);

  expect(result.state.metrics.wins).toBe(1);
  expect(result.state.actors.p0.hp, 'a win revives no one (R151)').toBe(0);
  const cells = livingCells(result.state);
  expect(new Set(cells).size).toBe(cells.length);
  for (const id of ['p0', 'p1', 'p2'] as const) {
    expect(result.state.actors[id].position).toBe(placement[id]);
  }
  // Re-seating is a teleport, matching spawnEncounter: no move event is emitted.
  expect(result.events.some((event) => event.kind === 'move')).toBe(false);

  // Ruling R96: `validateSimState` enforces the same rule independently, so the
  // state captured between the win and the next spawn must round-trip.
  const encoded = sim.encode(result.state);
  expect(sim.encode(sim.decode(encoded))).toBe(encoded);
});

/**
 * The R92 shape on the revive path (ruling R156): a Revive lands on a corpse
 * an ally stands on, and the corpse lies on its own seat, so neither the death
 * cell nor the input placement is free. The revived member rejoins at the
 * first free party-side cell instead of stacking.
 */
test('R92/R156: a Revive onto a corpse an ally stands on rejoins at a free cell, never stacked', () => {
  const sim = lab();
  const state = fightFixture();
  const placement = state.input.placement;

  // p0 fell on its own seat; p2 stepped onto the corpse.
  state.actors.p0.hp = 0;
  state.actors.p2.position = placement.p0;

  state.actors.p1.actionToken = 1;
  state.actors.p1.currentTarget = null;
  state.actors.p1.pendingCast = {
    skillId: 'revive', targets: ['p0'], startedAt: 2_000, completesAt: 2_100, token: 1,
  };
  schedule(state, { at: 2_100, kind: 'resolve', actorId: 'p1', epoch: 0, token: 1 });

  const result = sim.advance(state, 2_100);
  const revived = result.state.actors.p0;
  expect(revived.hp).toBe(Math.max(1, Math.floor(revived.stats.maxHp / 2)));
  expect(revived.position).not.toBe(placement.p0);
  const cells = livingCells(result.state);
  expect(new Set(cells).size).toBe(cells.length);
  expect(result.events.find((event) => event.kind === 'revive')).toMatchObject({
    actorId: 'p0', targetId: 'p1', reason: 'revive', position: revived.position,
  });
  const encoded = sim.encode(result.state);
  expect(sim.encode(sim.decode(encoded))).toBe(encoded);
});

/**
 * The wipe path had the same shape (ruling R92): two members can die on one
 * cell. A wipe now returns the party to town at full HP and MP (rulings R154,
 * R155), and the re-seat at encounter exit keeps the two apart.
 */
test('R92: a wipe after two members die on one cell brings them home to separate cells', () => {
  const sim = lab();
  const state = fightFixture();
  const placement = state.input.placement;

  // p2 died first; p1 stepped onto the corpse and died there too.
  for (const id of ['p0', 'p1', 'p2'] as const) state.actors[id].hp = 0;
  state.actors.p1.position = placement.p2;

  // e0's basic resolves onto the already-dead p0 and decides the encounter.
  state.actors.e0.position = gridPosition(2, 2);
  state.actors.e0.actionToken = 1;
  state.actors.e0.currentTarget = 'p0';
  state.actors.e0.pendingCast = {
    skillId: 'basic', targets: ['p0'], startedAt: 2_000, completesAt: 2_100, token: 1,
  };
  schedule(state, { at: 2_100, kind: 'resolve', actorId: 'e0', epoch: 0, token: 1 });

  const home = sim.advance(state, 2_100).state;
  expect(home.phase).toBe('stopped');
  expect(home.stopReason).toBe('wipe');
  for (const id of ['p0', 'p1', 'p2'] as const) {
    expect(home.actors[id].hp).toBe(home.actors[id].stats.maxHp);
    expect(home.actors[id].mp).toBe(home.actors[id].stats.maxMp);
    expect(home.actors[id].position).toBe(placement[id]);
  }
  const cells = livingCells(home);
  expect(new Set(cells).size).toBe(cells.length);
  const encoded = sim.encode(home);
  expect(sim.encode(sim.decode(encoded))).toBe(encoded);
});

/**
 * Ruling R100. The tests above reproduce the *state* ruling R92 describes;
 * this one replays the *sequence*. Every step is executed by the engine itself,
 * including `executeMove` permitting a step onto a corpse — the behaviour that
 * makes the whole bug possible and which a hand-built precondition never
 * exercises.
 *
 * The input is R92's own reproduction, the balance-matrix cell that aborted:
 * seed 4, two Guardians, the `melee` recipe and the CLI's `front` placement
 * ((1,3) and (2,3) in roster order). Two Guardians converge on the same front
 * cell, which is exactly the geometry that puts a corpse under an ally. Since
 * a win no longer revives (ruling R151), the bag carries Idun's Apples so the
 * engine's own revive path (rulings R152, R156) runs through the same fight;
 * without them this party wipes before 130 s.
 *
 * `tools/balance`'s `buildLabInput` is deliberately not imported: `packages/sim`
 * must not gain a dependency on `tools/`, so the equivalent input is built here
 * from the same rest thresholds that CLI uses.
 */
test('R100: R92\'s own reproduction, with apples, runs past the instant it used to abort on', () => {
  const sim = lab();
  const classes: ClassId[] = ['guardian', 'guardian'];
  const input = labInput({
    seed: 4,
    classes,
    recipe: 'melee',
    placement: { p0: gridPosition(1, 3), p1: gridPosition(2, 3) },
    strategies: { p0: defaultStrategy('guardian'), p1: defaultStrategy('guardian') },
  });

  // Summary collection keeps a two-minute drive cheap; `runTo` drains any
  // work-budget yield to the same absolute target.
  let state = sim.start(input, { bag: { capacity: 100, usedSlots: 1, held: { [IDUN_APPLE_ID]: 20 } } });
  for (let target = 5_000; target <= 130_000; target += 5_000) {
    state = runTo(sim, state, target, { collect: 'summary' }).state;
  }

  expect(state.nowMs).toBe(130_000);
  expect(state.stopReason).toBeNull();
  expect(state.metrics.consumed[IDUN_APPLE_ID], 'the engine revived someone').toBeGreaterThan(0);
  const cells = livingCells(state);
  expect(new Set(cells).size).toBe(cells.length);
  const encoded = sim.encode(state);
  expect(sim.encode(sim.decode(encoded))).toBe(encoded);
});

// ---------------------------------------------------------------------------
// transition: encounter spawn from a completed walk
// ---------------------------------------------------------------------------

test('a fixed recipe spawns deterministically without drawing rng', () => {
  const state = walkCompleteState({ recipe: 'melee' });
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  const rngBefore = state.rng;

  transition(state, ctx);

  expect(state.rng).toBe(rngBefore);
  expect(state.phase).toBe('fighting');
  expect(state.encounterCount).toBe(1);
  expect(state.encounterStartedAt).toBe(state.nowMs);
  expect(['e0', 'e1', 'e2'].map((id) => state.actors[id].position)).toEqual([
    gridPosition(1, 1), gridPosition(2, 1), gridPosition(3, 1),
  ]);
  expect(['e0', 'e1', 'e2'].every((id) => state.actors[id].definitionId === 'briar-boar')).toBe(true);
  expect(state.actors.p0.actionToken).toBe(1);
  expect(state.actors.e0.actionToken).toBe(0);
  expect(summary(events)).toEqual([
    ['phase', null, null, null, 'fighting'],
    ['spawn', 'e0', null, null, null],
    ['spawn', 'e1', null, null, null],
    ['spawn', 'e2', null, null, null],
  ]);
});

test('spawn schedules first decisions for every living actor and the encounter deadline', () => {
  const state = walkCompleteState({ recipe: 'melee' });
  const ctx = context(state, []);
  transition(state, ctx);

  const actIds = state.queue.filter((e) => e.kind === 'act').map((e) => e.actorId).sort();
  expect(actIds).toEqual(['e0', 'e1', 'e2', 'p0', 'p1', 'p2']);
  for (const e of state.queue.filter((e) => e.kind === 'act')) {
    expect(e.at).toBe(state.nowMs + 500);
    expect(e.epoch).toBe(state.epoch);
    expect(e.token).toBe(state.actors[e.actorId].actionToken);
  }
  const deadlineEntry = state.queue.find((e) => e.kind === 'deadline');
  expect(deadlineEntry).toMatchObject({
    at: state.nowMs + content.encounterLimitMs, actorId: '', epoch: state.epoch, token: null,
  });
});

test('party formation resets to input.placement on spawn, even after wandering', () => {
  const state = walkCompleteState({ recipe: 'melee' });
  state.actors.p0.position = gridPosition(4, 4);
  const ctx = context(state, []);

  transition(state, ctx);

  expect(state.actors.p0.position).toBe(state.input.placement.p0);
  expect(state.actors.p1.position).toBe(state.input.placement.p1);
  expect(state.actors.p2.position).toBe(state.input.placement.p2);
});

test('a mixed recipe draws exactly one bounded roll and repeats identically for the same seed', () => {
  const order: RecipeId[] = ['melee', 'ranged', 'clustered'];
  for (const seed of [1, 2, 7]) {
    const expectedDraw = drawBelow(seed, 3);
    const expectedRecipe = order[expectedDraw.value];
    const state = walkCompleteState({ recipe: 'mixed', seed });
    transition(state, context(state, []));

    expect(state.rng).toBe(expectedDraw.state);
    const spawnedIds = Object.values(state.actors).filter((a) => a.side === 'enemy').map((a) => a.definitionId);
    const expectedIds = content.recipes[expectedRecipe].monsters.map((m) => m.monsterId);
    expect(spawnedIds).toEqual(expectedIds);
  }

  const a = walkCompleteState({ recipe: 'mixed', seed: 42 });
  const b = walkCompleteState({ recipe: 'mixed', seed: 42 });
  transition(a, context(a, []));
  transition(b, context(b, []));
  expect(a.rng).toBe(b.rng);
  expect(Object.keys(a.actors).filter((id) => id.startsWith('e')).map((id) => a.actors[id].definitionId)).toEqual(
    Object.keys(b.actors).filter((id) => id.startsWith('e')).map((id) => b.actors[id].definitionId),
  );
});

// ---------------------------------------------------------------------------
// regenerate: phase multipliers, caps, rest exit, stop scheduling
// ---------------------------------------------------------------------------

test('fighting regen applies the x1/2 multiplier, floored, minimum one', () => {
  const state = soloState('fighting', 500, 500);
  regenerate(state, context(state, []));
  expect(state.actors.p0.hp).toBe(505); // floor(10 * 1/2) = 5
  expect(state.actors.p0.mp).toBe(505);
});

test('walking regen applies the x1 multiplier and never triggers a phase change', () => {
  const state = soloState('walking', 500, 500);
  schedule(state, { at: state.nowMs + 1_000, kind: 'transition', actorId: '', epoch: null, token: null });
  const events: DomainEvent[] = [];

  regenerate(state, context(state, events));

  expect(state.actors.p0.hp).toBe(510); // floor(10 * 1/1) = 10
  expect(state.actors.p0.mp).toBe(510);
  expect(state.phase).toBe('walking');
  expect(events.some((e) => e.kind === 'phase')).toBe(false);
  expect(state.queue.filter((e) => e.kind === 'transition')).toHaveLength(1); // untouched by regen
  expect(state.queue.some((e) => e.kind === 'regen' && e.at === state.nowMs + content.regenMs)).toBe(true);
});

test('regen gain is capped to the missing amount', () => {
  const state = soloState('walking', 995, 1_000);
  regenerate(state, context(state, []));
  expect(state.actors.p0.hp).toBe(1_000);
});

test('a full actor emits no regen event', () => {
  const state = soloState('walking', 1_000, 1_000);
  const events: DomainEvent[] = [];
  regenerate(state, context(state, events));
  expect(events).toEqual([]);
});

test('a maxMp-zero actor is excluded from mp regen and mp rest-exit checks', () => {
  const state = soloState('resting', 1_000, 0, 0);
  const events: DomainEvent[] = [];
  regenerate(state, context(state, events));
  expect(state.actors.p0.mp).toBe(0);
  expect(events.some((e) => e.reason === 'mp')).toBe(false);
  expect(state.phase).toBe('walking'); // hp already full, mp check disabled by maxMp === 0
});

test('regen emits each actor its hp event before its mp event, actors in id order', () => {
  const state = multiActorState('walking', [
    { id: 'p1', hp: 500, mp: 500 },
    { id: 'p0', hp: 500, mp: 500 },
  ]);
  const events: DomainEvent[] = [];
  regenerate(state, context(state, events));
  expect(events.map((e) => [e.actorId, e.reason])).toEqual([
    ['p0', 'hp'], ['p0', 'mp'], ['p1', 'hp'], ['p1', 'mp'],
  ]);
});

test('rest exit requires 90% hp: 89% does not exit, 90% does', () => {
  const under = soloState('resting', 859, 1_000);
  regenerate(under, context(under, []));
  expect(under.actors.p0.hp).toBe(899); // 89.9%
  expect(under.phase).toBe('resting');

  const at = soloState('resting', 860, 1_000);
  regenerate(at, context(at, []));
  expect(at.actors.p0.hp).toBe(900); // 90% exactly
  expect(at.phase).toBe('walking');
});

test('rest exit requires 80% mp: 79% does not exit, 80% does', () => {
  const under = soloState('resting', 1_000, 759);
  regenerate(under, context(under, []));
  expect(under.actors.p0.mp).toBe(799); // 79.9%
  expect(under.phase).toBe('resting');

  const at = soloState('resting', 1_000, 760);
  regenerate(at, context(at, []));
  expect(at.actors.p0.mp).toBe(800); // 80% exactly
  expect(at.phase).toBe('walking');
});

test('successful rest exit schedules the next transition and emits phase walking', () => {
  const state = soloState('resting', 1_000, 1_000);
  const events: DomainEvent[] = [];
  regenerate(state, context(state, events));
  expect(state.phase).toBe('walking');
  expect(events.some((e) => e.kind === 'phase' && e.reason === 'walking')).toBe(true);
  const next = state.queue.find((e) => e.kind === 'transition');
  expect(next).toMatchObject({ at: state.nowMs + content.walkMs, actorId: '', epoch: null, token: null });
});

test('regen does not schedule a successor once stopped', () => {
  const state = soloState('stopped', 500, 500);
  regenerate(state, context(state, []));
  expect(state.queue).toEqual([]);
});

// ---------------------------------------------------------------------------
// deadline
// ---------------------------------------------------------------------------

test('deadline stops a still-fighting encounter with no win or wipe', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  deadline(state, context(state, events));
  expect(state.phase).toBe('stopped');
  expect(state.stopReason).toBe('stalemate');
  expect(state.queue).toEqual([]);
  expect(state.metrics.wins).toBe(0);
  expect(state.metrics.wipes).toBe(0);
  expect(summary(events)).toEqual([['stop', null, null, null, 'stalemate']]);
});

test('deadline is a no-op once the encounter already resolved', () => {
  const state = fightFixture();
  const ctx = context(state, []);
  for (const a of Object.values(state.actors)) if (a.side === 'enemy') a.hp = 0;
  finishEncounter(state, ctx);
  const phaseAfterWin = state.phase;

  deadline(state, ctx);

  expect(state.phase).toBe(phaseAfterWin);
  expect(state.stopReason).toBeNull();
});

// ---------------------------------------------------------------------------
// pending activation (part 2 §4, §9 #4; spec §4.1 — one atomic activation at
// the next spawn, before the recipe draw)
// ---------------------------------------------------------------------------

/** A rule set that differs from `labInput()`'s in every field a preset holds. */
function otherRules(overrides: Partial<PendingRules> = {}): PendingRules {
  const base = labInput();
  return {
    // p0 and p1 trade cells: still collision-free, still the party's own cells.
    placement: { p0: base.placement.p1, p1: base.placement.p0, p2: base.placement.p2 },
    strategies: {
      ...base.strategies,
      p0: { ...base.strategies.p0, target: { kind: 'lowest-hp' } },
    },
    rest: { hpStart: 70, mpStart: 60 },
    ...overrides,
  };
}

/** Steps a run in small increments, calling `observe` after each step. */
function stepUntil(
  sim: ReturnType<typeof lab>,
  state: SimState,
  done: (state: SimState) => boolean,
  observe: (state: SimState) => void = () => {},
  stepMs = 100,
  limitMs = 2_000_000,
): SimState {
  let current = state;
  const stopAt = current.nowMs + limitMs;
  while (!done(current)) {
    if (current.phase === 'stopped' || current.nowMs >= stopAt) {
      throw new Error(`condition never met by ${current.nowMs} ms (phase ${current.phase})`);
    }
    current = runTo(sim, current, current.nowMs + stepMs).state;
    observe(current);
  }
  return current;
}

function enemyRoster(state: SimState): unknown[] {
  return Object.values(state.actors)
    .filter((a) => a.side === 'enemy')
    .map((a) => [a.id, a.definitionId, a.position]);
}

test('queueRules takes a deep validated copy: a later edit to the source does not reach the queue (B-L14)', () => {
  const sim = lab();
  const rules = otherRules();
  const queued = sim.queueRules(sim.start(labInput()), rules);

  rules.rest.hpStart = 10;
  rules.strategies.p0.target = { kind: 'highest-hp' };
  (rules.placement as Record<string, string>).p0 = '9,9';

  expect(queued.pendingRules).toEqual(otherRules());
});

test('queueRules refuses an unactivatable payload with the engine input validator', () => {
  const sim = lab();
  const state = sim.start(labInput());
  const refusal = (rules: PendingRules) => {
    try {
      sim.queueRules(state, rules);
    } catch (error) {
      return { code: (error as { code: string }).code, field: (error as { field: string }).field };
    }
    throw new Error('expected a refusal');
  };
  expect(refusal({ ...otherRules(), wipeLimit: 2 } as PendingRules).code).toBe('INVALID_INPUT');
  expect(refusal(otherRules({ rest: { hpStart: 95, mpStart: 0 } }))).toEqual({
    code: 'INVALID_INPUT',
    field: 'pendingRules.rest.hpStart',
  });
  // The queue on the state it was asked about is untouched.
  expect(state.pendingRules).toBeNull();
});

test('a newer queue replaces the pending rules; there is at most one pending set (B-L16)', () => {
  const sim = lab();
  const first = sim.queueRules(sim.start(labInput()), otherRules({ rest: { hpStart: 20, mpStart: 0 } }));
  const second = sim.queueRules(first, otherRules({ rest: { hpStart: 40, mpStart: 10 } }));
  expect(second.pendingRules?.rest).toEqual({ hpStart: 40, mpStart: 10 });

  const spawned = runTo(sim, second, content.walkMs).state;
  expect(spawned.input.rest).toEqual({ hpStart: 40, mpStart: 10 });
  expect(spawned.pendingRules).toBeNull();
});

test('activation happens at the spawn after walking, consumes no RNG and cannot reroll the encounter (B-L15, B-11)', () => {
  const sim = lab();
  for (const seed of [1, 7, 42, 99_991]) {
    const control = sim.start(labInput({ seed }));
    const queued = sim.queueRules(control, otherRules());

    // Just before the walk completes nothing has changed.
    const before = runTo(sim, queued, content.walkMs - 1).state;
    expect(before.input).toEqual(control.input);
    expect(before.pendingRules).toEqual(otherRules());

    const spawnedControl = runTo(sim, control, content.walkMs).state;
    const spawned = runTo(sim, queued, content.walkMs).state;

    expect(spawned.encounterCount).toBe(1);
    expect(spawned.phase).toBe('fighting');
    expect(spawned.pendingRules).toBeNull();
    expect(spawned.input).toEqual({ ...control.input, ...otherRules() });
    // Identical PRNG state and identical recipe draw against the control run.
    expect(spawned.rng).toBe(spawnedControl.rng);
    expect(enemyRoster(spawned)).toEqual(enemyRoster(spawnedControl));
    // The party is seated from the activated placement.
    expect(spawned.actors.p0.position).toBe(otherRules().placement.p0);
  }
});

test('rules queued mid-fight wait for the fight to end and activate at the next spawn, never mid-fight (B-11)', () => {
  const sim = lab();
  const fighting = atFight();
  expect(fighting.phase).toBe('fighting');
  const original = fighting.input;
  const queued = sim.queueRules(fighting, otherRules({ rest: { hpStart: 20, mpStart: 0 } }));
  const startedIn = queued.encounterCount;

  let sawAnotherPhase = false;
  const spawned = stepUntil(
    sim,
    queued,
    (state) => state.encounterCount > startedIn,
    (state) => {
      if (state.encounterCount === startedIn) {
        expect(state.input).toEqual(original);
        expect(state.pendingRules).not.toBeNull();
        if (state.phase !== 'fighting') sawAnotherPhase = true;
      }
    },
  );
  expect(sawAnotherPhase).toBe(true);
  expect(spawned.input.rest).toEqual({ hpStart: 20, mpStart: 0 });
  expect(spawned.pendingRules).toBeNull();
});

test('rules queued while resting activate at the spawn after the rest, not when resting ends', () => {
  const sim = lab();
  // The highest legal thresholds make a rest after the first win all but certain.
  const input = labInput({ rest: { hpStart: 89, mpStart: 79 } });
  const resting = stepUntil(sim, sim.start(input), (state) => state.phase === 'resting');
  const queued = sim.queueRules(resting, otherRules({ rest: { hpStart: 0, mpStart: 0 } }));
  const startedIn = queued.encounterCount;

  let walkedFirst = false;
  const spawned = stepUntil(
    sim,
    queued,
    (state) => state.encounterCount > startedIn,
    (state) => {
      if (state.encounterCount === startedIn) {
        expect(state.input.rest).toEqual(input.rest);
        if (state.phase === 'walking') walkedFirst = true;
      }
    },
  );
  expect(walkedFirst).toBe(true);
  expect(spawned.input.rest).toEqual({ hpStart: 0, mpStart: 0 });
});

test('stop neither activates the pending rules nor resets encounter state (B-L17)', () => {
  const sim = lab();
  const queued = sim.queueRules(atFight(), otherRules());
  const stopped = sim.stop(queued);
  expect(stopped.pendingRules).toEqual(otherRules());
  expect(stopped.input).toEqual(queued.input);
  expect(stopped.encounterCount).toBe(queued.encounterCount);
  expect(stopped.rng).toBe(queued.rng);
});

test('pending rules survive a snapshot round trip and a corrupted queue is refused', () => {
  const sim = lab();
  const queued = sim.queueRules(sim.start(labInput()), otherRules());
  const text = encodeSnapshot(queued);
  expect(sim.decode(text).pendingRules).toEqual(otherRules());
  expect(sim.encode(sim.decode(text))).toBe(text);

  const corrupted = JSON.parse(text) as { pendingRules: { rest: { hpStart: number } } };
  corrupted.pendingRules.rest.hpStart = 95;
  expect(() => sim.decode(JSON.stringify(corrupted))).toThrow();
  const extra = JSON.parse(text) as { pendingRules: Record<string, unknown> };
  extra.pendingRules.seed = 5;
  expect(() => sim.decode(JSON.stringify(extra))).toThrow();
});
