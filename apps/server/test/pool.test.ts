/**
 * P-24: simultaneous reconnects for one account coalesce into one worker job.
 */
import { describe, expect, test } from 'vitest';
import type { SegmentRequest, SegmentResult } from '../src/workers/segment';
import { SegmentPool, type SegmentExecutor } from '../src/workers/pool';

function deferredExecutor() {
  const calls: SegmentRequest[] = [];
  const resolvers: Array<(result: SegmentResult) => void> = [];
  const executor: SegmentExecutor = (request) => {
    calls.push(request);
    return new Promise((resolve) => resolvers.push(resolve));
  };
  const result = (simNowMs: number): SegmentResult => ({
    encodedState: `state@${simNowMs}`,
    events: [],
    simNowMs,
    creditedSimMs: simNowMs,
    completion: 'target',
    stopReason: null,
    reachedTarget: true,
    continuations: 1,
    rewards: [],
    pendingRulesQueued: false,
    pendingLootQueued: false,
  });
  return { executor, calls, resolvers, result };
}

const request = (simTarget: number): SegmentRequest => ({ encodedState: 'x', simTarget, collect: 'summary' });

describe('one account, one job in flight', () => {
  test('N simultaneous requests for one account run one job and share its result', async () => {
    const { executor, calls, resolvers, result } = deferredExecutor();
    const pool = new SegmentPool(executor);

    const joined = Array.from({ length: 10 }, (_, index) => pool.run('account-a', request(1_000 + index)));
    expect(calls).toHaveLength(1);
    expect(pool.size).toBe(1);

    resolvers[0](result(1_000));
    const results = await Promise.all(joined);
    expect(new Set(results).size, 'every joiner received the one result').toBe(1);
    expect(pool.size).toBe(0);
  });

  test('different accounts do not coalesce', () => {
    const { executor, calls } = deferredExecutor();
    const pool = new SegmentPool(executor);
    void pool.run('account-a', request(1));
    void pool.run('account-b', request(1));
    expect(calls).toHaveLength(2);
  });

  test('a request after the job finished starts a new one', async () => {
    const { executor, calls, resolvers, result } = deferredExecutor();
    const pool = new SegmentPool(executor);

    const first = pool.run('account-a', request(1));
    resolvers[0](result(1));
    await first;

    void pool.run('account-a', request(2));
    expect(calls).toHaveLength(2);
    expect(calls[1].simTarget).toBe(2);
  });

  test('a failed job releases the slot, so the account is not wedged', async () => {
    let call = 0;
    const pool = new SegmentPool(async () => {
      call += 1;
      throw new Error(`boom ${call}`);
    });

    await expect(pool.run('account-a', request(1))).rejects.toThrow('boom 1');
    expect(pool.size).toBe(0);
    await expect(pool.run('account-a', request(1))).rejects.toThrow('boom 2');
  });
});
