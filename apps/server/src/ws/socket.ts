/**
 * The socket (milestone B spec part 1 §3, part 2 §1 steps 2–5).
 *
 * Split in two on purpose. `SocketSession` is one connection as an object —
 * a client message in, server messages out — with every rule of the stream
 * decided there, so the protocol is testable without a network. `registerSocket`
 * is the thin part that binds it to `@fastify/websocket`: authenticate the
 * upgrade, count sockets, move bytes.
 *
 * What the session does *not* own is the hunt. The clock, the settlement, the
 * precomputed segment and the generation all belong to the lifecycle, which
 * the session reaches only through `HuntFeed`. The session owns the one thing
 * that is per connection: what this client has been sent, and therefore what
 * may follow it.
 *
 * Every outbound message passes `assertOutbound` last. The release filter
 * already guarantees most of what it checks; it exists so that "the filter is
 * correct" is not the only thing between the precomputed future and a client
 * (P-16, B-08). A failed check is `PROTOCOL` and the socket closes — nothing
 * is trimmed and sent anyway.
 */
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import {
  clientMessageSchema,
  frameSchema,
  reportSchema,
  snapshotSchema,
  wsErrorSchema,
  DIAGNOSTIC_FIELD_MAX,
  type ClientMessage,
  type DomainEventWire,
  type ErrorCode,
  type PublicStateWire,
  type ServerMessage,
} from '@narok/protocol';
import { AppError, toEnvelope } from '../errors';
import { assertReleasable, ProtocolViolation, release, type ReleaseCursor } from '../hunt/release';
import { requireSession, type Caller } from '../plugins/session';
import type { ServerConfig } from '../config';
import type { RouteContext } from '../routes/context';

// ---------------------------------------------------------------------------
// The port the lifecycle implements
// ---------------------------------------------------------------------------

/**
 * What the lifecycle knows about an account's hunt at one instant.
 *
 * `events` is the retained window of the current generation's lineage — every
 * event with `seq >= baseSeq` the server still holds — and it may run past
 * `releaseSimMs` into the precomputed segment. The session's release filter
 * decides what of it has elapsed; the lifecycle does not have to pre-trim it,
 * and a view that does is equally valid.
 *
 * `state` is the projection *at* `releaseSimMs`, never at the end of the
 * precomputed segment: a later state would show hit points the client has not
 * yet seen taken. The session refuses a state whose `nowMs` is ahead.
 */
export interface HuntView {
  /** Monotonic per account; incremented at start and at every accepted intervention (P-14). */
  readonly generation: number;
  /** `simTimeAt(now)`: nothing stamped after it may reach a client (part 2 §1 step 4). */
  readonly releaseSimMs: number;
  /** The first `seq` the window holds; a client whose cursor is older gets a snapshot. */
  readonly baseSeq: number;
  readonly events: readonly DomainEventWire[];
  readonly state: PublicStateWire;
}

export type HuntPush =
  /** A generation moved (start, intervention, stop, recovery): the session sends a snapshot. */
  | { readonly kind: 'view'; readonly view: HuntView }
  /** A settled report exists; reading it credits nothing (UI spec §8). */
  | { readonly kind: 'report'; readonly generation: number; readonly reportId: string };

export interface HuntFeed {
  /**
   * Connect / reconnect (part 2 §1 step 2): settle, commit, *then* refresh
   * presence, and return the current view. `undefined` when the account has no
   * hunt.
   */
  connect(accountId: string): Promise<HuntView | undefined>;
  /**
   * A heartbeat is a settlement, not a bare presence write: presence is
   * refreshed only after eligible accrual is settled (part 1 §3). Coalescing
   * concurrent callers onto one job is the feed's business (P-24).
   */
  heartbeat(accountId: string): Promise<HuntView | undefined>;
  /** Delivers pushes for the account until the returned function is called. */
  subscribe(accountId: string, listener: (push: HuntPush) => void): () => void;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export interface SocketBounds {
  /** Events sent and not yet acknowledged; past it the socket closes with BACKPRESSURE (P-40). */
  readonly unackedEvents: number;
  /** Largest inbound message, in bytes; past it the message is refused unparsed. */
  readonly inboundBytes: number;
}

/**
 * The bounds are `ServerConfig.bounds`, whose values are proposed defaults
 * logged at startup (P-40, part 1 §9 #7) — not measurements, and not chosen
 * here.
 */
export function socketBounds(config: ServerConfig): SocketBounds {
  return {
    unackedEvents: config.bounds.unackedEventsPerSocket,
    inboundBytes: config.bounds.socketMessageBytes,
  };
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`socket bound ${name} must be a positive integer, got ${value}`);
  }
}

// ---------------------------------------------------------------------------
// The last gate
// ---------------------------------------------------------------------------

export interface OutboundCursor {
  /** Highest generation already sent; -1 before the first message. */
  readonly generation: number;
  /** Highest `seq` sent in that generation, or folded into its snapshot; -1 for none. */
  readonly lastSeq: number;
}

function bounded(field: string): string {
  return field.length > DIAGNOSTIC_FIELD_MAX ? field.slice(0, DIAGNOSTIC_FIELD_MAX) : field;
}

/**
 * The check every message passes immediately before it is written.
 *
 * Returns the message as the strict schema parsed it, and that is what goes
 * on the wire: a state carrying one key more than `PublicState` — a seed, the
 * PRNG, the queue, pending rewards — fails here and is never sent (P-17,
 * B-08). The ordering rules are P-14 and P-16: no generation below one already
 * sent, a generation opened only by a snapshot, and no `seq` at or below one
 * already sent for its generation.
 */
export function assertOutbound(message: ServerMessage, sent: OutboundCursor, releaseSimMs: number): ServerMessage {
  // Parsed against the schema of its own type, so a rejection names the
  // offending path rather than a union mismatch.
  const schema = { frame: frameSchema, snapshot: snapshotSchema, report: reportSchema, error: wsErrorSchema }[message.type];
  const parsed = schema.safeParse(message);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const keys = issue !== undefined && 'keys' in issue ? (issue.keys as readonly string[]) : [];
    const path = [...(issue?.path ?? []), ...keys.slice(0, 1)].map(String).join('.');
    throw new ProtocolViolation(bounded(path === '' ? '$' : path), 'outbound message fails its schema');
  }
  const out = parsed.data as ServerMessage;

  if (out.generation < sent.generation) {
    throw new ProtocolViolation('generation', `generation ${out.generation} is below ${sent.generation}, already sent`);
  }
  const opening = out.generation > sent.generation;

  switch (out.type) {
    case 'snapshot':
      if (!opening && out.seq - 1 < sent.lastSeq) {
        throw new ProtocolViolation('seq', `snapshot seq ${out.seq} rewinds past ${sent.lastSeq + 1}`);
      }
      if (out.state.nowMs > releaseSimMs) {
        throw new ProtocolViolation('state.nowMs', `state at ${out.state.nowMs} has not elapsed at ${releaseSimMs}`);
      }
      break;
    case 'frame': {
      if (opening) throw new ProtocolViolation('generation', 'a frame cannot open a generation');
      const first = out.events[0];
      const last = out.events.at(-1);
      if (first === undefined || last === undefined || first.seq !== out.firstSeq || last.seq !== out.lastSeq) {
        throw new ProtocolViolation('firstSeq', 'frame bounds do not match its events');
      }
      assertReleasable(out.events, releaseSimMs, sent.lastSeq);
      if (out.state.nowMs > releaseSimMs) {
        throw new ProtocolViolation('state.nowMs', `state at ${out.state.nowMs} has not elapsed at ${releaseSimMs}`);
      }
      break;
    }
    case 'report':
      if (opening) throw new ProtocolViolation('generation', 'a report cannot open a generation');
      break;
    case 'error':
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// One connection
// ---------------------------------------------------------------------------

export interface SocketTransport {
  send(message: ServerMessage): void;
  /** Ends the connection; the matching `error` message has already been sent. */
  close(code: ErrorCode): void;
}

export interface SocketSessionOptions {
  readonly accountId: string;
  readonly feed: HuntFeed;
  /**
   * Re-resolves the session that opened the socket (P-11): authentication at
   * upgrade is not perpetual authorization. Called before every heartbeat's
   * settlement and before every push is delivered.
   */
  readonly authorize: () => Promise<boolean>;
  readonly transport: SocketTransport;
  readonly bounds: SocketBounds;
}

/** Raised inside the session to close with a code; never leaves it. */
class Refusal extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly field: string,
  ) {
    super(`${code}:${field}`);
  }
}

export class SocketSession {
  private readonly options: SocketSessionOptions;
  private readonly unsubscribe: () => void;

  private greeted = false;
  private ended = false;

  /** What this client has been sent: the P-14 cursor plus the release cursor. */
  private generation = -1;
  private cursor: ReleaseCursor = { lastSeq: -1, releasedSimMs: 0 };
  /** Event seqs sent in the current generation and not yet acknowledged, ascending. */
  private unacked: number[] = [];

  /** Inbound messages are handled one at a time, in arrival order. */
  private inbound: Promise<void> = Promise.resolve();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: SocketSessionOptions) {
    requirePositiveInteger('unackedEvents', options.bounds.unackedEvents);
    requirePositiveInteger('inboundBytes', options.bounds.inboundBytes);
    this.options = options;
    this.unsubscribe = options.feed.subscribe(options.accountId, (push) => {
      this.track(this.guard(() => this.onPush(push)));
    });
  }

  get closed(): boolean {
    return this.ended;
  }

  /** Accepts one raw client message. Resolves once it has been fully handled. */
  receive(raw: string): Promise<void> {
    const next = this.inbound.then(() => this.guard(() => this.onMessage(raw)));
    this.inbound = next;
    return this.track(next);
  }

  /** Resolves when everything already received or pushed has been handled. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** The transport went away on its own; stop listening to the feed. */
  dispose(): void {
    this.ended = true;
    this.unsubscribe();
  }

  // -- inbound -------------------------------------------------------------

  private async onMessage(raw: string): Promise<void> {
    if (this.closed) return;
    if (Buffer.byteLength(raw, 'utf8') > this.options.bounds.inboundBytes) throw new Refusal('VALIDATION', 'message');

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Refusal('VALIDATION', 'message');
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
      throw new Refusal('VALIDATION', bounded(path === '' ? 'message' : path));
    }
    await this.dispatch(parsed.data);
  }

  private async dispatch(message: ClientMessage): Promise<void> {
    if (message.type === 'hello') {
      if (this.greeted) throw new ProtocolViolation('type', 'hello is sent once per connection');
      this.greeted = true;
      await this.onHello(message.lastGeneration, message.lastSeq);
      return;
    }
    if (!this.greeted) throw new ProtocolViolation('type', `${message.type} before hello`);

    if (message.type === 'heartbeat') {
      await this.onHeartbeat();
    } else {
      this.onAck(message.generation, message.seq);
    }
  }

  private async onHello(lastGeneration: number | undefined, lastSeq: number | undefined): Promise<void> {
    const view = await this.options.feed.connect(this.options.accountId);
    if (this.closed) return;
    if (view === undefined) {
      // Not a close: the socket stays open for the start that will push a view.
      this.emit({ type: 'error', generation: Math.max(this.generation, 0), code: 'NOT_FOUND', field: 'hunt' }, 0);
      return;
    }

    // A backlog the unacked bound could not carry is resynchronised with a
    // snapshot rather than replayed straight into a BACKPRESSURE close.
    const through = this.releasedThrough(view);
    const resumable =
      lastGeneration === view.generation &&
      lastSeq !== undefined &&
      lastSeq >= view.baseSeq - 1 &&
      lastSeq <= through &&
      through - lastSeq <= this.options.bounds.unackedEvents;
    if (!resumable) {
      this.sendSnapshot(view);
      return;
    }

    // Resume: the client holds everything through `lastSeq`, so the cursor
    // starts there and the frame carries only what it missed.
    const held = view.events.find((event) => event.seq === lastSeq);
    this.generation = view.generation;
    this.cursor = { lastSeq, releasedSimMs: held?.at ?? 0 };
    this.unacked = [];
    this.sendFrame(view);
  }

  private async onHeartbeat(): Promise<void> {
    await this.requireAuthorized();
    const view = await this.options.feed.heartbeat(this.options.accountId);
    if (this.closed || view === undefined) return;
    this.deliver(view);
  }

  private onAck(generation: number, seq: number): void {
    // A superseded generation's events were discarded by the client when the
    // snapshot arrived (P-15); a late ack for them is expected, not an error.
    if (generation < this.generation) return;
    if (generation > this.generation) throw new ProtocolViolation('generation', 'ack for a generation not sent');
    if (seq > this.cursor.lastSeq) throw new ProtocolViolation('seq', `ack for seq ${seq}, not sent`);
    this.unacked = this.unacked.filter((sent) => sent > seq);
  }

  // -- pushes --------------------------------------------------------------

  private async onPush(push: HuntPush): Promise<void> {
    if (this.closed) return;
    // Before hello there is no stream to push into; hello will read the view.
    if (!this.greeted) return;
    await this.requireAuthorized();
    if (this.closed) return;

    if (push.kind === 'view') {
      this.deliver(push.view);
    } else if (push.generation === this.generation) {
      this.emit({ type: 'report', generation: push.generation, reportId: push.reportId }, this.cursor.releasedSimMs);
    }
  }

  // -- outbound ------------------------------------------------------------

  /**
   * A view goes out as a snapshot when it opens a generation, as a frame when
   * it continues one, and not at all when it belongs to a generation already
   * superseded here — the delayed pre-intervention frame of P-15.
   */
  private deliver(view: HuntView): void {
    if (view.generation < this.generation) return;
    if (view.generation > this.generation) this.sendSnapshot(view);
    else this.sendFrame(view);
  }

  /** The last `seq` elapsed at the view's release point, from its window. */
  private releasedThrough(view: HuntView): number {
    return release(view.events, view.releaseSimMs, { lastSeq: view.baseSeq - 1, releasedSimMs: 0 }).cursor.lastSeq;
  }

  private sendSnapshot(view: HuntView): void {
    const through = this.releasedThrough(view);
    this.emit({ type: 'snapshot', generation: view.generation, seq: through + 1, state: view.state }, view.releaseSimMs);
    // The snapshot folds every elapsed event into its state. The previous
    // generation's unacked events are superseded, so they no longer count.
    this.cursor = { lastSeq: through, releasedSimMs: view.releaseSimMs };
    this.unacked = [];
  }

  private sendFrame(view: HuntView): void {
    const result = release(view.events, view.releaseSimMs, this.cursor);
    if (result.events.length > 0) {
      if (this.unacked.length + result.events.length > this.options.bounds.unackedEvents) {
        throw new Refusal('BACKPRESSURE', 'ack');
      }
      const first = result.events[0]!;
      const last = result.events.at(-1)!;
      this.emit(
        { type: 'frame', generation: view.generation, firstSeq: first.seq, lastSeq: last.seq, events: result.events, state: view.state },
        view.releaseSimMs,
      );
      this.unacked.push(...result.events.map((event) => event.seq));
    }
    this.cursor = result.cursor;
  }

  private emit(message: ServerMessage, releaseSimMs: number): void {
    if (this.closed) return;
    const out = assertOutbound(message, { generation: this.generation, lastSeq: this.cursor.lastSeq }, releaseSimMs);
    this.options.transport.send(out);
    if (out.generation > this.generation) {
      this.generation = out.generation;
      this.cursor = { lastSeq: -1, releasedSimMs: 0 };
    }
  }

  private async requireAuthorized(): Promise<void> {
    if (!(await this.options.authorize())) throw new Refusal('UNAUTHENTICATED', 'session');
  }

  // -- failure -------------------------------------------------------------

  private track(work: Promise<void>): Promise<void> {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
    return work;
  }

  /** Every failure ends in exactly one `error` message and a close. */
  private async guard(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    let code: ErrorCode;
    let field: string;
    if (error instanceof Refusal || error instanceof ProtocolViolation) {
      ({ code, field } = error);
    } else {
      // A lifecycle refusal (HUNT_FAULTED, MAINTENANCE, …) keeps its code; an
      // unclassified throw becomes INTERNAL with nothing of its detail (P-39).
      ({ code, field } = toEnvelope(error, 'ws'));
    }
    try {
      // Built by hand rather than through `emit`: the error must go out even
      // when the failure was the gate refusing this very stream.
      this.options.transport.send({ type: 'error', generation: Math.max(this.generation, 0), code, field: bounded(field) });
    } finally {
      this.ended = true;
      this.unsubscribe();
      this.options.transport.close(code);
    }
  }
}

// ---------------------------------------------------------------------------
// The Fastify registration
// ---------------------------------------------------------------------------

/**
 * WebSocket close codes. The reason string carries the taxonomy code, which is
 * what a client reads; the numeric code only tells a generic library whether
 * reconnecting makes sense.
 */
function closeCodeFor(code: ErrorCode): number {
  if (code === 'INTERNAL') return 1011;
  if (code === 'BACKPRESSURE' || code === 'RATE_LIMITED' || code === 'MAINTENANCE') return 1013;
  return 1008;
}

function transportFor(socket: WebSocket): SocketTransport {
  return {
    send: (message) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    },
    close: (code) => {
      socket.close(closeCodeFor(code), code);
    },
  };
}

/**
 * Binds `SocketSession` to `/ws`.
 *
 * The upgrade passes three checks before a socket exists, in the app's hook
 * order: the origin guard (P-08, `onRequest`), then the session cookie and
 * nothing else — not a query string, not a subprotocol (P-07) — in this
 * route's `preValidation`, so a refusal is an ordinary HTTP answer and no
 * connection is ever opened for it.
 */
export async function registerSocket(app: FastifyInstance, ctx: RouteContext, feed: HuntFeed): Promise<void> {
  const { stores, config, now } = ctx;
  const open = new Map<string, number>();
  // The caller resolved at upgrade, handed from the hook to the handler.
  const callers = new WeakMap<FastifyRequest, Caller>();

  await app.register(websocket, { options: { maxPayload: config.bounds.socketMessageBytes } });

  app.route({
    method: 'GET',
    url: '/ws',
    preValidation: async (request: FastifyRequest) => {
      callers.set(request, await requireSession(request, stores, config, now()));
    },
    // A plain GET that reached here is authenticated but asked for no socket.
    handler: async () => {
      throw new AppError('VALIDATION', 'upgrade');
    },
    wsHandler: async (socket: WebSocket, request: FastifyRequest) => {
      const transport = transportFor(socket);
      const caller = callers.get(request);
      if (caller === undefined) {
        // Unreachable while preValidation runs first; refuse rather than guess.
        transport.send({ type: 'error', generation: 0, code: 'UNAUTHENTICATED', field: 'session' });
        transport.close('UNAUTHENTICATED');
        return;
      }
      const accountId = caller.account.id;

      const count = (open.get(accountId) ?? 0) + 1;
      if (count > config.bounds.socketsPerAccount) {
        transport.send({ type: 'error', generation: 0, code: 'RATE_LIMITED', field: 'sockets' });
        transport.close('RATE_LIMITED');
        return;
      }
      open.set(accountId, count);

      const session = new SocketSession({
        accountId,
        feed,
        authorize: async () => {
          try {
            await requireSession(request, stores, config, now());
            return true;
          } catch (error) {
            if (error instanceof AppError && error.code === 'UNAUTHENTICATED') return false;
            throw error;
          }
        },
        transport,
        bounds: socketBounds(config),
      });

      // The protocol is JSON text. A binary frame is handed over as an empty
      // message, which the session refuses as VALIDATION like any other
      // malformed input, rather than decoded as though it were text.
      socket.on('message', (data, isBinary) => {
        void session.receive(isBinary ? '' : data.toString());
      });
      socket.on('close', () => {
        session.dispose();
        const remaining = (open.get(accountId) ?? 1) - 1;
        if (remaining <= 0) open.delete(accountId);
        else open.set(accountId, remaining);
      });
    },
  });
}
