/**
 * The single-writer rule and the optimistic-concurrency guard (P-19–P-23),
 * against a real PostgreSQL because that is the only place row locks exist.
 *
 * Gate B-26. The property under test is not "the code calls FOR UPDATE" — it is
 * that two commands racing on one account produce one winner, one honest
 * refusal, and never two credits.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { connect, databaseReachable, disconnect, insertAccount, insertItem, truncateAll, type Db } from './db-helpers';
import { ConflictError, withAccountTx } from '../src/db/tx';
import * as schema from '../src/db/schema';

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

describe('P-19: the account row is the writer token', () => {
  test('two simultaneous sells of one item credit gold exactly once', async () => {
    const account = await insertAccount(db, { gold: 0 });
    const item = await insertItem(db, account.id);

    /** Both attempts read version 0, as two clients racing really would. */
    const sell = () =>
      withAccountTx(db, { accountId: account.id, expectedStateVersion: 0, operation: 'sell' }, async (tx) => {
        const [row] = await tx.select().from(schema.items).where(eq(schema.items.id, item.id));
        if (row === undefined) throw new ConflictError('RULE_VIOLATION', 'itemId');
        await tx.delete(schema.items).where(eq(schema.items.id, item.id));
        await tx
          .update(schema.accounts)
          .set({ gold: account.gold + 10 })
          .where(eq(schema.accounts.id, account.id));
        return { gold: 10 };
      });

    const results = await Promise.allSettled([sell(), sell()]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const [after] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id));
    expect(after.gold, 'gold credited once, not twice').toBe(10);
    expect(after.stateVersion, 'exactly one commit moved the version').toBe(1);
    expect(await db.select().from(schema.items)).toHaveLength(0);
  });

  test('serialised commands each see the previous version', async () => {
    const account = await insertAccount(db, { gold: 0 });

    for (let expected = 0; expected < 3; expected++) {
      await withAccountTx(db, { accountId: account.id, expectedStateVersion: expected, operation: 'tick' }, async (tx) => {
        await tx
          .update(schema.accounts)
          .set({ gold: (expected + 1) * 5 })
          .where(eq(schema.accounts.id, account.id));
        return {};
      });
    }

    const [after] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id));
    expect(after.stateVersion).toBe(3);
    expect(after.gold).toBe(15);
  });
});

describe('P-20: a commit whose read version moved affects zero rows and aborts', () => {
  test('a stale guard is refused and writes nothing', async () => {
    const account = await insertAccount(db, { gold: 0 });

    await withAccountTx(db, { accountId: account.id, expectedStateVersion: 0, operation: 'first' }, async (tx) => {
      await tx.update(schema.accounts).set({ gold: 100 }).where(eq(schema.accounts.id, account.id));
      return {};
    });

    // A second command formed against the version the first one superseded.
    await expect(
      withAccountTx(db, { accountId: account.id, expectedStateVersion: 0, operation: 'stale' }, async (tx) => {
        await tx.update(schema.accounts).set({ gold: 999 }).where(eq(schema.accounts.id, account.id));
        return {};
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_STATE_VERSION' });

    const [after] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id));
    expect(after.gold, 'the refused body wrote nothing').toBe(100);
    expect(after.stateVersion).toBe(1);
  });

  test('the conflict carries the current version so a client can refetch', async () => {
    const account = await insertAccount(db);
    await withAccountTx(db, { accountId: account.id, expectedStateVersion: 0, operation: 'bump' }, async () => ({}));

    try {
      await withAccountTx(db, { accountId: account.id, expectedStateVersion: 0, operation: 'stale' }, async () => ({}));
      throw new Error('expected a conflict');
    } catch (error) {
      expect((error as ConflictError).code).toBe('CONFLICT_STATE_VERSION');
      expect((error as ConflictError).currentStateVersion).toBe(1);
    }
  });
});

describe('P-21: a stale worker result is discarded, never merged', () => {
  test('a settlement whose account moved mid-run commits nothing and audits nothing', async () => {
    const account = await insertAccount(db, { gold: 0 });

    // The long simulation runs outside the transaction, so the account can move
    // underneath it — which is exactly the case the guard exists for.
    const readVersion = account.stateVersion;
    await withAccountTx(db, { accountId: account.id, expectedStateVersion: readVersion, operation: 'town' }, async (tx) => {
      await tx.update(schema.accounts).set({ gold: 50 }).where(eq(schema.accounts.id, account.id));
      return {};
    });

    await expect(
      withAccountTx(
        db,
        { accountId: account.id, expectedStateVersion: readVersion, operation: 'settle' },
        async (tx) => {
          await tx.update(schema.accounts).set({ gold: 5_000 }).where(eq(schema.accounts.id, account.id));
          await tx.insert(schema.resourceAudit).values({
            accountId: account.id,
            reason: 'kill-reward',
            sourceRef: 'hunt:1:1',
            delta: { gold: 5_000 },
            stateVersionAfter: readVersion + 1,
          });
          return {};
        },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT_STATE_VERSION' });

    const [after] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id));
    expect(after.gold).toBe(50);
    const audit = await db.select().from(schema.resourceAudit);
    expect(audit, 'no reward from the discarded result reached the audit').toHaveLength(0);
  });
});

describe('P-27: nothing commits partially', () => {
  test('a crash between the body and the commit leaves no reward and no audit row', async () => {
    const account = await insertAccount(db, { gold: 0 });

    await expect(
      withAccountTx(db, { accountId: account.id, expectedStateVersion: 0, operation: 'crash' }, async (tx) => {
        await tx.update(schema.accounts).set({ gold: 777 }).where(eq(schema.accounts.id, account.id));
        await tx.insert(schema.resourceAudit).values({
          accountId: account.id,
          reason: 'kill-reward',
          sourceRef: 'hunt:1:2',
          delta: { gold: 777 },
          stateVersionAfter: 1,
        });
        throw new Error('worker died after the body, before the commit');
      }),
    ).rejects.toThrow(/worker died/);

    const [after] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id));
    expect(after.gold).toBe(0);
    expect(after.stateVersion).toBe(0);
    expect(await db.select().from(schema.resourceAudit)).toHaveLength(0);
  });
});

describe('P-22: internal retries are bounded', () => {
  let attempts = 0;

  afterEach(() => {
    attempts = 0;
  });

  test('an exhausted retry returns a conflict rather than looping', async () => {
    const account = await insertAccount(db);

    await expect(
      withAccountTx(
        db,
        { accountId: account.id, expectedStateVersion: 0, operation: 'contended', maxAttempts: 3 },
        async () => {
          attempts += 1;
          throw new ConflictError('CONFLICT_STATE_VERSION', 'contention', 0);
        },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT_STATE_VERSION' });

    expect(attempts, 'tried its bounded number of times and stopped').toBe(3);
  });

  test('a retry that succeeds on a later attempt still commits once', async () => {
    const account = await insertAccount(db, { gold: 0 });

    await withAccountTx(
      db,
      { accountId: account.id, expectedStateVersion: 0, operation: 'flaky', maxAttempts: 3 },
      async (tx) => {
        attempts += 1;
        if (attempts < 2) throw new ConflictError('CONFLICT_STATE_VERSION', 'contention', 0);
        await tx.update(schema.accounts).set({ gold: 42 }).where(eq(schema.accounts.id, account.id));
        return {};
      },
    );

    const [after] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id));
    expect(after.gold).toBe(42);
    expect(after.stateVersion, 'one commit, not one per attempt').toBe(1);
  });
});
