import type { RunResult } from './types';

/**
 * Exact CSV column order (spec §12): simulation/content versions, seed, roster,
 * recipe, placement, requested/elapsed ms, stop reason, kills/wins/wipes, the three
 * phase-time totals, raw exp/gold, damage dealt, effective healing, kills per hour.
 */
const CSV_COLUMNS: readonly (keyof RunResult)[] = [
  'simulation_version',
  'content_version',
  'seed',
  'roster',
  'recipe',
  'placement',
  'requested_ms',
  'elapsed_ms',
  'stop_reason',
  'kills',
  'wins',
  'wipes',
  'rest_ms',
  'walk_ms',
  'fight_ms',
  'raw_exp',
  'raw_gold',
  'damage_dealt',
  'effective_healing',
  'kills_per_hour',
];

/**
 * Encodes one CSV cell (task 8 brief): `null` becomes an empty field (used for
 * `stop_reason` while still running and for `kills_per_hour` at zero elapsed time —
 * rulings R48), and a field containing a comma, quote, or newline is wrapped in
 * quotes with embedded quotes doubled. Refuses a non-finite number outright so NaN
 * or Infinity can never reach a file (hard constraint, rulings R48).
 */
export function csvCell(value: string | number | null): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`refusing to write a non-finite value to CSV: ${value}`);
  }
  const text = value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

/**
 * Renders `rows` as CSV text with a header row, in the exact column order above. The
 * CLI owns writing this string to disk (rulings R46/R48); this function performs no
 * I/O.
 */
export function writeCsv(rows: RunResult[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => csvCell(row[column] as string | number | null)).join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * Nearest-rank percentile over an ascending-sorted array (task 8 brief's exact
 * formula): `sorted[max(0, ceil(fraction * n) - 1)]`.
 */
export function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}
