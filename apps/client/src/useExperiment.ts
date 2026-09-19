/**
 * Owns generation, worker, playback clock, pause/resume/stop, and the two
 * comparison summary slots (ruling R54, contract §7 / milestone spec §11).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DomainEvent, LabInput, Metrics, PublicState, StopReason } from '@narok/sim';
import { horizon, reanchor, type PlaybackClock } from './clock';
import type { WorkerRequest, WorkerResponse } from './worker-contract';

export type ExperimentStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'error';

/** Produced when a run completes or is stopped, for the retained comparison slots. */
export interface Summary {
  label: string;
  input: LabInput;
  nowMs: number;
  stopReason: StopReason | null;
  metrics: Metrics;
  /**
   * The exact projection the run ended on. `Comparison.tsx` takes
   * `{input, state: PublicState}` pairs (contract §7), so retaining the real
   * frame keeps every reported figure measured rather than reconstructed.
   */
  state: PublicState;
}

/** Injectable real-time source and frame scheduler (ruling R53) — every test drives this by hand. */
export interface ClockDriver {
  now: () => number;
  schedule: (callback: () => void) => number;
  cancel: (handle: number) => void;
}

const DEFAULT_DRIVER: ClockDriver = {
  now: () => performance.now(),
  schedule: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * The subset of the `Worker` API the hook depends on. Lets tests substitute a
 * hand-written fake implementing `worker-contract.ts`'s message union instead of
 * a real thread (ruling R56), while production uses a real `Worker` unmodified.
 */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

function createRealWorker(): WorkerLike {
  return new Worker(new URL('./experiment.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

const EVENT_HISTORY_LIMIT = 500;
const BUFFER_MS = 2000;
const ALLOWED_SPEEDS = new Set([1, 4, 16]);

/**
 * Ruling R79: the outstanding-request marker is tied to request identity
 * (generation, plus the target for an advance) rather than a bare boolean, and
 * `stop` participates in it — so a frame only clears the marker (and only
 * decides what to send next) for the request it actually answers.
 */
type PendingRequest =
  | { kind: 'start'; generation: number }
  | { kind: 'advance'; generation: number; untilMs: number }
  | { kind: 'stop'; generation: number };

export interface UseExperimentOptions {
  driver?: ClockDriver;
  createWorker?: () => WorkerLike;
}

export interface UseExperimentResult {
  state: PublicState | null;
  events: DomainEvent[];
  status: ExperimentStatus;
  comparisonA: Summary | null;
  comparisonB: Summary | null;
  start: (input: LabInput) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  setSpeed: (speed: number) => void;
}

export function useExperiment(options: UseExperimentOptions = {}): UseExperimentResult {
  const driver = options.driver ?? DEFAULT_DRIVER;
  const createWorker = options.createWorker ?? createRealWorker;

  const [state, setState] = useState<PublicState | null>(null);
  const [events, setEvents] = useState<DomainEvent[]>([]);
  const [status, setStatus] = useState<ExperimentStatus>('idle');
  const [comparisonA, setComparisonA] = useState<Summary | null>(null);
  const [comparisonB, setComparisonB] = useState<Summary | null>(null);

  const workerRef = useRef<WorkerLike | null>(null);
  const generationRef = useRef(0);
  const inputRef = useRef<LabInput | null>(null);
  const pendingRef = useRef<PendingRequest | null>(null);
  const stopRequestedRef = useRef(false);
  const lastRequestedRef = useRef(0);
  const clockRef = useRef<PlaybackClock>({
    realAnchorMs: 0,
    simAnchorMs: 0,
    speed: 1,
    paused: true,
    bufferMs: BUFFER_MS,
  });
  const statusRef = useRef<ExperimentStatus>('idle');
  const finalizedRef = useRef<Set<number>>(new Set());
  const comparisonBRef = useRef<Summary | null>(null);
  const scheduleHandleRef = useRef<number | null>(null);

  const setStatusBoth = useCallback((next: ExperimentStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const pushSummary = useCallback((summary: Summary) => {
    const previousB = comparisonBRef.current;
    comparisonBRef.current = summary;
    setComparisonA(previousB);
    setComparisonB(summary);
  }, []);

  const teardownWorker = useCallback(() => {
    const worker = workerRef.current;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
    workerRef.current = null;
  }, []);

  const sendAdvance = useCallback((target: number) => {
    const worker = workerRef.current;
    if (!worker) return;
    lastRequestedRef.current = target;
    pendingRef.current = { kind: 'advance', generation: generationRef.current, untilMs: target };
    worker.postMessage({ type: 'advance', generation: generationRef.current, untilMs: target });
  }, []);

  const sendStopNow = useCallback(() => {
    const worker = workerRef.current;
    if (!worker) return;
    stopRequestedRef.current = false;
    pendingRef.current = { kind: 'stop', generation: generationRef.current };
    worker.postMessage({ type: 'stop', generation: generationRef.current });
  }, []);

  const handleMessage = useCallback(
    (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      // A response for a generation this hook no longer owns (e.g. delayed after a
      // new `start`) is discarded — applying it would mutate the wrong run.
      if (message.generation !== generationRef.current) return;

      if (message.type === 'error') {
        pendingRef.current = null;
        stopRequestedRef.current = false;
        setStatusBoth('error');
        return;
      }

      if (message.type === 'snapshot') {
        // export/import are not part of Task 9's hook surface (no UI action posts
        // `export`), so a snapshot response is simply not expected here.
        return;
      }

      // Consume the frame first (state, events, metrics) regardless of whether
      // it answers something this hook is currently tracking as pending — the
      // data is real and current for this generation either way.
      setState(message.state);
      setEvents((previous) => {
        const merged = previous.concat(message.events);
        return merged.length > EVENT_HISTORY_LIMIT ? merged.slice(merged.length - EVENT_HISTORY_LIMIT) : merged;
      });

      // Ruling R79: only clear the pending marker — and only decide what to
      // send next — for the request this frame actually answers. An unexpected
      // frame (nothing currently tracked as pending) is applied above but
      // otherwise ignored: this hook never issued the request that produced it,
      // so it has no outstanding intent to reconcile.
      const pending = pendingRef.current;
      if (pending === null) return;
      pendingRef.current = null;

      const terminal = message.state.phase === 'stopped' || message.state.stopReason !== null;
      if (terminal) {
        const generation = generationRef.current;
        if (!finalizedRef.current.has(generation) && inputRef.current) {
          finalizedRef.current.add(generation);
          pushSummary({
            label: `Run ${generation}`,
            input: inputRef.current,
            nowMs: message.state.nowMs,
            stopReason: message.state.stopReason,
            metrics: message.state.metrics,
            state: message.state,
          });
        }
        stopRequestedRef.current = false;
        setStatusBoth('stopped');
        return;
      }

      // A stop requested while this request was in flight takes priority over
      // continuing to chase an advance target.
      if (stopRequestedRef.current) {
        sendStopNow();
        return;
      }

      if (pending.kind === 'advance' && !message.reachedTarget) {
        sendAdvance(lastRequestedRef.current);
      }
    },
    [pushSummary, sendAdvance, sendStopNow, setStatusBoth],
  );

  const tick = useCallback(() => {
    if (statusRef.current === 'running' && pendingRef.current === null) {
      const target = Math.max(horizon(clockRef.current, driver.now()), lastRequestedRef.current);
      if (target > lastRequestedRef.current) {
        sendAdvance(target);
      }
    }
    scheduleHandleRef.current = driver.schedule(tick);
  }, [driver, sendAdvance]);

  useEffect(() => {
    scheduleHandleRef.current = driver.schedule(tick);
    return () => {
      teardownWorker();
      if (scheduleHandleRef.current !== null) {
        driver.cancel(scheduleHandleRef.current);
        scheduleHandleRef.current = null;
      }
    };
  }, [driver, tick, teardownWorker]);

  const start = useCallback(
    (input: LabInput) => {
      teardownWorker();
      const worker = createWorker();
      worker.onmessage = handleMessage;
      worker.onerror = () => {
        pendingRef.current = null;
        stopRequestedRef.current = false;
        setStatusBoth('error');
      };
      workerRef.current = worker;

      generationRef.current += 1;
      const generation = generationRef.current;
      inputRef.current = input;
      lastRequestedRef.current = 0;
      stopRequestedRef.current = false;
      pendingRef.current = { kind: 'start', generation };
      clockRef.current = {
        realAnchorMs: driver.now(),
        simAnchorMs: 0,
        speed: 1,
        paused: false,
        bufferMs: BUFFER_MS,
      };
      setState(null);
      setEvents([]);
      setStatusBoth('running');
      worker.postMessage({ type: 'start', generation, input });
    },
    [createWorker, driver, handleMessage, setStatusBoth, teardownWorker],
  );

  const pause = useCallback(() => {
    if (statusRef.current !== 'running') return;
    clockRef.current = reanchor(clockRef.current, driver.now(), { paused: true });
    setStatusBoth('paused');
  }, [driver, setStatusBoth]);

  const resume = useCallback(() => {
    if (statusRef.current !== 'paused') return;
    clockRef.current = reanchor(clockRef.current, driver.now(), { paused: false });
    setStatusBoth('running');
  }, [driver, setStatusBoth]);

  const stop = useCallback(() => {
    if (!workerRef.current) return;
    if (statusRef.current === 'idle' || statusRef.current === 'stopped') return;
    // Ruling R79: stop participates in the same single-outstanding-request
    // marker as advance. If something is already in flight, defer — the
    // deferred stop fires as soon as that request's own frame is consumed,
    // taking priority over resending an incomplete advance.
    if (pendingRef.current === null) {
      sendStopNow();
    } else {
      stopRequestedRef.current = true;
    }
  }, [sendStopNow]);

  const setSpeed = useCallback(
    (speed: number) => {
      if (!ALLOWED_SPEEDS.has(speed)) return;
      clockRef.current = reanchor(clockRef.current, driver.now(), { speed });
    },
    [driver],
  );

  return { state, events, status, comparisonA, comparisonB, start, pause, resume, stop, setSpeed };
}
