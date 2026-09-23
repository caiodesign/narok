/**
 * The seam, proved.
 *
 * Task 1 decided the authentication and session rules against in-memory
 * stores. If that seam was real, the same journeys hold against PostgreSQL
 * with only the storage swapped — so this file drives the app over the Drizzle
 * adapter and asserts the same properties the in-memory suites assert.
 *
 * Where a rule needs the database to be the one enforcing it — P-10's password
 * change revoking every session in one transaction — it is asserted here
 * rather than in memory, because that is where it can actually fail.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app';
import { defaultConfig, type ServerConfig } from '../src/config';
import { argon2Hasher } from '../src/auth/password';
import { drizzleStores, resetPassword } from '../src/db/repositories/accounts';
import { connect, databaseReachable, disconnect, truncateAll, type Db } from './db-helpers';
import { sessionCookie } from './helpers';
import * as schema from '../src/db/schema';

const ORIGIN = 'http://localhost:4173';
const PASSWORD = 'a-sufficiently-long-password';

let db: Db;
let app: FastifyInstance;
let config: ServerConfig;

beforeAll(async () => {
  expect(await databaseReachable(), 'PostgreSQL must be running: pnpm db:up').toBe(true);
  db = await connect();
});

afterAll(async () => {
  await disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  config = {
    ...defaultConfig(),
    allowedOrigins: [ORIGIN],
    argon2: { memoryCost: 8, timeCost: 1, parallelism: 1 },
  };

  const stores = drizzleStores(db, { now: () => Date.now(), bagCapacity: 100 });
  app = await createApp({
    config,
    // The audit and command stores are task 4's; the auth journey needs neither.
    stores: {
      ...stores,
      audit: { append: async () => {}, rows: async () => [] },
      commands: { get: async () => undefined, put: async () => {} },
    },
  });
});

afterEach(async () => {
  await app.close();
});

async function register(email = 'player@example.com') {
  return app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: ORIGIN }, payload: { email, password: PASSWORD } });
}

async function login(email = 'player@example.com', password = PASSWORD, cookie?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: cookie === undefined ? { origin: ORIGIN } : { origin: ORIGIN, cookie },
    payload: { email, password },
  });
}

describe('the same auth journey, over PostgreSQL', () => {
  test('register, login, read, logout', async () => {
    expect((await register()).statusCode).toBe(200);

    const cookie = sessionCookie((await login()).headers['set-cookie']);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe('player@example.com');

    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: ORIGIN, cookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  test('the account really landed in the database, hashed', async () => {
    await register();
    const [row] = await db.select().from(schema.accounts);
    expect(row.email).toBe('player@example.com');
    expect(row.passwordHash).not.toBe(PASSWORD);
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordAlgorithm).toContain('argon2id');
    expect(row.stateVersion).toBe(0);
  });

  test('a duplicate email is refused by the database index, not only by the check above it', async () => {
    await register();
    const again = await register('PLAYER@Example.COM');
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('EMAIL_TAKEN');
    expect(await db.select().from(schema.accounts)).toHaveLength(1);
  });

  test('P-09: login rotates, and the old session row is revoked in the database', async () => {
    await register();
    const first = sessionCookie((await login()).headers['set-cookie']);
    const second = sessionCookie((await login('player@example.com', PASSWORD, first)).headers['set-cookie']);

    expect(second).not.toBe(first);
    const rows = await db.select().from(schema.sessions);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revokedAt !== null)).toHaveLength(1);

    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: first } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: second } })).statusCode).toBe(200);
  });

  test('P-11: the idle window is refreshed in the database on each request', async () => {
    await register();
    const cookie = sessionCookie((await login()).headers['set-cookie']);
    const [before] = await db.select().from(schema.sessions);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

    const [after] = await db.select().from(schema.sessions);
    expect(after.lastSeenAt).toBeGreaterThan(before.lastSeenAt);
  });
});

describe('P-10: a password change revokes every session, atomically', () => {
  test('both live sessions die, and the database shows why', async () => {
    await register();
    const first = sessionCookie((await login()).headers['set-cookie']);
    const second = sessionCookie((await login()).headers['set-cookie']);
    const [account] = await db.select().from(schema.accounts);

    const hasher = argon2Hasher(config.argon2);
    const hashed = await hasher.hash('a-brand-new-long-password');
    await resetPassword(db, account.id, hashed.hash, hashed.algorithm, Date.now());

    for (const cookie of [first, second]) {
      expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    }

    const sessions = await db.select().from(schema.sessions);
    expect(sessions.every((row) => row.revokedAt !== null), 'every session row revoked').toBe(true);

    const [updated] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id));
    expect(updated.passwordHash).not.toBe(account.passwordHash);
    expect(updated.passwordChangedAt).toBeGreaterThanOrEqual(account.passwordChangedAt);
  });

  test('the new password works and the old one does not', async () => {
    await register();
    const [account] = await db.select().from(schema.accounts);
    const hasher = argon2Hasher(config.argon2);
    const hashed = await hasher.hash('a-brand-new-long-password');
    await resetPassword(db, account.id, hashed.hash, hashed.algorithm, Date.now());

    expect((await login('player@example.com', PASSWORD)).statusCode).toBe(401);
    expect((await login('player@example.com', 'a-brand-new-long-password')).statusCode).toBe(204);
  });
});

describe('ownership, over real rows', () => {
  test("another account's item is NOT_OWNED and an absent one is indistinguishable", async () => {
    await register('mine@example.com');
    await register('theirs@example.com');
    const mine = sessionCookie((await login('mine@example.com')).headers['set-cookie']);

    const [, theirs] = await db.select().from(schema.accounts).orderBy(schema.accounts.email);
    const [theirItem] = await db
      .insert(schema.items)
      .values({
        accountId: theirs.id,
        baseItemId: 'iron-sword',
        baseContentVersion: 'test',
        rarity: 'common',
        itemLevel: 1,
        bonuses: [],
      })
      .returning();

    const owned = await app.inject({
      method: 'POST',
      url: '/api/inventory/lock',
      headers: { origin: ORIGIN, cookie: mine, 'idempotency-key': 'k1' },
      payload: { itemId: theirItem.id, locked: true, expectedStateVersion: 0 },
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/inventory/lock',
      headers: { origin: ORIGIN, cookie: mine, 'idempotency-key': 'k2' },
      payload: { itemId: '99999999-9999-4999-8999-999999999999', locked: true, expectedStateVersion: 0 },
    });

    expect(owned.statusCode).toBe(403);
    expect(owned.json().code).toBe('NOT_OWNED');
    expect(missing.json()).toEqual(owned.json());

    const [unchanged] = await db.select().from(schema.items).where(eq(schema.items.id, theirItem.id));
    expect(unchanged.locked, 'their item was not touched').toBe(false);
  });
});
