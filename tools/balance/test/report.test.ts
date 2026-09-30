import { expect, test } from 'vitest';
import { benchmark, classifyShort } from '../src/benchmark';
import { csvCell, percentile, writeCsv } from '../src/csv';
import { emptyDropMetrics } from '@narok/sim';
import { buildLabInput, classMultisets, formatWaits, runBatch, runMatrix } from '../src/run';
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
    items_rolled_common: 0,
    items_rolled_uncommon: 0,
    items_rolled_rare: 0,
    items_rolled_epic: 0,
    items_rolled_legendary: 0,
    items_kept: 0,
    items_autosold: 0,
    drops_lost: 0,
    first_drop_ms: null,
    first_drop_rarity: null,
    epic_wait_kills: '',
    legendary_wait_kills: '',
    drop_protection: { epicPlus: 0, legendary: 0 },
    metrics: {
      kills: 0, wins: 0, wipes: 0, rawExp: 0, rawGold: 0, damageDealt: 0, effectiveHealing: 0,
      walkMs: 1000, fightMs: 0, restMs: 0, respawnMs: 0, actors: {}, drops: emptyDropMetrics(),
    },
  };
  const csv = writeCsv([row]);
  const lines = csv.trim().split('\n');
  expect(lines[0]).toBe(
    'simulation_version,content_version,seed,roster,recipe,placement,requested_ms,elapsed_ms,' +
      'stop_reason,kills,wins,wipes,rest_ms,walk_ms,fight_ms,raw_exp,raw_gold,damage_dealt,' +
      'effective_healing,kills_per_hour,items_rolled_common,items_rolled_uncommon,items_rolled_rare,' +
      'items_rolled_epic,items_rolled_legendary,items_kept,items_autosold,drops_lost,first_drop_ms,' +
      'first_drop_rarity,epic_wait_kills,legendary_wait_kills',
  );
  expect(lines[1]).toContain('"guardian,cleric,ranger"');
  expect(lines[1]).toContain('"p0:2,3"');
  // stop_reason (null) and kills_per_hour (null) both render as empty fields.
  expect(lines[1]).toBe(
    'a1,c1,1,"guardian,cleric,ranger",mixed,"p0:2,3",1000,1000,,0,0,0,0,1000,0,0,0,0,0,,0,0,0,0,0,0,0,0,,,,',
  );
});

// --- drop columns (task 6; layer-1 §12) ---

test('waits are reported per seed as the distribution of completed waits plus the open one, never a mean', () => {
  expect(formatWaits([], 0)).toBe('');
  expect(formatWaits([], 37)).toBe('>37');
  expect(formatWaits([412, 1_033], 0)).toBe('412;1033');
  expect(formatWaits([412, 1_033], 77)).toBe('412;1033;>77');
});

test('a run reports its drops from the simulation state, one row per seed', () => {
  const rows = runBatch(buildLabInput(1, ['guardian', 'cleric', 'ranger'], 'mixed', 'default'), [1, 2], 3_600_000);
  for (const row of rows) {
    const drops = row.metrics.drops;
    expect([
      row.items_rolled_common, row.items_rolled_uncommon, row.items_rolled_rare,
      row.items_rolled_epic, row.items_rolled_legendary,
    ]).toEqual([drops.rolled.common, drops.rolled.uncommon, drops.rolled.rare, drops.rolled.epic, drops.rolled.legendary]);
    expect(row.items_kept).toBe(drops.kept);
    expect(row.items_autosold).toBe(drops.autoSold);
    expect(row.drops_lost).toBe(drops.lost);
    expect(row.first_drop_ms).toBe(drops.firstDropMs);
    expect(row.first_drop_rarity).toBe(drops.firstDropRarity);
    expect(row.epic_wait_kills).toBe(formatWaits(drops.epicPlusWaits, row.drop_protection.epicPlus));
    expect(row.legendary_wait_kills).toBe(formatWaits(drops.legendaryWaits, row.drop_protection.legendary));
    // Every kill of an equipment-dropping monster is one opportunity: the open
    // wait plus the completed ones account for every kill.
    const epicKills = drops.epicPlusWaits.reduce((sum, wait) => sum + wait, 0) + row.drop_protection.epicPlus;
    expect(epicKills).toBe(row.kills);
    expect(row.items_rolled_common + row.items_rolled_uncommon).toBeGreaterThan(0);
  }
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
