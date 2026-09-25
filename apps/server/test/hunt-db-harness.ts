/**
 * A lifecycle over the real database with a hand-driven clock, shared by the
 * settlement, command, reward and report suites. Nothing here sleeps.
 */
import { eq } from 'drizzle-orm';
import { defaultPlacement, defaultStrategy, type PendingRules } from '@narok/sim';
import * as schema from '../src/db/schema';
import { CommandSequencer, type CommandDeps } from '../src/hunt/commands';
import { defaultHuntConfig, type HuntConfig } from '../src/hunt/config';
import { decodeCheckpoint } from '../src/hunt/envelope';
import { LifecycleFeed, type FeedScheduler } from '../src/hunt/feed';
import { PrecomputeCache, type HuntPlan, type LifecycleDeps } from '../src/hunt/lifecycle';
import type { RewardSource } from '../src/hunt/rewards';
import { SegmentPool, inlineExecutor, type SegmentExecutor } from '../src/workers/pool';
import type { Db } from './db-helpers';
import { party, sim, validated } from './hunt-fixtures';

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

export function plan(overrides: Partial<PendingRules> = {}, presetId: string = crypto.randomUUID()): HuntPlan {
  return {
    mapId: 'prototype',
    input: { classes: [...party], recipe: 'mixed', ...rules(overrides) },
    activeStrategy: { presetId, presetVersion: 1 },
    activeLoot: { presetId: crypto.randomUUID(), presetVersion: 1 },
    inventoryProjection: { capacity: 100, usedSlots: 0, stackHeadroom: {} },
  };
}

export interface RigOptions {
  readonly executor?: SegmentExecutor;
  readonly rewardSource?: RewardSource;
  readonly config?: Partial<HuntConfig>;
  readonly lifecycle?: Partial<LifecycleDeps>;
}

export function rig(db: Db, options: RigOptions = {}) {
  const clock = { now: T0 };
  const lifecycle: LifecycleDeps = {
    db,
    sim,
    content: validated,
    pins: { simulationVersion: 'b1', contentVersion: validated.version, gridHash: validated.gridHash },
    config: { ...defaultHuntConfig(), ...options.config },
    now: () => clock.now,
    drawSeed: () => 4_242,
    newHuntId: () => crypto.randomUUID(),
    pool: new SegmentPool(options.executor ?? inlineExecutor(sim, options.rewardSource)),
    precompute: new PrecomputeCache(),
    ...options.lifecycle,
  };
  const commands: CommandDeps = { lifecycle, sequencer: new CommandSequencer(lifecycle.now) };
  const noTicks: FeedScheduler = () => () => undefined;
  const feed = new LifecycleFeed({ lifecycle, retainedEvents: 5_000, releaseTickMs: 1_000, schedule: noTicks });
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
