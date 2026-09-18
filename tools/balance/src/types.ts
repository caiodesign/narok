import type { Metrics } from '@narok/sim';

/**
 * One measured run's exact CSV fields (spec §12, rulings R48) plus the full per-actor
 * `metrics` the companion JSON keeps alongside the CSV. Field names are already the
 * CSV column names (snake_case) so `writeCsv` needs no renaming step.
 */
export interface RunResult {
  simulation_version: string;
  content_version: string;
  seed: number;
  roster: string;
  recipe: string;
  placement: string;
  requested_ms: number;
  elapsed_ms: number;
  stop_reason: string | null;
  kills: number;
  wins: number;
  wipes: number;
  rest_ms: number;
  walk_ms: number;
  fight_ms: number;
  raw_exp: number;
  raw_gold: number;
  damage_dealt: number;
  effective_healing: number;
  kills_per_hour: number | null;
  metrics: Metrics;
}

export type PlacementName = 'default' | 'front' | 'spread';
export type CliRecipe = 'melee' | 'ranged' | 'clustered' | 'mixed';

export interface BenchmarkRunRecord {
  hours: number;
  seed: number;
  wallMs: number;
  peakRssBytes: number;
  requestedMs: number;
  elapsedMs: number;
  stopReason: string | null;
  short: boolean;
  fixture: 'gameplay' | 'engine-stress';
}

export interface BenchmarkPercentiles {
  p50: number;
  p95: number;
  p99: number;
}

export interface BenchmarkHorizonSummary {
  hours: number;
  runs: BenchmarkRunRecord[];
  wallMsPercentiles: BenchmarkPercentiles;
  peakRssBytesPercentiles: BenchmarkPercentiles;
}

export interface BenchmarkMetadata {
  nodeVersion: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryBytes: number;
  simulationVersion: string;
  contentVersion: string;
  gridHash: string;
  commandLine: string;
}

export interface BenchmarkReport {
  metadata: BenchmarkMetadata;
  gameplay: BenchmarkHorizonSummary[];
  stress: BenchmarkHorizonSummary[];
}
