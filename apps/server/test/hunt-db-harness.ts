/**
 * A lifecycle over the real database with a hand-driven clock, shared by the
 * settlement, command, reward and report suites. Nothing here sleeps.
 */
import { eq } from 'drizzle-orm';
import { defaultBag, defaultPlacement, defaultStrategy, starterLoot, type PendingRules } from '@narok/sim';
import * as schema from '../src/db/schema';
import { CommandSequencer, type CommandDeps } from '../src/hunt/commands';
import { defaultHuntConfig, type HuntConfig } from '../src/hunt/config';
import { decodeCheckpoint } from '../src/hunt/envelope';
import { LifecycleFeed, type FeedOptions, type FeedScheduler } from '../src/hunt/feed';
import { PrecomputeCache, type HuntPlan, type LifecycleDeps } from '../src/hunt/lifecycle';
import { SegmentPool, inlineExecutor, type SegmentExecutor } from '../src/workers/pool';
import type { Db } from './db-helpers';
import { party, sim as bundledSim, validated } from './hunt-fixtures';
import type { Content } from '@narok/data';
import type { DropProtection, Simulation } from '@narok/sim';

export const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);

export function rules(overrides: Partial<PendingRules> = {}): PendingRules {
  return {
    placement: defaultPlacement([...party]),
    strategies: Object.fromEntries(party.map((id, index) => [`p${index}`, defaultStrategy(id)])),
    rest: { hpStart: 50, mpStart: 30 },
    wipeLimit: 1,
    ...overrides,
  };
}

export function plan(
  overrides: Partial<PendingRules> = {},
  presetId: string = crypto.randomUUID(),
  setup: Partial<HuntPlan['setup']> & { readonly lootPresetId?: string } = {},
): HuntPlan {
  const { lootPresetId, ...inputs } = setup;
  return {
    mapId: 'prototype',
    input: { classes: [...party], recipe: 'mixed', ...rules(overrides) },
    activeStrategy: { presetId, presetVersion: 1 },
    activeLoot: { presetId: lootPresetId ?? crypto.randomUUID(), presetVersion: 1 },
    setup: { loot: starterLoot(), bag: defaultBag(), dropProtection: { epicPlus: 0, legendary: 0 }, ...inputs },
  };
}

export interface RigOptions {
  readonly executor?: SegmentExecutor;
  /** Another engine and the content it was bound to — the hunt's pinned content, never the bundle's by accident. */
  readonly engine?: { readonly sim: Simulation; readonly content: Content };
  readonly config?: Partial<HuntConfig>;
  readonly lifecycle?: Partial<LifecycleDeps>;
  readonly feed?: Partial<FeedOptions>;
}

export function rig(db: Db, options: RigOptions = {}) {
  const clock = { now: T0 };
  const sim = options.engine?.sim ?? bundledSim;
  const content = options.engine?.content ?? validated;
  const lifecycle: LifecycleDeps = {
    db,
    sim,
    content,
    pins: { simulationVersion: 'b1', contentVersion: content.version, gridHash: content.gridHash },
    config: { ...defaultHuntConfig(), ...options.config },
    now: () => clock.now,
    drawSeed: () => 4_242,
    newHuntId: () => crypto.randomUUID(),
    pool: new SegmentPool(options.executor ?? inlineExecutor(sim)),
    precompute: new PrecomputeCache(),
    ...options.lifecycle,
  };
  const commands: CommandDeps = { lifecycle, sequencer: new CommandSequencer(lifecycle.now) };
  const noTicks: FeedScheduler = () => () => undefined;
  // One command order for the account, shared by commands and the feed's settlements (R120).
  const feed = new LifecycleFeed({
    lifecycle,
    retainedEvents: 5_000,
    releaseTickMs: 1_000,
    schedule: noTicks,
    sequencer: commands.sequencer,
    ...options.feed,
  });
  return { clock, lifecycle, commands, feed };
}

export async function insertStrategyPreset(
  db: Db,
  accountId: string,
  payload: unknown = rules(),
  name = `Preset ${crypto.randomUUID().slice(0, 8)}`,
) {
  const [row] = await db
    .insert(schema.strategyPresets)
    .values({ accountId, name, payload, payloadSchemaVersion: 1, gridHash: validated.gridHash })
    .returning();
  return row;
}

/** A loot preset row (payload schema version 1); the starter filter unless told otherwise. */
export async function insertLootPreset(
  db: Db,
  accountId: string,
  payload: unknown = starterLoot(),
  name = `Loot ${crypto.randomUUID().slice(0, 8)}`,
) {
  const [row] = await db.insert(schema.lootPresets).values({ accountId, name, payload, payloadSchemaVersion: 1 }).returning();
  return row;
}

export async function presetRow(db: Db, id: string) {
  const [row] = await db.select().from(schema.strategyPresets).where(eq(schema.strategyPresets.id, id));
  return row;
}

export async function huntRow(db: Db, accountId: string) {
  const [row] = await db.select().from(schema.hunts).where(eq(schema.hunts.accountId, accountId));
  return row;
}

export async function checkpointOf(db: Db, accountId: string) {
  const row = await huntRow(db, accountId);
  return decodeCheckpoint(Buffer.from(row.checkpoint).toString('utf8'));
}

/** The `account_drop_protection` index, read raw, as the counters it indexes. */
export async function dropProtectionRows(db: Db, accountId: string): Promise<DropProtection> {
  const rows = await db
    .select()
    .from(schema.accountDropProtection)
    .where(eq(schema.accountDropProtection.accountId, accountId));
  return Object.fromEntries(rows.map((row) => [row.rewardTier, row.counter])) as unknown as DropProtection;
}

export async function accountVersion(db: Db, accountId: string): Promise<number> {
  const [row] = await db
    .select({ stateVersion: schema.accounts.stateVersion })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  return row.stateVersion;
}

export async function rejection(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (error) {
    const record = error as Record<string, unknown>;
    return {
      code: record.code,
      field: record.field,
      ...(record.stateVersion === undefined ? {} : { stateVersion: record.stateVersion }),
      ...(record.currentStateVersion === undefined ? {} : { stateVersion: record.currentStateVersion }),
      ...(record.generation === undefined ? {} : { generation: record.generation }),
    };
  }
  throw new Error('expected a rejection');
}
