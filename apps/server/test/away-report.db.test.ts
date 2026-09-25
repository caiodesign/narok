/**
 * The away report over the real database (milestone B spec part 2 §1 step 2;
 * UI spec §8; B-17, B-18): a reconnect settles, commits, refreshes presence,
 * then builds the report from the committed deltas and announces it. Reading
 * it — once, again, or after a refresh — credits nothing.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMessage } from '@narok/protocol';
import { createApp } from '../src/app';
import { defaultConfig } from '../src/config';
import * as schema from '../src/db/schema';
import { startHunt } from '../src/hunt/lifecycle';
import { readAwayReport } from '../src/reports/away';
import { memoryStores } from '../src/store/memory';
import { SocketSession, socketBounds } from '../src/ws/socket';
import { connect, databaseReachable, disconnect, insertAccount, truncateAll, type Db } from './db-helpers';
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

async function reports(accountId: string) {
  return db.select().from(schema.huntReports).where(eq(schema.huntReports.accountId, accountId));
}

describe('a reconnect after an absence produces one report from the committed deltas', () => {
  test('time away and simulated duration are separate, and the report matches the committed checkpoint', async () => {
    const account = await insertAccount(db);
    const r = rig(db, { config: { offlineCapMs: 60_000 } });
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan({ wipeLimit: 5 }) });

    // Five minutes away under a one-minute recorded cap.
    r.clock.now = T0 + 300_000;
    const view = await r.feed.connect(account.id);
    expect(view?.reportId).toBeDefined();

    const report = await readAwayReport(db, account.id, view!.reportId!);
    expect(report.status).toBe('capped');
    expect(report.timeAwayMs).toBe(300_000);
    expect(report.simulatedMs).toBe(60_000);
    expect(report.stopReason).toBeNull();
    expect(report.actions).toEqual(['view-hunt']);

    // Presence was refreshed after the commit the report describes.
    const row = await huntRow(db, account.id);
    expect(row.lastSeenAt.getTime()).toBe(T0 + 300_000);
    expect(report.generation).toBe(row.generation);
  });

  test('a hunt the engine stopped while away reports the stop and the restart action', async () => {
    const account = await insertAccount(db);
    const r = rig(db);
    // Seed 4,242 with no resting and one allowed wipe falls at 142,387 ms.
    await startHunt(r.lifecycle, {
      accountId: account.id,
      expectedStateVersion: 0,
      plan: plan({ wipeLimit: 1, rest: { hpStart: 0, mpStart: 0 } }),
    });

    r.clock.now = T0 + 3_600_000;
    const view = await r.feed.connect(account.id);
    const report = await readAwayReport(db, account.id, view!.reportId!);
    expect(report.status).toBe('stopped');
    expect(report.stopReason).toBe('wipe-limit');
    expect(report.copyKey).toBe('away.stopped.wipe-limit');
    expect(report.actions).toEqual(['start-hunt']);
    expect(report.timeAwayMs).toBe(3_600_000);
    expect(report.simulatedMs).toBe(142_387);
    expect(report.accrualEndedAtWall).toBe(T0 + 142_387);
    expect(report.uncovered).toEqual({ afterStopMs: 3_600_000 - 142_387, afterCapMs: 0 });
    expect(report.outcomes.wipes).toBe(1);
    expect((await huntRow(db, account.id)).status).toBe('stopped');
  });

  test('only the latest report is retained (part 4 §3.5, option a)', async () => {
    const account = await insertAccount(db);
    const r = rig(db);
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan({ wipeLimit: 5 }) });
    r.clock.now = T0 + 60_000;
    const first = await r.feed.connect(account.id);
    r.clock.now = T0 + 120_000;
    // A second socket connecting with nobody streaming: a fresh report.
    const rigAgain = rig(db);
    rigAgain.clock.now = r.clock.now;
    const second = await rigAgain.feed.connect(account.id);
    expect(second?.reportId).not.toBe(first?.reportId);
    const rows = await reports(account.id);
    expect(rows.map((row) => row.id)).toEqual([second!.reportId]);
  });

  test('the socket announces the report after the snapshot it describes', async () => {
    const account = await insertAccount(db);
    const r = rig(db);
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan({ wipeLimit: 5 }) });
    r.clock.now = T0 + 90_000;

    const sent: ServerMessage[] = [];
    const session = new SocketSession({
      accountId: account.id,
      feed: r.feed,
      authorize: async () => true,
      bounds: { ...socketBounds(defaultConfig()), unackedEvents: 100_000 },
      transport: { send: (message) => sent.push(message), close: () => undefined },
    });
    await session.receive(JSON.stringify({ type: 'hello' }));

    expect(sent.map((message) => message.type)).toEqual(['snapshot', 'report']);
    const [row] = await reports(account.id);
    expect(sent[1]).toMatchObject({ type: 'report', generation: 1, reportId: row.id });
  });
});

describe('reading a report credits nothing (B-17)', () => {
  let app: FastifyInstance;

  test('opening, reopening and refreshing it leave the account and the hunt byte-identical', async () => {
    const stores = memoryStores();
    const r = rig(db);
    app = await createApp({ stores, hunts: { lifecycle: r.lifecycle } });
    try {
      const email = `p-${crypto.randomUUID()}@example.com`;
      const origin = defaultConfig().allowedOrigins[0];
      await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin }, payload: { email, password: 'a-sufficiently-long-password' } });
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { email, password: 'a-sufficiently-long-password' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const me = await app.inject({ method: 'GET', url: '/api/me', headers: { origin, cookie } });
      const accountId = (me.json() as { id: string }).id;

      // The memory store's account is mirrored into the database for the hunt.
      await insertAccount(db, { id: accountId });
      await startHunt(r.lifecycle, { accountId, expectedStateVersion: 0, plan: plan({ wipeLimit: 5 }) });
      r.clock.now = T0 + 45_000;
      const view = await r.feed.connect(accountId);
      const reportId = view!.reportId!;

      const before = await huntRow(db, accountId);
      const version = await accountVersion(db, accountId);
      const reads = [];
      for (let i = 0; i < 3; i++) {
        r.clock.now += 10_000;
        const response = await app.inject({ method: 'GET', url: `/api/reports/${reportId}`, headers: { origin, cookie } });
        expect(response.statusCode).toBe(200);
        reads.push(response.json());
      }
      expect(reads[1]).toEqual(reads[0]);
      expect(reads[2]).toEqual(reads[0]);
      expect(Buffer.from((await huntRow(db, accountId)).checkpoint).equals(Buffer.from(before.checkpoint))).toBe(true);
      expect(await accountVersion(db, accountId)).toBe(version);

      // Another account's report reads exactly as a missing one does (P-12).
      const stranger = await insertAccount(db);
      const [theirs] = await db
        .insert(schema.huntReports)
        .values({ accountId: stranger.id, generation: 1, payload: {}, expiresAt: new Date(T0 + 86_400_000) })
        .returning();
      const foreign = await app.inject({ method: 'GET', url: `/api/reports/${theirs.id}`, headers: { origin, cookie } });
      const missing = await app.inject({ method: 'GET', url: `/api/reports/${crypto.randomUUID()}`, headers: { origin, cookie } });
      expect(foreign.statusCode).toBe(missing.statusCode);
      expect(foreign.json()).toEqual(missing.json());
    } finally {
      await app.close();
    }
  });
});

describe('a report that cannot be stored (review fix)', () => {
  test('is logged with the account and hunt, and the connection carries on without it', async () => {
    const account = await insertAccount(db);
    const lines: string[] = [];
    const r = rig(db, {
      feed: {
        onLog: (line) => lines.push(line),
        recordReport: async () => {
          throw new Error('injected: report insert failed');
        },
      },
    });
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan({ wipeLimit: 5 }) });
    r.clock.now = T0 + 90_000;

    const sent: ServerMessage[] = [];
    let closedWith: string | undefined;
    const session = new SocketSession({
      accountId: account.id,
      feed: r.feed,
      authorize: async () => true,
      bounds: { ...socketBounds(defaultConfig()), unackedEvents: 100_000 },
      transport: { send: (message) => sent.push(message), close: (code) => (closedWith = code) },
    });
    await session.receive(JSON.stringify({ type: 'hello' }));

    const { huntId } = await checkpointOf(db, account.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`account=${account.id}`);
    expect(lines[0]).toContain(`hunt=${huntId}`);
    expect(lines[0]).toContain('injected: report insert failed');

    // The settlement stands, the snapshot went out, no report was announced, the socket is open.
    expect(sent.map((message) => message.type)).toEqual(['snapshot']);
    expect(closedWith).toBeUndefined();
    expect((await huntRow(db, account.id)).lastSeenAt.getTime()).toBe(T0 + 90_000);
    expect(await reports(account.id)).toEqual([]);

    // And the socket keeps serving: a heartbeat still settles and answers.
    r.clock.now = T0 + 95_000;
    await session.receive(JSON.stringify({ type: 'heartbeat' }));
    expect(closedWith).toBeUndefined();
    expect((await huntRow(db, account.id)).lastSeenAt.getTime()).toBe(T0 + 95_000);
  });
});
