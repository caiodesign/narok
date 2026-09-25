/**
 * The hunt lifecycle over a real database (milestone B spec part 2 §1):
 * start (B-L01), precompute (step 3), persist (step 6), recovery (B-25) and
 * the faulted hunt (P-38, B-30).
 *
 * Stop and the travel segment land with the B stop vocabulary and are tested
 * with it; this file is about who writes what, when, and what survives a
 * failure in between.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { content, validateContent } from '@narok/data';
import { createGrid, createSimulation, defaultPlacement, defaultStrategy, SimError } from '@narok/sim';
import * as schema from '../src/db/schema';
import { AppError } from '../src/errors';
import { decodeCheckpoint } from '../src/hunt/envelope';
import {
  PrecomputeCache,
  drawHuntSeed,
  persistHunt,
  precomputeHunt,
  readHunt,
  recoverFaultedHunt,
  startHunt,
  type HuntPlan,
  type LifecycleDeps,
} from '../src/hunt/lifecycle';
import { defaultHuntConfig, validateHuntConfig } from '../src/hunt/config';
import { SegmentPool, inlineExecutor, type SegmentExecutor } from '../src/workers/pool';
import { runSegment } from '../src/workers/segment';
import { connect, databaseReachable, disconnect, insertAccount, truncateAll, type Db } from './db-helpers';

let db: Db;

const validated = validateContent(content);
const sim = createSimulation(validated, createGrid(validated.grid, validated.shapes));
const classes = ['guardian', 'cleric', 'ranger'] as const;

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);

function plan(overrides: Partial<HuntPlan['input']> = {}): HuntPlan {
  return {
    mapId: 'prototype',
    input: {
      classes: [...classes],
      recipe: 'mixed',
      placement: defaultPlacement([...classes]),
      strategies: Object.fromEntries(classes.map((id, index) => [`p${index}`, defaultStrategy(id)])),
      rest: { hpStart: 50, mpStart: 30 },
      wipeLimit: 1,
      ...overrides,
    },
    activeStrategy: { presetId: crypto.randomUUID(), presetVersion: 1 },
    activeLoot: { presetId: crypto.randomUUID(), presetVersion: 1 },
    inventoryProjection: { capacity: 100, usedSlots: 0, stackHeadroom: {} },
  };
}

interface Harness {
  deps: LifecycleDeps;
  clock: { now: number };
  executorCalls: number;
}

function harness(overrides: Partial<LifecycleDeps> = {}, executor?: SegmentExecutor): Harness {
  const clock = { now: T0 };
  const state = { executorCalls: 0 };
  const inner = executor ?? inlineExecutor(sim);
  const counted: SegmentExecutor = (request) => {
    state.executorCalls += 1;
    return inner(request);
  };
  const deps: LifecycleDeps = {
    db,
    sim,
    pins: { simulationVersion: sim.start(withSeed(plan(), 1)).simulationVersion, contentVersion: validated.version, gridHash: validated.gridHash },
    config: defaultHuntConfig(),
    now: () => clock.now,
    drawSeed: () => 12_345,
    newHuntId: () => crypto.randomUUID(),
    pool: new SegmentPool(counted),
    precompute: new PrecomputeCache(),
    ...overrides,
  };
  return {
    deps,
    clock,
    get executorCalls() {
      return state.executorCalls;
    },
  } as Harness;
}

function withSeed(huntPlan: HuntPlan, seed: number) {
  return { ...huntPlan.input, seed };
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

async function rejection(run: () => Promise<unknown>): Promise<{ code: string; field: string }> {
  try {
    await run();
  } catch (error) {
    const record = error as { code?: string; field?: string };
    return { code: record.code ?? 'unknown', field: record.field ?? '$' };
  }
  throw new Error('expected a rejection');
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

describe('configuration: proposed defaults, each with a refusal', () => {
  test('the proposed defaults of part 2 §1 validate', () => {
    const config = defaultHuntConfig();
    expect(config.persistCadenceMs).toBe(20_000);
    expect(config.precomputeHorizonMs).toBe(30_000);
    expect(config.offlineCapMs).toBe(43_200_000);
    expect(() => validateHuntConfig(config)).not.toThrow();
  });

  test.each([
    ['persistCadenceMs', 0],
    ['precomputeHorizonMs', -1],
    ['offlineCapMs', 1.5],
    ['maxCheckpointBytes', 0],
  ] as const)('%s = %s is refused at startup, not degraded at runtime', (key, value) => {
    expect(() => validateHuntConfig({ ...defaultHuntConfig(), [key]: value })).toThrowError(RangeError);
  });
});

describe('the hunt seed is the server\'s', () => {
  test('a CSPRNG draw of zero is redrawn, because the engine rejects a zero seed', () => {
    const draws = [0, 0, 77];
    expect(drawHuntSeed(() => draws.shift() ?? 1)).toBe(77);
  });

  test('the default draw is a nonzero u32', () => {
    for (let index = 0; index < 100; index++) {
      const seed = drawHuntSeed();
      expect(Number.isInteger(seed) && seed > 0 && seed <= 0xffff_ffff).toBe(true);
    }
  });
});

describe('step 1: start', () => {
  test('records T0 as the anchor, generation 1, reward sequence 0, and a running row', async () => {
    const account = await insertAccount(db);
    const { deps } = harness();

    const started = await startHunt(deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });

    const row = await huntRow(account.id);
    expect(row.status).toBe('running');
    expect(row.generation).toBe(1);
    expect(row.simAnchorMs).toBe(0);
    expect(row.wallAnchorAt.getTime()).toBe(T0);

    const envelope = decodeCheckpoint(Buffer.from(row.checkpoint).toString('utf8'));
    expect(envelope).toMatchObject({
      accountId: account.id,
      huntId: started.huntId,
      generation: 1,
      checkpointSeq: 0,
      wallAnchorMs: T0,
      simAnchorMs: 0,
      lastSeenAt: T0,
      pausedWallMs: 0,
      rewardSeq: 0,
      pendingRewards: [],
      stopContext: null,
    });
    expect(sim.decode(envelope.state).input.seed, 'the seed is persisted in the checkpoint').toBe(12_345);
    expect(started.stateVersion).toBe(1);
    expect(await accountVersion(account.id)).toBe(1);
  });

  test('the response is the projection: no seed, no rng, no queue, no pending rewards (B-08)', async () => {
    const account = await insertAccount(db);
    const { deps } = harness();
    const started = await startHunt(deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });

    const text = JSON.stringify(started);
    for (const forbidden of ['"seed"', '"rng"', '"queue"', '"pendingRewards"', '12345']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(started.generation).toBe(1);
    expect(started.state.nowMs).toBe(0);
  });

  test('B-L01: a commit failure leaves no hunts row and no idempotency result', async () => {
    const account = await insertAccount(db);
    const { deps } = harness({
      hooks: {
        beforeCommit: () => {
          throw new Error('injected commit failure');
        },
      },
    });

    await expect(
      startHunt(deps, {
        accountId: account.id,
        expectedStateVersion: 0,
        plan: plan(),
        idempotency: { key: 'start-1', requestHash: 'h' },
      }),
    ).rejects.toThrow('injected commit failure');

    expect(await huntRow(account.id)).toBeUndefined();
    expect(await db.select().from(schema.commandResults)).toHaveLength(0);
    expect(await accountVersion(account.id)).toBe(0);
  });

  test('an invalid plan is a validation error and writes nothing', async () => {
    const account = await insertAccount(db);
    const { deps } = harness();

    const refused = await rejection(() =>
      startHunt(deps, { accountId: account.id, expectedStateVersion: 0, plan: plan({ wipeLimit: 0 }) }),
    );
    expect(refused.code).toBe('VALIDATION');
    expect(await huntRow(account.id)).toBeUndefined();
  });

  test('a second start while one is running is a rule violation and changes nothing', async () => {
    const account = await insertAccount(db);
    const { deps } = harness();
    await startHunt(deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    const before = await huntRow(account.id);

    const refused = await rejection(() =>
      startHunt(deps, { accountId: account.id, expectedStateVersion: 1, plan: plan() }),
    );
    expect(refused).toEqual({ code: 'RULE_VIOLATION', field: 'hunt.status' });
    expect(Buffer.from((await huntRow(account.id)).checkpoint).equals(Buffer.from(before.checkpoint))).toBe(true);
  });

  test('a replayed start returns the stored response and writes one row', async () => {
    const account = await insertAccount(db);
    const { deps } = harness();
    const command = {
      accountId: account.id,
      expectedStateVersion: 0,
      plan: plan(),
      idempotency: { key: 'start-1', requestHash: 'h' },
    };

    const first = await startHunt(deps, command);
    const second = await startHunt(deps, command);

    expect(second).toEqual(first);
    expect(await db.select().from(schema.hunts)).toHaveLength(1);
    expect(await accountVersion(account.id)).toBe(1);
  });

  test('a stale expected version is a conflict carrying the current version', async () => {
    const account = await insertAccount(db, { stateVersion: 4 });
    const { deps } = harness();
    const refused = await rejection(() =>
      startHunt(deps, { accountId: account.id, expectedStateVersion: 3, plan: plan() }),
    );
    expect(refused.code).toBe('CONFLICT_STATE_VERSION');
    expect(await huntRow(account.id)).toBeUndefined();
  });
});

describe('step 6: persist', () => {
  test('advances to the wall clock, bumps checkpointSeq once, and re-anchors', async () => {
    const account = await insertAccount(db);
    const h = harness();
    await startHunt(h.deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });

    h.clock.now = T0 + 60_000;
    const persisted = await persistHunt(h.deps, account.id, { live: true });

    expect(persisted.creditedSimMs).toBe(60_000);
    const envelope = decodeCheckpoint(Buffer.from((await huntRow(account.id)).checkpoint).toString('utf8'));
    expect(envelope.checkpointSeq).toBe(1);
    expect(envelope.simAnchorMs).toBe(60_000);
    expect(envelope.wallAnchorMs).toBe(T0 + 60_000);
    expect(envelope.lastSeenAt, 'a live connection refreshes presence').toBe(T0 + 60_000);
    expect(envelope.generation, 'a persist is not an intervention').toBe(1);
    expect(sim.decode(envelope.state).nowMs).toBe(60_000);
    expect(await accountVersion(account.id)).toBe(2);
  });

  test('without a live connection, presence is left where it was', async () => {
    const account = await insertAccount(db);
    const h = harness();
    await startHunt(h.deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });

    h.clock.now = T0 + 60_000;
    await persistHunt(h.deps, account.id, { live: false });

    const envelope = decodeCheckpoint(Buffer.from((await huntRow(account.id)).checkpoint).toString('utf8'));
    expect(envelope.lastSeenAt).toBe(T0);
    expect(envelope.simAnchorMs).toBe(60_000);
  });

  test('P-21: an account mutated mid-segment discards the candidate instead of merging it', async () => {
    const account = await insertAccount(db);
    const h = harness({
      hooks: {
        afterSegment: async () => {
          // Another command commits while the worker was running.
          await db.update(schema.accounts).set({ stateVersion: 99 }).where(eq(schema.accounts.id, account.id));
        },
      },
    });
    // Start without the hook's interference.
    await startHunt({ ...h.deps, hooks: undefined }, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    const before = await huntRow(account.id);

    h.clock.now = T0 + 60_000;
    const refused = await rejection(() => persistHunt(h.deps, account.id, { live: true }));

    expect(refused.code).toBe('CONFLICT_STATE_VERSION');
    const after = await huntRow(account.id);
    expect(Buffer.from(after.checkpoint).equals(Buffer.from(before.checkpoint)), 'nothing merged').toBe(true);
  });
});

describe('a segment that falls short of its window', () => {
  test('B-L03: a work-bound cut keeps presence where it was, so the cap cannot be re-based', async () => {
    const account = await insertAccount(db);
    // A tiny work bound: every persist is cut short of its target.
    const cut: SegmentExecutor = async (request) =>
      runSegment(sim, { ...request, maxScheduledEvents: 1, maxContinuations: 5 });
    const h = harness({}, cut);
    await startHunt(h.deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });

    // The player returns after 19 hours.
    h.clock.now = T0 + 68_400_000;
    const first = await persistHunt(h.deps, account.id, { live: true });
    expect(first.completion).toBe('capped');

    const envelope = decodeCheckpoint(Buffer.from((await huntRow(account.id)).checkpoint).toString('utf8'));
    expect(envelope.lastSeenAt, 'presence is not refreshed by a partial settlement').toBe(T0);
    expect(envelope.wallAnchorMs, 'anchored where the segment actually reached').toBe(T0 + envelope.simAnchorMs);

    // However many partial settlements follow, the total never passes the 12 h cap.
    const full = { ...h.deps, pool: new SegmentPool(inlineExecutor(sim)) };
    await persistHunt(full, account.id, { live: true });
    const settled = decodeCheckpoint(Buffer.from((await huntRow(account.id)).checkpoint).toString('utf8'));
    expect(sim.decode(settled.state).nowMs).toBeLessThanOrEqual(43_200_000);
    expect(settled.lastSeenAt, 'a complete settlement refreshes presence').toBe(T0 + 68_400_000);
  });

  test('a joined result shorter than this caller’s window is anchored where it reached', async () => {
    const account = await insertAccount(db);
    // A gate: the first job does not finish until the second has joined it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const inner = inlineExecutor(sim);
    const gated: SegmentExecutor = async (request) => {
      started();
      await gate;
      return inner(request);
    };
    const h = harness({}, gated);
    // Count joiners by wrapping the pool.
    let runs = 0;
    const pool = h.deps.pool;
    const counting = Object.assign(Object.create(Object.getPrototypeOf(pool)), pool, {
      run: (key: string, request: Parameters<SegmentPool['run']>[1]) => {
        runs += 1;
        return pool.run(key, request);
      },
    }) as SegmentPool;
    // The first caller is delayed after its segment, so the joiner - whose own
    // window reaches 15 s - is the one that commits the 10 s result.
    let afterSegmentCalls = 0;
    const deps = {
      ...h.deps,
      pool: counting,
      hooks: {
        afterSegment: async () => {
          afterSegmentCalls += 1;
          if (afterSegmentCalls === 1) await new Promise((resolve) => setTimeout(resolve, 300));
        },
      },
    };
    await startHunt({ ...deps, pool: new SegmentPool(inlineExecutor(sim)) }, {
      accountId: account.id,
      expectedStateVersion: 0,
      plan: plan(),
    });

    h.clock.now = T0 + 10_000;
    const first = persistHunt(deps, account.id, { live: true });
    await running;
    h.clock.now = T0 + 15_000;
    const second = persistHunt(deps, account.id, { live: true });
    while (runs < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pool.size, 'the second persist joined the first job').toBe(1);
    release();

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled'), 'one commits, one conflicts').toHaveLength(1);

    const envelope = decodeCheckpoint(Buffer.from((await huntRow(account.id)).checkpoint).toString('utf8'));
    expect(envelope.simAnchorMs).toBe(10_000);
    expect(envelope.lastSeenAt, 'a short settlement does not refresh presence').toBe(T0);
    // The joiner committed, the wall anchor matches the sim time actually
    // reached, so the next settlement still owes every uncredited millisecond.
    expect(envelope.wallAnchorMs - T0).toBe(envelope.simAnchorMs);
  });
});

describe('B-25: recovery replays from the durable checkpoint', () => {
  test('a crash between the worker and the commit re-simulates to identical bytes', async () => {
    // Control: one clean persist.
    const control = await insertAccount(db);
    const clean = harness();
    await startHunt(clean.deps, { accountId: control.id, expectedStateVersion: 0, plan: plan() });
    clean.clock.now = T0 + 300_000;
    await persistHunt(clean.deps, control.id, { live: true });
    const expected = decodeCheckpoint(Buffer.from((await huntRow(control.id)).checkpoint).toString('utf8'));

    // Crashed: the first attempt dies after the worker, before the commit.
    const account = await insertAccount(db);
    let crash = true;
    const crashing = harness({
      hooks: {
        beforeCommit: () => {
          if (crash) throw new Error('process killed');
        },
      },
    });
    await startHunt({ ...crashing.deps, hooks: undefined }, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    const durable = await huntRow(account.id);

    crashing.clock.now = T0 + 300_000;
    await expect(persistHunt(crashing.deps, account.id, { live: true })).rejects.toThrow('process killed');
    expect(Buffer.from((await huntRow(account.id)).checkpoint).equals(Buffer.from(durable.checkpoint))).toBe(true);

    // A fresh process: new pool, new cache, same pinned engine.
    crash = false;
    const restarted = { ...crashing.deps, pool: new SegmentPool(inlineExecutor(sim)), precompute: new PrecomputeCache() };
    await persistHunt(restarted, account.id, { live: true });

    const recovered = decodeCheckpoint(Buffer.from((await huntRow(account.id)).checkpoint).toString('utf8'));
    expect(recovered.state, 'the replay reproduces the engine state byte for byte').toBe(expected.state);
    expect(recovered.checkpointSeq, 'committed exactly once').toBe(1);
    expect(recovered.rewardSeq).toBe(expected.rewardSeq);
  });

  test('a checkpoint pinned to another content version fails closed and is not substituted', async () => {
    const account = await insertAccount(db);
    const h = harness();
    await startHunt(h.deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });

    const redeployed = { ...h.deps, pins: { ...h.deps.pins, contentVersion: 'some-later-content' } };
    const refused = await rejection(() => readHunt(redeployed, account.id));
    expect(refused).toEqual({ code: 'CONTENT_VERSION_MISMATCH', field: 'contentVersion' });
  });
});

describe('step 3: precompute is memory only', () => {
  test('it writes nothing durable and is keyed to the checkpoint it came from', async () => {
    const account = await insertAccount(db);
    const h = harness();
    await startHunt(h.deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    const before = await huntRow(account.id);

    const ahead = await precomputeHunt(h.deps, account.id);
    expect(ahead.simNowMs).toBe(h.deps.config.precomputeHorizonMs);
    expect(ahead.events.length).toBeGreaterThan(0);

    const after = await huntRow(account.id);
    expect(Buffer.from(after.checkpoint).equals(Buffer.from(before.checkpoint))).toBe(true);
    expect(await accountVersion(account.id)).toBe(1);
    expect(h.deps.precompute.get(account.id, { huntId: (await readHunt(h.deps, account.id)).envelope.huntId, generation: 1, checkpointSeq: 0 })).toBe(ahead);
  });

  test('a superseding commit discards it, so it can never be a reward source', async () => {
    const account = await insertAccount(db);
    const h = harness();
    const started = await startHunt(h.deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    const before = await precomputeHunt(h.deps, account.id);

    h.clock.now = T0 + 20_000;
    await persistHunt(h.deps, account.id, { live: true });

    expect(h.deps.precompute.get(account.id, { huntId: started.huntId, generation: 1, checkpointSeq: 0 })).toBeUndefined();
    // A fresh precompute runs from the new checkpoint, not the discarded one.
    const after = await precomputeHunt(h.deps, account.id);
    expect(after).not.toBe(before);
    expect(after.simNowMs).toBe(20_000 + h.deps.config.precomputeHorizonMs);
  });

  test('a new hunt never reads an old hunt’s precomputation, though both start at (1, 0)', () => {
    const cache = new PrecomputeCache();
    const result = { simNowMs: 1 } as never;
    cache.set('a', { huntId: 'old', generation: 1, checkpointSeq: 0 }, result);
    expect(cache.get('a', { huntId: 'new', generation: 1, checkpointSeq: 0 })).toBeUndefined();
  });
});

describe('P-38 / B-30: a faulted hunt', () => {
  const invalidState: SegmentExecutor = async () => {
    throw new SimError('INVALID_STATE', 'actors.p0.hp', 'injected invalid state');
  };

  async function faulted() {
    const account = await insertAccount(db);
    const h = harness({}, invalidState);
    await startHunt(h.deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    const before = await huntRow(account.id);
    h.clock.now = T0 + 60_000;
    const refused = await rejection(() => persistHunt(h.deps, account.id, { live: true }));
    return { account, h, before, refused };
  }

  test('the failing segment is rolled back and the last valid checkpoint kept', async () => {
    const { account, before, refused } = await faulted();
    expect(refused.code).toBe('HUNT_FAULTED');

    const after = await huntRow(account.id);
    expect(after.status).toBe('faulted');
    expect(after.faultedReason).toContain('INVALID_STATE');
    expect(Buffer.from(after.checkpoint).equals(Buffer.from(before.checkpoint))).toBe(true);
  });

  test('a fault archive row holds the checkpoint and the reproduction inputs', async () => {
    const { account, before } = await faulted();
    const archived = await db
      .select()
      .from(schema.huntCheckpointArchive)
      .where(eq(schema.huntCheckpointArchive.accountId, account.id));

    expect(archived).toHaveLength(1);
    expect(archived[0].capturedFor).toBe('fault');
    expect(Buffer.from(archived[0].checkpoint).equals(Buffer.from(before.checkpoint))).toBe(true);

    const reason = JSON.parse((await huntRow(account.id)).faultedReason ?? '{}');
    expect(reason).toMatchObject({ code: 'INVALID_STATE', field: 'actors.p0.hp', simTarget: 60_000, wallMs: T0 + 60_000 });
  });

  test('automatic retries stop: a later persist answers HUNT_FAULTED without running the engine', async () => {
    const { account, h } = await faulted();
    const callsAfterFault = h.executorCalls;

    h.clock.now = T0 + 120_000;
    expect((await rejection(() => persistHunt(h.deps, account.id, { live: true }))).code).toBe('HUNT_FAULTED');
    expect(await rejection(() => precomputeHunt(h.deps, account.id))).toMatchObject({ code: 'HUNT_FAULTED' });
    expect(h.executorCalls).toBe(callsAfterFault);
    expect(await db.select().from(schema.huntCheckpointArchive)).toHaveLength(1);
  });

  test('every command but explicit recovery answers HUNT_FAULTED, including start', async () => {
    const { account } = await faulted();
    const { deps } = harness();
    const version = await accountVersion(account.id);
    const refused = await rejection(() =>
      startHunt(deps, { accountId: account.id, expectedStateVersion: version, plan: plan() }),
    );
    expect(refused.code).toBe('HUNT_FAULTED');
    expect(await rejection(() => readHunt(deps, account.id))).toMatchObject({ code: 'HUNT_FAULTED' });
  });

  test('no wipe penalty and no invented settlement: the engine state is untouched', async () => {
    const { account, before } = await faulted();
    const was = decodeCheckpoint(Buffer.from(before.checkpoint).toString('utf8'));
    const now = decodeCheckpoint(Buffer.from((await huntRow(account.id)).checkpoint).toString('utf8'));
    expect(now.state).toBe(was.state);
    expect(sim.decode(now.state).metrics.wipes).toBe(0);
  });

  test('a fault still lands when another command commits between its read and its write', async () => {
    const account = await insertAccount(db);
    let raced = false;
    const h = harness({}, async () => {
      if (!raced) {
        raced = true;
        // A town command commits while the failing segment runs.
        await db.update(schema.accounts).set({ stateVersion: 50 }).where(eq(schema.accounts.id, account.id));
      }
      throw new SimError('INVALID_STATE', 'x', 'injected');
    });
    await startHunt(h.deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    h.clock.now = T0 + 1_000;
    expect((await rejection(() => persistHunt(h.deps, account.id, { live: true }))).code).toBe('HUNT_FAULTED');
    expect((await huntRow(account.id)).status).toBe('faulted');
  });

  test('an engine version refusal is the client’s to resolve, not a fault', async () => {
    const account = await insertAccount(db);
    const h = harness({}, async () => {
      throw new SimError('WRONG_VERSION', 'simulationVersion', 'injected');
    });
    await startHunt(h.deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    h.clock.now = T0 + 1_000;
    expect(await rejection(() => persistHunt(h.deps, account.id, { live: true }))).toEqual({
      code: 'CONTENT_VERSION_MISMATCH',
      field: 'simulationVersion',
    });
    expect((await huntRow(account.id)).status).toBe('running');
  });

  test('a checkpoint past the size cap faults rather than truncating', async () => {
    const account = await insertAccount(db);
    const h = harness();
    await startHunt(h.deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });

    h.clock.now = T0 + 60_000;
    const tiny = { ...h.deps, config: { ...h.deps.config, maxCheckpointBytes: 64 } };
    const refused = await rejection(() => persistHunt(tiny, account.id, { live: true }));
    expect(refused.code).toBe('HUNT_FAULTED');
    expect((await huntRow(account.id)).status).toBe('faulted');
  });
});

describe('P-38: recovery from a fault is explicit and validated', () => {
  test('it returns the hunt to town from the last valid checkpoint, inventing no settlement', async () => {
    const account = await insertAccount(db);
    const h = harness({}, async () => {
      throw new SimError('INVALID_STATE', 'actors.p0.hp', 'injected');
    });
    await startHunt(h.deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    const valid = await huntRow(account.id);
    h.clock.now = T0 + 60_000;
    await rejection(() => persistHunt(h.deps, account.id, { live: true }));

    const version = await accountVersion(account.id);
    await recoverFaultedHunt(h.deps, { accountId: account.id, expectedStateVersion: version });

    const row = await huntRow(account.id);
    expect(row.status).toBe('stopped');
    const before = decodeCheckpoint(Buffer.from(valid.checkpoint).toString('utf8'));
    const after = decodeCheckpoint(Buffer.from(row.checkpoint).toString('utf8'));
    expect(after.state, 'the engine state is the last valid one, unadvanced').toBe(before.state);
    expect(after.stopContext).toEqual({ reason: 'operator', atSimMs: 0, atWallMs: T0 + 60_000 });
    expect(row.faultedReason, 'the reason stays for the record').toContain('INVALID_STATE');

    // Town again: a new hunt may start, and it does not inherit the old fault.
    const { deps } = harness();
    await expect(
      startHunt(deps, { accountId: account.id, expectedStateVersion: version + 1, plan: plan() }),
    ).resolves.toMatchObject({ generation: 1 });
    expect((await huntRow(account.id)).faultedReason).toBeNull();
  });

  test('it is refused for a hunt that is not faulted', async () => {
    const account = await insertAccount(db);
    const h = harness();
    await startHunt(h.deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    const refused = await rejection(() =>
      recoverFaultedHunt(h.deps, { accountId: account.id, expectedStateVersion: 1 }),
    );
    expect(refused).toEqual({ code: 'RULE_VIOLATION', field: 'hunt.status' });
  });

  test('it is guarded: a stale expected version is a conflict and changes nothing', async () => {
    const account = await insertAccount(db);
    const h = harness({}, async () => {
      throw new SimError('INVALID_STATE', 'x', 'injected');
    });
    await startHunt(h.deps, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
    h.clock.now = T0 + 1_000;
    await rejection(() => persistHunt(h.deps, account.id, { live: true }));

    const refused = await rejection(() => recoverFaultedHunt(h.deps, { accountId: account.id, expectedStateVersion: 0 }));
    expect(refused.code).toBe('CONFLICT_STATE_VERSION');
    expect((await huntRow(account.id)).status).toBe('faulted');
  });
});

// Keep the import honest: AppError is what the lifecycle throws for every
// stable code above.
void AppError;
