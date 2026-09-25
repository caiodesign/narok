import { expect, test } from 'vitest';
import { benchmark, classifyShort } from '../src/benchmark';
import { csvCell, percentile, writeCsv } from '../src/csv';
import { classMultisets, runMatrix } from '../src/run';
import type { RunResult } from '../src/types';

// --- CSV quote escaping (rulings R50) ---

test('csvCell wraps a field containing a comma and a quote, doubling the quote', () => {
  expect(csvCell('He said "hi", ok')).toBe('"He said ""hi"", ok"');
});

test('csvCell leaves a plain field untouched', () => {
  expect(csvCell('mixed')).toBe('mixed');
  expect(csvCell(42)).toBe('42');
});

test('csvCell renders null as an empty field', () => {
  expect(csvCell(null)).toBe('');
});

test('csvCell refuses a non-finite number', () => {
  expect(() => csvCell(Number.NaN)).toThrow();
  expect(() => csvCell(Number.POSITIVE_INFINITY)).toThrow();
});

test('writeCsv quotes a roster field naturally, since it always joins with commas', () => {
  const row: RunResult = {
    simulation_version: 'a1',
    content_version: 'c1',
    seed: 1,
    roster: 'guardian,cleric,ranger',
    recipe: 'mixed',
    placement: 'p0:2,3',
    requested_ms: 1000,
    elapsed_ms: 1000,
    stop_reason: null,
    kills: 0,
    wins: 0,
    wipes: 0,
    rest_ms: 0,
    walk_ms: 1000,
    fight_ms: 0,
    raw_exp: 0,
    raw_gold: 0,
    damage_dealt: 0,
    effective_healing: 0,
    kills_per_hour: null,
    metrics: {
      kills: 0, wins: 0, wipes: 0, rawExp: 0, rawGold: 0, damageDealt: 0, effectiveHealing: 0,
      walkMs: 1000, fightMs: 0, restMs: 0, respawnMs: 0, actors: {},
    },
  };
  const csv = writeCsv([row]);
  const lines = csv.trim().split('\n');
  expect(lines[0]).toBe(
    'simulation_version,content_version,seed,roster,recipe,placement,requested_ms,elapsed_ms,' +
      'stop_reason,kills,wins,wipes,rest_ms,walk_ms,fight_ms,raw_exp,raw_gold,damage_dealt,' +
      'effective_healing,kills_per_hour',
  );
  expect(lines[1]).toContain('"guardian,cleric,ranger"');
  expect(lines[1]).toContain('"p0:2,3"');
  // stop_reason (null) and kills_per_hour (null) both render as empty fields.
  expect(lines[1]).toBe(
    'a1,c1,1,"guardian,cleric,ranger",mixed,"p0:2,3",1000,1000,,0,0,0,0,1000,0,0,0,0,0,',
  );
});

test('percentile uses the nearest-rank formula sorted[max(0, ceil(f*n)-1)]', () => {
  const sorted = [10, 20, 30, 40, 50];
  expect(percentile(sorted, 0.5)).toBe(30);
  expect(percentile(sorted, 0)).toBe(10);
  expect(percentile(sorted, 1)).toBe(50);
});

// --- exactly 34 multisets, stable order (rulings R48/R50) ---

test('classMultisets produces exactly 34 compositions', () => {
  expect(classMultisets()).toHaveLength(34);
});

test('classMultisets has no duplicate compositions and stays non-decreasing per class order', () => {
  const order = ['guardian', 'cleric', 'ranger', 'arcanist'];
  const seen = new Set<string>();
  for (const composition of classMultisets()) {
    const key = composition.join(',');
    expect(seen.has(key)).toBe(false);
    seen.add(key);
    const indexes = composition.map((id) => order.indexOf(id));
    for (let i = 1; i < indexes.length; i++) {
      expect(indexes[i]).toBeGreaterThanOrEqual(indexes[i - 1]);
    }
  }
});

test('classMultisets is ordered by size, then lexicographically by class index', () => {
  const multisets = classMultisets();
  expect(multisets.slice(0, 4)).toEqual([
    ['guardian'], ['cleric'], ['ranger'], ['arcanist'],
  ]);
  expect(multisets[4]).toEqual(['guardian', 'guardian']);
  expect(multisets[multisets.length - 1]).toEqual(['arcanist', 'arcanist', 'arcanist']);
  for (let i = 1; i < multisets.length; i++) {
    expect(multisets[i].length).toBeGreaterThanOrEqual(multisets[i - 1].length);
  }
});

test('runMatrix produces 34 x 3 recipes x 3 placements rows per seed', () => {
  const rows = runMatrix([1], 500);
  expect(rows).toHaveLength(34 * 3 * 3);
  const recipes = new Set(rows.map((row) => row.recipe));
  expect(recipes).toEqual(new Set(['melee', 'ranged', 'clustered']));
});

// --- short-run labelling (rulings R49/R50) ---

test('classifyShort marks a run that stopped before its requested horizon', () => {
  expect(classifyShort(10_000, 4_000)).toBe(true);
});

test('classifyShort does not mark a run that reached its full requested horizon', () => {
  expect(classifyShort(10_000, 10_000)).toBe(false);
});

// --- required benchmark metadata (rulings R49/R50) ---

test(
  'benchmark reports node/platform/cpu/memory/build metadata and separate gameplay/stress sections',
  async () => {
    const report = await benchmark([0.0002], 1);

    expect(typeof report.metadata.nodeVersion).toBe('string');
    expect(typeof report.metadata.platform).toBe('string');
    expect(typeof report.metadata.arch).toBe('string');
    expect(typeof report.metadata.cpuModel).toBe('string');
    expect(report.metadata.cpuCount).toBeGreaterThan(0);
    expect(report.metadata.totalMemoryBytes).toBeGreaterThan(0);
    expect(report.metadata.simulationVersion).toBe('b1');
    expect(typeof report.metadata.contentVersion).toBe('string');
    expect(typeof report.metadata.gridHash).toBe('string');
    expect(typeof report.metadata.commandLine).toBe('string');

    expect(report.gameplay).toHaveLength(1);
    expect(report.stress).toHaveLength(1);
    expect(report.gameplay[0].runs).toHaveLength(1);
    expect(report.gameplay[0].runs[0].fixture).toBe('gameplay');
    expect(report.stress[0].runs[0].fixture).toBe('engine-stress');
    for (const summary of [...report.gameplay, ...report.stress]) {
      expect(Number.isFinite(summary.wallMsPercentiles.p50)).toBe(true);
      expect(Number.isFinite(summary.peakRssBytesPercentiles.p50)).toBe(true);
    }
  },
  20_000,
);
