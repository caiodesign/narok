# Placement analysis — recomputed from the complete matrix

Source: `artifacts/matrix.csv`

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

Stop-reason census across every row (no row in a complete matrix may be an error row —
an aborted run writes no CSV at all, so completeness plus this census is the evidence that
the R92 collision no longer fires anywhere in the sweep):

| stop_reason | rows |
|---|---|
| (reached horizon, no stop reason) | 25399 |
| wipe-limit | 5201 |

## 2. Aggregate per recipe (all 34 rosters x 100 seeds pooled)

Primary metric is **mean kills in the fixed one-hour horizon**: a run that wipes out early
stops accumulating, so this measure already penalises a placement that gets the party killed.
`kills/h` (kills normalised by *elapsed* simulated time) is shown as a cross-check because it
rewards a short violent run, and `full horizon` is the share of seeds that survived the hour.

| recipe | placement | mean kills | mean kills/h | mean wins | mean wipes | full horizon |
|---|---|---|---|---|---|---|
| melee | default | 244.42 | 269.99 | 81.34 | 0.189 | 81.1% |
| melee | front | 219.26 | 250.83 | 72.93 | 0.256 | 74.4% |
| melee | spread | 210.66 | 240.40 | 70.07 | 0.228 | 77.2% |
| ranged | default | 283.23 | 315.78 | 94.25 | 0.151 | 84.9% |
| ranged | front | 258.28 | 291.46 | 85.94 | 0.181 | 81.9% |
| ranged | spread | 270.13 | 301.44 | 89.90 | 0.152 | 84.8% |
| clustered | default | 539.41 | 593.48 | 107.71 | 0.122 | 87.8% |
| clustered | front | 515.40 | 561.62 | 102.93 | 0.110 | 89.0% |
| clustered | spread | 519.87 | 577.02 | 103.78 | 0.140 | 86.0% |

| recipe | best placement (mean kills) | runner-up | margin | best placement (mean kills/h) |
|---|---|---|---|---|
| melee | **default** (244.42) | front (219.26) | +11.47% | default |
| ranged | **default** (283.23) | spread (270.13) | +4.85% | default |
| clustered | **default** (539.41) | spread (519.87) | +3.76% | default |

## 3. Per composition x recipe (which placement wins each of the 102 cells)

Each of the 102 cells is 100 seeds of one roster in one recipe. The winner is the
placement with the highest mean kills over those 100 seeds; an exact tie on that mean is
counted as a tie rather than awarded to whichever placement the sort happened to put first.

| placement | cells won (of 102) | melee | ranged | clustered |
|---|---|---|---|---|
| default | 54 | 24 | 18 | 12 |
| front | 20 | 7 | 4 | 9 |
| spread | 27 | 3 | 11 | 13 |
| tie | 1 | 0 | 1 | 0 |

The class-aware `default` placement — the one the sim itself computes and the one the client
opens with — is **not** the best choice in **47 of 102** cells: one of the
two fixed alternatives beats it there.

## 4. Seed-paired comparison (each roster x recipe x seed judged independently)

Total comparisons: 10200 (34 rosters x 3 recipes x 100 seeds).

| outcome | count | share |
|---|---|---|
| default | 4646 | 45.55% |
| front | 1920 | 18.82% |
| spread | 2816 | 27.61% |
| tie | 818 | 8.02% |

## 5. The R66 measurable gate

> measured results show more than one placement has an advantage across the three recipes

That sentence admits two readings, and the complete matrix answers them differently. Both are
reported here; neither is hidden behind the other.

- **Reading A — a different placement wins each recipe outright.** Distinct aggregate winners across the three recipes: **1** (default). **Not satisfied**: one placement wins all three.
- **Reading B — more than one placement holds an advantage somewhere across the three recipes.** Placements that win at least one composition x recipe cell: **3** (default 54, front 20, spread 27 of 102). Satisfied.
- Placements that win at least one seed-paired comparison: **3** of 3.

## 6. The ten widest composition x recipe margins

| roster | recipe | winner | margin over runner-up | mean kills: default / front / spread |
|---|---|---|---|---|
| cleric | melee | front | n/a (runner-up scored zero) | 0.00 / 0.02 / 0.00 |
| guardian,guardian | melee | default | +261.29% | 85.95 / 13.08 / 23.79 |
| ranger | clustered | spread | +159.98% | 10.23 / 19.29 / 50.15 |
| cleric | ranged | default | +89.95% | 12.10 / 6.37 / 4.66 |
| guardian,guardian,arcanist | ranged | default | +82.35% | 257.75 / 141.35 / 131.12 |
| arcanist,arcanist | clustered | spread | +77.65% | 205.62 / 204.71 / 365.28 |
| guardian,ranger,arcanist | clustered | default | +71.70% | 740.79 / 431.44 / 362.96 |
| guardian,arcanist | ranged | default | +65.90% | 132.01 / 68.52 / 79.57 |
| guardian | clustered | default | +65.84% | 4.03 / 1.60 / 2.43 |
| cleric | clustered | front | +64.04% | 54.90 / 90.06 / 42.26 |

## 7. Guardian-heavy compositions — the class of composition the pre-fix analysis had to drop

R97: the earlier, pre-fix summary covered 25 of 34 rosters and excluded nine *because they
crashed*, and those were guardian-heavy — exactly the melee-clustering geometry the placement
question is about. Every roster carrying two or more Guardians is listed here, in full, from
the complete matrix. (This table does not claim to be those precise nine rosters; the pre-fix
exclusion list was produced by a bespoke sweep that is void under R97 and is not consulted.)

| roster | recipe | winner | mean kills: default / front / spread | full horizon: default / front / spread |
|---|---|---|---|---|
| guardian,guardian | melee | default | 86.0 / 13.1 / 23.8 | 42% / 0% / 1% |
| guardian,guardian | ranged | front | 121.0 / 125.8 / 118.3 | 94% / 85% / 80% |
| guardian,guardian | clustered | front | 317.4 / 361.5 / 315.1 | 78% / 100% / 51% |
| guardian,guardian,guardian | melee | default | 189.3 / 146.8 / 138.1 | 100% / 100% / 99% |
| guardian,guardian,guardian | ranged | default | 210.5 / 171.1 / 180.2 | 100% / 100% / 100% |
| guardian,guardian,guardian | clustered | default | 596.9 / 594.0 / 492.6 | 100% / 100% / 100% |
| guardian,guardian,cleric | melee | default | 310.7 / 309.0 / 304.6 | 100% / 100% / 100% |
| guardian,guardian,cleric | ranged | default | 370.3 / 343.6 / 331.4 | 100% / 100% / 100% |
| guardian,guardian,cleric | clustered | default | 662.0 / 625.0 / 600.5 | 100% / 100% / 100% |
| guardian,guardian,ranger | melee | default | 321.2 / 267.2 / 250.9 | 100% / 100% / 100% |
| guardian,guardian,ranger | ranged | default | 302.7 / 256.8 / 218.9 | 100% / 100% / 100% |
| guardian,guardian,ranger | clustered | default | 754.0 / 752.6 / 708.1 | 100% / 100% / 100% |
| guardian,guardian,arcanist | melee | default | 280.0 / 222.9 / 153.3 | 100% / 100% / 100% |
| guardian,guardian,arcanist | ranged | default | 257.8 / 141.3 / 131.1 | 100% / 100% / 100% |
| guardian,guardian,arcanist | clustered | front | 508.6 / 510.0 / 452.8 | 100% / 100% / 100% |
