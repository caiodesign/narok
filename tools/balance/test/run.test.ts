import { expect, test } from 'vitest';
import { labInput } from '../../../packages/sim/test/fixtures';
import { CliError, parseHours, parseHoursList, parseParty, parsePlacement, parseRecipe, parseSeeds } from '../src/args';
import { classifyShort } from '../src/benchmark';
import { buildLabInput, runBatch } from '../src/run';

test('same seeds yield identical gameplay metrics', () => {
  const rows = runBatch(labInput(), [1, 1], 60_000);
  expect(rows[0]).toEqual(rows[1]);
  expect(rows[0].elapsed_ms).toBeLessThanOrEqual(rows[0].requested_ms);
  const expected =
    rows[0].elapsed_ms === 0 ? null : (rows[0].kills * 3_600_000) / rows[0].elapsed_ms;
  expect(rows[0].kills_per_hour).toBe(expected);
});

test('a solo cleric wipes against the melee recipe well before its 1 hour horizon', () => {
  // Ruling R73: a genuine early stop, not a synthetic one. A lone cleric (no tank
  // to hold threat, no offense of its own) reliably loses its single life to the
  // melee recipe. Confirmed deterministic and reproducible for seed 1: wipe
  // at nowMs 14,307 ms, well inside the requested 3,600,000 ms (1 hour) horizon —
  // proving `elapsed_ms` really is "the simulated nowMs reached, never the
  // requested horizon after an early stop" (rulings R48), and that `classifyShort`
  // agrees with a real early-stopped row rather than only synthetic numbers.
  const input = buildLabInput(1, ['cleric'], 'melee', 'default');
  const row = runBatch(input, [1], 3_600_000)[0];

  expect(row.stop_reason).toBe('wipe');
  expect(row.wipes).toBe(1);
  expect(row.elapsed_ms).toBe(14_307);
  expect(row.elapsed_ms).toBeLessThan(row.requested_ms);
  expect(classifyShort(row.requested_ms, row.elapsed_ms)).toBe(true);
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

// --- --hours bound: 168h for run/matrix, 24h for benchmark (rulings R47/R72) ---

test('parseHours (run/matrix) accepts up to 168 hours', () => {
  expect(parseHours('168')).toBe(168);
});

test('parseHours (run/matrix) rejects above 168 hours', () => {
  expect(() => parseHours('168.01')).toThrow(CliError);
});

test('parseHoursList (benchmark) accepts up to 24 hours, including spec §13\'s 12,24 evidence pair', () => {
  expect(parseHoursList('12,24')).toEqual([12, 24]);
});

test('parseHoursList (benchmark) rejects any value above the 24-hour engine-stress ceiling', () => {
  // The engine-stress fixture's encounter deadline is fixed at 24h + 1ms (contract
  // §6); benchmark always runs a stress sample at every requested horizon, so no
  // benchmark horizon may exceed 24h even though run/matrix allow up to 168
  // (ruling R72). A demonstrated real case: `--hours 25` used to produce a stress
  // record with stopReason "stalemate" and short: true instead of being rejected.
  expect(() => parseHoursList('25')).toThrow(CliError);
  expect(() => parseHoursList('12,25')).toThrow(CliError);
});

test('parseHoursList (benchmark) names the engine-stress 24-hour ceiling in its error', () => {
  expect(() => parseHoursList('25')).toThrow(/24-hour engine-stress/);
});
