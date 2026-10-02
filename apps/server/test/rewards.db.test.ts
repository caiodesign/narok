/**
 * Drops across a real commit (milestone B spec part 2 §2, §9 #8; part 3 §2.4,
 * §3.4; B-L07, B-25, P-27; rulings R128, R132).
 *
 * The engine's own drops, under the bundled content with every monster at the
 * largest accepted drop multiplier so a few minutes carry many rewards. What
 * is proved: a reward exists only with its commit, a re-simulated segment
 * commits the same ids once, `account_drop_protection` always equals the
 * committed checkpoint's counters, and a Keep the bag cannot hold is lost,
 * audited as `overflow-lost`, while the hunt carries on.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { LootPreset } from '@narok/loot';
import * as schema from '../src/db/schema';
import { persistHunt, startHunt, stopHunt } from '../src/hunt/lifecycle';
import { AUDIT_REASON, readDropProtection } from '../src/hunt/rewards';
import { connect, databaseReachable, disconnect, insertAccount, truncateAll, type Db } from './db-helpers';
import { checkpointOf, dropProtectionRows, huntRow, plan, rig, T0 } from './hunt-db-harness';
import { rich, richSim } from './hunt-fixtures';

let db: Db;
const engine = { sim: richSim, content: rich };
const KEEP_ALL: LootPreset = { exceptions: [], rarity: {}, fallback: { equipment: 'keep', consumable: 'keep' } };

async function audit(accountId: string) {
  return db
    .select()
    .from(schema.resourceAudit)
    .where(eq(schema.resourceAudit.accountId, accountId))
    .orderBy(schema.resourceAudit.id);
}

async function itemsOf(accountId: string) {
  return db.select().from(schema.items).where(eq(schema.items.accountId, accountId));
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
      engine,
      lifecycle: {
        hooks: {
          beforeCommit: () => {
            if (fail) throw new Error('injected: crash before commit');
          },
        },
      },
    });
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });

    r.clock.now = T0 + 600_000;
    fail = true;
    await expect(persistHunt(r.lifecycle, account.id, { live: true })).rejects.toThrow(/injected/);
    expect(await audit(account.id)).toEqual([]);
    expect(await itemsOf(account.id)).toEqual([]);

    fail = false;
    const committed = await persistHunt(r.lifecycle, account.id, { live: true });
    const envelope = await checkpointOf(db, account.id);
    expect(committed.rewards.length).toBeGreaterThan(5);
    const rows = await audit(account.id);
    expect(rows.map((row) => row.sourceRef)).toEqual(committed.rewards.map((reward) => reward.rewardId));
    committed.rewards.forEach((reward) => expect(reward.rewardId).toBe(`${envelope.huntId}:${reward.rewardSeq}`));
    expect(rows.map((row) => row.reason)).toEqual(committed.rewards.map((reward) => AUDIT_REASON[reward.disposition.outcome]));
    expect(rows.every((row) => row.stateVersionAfter === committed.stateVersion)).toBe(true);
  });

  test('kept equipment becomes an item keyed by its reward id, under the hunt’s pinned content; auto-sell credits no gold', async () => {
    const account = await insertAccount(db);
    const r = rig(db, { engine });
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    r.clock.now = T0 + 600_000;
    const committed = await persistHunt(r.lifecycle, account.id, { live: true });

    const kept = committed.rewards.filter((reward) => reward.disposition.outcome === 'kept');
    const sold = committed.rewards.filter((reward) => reward.disposition.outcome === 'auto-sold');
    expect(kept.length).toBeGreaterThan(0);
    expect(sold.length).toBeGreaterThan(0);

    const items = await itemsOf(account.id);
    expect(items.map((item) => item.sourceRef).sort()).toEqual(kept.map((reward) => reward.rewardId).sort());
    for (const item of items) {
      const reward = kept.find((entry) => entry.rewardId === item.sourceRef)!;
      if (reward.item.kind !== 'equipment') throw new Error('expected equipment');
      expect(item).toMatchObject({
        baseItemId: reward.item.definitionId,
        baseContentVersion: rich.version,
        rarity: reward.item.rarity,
        itemLevel: reward.itemLevel,
        bonuses: reward.item.bonuses,
        protected: reward.item.rarity === 'legendary',
        locked: false,
        equippedCharacterId: null,
      });
    }
    // The bag the engine counted is the bag the tables hold.
    const state = richSim.decode((await checkpointOf(db, account.id)).state);
    expect(state.bagState.usedSlots).toBe(items.length);

    // Prices are deferred: an auto-sold item is audited and counted, never priced.
    const [row] = await db.select({ gold: schema.accounts.gold }).from(schema.accounts).where(eq(schema.accounts.id, account.id));
    expect(row.gold).toBe(0);
    const soldRows = (await audit(account.id)).filter((entry) => entry.reason === 'drop-auto-sold');
    expect(soldRows).toHaveLength(sold.length);
    expect(soldRows.every((entry) => (entry.delta as { gold: number }).gold === 0)).toBe(true);
  });

  test('one reward can never become two items: the source index refuses a second credit', async () => {
    const account = await insertAccount(db);
    const values = {
      accountId: account.id, baseItemId: 'leather-cap', baseContentVersion: rich.version, rarity: 'common',
      itemLevel: 10, bonuses: [], sourceRef: '22222222-2222-4222-8222-222222222222:0',
    };
    await db.insert(schema.items).values(values);
    await expect(db.insert(schema.items).values(values)).rejects.toThrow();
    expect(await itemsOf(account.id)).toHaveLength(1);
  });

  test('a full carrier forces commits within one settlement, and the rounds together equal one uncapped settlement', async () => {
    const accounts = [await insertAccount(db), await insertAccount(db)];
    const capped = rig(db, { engine, config: { rewardCarrierCap: 10 } });
    const uncapped = rig(db, { engine });
    for (const [index, harness] of [capped, uncapped].entries()) {
      await startHunt(harness.lifecycle, { accountId: accounts[index].id, expectedStateVersion: 0, plan: plan() });
      harness.clock.now = T0 + 300_000;
    }

    const small = await persistHunt(capped.lifecycle, accounts[0].id, { live: true });
    const whole = await persistHunt(uncapped.lifecycle, accounts[1].id, { live: true });

    expect(small.commits).toBeGreaterThan(1);
    expect(whole.commits).toBe(1);
    expect(small.creditedSimMs).toBe(300_000);
    const items = (rewards: typeof small.rewards) => rewards.map((reward) => [reward.rewardSeq, reward.item, reward.disposition]);
    expect(items(small.rewards)).toEqual(items(whole.rewards));
    const [a, b] = [await checkpointOf(db, accounts[0].id), await checkpointOf(db, accounts[1].id)];
    expect(a.state).toBe(b.state);
    expect(a.lastSeenAt).toBe(T0 + 300_000);
    expect((await audit(accounts[0].id)).length).toBe(small.rewards.length);
    expect(await dropProtectionRows(db, accounts[0].id)).toEqual(richSim.decode(a.state).dropProtection);
  }, 30_000);
});

describe('account_drop_protection is an index of the checkpoint’s counters (part 3 §2.4, R128)', () => {
  test('every commit rewrites it from the committed counters, and a replay rewrites the same values', async () => {
    const account = await insertAccount(db);
    let fail = false;
    const r = rig(db, {
      engine,
      lifecycle: { hooks: { beforeCommit: () => { if (fail) throw new Error('injected'); } } },
    });
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });

    for (const at of [60_000, 180_000, 240_000]) {
      r.clock.now = T0 + at;
      fail = true;
      const before = await dropProtectionRows(db, account.id);
      await expect(persistHunt(r.lifecycle, account.id, { live: true })).rejects.toThrow(/injected/);
      // A failed commit leaves the index where the last commit put it.
      expect(await dropProtectionRows(db, account.id)).toEqual(before);
      fail = false;
      await persistHunt(r.lifecycle, account.id, { live: true });
      const counters = richSim.decode((await checkpointOf(db, account.id)).state).dropProtection;
      expect(await dropProtectionRows(db, account.id)).toEqual(counters);
      expect(counters.epicPlus + counters.legendary).toBeGreaterThan(0);
    }
  });

  test('stopping keeps the counters, and the next hunt starts from the account’s index (layer-1 §4.5)', async () => {
    const account = await insertAccount(db);
    const r = rig(db, { engine });
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    r.clock.now = T0 + 120_000;
    const stopped = await stopHunt(r.lifecycle, { accountId: account.id });
    const counters = richSim.decode((await checkpointOf(db, account.id)).state).dropProtection;
    expect(await readDropProtection(db, account.id)).toEqual(counters);

    // The travel home costs its time; the next hunt then begins from the index.
    r.clock.now = T0 + 120_000 + (rich.townReturnTravelMs ?? 0);
    const next = await startHunt(r.lifecycle, {
      accountId: account.id,
      expectedStateVersion: stopped.stateVersion,
      plan: plan({}, undefined, { dropProtection: await readDropProtection(db, account.id) }),
    });
    const state = richSim.decode((await checkpointOf(db, account.id)).state);
    expect(state.dropProtection).toEqual(counters);
    expect(state.nextRewardSeq).toBe(0);
    expect(next.huntId).not.toBe(stopped.huntId);
  });
});

describe('a Keep the bag cannot hold is lost, audited, and the hunt goes on (part 3 §3.4, spec §4.0)', () => {
  test('overflow-lost rows name each lost reward; no item appears later; the hunt keeps running', async () => {
    const account = await insertAccount(db);
    const r = rig(db, { engine });
    await startHunt(r.lifecycle, {
      accountId: account.id,
      expectedStateVersion: 0,
      plan: plan({}, undefined, { loot: KEEP_ALL, bag: { capacity: 2, usedSlots: 0, held: {} } }),
    });
    r.clock.now = T0 + 600_000;
    const committed = await persistHunt(r.lifecycle, account.id, { live: true });

    const lost = committed.rewards.filter((reward) => reward.disposition.outcome === 'lost');
    expect(lost.length).toBeGreaterThan(0);
    expect(committed.rewards.filter((reward) => reward.disposition.outcome === 'kept')).toHaveLength(2);
    const lostRows = (await audit(account.id)).filter((row) => row.reason === 'overflow-lost');
    expect(lostRows.map((row) => row.sourceRef)).toEqual(lost.map((reward) => reward.rewardId));
    expect(await itemsOf(account.id)).toHaveLength(2);
    expect((await huntRow(db, account.id)).status).toBe('running');

    // The next settlement adds new drops and never revisits a lost one.
    r.clock.now = T0 + 660_000;
    const later = await persistHunt(r.lifecycle, account.id, { live: true });
    const lostIds = new Set(lost.map((reward) => reward.rewardId));
    expect(later.rewards.some((reward) => lostIds.has(reward.rewardId))).toBe(false);
    expect(await itemsOf(account.id)).toHaveLength(2);
  });
});
