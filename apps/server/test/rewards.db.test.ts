/**
 * The reward carrier across a real commit (milestone B spec part 2 §2, §9 #8;
 * B-L07, P-27).
 *
 * As in `rewards.test.ts` the source is a test-only one — one draft per kill,
 * read from the `metrics.kills` delta — because the engine emits no reward
 * record before task 6. The sink writes each drained reward inside the commit
 * transaction; what is proved is that a reward exists only with its commit,
 * and that a re-simulated segment reproduces the same ids.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { SimState } from '@narok/sim';
import * as schema from '../src/db/schema';
import { persistHunt, startHunt } from '../src/hunt/lifecycle';
import type { RewardSink, RewardSource } from '../src/hunt/rewards';
import { connect, databaseReachable, disconnect, insertAccount, truncateAll, type Db } from './db-helpers';
import { checkpointOf, plan, rig, T0 } from './hunt-db-harness';

let db: Db;

const perKill: RewardSource = (before: SimState, after: SimState) =>
  Array.from({ length: after.metrics.kills - before.metrics.kills }, (_, index) => ({
    atSimMs: after.nowMs,
    kind: 'exp' as const,
    payload: { kill: before.metrics.kills + index + 1 },
  }));

/** Records each drained reward in the commit's own transaction. */
const auditSink: RewardSink = async (tx, accountId, rewards, stateVersionAfter) => {
  for (const reward of rewards) {
    await tx.insert(schema.resourceAudit).values({
      accountId,
      reason: 'test-reward',
      sourceRef: reward.rewardId,
      delta: reward.payload,
      stateVersionAfter,
    });
  }
};

async function sunk(accountId: string): Promise<string[]> {
  const rows = await db
    .select({ sourceRef: schema.resourceAudit.sourceRef })
    .from(schema.resourceAudit)
    .where(eq(schema.resourceAudit.accountId, accountId))
    .orderBy(schema.resourceAudit.id);
  return rows.map((row) => row.sourceRef);
}

beforeAll(async () => {
  expect(await databaseReachable(), 'PostgreSQL must be running: pnpm db:up').toBe(true);
  db = await connect();
});

afterAll(async () => {
  await disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
});

describe('rewards drain at the commit and nowhere else', () => {
  test('a failed commit writes no reward; the re-simulated segment commits the same ids once', async () => {
    const account = await insertAccount(db);
    let fail = false;
    const r = rig(db, {
      rewardSource: perKill,
      lifecycle: {
        rewardSink: auditSink,
        hooks: {
          beforeCommit: () => {
            if (fail) throw new Error('injected: crash before commit');
          },
        },
      },
    });
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan({ wipeLimit: 5 }) });

    r.clock.now = T0 + 600_000;
    fail = true;
    await expect(persistHunt(r.lifecycle, account.id, { live: true })).rejects.toThrow(/injected/);
    expect(await sunk(account.id)).toEqual([]);

    fail = false;
    const committed = await persistHunt(r.lifecycle, account.id, { live: true });
    const envelope = await checkpointOf(db, account.id);
    expect(committed.rewards.length).toBeGreaterThan(0);
    expect(await sunk(account.id)).toEqual(committed.rewards.map((reward) => reward.rewardId));
    expect(committed.rewards.map((reward) => reward.rewardId)).toEqual(
      committed.rewards.map((_, index) => `${envelope.huntId}:${index}`),
    );
    expect(envelope.pendingRewards).toEqual([]);
    expect(envelope.rewardSeq).toBe(committed.rewards.length);
  });

  test('a full carrier forces commits within one settlement, and the rounds together equal one uncapped settlement', async () => {
    const accounts = [await insertAccount(db), await insertAccount(db)];
    const capped = rig(db, { rewardSource: perKill, config: { rewardCarrierCap: 2 }, lifecycle: { rewardSink: auditSink } });
    const uncapped = rig(db, { rewardSource: perKill, lifecycle: { rewardSink: auditSink } });
    for (const [index, harness] of [capped, uncapped].entries()) {
      await startHunt(harness.lifecycle, { accountId: accounts[index].id, expectedStateVersion: 0, plan: plan({ wipeLimit: 5 }) });
      harness.clock.now = T0 + 600_000;
    }

    const small = await persistHunt(capped.lifecycle, accounts[0].id, { live: true });
    const whole = await persistHunt(uncapped.lifecycle, accounts[1].id, { live: true });

    expect(small.commits).toBeGreaterThan(1);
    expect(whole.commits).toBe(1);
    expect(small.creditedSimMs).toBe(600_000);
    const payloads = (rewards: typeof small.rewards) => rewards.map((reward) => reward.payload);
    expect(payloads(small.rewards)).toEqual(payloads(whole.rewards));
    const [a, b] = [await checkpointOf(db, accounts[0].id), await checkpointOf(db, accounts[1].id)];
    expect(a.state).toBe(b.state);
    expect(a.lastSeenAt).toBe(T0 + 600_000);
    expect((await sunk(accounts[0].id)).length).toBe(small.rewards.length);
  });
});
