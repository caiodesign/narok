import { expect, test } from 'vitest';
import { nextU32, drawBelow } from '../src/rng';

test('xorshift32 has stable vectors and rejects zero', () => {
  let state = 1;
  const values: number[] = [];
  for (let i = 0; i < 3; i++) {
    const next = nextU32(state);
    state = next.state;
    values.push(next.value);
  }
  expect(values).toEqual([270369, 67634689, 2647435461]);
  expect(() => nextU32(0)).toThrow();
  expect(drawBelow(1, 1).value).toBe(0);
});
