/**
 * The reward carrier (milestone B spec part 2 §2, §6, §9 #2, #3, #8; B-L07,
 * B-L09).
 *
 * The engine emits no reward record yet — drops arrive with task 6 — so these
 * tests drive the carrier with a reward source read from what the engine does
 * expose: the `metrics.kills` delta between two states, one draft per kill.
 * That source lives in this file only and is not wired into production; what
 * is under test is the carrier's mechanics: ids allocated inside the
 * transition and reproducible on replay, rewards read from state rather than
 * from the returned events, drained at each commit, and a cap that forces a
 * commit exactly the way the work budget forces a yield.
 */
import { describe, expect, test } from 'vitest';
import type { SimState } from '@narok/sim';
import { REWARD_CARRIER_CAP } from '../src/hunt/envelope';
import { allocateRewards, drainRewards, RewardCarrierFull, type RewardSource } from '../src/hunt/rewards';
import { settle, type SegmentRunner, type Settlement } from '../src/hunt/settle';
import { runSegment } from '../src/workers/segment';
import { envelope, labInput, sim, W0 } from './hunt-fixtures';

/** One draft per kill, numbered by the kill's ordinal in the hunt. */
const perKill: RewardSource = (before: SimState, after: SimState) =>
  Array.from({ length: after.metrics.kills - before.metrics.kills }, (_, index) => ({
    atSimMs: after.nowMs,
    kind: 'exp' as const,
    payload: { kill: before.metrics.kills + index + 1 },
  }));

const runner: SegmentRunner = (request) => runSegment(sim, request, perKill);
/** A long-lived party, so a window of minutes has kills to count and no stop. */
const sturdy = () => envelope({ state: sim.encode(sim.start(labInput({ wipeLimit: 5, seed: 11 }))) });
const TEN_MINUTES = 600_000;

function idsAndPayloads(settlement: Pick<Settlement, 'rewards'>) {
  return settlement.rewards.map((reward) => [reward.rewardId, reward.payload]);
}

describe('reward ids are "<huntId>:<rewardSeq>", allocated inside the transition (B-L07, part 2 §9 #2)', () => {
  test('allocation numbers from the checkpoint sequence and advances it', () => {
    const before = envelope({ rewardSeq: 7 });
    const after = allocateRewards(before, [
      { atSimMs: 10, kind: 'exp', payload: { a: 1 } },
      { atSimMs: 20, kind: 'gold', payload: { b: 2 } },
    ]);
    expect(after.rewardSeq).toBe(9);
    expect(after.pendingRewards.map((reward) => reward.rewardId)).toEqual([`${before.huntId}:7`, `${before.huntId}:8`]);
    expect(before.pendingRewards).toEqual([]);
  });

  test('replaying a segment from the same checkpoint reproduces the same rewards with the same ids', async () => {
    const from = sturdy();
    const first = await settle(from, W0 + TEN_MINUTES, runner);
    const replay = await settle(from, W0 + TEN_MINUTES, runner);
    expect(first.rewards.length).toBeGreaterThan(0);
    expect(replay.rewards).toEqual(first.rewards);
    expect(replay.envelope).toEqual(first.envelope);
  });
});

describe('rewards come from state, never from the returned events (B-L09)', () => {
  test('summary settlement and detailed live play credit the same rewards, state and RNG', async () => {
    const from = sturdy();
    const summary = await settle(from, W0 + TEN_MINUTES, runner, { collect: 'summary' });
    const detailed = await settle(from, W0 + TEN_MINUTES, runner, { collect: 'events' });

    expect(summary.events).toEqual([]);
    expect(detailed.events.length).toBeGreaterThan(0);
    expect(summary.rewards).toEqual(detailed.rewards);
    expect(summary.envelope.state).toBe(detailed.envelope.state);
    expect(sim.decode(summary.envelope.state).rng).toBe(sim.decode(detailed.envelope.state).rng);
    expect(summary.rewards.length).toBe(sim.decode(summary.envelope.state).metrics.kills);
  });
});

describe('the bounded carrier (part 2 §9 #8)', () => {
  test('rewards drain at each commit: the settled checkpoint carries none and the settlement returns them', async () => {
    const settled = await settle(sturdy(), W0 + TEN_MINUTES, runner);
    expect(settled.envelope.pendingRewards).toEqual([]);
    expect(settled.envelope.rewardSeq).toBe(settled.rewards.length);

    const drained = drainRewards(allocateRewards(envelope(), [{ atSimMs: 1, kind: 'exp', payload: {} }]));
    expect(drained.envelope.pendingRewards).toEqual([]);
    expect(drained.drained).toHaveLength(1);
    expect(drained.envelope.rewardSeq).toBe(1);
  });

  test('allocation past the cap is refused rather than dropping or truncating a reward', () => {
    const full = envelope({
      pendingRewards: Array.from({ length: REWARD_CARRIER_CAP }, (_, index) => ({
        rewardId: `x:${index}`,
        atSimMs: 0,
        kind: 'exp' as const,
        payload: {},
      })),
      rewardSeq: REWARD_CARRIER_CAP,
    });
    expect(() => allocateRewards(full, [{ atSimMs: 0, kind: 'exp', payload: {} }])).toThrow(RewardCarrierFull);
  });

  test('a full carrier forces a commit like the work budget forces a yield, and changes nothing about the run', async () => {
    const from = sturdy();
    const uncapped = await settle(from, W0 + TEN_MINUTES, runner);
    expect(uncapped.rewards.length).toBeGreaterThan(3);

    // Room for three rewards per commit: the settlement ends early, anchored
    // where it stopped, presence untouched, and the rest stays owed.
    const rounds: Settlement[] = [];
    let current = from;
    for (let guard = 0; guard < 1_000; guard++) {
      const round = await settle(current, W0 + TEN_MINUTES, runner, { rewardCap: 3 });
      rounds.push(round);
      current = round.envelope;
      expect(round.rewards.length).toBeLessThanOrEqual(3);
      if (round.completion !== 'reward-cap') break;
      expect(round.envelope.lastSeenAt).toBe(from.lastSeenAt);
      expect(round.envelope.simAnchorMs).toBeLessThan(TEN_MINUTES);
    }

    expect(rounds.length).toBeGreaterThan(1);
    expect(rounds[0].completion).toBe('reward-cap');
    // Nothing dropped, nothing altered: the same rewards in the same order with
    // the same ids, and the same final engine state as one uncapped settlement.
    expect(rounds.flatMap((round) => idsAndPayloads(round))).toEqual(idsAndPayloads(uncapped));
    expect(current.state).toBe(uncapped.envelope.state);
    expect(current.rewardSeq).toBe(uncapped.envelope.rewardSeq);
    // Ten simulated minutes settled once uncapped and again three rewards at a
    // time, halving on every overfull step: seconds of engine work, so it gets
    // the same allowance as the other long engine suites.
  }, 20_000);
});

describe('pity lives in the checkpoint (part 2 §9 #3)', () => {
  test('settlements, forced commits and a queued strategy all carry the counters forward unchanged', async () => {
    const from = { ...sturdy(), pity: { epicPlus: 17, legendary: 3 } };
    const settled = await settle(from, W0 + TEN_MINUTES, runner, { rewardCap: 3 });
    expect(settled.envelope.pity).toEqual({ epicPlus: 17, legendary: 3 });
    const again = await settle(settled.envelope, W0 + TEN_MINUTES, runner);
    expect(again.envelope.pity).toEqual({ epicPlus: 17, legendary: 3 });
  });
});
