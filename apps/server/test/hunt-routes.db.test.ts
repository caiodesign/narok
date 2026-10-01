/**
 * The hunt routes over a real database (part 1 §3's route table): start, read
 * and stop. Ownership comes before validation (P-12), the client names no
 * seed and no time (P-02, part 1 §2), and every answer is the projection.
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

const party = ['guardian', 'cleric', 'ranger'] as const;

function strategyPayload(overrides: Record<string, unknown> = {}) {
  return {
    placement: defaultPlacement([...party]),
    strategies: Object.fromEntries(party.map((id, index) => [`p${index}`, defaultStrategy(id)])),
    rest: { hpStart: 50, mpStart: 30 },
    ...overrides,
  };
}

async function setup(who: Player, payload: unknown = strategyPayload()) {
  const characters = [];
  for (const [slot, classId] of party.entries()) {
    characters.push(await insertCharacter(db, who.accountId, { slot, classId }));
  }
  const [strategy] = await db
    .insert(schema.strategyPresets)
    .values({ accountId: who.accountId, name: 'Main', payload, payloadSchemaVersion: 1, gridHash: validated.gridHash })
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

function start(who: Player, body: Record<string, unknown>, key: string = crypto.randomUUID()) {
  return app.inject({
    method: 'POST',
    url: '/api/hunts',
    headers: { origin, cookie: who.cookie, 'idempotency-key': key },
    payload: body,
  });
}

describe('POST /api/hunts', () => {
  test('starts a hunt from owned characters and presets and answers with the projection', async () => {
    const me = await player();
    const refs = await setup(me);

    const response = await start(me, { ...refs, mapId: 'prototype', expectedStateVersion: await version(me.accountId) });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ generation: 1, eventCursor: expect.any(Number) });
    expect(body.state.nowMs).toBe(0);
    const p0 = body.state.actors.find((actor: { id: string }) => actor.id === 'p0');
    expect(p0.definitionId, 'party order is the order the characters were named').toBe('guardian');
    for (const forbidden of ['"seed"', '"rng"', '"queue"', '"pendingRewards"']) {
      expect(response.body).not.toContain(forbidden);
    }

    const [row] = await db.select().from(schema.hunts).where(eq(schema.hunts.accountId, me.accountId));
    expect(row.status).toBe('running');
  });

  test('the preset carries the rest thresholds into the hunt, and no wipe limit (spec §4.0.1, ruling R154)', async () => {
    const me = await player();
    const refs = await setup(me, strategyPayload({ rest: { hpStart: 70, mpStart: 40 } }));
    await start(me, { ...refs, mapId: 'prototype', expectedStateVersion: await version(me.accountId) });

    const [row] = await db.select().from(schema.hunts).where(eq(schema.hunts.accountId, me.accountId));
    const envelope = JSON.parse(Buffer.from(row.checkpoint).toString('utf8'));
    const input = JSON.parse(envelope.state).input;
    expect(input).not.toHaveProperty('wipeLimit');
    expect(input.rest).toEqual({ hpStart: 70, mpStart: 40 });
    expect(envelope.activeStrategy).toEqual({ presetId: refs.strategyPresetId, presetVersion: 1 });
  });

  test('another account’s character, strategy or loot preset is NOT_OWNED', async () => {
    const me = await player();
    const other = await player();
    const mine = await setup(me);
    const theirs = await setup(other);
    const expected = await version(me.accountId);

    for (const [field, swapped] of [
      ['characterIds', { ...mine, characterIds: [theirs.characterIds[0], ...mine.characterIds.slice(1)] }],
      ['strategyPresetId', { ...mine, strategyPresetId: theirs.strategyPresetId }],
      ['lootPresetId', { ...mine, lootPresetId: theirs.lootPresetId }],
    ] as const) {
      const response = await start(me, { ...swapped, mapId: 'prototype', expectedStateVersion: expected });
      expect(response.json(), field).toMatchObject({ code: 'NOT_OWNED', field });
    }
  });

  test('a preset whose payload is malformed is a validation error, and writes nothing', async () => {
    const me = await player();
    const refs = await setup(me, strategyPayload({ rest: { hpStart: 99, mpStart: 0 } }));
    const response = await start(me, { ...refs, mapId: 'prototype', expectedStateVersion: await version(me.accountId) });
    expect(response.json()).toMatchObject({ code: 'VALIDATION', field: 'plan.input.rest.hpStart' });
    expect(await db.select().from(schema.hunts)).toHaveLength(0);
  });

  test('an unknown map is a validation error', async () => {
    const me = await player();
    const refs = await setup(me);
    const response = await start(me, { ...refs, mapId: 'nowhere', expectedStateVersion: await version(me.accountId) });
    expect(response.json()).toMatchObject({ code: 'VALIDATION', field: 'mapId' });
  });

  test('P-02: a client-supplied seed or snapshot is rejected, never accepted as state', async () => {
    const me = await player();
    const refs = await setup(me);
    const expected = await version(me.accountId);
    for (const smuggled of [{ seed: 1 }, { state: { nowMs: 999_999 } }, { snapshot: 'x' }]) {
      const response = await start(me, { ...refs, mapId: 'prototype', expectedStateVersion: expected, ...smuggled });
      expect(response.json()).toMatchObject({ code: 'VALIDATION' });
    }
    expect(await db.select().from(schema.hunts)).toHaveLength(0);
  });

  test('a stale expected version is a conflict carrying the current version', async () => {
    const me = await player();
    const refs = await setup(me);
    const current = await version(me.accountId);
    const response = await start(me, { ...refs, mapId: 'prototype', expectedStateVersion: current + 5 });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'CONFLICT_STATE_VERSION', stateVersion: current });
  });

  test('a replayed start answers the same and starts once', async () => {
    const me = await player();
    const refs = await setup(me);
    const body = { ...refs, mapId: 'prototype', expectedStateVersion: await version(me.accountId) };
    const first = await start(me, body, 'same-key');
    const second = await start(me, body, 'same-key');
    expect(second.json()).toEqual(first.json());
    expect(await version(me.accountId)).toBe(body.expectedStateVersion + 1);
  });
});

describe('GET /api/hunts/current and POST /api/hunts/current/stop', () => {
  test('the current hunt reads back as the projection; none reads as NOT_FOUND', async () => {
    const me = await player();
    const none = await app.inject({ method: 'GET', url: '/api/hunts/current', headers: { origin, cookie: me.cookie } });
    expect(none.json()).toMatchObject({ code: 'NOT_FOUND', field: 'hunt' });

    const refs = await setup(me);
    await start(me, { ...refs, mapId: 'prototype', expectedStateVersion: await version(me.accountId) });
    const current = await app.inject({ method: 'GET', url: '/api/hunts/current', headers: { origin, cookie: me.cookie } });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ generation: 1, status: 'running' });
    expect(current.body).not.toContain('"seed"');
  });

  test('stop returns to town, and a new hunt waits for the journey', async () => {
    const me = await player();
    const refs = await setup(me);
    await start(me, { ...refs, mapId: 'prototype', expectedStateVersion: await version(me.accountId) });

    const stopped = await app.inject({
      method: 'POST',
      url: '/api/hunts/current/stop',
      headers: { origin, cookie: me.cookie, 'idempotency-key': 'stop-1' },
      payload: {},
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ generation: 2, state: { phase: 'stopped' } });

    const again = await start(me, { ...refs, mapId: 'prototype', expectedStateVersion: await version(me.accountId) });
    expect(again.json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'hunt.travel' });
  });

  test('stop without an idempotency key is a validation error', async () => {
    const me = await player();
    const response = await app.inject({
      method: 'POST',
      url: '/api/hunts/current/stop',
      headers: { origin, cookie: me.cookie },
      payload: {},
    });
    expect(response.json()).toMatchObject({ code: 'VALIDATION', field: 'idempotency-key' });
  });

  test('every hunt route requires a session', async () => {
    for (const [method, url] of [
      ['POST', '/api/hunts'],
      ['GET', '/api/hunts/current'],
      ['POST', '/api/hunts/current/stop'],
      ['POST', '/api/hunts/current/loot'],
    ] as const) {
      const response = await app.inject({ method, url, headers: { origin }, payload: method === 'POST' ? {} : undefined });
      expect(response.json(), url).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });
});

describe('POST /api/hunts/current/strategy (apply next encounter)', () => {
  async function running(who: Player) {
    const refs = await setup(who);
    await start(who, { ...refs, mapId: 'prototype', expectedStateVersion: await version(who.accountId) });
    const [other] = await db
      .insert(schema.strategyPresets)
      .values({ accountId: who.accountId, name: 'Other', payload: strategyPayload({ rest: { hpStart: 40, mpStart: 20 } }), payloadSchemaVersion: 1, gridHash: validated.gridHash })
      .returning();
    return { refs, other };
  }

  function apply(who: Player, body: Record<string, unknown>, key: string = crypto.randomUUID()) {
    return app.inject({
      method: 'POST',
      url: '/api/hunts/current/strategy',
      headers: { origin, cookie: who.cookie, 'idempotency-key': key },
      payload: body,
    });
  }

  test('queues the preset for the next spawn and names active and pending versions separately', async () => {
    const me = await player();
    const { refs, other } = await running(me);
    const response = await apply(me, {
      presetId: other.id,
      presetVersion: 1,
      expectedGeneration: 1,
      expectedStateVersion: await version(me.accountId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      generation: 2,
      activeStrategy: { presetId: refs.strategyPresetId, presetVersion: 1 },
      pendingStrategy: { presetId: other.id, presetVersion: 1 },
    });

    const current = await app.inject({ method: 'GET', url: '/api/hunts/current', headers: { origin, cookie: me.cookie } });
    expect(current.json()).toMatchObject({ pendingStrategy: { presetId: other.id, presetVersion: 1 } });
  });

  test('a stale generation is a recoverable conflict carrying the current values', async () => {
    const me = await player();
    const { other } = await running(me);
    const current = await version(me.accountId);
    const response = await apply(me, { presetId: other.id, presetVersion: 1, expectedGeneration: 7, expectedStateVersion: current });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: 'CONFLICT_STATE_VERSION',
      field: 'expectedGeneration',
      retryable: true,
      stateVersion: current,
      generation: 1,
    });
  });

  test('another account’s preset is NOT_OWNED, and a missing generation guard is a validation error', async () => {
    const me = await player();
    const them = await player();
    await running(me);
    const { other: theirs } = await running(them);
    const foreign = await apply(me, { presetId: theirs.id, presetVersion: 1, expectedGeneration: 1, expectedStateVersion: await version(me.accountId) });
    expect(foreign.json()).toMatchObject({ code: 'NOT_OWNED', field: 'presetId' });

    const unguarded = await apply(me, { presetId: theirs.id, presetVersion: 1, expectedStateVersion: 0 });
    expect(unguarded.json()).toMatchObject({ code: 'VALIDATION', field: 'expectedGeneration' });
  });
});

describe('POST /api/hunts/current/loot (apply loot filter)', () => {
  const IGNORE_ALL = { exceptions: [], rarity: {}, fallback: { equipment: 'ignore', consumable: 'ignore' } };

  async function running(who: Player) {
    const refs = await setup(who);
    await start(who, { ...refs, mapId: 'prototype', expectedStateVersion: await version(who.accountId) });
    const [other] = await db
      .insert(schema.lootPresets)
      .values({ accountId: who.accountId, name: 'Ignore', payload: IGNORE_ALL, payloadSchemaVersion: 1 })
      .returning();
    return { refs, other };
  }

  function apply(who: Player, body: Record<string, unknown>, key: string = crypto.randomUUID()) {
    return app.inject({
      method: 'POST',
      url: '/api/hunts/current/loot',
      headers: { origin, cookie: who.cookie, 'idempotency-key': key },
      payload: body,
    });
  }

  test('applies the filter as a new generation and names the active loot version', async () => {
    const me = await player();
    const { refs, other } = await running(me);
    const response = await apply(me, {
      presetId: other.id,
      presetVersion: 1,
      expectedGeneration: 1,
      expectedStateVersion: await version(me.accountId),
    });
    expect(response.statusCode).toBe(200);
    // Nothing had dropped yet, so the filter governs from now on at once.
    expect(response.json()).toMatchObject({ generation: 2, activeLoot: { presetId: other.id, presetVersion: 1 }, pendingLoot: null });
    expect(refs.lootPresetId).not.toBe(other.id);

    const current = await app.inject({ method: 'GET', url: '/api/hunts/current', headers: { origin, cookie: me.cookie } });
    expect(current.json()).toMatchObject({ activeLoot: { presetId: other.id, presetVersion: 1 }, pendingLoot: null });
  });

  test('a stale generation is a recoverable conflict; another account’s preset is NOT_OWNED', async () => {
    const me = await player();
    const them = await player();
    const { other } = await running(me);
    const { other: theirs } = await running(them);
    const current = await version(me.accountId);
    const stale = await apply(me, { presetId: other.id, presetVersion: 1, expectedGeneration: 5, expectedStateVersion: current });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'CONFLICT_STATE_VERSION', field: 'expectedGeneration', generation: 1 });
    const foreign = await apply(me, { presetId: theirs.id, presetVersion: 1, expectedGeneration: 1, expectedStateVersion: current });
    expect(foreign.json()).toMatchObject({ code: 'NOT_OWNED', field: 'presetId' });
  });

  test('a start refuses a loot preset the evaluator cannot run, and writes nothing', async () => {
    const me = await player();
    const refs = await setup(me);
    await db
      .update(schema.lootPresets)
      .set({ payload: { exceptions: [{ when: { material: 'ore' }, action: 'keep' }], rarity: {}, fallback: { equipment: 'keep', consumable: 'keep' } } })
      .where(eq(schema.lootPresets.id, refs.lootPresetId));
    const response = await start(me, { ...refs, mapId: 'prototype', expectedStateVersion: await version(me.accountId) });
    expect(response.json()).toMatchObject({ code: 'VALIDATION', field: 'lootPreset.exceptions.0.when.material' });
    expect(await db.select().from(schema.hunts)).toHaveLength(0);
  });

  test('a start carries the account’s bad-luck counters into the hunt (layer-1 §4.5)', async () => {
    const me = await player();
    const refs = await setup(me);
    await db.insert(schema.accountDropProtection).values([
      { accountId: me.accountId, rewardTier: 'epicPlus', counter: 41 },
      { accountId: me.accountId, rewardTier: 'legendary', counter: 977 },
    ]);
    const response = await start(me, { ...refs, mapId: 'prototype', expectedStateVersion: await version(me.accountId) });
    expect(response.statusCode).toBe(200);
    const [row] = await db.select().from(schema.hunts).where(eq(schema.hunts.accountId, me.accountId));
    const envelope = JSON.parse(Buffer.from(row.checkpoint).toString('utf8')) as { state: string };
    expect((JSON.parse(envelope.state) as { dropProtection: unknown }).dropProtection).toEqual({ epicPlus: 41, legendary: 977 });
  });
});
