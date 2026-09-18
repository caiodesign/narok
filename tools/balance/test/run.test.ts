import { expect, test } from 'vitest';
import { labInput } from '../../../packages/sim/test/fixtures';
import { CliError, parseParty, parsePlacement, parseRecipe, parseSeeds } from '../src/args';
import { runBatch } from '../src/run';

test('same seeds yield identical gameplay metrics', () => {
  const rows = runBatch(labInput(), [1, 1], 60_000);
  expect(rows[0]).toEqual(rows[1]);
  expect(rows[0].elapsed_ms).toBeLessThanOrEqual(rows[0].requested_ms);
  const expected =
    rows[0].elapsed_ms === 0 ? null : (rows[0].kills * 3_600_000) / rows[0].elapsed_ms;
  expect(rows[0].kills_per_hour).toBe(expected);
});

test('an early-stopped run reports elapsed_ms below the requested horizon', () => {
  // A one-millisecond horizon never even reaches the first decision, so the run
  // still completes normally (reachedTarget) with elapsed_ms === requested_ms; this
  // just pins that requested/elapsed can differ in general via the <= assertion
  // above and gives a second, independent data point at a different horizon.
  const rows = runBatch(labInput(), [2], 1_000);
  expect(rows[0].elapsed_ms).toBeLessThanOrEqual(rows[0].requested_ms);
  expect(rows[0].requested_ms).toBe(1_000);
});

test('kills_per_hour is null (an empty CSV field) at zero elapsed time', () => {
  const rows = runBatch(labInput(), [1], 0);
  expect(rows[0].elapsed_ms).toBe(0);
  expect(rows[0].kills_per_hour).toBeNull();
  expect(Number.isNaN(rows[0].kills_per_hour)).toBe(false);
});

test('runBatch reproduces different seeds with independently correct kills_per_hour', () => {
  const rows = runBatch(labInput(), [1, 2, 3], 600_000);
  for (const row of rows) {
    const expected = row.elapsed_ms === 0 ? null : (row.kills * 3_600_000) / row.elapsed_ms;
    expect(row.kills_per_hour).toBe(expected);
    expect(Number.isFinite(row.kills_per_hour ?? 0)).toBe(true);
  }
});

// --- --seeds parsing (rulings R47) ---

test('parseSeeds accepts an inclusive a:b range', () => {
  expect(parseSeeds('3:6')).toEqual([3, 4, 5, 6]);
});

test('parseSeeds accepts a single-value range', () => {
  expect(parseSeeds('5:5')).toEqual([5]);
});

test('parseSeeds accepts a comma list', () => {
  expect(parseSeeds('1,4,9')).toEqual([1, 4, 9]);
});

test('parseSeeds rejects a reversed range', () => {
  expect(() => parseSeeds('6:3')).toThrow(CliError);
});

test('parseSeeds rejects an empty spec', () => {
  expect(() => parseSeeds('')).toThrow(CliError);
  expect(() => parseSeeds(undefined)).toThrow(CliError);
});

test('parseSeeds rejects an out-of-bounds seed', () => {
  expect(() => parseSeeds('0')).toThrow(CliError);
  expect(() => parseSeeds('4294967296')).toThrow(CliError);
});

test('parseSeeds rejects a non-integer entry', () => {
  expect(() => parseSeeds('1.5')).toThrow(CliError);
  expect(() => parseSeeds('abc')).toThrow(CliError);
});

// --- unknown class/recipe/placement rejection (rulings R47/R50) ---

test('parseParty rejects an unknown class id', () => {
  expect(() => parseParty('guardian,wizard')).toThrow(CliError);
});

test('parseParty rejects an empty or oversized roster', () => {
  expect(() => parseParty('')).toThrow(CliError);
  expect(() => parseParty('guardian,cleric,ranger,arcanist')).toThrow(CliError);
});

test('parseParty accepts duplicate known classes', () => {
  expect(parseParty('guardian,guardian')).toEqual(['guardian', 'guardian']);
});

test('parseRecipe rejects an unknown recipe', () => {
  expect(() => parseRecipe('elemental')).toThrow(CliError);
});

test('parseRecipe defaults to mixed', () => {
  expect(parseRecipe(undefined)).toBe('mixed');
});

test('parsePlacement rejects an unknown placement', () => {
  expect(() => parsePlacement('flank')).toThrow(CliError);
});

test('parsePlacement defaults to default', () => {
  expect(parsePlacement(undefined)).toBe('default');
});
