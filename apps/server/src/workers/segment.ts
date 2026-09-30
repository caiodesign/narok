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
import {
  takeDispositionedRewards,
  type AdvanceOptions,
  type DomainEvent,
  type PendingReward,
  type Simulation,
  type SimState,
  type StopReason,
} from '@narok/sim';
import { REWARD_CARRIER_CAP } from '../hunt/envelope';

/** The engine's own default work budget (contracts §5); halved only to fit the reward carrier. */
const ENGINE_DEFAULT_BUDGET = 10_000;

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
  /**
   * How many rewards the carrier can still take (part 2 §9 #8). Reaching it
   * ends the segment with `completion: 'reward-cap'` so the caller commits
   * and continues — never by dropping a reward. Defaults to the full carrier.
   */
  readonly rewardRoom?: number;
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
  readonly completion: 'target' | 'stopped' | 'capped' | 'reward-cap';
  readonly stopReason: StopReason | null;
  /** True for `'target'` and `'stopped'`: no further work toward this target. */
  readonly reachedTarget: boolean;
  /** How many `advance` calls it took. An operational signal, not a rule. */
  readonly continuations: number;
  /**
   * The dispositioned rewards drained off the states this segment passed
   * through, in `rewardSeq` order (R132); ids come later. The candidate state
   * no longer carries them.
   */
  readonly rewards: readonly PendingReward[];
  /** Whether a queued strategy is still waiting for a spawn at the segment's end (R115). */
  readonly pendingRulesQueued: boolean;
  /** Whether an applied loot filter is still waiting for earlier drops to settle (R131). */
  readonly pendingLootQueued: boolean;
}

export class RewardCarrierStalled extends Error {
  constructor(atMs: number) {
    super(`one engine step at ${atMs} ms yields more rewards than an empty carrier holds`);
    this.name = 'RewardCarrierStalled';
  }
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
  const room = request.rewardRoom ?? REWARD_CARRIER_CAP;
  if (!Number.isSafeInteger(room) || room < 0) {
    throw new RangeError(`rewardRoom must be a non-negative integer, got ${room}`);
  }

  const started = sim.decode(request.encodedState);
  const startedAt = started.nowMs;
  const fullBudget = request.maxScheduledEvents ?? ENGINE_DEFAULT_BUDGET;

  let current: SimState = started;
  const events: DomainEvent[] = [];
  const rewards: PendingReward[] = [];
  let continuations = 0;

  const finish = (completion: SegmentResult['completion']): SegmentResult => ({
    encodedState: sim.encode(current),
    events,
    simNowMs: current.nowMs,
    creditedSimMs: current.nowMs - startedAt,
    completion,
    stopReason: current.stopReason,
    reachedTarget: completion === 'target' || completion === 'stopped',
    continuations,
    rewards,
    pendingRulesQueued: current.pendingRules !== null,
    pendingLootQueued: current.pendingLoot.length > 0,
  });

  let budget = fullBudget;
  for (;;) {
    const beforeNowMs = current.nowMs;
    const beforePopped = current.nextQueueSeq - current.queue.length;

    const options: AdvanceOptions = { collect: request.collect, maxScheduledEvents: budget };
    const result = sim.advance(current, request.simTarget, options);

    // Rewards are read from the state the step produced, never from its events
    // (part 2 §6): the dispositioned ones are drained off it. A step that would
    // overfill the carrier is discarded and retried smaller from the same
    // state — the split invariant makes that free — until it fits, or ends the
    // segment for a commit.
    const drained = takeDispositionedRewards(result.state);
    if (rewards.length + drained.rewards.length > room) {
      if (budget > 1) {
        budget = Math.ceil(budget / 2);
        continue;
      }
      if (rewards.length === 0) throw new RewardCarrierStalled(current.nowMs);
      return finish('reward-cap');
    }
    budget = fullBudget;
    continuations += 1;

    current = drained.state;
    // A loop, not a spread: a large budget can yield more events than a call
    // accepts as arguments.
    for (const event of result.events) events.push(event);
    for (const reward of drained.rewards) rewards.push(reward);

    if (result.reachedTarget) return finish(current.phase === 'stopped' ? 'stopped' : 'target');

    const afterPopped = current.nextQueueSeq - current.queue.length;
    if (current.nowMs <= beforeNowMs && afterPopped <= beforePopped) {
      throw new SegmentStalled(current.nowMs, request.simTarget);
    }

    if (continuations >= limit) return finish('capped');
  }
}
