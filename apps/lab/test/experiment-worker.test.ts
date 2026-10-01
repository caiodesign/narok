/**
 * Worker-level tests (ruling R75) exercising `src/experiment.worker.ts` directly —
 * no `Worker` thread, no hook. The worker module assigns `self.onmessage` as a
 * module-scope side effect, so each test stubs a minimal `self` (matching the
 * module's own local `declare const self` shape) *before* dynamically importing a
 * fresh copy of the module (`vi.resetModules()` clears the cache each time, since
 * the module holds its own private `state`/`generation`).
 *
 * Focus: the `import`/`export` branches of contract §7 that the hook never
 * exercises, including their generation checks (dropped-older, errored-unseen,
 * and "no experiment loaded").
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { content, validateContent } from '@narok/data';
import { createGrid, createSimulation } from '@narok/sim';
import type { ActorId, DomainEvent, LabInput, Strategy } from '@narok/sim';
import { defaultStrategy, gridPosition } from '@narok/sim';
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

/** Builds a valid, non-trivial (nowMs > 0) encoded snapshot the same way the CLI/lab would. */
function snapshotAt(untilMs: number): string {
  const validated = validateContent(content);
  const sim = createSimulation(validated, createGrid(validated.grid, validated.shapes));
  const started = sim.start(labInput());
  const advanced = sim.advance(started, untilMs, { maxScheduledEvents: 25 });
  return sim.encode(advanced.state);
}

type Handler = (event: MessageEvent<WorkerRequest>) => void;

async function loadWorker(): Promise<{ post: (message: WorkerRequest) => void; posted: WorkerResponse[] }> {
  vi.resetModules();
  const posted: WorkerResponse[] = [];
  let handler: Handler | null = null;
  vi.stubGlobal('self', {
    postMessage: (message: WorkerResponse) => posted.push(message),
    set onmessage(next: Handler | null) {
      handler = next;
    },
    get onmessage() {
      return handler;
    },
  });
  await import('../src/experiment.worker');
  return {
    posted,
    post: (message: WorkerRequest) => {
      if (!handler) throw new Error('worker module did not register self.onmessage');
      (handler as Handler)({ data: message } as MessageEvent<WorkerRequest>);
    },
  };
}

describe('experiment.worker: export', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns encodeSnapshot of the currently held state for a started generation', async () => {
    const { post, posted } = await loadWorker();
    post({ type: 'start', generation: 1, input: labInput() });
    expect(posted[0]).toMatchObject({ type: 'frame', generation: 1 });

    post({ type: 'export', generation: 1 });
    expect(posted).toHaveLength(2);
    const snapshot = posted[1];
    expect(snapshot.type).toBe('snapshot');
    if (snapshot.type !== 'snapshot') throw new Error('expected a snapshot response');
    expect(snapshot.generation).toBe(1);
    expect(() => JSON.parse(snapshot.text)).not.toThrow();
  });

  test('errors STALE_GENERATION when no experiment is loaded for an otherwise-current generation', async () => {
    const { post, posted } = await loadWorker();
    // Force `start` to fail validation (empty roster) so the generation is
    // recorded as seen but no state is ever held.
    post({ type: 'start', generation: 1, input: labInput({ classes: [] }) });
    expect(posted[0]).toMatchObject({ type: 'error', generation: 1 });

    post({ type: 'export', generation: 1 });
    expect(posted[1]).toEqual({ type: 'error', generation: 1, code: 'STALE_GENERATION', field: 'export' });
  });

  test('errors STALE_GENERATION for a generation the worker has never seen', async () => {
    const { post, posted } = await loadWorker();
    post({ type: 'export', generation: 1 }); // no start at all yet
    expect(posted).toEqual([{ type: 'error', generation: 1, code: 'STALE_GENERATION', field: 'export' }]);
  });

  test('a request for a superseded (older) generation is dropped with no output', async () => {
    const { post, posted } = await loadWorker();
    post({ type: 'start', generation: 1, input: labInput() });
    post({ type: 'start', generation: 2, input: labInput() }); // supersedes generation 1
    expect(posted).toHaveLength(2);

    post({ type: 'export', generation: 1 }); // stale: dropped, no third message
    expect(posted).toHaveLength(2);
  });
});

describe('experiment.worker: import', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('decodes a snapshot into the held state, replacing whatever start produced', async () => {
    const { post, posted } = await loadWorker();
    post({ type: 'start', generation: 1, input: labInput() }); // nowMs 0
    expect(posted[0]).toMatchObject({ type: 'frame', generation: 1, state: { nowMs: 0 } });

    const text = snapshotAt(2_000); // a later, distinct state
    post({ type: 'import', generation: 1, text });

    expect(posted).toHaveLength(2);
    const frame = posted[1];
    expect(frame.type).toBe('frame');
    if (frame.type !== 'frame') throw new Error('expected a frame response');
    expect(frame.generation).toBe(1);
    expect(frame.state.nowMs).toBe(2_000);
    expect(frame.reachedTarget).toBe(true);
    expect(frame.events).toEqual([]);
  });

  test('runs the same validation as decode: a corrupt snapshot maps to the underlying SimError code, never INTERNAL', async () => {
    const { post, posted } = await loadWorker();
    post({ type: 'start', generation: 1, input: labInput() });
    post({ type: 'import', generation: 1, text: 'not valid json' });

    expect(posted[1]).toMatchObject({ type: 'error', generation: 1, field: '$' });
    const error = posted[1];
    if (error.type !== 'error') throw new Error('expected an error response');
    expect(error.code).not.toBe('INTERNAL');
  });

  test('errors STALE_GENERATION for a generation the worker has never seen (no prior start)', async () => {
    const { post, posted } = await loadWorker();
    post({ type: 'import', generation: 1, text: snapshotAt(0) });
    expect(posted).toEqual([{ type: 'error', generation: 1, code: 'STALE_GENERATION', field: 'import' }]);
  });

  test('a request for a superseded (older) generation is dropped with no output', async () => {
    const { post, posted } = await loadWorker();
    post({ type: 'start', generation: 1, input: labInput() });
    post({ type: 'start', generation: 2, input: labInput() });
    expect(posted).toHaveLength(2);

    post({ type: 'import', generation: 1, text: snapshotAt(0) });
    expect(posted).toHaveLength(2);
  });
});

describe('experiment.worker: >1000-event PROTOCOL bound (R78)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('@narok/sim');
    vi.resetModules();
  });

  test('a batch exceeding 1000 domain events is rejected outright: error {code: PROTOCOL, field: events}, no frame, nothing committed or truncated', async () => {
    const oversizedBatch: DomainEvent[] = Array.from({ length: 1_001 }, (_, index) => ({
      seq: index,
      at: 2_000,
      encounter: 1,
      kind: 'damage',
      actorId: 'e0',
      targetId: 'p0',
      amount: 1,
      reason: null,
      position: null,
    }));

    // Stub only `createSimulation`'s `advance`, so the worker's own bound-check
    // is exercised against a batch real content/RNG cannot actually produce
    // within a single 25-scheduled-event work budget. Only the FIRST call is
    // inflated, so a follow-up call proves the worker's held state survived
    // the rejection uncorrupted rather than perpetually erroring.
    let inflateNextCall = true;
    vi.doMock('@narok/sim', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@narok/sim')>();
      return {
        ...actual,
        createSimulation: (boundContent: Parameters<typeof actual.createSimulation>[0], battlefield: Parameters<typeof actual.createSimulation>[1]) => {
          const real = actual.createSimulation(boundContent, battlefield);
          return {
            ...real,
            advance: (...args: Parameters<typeof real.advance>) => {
              const result = real.advance(...args);
              if (inflateNextCall) {
                inflateNextCall = false;
                return { ...result, events: oversizedBatch };
              }
              return result;
            },
          };
        },
      };
    });

    vi.resetModules(); // force a fresh module instance so `vi.doMock` above applies
    const posted: WorkerResponse[] = [];
    let handler: Handler | null = null;
    vi.stubGlobal('self', {
      postMessage: (message: WorkerResponse) => posted.push(message),
      set onmessage(next: Handler | null) {
        handler = next;
      },
      get onmessage() {
        return handler;
      },
    });
    await import('../src/experiment.worker');
    const post = (message: WorkerRequest): void => {
      if (!handler) throw new Error('worker module did not register self.onmessage');
      (handler as Handler)({ data: message } as MessageEvent<WorkerRequest>);
    };

    post({ type: 'start', generation: 1, input: labInput() });
    expect(posted[0]).toMatchObject({ type: 'frame', generation: 1 });

    post({ type: 'advance', generation: 1, untilMs: 2_000 });
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual({ type: 'error', generation: 1, code: 'PROTOCOL', field: 'events' });
    expect(posted.filter((message) => message.type === 'frame')).toHaveLength(1); // only start's frame

    // The rejected batch did not corrupt or replace the held state: the worker
    // is still usable for the same generation on the very next request (the
    // mock only inflates `events`, so this next call's own real `state`/
    // `reachedTarget` prove the worker kept operating on a valid prior state).
    post({ type: 'advance', generation: 1, untilMs: 2_000 });
    expect(posted).toHaveLength(3);
    expect(posted[2]).toMatchObject({ type: 'frame', generation: 1 });
  });
});
