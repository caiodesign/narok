import { expect, test } from 'vitest';
import { lab, labInput, runTo } from './fixtures';

/** Deep-freezes an object graph so any mutation attempt throws instead of silently succeeding. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

test('split and summary runs preserve state and ordered events', () => {
  const sim = lab();
  const initial = sim.start(labInput());
  const direct = runTo(sim, initial, 60000);
  const left = runTo(sim, initial, 2751);
  const right = runTo(sim, sim.decode(sim.encode(left.state)), 60000);
  expect(right.state).toEqual(direct.state);
  expect([...left.events, ...right.events]).toEqual(direct.events);
  expect(runTo(sim, initial, 60000, { collect: 'summary' }).state).toEqual(direct.state);
});

test('work limit yields without changing the outcome', () => {
  const sim = lab();
  const state = sim.start(labInput());
  expect(runTo(sim, state, 60000, { maxScheduledEvents: 1 }))
    .toEqual(runTo(sim, state, 60000));
});

test('start() and advance() never mutate the caller\'s input or state (contract §3)', () => {
  const sim = lab();
  const frozenInput = deepFreeze(labInput());
  // A frozen LabInput throws under `'use strict'` on any write attempt (module
  // code is strict by default), so `start` mutating it in place would fail loudly.
  const state = sim.start(frozenInput);
  expect(state.input).toEqual(frozenInput);

  const frozenState = deepFreeze(sim.start(labInput()));
  const before = sim.encode(frozenState);
  sim.advance(frozenState, 5_000);
  expect(sim.encode(frozenState)).toBe(before);
});

test('a mid-cast snapshot round-trips through encode/decode and still resolves (R44 split invariance)', () => {
  const sim = lab();
  const initial = sim.start(labInput());
  // 2,751 ms lands inside p1's first cast window (started 2,500 ms, resolves later).
  const midCast = runTo(sim, initial, 2_751).state;
  const casting = Object.values(midCast.actors).find((actor) => actor.pendingCast !== null);
  expect(casting).toBeDefined();

  const decoded = sim.decode(sim.encode(midCast));
  expect(decoded).toEqual(midCast);
  const decodedCasting = decoded.actors[casting!.id];
  expect(decodedCasting.pendingCast).toEqual(casting!.pendingCast);

  // The resumed run from the decoded snapshot reaches the same outcome as the
  // uninterrupted direct run (already proven state-for-state by the split test
  // above); here the point is specifically that the in-flight cast survives the
  // round trip and completes.
  const resumed = runTo(sim, decoded, casting!.pendingCast!.completesAt).state;
  expect(resumed.actors[casting!.id].pendingCast).toBeNull();
});

test('stop() sets operator phase/reason, clears the queue, and preserves everything else', () => {
  const sim = lab();
  const running = runTo(sim, sim.start(labInput()), 5_000).state;
  const before = sim.encode(running);

  const stopped = sim.stop(running);

  expect(stopped.phase).toBe('stopped');
  expect(stopped.stopReason).toBe('operator');
  expect(stopped.queue).toEqual([]);
  expect(stopped.nowMs).toBe(running.nowMs);
  expect(stopped.rng).toBe(running.rng);
  expect(stopped.metrics).toEqual(running.metrics);
  expect(stopped.actors).toEqual(running.actors);
  // stop() clones rather than mutating its argument (contract §3).
  expect(sim.encode(running)).toBe(before);
});

test('a stopped experiment accrues no further time, regen or events on repeated advance (R38)', () => {
  const sim = lab();
  const running = runTo(sim, sim.start(labInput()), 5_000).state;
  const stopped = sim.stop(running);
  const stoppedEncoded = sim.encode(stopped);

  // A far-future target must not move the clock, touch metrics/rng, or emit anything.
  const result = sim.advance(stopped, 3_600_000);

  expect(result.reachedTarget).toBe(true);
  expect(result.events).toEqual([]);
  expect(sim.encode(result.state)).toBe(stoppedEncoded);
  expect(result.state.nowMs).toBe(stopped.nowMs);
  expect(result.state.metrics).toEqual(stopped.metrics);

  // Advancing the already-stopped result again is equally inert.
  const again = sim.advance(result.state, 7_200_000);
  expect(again.reachedTarget).toBe(true);
  expect(again.events).toEqual([]);
  expect(sim.encode(again.state)).toBe(stoppedEncoded);
});

test('an experiment the engine itself stopped (stalemate) is equally inert on further advance', () => {
  const sim = lab();
  // Wipe limit one and a seed whose party cannot out-damage a fresh boar trio
  // before the 120,000 ms deadline would need real balance tuning; instead reuse
  // the dispatcher's own stalemate outcome by stopping at the deadline with an
  // undecided fight is exercised in invariants.test.ts. Here we only need *some*
  // stopped, non-operator state to prove R38 is reason-agnostic, so build one
  // directly rather than depend on combat balance.
  const running = runTo(sim, sim.start(labInput()), 5_000).state;
  const engineStopped = { ...running, phase: 'stopped' as const, stopReason: 'stalemate' as const, queue: [] };

  const result = sim.advance(engineStopped, 999_999_999);

  expect(result.reachedTarget).toBe(true);
  expect(result.events).toEqual([]);
  expect(result.state.nowMs).toBe(engineStopped.nowMs);
  expect(result.state.stopReason).toBe('stalemate');
  expect(result.state.metrics).toEqual(engineStopped.metrics);
});
