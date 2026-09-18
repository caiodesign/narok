/**
 * Pure playback clock for the laboratory (ruling R53). Maps real elapsed playback
 * time to a nondecreasing, buffered simulation-time horizon. No React import, no
 * DOM access, no timers — every millisecond value is supplied by the caller.
 *
 * `simAnchorMs` is UNBUFFERED simulation time: the buffer is subtracted exactly
 * once, inside `horizon`. Pausing and speed changes settle the current anchor at
 * that unbuffered value before applying the change, so the buffer is never
 * subtracted twice.
 */
export interface PlaybackClock {
  /** `now()` reading (e.g. `performance.now()`) the anchor was taken at. */
  realAnchorMs: number;
  /** Unbuffered simulation time at the anchor. */
  simAnchorMs: number;
  /** Playback speed multiplier: 1, 4, or 16. */
  speed: number;
  paused: boolean;
  /** Constant simulation-ms playback buffer (2,000 for every speed). */
  bufferMs: number;
}

/**
 * The buffered, nonnegative simulation-time horizon at `realNowMs`. Floors to an
 * integer millisecond and clamps at 0.
 */
export function horizon(clock: PlaybackClock, realNowMs: number): number {
  const delta = clock.paused ? 0 : Math.max(0, realNowMs - clock.realAnchorMs) * clock.speed;
  return Math.max(0, Math.floor(clock.simAnchorMs + delta - clock.bufferMs));
}

/**
 * Settles the clock's unbuffered anchor at `now`, then applies `changes` (pause
 * toggle and/or speed change). Settling first means a paused clock's horizon does
 * not move, and a speed change takes effect only for elapsed time after `now`.
 */
export function reanchor(
  clock: PlaybackClock,
  now: number,
  changes: Partial<Pick<PlaybackClock, 'paused' | 'speed'>>,
): PlaybackClock {
  const delta = clock.paused ? 0 : Math.max(0, now - clock.realAnchorMs) * clock.speed;
  return {
    ...clock,
    simAnchorMs: clock.simAnchorMs + delta,
    realAnchorMs: now,
    ...changes,
  };
}
