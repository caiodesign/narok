/**
 * Applying a loot filter to a running hunt (part 3 §3.3; UI spec §6; part 2 §4;
 * B-14's server half; ruling R131).
 *
 * The apply is settle-then-apply like the strategy apply: elapsed time is
 * committed to the server's command time first, then the validated filter
 * governs every drop after that cutoff — never one rolled before it, and never
 * the inventory. It is evaluated by the one `packages/loot` evaluator the
 * preview calls.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { evaluate, type LootPreset } from '@narok/loot';
import * as schema from '../src/db/schema';
import { applyCommand } from '../src/hunt/commands';
import { persistHunt, startHunt } from '../src/hunt/lifecycle';
import { connect, databaseReachable, disconnect, insertAccount, truncateAll, type Db } from './db-helpers';
import { checkpointOf, insertLootPreset, plan, rejection, rig, T0 } from './hunt-db-harness';
import { rich, richSim } from './hunt-fixtures';

let db: Db;
const engine = { sim: richSim, content: rich };
const KEEP_ALL: LootPreset = { exceptions: [], rarity: {}, fallback: { equipment: 'keep', consumable: 'keep' } };
const IGNORE_ALL: LootPreset = { exceptions: [], rarity: {}, fallback: { equipment: 'ignore', consumable: 'ignore' } };

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

async function running() {
  const account = await insertAccount(db);
  const r = rig(db, { engine });
  const active = await insertLootPreset(db, account.id, KEEP_ALL);
  const other = await insertLootPreset(db, account.id, IGNORE_ALL);
  const started = await startHunt(r.lifecycle, {
    accountId: account.id,
    expectedStateVersion: 0,
    plan: plan({ wipeLimit: 5 }, undefined, { loot: KEEP_ALL, lootPresetId: active.id }),
  });
  return { account, r, active, other, started };
}

/** The first instant, on a 1 s grid, at which a rolled drop is still waiting for its encounter to end. */
async function midEncounterWithWaitingDrop(): Promise<number> {
  const state = richSim.start({ ...plan({ wipeLimit: 5 }).input, seed: 4_242 }, { loot: KEEP_ALL });
  let current = state;
  for (let at = 1_000; at < 600_000; at += 1_000) {
    current = richSim.advance(current, at).state;
    if (current.pendingRewards.some((reward) => reward.disposition === null)) return at;
  }
  throw new Error('no waiting drop within ten minutes');
}

describe('apply affects only drops after the acknowledged cutoff (UI spec §6)', () => {
  test('rewards rolled before the cutoff keep the filter they were rolled under; every later one runs the new filter', async () => {
    const { account, r, other } = await running();
    const cutoffAt = await midEncounterWithWaitingDrop();
    r.clock.now = T0 + cutoffAt;

    const outcome = await applyCommand(r.commands, account, {
      command: { kind: 'apply-loot', presetId: other.id, presetVersion: 1 },
    });
    const applied = await checkpointOf(db, account.id);
    const atApply = richSim.decode(applied.state);
    // Settled to the command time first, then applied (B-L13), as a new generation.
    expect(atApply.nowMs).toBe(cutoffAt);
    expect(applied.generation).toBe(2);
    const cutoff = atApply.nextRewardSeq;
    const waiting = atApply.pendingRewards.filter((reward) => reward.disposition === null).map((reward) => reward.rewardSeq);
    expect(waiting.length).toBeGreaterThan(0);
    expect(applied.pendingLoot).toMatchObject({ presetId: other.id, presetVersion: 1, acknowledgedAtSimMs: cutoffAt });
    expect(outcome.view?.pendingLoot).toEqual({ presetId: other.id, presetVersion: 1 });

    r.clock.now = T0 + cutoffAt + 300_000;
    const settled = await persistHunt(r.lifecycle, account.id, { live: true });
    const before = settled.rewards.filter((reward) => reward.rewardSeq < cutoff);
    const after = settled.rewards.filter((reward) => reward.rewardSeq >= cutoff);
    expect(before.map((reward) => reward.rewardSeq)).toEqual(waiting);
    expect(after.length).toBeGreaterThan(0);
    for (const reward of before) expect(reward.disposition.outcome).toBe('kept');
    for (const reward of after) {
      // The very evaluator the preview runs, over the applied filter.
      const expected = reward.item.kind === 'equipment' && reward.item.rarity === 'legendary' ? 'keep' : 'ignore';
      expect(reward.disposition.action).toBe(expected);
    }
    // Once the earlier drops were dispositioned, the applied version is the active one.
    const promoted = await checkpointOf(db, account.id);
    expect(promoted.pendingLoot).toBeNull();
    expect(promoted.activeLoot).toEqual({ presetId: other.id, presetVersion: 1 });
  });

  test('with nothing waiting it takes effect at once, and existing inventory is never re-evaluated', async () => {
    const { account, r, other } = await running();
    r.clock.now = T0 + 120_000;
    await persistHunt(r.lifecycle, account.id, { live: true });

    // Advance to an instant with nothing rolled and waiting, then apply.
    let at = 120_000;
    for (;;) {
      const state = richSim.decode((await checkpointOf(db, account.id)).state);
      if (state.pendingRewards.every((reward) => reward.disposition !== null)) break;
      at += 1_000;
      r.clock.now = T0 + at;
      await persistHunt(r.lifecycle, account.id, { live: true });
    }
    const current = await checkpointOf(db, account.id);
    const itemsBefore = await db.select().from(schema.items).where(eq(schema.items.accountId, account.id));
    expect(itemsBefore.length).toBeGreaterThan(0);
    const outcome = await applyCommand(r.commands, account, {
      command: { kind: 'apply-loot', presetId: other.id, presetVersion: 1 },
      expectedGeneration: current.generation,
    });
    const applied = await checkpointOf(db, account.id);
    expect(applied.pendingLoot).toBeNull();
    expect(applied.activeLoot).toEqual({ presetId: other.id, presetVersion: 1 });
    expect(outcome.view?.activeLoot).toEqual({ presetId: other.id, presetVersion: 1 });
    expect(richSim.decode(applied.state).lootPresetSnapshot).toEqual(IGNORE_ALL);

    const itemsAfter = await db.select().from(schema.items).where(eq(schema.items.accountId, account.id));
    expect(itemsAfter.map((item) => item.id).sort()).toEqual(itemsBefore.map((item) => item.id).sort());
  });

  test('the dispositions a commit credits agree with the shared evaluator for every drop', async () => {
    const { account, r } = await running();
    r.clock.now = T0 + 300_000;
    const settled = await persistHunt(r.lifecycle, account.id, { live: true });
    expect(settled.rewards.length).toBeGreaterThan(0);
    for (const reward of settled.rewards) {
      if (reward.item.kind !== 'equipment') continue;
      const drop = {
        category: 'equipment' as const,
        definitionId: reward.item.definitionId,
        slot: rich.items[reward.item.definitionId].slot,
        rarity: reward.item.rarity,
        bonusIds: reward.item.bonuses.map((bonus) => bonus.bonusId),
        itemLevel: reward.itemLevel,
      };
      const { action, matched } = evaluate(drop, KEEP_ALL);
      expect({ action: reward.disposition.action, matched: reward.disposition.matched }).toEqual({ action, matched });
    }
  });
});

describe('the apply is an intervention like the strategy apply (part 2 §4)', () => {
  test('a stale generation is refused recoverably with the current values, and nothing settles', async () => {
    const { account, r, other } = await running();
    r.clock.now = T0 + 5_000;
    const before = await checkpointOf(db, account.id);
    const refused = await rejection(() =>
      applyCommand(r.commands, account, {
        command: { kind: 'apply-loot', presetId: other.id, presetVersion: 1 },
        expectedGeneration: before.generation + 1,
      }),
    );
    expect(refused).toMatchObject({ code: 'CONFLICT_STATE_VERSION', field: 'expectedGeneration', generation: 1 });
    expect(await checkpointOf(db, account.id)).toEqual(before);
  });

  test('an invalid filter is refused after its settlement stands (B-L13)', async () => {
    const { account, r } = await running();
    const broken = await insertLootPreset(db, account.id, { exceptions: [], rarity: {}, fallback: { equipment: 'keep' } });
    r.clock.now = T0 + 7_000;
    const refused = await rejection(() =>
      applyCommand(r.commands, account, { command: { kind: 'apply-loot', presetId: broken.id, presetVersion: 1 } }),
    );
    expect(refused).toMatchObject({ code: 'VALIDATION', field: 'lootPreset.fallback.consumable' });
    const envelope = await checkpointOf(db, account.id);
    expect(richSim.decode(envelope.state).nowMs).toBe(7_000);
    expect(envelope.generation).toBe(1);
    expect(envelope.pendingLoot).toBeNull();
  });

  test('a preset version the player did not see, or another account’s preset, is refused', async () => {
    const { account, r, other } = await running();
    r.clock.now = T0 + 1_000;
    expect(
      await rejection(() =>
        applyCommand(r.commands, account, { command: { kind: 'apply-loot', presetId: other.id, presetVersion: 2 } }),
      ),
    ).toMatchObject({ code: 'CONFLICT_STATE_VERSION', field: 'presetVersion' });

    const stranger = await insertAccount(db);
    const theirs = await insertLootPreset(db, stranger.id, KEEP_ALL);
    expect(
      await rejection(() =>
        applyCommand(r.commands, account, { command: { kind: 'apply-loot', presetId: theirs.id, presetVersion: 1 } }),
      ),
    ).toMatchObject({ code: 'NOT_OWNED', field: 'presetId' });
  });
});
