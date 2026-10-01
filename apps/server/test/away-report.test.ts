/**
 * The away report as a pure function of a committed settlement (milestone B
 * spec part 2 §1 step 2, §3; UI spec §8; B-17, B-18).
 *
 * A report describes settled, already credited progress. It is built from the
 * committed deltas — the state before and after the settlement, and the window
 * that bounded it — so building it again, or reading it again, can credit
 * nothing: there is nothing in it to credit.
 *
 * Four states: running, capped, bag-full (task 6) and stopped.
 */
import { describe, expect, test } from 'vitest';
import type { SimState } from '@narok/sim';
import { buildAwayReport, type AwayReportInput } from '../src/reports/away';
import { sim, startState, W0 } from './hunt-fixtures';

const HOUR = 3_600_000;

function withMetrics(state: SimState, metrics: Partial<SimState['metrics']>, extra: Partial<SimState> = {}): SimState {
  return { ...structuredClone(state), ...extra, metrics: { ...structuredClone(state.metrics), ...metrics } };
}

const before = withMetrics(startState(), { kills: 40, wins: 12, wipes: 0, rawExp: 900, rawGold: 300 }, { nowMs: 5_400_000 });

function input(overrides: Partial<AwayReportInput> = {}): AwayReportInput {
  return {
    huntId: '22222222-2222-4222-8222-222222222222',
    generation: 3,
    previousLastSeenAt: W0,
    returnedAtWall: W0 + HOUR,
    window: { capCutoffWall: W0 + 43_200_000, eligibleCutoffWall: W0 + HOUR, simTarget: 5_400_000 + HOUR, creditableMs: HOUR, cappedBy: 'presence' },
    creditedSimMs: HOUR,
    uncovered: { afterStopMs: 0, afterCapMs: 0 },
    stop: null,
    before,
    after: withMetrics(before, { kills: 70, wins: 22, wipes: 0, rawExp: 1_600, rawGold: 520 }, { nowMs: 5_400_000 + HOUR }),
    rewardsCredited: 0,
    ...overrides,
  };
}

/** Drops across the absence: `lost` of them to a full bag. */
function withDrops(state: SimState, drops: Partial<SimState['metrics']['drops']>): SimState {
  const next = structuredClone(state);
  next.metrics.drops = { ...next.metrics.drops, ...drops };
  return next;
}

describe('the four states, each with its own copy and actions (UI spec §8)', () => {
  test('running: the hunt is still going; the action views it and nothing restarts', () => {
    const report = buildAwayReport(input());
    expect(report.status).toBe('running');
    expect(report.stopReason).toBeNull();
    expect(report.copyKey).toBe('away.running');
    expect(report.actions).toEqual(['view-hunt']);
    expect(report.timeAwayMs).toBe(HOUR);
    expect(report.simulatedMs).toBe(HOUR);
  });

  test('capped: accrual stopped at the cap, the hunt did not, and it is reported as a cap rather than a combat failure', () => {
    const W1 = W0 + 68_400_000;
    const report = buildAwayReport(
      input({
        returnedAtWall: W1,
        window: { capCutoffWall: W0 + 43_200_000, eligibleCutoffWall: W0 + 43_200_000, simTarget: 48_600_000, creditableMs: 43_200_000, cappedBy: 'cap' },
        creditedSimMs: 43_200_000,
        uncovered: { afterStopMs: 0, afterCapMs: 25_200_000 },
        after: withMetrics(before, { kills: 400 }, { nowMs: 48_600_000 }),
      }),
    );
    expect(report.status).toBe('capped');
    expect(report.stopReason, 'a cap is not a stop').toBeNull();
    expect(report.copyKey).toBe('away.capped');
    expect(report.actions).toEqual(['view-hunt']);
    // Time away and simulated duration, separately.
    expect(report.timeAwayMs).toBe(68_400_000);
    expect(report.simulatedMs).toBe(43_200_000);
    expect(report.accrualEndedAtWall).toBe(W0 + 43_200_000);
    expect(report.uncovered).toEqual({ afterStopMs: 0, afterCapMs: 25_200_000 });
  });

  test('stopped, the part 2 §3 worked example: the actual reason and the restart action', () => {
    const W1 = W0 + 68_400_000;
    const after = withMetrics(before, { wipes: 1 }, { nowMs: 46_000_000, phase: 'stopped', stopReason: 'wipe' });
    const report = buildAwayReport(
      input({
        returnedAtWall: W1,
        window: { capCutoffWall: W0 + 43_200_000, eligibleCutoffWall: W0 + 43_200_000, simTarget: 48_600_000, creditableMs: 43_200_000, cappedBy: 'cap' },
        creditedSimMs: 40_600_000,
        uncovered: { afterStopMs: 2_600_000, afterCapMs: 25_200_000 },
        stop: { reason: 'wipe', atSimMs: 46_000_000, atWallMs: W0 + 40_600_000 },
        after,
      }),
    );
    // A stop outranks the cap: the hunt ended before the cap was reached.
    expect(report.status).toBe('stopped');
    expect(report.stopReason).toBe('wipe');
    expect(report.copyKey).toBe('away.stopped.wipe');
    expect(report.actions).toEqual(['start-hunt']);
    expect(report.timeAwayMs).toBe(68_400_000);
    expect(report.simulatedMs).toBe(40_600_000);
    expect(report.accrualEndedAtWall).toBe(W0 + 40_600_000);
    // A wipe ends the hunt (owner decision 2026-09-30): there is no wipe limit to report.
    expect(report.outcomes.wipes).toBe(1);
    expect(report.wipesThisHunt).toBe(1);
    expect(report).not.toHaveProperty('wipeLimit');
  });

  test('bag-full: drops were lost to a full bag, the hunt kept going, and managing the bag is the primary action', () => {
    const after = withDrops(input().after, { kept: 3, autoSold: 5, lost: 4, rolled: { common: 5, uncommon: 5, rare: 2, epic: 0, legendary: 0 } });
    const report = buildAwayReport(input({ after }));
    expect(report.status).toBe('bag-full');
    expect(report.stopReason, 'a full bag is not a stop').toBeNull();
    expect(report.copyKey).toBe('away.bagFull');
    expect(report.actions).toEqual(['manage-bag', 'view-hunt']);
    expect(report.outcomes.drops).toEqual({ rolled: 12, kept: 3, autoSold: 5, ignored: 0, lost: 4 });
  });

  test('a full bag outranks the cap, and a stop outranks a full bag', () => {
    const lost = withDrops(input().after, { lost: 1 });
    expect(buildAwayReport(input({ after: lost, window: { ...input().window, cappedBy: 'cap' } })).status).toBe('bag-full');
    const stopped = withDrops(withMetrics(input().after, {}, { phase: 'stopped', stopReason: 'wipe' }), { lost: 1 });
    expect(buildAwayReport(input({ after: stopped })).status).toBe('stopped');
    // Drops lost before this absence are not this absence's news.
    const earlier = withDrops(before, { lost: 2 });
    expect(buildAwayReport(input({ before: earlier, after: withDrops(input().after, { lost: 2 }) })).status).toBe('running');
  });

  test('the four states are four different reports', () => {
    const keys = new Set([
      buildAwayReport(input()).copyKey,
      buildAwayReport(input({ window: { ...input().window, cappedBy: 'cap' } })).copyKey,
      buildAwayReport(input({ after: withDrops(input().after, { lost: 1 }) })).copyKey,
      buildAwayReport(input({ stop: { reason: 'stalemate', atSimMs: 1, atWallMs: W0 + 1 }, after: withMetrics(before, {}, { phase: 'stopped', stopReason: 'stalemate' }) })).copyKey,
    ]);
    expect(keys.size).toBe(4);
  });
});

describe('the report is built from committed deltas and credits nothing (B-17)', () => {
  test('outcomes are the metric deltas across the settlement, never the running totals', () => {
    const report = buildAwayReport(input());
    expect(report.outcomes).toEqual({
      kills: 30, wins: 10, wipes: 0, rawExp: 700, rawGold: 220,
      drops: { rolled: 0, kept: 0, autoSold: 0, ignored: 0, lost: 0 },
      consumed: {},
    });
  });

  test("Idun's Apples eaten during the absence are its resource consumption (R152)", () => {
    const earlier = withMetrics(before, { consumed: { 'idun-apple': 2 } });
    const report = buildAwayReport(input({
      before: earlier,
      after: withMetrics(earlier, { consumed: { 'idun-apple': 5 } }, { nowMs: 5_400_000 + HOUR }),
    }));
    expect(report.outcomes.consumed).toEqual({ 'idun-apple': 3 });
  });

  test('building it again from the same inputs is identical and leaves its inputs untouched', () => {
    const source = input();
    const frozen = JSON.stringify(source);
    expect(buildAwayReport(source)).toEqual(buildAwayReport(source));
    expect(JSON.stringify(source)).toBe(frozen);
  });

  test('it carries no seed, RNG state, queue or reward carrier (B-08)', () => {
    const text = JSON.stringify(buildAwayReport(input()));
    for (const forbidden of ['"rng"', '"seed"', '"queue"', '"pendingRewards"']) expect(text).not.toContain(forbidden);
    expect(sim.decode(sim.encode(before)).nowMs).toBe(before.nowMs);
  });
});
