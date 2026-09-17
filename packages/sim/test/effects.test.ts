import { expect, test } from 'vitest';
import {
  activeStunExpiry,
  addHealThreat,
  applySlow,
  applyTaunt,
  effectiveSlowBp,
  expire,
  livingActors,
  recoveryMs,
} from '../src/effects';
import { actor, context, fightFixture } from './fixtures';
import type { DomainEvent, TimedStatus } from '../src/types';

function slow(id: string, valueBp: number, expiresAt: number): TimedStatus {
  return { id, sourceId: id.slice(id.indexOf(':') + 1), kind: 'slow', valueBp, expiresAt };
}

function stun(id: string, expiresAt: number): TimedStatus {
  return { id, sourceId: 'e0', kind: 'stun', valueBp: 0, expiresAt };
}

test('expire drops records at their expiry and keeps later ones', () => {
  const state = fightFixture();
  state.nowMs = 6_000;
  state.actors.e0.statuses = [
    slow('slow:p2', 3_000, 5_999), // already elapsed
    slow('slow:p1', 2_000, 6_000), // expiry is inclusive
    stun('stun:p0', 6_001), // still active
  ];
  state.actors.e0.forcedTarget = { actorId: 'p0', expiresAt: 6_000 };
  state.actors.e1.forcedTarget = { actorId: 'p0', expiresAt: 6_001 };

  expire(state, 'e0');
  expire(state, 'e1');

  expect(state.actors.e0.statuses).toEqual([stun('stun:p0', 6_001)]);
  expect(state.actors.e0.forcedTarget).toBeNull();
  expect(state.actors.e1.forcedTarget).toEqual({ actorId: 'p0', expiresAt: 6_001 });
});

test('effective slow is the strongest active reduction, never their sum', () => {
  const cases: { name: string; statuses: TimedStatus[]; expected: number }[] = [
    { name: 'no statuses', statuses: [], expected: 0 },
    { name: 'one slow', statuses: [slow('slow:e0', 3_000, 9_000)], expected: 3_000 },
    {
      name: 'two slows take the maximum',
      statuses: [slow('slow:e0', 3_000, 9_000), slow('slow:e1', 5_000, 9_000)],
      expected: 5_000,
    },
    {
      name: 'weaker slow listed last still loses',
      statuses: [slow('slow:e0', 5_000, 9_000), slow('slow:e1', 3_000, 9_000)],
      expected: 5_000,
    },
    { name: 'expired slow is ignored', statuses: [slow('slow:e0', 5_000, 2_000)], expected: 0 },
    { name: 'a stun is not a slow', statuses: [stun('stun:e0', 9_000)], expected: 0 },
  ];

  for (const testCase of cases) {
    const subject = actor({ statuses: testCase.statuses });
    expect(effectiveSlowBp(subject, 2_000), testCase.name).toBe(testCase.expected);
  }
});

test('recovery scales the derived interval by the strongest active slow', () => {
  const unslowed = actor();
  expect(unslowed.stats.intervalMs).toBe(1_569);
  expect(recoveryMs(unslowed, 2_000)).toBe(1_569);
  expect(recoveryMs(actor({ statuses: [slow('slow:e0', 3_000, 9_000)] }), 2_000)).toBe(2_242);
  expect(
    recoveryMs(
      actor({ statuses: [slow('slow:e0', 3_000, 9_000), slow('slow:e1', 5_000, 9_000)] }),
      2_000,
    ),
  ).toBe(3_138); // 5,000 bp, not the 8,000 bp their sum would give
  expect(recoveryMs(actor({ statuses: [slow('slow:e0', 5_000, 2_000)] }), 2_000)).toBe(1_569);
});

test('active stun expiry reports the latest active stun', () => {
  expect(activeStunExpiry(actor(), 2_000)).toBeNull();
  expect(activeStunExpiry(actor({ statuses: [slow('slow:e0', 3_000, 9_000)] }), 2_000)).toBeNull();
  expect(activeStunExpiry(actor({ statuses: [stun('stun:a', 1_999)] }), 2_000)).toBeNull();
  expect(
    activeStunExpiry(actor({ statuses: [stun('stun:a', 2_800), stun('stun:b', 2_600)] }), 2_000),
  ).toBe(2_800);
});

test('a repeated slow from the same source refreshes instead of stacking', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  const caster = state.actors.p2;
  const target = state.actors.e0;

  applySlow(state, ctx, caster, target, 3_000, 5_000);
  expect(target.statuses).toEqual([
    { id: 'slow:p2', sourceId: 'p2', kind: 'slow', valueBp: 3_000, expiresAt: 7_000 },
  ]);

  state.nowMs = 3_000;
  applySlow(state, ctx, caster, target, 2_000, 5_000);

  expect(target.statuses).toEqual([
    { id: 'slow:p2', sourceId: 'p2', kind: 'slow', valueBp: 2_000, expiresAt: 8_000 },
  ]);
  expect(state.queue.filter((e) => e.kind === 'expire').map((e) => [e.actorId, e.at])).toEqual([
    ['e0', 7_000], ['e0', 8_000],
  ]);
  expect(events.map((e) => [e.kind, e.actorId, e.targetId, e.amount, e.reason])).toEqual([
    ['status', 'e0', 'p2', 3_000, 'slow'],
    ['status', 'e0', 'p2', 2_000, 'slow'],
  ]);

  // A second source is a separate record, and the strongest of the two applies.
  applySlow(state, ctx, state.actors.p1, target, 4_000, 5_000);
  expect(target.statuses).toHaveLength(2);
  expect(effectiveSlowBp(target, 3_000)).toBe(4_000);
});

test('taunt raises caster threat to 110% of the previous maximum, floored at one', () => {
  const cases: [Record<string, number>, number][] = [
    [{}, 1],
    [{ p1: 1 }, 2],
    [{ p1: 9 }, 10],
    [{ p1: 10 }, 11],
    [{ p1: 40 }, 44],
    [{ p1: 100 }, 110],
    [{ p1: 101 }, 112],
    [{ p1: 7, p2: 40 }, 44], // the maximum across sources, not the caster's own entry
  ];

  for (const [threat, expected] of cases) {
    const state = fightFixture();
    const events: DomainEvent[] = [];
    const ctx = context(state, events);
    state.actors.e0.threat = { ...threat };

    applyTaunt(state, ctx, state.actors.p0, state.actors.e0, 4_000);

    expect(state.actors.e0.threat.p0, JSON.stringify(threat)).toBe(expected);
    expect(events.map((e) => [e.kind, e.actorId, e.targetId, e.amount])).toEqual([
      ['taunt', 'p0', 'e0', expected],
    ]);
  }
});

test('taunt replaces the forced record outright and schedules its own expiry', () => {
  const state = fightFixture();
  const ctx = context(state, []);
  state.actors.e0.forcedTarget = { actorId: 'p1', expiresAt: 9_000 };

  applyTaunt(state, ctx, state.actors.p0, state.actors.e0, 4_000);

  expect(state.actors.e0.forcedTarget).toEqual({ actorId: 'p0', expiresAt: 6_000 });
  expect(state.queue.filter((e) => e.kind === 'expire')).toEqual([
    { at: 6_000, kind: 'expire', actorId: 'e0', seq: expect.any(Number), epoch: 0, token: null },
  ]);
});

test('heal threat reaches only living enemies, in ascending id order', () => {
  const state = fightFixture();
  state.actors.e1.hp = 0;
  const order: string[] = [];
  for (const entry of livingActors(state)) order.push(entry.id);
  expect(order).toEqual(['e0', 'e2', 'p0', 'p1', 'p2']);

  state.actors.e0.threat = { p1: 4 };
  addHealThreat(state, 'p1', 7);

  expect(state.actors.e0.threat).toEqual({ p1: 7 }); // 4 + floor(7 / 2)
  expect(state.actors.e2.threat).toEqual({ p1: 3 });
  expect(state.actors.e1.threat).toEqual({});
  expect(state.actors.p0.threat).toEqual({});
});
