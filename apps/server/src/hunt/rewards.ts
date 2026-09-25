/**
 * The reward carrier (milestone B spec part 2 §2, §6, §9 #2, #3, #8; ruling
 * R117).
 *
 * Three rules, each one the reason a retried or re-simulated commit is safe:
 *
 * - **Rewards are read from state, never from the returned events.** Summary
 *   collection returns no events at all, so a source that read them would
 *   credit an offline settlement nothing. A {@link RewardSource} is handed the
 *   state before and after each engine step and nothing else.
 * - **Ids are allocated inside the transition.** `"<huntId>:<rewardSeq>"`,
 *   numbered from the checkpoint's own `rewardSeq` — no UUID, no database
 *   sequence — so re-simulating a segment from the same checkpoint reproduces
 *   the same rewards with the same ids (B-L07).
 * - **The carrier is bounded, and its bound forces a commit.** Reaching
 *   {@link REWARD_CARRIER_CAP} ends the segment early and commits it, exactly
 *   as the work budget forces a yield; the rest of the window is settled next,
 *   against the same absolute target. Nothing is dropped or altered.
 *
 * The engine emits no reward record yet (drops arrive with task 6), so the
 * production source is {@link NO_REWARDS}. The carrier is built and exercised
 * now so task 6 plugs a source into it rather than inventing a second path.
 */
import type { SimState } from '@narok/sim';
import type { Tx } from '../db/tx';
import { REWARD_CARRIER_CAP, rewardIdFor, type CheckpointEnvelope, type PendingReward } from './envelope';

/** A reward before its id: what a source reads off two consecutive states. */
export interface RewardDraft {
  readonly atSimMs: number;
  readonly kind: PendingReward['kind'];
  readonly payload: Record<string, unknown>;
}

/**
 * Reads the rewards one engine step produced from the states on either side of
 * it. Must be a pure function of its two arguments: it runs inside the segment
 * worker, and a replay must see exactly what the first run saw.
 */
export type RewardSource = (before: SimState, after: SimState) => readonly RewardDraft[];

/** Today's production source: the engine accrues no reward record before task 6. */
export const NO_REWARDS: RewardSource = () => [];

/**
 * Writes drained rewards to their canonical tables inside the commit
 * transaction, so a reward exists only together with the checkpoint that
 * produced it (P-27). Absent until a reward has somewhere to go.
 */
export type RewardSink = (
  tx: Tx,
  accountId: string,
  rewards: readonly PendingReward[],
  stateVersionAfter: number,
) => Promise<void>;

export class RewardCarrierFull extends Error {
  constructor(held: number, adding: number) {
    super(`the reward carrier holds ${held} and cannot take ${adding} more`);
    this.name = 'RewardCarrierFull';
  }
}

/** Room left in the carrier. */
export function rewardRoom(envelope: CheckpointEnvelope, cap: number = REWARD_CARRIER_CAP): number {
  return Math.max(0, Math.min(cap, REWARD_CARRIER_CAP) - envelope.pendingRewards.length);
}

/**
 * Appends `drafts` to the carrier, allocating each id from `rewardSeq` in
 * order. Refuses outright rather than truncating when they would not fit; the
 * segment runner never asks it to, because it stops at the cap first.
 */
export function allocateRewards(envelope: CheckpointEnvelope, drafts: readonly RewardDraft[]): CheckpointEnvelope {
  if (drafts.length === 0) return envelope;
  if (envelope.pendingRewards.length + drafts.length > REWARD_CARRIER_CAP) {
    throw new RewardCarrierFull(envelope.pendingRewards.length, drafts.length);
  }

  const allocated = drafts.map(
    (draft, index): PendingReward => ({
      rewardId: rewardIdFor(envelope.huntId, envelope.rewardSeq + index),
      atSimMs: draft.atSimMs,
      kind: draft.kind,
      payload: structuredClone(draft.payload),
    }),
  );
  return {
    ...envelope,
    rewardSeq: envelope.rewardSeq + drafts.length,
    pendingRewards: [...envelope.pendingRewards, ...allocated],
  };
}

/** Empties the carrier for a commit; `rewardSeq` keeps counting across drains. */
export function drainRewards(envelope: CheckpointEnvelope): {
  envelope: CheckpointEnvelope;
  drained: PendingReward[];
} {
  return { envelope: { ...envelope, pendingRewards: [] }, drained: envelope.pendingRewards };
}
