/**
 * The hunt routes (part 1 §3): start, read, stop and apply-next-encounter.
 *
 * Every mutating route resolves the caller, then checks ownership of every
 * named object, then validates the business rule — in that order, so a
 * cross-account probe learns nothing from which complaint comes back (P-12).
 * The client names no seed, no time and no state; the plan is built here from
 * the account's own records and handed to the lifecycle (P-02).
 */
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  applyStrategyCommandSchema,
  startHuntCommandSchema,
  STRATEGY_PAYLOAD_SCHEMA_VERSION,
  strategyPresetPayloadSchema,
} from '@narok/protocol';
import type { ClassId } from '@narok/data';
import type { PositionId, Strategy } from '@narok/sim';
import * as schema from '../db/schema';
import { ConflictError } from '../db/tx';
import { AppError, notOwned } from '../errors';
import { applyCommand, CommandSequencer, type CommandDeps } from '../hunt/commands';
import type { LifecycleFeed } from '../hunt/feed';
import { readHunt, startHunt, type HuntPlan, type LifecycleDeps } from '../hunt/lifecycle';
import { strategyVersions } from '../hunt/pending';
import { requireSession } from '../plugins/session';
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

function requireIdempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
    throw new AppError('VALIDATION', 'idempotency-key');
  }
  return key;
}

/** The request hash an idempotency key is bound to (P-25). */
async function hashRequest(value: unknown): Promise<string> {
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

    // 1. Ownership, for everything named, before any rule.
    const characters = await db
      .select({ id: schema.characters.id, classId: schema.characters.classId })
      .from(schema.characters)
      .where(and(eq(schema.characters.accountId, account.id), inArray(schema.characters.id, body.characterIds)));
    if (characters.length !== new Set(body.characterIds).size || characters.length !== body.characterIds.length) {
      throw notOwned('characterIds');
    }
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
    if (strategy.payloadSchemaVersion !== STRATEGY_PAYLOAD_SCHEMA_VERSION) {
      throw new AppError('VALIDATION', 'strategyPreset.payloadSchemaVersion');
    }
    const payload = strategyPresetPayloadSchema.safeParse(strategy.payload);
    if (!payload.success) {
      const path = payload.error.issues[0]?.path.join('.') ?? '';
      throw new AppError('VALIDATION', path === '' ? 'strategyPreset' : `strategyPreset.${path}`);
    }

    // Party order is the order named: the first character is p0.
    const byId = new Map(characters.map((row) => [row.id, row.classId]));
    const [bag] = await db
      .select({ used: count() })
      .from(schema.items)
      .where(and(eq(schema.items.accountId, account.id), isNull(schema.items.equippedCharacterId)));
    const [accountRow] = await db
      .select({ bagCapacity: schema.accounts.bagCapacity })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id));

    const plan: HuntPlan = {
      mapId: body.mapId,
      input: {
        classes: body.characterIds.map((id) => byId.get(id) as ClassId),
        recipe,
        placement: payload.data.placement as Record<string, PositionId>,
        strategies: payload.data.strategies as Record<string, Strategy>,
        rest: payload.data.rest,
        wipeLimit: payload.data.wipeLimit,
      },
      activeStrategy: { presetId: strategy.id, presetVersion: strategy.presetVersion },
      activeLoot: { presetId: loot.id, presetVersion: loot.presetVersion },
      inventoryProjection: { capacity: accountRow?.bagCapacity ?? 0, usedSlots: bag?.used ?? 0, stackHeadroom: {} },
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
}
