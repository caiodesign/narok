/**
 * The anchor arithmetic of milestone B spec part 2 §3, as pure integer
 * millisecond maths.
 *
 * It lives in its own module and its own test because every honest answer
 * about offline accrual is decided here: what the cap covers, what is
 * discarded, and why deferring a reconnection can never convert unattended
 * hours into production.
 */
import { describe, expect, test } from 'vitest';
import {
  OFFLINE_CAP_MS,
  reanchor,
  settlementWindow,
  stopWallInstant,
  type HuntAnchors,
} from '../src/hunt/clock';

const W0 = 1_800_000_000_000;

function anchors(overrides: Partial<HuntAnchors> = {}): HuntAnchors {
  return {
    wallAnchorMs: W0,
    simAnchorMs: 0,
    pausedWallMs: 0,
    lastSeenAt: W0,
    offlineCapMs: OFFLINE_CAP_MS,
    ...overrides,
  };
}

describe('the shared beta cap', () => {
  test('is twelve hours, in milliseconds', () => {
    expect(OFFLINE_CAP_MS).toBe(43_200_000);
    expect(OFFLINE_CAP_MS).toBe(12 * 60 * 60 * 1000);
  });
});

describe('settlementWindow', () => {
  test('an hour away is an hour simulated: under the cap, nothing is lost', () => {
    const window = settlementWindow(anchors(), W0 + 3_600_000);
    expect(window.eligibleCutoffWall).toBe(W0 + 3_600_000);
    expect(window.simTarget).toBe(3_600_000);
    expect(window.cappedBy).toBe('presence');
  });

  test('the worked example of part 2 §3: nineteen hours away credits at most twelve', () => {
    const W1 = W0 + 68_400_000; // 19 h
    const window = settlementWindow(anchors({ simAnchorMs: 5_400_000 }), W1);

    expect(window.capCutoffWall).toBe(W0 + 43_200_000);
    expect(window.eligibleCutoffWall).toBe(W0 + 43_200_000);
    expect(window.simTarget).toBe(48_600_000);
    expect(window.cappedBy, 'the cap, not the clock, ended it').toBe('cap');
    // The seven hours past the cutoff are never simulated, now or later.
    expect(W1 - window.eligibleCutoffWall).toBe(25_200_000);
  });

  test('a paused interval is removed from the simulated target, not from the wall', () => {
    const window = settlementWindow(anchors({ pausedWallMs: 600_000 }), W0 + 3_600_000);
    expect(window.simTarget).toBe(3_600_000 - 600_000);
  });

  test('time already simulated is the floor: the target moves forward, never back', () => {
    const window = settlementWindow(anchors({ simAnchorMs: 90_000 }), W0 + 60_000);
    expect(window.simTarget).toBe(150_000);
  });

  test('a duplicate settlement credits nothing rather than double-crediting', () => {
    // Re-anchored at W1, a second settlement at the same instant asks the
    // engine to advance to exactly where it already is, which is a legal no-op.
    const W1 = W0 + 3_600_000;
    const settled = reanchor(anchors(), W1, 3_600_000);
    const again = settlementWindow(settled, W1);
    expect(again.simTarget).toBe(3_600_000);
    expect(again.simTarget - settled.simAnchorMs).toBe(0);
  });

  test('a clock that went backwards never asks the engine to rewind', () => {
    // Wall clocks move. The engine treats a rewind as an invariant error, so the
    // window clamps instead of handing it one (contracts §3 TIME_REWIND).
    const window = settlementWindow(anchors({ simAnchorMs: 60_000 }), W0 - 5_000);
    expect(window.simTarget).toBe(60_000);
    expect(window.creditableMs).toBe(0);
  });

  test('presence exactly at the cap cutoff is covered, not truncated', () => {
    const window = settlementWindow(anchors(), W0 + OFFLINE_CAP_MS);
    expect(window.simTarget).toBe(OFFLINE_CAP_MS);
    expect(window.cappedBy).toBe('presence');
  });
});

describe('reanchor', () => {
  test('re-anchors to now, which is what makes uncovered time unrecoverable', () => {
    const W1 = W0 + 68_400_000;
    // The engine stopped early, at 40,600,000 of simulated time.
    const after = reanchor(anchors(), W1, 40_600_000);

    expect(after.lastSeenAt, 'presence is now, not the cutoff').toBe(W1);
    expect(after.wallAnchorMs).toBe(W1);
    expect(after.simAnchorMs).toBe(40_600_000);
    expect(after.pausedWallMs, 'the paused total is consumed by the re-anchor').toBe(0);
  });

  test('no residual is stored, so a later settlement has nothing to redeem', () => {
    const W1 = W0 + 68_400_000;
    const after = reanchor(anchors(), W1, 40_600_000);
    const next = settlementWindow(after, W1 + 1_000);
    expect(next.simTarget - after.simAnchorMs, 'only the new second is creditable').toBe(1_000);
  });

  test('a paused interval does not survive its own re-anchor', () => {
    const after = reanchor(anchors({ pausedWallMs: 900_000 }), W0 + 3_600_000, 2_700_000);
    expect(after.pausedWallMs).toBe(0);
  });
});

describe('stopWallInstant', () => {
  test('is computed with the pre-settlement anchors', () => {
    const before = anchors({ simAnchorMs: 5_400_000 });
    // The engine stopped at 46,000,000 of simulated time.
    expect(stopWallInstant(before, 46_000_000)).toBe(W0 + 40_600_000);
  });

  test('a paused interval pushes the wall instant later, not the simulated one', () => {
    const before = anchors({ pausedWallMs: 300_000 });
    expect(stopWallInstant(before, 60_000)).toBe(W0 + 60_000 + 300_000);
  });
});

describe('what the cap is and is not', () => {
  test('a maintained connection never engages it: each heartbeat re-anchors', () => {
    let current = anchors();
    for (let tick = 1; tick <= 40; tick++) {
      const at = W0 + tick * 30_000;
      const window = settlementWindow(current, at);
      expect(window.cappedBy, `heartbeat ${tick}`).toBe('presence');
      current = reanchor(current, at, window.simTarget);
    }
    // Twenty minutes of heartbeats, all of it credited.
    expect(current.simAnchorMs).toBe(40 * 30_000);
  });

  test('reaching the cap is not a stop: it bounds accrual and says nothing about the hunt', () => {
    const window = settlementWindow(anchors(), W0 + 68_400_000);
    expect(window.cappedBy).toBe('cap');
    expect(window).not.toHaveProperty('stopReason');
  });
});
