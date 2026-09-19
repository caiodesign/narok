/**
 * Task 11b — the §13 "batch of 100 jobs" evidence run, with bounded concurrency.
 *
 * `pnpm balance benchmark` does NOT satisfy this gate: `runHorizon`
 * (tools/balance/src/benchmark.ts) is a plain `for` loop with `await
 * runInChildProcess(...)` inside it, so its samples run strictly one at a time
 * (concurrency 1) and it measures *per-run cost*, not batch throughput (R99).
 *
 * This harness reuses the exact same child-process job runner the benchmark uses
 * (tools/balance/src/benchmark-runner.ts) so a batch job is the same unit of work
 * as a benchmark sample — only the scheduling differs. It dispatches 100 gameplay
 * jobs (default party guardian/cleric/ranger, mixed recipe, default placement,
 * seeds 1..100, 12-hour horizon each) through a worker pool whose size is the
 * concurrency passed on the command line, sized from the machine's real CPU count.
 *
 * Usage: node artifacts/batch-100.mjs <concurrency> <hours> <jobs> <outJsonPath>
 */
import { fork } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RUNNER_PATH = fileURLToPath(
  new URL('../tools/balance/src/benchmark-runner.ts', import.meta.url),
);

const concurrency = Number(process.argv[2] ?? cpus().length);
const hours = Number(process.argv[3] ?? 12);
const jobCount = Number(process.argv[4] ?? 100);
const outPath = process.argv[5] ?? 'artifacts/batch-100.json';

function runInChildProcess(job) {
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    const child = fork(RUNNER_PATH, [JSON.stringify(job)], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    child.on('message', (message) => {
      settled = true;
      if (message && typeof message === 'object' && 'error' in message) {
        reject(new Error(String(message.error)));
      } else {
        resolve({
          ...message,
          processWallMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        });
      }
    });
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`batch runner exited with code ${code} before reporting a result`));
      }
    });
  });
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

async function main() {
  const jobs = [];
  for (let seed = 1; seed <= jobCount; seed++) jobs.push({ kind: 'gameplay', hours, seed });

  const results = new Array(jobs.length);
  let next = 0;
  let peakConcurrent = 0;
  let inFlight = 0;

  const startedAt = process.hrtime.bigint();

  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) return;
      inFlight++;
      if (inFlight > peakConcurrent) peakConcurrent = inFlight;
      results[index] = await runInChildProcess(jobs[index]);
      inFlight--;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const totalWallMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  const cpuList = cpus();
  const report = {
    metadata: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpuList[0]?.model ?? 'unknown',
      cpuCount: cpuList.length,
      totalMemoryBytes: totalmem(),
      fixture: 'gameplay',
      party: 'guardian,cleric,ranger',
      recipe: 'mixed',
      placement: 'default',
      horizonHours: hours,
      jobCount: jobs.length,
      requestedConcurrency: concurrency,
      observedPeakConcurrency: peakConcurrent,
    },
    totals: {
      totalWallMs,
      totalWallSeconds: totalWallMs / 1000,
      jobsPerSecond: jobs.length / (totalWallMs / 1000),
      completed: results.filter(Boolean).length,
      short: results.filter((r) => r.elapsedMs < r.requestedMs).length,
    },
    perJobSimWallMs: summarize(results.map((r) => r.wallMs)),
    perJobProcessWallMs: summarize(results.map((r) => r.processWallMs)),
    peakRssBytes: summarize(results.map((r) => r.peakRssBytes)),
    runs: results.map((r, index) => ({
      seed: jobs[index].seed,
      hours: jobs[index].hours,
      wallMs: r.wallMs,
      processWallMs: r.processWallMs,
      peakRssBytes: r.peakRssBytes,
      requestedMs: r.requestedMs,
      elapsedMs: r.elapsedMs,
      stopReason: r.stopReason,
      short: r.elapsedMs < r.requestedMs,
    })),
  };

  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(
    `batch: ${jobs.length} job(s), ${hours}h horizon, requested concurrency ${concurrency}, ` +
      `observed peak ${peakConcurrent}, wall ${(totalWallMs / 1000).toFixed(3)} s, ` +
      `${(jobs.length / (totalWallMs / 1000)).toFixed(3)} jobs/s -> ${outPath}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
