/**
 * P-03: the server and the balance CLI are the same engine producing the same
 * bytes.
 *
 * Milestone A proved the engine deterministic. What has to be proved *here* is
 * that the server's way of driving it — decode, advance in budgeted
 * continuations, encode — adds nothing and loses nothing. If these ever
 * diverge, a reward a player received could not be reproduced by the tool the
 * balance decisions are made with.
 */
import { describe, expect, test } from 'vitest';
import { content, validateContent } from '@narok/data';
import {
  createGrid,
  createSimulation,
  defaultPlacement,
  defaultStrategy,
  takeDispositionedRewards,
  type LabInput,
} from '@narok/sim';
import { drainSummary } from '../../../tools/balance/src/run';
import { runSegment } from '../src/workers/segment';

const validated = validateContent(content);
const sim = createSimulation(validated, createGrid(validated.grid, validated.shapes));

function input(seed: number, classes: readonly ('guardian' | 'cleric' | 'ranger')[] = ['guardian', 'cleric', 'ranger']): LabInput {
  return {
    seed,
    classes: [...classes],
    recipe: 'mixed',
    placement: defaultPlacement([...classes]),
    strategies: Object.fromEntries(classes.map((id, index) => [`p${index}`, defaultStrategy(id)])),
    rest: { hpStart: 50, mpStart: 30 },
  };
}

const TEN_MINUTES = 600_000;

describe('the worker path and the CLI path agree byte for byte', () => {
  test.each([1, 2, 7])('seed %i, ten minutes, summary collection', (seed) => {
    const started = sim.start(input(seed));

    // The worker drains the dispositioned rewards it hands to the commit
    // (R132); the CLI keeps them. Drained the same way, the bytes agree, and
    // so do the rewards.
    const cli = takeDispositionedRewards(drainSummary(sim, started, TEN_MINUTES));
    const viaWorker = runSegment(sim, {
      encodedState: sim.encode(started),
      simTarget: TEN_MINUTES,
      collect: 'summary',
    });

    expect(viaWorker.encodedState).toBe(sim.encode(cli.state));
    expect(viaWorker.rewards).toEqual(cli.rewards);
  });

  test('a tight work budget changes how many calls it takes, not what comes out', () => {
    const started = sim.start(input(3));
    const unbudgeted = runSegment(sim, {
      encodedState: sim.encode(started),
      simTarget: TEN_MINUTES,
      collect: 'summary',
    });
    const budgeted = runSegment(sim, {
      encodedState: sim.encode(started),
      simTarget: TEN_MINUTES,
      collect: 'summary',
      maxScheduledEvents: 5,
    });

    expect(budgeted.continuations).toBeGreaterThan(unbudgeted.continuations);
    expect(budgeted.encodedState).toBe(unbudgeted.encodedState);
    expect(budgeted.simNowMs).toBe(unbudgeted.simNowMs);
  });

  test('advancing in two segments equals advancing in one (the split invariant)', () => {
    const started = sim.encode(sim.start(input(5)));

    const oneShot = runSegment(sim, { encodedState: started, simTarget: TEN_MINUTES, collect: 'summary' });

    const first = runSegment(sim, { encodedState: started, simTarget: 240_000, collect: 'summary' });
    const second = runSegment(sim, {
      encodedState: first.encodedState,
      simTarget: TEN_MINUTES,
      collect: 'summary',
    });

    expect(second.encodedState).toBe(oneShot.encodedState);
  });

  test('a continuation resumes against the same absolute target, not a relative one', () => {
    const started = sim.encode(sim.start(input(11)));
    const budgeted = runSegment(sim, {
      encodedState: started,
      simTarget: TEN_MINUTES,
      collect: 'summary',
      maxScheduledEvents: 3,
    });
    expect(budgeted.reachedTarget).toBe(true);
    expect(budgeted.simNowMs).toBe(TEN_MINUTES);
  });
});

describe('an engine stop ends accrual before the target', () => {
  // A lone ranger wipes quickly, which is exactly the case a caller could get
  // wrong: the engine says "target reached" because nothing more can happen,
  // yet far less time was credited than was asked for.
  const SIX_HOURS = 21_600_000;

  test('the worker and the CLI still agree byte for byte on a stopped hunt', () => {
    const started = sim.start(input(2, ['ranger']));
    const viaCli = drainSummary(sim, started, SIX_HOURS);
    const viaWorker = runSegment(sim, { encodedState: sim.encode(started), simTarget: SIX_HOURS, collect: 'summary' });

    expect(viaWorker.encodedState).toBe(sim.encode(viaCli));
    expect(viaWorker.completion).toBe('stopped');
    expect(viaWorker.stopReason).toBe('wipe');
    expect(viaWorker.simNowMs).toBe(viaCli.nowMs);
    expect(viaWorker.simNowMs, 'credit is the state delta, never the horizon').toBeLessThan(SIX_HOURS);
    expect(viaWorker.creditedSimMs).toBe(viaCli.nowMs);
  });

  test('advancing a stopped hunt again credits nothing and changes nothing', () => {
    const stopped = runSegment(sim, {
      encodedState: sim.encode(sim.start(input(2, ['ranger']))),
      simTarget: SIX_HOURS,
      collect: 'summary',
    });
    const again = runSegment(sim, { encodedState: stopped.encodedState, simTarget: SIX_HOURS * 2, collect: 'summary' });

    expect(again.creditedSimMs).toBe(0);
    expect(again.encodedState).toBe(stopped.encodedState);
    expect(again.completion).toBe('stopped');
  });

  test('a hunt that reaches its target unstopped says so', () => {
    const result = runSegment(sim, { encodedState: sim.encode(sim.start(input(1))), simTarget: 60_000, collect: 'summary' });
    expect(result.completion).toBe('target');
    expect(result.stopReason).toBeNull();
  });
});

describe('collection mode changes what is reported, never what happened', () => {
  test('events and summary collection reach an identical state', () => {
    const started = sim.encode(sim.start(input(9)));
    const detailed = runSegment(sim, { encodedState: started, simTarget: TEN_MINUTES, collect: 'events' });
    const summary = runSegment(sim, { encodedState: started, simTarget: TEN_MINUTES, collect: 'summary' });

    expect(detailed.encodedState).toBe(summary.encodedState);
  });

  test('summary collects none, event collection collects many', () => {
    const started = sim.encode(sim.start(input(9)));
    const detailed = runSegment(sim, { encodedState: started, simTarget: TEN_MINUTES, collect: 'events' });
    const summary = runSegment(sim, { encodedState: started, simTarget: TEN_MINUTES, collect: 'summary' });

    expect(summary.events).toHaveLength(0);
    expect(detailed.events.length).toBeGreaterThan(100);
  });

  test('collected events arrive in sequence order, which is what the release filter assumes', () => {
    const started = sim.encode(sim.start(input(4)));
    const { events } = runSegment(sim, { encodedState: started, simTarget: TEN_MINUTES, collect: 'events' });

    for (let index = 1; index < events.length; index++) {
      expect(events[index].seq).toBeGreaterThan(events[index - 1].seq);
      expect(events[index].at).toBeGreaterThanOrEqual(events[index - 1].at);
    }
  });
});

describe('the segment is a candidate, not a commit', () => {
  test('it returns an encoding and touches nothing else', () => {
    const started = sim.encode(sim.start(input(1)));
    const result = runSegment(sim, { encodedState: started, simTarget: 60_000, collect: 'summary' });

    expect(typeof result.encodedState).toBe('string');
    expect(result.creditedSimMs).toBe(60_000);
    // The input encoding is untouched: the caller still holds the state it had.
    expect(sim.decode(started).nowMs).toBe(0);
  });

  test('advancing to the current time is a legal no-op that credits nothing', () => {
    const started = sim.encode(sim.start(input(1)));
    const result = runSegment(sim, { encodedState: started, simTarget: 0, collect: 'summary' });
    expect(result.creditedSimMs).toBe(0);
    expect(result.encodedState).toBe(started);
  });

  test('a budget of zero is refused by the engine, before a segment can spin on it', () => {
    const started = sim.encode(sim.start(input(1)));
    // The engine range-checks its own options: a budget below one cannot pop an
    // event, so it is an invalid input rather than a segment that stalls.
    expect(() =>
      runSegment(sim, {
        encodedState: started,
        simTarget: TEN_MINUTES,
        collect: 'summary',
        maxScheduledEvents: 0,
      }),
    ).toThrowError(/at least one event/);
  });

  test('a continuation cap stops a segment rather than letting it run forever', () => {
    const started = sim.encode(sim.start(input(1)));
    const capped = runSegment(sim, {
      encodedState: started,
      simTarget: TEN_MINUTES,
      collect: 'summary',
      maxScheduledEvents: 1,
      maxContinuations: 3,
    });

    expect(capped.reachedTarget, 'it stopped short rather than spinning').toBe(false);
    expect(capped.completion).toBe('capped');
    expect(capped.continuations).toBe(3);
    expect(capped.simNowMs).toBeLessThan(TEN_MINUTES);
  });

  test('a continuation cap below one is refused, not silently treated as one', () => {
    const started = sim.encode(sim.start(input(1)));
    for (const maxContinuations of [0, -1, 1.5]) {
      expect(() =>
        runSegment(sim, { encodedState: started, simTarget: TEN_MINUTES, collect: 'summary', maxContinuations }),
      ).toThrowError(RangeError);
    }
  });
});

// P-02 — a client-supplied snapshot is never accepted as account state — is
// proved against the real routes in `hunt-routes.db.test.ts`.
