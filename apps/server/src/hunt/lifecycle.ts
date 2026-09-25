/**
 * The authoritative hunt lifecycle (milestone B spec part 2 §1).
 *
 * Every mutating step follows the account mutation sequence of layer-1 §8.1:
 * read a coherent versioned snapshot and the server command time, simulate
 * *outside* the transaction, then one short `withAccountTx` that re-checks the
 * account version and commits the checkpoint atomically with the increment.
 * A worker result formed against a version that has since moved is discarded,
 * never merged (P-21).
 *
 * What leaves this module for a client is `project(state)` plus `generation`
 * and the event cursor — never the seed, never the queue (B-08).
 *
 * Stop and the return-to-town travel segment are not here yet: the travel
 * duration is an open content input (`townReturnTravelMs: null`), and a stop
 * that consumes it cannot be written until the owner sets it.
 */
import { eq } from 'drizzle-orm';
import { SimError, type LabInput, type PublicState, type Simulation, type SimState } from '@narok/sim';
import * as schema from '../db/schema';
import {
  archiveCheckpoint,
  CheckpointMissingError,
  CheckpointVersionError,
  loadCheckpoint,
  saveCheckpoint,
  type CheckpointVersions,
} from '../db/repositories/hunts';
import { ConflictError, withAccountTx, type Database, type IdempotencySpec, type Tx } from '../db/tx';
import { AppError } from '../errors';
import { SegmentPool } from '../workers/pool';
import type { SegmentResult } from '../workers/segment';
import { reanchor, settlementWindow, stopWallInstant, type HuntAnchors } from './clock';
import type { HuntConfig } from './config';
import { decodeCheckpoint, encodeCheckpoint, ENVELOPE_VERSION, type CheckpointEnvelope } from './envelope';

type PresetRef = CheckpointEnvelope['activeStrategy'];

/**
 * Everything a start needs, already resolved from account records and
 * validated for ownership by the route. It names no seed: the seed is the
 * server's (part 1 §2).
 */
export interface HuntPlan {
  readonly mapId: string;
  readonly input: Omit<LabInput, 'seed'>;
  readonly activeStrategy: PresetRef;
  readonly activeLoot: PresetRef;
  readonly inventoryProjection: CheckpointEnvelope['inventoryProjection'];
}

/** Test-only seams for injecting a crash at the two instants that matter. */
export interface LifecycleHooks {
  /** Between the worker's result and the transaction. */
  readonly afterSegment?: () => void | Promise<void>;
  /** Inside the transaction, after every write, before the commit. */
  readonly beforeCommit?: () => void | Promise<void>;
}

export interface LifecycleDeps {
  readonly db: Database;
  readonly sim: Simulation;
  /** The deployed versions. A checkpoint under any other is refused, never substituted (P-28). */
  readonly pins: CheckpointVersions;
  readonly config: HuntConfig;
  readonly now: () => number;
  readonly drawSeed: () => number;
  readonly newHuntId: () => string;
  readonly pool: SegmentPool;
  readonly precompute: PrecomputeCache;
  readonly hooks?: LifecycleHooks;
}

/** What a client receives. Serialisable, because it is also the idempotent response. */
export interface HuntView {
  readonly huntId: string;
  readonly generation: number;
  /** The next domain sequence: where the client's event cursor starts. */
  readonly eventCursor: number;
  readonly stateVersion: number;
  readonly state: PublicState;
}

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

function cryptoU32(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/**
 * A CSPRNG nonzero u32 (part 2 §9 #1). Zero is redrawn rather than mapped,
 * because the engine's xorshift rejects a zero state and a mapping would bias
 * one value.
 */
export function drawHuntSeed(random: () => number = cryptoU32): number {
  for (;;) {
    const value = random() >>> 0;
    if (value !== 0) return value;
  }
}

// ---------------------------------------------------------------------------
// Step 3's private cache
// ---------------------------------------------------------------------------

export interface PrecomputeKey {
  /** Every hunt starts at (1, 0), so the hunt itself is part of the key. */
  readonly huntId: string;
  readonly generation: number;
  readonly checkpointSeq: number;
}

/**
 * Precomputed playback, held in memory only and keyed to the exact checkpoint
 * it was computed from. Any commit moves `checkpointSeq` and any intervention
 * moves `generation`, so a stale entry cannot be read back even if a discard
 * were missed — and nothing here is ever a reward source (layer-1 §4.4 step 8).
 */
export class PrecomputeCache {
  private readonly entries = new Map<string, { key: PrecomputeKey; result: SegmentResult }>();

  get(accountId: string, key: PrecomputeKey): SegmentResult | undefined {
    const entry = this.entries.get(accountId);
    if (entry === undefined) return undefined;
    const same =
      entry.key.huntId === key.huntId &&
      entry.key.generation === key.generation &&
      entry.key.checkpointSeq === key.checkpointSeq;
    return same ? entry.result : undefined;
  }

  set(accountId: string, key: PrecomputeKey, result: SegmentResult): void {
    this.entries.set(accountId, { key, result });
  }

  discard(accountId: string): void {
    this.entries.delete(accountId);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface LoadedHunt {
  readonly envelope: CheckpointEnvelope;
  readonly status: string;
  readonly mapId: string;
  /** The account version read *before* the hunt row, so any later hunt write moves it. */
  readonly stateVersion: number;
}

async function readAccountVersion(db: Database | Tx, accountId: string): Promise<number> {
  const [row] = await db
    .select({ stateVersion: schema.accounts.stateVersion })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  if (row === undefined) throw new AppError('NOT_OWNED', 'accountId');
  return row.stateVersion;
}

/**
 * Loads the durable checkpoint under the deployed pins. A faulted hunt answers
 * `HUNT_FAULTED` to everything but the explicit recovery (P-38); a hunt pinned
 * to other versions answers `CONTENT_VERSION_MISMATCH` and nothing is replayed
 * under whatever happens to be deployed (B-29).
 */
export async function readHunt(deps: LifecycleDeps, accountId: string): Promise<LoadedHunt> {
  const stateVersion = await readAccountVersion(deps.db, accountId);

  let loaded;
  try {
    loaded = await loadCheckpoint(deps.db, accountId, deps.pins);
  } catch (error) {
    if (error instanceof CheckpointMissingError) throw new AppError('NOT_FOUND', 'hunt');
    if (error instanceof CheckpointVersionError) throw new AppError('CONTENT_VERSION_MISMATCH', error.field);
    throw error;
  }

  if (loaded.status === 'faulted') throw new AppError('HUNT_FAULTED', 'hunt.status');

  return {
    envelope: decodeCheckpoint(loaded.encoded),
    status: loaded.status,
    mapId: loaded.mapId,
    stateVersion,
  };
}

function keyOf(envelope: CheckpointEnvelope): PrecomputeKey {
  return { huntId: envelope.huntId, generation: envelope.generation, checkpointSeq: envelope.checkpointSeq };
}

/**
 * Jobs coalesce only when they start from the same checkpoint. Keyed by
 * account alone, a caller that read a newer checkpoint could join a job
 * running from an older one and commit its result on top of the newer row.
 */
function jobKey(accountId: string, envelope: CheckpointEnvelope): string {
  const key = keyOf(envelope);
  return `${accountId}:${key.huntId}:${key.generation}:${key.checkpointSeq}`;
}

function anchorsOf(envelope: CheckpointEnvelope): HuntAnchors {
  return {
    wallAnchorMs: envelope.wallAnchorMs,
    simAnchorMs: envelope.simAnchorMs,
    pausedWallMs: envelope.pausedWallMs,
    lastSeenAt: envelope.lastSeenAt,
    offlineCapMs: envelope.offlineCapMs,
  };
}

function versionsOf(state: SimState): CheckpointVersions {
  return {
    simulationVersion: state.simulationVersion,
    contentVersion: state.contentVersion,
    gridHash: state.gridHash,
  };
}

function view(sim: Simulation, envelope: CheckpointEnvelope, state: SimState, stateVersion: number): HuntView {
  return {
    huntId: envelope.huntId,
    generation: envelope.generation,
    eventCursor: state.nextDomainSeq,
    stateVersion,
    state: sim.project(state),
  };
}

// ---------------------------------------------------------------------------
// Step 1: start
// ---------------------------------------------------------------------------

export interface StartCommand {
  readonly accountId: string;
  readonly expectedStateVersion: number;
  readonly plan: HuntPlan;
  readonly idempotency?: IdempotencySpec;
}

export async function startHunt(deps: LifecycleDeps, command: StartCommand): Promise<HuntView> {
  const T0 = deps.now();
  const huntId = deps.newHuntId();

  // Simulated outside the transaction; `start` is cheap, but the rule is the rule.
  let state: SimState;
  try {
    state = deps.sim.start({ ...command.plan.input, seed: deps.drawSeed() });
  } catch (error) {
    if (error instanceof SimError && (error.code === 'INVALID_INPUT' || error.code === 'INVALID_CONTENT')) {
      throw new AppError('VALIDATION', `plan.${error.field}`);
    }
    throw error;
  }

  const envelope: CheckpointEnvelope = {
    envelopeVersion: ENVELOPE_VERSION,
    accountId: command.accountId,
    huntId,
    generation: 1,
    checkpointSeq: 0,
    accountStateVersion: command.expectedStateVersion,
    wallAnchorMs: T0,
    simAnchorMs: 0,
    pausedWallMs: 0,
    lastSeenAt: T0,
    offlineCapMs: deps.config.offlineCapMs,
    rewardSeq: 0,
    pendingRewards: [],
    pity: { epicPlus: 0, legendary: 0 },
    activeStrategy: command.plan.activeStrategy,
    activeLoot: command.plan.activeLoot,
    pendingStrategy: null,
    pendingLoot: null,
    inventoryProjection: command.plan.inventoryProjection,
    stopContext: null,
    state: deps.sim.encode(state),
  };
  const encoded = encodeCheckpoint(envelope);

  const result = await withAccountTx(
    deps.db,
    {
      accountId: command.accountId,
      expectedStateVersion: command.expectedStateVersion,
      operation: 'hunt.start',
      idempotency: command.idempotency,
    },
    async (tx) => {
      // Checked under the account lock, so two starts cannot both see "none".
      const [existing] = await tx
        .select({ status: schema.hunts.status })
        .from(schema.hunts)
        .where(eq(schema.hunts.accountId, command.accountId));
      if (existing?.status === 'faulted') throw new AppError('HUNT_FAULTED', 'hunt.status');
      if (existing?.status === 'running') throw new AppError('RULE_VIOLATION', 'hunt.status');

      await saveCheckpoint(tx, {
        accountId: command.accountId,
        status: 'running',
        mapId: command.plan.mapId,
        encoded,
        checkpointSchemaVersion: ENVELOPE_VERSION,
        ...versionsOf(state),
        simAnchorMs: 0,
        wallAnchorAt: new Date(T0),
        lastSeenAt: new Date(T0),
        generation: 1,
        maxBytes: deps.config.maxCheckpointBytes,
      });

      await deps.hooks?.beforeCommit?.();
      return view(deps.sim, envelope, state, command.expectedStateVersion + 1);
    },
  );

  deps.precompute.discard(command.accountId);
  return result;
}

// ---------------------------------------------------------------------------
// Faulting
// ---------------------------------------------------------------------------

interface FaultReason {
  readonly code: string;
  readonly field: string;
  /** The reproduction inputs: with the archived checkpoint, enough to replay the failure. */
  readonly simTarget: number;
  readonly wallMs: number;
}

/**
 * Rolls nothing forward: the last valid checkpoint stays exactly as it was,
 * a copy goes to the archive with the reproduction inputs, and the row is
 * marked so every later command short-circuits (P-38, B-30). No wipe is
 * charged and no town settlement is invented.
 */
async function faultHunt(deps: LifecycleDeps, accountId: string, reason: FaultReason): Promise<never> {
  deps.precompute.discard(accountId);

  // Each attempt re-reads the version: a fault must land even while other
  // commands keep committing, or the next persist would run the engine again.
  for (let attempt = 1; ; attempt++) {
    const stateVersion = await readAccountVersion(deps.db, accountId);
    try {
      await withAccountTx(deps.db, { accountId, expectedStateVersion: stateVersion, operation: 'hunt.fault' }, (tx) =>
        markFaulted(tx, accountId, reason),
      );
      break;
    } catch (error) {
      const contended = error instanceof ConflictError && error.code === 'CONFLICT_STATE_VERSION';
      if (!contended || attempt >= FAULT_ATTEMPTS) throw error;
    }
  }

  throw new AppError('HUNT_FAULTED', 'hunt.status');
}

/** Bounded, like every retry (P-22); each attempt starts from a fresh read. */
const FAULT_ATTEMPTS = 5;

async function markFaulted(tx: Tx, accountId: string, reason: FaultReason): Promise<void> {
  const [row] = await tx
    .select({ status: schema.hunts.status })
    .from(schema.hunts)
    .where(eq(schema.hunts.accountId, accountId));
  // Already faulted by a concurrent caller: one archive row, not two.
  if (row === undefined || row.status === 'faulted') return;

  await archiveCheckpoint(tx, accountId, 'fault');
  await tx
    .update(schema.hunts)
    .set({ status: 'faulted', faultedReason: JSON.stringify(reason), updatedAt: new Date() })
    .where(eq(schema.hunts.accountId, accountId));
}

export interface RecoverCommand {
  readonly accountId: string;
  readonly expectedStateVersion: number;
  readonly idempotency?: IdempotencySpec;
}

/**
 * The one command a faulted hunt accepts (P-38): an explicit, guarded return
 * to town. The engine state is the last valid checkpoint, not advanced and not
 * repaired, so no settlement is invented and no wipe is charged. The fault
 * reason stays on the row for the record; the archive row already holds the
 * reproduction inputs.
 */
export async function recoverFaultedHunt(deps: LifecycleDeps, command: RecoverCommand): Promise<void> {
  const nowWall = deps.now();

  await withAccountTx(
    deps.db,
    {
      accountId: command.accountId,
      expectedStateVersion: command.expectedStateVersion,
      operation: 'hunt.recover',
      idempotency: command.idempotency,
    },
    async (tx) => {
      let loaded;
      try {
        loaded = await loadCheckpoint(tx, command.accountId, deps.pins);
      } catch (error) {
        if (error instanceof CheckpointMissingError) throw new AppError('NOT_FOUND', 'hunt');
        if (error instanceof CheckpointVersionError) throw new AppError('CONTENT_VERSION_MISMATCH', error.field);
        throw error;
      }
      if (loaded.status !== 'faulted') throw new AppError('RULE_VIOLATION', 'hunt.status');

      const envelope = decodeCheckpoint(loaded.encoded);
      const atSimMs = deps.sim.decode(envelope.state).nowMs;
      const encoded = encodeCheckpoint({
        ...envelope,
        stopContext: { reason: 'operator', atSimMs, atWallMs: nowWall },
      });

      await saveCheckpoint(tx, {
        accountId: command.accountId,
        status: 'stopped',
        mapId: loaded.mapId,
        encoded,
        checkpointSchemaVersion: ENVELOPE_VERSION,
        simulationVersion: loaded.simulationVersion,
        contentVersion: loaded.contentVersion,
        gridHash: loaded.gridHash,
        simAnchorMs: loaded.simAnchorMs,
        wallAnchorAt: loaded.wallAnchorAt,
        lastSeenAt: loaded.lastSeenAt,
        generation: loaded.generation,
        faultedReason: loaded.faultedReason,
        maxBytes: deps.config.maxCheckpointBytes,
      });
    },
  );

  deps.precompute.discard(command.accountId);
}

/**
 * Runs a segment, translating an engine failure into the right outcome: a
 * version mismatch is the client's to resolve, anything else faults the hunt.
 */
async function runOrFault(
  deps: LifecycleDeps,
  accountId: string,
  jobKey: string,
  request: Parameters<SegmentPool['run']>[1],
  wallMs: number,
): Promise<SegmentResult> {
  try {
    return await deps.pool.run(jobKey, request);
  } catch (error) {
    if (error instanceof SimError) {
      if (error.code === 'WRONG_VERSION') throw new AppError('CONTENT_VERSION_MISMATCH', error.field);
      return faultHunt(deps, accountId, {
        code: error.code,
        field: error.field,
        simTarget: request.simTarget,
        wallMs,
      });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Step 6: persist
// ---------------------------------------------------------------------------

export interface PersistOptions {
  /** Refresh presence only when a connection is live (part 2 §3's anchor table). */
  readonly live: boolean;
}

export interface PersistResult {
  readonly creditedSimMs: number;
  readonly completion: SegmentResult['completion'] | 'inert';
  readonly stateVersion: number;
}

/**
 * Settles the hunt to the wall clock and commits it. A failed commit leaves the
 * previous checkpoint durable; re-running from it reproduces the same bytes,
 * which is what recovery (step 8) rests on.
 *
 * Rewards are not drained here yet — the reward path arrives with drops.
 */
export async function persistHunt(deps: LifecycleDeps, accountId: string, options: PersistOptions): Promise<PersistResult> {
  const loaded = await readHunt(deps, accountId);
  if (loaded.status !== 'running') {
    return { creditedSimMs: 0, completion: 'inert', stateVersion: loaded.stateVersion };
  }

  const nowWall = deps.now();
  const { envelope } = loaded;
  const anchors = anchorsOf(envelope);
  const window = settlementWindow(anchors, nowWall);

  const segment = await runOrFault(
    deps,
    accountId,
    jobKey(accountId, envelope),
    { encodedState: envelope.state, simTarget: window.simTarget, collect: 'summary' },
    nowWall,
  );
  await deps.hooks?.afterSegment?.();

  const next = nextAnchors(anchors, nowWall, window.simTarget, segment, options);
  const stopped = segment.completion === 'stopped';
  const updated: CheckpointEnvelope = {
    ...envelope,
    checkpointSeq: envelope.checkpointSeq + 1,
    accountStateVersion: loaded.stateVersion,
    ...next,
    stopContext:
      stopped && segment.stopReason !== null
        ? {
            reason: segment.stopReason,
            atSimMs: segment.simNowMs,
            // From the pre-settlement anchors (part 2 §3).
            atWallMs: stopWallInstant(anchors, segment.simNowMs),
          }
        : envelope.stopContext,
    state: segment.encodedState,
  };
  const encoded = encodeCheckpoint(updated);

  // Checked before the transaction, so an oversized checkpoint faults cleanly
  // instead of aborting a commit halfway (part 1 §9 #6).
  if (Buffer.byteLength(encoded, 'utf8') > deps.config.maxCheckpointBytes) {
    return faultHunt(deps, accountId, {
      code: 'CHECKPOINT_TOO_LARGE',
      field: 'checkpoint',
      simTarget: window.simTarget,
      wallMs: nowWall,
    });
  }

  const state = deps.sim.decode(segment.encodedState);
  try {
    await withAccountTx(
      deps.db,
      { accountId, expectedStateVersion: loaded.stateVersion, operation: 'hunt.persist' },
      async (tx) => {
        await saveCheckpoint(tx, {
          accountId,
          status: stopped ? 'stopped' : 'running',
          mapId: loaded.mapId,
          encoded,
          checkpointSchemaVersion: ENVELOPE_VERSION,
          ...versionsOf(state),
          simAnchorMs: updated.simAnchorMs,
          wallAnchorAt: new Date(updated.wallAnchorMs),
          lastSeenAt: new Date(updated.lastSeenAt),
          generation: updated.generation,
          maxBytes: deps.config.maxCheckpointBytes,
        });
        await deps.hooks?.beforeCommit?.();
      },
    );
  } finally {
    // Whatever happened, the precomputation was formed against a checkpoint
    // that is either superseded or about to be re-simulated.
    deps.precompute.discard(accountId);
  }

  return {
    creditedSimMs: segment.creditedSimMs,
    completion: segment.completion,
    stateVersion: loaded.stateVersion + 1,
  };
}

/**
 * The anchors after a commit.
 *
 * A segment that covered its whole window (or that the engine stopped)
 * re-anchors to now and, on a live connection, refreshes presence.
 *
 * One that fell short — cut by the work bound, or a coalesced result computed
 * for an earlier instant than this caller's — anchors at the wall instant it
 * actually reached and leaves presence alone. Refreshing presence there would
 * re-base the offline cap on an unfinished settlement, and the next one could
 * then credit past the cap (B-L03); re-anchoring to now would forfeit the
 * uncovered remainder instead of leaving it owed.
 */
function nextAnchors(
  anchors: HuntAnchors,
  nowWall: number,
  simTarget: number,
  segment: SegmentResult,
  options: PersistOptions,
): Pick<CheckpointEnvelope, 'wallAnchorMs' | 'simAnchorMs' | 'pausedWallMs' | 'lastSeenAt'> {
  const short = segment.completion !== 'stopped' && segment.simNowMs < simTarget;

  if (short) {
    return {
      wallAnchorMs: stopWallInstant(anchors, segment.simNowMs),
      simAnchorMs: segment.simNowMs,
      pausedWallMs: 0,
      lastSeenAt: anchors.lastSeenAt,
    };
  }

  const settled = reanchor(anchors, nowWall, segment.simNowMs);
  return {
    wallAnchorMs: settled.wallAnchorMs,
    simAnchorMs: settled.simAnchorMs,
    pausedWallMs: settled.pausedWallMs,
    lastSeenAt: options.live ? settled.lastSeenAt : anchors.lastSeenAt,
  };
}

// ---------------------------------------------------------------------------
// Step 3: precompute
// ---------------------------------------------------------------------------

/**
 * Advances a *copy* of the committed checkpoint by the configured horizon and
 * holds the result in memory. Nothing durable is written and nothing here can
 * be credited: rewards come only from a committed settlement.
 */
export async function precomputeHunt(deps: LifecycleDeps, accountId: string): Promise<SegmentResult> {
  const loaded = await readHunt(deps, accountId);
  const key = keyOf(loaded.envelope);

  const cached = deps.precompute.get(accountId, key);
  if (cached !== undefined) return cached;

  const nowWall = deps.now();
  const committedAt = deps.sim.decode(loaded.envelope.state).nowMs;
  const result = await runOrFault(
    deps,
    accountId,
    // Its own job slot: a precompute must never be handed a settlement's
    // result by the pool's coalescing, or the reverse.
    `${jobKey(accountId, loaded.envelope)}:precompute`,
    {
      encodedState: loaded.envelope.state,
      simTarget: committedAt + deps.config.precomputeHorizonMs,
      collect: 'events',
    },
    nowWall,
  );

  deps.precompute.set(accountId, key, result);
  return result;
}
