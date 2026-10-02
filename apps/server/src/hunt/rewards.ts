/**
 * The reward carrier (milestone B spec part 2 §2, §6, §9 #2, #3, #8; part 3
 * §2, §3.4; rulings R117, R127, R128, R132).
 *
 * Three rules, each one the reason a retried or re-simulated commit is safe:
 *
 * - **Rewards are read from state, never from the returned events.** Summary
 *   collection returns no events at all, so reading them would credit an
 *   offline settlement nothing. The engine state carries every rolled drop
 *   with its disposition (`state.pendingRewards`), and the segment runner
 *   drains the dispositioned ones off the states it passes through.
 * - **Ids are allocated inside the transition.** `"<huntId>:<rewardSeq>"`,
 *   the ordinal numbered by the engine from the checkpoint's own
 *   `state.nextRewardSeq` — no UUID, no database sequence — so re-simulating
 *   a segment from the same checkpoint reproduces the same rewards with the
 *   same ids (B-L07), and `items`' unique source index refuses a second credit.
 * - **The carrier is bounded, and its bound forces a commit.** Reaching
 *   {@link REWARD_CARRIER_CAP} ends the segment early and commits it, exactly
 *   as the work budget forces a yield; the rest of the window is settled next,
 *   against the same absolute target. Nothing is dropped or altered.
 *
 * One source of truth: the engine state inside the checkpoint. The envelope
 * duplicates none of it, and `account_drop_protection` is an index of the
 * committed counters, rewritten from them in every commit's transaction.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Content } from '@narok/data';
import type { DropProtection, PendingReward, SimState } from '@narok/sim';
import * as schema from '../db/schema';
import type { Database, Tx } from '../db/tx';
import { rewardIdFor, type CheckpointEnvelope, type PresetRef } from './envelope';
import { lootVersionFor } from './pending';

/** A dispositioned reward with its reproducible id: what a commit credits. */
export interface HuntReward extends PendingReward {
  readonly rewardId: string;
  readonly disposition: NonNullable<PendingReward['disposition']>;
  /** The loot preset version whose window the reward was rolled in (R131). */
  readonly lootPreset: PresetRef;
}

/**
 * Names drained rewards within their hunt's namespace, and records which loot
 * preset version governed each, from the checkpoint the settlement started from.
 */
export function identifyRewards(from: CheckpointEnvelope, rewards: readonly PendingReward[]): HuntReward[] {
  return rewards.map((reward) => {
    if (reward.disposition === null) throw new RangeError(`reward ${reward.rewardSeq} has no disposition yet`);
    return {
      ...structuredClone(reward),
      disposition: structuredClone(reward.disposition),
      rewardId: rewardIdFor(from.huntId, reward.rewardSeq),
      lootPreset: lootVersionFor(from, reward.rewardSeq),
    };
  });
}

/** What a sink needs besides the rewards: whose, and under which pinned content. */
export interface RewardCommit {
  readonly accountId: string;
  readonly stateVersionAfter: number;
  /** The hunt's pinned content, which an item instance resolves its definition under (B-29). */
  readonly contentVersion: string;
  /** That content itself: a kept item's handedness is copied from it (ruling R145). */
  readonly content: Content;
}

/**
 * Writes drained rewards to their canonical tables inside the commit
 * transaction, so a reward exists only together with the checkpoint that
 * produced it (P-27).
 */
export type RewardSink = (tx: Tx, rewards: readonly HuntReward[], commit: RewardCommit) => Promise<void>;

/**
 * The production sink (part 3 §3.3, §3.4; ruling R132). Every reward leaves one
 * trace keyed by its id:
 *
 * - **kept** equipment becomes an `items` row, its `source_ref` the reward id
 *   (unique per account) and `protected` set at acquisition for a protected
 *   rarity; a kept consumable adds to its stack;
 * - **auto-sold** is audited and credits nothing: prices are deferred, so an
 *   auto-sold item is counted, not priced (spec §4.0);
 * - **lost** — a Keep the full bag could not hold — is audited as
 *   `overflow-lost`, and nothing is added later (UI spec §6, §8);
 * - **ignored** leaves the audit row of its disposition only.
 */
export const commitRewards: RewardSink = async (tx, rewards, commit) => {
  for (const reward of rewards) {
    const { item, disposition } = reward;
    const itemDelta = item.kind === 'equipment'
      ? { definitionId: item.definitionId, rarity: item.rarity, itemLevel: reward.itemLevel, bonuses: item.bonuses }
      : { consumableId: item.consumableId, quantity: item.quantity };

    if (disposition.outcome === 'kept' && item.kind === 'equipment') {
      await tx.insert(schema.items).values({
        accountId: commit.accountId,
        baseItemId: item.definitionId,
        baseContentVersion: commit.contentVersion,
        rarity: item.rarity,
        itemLevel: reward.itemLevel,
        bonuses: item.bonuses,
        protected: disposition.matched === 'protected',
        sourceRef: reward.rewardId,
        twoHanded: commit.content.items[item.definitionId]?.handedness === 'two-handed',
      });
    } else if (disposition.outcome === 'kept' && item.kind === 'consumable') {
      // One total per consumable (ruling R137): past 999 it is several stacks,
      // each taking a slot, never a refused commit.
      await tx
        .insert(schema.stackItems)
        .values({ accountId: commit.accountId, definitionId: item.consumableId, quantity: item.quantity })
        .onConflictDoUpdate({
          target: [schema.stackItems.accountId, schema.stackItems.definitionId],
          set: { quantity: sql`${schema.stackItems.quantity} + ${item.quantity}` },
        });
    }

    await tx.insert(schema.resourceAudit).values({
      accountId: commit.accountId,
      reason: AUDIT_REASON[disposition.outcome],
      sourceRef: reward.rewardId,
      delta: {
        item: itemDelta, action: disposition.action, matched: disposition.matched, lootPreset: reward.lootPreset, gold: 0,
      },
      stateVersionAfter: commit.stateVersionAfter,
    });
  }
};

/** Units of each consumable spent between two committed states (ruling R152). */
export function consumedDuring(before: SimState, after: SimState): Record<string, number> {
  const spent: Record<string, number> = {};
  for (const id of Object.keys(after.metrics.consumed).sort()) {
    const units = after.metrics.consumed[id]! - (before.metrics.consumed[id] ?? 0);
    if (units > 0) spent[id] = units;
  }
  return spent;
}

/**
 * Takes what the engine spent from the bag off the account's stacks, in the
 * commit that settles it (ruling R152): `consumed` is the increase of the
 * engine's cumulative `metrics.consumed` across the committed span, so a
 * span is debited exactly once, as its drops are credited exactly once. One
 * audit row records the span's spending under `sourceRef`.
 */
export async function commitConsumption(
  tx: Tx,
  accountId: string,
  consumed: Readonly<Record<string, number>>,
  sourceRef: string,
  stateVersionAfter: number,
): Promise<void> {
  const ids = Object.keys(consumed).sort();
  if (ids.length === 0) return;
  for (const definitionId of ids) {
    // The stack held at least this much when the hunt started; the check
    // constraint refuses a negative total rather than clamping it. A stack
    // that reaches 0 keeps its row, as `persistBag` writes a 0 total:
    // `loadBag` skips non-positive totals, so the bag, the engine's bag state
    // and the town inventory view never list an empty stack.
    const updated = await tx
      .update(schema.stackItems)
      .set({ quantity: sql`${schema.stackItems.quantity} - ${consumed[definitionId]!}` })
      .where(and(eq(schema.stackItems.accountId, accountId), eq(schema.stackItems.definitionId, definitionId)))
      .returning({ quantity: schema.stackItems.quantity });
    // The engine only spends what the account's stack gave it, so a missing
    // row is a broken invariant: fail the commit rather than debit nothing.
    if (updated.length !== 1) {
      throw new Error(`commitConsumption: account ${accountId} has no ${definitionId} stack to take ${consumed[definitionId]!} from`);
    }
  }
  await tx.insert(schema.resourceAudit).values({
    accountId, reason: 'consumed', sourceRef, delta: { consumed: { ...consumed } }, stateVersionAfter,
  });
}

/** The audit reason of each outcome; `overflow-lost` is part 3 §3.4's name. */
export const AUDIT_REASON: Record<HuntReward['disposition']['outcome'], string> = {
  kept: 'drop-kept',
  'auto-sold': 'drop-auto-sold',
  ignored: 'drop-ignored',
  lost: 'overflow-lost',
};

/** The reward tiers `account_drop_protection` indexes, one row each (part 3 §2.4). */
const TIERS: readonly (keyof DropProtection)[] = ['epicPlus', 'legendary'];

/**
 * Rewrites the account's bad-luck index from the counters the committed
 * checkpoint carries, inside that commit's transaction (part 3 §2.4, ruling
 * R128). An index, never a source: the checkpoint is authoritative, and a
 * replay of the same segment rewrites exactly the same values.
 */
export async function indexDropProtection(tx: Tx, accountId: string, protection: DropProtection): Promise<void> {
  for (const tier of TIERS) {
    await tx
      .insert(schema.accountDropProtection)
      .values({ accountId, rewardTier: tier, counter: protection[tier] })
      .onConflictDoUpdate({
        target: [schema.accountDropProtection.accountId, schema.accountDropProtection.rewardTier],
        set: { counter: protection[tier], updatedAt: new Date() },
      });
  }
}

/**
 * The counters a new hunt starts from: the account's, which outlive every hunt
 * (layer-1 §4.5). Zero for an account that has never had an opportunity.
 */
export async function readDropProtection(db: Database | Tx, accountId: string): Promise<DropProtection> {
  const rows = await db
    .select({ rewardTier: schema.accountDropProtection.rewardTier, counter: schema.accountDropProtection.counter })
    .from(schema.accountDropProtection)
    .where(eq(schema.accountDropProtection.accountId, accountId));
  const protection: DropProtection = { epicPlus: 0, legendary: 0 };
  for (const row of rows) {
    if (row.rewardTier === 'epicPlus' || row.rewardTier === 'legendary') protection[row.rewardTier] = row.counter;
  }
  return protection;
}
