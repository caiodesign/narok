/**
 * The hunt hook (milestone B spec part 4 §1–§3.1): the client's view of the
 * server-authoritative hunt, and the commands it may issue.
 *
 * It keeps `UseExperimentResult`'s field names — `state`, `events`, `status`,
 * `start`, `stop` — so every `hud/*` prop type is the one the laboratory's hook
 * already fed. What changed is who owns time. The laboratory's hook drove a
 * worker with `advance`; this one owns nothing authoritative:
 *
 *  - `state` and `events` are what `playback.ts` has exposed from the socket,
 *    behind the render horizon, and nothing else;
 *  - `status` is the *authoritative* hunt status — the newest released state
 *    and the server's hunt record — not the playback state (R110): a client
 *    that is buffering is still hunting;
 *  - `start` and `stop` are commands. Each shows pending until the server
 *    answers, and Stop is the owner's return-to-town: there is no resume
 *    (ruling R166);
 *  - `recover` is the one command a faulted hunt accepts (P-38, B-30): the
 *    explicit return to town from the last valid checkpoint.
 *
 * `driver.now()` (`performance.now()` in production) paces rendering only: it
 * is the `now` of `clock.ts`'s horizon and of nothing else. No elapsed or
 * authoritative time is derived from it, and it is never sent anywhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { content, type SkillId, type Slot } from '@narok/data';
import type { DomainEvent, PublicState } from '@narok/sim';
import { STRATEGY_PAYLOAD_SCHEMA_VERSION, type PublicStateWire, type StrategyPresetPayload } from '@narok/protocol';
import {
  CommandError,
  createApi,
  decodeAwayReport,
  faultOf,
  type Api,
  type AwayReportRecord,
  type CharacterSummary,
  type HuntResponse,
  type InventoryResponse,
  type PresetRef,
  type PresetsResponse,
  type SavePresetResponse,
} from './commands';
import { initialView, reduce, type PlaybackStatus, type PlaybackView } from './playback';
import type { ProtocolFault } from './protocol';
import type { ExperimentStatus } from './status';
import {
  createTransport,
  DEFAULT_TIMERS,
  isTerminalClose,
  socketUrl,
  type Cursor,
  type SocketLike,
  type Timers,
  type Transport,
} from './transport';

/** The one map milestone B ships (spec §2.2; `apps/server/src/routes/hunts.ts` MAPS). */
export const HUNT_MAP_ID = 'prototype';

/**
 * The return journey a player's Stop costs (spec §4.0.1), from the bundled
 * content. The server refuses a start until the party is in town
 * (`RULE_VIOLATION` / `hunt.travel`); the client uses this only as the ceiling
 * on how long it shows the party returning, so a skewed local clock can never
 * hold Start back longer than the journey itself.
 */
export const TOWN_RETURN_TRAVEL_MS = content.townReturnTravelMs ?? 0;

/** The server's refusal of a start while the party is still travelling home. */
export function isTravelRefusal(fault: ProtocolFault | null): boolean {
  return fault !== null && fault.code === 'RULE_VIOLATION' && fault.field === 'hunt.travel';
}

export interface ClockDriver {
  now: () => number;
  schedule: (callback: () => void) => number;
  cancel: (handle: number) => void;
}

const DEFAULT_DRIVER: ClockDriver = {
  now: () => performance.now(),
  schedule: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export interface UseHuntOptions {
  driver?: ClockDriver;
  createSocket?: (url: string) => SocketLike;
  fetch?: typeof fetch;
  api?: Api;
  url?: string;
  timers?: Timers;
  heartbeatMs?: number;
  /** Wall-clock milliseconds, for the return journey's countdown; `Date.now` by default. */
  wallClock?: () => number;
}

export type HuntCommandPending = 'start' | 'stop' | 'recover' | null;

/** Why a hunt stopped, as the wire names it. */
export type StopReason = NonNullable<PublicStateWire['stopReason']>;

/**
 * What the strategy editor needs from the server, already guarded.
 *
 * Ruling R170: Save and Apply are guarded by the account and hunt versions
 * read at the moment the command is sent, not when the editor opened; and a
 * queued strategy is re-read on every phase change while one is pending —
 * because the account version moves at every settled encounter, so a guard
 * taken at open would refuse nearly every save during a hunt, and a pending
 * version activates at the next spawn without a new generation to signal it.
 * For Save, R176 supersedes this as the staleness guard: the account version
 * read now only sequences the write, and `expectedPresetVersion` — the
 * version the draft was loaded from — is what refuses a stale draft.
 */
export interface StrategyCommands {
  save(presetId: string, payload: StrategyPresetPayload, expectedPresetVersion: number): Promise<PresetRef>;
  apply(ref: PresetRef): Promise<{ active: PresetRef | null; pending: PresetRef | null }>;
}

/**
 * The town commands (part 4 §3.3–§3.4), over the same account state Hunt reads.
 *
 * Ruling R189: equip, unequip, allocate, upgrade-skill and sell are guarded by
 * the account version of the newest read the player acted on — they are
 * town-only, so in town that version is stable and a different one means the
 * player's picture is stale; lock and apply-loot read the version at the
 * moment of sending, as Save and Apply do (R170), because both are allowed
 * while a hunt runs and the version moves at every settled encounter. Every
 * success re-reads the whole account, so every screen's counters come from
 * one returned state; every refusal is recorded as `commandError` and
 * rethrown, and a stale-version refusal re-reads the account too — so a
 * screen that catches one never re-reads it again (Task 10 fix round 1).
 * The screen that sent a command shows its refusal from the rejection it
 * catches, scoped to that command (ruling R195); `commandError` is the
 * Hunt shell's, not the town screens'.
 */
export interface TownCommands {
  equip(itemId: string, characterId: string, slot: Slot): Promise<void>;
  unequip(characterId: string, slot: Slot): Promise<void>;
  lock(itemId: string, locked: boolean): Promise<void>;
  allocate(characterId: string, spend: Partial<Record<'str' | 'agi' | 'vit' | 'int' | 'dex' | 'luk', number>>, quotedCost: number): Promise<void>;
  upgradeSkill(characterId: string, skillId: SkillId, targetRank: number): Promise<void>;
  applyLoot(ref: PresetRef): Promise<void>;
  sell(itemIds: readonly string[]): Promise<void>;
  /** Re-reads characters, presets and the bag. */
  refresh(): Promise<void>;
}

export interface UseHuntResult {
  state: PublicState | null;
  events: DomainEvent[];
  status: ExperimentStatus;
  /** Why the hunt stopped, from the same source as `status`; `null` while it runs or when unknown. */
  stopReason: StopReason | null;
  /** The server reported the hunt faulted: no normal start is offered (part 4 §2). */
  faulted: boolean;
  start: () => void;
  stop: () => void;
  /** The explicit recovery of a faulted hunt (B-30); offered only while `faulted`. */
  recover: () => void;
  canStart: boolean;
  /**
   * Milliseconds until a stopped party reaches town, `0` once it is there. A
   * start is refused (`hunt.travel`) until then, so `canStart` is false meanwhile.
   */
  returningMs: number;
  pending: HuntCommandPending;
  /** The last refused command or read, as the server's code. */
  commandError: ProtocolFault | null;
  playback: PlaybackStatus;
  /** A socket or protocol fault. */
  error: ProtocolFault | null;
  reportId: string | null;
  /** The away report `reportId` names, as read — a read only; it credits nothing (B-17). */
  report: AwayReportRecord | null;
  hunt: HuntResponse | null;
  inventory: InventoryResponse | null;
  characters: readonly CharacterSummary[];
  presets: PresetsResponse | null;
  selectedPresetId: string | null;
  selectPreset: (presetId: string) => void;
  /** The loot preset a start would use (ruling R190). */
  startLootPresetId: string | null;
  strategy: StrategyCommands;
  town: TownCommands;
}

function cursorOf(view: PlaybackView): Cursor {
  if (view.generation < 0 || view.lastSeq < 0) return {};
  if (view.status === 'resyncing' || view.status === 'idle' || view.status === 'error' || view.status === 'closed') return {};
  return { lastGeneration: view.generation, lastSeq: view.lastSeq };
}

function defaultSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

export function useHunt(options: UseHuntOptions = {}): UseHuntResult {
  // Captured once: a hook's collaborators do not change under it.
  const config = useRef(options).current;
  const driver = config.driver ?? DEFAULT_DRIVER;
  const api = useMemo(() => config.api ?? createApi({ fetch: config.fetch }), [config]);

  const [view, setView] = useState<PlaybackView>(() => initialView(driver.now()));
  const viewRef = useRef(view);
  const transportRef = useRef<Transport | null>(null);

  const [hunt, setHunt] = useState<HuntResponse | null>(null);
  const [inventory, setInventory] = useState<InventoryResponse | null>(null);
  const [characters, setCharacters] = useState<readonly CharacterSummary[]>([]);
  const [presets, setPresets] = useState<PresetsResponse | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [pending, setPending] = useState<HuntCommandPending>(null);
  const [commandError, setCommandError] = useState<ProtocolFault | null>(null);
  /**
   * The server has said HUNT_FAULTED — on the socket, a hunt read or a start —
   * and no recovery has been acknowledged since. Held here rather than read
   * off the playback view, because the socket closes right after its error and
   * the view moves on to reconnecting, while the hunt stays faulted (B-30).
   */
  const [faulted, setFaulted] = useState(false);
  const pendingRef = useRef<HuntCommandPending>(null);
  const [report, setReport] = useState<AwayReportRecord | null>(null);
  /** The newest account version any read returned: what a town command was formed against (R189). */
  const accountVersion = useRef<number | null>(null);
  const mounted = useRef(true);
  const wallClock = config.wallClock ?? Date.now;
  const timers = config.timers ?? DEFAULT_TIMERS;
  /** When the stopped party reaches town, on the local wall clock; `null` when it is there or no stop is known. */
  const [inTownAt, setInTownAt] = useState<number | null>(null);
  const [wallNow, setWallNow] = useState(() => wallClock());

  const apply = useCallback(
    (message: unknown) => {
      const before = viewRef.current;
      const { view: next, effects } = reduce(before, message, driver.now());
      if (next !== before) {
        viewRef.current = next;
        setView(next);
      }
      for (const effect of effects) {
        if (effect.kind === 'ack') transportRef.current?.send({ type: 'ack', generation: effect.generation, seq: effect.seq });
        else transportRef.current?.resync();
      }
      // A contract broken by the server is surfaced and the stream is ended,
      // never "recovered" by applying part of it (part 4 §2 rule 2).
      if (next.status === 'error' && before.status !== 'error') transportRef.current?.close();
    },
    [driver],
  );

  // The socket.
  useEffect(() => {
    const transport = createTransport({
      url: config.url ?? socketUrl(window.location),
      createSocket: config.createSocket ?? defaultSocket,
      cursor: () => cursorOf(viewRef.current),
      onMessage: apply,
      onClose: (reason) => apply(isTerminalClose(reason) ? { type: 'closed', code: reason } : { type: 'disconnected' }),
      timers: config.timers,
      heartbeatMs: config.heartbeatMs,
    });
    transportRef.current = transport;
    return () => {
      transportRef.current = null;
      transport.close();
    };
  }, [apply, config]);

  // The render loop: paces what is shown, nothing more.
  useEffect(() => {
    let handle = 0;
    const loop = () => {
      apply({ type: 'tick' });
      handle = driver.schedule(loop);
    };
    handle = driver.schedule(loop);
    return () => driver.cancel(handle);
  }, [apply, driver]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // -- reads ---------------------------------------------------------------

  const refreshHunt = useCallback(async () => {
    try {
      const current = await api.currentHunt();
      if (mounted.current) setHunt(current);
    } catch (error) {
      if (!mounted.current) return;
      const fault = faultOf(error);
      if (fault.code === 'NOT_FOUND') setHunt(null);
      else setCommandError(fault);
      if (fault.code === 'HUNT_FAULTED') setFaulted(true);
    }
  }, [api]);

  const refreshAccount = useCallback(async () => {
    const [chars, presetList, bag] = await Promise.allSettled([api.characters(), api.presets(), api.inventory()]);
    if (!mounted.current) return;
    const seen = (version: number) => {
      if (accountVersion.current === null || version > accountVersion.current) accountVersion.current = version;
    };
    if (chars.status === 'fulfilled') {
      seen(chars.value.stateVersion);
      setCharacters([...chars.value.characters].sort((a, b) => a.slot - b.slot));
    }
    if (presetList.status === 'fulfilled') {
      setPresets(presetList.value);
      setSelectedPresetId((current) => current ?? presetList.value.strategy[0]?.id ?? null);
    }
    if (bag.status === 'fulfilled') {
      seen(bag.value.stateVersion);
      setInventory(bag.value);
    }
    const refused = [chars, presetList, bag].find((result) => result.status === 'rejected');
    if (refused !== undefined && refused.status === 'rejected') setCommandError(faultOf(refused.reason));
  }, [api]);

  useEffect(() => {
    void refreshAccount();
    void refreshHunt();
  }, [refreshAccount, refreshHunt]);

  // A report notice from the socket: read it. Reading is all the client does
  // with a report — it settles nothing and credits nothing (B-17).
  const reportId = view.reportId;
  useEffect(() => {
    if (reportId === null) return;
    let live = true;
    api.report(reportId).then(
      (read) => {
        if (live && mounted.current) setReport(decodeAwayReport(read));
      },
      (error: unknown) => {
        if (live && mounted.current) setCommandError(faultOf(error));
      },
    );
    return () => {
      live = false;
    };
  }, [reportId, api]);

  useEffect(() => {
    if (view.status === 'faulted') setFaulted(true);
  }, [view.status]);

  // A new generation (start, stop, apply, recovery) or a reconnect's snapshot:
  // re-read the hunt record for the active and pending strategy versions.
  useEffect(() => {
    if (view.generation >= 0) void refreshHunt();
  }, [view.generation, refreshHunt]);

  // The newest *released* state is the authoritative one; the shown state lags it by the buffer.
  const latest = view.held.length > 0 ? view.held[view.held.length - 1]! : view.state;

  // Ruling R175: the wallet and bag occupancy are re-read from the server when a
  // released state's settled-encounter count (wins + wipes) moves — because
  // gold and drops settle at the end of an encounter (part 3 §2), and the
  // client may not add up gold or slots itself (R108: bound, never invented).
  const settledEncounters = latest === null ? null : latest.metrics.wins + latest.metrics.wipes;
  useEffect(() => {
    if (settledEncounters === null || settledEncounters === 0) return;
    void api.inventory().then(
      (bag) => {
        if (mounted.current) setInventory(bag);
      },
      () => undefined,
    );
  }, [settledEncounters, api]);

  // A pending strategy activates at the next spawn without a new generation,
  // so a phase change while one is queued is the moment to re-read (R170).
  const latestPhase = latest?.phase ?? null;
  // A pending loot filter likewise becomes active once earlier drops settle (R131).
  const hasPending = hunt?.pendingStrategy != null || hunt?.pendingLoot != null;
  useEffect(() => {
    if (hasPending && latestPhase !== null) void refreshHunt();
  }, [hasPending, latestPhase, refreshHunt]);

  // -- the return journey -------------------------------------------------

  // A hunt read names when the party reaches town (server wall time). It is
  // turned into a local deadline once, clamped to the content's journey, so a
  // skewed clock shortens or caps the wait but never invents a longer one.
  // Command answers carry no `inTownAtWallMs` (undefined): they keep it.
  useEffect(() => {
    const at = hunt?.inTownAtWallMs;
    if (at === undefined) return;
    if (at === null || hunt?.status !== 'stopped') {
      setInTownAt(null);
      return;
    }
    const now = wallClock();
    setWallNow(now);
    setInTownAt(now + Math.min(Math.max(at - now, 0), TOWN_RETURN_TRAVEL_MS));
  }, [hunt, wallClock]);

  // A countdown tick while the party travels; it stops once the party arrives.
  useEffect(() => {
    if (inTownAt === null || inTownAt <= wallClock()) return;
    const handle = timers.setInterval(() => {
      if (mounted.current) setWallNow(wallClock());
    }, 250);
    return () => timers.clearInterval(handle);
  }, [inTownAt, timers, wallClock]);

  const returningMs = inTownAt === null ? 0 : Math.max(0, inTownAt - wallNow);

  // Once the party is in town, a travel refusal it caused no longer applies.
  useEffect(() => {
    if (returningMs === 0) setCommandError((current) => (isTravelRefusal(current) ? null : current));
  }, [returningMs]);

  // -- commands ------------------------------------------------------------

  const begin = (kind: Exclude<HuntCommandPending, null>): boolean => {
    if (pendingRef.current !== null) return false;
    pendingRef.current = kind;
    setPending(kind);
    setCommandError(null);
    return true;
  };
  const finish = () => {
    pendingRef.current = null;
    if (mounted.current) setPending(null);
  };

  const strategyPreset = presets?.strategy.find((preset) => preset.id === selectedPresetId) ?? presets?.strategy[0] ?? null;
  const lootPreset = presets?.loot[0] ?? null;

  const start = useCallback(() => {
    if (strategyPreset === null || lootPreset === null || characters.length === 0) return;
    if (!begin('start')) return;
    void (async () => {
      try {
        // The guard is the account version as it stands; the party, map and
        // presets are the intent (part 1 §3). No seed and no time are named.
        const me = await api.me();
        const started = await api.startHunt({
          characterIds: characters.slice(0, 3).map((character) => character.id),
          mapId: HUNT_MAP_ID,
          strategyPresetId: strategyPreset.id,
          lootPresetId: lootPreset.id,
          expectedStateVersion: me.stateVersion,
        });
        if (mounted.current) {
          setHunt({ ...started, status: 'running', mapId: HUNT_MAP_ID, inTownAtWallMs: null });
          setInTownAt(null);
        }
        void refreshAccount();
      } catch (error) {
        if (!mounted.current) return;
        const fault = faultOf(error);
        setCommandError(fault);
        if (fault.code === 'HUNT_FAULTED') setFaulted(true);
        // Still travelling home (a clock behind the server's, or another tab's
        // stop): re-read when the party arrives so the countdown is the server's.
        if (isTravelRefusal(fault)) void refreshHunt();
      } finally {
        finish();
      }
    })();
  }, [api, characters, lootPreset, strategyPreset, refreshAccount, refreshHunt]);

  const stop = useCallback(() => {
    if (!begin('stop')) return;
    void (async () => {
      try {
        const stopped = await api.stopHunt();
        if (mounted.current) {
          // The stop's answer does not say when the party arrives; until the
          // re-read below does, it is the content's whole journey from now.
          setHunt((current) => ({ ...current, ...stopped, status: 'stopped', inTownAtWallMs: undefined }));
          const now = wallClock();
          setWallNow(now);
          setInTownAt(TOWN_RETURN_TRAVEL_MS > 0 ? now + TOWN_RETURN_TRAVEL_MS : null);
        }
        void refreshHunt();
        void refreshAccount();
      } catch (error) {
        if (mounted.current) setCommandError(faultOf(error));
      } finally {
        finish();
      }
    })();
  }, [api, refreshAccount, refreshHunt, wallClock]);

  const recover = useCallback(() => {
    if (!begin('recover')) return;
    void (async () => {
      try {
        // Guarded by the account version as it stands (P-23); the hunt is the
        // account's own and the state is the server's, so nothing else is named.
        const me = await api.me();
        const recovered = await api.recoverHunt({ expectedStateVersion: me.stateVersion });
        if (!mounted.current) return;
        setFaulted(false);
        // An unreadable checkpoint is removed rather than returned to town: no hunt, as a new account.
        // The stream's last view was of that hunt; it is dropped with it.
        if ('removed' in recovered) {
          setHunt(null);
          viewRef.current = initialView(driver.now());
          setView(viewRef.current);
        } else {
          setHunt((current) => ({ ...current, ...recovered, status: 'stopped' }));
        }
        // The socket closed on the fault; reopen it now for a fresh snapshot
        // rather than waiting out the reconnect backoff.
        transportRef.current?.resync();
        void refreshHunt();
        void refreshAccount();
      } catch (error) {
        if (mounted.current) setCommandError(faultOf(error));
      } finally {
        finish();
      }
    })();
  }, [api, driver, refreshAccount, refreshHunt]);

  const strategy = useMemo<StrategyCommands>(
    () => ({
      async save(presetId, payload, expectedPresetVersion) {
        // Sequenced by the account version read now (R170) and guarded by the
        // preset version the draft was loaded from (R176).
        const me = await api.me();
        let saved: SavePresetResponse;
        try {
          saved = await api.savePreset(presetId, {
            payload,
            payloadSchemaVersion: STRATEGY_PAYLOAD_SCHEMA_VERSION,
            expectedPresetVersion,
            expectedStateVersion: me.stateVersion,
          });
        } catch (error) {
          // Another tab or device saved first: show the player what it saved.
          if (error instanceof CommandError && error.field === 'expectedPresetVersion') void refreshAccount();
          throw error;
        }
        if (mounted.current) {
          setPresets((current) =>
            current === null
              ? current
              : {
                  ...current,
                  strategy: current.strategy.map((preset) =>
                    preset.id === presetId ? { ...preset, payload, presetVersion: saved.presetVersion } : preset,
                  ),
                },
          );
        }
        return { presetId: saved.presetId, presetVersion: saved.presetVersion };
      },
      async apply(ref) {
        const current = await api.currentHunt();
        const applied = await api.applyStrategy({
          ...ref,
          expectedStateVersion: current.stateVersion,
          expectedGeneration: current.generation,
        });
        if (mounted.current) setHunt({ ...current, ...applied });
        return { active: applied.activeStrategy, pending: applied.pendingStrategy };
      },
    }),
    [api, refreshAccount],
  );

  const town = useMemo<TownCommands>(() => {
    const guarded = async (send: (expectedStateVersion: number) => Promise<unknown>, version: () => Promise<number>): Promise<void> => {
      setCommandError(null);
      try {
        await send(await version());
      } catch (error) {
        if (mounted.current) setCommandError(faultOf(error));
        if (error instanceof CommandError && error.code === 'CONFLICT_STATE_VERSION') await refreshAccount();
        throw error;
      }
      await refreshAccount();
    };
    // The version the player's picture was read at (R189).
    const read = async () => accountVersion.current ?? (await api.me()).stateVersion;
    // The version as it stands now, for commands allowed mid-hunt (R170, R189).
    const now = async () => (await api.me()).stateVersion;
    return {
      equip: (itemId, characterId, slot) => guarded((v) => api.equip({ itemId, characterId, slot, expectedStateVersion: v }), read),
      unequip: (characterId, slot) => guarded((v) => api.unequip({ characterId, slot, expectedStateVersion: v }), read),
      lock: (itemId, locked) => guarded((v) => api.lock({ itemId, locked, expectedStateVersion: v }), now),
      allocate: (characterId, spend, quotedCost) =>
        guarded((v) => api.allocate(characterId, { spend, quotedCost, expectedStateVersion: v }), read),
      upgradeSkill: (characterId, skillId, targetRank) =>
        guarded((v) => api.upgradeSkill(characterId, { skillId, targetRank, expectedStateVersion: v }), read),
      sell: (itemIds) => guarded((v) => api.sell({ itemIds, expectedStateVersion: v }), read),
      applyLoot: async (ref) => {
        setCommandError(null);
        try {
          const current = await api.currentHunt();
          const applied = await api.applyLoot({ ...ref, expectedStateVersion: current.stateVersion, expectedGeneration: current.generation });
          if (mounted.current) setHunt((was) => ({ ...was, ...applied }));
        } catch (error) {
          if (mounted.current) setCommandError(faultOf(error));
          throw error;
        }
      },
      refresh: refreshAccount,
    };
  }, [api, refreshAccount]);

  // -- the authoritative status ---------------------------------------------

  // Whichever source has seen the newer generation speaks for the hunt.
  const spoken = useMemo<PublicStateWire | null>(() => {
    const socketIsNewer = hunt === null || view.generation >= hunt.generation;
    return socketIsNewer ? latest : hunt.state;
  }, [view.generation, latest, hunt]);

  const status = useMemo<ExperimentStatus>(() => {
    if (view.status === 'error' || faulted) return 'error';
    // A stopped record the socket has not overtaken speaks for the hunt. That
    // is also how a recovered hunt reads: it keeps its generation and its last
    // valid engine state, which the engine never stopped (P-38).
    if (hunt !== null && hunt.status === 'stopped' && hunt.generation >= view.generation) return 'stopped';
    const phase = spoken?.phase ?? null;
    if (phase === null && hunt === null) return 'idle';
    if (phase === 'stopped') return 'stopped';
    if (view.status === 'idle' && hunt === null) return 'idle';
    return 'running';
  }, [view.status, view.generation, spoken, hunt, faulted]);

  const stopReason = status === 'stopped' ? (spoken?.stopReason ?? null) : null;

  const canStart =
    !faulted &&
    pending === null &&
    status !== 'running' &&
    returningMs === 0 &&
    strategyPreset !== null &&
    lootPreset !== null &&
    characters.length > 0;

  return {
    // The wire projection is the simulation's `PublicState` field for field
    // (`packages/protocol/test/public-state.test.ts` proves it both ways).
    state: view.state as PublicState | null,
    events: view.events as unknown as DomainEvent[],
    status,
    stopReason,
    faulted,
    start,
    stop,
    recover,
    canStart,
    returningMs,
    pending,
    commandError,
    playback: view.status,
    // The socket's HUNT_FAULTED outlives an acknowledged recovery until the
    // fresh snapshot replaces it; it no longer describes the hunt.
    error: view.error?.code === 'HUNT_FAULTED' && !faulted ? null : view.error,
    reportId: view.reportId,
    report,
    hunt,
    inventory,
    characters,
    presets,
    selectedPresetId: strategyPreset?.id ?? null,
    selectPreset: setSelectedPresetId,
    startLootPresetId: lootPreset?.id ?? null,
    strategy,
    town,
  };
}
