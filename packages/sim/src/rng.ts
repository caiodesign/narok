/**
 * Deterministic xorshift32 PRNG. Seed 1 must yield 270369, then 67634689, then
 * 2647435461 (the required RNG vector from the simulation contract). No
 * cryptographic guarantee is claimed.
 */
export function nextU32(state: number): { state: number; value: number } {
  if (!Number.isInteger(state) || state < 1 || state > 0xffffffff) {
    throw new RangeError('nonzero uint32 seed required');
  }
  let x = state;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  const value = x >>> 0;
  return { state: value, value };
}

/**
 * Draws an integer in `[0, max)` using rejection sampling so every output is
 * uniformly distributed regardless of `max`.
 */
export function drawBelow(state: number, max: number): { state: number; value: number } {
  if (!Number.isInteger(max) || max < 1 || max > 1_000_000) {
    throw new RangeError('invalid draw bound');
  }
  const limit = Math.floor(0x100000000 / max) * max;
  let next = nextU32(state);
  while (next.value >= limit) next = nextU32(next.state);
  return { state: next.state, value: next.value % max };
}
