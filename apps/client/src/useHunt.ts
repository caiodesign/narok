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
 *    (ruling R166).
 *
 * `driver.now()` (`performance.now()` in production) paces rendering only: it
 * is the `now` of `clock.ts`'s horizon and of nothing else. No elapsed or
 * authoritative time is derived from it, and it is never sent anywhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DomainEvent, PublicState } from '@narok/sim';
import { STRATEGY_PAYLOAD_SCHEMA_VERSION, type PublicStateWire, type StrategyPresetPayload } from '@narok/protocol';
import {
  CommandError,
  createApi,
  faultOf,
  type Api,
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
  isTerminalClose,
  socketUrl,
  type Cursor,
  type SocketLike,
  type Timers,
  type Transport,
} from './transport';

/** The one map milestone B ships (spec §2.2; `apps/server/src/routes/hunts.ts` MAPS). */
export const HUNT_MAP_ID = 'prototype';

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
}

export type HuntCommandPending = 'start' | 'stop' | null;

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
  canStart: boolean;
  pending: HuntCommandPending;
  /** The last refused command or read, as the server's code. */
  commandError: ProtocolFault | null;
  playback: PlaybackStatus;
  /** A socket or protocol fault. */
  error: ProtocolFault | null;
  reportId: string | null;
  hunt: HuntResponse | null;
  inventory: InventoryResponse | null;
  characters: readonly CharacterSummary[];
  presets: PresetsResponse | null;
  selectedPresetId: string | null;
  selectPreset: (presetId: string) => void;
  strategy: StrategyCommands;
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
  const pendingRef = useRef<HuntCommandPending>(null);
  const mounted = useRef(true);

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
    }
  }, [api]);

  const refreshAccount = useCallback(async () => {
    const [chars, presetList, bag] = await Promise.allSettled([api.characters(), api.presets(), api.inventory()]);
    if (!mounted.current) return;
    if (chars.status === 'fulfilled') setCharacters([...chars.value.characters].sort((a, b) => a.slot - b.slot));
    if (presetList.status === 'fulfilled') {
      setPresets(presetList.value);
      setSelectedPresetId((current) => current ?? presetList.value.strategy[0]?.id ?? null);
    }
    if (bag.status === 'fulfilled') setInventory(bag.value);
    const refused = [chars, presetList, bag].find((result) => result.status === 'rejected');
    if (refused !== undefined && refused.status === 'rejected') setCommandError(faultOf(refused.reason));
  }, [api]);

  useEffect(() => {
    void refreshAccount();
    void refreshHunt();
  }, [refreshAccount, refreshHunt]);

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
  const hasPending = hunt?.pendingStrategy != null;
  useEffect(() => {
    if (hasPending && latestPhase !== null) void refreshHunt();
  }, [hasPending, latestPhase, refreshHunt]);

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
        if (mounted.current) setHunt({ ...started, status: 'running', mapId: HUNT_MAP_ID });
        void refreshAccount();
      } catch (error) {
        if (mounted.current) setCommandError(faultOf(error));
      } finally {
        finish();
      }
    })();
  }, [api, characters, lootPreset, strategyPreset, refreshAccount]);

  const stop = useCallback(() => {
    if (!begin('stop')) return;
    void (async () => {
      try {
        const stopped = await api.stopHunt();
        if (mounted.current) setHunt((current) => ({ ...current, ...stopped, status: 'stopped' }));
        void refreshHunt();
        void refreshAccount();
      } catch (error) {
        if (mounted.current) setCommandError(faultOf(error));
      } finally {
        finish();
      }
    })();
  }, [api, refreshAccount, refreshHunt]);

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

  // -- the authoritative status ---------------------------------------------

  // Whichever source has seen the newer generation speaks for the hunt.
  const spoken = useMemo<PublicStateWire | null>(() => {
    const socketIsNewer = hunt === null || view.generation >= hunt.generation;
    return socketIsNewer ? latest : hunt.state;
  }, [view.generation, latest, hunt]);

  const status = useMemo<ExperimentStatus>(() => {
    if (view.status === 'error' || view.status === 'faulted') return 'error';
    const socketIsNewer = hunt === null || view.generation >= hunt.generation;
    const phase = spoken?.phase ?? null;
    if (phase === null && hunt === null) return 'idle';
    if (phase === 'stopped') return 'stopped';
    if (!socketIsNewer && hunt.status === 'stopped') return 'stopped';
    if (view.status === 'idle' && hunt === null) return 'idle';
    return 'running';
  }, [view.status, view.generation, spoken, hunt]);

  const stopReason = status === 'stopped' ? (spoken?.stopReason ?? null) : null;
  const faulted = view.status === 'faulted';

  const canStart =
    !faulted &&
    pending === null &&
    status !== 'running' &&
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
    canStart,
    pending,
    commandError,
    playback: view.status,
    error: view.error,
    reportId: view.reportId,
    hunt,
    inventory,
    characters,
    presets,
    selectedPresetId: strategyPreset?.id ?? null,
    selectPreset: setSelectedPresetId,
    strategy,
  };
}
