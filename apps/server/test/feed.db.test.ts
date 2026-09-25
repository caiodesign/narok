/**
 * The lifecycle as the socket sees it: `LifecycleFeed` implements `HuntFeed`
 * over real checkpoints (part 2 §1 steps 2–6).
 *
 * What is proved here is the seam, not either side: a real hunt, settled and
 * committed by the lifecycle, streamed through a real `SocketSession`, never
 * trips the session's own release and schema checks — so nothing unelapsed,
 * nothing out of order and nothing outside `PublicState` reaches a client.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMessage } from '@narok/protocol';
import { content, validateContent } from '@narok/data';
import { createGrid, createSimulation, defaultPlacement, defaultStrategy, SimError } from '@narok/sim';
import { defaultConfig } from '../src/config';
import * as schema from '../src/db/schema';
import { defaultHuntConfig } from '../src/hunt/config';
import { decodeCheckpoint } from '../src/hunt/envelope';
import { LifecycleFeed, type FeedScheduler } from '../src/hunt/feed';
import { PrecomputeCache, persistHunt, startHunt, type HuntPlan, type LifecycleDeps } from '../src/hunt/lifecycle';
import { SegmentPool, inlineExecutor, type SegmentExecutor } from '../src/workers/pool';
import { SocketSession, socketBounds } from '../src/ws/socket';
import { connect, databaseReachable, disconnect, insertAccount, truncateAll, type Db } from './db-helpers';

let db: Db;

const validated = validateContent(content);
const sim = createSimulation(validated, createGrid(validated.grid, validated.shapes));
const classes = ['guardian', 'cleric', 'ranger'] as const;
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);

function plan(): HuntPlan {
  return {
    mapId: 'prototype',
    input: {
      classes: [...classes],
      recipe: 'mixed',
      placement: defaultPlacement([...classes]),
      strategies: Object.fromEntries(classes.map((id, index) => [`p${index}`, defaultStrategy(id)])),
      rest: { hpStart: 50, mpStart: 30 },
      wipeLimit: 1,
    },
    activeStrategy: { presetId: crypto.randomUUID(), presetVersion: 1 },
    activeLoot: { presetId: crypto.randomUUID(), presetVersion: 1 },
    inventoryProjection: { capacity: 100, usedSlots: 0, stackHeadroom: {} },
  };
}

/** A scheduler the test drives by hand, so no test sleeps. */
function manualScheduler() {
  const jobs = new Map<number, () => void>();
  let next = 0;
  const scheduler: FeedScheduler = (fn) => {
    const id = next++;
    jobs.set(id, fn);
    return () => jobs.delete(id);
  };
  return { scheduler, jobs };
}

function rig(executor?: SegmentExecutor) {
  const clock = { now: T0 };
  const lifecycle: LifecycleDeps = {
    db,
    sim,
    pins: {
      simulationVersion: 'b1',
      contentVersion: validated.version,
      gridHash: validated.gridHash,
    },
    config: defaultHuntConfig(),
    now: () => clock.now,
    drawSeed: () => 4_242,
    newHuntId: () => crypto.randomUUID(),
    pool: new SegmentPool(executor ?? inlineExecutor(sim)),
    precompute: new PrecomputeCache(),
  };
  const { scheduler, jobs } = manualScheduler();
  const feed = new LifecycleFeed({ lifecycle, retainedEvents: 5_000, releaseTickMs: 1_000, schedule: scheduler });
  return { clock, lifecycle, feed, jobs };
}

function socket(feed: LifecycleFeed, accountId: string) {
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

async function huntRow(accountId: string) {
  const [row] = await db.select().from(schema.hunts).where(eq(schema.hunts.accountId, accountId));
  return row;
}

async function accountVersion(accountId: string): Promise<number> {
  const [row] = await db
    .select({ stateVersion: schema.accounts.stateVersion })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  return row.stateVersion;
}

function envelopeOf(row: Awaited<ReturnType<typeof huntRow>>) {
  return decodeCheckpoint(Buffer.from(row.checkpoint).toString('utf8'));
}

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

describe('connect: settle, commit, then presence (step 2)', () => {
  test('an account with no hunt has no view', async () => {
    const account = await insertAccount(db);
    const { feed } = rig();
    expect(await feed.connect(account.id)).toBeUndefined();
  });

  test('a reconnect settles the time away and shows the state at that instant', async () => {
    const account = await insertAccount(db);
    const { clock, lifecycle, feed } = rig();
    await startHunt(lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });

    clock.now = T0 + 60_000;
    const view = await feed.connect(account.id);

    expect(view).toBeDefined();
    expect(view!.generation).toBe(1);
    expect(view!.releaseSimMs).toBe(60_000);
    expect(view!.state.nowMs, 'the state is at the release point, never ahead').toBe(60_000);
    expect(view!.events, 'offline time is folded into the snapshot, not replayed').toHaveLength(0);

    const envelope = envelopeOf(await huntRow(account.id));
    expect(envelope.checkpointSeq).toBe(1);
    expect(envelope.lastSeenAt).toBe(T0 + 60_000);
  });

  test('a faulted hunt answers HUNT_FAULTED, and the socket closes with it', async () => {
    const account = await insertAccount(db);
    const { clock, lifecycle, feed } = rig(async () => {
      throw new SimError('INVALID_STATE', 'x', 'injected');
    });
    await startHunt(lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });

    clock.now = T0 + 1_000;
    const { session, sent, closed } = socket(feed, account.id);
    await session.receive(JSON.stringify({ type: 'hello' }));

    expect(closed.code).toBe('HUNT_FAULTED');
    expect(sent.at(-1)).toMatchObject({ type: 'error', code: 'HUNT_FAULTED' });
    expect((await huntRow(account.id)).status).toBe('faulted');
  });
});

describe('release ticks write nothing (steps 3–4)', () => {
  test('a view between commits simulates a copy and leaves the database untouched', async () => {
    const account = await insertAccount(db);
    const { clock, lifecycle, feed } = rig();
    await startHunt(lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    await feed.connect(account.id);
    const before = await huntRow(account.id);
    const version = await accountVersion(account.id);

    clock.now = T0 + 5_000;
    const view = await feed.view(account.id);

    expect(view!.releaseSimMs).toBe(5_000);
    expect(view!.state.nowMs).toBe(5_000);
    expect(view!.events.length).toBeGreaterThan(0);
    for (const event of view!.events) expect(event.at).toBeLessThanOrEqual(5_000);

    expect(Buffer.from((await huntRow(account.id)).checkpoint).equals(Buffer.from(before.checkpoint))).toBe(true);
    expect(await accountVersion(account.id)).toBe(version);
  });

  test('a tick past the persist cadence commits, as step 6 requires', async () => {
    const account = await insertAccount(db);
    const { clock, lifecycle, feed } = rig();
    await startHunt(lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    await feed.connect(account.id);

    clock.now = T0 + lifecycle.config.persistCadenceMs - 1;
    await feed.tick(account.id);
    expect(envelopeOf(await huntRow(account.id)).checkpointSeq, 'inside the cadence: only the connect commit').toBe(1);

    clock.now = T0 + lifecycle.config.persistCadenceMs;
    await feed.tick(account.id);
    const envelope = envelopeOf(await huntRow(account.id));
    expect(envelope.checkpointSeq).toBe(2);
    expect(envelope.simAnchorMs).toBe(lifecycle.config.persistCadenceMs);
  });

  test('the ticker runs only while someone is subscribed', async () => {
    const account = await insertAccount(db);
    const { lifecycle, feed, jobs } = rig();
    await startHunt(lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });

    const first = feed.subscribe(account.id, () => {});
    const second = feed.subscribe(account.id, () => {});
    expect(jobs.size, 'one ticker per account, however many sockets').toBe(1);
    first();
    expect(jobs.size).toBe(1);
    second();
    expect(jobs.size).toBe(0);
  });
});

describe('heartbeat is a settlement (step 6)', () => {
  test('it commits the elapsed window and shows its events', async () => {
    const account = await insertAccount(db);
    const { clock, lifecycle, feed } = rig();
    await startHunt(lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    const connected = await feed.connect(account.id);

    clock.now = T0 + 30_000;
    const view = await feed.heartbeat(account.id);

    const envelope = envelopeOf(await huntRow(account.id));
    expect(envelope.checkpointSeq).toBe(2);
    expect(envelope.lastSeenAt).toBe(T0 + 30_000);
    expect(view!.releaseSimMs).toBe(30_000);
    expect(view!.baseSeq).toBe(connected!.baseSeq);
    const seqs = view!.events.map((event) => event.seq);
    expect(seqs[0]).toBe(view!.baseSeq);
    seqs.forEach((seq, index) => expect(seq).toBe(view!.baseSeq + index));
  });

  test('losing a race to another command keeps the socket, and the next heartbeat settles', async () => {
    const account = await insertAccount(db);
    const { clock, lifecycle, feed } = rig();
    await startHunt(lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    await feed.connect(account.id);

    // Another command commits between the heartbeat's read and its write.
    const racing = new LifecycleFeed({
      lifecycle: {
        ...lifecycle,
        hooks: {
          afterSegment: async () => {
            await db
              .update(schema.accounts)
              .set({ stateVersion: sql`${schema.accounts.stateVersion} + 1` })
              .where(eq(schema.accounts.id, account.id));
          },
        },
      },
      retainedEvents: 5_000,
      releaseTickMs: 1_000,
      schedule: manualScheduler().scheduler,
    });
    expect(await racing.connect(account.id), 'a lost race still answers').toBeDefined();

    clock.now = T0 + 10_000;
    const view = await racing.heartbeat(account.id);
    expect(view, 'a view is still returned').toBeDefined();
    expect(view!.state.nowMs).toBe(view!.releaseSimMs);

    // Undisturbed, the next heartbeat settles the whole window.
    clock.now = T0 + 12_000;
    await feed.heartbeat(account.id);
    expect(envelopeOf(await huntRow(account.id)).simAnchorMs).toBe(12_000);
  });

  test('a stopped hunt keeps answering with its final state and commits nothing', async () => {
    const account = await insertAccount(db);
    const { clock, lifecycle, feed } = rig();
    // A lone ranger wipes quickly under wipe limit 1.
    const solo: HuntPlan = {
      ...plan(),
      input: {
        ...plan().input,
        classes: ['ranger'],
        placement: defaultPlacement(['ranger']),
        strategies: { p0: defaultStrategy('ranger') },
      },
    };
    await startHunt(lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: solo });
    clock.now = T0 + 3_600_000;
    await persistHunt(lifecycle, account.id, { live: true });
    expect((await huntRow(account.id)).status).toBe('stopped');

    const view = await feed.connect(account.id);
    expect(view!.state.phase).toBe('stopped');
    expect(view!.releaseSimMs).toBe(view!.state.nowMs);
    expect(view!.releaseSimMs).toBeLessThan(3_600_000);
  });
});

describe('end to end through a real socket session', () => {
  test('hello, ticks and heartbeats stream an ordered, elapsed, gapless sequence', async () => {
    const account = await insertAccount(db);
    const { clock, lifecycle, feed } = rig();
    await startHunt(lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });

    const { session, sent, closed } = socket(feed, account.id);
    clock.now = T0 + 2_000;
    await session.receive(JSON.stringify({ type: 'hello' }));
    expect(sent[0]).toMatchObject({ type: 'snapshot', generation: 1 });

    for (let second = 3; second <= 45; second++) {
      clock.now = T0 + second * 1_000;
      if (second % 15 === 0) await session.receive(JSON.stringify({ type: 'heartbeat' }));
      else await feed.tick(account.id);
      await session.settled();
    }

    expect(closed.code, 'the session never refused the feed').toBeUndefined();
    const frames = sent.filter((message) => message.type === 'frame');
    expect(frames.length).toBeGreaterThan(10);

    const snapshot = sent[0] as Extract<ServerMessage, { type: 'snapshot' }>;
    let expected = snapshot.seq;
    for (const frame of frames) {
      if (frame.type !== 'frame') continue;
      expect(frame.firstSeq, 'no gap and no repeat between frames').toBe(expected);
      expected = frame.lastSeq + 1;
      expect(frame.state.nowMs).toBeGreaterThanOrEqual(frame.events.at(-1)!.at);
    }
    expect(expected - snapshot.seq).toBeGreaterThan(100);

    // The stream matches the engine run straight through, event for event.
    const straight = sim.advance(
      sim.start({ ...plan().input, seed: 4_242 }),
      45_000,
      { collect: 'events' },
    ).events.filter((event) => event.seq >= snapshot.seq && event.seq < expected);
    const streamed = frames.flatMap((frame) => (frame.type === 'frame' ? frame.events : []));
    expect(streamed).toEqual(straight);
  });
});
