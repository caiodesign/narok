/**
 * Part 4 §2's playback contract, one case per rule, driving the pure reducer by
 * hand: no socket, no timer, no `performance.now()`. Every millisecond below is
 * supplied by the test, which is the point — `reduce` decides what may be shown
 * from the server's released clock and the caller's render instant alone.
 *
 * Gates: B-03 (render horizon), B-05 (generations), B-06 (sequence gaps), B-07
 * (snapshots), the client half of B-08 (a future or private field is PROTOCOL,
 * never trimmed) and of B-23 (R109's identity rule, bound to this publisher by
 * R167).
 */
import { describe, expect, test } from 'vitest';
import type { DomainEventWire, PublicStateWire } from '@narok/protocol';
import { horizon } from '../src/clock';
import { initialView, reduce, type PlaybackView } from '../src/playback';
import { wireState } from './hunt-fakes';

function state(nowMs: number): PublicStateWire {
  return wireState(nowMs);
}

function event(seq: number, at: number): DomainEventWire {
  return {
    seq,
    at,
    encounter: 1,
    kind: 'regen',
    actorId: 'p0',
    targetId: null,
    amount: 1,
    reason: 'hp',
    position: null,
  };
}

interface FrameShape {
  generation: number;
  firstSeq: number;
  lastSeq: number;
  /** Released clock of the frame; defaults to the last event's `at`. */
  nowMs?: number;
  /** Event timestamps; defaults to 1000 ms per seq. */
  at?: (seq: number) => number;
  events?: DomainEventWire[];
}

function frame(shape: FrameShape) {
  const at = shape.at ?? ((seq: number) => seq * 1000);
  const events =
    shape.events ??
    Array.from({ length: shape.lastSeq - shape.firstSeq + 1 }, (_, index) => event(shape.firstSeq + index, at(shape.firstSeq + index)));
  const nowMs = shape.nowMs ?? Math.max(0, ...events.map((item) => item.at));
  return {
    type: 'frame' as const,
    generation: shape.generation,
    firstSeq: shape.firstSeq,
    lastSeq: shape.lastSeq,
    events,
    state: state(nowMs),
  };
}

function snapshot(generation: number, seq: number, nowMs: number) {
  return { type: 'snapshot' as const, generation, seq, state: state(nowMs) };
}

/** A live generation-7 view: snapshotted at sim 0, so seq 1 is the next expected. */
const view: PlaybackView = reduce(initialView(0), snapshot(7, 1, 0), 0).view;

describe('render horizon (rule 1, B-03)', () => {
  test('an event with at > horizon is retained but never exposed to the view model', () => {
    // horizon(now = 1000) = 0 + 1000 - 2000 → 0; the event at 3000 is not yet due.
    const next = reduce(view, frame({ generation: 7, firstSeq: 1, lastSeq: 1, at: () => 3000 }), 1000);
    expect(horizon(next.view.clock, 1000)).toBe(0);
    expect(next.view.events).toEqual([]);
    expect(next.view.queue.map((item) => item.seq)).toEqual([1]);

    // Still held one millisecond before it is due…
    const early = reduce(next.view, { type: 'tick' }, 4999);
    expect(early.view.events).toEqual([]);
    // …and exposed exactly when the horizon reaches it.
    const due = reduce(early.view, { type: 'tick' }, 5000);
    expect(due.view.events.map((item) => item.seq)).toEqual([1]);
    expect(due.view.queue).toEqual([]);
  });

  test('the state shown is never ahead of the horizon either', () => {
    const next = reduce(view, frame({ generation: 7, firstSeq: 1, lastSeq: 1, at: () => 3000 }), 1000);
    expect(next.view.state?.nowMs).toBe(0);
    expect(reduce(next.view, { type: 'tick' }, 5000).view.state?.nowMs).toBe(3000);
  });
});

describe('generations (rule 3, B-05)', () => {
  test('a frame below the highest observed generation changes nothing at all', () => {
    const stale = reduce(view, frame({ generation: 6, firstSeq: 1, lastSeq: 3 }), 1000);
    expect(stale.view).toBe(view);
    expect(stale.effects).toEqual([]);
  });

  test('a snapshot or report below the highest observed generation changes nothing either', () => {
    expect(reduce(view, snapshot(6, 1, 9000), 1000).view).toBe(view);
    expect(reduce(view, { type: 'report', generation: 6, reportId: crypto.randomUUID() }, 1000).view).toBe(view);
  });

  test('a newer generation resynchronises and never splices onto the old history', () => {
    const live = reduce(view, frame({ generation: 7, firstSeq: 1, lastSeq: 3 }), 1000).view;
    const next = reduce(live, frame({ generation: 8, firstSeq: 9, lastSeq: 9 }), 1100);
    expect(next.view.status).toBe('resyncing');
    expect(next.view.events).toEqual([]);
    expect(next.view.queue).toEqual([]);
    expect(next.effects).toEqual([{ kind: 'request-snapshot', generation: 8 }]);
  });

  test('frames of the new generation are not applied until its snapshot arrives', () => {
    const resyncing = reduce(view, frame({ generation: 8, firstSeq: 9, lastSeq: 9 }), 1100).view;
    const more = reduce(resyncing, frame({ generation: 8, firstSeq: 10, lastSeq: 10 }), 1200);
    expect(more.view).toBe(resyncing);
    const snapped = reduce(resyncing, snapshot(8, 11, 20_000), 1300).view;
    expect(snapped.status).toBe('live');
    expect(snapped.generation).toBe(8);
    expect(snapped.lastSeq).toBe(10);
  });
});

describe('sequence gaps (rule 4, B-06)', () => {
  test('a non-contiguous seq requests a snapshot and invents no event', () => {
    const live = reduce(view, frame({ generation: 7, firstSeq: 1, lastSeq: 2, at: () => 0 }), 3000).view;
    expect(live.events.map((item) => item.seq)).toEqual([1, 2]);

    const gap = reduce(live, frame({ generation: 7, firstSeq: 5, lastSeq: 5, at: () => 0 }), 3000);
    expect(gap.effects).toEqual([{ kind: 'request-snapshot', generation: 7 }]);
    expect(gap.view.status).toBe('resyncing');
    // Nothing guessed, nothing renumbered: the history is exactly what arrived.
    expect(gap.view.events).toBe(live.events);
    expect(gap.view.queue).toEqual([]);
    expect(gap.view.lastSeq).toBe(2);
  });

  test('a contiguous frame is acknowledged up to its last seq', () => {
    const next = reduce(view, frame({ generation: 7, firstSeq: 1, lastSeq: 3 }), 1000);
    expect(next.effects).toEqual([{ kind: 'ack', generation: 7, seq: 3 }]);
    expect(next.view.lastSeq).toBe(3);
  });
});

describe('resynchronisation (rule 5, B-07)', () => {
  test('a snapshot replaces state wholesale, re-anchors the clock and clears events', () => {
    const live = reduce(view, frame({ generation: 7, firstSeq: 1, lastSeq: 2, at: () => 0 }), 3000).view;
    expect(live.events).toHaveLength(2);

    const next = reduce(live, snapshot(7, 3, 42_000), 50_000).view;
    expect(next.state).toEqual(state(42_000));
    expect(next.releasedUntilMs).toBe(42_000);
    expect(next.clock.simAnchorMs).toBe(42_000);
    expect(next.clock.realAnchorMs).toBe(50_000);
    expect(next.clock.paused).toBe(false);
    expect(next.events).toEqual([]);
    expect(next.queue).toEqual([]);
    expect(next.lastSeq).toBe(2);
    // The buffer is subtracted once, by `horizon`, not by the re-anchor.
    expect(horizon(next.clock, 50_000)).toBe(40_000);
  });
});

describe('never future (rule 2, B-08 client half)', () => {
  test('a payload carrying a seed raises PROTOCOL instead of being dropped', () => {
    const smuggled = { ...snapshot(7, 1, 0), state: { ...state(0), seed: 12345 } };
    const next = reduce(view, smuggled, 1000).view;
    expect(next.status).toBe('error');
    expect(next.error).toEqual({ code: 'PROTOCOL', field: 'state.seed' });
  });

  test('a payload carrying an rng field raises PROTOCOL instead of being dropped', () => {
    const base = frame({ generation: 7, firstSeq: 1, lastSeq: 1 });
    const smuggled = { ...base, rng: [1, 2, 3, 4] };
    const next = reduce(view, smuggled, 1000).view;
    expect(next.error).toEqual({ code: 'PROTOCOL', field: 'rng' });
    expect(next.events).toEqual([]);
  });

  test('an event stamped after the released clock raises PROTOCOL instead of being trimmed', () => {
    const future = frame({ generation: 7, firstSeq: 1, lastSeq: 2, at: (seq) => seq * 1000, nowMs: 1000 });
    const next = reduce(view, future, 10_000).view;
    expect(next.status).toBe('error');
    expect(next.error).toEqual({ code: 'PROTOCOL', field: 'events.1.at' });
    // Not "the valid half": nothing from the frame is applied.
    expect(next.events).toEqual([]);
    expect(next.queue).toEqual([]);
  });

  test('an errored view ignores everything after it', () => {
    const errored = reduce(view, { ...snapshot(7, 1, 0), rng: 1 }, 1000).view;
    expect(reduce(errored, frame({ generation: 7, firstSeq: 1, lastSeq: 1 }), 2000).view).toBe(errored);
  });
});

describe('identity (R109, R167, B-23 client half)', () => {
  test('a frame with an empty events array returns the same events reference', () => {
    const live = reduce(view, frame({ generation: 7, firstSeq: 1, lastSeq: 2, at: () => 0 }), 3000).view;
    const empty = { type: 'frame' as const, generation: 7, firstSeq: 3, lastSeq: 2, events: [], state: state(500) };
    const next = reduce(live, empty, 3100);
    expect(next.view.events).toBe(live.events);
    expect(next.effects).toEqual([]);
  });

  test('a render tick that exposes nothing returns the same view', () => {
    const live = reduce(view, frame({ generation: 7, firstSeq: 1, lastSeq: 1, at: () => 9000 }), 1000).view;
    expect(reduce(live, { type: 'tick' }, 1500).view).toBe(live);
  });
});

describe('starvation (rule 7)', () => {
  test('a horizon overrun yields buffering, holds the last frame and extrapolates nothing', () => {
    const live = reduce(view, frame({ generation: 7, firstSeq: 1, lastSeq: 1, at: () => 1000 }), 0).view;
    // horizon(now = 5000) = 3000 > released 1000: the release edge is overrun.
    const starved = reduce(live, { type: 'tick' }, 5000).view;
    expect(starved.status).toBe('buffering');
    expect(starved.state?.nowMs).toBe(1000);
    expect(starved.events.map((item) => item.seq)).toEqual([1]);
    // Held at the edge: later instants show nothing newer and no later time.
    expect(horizon(starved.clock, 60_000)).toBe(1000);
    expect(reduce(starved, { type: 'tick' }, 60_000).view).toBe(starved);

    // Fresh released content resumes playback from the edge, not from wall time.
    const fed = reduce(starved, frame({ generation: 7, firstSeq: 2, lastSeq: 2, at: () => 1500 }), 61_000).view;
    expect(fed.status).toBe('live');
    expect(horizon(fed.clock, 61_000)).toBe(1000);
    expect(fed.events.map((item) => item.seq)).toEqual([1]);
    expect(reduce(fed, { type: 'tick' }, 61_500).view.events.map((item) => item.seq)).toEqual([1, 2]);
  });

  test('a dropped socket keeps the last frame and accrues nothing', () => {
    const live = reduce(view, frame({ generation: 7, firstSeq: 1, lastSeq: 1, at: () => 0 }), 3000).view;
    const dropped = reduce(live, { type: 'disconnected' }, 4000).view;
    expect(dropped.status).toBe('disconnected');
    expect(dropped.state).toBe(live.state);
    expect(dropped.events).toBe(live.events);
  });

  test('a terminal close is `closed` with its code, keeps the last frame, and nothing reopens it (R179)', () => {
    const live = reduce(view, frame({ generation: 7, firstSeq: 1, lastSeq: 1, at: () => 0 }), 3000).view;
    const closed = reduce(live, { type: 'closed', code: 'UNAUTHENTICATED' }, 4000).view;
    expect(closed.status).toBe('closed');
    expect(closed.error).toEqual({ code: 'UNAUTHENTICATED', field: 'socket' });
    expect(closed.state).toBe(live.state);
    expect(reduce(closed, { type: 'disconnected' }, 5000).view).toBe(closed);
    expect(reduce(closed, frame({ generation: 7, firstSeq: 2, lastSeq: 2, at: () => 1000 }), 5000).view).toBe(closed);
  });
});

describe('the bounded history', () => {
  test('keeps the newest 500 rows', () => {
    const many = frame({ generation: 7, firstSeq: 1, lastSeq: 600, at: () => 0 });
    const next = reduce(view, many, 2000).view;
    expect(next.events).toHaveLength(500);
    expect(next.events[0]?.seq).toBe(101);
    expect(next.events.at(-1)?.seq).toBe(600);
  });
});
