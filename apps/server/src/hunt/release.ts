/**
 * What a client is allowed to see, and when (layer-1 §4.4 steps 4–5, P-16,
 * gate B-08).
 *
 * The server may simulate ahead of the wall clock — it is cheaper to run a
 * segment in one go than to wake up every few hundred milliseconds. That is
 * private. An event is released only once its authoritative timestamp has
 * *elapsed*, so a client can never learn a kill, a drop or a death before it
 * happens, however far ahead the server has run.
 *
 * Two rules make that enforceable rather than aspirational:
 *
 * - The filter is on `event.at`, never on which batch an event arrived in. A
 *   batch is a scheduling detail; the timestamp is the fact.
 * - Violations raise `PROTOCOL` rather than being trimmed. Silently dropping
 *   an out-of-order event would hide the bug that produced it, and the client
 *   would render a gap it cannot detect (contracts §7's precedent: exceeding a
 *   bound is an invariant error, never permission to drop events).
 */
import type { DomainEventWire } from '@narok/protocol';

export class ProtocolViolation extends Error {
  readonly code = 'PROTOCOL' as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ProtocolViolation';
    this.field = field;
  }
}

export interface ReleaseCursor {
  /** Highest `seq` already sent for this generation. */
  readonly lastSeq: number;
  /** Simulated time already released. */
  readonly releasedSimMs: number;
}

export interface ReleaseResult {
  readonly events: DomainEventWire[];
  readonly cursor: ReleaseCursor;
  /** Events held back because their instant has not elapsed yet. */
  readonly withheld: number;
}

/**
 * Selects the events of `batch` that have elapsed at `releaseSimMs` and follow
 * `cursor`, in `(at, seq)` order.
 *
 * `batch` is whatever the engine produced, which may run past the release
 * point; the remainder stays on the server until its instant arrives.
 */
export function release(
  batch: readonly DomainEventWire[],
  releaseSimMs: number,
  cursor: ReleaseCursor,
): ReleaseResult {
  const ordered = [...batch].sort((a, b) => (a.at === b.at ? a.seq - b.seq : a.at - b.at));

  const events: DomainEventWire[] = [];
  let lastSeq = cursor.lastSeq;
  let withheld = 0;

  for (const event of ordered) {
    if (event.at > releaseSimMs) {
      withheld += 1;
      continue;
    }
    // Already sent. Not an error: a reconnect legitimately replays a batch.
    if (event.seq <= cursor.lastSeq) continue;

    if (event.seq <= lastSeq) {
      throw new ProtocolViolation('seq', `event seq ${event.seq} is not greater than the last released ${lastSeq}`);
    }
    events.push(event);
    lastSeq = event.seq;
  }

  return {
    events,
    cursor: { lastSeq, releasedSimMs: Math.max(cursor.releasedSimMs, releaseSimMs) },
    withheld,
  };
}

/**
 * The last check before a frame leaves the process.
 *
 * `release` already guarantees this for anything it produced; this exists for
 * everything else — a hand-built frame, a replayed buffer, a future code path
 * that assembles events some other way. It is cheap, and it is the difference
 * between "the filter is correct" and "no frame can be wrong".
 */
export function assertReleasable(events: readonly DomainEventWire[], releaseSimMs: number, lastSeq: number): void {
  let previous = lastSeq;
  for (const event of events) {
    if (event.at > releaseSimMs) {
      throw new ProtocolViolation('at', `event at ${event.at} has not elapsed at ${releaseSimMs}`);
    }
    if (event.seq <= previous) {
      throw new ProtocolViolation('seq', `event seq ${event.seq} is not greater than ${previous}`);
    }
    previous = event.seq;
  }
}

/**
 * How far a client may be told the hunt has progressed.
 *
 * The playback buffer (layer-1 §4.4 step 5, a 🟡 proposed default of ~2s) is
 * the client's, not the server's: the server releases what has elapsed, and
 * the client renders slightly behind that so a hiccup does not stall it. The
 * server therefore never subtracts the buffer — doing so here would hide
 * elapsed events from a client that asked honestly.
 */
export function releasePoint(simNowMs: number): number {
  return simNowMs;
}
