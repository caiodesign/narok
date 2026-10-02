/**
 * The maintenance settlement path (part 2 §7; P-31; rulings R119, R199):
 * freeze at a cutoff, settle every running hunt to it under the pinned
 * artifacts, resume with new anchors. The arithmetic is `settle.test.ts`'s;
 * this is the wiring over a real database.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import * as schema from '../src/db/schema';
import { persistHunt, startHunt } from '../src/hunt/lifecycle';
import { freeze, resumeAll, settleAll } from '../src/ops/maintenance';
import { connect, databaseReachable, disconnect, insertAccount, truncateAll, type Db } from './db-helpers';
import { sim } from './hunt-fixtures';
import { checkpointOf, plan, rig, T0 } from './hunt-db-harness';

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

describe('maintenance: freeze, settle to the cutoff, resume (R199)', () => {
  test('downtime is a pause: never simulated, and not billed to the offline allowance', async () => {
    const account = await insertAccount(db);
    const r = rig(db);
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    const startedAt = await checkpointOf(db, account.id);

    const cutoff = T0 + 20_000;
    r.clock.now = cutoff + 5_000;
    await freeze(r.lifecycle, cutoff, 'test');
    const settled = await settleAll(r.lifecycle);
    expect(settled).toEqual([expect.objectContaining({ accountId: account.id, outcome: 'settled' })]);
    const atCutoff = await checkpointOf(db, account.id);
    expect(atCutoff.wallAnchorMs, 'settled to the cutoff, not to the operator clock').toBe(cutoff);
    expect(sim.decode(atCutoff.state).nowMs).toBe(20_000);

    const downtime = 10 * 60 * 1000;
    r.clock.now = cutoff + downtime;
    const resumed = await resumeAll(r.lifecycle, r.clock.now);
    expect(resumed.outcomes).toEqual([expect.objectContaining({ accountId: account.id, outcome: 'resumed' })]);
    expect(resumed.lifted).toBe(true);
    const after = await checkpointOf(db, account.id);
    expect(after.wallAnchorMs).toBe(cutoff + downtime);
    expect(after.simAnchorMs, 'nothing simulated across the outage').toBe(atCutoff.simAnchorMs);
    expect(after.lastSeenAt, 'the outage does not bill the allowance').toBe(startedAt.lastSeenAt + downtime);
    const [row] = await db.select().from(schema.maintenance).where(eq(schema.maintenance.id, 1));
    expect(row.frozen).toBe(false);

    // Play continues from the resume instant: five seconds later is five simulated seconds later.
    r.clock.now = cutoff + downtime + 5_000;
    await persistHunt(r.lifecycle, account.id, { live: true });
    expect(sim.decode((await checkpointOf(db, account.id)).state).nowMs).toBe(25_000);
  });

  test('a hunt pinned to other artifacts is refused and reported, never settled under substitutes', async () => {
    const account = await insertAccount(db);
    const r = rig(db);
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    await db.update(schema.hunts).set({ contentVersion: 'retired-content' }).where(eq(schema.hunts.accountId, account.id));
    const before = (await db.select().from(schema.hunts).where(eq(schema.hunts.accountId, account.id)))[0].checkpoint;

    r.clock.now = T0 + 20_000;
    await freeze(r.lifecycle, T0 + 20_000, 'test');
    expect(await settleAll(r.lifecycle)).toEqual([
      { accountId: account.id, outcome: 'refused', detail: 'CONTENT_VERSION_MISMATCH contentVersion' },
    ]);
    const after = (await db.select().from(schema.hunts).where(eq(schema.hunts.accountId, account.id)))[0].checkpoint;
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
  });

  test('resume keeps the freeze while a running hunt was never settled to the cutoff (R201)', async () => {
    const account = await insertAccount(db);
    const r = rig(db);
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    const before = (await db.select().from(schema.hunts).where(eq(schema.hunts.accountId, account.id)))[0].checkpoint;

    // freeze -> resume with no settle: the hunt is anchored before the cutoff.
    const cutoff = T0 + 20_000;
    r.clock.now = cutoff;
    await freeze(r.lifecycle, cutoff, 'test');
    r.clock.now = cutoff + 60_000;
    const refused = await resumeAll(r.lifecycle, r.clock.now);
    expect(refused.outcomes).toEqual([expect.objectContaining({ accountId: account.id, outcome: 'skipped' })]);
    expect(refused.lifted, 'a skipped hunt keeps the freeze').toBe(false);
    const [still] = await db.select().from(schema.maintenance).where(eq(schema.maintenance.id, 1));
    expect(still.frozen).toBe(true);
    const after = (await db.select().from(schema.hunts).where(eq(schema.hunts.accountId, account.id)))[0].checkpoint;
    expect(Buffer.from(after).equals(Buffer.from(before)), 'the skipped hunt is left untouched').toBe(true);

    // The operator's explicit override lifts it, and still touches no skipped hunt.
    const forced = await resumeAll(r.lifecycle, r.clock.now, { force: true });
    expect(forced.outcomes).toEqual([expect.objectContaining({ accountId: account.id, outcome: 'skipped' })]);
    expect(forced.lifted).toBe(true);
    const [lifted] = await db.select().from(schema.maintenance).where(eq(schema.maintenance.id, 1));
    expect(lifted.frozen).toBe(false);
  });

  test('settle and resume refuse to run unless maintenance is frozen', async () => {
    const r = rig(db);
    await expect(settleAll(r.lifecycle)).rejects.toThrow(/not frozen/);
    await expect(resumeAll(r.lifecycle, T0)).rejects.toThrow(/not frozen/);
  });
});
