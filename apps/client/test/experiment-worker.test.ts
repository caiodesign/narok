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
import type { ActorId, LabInput, Strategy } from '@narok/sim';
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
    wipeLimit: 1,
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
