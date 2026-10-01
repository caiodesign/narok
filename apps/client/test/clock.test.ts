import { expect, test } from 'vitest';
import { horizon, reanchor, type PlaybackClock } from '../src/clock';
import { ALLOWED_SPEEDS, PLAYBACK_BUFFER_MS } from '../src/playback';

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

/*
 * B-04 (milestone B Task 9). `clock.ts` is unchanged as a module; what changed is
 * where its anchor comes from: the server's released clock, set by a snapshot
 * (`playback.ts`), never a local start. The buffer is the 2,000 simulation-ms A
 * shipped, and it is subtracted exactly once, by `horizon`, at every speed.
 */

test('B-04: at every allowed speed the horizon trails released time by exactly bufferMs', () => {
  for (const speed of ALLOWED_SPEEDS) {
    const releasedUntilMs = 120_000;
    const clock: PlaybackClock = {
      realAnchorMs: 7_000,
      simAnchorMs: releasedUntilMs,
      speed,
      paused: false,
      bufferMs: PLAYBACK_BUFFER_MS,
    };
    expect(PLAYBACK_BUFFER_MS).toBe(2000);
    expect(horizon(clock, 7_000), `speed ${speed}`).toBe(releasedUntilMs - PLAYBACK_BUFFER_MS);
    // Real time advances the unbuffered anchor at `speed`; the buffer stays one buffer.
    expect(horizon(clock, 7_250), `speed ${speed}`).toBe(releasedUntilMs + 250 * speed - PLAYBACK_BUFFER_MS);
  }
});

test('B-04: a snapshot re-anchor, then a pause and a speed change, never subtracts the buffer twice', () => {
  for (const speed of ALLOWED_SPEEDS) {
    // As playback.ts re-anchors on a snapshot: simAnchorMs = releasedUntilMs, realAnchorMs = now.
    const snapped: PlaybackClock = { realAnchorMs: 50_000, simAnchorMs: 42_000, speed: 1, paused: false, bufferMs: 2000 };
    expect(horizon(snapped, 50_000)).toBe(40_000);

    const paused = reanchor(snapped, 51_000, { paused: true });
    expect(paused.simAnchorMs, 'the anchor stays unbuffered').toBe(43_000);
    expect(horizon(paused, 90_000)).toBe(41_000);

    const faster = reanchor(paused, 90_000, { speed });
    expect(horizon(faster, 90_000)).toBe(41_000);

    const resumed = reanchor(faster, 95_000, { paused: false });
    expect(resumed.simAnchorMs).toBe(43_000);
    expect(horizon(resumed, 95_000)).toBe(41_000);
    expect(horizon(resumed, 96_000)).toBe(41_000 + 1000 * speed);
  }
});
