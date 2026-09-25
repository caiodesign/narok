/**
 * Scheduling segments per account (milestone B spec part 2 §6, P-24).
 *
 * The rule this module exists for: **one account, one job in flight.** Ten
 * tabs reconnecting at once must not queue ten settlements of the same window,
 * each of which would lose the version race to the first and be discarded
 * (P-21). They share one job and one result instead.
 *
 * The executor is a seam, not a decision. The default runs the segment on the
 * calling thread; moving it behind `worker_threads` changes where the work
 * happens and nothing about what it produces, because `runSegment` is a pure
 * function of its request (P-03). The coalescing is the part with a contract,
 * and it lives here either way.
 */
import type { Simulation } from '@narok/sim';
import { NO_REWARDS, type RewardSource } from '../hunt/rewards';
import { runSegment, type SegmentRequest, type SegmentResult } from './segment';

export type SegmentExecutor = (request: SegmentRequest) => Promise<SegmentResult>;

/**
 * `source` reads rewards off the engine's states; it runs where the segment
 * runs, so a worker executor is handed it at construction, never per request.
 */
export function inlineExecutor(sim: Simulation, source: RewardSource = NO_REWARDS): SegmentExecutor {
  // A microtask boundary, so a caller can never observe the result before its
  // own `await` — the same ordering a real worker gives.
  return async (request) => {
    await Promise.resolve();
    return runSegment(sim, request, source);
  };
}

export class SegmentPool {
  private readonly inFlight = new Map<string, Promise<SegmentResult>>();

  constructor(private readonly executor: SegmentExecutor) {}

  /**
   * Runs `request` for `accountId`, or joins the job already running for it.
   *
   * A joiner receives the in-flight job's result even though its own request
   * may name a slightly later target. That is deliberate: every result is only
   * a candidate, and whoever commits it re-checks the account version, so the
   * worst a joiner sees is a settlement a few milliseconds short — the next
   * heartbeat settles the rest.
   */
  run(accountId: string, request: SegmentRequest): Promise<SegmentResult> {
    const existing = this.inFlight.get(accountId);
    if (existing !== undefined) return existing;

    const job = this.executor(request).finally(() => {
      this.inFlight.delete(accountId);
    });
    this.inFlight.set(accountId, job);
    return job;
  }

  /** Jobs currently running. An operational signal for tests and metrics. */
  get size(): number {
    return this.inFlight.size;
  }
}
