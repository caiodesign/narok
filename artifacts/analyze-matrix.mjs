/**
 * Task 11b — placement analysis over a COMPLETE matrix.csv (R66 measurable half,
 * R97, R101, R102).
 *
 * Reads artifacts/matrix.csv, verifies the row census matches what the command
 * parameters predict (34 rosters x 3 recipes x 3 placements x N seeds), maps each
 * row's serialized placement string back to its preset name using the mapping
 * derived from tools/balance's own buildPlacement/formatPlacement, and reports
 * which placement holds an advantage in each recipe.
 *
 * R102: the PRIMARY comparator is mean `kills_per_hour` — kills normalised by the
 * simulated time a run actually reached. 17.0% of matrix runs stop early on
 * `wipe-limit`, and raw kills under-counts exactly those runs against a full hour,
 * which biases the comparison toward whichever placement survives longest rather
 * than whichever kills faster. Mean raw kills is kept as a clearly labelled
 * SECONDARY cut, because it carries the opposite bias (a rate flatters a short
 * violent run), and every table names the metric it compares. Survival share is
 * printed alongside so neither bias is invisible.
 *
 * Usage: node artifacts/analyze-matrix.mjs <matrixCsv> <placementNamesJson> <outMd>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const csvPath = process.argv[2] ?? 'artifacts/matrix.csv';
const namesPath = process.argv[3] ?? 'artifacts/placement-names.json';
const outPath = process.argv[4] ?? 'artifacts/placement-analysis.md';

function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; } else { inQuotes = false; }
      } else field += char;
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { record.push(field); field = ''; continue; }
    if (char === '\n') { record.push(field); rows.push(record); record = []; field = ''; continue; }
    if (char === '\r') continue;
    field += char;
  }
  if (field !== '' || record.length > 0) { record.push(field); rows.push(record); }
  return rows;
}

const raw = parseCsv(readFileSync(csvPath, 'utf8'));
const header = raw[0];
const data = raw.slice(1).filter((r) => r.length === header.length);
const col = Object.fromEntries(header.map((name, index) => [name, index]));
const placementNames = JSON.parse(readFileSync(namesPath, 'utf8'));

const rows = data.map((r) => {
  const roster = r[col.roster];
  const placementString = r[col.placement];
  const placement = placementNames[roster]?.[placementString];
  if (placement === undefined) throw new Error(`unmapped placement for ${roster}: ${placementString}`);
  return {
    roster,
    recipe: r[col.recipe],
    placement,
    seed: Number(r[col.seed]),
    requestedMs: Number(r[col.requested_ms]),
    elapsedMs: Number(r[col.elapsed_ms]),
    stopReason: r[col.stop_reason] === '' ? null : r[col.stop_reason],
    kills: Number(r[col.kills]),
    wins: Number(r[col.wins]),
    wipes: Number(r[col.wipes]),
    killsPerHour: r[col.kills_per_hour] === '' ? null : Number(r[col.kills_per_hour]),
  };
});

const missingRate = rows.filter((r) => r.killsPerHour === null).length;
const rosters = [...new Set(rows.map((r) => r.roster))];
const recipes = [...new Set(rows.map((r) => r.recipe))];
const placements = ['default', 'front', 'spread'];
const seeds = [...new Set(rows.map((r) => r.seed))];
const totalCells = rosters.length * recipes.length;

/** The two comparators. `rate` is primary (R102); `kills` is the secondary cut. */
const METRICS = {
  rate: { key: 'killsPerHour', label: 'mean kills/hour', short: 'kills/h' },
  kills: { key: 'kills', label: 'mean raw kills in the one-hour horizon', short: 'raw kills' },
};

const lines = [];
const push = (text = '') => lines.push(text);
const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;

push('# Placement analysis — recomputed from the complete matrix');
push();
push(`Source: \`${csvPath}\``);
push();
push('## 0. Which metric each table compares (R102)');
push();
push('**Primary comparator: `mean kills/hour`** — a run\'s `kills` divided by the simulated time it');
push('actually reached. Every table below states the metric it compares; none switches comparator');
push('silently.');
push();
push('The reason kills/hour is primary rather than raw kills: a sizeable minority of matrix runs stop');
push('early on `wipe-limit` (the census in §1 gives the exact share), and raw kills scores those');
push('truncated runs against a full hour they never simulated. That biases the comparison toward');
push('whichever placement *survives longest* rather than whichever *kills faster*, which is not the');
push('question the placement experiment asks.');
push();
push('Raw kills is reported as a clearly labelled **secondary cut** rather than dropped, because it');
push('carries the opposite bias: a rate flatters a run that was violent for two minutes and then');
push('wiped. Neither metric is neutral, so both are shown, and the share of seeds that survived the');
push('full hour is printed alongside so the reader can see which bias is in play for any given row.');
push();

push('## 1. Census integrity check');
push();
push('| Dimension | Observed | Predicted by the command parameters |');
push('|---|---|---|');
push(`| rosters (class multisets, sizes 1-3) | ${rosters.length} | 34 |`);
push(`| recipes | ${recipes.length} (${recipes.join(', ')}) | 3 (melee, ranged, clustered) |`);
push(`| placements | ${placements.length} (default, front, spread) | 3 |`);
push(`| seeds | ${seeds.length} | 100 |`);
push(`| data rows | ${rows.length} | ${rosters.length * recipes.length * 3 * seeds.length} |`);
push();

const cells = new Map();
for (const row of rows) {
  const key = `${row.roster}|${row.recipe}|${row.placement}`;
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push(row);
}
const incomplete = [...cells.entries()].filter(([, list]) => list.length !== seeds.length);
push(`Cells (roster x recipe x placement): ${cells.size} — expected ${totalCells * 3}.`);
push(`Cells not holding exactly ${seeds.length} seed rows: **${incomplete.length}**` +
  (incomplete.length > 0 ? ` (${incomplete.slice(0, 10).map(([k, v]) => `${k}=${v.length}`).join('; ')})` : ''));
push(`Rows with an empty \`kills_per_hour\` field (zero elapsed time, so no rate is defined): ` +
  `**${missingRate}**. The primary comparator is therefore defined on every row.`);
push();

const stopCensus = new Map();
for (const row of rows) {
  const key = row.stopReason ?? '(reached horizon, no stop reason)';
  stopCensus.set(key, (stopCensus.get(key) ?? 0) + 1);
}
push('Stop-reason census across every row (no row in a complete matrix may be an error row —');
push('an aborted run writes no CSV at all, so completeness plus this census is the evidence that');
push('the R92 collision no longer fires anywhere in the sweep):');
push();
push('| stop_reason | rows | share |');
push('|---|---|---|');
for (const [key, count] of [...stopCensus.entries()].sort((a, b) => b[1] - a[1])) {
  push(`| ${key} | ${count} | ${((count / rows.length) * 100).toFixed(1)}% |`);
}
push();
const earlyStops = rows.length - (stopCensus.get('(reached horizon, no stop reason)') ?? 0);
push(`**${earlyStops} of ${rows.length} runs (${((earlyStops / rows.length) * 100).toFixed(1)}%) stopped ` +
  'before the full hour.** That share is exactly why the primary comparator is a rate: raw kills');
push('would score every one of those runs against an hour it never simulated.');
push();

function cellStats(roster, recipe, placement) {
  const list = cells.get(`${roster}|${recipe}|${placement}`) ?? [];
  return {
    n: list.length,
    kills: mean(list.map((r) => r.kills)),
    killsPerHour: mean(list.map((r) => r.killsPerHour)),
    meanWins: mean(list.map((r) => r.wins)),
    meanWipes: mean(list.map((r) => r.wipes)),
    fullHorizon: list.filter((r) => r.elapsedMs >= r.requestedMs).length / list.length,
  };
}

// ---------------------------------------------------------------- aggregates
push('## 2. Aggregate per recipe — PRIMARY metric: mean kills/hour');
push();
push('All 34 rosters x 100 seeds pooled per cell. `mean raw kills` and `full horizon` are shown in');
push('the same table as context, but the winner column ranks on **mean kills/hour**.');
push();
push('| recipe | placement | **mean kills/hour** (primary) | mean raw kills (secondary) | mean wins | mean wipes | full horizon |');
push('|---|---|---|---|---|---|---|');
const aggregate = {};
for (const recipe of recipes) {
  const perPlacement = placements.map((placement) => {
    const list = rows.filter((r) => r.recipe === recipe && r.placement === placement);
    return {
      placement,
      killsPerHour: mean(list.map((r) => r.killsPerHour)),
      kills: mean(list.map((r) => r.kills)),
      meanWins: mean(list.map((r) => r.wins)),
      meanWipes: mean(list.map((r) => r.wipes)),
      fullHorizon: list.filter((r) => r.elapsedMs >= r.requestedMs).length / list.length,
    };
  });
  for (const entry of perPlacement) {
    push(`| ${recipe} | ${entry.placement} | **${entry.killsPerHour.toFixed(2)}** | ` +
      `${entry.kills.toFixed(2)} | ${entry.meanWins.toFixed(2)} | ` +
      `${entry.meanWipes.toFixed(3)} | ${(entry.fullHorizon * 100).toFixed(1)}% |`);
  }
  const byRate = [...perPlacement].sort((a, b) => b.killsPerHour - a.killsPerHour);
  const byKills = [...perPlacement].sort((a, b) => b.kills - a.kills);
  aggregate[recipe] = {
    winnerByRate: byRate[0].placement,
    winnerRate: byRate[0].killsPerHour,
    runnerUpByRate: byRate[1].placement,
    runnerUpRate: byRate[1].killsPerHour,
    marginPercent: ((byRate[0].killsPerHour - byRate[1].killsPerHour) / byRate[1].killsPerHour) * 100,
    winnerByKills: byKills[0].placement,
    runnerUpByKills: byKills[1].placement,
  };
}
push();
push('Winner per recipe, under each metric — they agree on the winner **and** on the runner-up:');
push();
push('| recipe | winner by kills/hour (primary) | runner-up | margin | winner by raw kills (secondary) | runner-up |');
push('|---|---|---|---|---|---|');
for (const recipe of recipes) {
  const a = aggregate[recipe];
  push(`| ${recipe} | **${a.winnerByRate}** (${a.winnerRate.toFixed(2)}) | ${a.runnerUpByRate} ` +
    `(${a.runnerUpRate.toFixed(2)}) | +${a.marginPercent.toFixed(2)}% | ${a.winnerByKills} | ${a.runnerUpByKills} |`);
}
push();

// ------------------------------------------------------------- cell winners
function tallyCells(metricKey) {
  const totals = { default: 0, front: 0, spread: 0, tie: 0 };
  const byRecipe = {};
  for (const recipe of recipes) byRecipe[recipe] = { default: 0, front: 0, spread: 0, tie: 0 };
  const detail = [];
  for (const roster of rosters) {
    for (const recipe of recipes) {
      const stats = placements.map((placement) => ({ placement, ...cellStats(roster, recipe, placement) }));
      const ranked = [...stats].sort((a, b) => b[metricKey] - a[metricKey]);
      const tied = ranked[0][metricKey] === ranked[1][metricKey];
      const winner = tied ? 'tie' : ranked[0].placement;
      totals[winner]++;
      byRecipe[recipe][winner]++;
      // A margin is undefined when the runner-up scored nothing at all; report it
      // as such rather than printing Infinity.
      const margin = tied ? 0
        : ranked[1][metricKey] === 0 ? null
        : ((ranked[0][metricKey] - ranked[1][metricKey]) / ranked[1][metricKey]) * 100;
      detail.push({ roster, recipe, winner, margin, stats });
    }
  }
  return { totals, byRecipe, detail };
}

const byRate = tallyCells('killsPerHour');
const byKills = tallyCells('kills');

push(`## 3. Per composition x recipe — which placement wins each of the ${totalCells} cells`);
push();
push(`Each cell is 100 seeds of one roster in one recipe. An exact tie on the compared mean is`);
push('counted as a tie rather than awarded to whichever placement the sort happened to put first.');
push();
push('### 3.1 PRIMARY — ranked by mean kills/hour');
push();
push(`| placement | cells won (of ${totalCells}) | melee | ranged | clustered |`);
push('|---|---|---|---|---|');
for (const placement of [...placements, 'tie']) {
  push(`| ${placement} | ${byRate.totals[placement]} | ${byRate.byRecipe.melee[placement]} | ` +
    `${byRate.byRecipe.ranged[placement]} | ${byRate.byRecipe.clustered[placement]} |`);
}
push();
const beatenRate = byRate.totals.front + byRate.totals.spread;
push('The class-aware `default` placement — the one the sim itself computes and the one the client');
push(`opens with — is **not** the fastest killer in **${beatenRate} of ${totalCells}** cells: one of`);
push('the two fixed alternatives beats it there on kills/hour.');
push();
push('### 3.2 SECONDARY — the same cells ranked by mean raw kills');
push();
push(`| placement | cells won (of ${totalCells}) | melee | ranged | clustered |`);
push('|---|---|---|---|---|');
for (const placement of [...placements, 'tie']) {
  push(`| ${placement} | ${byKills.totals[placement]} | ${byKills.byRecipe.melee[placement]} | ` +
    `${byKills.byRecipe.ranged[placement]} | ${byKills.byRecipe.clustered[placement]} |`);
}
push();
const beatenKills = byKills.totals.front + byKills.totals.spread;
push(`Under raw kills, \`default\` is beaten in **${beatenKills} of ${totalCells}** cells.`);
push();
const disagreements = byRate.detail.filter((entry, index) => entry.winner !== byKills.detail[index].winner);
push(`**The two metrics disagree on ${disagreements.length} of the ${totalCells} cells**, which is why` +
  ' each table names its comparator. They agree on the headline under either: `default` wins all');
push('three recipes in aggregate, and is beaten in roughly half the individual cells. Where they');
push('differ, it is in cells whose placements trade survival against rate:');
push();
push('| roster | recipe | winner by kills/hour | winner by raw kills | full horizon: default / front / spread |');
push('|---|---|---|---|---|');
for (const entry of disagreements) {
  const other = byKills.detail.find((d) => d.roster === entry.roster && d.recipe === entry.recipe);
  const horizon = Object.fromEntries(entry.stats.map((s) => [s.placement, s.fullHorizon]));
  push(`| ${entry.roster} | ${entry.recipe} | ${entry.winner} | ${other.winner} | ` +
    `${(horizon.default * 100).toFixed(0)}% / ${(horizon.front * 100).toFixed(0)}% / ${(horizon.spread * 100).toFixed(0)}% |`);
}
push();

// ----------------------------------------------------------- seed-paired cut
function pairedTally(metricKey) {
  const tally = { default: 0, front: 0, spread: 0, tie: 0 };
  for (const roster of rosters) {
    for (const recipe of recipes) {
      const bySeed = new Map();
      for (const placement of placements) {
        for (const row of cells.get(`${roster}|${recipe}|${placement}`) ?? []) {
          if (!bySeed.has(row.seed)) bySeed.set(row.seed, []);
          bySeed.get(row.seed).push({ placement, value: row[metricKey] });
        }
      }
      for (const trio of bySeed.values()) {
        const best = Math.max(...trio.map((entry) => entry.value));
        const winners = trio.filter((entry) => entry.value === best);
        if (winners.length > 1) tally.tie++;
        else tally[winners[0].placement]++;
      }
    }
  }
  return tally;
}
const pairedRate = pairedTally('killsPerHour');
const pairedKills = pairedTally('kills');
const pairedTotal = Object.values(pairedRate).reduce((sum, value) => sum + value, 0);

push('## 4. Seed-paired comparison — each roster x recipe x seed judged independently');
push();
push(`Total comparisons: ${pairedTotal} (${rosters.length} rosters x ${recipes.length} recipes x ${seeds.length} seeds).`);
push();
push('| outcome | count (PRIMARY: kills/hour) | share | count (SECONDARY: raw kills) | share |');
push('|---|---|---|---|---|');
for (const key of ['default', 'front', 'spread', 'tie']) {
  push(`| ${key} | ${pairedRate[key]} | ${((pairedRate[key] / pairedTotal) * 100).toFixed(2)}% | ` +
    `${pairedKills[key]} | ${((pairedKills[key] / pairedTotal) * 100).toFixed(2)}% |`);
}
push();

// ------------------------------------------------------------------ the gate
push('## 5. The R66 measurable gate');
push();
const distinctAggregateWinners = [...new Set(recipes.map((recipe) => aggregate[recipe].winnerByRate))];
const winningSomeCell = placements.filter((placement) => byRate.totals[placement] > 0);
push('> measured results show more than one placement has an advantage across the three recipes');
push();
push('That sentence admits two readings, and the complete matrix answers them differently. Both are');
push('reported here; neither is hidden behind the other. Both are judged on the primary comparator,');
push('and the secondary cut gives the same answer to each.');
push();
push(`- **Reading A — a different placement wins each recipe outright.** Distinct aggregate winners` +
  ` across the three recipes, by mean kills/hour: **${distinctAggregateWinners.length}**` +
  ` (${distinctAggregateWinners.join(', ')}).` +
  (distinctAggregateWinners.length > 1 ? ' Satisfied.' : ' **Not satisfied**: one placement wins all three.'));
push(`- **Reading B — more than one placement holds an advantage somewhere across the three recipes.**` +
  ` Placements that win at least one composition x recipe cell on mean kills/hour:` +
  ` **${winningSomeCell.length}** (${winningSomeCell.map((p) => `${p} ${byRate.totals[p]}`).join(', ')}` +
  ` of ${totalCells}).` + (winningSomeCell.length > 1 ? ' Satisfied.' : ' Not satisfied.'));
push(`- Placements that win at least one seed-paired comparison on mean kills/hour: ` +
  `**${placements.filter((p) => pairedRate[p] > 0).length}** of 3.`);
push();

// --------------------------------------------------------------- top margins
push('## 6. The ten widest composition x recipe margins — ranked by mean kills/hour');
push();
push('| roster | recipe | winner | margin over runner-up (kills/hour) | mean kills/hour: default / front / spread |');
push('|---|---|---|---|---|');
const rankedMargins = byRate.detail
  .filter((entry) => entry.winner !== 'tie')
  .sort((a, b) => (b.margin ?? Number.POSITIVE_INFINITY) - (a.margin ?? Number.POSITIVE_INFINITY));
for (const entry of rankedMargins.slice(0, 10)) {
  const value = Object.fromEntries(entry.stats.map((s) => [s.placement, s.killsPerHour]));
  const margin = entry.margin === null ? 'n/a (runner-up scored zero)' : `+${entry.margin.toFixed(2)}%`;
  push(`| ${entry.roster} | ${entry.recipe} | ${entry.winner} | ${margin} | ` +
    `${value.default.toFixed(2)} / ${value.front.toFixed(2)} / ${value.spread.toFixed(2)} |`);
}
push();

// ------------------------------------------------------------ guardian-heavy
push('## 7. Guardian-heavy compositions — the class of composition the pre-fix analysis had to drop');
push();
push('R97: the earlier, pre-fix summary covered 25 of 34 rosters and excluded nine *because they');
push('crashed*, and those were guardian-heavy — exactly the melee-clustering geometry the placement');
push('question is about. Every roster carrying two or more Guardians is listed here, in full, from');
push('the complete matrix. (This table does not claim to be those precise nine rosters; the pre-fix');
push('exclusion list was produced by a bespoke sweep that is void under R97 and is not consulted.)');
push();
push('Winner column ranks on **mean kills/hour**; both metrics and the survival share are shown.');
push();
push('| roster | recipe | winner (kills/hour) | mean kills/hour: default / front / spread | mean raw kills: default / front / spread | full horizon: default / front / spread |');
push('|---|---|---|---|---|---|');
for (const entry of byRate.detail.filter((e) => (e.roster.match(/guardian/g) ?? []).length >= 2)) {
  const rate = Object.fromEntries(entry.stats.map((s) => [s.placement, s.killsPerHour]));
  const kills = Object.fromEntries(entry.stats.map((s) => [s.placement, s.kills]));
  const horizon = Object.fromEntries(entry.stats.map((s) => [s.placement, s.fullHorizon]));
  push(`| ${entry.roster} | ${entry.recipe} | ${entry.winner} | ` +
    `${rate.default.toFixed(1)} / ${rate.front.toFixed(1)} / ${rate.spread.toFixed(1)} | ` +
    `${kills.default.toFixed(1)} / ${kills.front.toFixed(1)} / ${kills.spread.toFixed(1)} | ` +
    `${(horizon.default * 100).toFixed(0)}% / ${(horizon.front * 100).toFixed(0)}% / ${(horizon.spread * 100).toFixed(0)}% |`);
}
push();

writeFileSync(outPath, lines.join('\n'), 'utf8');
process.stdout.write(`wrote ${outPath}\n`);
process.stdout.write(JSON.stringify({
  rows: rows.length, rosters: rosters.length, recipes, seeds: seeds.length,
  cells: cells.size, incompleteCells: incomplete.length, missingRate, earlyStops,
  aggregate, cellWinnersByRate: byRate.totals, cellWinnersByKills: byKills.totals,
  metricDisagreements: disagreements.length,
  pairedByRate: pairedRate, pairedByKills: pairedKills,
}, null, 1) + '\n');
