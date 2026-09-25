/**
 * Settlement against the real database (milestone B spec part 2 §3; B-L02,
 * B-18): settle → commit → refresh presence → re-anchor, with presence per
 * account so two tabs cannot double-settle.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { ConflictError } from '../src/db/tx';
import { persistHunt, startHunt } from '../src/hunt/lifecycle';
import { connect, databaseReachable, disconnect, insertAccount, truncateAll, type Db } from './db-helpers';
import { sim } from './hunt-fixtures';
import { accountVersion, checkpointOf, huntRow, plan, rig, T0 } from './hunt-db-harness';

let db: Db;

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

describe('settle → commit → refresh presence (B-L02)', () => {
  test('a failure between the settlement and the commit leaves lastSeenAt and the allowance intact', async () => {
    const account = await insertAccount(db);
    let fail = true;
    const r = rig(db, {
      lifecycle: {
        hooks: {
          beforeCommit: () => {
            if (fail) throw new Error('injected: crash before commit');
          },
        },
      },
    });
    fail = false;
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    fail = true;

    const before = await huntRow(db, account.id);
    r.clock.now = T0 + 60_000;
    await expect(persistHunt(r.lifecycle, account.id, { live: true })).rejects.toThrow(/injected/);

    const after = await huntRow(db, account.id);
    expect(after.lastSeenAt.getTime()).toBe(before.lastSeenAt.getTime());
    expect(Buffer.from(after.checkpoint).equals(Buffer.from(before.checkpoint))).toBe(true);
    expect((await checkpointOf(db, account.id)).lastSeenAt).toBe(T0);

    // The retry settles the same window: nothing of the allowance was burned.
    fail = false;
    const retried = await persistHunt(r.lifecycle, account.id, { live: true });
    expect(retried.creditedSimMs).toBe(60_000);
    expect((await checkpointOf(db, account.id)).lastSeenAt).toBe(T0 + 60_000);
  });
});

describe('presence is per account (B-18)', () => {
  test('two tabs settling at one instant contend on one state version and credit the window once', async () => {
    const account = await insertAccount(db);
    const r = rig(db);
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    const version = await accountVersion(db, account.id);
    r.clock.now = T0 + 45_000;

    const results = await Promise.allSettled([
      persistHunt(r.lifecycle, account.id, { live: true }),
      persistHunt(r.lifecycle, account.id, { live: true }),
    ]);
    // Whichever way the race falls, the window is credited exactly once: a
    // loser either lost the version check or found nothing left to settle.
    let credited = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') credited += result.value.creditedSimMs;
      else expect(result.reason).toBeInstanceOf(ConflictError);
    }
    expect(credited).toBe(45_000);

    const envelope = await checkpointOf(db, account.id);
    expect(sim.decode(envelope.state).nowMs).toBe(45_000);
    expect(envelope.checkpointSeq).toBe((await accountVersion(db, account.id)) - version);

    // The loser retries from fresh state and finds nothing left to credit.
    const retry = await persistHunt(r.lifecycle, account.id, { live: true });
    expect(retry.creditedSimMs).toBe(0);
  });

  test('repeated heartbeats accrue continuously and never engage the cap', async () => {
    const account = await insertAccount(db);
    const r = rig(db, { config: { offlineCapMs: 60_000 } });
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    // Three heartbeats 30 s apart cover 90 s under a 60 s recorded cap.
    for (const at of [30_000, 60_000, 90_000]) {
      r.clock.now = T0 + at;
      await persistHunt(r.lifecycle, account.id, { live: true });
    }
    const envelope = await checkpointOf(db, account.id);
    expect(sim.decode(envelope.state).nowMs).toBe(90_000);
    expect(envelope.generation, 'heartbeats never bump generation').toBe(1);
  });
});
