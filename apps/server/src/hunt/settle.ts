/**
 * Offline settlement (milestone B spec part 2 §3, layer-1 §4.6).
 *
 * `settle(envelope, nowWall, run)` is the quoted arithmetic, all integer
 * milliseconds, and nothing more:
 *
 *   capCutoffWall      = previousLastSeenAt + offlineCapMs
 *   eligibleCutoffWall = min(nowWall, capCutoffWall)
 *   simTarget          = simAnchorMs + (eligibleCutoffWall - wallAnchorMs) - pausedWallMs
 *   result             = advance(state, simTarget, { collect: 'summary' })
 *   creditedSimMs      = result.state.nowMs - state.nowMs
 *
 * It is pure over its inputs: the segment runner is a parameter, the input
 * envelope is never mutated, and the cap is the one **recorded in the
 * checkpoint**, never configuration's — so a later cap change cannot rewrite
 * settled history. The window arithmetic itself lives in `clock.ts`; this
 * module turns a window and an engine result into the next checkpoint, which
 * is the one place the lifecycle and the tests both go through.
 *
 * The caller owns the order around it — settle → commit → refresh presence →
 * re-anchor (layer-1 §4.4 step 2). The refreshed presence and the re-anchor
 * are *in* the returned envelope, so they reach the database in the same
 * transaction as the settlement or not at all; a failure before that commit
 * leaves the previous `lastSeenAt`, and with it the allowance, untouched
 * (B-L02).
 */
import type { DomainEvent, StopReason } from '@narok/sim';
import type { SegmentRequest, SegmentResult } from '../workers/segment';
import { reanchor, settlementWindow, stopWallInstant, type HuntAnchors, type SettlementWindow } from './clock';
import type { CheckpointEnvelope, PendingReward } from './envelope';
import { reconcileActivation } from './pending';
import { allocateRewards, drainRewards, rewardRoom } from './rewards';

/** Runs one segment. The lifecycle hands in its worker pool; a test hands in the engine or a stub. */
export type SegmentRunner = (request: SegmentRequest) => SegmentResult | Promise<SegmentResult>;

export interface SettleOptions {
  /**
   * Refresh presence. True for anything a live connection drives — connect,
   * heartbeat, a command, a cadence persist with a socket open — and false
   * for a settlement nobody is present for (part 2 §3's anchor table).
   */
  readonly live?: boolean;
  /** `'events'` when a connected client will be shown the window; otherwise summary. Never changes state. */
  readonly collect?: 'events' | 'summary';
  /** The account version this settlement will be committed against. */
  readonly accountStateVersion?: number;
  /** The carrier bound for this settlement; never above the envelope's own cap. */
  readonly rewardCap?: number;
}

export interface Settlement {
  /** The `state.nowMs` delta — never the requested horizon. */
  readonly creditedSimMs: number;
  readonly window: SettlementWindow;
  /** Presence before this settlement: the instant the cap was measured from. */
  readonly previousLastSeenAt: number;
  readonly completion: SegmentResult['completion'];
  /** An engine stop inside the window, placed on the wall with the **pre-settlement** anchors. */
  readonly stop: { readonly reason: StopReason; readonly atSimMs: number; readonly atWallMs: number } | null;
  /**
   * Wall time this settlement will never simulate (B-L03): after an engine
   * stop up to the eligible cutoff, and after the cap cutoff up to now. A
   * segment cut short leaves its remainder owed rather than uncovered.
   */
  readonly uncovered: { readonly afterStopMs: number; readonly afterCapMs: number };
  /** The next checkpoint: re-anchored, activation reconciled, carrier drained. */
  readonly envelope: CheckpointEnvelope;
  /** Drained from the carrier; the caller commits them with `envelope`, atomically. */
  readonly rewards: readonly PendingReward[];
  readonly events: readonly DomainEvent[];
  /** Whether a queued strategy became active inside this window. */
  readonly activated: boolean;
}

export function anchorsOf(envelope: CheckpointEnvelope): HuntAnchors {
  return {
    wallAnchorMs: envelope.wallAnchorMs,
    simAnchorMs: envelope.simAnchorMs,
    pausedWallMs: envelope.pausedWallMs,
    lastSeenAt: envelope.lastSeenAt,
    offlineCapMs: envelope.offlineCapMs,
  };
}

/**
 * The wall instant a settlement may use: never earlier than the checkpoint's
 * own anchor. A settlement stamped before another one committed (a command
 * waiting behind a heartbeat, a second process) must not rewind the anchor or
 * presence — re-anchoring backwards would let the next settlement credit the
 * same wall interval twice (B-17, B-18; ruling R120).
 */
export function effectiveWall(envelope: CheckpointEnvelope, nowWall: number): number {
  return Math.max(nowWall, envelope.wallAnchorMs);
}

/** The window and the engine request for a settlement at `nowWall`. */
export function settlementRequest(
  envelope: CheckpointEnvelope,
  nowWall: number,
  options: SettleOptions = {},
): { window: SettlementWindow; request: SegmentRequest } {
  const window = settlementWindow(anchorsOf(envelope), effectiveWall(envelope, nowWall));
  return {
    window,
    request: {
      encodedState: envelope.state,
      simTarget: window.simTarget,
      collect: options.collect ?? 'summary',
      rewardRoom: rewardRoom(envelope, options.rewardCap),
    },
  };
}

/**
 * The anchors after a settlement.
 *
 * A segment that covered its whole window (or that the engine stopped)
 * re-anchors to **now** and, for a live connection, refreshes presence. That
 * asymmetry — presence moves to now, not to the cutoff actually simulated —
 * is the mechanism: no residual is stored, so uncovered time is gone for good
 * and a duplicate settlement credits zero (B-L04, B-L05).
 *
 * One that fell short — cut by the work bound, by a full reward carrier, or a
 * coalesced result computed for an earlier instant than this caller's —
 * anchors at the wall instant it reached and leaves presence alone. Refreshing
 * presence there would re-base the cap on an unfinished settlement, and the
 * next one could then credit past it; re-anchoring to now would forfeit the
 * remainder instead of leaving it owed.
 */
function nextAnchors(
  anchors: HuntAnchors,
  nowWall: number,
  window: SettlementWindow,
  segment: SegmentResult,
  live: boolean,
): Pick<CheckpointEnvelope, 'wallAnchorMs' | 'simAnchorMs' | 'pausedWallMs' | 'lastSeenAt'> {
  if (isShort(window, segment)) {
    return {
      wallAnchorMs: stopWallInstant(anchors, segment.simNowMs),
      simAnchorMs: segment.simNowMs,
      pausedWallMs: 0,
      lastSeenAt: anchors.lastSeenAt,
    };
  }

  const settled = reanchor(anchors, nowWall, segment.simNowMs);
  return {
    wallAnchorMs: settled.wallAnchorMs,
    simAnchorMs: settled.simAnchorMs,
    pausedWallMs: settled.pausedWallMs,
    // Presence only ever moves forward.
    lastSeenAt: live ? Math.max(anchors.lastSeenAt, settled.lastSeenAt) : anchors.lastSeenAt,
  };
}

function isShort(window: SettlementWindow, segment: SegmentResult): boolean {
  return segment.completion !== 'stopped' && segment.simNowMs < window.simTarget;
}

/** Turns an engine result for `window` into the next checkpoint. Pure. */
export function applySegment(
  envelope: CheckpointEnvelope,
  requestedWall: number,
  window: SettlementWindow,
  segment: SegmentResult,
  options: SettleOptions = {},
): Settlement {
  const nowWall = effectiveWall(envelope, requestedWall);
  const anchors = anchorsOf(envelope);
  const short = isShort(window, segment);

  const stop =
    segment.completion === 'stopped' && segment.stopReason !== null
      ? {
          reason: segment.stopReason,
          atSimMs: segment.simNowMs,
          atWallMs: stopWallInstant(anchors, segment.simNowMs),
        }
      : null;

  const uncovered = short
    ? { afterStopMs: 0, afterCapMs: 0 }
    : {
        afterStopMs: stop === null ? 0 : Math.max(0, window.eligibleCutoffWall - stop.atWallMs),
        afterCapMs: window.cappedBy === 'cap' ? nowWall - window.capCutoffWall : 0,
      };

  const settled: CheckpointEnvelope = {
    ...envelope,
    checkpointSeq: envelope.checkpointSeq + 1,
    accountStateVersion: options.accountStateVersion ?? envelope.accountStateVersion,
    ...nextAnchors(anchors, nowWall, window, segment, options.live ?? true),
    stopContext:
      stop === null
        ? envelope.stopContext
        : {
            ...stop,
            // The owner's travel rule is for the player's stop; an engine stop
            // found by a settlement has long since been overtaken by the clock.
            inTownAtWallMs: stop.atWallMs,
          },
    state: segment.encodedState,
  };

  const activated = envelope.pendingStrategy !== null && !segment.pendingRulesQueued;
  const withRewards = allocateRewards(reconcileActivation(settled, segment.pendingRulesQueued), segment.rewards);
  const { envelope: drained, drained: rewards } = drainRewards(withRewards);

  return {
    creditedSimMs: segment.creditedSimMs,
    window,
    previousLastSeenAt: envelope.lastSeenAt,
    completion: segment.completion,
    stop,
    uncovered,
    envelope: drained,
    rewards,
    events: segment.events,
    activated,
  };
}

/** Settles `envelope` to `nowWall` with `run`. See the module comment. */
export async function settle(
  envelope: CheckpointEnvelope,
  nowWall: number,
  run: SegmentRunner,
  options: SettleOptions = {},
): Promise<Settlement> {
  const { window, request } = settlementRequest(envelope, nowWall, options);
  const segment = await run(request);
  return applySegment(envelope, nowWall, window, segment, options);
}

/**
 * Resumes a hunt after maintenance downtime (part 2 §7 step 5, §9 #10; P-31;
 * ruling R119). The checkpoint must already be settled to the freeze cutoff —
 * anchored at it — under the old artifacts. Downtime is then an explicit
 * pause: the wall anchor jumps to the resume instant so the outage is never
 * simulated, and `lastSeenAt` advances by the downtime so an operator outage
 * does not bill the player's offline allowance. One recorded adjustment on one
 * field; nothing is simulated retroactively.
 */
export function resumeAfterMaintenance(
  envelope: CheckpointEnvelope,
  cutoffWall: number,
  resumeWall: number,
): CheckpointEnvelope {
  if (resumeWall < cutoffWall) {
    throw new RangeError(`resume ${resumeWall} precedes the maintenance cutoff ${cutoffWall}`);
  }
  if (envelope.wallAnchorMs !== cutoffWall) {
    throw new RangeError('the checkpoint must be settled to the maintenance cutoff before it resumes');
  }
  return {
    ...envelope,
    wallAnchorMs: resumeWall,
    pausedWallMs: 0,
    lastSeenAt: envelope.lastSeenAt + (resumeWall - cutoffWall),
  };
}
