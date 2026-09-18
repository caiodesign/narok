import { expect, test } from 'vitest';
import { horizon, reanchor, type PlaybackClock } from '../src/clock';

test('paused real time does not advance the laboratory', () => {
  const clock: PlaybackClock = {
    realAnchorMs: 0,
    simAnchorMs: 0,
    speed: 1,
    paused: false,
    bufferMs: 2000,
  };
  expect(horizon(clock, 5000)).toBe(3000);
  const paused = reanchor(clock, 5000, { paused: true });
  expect(horizon(paused, 15000)).toBe(3000);
  const resumed = reanchor(paused, 15000, { paused: false });
  expect(horizon(resumed, 16000)).toBe(4000);
});

test('a speed change settles the prior anchor before the new speed applies', () => {
  const clock: PlaybackClock = {
    realAnchorMs: 0,
    simAnchorMs: 0,
    speed: 1,
    paused: false,
    bufferMs: 2000,
  };
  // At real 4000ms/speed 1, unbuffered sim time is 4000ms -> horizon 2000ms.
  expect(horizon(clock, 4000)).toBe(2000);

  const faster = reanchor(clock, 4000, { speed: 4 });
  // Settling at the moment of the change must not jump the horizon.
  expect(horizon(faster, 4000)).toBe(2000);

  // 500ms of real time at the new 4x speed adds 2000ms of unbuffered sim time.
  expect(horizon(faster, 4500)).toBe(4000);
});

test('horizon floors fractional milliseconds and clamps at zero', () => {
  const clock: PlaybackClock = {
    realAnchorMs: 0,
    simAnchorMs: 0,
    speed: 1,
    paused: false,
    bufferMs: 2000,
  };
  // 5000.7ms elapsed - 2000ms buffer = 3000.7ms, floored to 3000ms.
  expect(horizon(clock, 5000.7)).toBe(3000);

  // Elapsed time below the buffer must clamp to 0, never go negative.
  expect(horizon(clock, 500)).toBe(0);
  expect(horizon(clock, 0)).toBe(0);

  // A real time before the anchor must not produce negative elapsed time.
  expect(horizon(clock, -1000)).toBe(0);
});

test('reanchor at a lower speed while paused does not accumulate simAnchor drift', () => {
  const clock: PlaybackClock = {
    realAnchorMs: 1000,
    simAnchorMs: 5000,
    speed: 4,
    paused: true,
    bufferMs: 2000,
  };
  const changed = reanchor(clock, 9000, { speed: 1 });
  expect(changed.simAnchorMs).toBe(5000);
  expect(changed.realAnchorMs).toBe(9000);
  expect(changed.paused).toBe(true);
  expect(horizon(changed, 9000)).toBe(3000);
});
