/**
 * The socket protocol's invariants (part 1 §3, part 2 §1 steps 2–5): P-11,
 * P-14, P-15, P-16, P-17, P-40 and gate B-08.
 *
 * Almost everything here drives one `SocketSession` directly — message in,
 * messages out — against a fake `HuntFeed`, because every rule under test is a
 * property of the per-connection object and none of them needs a network. The
 * last block runs the same session behind the real upgrade, for the rules that
 * only exist there: the credential travels in the cookie alone (P-07) and the
 * sockets-per-account bound.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { content, validateContent } from '@narok/data';
import {
  createGrid,
  createSimulation,
  defaultPlacement,
  defaultStrategy,
  emptyDropMetrics,
  type LabInput,
} from '@narok/sim';
import {
  publicStateSchema,
  serverMessageSchema,
  type DomainEventWire,
  type ErrorCode,
  type PublicStateWire,
  type ServerMessage,
} from '@narok/protocol';
import { ProtocolViolation } from '../src/hunt/release';
import {
  assertOutbound,
  SocketSession,
  socketBounds,
  type HuntFeed,
  type HuntPush,
  type HuntView,
} from '../src/ws/socket';
import { defaultConfig } from '../src/config';
import { harness, ORIGIN, type Harness } from './helpers';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function event(seq: number, at: number, kind = 'damage'): DomainEventWire {
  return { seq, at, encounter: 1, kind, actorId: 'p0', targetId: 'e0', amount: 5, reason: null, position: null };
}

function state(nowMs: number): PublicStateWire {
  return publicStateSchema.parse({
    nowMs,
    phase: 'fighting',
    stopReason: null,
    actors: [],
    metrics: {
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
      consumed: {},
      actors: {},
      drops: emptyDropMetrics(),
    },
  });
}

function view(generation: number, releaseSimMs: number, events: DomainEventWire[], baseSeq = 0): HuntView {
  return { generation, releaseSimMs, baseSeq, events, state: state(releaseSimMs) };
}

/** A feed whose answers the test sets, and whose pushes the test fires. */
class FakeFeed implements HuntFeed {
  current: HuntView | undefined;
  heartbeats = 0;
  /** When set, the next heartbeat waits on it instead of answering at once. */
  gate: Promise<HuntView | undefined> | undefined;
  private listener: ((push: HuntPush) => void) | undefined;

  constructor(current?: HuntView) {
    this.current = current;
  }

  async connect(): Promise<HuntView | undefined> {
    return this.current;
  }

  async heartbeat(): Promise<HuntView | undefined> {
    this.heartbeats += 1;
    if (this.gate !== undefined) {
      const pending = this.gate;
      this.gate = undefined;
      return pending;
    }
    return this.current;
  }

  subscribe(_accountId: string, listener: (push: HuntPush) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  push(push: HuntPush): void {
    this.listener?.(push);
  }

  get subscribed(): boolean {
    return this.listener !== undefined;
  }
}

interface Wire {
  readonly sent: ServerMessage[];
  closedWith: ErrorCode | undefined;
}

interface Rig {
  readonly session: SocketSession;
  readonly feed: FakeFeed;
  readonly wire: Wire;
  authorized: boolean;
  send(message: unknown): Promise<void>;
}

function rig(feed: FakeFeed, bounds: Partial<{ unackedEvents: number; inboundBytes: number }> = {}): Rig {
  const wire: Wire = { sent: [], closedWith: undefined };
  const box = { authorized: true };
  const session = new SocketSession({
    accountId: 'account-1',
    feed,
    authorize: async () => box.authorized,
    bounds: { ...socketBounds(defaultConfig()), ...bounds },
    transport: {
      send: (message) => wire.sent.push(message),
      close: (code) => {
        wire.closedWith = code;
      },
    },
  });
  return {
    session,
    feed,
    wire,
    get authorized() {
      return box.authorized;
    },
    set authorized(value: boolean) {
      box.authorized = value;
    },
    send: (message: unknown) => session.receive(JSON.stringify(message)),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const errors = (wire: Wire) => wire.sent.filter((message) => message.type === 'error');
const frames = (wire: Wire) => wire.sent.filter((message) => message.type === 'frame');

/** A real hunt, so the honesty tests project an actual engine state. */
const validated = validateContent(content);
const sim = createSimulation(validated, createGrid(validated.grid, validated.shapes));

function labInput(seed: number): LabInput {
  const classes = ['guardian', 'cleric', 'ranger'] as const;
  return {
    seed,
    classes: [...classes],
    recipe: 'mixed',
    placement: defaultPlacement([...classes]),
    strategies: Object.fromEntries(classes.map((id, index) => [`p${index}`, defaultStrategy(id)])),
    rest: { hpStart: 50, mpStart: 30 },
  };
}

/**
 * The shape the lifecycle hands over: the state *at* the release point, and a
 * precomputed batch that runs well past it (part 2 §1 step 3).
 */
function realView(releaseSimMs: number, aheadMs: number): HuntView {
  const started = sim.start(labInput(11));
  const released = sim.advance(started, releaseSimMs, { collect: 'events' });
  const ahead = sim.advance(released.state, releaseSimMs + aheadMs, { collect: 'events' });
  return {
    generation: 1,
    releaseSimMs,
    baseSeq: 0,
    events: [...released.events, ...ahead.events],
    state: sim.project(released.state),
  };
}

// ---------------------------------------------------------------------------
// P-14
// ---------------------------------------------------------------------------

describe('P-14: every message carries generation and seq, monotonic within a generation', () => {
  test('across a hello, heartbeats, an intervention and more heartbeats', async () => {
    const r = rig(new FakeFeed(view(1, 1_000, [event(0, 500), event(1, 1_000)])));
    await r.send({ type: 'hello' });

    r.feed.current = view(1, 2_000, [event(0, 500), event(1, 1_000), event(2, 1_500), event(3, 2_000)]);
    await r.send({ type: 'heartbeat' });
    await r.send({ type: 'ack', generation: 1, seq: 3 });
    r.feed.current = view(1, 3_000, [event(2, 1_500), event(3, 2_000), event(4, 2_500), event(5, 3_500)]);
    await r.send({ type: 'heartbeat' });

    // An accepted intervention: the lineage continues, the generation moves.
    r.feed.current = view(2, 3_000, [event(5, 3_000)], 5);
    r.feed.push({ kind: 'view', view: r.feed.current });
    await r.session.settled();
    r.feed.current = view(2, 4_000, [event(5, 3_000), event(6, 3_800)], 5);
    await r.send({ type: 'heartbeat' });

    expect(r.wire.closedWith).toBeUndefined();
    expect(r.wire.sent.map((m) => m.type)).toEqual(['snapshot', 'frame', 'frame', 'snapshot', 'frame']);

    let generation = -1;
    let lastSeq = -1;
    for (const message of r.wire.sent) {
      expect(serverMessageSchema.safeParse(message).success).toBe(true);
      expect(message.generation).toBeGreaterThanOrEqual(generation);
      if (message.generation > generation) lastSeq = -1;
      generation = message.generation;

      if (message.type === 'snapshot') {
        expect(message.seq - 1).toBeGreaterThanOrEqual(lastSeq);
        lastSeq = message.seq - 1;
      } else if (message.type === 'frame') {
        expect(message.firstSeq).toBeGreaterThan(lastSeq);
        expect(message.events.map((e) => e.seq)).toEqual(
          Array.from({ length: message.lastSeq - message.firstSeq + 1 }, (_, i) => message.firstSeq + i),
        );
        lastSeq = message.lastSeq;
      }
    }

    // The released clock bounded what went out: seq 5 (at 3_500) waited.
    expect(frames(r.wire)[1].events.map((e) => e.seq)).toEqual([4]);
  });

  test('a frame cannot open a generation; only a snapshot can', () => {
    const frame: ServerMessage = {
      type: 'frame',
      generation: 2,
      firstSeq: 4,
      lastSeq: 4,
      events: [event(4, 100)],
      state: state(100),
    };
    expect(() => assertOutbound(frame, { generation: 1, lastSeq: 3 }, 1_000)).toThrow(ProtocolViolation);
  });

  test('a snapshot cannot rewind the sequence of its own generation', () => {
    const snapshot: ServerMessage = { type: 'snapshot', generation: 1, seq: 2, state: state(100) };
    expect(() => assertOutbound(snapshot, { generation: 1, lastSeq: 5 }, 1_000)).toThrow(ProtocolViolation);
  });

  test('no message goes out under a generation lower than one already sent', () => {
    const snapshot: ServerMessage = { type: 'snapshot', generation: 1, seq: 9, state: state(100) };
    expect(() => assertOutbound(snapshot, { generation: 2, lastSeq: 0 }, 1_000)).toThrow(ProtocolViolation);
  });
});

// ---------------------------------------------------------------------------
// P-15
// ---------------------------------------------------------------------------

describe('P-15: a pre-intervention frame delivered after the bump contributes nothing', () => {
  test('a heartbeat that settled under generation 1 answers after generation 2 was sent', async () => {
    const r = rig(new FakeFeed(view(1, 1_000, [event(0, 500)])));
    await r.send({ type: 'hello' });

    // The heartbeat's settlement is slow; the intervention lands meanwhile.
    let answer!: (value: HuntView) => void;
    r.feed.gate = new Promise<HuntView>((resolve) => {
      answer = resolve;
    });
    const beating = r.send({ type: 'heartbeat' });
    await Promise.resolve();

    r.feed.push({ kind: 'view', view: view(2, 1_200, [], 1) });
    // Not `settled()`: the heartbeat is still waiting on its settlement.
    await tick();
    answer(view(1, 2_000, [event(0, 500), event(1, 1_100), event(2, 1_900)]));
    await beating;

    expect(r.wire.closedWith).toBeUndefined();
    expect(r.wire.sent.map((m) => [m.type, m.generation])).toEqual([
      ['snapshot', 1],
      ['snapshot', 2],
    ]);
    const delivered = r.wire.sent.flatMap((m) => (m.type === 'frame' ? m.events.map((e) => e.seq) : []));
    expect(delivered, 'none of the delayed frame reached the wire').toEqual([]);
  });

  test('a push that arrives late, under an older generation, is dropped', async () => {
    const r = rig(new FakeFeed(view(3, 1_000, [], 0)));
    await r.send({ type: 'hello' });
    r.feed.push({ kind: 'view', view: view(2, 900, [event(0, 800)]) });
    r.feed.push({ kind: 'report', generation: 2, reportId: '11111111-1111-4111-8111-111111111111' });
    await r.session.settled();

    expect(r.wire.sent.map((m) => m.type)).toEqual(['snapshot']);
    expect(r.wire.closedWith).toBeUndefined();
  });

  test('an ack for a superseded generation is ignored, not an error', async () => {
    const r = rig(new FakeFeed(view(1, 1_000, [event(0, 500)])));
    await r.send({ type: 'hello' });
    r.feed.push({ kind: 'view', view: view(2, 1_000, [], 1) });
    await r.session.settled();
    await r.send({ type: 'ack', generation: 1, seq: 0 });

    expect(errors(r.wire)).toEqual([]);
    expect(r.wire.closedWith).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P-16 and B-08
// ---------------------------------------------------------------------------

describe('P-16: a violation raises PROTOCOL rather than being trimmed', () => {
  test('a batch whose sequence runs against its timestamps', async () => {
    const r = rig(new FakeFeed(view(1, 0, [])));
    await r.send({ type: 'hello' });
    r.feed.current = view(1, 2_000, [event(1, 500), event(0, 1_500)]);
    await r.send({ type: 'heartbeat' });

    expect(frames(r.wire)).toEqual([]);
    expect(errors(r.wire).map((m) => m.type === 'error' && m.code)).toEqual(['PROTOCOL']);
    expect(r.wire.closedWith).toBe('PROTOCOL');
  });

  test('an already-sent seq that comes back with a later timestamp is not skipped as a replay', async () => {
    const r = rig(new FakeFeed(view(1, 1_000, [])));
    await r.send({ type: 'hello' });
    r.feed.current = view(1, 1_000, [event(0, 400), event(1, 900)]);
    await r.send({ type: 'heartbeat' });
    expect(frames(r.wire)).toHaveLength(1);

    // seq 1 was released at or before 1_000; claiming it happened at 1_800
    // is a rewritten past, and the only honest answer is to stop.
    r.feed.current = view(1, 2_000, [event(1, 1_800), event(2, 1_900)]);
    await r.send({ type: 'heartbeat' });

    expect(frames(r.wire)).toHaveLength(1);
    expect(r.wire.closedWith).toBe('PROTOCOL');
  });

  test('a state ahead of the released clock is the future, and is refused', async () => {
    const r = rig(new FakeFeed({ ...view(1, 1_000, []), state: state(1_001) }));
    await r.send({ type: 'hello' });

    expect(r.wire.sent.filter((m) => m.type === 'snapshot')).toEqual([]);
    expect(r.wire.closedWith).toBe('PROTOCOL');
  });

  test('the last gate refuses an event past the released clock', () => {
    const frame: ServerMessage = {
      type: 'frame',
      generation: 1,
      firstSeq: 3,
      lastSeq: 4,
      events: [event(3, 900), event(4, 1_001)],
      state: state(1_000),
    };
    expect(() => assertOutbound(frame, { generation: 1, lastSeq: 2 }, 1_000)).toThrow(/has not elapsed/);
  });

  test('the last gate refuses a seq not above the last one sent', () => {
    const frame: ServerMessage = {
      type: 'frame',
      generation: 1,
      firstSeq: 2,
      lastSeq: 2,
      events: [event(2, 900)],
      state: state(1_000),
    };
    expect(() => assertOutbound(frame, { generation: 1, lastSeq: 2 }, 1_000)).toThrow(ProtocolViolation);
  });

  test('the last gate refuses a frame whose bounds misstate its events', () => {
    const frame: ServerMessage = {
      type: 'frame',
      generation: 1,
      firstSeq: 3,
      lastSeq: 9,
      events: [event(3, 900)],
      state: state(1_000),
    };
    expect(() => assertOutbound(frame, { generation: 1, lastSeq: 2 }, 1_000)).toThrow(ProtocolViolation);
  });

  test('B-08: a precomputed batch far past the release point leaks nothing', async () => {
    const released = 20_000;
    const precomputed = realView(released, 30_000);
    expect(precomputed.events.some((e) => e.at > released), 'the fixture really runs ahead').toBe(true);

    // A resume from the first event replays the whole retained window, which
    // is the widest path the release filter can be asked to cover.
    const resumed = rig(new FakeFeed(precomputed));
    await resumed.send({ type: 'hello', lastGeneration: 1, lastSeq: 0 });
    await resumed.send({ type: 'heartbeat' });

    const out = resumed.wire.sent.flatMap((m) => (m.type === 'frame' ? m.events : []));
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((e) => e.at <= released)).toBe(true);
    for (const message of resumed.wire.sent) {
      if (message.type === 'frame' || message.type === 'snapshot') expect(message.state.nowMs).toBeLessThanOrEqual(released);
    }
    expect(resumed.wire.closedWith).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P-17 and B-08
// ---------------------------------------------------------------------------

const PRIVATE_KEYS = ['seed', 'rng', 'queue', 'pendingRewards'] as const;

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      keysOf(inner, into);
    }
  }
  return into;
}

describe('P-17: a snapshot is exactly a PublicState', () => {
  test('an honest snapshot of a real hunt has the PublicState keys and no private one', async () => {
    const r = rig(new FakeFeed(realView(20_000, 30_000)));
    await r.send({ type: 'hello' });

    const snapshot = r.wire.sent[0];
    expect(snapshot.type).toBe('snapshot');
    if (snapshot.type !== 'snapshot') return;
    expect(Object.keys(snapshot).sort()).toEqual(['generation', 'seq', 'state', 'type']);
    expect(Object.keys(snapshot.state).sort()).toEqual(Object.keys(publicStateSchema.shape).sort());
    expect(snapshot.state.actors.length).toBeGreaterThan(0);

    const keys = keysOf(snapshot);
    for (const key of PRIVATE_KEYS) expect(keys.has(key), key).toBe(false);
  });

  test.each(PRIVATE_KEYS)('a state carrying `%s` fails the comparison and is never sent', async (key) => {
    const leaky = { ...state(1_000), [key]: 12345 } as PublicStateWire;
    const r = rig(new FakeFeed({ ...view(1, 1_000, []), state: leaky }));
    await r.send({ type: 'hello' });

    expect(r.wire.sent.some((m) => m.type === 'snapshot')).toBe(false);
    expect(r.wire.sent.map((m) => m.type === 'error' && m.field)).toEqual([`state.${key}`]);
    expect(r.wire.closedWith).toBe('PROTOCOL');
  });

  test('an additional key nested in an actor fails too', async () => {
    const real = realView(5_000, 0);
    const leaky = {
      ...real.state,
      actors: real.state.actors.map((actor, index) => (index === 0 ? { ...actor, seed: 7 } : actor)),
    } as PublicStateWire;
    const r = rig(new FakeFeed({ ...real, state: leaky }));
    await r.send({ type: 'hello' });

    expect(r.wire.sent.some((m) => m.type === 'snapshot')).toBe(false);
    expect(r.wire.closedWith).toBe('PROTOCOL');
  });
});

// ---------------------------------------------------------------------------
// hello
// ---------------------------------------------------------------------------

describe('hello: resume inside the retained window, otherwise a snapshot', () => {
  // Released through seq 4; the server still holds seqs 2..6 (5 and 6 are ahead).
  const window = () => view(3, 1_000, [event(2, 300), event(3, 600), event(4, 900), event(5, 1_100), event(6, 1_300)], 2);

  test('a first hello gets a snapshot whose seq is the released cursor', async () => {
    const r = rig(new FakeFeed(window()));
    await r.send({ type: 'hello' });
    expect(r.wire.sent).toMatchObject([{ type: 'snapshot', generation: 3, seq: 5 }]);
  });

  test('a different generation gets a snapshot', async () => {
    const r = rig(new FakeFeed(window()));
    await r.send({ type: 'hello', lastGeneration: 2, lastSeq: 3 });
    expect(r.wire.sent.map((m) => m.type)).toEqual(['snapshot']);
  });

  test('a lastSeq below the retained window gets a snapshot', async () => {
    const r = rig(new FakeFeed(window()));
    await r.send({ type: 'hello', lastGeneration: 3, lastSeq: 0 });
    expect(r.wire.sent.map((m) => m.type)).toEqual(['snapshot']);
  });

  test('a lastSeq past what was released gets a snapshot, not the future', async () => {
    const r = rig(new FakeFeed(window()));
    await r.send({ type: 'hello', lastGeneration: 3, lastSeq: 5 });
    expect(r.wire.sent).toMatchObject([{ type: 'snapshot', seq: 5 }]);
  });

  test('a lastSeq inside the window gets exactly what it missed', async () => {
    const r = rig(new FakeFeed(window()));
    await r.send({ type: 'hello', lastGeneration: 3, lastSeq: 2 });
    expect(r.wire.sent).toMatchObject([{ type: 'frame', generation: 3, firstSeq: 3, lastSeq: 4 }]);
  });

  test('a backlog larger than the unacked bound is resynchronised, not replayed into a close', async () => {
    const r = rig(new FakeFeed(window()), { unackedEvents: 2 });
    await r.send({ type: 'hello', lastGeneration: 3, lastSeq: 1 });
    expect(r.wire.sent).toMatchObject([{ type: 'snapshot', seq: 5 }]);
    expect(r.wire.closedWith).toBeUndefined();
  });

  test('a client already current is sent nothing to replay', async () => {
    const r = rig(new FakeFeed(window()));
    await r.send({ type: 'hello', lastGeneration: 3, lastSeq: 4 });
    expect(r.wire.sent).toEqual([]);
    expect(r.wire.closedWith).toBeUndefined();
  });

  test('no hunt is NOT_FOUND on the stream, and the socket stays for the start', async () => {
    const r = rig(new FakeFeed(undefined));
    await r.send({ type: 'hello' });
    expect(r.wire.sent).toMatchObject([{ type: 'error', code: 'NOT_FOUND', field: 'hunt' }]);
    expect(r.wire.closedWith).toBeUndefined();

    r.feed.push({ kind: 'view', view: view(1, 0, []) });
    await r.session.settled();
    expect(r.wire.sent.at(-1)).toMatchObject({ type: 'snapshot', generation: 1, seq: 0 });
  });

  test('M1: a push that opens a newer generation during hello is never rewound by the older view', async () => {
    class RacingFeed extends FakeFeed {
      override async connect(): Promise<HuntView | undefined> {
        // A start lands while the hello's settlement is in flight.
        this.push({ kind: 'view', view: view(4, 0, []) });
        await new Promise((resolve) => setTimeout(resolve, 0));
        return window();
      }
    }
    const r = rig(new RacingFeed());
    await r.send({ type: 'hello', lastGeneration: 3, lastSeq: 2 });
    await r.session.settled();
    expect(r.wire.sent).toMatchObject([{ type: 'snapshot', generation: 4 }]);
    expect(r.wire.closedWith).toBeUndefined();
  });

  test('a second hello is a protocol violation', async () => {
    const r = rig(new FakeFeed(window()));
    await r.send({ type: 'hello' });
    await r.send({ type: 'hello' });
    expect(r.wire.closedWith).toBe('PROTOCOL');
  });

  test('a heartbeat before hello is a protocol violation, and settles nothing', async () => {
    const r = rig(new FakeFeed(window()));
    await r.send({ type: 'heartbeat' });
    expect(r.wire.closedWith).toBe('PROTOCOL');
    expect(r.feed.heartbeats).toBe(0);
  });

  test('a client message outside the vocabulary is VALIDATION — there is no advance', async () => {
    const r = rig(new FakeFeed(window()));
    await r.send({ type: 'advance', untilMs: 60_000 });
    expect(r.wire.sent).toMatchObject([{ type: 'error', code: 'VALIDATION' }]);
    expect(r.wire.closedWith).toBe('VALIDATION');
  });
});

// ---------------------------------------------------------------------------
// P-40
// ---------------------------------------------------------------------------

describe('P-40: unacknowledged output past its bound closes with BACKPRESSURE', () => {
  const burst = (from: number, count: number, at: number) =>
    Array.from({ length: count }, (_, i) => event(from + i, at));

  test('a client that never acks is closed, and the overflowing frame is not sent', async () => {
    const r = rig(new FakeFeed(view(1, 0, [])), { unackedEvents: 5 });
    await r.send({ type: 'hello' });
    r.feed.current = view(1, 1_000, burst(0, 3, 1_000));
    await r.send({ type: 'heartbeat' });
    r.feed.current = view(1, 2_000, [...burst(0, 3, 1_000), ...burst(3, 3, 2_000)]);
    await r.send({ type: 'heartbeat' });

    expect(frames(r.wire)).toHaveLength(1);
    expect(r.wire.sent.at(-1)).toMatchObject({ type: 'error', code: 'BACKPRESSURE' });
    expect(r.wire.closedWith).toBe('BACKPRESSURE');
    expect(r.feed.subscribed).toBe(false);
  });

  test('the same traffic, acknowledged, flows', async () => {
    const r = rig(new FakeFeed(view(1, 0, [])), { unackedEvents: 5 });
    await r.send({ type: 'hello' });
    r.feed.current = view(1, 1_000, burst(0, 3, 1_000));
    await r.send({ type: 'heartbeat' });
    await r.send({ type: 'ack', generation: 1, seq: 2 });
    r.feed.current = view(1, 2_000, [...burst(0, 3, 1_000), ...burst(3, 3, 2_000)]);
    await r.send({ type: 'heartbeat' });

    expect(frames(r.wire)).toHaveLength(2);
    expect(r.wire.closedWith).toBeUndefined();
  });

  test('a frame larger than the bound on its own is refused, not split', async () => {
    const r = rig(new FakeFeed(view(1, 0, [])), { unackedEvents: 5 });
    await r.send({ type: 'hello' });
    r.feed.current = view(1, 1_000, burst(0, 6, 1_000));
    await r.send({ type: 'heartbeat' });

    expect(frames(r.wire)).toEqual([]);
    expect(r.wire.closedWith).toBe('BACKPRESSURE');
  });

  test('an ack for output never sent is a protocol violation', async () => {
    const r = rig(new FakeFeed(view(1, 1_000, [event(0, 500)])));
    await r.send({ type: 'hello' });
    await r.send({ type: 'ack', generation: 1, seq: 7 });
    expect(r.wire.closedWith).toBe('PROTOCOL');
  });

  test('an ack for a generation not yet sent is a protocol violation', async () => {
    const r = rig(new FakeFeed(view(1, 1_000, [])));
    await r.send({ type: 'hello' });
    await r.send({ type: 'ack', generation: 2, seq: 0 });
    expect(r.wire.closedWith).toBe('PROTOCOL');
  });

  test('an inbound message over its byte bound is refused before it is parsed', async () => {
    const r = rig(new FakeFeed(view(1, 1_000, [])), { inboundBytes: 64 });
    await r.session.receive(JSON.stringify({ type: 'hello', padding: 'x'.repeat(100) }));
    expect(r.wire.sent).toMatchObject([{ type: 'error', code: 'VALIDATION', field: 'message' }]);
    expect(r.wire.closedWith).toBe('VALIDATION');
  });

  test.each([0, -1, 1.5, Number.NaN])('a bound of %s is refused at construction', (bad) => {
    expect(() => rig(new FakeFeed(), { unackedEvents: bad })).toThrow(/unackedEvents/);
    expect(() => rig(new FakeFeed(), { inboundBytes: bad })).toThrow(/inboundBytes/);
  });

  test('the bounds come from configuration, whose defaults are logged at startup', () => {
    const config = defaultConfig();
    expect(socketBounds(config)).toEqual({
      unackedEvents: config.bounds.unackedEventsPerSocket,
      inboundBytes: config.bounds.socketMessageBytes,
    });
  });
});

// ---------------------------------------------------------------------------
// P-11
// ---------------------------------------------------------------------------

describe('P-11: a session revoked mid-hunt stops frame delivery', () => {
  test('re-checked per heartbeat: the dead session settles nothing and receives nothing', async () => {
    const r = rig(new FakeFeed(view(1, 1_000, [event(0, 500)])));
    await r.send({ type: 'hello' });
    r.feed.current = view(1, 2_000, [event(0, 500), event(1, 1_500)]);
    await r.send({ type: 'heartbeat' });
    expect(frames(r.wire)).toHaveLength(1);

    r.authorized = false;
    r.feed.current = view(1, 3_000, [event(1, 1_500), event(2, 2_500)]);
    await r.send({ type: 'heartbeat' });

    expect(r.feed.heartbeats, 'no settlement, so no presence refresh, on a dead session').toBe(1);
    expect(r.wire.sent.at(-1)).toMatchObject({ type: 'error', code: 'UNAUTHENTICATED' });
    expect(r.wire.closedWith).toBe('UNAUTHENTICATED');

    const before = r.wire.sent.length;
    r.feed.push({ kind: 'view', view: view(2, 3_000, [], 2) });
    await r.send({ type: 'heartbeat' });
    await r.session.settled();
    expect(r.wire.sent).toHaveLength(before);
  });

  test('a push is re-checked too, so an intervention cannot reach a revoked session', async () => {
    const r = rig(new FakeFeed(view(1, 1_000, [])));
    await r.send({ type: 'hello' });
    r.authorized = false;
    r.feed.push({ kind: 'view', view: view(2, 1_000, [], 0) });
    await r.session.settled();

    expect(r.wire.sent.some((m) => m.type === 'snapshot' && m.generation === 2)).toBe(false);
    expect(r.wire.closedWith).toBe('UNAUTHENTICATED');
  });
});

// ---------------------------------------------------------------------------
// The real upgrade
// ---------------------------------------------------------------------------

type Client = Awaited<ReturnType<Harness['app']['injectWS']>>;

function inbox(ws: Client) {
  const received: ServerMessage[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
  });
  ws.on('message', (data: Buffer) => received.push(JSON.parse(data.toString()) as ServerMessage));
  const next = async (count: number) => {
    for (let i = 0; i < 100 && received.length < count; i += 1) await new Promise((r) => setTimeout(r, 5));
    return received;
  };
  return { received, closed, next };
}

describe('over the real upgrade', () => {
  let h: Harness;
  let feed: FakeFeed;

  afterEach(async () => {
    await h.app.close();
  });

  async function open(overrides = {}) {
    feed = new FakeFeed(view(1, 1_000, [event(0, 500)]));
    h = await harness(overrides, { huntFeed: feed });
    return h.signUp();
  }

  test('an authenticated hello is answered with a snapshot', async () => {
    const cookie = await open();
    const ws = await h.app.injectWS('/ws', { headers: { cookie, origin: ORIGIN } });
    const box = inbox(ws);
    ws.send(JSON.stringify({ type: 'hello' }));

    const [first] = await box.next(1);
    expect(first).toMatchObject({ type: 'snapshot', generation: 1, seq: 1 });
    ws.terminate();
  });

  test('P-07 holds on the upgrade: a credential in the subprotocol is not a session', async () => {
    const cookie = await open();
    const token = cookie.slice('narok_session='.length);
    await expect(
      h.app.injectWS('/ws', { headers: { origin: ORIGIN, 'sec-websocket-protocol': `narok, ${token}` } }),
    ).rejects.toThrow(/401/);
  });

  test('P-07 holds on the upgrade: a credential in the query string is not a session', async () => {
    const cookie = await open();
    const token = cookie.slice('narok_session='.length);
    await expect(h.app.injectWS(`/ws?session=${token}`, { headers: { origin: ORIGIN } })).rejects.toThrow(/401/);
  });

  test('P-08 holds on the upgrade: a foreign origin is refused before anything else', async () => {
    const cookie = await open();
    await expect(
      h.app.injectWS('/ws', { headers: { cookie, origin: 'https://evil.example.com' } }),
    ).rejects.toThrow(/403/);
  });

  test('P-10/P-11: a password reset closes the open socket at the next heartbeat', async () => {
    const cookie = await open();
    const ws = await h.app.injectWS('/ws', { headers: { cookie, origin: ORIGIN } });
    const box = inbox(ws);
    ws.send(JSON.stringify({ type: 'hello' }));
    await box.next(1);

    const account = await h.stores.accounts.byEmail('player@example.com');
    await h.stores.accounts.resetPassword(account!.id, 'a-brand-new-long-password');
    feed.current = view(1, 2_000, [event(0, 500), event(1, 1_500)]);
    ws.send(JSON.stringify({ type: 'heartbeat' }));

    const closed = await box.closed;
    expect(closed.reason).toBe('UNAUTHENTICATED');
    expect(box.received.map((m) => m.type)).toEqual(['snapshot', 'error']);
  });

  test('the sockets-per-account bound refuses one more with RATE_LIMITED', async () => {
    const cookie = await open({ bounds: { ...defaultConfig().bounds, socketsPerAccount: 1 } });
    const first = await h.app.injectWS('/ws', { headers: { cookie, origin: ORIGIN } });
    const second = await h.app.injectWS('/ws', { headers: { cookie, origin: ORIGIN } });
    const box = inbox(second);

    // Only the close is asserted: the refusal is written the moment the
    // socket opens, before `injectWS` hands the client over to attach a
    // message listener, so the paired `error` message can race it here.
    const closed = await box.closed;
    expect(closed.reason).toBe('RATE_LIMITED');
    first.terminate();
  });

  test('a plain GET without an upgrade is not a socket', async () => {
    const cookie = await open();
    const response = await h.app.inject({ method: 'GET', url: '/ws', headers: { cookie } });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION');
  });
});
