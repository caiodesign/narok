import { expect, test } from 'vitest';
import { content } from '@narok/data';
import { decodeSnapshot, encodeSnapshot } from '../src/snapshot';
import { createGrid } from '../src/battlefield/grid';
import { startState } from '../src/state';
import { SimError } from '../src/errors';
import { fightFixture, labInput } from './fixtures';
import type { SimState } from '../src/types';

function expectSimError(action: () => void): SimError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SimError);
    return error as SimError;
  }
  throw new Error('expected action to throw a SimError');
}

/** Parses the canonical encoding, mutates the plain object, and re-serializes it. */
function mutate(state: SimState, fn: (raw: Record<string, unknown>) => void): string {
  const raw = JSON.parse(encodeSnapshot(state)) as Record<string, unknown>;
  fn(raw);
  return JSON.stringify(raw);
}

test('snapshot preserves complete state', () => {
  const state = fightFixture();
  expect(decodeSnapshot(encodeSnapshot(state), content, createGrid(content.grid))).toEqual(state);
});

test('snapshot round-trips a fresh walking-phase startState too', () => {
  const grid = createGrid(content.grid);
  const state = startState(content, grid, labInput());
  expect(decodeSnapshot(encodeSnapshot(state), content, grid)).toEqual(state);
});

test('repeated encoding of equal states gives identical text', () => {
  expect(encodeSnapshot(fightFixture())).toBe(encodeSnapshot(fightFixture()));
});

test('canonical JSON sorts object keys by code-unit order regardless of insertion order', () => {
  const state = fightFixture();
  const reordered: SimState = {
    ...state,
    actors: {
      e2: state.actors.e2, e1: state.actors.e1, e0: state.actors.e0,
      p2: state.actors.p2, p1: state.actors.p1, p0: state.actors.p0,
    },
  };
  expect(encodeSnapshot(reordered)).toBe(encodeSnapshot(state));
});

test('encodeSnapshot rejects a non-finite number', () => {
  const state = fightFixture();
  expect(() => encodeSnapshot({ ...state, nowMs: Infinity })).toThrow(SimError);
});

test('decodeSnapshot rejects text over the 1 MiB limit before parsing', () => {
  const text = 'x'.repeat(1_048_577);
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_STATE');
});

test('decodeSnapshot rejects a wrong schemaVersion', () => {
  const text = mutate(fightFixture(), (raw) => { raw.schemaVersion = 2; });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('WRONG_VERSION');
  expect(error.field).toBe('schemaVersion');
});

test('decodeSnapshot rejects a wrong contentVersion', () => {
  const text = mutate(fightFixture(), (raw) => { raw.contentVersion = 'not-the-real-version'; });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('WRONG_VERSION');
});

test('decodeSnapshot rejects a wrong gridHash', () => {
  const text = mutate(fightFixture(), (raw) => { raw.gridHash = 'not-the-real-hash'; });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('WRONG_VERSION');
});

test('decodeSnapshot rejects zero RNG', () => {
  const text = mutate(fightFixture(), (raw) => { raw.rng = 0; });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_STATE');
  expect(error.field).toBe('rng');
});

test('decodeSnapshot rejects negative HP', () => {
  const text = mutate(fightFixture(), (raw) => {
    const actors = raw.actors as Record<string, Record<string, unknown>>;
    actors.p0.hp = -5;
  });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_STATE');
  expect(error.field).toBe('actors.p0.hp');
});

test('decodeSnapshot rejects an unsafe timestamp', () => {
  const text = mutate(fightFixture(), (raw) => { raw.nowMs = Number.MAX_SAFE_INTEGER + 2048; });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('UNSAFE_INTEGER');
  expect(error.field).toBe('nowMs');
});

test('decodeSnapshot rejects duplicate live positions', () => {
  const text = mutate(fightFixture(), (raw) => {
    const actors = raw.actors as Record<string, Record<string, unknown>>;
    actors.e1.position = actors.e0.position;
  });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_STATE');
});

test('decodeSnapshot rejects an invalid rule/class pairing inside the re-validated input', () => {
  const text = mutate(fightFixture(), (raw) => {
    const input = raw.input as Record<string, unknown>;
    const strategies = input.strategies as Record<string, unknown>;
    // p0 is a guardian; the cleric strategy uses heal/smite, which are not its skills.
    strategies.p0 = {
      rules: [
        { skillId: 'heal', enabled: true, condition: { kind: 'ally-hp-below', value: 60 } },
        { skillId: 'smite', enabled: true, condition: { kind: 'always' } },
      ],
      target: { kind: 'lowest-hp' },
    };
  });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_INPUT');
});

test('decodeSnapshot rejects a malformed queue entry', () => {
  const text = mutate(fightFixture(), (raw) => {
    const queue = raw.queue as Record<string, unknown>[];
    queue[0].kind = 'bogus';
  });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_STATE');
  expect(error.field).toBe('queue.0.kind');
});

test('decodeSnapshot rejects a queue entry referencing an unknown actor', () => {
  const text = mutate(fightFixture(), (raw) => {
    const queue = raw.queue as Record<string, unknown>[];
    const act = queue.find((entry) => entry.kind === 'act')!;
    act.actorId = 'ghost';
  });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_STATE');
});

test('decodeSnapshot rejects a second current act entry sharing an actor token', () => {
  const text = mutate(fightFixture(), (raw) => {
    const queue = raw.queue as Record<string, unknown>[];
    const act = queue.find((entry) => entry.kind === 'act' && entry.actorId === 'p0')!;
    queue.push({ ...act, at: (act.at as number) + 10, seq: 999 });
  });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_STATE');
});
