/**
 * The freeze as the running server honours it (part 1 §6 step 1; part 2 §7
 * step 1; gate B-28; ruling R206): while `maintenance.frozen` is set, every
 * gameplay command — REST and socket — answers `MAINTENANCE`, every read keeps
 * answering, and `resume` lifts it. The flag is the database row, so this
 * process learns of a freeze another process (the operator command) set.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMessage } from '@narok/protocol';
import { content, validateContent } from '@narok/data';
import { STARTER_LOOT_PRESET } from '@narok/loot';
import { defaultPlacement, defaultStrategy } from '@narok/sim';
import { createApp } from '../src/app';
import { compose } from '../src/compose';
import { defaultConfig } from '../src/config';
import * as schema from '../src/db/schema';
import { startHunt, type LifecycleDeps } from '../src/hunt/lifecycle';
import { freeze, resumeAll, settleAll } from '../src/ops/maintenance';
import { SocketSession, socketBounds } from '../src/ws/socket';
import { connect, DATABASE_URL, databaseReachable, disconnect, insertAccount, insertCharacter, truncateAll, type Db } from './db-helpers';
import { sessionCookie } from './helpers';
import { plan, rig } from './hunt-db-harness';

let db: Db;
let app: FastifyInstance;
let close: () => Promise<void>;
let origin: string;
let lifecycle: LifecycleDeps;

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
  lifecycle = composed.deps.hunts!.lifecycle;
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

async function player(): Promise<Player> {
  const email = `p-${crypto.randomUUID()}@example.com`;
  await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin }, payload: { email, password: PASSWORD } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { email, password: PASSWORD } });
  const cookie = sessionCookie(login.headers['set-cookie']);
  const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.email, email));
  return { accountId: account.id, cookie };
}

async function setup(who: Player) {
  const characters = [];
  for (const [slot, classId] of party.entries()) {
    characters.push(await insertCharacter(db, who.accountId, { slot, classId }));
  }
  const payload = {
    placement: defaultPlacement([...party]),
    strategies: Object.fromEntries(party.map((id, index) => [`p${index}`, defaultStrategy(id)])),
    rest: { hpStart: 50, mpStart: 30 },
  };
  const [strategy] = await db
    .insert(schema.strategyPresets)
    .values({ accountId: who.accountId, name: 'Main', payload, payloadSchemaVersion: 1, gridHash: validated.gridHash })
    .returning();
  const [loot] = await db
    .insert(schema.lootPresets)
    .values({ accountId: who.accountId, name: 'Loot', payload: STARTER_LOOT_PRESET, payloadSchemaVersion: 1 })
    .returning();
  return { characterIds: characters.map((row) => row.id), strategyPresetId: strategy.id, lootPresetId: loot.id, payload };
}

async function version(accountId: string): Promise<number> {
  const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
  return row.stateVersion;
}

function call(who: Player, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { origin, cookie: who.cookie, ...(method === 'GET' ? {} : { 'idempotency-key': crypto.randomUUID() }) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

describe('a freeze refuses every gameplay command and keeps every read (R206)', () => {
  test('hunt, preset and town commands answer MAINTENANCE and commit nothing; resume lifts it', async () => {
    const me = await player();
    const refs = await setup(me);
    const started = await call(me, 'POST', '/api/hunts', {
      characterIds: refs.characterIds,
      strategyPresetId: refs.strategyPresetId,
      lootPresetId: refs.lootPresetId,
      mapId: 'prototype',
      expectedStateVersion: await version(me.accountId),
    });
    expect(started.statusCode).toBe(200);

    await freeze(lifecycle, Date.now(), 'test');
    const at = await version(me.accountId);
    const [before] = await db.select().from(schema.hunts).where(eq(schema.hunts.accountId, me.accountId));

    const commands: Array<[method: 'POST' | 'PUT', url: string, body: unknown]> = [
      ['POST', '/api/hunts', {
        characterIds: refs.characterIds,
        strategyPresetId: refs.strategyPresetId,
        lootPresetId: refs.lootPresetId,
        mapId: 'prototype',
        expectedStateVersion: at,
      }],
      ['POST', '/api/hunts/current/stop', {}],
      ['POST', '/api/hunts/current/strategy', {
        presetId: refs.strategyPresetId, presetVersion: 1, expectedGeneration: 1, expectedStateVersion: at,
      }],
      ['POST', '/api/hunts/current/loot', {
        presetId: refs.lootPresetId, presetVersion: 1, expectedGeneration: 1, expectedStateVersion: at,
      }],
      ['PUT', `/api/presets/${refs.strategyPresetId}`, {
        payload: refs.payload, payloadSchemaVersion: 1, expectedPresetVersion: 1, expectedStateVersion: at,
      }],
      ['POST', '/api/characters', { slot: 2, name: 'Frozen', classId: 'ranger', expectedStateVersion: at }],
    ];
    for (const [method, url, body] of commands) {
      const refused = await call(me, method, url, body);
      expect(refused.statusCode, `${method} ${url}`).toBe(503);
      expect(refused.json(), `${method} ${url}`).toEqual({ code: 'MAINTENANCE', field: 'maintenance', retryable: true });
    }

    expect(await version(me.accountId), 'no refused command committed').toBe(at);
    const [after] = await db.select().from(schema.hunts).where(eq(schema.hunts.accountId, me.accountId));
    expect(Buffer.from(after.checkpoint).equals(Buffer.from(before.checkpoint)), 'the hunt is untouched').toBe(true);
    const created = await db.select().from(schema.characters).where(eq(schema.characters.accountId, me.accountId));
    expect(created).toHaveLength(3);

    for (const url of ['/api/hunts/current', '/api/presets', '/api/characters', '/api/inventory', '/api/me']) {
      expect((await call(me, 'GET', url)).statusCode, `GET ${url} while frozen`).toBe(200);
    }

    await settleAll(lifecycle);
    const resumed = await resumeAll(lifecycle, Date.now());
    expect(resumed.lifted).toBe(true);
    const stopped = await call(me, 'POST', '/api/hunts/current/stop', {});
    expect(stopped.statusCode, 'commands are accepted again once resume lifts the freeze').toBe(200);
  });

  test('a lifted freeze refuses nothing', async () => {
    const me = await player();
    await freeze(lifecycle, Date.now(), 'test');
    const resumed = await resumeAll(lifecycle, Date.now());
    expect(resumed.lifted).toBe(true);

    const created = await call(me, 'POST', '/api/characters', {
      slot: 0, name: 'Thawed', classId: 'ranger', expectedStateVersion: await version(me.accountId),
    });
    expect(created.statusCode).toBe(200);
  });
});

describe('the socket under a freeze (R206)', () => {
  function socket(feed: ReturnType<typeof rig>['feed'], accountId: string) {
    const sent: ServerMessage[] = [];
    const closed: { code?: string } = {};
    const session = new SocketSession({
      accountId,
      feed,
      authorize: async () => true,
      bounds: { ...socketBounds(defaultConfig()), unackedEvents: 100_000 },
      transport: {
        send: (message) => sent.push(message),
        close: (code) => {
          closed.code = code;
        },
      },
    });
    return { session, sent, closed };
  }

  test('a hello settles nothing and closes with MAINTENANCE', async () => {
    const account = await insertAccount(db);
    const r = rig(db);
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    r.clock.now += 30_000;
    await freeze(r.lifecycle, r.clock.now, 'test');
    const at = await version(account.id);

    const client = socket(r.feed, account.id);
    await client.session.receive(JSON.stringify({ type: 'hello' }));

    expect(client.sent).toEqual([{ type: 'error', generation: 0, code: 'MAINTENANCE', field: 'maintenance' }]);
    expect(client.closed.code).toBe('MAINTENANCE');
    expect(await version(account.id), 'the connect settlement did not commit').toBe(at);
  });

  test('a heartbeat on an open socket settles nothing once frozen and closes with MAINTENANCE', async () => {
    const account = await insertAccount(db);
    const r = rig(db);
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    const client = socket(r.feed, account.id);
    await client.session.receive(JSON.stringify({ type: 'hello' }));
    expect(client.closed.code).toBeUndefined();

    r.clock.now += 60_000;
    await freeze(r.lifecycle, r.clock.now, 'test');
    const at = await version(account.id);
    await client.session.receive(JSON.stringify({ type: 'heartbeat' }));

    expect(client.sent.at(-1)).toMatchObject({ type: 'error', code: 'MAINTENANCE', field: 'maintenance' });
    expect(client.closed.code).toBe('MAINTENANCE');
    expect(await version(account.id), 'the heartbeat settlement did not commit').toBe(at);
  });
});
