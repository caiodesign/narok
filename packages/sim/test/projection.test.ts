import { expect, test } from 'vitest';
import { gridPosition } from '../src/battlefield/grid';
import { project } from '../src/project';
import type { Metrics, SimState } from '../src/types';
import { actor, atFight } from './fixtures';

/**
 * A hand-built state exercising every `targetReason` branch (ruling R42) plus
 * enough runtime-only fields (queue, RNG, threat internals, tokens, epoch,
 * pending-cast targets/timing) that a stray object spread in `project` would be
 * caught by the "never projects" assertions below.
 */
function targetReasonState(): SimState {
  const p0 = actor({
    id: 'p0',
    currentTarget: 'e0',
    forcedTarget: { actorId: 'e0', expiresAt: 5_000 },
    actionToken: 7,
    cooldowns: { taunt: 4_000 },
  });
  const p1 = actor({
    id: 'p1',
    currentTarget: 'e0',
    // An expired forced-target record naming the current target: must NOT read as forced.
    forcedTarget: { actorId: 'e0', expiresAt: 1_000 },
    pendingCast: { skillId: 'cleave', targets: ['e0'], startedAt: 900, completesAt: 1_400, token: 3 },
  });
  const p2 = actor({ id: 'p2', currentTarget: null });
  const e0 = actor({
    id: 'e0',
    side: 'enemy',
    currentTarget: 'p0',
    threat: { p0: 5, p1: 0 },
    position: gridPosition(1, 1),
  });
  const zero = { damageDealt: 0, damageReceived: 0, healingDone: 0 };
  const metrics: Metrics = {
    kills: 0, wins: 0, wipes: 0, rawExp: 0, rawGold: 0, damageDealt: 0, effectiveHealing: 0,
    walkMs: 2_000, fightMs: 0, restMs: 0, respawnMs: 0,
    actors: { p0: { ...zero }, p1: { ...zero }, p2: { ...zero }, e0: { ...zero } },
  };
  return {
    schemaVersion: 1,
    simulationVersion: 'b1',
    contentVersion: 'test-content',
    gridHash: 'test-grid',
    nowMs: 2_000,
    rng: 123456,
    nextQueueSeq: 9,
    nextDomainSeq: 4,
    epoch: 2,
    encounterCount: 1,
    encounterStartedAt: 2_000,
    phase: 'fighting',
    stopReason: null,
    input: {
      seed: 1, classes: ['guardian'], recipe: 'melee', placement: {}, strategies: {},
      rest: { hpStart: 50, mpStart: 30 }, wipeLimit: 1,
    },
    pendingRules: null,
    // Deliberately out of ASCII order (e0 before p0/p1/p2) so the sort is exercised.
    actors: { e0, p2, p0, p1 },
    queue: [{ at: 3_000, kind: 'act', actorId: 'p0', seq: 0, epoch: 2, token: 7 }],
    metrics,
  };
}

test('actors are listed in ASCII id order regardless of construction order', () => {
  const projected = project(targetReasonState());
  expect(projected.actors.map((a) => a.id)).toEqual(['e0', 'p0', 'p1', 'p2']);
});

test('targetReason resolves forced, threat, priority and null exactly (R42)', () => {
  const projected = project(targetReasonState());
  const byId = Object.fromEntries(projected.actors.map((a) => [a.id, a]));

  // Unexpired forcedTarget naming currentTarget wins over everything else.
  expect(byId.p0.targetReason).toBe('forced');
  // Enemy with positive threat on its currentTarget, no live forced record.
  expect(byId.e0.targetReason).toBe('threat');
  // Party actor: threat never applies to it; its own forcedTarget has expired.
  expect(byId.p1.targetReason).toBe('priority');
  // No currentTarget at all.
  expect(byId.p2.targetReason).toBeNull();
});

test('casting reflects only the current pending skill, never its timing or targets', () => {
  const projected = project(targetReasonState());
  const byId = Object.fromEntries(projected.actors.map((a) => [a.id, a]));
  expect(byId.p1.casting).toBe('cleave');
  expect(byId.p0.casting).toBeNull();
});

test('cooldowns are copied as an independent plain record (R12/R42)', () => {
  const state = targetReasonState();
  const projected = project(state);
  const p0 = projected.actors.find((a) => a.id === 'p0')!;
  expect(p0.cooldowns).toEqual({ taunt: 4_000 });
  p0.cooldowns.taunt = 999;
  expect(state.actors.p0.cooldowns.taunt).toBe(4_000);
});

test('metrics are deep-copied, never aliasing the source state', () => {
  const state = targetReasonState();
  const projected = project(state);
  projected.metrics.kills = 999;
  projected.metrics.actors.p0.damageDealt = 999;
  expect(state.metrics.kills).toBe(0);
  expect(state.metrics.actors.p0.damageDealt).toBe(0);
});

test('every PublicActor carries exactly the allow-listed fields, never queue, RNG, tokens, epoch, threat or status internals', () => {
  const projected = project(targetReasonState());
  const allowed = new Set([
    'id', 'definitionId', 'side', 'position', 'hp', 'mp', 'maxHp', 'maxMp',
    'currentTarget', 'casting', 'targetReason', 'cooldowns',
  ]);
  for (const a of projected.actors) {
    expect(new Set(Object.keys(a))).toEqual(allowed);
  }
  expect(new Set(Object.keys(projected))).toEqual(new Set(['nowMs', 'phase', 'stopReason', 'actors', 'metrics']));
});

test('a real advanced state projects the same public actor count and ids as the runtime state', () => {
  const state = atFight();
  const projected = project(state);
  expect(projected.actors.map((a) => a.id)).toEqual(Object.keys(state.actors).sort());
  expect(projected.nowMs).toBe(state.nowMs);
  expect(projected.phase).toBe(state.phase);
});
