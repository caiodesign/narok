/**
 * Authoritative commands (milestone B spec part 2 §4; ruling R116).
 *
 * Every command is ordered by `(commandAtWall, receiveSeq)`. Both are the
 * server's: a command carries no client timestamp and no ordering hint, and
 * any it smuggles in is never read. They are allocated together, when the
 * command reaches the head of its account's queue — under the same per-account
 * lock inside which the account state version is read — so two commands given
 * the same `commandAtWall` apply in receive order, the second against the
 * first's committed result, and either lands on top of it or is refused as
 * stale.
 *
 * The lock is this process's. Across processes the account row lock and the
 * version predicate of `withAccountTx` still serialise every commit (layer-1
 * §8.1); the queue adds the receive order within one.
 *
 * The command classes of part 2 §4's table, and what each does:
 *
 * | Command         | Settles first | Bumps generation | Touches presets |
 * |-----------------|---------------|------------------|-----------------|
 * | heartbeat       | yes           | no               | no              |
 * | stop            | yes           | yes              | no              |
 * | apply-strategy  | yes           | yes              | no (reads one)  |
 * | save-strategy-  | no            | no               | yes (only that) |
 * |   preset        |               |                  |                 |
 *
 * Settle-then-apply is unconditional: the settlement commits *before* the
 * intent is validated, so an illegal intent still leaves it standing (B-L13).
 * Stale expectations are checked first, against the read, so a stale command
 * settles nothing on its own behalf and leaves the checkpoint untouched
 * (B-L12).
 */
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { loadCheckpoint, saveCheckpoint } from '../db/repositories/hunts';
import { withAccountTx, type IdempotencySpec } from '../db/tx';
import { AppError, notOwned } from '../errors';
import { encodeCheckpoint, ENVELOPE_VERSION, type PresetRef } from './envelope';
import {
  persistHunt,
  readAccountVersion,
  readHunt,
  stopHunt,
  storedResult,
  view,
  type HuntView,
  type LifecycleDeps,
} from './lifecycle';
import { presetRules, queueStrategy } from './pending';

export interface CommandStamp {
  /** The server command time. Settlement is to this instant, never to the client's. */
  readonly commandAtWall: number;
  /** Per-account receive order, the tie-break for one `commandAtWall`. */
  readonly receiveSeq: number;
}

/**
 * One queue per account. `submit` runs commands one at a time in arrival
 * order and stamps each as it reaches the head.
 */
export class CommandSequencer {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly counters = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  submit<T>(accountId: string, run: (stamp: CommandStamp) => Promise<T>): Promise<T> {
    const previous = this.tails.get(accountId) ?? Promise.resolve();
    const job = previous.then(() => {
      // Under the lock: the stamp, then whatever the command reads.
      const receiveSeq = (this.counters.get(accountId) ?? 0) + 1;
      this.counters.set(accountId, receiveSeq);
      return run({ commandAtWall: this.now(), receiveSeq });
    });

    const tail = job.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(accountId, tail);
    void tail.then(() => {
      // An idle account holds nothing: receive order only has to separate
      // commands that were waiting for one another.
      if (this.tails.get(accountId) === tail) {
        this.tails.delete(accountId);
        this.counters.delete(accountId);
      }
    });
    return job;
  }
}

export interface CommandDeps {
  readonly lifecycle: LifecycleDeps;
  readonly sequencer: CommandSequencer;
}

export type HuntCommand =
  /** A settlement and nothing else (part 2 §3): presence refreshed, generation untouched. */
  | { readonly kind: 'heartbeat' }
  /** The owner's stop: return to town (spec §4.0). */
  | { readonly kind: 'stop' }
  /** Apply next encounter (UI spec §5): queue that exact validated version. */
  | { readonly kind: 'apply-strategy'; readonly presetId: string; readonly presetVersion: number }
  /** Save a preset: the row changes, a running hunt does not (UI spec §5). */
  | { readonly kind: 'save-strategy-preset'; readonly presetId: string; readonly payload: unknown };

export interface CommandRequest {
  readonly command: HuntCommand;
  /** The hunt generation the intent was formed against; stale is refused, never merged. */
  readonly expectedGeneration?: number;
  /** The account version the intent was formed against. */
  readonly expectedStateVersion?: number;
  readonly idempotency?: IdempotencySpec;
}

export interface CommandOutcome extends CommandStamp {
  /** The hunt after the command, for every class that settles. */
  readonly view: HuntView | null;
  /** The saved preset's new version, for a save. */
  readonly preset: PresetRef | null;
}

/**
 * Applies one command for `account`, in order. Only the fields named in
 * {@link CommandRequest} and {@link HuntCommand} are read.
 */
export function applyCommand(
  deps: CommandDeps,
  account: { readonly id: string },
  request: CommandRequest,
): Promise<CommandOutcome> {
  return deps.sequencer.submit(account.id, (stamp) => run(deps.lifecycle, account.id, request, stamp));
}

async function run(
  deps: LifecycleDeps,
  accountId: string,
  request: CommandRequest,
  stamp: CommandStamp,
): Promise<CommandOutcome> {
  const { command } = request;
  const stamped = (view: HuntView | null, preset: PresetRef | null = null): CommandOutcome => ({
    commandAtWall: stamp.commandAtWall,
    receiveSeq: stamp.receiveSeq,
    view,
    preset,
  });

  switch (command.kind) {
    case 'save-strategy-preset':
      return stamped(null, await savePreset(deps, accountId, command, request));

    case 'stop': {
      // A replay answers what the first attempt answered, whatever moved since.
      const replay = await storedResult<HuntView>(deps, accountId, request.idempotency);
      if (replay !== undefined) return stamped(replay);
      await expectCurrent(deps, accountId, request);
      return stamped(
        await stopHunt(deps, { accountId, idempotency: request.idempotency, atWall: stamp.commandAtWall }),
      );
    }

    case 'heartbeat': {
      await expectCurrent(deps, accountId, request);
      const settled = await persistHunt(deps, accountId, { live: true, atWall: stamp.commandAtWall });
      return stamped(view(deps.sim, settled.envelope, deps.sim.decode(settled.envelope.state), settled.stateVersion));
    }

    case 'apply-strategy':
      return stamped(await applyStrategy(deps, accountId, command, request, stamp));
  }
}

/**
 * B-L12: a mismatched generation or account version is refused with both
 * current values, before anything settles, so the checkpoint is unchanged
 * and the client can refetch and resubmit.
 */
async function expectCurrent(deps: LifecycleDeps, accountId: string, request: CommandRequest): Promise<void> {
  if (request.expectedGeneration === undefined && request.expectedStateVersion === undefined) return;
  const loaded = await readHunt(deps, accountId);
  const current = { stateVersion: loaded.stateVersion, generation: loaded.envelope.generation };
  if (request.expectedStateVersion !== undefined && request.expectedStateVersion !== current.stateVersion) {
    throw new AppError('CONFLICT_STATE_VERSION', 'expectedStateVersion', current.stateVersion, current.generation);
  }
  if (request.expectedGeneration !== undefined && request.expectedGeneration !== current.generation) {
    throw new AppError('CONFLICT_STATE_VERSION', 'expectedGeneration', current.stateVersion, current.generation);
  }
}

async function ownedPreset(deps: LifecycleDeps, accountId: string, presetId: string) {
  const [row] = await deps.db
    .select()
    .from(schema.strategyPresets)
    .where(and(eq(schema.strategyPresets.id, presetId), eq(schema.strategyPresets.accountId, accountId)));
  // Absent and not-yours answer identically (P-12).
  if (row === undefined) throw notOwned('presetId');
  return row;
}

async function applyStrategy(
  deps: LifecycleDeps,
  accountId: string,
  command: Extract<HuntCommand, { kind: 'apply-strategy' }>,
  request: CommandRequest,
  stamp: CommandStamp,
): Promise<HuntView> {
  // A replay answers from its stored result without settling again.
  const replay = await storedResult<HuntView>(deps, accountId, request.idempotency);
  if (replay !== undefined) return replay;

  // Ownership, then the guard, then the settlement, then the rule (P-12, B-L12, B-L13).
  await ownedPreset(deps, accountId, command.presetId);
  await expectCurrent(deps, accountId, request);
  const settled = await persistHunt(deps, accountId, { live: true, atWall: stamp.commandAtWall });

  // The intent is judged against the *settled* state.
  if (settled.completion === 'inert' || deps.sim.decode(settled.envelope.state).phase === 'stopped') {
    throw new AppError('RULE_VIOLATION', 'hunt.status');
  }
  const row = await ownedPreset(deps, accountId, command.presetId);
  if (row.presetVersion !== command.presetVersion) {
    // The player applied a version that is no longer the saved one.
    throw new AppError('CONFLICT_STATE_VERSION', 'presetVersion', settled.stateVersion, settled.envelope.generation);
  }
  const queued = queueStrategy(
    deps.sim,
    settled.envelope,
    { presetId: row.id, presetVersion: row.presetVersion, payload: row.payload, payloadSchemaVersion: row.payloadSchemaVersion },
    { commandId: request.idempotency?.key ?? `${stamp.commandAtWall}:${stamp.receiveSeq}` },
  );

  const result = await withAccountTx(
    deps.db,
    {
      accountId,
      expectedStateVersion: settled.stateVersion,
      operation: 'hunt.strategy',
      idempotency: request.idempotency,
    },
    async (tx) => {
      const loaded = await loadCheckpoint(tx, accountId, deps.pins);
      if (loaded.status !== 'running') throw new AppError('RULE_VIOLATION', 'hunt.status');

      const updated = {
        ...queued,
        generation: queued.generation + 1,
        checkpointSeq: queued.checkpointSeq + 1,
        accountStateVersion: settled.stateVersion,
      };
      const state = deps.sim.decode(updated.state);
      await saveCheckpoint(tx, {
        accountId,
        status: 'running',
        mapId: loaded.mapId,
        encoded: encodeCheckpoint(updated),
        checkpointSchemaVersion: ENVELOPE_VERSION,
        simulationVersion: state.simulationVersion,
        contentVersion: state.contentVersion,
        gridHash: state.gridHash,
        simAnchorMs: updated.simAnchorMs,
        wallAnchorAt: new Date(updated.wallAnchorMs),
        lastSeenAt: new Date(updated.lastSeenAt),
        generation: updated.generation,
        maxBytes: deps.config.maxCheckpointBytes,
      });
      await deps.hooks?.beforeCommit?.();
      return view(deps.sim, updated, state, settled.stateVersion + 1);
    },
  );

  // The private precomputation was formed under the old generation.
  deps.precompute.discard(accountId);
  return result;
}

/**
 * Save preset: settles nothing and bumps no generation — it changes the row
 * and only the row, so a running hunt's active and pending versions are
 * exactly what they were (UI spec §5). It still takes the account version.
 */
async function savePreset(
  deps: LifecycleDeps,
  accountId: string,
  command: Extract<HuntCommand, { kind: 'save-strategy-preset' }>,
  request: CommandRequest,
): Promise<PresetRef> {
  await ownedPreset(deps, accountId, command.presetId);
  // The protocol's shape; the engine judges the rules against a party when
  // they are started or applied, the only moments a party exists.
  presetRules(command.payload);
  const expectedStateVersion = request.expectedStateVersion ?? (await readAccountVersion(deps.db, accountId));

  return withAccountTx(
    deps.db,
    { accountId, expectedStateVersion, operation: 'preset.save', idempotency: request.idempotency },
    async (tx) => {
      const [row] = await tx
        .update(schema.strategyPresets)
        .set({
          payload: command.payload as object,
          presetVersion: sql`${schema.strategyPresets.presetVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.strategyPresets.id, command.presetId), eq(schema.strategyPresets.accountId, accountId)))
        .returning({ presetId: schema.strategyPresets.id, presetVersion: schema.strategyPresets.presetVersion });
      if (row === undefined) throw notOwned('presetId');
      return row;
    },
  );
}
