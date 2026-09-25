/**
 * Offline settlement as a pure function (milestone B spec part 2 §3; B-L03,
 * B-L04, B-L05, B-18).
 *
 * `settle(envelope, nowWall, run)` is the quoted arithmetic and nothing else:
 *
 *   capCutoffWall      = previousLastSeenAt + offlineCapMs
 *   eligibleCutoffWall = min(nowWall, capCutoffWall)
 *   simTarget          = simAnchorMs + (eligibleCutoffWall - wallAnchorMs) - pausedWallMs
 *   result             = advance(state, simTarget, { collect: 'summary' })
 *   creditedSimMs      = result.state.nowMs - state.nowMs
 *
 * The segment runner is a parameter, so the worked example — whose wipe at
 * exactly 46,000,000 ms no real seed is guaranteed to produce — is asserted
 * against a stub, and everything else against the real engine.
 */
import { describe, expect, test } from 'vitest';
import { resumeAfterMaintenance, settle, type SegmentRunner } from '../src/hunt/settle';
import { runSegment, type SegmentRequest, type SegmentResult } from '../src/workers/segment';
import { envelope, sim, startState, W0 } from './hunt-fixtures';

const real: SegmentRunner = (request) => runSegment(sim, request);

function stub(result: Partial<SegmentResult>, seen: SegmentRequest[] = []): SegmentRunner {
  return (request) => {
    seen.push(request);
    return {
      encodedState: request.encodedState,
      events: [],
      simNowMs: request.simTarget,
      creditedSimMs: 0,
      completion: 'target',
      stopReason: null,
      reachedTarget: true,
      continuations: 1,
      rewards: [],
      pendingRulesQueued: false,
      ...result,
    };
  };
}

describe('the part 2 §3 worked example, end to end', () => {
  const W1 = W0 + 68_400_000; // 19 h away
  const before = envelope({ wallAnchorMs: W0, simAnchorMs: 5_400_000, lastSeenAt: W0, pausedWallMs: 0 });

  test('credits the state.nowMs delta, never the requested horizon, and places the stop with pre-settlement anchors', async () => {
    const seen: SegmentRequest[] = [];
    const settled = await settle(
      before,
      W1,
      stub({ simNowMs: 46_000_000, creditedSimMs: 40_600_000, completion: 'stopped', stopReason: 'wipe-limit' }, seen),
    );

    // capCutoffWall = W0 + 43,200,000; eligibleCutoffWall = min(W1, that).
    expect(settled.window.capCutoffWall).toBe(W0 + 43_200_000);
    expect(settled.window.eligibleCutoffWall).toBe(W0 + 43_200_000);
    // simTarget = 5,400,000 + 43,200,000, asked of the engine in summary mode.
    expect(seen).toHaveLength(1);
    expect(seen[0].simTarget).toBe(48_600_000);
    expect(seen[0].collect).toBe('summary');

    // The engine wiped out at 46,000,000: 11 h 16 m 40 s credited.
    expect(settled.creditedSimMs).toBe(40_600_000);
    expect(settled.stop).toEqual({ reason: 'wipe-limit', atSimMs: 46_000_000, atWallMs: W0 + 40_600_000 });

    // Both uncovered intervals (B-L03): stop → cap cutoff, and cap cutoff → return.
    expect(settled.uncovered).toEqual({ afterStopMs: 2_600_000, afterCapMs: 25_200_000 });

    // After the commit: presence and the wall anchor are the return, the sim anchor is the stop.
    expect(settled.envelope.lastSeenAt).toBe(W1);
    expect(settled.envelope.wallAnchorMs).toBe(W1);
    expect(settled.envelope.simAnchorMs).toBe(46_000_000);
    expect(settled.envelope.pausedWallMs).toBe(0);
    expect(settled.envelope.stopContext).toMatchObject({ reason: 'wipe-limit', atSimMs: 46_000_000, atWallMs: W0 + 40_600_000 });

    // Time away and simulated duration are two numbers, not one.
    expect(W1 - before.lastSeenAt).toBe(68_400_000);
    expect(settled.creditedSimMs).not.toBe(W1 - before.lastSeenAt);
  });

  test('had the hunt still been running at the cutoff, the full cap is credited and the seven hours are discarded identically', async () => {
    const settled = await settle(before, W1, stub({ simNowMs: 48_600_000, creditedSimMs: 43_200_000 }));
    expect(settled.creditedSimMs).toBe(43_200_000);
    expect(settled.window.cappedBy).toBe('cap');
    expect(settled.stop).toBeNull();
    expect(settled.uncovered).toEqual({ afterStopMs: 0, afterCapMs: 25_200_000 });
    expect(settled.envelope.simAnchorMs).toBe(48_600_000);
    expect(settled.envelope.lastSeenAt).toBe(W1);
  });
});

describe('the cap in force is the checkpoint’s, not configuration’s', () => {
  test('a checkpoint recorded under a one-hour cap settles one hour, whatever is deployed now', async () => {
    const seen: SegmentRequest[] = [];
    await settle(envelope({ offlineCapMs: 3_600_000 }), W0 + 68_400_000, stub({}, seen));
    expect(seen[0].simTarget).toBe(3_600_000);
  });

  test('the recorded cap is carried forward unchanged by the re-anchor', async () => {
    const settled = await settle(envelope({ offlineCapMs: 3_600_000 }), W0 + 10_000, real);
    expect(settled.envelope.offlineCapMs).toBe(3_600_000);
  });
});

describe('re-anchoring to now makes uncovered time unrecoverable (B-L04) and a repeat a no-op (B-L05)', () => {
  // A ten-minute recorded cap keeps the real engine run short and the hunt alive.
  const offline = envelope({ offlineCapMs: 600_000 });
  const W1 = W0 + 3_600_000;

  test('settle, wait, settle again: the second credits only the wait, never the uncovered time', async () => {
    const first = await settle(offline, W1, real);
    expect(first.creditedSimMs).toBe(600_000);
    expect(first.uncovered.afterCapMs).toBe(3_000_000);

    const second = await settle(first.envelope, W1 + 60_000, real);
    expect(second.creditedSimMs).toBe(60_000);
    expect(second.uncovered).toEqual({ afterStopMs: 0, afterCapMs: 0 });

    // Deferring the return does not help either: the uncovered time is gone.
    const later = await settle(first.envelope, W1 + 3_600_000, real);
    expect(later.creditedSimMs).toBe(600_000);
  });

  test('settling twice at one instant credits zero and leaves the engine bytes unchanged', async () => {
    const first = await settle(offline, W0 + 90_000, real);
    const again = await settle(first.envelope, W0 + 90_000, real);
    expect(again.creditedSimMs).toBe(0);
    expect(again.envelope.state).toBe(first.envelope.state);
    expect(again.envelope.simAnchorMs).toBe(first.envelope.simAnchorMs);
  });

  test('a settlement asked for a wall instant before the anchor never rewinds', async () => {
    const first = await settle(offline, W0 + 90_000, real);
    const backwards = await settle(first.envelope, W0 + 30_000, real);
    expect(backwards.creditedSimMs).toBe(0);
  });
});

describe('presence semantics (B-18)', () => {
  test('a heartbeat is a settlement: it credits the covered interval and does not bump generation', async () => {
    const before = envelope({ generation: 4 });
    const heartbeat = await settle(before, W0 + 30_000, real, { live: true });
    expect(heartbeat.creditedSimMs).toBe(30_000);
    expect(heartbeat.envelope.generation).toBe(4);
    expect(heartbeat.envelope.lastSeenAt).toBe(W0 + 30_000);
    expect(sim.decode(heartbeat.envelope.state).nowMs).toBe(30_000);
  });

  test('a settlement for no live connection advances the hunt but leaves presence, and so the allowance, alone', async () => {
    const settled = await settle(envelope(), W0 + 30_000, real, { live: false });
    expect(settled.creditedSimMs).toBe(30_000);
    expect(settled.envelope.lastSeenAt).toBe(W0);
    expect(settled.envelope.wallAnchorMs).toBe(W0 + 30_000);
  });

  test('a segment cut short by its work bound anchors where it stopped and leaves the remainder owed', async () => {
    const settled = await settle(envelope(), W0 + 60_000, stub({ simNowMs: 20_000, creditedSimMs: 20_000, completion: 'capped', reachedTarget: false }));
    expect(settled.envelope.simAnchorMs).toBe(20_000);
    expect(settled.envelope.wallAnchorMs).toBe(W0 + 20_000);
    expect(settled.envelope.lastSeenAt).toBe(W0);
    expect(settled.uncovered).toEqual({ afterStopMs: 0, afterCapMs: 0 });
  });

  test('settle is pure: the input envelope is not mutated and the checkpoint sequence moves by one', async () => {
    const before = envelope();
    const frozen = JSON.stringify(before);
    const settled = await settle(before, W0 + 10_000, real);
    expect(JSON.stringify(before)).toBe(frozen);
    expect(settled.envelope.checkpointSeq).toBe(before.checkpointSeq + 1);
  });
});

describe('maintenance downtime does not bill the allowance (P-31, part 2 §9 #10)', () => {
  test('resuming moves the wall anchor past the outage and advances lastSeenAt by the downtime', async () => {
    const cutoff = W0 + 600_000;
    const resume = cutoff + 3 * 3_600_000;
    // An offline player: presence stays at W0 while the hunt is settled to the cutoff.
    const atCutoff = await settle(envelope(), cutoff, real, { live: false });
    expect(atCutoff.envelope.lastSeenAt).toBe(W0);

    const resumed = resumeAfterMaintenance(atCutoff.envelope, cutoff, resume);
    expect(resumed.wallAnchorMs).toBe(resume);
    expect(resumed.simAnchorMs).toBe(atCutoff.envelope.simAnchorMs);
    expect(resumed.pausedWallMs).toBe(0);
    expect(resumed.lastSeenAt).toBe(W0 + 3 * 3_600_000);
    expect(resumed.state).toBe(atCutoff.envelope.state);

    // The outage is excluded from sim time: a minute after resume credits a minute.
    const after = await settle(resumed, resume + 60_000, real, { live: false });
    expect(after.creditedSimMs).toBe(60_000);
    // And the cap is measured from the shifted presence: 12 h from W0 + 3 h.
    expect(after.window.capCutoffWall).toBe(W0 + 3 * 3_600_000 + 43_200_000);
  });

  test('a resume earlier than its cutoff is refused rather than rewinding presence', () => {
    expect(() => resumeAfterMaintenance(envelope(), W0 + 10, W0)).toThrow(RangeError);
  });
});

test('a started engine state is where every settlement in this file begins', () => {
  expect(sim.decode(envelope().state).nowMs).toBe(startState().nowMs);
});
