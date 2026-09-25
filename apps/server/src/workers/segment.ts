/**
 * Running one segment of a hunt (milestone B spec part 2 §6, P-03, P-04).
 *
 * This is the only place the server advances simulated time, and it does three
 * things deliberately:
 *
 * - **It produces a candidate, never a commit.** No transaction, no database
 *   handle, nothing but an encoded result handed back to the caller, which
 *   decides whether the account still looks the way it did when this started
 *   (P-04, P-21). That is why a long run can sit outside the account lock.
 * - **It drains the work budget.** `advance` yields when it has done its
 *   allotted work; a continuation resumes against the *same absolute target*,
 *   so the split invariant holds for free rather than by arrangement
 *   (contracts §5, layer-1 §4.8).
 * - **It never chooses the collection mode for you.** `'events'` feeds
 *   playback; `'summary'` feeds offline settlement. Neither changes state, RNG
 *   use or rewards (layer-1 §4.8), and the caller says which it needs. The
 *   spec calls the first one "detailed"; the engine's own vocabulary is
 *   `'events'` and that is what travels, so there is one name for it in code.
 */
import type { AdvanceOptions, DomainEvent, Simulation, SimState, StopReason } from '@narok/sim';

export interface SegmentRequest {
  /** The engine's own encoding, exactly as it was stored. */
  readonly encodedState: string;
  /** Absolute simulated instant to advance to. */
  readonly simTarget: number;
  /** `'events'` for playback, `'summary'` for settlement. */
  readonly collect: 'events' | 'summary';
  /** Yield budget per `advance` call; a continuation resumes the same target. */
  readonly maxScheduledEvents?: number;
  /**
   * The per-job work bound. A segment that hits it returns a partial candidate
   * with `completion: 'capped'`; the caller commits that partial candidate and
   * queues the rest against the same absolute target, exactly as the engine's
   * own yield does one level down. Must be at least one.
   */
  readonly maxContinuations?: number;
}

export interface SegmentResult {
  /** The candidate, encoded. The caller commits it or discards it. */
  readonly encodedState: string;
  /** `'events'` mode only; summary collects none by design. */
  readonly events: DomainEvent[];
  /**
   * The only valid source for the next sim anchor. It equals `simTarget` only
   * when `completion` is `'target'`; an engine stop ends accrual earlier.
   */
  readonly simNowMs: number;
  readonly creditedSimMs: number;
  /**
   * Why the segment ended. `'stopped'` means the engine stopped the hunt on
   * its own (the engine then reports its target reached, because nothing more
   * can happen); `'capped'` means the work bound ran out first.
   */
  readonly completion: 'target' | 'stopped' | 'capped';
  readonly stopReason: StopReason | null;
  /** True for `'target'` and `'stopped'`: no further work toward this target. */
  readonly reachedTarget: boolean;
  /** How many `advance` calls it took. An operational signal, not a rule. */
  readonly continuations: number;
}

export class SegmentStalled extends Error {
  constructor(atMs: number, targetMs: number) {
    super(`segment made no progress at ${atMs} ms toward ${targetMs} ms`);
    this.name = 'SegmentStalled';
  }
}

const DEFAULT_MAX_CONTINUATIONS = 10_000;

/**
 * Advances a decoded state to `simTarget`, draining work-budget yields.
 *
 * Progress is checked the way `tools/balance`'s `drainSummary` checks it — by
 * simulated time *or* by events popped from the queue — so a budget that
 * cannot advance fails loudly instead of spinning.
 */
export function runSegment(sim: Simulation, request: SegmentRequest): SegmentResult {
  const limit = request.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`maxContinuations must be a positive integer, got ${limit}`);
  }

  const started = sim.decode(request.encodedState);
  const startedAt = started.nowMs;

  const options: AdvanceOptions = {
    collect: request.collect,
    ...(request.maxScheduledEvents === undefined ? {} : { maxScheduledEvents: request.maxScheduledEvents }),
  };

  let current: SimState = started;
  const events: DomainEvent[] = [];
  let continuations = 0;

  const finish = (completion: SegmentResult['completion']): SegmentResult => ({
    encodedState: sim.encode(current),
    events,
    simNowMs: current.nowMs,
    creditedSimMs: current.nowMs - startedAt,
    completion,
    stopReason: current.stopReason,
    reachedTarget: completion !== 'capped',
    continuations,
  });

  for (;;) {
    const beforeNowMs = current.nowMs;
    const beforePopped = current.nextQueueSeq - current.queue.length;

    const result = sim.advance(current, request.simTarget, options);
    current = result.state;
    continuations += 1;
    // A loop, not a spread: a large budget can yield more events than a call
    // accepts as arguments.
    for (const event of result.events) events.push(event);

    if (result.reachedTarget) return finish(current.phase === 'stopped' ? 'stopped' : 'target');

    const afterPopped = current.nextQueueSeq - current.queue.length;
    if (current.nowMs <= beforeNowMs && afterPopped <= beforePopped) {
      throw new SegmentStalled(current.nowMs, request.simTarget);
    }

    if (continuations >= limit) return finish('capped');
  }
}
