/**
 * The one socket (milestone B spec part 1 §3; part 4 §2 rule 6).
 *
 * One `/ws` connection, authenticated by the session cookie the browser sends
 * with the upgrade — never a token in the URL, a subprotocol or a message
 * (P-07). On open it sends `hello` with the cursor of what the client has
 * applied, so the server can resume with a frame or answer with a snapshot;
 * it sends `heartbeat` on the configured interval and `ack` up to the last
 * applied `seq` when the playback reducer asks for one. On loss it reconnects
 * with exponential backoff (layer-1 §11). It never sends `advance`: the three
 * messages `protocol.ts` admits are the only ones `encodeClientMessage` writes.
 *
 * A snapshot has no request message in part 1 §3's vocabulary. The server
 * sends one on `hello` whenever the cursor is absent or stale, so the client
 * requests a snapshot by reconnecting without a cursor (ruling R169).
 *
 * Ruling R169: a snapshot is requested by reconnecting with a cursor-less
 * `hello` — because part 1 §3 gives the client no snapshot request message and
 * the client may not invent one; the server already answers a cursor-less
 * `hello` with a snapshot.
 */
import { encodeClientMessage, type ClientMessage } from './protocol';

/** The `WebSocket` surface used here; a test substitutes a hand-written fake (R56). */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  setInterval(callback: () => void, ms: number): number;
  clearInterval(handle: number): void;
}

export const DEFAULT_TIMERS: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms) as unknown as number,
  clearInterval: (handle) => globalThis.clearInterval(handle),
};

/** "Roughly every 30 s" — part 2 §3's proposed presence interval (layer-1 §4.6). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Reconnect backoff: doubles from the first delay to the cap, and resets on open. */
export const RECONNECT_INITIAL_MS = 500;
export const RECONNECT_MAX_MS = 30_000;

/**
 * Close reasons after which reconnecting cannot help without the player: the
 * session is gone, or this client already broke the contract. The server puts
 * the taxonomy code in the close reason (`apps/server/src/ws/socket.ts`).
 */
const TERMINAL_REASONS: ReadonlySet<string> = new Set(['UNAUTHENTICATED', 'FORBIDDEN_ORIGIN']);

export interface Cursor {
  readonly lastGeneration?: number;
  readonly lastSeq?: number;
}

export interface TransportOptions {
  readonly url: string;
  readonly createSocket: (url: string) => SocketLike;
  /** What the client has applied, read at each `hello`; `{}` asks for a snapshot. */
  readonly cursor: () => Cursor;
  readonly onMessage: (data: unknown) => void;
  readonly onOpen?: () => void;
  readonly onClose?: (reason: string) => void;
  readonly timers?: Timers;
  readonly heartbeatMs?: number;
}

export interface Transport {
  send(message: ClientMessage): void;
  /** Drops the connection and reconnects at once, with no cursor: the server answers with a snapshot. */
  resync(): void;
  /** Ends the transport for good. */
  close(): void;
}

export function socketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export function createTransport(options: TransportOptions): Transport {
  const timers = options.timers ?? DEFAULT_TIMERS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;

  let socket: SocketLike | null = null;
  let open = false;
  let ended = false;
  let delay = RECONNECT_INITIAL_MS;
  let retry: number | null = null;
  let heartbeat: number | null = null;
  let snapshotNext = false;

  const stopHeartbeat = (): void => {
    if (heartbeat !== null) timers.clearInterval(heartbeat);
    heartbeat = null;
  };

  const detach = (current: SocketLike): void => {
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
  };

  const write = (message: ClientMessage): void => {
    if (socket !== null && open) socket.send(encodeClientMessage(message));
  };

  const scheduleReconnect = (): void => {
    if (ended || retry !== null) return;
    retry = timers.setTimeout(() => {
      retry = null;
      connect();
    }, delay);
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
  };

  function connect(): void {
    if (ended) return;
    const current = options.createSocket(options.url);
    socket = current;
    open = false;

    current.onopen = () => {
      open = true;
      delay = RECONNECT_INITIAL_MS;
      const cursor = snapshotNext ? {} : options.cursor();
      snapshotNext = false;
      write({ type: 'hello', ...cursor });
      stopHeartbeat();
      heartbeat = timers.setInterval(() => write({ type: 'heartbeat' }), heartbeatMs);
      options.onOpen?.();
    };
    current.onmessage = (event) => {
      options.onMessage(event.data);
    };
    current.onclose = (event) => {
      detach(current);
      if (socket === current) {
        socket = null;
        open = false;
        stopHeartbeat();
      }
      options.onClose?.(event.reason);
      if (TERMINAL_REASONS.has(event.reason)) {
        ended = true;
        return;
      }
      scheduleReconnect();
    };
    current.onerror = () => {
      // A failed connection also closes; the close handler decides.
    };
  }

  connect();

  return {
    send: write,
    resync() {
      if (ended) return;
      const current = socket;
      snapshotNext = true;
      if (current !== null) {
        detach(current);
        socket = null;
        open = false;
        stopHeartbeat();
        current.close(1000, 'resync');
      }
      if (retry !== null) {
        timers.clearTimeout(retry);
        retry = null;
      }
      connect();
    },
    close() {
      ended = true;
      if (retry !== null) timers.clearTimeout(retry);
      retry = null;
      stopHeartbeat();
      const current = socket;
      socket = null;
      open = false;
      if (current !== null) {
        detach(current);
        current.close(1000, 'client');
      }
    },
  };
}
