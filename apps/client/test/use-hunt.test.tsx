// @vitest-environment jsdom
/**
 * `useHunt` over a hand-written fake socket implementing `protocol.ts`'s union —
 * the substitution `apps/lab/test/experiment-worker.test.ts` makes for the worker
 * (R56). No network, no real timer: the socket, the clock driver, the timers and
 * `fetch` are all the test's.
 *
 * The journey is part 4 §2 rule 6: connect, `hello`, frames, a mid-hunt drop,
 * a reconnect that delivers a `report` then a `snapshot`, and the rendered log
 * holding no duplicated or reordered event (B-07). Throughout, the client sends
 * only `hello`, `heartbeat` and `ack` — never `advance` (part 1 §3).
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { ClientMessage, DomainEventWire, PublicStateWire, ServerMessage } from '@narok/protocol';
import type { SocketLike, Timers } from '../src/transport';
import { useHunt, type ClockDriver } from '../src/useHunt';

afterEach(() => {
  cleanup();
});

const METRICS: PublicStateWire['metrics'] = {
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

function state(nowMs: number, phase: PublicStateWire['phase'] = 'fighting'): PublicStateWire {
  return { nowMs, phase, stopReason: null, actors: [], metrics: METRICS };
}

function event(seq: number, at: number): DomainEventWire {
  return { seq, at, encounter: 1, kind: 'regen', actorId: 'p0', targetId: null, amount: 1, reason: 'hp', position: null };
}

function frame(generation: number, firstSeq: number, lastSeq: number, at = 0): ServerMessage {
  const events = Array.from({ length: lastSeq - firstSeq + 1 }, (_, index) => event(firstSeq + index, at));
  return { type: 'frame', generation, firstSeq, lastSeq, events, state: state(at) };
}

/** The browser `WebSocket` surface the transport uses, and nothing more. */
class FakeSocket implements SocketLike {
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

  deliver(message: ServerMessage | Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(): void {
    this.onclose?.({ code: 1006, reason: '' });
  }
}

/** Timers the test fires by hand: the heartbeat interval and the reconnect backoff. */
function manualTimers(): Timers & { fireTimeouts: () => void; fireIntervals: () => void; delays: number[] } {
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

function manualDriver(): { driver: ClockDriver; setNow: (ms: number) => void; pump: () => void } {
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

/** No REST in these cases: every read answers "no hunt", as a server with none would. */
const offline: typeof fetch = async () =>
  new Response(JSON.stringify({ code: 'NOT_FOUND', field: 'hunt', retryable: false }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });

function mount() {
  const sockets: FakeSocket[] = [];
  const timers = manualTimers();
  const clock = manualDriver();
  const hook = renderHook(() =>
    useHunt({
      driver: clock.driver,
      timers,
      fetch: offline,
      url: 'ws://narok.test/ws',
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    }),
  );
  return { ...hook, sockets, timers, clock };
}

function seqs(events: readonly { seq: number }[]): number[] {
  return events.map((item) => item.seq);
}

function expectStrictlyAscending(events: readonly { seq: number }[]): void {
  const values = seqs(events);
  expect(new Set(values).size, 'no duplicated event').toBe(values.length);
  expect([...values].sort((a, b) => a - b), 'no reordered event').toEqual(values);
}

describe('useHunt over the socket', () => {
  test('connect, hello, frames, drop, reconnect with report then snapshot, and a clean log (B-07)', () => {
    const { result, sockets, timers, clock } = mount();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('ws://narok.test/ws');
    act(() => sockets[0]!.open());
    // A first connection has no cursor: the server answers with a snapshot.
    expect(sockets[0]!.sent).toEqual([{ type: 'hello' }]);

    act(() => sockets[0]!.deliver({ type: 'snapshot', generation: 3, seq: 1, state: state(0) }));
    expect(result.current.playback).toBe('live');

    act(() => sockets[0]!.deliver(frame(3, 1, 3)));
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'ack', generation: 3, seq: 3 });
    clock.setNow(2000);
    act(() => clock.pump());
    expect(seqs(result.current.events)).toEqual([1, 2, 3]);

    // The heartbeat runs on the configured interval.
    act(() => timers.fireIntervals());
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'heartbeat' });

    // A mid-hunt drop: the last frame is held and nothing accrues locally.
    act(() => sockets[0]!.drop());
    expect(result.current.playback).toBe('disconnected');
    expect(seqs(result.current.events)).toEqual([1, 2, 3]);

    // Reconnect with backoff; the hello carries the cursor of what was applied.
    act(() => timers.fireTimeouts());
    expect(sockets).toHaveLength(2);
    act(() => sockets[1]!.open());
    expect(sockets[1]!.sent).toEqual([{ type: 'hello', lastGeneration: 3, lastSeq: 3 }]);

    const reportId = crypto.randomUUID();
    act(() => sockets[1]!.deliver({ type: 'report', generation: 3, reportId }));
    act(() => sockets[1]!.deliver({ type: 'snapshot', generation: 3, seq: 9, state: state(60_000) }));
    expect(result.current.reportId).toBe(reportId);
    // History before the snapshot is gone by design, never re-spliced.
    expect(result.current.events).toEqual([]);

    act(() => sockets[1]!.deliver(frame(3, 9, 11, 60_000)));
    clock.setNow(10_000);
    act(() => clock.pump());
    expect(seqs(result.current.events)).toEqual([9, 10, 11]);
    expectStrictlyAscending(result.current.events);

    // Never an advance, on any connection.
    const kinds = sockets.flatMap((socket) => socket.sent.map((message) => message.type));
    expect(new Set(kinds)).toEqual(new Set(['hello', 'ack', 'heartbeat']));
  });

  test('a resumed connection continues the log without duplicating an event (B-07)', () => {
    const { result, sockets, timers, clock } = mount();
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.deliver({ type: 'snapshot', generation: 1, seq: 1, state: state(0) }));
    act(() => sockets[0]!.deliver(frame(1, 1, 2)));
    act(() => sockets[0]!.drop());
    act(() => timers.fireTimeouts());
    act(() => sockets[1]!.open());
    expect(sockets[1]!.sent[0]).toEqual({ type: 'hello', lastGeneration: 1, lastSeq: 2 });

    act(() => sockets[1]!.deliver(frame(1, 3, 4)));
    clock.setNow(5000);
    act(() => clock.pump());
    expect(seqs(result.current.events)).toEqual([1, 2, 3, 4]);
    expectStrictlyAscending(result.current.events);
  });

  test('an overlapping replay is a gap, not a duplicate: the client resynchronises', () => {
    const { result, sockets, clock } = mount();
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.deliver({ type: 'snapshot', generation: 1, seq: 1, state: state(0) }));
    act(() => sockets[0]!.deliver(frame(1, 1, 3)));
    clock.setNow(2000);
    act(() => clock.pump());

    act(() => sockets[0]!.deliver(frame(1, 2, 5)));
    expect(result.current.playback).toBe('resyncing');
    expect(seqs(result.current.events)).toEqual([1, 2, 3]);
    // The snapshot request is a fresh connection whose hello carries no cursor.
    expect(sockets[0]!.closedByClient).toBe(true);
    expect(sockets).toHaveLength(2);
    act(() => sockets[1]!.open());
    expect(sockets[1]!.sent).toEqual([{ type: 'hello' }]);
  });

  test('a frame of a superseded generation is applied nowhere (P-15)', () => {
    const { result, sockets, clock } = mount();
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.deliver({ type: 'snapshot', generation: 5, seq: 1, state: state(0) }));
    act(() => sockets[0]!.deliver(frame(4, 1, 3)));
    clock.setNow(5000);
    act(() => clock.pump());
    expect(result.current.events).toEqual([]);
    expect(sockets[0]!.sent.filter((message) => message.type === 'ack')).toEqual([]);
  });

  test('a smuggled seed surfaces PROTOCOL and closes the socket rather than being dropped', () => {
    const { result, sockets } = mount();
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.deliver({ type: 'snapshot', generation: 1, seq: 1, state: { ...state(0), seed: 7 } }));
    expect(result.current.playback).toBe('error');
    expect(result.current.error).toEqual({ code: 'PROTOCOL', field: 'state.seed' });
    expect(sockets[0]!.closedByClient).toBe(true);
  });
});
