/**
 * The lifecycle as the socket sees it (milestone B spec part 2 §1 steps 2–6).
 *
 * `LifecycleFeed` implements the socket's `HuntFeed` port over real
 * checkpoints. It does two different kinds of work and keeps them apart:
 *
 * - **Settlements** — connect, heartbeat, and a tick once the committed
 *   checkpoint is older than the persist cadence — go through `persistHunt`
 *   and commit. They are the only thing here that writes.
 * - **Release ticks** — every `releaseTickMs` while a socket is subscribed —
 *   simulate a *copy* of the committed state forward to `simTimeAt(now)` and
 *   write nothing. The view's state is the copy's state at exactly that
 *   instant, so it can never show a client something that has not happened.
 *
 * Determinism is what makes the two agree: an event a tick released and the
 * same event re-produced by the settlement that later commits it carry the
 * same `seq` and the same `at` (P-03), so the socket's release cursor skips
 * the repeat. Nothing here is a reward source; rewards come only from a
 * committed settlement.
 *
 * The retained window is per account and per process. It holds the events of
 * the current hunt and generation from `baseSeq` on, so a reconnecting client
 * inside it resumes with a frame instead of a snapshot.
 */
import type { DomainEventWire } from '@narok/protocol';
import { ConflictError } from '../db/tx';
import { AppError } from '../errors';
import type { HuntFeed, HuntPush, HuntView } from '../ws/socket';
import { settlementWindow } from './clock';
import type { CheckpointEnvelope } from './envelope';
import { persistHunt, readHunt, type LifecycleDeps, type PersistResult } from './lifecycle';
import { buildAwayReport, recordAwayReport } from '../reports/away';
import { CommandSequencer } from './commands';

/** Runs `fn` every `everyMs` until the returned function is called. */
export type FeedScheduler = (fn: () => void, everyMs: number) => () => void;

export const intervalScheduler: FeedScheduler = (fn, everyMs) => {
  const handle = setInterval(fn, everyMs);
  // A ticker must never be what keeps the process alive.
  handle.unref?.();
  return () => clearInterval(handle);
};

export interface FeedOptions {
  readonly lifecycle: LifecycleDeps;
  /** Events retained per account for resumption; past it the oldest are dropped. */
  readonly retainedEvents: number;
  /**
   * How often a subscribed account is released to. It must stay under the
   * client's ~2 s playback buffer (layer-1 §4.4 step 5), or playback stalls
   * between releases.
   */
  readonly releaseTickMs: number;
  readonly schedule?: FeedScheduler;
  /**
   * The per-account command order (R116, R120). Every settlement the feed
   * makes — connect, heartbeat, cadence tick — takes its `commandAtWall` from
   * it, so settlements and commands share one `(commandAtWall, receiveSeq)`
   * order. Share the routes' sequencer; one is made when absent.
   */
  readonly sequencer?: CommandSequencer;
  /** The server's log line sink (`AppDeps.onLog`). */
  readonly onLog?: (line: string) => void;
  /** Test seam: where the away report is stored. Defaults to `recordAwayReport`. */
  readonly recordReport?: typeof recordAwayReport;
}

interface Window {
  readonly envelope: CheckpointEnvelope;
  readonly baseSeq: number;
  readonly events: readonly DomainEventWire[];
}

type Listener = (push: HuntPush) => void;

function positive(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
  }
}

function sameLineage(a: CheckpointEnvelope, b: CheckpointEnvelope): boolean {
  return a.huntId === b.huntId && a.generation === b.generation;
}

export class LifecycleFeed implements HuntFeed {
  private readonly windows = new Map<string, Window>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly tickers = new Map<string, () => void>();
  private readonly schedule: FeedScheduler;
  private readonly sequencer: CommandSequencer;

  constructor(private readonly options: FeedOptions) {
    positive('retainedEvents', options.retainedEvents);
    positive('releaseTickMs', options.releaseTickMs);
    this.schedule = options.schedule ?? intervalScheduler;
    this.sequencer = options.sequencer ?? new CommandSequencer(options.lifecycle.now);
  }

  // -- HuntFeed ------------------------------------------------------------

  async connect(accountId: string): Promise<HuntView | undefined> {
    try {
      await readHunt(this.deps, accountId);
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
    // With another socket already streaming this hunt the gap is a tick wide,
    // so its events are kept and that socket's stream stays gapless. With
    // none, the time away may be hours: it is folded into the snapshot.
    const streaming = this.windows.has(accountId);
    const committed = await this.settle(accountId, streaming ? 'events' : 'summary');
    // A return from an absence gets its report; a second tab joining a
    // stream that never stopped has been away from nothing.
    const reportId = streaming || committed === undefined ? undefined : await this.report(accountId, committed);
    const view = await this.view(accountId);
    return view === undefined || reportId === undefined ? view : { ...view, reportId };
  }

  async heartbeat(accountId: string): Promise<HuntView | undefined> {
    await this.settle(accountId, 'events');
    return this.view(accountId);
  }

  subscribe(accountId: string, listener: Listener): () => void {
    let set = this.listeners.get(accountId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(accountId, set);
    }
    set.add(listener);
    if (!this.tickers.has(accountId)) {
      this.tickers.set(
        accountId,
        this.schedule(() => void this.tick(accountId), this.options.releaseTickMs),
      );
    }

    return () => {
      const current = this.listeners.get(accountId);
      current?.delete(listener);
      if (current !== undefined && current.size === 0) {
        this.listeners.delete(accountId);
        this.tickers.get(accountId)?.();
        this.tickers.delete(accountId);
        this.windows.delete(accountId);
      }
    };
  }

  // -- the rest of the lifecycle's surface ----------------------------------

  /**
   * One release: a settlement when the committed checkpoint is older than the
   * persist cadence (step 6), otherwise a write-free view (step 4). A failed
   * tick is dropped — the next tick or heartbeat tries again, and a fault
   * reaches the socket through the heartbeat, which closes it.
   */
  async tick(accountId: string): Promise<void> {
    try {
      const window = this.windows.get(accountId);
      if (window === undefined) return;
      const age = this.deps.now() - window.envelope.wallAnchorMs;
      if (age >= this.deps.config.persistCadenceMs) await this.settle(accountId, 'events');
      const view = await this.view(accountId);
      if (view !== undefined) this.push(accountId, { kind: 'view', view });
    } catch {
      // Deliberately silent here; see above.
    }
  }

  /**
   * Re-reads the committed hunt and pushes it: for a start, an intervention
   * or a recovery, each of which opens a generation the sockets must be
   * snapshotted into.
   */
  async notify(accountId: string): Promise<void> {
    this.windows.delete(accountId);
    const loaded = await readHunt(this.deps, accountId);
    this.reset(accountId, loaded.envelope);
    const view = await this.view(accountId);
    if (view !== undefined) this.push(accountId, { kind: 'view', view });
  }

  /**
   * The hunt as it stands now, without writing: the committed state advanced
   * on a copy to `simTimeAt(now)`, bounded by the offline cap exactly as a
   * settlement would be.
   */
  async view(accountId: string): Promise<HuntView | undefined> {
    const window = this.windows.get(accountId) ?? (await this.load(accountId));
    if (window === undefined) return undefined;

    const { envelope } = window;
    const target = settlementWindow(
      {
        wallAnchorMs: envelope.wallAnchorMs,
        simAnchorMs: envelope.simAnchorMs,
        pausedWallMs: envelope.pausedWallMs,
        lastSeenAt: envelope.lastSeenAt,
        offlineCapMs: envelope.offlineCapMs,
      },
      this.deps.now(),
    ).simTarget;

    const ahead = await this.deps.pool.run(`${accountId}:view:${envelope.huntId}:${envelope.checkpointSeq}:${target}`, {
      encodedState: envelope.state,
      simTarget: target,
      collect: 'events',
    });

    const state = this.deps.sim.decode(ahead.encodedState);
    const committedThrough = window.events.at(-1)?.seq ?? window.baseSeq - 1;
    const fresh = ahead.events.filter((event) => event.seq > committedThrough);

    return {
      generation: envelope.generation,
      // What the copy actually reached: the target, or earlier if the engine
      // stopped the hunt. Either way the state is exactly at this instant.
      releaseSimMs: ahead.simNowMs,
      baseSeq: window.baseSeq,
      events: [...window.events, ...fresh],
      state: this.deps.sim.project(state),
    };
  }

  // -- internals -------------------------------------------------------------

  private get deps(): LifecycleDeps {
    return this.options.lifecycle;
  }

  /**
   * Commits a settlement and folds its events into the window. Losing the
   * version race to another command is not a failure of the connection: the
   * window is re-read from what did commit, and the next settlement covers
   * the time this one did not.
   */
  private async settle(accountId: string, collect: 'events' | 'summary'): Promise<PersistResult | undefined> {
    let committed;
    try {
      // In the account's command order, settled to the instant it was stamped at.
      committed = await this.sequencer.submit(accountId, (stamp) =>
        persistHunt(this.deps, accountId, { live: true, collect, atWall: stamp.commandAtWall }),
      );
    } catch (error) {
      if (error instanceof ConflictError && error.code === 'CONFLICT_STATE_VERSION') {
        const loaded = await readHunt(this.deps, accountId);
        this.advanceWindow(accountId, loaded.envelope, []);
        return undefined;
      }
      throw error;
    }
    this.advanceWindow(accountId, committed.envelope, collect === 'events' ? committed.events : null);
    return committed;
  }

  /**
   * Step 2's last write: the away report, built from the deltas the settlement
   * just committed (ruling R118). A report is a description, not a reward
   * path, so failing to store one never fails the connection — the settlement
   * it would have described already stands.
   */
  private async report(accountId: string, committed: PersistResult): Promise<string | undefined> {
    if (committed.completion === 'inert' || committed.window === null) return undefined;
    const { sim } = this.deps;
    const report = buildAwayReport({
      huntId: committed.envelope.huntId,
      generation: committed.envelope.generation,
      previousLastSeenAt: committed.previous.lastSeenAt,
      returnedAtWall: committed.envelope.lastSeenAt,
      window: committed.window,
      creditedSimMs: committed.creditedSimMs,
      uncovered: committed.uncovered,
      stop: committed.stop,
      before: sim.decode(committed.previous.state),
      after: sim.decode(committed.envelope.state),
      rewardsCredited: committed.rewards.length,
    });
    const record = this.options.recordReport ?? recordAwayReport;
    try {
      return await record(this.deps.db, accountId, report, {
        nowWall: committed.envelope.lastSeenAt,
        retentionMs: this.deps.config.reportRetentionMs,
      });
    } catch (error) {
      // Logged, never swallowed silently; the connection carries on without it.
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.options.onLog?.(
        `away report not stored account=${accountId} hunt=${committed.envelope.huntId} error=${reason.slice(0, 200)}`,
      );
      return undefined;
    }
  }

  /**
   * Moves the window to a newly committed checkpoint. Events of the same hunt
   * and generation are appended; `null` (a summary settlement) or a new
   * lineage starts the window over at the committed state.
   */
  private advanceWindow(
    accountId: string,
    envelope: CheckpointEnvelope,
    events: readonly DomainEventWire[] | null,
  ): void {
    const window = this.windows.get(accountId);
    if (window === undefined || events === null || !sameLineage(window.envelope, envelope)) {
      this.reset(accountId, envelope);
      return;
    }

    const through = window.events.at(-1)?.seq ?? window.baseSeq - 1;
    const kept = [...window.events, ...events.filter((event) => event.seq > through)];
    const overflow = Math.max(0, kept.length - this.options.retainedEvents);
    const retained = kept.slice(overflow);
    this.windows.set(accountId, {
      envelope,
      baseSeq: overflow === 0 ? window.baseSeq : (retained[0]?.seq ?? window.baseSeq),
      events: retained,
    });
  }

  private reset(accountId: string, envelope: CheckpointEnvelope): void {
    const baseSeq = this.deps.sim.decode(envelope.state).nextDomainSeq;
    this.windows.set(accountId, { envelope, baseSeq, events: [] });
  }

  private async load(accountId: string): Promise<Window | undefined> {
    try {
      const loaded = await readHunt(this.deps, accountId);
      this.reset(accountId, loaded.envelope);
      return this.windows.get(accountId);
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }

  private push(accountId: string, push: HuntPush): void {
    for (const listener of this.listeners.get(accountId) ?? []) listener(push);
  }
}
