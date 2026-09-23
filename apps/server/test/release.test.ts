/**
 * Gate B-08 and B-L06: no future outcome reaches a client.
 *
 * The server runs ahead on purpose. These tests are what stop that from
 * becoming a leak — every released event has elapsed, the order is `(at, seq)`,
 * and a violation is raised rather than trimmed away.
 */
import { describe, expect, test } from 'vitest';
import type { DomainEventWire } from '@narok/protocol';
import { assertReleasable, ProtocolViolation, release, releasePoint } from '../src/hunt/release';

function event(seq: number, at: number, kind = 'damage'): DomainEventWire {
  return { seq, at, encounter: 1, kind, actorId: 'p0', targetId: 'e0', amount: 5, reason: null, position: null };
}

const START: { lastSeq: number; releasedSimMs: number } = { lastSeq: -1, releasedSimMs: 0 };

describe('an event is released only once its instant has elapsed', () => {
  test('the server may hold a batch that runs past the release point', () => {
    const batch = [event(0, 1_000), event(1, 2_000), event(2, 3_000), event(3, 4_000)];
    const result = release(batch, 2_000, START);

    expect(result.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(result.withheld, 'the future stayed on the server').toBe(2);
  });

  test('the withheld events are released later, unchanged', () => {
    const batch = [event(0, 1_000), event(1, 2_000), event(2, 3_000)];
    const first = release(batch, 2_000, START);
    const second = release(batch, 5_000, first.cursor);

    expect(first.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(second.events.map((e) => e.seq)).toEqual([2]);
    expect(second.events[0]).toEqual(event(2, 3_000));
  });

  test('an event exactly at the release point has elapsed', () => {
    const result = release([event(0, 2_000)], 2_000, START);
    expect(result.events).toHaveLength(1);
  });

  test('the filter reads the timestamp, never the batch it arrived in', () => {
    // One batch carrying an old event and a future one: the old one goes, the
    // future one waits, however they were grouped.
    const result = release([event(5, 9_000), event(4, 500)], 1_000, { lastSeq: 3, releasedSimMs: 0 });
    expect(result.events.map((e) => e.seq)).toEqual([4]);
    expect(result.withheld).toBe(1);
  });
});

describe('order is (at, seq), not arrival', () => {
  test('a shuffled batch is released in simulated order', () => {
    const batch = [event(2, 3_000), event(0, 1_000), event(1, 1_000)];
    const result = release(batch, 5_000, START);
    expect(result.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  test('two events at the same instant keep their sequence order', () => {
    const result = release([event(7, 4_000), event(6, 4_000)], 5_000, { lastSeq: 5, releasedSimMs: 0 });
    expect(result.events.map((e) => e.seq)).toEqual([6, 7]);
  });
});

describe('the cursor', () => {
  test('already-released events are skipped without complaint, so a reconnect can replay a batch', () => {
    const batch = [event(0, 1_000), event(1, 2_000), event(2, 3_000)];
    const first = release(batch, 5_000, START);
    const again = release(batch, 5_000, first.cursor);

    expect(first.events).toHaveLength(3);
    expect(again.events, 'nothing is sent twice').toHaveLength(0);
    expect(again.cursor.lastSeq).toBe(2);
  });

  test('never moves backwards', () => {
    const result = release([], 1_000, { lastSeq: 9, releasedSimMs: 8_000 });
    expect(result.cursor.lastSeq).toBe(9);
    expect(result.cursor.releasedSimMs).toBe(8_000);
  });
});

describe('P-16: a violation is raised, never trimmed', () => {
  test('a duplicate sequence inside one batch is a protocol error', () => {
    const batch = [event(4, 1_000), event(4, 1_500)];
    expect(() => release(batch, 5_000, { lastSeq: 3, releasedSimMs: 0 })).toThrowError(ProtocolViolation);
  });

  test('assertReleasable refuses a frame carrying an unelapsed event', () => {
    expect(() => assertReleasable([event(0, 5_000)], 1_000, -1)).toThrowError(ProtocolViolation);
    try {
      assertReleasable([event(0, 5_000)], 1_000, -1);
    } catch (error) {
      expect((error as ProtocolViolation).field).toBe('at');
    }
  });

  test('assertReleasable refuses a frame whose sequence goes backwards', () => {
    expect(() => assertReleasable([event(3, 100), event(2, 200)], 1_000, -1)).toThrowError(ProtocolViolation);
  });

  test('assertReleasable refuses a frame that repeats what was already sent', () => {
    expect(() => assertReleasable([event(5, 100)], 1_000, 5)).toThrowError(ProtocolViolation);
  });

  test('a legal frame passes', () => {
    expect(() => assertReleasable([event(6, 100), event(7, 200)], 1_000, 5)).not.toThrow();
  });
});

describe('the playback buffer belongs to the client', () => {
  test('the server releases what has elapsed and subtracts nothing', () => {
    // Subtracting the buffer here would hide elapsed events from a client that
    // asked honestly; the client renders behind the release point instead.
    expect(releasePoint(10_000)).toBe(10_000);
  });

  test('a request for a later window cannot move the release point', () => {
    // The caller passes the authoritative simulated time. Nothing a client
    // sends is an input to this function, which is the point.
    const batch = [event(0, 1_000), event(1, 30_000)];
    const result = release(batch, releasePoint(2_000), START);
    expect(result.events.map((e) => e.seq)).toEqual([0]);
  });
});
