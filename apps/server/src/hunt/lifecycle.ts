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
 * A stop is settle-then-apply like every intervention: the elapsed time is
 * committed first, then the encounter is abandoned and the party travels to
 * town for the content's `townReturnTravelMs` (spec §4.0, §4.0.1).
 */
import { and, eq } from 'drizzle-orm';
import type { Content } from '@narok/data';
import {
  SimError,
  takeDispositionedRewards,
  type HuntSetup,
  type LabInput,
  type PublicState,
  type Simulation,
  type SimState,
} from '@narok/sim';
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
import type { SettlementWindow } from './clock';
import type { HuntConfig } from './config';
import {
  decodeCheckpoint,
  encodeCheckpoint,
  ENVELOPE_VERSION,
  type CheckpointEnvelope,
  type PresetRef,
} from './envelope';
import { lootVersions, strategyVersions } from './pending';
import { commitRewards, identifyRewards, indexDropProtection, type HuntReward, type RewardSink } from './rewards';
import { settle, type Settlement } from './settle';

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
  /**
   * The account-side inputs the engine rolls and dispositions drops against
   * (part 3 §2.5): the active loot preset's validated payload, the bag, and the
   * account's bad-luck counters. Copied into the checkpoint at start.
   */
  readonly setup: Required<HuntSetup>;
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
  /** The validated content the simulation was built from; the travel time lives here. */
  readonly content: Content;
  /** The deployed versions. A checkpoint under any other is refused, never substituted (P-28). */
  readonly pins: CheckpointVersions;
  readonly config: HuntConfig;
  readonly now: () => number;
  readonly drawSeed: () => number;
  readonly newHuntId: () => string;
  readonly pool: SegmentPool;
  readonly precompute: PrecomputeCache;
  readonly hooks?: LifecycleHooks;
  /**
   * Where drained rewards are written, inside the commit transaction (R117,
   * R132). Defaults to {@link commitRewards}; a test may observe or fail it.
   */
  readonly rewardSink?: RewardSink;
}

/** What a client receives. Serialisable, because it is also the idempotent response. */
export interface HuntView {
  readonly huntId: string;
  readonly generation: number;
  /** The next domain sequence: where the client's event cursor starts. */
  readonly eventCursor: number;
  readonly stateVersion: number;
  readonly state: PublicState;
  /** The rules in force now, and the version queued for the next spawn — separately (UI spec §5). */
  readonly activeStrategy: PresetRef;
  readonly pendingStrategy: PresetRef | null;
  /** The loot filter in force and the one applied after the cutoff, separately (UI spec §6). */
  readonly activeLoot: PresetRef;
  readonly pendingLoot: PresetRef | null;
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

export async function readAccountVersion(db: Database | Tx, accountId: string): Promise<number> {
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

function versionsOf(state: SimState): CheckpointVersions {
  return {
    simulationVersion: state.simulationVersion,
    contentVersion: state.contentVersion,
    gridHash: state.gridHash,
  };
}

export function view(sim: Simulation, envelope: CheckpointEnvelope, state: SimState, stateVersion: number): HuntView {
  const versions = strategyVersions(envelope);
  const loot = lootVersions(envelope);
  return {
    huntId: envelope.huntId,
    generation: envelope.generation,
    eventCursor: state.nextDomainSeq,
    stateVersion,
    state: sim.project(state),
    activeStrategy: versions.activeVersion,
    pendingStrategy: versions.pendingVersion,
    activeLoot: loot.activeVersion,
    pendingLoot: loot.pendingVersion,
  };
}

/**
 * Commits drained rewards and the bad-luck index inside a checkpoint's own
 * transaction (P-27; rulings R128, R132): no reward exists without the commit
 * that produced it, and `account_drop_protection` always equals the counters
 * the committed checkpoint carries.
 */
async function commitHuntRewards(
  deps: LifecycleDeps,
  tx: Tx,
  accountId: string,
  state: SimState,
  rewards: readonly HuntReward[],
  stateVersionAfter: number,
): Promise<void> {
  await indexDropProtection(tx, accountId, state.dropProtection);
  if (rewards.length === 0) return;
  const sink = deps.rewardSink ?? commitRewards;
  await sink(tx, rewards, { accountId, stateVersionAfter, contentVersion: state.contentVersion });
}

/**
 * A command replayed under its idempotency key answers from the stored result
 * without settling again; the same key with different input is refused
 * (layer-1 §8.1). `undefined` when the key is new.
 */
export async function storedResult<T>(
  deps: LifecycleDeps,
  accountId: string,
  idempotency: IdempotencySpec | undefined,
): Promise<T | undefined> {
  if (idempotency === undefined) return undefined;
  const [stored] = await deps.db
    .select({ requestHash: schema.commandResults.requestHash, response: schema.commandResults.response })
    .from(schema.commandResults)
    .where(
      and(eq(schema.commandResults.accountId, accountId), eq(schema.commandResults.idempotencyKey, idempotency.key)),
    );
  if (stored === undefined) return undefined;
  if (stored.requestHash !== idempotency.requestHash) {
    throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'idempotency-key');
  }
  return stored.response as T;
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
    state = deps.sim.start({ ...command.plan.input, seed: deps.drawSeed() }, command.plan.setup);
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
    activeStrategy: command.plan.activeStrategy,
    activeLoot: command.plan.activeLoot,
    pendingStrategy: null,
    pendingLoot: [],
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
        .select({ status: schema.hunts.status, checkpoint: schema.hunts.checkpoint })
        .from(schema.hunts)
        .where(eq(schema.hunts.accountId, command.accountId));
      if (existing?.status === 'faulted') throw new AppError('HUNT_FAULTED', 'hunt.status');
      if (existing?.status === 'running') throw new AppError('RULE_VIOLATION', 'hunt.status');
      if (existing !== undefined && inTownAt(existing.checkpoint) > T0) {
        throw new AppError('RULE_VIOLATION', 'hunt.travel');
      }

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

/** When the previous hunt's party reaches town; `-Infinity` when nothing is in transit. */
function inTownAt(checkpoint: Uint8Array): number {
  try {
    const stop = decodeCheckpoint(Buffer.from(checkpoint).toString('utf8')).stopContext;
    return stop?.inTownAtWallMs ?? Number.NEGATIVE_INFINITY;
  } catch {
    // An older envelope cannot carry a journey; it blocks nothing.
    return Number.NEGATIVE_INFINITY;
  }
}

// ---------------------------------------------------------------------------
// Step 7 for stop: settle, then return to town
// ---------------------------------------------------------------------------

export interface StopCommand {
  readonly accountId: string;
  /** Optional: the stop route is unguarded (part 1 §3), a stop needs no read. */
  readonly expectedStateVersion?: number;
  readonly idempotency?: IdempotencySpec;
  /**
   * The server command time (part 2 §4). Recorded by the command sequencer
   * when the command arrives; `deps.now()` when called directly.
   */
  readonly atWall?: number;
}

/**
 * The owner's stop (spec §4.0): stopping *is* the return to town. The elapsed
 * time is settled and committed first, and that settlement stands even if the
 * stop itself is then refused — settling is not conditional on the intent
 * being legal (part 2 §1 step 7). Then the encounter is abandoned with the
 * engine's own queue-clearing stop, which preserves damage, spent resources,
 * RNG progression and metrics exactly (B-L18), and the party travels to town.
 */
export async function stopHunt(deps: LifecycleDeps, command: StopCommand): Promise<HuntView> {
  // A replay answers from its stored result without settling again.
  const replay = await storedResult<HuntView>(deps, command.accountId, command.idempotency);
  if (replay !== undefined) return replay;

  // The caller's guard is checked against the version it read, before the
  // settlement moves it; a stale intent settles nothing on its behalf.
  const current = await readAccountVersion(deps.db, command.accountId);
  if (command.expectedStateVersion !== undefined && current !== command.expectedStateVersion) {
    throw new ConflictError('CONFLICT_STATE_VERSION', 'expectedStateVersion', current);
  }

  const nowWall = command.atWall ?? deps.now();
  const settled = await persistHunt(deps, command.accountId, { live: true, atWall: nowWall });
  const travelMs = deps.content.townReturnTravelMs ?? 0;

  const result = await withAccountTx(
    deps.db,
    {
      accountId: command.accountId,
      expectedStateVersion: settled.stateVersion,
      operation: 'hunt.stop',
      idempotency: command.idempotency,
    },
    async (tx) => {
      const loaded = await loadCheckpoint(tx, command.accountId, deps.pins);
      if (loaded.status !== 'running') throw new AppError('RULE_VIOLATION', 'hunt.status');

      const envelope = decodeCheckpoint(loaded.encoded);
      // The engine's stop dispositions the drops the abandoned encounter's
      // kills rolled (R127); they are credited with this commit.
      const { state, rewards: dropped } = takeDispositionedRewards(deps.sim.stop(deps.sim.decode(envelope.state)));
      const updated: CheckpointEnvelope = {
        ...envelope,
        generation: envelope.generation + 1,
        checkpointSeq: envelope.checkpointSeq + 1,
        stopContext: {
          reason: 'operator',
          atSimMs: state.nowMs,
          atWallMs: nowWall,
          inTownAtWallMs: nowWall + travelMs,
        },
        state: deps.sim.encode(state),
      };

      await saveCheckpoint(tx, {
        accountId: command.accountId,
        status: 'stopped',
        mapId: loaded.mapId,
        encoded: encodeCheckpoint(updated),
        checkpointSchemaVersion: ENVELOPE_VERSION,
        ...versionsOf(state),
        simAnchorMs: updated.simAnchorMs,
        wallAnchorAt: new Date(updated.wallAnchorMs),
        lastSeenAt: new Date(updated.lastSeenAt),
        generation: updated.generation,
        maxBytes: deps.config.maxCheckpointBytes,
      });
      await commitHuntRewards(deps, tx, command.accountId, state, identifyRewards(envelope, dropped), settled.stateVersion + 1);
      await deps.hooks?.beforeCommit?.();

      return view(deps.sim, updated, state, settled.stateVersion + 1);
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

/**
 * Bounded, like every retry (P-22); each attempt starts from a fresh read.
 * Shared by the fault write and by a command's own settlement (R120).
 */
export const CONTENDED_ATTEMPTS = 5;
const FAULT_ATTEMPTS = CONTENDED_ATTEMPTS;

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
        // No journey: recovery is an operator action, not the player's stop.
        stopContext: { reason: 'operator', atSimMs, atWallMs: nowWall, inTownAtWallMs: nowWall },
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
  /**
   * `'events'` when a connected client will be shown the settled window;
   * summary otherwise. Either way the committed state is identical.
   */
  readonly collect?: 'events' | 'summary';
  /** The wall instant to settle to: a command's recorded time, or `deps.now()`. */
  readonly atWall?: number;
}

export interface PersistResult {
  readonly creditedSimMs: number;
  /** The settled window's events, when `collect` asked for them; every one has elapsed. */
  readonly events: SegmentResult['events'];
  /** The committed checkpoint, so a caller need not read it back. */
  readonly envelope: CheckpointEnvelope;
  /** The checkpoint this settlement started from: the "before" of an away report. */
  readonly previous: CheckpointEnvelope;
  readonly completion: SegmentResult['completion'] | 'inert';
  readonly stateVersion: number;
  /** The window of the first round; later rounds share its presence and its cap. */
  readonly window: SettlementWindow | null;
  /** The engine stop inside the window, if any, placed with the pre-settlement anchors. */
  readonly stop: Settlement['stop'];
  readonly uncovered: Settlement['uncovered'];
  /** Every reward drained and committed, in order, across every round. */
  readonly rewards: readonly HuntReward[];
  /** Checkpoints committed: more than one when a full reward carrier forced a commit. */
  readonly commits: number;
}

/**
 * Settles the hunt to the wall clock and commits it, through `settle.ts`. A
 * failed commit leaves the previous checkpoint durable; re-running from it
 * reproduces the same bytes and the same reward ids, which is what recovery
 * (step 8) rests on.
 *
 * A full reward carrier forces a commit, and the settlement then continues
 * from it toward the same absolute target, one committed round at a time —
 * exactly as a work-budget yield continues one level down (part 2 §9 #8).
 */
export async function persistHunt(deps: LifecycleDeps, accountId: string, options: PersistOptions): Promise<PersistResult> {
  const nowWall = options.atWall ?? deps.now();
  let loaded = await readHunt(deps, accountId);
  const previous = loaded.envelope;
  if (loaded.status !== 'running') {
    return {
      creditedSimMs: 0,
      events: [],
      envelope: loaded.envelope,
      previous,
      completion: 'inert',
      stateVersion: loaded.stateVersion,
      window: null,
      stop: null,
      uncovered: { afterStopMs: 0, afterCapMs: 0 },
      rewards: [],
      commits: 0,
    };
  }

  let creditedSimMs = 0;
  const events: SegmentResult['events'] = [];
  const rewards: HuntReward[] = [];
  let window: SettlementWindow | null = null;
  let commits = 0;

  for (;;) {
    const settlement = await persistRound(deps, accountId, loaded, nowWall, options);
    commits += 1;
    creditedSimMs += settlement.creditedSimMs;
    for (const event of settlement.events) events.push(event);
    for (const reward of settlement.rewards) rewards.push(reward);
    window ??= settlement.window;

    const stateVersion = loaded.stateVersion + 1;
    if (settlement.completion !== 'reward-cap') {
      return {
        creditedSimMs,
        events,
        envelope: settlement.envelope,
        previous,
        completion: settlement.completion,
        stateVersion,
        window,
        stop: settlement.stop,
        uncovered: settlement.uncovered,
        rewards,
        commits,
      };
    }
    loaded = { ...loaded, envelope: settlement.envelope, stateVersion };
  }
}

/** One settlement round and its commit. */
async function persistRound(
  deps: LifecycleDeps,
  accountId: string,
  loaded: LoadedHunt,
  nowWall: number,
  options: PersistOptions,
): Promise<Settlement> {
  const { envelope } = loaded;
  const collect = options.collect ?? 'summary';

  const settlement = await settle(
    envelope,
    nowWall,
    async (request) => {
      const segment = await runOrFault(deps, accountId, `${jobKey(accountId, envelope)}:${collect}`, request, nowWall);
      await deps.hooks?.afterSegment?.();
      return segment;
    },
    { live: options.live, collect, accountStateVersion: loaded.stateVersion, rewardCap: deps.config.rewardCarrierCap },
  );

  const updated = settlement.envelope;
  const encoded = encodeCheckpoint(updated);

  // Checked before the transaction, so an oversized checkpoint faults cleanly
  // instead of aborting a commit halfway (part 1 §9 #6).
  if (Buffer.byteLength(encoded, 'utf8') > deps.config.maxCheckpointBytes) {
    return faultHunt(deps, accountId, {
      code: 'CHECKPOINT_TOO_LARGE',
      field: 'checkpoint',
      simTarget: settlement.window.simTarget,
      wallMs: nowWall,
    });
  }

  const state = deps.sim.decode(updated.state);
  const stopped = state.phase === 'stopped';
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
        // Drained rewards and the bad-luck index reach their tables in the
        // checkpoint's transaction, so neither exists without it (P-27).
        await commitHuntRewards(deps, tx, accountId, state, settlement.rewards, loaded.stateVersion + 1);
        await deps.hooks?.beforeCommit?.();
      },
    );
  } finally {
    // Whatever happened, the precomputation was formed against a checkpoint
    // that is either superseded or about to be re-simulated.
    deps.precompute.discard(accountId);
  }

  return settlement;
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
