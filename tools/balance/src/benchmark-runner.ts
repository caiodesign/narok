import { content } from '@narok/data';
import { advance, createGrid, createSimulation } from '@narok/sim';
import type { Simulation, SimState } from '@narok/sim';
import { buildStressFixture } from '../../../packages/sim/test/stress-fixture';
import { buildLabInput } from './run';
import { hoursToMs } from './args';

/**
 * The forked child-process entry point `benchmark.ts` launches (rulings R46/R49):
 * runs exactly one job — one gameplay sample or one engine-stress sample — to its
 * requested horizon, samples RSS on an interval throughout, and reports wall
 * duration, peak sampled RSS, and the requested/actual simulated horizon back over
 * IPC. Isolating each sample in its own process is what makes the peak RSS
 * measurement per-run rather than cumulative across the whole benchmark.
 */
interface GameplayJob { kind: 'gameplay'; hours: number; seed: number }
interface StressJob { kind: 'stress'; hours: number; seed: number }
type Job = GameplayJob | StressJob;

interface RunnerResult {
  wallMs: number;
  peakRssBytes: number;
  requestedMs: number;
  elapsedMs: number;
  stopReason: string | null;
}
interface RunnerError { error: string }

const RSS_SAMPLE_INTERVAL_MS = 25;

/**
 * Drives `state` to `untilMs` across work-budget yields, yielding one macrotask
 * between `advance` calls so the RSS sampling interval and the parent's IPC channel
 * both get a chance to run during a long synchronous horizon. Throws on no progress,
 * matching `runTo`/`drainSummary`'s loop-detection guard.
 */
async function drainWithYields(
  advanceStep: (state: SimState, untilMs: number) => { state: SimState; reachedTarget: boolean },
  state: SimState,
  untilMs: number,
): Promise<SimState> {
  let current = state;
  for (;;) {
    const beforeNowMs = current.nowMs;
    const beforePopped = current.nextQueueSeq - current.queue.length;
    const result = advanceStep(current, untilMs);
    current = result.state;
    if (result.reachedTarget) return current;
    const afterPopped = current.nextQueueSeq - current.queue.length;
    if (current.nowMs <= beforeNowMs && afterPopped <= beforePopped) {
      throw new Error(`advance made no progress at ${current.nowMs} ms toward ${untilMs} ms`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function runJob(job: Job): Promise<RunnerResult> {
  const untilMs = hoursToMs(job.hours);
  let peakRssBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
  }, RSS_SAMPLE_INTERVAL_MS);
  sampler.unref();

  const startedAt = process.hrtime.bigint();
  let finalState: SimState;

  if (job.kind === 'gameplay') {
    const battlefield = createGrid(content.grid, content.shapes);
    const sim: Simulation = createSimulation(content, battlefield);
    const input = buildLabInput(job.seed, ['guardian', 'cleric', 'ranger'], 'mixed', 'default');
    const started = sim.start(input);
    finalState = await drainWithYields(
      (state, target) => sim.advance(state, target, { collect: 'summary' }),
      started,
      untilMs,
    );
  } else {
    const fixture = buildStressFixture(job.seed);
    finalState = await drainWithYields(
      (state, target) => advance(fixture.content, fixture.battlefield, state, target, { collect: 'summary' }),
      fixture.state,
      untilMs,
    );
  }

  clearInterval(sampler);
  const endedAt = process.hrtime.bigint();
  const finalRss = process.memoryUsage().rss;
  if (finalRss > peakRssBytes) peakRssBytes = finalRss;

  return {
    wallMs: Number(endedAt - startedAt) / 1_000_000,
    peakRssBytes,
    requestedMs: untilMs,
    elapsedMs: finalState.nowMs,
    stopReason: finalState.stopReason,
  };
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (raw === undefined) throw new Error('benchmark-runner: missing job payload');
  const job = JSON.parse(raw) as Job;
  const result = await runJob(job);
  process.send?.(result);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const failure: RunnerError = { error: message };
  process.send?.(failure);
  process.exitCode = 1;
});
