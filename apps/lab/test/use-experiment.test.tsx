// @vitest-environment jsdom
/**
 * The laboratory's `useExperiment` hook, driven through a hand-written fake
 * worker (R56). Split out of the client's `controls.test.tsx` when the hook
 * moved to `apps/lab` (milestone B Task 8); the cases are unchanged.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { defaultStrategy, gridPosition } from '@narok/data';
import { emptyDropMetrics } from '@narok/sim';
import type { ActorId, LabInput, Metrics, PublicState, Strategy } from '@narok/sim';
import { useExperiment, type ClockDriver, type WorkerLike } from '../src/useExperiment';
import type { WorkerRequest, WorkerResponse } from '../src/worker-contract';

function labInput(overrides: Partial<LabInput> = {}): LabInput {
  const classes: LabInput['classes'] = ['guardian', 'cleric', 'ranger'];
  const strategies: Record<ActorId, Strategy> = {};
  classes.forEach((classId, index) => {
    strategies[`p${index}`] = defaultStrategy(classId);
  });
  return {
    seed: 1,
    classes,
    recipe: 'mixed',
    placement: { p0: gridPosition(2, 3), p1: gridPosition(1, 4), p2: gridPosition(3, 4) },
    strategies,
    rest: { hpStart: 50, mpStart: 30 },
    ...overrides,
  };
}

const EMPTY_METRICS: Metrics = {
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
  consumed: {},
  actors: {},
  drops: emptyDropMetrics(),
};

afterEach(() => {
  cleanup();
});

function publicState(overrides: Partial<PublicState> = {}): PublicState {
  return {
    nowMs: 0,
    phase: 'walking',
    stopReason: null,
    actors: [],
    metrics: EMPTY_METRICS,
    ...overrides,
  };
}

// --- useExperiment (hook, driven through a hand-written fake worker) -----

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: WorkerRequest[] = [];
  terminated = false;

  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(message: WorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
  }
}

function createManualDriver(): { driver: ClockDriver; setNow: (ms: number) => void; pump: () => void } {
  let currentNow = 0;
  let pending: Array<() => void> = [];
  const driver: ClockDriver = {
    now: () => currentNow,
    schedule: (callback) => {
      pending.push(callback);
      return pending.length;
    },
    cancel: () => {
      // Manual driver: cancellation is a no-op, matched by pump() only ever
      // running callbacks captured at the start of its own call.
    },
  };
  return {
    driver,
    setNow: (ms: number) => {
      currentNow = ms;
    },
    pump: () => {
      const due = pending;
      pending = [];
      due.forEach((callback) => callback());
    },
  };
}

describe('useExperiment', () => {
  let workers: FakeWorker[];
  let createWorker: () => WorkerLike;

  beforeEach(() => {
    workers = [];
    createWorker = () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('pause and speed changes reanchor the clock without sending the worker an advance', () => {
    const { driver, setNow, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput()));
    const worker = workers[0];
    expect(worker.sent).toEqual([{ type: 'start', generation: 1, input: labInput() }]);

    act(() => worker.respond({ type: 'frame', generation: 1, state: publicState(), events: [], reachedTarget: true }));
    expect(result.current.status).toBe('running');

    act(() => result.current.pause());
    setNow(20_000);
    act(() => pump());
    expect(worker.sent).toHaveLength(1); // still just the initial start

    act(() => result.current.setSpeed(16));
    act(() => pump());
    expect(worker.sent).toHaveLength(1);

    act(() => result.current.resume());
    act(() => pump()); // horizon is still 0 right at the resume anchor: no new work yet
    expect(worker.sent).toHaveLength(1);

    setNow(25_000); // 5s of real time at the new 16x speed
    act(() => pump());
    expect(worker.sent).toHaveLength(2);
    expect(worker.sent[1]).toMatchObject({ type: 'advance', generation: 1 });
  });

  test('never sends two outstanding advances (bounded pending frames)', () => {
    const { driver, setNow, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput()));
    const worker = workers[0];
    act(() => worker.respond({ type: 'frame', generation: 1, state: publicState(), events: [], reachedTarget: true }));

    setNow(5000);
    act(() => pump());
    expect(worker.sent).toHaveLength(2); // start + first advance

    // A second tick before the worker responds must not send another advance.
    setNow(9000);
    act(() => pump());
    expect(worker.sent).toHaveLength(2);
  });

  test('requests exactly the supplied horizon, never beyond it, and resends the same target while incomplete', () => {
    const { driver, setNow, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput()));
    const worker = workers[0];
    act(() => worker.respond({ type: 'frame', generation: 1, state: publicState(), events: [], reachedTarget: true }));

    setNow(5000);
    act(() => pump());
    // horizon = floor(0 + (5000 - 0) * 1 - 2000) = 3000
    expect(worker.sent[1]).toMatchObject({ type: 'advance', generation: 1, untilMs: 3000 });

    act(() =>
      worker.respond({
        type: 'frame',
        generation: 1,
        state: publicState({ nowMs: 1000 }),
        events: [],
        reachedTarget: false,
      }),
    );
    // Incomplete batch: immediately resent to the SAME target, not a new one.
    expect(worker.sent[2]).toMatchObject({ type: 'advance', generation: 1, untilMs: 3000 });
  });

  test('worker error transitions to error status and recovers to usable running on the next start', () => {
    const { driver, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput()));
    const first = workers[0];
    act(() => first.respond({ type: 'error', generation: 1, code: 'STALE_GENERATION', field: 'advance' }));
    expect(result.current.status).toBe('error');

    act(() => result.current.start(labInput()));
    const second = workers[1];
    expect(second.sent).toEqual([{ type: 'start', generation: 2, input: labInput() }]);
    act(() => second.respond({ type: 'frame', generation: 2, state: publicState(), events: [], reachedTarget: true }));
    expect(result.current.status).toBe('running');
    void pump;
  });

  test('a stale (superseded) generation frame is dropped with no effect (dropped-older branch)', () => {
    const { driver, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput()));
    const first = workers[0];
    act(() => first.respond({ type: 'frame', generation: 1, state: publicState(), events: [], reachedTarget: true }));

    act(() => result.current.start(labInput())); // generation becomes 2
    const second = workers[1];
    act(() => second.respond({ type: 'frame', generation: 2, state: publicState({ nowMs: 42 }), events: [], reachedTarget: true }));
    expect(result.current.state?.nowMs).toBe(42);

    // A late frame from the superseded generation 1 worker must be ignored.
    act(() => first.respond({ type: 'frame', generation: 1, state: publicState({ nowMs: 999 }), events: [], reachedTarget: true }));
    expect(result.current.state?.nowMs).toBe(42);
    expect(result.current.status).toBe('running');
    void pump;
  });

  test('an errored-unseen-generation response surfaces as a worker error', () => {
    const { driver, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput()));
    const worker = workers[0];
    act(() => worker.respond({ type: 'frame', generation: 1, state: publicState(), events: [], reachedTarget: true }));

    // The worker reports a protocol bug: a request referenced a generation it
    // never established (or arrived with no experiment loaded).
    act(() => worker.respond({ type: 'error', generation: 1, code: 'STALE_GENERATION', field: 'stop' }));
    expect(result.current.status).toBe('error');
    void pump;
  });

  test('produces comparison summaries on completion and shifts A/B across two runs', () => {
    const { driver, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput({ seed: 1 })));
    const first = workers[0];
    act(() =>
      first.respond({
        type: 'frame',
        generation: 1,
        state: publicState({ phase: 'stopped', stopReason: 'operator', nowMs: 100 }),
        events: [],
        reachedTarget: true,
      }),
    );
    expect(result.current.status).toBe('stopped');
    expect(result.current.comparisonB?.nowMs).toBe(100);
    expect(result.current.comparisonA).toBeNull();

    act(() => result.current.start(labInput({ seed: 2 })));
    const second = workers[1];
    act(() =>
      second.respond({
        type: 'frame',
        generation: 2,
        state: publicState({ phase: 'stopped', stopReason: 'operator', nowMs: 200 }),
        events: [],
        reachedTarget: true,
      }),
    );
    expect(result.current.comparisonB?.nowMs).toBe(200);
    expect(result.current.comparisonA?.nowMs).toBe(100);
    void pump;
  });

  test('R79: stop() participates in the pending marker instead of firing regardless of an outstanding advance', () => {
    const { driver, setNow, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput()));
    const worker = workers[0];
    act(() => worker.respond({ type: 'frame', generation: 1, state: publicState(), events: [], reachedTarget: true }));

    setNow(5000);
    act(() => pump()); // sends the first advance; still unanswered
    expect(worker.sent).toHaveLength(2);
    expect(worker.sent[1]).toMatchObject({ type: 'advance', generation: 1 });

    act(() => result.current.stop());
    // The outstanding advance hasn't been answered yet -- a correctly-gated
    // stop must not fire alongside it (tied to request identity, not a bare
    // boolean that stop ignores).
    expect(worker.sent).toHaveLength(2);

    act(() =>
      worker.respond({
        type: 'frame',
        generation: 1,
        state: publicState({ nowMs: 1000 }),
        events: [],
        reachedTarget: false,
      }),
    );
    // The outstanding advance's own response arrives, reporting incomplete
    // work. The deferred stop must be sent now -- and the advance must NOT be
    // resent even though reachedTarget was false, because a frame only clears
    // the pending marker for the request it actually answers, and a stop is
    // what's actually pending by the time this frame lands.
    expect(worker.sent).toHaveLength(3);
    expect(worker.sent[2]).toEqual({ type: 'stop', generation: 1 });
  });
});
