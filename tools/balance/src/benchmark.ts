import { fork } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { content } from '@narok/data';
import { percentile } from './csv';
import type {
  BenchmarkHorizonSummary,
  BenchmarkMetadata,
  BenchmarkPercentiles,
  BenchmarkReport,
  BenchmarkRunRecord,
} from './types';

const RUNNER_PATH = fileURLToPath(new URL('./benchmark-runner.ts', import.meta.url));

interface RunnerResult {
  wallMs: number;
  peakRssBytes: number;
  requestedMs: number;
  elapsedMs: number;
  stopReason: string | null;
}
interface RunnerError { error: string }

function isRunnerError(message: RunnerResult | RunnerError): message is RunnerError {
  return 'error' in message;
}

/**
 * Runs one benchmark sample in a fresh child process (rulings R46/R49) so its peak
 * RSS is measured in isolation rather than accumulated across the whole benchmark.
 */
function runInChildProcess(job: { kind: 'gameplay' | 'stress'; hours: number; seed: number }): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const child = fork(RUNNER_PATH, [JSON.stringify(job)], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    child.on('message', (message: RunnerResult | RunnerError) => {
      settled = true;
      if (isRunnerError(message)) reject(new Error(message.error));
      else resolve(message);
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
        reject(new Error(`benchmark runner exited with code ${code} before reporting a result`));
      }
    });
  });
}

function summarizePercentiles(values: number[]): BenchmarkPercentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99) };
}

/**
 * Whether a sample stopped before reaching its requested horizon (rulings R49): a
 * normal party can hit its wipe limit or stalemate deadline early; the engine-stress
 * fixture never does (its HP budget survives the horizon by construction), so this
 * only ever marks gameplay samples. Never used to extrapolate a full-duration cost —
 * short samples are reported, not rescaled.
 */
export function classifyShort(requestedMs: number, elapsedMs: number): boolean {
  return elapsedMs < requestedMs;
}

async function runHorizon(
  hours: number,
  sampleCount: number,
  fixture: 'gameplay' | 'engine-stress',
): Promise<BenchmarkHorizonSummary> {
  const kind = fixture === 'gameplay' ? 'gameplay' : 'stress';
  const records: BenchmarkRunRecord[] = [];
  for (let seed = 1; seed <= sampleCount; seed++) {
    const result = await runInChildProcess({ kind, hours, seed });
    records.push({
      hours,
      seed,
      wallMs: result.wallMs,
      peakRssBytes: result.peakRssBytes,
      requestedMs: result.requestedMs,
      elapsedMs: result.elapsedMs,
      stopReason: result.stopReason,
      short: classifyShort(result.requestedMs, result.elapsedMs),
      fixture,
    });
  }
  return {
    hours,
    runs: records,
    wallMsPercentiles: summarizePercentiles(records.map((record) => record.wallMs)),
    peakRssBytesPercentiles: summarizePercentiles(records.map((record) => record.peakRssBytes)),
  };
}

function buildMetadata(): BenchmarkMetadata {
  const cpuList = cpus();
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpuList[0]?.model ?? 'unknown',
    cpuCount: cpuList.length,
    totalMemoryBytes: totalmem(),
    simulationVersion: 'b1',
    contentVersion: content.version,
    gridHash: content.gridHash,
    commandLine: process.argv.slice(1).join(' '),
  };
}

/**
 * Runs `runs` gameplay samples (default party, mixed recipe, default placement,
 * seeds `1..runs`) plus one engine-stress sample per requested horizon, each in an
 * isolated child process, and reports p50/p95/p99 wall duration and peak sampled RSS
 * per horizon (rulings R49). Gameplay and stress stay in separate report sections; a
 * gameplay sample that stopped early is marked `short` rather than silently
 * extrapolated. Necessarily asynchronous: forking and awaiting child processes
 * cannot be done synchronously.
 */
export async function benchmark(hours: number[], runs: number): Promise<BenchmarkReport> {
  const gameplay: BenchmarkHorizonSummary[] = [];
  const stress: BenchmarkHorizonSummary[] = [];
  for (const hour of hours) {
    gameplay.push(await runHorizon(hour, runs, 'gameplay'));
    stress.push(await runHorizon(hour, 1, 'engine-stress'));
  }
  return { metadata: buildMetadata(), gameplay, stress };
}

/** Renders a `BenchmarkReport` as pretty JSON text; the CLI owns writing it to disk. */
export function writeBenchmark(report: BenchmarkReport): string {
  return JSON.stringify(report, null, 2) + '\n';
}
