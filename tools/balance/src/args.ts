import type { ClassId, RecipeId } from '@narok/data';
import type { CliRecipe, PlacementName } from './types';

/** Thrown for any invalid CLI input; the CLI catches this and prints one stderr line. */
export class CliError extends Error {}

const CLASS_IDS: readonly ClassId[] = ['guardian', 'cleric', 'ranger', 'arcanist'];
const RECIPE_IDS: readonly CliRecipe[] = ['melee', 'ranged', 'clustered', 'mixed'];
const MATRIX_RECIPE_IDS: readonly RecipeId[] = ['melee', 'ranged', 'clustered'];
const PLACEMENT_NAMES: readonly PlacementName[] = ['default', 'front', 'spread'];
const MAX_HOURS = 168;
const MAX_SEED = 4_294_967_295;

/**
 * `--seeds <a:b | a,b,c>` (rulings R47): an inclusive `a:b` range or a comma list,
 * every seed an integer in `1..4,294,967,295`; empty input, a reversed range, or any
 * out-of-bounds/non-integer entry is rejected.
 */
export function parseSeeds(spec: string | undefined): number[] {
  if (spec === undefined || spec.trim() === '') {
    throw new CliError('--seeds is required');
  }
  const checkSeed = (value: number, raw: string): number => {
    if (!Number.isInteger(value) || value < 1 || value > MAX_SEED) {
      throw new CliError(`--seeds: "${raw}" is not an integer in 1..${MAX_SEED}`);
    }
    return value;
  };

  if (spec.includes(':')) {
    const parts = spec.split(':');
    if (parts.length !== 2) throw new CliError(`--seeds: invalid range "${spec}"`);
    const [rawStart, rawEnd] = parts;
    const start = checkSeed(Number(rawStart), rawStart);
    const end = checkSeed(Number(rawEnd), rawEnd);
    if (end < start) throw new CliError(`--seeds: reversed range "${spec}"`);
    const seeds: number[] = [];
    for (let value = start; value <= end; value++) seeds.push(value);
    return seeds;
  }

  const seeds = spec.split(',').map((raw) => checkSeed(Number(raw), raw));
  if (seeds.length === 0) throw new CliError('--seeds is required');
  return seeds;
}

/**
 * `--hours <number>` (rulings R47): a positive finite number, possibly fractional,
 * rejected above 168 hours (one week). `requestedMs = round(hours * 3,600,000)`.
 */
export function parseHours(spec: string | undefined): number {
  if (spec === undefined) throw new CliError('--hours is required');
  const hours = Number(spec);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new CliError(`--hours: "${spec}" is not a positive finite number`);
  }
  if (hours > MAX_HOURS) {
    throw new CliError(`--hours: "${spec}" exceeds the ${MAX_HOURS} hour maximum`);
  }
  return hours;
}

/** `--hours <a,b,...>` for `benchmark` (rulings R47): a comma list, each hour value validated. */
export function parseHoursList(spec: string | undefined): number[] {
  if (spec === undefined || spec.trim() === '') throw new CliError('--hours is required');
  return spec.split(',').map((raw) => parseHours(raw));
}

/** `requestedMs = round(hours * 3,600,000)` (rulings R47). */
export function hoursToMs(hours: number): number {
  return Math.round(hours * 3_600_000);
}

/** `--party <classIds>` (rulings R47): 1–3 known class ids, comma-separated, duplicates allowed. */
export function parseParty(spec: string | undefined): ClassId[] {
  if (spec === undefined || spec.trim() === '') throw new CliError('--party is required');
  const classes = spec.split(',').map((raw) => {
    const trimmed = raw.trim();
    if (!(CLASS_IDS as readonly string[]).includes(trimmed)) {
      throw new CliError(`--party: unknown class "${raw}"`);
    }
    return trimmed as ClassId;
  });
  if (classes.length < 1 || classes.length > 3) {
    throw new CliError('--party: expected 1 to 3 classes');
  }
  return classes;
}

/** `--recipe <melee|ranged|clustered|mixed>` (rulings R47), default `mixed`. */
export function parseRecipe(spec: string | undefined): CliRecipe {
  const value = spec ?? 'mixed';
  if (!(RECIPE_IDS as readonly string[]).includes(value)) {
    throw new CliError(`--recipe: expected one of ${RECIPE_IDS.join(', ')}, got "${value}"`);
  }
  return value as CliRecipe;
}

/** `matrix`'s three fixed recipes never include `mixed` (spec §12); reused for validation elsewhere. */
export function matrixRecipes(): readonly RecipeId[] {
  return MATRIX_RECIPE_IDS;
}

/** `--placement <default|front|spread>` (rulings R47), default `default`. */
export function parsePlacement(spec: string | undefined): PlacementName {
  const value = spec ?? 'default';
  if (!(PLACEMENT_NAMES as readonly string[]).includes(value)) {
    throw new CliError(`--placement: expected one of ${PLACEMENT_NAMES.join(', ')}, got "${value}"`);
  }
  return value as PlacementName;
}

/** `--out <path>` (rulings R47): required for `run`/`matrix`/`benchmark`. */
export function parseOut(spec: string | undefined): string {
  if (spec === undefined || spec.trim() === '') throw new CliError('--out is required');
  return spec;
}

/** `--runs <n>` (rulings R47): a positive integer. */
export function parseRuns(spec: string | undefined): number {
  if (spec === undefined) throw new CliError('--runs is required');
  const runs = Number(spec);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new CliError(`--runs: "${spec}" is not a positive integer`);
  }
  return runs;
}
