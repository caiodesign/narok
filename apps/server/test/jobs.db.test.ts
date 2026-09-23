/**
 * P-05: the periodic sweeps run as named jobs with a durable "last completed
 * at" record under an advisory lock, so a restart neither skips a sweep nor
 * runs one twice.
 *
 * The advisory lock is what makes the second part true. Part 1 §9 #11 records
 * the consequence plainly: scaling `api` past one instance requires revisiting
 * this, and the lock is what makes that revisit a choice rather than a
 * corruption.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { connect, databaseReachable, disconnect, insertAccount, truncateAll, type Db } from './db-helpers';
import { runPeriodicJob, sweepExpired } from '../src/db/jobs';
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

describe('runPeriodicJob', () => {
  test('records when it last completed, so a restart knows what it missed', async () => {
    const at = new Date('2026-09-22T10:00:00Z');
    const outcome = await runPeriodicJob(db, 'sweep-sessions', { now: () => at }, async () => 7);

    expect(outcome).toEqual({ ran: true, result: 7 });
    const [row] = await db.select().from(schema.periodicJobs).where(eq(schema.periodicJobs.name, 'sweep-sessions'));
    expect(row.lastCompletedAt?.toISOString()).toBe(at.toISOString());
    expect(row.lastError).toBeNull();
  });

  test('a failure is recorded and does not stamp a completion it never reached', async () => {
    await expect(
      runPeriodicJob(db, 'sweep-sessions', { now: () => new Date() }, async () => {
        throw new Error('the sweep blew up');
      }),
    ).rejects.toThrow(/the sweep blew up/);

    const [row] = await db.select().from(schema.periodicJobs).where(eq(schema.periodicJobs.name, 'sweep-sessions'));
    expect(row.lastCompletedAt, 'a failed run is not a completion').toBeNull();
    expect(row.lastError).toContain('the sweep blew up');
  });

  test('a later successful run clears the recorded error', async () => {
    await runPeriodicJob(db, 'sweep-sessions', { now: () => new Date() }, async () => {
      throw new Error('first attempt failed');
    }).catch(() => undefined);

    await runPeriodicJob(db, 'sweep-sessions', { now: () => new Date() }, async () => 1);

    const [row] = await db.select().from(schema.periodicJobs).where(eq(schema.periodicJobs.name, 'sweep-sessions'));
    expect(row.lastError).toBeNull();
    expect(row.lastCompletedAt).not.toBeNull();
  });

  test('two runners cannot execute the same job at once', async () => {
    let concurrent = 0;
    let observedOverlap = false;

    const body = async (): Promise<number> => {
      concurrent += 1;
      if (concurrent > 1) observedOverlap = true;
      await new Promise((resolve) => setTimeout(resolve, 40));
      concurrent -= 1;
      return 1;
    };

    const outcomes = await Promise.all([
      runPeriodicJob(db, 'sweep-sessions', { now: () => new Date() }, body),
      runPeriodicJob(db, 'sweep-sessions', { now: () => new Date() }, body),
    ]);

    expect(observedOverlap, 'the advisory lock kept them apart').toBe(false);
    // The loser skips rather than queueing: a sweep that already ran this tick
    // does not need to run again immediately.
    expect(outcomes.filter((outcome) => outcome.ran)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ran)).toHaveLength(1);
  });

  test('different jobs do not block each other', async () => {
    const outcomes = await Promise.all([
      runPeriodicJob(db, 'sweep-sessions', { now: () => new Date() }, async () => 'a'),
      runPeriodicJob(db, 'sweep-commands', { now: () => new Date() }, async () => 'b'),
    ]);
    expect(outcomes.every((outcome) => outcome.ran)).toBe(true);
  });
});

describe('sweepExpired', () => {
  test('drops expired sessions, command results and reports, and keeps live ones', async () => {
    const account = await insertAccount(db);
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    await db.insert(schema.sessions).values([
      { accountId: account.id, tokenHash: 'dead', createdAt: 0, expiresAt: Date.now() - 1_000, lastSeenAt: 0 },
      { accountId: account.id, tokenHash: 'live', createdAt: 0, expiresAt: Date.now() + 60_000, lastSeenAt: 0 },
    ]);
    await db.insert(schema.commandResults).values([
      { accountId: account.id, idempotencyKey: 'old', operation: 'x', requestHash: 'h', response: {}, stateVersionAfter: 0, expiresAt: past },
      { accountId: account.id, idempotencyKey: 'new', operation: 'x', requestHash: 'h', response: {}, stateVersionAfter: 0, expiresAt: future },
    ]);
    await db.insert(schema.huntReports).values([
      { accountId: account.id, generation: 1, payload: {}, expiresAt: past },
      { accountId: account.id, generation: 2, payload: {}, expiresAt: future },
    ]);

    const removed = await sweepExpired(db, new Date());

    expect(removed).toEqual({ sessions: 1, commandResults: 1, reports: 1 });
    expect((await db.select().from(schema.sessions)).map((row) => row.tokenHash)).toEqual(['live']);
    expect((await db.select().from(schema.commandResults)).map((row) => row.idempotencyKey)).toEqual(['new']);
    expect((await db.select().from(schema.huntReports)).map((row) => row.generation)).toEqual([2]);
  });

  test('never touches the audit trail, whose retention is the whole beta', async () => {
    const account = await insertAccount(db);
    await db.insert(schema.resourceAudit).values({
      accountId: account.id,
      reason: 'kill-reward',
      sourceRef: 'hunt:1:1',
      delta: {},
      stateVersionAfter: 1,
      occurredAt: new Date('2020-01-01T00:00:00Z'),
    });

    await sweepExpired(db, new Date());

    expect(await db.select().from(schema.resourceAudit), 'audit rows outlive every sweep').toHaveLength(1);
  });
});
