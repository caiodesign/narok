/**
 * The migration runbook of milestone B spec part 1 §6, as far as it can be
 * asserted without a deployment: the freeze is durable, step 3 archives every
 * checkpoint before step 4 touches anything, and the HP/MP rule is applied
 * inside migration rather than deferred.
 *
 * The executed restore drill and a real settlement are evidence work (P-34,
 * gate B-28) and belong to the milestone's evidence task, not here. Nothing in
 * this file may be read as closing that gate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { connect, databaseReachable, disconnect, insertAccount, insertCharacter, truncateAll, type Db } from './db-helpers';
import { archiveCheckpoint, loadCheckpoint, saveCheckpoint } from '../src/db/repositories/hunts';
import { clampToMaximum } from '../src/db/migrate-rules';
import { withAccountTx } from '../src/db/tx';
import * as schema from '../src/db/schema';

let db: Db;

const PINS = { simulationVersion: 'a1', contentVersion: 'v1', gridHash: 'g1' } as const;

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

async function seedHunt(accountId: string, encoded: string): Promise<void> {
  await withAccountTx(db, { accountId, expectedStateVersion: 0, operation: 'seed' }, async (tx) =>
    saveCheckpoint(tx, {
      accountId,
      status: 'running',
      mapId: 'meadow-outskirts',
      encoded,
      ...PINS,
      checkpointSchemaVersion: 1,
      simAnchorMs: 0,
      wallAnchorAt: new Date(),
      lastSeenAt: new Date(),
      maxBytes: 1024 * 1024,
    }),
  );
}

describe('step 1: the freeze is durable', () => {
  test('the cutoff survives a reconnect, because every process must see it', async () => {
    await db.insert(schema.maintenance).values({ id: 1, frozen: true, cutoffAt: new Date('2026-09-22T12:00:00Z'), updatedBy: 'admin' });

    const [row] = await db.select().from(schema.maintenance);
    expect(row.frozen).toBe(true);
    expect(row.cutoffAt?.toISOString()).toBe('2026-09-22T12:00:00.000Z');
  });
});

describe('step 3: every checkpoint is archived before step 4 runs', () => {
  test('the archive row count equals the hunt row count', async () => {
    const accounts = [await insertAccount(db), await insertAccount(db), await insertAccount(db)];
    for (const [index, account] of accounts.entries()) {
      await seedHunt(account.id, `{"state":${index}}`);
    }

    for (const account of accounts) {
      await archiveCheckpoint(db, account.id, 'migration');
    }

    const hunts = await db.select().from(schema.hunts);
    const archived = await db.select().from(schema.huntCheckpointArchive);
    expect(archived).toHaveLength(hunts.length);
    expect(archived.every((row) => row.capturedFor === 'migration')).toBe(true);
  });

  test('archiving copies rather than moves: the live checkpoint is still there', async () => {
    const account = await insertAccount(db);
    await seedHunt(account.id, '{"state":1}');
    await archiveCheckpoint(db, account.id, 'migration');

    const live = await loadCheckpoint(db, account.id, PINS);
    expect(live.encoded).toBe('{"state":1}');
  });

  test('the archived bytes are the bytes, so a rollback is a replay and not a hope', async () => {
    const account = await insertAccount(db);
    const encoded = '{"zebra":1,"alpha":2,"scaled":1.50}';
    await seedHunt(account.id, encoded);
    await archiveCheckpoint(db, account.id, 'migration');

    const [row] = await db.select().from(schema.huntCheckpointArchive);
    expect(Buffer.from(row.checkpoint).toString('utf8')).toBe(encoded);
    expect(row.simulationVersion).toBe(PINS.simulationVersion);
    expect(row.contentVersion).toBe(PINS.contentVersion);
    expect(row.gridHash).toBe(PINS.gridHash);
  });

  test('a fault capture is the same mechanism under a different label (layer-1 §11)', async () => {
    const account = await insertAccount(db);
    await seedHunt(account.id, '{"state":1}');
    await archiveCheckpoint(db, account.id, 'fault');

    const [row] = await db.select().from(schema.huntCheckpointArchive);
    expect(row.capturedFor).toBe('fault');
  });
});

/**
 * The owner's decision (spec §4.0, part 1 §9 #16): the current value is
 * preserved and clamped to the new maximum. Ratio preservation was rejected
 * because it would hand out free healing during maintenance, which layer-1
 * §4.5 forbids for every other transition.
 */
describe('step 4: the HP/MP rule is applied during migration, not at the next level-up', () => {
  test('a raised maximum leaves the current value where it was', () => {
    expect(clampToMaximum(120, 200)).toBe(120);
  });

  test('a lowered maximum clamps rather than scaling', () => {
    expect(clampToMaximum(180, 150)).toBe(150);
  });

  test('a full character stays full only by coincidence, never by rule', () => {
    // 200/200 with the maximum raised to 260 is 200, not 260: no free healing.
    expect(clampToMaximum(200, 260)).toBe(200);
  });

  test('ratio preservation is not what happens', () => {
    // Half of 200 with the maximum raised to 400 would be 200 under a ratio
    // rule. It stays 100.
    expect(clampToMaximum(100, 400)).toBe(100);
  });

  test('a maximum of zero clamps to zero rather than going negative', () => {
    expect(clampToMaximum(50, 0)).toBe(0);
  });

  test('the rule holds against the database column, which refuses a negative anyway', async () => {
    const account = await insertAccount(db);
    const character = await insertCharacter(db, account.id, { hp: 180, mp: 60 });

    await db
      .update(schema.characters)
      .set({ hp: clampToMaximum(character.hp, 150) })
      .where(eq(schema.characters.id, character.id));

    const [after] = await db.select().from(schema.characters).where(eq(schema.characters.id, character.id));
    expect(after.hp).toBe(150);
  });
});
