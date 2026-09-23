/**
 * P-25 and P-36: a replayed command mutates once and returns what it returned
 * the first time; the same key with different input is refused; a grant repeats
 * as a no-op.
 *
 * The idempotency record is written *in the same transaction as its effect*.
 * That is the whole guarantee — a record written afterwards can be lost between
 * the two, which is precisely the crash a retrying client is recovering from.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { connect, databaseReachable, disconnect, insertAccount, truncateAll, type Db } from './db-helpers';
import { ConflictError, withAccountTx } from '../src/db/tx';
import { grantOnce } from '../src/db/repositories/grants';
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

describe('P-25: a replayed command mutates once', () => {
  test('a duplicated purchase credits one set of potions and returns the stored response', async () => {
    const account = await insertAccount(db, { gold: 100 });

    const buy = (expectedStateVersion: number) =>
      withAccountTx(
        db,
        {
          accountId: account.id,
          expectedStateVersion,
          operation: 'shop.buy',
          idempotency: { key: 'buy-1', requestHash: 'hash-of-2-potions' },
        },
        async (tx) => {
          await tx
            .insert(schema.stackItems)
            .values({ accountId: account.id, definitionId: 'small-hp-potion', quantity: 2 })
            .onConflictDoUpdate({
              target: [schema.stackItems.accountId, schema.stackItems.definitionId],
              set: { quantity: 2 },
            });
          return { bought: 2 };
        },
      );

    const first = await buy(0);
    // The client never saw the response and retries with the same key. Its
    // guard still names the version it read, which the replay must not fail on.
    const second = await buy(0);

    expect(first).toEqual({ bought: 2 });
    expect(second, 'the replay returns the stored response').toEqual({ bought: 2 });

    const stacks = await db.select().from(schema.stackItems);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].quantity, 'credited once').toBe(2);

    const [after] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id));
    expect(after.stateVersion, 'one commit moved the version').toBe(1);
  });

  test('the same key with different input is refused rather than treated as a replay', async () => {
    const account = await insertAccount(db);

    await withAccountTx(
      db,
      {
        accountId: account.id,
        expectedStateVersion: 0,
        operation: 'shop.buy',
        idempotency: { key: 'buy-1', requestHash: 'hash-of-2-potions' },
      },
      async () => ({ bought: 2 }),
    );

    await expect(
      withAccountTx(
        db,
        {
          accountId: account.id,
          expectedStateVersion: 1,
          operation: 'shop.buy',
          idempotency: { key: 'buy-1', requestHash: 'hash-of-99-potions' },
        },
        async () => ({ bought: 99 }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  test('the record is written inside the transaction, so a failed body leaves no key behind', async () => {
    const account = await insertAccount(db);

    await expect(
      withAccountTx(
        db,
        {
          accountId: account.id,
          expectedStateVersion: 0,
          operation: 'shop.buy',
          idempotency: { key: 'buy-2', requestHash: 'h' },
        },
        async () => {
          throw new ConflictError('RULE_VIOLATION', 'gold');
        },
      ),
    ).rejects.toMatchObject({ code: 'RULE_VIOLATION' });

    expect(await db.select().from(schema.commandResults)).toHaveLength(0);
  });

  test('two accounts may use the same key: the scope is (account, key)', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);

    for (const account of [a, b]) {
      await withAccountTx(
        db,
        {
          accountId: account.id,
          expectedStateVersion: 0,
          operation: 'shop.buy',
          idempotency: { key: 'shared-key', requestHash: 'h' },
        },
        async () => ({ ok: true }),
      );
    }

    expect(await db.select().from(schema.commandResults)).toHaveLength(2);
  });
});

describe('P-36: a grant repeats as a no-op', () => {
  test('the starter kit is granted once however many times it is attempted', async () => {
    const account = await insertAccount(db);

    const first = await grantOnce(db, {
      accountId: account.id,
      grantKey: 'starter-kit:0',
      kind: 'starter',
      payload: { potions: 20 },
      grantedBy: 'system',
    });
    const second = await grantOnce(db, {
      accountId: account.id,
      grantKey: 'starter-kit:0',
      kind: 'starter',
      payload: { potions: 20 },
      grantedBy: 'system',
    });

    expect(first.granted, 'the first attempt grants').toBe(true);
    expect(second.granted, 'the second is a no-op').toBe(false);
    expect(await db.select().from(schema.accountGrants)).toHaveLength(1);
  });

  test('a different slot is a different grant', async () => {
    const account = await insertAccount(db);
    await grantOnce(db, { accountId: account.id, grantKey: 'starter-kit:0', kind: 'starter', payload: {}, grantedBy: 'system' });
    await grantOnce(db, { accountId: account.id, grantKey: 'starter-kit:1', kind: 'starter', payload: {}, grantedBy: 'system' });
    expect(await db.select().from(schema.accountGrants)).toHaveLength(2);
  });
});
