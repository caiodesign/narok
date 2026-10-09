/**
 * Hand-written stand-ins for the server, shared by the hunt and strategy
 * component suites — the substitution pattern R56 fixed for the worker. No
 * network and no real timer: the socket, the clock driver, the timers and the
 * REST API are all the test's, and every command answers only when the test
 * resolves it, so "pending until acknowledged" can be observed.
 */
import type { ClientMessage, PublicStateWire, ServerMessage } from '@narok/protocol';
import {
  CommandError,
  type Api,
  type AwayReportRecord,
  type HuntResponse,
  type InventoryResponse,
  type LootPresetRecord,
  type PresetRef,
  type PresetsResponse,
  type SavePresetResponse,
  type StrategyPresetRecord,
} from '../src/commands';
import type { SocketLike, Timers } from '../src/transport';
import type { ClockDriver, UseHuntOptions } from '../src/useHunt';

export const METRICS: PublicStateWire['metrics'] = {
  kills: 0,
  wins: 0,
  wipes: 0,
  rawExp: 0,
  rawGold: 0,
  damageDealt: 0,
  effectiveHealing: 0,
  walkMs: 0,
  fightMs: 0,
  restMs: 0,
  actors: {},
  drops: {
    rolled: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
    consumables: 0,
    kept: 0,
    autoSold: 0,
    ignored: 0,
    lost: 0,
    firstDropMs: null,
    firstDropRarity: null,
    epicPlusWaits: [],
    legendaryWaits: [],
  },
  consumed: {},
};

export function wireState(nowMs: number, phase: PublicStateWire['phase'] = 'fighting'): PublicStateWire {
  return { nowMs, phase, stopReason: null, actors: [], metrics: METRICS };
}

/** The browser `WebSocket` surface the transport uses, and nothing more. */
export class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: ClientMessage[] = [];
  closedByClient = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(): void {
    this.closedByClient = true;
    this.onclose?.({ code: 1000, reason: '' });
  }

  open(): void {
    this.onopen?.();
  }

  /** A server message; a test may also deliver one the protocol forbids. */
  deliver(message: ServerMessage | Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(): void {
    this.onclose?.({ code: 1006, reason: '' });
  }

  /** The server closing with a taxonomy code as the reason (`apps/server/src/ws/socket.ts`). */
  closeWith(reason: string): void {
    this.onclose?.({ code: 4001, reason });
  }
}

/** Timers the test fires by hand: the heartbeat interval and the reconnect backoff. */
export function manualTimers(): Timers & { fireTimeouts: () => void; fireIntervals: () => void; delays: number[] } {
  let next = 1;
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  const delays: number[] = [];
  return {
    delays,
    setTimeout: (callback, ms) => {
      delays.push(ms);
      timeouts.set(next, callback);
      return next++;
    },
    clearTimeout: (handle) => {
      timeouts.delete(handle);
    },
    setInterval: (callback) => {
      intervals.set(next, callback);
      return next++;
    },
    clearInterval: (handle) => {
      intervals.delete(handle);
    },
    fireTimeouts: () => {
      const due = [...timeouts.values()];
      timeouts.clear();
      due.forEach((callback) => callback());
    },
    fireIntervals: () => {
      [...intervals.values()].forEach((callback) => callback());
    },
  };
}

export function manualDriver(): { driver: ClockDriver; setNow: (ms: number) => void; pump: () => void } {
  let current = 0;
  let pending: (() => void)[] = [];
  return {
    driver: {
      now: () => current,
      schedule: (callback) => {
        pending.push(callback);
        return pending.length;
      },
      cancel: () => undefined,
    },
    setNow: (ms) => {
      current = ms;
    },
    pump: () => {
      const due = pending;
      pending = [];
      due.forEach((callback) => callback());
    },
  };
}

/** A promise the test settles by hand. */
export interface Gate<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export const CHARACTER_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
] as const;

export function presetRecord(id: string, name: string, presetVersion = 1): StrategyPresetRecord {
  return {
    id,
    name,
    presetVersion,
    payloadSchemaVersion: 1,
    payload: { placement: {}, strategies: {}, rest: { hpStart: 50, mpStart: 30 } },
  };
}

export const SUSTAIN = '10000000-0000-4000-8000-000000000001';

/** The server's record of a hunt that stopped for `reason`. */
export function stoppedHunt(reason: NonNullable<PublicStateWire['stopReason']>, active: PresetRef): HuntResponse {
  const record = huntResponse(2, 'stopped', active);
  return { ...record, state: { ...record.state, stopReason: reason }, status: 'stopped', mapId: 'prototype' };
}

/** The fakes' one loot preset, as `GET /api/presets` lists it. */
export const DEFAULT_LOOT: LootPresetRecord = { id: '30000000-0000-4000-8000-000000000001', name: 'Default', presetVersion: 1 };

export function huntResponse(generation: number, phase: PublicStateWire['phase'], active: PresetRef, pending: PresetRef | null = null): HuntResponse {
  return {
    huntId: '20000000-0000-4000-8000-000000000001',
    generation,
    stateVersion: 10 + generation,
    state: wireState(0, phase),
    activeStrategy: active,
    pendingStrategy: pending,
    activeLoot: { presetId: DEFAULT_LOOT.id, presetVersion: DEFAULT_LOOT.presetVersion },
    pendingLoot: null,
  };
}

/** The API, with every command held open until the test answers it. */
export interface FakeApi extends Api {
  readonly starts: Gate<HuntResponse>[];
  readonly stops: Gate<HuntResponse>[];
  readonly saves: { presetId: string; body: unknown; gate: Gate<SavePresetResponse> }[];
  readonly applies: { body: unknown; gate: Gate<HuntResponse> }[];
  /** Every faulted-hunt recovery sent (B-30), each held open until the test answers it. */
  readonly recovers: { body: unknown; gate: Gate<HuntResponse> }[];
  current: HuntResponse | null;
  inventoryResponse: InventoryResponse | null;
  /** What `GET /api/presets` answers now; a test may replace it, as another tab's save would. */
  strategyPresets: readonly StrategyPresetRecord[];
  /** The loot presets `GET /api/presets` lists. */
  lootPresets: readonly LootPresetRecord[];
  /** How many times the preset list was read. */
  presetReads: number;
  /** What `GET /api/reports/:id` answers, by id. */
  readonly reports: Record<string, AwayReportRecord>;
  /** Every report id read, in order. */
  readonly reportReads: string[];
  /** Every town mutation sent (equip, unequip, lock, allocate, skills, loot, sell), in order. */
  readonly mutations: { name: string; body: unknown }[];
}

export function fakeApi(presets: readonly StrategyPresetRecord[] = [presetRecord(SUSTAIN, 'Sustain')]): FakeApi {
  const api: FakeApi = {
    starts: [],
    stops: [],
    saves: [],
    applies: [],
    recovers: [],
    current: null,
    inventoryResponse: null,
    strategyPresets: presets,
    lootPresets: [DEFAULT_LOOT],
    presetReads: 0,
    reports: {},
    reportReads: [],
    mutations: [],
    me: async () => ({ id: 'a', email: 'a@narok.test', stateVersion: 7, premium: false }),
    characters: async () => ({
      characters: [
        { id: CHARACTER_IDS[0], slot: 0, name: 'Bjorn', classId: 'guardian', level: 1 },
        { id: CHARACTER_IDS[1], slot: 1, name: 'Sigrun', classId: 'cleric', level: 1 },
        { id: CHARACTER_IDS[2], slot: 2, name: 'Kaio', classId: 'ranger', level: 1 },
      ],
      stateVersion: 7,
    }),
    presets: async (): Promise<PresetsResponse> => {
      api.presetReads += 1;
      return {
        strategy: api.strategyPresets,
        loot: api.lootPresets,
        stateVersion: 7,
      };
    },
    inventory: async () => {
      if (api.inventoryResponse === null) throw new CommandError('NOT_FOUND', 'inventory');
      return api.inventoryResponse;
    },
    currentHunt: async () => {
      if (api.current === null) throw new CommandError('NOT_FOUND', 'hunt');
      return api.current;
    },
    startHunt: () => {
      const held = gate<HuntResponse>();
      api.starts.push(held);
      return held.promise;
    },
    stopHunt: () => {
      const held = gate<HuntResponse>();
      api.stops.push(held);
      return held.promise;
    },
    applyStrategy: (body) => {
      const held = gate<HuntResponse>();
      api.applies.push({ body, gate: held });
      return held.promise;
    },
    recoverHunt: (body) => {
      const held = gate<HuntResponse>();
      api.recovers.push({ body, gate: held });
      return held.promise;
    },
    savePreset: (presetId, body) => {
      const held = gate<SavePresetResponse>();
      api.saves.push({ presetId, body, gate: held });
      return held.promise;
    },
    report: async (reportId) => {
      api.reportReads.push(reportId);
      const found = api.reports[reportId];
      if (found === undefined) throw new CommandError('NOT_OWNED', 'reportId');
      return found;
    },
    // Town mutations are recorded and refused: a suite that needs one to land
    // substitutes its own.
    equip: async (body) => {
      api.mutations.push({ name: 'equip', body });
      throw new CommandError('RULE_VIOLATION', 'equip');
    },
    unequip: async (body) => {
      api.mutations.push({ name: 'unequip', body });
      throw new CommandError('RULE_VIOLATION', 'unequip');
    },
    lock: async (body) => {
      api.mutations.push({ name: 'lock', body });
      throw new CommandError('RULE_VIOLATION', 'lock');
    },
    allocate: async (characterId, body) => {
      api.mutations.push({ name: 'allocate', body: { characterId, ...body } });
      throw new CommandError('RULE_VIOLATION', 'allocate');
    },
    upgradeSkill: async (characterId, body) => {
      api.mutations.push({ name: 'upgradeSkill', body: { characterId, ...body } });
      throw new CommandError('RULE_VIOLATION', 'skills');
    },
    applyLoot: async (body) => {
      api.mutations.push({ name: 'applyLoot', body });
      throw new CommandError('RULE_VIOLATION', 'loot');
    },
    sell: async (body) => {
      api.mutations.push({ name: 'sell', body });
      throw new CommandError('RULE_VIOLATION', 'sell');
    },
  };
  return api;
}

/** `useHunt`'s collaborators, all of them the test's. */
export function huntHarness(api: Api): {
  options: UseHuntOptions;
  sockets: FakeSocket[];
  timers: ReturnType<typeof manualTimers>;
  clock: ReturnType<typeof manualDriver>;
  /** The wall clock the return journey's countdown reads; the test moves it. */
  wall: { now: number };
} {
  const sockets: FakeSocket[] = [];
  const timers = manualTimers();
  const clock = manualDriver();
  const wall = { now: 1_700_000_000_000 };
  return {
    sockets,
    timers,
    clock,
    wall,
    options: {
      api,
      driver: clock.driver,
      timers,
      wallClock: () => wall.now,
      url: 'ws://narok.test/ws',
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    },
  };
}
