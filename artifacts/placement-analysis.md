# Placement analysis — recomputed from the complete matrix

Source: `artifacts/matrix.csv`

## 0. Which metric each table compares (R102)

**Primary comparator: `mean kills/hour`** — a run's `kills` divided by the simulated time it
actually reached. Every table below states the metric it compares; none switches comparator
silently.

The reason kills/hour is primary rather than raw kills: a sizeable minority of matrix runs stop
early on `wipe-limit` (the census in §1 gives the exact share), and raw kills scores those
truncated runs against a full hour they never simulated. That biases the comparison toward
whichever placement *survives longest* rather than whichever *kills faster*, which is not the
question the placement experiment asks.

Raw kills is reported as a clearly labelled **secondary cut** rather than dropped, because it
carries the opposite bias: a rate flatters a run that was violent for two minutes and then
wiped. Neither metric is neutral, so both are shown, and the share of seeds that survived the
full hour is printed alongside so the reader can see which bias is in play for any given row.

## 1. Census integrity check

| Dimension | Observed | Predicted by the command parameters |
|---|---|---|
| rosters (class multisets, sizes 1-3) | 34 | 34 |
| recipes | 3 (melee, ranged, clustered) | 3 (melee, ranged, clustered) |
| placements | 3 (default, front, spread) | 3 |
| seeds | 100 | 100 |
| data rows | 30600 | 30600 |

Cells (roster x recipe x placement): 306 — expected 306.
Cells not holding exactly 100 seed rows: **0**
Rows with an empty `kills_per_hour` field (zero elapsed time, so no rate is defined): **0**. The primary comparator is therefore defined on every row.

Stop-reason census across every row (no row in a complete matrix may be an error row —
an aborted run writes no CSV at all, so completeness plus this census is the evidence that
the R92 collision no longer fires anywhere in the sweep):

| stop_reason | rows | share |
|---|---|---|
| (reached horizon, no stop reason) | 25399 | 83.0% |
| wipe-limit | 5201 | 17.0% |

**5201 of 30600 runs (17.0%) stopped before the full hour.** That share is exactly why the primary comparator is a rate: raw kills
would score every one of those runs against an hour it never simulated.

## 2. Aggregate per recipe — PRIMARY metric: mean kills/hour

All 34 rosters x 100 seeds pooled per cell. `mean raw kills` and `full horizon` are shown in
the same table as context, but the winner column ranks on **mean kills/hour**.

| recipe | placement | **mean kills/hour** (primary) | mean raw kills (secondary) | mean wins | mean wipes | full horizon |
|---|---|---|---|---|---|---|
| melee | default | **269.99** | 244.42 | 81.34 | 0.189 | 81.1% |
| melee | front | **250.83** | 219.26 | 72.93 | 0.256 | 74.4% |
| melee | spread | **240.40** | 210.66 | 70.07 | 0.228 | 77.2% |
| ranged | default | **315.78** | 283.23 | 94.25 | 0.151 | 84.9% |
| ranged | front | **291.46** | 258.28 | 85.94 | 0.181 | 81.9% |
| ranged | spread | **301.44** | 270.13 | 89.90 | 0.152 | 84.8% |
| clustered | default | **593.48** | 539.41 | 107.71 | 0.122 | 87.8% |
| clustered | front | **561.62** | 515.40 | 102.93 | 0.110 | 89.0% |
| clustered | spread | **577.02** | 519.87 | 103.78 | 0.140 | 86.0% |

Winner per recipe, under each metric — they agree on the winner **and** on the runner-up:

| recipe | winner by kills/hour (primary) | runner-up | margin | winner by raw kills (secondary) | runner-up |
|---|---|---|---|---|---|
| melee | **default** (269.99) | front (250.83) | +7.64% | default | front |
| ranged | **default** (315.78) | spread (301.44) | +4.75% | default | spread |
| clustered | **default** (593.48) | spread (577.02) | +2.85% | default | spread |

## 3. Per composition x recipe — which placement wins each of the 102 cells

Each cell is 100 seeds of one roster in one recipe. An exact tie on the compared mean is
counted as a tie rather than awarded to whichever placement the sort happened to put first.

### 3.1 PRIMARY — ranked by mean kills/hour

| placement | cells won (of 102) | melee | ranged | clustered |
|---|---|---|---|---|
| default | 51 | 20 | 18 | 13 |
| front | 19 | 8 | 4 | 7 |
| spread | 31 | 6 | 11 | 14 |
| tie | 1 | 0 | 1 | 0 |

The class-aware `default` placement — the one the sim itself computes and the one the client
opens with — is **not** the fastest killer in **50 of 102** cells: one of
the two fixed alternatives beats it there on kills/hour.

### 3.2 SECONDARY — the same cells ranked by mean raw kills

| placement | cells won (of 102) | melee | ranged | clustered |
|---|---|---|---|---|
| default | 54 | 24 | 18 | 12 |
| front | 20 | 7 | 4 | 9 |
| spread | 27 | 3 | 11 | 13 |
| tie | 1 | 0 | 1 | 0 |

Under raw kills, `default` is beaten in **47 of 102** cells.

**The two metrics disagree on 11 of the 102 cells**, which is why each table names its comparator. They agree on the headline under either: `default` wins all
three recipes in aggregate, and is beaten in roughly half the individual cells. Where they
differ, it is in cells whose placements trade survival against rate:

| roster | recipe | winner by kills/hour | winner by raw kills | full horizon: default / front / spread |
|---|---|---|---|---|
| guardian | ranged | spread | default | 0% / 0% / 0% |
| cleric | clustered | spread | front | 8% / 27% / 1% |
| ranger | melee | spread | default | 0% / 0% / 0% |
| ranger | ranged | front | default | 0% / 0% / 0% |
| ranger | clustered | default | spread | 0% / 0% / 0% |
| guardian,guardian | clustered | spread | front | 78% / 100% / 51% |
| guardian,cleric | melee | front | default | 84% / 9% / 42% |
| guardian,cleric | ranged | default | front | 87% / 99% / 89% |
| ranger,arcanist | melee | spread | default | 64% / 62% / 35% |
| arcanist,arcanist | melee | spread | default | 89% / 2% / 76% |
| arcanist,arcanist | ranged | default | spread | 35% / 88% / 94% |

## 4. Seed-paired comparison — each roster x recipe x seed judged independently

Total comparisons: 10200 (34 rosters x 3 recipes x 100 seeds).

| outcome | count (PRIMARY: kills/hour) | share | count (SECONDARY: raw kills) | share |
|---|---|---|---|---|
| default | 4628 | 45.37% | 4646 | 45.55% |
| front | 2139 | 20.97% | 1920 | 18.82% |
| spread | 2920 | 28.63% | 2816 | 27.61% |
| tie | 513 | 5.03% | 818 | 8.02% |

## 5. The R66 measurable gate

> measured results show more than one placement has an advantage across the three recipes

That sentence admits two readings, and the complete matrix answers them differently. Both are
reported here; neither is hidden behind the other. Both are judged on the primary comparator,
and the secondary cut gives the same answer to each.

- **Reading A — a different placement wins each recipe outright.** Distinct aggregate winners across the three recipes, by mean kills/hour: **1** (default). **Not satisfied**: one placement wins all three.
- **Reading B — more than one placement holds an advantage somewhere across the three recipes.** Placements that win at least one composition x recipe cell on mean kills/hour: **3** (default 51, front 19, spread 31 of 102). Satisfied.
- Placements that win at least one seed-paired comparison on mean kills/hour: **3** of 3.

## 6. The ten widest composition x recipe margins — ranked by mean kills/hour

| roster | recipe | winner | margin over runner-up (kills/hour) | mean kills/hour: default / front / spread |
|---|---|---|---|---|
| cleric | melee | front | n/a (runner-up scored zero) | 0.00 / 1.01 / 0.00 |
| guardian,guardian,arcanist | ranged | default | +82.35% | 257.75 / 141.35 / 131.12 |
| arcanist,arcanist | clustered | spread | +77.65% | 205.62 / 204.71 / 365.28 |
| guardian,ranger,arcanist | clustered | default | +71.70% | 740.79 / 431.44 / 362.96 |
| ranger,arcanist,arcanist | clustered | default | +51.99% | 610.27 / 401.51 / 394.76 |
| cleric | clustered | spread | +51.57% | 191.98 / 202.54 / 307.00 |
| guardian,ranger,arcanist | melee | front | +36.92% | 207.53 / 284.14 / 188.46 |
| ranger,ranger,ranger | clustered | spread | +35.05% | 622.07 / 658.00 / 888.62 |
| guardian | melee | default | +33.86% | 115.72 / 86.45 / 41.75 |
| guardian,arcanist,arcanist | clustered | default | +31.17% | 477.91 / 364.34 / 277.98 |

## 7. Guardian-heavy compositions — the class of composition the pre-fix analysis had to drop

R97: the earlier, pre-fix summary covered 25 of 34 rosters and excluded nine *because they
crashed*, and those were guardian-heavy — exactly the melee-clustering geometry the placement
question is about. Every roster carrying two or more Guardians is listed here, in full, from
the complete matrix. (This table does not claim to be those precise nine rosters; the pre-fix
exclusion list was produced by a bespoke sweep that is void under R97 and is not consulted.)

Winner column ranks on **mean kills/hour**; both metrics and the survival share are shown.

| roster | recipe | winner (kills/hour) | mean kills/hour: default / front / spread | mean raw kills: default / front / spread | full horizon: default / front / spread |
|---|---|---|---|---|---|
| guardian,guardian | melee | default | 142.9 / 136.9 / 134.9 | 86.0 / 13.1 / 23.8 | 42% / 0% / 1% |
| guardian,guardian | ranged | front | 125.1 / 139.6 / 134.0 | 121.0 / 125.8 / 118.3 | 94% / 85% / 80% |
| guardian,guardian | clustered | spread | 365.7 / 361.5 / 417.6 | 317.4 / 361.5 / 315.1 | 78% / 100% / 51% |
| guardian,guardian,guardian | melee | default | 189.3 / 146.8 / 141.8 | 189.3 / 146.8 / 138.1 | 100% / 100% / 99% |
| guardian,guardian,guardian | ranged | default | 210.5 / 171.1 / 180.2 | 210.5 / 171.1 / 180.2 | 100% / 100% / 100% |
| guardian,guardian,guardian | clustered | default | 596.9 / 594.0 / 492.6 | 596.9 / 594.0 / 492.6 | 100% / 100% / 100% |
| guardian,guardian,cleric | melee | default | 310.7 / 309.0 / 304.6 | 310.7 / 309.0 / 304.6 | 100% / 100% / 100% |
| guardian,guardian,cleric | ranged | default | 370.3 / 343.6 / 331.4 | 370.3 / 343.6 / 331.4 | 100% / 100% / 100% |
| guardian,guardian,cleric | clustered | default | 662.0 / 625.0 / 600.5 | 662.0 / 625.0 / 600.5 | 100% / 100% / 100% |
| guardian,guardian,ranger | melee | default | 321.2 / 267.2 / 250.9 | 321.2 / 267.2 / 250.9 | 100% / 100% / 100% |
| guardian,guardian,ranger | ranged | default | 302.7 / 256.8 / 218.9 | 302.7 / 256.8 / 218.9 | 100% / 100% / 100% |
| guardian,guardian,ranger | clustered | default | 754.0 / 752.6 / 708.1 | 754.0 / 752.6 / 708.1 | 100% / 100% / 100% |
| guardian,guardian,arcanist | melee | default | 280.0 / 222.9 / 153.3 | 280.0 / 222.9 / 153.3 | 100% / 100% / 100% |
| guardian,guardian,arcanist | ranged | default | 257.8 / 141.3 / 131.1 | 257.8 / 141.3 / 131.1 | 100% / 100% / 100% |
| guardian,guardian,arcanist | clustered | front | 508.6 / 510.0 / 452.8 | 508.6 / 510.0 / 452.8 | 100% / 100% / 100% |
