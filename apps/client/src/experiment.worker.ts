/**
 * The laboratory's dedicated worker (contract §7, ruling R52). Builds its
 * `Simulation` once at module scope, the same way `packages/sim/test/fixtures.ts`'s
 * `lab()` helper does, and holds at most one `SimState`.
 *
 * Generation protocol: `generation` is owned by the hook and only ever increases.
 * `start` is how the worker learns of a new generation. A request older than the
 * generation the worker has already started is dropped with no output (its
 * requester no longer exists). A non-`start` request naming a generation the
 * worker has never started, or an `advance`/`stop`/`export` with no experiment
 * loaded, is a protocol bug and gets `error {code: 'STALE_GENERATION'}`.
 */
import { content, validateContent } from '@narok/data';
import { createGrid, createSimulation, SimError } from '@narok/sim';
import type { SimState } from '@narok/sim';
import type { WorkerErrorCode, WorkerRequest, WorkerResponse } from './worker-contract';

/**
 * Precise local typing for the worker's own global scope, standing in for the
 * `webworker` lib (which cannot be combined with the repo's shared `dom` lib).
 * Shadows the ambient `self`/`postMessage` only within this module.
 */
declare const self: {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const validated = validateContent(content);
const sim = createSimulation(validated, createGrid(validated.grid, validated.shapes));

let state: SimState | null = null;
let generation = 0;

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

function postError(requestGeneration: number, code: WorkerErrorCode, field: string): void {
  post({ type: 'error', generation: requestGeneration, code, field });
}

/** Maps an exception raised beneath the worker to a bounded `{code, field}` pair. Never posts an `Error` object, a stack trace, or a message built from untrusted input. */
function toWorkerError(error: unknown, field: string): { code: WorkerErrorCode; field: string } {
  if (error instanceof SimError) return { code: error.code, field: error.field };
  return { code: 'INTERNAL', field };
}

self.onmessage = (event) => {
  const request = event.data;

  if (request.generation < generation) return;

  if (request.type === 'start') {
    generation = request.generation;
    try {
      const next = sim.start(request.input);
      state = next;
      post({
        type: 'frame',
        generation: request.generation,
        state: sim.project(next),
        events: [],
        reachedTarget: true,
      });
    } catch (error) {
      state = null;
      const mapped = toWorkerError(error, 'start');
      postError(request.generation, mapped.code, mapped.field);
    }
    return;
  }

  if (request.generation > generation) {
    postError(request.generation, 'STALE_GENERATION', request.type);
    return;
  }

  if ((request.type === 'advance' || request.type === 'stop' || request.type === 'export') && state === null) {
    postError(request.generation, 'STALE_GENERATION', request.type);
    return;
  }

  if (request.type === 'advance') {
    try {
      const result = sim.advance(state as SimState, request.untilMs, { maxScheduledEvents: 25 });
      if (result.events.length > 1000) {
        // Events are never dropped or truncated to fit the bound; the whole batch
        // (and any state it would have produced) is rejected instead.
        postError(request.generation, 'PROTOCOL', 'events');
        return;
      }
      state = result.state;
      post({
        type: 'frame',
        generation: request.generation,
        state: sim.project(state),
        events: result.events,
        reachedTarget: result.reachedTarget,
      });
    } catch (error) {
      const mapped = toWorkerError(error, 'advance');
      postError(request.generation, mapped.code, mapped.field);
    }
    return;
  }

  if (request.type === 'stop') {
    try {
      state = sim.stop(state as SimState);
      post({
        type: 'frame',
        generation: request.generation,
        state: sim.project(state),
        events: [],
        reachedTarget: true,
      });
    } catch (error) {
      const mapped = toWorkerError(error, 'stop');
      postError(request.generation, mapped.code, mapped.field);
    }
    return;
  }

  if (request.type === 'export') {
    try {
      post({ type: 'snapshot', generation: request.generation, text: sim.encode(state as SimState) });
    } catch (error) {
      const mapped = toWorkerError(error, 'export');
      postError(request.generation, mapped.code, mapped.field);
    }
    return;
  }

  if (request.type === 'import') {
    try {
      const next = sim.decode(request.text);
      state = next;
      post({
        type: 'frame',
        generation: request.generation,
        state: sim.project(next),
        events: [],
        reachedTarget: true,
      });
    } catch (error) {
      const mapped = toWorkerError(error, 'import');
      postError(request.generation, mapped.code, mapped.field);
    }
    return;
  }
};
