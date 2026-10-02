/**
 * The settlement digest (Task 10 fix round 1; part 4 §3.5; rulings R191,
 * R192): per-member deaths and revives, and a bounded chronological timeline,
 * folded only from the events the engine emitted.
 */
import { describe, expect, test } from 'vitest';
import type { DomainEvent } from '@narok/sim';
import { DigestFolder, mergeDigests, TIMELINE_LIMIT, type HuntDigest } from '../src/hunt/digest';
import { runSegment } from '../src/workers/segment';
import { sim, startState } from './hunt-fixtures';

const PARTY = new Set(['p0', 'p1', 'p2']);

function event(kind: DomainEvent['kind'], at: number, extra: Partial<DomainEvent> = {}): DomainEvent {
  return { seq: at, at, encounter: 0, kind, actorId: null, targetId: null, amount: null, reason: null, position: null, ...extra };
}

function fold(events: DomainEvent[]): HuntDigest {
  const folder = new DigestFolder(PARTY);
  folder.fold(events);
  return folder.result();
}

describe('per-member deaths and revives', () => {
  test('counts party deaths per member and ignores enemy deaths (kills)', () => {
    const digest = fold([
      event('death', 1, { actorId: 'e7' }),
      event('death', 2, { actorId: 'p1' }),
      event('revive', 3, { actorId: 'p1', reason: 'idun-apple' }),
      event('death', 4, { actorId: 'p1' }),
      event('death', 5, { actorId: 'p2' }),
    ]);
    expect(digest.deaths).toEqual({ p1: 2, p2: 1 });
    expect(digest.revives).toEqual({ p1: 1 });
  });
});

describe('the timeline (R191)', () => {
  test('is chronological; runs of wins and of lost drops fold into one entry that a course event closes', () => {
    const digest = fold([
      event('win', 10),
      event('win', 20),
      event('drop-lost', 21),
      event('win', 30),
      event('drop-lost', 31),
      event('death', 40, { actorId: 'p0' }),
      event('win', 50),
      event('wipe', 60),
      event('stop', 60, { reason: 'wipe' }),
    ]);
    expect(digest.entries).toEqual([
      { kind: 'won', atSimMs: 10, actorId: null, count: 3, reason: null },
      { kind: 'drop-lost', atSimMs: 21, actorId: null, count: 2, reason: null },
      { kind: 'death', atSimMs: 40, actorId: 'p0', count: 1, reason: null },
      { kind: 'won', atSimMs: 50, actorId: null, count: 1, reason: null },
      { kind: 'wipe', atSimMs: 60, actorId: null, count: 1, reason: null },
      { kind: 'stop', atSimMs: 60, actorId: null, count: 1, reason: 'wipe' },
    ]);
    expect(digest.omitted).toBe(0);
  });

  test('keeps at most the limit, the most recent ones, and counts what it let go', () => {
    const events = Array.from({ length: TIMELINE_LIMIT + 4 }, (_, index) => event('death', index * 10, { actorId: 'p0' }));
    const digest = fold(events);
    expect(digest.entries).toHaveLength(TIMELINE_LIMIT);
    expect(digest.omitted).toBe(4);
    expect(digest.entries[0]!.atSimMs).toBe(40);
    // The counts are never bounded: every death is a death.
    expect(digest.deaths).toEqual({ p0: TIMELINE_LIMIT + 4 });
  });

  test('records nothing the engine did not emit', () => {
    expect(fold([event('damage', 1, { actorId: 'p0' }), event('move', 2)])).toEqual({ deaths: {}, revives: {}, entries: [], omitted: 0 });
  });

  test('two rounds merge in order, within the bound', () => {
    const first = fold(Array.from({ length: TIMELINE_LIMIT }, (_, index) => event('death', index, { actorId: 'p0' })));
    const second = fold([event('death', 100, { actorId: 'p2' }), event('stop', 101, { reason: 'wipe' })]);
    const merged = mergeDigests(first, second);
    expect(merged.entries).toHaveLength(TIMELINE_LIMIT);
    expect(merged.entries.at(-1)).toMatchObject({ kind: 'stop', reason: 'wipe' });
    expect(merged.omitted).toBe(2);
    expect(merged.deaths).toEqual({ p0: TIMELINE_LIMIT, p2: 1 });
  });
});

describe('a digest changes nothing the settlement commits (R192)', () => {
  test('summary with a digest: the same state and rewards, no events returned, and the digest filled', () => {
    const encodedState = sim.encode(startState({ rest: { hpStart: 0, mpStart: 0 } }));
    const request = { encodedState, simTarget: 600_000, collect: 'summary' as const };
    const plain = runSegment(sim, request);
    const digested = runSegment(sim, { ...request, digest: true });
    expect(digested.encodedState).toBe(plain.encodedState);
    expect(digested.rewards).toEqual(plain.rewards);
    expect(digested.events).toEqual([]);
    expect(plain.digest).toBeNull();
    expect(digested.digest!.entries.length).toBeGreaterThan(0);
    // It agrees with the events an events-mode run of the same window emits.
    const watched = runSegment(sim, { ...request, collect: 'events' });
    const folder = new DigestFolder(new Set(['p0', 'p1', 'p2']));
    folder.fold(watched.events);
    expect(digested.digest).toEqual(folder.result());
  });
});
