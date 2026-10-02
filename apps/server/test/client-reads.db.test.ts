/**
 * What the protocol client (milestone B Task 9) binds that the server did not
 * yet publish, each the smallest addition with its own ruling:
 *
 * - `GET /api/presets` and `PUT /api/presets/:id` (part 1 §3's table; R171):
 *   the Strategy screen's preset tabs and its Save preset command, wired to the
 *   `save-strategy-preset` command `hunt/commands.ts` already implements.
 * - `gold` on `GET /api/inventory` and `mapId` on `GET /api/hunts/current`
 *   (R172): the wallet and the zone the Hunt HUD binds instead of leaving out
 *   (part 4 §3.1, R108).
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { content, validateContent } from '@narok/data';
import { STARTER_LOOT_PRESET } from '@narok/loot';
import { defaultPlacement, defaultStrategy } from '@narok/sim';
import { createApp } from '../src/app';
import { compose } from '../src/compose';
import * as schema from '../src/db/schema';
import { connect, DATABASE_URL, databaseReachable, disconnect, insertCharacter, truncateAll, type Db } from './db-helpers';
import { sessionCookie } from './helpers';

let db: Db;
let app: FastifyInstance;
let close: () => Promise<void>;
let origin: string;

const validated = validateContent(content);
const PASSWORD = 'a-sufficiently-long-password';
const party = ['guardian', 'cleric', 'ranger'] as const;

beforeAll(async () => {
  expect(await databaseReachable(), 'PostgreSQL must be running: pnpm db:up').toBe(true);
  db = await connect();
});

afterAll(async () => {
  await disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  const composed = compose({ DATABASE_URL, NAROK_INSECURE_COOKIES: '1' });
  close = composed.close;
  origin = composed.deps.config!.allowedOrigins[0];
  app = await createApp(composed.deps);
});

afterEach(async () => {
  await app.close();
  await close();
});

interface Player {
  accountId: string;
  cookie: string;
}

async function player(email = `p-${crypto.randomUUID()}@example.com`): Promise<Player> {
  await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin }, payload: { email, password: PASSWORD } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { email, password: PASSWORD } });
  const cookie = sessionCookie(login.headers['set-cookie']);
  const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.email, email));
  return { accountId: account.id, cookie };
}

function strategyPayload(rest = { hpStart: 50, mpStart: 30 }) {
  return {
    placement: defaultPlacement([...party]),
    strategies: Object.fromEntries(party.map((id, index) => [`p${index}`, defaultStrategy(id)])),
    rest,
  };
}

async function setup(who: Player) {
  const characters = [];
  for (const [slot, classId] of party.entries()) {
    characters.push(await insertCharacter(db, who.accountId, { slot, classId }));
  }
  const [strategy] = await db
    .insert(schema.strategyPresets)
    .values({ accountId: who.accountId, name: 'Main', payload: strategyPayload(), payloadSchemaVersion: 1, gridHash: validated.gridHash })
    .returning();
  const [loot] = await db
    .insert(schema.lootPresets)
    .values({ accountId: who.accountId, name: 'Loot', payload: STARTER_LOOT_PRESET, payloadSchemaVersion: 1 })
    .returning();
  return { characterIds: characters.map((row) => row.id), strategyPresetId: strategy.id, lootPresetId: loot.id };
}

async function version(accountId: string): Promise<number> {
  const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
  return row.stateVersion;
}

function get(who: Player, url: string) {
  return app.inject({ method: 'GET', url, headers: { origin, cookie: who.cookie } });
}

function save(who: Player, id: string, body: Record<string, unknown>, key: string = crypto.randomUUID()) {
  return app.inject({
    method: 'PUT',
    url: `/api/presets/${id}`,
    headers: { origin, cookie: who.cookie, 'idempotency-key': key },
    payload: body,
  });
}

describe('GET /api/presets', () => {
  test('lists the account’s own strategy and loot presets with their versions and payloads', async () => {
    const me = await player();
    const other = await player();
    const refs = await setup(me);
    await setup(other);

    const response = await get(me, '/api/presets');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.strategy).toEqual([
      { id: refs.strategyPresetId, name: 'Main', presetVersion: 1, payloadSchemaVersion: 1, payload: strategyPayload() },
    ]);
    // Ruling R183: loot presets carry their payload, which the Bag screen's
    // filter pane shows and previews (part 4 §3.3).
    expect(body.loot).toEqual([
      { id: refs.lootPresetId, name: 'Loot', presetVersion: 1, payloadSchemaVersion: 1, payload: STARTER_LOOT_PRESET },
    ]);
    expect(body.stateVersion).toBe(await version(me.accountId));
  });

  test('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/presets', headers: { origin } });
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('PUT /api/presets/:id (Save preset)', () => {
  test('saves a new version of the payload and takes the account version', async () => {
    const me = await player();
    const refs = await setup(me);
    const expected = await version(me.accountId);
    const payload = strategyPayload({ hpStart: 70, mpStart: 40 });

    const response = await save(me, refs.strategyPresetId, { payload, payloadSchemaVersion: 1, expectedPresetVersion: 1, expectedStateVersion: expected });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ presetId: refs.strategyPresetId, presetVersion: 2, stateVersion: expected + 1 });

    const [row] = await db.select().from(schema.strategyPresets).where(eq(schema.strategyPresets.id, refs.strategyPresetId));
    expect(row.presetVersion).toBe(2);
    expect(row.payload).toEqual(payload);
  });

  test('does not touch a running hunt: its active strategy stays the version it started with', async () => {
    const me = await player();
    const refs = await setup(me);
    await app.inject({
      method: 'POST',
      url: '/api/hunts',
      headers: { origin, cookie: me.cookie, 'idempotency-key': crypto.randomUUID() },
      payload: { ...refs, mapId: 'prototype', expectedStateVersion: await version(me.accountId) },
    });
    const before = (await get(me, '/api/hunts/current')).json();

    await save(me, refs.strategyPresetId, {
      payload: strategyPayload({ hpStart: 10, mpStart: 10 }),
      payloadSchemaVersion: 1,
      expectedPresetVersion: 1,
      expectedStateVersion: await version(me.accountId),
    });

    const after = (await get(me, '/api/hunts/current')).json();
    expect(after.activeStrategy).toEqual({ presetId: refs.strategyPresetId, presetVersion: 1 });
    expect(after.pendingStrategy).toBeNull();
    expect(after.generation).toBe(before.generation);
  });

  test('a stale expected version is a recoverable conflict carrying the current version', async () => {
    const me = await player();
    const refs = await setup(me);
    const current = await version(me.accountId);
    const response = await save(me, refs.strategyPresetId, {
      payload: strategyPayload(),
      payloadSchemaVersion: 1,
      expectedPresetVersion: 1,
      expectedStateVersion: current + 3,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'CONFLICT_STATE_VERSION', stateVersion: current });
  });

  test('two saves from the same preset version: the second is a recoverable conflict naming the preset version', async () => {
    const me = await player();
    const refs = await setup(me);
    // Two tabs loaded preset v1; the first saves v2.
    const first = await save(me, refs.strategyPresetId, {
      payload: strategyPayload({ hpStart: 70, mpStart: 40 }),
      payloadSchemaVersion: 1,
      expectedPresetVersion: 1,
      expectedStateVersion: await version(me.accountId),
    });
    expect(first.json()).toMatchObject({ presetVersion: 2 });

    // The second still holds v1 and a fresh account version: the account
    // guard alone would pass, so only the preset guard can refuse it.
    const current = await version(me.accountId);
    const second = await save(me, refs.strategyPresetId, {
      payload: strategyPayload({ hpStart: 10, mpStart: 10 }),
      payloadSchemaVersion: 1,
      expectedPresetVersion: 1,
      expectedStateVersion: current,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'CONFLICT_STATE_VERSION', field: 'expectedPresetVersion', stateVersion: current });

    const [row] = await db.select().from(schema.strategyPresets).where(eq(schema.strategyPresets.id, refs.strategyPresetId));
    expect(row.presetVersion).toBe(2);
    expect(row.payload).toEqual(strategyPayload({ hpStart: 70, mpStart: 40 }));
    expect(await version(me.accountId)).toBe(current);
  });

  test('another account’s preset, an absent one and a malformed id all answer NOT_OWNED', async () => {
    const me = await player();
    const other = await player();
    await setup(me);
    const theirs = await setup(other);
    const expected = await version(me.accountId);
    for (const id of [theirs.strategyPresetId, crypto.randomUUID(), 'not-a-uuid']) {
      const response = await save(me, id, { payload: strategyPayload(), payloadSchemaVersion: 1, expectedPresetVersion: 1, expectedStateVersion: expected });
      expect(response.json(), id).toMatchObject({ code: 'NOT_OWNED', field: 'presetId' });
    }
  });

  test('a malformed payload, a smuggled field or a missing guard is a validation error and writes nothing', async () => {
    const me = await player();
    const refs = await setup(me);
    const expected = await version(me.accountId);
    for (const body of [
      { payload: { ...strategyPayload(), wipeLimit: 3 }, payloadSchemaVersion: 1, expectedPresetVersion: 1, expectedStateVersion: expected },
      { payload: strategyPayload(), payloadSchemaVersion: 2, expectedPresetVersion: 1, expectedStateVersion: expected },
      { payload: strategyPayload(), payloadSchemaVersion: 1, expectedPresetVersion: 1, expectedStateVersion: expected, seed: 1 },
      { payload: strategyPayload(), payloadSchemaVersion: 1, expectedPresetVersion: 1 },
      { payload: strategyPayload(), payloadSchemaVersion: 1, expectedStateVersion: expected },
    ]) {
      const response = await save(me, refs.strategyPresetId, body);
      expect(response.json(), JSON.stringify(Object.keys(body))).toMatchObject({ code: 'VALIDATION' });
    }
    expect(await version(me.accountId)).toBe(expected);
    const [row] = await db.select().from(schema.strategyPresets).where(eq(schema.strategyPresets.id, refs.strategyPresetId));
    expect(row.presetVersion).toBe(1);
  });

  test('a replayed save answers the same and saves once', async () => {
    const me = await player();
    const refs = await setup(me);
    const body = { payload: strategyPayload({ hpStart: 60, mpStart: 20 }), payloadSchemaVersion: 1, expectedPresetVersion: 1, expectedStateVersion: await version(me.accountId) };
    const first = await save(me, refs.strategyPresetId, body, 'same-key');
    const second = await save(me, refs.strategyPresetId, body, 'same-key');
    expect(second.json()).toEqual(first.json());
    const [row] = await db.select().from(schema.strategyPresets).where(eq(schema.strategyPresets.id, refs.strategyPresetId));
    expect(row.presetVersion).toBe(2);
  });
});

describe('the wallet and the zone (R172)', () => {
  test('GET /api/inventory carries the account’s gold', async () => {
    const me = await player();
    await db.update(schema.accounts).set({ gold: 1234 }).where(eq(schema.accounts.id, me.accountId));
    const response = await get(me, '/api/inventory');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ gold: 1234, capacity: expect.any(Number), usedSlots: expect.any(Number) });
  });

  test('GET /api/hunts/current names the map the hunt runs on', async () => {
    const me = await player();
    const refs = await setup(me);
    await app.inject({
      method: 'POST',
      url: '/api/hunts',
      headers: { origin, cookie: me.cookie, 'idempotency-key': crypto.randomUUID() },
      payload: { ...refs, mapId: 'prototype', expectedStateVersion: await version(me.accountId) },
    });
    expect((await get(me, '/api/hunts/current')).json()).toMatchObject({ mapId: 'prototype' });
  });
});
