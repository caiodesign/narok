import { expect, test } from 'vitest';
import { compareScheduled, isStale, schedule, takeNext } from '../src/scheduler';
import { startState } from '../src/state';
import { SimError } from '../src/errors';
import { content } from '@narok/data';
import { createGrid } from '../src/battlefield/grid';
import { fightFixture, labInput } from './fixtures';
import type { ScheduledEvent } from '../src/types';

function expectSimError(action: () => void): SimError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SimError);
    return error as SimError;
  }
  throw new Error('expected action to throw a SimError');
}

test('expiry precedes resolve regardless of actor ID', () => {
  const base = { at: 1000, epoch: 1, token: null, seq: 1 };
  expect(compareScheduled(
    { ...base, kind: 'expire', actorId: 'z' },
    { ...base, kind: 'resolve', actorId: 'a' },
  )).toBeLessThan(0);
});

test('priority order matches the fixed table regardless of actor id or seq', () => {
  const kinds: ScheduledEvent['kind'][] = ['expire', 'regen', 'resolve', 'act', 'deadline', 'transition'];
  for (let i = 0; i < kinds.length - 1; i++) {
    const earlier: ScheduledEvent = { at: 500, kind: kinds[i], actorId: 'zzz', seq: 999, epoch: null, token: null };
    const later: ScheduledEvent = { at: 500, kind: kinds[i + 1], actorId: 'aaa', seq: 0, epoch: null, token: null };
    expect(compareScheduled(earlier, later)).toBeLessThan(0);
  }
});

test('same time and kind break ties by ASCII actor id, never localeCompare', () => {
  const a: ScheduledEvent = { at: 1000, kind: 'act', actorId: 'B', seq: 5, epoch: 0, token: 0 };
  const b: ScheduledEvent = { at: 1000, kind: 'act', actorId: 'a', seq: 0, epoch: 0, token: 0 };
  // ASCII 'B' (66) sorts before 'a' (97); localeCompare disagrees, proving we don't use it.
  expect(compareScheduled(a, b)).toBeLessThan(0);
  expect('B'.localeCompare('a')).toBeGreaterThan(0);
});

test('identical time/kind/actor break ties by seq', () => {
  const a: ScheduledEvent = { at: 1000, kind: 'act', actorId: 'p0', seq: 1, epoch: 0, token: 0 };
  const b: ScheduledEvent = { at: 1000, kind: 'act', actorId: 'p0', seq: 2, epoch: 0, token: 0 };
  expect(compareScheduled(a, b)).toBeLessThan(0);
});

test('schedule assigns increasing sequence numbers starting at zero', () => {
  const grid = createGrid(content.grid);
  const state = startState(content, grid, labInput());
  expect(state.nextQueueSeq).toBe(2); // startState already scheduled transition + regen
  schedule(state, { at: 100_000, kind: 'deadline', actorId: '', epoch: 0, token: null });
  expect(state.nextQueueSeq).toBe(3);
  const inserted = state.queue.find((event) => event.kind === 'deadline');
  expect(inserted?.seq).toBe(2);
});

test('schedule keeps the queue in canonical order after out-of-order inserts', () => {
  const grid = createGrid(content.grid);
  const state = startState(content, grid, labInput());
  schedule(state, { at: 10_000, kind: 'act', actorId: 'p0', epoch: 0, token: 0 });
  schedule(state, { at: 3_000, kind: 'act', actorId: 'p1', epoch: 0, token: 0 });
  schedule(state, { at: 3_000, kind: 'expire', actorId: 'p1', epoch: 0, token: null });
  const sorted = [...state.queue].sort(compareScheduled);
  expect(state.queue).toEqual(sorted);
});

test('schedule rejects an event at or before the current time', () => {
  const grid = createGrid(content.grid);
  const state = startState(content, grid, labInput());
  const error = expectSimError(() =>
    schedule(state, { at: 0, kind: 'act', actorId: 'p0', epoch: 0, token: 0 }));
  expect(error.code).toBe('LOOP_DETECTED');
  const negative = expectSimError(() =>
    schedule(state, { at: -5, kind: 'act', actorId: 'p0', epoch: 0, token: 0 }));
  expect(negative.code).toBe('LOOP_DETECTED');
});

test('takeNext removes and returns the smallest entry, then undefined once empty', () => {
  const grid = createGrid(content.grid);
  const state = startState(content, grid, labInput());
  expect(takeNext(state)?.kind).toBe('transition'); // at 2000, before regen at 5000
  expect(takeNext(state)?.kind).toBe('regen');
  expect(takeNext(state)).toBeUndefined();
});

test('isStale flags a mismatched epoch; null epoch is never stale on that axis', () => {
  const state = fightFixture();
  const event = state.queue.find((e) => e.kind === 'act' && e.actorId === 'p0')!;
  expect(isStale(state, event)).toBe(false);
  expect(isStale(state, { ...event, epoch: state.epoch + 1 })).toBe(true);
  const globalEvent = state.queue.find((e) => e.kind === 'regen')!;
  expect(isStale(state, globalEvent)).toBe(false);
});

test('isStale flags a mismatched or missing actor token; null token is never stale', () => {
  const state = fightFixture();
  const event = state.queue.find((e) => e.kind === 'act' && e.actorId === 'p0')!;
  expect(isStale(state, { ...event, token: (event.token ?? 0) + 1 })).toBe(true);
  expect(isStale(state, { ...event, actorId: 'ghost', token: 0 })).toBe(true);
  const deadline = state.queue.find((e) => e.kind === 'deadline')!;
  expect(isStale(state, deadline)).toBe(false);
});
