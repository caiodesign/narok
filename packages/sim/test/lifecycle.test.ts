import { expect, test } from 'vitest';
import { content } from '@narok/data';
import type { ClassId, RecipeId } from '@narok/data';
import { transition, regenerate, finishEncounter, deadline } from '../src/lifecycle';
import { drawBelow } from '../src/rng';
import { schedule } from '../src/scheduler';
import { encodeSnapshot, decodeSnapshot } from '../src/snapshot';
import { gridPosition } from '../src/battlefield/grid';
import { derive } from '../src/math';
import { defaultStrategy } from '../src/state';
import { fightFixture, walkCompleteState, context, actor, lab, labInput, runTo } from './fixtures';
import type { Actor, ActorId, DomainEvent, Metrics, Phase, SimState } from '../src/types';

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
    actors,
    queue: [],
    metrics: {
      kills: 0, wins: 0, wipes: 0, rawExp: 0, rawGold: 0, damageDealt: 0, effectiveHealing: 0,
      walkMs: 0, fightMs: 0, restMs: 0, respawnMs: 0, actors: metricsActors,
    },
  };
}

function soloState(phase: Phase, hp: number, mp: number, maxMp?: number): SimState {
  return multiActorState(phase, [{ id: 'p0', hp, mp, maxMp }]);
}

test('one allowed wipe stops on the first wipe', () => {
  const state = fightFixture();
  for (const a of Object.values(state.actors).filter(a => a.side === 'party')) a.hp = 0;
  finishEncounter(state, context(state, []));
  expect(state.phase).toBe('stopped');
  expect(state.stopReason).toBe('wipe-limit');
  expect(state.metrics.wipes).toBe(1);
});
test('won encounter revives a member without a free MP refill', () => {
  const state = fightFixture();
  state.actors.p1.hp = 0;
  state.actors.p1.mp = 3;
  for (const a of Object.values(state.actors).filter(a => a.side === 'enemy')) a.hp = 0;
  finishEncounter(state, context(state, []));
  expect(state.actors.p1.hp).toBe(Math.floor(state.actors.p1.stats.maxHp / 10));
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

test('five total wipes stop only at the configured limit', () => {
  const state = fightFixture();
  state.input.wipeLimit = 5;
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  for (let i = 1; i <= 5; i++) {
    state.phase = 'fighting';
    for (const a of Object.values(state.actors)) if (a.side === 'party') a.hp = 0;
    finishEncounter(state, ctx);
    expect(state.metrics.wipes).toBe(i);
    if (i < 5) {
      expect(state.phase).toBe('respawning');
      expect(state.stopReason).toBeNull();
    }
  }
  expect(state.phase).toBe('stopped');
  expect(state.stopReason).toBe('wipe-limit');
  expect(state.queue).toEqual([]);
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

test('30-second respawn: wipe schedules a respawn transition, which fully restores HP/MP and resumes walking', () => {
  const state = fightFixture();
  state.input.wipeLimit = 2; // must not be the final wipe, or it stops instead of respawning
  state.actors.p0.cooldowns.cleave = 6_000;
  state.actors.p1.mp = 3;
  for (const a of Object.values(state.actors)) if (a.side === 'party') a.hp = 0;

  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  finishEncounter(state, ctx);
  expect(state.phase).toBe('respawning');

  const respawnEntry = state.queue.find((e) => e.kind === 'transition');
  expect(respawnEntry).toMatchObject({ at: state.nowMs + 30_000, actorId: '', epoch: null, token: null });

  // Stand in for the dispatcher, which always pops an entry before running its handler.
  state.queue.splice(state.queue.indexOf(respawnEntry!), 1);
  state.nowMs = respawnEntry!.at;
  transition(state, ctx);

  expect(state.phase).toBe('walking');
  for (const id of ['p0', 'p1', 'p2'] as const) {
    const member = state.actors[id];
    expect(member.hp).toBe(member.stats.maxHp);
    expect(member.mp).toBe(member.stats.maxMp);
    expect(member.statuses).toEqual([]);
    expect(member.pendingCast).toBeNull();
    expect(member.forcedTarget).toBeNull();
    expect(member.threat).toEqual({});
  }
  expect(state.actors.p0.cooldowns.cleave).toBe(6_000); // preserved exactly, not recomputed
  const nextTransition = state.queue.find((e) => e.kind === 'transition');
  expect(nextTransition).toMatchObject({
    at: state.nowMs + content.walkMs, actorId: '', epoch: null, token: null,
  });
  expect(events.some((e) => e.kind === 'phase' && e.reason === 'walking')).toBe(true);
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
 * now re-seats the party at `input.placement`, which `startState` validated
 * collision-free, exactly as `spawnEncounter` already did.
 */
test('R92: a win revives a corpse an ally stands on without stacking two living actors', () => {
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
  expect(result.state.actors.p0.hp).toBe(Math.floor(state.actors.p0.stats.maxHp / 10));
  const cells = livingCells(result.state);
  expect(new Set(cells).size).toBe(cells.length);
  for (const id of ['p0', 'p1', 'p2'] as const) {
    expect(result.state.actors[id].position).toBe(placement[id]);
  }
  // Re-seating is a teleport, matching spawnEncounter: no move event is emitted.
  expect(result.events.some((event) => event.kind === 'move')).toBe(false);

  // Ruling R96: `validateSimState` enforces the same rule independently
  // (`duplicate live position with <id>`), so the overlap also broke snapshot
  // decode — browser export/import and every checkpoint/restore path — for a
  // state captured between the revive and the next spawn. It must round-trip.
  const encoded = sim.encode(result.state);
  expect(sim.encode(sim.decode(encoded))).toBe(encoded);
});

/**
 * The wipe path had the same shape (ruling R92): two members can die on one cell
 * for the same reason, and `completeRespawn` restored both to full HP without
 * touching position. Re-seating at encounter exit covers it, so the respawn
 * transition can no longer resurrect a stack.
 */
test('R92: a respawn after two members die on one cell restores them to separate cells', () => {
  const sim = lab();
  const state = fightFixture();
  state.input.wipeLimit = 2; // not the final wipe, so it respawns instead of stopping
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

  const wiped = sim.advance(state, 2_100).state;
  expect(wiped.phase).toBe('respawning');

  const respawned = sim.advance(wiped, 2_100 + content.respawnMs).state;
  expect(respawned.phase).toBe('walking');
  for (const id of ['p0', 'p1', 'p2'] as const) {
    expect(respawned.actors[id].hp).toBe(respawned.actors[id].stats.maxHp);
    expect(respawned.actors[id].position).toBe(placement[id]);
  }
  const cells = livingCells(respawned);
  expect(new Set(cells).size).toBe(cells.length);
  const encoded = sim.encode(respawned);
  expect(sim.encode(sim.decode(encoded))).toBe(encoded);
});

/**
 * Ruling R100. The two tests above reproduce the *state* ruling R92 describes;
 * this one replays the *sequence*. Every step is executed by the engine itself,
 * including step 2 of the chain — `executeMove` permitting a step onto a corpse
 * — which is the behaviour that makes the whole bug possible and which a
 * hand-built precondition never exercises.
 *
 * The input is R92's own reproduction, the balance-matrix cell that aborted:
 * seed 4, two Guardians, the `melee` recipe and the CLI's `front` placement
 * ((1,3) and (2,3) in roster order). Two Guardians converge on the same front
 * cell, which is exactly the geometry that puts a corpse under an ally. Before
 * the fix this threw `INVALID_STATE actors.pN.position "shares a cell with pM"`
 * advancing past `nowMs` 121,980.
 *
 * `tools/balance`'s `buildLabInput` is deliberately not imported: `packages/sim`
 * must not gain a dependency on `tools/`, so the equivalent input is built here
 * from the same rest thresholds and wipe limit that CLI uses.
 */
test('R100: R92\'s own reproduction runs past the instant it used to abort on', () => {
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
  let state = sim.start(input);
  for (let target = 5_000; target <= 130_000; target += 5_000) {
    state = runTo(sim, state, target, { collect: 'summary' }).state;
  }

  expect(state.nowMs).toBe(130_000);
  expect(state.metrics.wins).toBe(2);
  expect(state.stopReason).toBeNull();
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
// regenerate: phase multipliers, caps, rest exit, stop/respawn scheduling
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

test('regen still schedules its successor while respawning but applies no gains', () => {
  const state = soloState('respawning', 500, 500);
  const events: DomainEvent[] = [];
  regenerate(state, context(state, events));
  expect(state.actors.p0.hp).toBe(500);
  expect(state.actors.p0.mp).toBe(500);
  expect(events).toEqual([]);
  expect(state.queue.some((e) => e.kind === 'regen' && e.at === state.nowMs + content.regenMs)).toBe(true);
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
