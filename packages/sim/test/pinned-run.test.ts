import { expect, test } from 'vitest';
import { content } from '@narok/data';
import type { LabInput, Metrics, Phase, StopReason } from '../src/types';
import fixtureJson from './fixtures/one-hour-run.json';
import { lab, runTo } from './fixtures';

/**
 * Pinned one-hour fixture (ruling R44): a small committed golden file recording
 * one full `runTo(sim, sim.start(input), 3_600_000)` run's observable outputs.
 * Recomputing the same run and comparing field by field turns any accidental
 * change to content, RNG consumption, or scheduling into a visible diff here,
 * without committing the full 13,648-event log or a multi-megabyte snapshot.
 *
 * Loaded as a plain JSON module (the bundler's static import, not `node:fs`),
 * so `packages/sim` still imports no Node or browser globals anywhere,
 * including its tests.
 */
interface PinnedFixture {
  contentVersion: string;
  gridHash: string;
  simulationVersion: 'a1';
  untilMs: number;
  input: LabInput;
  observed: {
    nowMs: number;
    phase: Phase;
    stopReason: StopReason | null;
    rng: number;
    domainEventCount: number;
    metrics: Metrics;
  };
}

const pinned = fixtureJson as unknown as PinnedFixture;

test('the bound content still matches the pinned fixture\'s content/grid identity', () => {
  expect(content.version).toBe(pinned.contentVersion);
  expect(content.gridHash).toBe(pinned.gridHash);
});

test('a recomputed one-hour run matches the pinned fixture field by field (R44)', () => {
  const sim = lab();
  const result = runTo(sim, sim.start(pinned.input), pinned.untilMs);

  expect(result.state.simulationVersion).toBe(pinned.simulationVersion);
  expect(result.state.contentVersion).toBe(pinned.contentVersion);
  expect(result.state.gridHash).toBe(pinned.gridHash);
  expect(result.state.nowMs).toBe(pinned.observed.nowMs);
  expect(result.state.phase).toBe(pinned.observed.phase);
  expect(result.state.stopReason).toBe(pinned.observed.stopReason);
  expect(result.state.rng).toBe(pinned.observed.rng);
  expect(result.state.metrics).toEqual(pinned.observed.metrics);
  expect(result.events.length).toBe(pinned.observed.domainEventCount);
  expect(result.events[result.events.length - 1]!.seq).toBe(pinned.observed.domainEventCount - 1);
});
