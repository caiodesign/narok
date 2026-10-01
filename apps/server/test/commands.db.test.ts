/**
 * Authoritative commands over the real database (milestone B spec part 2 §4):
 * server time, `(commandAtWall, receiveSeq)` ordering (B-L11), stale-write
 * rejection (B-L12), settle-then-apply (B-L13), the command-class table, and
 * the pending snapshot surviving a later preset edit (B-L14, B-11).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { applyCommand } from '../src/hunt/commands';
import { persistHunt, startHunt } from '../src/hunt/lifecycle';
import { connect, databaseReachable, disconnect, insertAccount, truncateAll, type Db } from './db-helpers';
import { sim } from './hunt-fixtures';
import {
  accountVersion,
  checkpointOf,
  huntRow,
  insertStrategyPreset,
  plan,
  presetRow,
  rejection,
  rig,
  rules,
  T0,
  dropProtectionRows,
} from './hunt-db-harness';

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

/** A running hunt, the rig it runs on, and a second preset to apply. */
async function running(options: Parameters<typeof rig>[1] = {}) {
  const account = await insertAccount(db);
  const r = rig(db, options);
  const active = await insertStrategyPreset(db, account.id, rules());
  await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan({}, active.id) });
  const swapped = rules();
  const other = await insertStrategyPreset(db, account.id, {
    ...swapped,
    placement: { p0: swapped.placement.p1, p1: swapped.placement.p0, p2: swapped.placement.p2 },
  });
  return { account, r, active, other };
}

describe('server time and same-timestamp ordering (B-L11)', () => {
  test('two commands at one instant apply in receive order, the second against the first’s committed result', async () => {
    const { account, r, active, other } = await running();
    r.clock.now = T0 + 1_000;

    const [first, second] = await Promise.all([
      applyCommand(r.commands, account, { command: { kind: 'apply-strategy', presetId: other.id, presetVersion: 1 } }),
      applyCommand(r.commands, account, { command: { kind: 'apply-strategy', presetId: active.id, presetVersion: 1 } }),
    ]);

    expect(first.commandAtWall).toBe(T0 + 1_000);
    expect(second.commandAtWall).toBe(first.commandAtWall);
    expect(second.receiveSeq).toBe(first.receiveSeq + 1);
    expect(second.view?.generation).toBe((first.view?.generation ?? 0) + 1);
    // One pending strategy, and it is the later one.
    const envelope = await checkpointOf(db, account.id);
    expect(envelope.pendingStrategy).toMatchObject({ presetId: active.id, presetVersion: 1 });
    expect(envelope.generation).toBe(3);
  });

  test('a second command formed against the same read is judged against the first’s result: stale', async () => {
    const { account, r, active, other } = await running();
    r.clock.now = T0 + 1_000;
    const generation = (await checkpointOf(db, account.id)).generation;

    const results = await Promise.allSettled([
      applyCommand(r.commands, account, { command: { kind: 'apply-strategy', presetId: other.id, presetVersion: 1 }, expectedGeneration: generation }),
      applyCommand(r.commands, account, { command: { kind: 'apply-strategy', presetId: active.id, presetVersion: 1 }, expectedGeneration: generation }),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    const reason = (results[1] as PromiseRejectedResult).reason as { code: string; field: string; generation: number };
    expect(reason.code).toBe('CONFLICT_STATE_VERSION');
    expect(reason.field).toBe('expectedGeneration');
    expect(reason.generation).toBe(generation + 1);
    expect((await checkpointOf(db, account.id)).pendingStrategy).toMatchObject({ presetId: other.id });
  });

  test('client-supplied ordering hints and timestamps are ignored', async () => {
    const { account, r, other } = await running();
    r.clock.now = T0 + 5_000;
    const smuggled = {
      command: { kind: 'apply-strategy', presetId: other.id, presetVersion: 1, commandAtWall: T0 + 99_000 },
      commandAtWall: T0 + 99_000,
      receiveSeq: -7,
    } as unknown as Parameters<typeof applyCommand>[2];

    const outcome = await applyCommand(r.commands, account, smuggled);
    expect(outcome.commandAtWall).toBe(T0 + 5_000);
    expect(outcome.receiveSeq).toBeGreaterThan(0);
    // Settled to the server's instant, not the client's.
    expect(sim.decode((await checkpointOf(db, account.id)).state).nowMs).toBe(5_000);
  });
});

describe('stale expectations are rejected recoverably, with the current values (B-L12)', () => {
  test('a mismatched generation changes nothing, not even the settlement', async () => {
    const { account, r, other } = await running();
    r.clock.now = T0 + 3_000;
    const before = await huntRow(db, account.id);
    const version = await accountVersion(db, account.id);

    expect(
      await rejection(() =>
        applyCommand(r.commands, account, {
          command: { kind: 'apply-strategy', presetId: other.id, presetVersion: 1 },
          expectedGeneration: 9,
        }),
      ),
    ).toEqual({ code: 'CONFLICT_STATE_VERSION', field: 'expectedGeneration', stateVersion: version, generation: 1 });

    const after = await huntRow(db, account.id);
    expect(Buffer.from(after.checkpoint).equals(Buffer.from(before.checkpoint))).toBe(true);
    expect(await accountVersion(db, account.id)).toBe(version);
  });

  test('a mismatched account state version likewise', async () => {
    const { account, r, other } = await running();
    r.clock.now = T0 + 3_000;
    const before = await huntRow(db, account.id);
    const version = await accountVersion(db, account.id);

    expect(
      await rejection(() =>
        applyCommand(r.commands, account, {
          command: { kind: 'apply-strategy', presetId: other.id, presetVersion: 1 },
          expectedStateVersion: version - 1,
        }),
      ),
    ).toEqual({ code: 'CONFLICT_STATE_VERSION', field: 'expectedStateVersion', stateVersion: version, generation: 1 });
    expect(Buffer.from((await huntRow(db, account.id)).checkpoint).equals(Buffer.from(before.checkpoint))).toBe(true);
  });
});

describe('settle-then-apply (B-L13)', () => {
  test('an invalid intent leaves its settlement committed', async () => {
    const { account, r } = await running();
    const invalid = await insertStrategyPreset(db, account.id, { ...rules(), rest: { hpStart: 95, mpStart: 0 } });
    r.clock.now = T0 + 7_000;
    const before = await checkpointOf(db, account.id);

    expect(
      await rejection(() =>
        applyCommand(r.commands, account, { command: { kind: 'apply-strategy', presetId: invalid.id, presetVersion: 1 } }),
      ),
    ).toMatchObject({ code: 'VALIDATION', field: 'strategyPreset.rest.hpStart' });

    const after = await checkpointOf(db, account.id);
    expect(sim.decode(after.state).nowMs).toBe(7_000);
    expect(after.checkpointSeq).toBe(before.checkpointSeq + 1);
    expect(after.generation, 'the settlement is not an intervention').toBe(before.generation);
    expect(after.pendingStrategy).toBeNull();
  });

  test('a preset version the player did not see is refused after the settlement stands', async () => {
    const { account, r, other } = await running();
    r.clock.now = T0 + 2_500;
    expect(
      await rejection(() =>
        applyCommand(r.commands, account, { command: { kind: 'apply-strategy', presetId: other.id, presetVersion: 2 } }),
      ),
    ).toMatchObject({ code: 'CONFLICT_STATE_VERSION', field: 'presetVersion' });
    expect(sim.decode((await checkpointOf(db, account.id)).state).nowMs).toBe(2_500);
  });

  test('another account’s preset is NOT_OWNED', async () => {
    const { account, r } = await running();
    const stranger = await insertAccount(db);
    const theirs = await insertStrategyPreset(db, stranger.id, rules());
    expect(
      await rejection(() =>
        applyCommand(r.commands, account, { command: { kind: 'apply-strategy', presetId: theirs.id, presetVersion: 1 } }),
      ),
    ).toMatchObject({ code: 'NOT_OWNED' });
  });
});

describe('the command classes of part 2 §4', () => {
  test('heartbeat: settles, never bumps generation, touches no preset', async () => {
    const { account, r, other } = await running();
    r.clock.now = T0 + 4_000;
    const outcome = await applyCommand(r.commands, account, { command: { kind: 'heartbeat' } });
    const envelope = await checkpointOf(db, account.id);
    expect(sim.decode(envelope.state).nowMs).toBe(4_000);
    expect(envelope.generation).toBe(1);
    expect(envelope.lastSeenAt).toBe(T0 + 4_000);
    expect(outcome.view?.generation).toBe(1);
    expect((await presetRow(db, other.id)).presetVersion).toBe(1);
  });

  test('stop: settles, bumps generation and preserves pity and the pending strategy', async () => {
    const { account, r, other } = await running();
    r.clock.now = T0 + 1_000;
    await applyCommand(r.commands, account, { command: { kind: 'apply-strategy', presetId: other.id, presetVersion: 1 } });
    r.clock.now = T0 + 1_500;
    await applyCommand(r.commands, account, { command: { kind: 'stop' } });
    const envelope = await checkpointOf(db, account.id);
    expect(sim.decode(envelope.state).nowMs).toBe(1_500);
    expect(envelope.generation).toBe(3);
    expect(envelope.stopContext?.reason).toBe('operator');
    // The counters accrued to the stop are kept, in the checkpoint and its index.
    const counters = sim.decode(envelope.state).dropProtection;
    expect(counters.epicPlus).toBe(sim.decode(envelope.state).metrics.kills);
    expect(await dropProtectionRows(db, account.id)).toEqual(counters);
    // Stopping does not activate the pending version (B-L17).
    expect(envelope.pendingStrategy).toMatchObject({ presetId: other.id });
    expect(sim.decode(envelope.state).pendingRules).not.toBeNull();
  });

  test('apply next encounter: settles, bumps generation, queues the snapshot, leaves the preset row alone', async () => {
    const { account, r, other } = await running();
    r.clock.now = T0 + 1_000;
    const row = await presetRow(db, other.id);
    const outcome = await applyCommand(r.commands, account, { command: { kind: 'apply-strategy', presetId: other.id, presetVersion: 1 } });
    const envelope = await checkpointOf(db, account.id);
    expect(sim.decode(envelope.state).nowMs).toBe(1_000);
    expect(envelope.generation).toBe(2);
    expect(envelope.pendingStrategy).toMatchObject({ presetId: other.id, presetVersion: 1, acknowledgedAtSimMs: 1_000 });
    expect(outcome.view?.pendingStrategy).toEqual({ presetId: other.id, presetVersion: 1 });
    expect(outcome.view?.activeStrategy).toEqual(envelope.activeStrategy);
    expect(await presetRow(db, other.id)).toEqual(row);
  });

  test('save preset: no settlement, no generation, only the preset row changes; a running hunt is unchanged', async () => {
    const { account, r, active } = await running();
    r.clock.now = T0 + 9_000;
    const before = await huntRow(db, account.id);

    const outcome = await applyCommand(r.commands, account, {
      command: { kind: 'save-strategy-preset', presetId: active.id, expectedPresetVersion: 1, payload: rules({ rest: { hpStart: 60, mpStart: 20 } }) },
    });
    expect(outcome.preset).toMatchObject({ presetId: active.id, presetVersion: 2 });

    const after = await huntRow(db, account.id);
    expect(Buffer.from(after.checkpoint).equals(Buffer.from(before.checkpoint))).toBe(true);
    const row = await presetRow(db, active.id);
    expect(row.presetVersion).toBe(2);
    expect((row.payload as { rest: unknown }).rest).toEqual({ hpStart: 60, mpStart: 20 });
  });

  test('save preset refuses a malformed payload — a stale wipe limit (R154) — and writes nothing', async () => {
    const { account, r, active } = await running();
    expect(
      await rejection(() =>
        applyCommand(r.commands, account, {
          command: { kind: 'save-strategy-preset', presetId: active.id, expectedPresetVersion: 1, payload: { ...rules(), wipeLimit: 1 } },
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION' });
    expect((await presetRow(db, active.id)).presetVersion).toBe(1);
  });
});

describe('the queued snapshot is the one that activates (B-L14, B-11)', () => {
  test('apply, edit the same preset, spawn: the activated payload is the queued one', async () => {
    const { account, r, other } = await running();
    r.clock.now = T0 + 500;
    await applyCommand(r.commands, account, { command: { kind: 'apply-strategy', presetId: other.id, presetVersion: 1 } });
    await applyCommand(r.commands, account, {
      command: { kind: 'save-strategy-preset', presetId: other.id, expectedPresetVersion: 1, payload: rules({ rest: { hpStart: 10, mpStart: 10 } }) },
    });

    // The walk completes at 2,000 ms; settle past it.
    r.clock.now = T0 + 2_100;
    await applyCommand(r.commands, account, { command: { kind: 'heartbeat' } });

    const envelope = await checkpointOf(db, account.id);
    const state = sim.decode(envelope.state);
    expect(state.encounterCount).toBe(1);
    // The queued snapshot's swapped placement, not the edit's default one.
    expect(state.input.placement).toEqual({
      p0: rules().placement.p1, p1: rules().placement.p0, p2: rules().placement.p2,
    });
    expect(state.input.rest).toEqual(rules().rest);
    expect(envelope.activeStrategy).toEqual({ presetId: other.id, presetVersion: 1 });
    expect(envelope.pendingStrategy).toBeNull();
  });
});

describe('idempotency', () => {
  test('a replayed apply answers the stored result and applies once', async () => {
    const { account, r, other } = await running();
    r.clock.now = T0 + 1_000;
    const idempotency = { key: 'strategy:k1', requestHash: 'h1' };
    const first = await applyCommand(r.commands, account, {
      command: { kind: 'apply-strategy', presetId: other.id, presetVersion: 1 },
      idempotency,
    });
    r.clock.now = T0 + 1_800;
    const replay = await applyCommand(r.commands, account, {
      command: { kind: 'apply-strategy', presetId: other.id, presetVersion: 1 },
      idempotency,
    });
    expect(replay.view).toEqual(first.view);
    const envelope = await checkpointOf(db, account.id);
    expect(envelope.generation).toBe(2);
    expect(sim.decode(envelope.state).nowMs, 'a replay settles nothing').toBe(1_000);
  });
});

describe('a settlement committed inside a command’s own settle (R120)', () => {
  /**
   * "Another process" — its own pool and command queue — commits a settlement
   * at a later wall instant after this command read the checkpoint and before
   * it committed. The command must neither be refused for a conflict it did
   * not cause nor re-anchor backwards to its earlier stamp.
   */
  async function racing() {
    const account = await insertAccount(db);
    const elsewhere = rig(db);
    let raced = false;
    const r = rig(db, {
      lifecycle: {
        hooks: {
          afterSegment: async () => {
            if (raced) return;
            raced = true;
            elsewhere.clock.now = T0 + 3_000;
            await persistHunt(elsewhere.lifecycle, account.id, { live: true });
          },
        },
      },
    });
    const active = await insertStrategyPreset(db, account.id, rules());
    await startHunt(r.lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan({}, active.id) });
    const other = await insertStrategyPreset(db, account.id, rules({ rest: { hpStart: 40, mpStart: 20 } }));
    return { account, r, other };
  }

  test('the command retries its settlement and applies; no wall interval is credited twice', async () => {
    const { account, r, other } = await racing();
    r.clock.now = T0 + 1_000;

    const outcome = await applyCommand(r.commands, account, {
      command: { kind: 'apply-strategy', presetId: other.id, presetVersion: 1 },
      expectedGeneration: 1,
    });
    expect(outcome.commandAtWall).toBe(T0 + 1_000);
    expect(outcome.view?.generation).toBe(2);

    // The stale stamp did not rewind the anchor or presence.
    const applied = await checkpointOf(db, account.id);
    expect(applied.wallAnchorMs).toBe(T0 + 3_000);
    expect(applied.lastSeenAt).toBe(T0 + 3_000);
    expect(sim.decode(applied.state).nowMs).toBe(3_000);

    // The next settlement credits only what is new since the race.
    r.clock.now = T0 + 5_000;
    const heartbeat = await persistHunt(r.lifecycle, account.id, { live: true });
    expect(heartbeat.creditedSimMs).toBe(2_000);
    expect(sim.decode((await checkpointOf(db, account.id)).state).nowMs).toBe(5_000);
  });

  test('the client’s own stale expectation is still refused recoverably, not retried away (B-L12)', async () => {
    const { account, r, other } = await racing();
    r.clock.now = T0 + 1_000;
    const version = await accountVersion(db, account.id);

    // The other settlement moves the account version the client read.
    const refused = await rejection(() =>
      applyCommand(r.commands, account, {
        command: { kind: 'apply-strategy', presetId: other.id, presetVersion: 1 },
        expectedStateVersion: version,
      }),
    );
    expect(refused).toEqual({ code: 'CONFLICT_STATE_VERSION', field: 'expectedStateVersion', stateVersion: version + 1, generation: 1 });
    expect((await checkpointOf(db, account.id)).pendingStrategy).toBeNull();
  });
});

describe('the socket’s settlements share the command order (R120)', () => {
  test('a heartbeat queued behind a command waits for it and is stamped when it reaches the head', async () => {
    const { account, r } = await running();
    await r.feed.connect(account.id);
    const before = (await checkpointOf(db, account.id)).checkpointSeq;

    let release!: () => void;
    const blocker = r.commands.sequencer.submit(account.id, () => new Promise<void>((resolve) => (release = resolve)));
    r.clock.now = T0 + 2_000;
    const heartbeat = r.feed.heartbeat(account.id);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await checkpointOf(db, account.id)).checkpointSeq, 'nothing settles while the command holds the order').toBe(before);

    r.clock.now = T0 + 4_000;
    release();
    await blocker;
    await heartbeat;
    const after = await checkpointOf(db, account.id);
    expect(after.checkpointSeq).toBe(before + 1);
    expect(sim.decode(after.state).nowMs).toBe(4_000);
  });
});
