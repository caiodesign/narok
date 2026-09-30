/**
 * The reward carrier (milestone B spec part 2 §2, §6, §9 #2, #3, #8; B-L07,
 * B-L09; rulings R117, R132).
 *
 * The rewards are the engine's own drops, read off its state: the kill handler
 * rolls them, encounter end dispositions them, and the segment runner drains
 * the dispositioned ones. The content under test is the bundle with every
 * monster at the largest accepted drop multiplier, so a few simulated minutes
 * carry many rewards; nothing about reward *kinds* is invented here.
 */
import { describe, expect, test } from 'vitest';
import { REWARD_CARRIER_CAP } from '../src/hunt/envelope';
import { identifyRewards } from '../src/hunt/rewards';
import { settle, type SegmentRunner, type Settlement } from '../src/hunt/settle';
import { runSegment } from '../src/workers/segment';
import { envelope, labInput, richSim, W0 } from './hunt-fixtures';

const runner: SegmentRunner = (request) => runSegment(richSim, request);
/** A long-lived party, so a window of minutes has kills and drops and no stop. */
const sturdy = () => envelope({ state: richSim.encode(richSim.start(labInput({ wipeLimit: 5, seed: 11 }))) });
const TEN_MINUTES = 600_000;
/** 2 x the grid's five enemies: the most rewards one encounter end can release. */
const CAP = 10;

function idsAndItems(settlement: Pick<Settlement, 'rewards'>) {
  return settlement.rewards.map((reward) => [reward.rewardId, reward.item, reward.disposition]);
}

describe('reward ids are "<huntId>:<rewardSeq>", allocated inside the transition (B-L07, part 2 §9 #2)', () => {
  test('ids number from the engine ordinal in the hunt namespace, in kill order', async () => {
    const from = sturdy();
    const settled = await settle(from, W0 + TEN_MINUTES, runner);
    expect(settled.rewards.length).toBeGreaterThan(10);
    settled.rewards.forEach((reward, index) => {
      expect(reward.rewardId).toBe(`${from.huntId}:${reward.rewardSeq}`);
      if (index > 0) expect(reward.rewardSeq).toBeGreaterThan(settled.rewards[index - 1].rewardSeq);
      expect(reward.disposition).not.toBeNull();
    });
    // Every ordinal the engine allocated is either credited or still waiting for its encounter to end.
    const state = richSim.decode(settled.envelope.state);
    const waiting = state.pendingRewards.map((reward) => reward.rewardSeq);
    expect([...settled.rewards.map((reward) => reward.rewardSeq), ...waiting]).toEqual(
      Array.from({ length: state.nextRewardSeq }, (_, index) => index),
    );
  });

  test('replaying a segment from the same checkpoint reproduces the same rewards with the same ids', async () => {
    const from = sturdy();
    const first = await settle(from, W0 + TEN_MINUTES, runner);
    const replay = await settle(from, W0 + TEN_MINUTES, runner);
    expect(first.rewards.length).toBeGreaterThan(0);
    expect(replay.rewards).toEqual(first.rewards);
    expect(replay.envelope).toEqual(first.envelope);
  });

  test('only a dispositioned reward can be named for a commit', () => {
    const state = richSim.decode(sturdy().state);
    expect(() => identifyRewards(sturdy(), [{
      rewardSeq: 0, atSimMs: 0, monsterId: 'mossling', itemLevel: 10,
      item: { kind: 'equipment', definitionId: 'leather-cap', rarity: 'common', bonuses: [] }, disposition: null,
    }])).toThrow(RangeError);
    expect(state.pendingRewards).toEqual([]);
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
    expect(richSim.decode(summary.envelope.state).rng).toBe(richSim.decode(detailed.envelope.state).rng);
  });
});

describe('the bounded carrier (part 2 §9 #8)', () => {
  test('rewards drain at each commit: the settled checkpoint carries none dispositioned, and the settlement returns them', async () => {
    const settled = await settle(sturdy(), W0 + TEN_MINUTES, runner);
    const state = richSim.decode(settled.envelope.state);
    expect(state.pendingRewards.every((reward) => reward.disposition === null)).toBe(true);
    expect(settled.rewards.length).toBeGreaterThan(0);
    const text = JSON.stringify(settled.envelope);
    for (const gone of ['"rewardSeq"', '"pity"', '"inventoryProjection"']) expect(text).not.toContain(gone);
  });

  test('the carrier bound can never exceed the envelope cap', async () => {
    const settled = await settle(sturdy(), W0 + 60_000, runner, { rewardCap: REWARD_CARRIER_CAP * 4 });
    expect(settled.rewards.length).toBeLessThanOrEqual(REWARD_CARRIER_CAP);
  });

  test('a full carrier forces a commit like the work budget forces a yield, and changes nothing about the run', async () => {
    const from = sturdy();
    const uncapped = await settle(from, W0 + TEN_MINUTES, runner);
    expect(uncapped.rewards.length).toBeGreaterThan(3 * CAP);

    // Room for ten rewards per commit — the most one event can release: an
    // encounter end dispositions up to five kills' equipment and consumables.
    // The settlement ends early, anchored where it stopped, presence
    // untouched, and the rest stays owed.
    const rounds: Settlement[] = [];
    let current = from;
    for (let guard = 0; guard < 1_000; guard++) {
      const round = await settle(current, W0 + TEN_MINUTES, runner, { rewardCap: CAP });
      rounds.push(round);
      current = round.envelope;
      expect(round.rewards.length).toBeLessThanOrEqual(CAP);
      if (round.completion !== 'reward-cap') break;
      expect(round.envelope.lastSeenAt).toBe(from.lastSeenAt);
      expect(round.envelope.simAnchorMs).toBeLessThan(TEN_MINUTES);
    }

    expect(rounds.length).toBeGreaterThan(1);
    expect(rounds[0].completion).toBe('reward-cap');
    // Nothing dropped, nothing altered: the same rewards in the same order with
    // the same ids, and the same final engine state as one uncapped settlement.
    expect(rounds.flatMap((round) => idsAndItems(round))).toEqual(idsAndItems(uncapped));
    expect(current.state).toBe(uncapped.envelope.state);
    // Ten simulated minutes settled once uncapped and again ten rewards at a
    // time, halving on every overfull step: seconds of engine work.
  }, 30_000);
});

describe('pity lives in the checkpoint (part 2 §9 #3; part 3 §2.4)', () => {
  test('the counters accrue one per eligible kill across settlements and forced commits, never reset by either', async () => {
    const start = richSim.decode(sturdy().state);
    const seeded = envelope({ state: richSim.encode({ ...start, dropProtection: { epicPlus: 17, legendary: 3 } }) });
    const settled = await settle(seeded, W0 + TEN_MINUTES, runner, { rewardCap: 5 * CAP });
    const state = richSim.decode(settled.envelope.state);
    const waits = state.metrics.drops.epicPlusWaits.reduce((sum, wait) => sum + wait, 0);
    // Every kill is an opportunity (every prototype monster drops equipment).
    expect(waits + state.dropProtection.epicPlus).toBe(17 + state.metrics.kills);
  });
});
