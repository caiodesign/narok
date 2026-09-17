import { expect, test } from 'vitest';
import { content } from '@narok/data';
import type { RecipeId } from '@narok/data';
import { transition, regenerate, finishEncounter, deadline } from '../src/lifecycle';
import { drawBelow } from '../src/rng';
import { schedule } from '../src/scheduler';
import { gridPosition } from '../src/battlefield/grid';
import { derive } from '../src/math';
import { fightFixture, walkCompleteState, context, actor, labInput } from './fixtures';
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
    simulationVersion: 'a1',
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
