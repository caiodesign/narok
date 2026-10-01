/**
 * The hunt routes (part 1 §3): start, read, stop, apply-next-encounter and
 * apply-loot-filter.
 *
 * Every mutating route resolves the caller, then checks ownership of every
 * named object, then validates the business rule — in that order, so a
 * cross-account probe learns nothing from which complaint comes back (P-12).
 * The client names no seed, no time and no state; the plan is built here from
 * the account's own records and handed to the lifecycle (P-02).
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { bagState } from '@narok/progression';
import { applyLootCommandSchema, applyStrategyCommandSchema, startHuntCommandSchema } from '@narok/protocol';
import { loadBag } from '../db/repositories/inventory';
import * as schema from '../db/schema';
import { ConflictError } from '../db/tx';
import { AppError, notOwned } from '../errors';
import { applyCommand, CommandSequencer, type CommandDeps } from '../hunt/commands';
import type { LifecycleFeed } from '../hunt/feed';
import { readHunt, startHunt, type HuntPlan, type LifecycleDeps } from '../hunt/lifecycle';
import { lootVersions, presetLoot, presetRules, strategyVersions } from '../hunt/pending';
import { readDropProtection } from '../hunt/rewards';
import { requireSession } from '../plugins/session';
import { loadParty } from '../town/party';
import type { RouteContext } from './context';

export interface HuntServices {
  readonly lifecycle: LifecycleDeps;
  /** Told about every new generation, so open sockets are snapshotted into it. */
  readonly feed?: LifecycleFeed;
  /** The per-account command order (R116); one is made when absent. */
  readonly sequencer?: CommandSequencer;
}

/**
 * The maps a hunt may name, and the encounter recipe each runs. Milestone B
 * ships the one prototype map (spec §2.2: no extra maps).
 */
const MAPS: Readonly<Record<string, 'mixed'>> = { prototype: 'mixed' };

export function requireIdempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
    throw new AppError('VALIDATION', 'idempotency-key');
  }
  return key;
}

/** The request hash an idempotency key is bound to (P-25). */
export async function hashRequest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex');
}

/** The transaction layer's refusals, in the envelope a client reads. */
export function asAppError(error: unknown): unknown {
  if (error instanceof ConflictError) return new AppError(error.code, error.field, error.currentStateVersion);
  return error;
}

export function registerHuntRoutes(app: FastifyInstance, ctx: RouteContext, services: HuntServices): void {
  const { stores, config, now, parse } = ctx;
  const { lifecycle, feed } = services;
  const { db } = lifecycle;
  const commands: CommandDeps = { lifecycle, sequencer: services.sequencer ?? new CommandSequencer(lifecycle.now) };
  const caller = (request: FastifyRequest) => requireSession(request, stores, config, now());

  // A new generation reaches open sockets as a snapshot. A failed push costs
  // nothing: the socket's next heartbeat reads the committed hunt anyway.
  const announce = (accountId: string) => {
    void feed?.notify(accountId).catch(() => undefined);
  };

  app.post('/api/hunts', async (request) => {
    const { account } = await caller(request);
    const key = requireIdempotencyKey(request);
    const body = parse(startHuntCommandSchema, request.body);

    // 1. Ownership, for everything named, before any rule. The characters
    // come back as the engine's party: progression and worn items (R148).
    const party = await loadParty(db, account.id, body.characterIds);
    const [strategy] = await db
      .select()
      .from(schema.strategyPresets)
      .where(and(eq(schema.strategyPresets.id, body.strategyPresetId), eq(schema.strategyPresets.accountId, account.id)));
    if (strategy === undefined) throw notOwned('strategyPresetId');
    const [loot] = await db
      .select()
      .from(schema.lootPresets)
      .where(and(eq(schema.lootPresets.id, body.lootPresetId), eq(schema.lootPresets.accountId, account.id)));
    if (loot === undefined) throw notOwned('lootPresetId');

    // 2. The rules.
    const recipe = MAPS[body.mapId];
    if (recipe === undefined) throw new AppError('VALIDATION', 'mapId');
    // The preset's rules, with the engine's default wipe limit when it names none.
    const rules = presetRules(strategy.payload, strategy.payloadSchemaVersion);

    // The filter that will run at encounter end is a validated copy of the
    // named preset, checked by the evaluator's own validator (part 3 §3.3).
    const lootPreset = presetLoot(loot.payload, loot.payloadSchemaVersion);

    // The bag the engine may assume (part 3 §2.5), counted by the one rule
    // the town commands use: each unequipped item a slot, each consumable
    // total ceil(n / 999) slots (ruling R137).
    const bag = bagState(await loadBag(db, account.id));

    const plan: HuntPlan = {
      mapId: body.mapId,
      input: { classes: party.classes, recipe, ...rules },
      activeStrategy: { presetId: strategy.id, presetVersion: strategy.presetVersion },
      activeLoot: { presetId: loot.id, presetVersion: loot.presetVersion },
      setup: {
        loot: lootPreset,
        bag,
        party: party.party,
        // The account's counters outlive every hunt (layer-1 §4.5).
        dropProtection: await readDropProtection(db, account.id),
      },
    };

    try {
      const view = await startHunt(lifecycle, {
        accountId: account.id,
        expectedStateVersion: body.expectedStateVersion,
        plan,
        idempotency: { key: `hunt.start:${key}`, requestHash: await hashRequest(body) },
      });
      announce(account.id);
      return view;
    } catch (error) {
      throw asAppError(error);
    }
  });

  app.get('/api/hunts/current', async (request) => {
    const { account } = await caller(request);
    // A read settles nothing and writes nothing: the committed hunt, projected.
    const loaded = await readHunt(lifecycle, account.id);
    const state = lifecycle.sim.decode(loaded.envelope.state);
    const versions = strategyVersions(loaded.envelope);
    const lootVersion = lootVersions(loaded.envelope);
    return {
      huntId: loaded.envelope.huntId,
      status: loaded.status,
      generation: loaded.envelope.generation,
      eventCursor: state.nextDomainSeq,
      stateVersion: loaded.stateVersion,
      inTownAtWallMs: loaded.envelope.stopContext?.inTownAtWallMs ?? null,
      // Active and pending, separately, so the UI names both (UI spec §5).
      activeStrategy: versions.activeVersion,
      pendingStrategy: versions.pendingVersion,
      activeLoot: lootVersion.activeVersion,
      pendingLoot: lootVersion.pendingVersion,
      state: lifecycle.sim.project(state),
    };
  });

  app.post('/api/hunts/current/stop', async (request) => {
    const { account } = await caller(request);
    const key = requireIdempotencyKey(request);
    // The body carries nothing: a stop names no time and needs no guard.
    parse(startHuntCommandSchema.pick({}).strict(), request.body ?? {});

    try {
      // Through the command order like every intervention (R116): settled to
      // the server's command time, then applied.
      const outcome = await applyCommand(commands, account, {
        command: { kind: 'stop' },
        idempotency: { key: `hunt.stop:${key}`, requestHash: await hashRequest({}) },
      });
      announce(account.id);
      return outcome.view;
    } catch (error) {
      throw asAppError(error);
    }
  });

  /**
   * Apply next encounter (UI spec §5, part 2 §4): settle to the server's
   * command time, then queue that exact validated preset version for the next
   * spawn. The body names the preset, the version the player saw, and the
   * generation and account version the intent was formed against — never a
   * time, never an order.
   */
  app.post('/api/hunts/current/strategy', async (request) => {
    const { account } = await caller(request);
    const key = requireIdempotencyKey(request);
    const body = parse(applyStrategyCommandSchema, request.body);

    // Ownership before any rule (P-12).
    const [preset] = await db
      .select({ id: schema.strategyPresets.id })
      .from(schema.strategyPresets)
      .where(and(eq(schema.strategyPresets.id, body.presetId), eq(schema.strategyPresets.accountId, account.id)));
    if (preset === undefined) throw notOwned('presetId');

    try {
      const outcome = await applyCommand(commands, account, {
        command: { kind: 'apply-strategy', presetId: body.presetId, presetVersion: body.presetVersion },
        expectedGeneration: body.expectedGeneration,
        expectedStateVersion: body.expectedStateVersion,
        idempotency: { key: `hunt.strategy:${key}`, requestHash: await hashRequest(body) },
      });
      announce(account.id);
      return outcome.view;
    } catch (error) {
      throw asAppError(error);
    }
  });

  /**
   * Apply loot filter (UI spec §6, part 3 §3.3): settle to the server's
   * command time, then run that exact validated preset version on every drop
   * after this cutoff. Never retroactive: nothing already dropped or already
   * in the bag is re-evaluated. Guarded like apply-next-encounter.
   */
  app.post('/api/hunts/current/loot', async (request) => {
    const { account } = await caller(request);
    const key = requireIdempotencyKey(request);
    const body = parse(applyLootCommandSchema, request.body);

    // Ownership before any rule (P-12).
    const [preset] = await db
      .select({ id: schema.lootPresets.id })
      .from(schema.lootPresets)
      .where(and(eq(schema.lootPresets.id, body.presetId), eq(schema.lootPresets.accountId, account.id)));
    if (preset === undefined) throw notOwned('presetId');

    try {
      const outcome = await applyCommand(commands, account, {
        command: { kind: 'apply-loot', presetId: body.presetId, presetVersion: body.presetVersion },
        expectedGeneration: body.expectedGeneration,
        expectedStateVersion: body.expectedStateVersion,
        idempotency: { key: `hunt.loot:${key}`, requestHash: await hashRequest(body) },
      });
      announce(account.id);
      return outcome.view;
    } catch (error) {
      throw asAppError(error);
    }
  });
}
