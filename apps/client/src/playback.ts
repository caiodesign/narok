/**
 * Playback of the server-authoritative hunt (milestone B spec part 4 §2).
 *
 * Pure: `reduce(view, message, nowMs)` returns the next view and the effects
 * the caller must perform — `request-snapshot` or `ack` — and touches no
 * socket, no timer and no clock. `nowMs` is the caller's render instant and is
 * used for one thing only: pacing what is *shown* against `clock.ts`'s
 * horizon. Nothing here derives authoritative time from it; the authoritative
 * clock is `releasedUntilMs`, which only the server moves.
 *
 * The rules, in part 4 §2's numbering:
 *
 *  1. Render horizon — the view exposes an event or a state only once
 *     `horizon(clock, now)` has reached its timestamp. Everything else waits
 *     in `queue`/`held`, never drawn.
 *  2. Never future — a message carrying a seed, an RNG word, any key the
 *     strict schema does not know, or an event stamped after the frame's
 *     released clock, is `PROTOCOL`. Nothing from it is applied.
 *  3. Generations — a message below the highest generation observed changes
 *     nothing. A higher one drops the queue and the history, requests a
 *     snapshot, and splices nothing onto the old history.
 *  4. Sequence gaps — a frame that does not continue `lastSeq` requests a
 *     snapshot; no event is guessed and none is renumbered.
 *  5. Resynchronisation — a snapshot replaces the state wholesale, sets
 *     `simAnchorMs = releasedUntilMs` and `realAnchorMs = now`, and clears the
 *     history. A snapshot's `releasedUntilMs` is its `state.nowMs` (ruling
 *     R168: the server projects the state exactly at its release point).
 *  7. Starvation — when the horizon overruns the release edge the view holds
 *     the last frame, says `buffering`, and pins the clock at the edge.
 *
 * Rule 6 (reconnect) is the transport's; R109's identity rule binds here by
 * R167: a message that exposes no event returns the same `events` array, and
 * one that changes nothing returns the same view.
 *
 * Ruling R167 (milestone B Task 9; the plan's R133): R109's "any future
 * publisher of a per-frame collection" now binds the socket handler — this
 * reducer — at the same 16.7 ms per-frame budget A measured against — because
 * the socket replaced the worker as the publisher every HUD memo keys on, and
 * a fresh empty array per frame would re-render the log at the release rate.
 *
 * Ruling R168: a snapshot's `releasedUntilMs` is its `state.nowMs` — because
 * the server projects the state exactly at its release point, and the wire
 * snapshot carries no second clock field to disagree with it.
 */
import { horizon, reanchor, type PlaybackClock } from './clock';
import { parseServerMessage, type DomainEventWire, type ProtocolFault, type PublicStateWire, type ServerMessage } from './protocol';
import type { TerminalCloseCode } from './transport';

/** The speeds `clock.ts` is exercised at (milestone A's `ALLOWED_SPEEDS`); production plays at 1×. */
export const ALLOWED_SPEEDS = [1, 4, 16] as const;

/** The 2,000 simulation-ms playback buffer A shipped (A spec §11; layer-1 §4.4 🟡). */
export const PLAYBACK_BUFFER_MS = 2000;

/** The visible history bound: a display buffer, not a record (A spec §11). */
export const EVENT_HISTORY_LIMIT = 500;

/**
 * Part 4 §2's playback states, plus `idle` (no hunt), `connecting` (before any
 * message) and `closed`.
 *
 * Ruling R179: a socket the server closed with `UNAUTHENTICATED` or
 * `FORBIDDEN_ORIGIN` is `closed` — a terminal state carrying that code, with
 * its own copy — never `disconnected` — because the transport does not
 * reconnect after either, so "Reconnecting" would promise what will not happen.
 */
export type PlaybackStatus =
  | 'connecting'
  | 'idle'
  | 'live'
  | 'buffering'
  | 'resyncing'
  | 'disconnected'
  | 'closed'
  | 'faulted'
  | 'error';

export interface PlaybackView {
  readonly status: PlaybackStatus;
  /** Highest generation observed; -1 before the first message. */
  readonly generation: number;
  /** Last `seq` applied (queued or shown) in that generation; -1 for none. */
  readonly lastSeq: number;
  /** The server's released clock: no event or state after it exists here. */
  readonly releasedUntilMs: number;
  readonly clock: PlaybackClock;
  /** The state shown: the newest released one at or behind the horizon. */
  readonly state: PublicStateWire | null;
  /** Released events not yet reached by the horizon; never shown. */
  readonly queue: readonly DomainEventWire[];
  /** Released states not yet reached by the horizon; never shown. */
  readonly held: readonly PublicStateWire[];
  /** The shown history, bounded to {@link EVENT_HISTORY_LIMIT}. */
  readonly events: readonly DomainEventWire[];
  readonly error: ProtocolFault | null;
  /** The latest settled away report the server pointed at (UI spec §8). */
  readonly reportId: string | null;
}

export type Effect =
  | { readonly kind: 'request-snapshot'; readonly generation: number }
  | { readonly kind: 'ack'; readonly generation: number; readonly seq: number };

/** Local signals the hook feeds the reducer; never on the wire. */
export type PlaybackSignal =
  | { readonly type: 'tick' }
  | { readonly type: 'disconnected' }
  /** A terminal close (R179): no reconnect follows. */
  | { readonly type: 'closed'; readonly code: TerminalCloseCode };

export interface Reduction {
  readonly view: PlaybackView;
  readonly effects: readonly Effect[];
}

const NONE: readonly Effect[] = [];
const NO_EVENTS: readonly DomainEventWire[] = [];
const NO_STATES: readonly PublicStateWire[] = [];

export function initialView(nowMs: number): PlaybackView {
  return {
    status: 'connecting',
    generation: -1,
    lastSeq: -1,
    releasedUntilMs: 0,
    clock: { realAnchorMs: nowMs, simAnchorMs: 0, speed: 1, paused: true, bufferMs: PLAYBACK_BUFFER_MS },
    state: null,
    queue: NO_EVENTS,
    held: NO_STATES,
    events: NO_EVENTS,
    error: null,
    reportId: null,
  };
}

function unchanged(view: PlaybackView): Reduction {
  return { view, effects: NONE };
}

function isSignal(message: unknown): message is PlaybackSignal {
  if (message === null || typeof message !== 'object') return false;
  const type = (message as { type?: unknown }).type;
  return type === 'tick' || type === 'disconnected' || type === 'closed';
}

function fail(view: PlaybackView, fault: ProtocolFault): Reduction {
  return { view: { ...view, status: 'error', error: fault }, effects: NONE };
}

/** The newest `limit` of `events`, or `events` itself when already within it. */
function bound(events: readonly DomainEventWire[]): readonly DomainEventWire[] {
  return events.length > EVENT_HISTORY_LIMIT ? events.slice(events.length - EVENT_HISTORY_LIMIT) : events;
}

/**
 * Moves everything the horizon has reached from the queue to the view, then
 * applies rule 7. Returns `view` itself when nothing changed.
 */
function flush(view: PlaybackView, nowMs: number): PlaybackView {
  if (view.status === 'resyncing' || view.status === 'error' || view.status === 'idle') return view;
  const edge = horizon(view.clock, nowMs);

  let next = view;
  const dueEvents = view.queue.filter((event) => event.at <= edge);
  if (dueEvents.length > 0) {
    next = {
      ...next,
      queue: dueEvents.length === view.queue.length ? NO_EVENTS : view.queue.filter((event) => event.at > edge),
      events: bound([...view.events, ...dueEvents]),
    };
  }
  const dueStates = view.held.filter((state) => state.nowMs <= edge);
  if (dueStates.length > 0) {
    next = {
      ...next,
      held: dueStates.length === view.held.length ? NO_STATES : view.held.filter((state) => state.nowMs > edge),
      state: dueStates[dueStates.length - 1]!,
    };
  }

  // Rule 7: the horizon overran the release edge. Hold the last frame and pin
  // the clock exactly at the edge (its unbuffered anchor is edge + buffer), so
  // playback resumes from there when more is released rather than jumping.
  if ((next.status === 'live' || next.status === 'disconnected') && edge > next.releasedUntilMs) {
    next = {
      ...next,
      status: next.status === 'live' ? 'buffering' : next.status,
      clock: { ...next.clock, simAnchorMs: next.releasedUntilMs + next.clock.bufferMs, realAnchorMs: nowMs, paused: true },
    };
  }
  return next;
}

function resync(view: PlaybackView, generation: number): Reduction {
  return {
    view: {
      ...view,
      status: 'resyncing',
      generation,
      queue: NO_EVENTS,
      held: NO_STATES,
      events: generation > view.generation ? NO_EVENTS : view.events,
    },
    effects: [{ kind: 'request-snapshot', generation }],
  };
}

function onSnapshot(view: PlaybackView, message: Extract<ServerMessage, { type: 'snapshot' }>, nowMs: number): Reduction {
  const releasedUntilMs = message.state.nowMs;
  return {
    view: flush(
      {
        ...view,
        status: 'live',
        generation: message.generation,
        // The snapshot folds every elapsed event up to `seq - 1` into its state.
        lastSeq: message.seq - 1,
        releasedUntilMs,
        clock: { ...view.clock, simAnchorMs: releasedUntilMs, realAnchorMs: nowMs, paused: false },
        state: message.state,
        queue: NO_EVENTS,
        held: NO_STATES,
        events: NO_EVENTS,
        error: null,
      },
      nowMs,
    ),
    effects: NONE,
  };
}

function onFrame(view: PlaybackView, message: Extract<ServerMessage, { type: 'frame' }>, nowMs: number): Reduction {
  if (message.generation > view.generation) return resync(view, message.generation);
  // Waiting for the snapshot a resync asked for: nothing may be spliced in.
  if (view.status === 'resyncing') return unchanged(view);

  const releasedUntilMs = message.state.nowMs;
  const { events } = message;

  // Rule 2: everything in a frame has elapsed at its own released clock.
  for (let index = 0; index < events.length; index++) {
    if (events[index]!.at > releasedUntilMs) return fail(view, { code: 'PROTOCOL', field: `events.${index}.at` });
  }
  if (releasedUntilMs < view.releasedUntilMs) return fail(view, { code: 'PROTOCOL', field: 'state.nowMs' });

  if (events.length > 0) {
    // The frame's own bounds must describe its events, contiguously.
    const contiguous = events.every((event, index) => event.seq === message.firstSeq + index);
    if (!contiguous || events[events.length - 1]!.seq !== message.lastSeq) {
      return fail(view, { code: 'PROTOCOL', field: 'firstSeq' });
    }
    // Rule 4: it must also continue what was already applied.
    if (message.firstSeq !== view.lastSeq + 1) return resync(view, view.generation);
  }

  const wasStarved = view.status === 'buffering' || view.status === 'disconnected' || view.status === 'connecting';
  const grew = releasedUntilMs > view.releasedUntilMs;
  const next: PlaybackView = {
    ...view,
    status: 'live',
    lastSeq: events.length > 0 ? message.lastSeq : view.lastSeq,
    releasedUntilMs,
    // Resume from the edge the clock was pinned at, never from wall time.
    clock: wasStarved && grew ? reanchor(view.clock, nowMs, { paused: false }) : view.clock,
    queue: events.length > 0 ? [...view.queue, ...events] : view.queue,
    held: [...view.held, message.state],
  };
  const effects: readonly Effect[] =
    events.length > 0 ? [{ kind: 'ack', generation: message.generation, seq: message.lastSeq }] : NONE;
  return { view: flush(next, nowMs), effects };
}

/**
 * The single transition. `message` is a raw inbound socket payload (text or
 * decoded) or a local signal; raw payloads are validated here, so a caller
 * cannot apply an unvalidated message by accident.
 */
export function reduce(view: PlaybackView, message: unknown, nowMs: number): Reduction {
  if (view.status === 'error' || view.status === 'closed') return unchanged(view);

  if (isSignal(message)) {
    if (message.type === 'tick') {
      const next = flush(view, nowMs);
      return next === view ? unchanged(view) : { view: next, effects: NONE };
    }
    if (message.type === 'closed') {
      return { view: { ...view, status: 'closed', error: { code: message.code, field: 'socket' } }, effects: NONE };
    }
    if (view.status === 'disconnected' || view.status === 'idle') return unchanged(view);
    return { view: { ...view, status: 'disconnected' }, effects: NONE };
  }

  const parsed = parseServerMessage(message);
  if (!parsed.ok) return fail(view, parsed.fault);
  const inbound = parsed.message;

  // Rule 3 / P-15: below the highest generation observed, nothing applies.
  if (inbound.generation < view.generation) return unchanged(view);

  switch (inbound.type) {
    case 'snapshot':
      return onSnapshot(view, inbound, nowMs);
    case 'frame':
      return onFrame(view, inbound, nowMs);
    case 'report':
      // A pointer at a settled report; reading it credits nothing (UI spec §8).
      return { view: { ...view, reportId: inbound.reportId }, effects: NONE };
    case 'error':
      if (inbound.code === 'NOT_FOUND') {
        // The account has no hunt; the socket stays open for the one a start opens.
        return { view: { ...view, status: 'idle', state: null, queue: NO_EVENTS, held: NO_STATES }, effects: NONE };
      }
      return {
        view: {
          ...view,
          status: inbound.code === 'HUNT_FAULTED' ? 'faulted' : view.status === 'idle' ? 'idle' : 'disconnected',
          error: { code: inbound.code, field: inbound.field },
        },
        effects: NONE,
      };
  }
}
