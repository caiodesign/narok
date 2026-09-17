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

test('decodeSnapshot rejects a queue array that is not in canonical scheduled order', () => {
  const text = mutate(fightFixture(), (raw) => {
    const queue = raw.queue as Record<string, unknown>[];
    // fightFixture's canonical order sorts act entries by actorId ascending, so
    // swapping the first two (e0, e1) puts a larger actorId before a smaller one.
    [queue[0], queue[1]] = [queue[1], queue[0]];
  });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_STATE');
  expect(error.field).toBe('queue.1');
});

test('decodeSnapshot rejects a queue entry whose seq is not less than nextQueueSeq', () => {
  const text = mutate(fightFixture(), (raw) => {
    const queue = raw.queue as Record<string, unknown>[];
    queue[0].seq = raw.nextQueueSeq;
  });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_STATE');
  expect(error.field).toBe('queue.0.seq');
});

test('decodeSnapshot rejects duplicate seq values in the queue', () => {
  const text = mutate(fightFixture(), (raw) => {
    const queue = raw.queue as Record<string, unknown>[];
    queue[1].seq = queue[0].seq;
  });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_STATE');
  expect(error.field).toBe('queue.1.seq');
});

test('decodeSnapshot rejects "__proto__" as a queue actorId', () => {
  const text = mutate(fightFixture(), (raw) => {
    const queue = raw.queue as Record<string, unknown>[];
    queue[0].actorId = '__proto__';
  });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_STATE');
  expect(error.field).toBe('queue.0.actorId');
});

test('decodeSnapshot rejects "__proto__" as an actor currentTarget', () => {
  const text = mutate(fightFixture(), (raw) => {
    const actors = raw.actors as Record<string, Record<string, unknown>>;
    actors.p0.currentTarget = '__proto__';
  });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_STATE');
  expect(error.field).toBe('actors.p0.currentTarget');
});

test('decodeSnapshot rejects "__proto__" as a threat key', () => {
  const text = mutate(fightFixture(), (raw) => {
    const actors = raw.actors as Record<string, Record<string, unknown>>;
    // Built via JSON.parse (not an object literal) so "__proto__" lands as a
    // genuine own enumerable property, matching what a crafted snapshot's JSON
    // parse would produce — an object literal's `{ __proto__: 5 }` would instead
    // set the prototype (or, for a non-object value, silently do nothing).
    actors.p0.threat = JSON.parse('{"__proto__": 5}');
  });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_STATE');
  expect(error.field).toBe('actors.p0.threat.__proto__');
});

test('decodeSnapshot rejects "__proto__" as an actors record key', () => {
  const text = mutate(fightFixture(), (raw) => {
    const actors = raw.actors as Record<string, Record<string, unknown>>;
    const proto = { ...actors.p0, id: '__proto__' };
    // `actors.__proto__ = proto` (and an object-literal `{ __proto__: proto }`)
    // would set the object's prototype instead of creating an own property —
    // Object.defineProperty bypasses that special-casing, matching what
    // JSON.parse produces for a literal `"__proto__"` key in crafted text.
    Object.defineProperty(actors, '__proto__', { value: proto, enumerable: true, configurable: true, writable: true });
  });
  const error = expectSimError(() => decodeSnapshot(text, content, createGrid(content.grid)));
  expect(error.code).toBe('INVALID_STATE');
  expect(error.field).toBe('actors.__proto__');
});
