import type { DropProtection, Metrics } from '@narok/sim';

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
  /** Equipment rolled per rarity, at the roll (part 3 §7). */
  items_rolled_common: number;
  items_rolled_uncommon: number;
  items_rolled_rare: number;
  items_rolled_epic: number;
  items_rolled_legendary: number;
  items_kept: number;
  /** Counted, not priced: gold columns arrive with prices (spec §4.0). */
  items_autosold: number;
  drops_lost: number;
  /** Simulated ms of the first equipment drop; `null` when none dropped. */
  first_drop_ms: number | null;
  first_drop_rarity: string | null;
  /**
   * This seed's wait distribution in eligible kills (layer-1 §12: never a
   * mean): every completed wait for an Epic-or-better, then the still-open one
   * as `>n`, joined by `;`.
   */
  epic_wait_kills: string;
  legendary_wait_kills: string;
  /** The bad-luck counters at the end of the run; JSON only, never a CSV column. */
  drop_protection: DropProtection;
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
