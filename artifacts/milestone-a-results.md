# Milestone A — results, evidence and recommendation

This is the `artifacts/milestone-a-results.md` that `2026-09-14-milestone-a-spec.md` §13 requires.
It is produced during execution, not by the planning packet.

**Every number below was printed by a command run on this workstation during this evidence run.**
Nothing is estimated, nothing is extrapolated from a short run to a longer horizon, nothing is
copied from the spec or the plan as though it had been measured, and nothing is carried forward
from the artifacts that existed before the defect described in §4 was fixed — those are void and
were moved aside before this run started. Where a gate could not be run, the sentence that would
have held its result says so instead, names what is missing, and the gate is listed as open in §11.

**Contents.** 1 Build under test · 2 Correctness commands and results · 3 Continuous integration ·
4 The defect this evidence run exposed · 5 Balance evidence · 6 Performance evidence (workstation) ·
7 Placement analysis · 8 A-14, pending · 9 Raw artifacts · 10 Coverage map A-01…A-14 ·
11 Gates that are open · 12 Recommendation.

**Three gates are open and are named as open, not as passed:** the five-tester placement experiment
(§8), R64's visual composition checks (§11), and the single-VPS concurrency target (§6.5).

---

## 1. Build under test

| Field | Value |
|---|---|
| git commit | `346a12404659e550daeadd35fb6b1da90a9d0dca` (`346a124`, branch `milestone-a`) |
| working tree at run time | clean apart from two pre-existing deletions under `codex-examples/` that predate this branch |
| `simulationVersion` | `a1` |
| `contentVersion` | `d32c6cd45b1ee49eae6ab0f3fa5f1d4b5a1ab657bb9dc18a4db18c7da50816ef` |
| `gridHash` | `c2c839371c6faddb0756adef80f3fcb3d17c841fef809acc419dea7ddb43e4b9` |
| Node | `v24.15.0` (the repo's pinned `engines.node`) |
| pnpm | `10.34.5` (the repo's `packageManager`) |

`simulationVersion`, `contentVersion` and `gridHash` are the values this run's own artifacts
recorded — `artifacts/baseline.csv` carries them in every row, and
`artifacts/baseline.csv.actors.json` and `artifacts/performance.json` each carry them in their
metadata block.

---

## 2. Correctness commands and results

Every command below is written in the repo-relative form a reader would type. Exit status is the
process exit code observed on this machine; the raw output of each is on disk at the path in the
last column.

| # | Command | Exit | Headline result | Raw output |
|---|---|---|---|---|
| 1 | `pnpm check` (= `build:data && typecheck && lint && test`) | **0** | **317 tests passed across 24 files**, 0 failed; `tsc --noEmit` and `eslint` both clean | `artifacts/run-11b/check.stdout.txt` |
| 2 | `pnpm --filter @narok/client build` | **0** | vite production build, 783 modules, built in 194 ms; one advisory chunk-size warning, no errors | `artifacts/run-11b/build.stdout.txt` |
| 3 | `pnpm test:e2e` | **0** | **6 of 6 Playwright specs passed** in 8.0 s (Chromium, against the built-and-previewed bundle) | `artifacts/run-11b/e2e.stdout.txt` |

### 2.1 What `pnpm check` covers (`pnpm test`, 317 tests / 24 files)

The per-file breakdown was taken from a second execution of the same suite at the same commit with
vitest's JSON reporter (`npx vitest run --reporter=json`), which also reported 317 passed / 0
failed. The totals agree with command 1 above.

| Area | File | Tests |
|---|---|---|
| Simulation | `packages/sim/test/actions.test.ts` | 32 |
| | `packages/sim/test/lifecycle.test.ts` | 32 |
| | `packages/sim/test/snapshot.test.ts` | 24 |
| | `packages/sim/test/state.test.ts` | 18 |
| | `packages/sim/test/invariants.test.ts` | 15 |
| | `packages/sim/test/grid.test.ts` | 14 |
| | `packages/sim/test/math.test.ts` | 11 |
| | `packages/sim/test/scheduler.test.ts` | 10 |
| | `packages/sim/test/effects.test.ts` | 8 |
| | `packages/sim/test/advance.test.ts` | 7 |
| | `packages/sim/test/projection.test.ts` | 7 |
| | `packages/sim/test/pinned-run.test.ts` | 2 |
| | `packages/sim/test/rng.test.ts` | 1 |
| Content | `packages/data/test/content.test.ts` | 8 |
| Balance CLI | `tools/balance/test/run.test.ts` | 23 |
| | `tools/balance/test/report.test.ts` | 13 |
| Client | `apps/client/test/controls.test.tsx` | 41 |
| | `apps/client/test/battlefield.test.tsx` | 12 |
| | `apps/client/test/eventlog.test.tsx` | 9 |
| | `apps/client/test/experiment-worker.test.ts` | 9 |
| | `apps/client/test/app.test.tsx` | 6 |
| | `apps/client/test/comparison.test.tsx` | 6 |
| | `apps/client/test/i18n.test.ts` | 5 |
| | `apps/client/test/clock.test.ts` | 4 |

### 2.2 §13's automated-correctness list, item by item

| §13 item | Where it is proven | Status in this run |
|---|---|---|
| Same input/seed produces byte-equivalent canonical final state and ordered domain events | `packages/sim/test/pinned-run.test.ts` — a committed one-hour golden fixture recomputed field by field (`nowMs`, `phase`, `rng`, a 13,648-event count, full metrics); `packages/sim/test/invariants.test.ts` "any seed splits anywhere without changing state or events" | **green** |
| Direct, chunked, JSON-restored and summary-mode runs agree | `invariants.test.ts` "any seed splits anywhere without changing state or events" and "any seed agrees across summary collection and a one-event work budget"; `snapshot.test.ts` round trips | **green** |
| Exact-boundary tests: status expiry, regen, casts, deaths, timeout, rest exit, respawn | `invariants.test.ts` — "a kill resolving exactly at the encounter deadline wins", "an undecided encounter at the exact deadline stops as a stalemate after its resolutions", "a stun expiring exactly at a cast completion lets the cast resolve", "a stun expiring one millisecond later postpones the whole cast", "the regen tick applies at exactly its instant, never a millisecond early", "a hit that brings HP to exactly zero is a death; one point short is not", "a respawn completes at exactly its instant, not a millisecond before"; rest-exit boundaries in `lifecycle.test.ts` ("rest exit requires 90% hp: 89% does not exit, 90% does" and the MP twin) | **green** |
| Geometry never overlaps live units, wraps shapes, or emits coordinates from combat APIs | `grid.test.ts` ("square clips at the right edge without wrapping", placement validation), `invariants.test.ts` ("resource, occupancy and queue invariants are asserted after each dispatch", "combat APIs publish opaque cell ids, never coordinates"), `lifecycle.test.ts` R92/R100 tests — **and see §4: this item was failing in shipped code until this evidence run exposed it** | **green now, was red** |
| Work-budget yields resume without losing events or consuming extra RNG | `invariants.test.ts` "any seed agrees across summary collection and a one-event work budget" and "stale entries are skipped but still spend the work budget" | **green** |
| Browser smoke: configure → start → elapsed events → pause → resume → finish/stop → compare, in both languages | `e2e/laboratory.spec.ts`, run as command 3 above | **green** |

### 2.3 The browser smoke, spec by spec

All six passed on the first run against this tree. Per R69, no red phase was manufactured and the
observed result is recorded as-is.

| Spec | What it drives |
|---|---|
| `a player can run, pause, resume and inspect an experiment` | cold load → `0 s` → Start → clock moves → Pause → `Paused` → frozen reading → Resume → `Running` and the clock moved again → Stop experiment → comparison A visible, holding real kills and the `Stopped by the operator` reason |
| `a second run from a changed placement fills comparison B` | one run, then p0 moved from its default `2,3` seat to the empty party cell `0,3` through the accessible placement grid, then a second run; comparison B filled with kills and walking time |
| `the same run works in Portuguese with the shipped pt-BR strings` | the same journey driven entirely through accessible names read from the committed `pt-BR.json` at run time, and the comparison slot's `aria-label` asserted against the shipped translation |
| `the laboratory does not scroll horizontally at 1440x900` / `1280x800` / `1100x800` | `document.documentElement.scrollWidth - clientWidth <= 0` at each of the three widths the UI spec names |

The three viewport specs measure **horizontal overflow only**. That is not a judgement about
whether the layout looks right, and it does not discharge R64's visual composition checks — see
§11.

---

## 3. Continuous integration

`.github/workflows/ci.yml` runs on push and pull request: checkout, pnpm from the `packageManager`
field, Node pinned to `engines.node` (24.15.0), `pnpm install --frozen-lockfile`, `pnpm build:data`,
`pnpm typecheck`, `pnpm lint`, `pnpm test`, `npx playwright install --with-deps chromium`,
`pnpm --filter @narok/client build`, `pnpm test:e2e`. The `pnpm balance` commands are deliberately
absent — they are minutes-long evidence runs, not gates. No secret is referenced.

The workflow has not been observed executing on GitHub from this run; what is verified here is that
every step it runs was run locally against this commit and passed, as recorded in §2.

---

## 4. The defect this evidence run exposed (R92/R96/R97)

§13's automated-correctness list contains the line *"Geometry never overlaps live units"*. Before
the fix described here, that acceptance item was not merely untested — **it was failing in shipped
`packages/sim` code**, and `pnpm balance matrix`, one of §13's own required evidence commands,
could not run to completion at all. This section records the sequence rather than only the green
end state.

### 4.1 What the defect was

A corpse does not occupy its cell: `executeMove` (`packages/sim/src/actions.ts`) tests occupancy
with `livingActors`, and both occupancy checks — `assertInvariants` in `packages/sim/src/advance.ts`
and `validateSimState` in `packages/sim/src/validate-state.ts` — skip any actor at `hp <= 0`. So an
ally could legally step onto a fallen party member. `finishEncounter`'s win branch then revived that
corpse **in place** (`if (member.hp <= 0) member.hp = ...`, position never touched), and
`completeRespawn` restored the whole party in place on the wipe path. The result was two *living*
actors on one cell, which tripped `INVALID_STATE actors.pN.position "shares a cell with pM"` on the
next dispatch and, independently, made the state undecodable (`duplicate live position with pM`),
so snapshot export/import and every checkpoint path failed on exactly those runs too.

### 4.2 How it was found

By this task's own evidence run — specifically by its first attempt, which ran
`pnpm balance matrix --hours 1 --seeds 1:100` (§13's second required balance command) against the
then-shipped tree and watched it **abort** with that `SimError` instead of producing a CSV. The
controller then reproduced and root-caused it independently rather than taking the report on trust.

To be exact about who observed what: the pre-fix abort and the two blast-radius figures in §4.3 were
observed by that earlier attempt and by the controller's probes. This run observed only the
post-fix behaviour in §4.5, on the fixed tree. The abort was not a balance-tool quirk — the browser
laboratory runs the same `packages/sim`.

### 4.3 Measured blast radius *before* the fix

These two figures are **not** from this run's commands. They were measured by the controller's own
probes against the pre-fix tree and are reproduced here, attributed, because R97 requires the
report to state the severity the fix removed:

| Probe | Measurement |
|---|---|
| Controller's CLI sweep over composition × recipe × placement × seed | **934 of 30,600 cells failed (3.05%)**, across 36 distinct composition/recipe/placement combinations |
| Controller's browser-reachable roster probe (all 84 rosters the laboratory lets a user build, `mixed`, default placement, 40 seeds each, 1 h horizon) | **54 of 3,360 roster-runs crashed (1.61%)**, concentrated in **5 guardian-heavy rosters**, with `guardian,guardian` failing **21 of 40 seeds** |

The accurate severity statement, from those probes: the defect missed the client's **default** party
(guardian/cleric/ranger, `mixed`, default placement) entirely across 200 seeds — which is why no
existing client or sim test caught it — but a user who picked two Guardians had a better-than-even
chance of the laboratory dying within an hour of simulated time. Guardian-heavy melee rosters
converge on the same front cell, which is exactly the geometry that puts a corpse under an ally.

### 4.4 The fix

Commit **`ec45fc3` — `fix: reseat revived party members to prevent cell collisions (R92)`**, with
the end-to-end replay test added in commit **`346a124` — `test: replay the R92 collision sequence
end to end`** (the commit this report's evidence was run against).

The change is one statement in `finishEncounter`'s shared party-reset loop
(`packages/sim/src/lifecycle.ts`): `member.position = state.input.placement[id];`, re-seating the
party at the placement `startState` already validated collision-free — the same source
`spawnEncounter` uses. It is a teleport, not a step: no `move` event, and no RNG draw added, removed
or reordered. Neither occupancy check was weakened, and corpses were not made to block movement.

Three tests in `packages/sim/test/lifecycle.test.ts` hold it down. All three pass in this run's
`pnpm check`; that they *fail* when the one statement is disabled is the controller's recorded
perturbation result, attributed here rather than re-verified by this run:

- `R92: a win revives a corpse an ally stands on without stacking two living actors`
- `R92: a respawn after two members die on one cell restores them to separate cells`
- `R100: R92's own reproduction runs past the instant it used to abort on` — drives the real engine
  from `sim.start()` over the exact input that used to abort (seed 4, two Guardians, `melee`, the
  CLI's `front` cells) past the failure instant at 121,981 ms.

**Evidence the fix changed no combat behaviour:** the pinned one-hour golden fixture
`packages/sim/test/fixtures/one-hour-run.json` was last modified in commit `4100fd1`, well before
either fix commit, and was not touched by `ec45fc3` or `346a124` (`git show --stat` on both lists it
zero times). `pnpm test` at this commit passes `pinned-run.test.ts`, which re-derives that run and
compares `nowMs`, `phase`, `rng`, the 13,648-event count and the full metrics block field by field.
A fix that moved a single RNG draw would have failed it.

### 4.5 Re-measured after the fix

`pnpm balance matrix --hours 1 --seeds 1:100 --out artifacts/matrix.csv` — the command that used to
abort — **completed with exit status 0 and wrote 30,600 rows**, the exact count its parameters
predict (34 class multisets × 3 fixed recipes × 3 placements × 100 seeds). Every one of the 306
roster × recipe × placement cells holds exactly its 100 seed rows; none is missing or short.

That is the re-measurement. It is also the strongest available form of it: `runMatrix` has no
error-tolerant path — a single `SimError` anywhere in the sweep throws out of the command and no CSV
is written at all. A complete file *is* the statement that the collision fired zero times in 30,600
one-hour runs, against 934 pre-fix failures in a sweep of the same 30,600-cell shape.

The stop-reason census over those 30,600 rows contains only ordinary outcomes — 25,399 rows reached
the full hour and 5,201 stopped on `wipe-limit`, which is normal for a CLI that fixes
`wipeLimit = 1` and includes rosters as fragile as a solo Cleric. No row records an error state.

---

## 5. Balance evidence

### 5.1 `pnpm balance run` — the baseline

```
pnpm balance run --hours 1 --seeds 1:100 --recipe mixed --party guardian,cleric,ranger --out artifacts/baseline.csv
```

Exit **0**. Printed: `wrote 100 row(s) to artifacts/baseline.csv`.

100 rows, seeds 1–100, one roster (`guardian,cleric,ranger`), recipe `mixed`, placement
`p0:2,3;p1:1,4;p2:3,4`, `simulation_version` `a1` and the `contentVersion` from §1 in every row.

| Metric over the 100 seeds | min | p50 | p95 | max | mean |
|---|---|---|---|---|---|
| `elapsed_ms` | 3,600,000 | 3,600,000 | 3,600,000 | 3,600,000 | 3,600,000 |
| `kills` | 489 | 526 | 552 | 557 | 525.70 |
| `kills_per_hour` | 489 | 526 | 552 | 557 | 525.70 |
| `wins` | 139 | 143 | 146 | 148 | 143.27 |
| `wipes` | 0 | 0 | 0 | 0 | 0 |
| `raw_exp` | 12,570 | 12,870 | 13,170 | 13,350 | 12,905.64 |
| `raw_gold` | 1,295 | 1,340 | 1,372 | 1,390 | 1,338.32 |
| `damage_dealt` | 61,270 | 62,960 | 64,310 | 65,290 | 63,015.21 |
| `effective_healing` | 10,324 | 11,398 | 11,972 | 12,373 | 11,386.90 |
| `fight_ms` | 1,141,643 | 1,161,934 | 1,182,545 | 1,189,463 | 1,163,161.96 |
| `walk_ms` | 280,000 | 286,129 | 294,000 | 298,000 | 287,235.01 |
| `rest_ms` | 2,116,537 | 2,149,294 | 2,171,051 | 2,176,357 | 2,149,603.03 |

**Short-run distinction:** none. All 100 runs reached the full requested 3,600,000 ms and recorded
no `stop_reason`; `kills_per_hour` equals `kills` for every row precisely because no run stopped
early. Nothing here is scaled from a shorter run.

Per-actor detail is in the companion `artifacts/baseline.csv.actors.json`, as spec §12 requires.

### 5.2 `pnpm balance matrix` — the full sweep

```
pnpm balance matrix --hours 1 --seeds 1:100 --out artifacts/matrix.csv
```

Exit **0**. Printed: `wrote 30600 row(s) to artifacts/matrix.csv`. Wall duration **835.95 s**
(13 min 56 s).

That wall figure is **not** a clean performance measurement and must not be read as one: other
repository commands (a full `vitest run` and a two-job harness smoke) were executed on this machine
while the matrix was running. It is recorded only so a reader knows the order of magnitude of the
command. Every figure in §6 was measured with nothing else running.

Census and completeness are in §4.5. The placement analysis derived from this file is §7 and
`artifacts/placement-analysis.md`.

---

## 6. Performance evidence — **workstation results**

Everything in this section was measured on the workstation below, not on the intended deployment
host. See §6.5.

### 6.1 Hardware and runtime, as recorded in `artifacts/performance.json`

| Field | Value |
|---|---|
| `nodeVersion` | `v24.15.0` |
| `platform` / `arch` | `win32` / `x64` |
| `cpuModel` | `AMD Ryzen 7 7800X3D 8-Core Processor` |
| `cpuCount` | 16 |
| `totalMemoryBytes` | 33,514,852,352 (31.2 GiB) |
| `simulationVersion` / `contentVersion` / `gridHash` | as in §1 |

The report's `commandLine` metadata field is deliberately **not** quoted here: R49 records it as an
absolute path, which would carry a home directory into a committed file. Every command in this
document is written in the repo-relative form a reader would type.

### 6.2 `pnpm balance benchmark` — sequential per-run cost

```
pnpm balance benchmark --hours 12,24 --runs 20 --out artifacts/performance.json
```

Exit **0**. Printed: `wrote benchmark report to artifacts/performance.json`. Whole command took
**52.26 s** of wall time.

These are **per-run costs measured one run at a time**. `runHorizon` in
`tools/balance/src/benchmark.ts` is a `for` loop with `await runInChildProcess(...)` inside it, so
samples run strictly sequentially at concurrency 1, each in its own forked process so peak RSS is
per-run rather than cumulative. They are **not** throughput figures and must not be read as any —
throughput is §6.4.

**Normal gameplay** (default party guardian/cleric/ranger, `mixed` recipe, default placement, seeds
1–20, summary collection):

| Horizon | Samples | wall p50 | wall p95 | wall p99 | wall min–max | peak RSS p50 | peak RSS p99 | short |
|---|---|---|---|---|---|---|---|---|
| 12 h | 20 | 608.261 ms | 620.177 ms | 630.064 ms | 597.457 – 630.064 ms | 104.9 MiB | 105.6 MiB | **0 of 20** |
| 24 h | 20 | 1,134.950 ms | 1,151.269 ms | 1,160.574 ms | 1,111.041 – 1,160.574 ms | 105.4 MiB | 106.8 MiB | **0 of 20** |

**Engine-stress fixture** (the maximum-event fixture §13 asks for, kept in its own table per R49 —
these numbers are not comparable with the gameplay rows above and must not be pooled with them):

| Horizon | Samples | wall | peak RSS | short |
|---|---|---|---|---|
| 12 h | 1 | 4,216.354 ms | 127.3 MiB | 0 of 1 |
| 24 h | 1 | 8,337.197 ms | 127.3 MiB | 0 of 1 |

**Short-run distinction:** there were no short samples in this run at all. Every one of the 42
samples reached its full requested horizon — 43,200,000 ms at 12 h and 86,400,000 ms at 24 h, with
no `stopReason` — so no cost in this section is an early stop, and nothing has been scaled up to a
horizon it did not actually simulate.

### 6.3 What the benchmark does *not* cover

`benchmark` does not satisfy §13's "batch of 100 jobs". It is sequential by construction, and
presenting its per-run costs as batch throughput would be reporting an unrun gate as passed. The
batch had to be built for this task; it is §6.4.

### 6.4 The batch of 100 jobs, with bounded concurrency

No such command existed, so one was written for this evidence run:
`artifacts/batch-100.mjs`. It dispatches jobs through a fixed-size worker pool, forking the **same**
child-process job runner the benchmark uses (`tools/balance/src/benchmark-runner.ts`), so a batch
job is exactly the same unit of work as a benchmark sample and only the scheduling differs. Each
job is one gameplay run: default party guardian/cleric/ranger, `mixed` recipe, default placement,
seeds 1–100, summary collection. Concurrency was sized to this machine's real CPU count, 16.

```
node artifacts/batch-100.mjs 16 12 100 artifacts/batch-100-h12-c16.json
node artifacts/batch-100.mjs 16 24 100 artifacts/batch-100-h24-c16.json
node artifacts/batch-100.mjs  1 12 100 artifacts/batch-100-h12-c1.json
```

All three exit **0**, 100 of 100 jobs completed, **0 short** — every job reached its full requested
horizon.

| Batch | Horizon | Concurrency requested | Concurrency observed (peak in flight) | Wall time | Throughput |
|---|---|---|---|---|---|
| 100 jobs | 12 h | 16 | **16** | **10.564 s** | **9.466 jobs/s** |
| 100 jobs | 24 h | 16 | **16** | **18.195 s** | **5.496 jobs/s** |
| 100 jobs (sequential reference) | 12 h | 1 | 1 | 70.858 s | 1.411 jobs/s |

The third row is a deliberate reference point, run identically except for the pool size, so the
throughput figures above have something measured to be compared against rather than a per-run cost
borrowed from §6.2. Sixteen workers finished the same 100 twelve-hour jobs **6.71× faster** than one
worker.

Per-job cost inside each batch, which is where the contention shows:

| Batch | per-job simulation wall p50 | p95 | max | per-job process wall p50 (incl. fork + loader) | peak RSS p50 | peak RSS max |
|---|---|---|---|---|---|---|
| 12 h, concurrency 16 | 1,390.494 ms | 1,490.269 ms | 1,530.337 ms | 1,635.189 ms | 67.7 MiB | 102.9 MiB |
| 24 h, concurrency 16 | 2,578.660 ms | 2,704.863 ms | 2,731.763 ms | 2,811.174 ms | 68.2 MiB | 103.3 MiB |
| 12 h, concurrency 1 | 606.551 ms | 621.268 ms | 628.298 ms | 707.279 ms | 102.1 MiB | 103.6 MiB |

A twelve-hour job that costs 606.551 ms at the median when it has the machine to itself costs
1,390.494 ms at the median when sixteen of them share it — 2.29× — on a part with 8 physical cores
and 16 hardware threads. That is a real, measured contention cost and it is the number that matters
for any concurrency claim.

### 6.5 The single-VPS concurrency target — **not tested on the target VPS**

This gate is **open**. The target VPS was not available to this run, and nothing here was measured
on it. A workstation with an AMD Ryzen 7 7800X3D and 31.2 GiB of RAM does not stand in for it, and
§6.4's throughput is not evidence about that host. The target is not claimed to have passed, and
the §6.4 figures must not be quoted as though it had.

### 6.6 The sub-second goal — **evaluated, not asserted**

§13 says this goal is evaluated, not asserted, and it does not define the horizon or the load the
second applies to. What was measured, with the full distribution rather than a chosen point:

| Condition | Samples | p50 | p95 | max | samples over 1,000 ms |
|---|---|---|---|---|---|
| 12 h gameplay, one at a time | 20 | 608.261 ms | 620.177 ms | 630.064 ms | **0 of 20** |
| 24 h gameplay, one at a time | 20 | 1,134.950 ms | 1,151.269 ms | 1,160.574 ms | **20 of 20** |
| 12 h gameplay, 16 concurrent | 100 | 1,390.494 ms | 1,490.269 ms | 1,530.337 ms | **96 of 100** |
| 24 h gameplay, 16 concurrent | 100 | 2,578.660 ms | 2,704.863 ms | 2,731.763 ms | **100 of 100** |
| 12 h engine-stress | 1 | 4,216.354 ms | — | — | 1 of 1 |
| 24 h engine-stress | 1 | 8,337.197 ms | — | — | 1 of 1 |

Read plainly: a twelve-hour catch-up for one party finishes under a second on this workstation when
it has the machine to itself, and nothing else measured here does. The twenty-four-hour horizon —
which is the offline cap the wider design contemplates — did not come in under a second in any of
the 120 samples taken, at any concurrency. This is recorded as the measured distribution. It is
**not** a claim that the goal is met, and the favourable 12 h p50 is not offered as one.

---

## 7. Placement analysis — the measurable half of A-14 (R66)

Full working, with every table, is in `artifacts/placement-analysis.md`, recomputed from scratch
over the complete 30,600-row matrix. No figure from the pre-fix `placement-summary.txt` is used. Per
the task handoff, that file covered 25 of 34 rosters and dropped nine *because they crashed*, and
the dropped ones were guardian-heavy — exactly the melee-clustering compositions the placement
question is about. A conclusion drawn from a sample that discarded the hardest cases for being
broken is selection bias, so it was recomputed from scratch rather than reconciled.

Primary metric is **mean kills in the fixed one-hour horizon** over the 100 seeds of a cell. A run
that wipes out early stops accumulating, so this already penalises a placement that gets the party
killed; `kills_per_hour` (normalised by *elapsed* time, so it rewards a short violent run) is
carried as a cross-check and agrees with it on every aggregate winner.

**Aggregate, per recipe, all 34 rosters × 100 seeds pooled:**

| Recipe | default | front | spread | Winner | Margin over runner-up |
|---|---|---|---|---|---|
| melee | **244.42** | 219.26 | 210.66 | default | +11.47% over front |
| ranged | **283.23** | 258.28 | 270.13 | default | +4.85% over spread |
| clustered | **539.41** | 515.40 | 519.87 | default | +3.76% over spread |

**Per composition × recipe (102 cells, each 100 seeds):**

| Placement | Cells won | melee | ranged | clustered |
|---|---|---|---|---|
| default | 54 | 24 | 18 | 12 |
| front | 20 | 7 | 4 | 9 |
| spread | 27 | 3 | 11 | 13 |
| exact tie | 1 | 0 | 1 | 0 |

**Seed-paired (10,200 independent roster × recipe × seed comparisons):** default 4,646 (45.55%),
spread 2,816 (27.61%), front 1,920 (18.82%), tie 818 (8.02%).

### 7.1 The gate sentence, and why it needs two answers

> measured results show more than one placement has an advantage across the three recipes

The complete data answers the two available readings differently, and both are stated because
reporting only the favourable one would be the selection bias R97 exists to prevent:

- **Reading A — a different placement wins a different recipe.** **Not satisfied.** The class-aware
  `default` placement wins all three recipes outright, on mean kills and on kills/hour alike.
- **Reading B — more than one placement holds an advantage somewhere across the three recipes.**
  **Satisfied.** All three placements win cells: default 54, spread 27, front 20 of 102. The
  `default` placement is beaten by one of the two fixed alternatives in **47 of 102** cells, and the
  differences are frequently large, not marginal — `ranger` in `clustered` goes 10.23 → 50.15 mean
  kills moving from default to spread; `arcanist,arcanist` in `clustered` goes 205.62 → 365.28.

Note that `default` is not a neutral control: it is the sim's own class-aware `defaultPlacement`,
which deliberately seats a Guardian at the front-centre cell. Reading A therefore says something
narrower than "placement does not matter" — it says the designed default is the best *single*
choice at every recipe, while Reading B says the right choice for a *specific* party is often one
of the others.

The composition the defect used to kill also carries the widest measurable margin in the sweep:
`guardian,guardian` in `melee` scores 85.95 mean kills from the default placement and survives the
hour on 42% of seeds, against 13.08 kills / 0% from `front` and 23.79 kills / 1% from `spread` —
+261.29% over the runner-up. That row exists only because the R92 fix let those runs complete, and
it is a direct illustration of why the pre-fix exclusion could not be reconciled: the strongest
placement signal in the data was inside the sample that had been dropped.

---

## 8. A-14, the human placement experiment — **PENDING (requires five human testers)**

Not run, and not runnable by an automated agent. §13 requires five real testers, each making at
least two setup changes, each recording what they expected and their explanation of what happened;
the gate is that at least four of five can explain a supported effect of their own change. No
tester names, predictions, observations or explanations appear anywhere in this report, and none
were simulated.

What is delivered instead: **`artifacts/placement-experiment-protocol.md`** — the session script
(shared baseline setup, the three fixed recipes, trial length, the record sheet, and the scoring
rule for the human gate) so the user can run the session and close A-14. The measured half of the
gate, which an agent may answer, is §7 above.

---

## 9. Raw artifacts from this run

`artifacts/**` is gitignored, so the bulk outputs below are **not committed**. Each is listed with
its byte size and a content hash so a reader can verify the file they are holding is the one these
numbers came from.

| File | Size | SHA-256 |
|---|---|---|
| `artifacts/baseline.csv` | 20,397 B | `sha256:8ffd0f2d72bd05891fe3b4e309a695ea0dc8274982cf5654fb961c99d512741f` |
| `artifacts/baseline.csv.actors.json` | 66,280 B | `sha256:1ca6f0bdf4ed6e0238af6c189ed50374f9887635d9532fd0f1aa07f7bd3d2419` |
| `artifacts/matrix.csv` | 5,900,098 B | `sha256:35c897b0ea05efadf649b9e681283a81f5690558596a8f015d91ebabb3f84662` |
| `artifacts/matrix.csv.actors.json` | 17,110,666 B | `sha256:ecb9b1ec61e7e2178a6f006f7c67f0fa92c451fd47a4fe8e4460cda7bca1bb27` |
| `artifacts/performance.json` | 13,932 B | `sha256:99aa585af56fe196b05f2d00c8623eb23adbba0101f7c8bb2fc37c4cdc48bed9` |
| `artifacts/batch-100-h12-c16.json` | 26,005 B | `sha256:033ad5375de2ed179dae2171ca35e7181786510d81d5935e9522248575112b6a` |
| `artifacts/batch-100-h24-c16.json` | 26,032 B | `sha256:be35cdedae11e389e30b07fddd9d515fea8c3380137c92ea05319f89e5942690` |
| `artifacts/batch-100-h12-c1.json` | 25,898 B | `sha256:c1486ea094203e11a42e6d3138ecbe344a5313436c4d8f20dd69532acc55026d` |
| `artifacts/batch-100.mjs` (the batch harness written for §6.4) | 5,501 B | `sha256:5c8f8fad106eb55532ba214e69210292a5c2879cb85d301433e81c4610d42c83` |
| `artifacts/analyze-matrix.mjs` (the §7 analysis script) | 14,991 B | `sha256:939f6a98bb3b49e37be9aeb3934bc0f732d25836df2dd02189192075069e3701` |
| `artifacts/placement-names.json` (placement-string → preset-name map) | 4,275 B | `sha256:c492755f73c72a5fd0e3687f66cd8d513b1cf429215e18c625d58b2fd1f89c34` |

Console output of every command is under `artifacts/run-11b/` (`check`, `build`, `e2e`, `baseline`,
`matrix`, `benchmark` and the three batches, each with its stdout, stderr and exit status).
Playwright's own output directory is `artifacts/playwright/`.

Committed alongside this report: `artifacts/placement-experiment-protocol.md` and
`artifacts/placement-analysis.md`.

**The pre-fix artifacts are void (R97) and were moved to `artifacts/void-pre-r92/` before this run
started**, so no stale file could be mistaken for a current one. Not one figure was carried forward
from them; the only pre-fix numbers anywhere in this report are the two blast-radius measurements in
§4.3, which are explicitly attributed to the controller's probes.

---

## 10. Coverage and acceptance map (A-01 … A-14)

| Requirement | Status in this run | Evidence |
|---|---|---|
| A-01 classes / party sizes / duplicates | **green** | `packages/data/test/content.test.ts`; `apps/client/test/controls.test.tsx` (41 tests); the matrix enumerated all 34 unordered class multisets of sizes 1–3 including duplicates, 900 rows each, all complete |
| A-02 eight skills | **green** | `packages/sim/test/actions.test.ts` (32) and `effects.test.ts` (8); the EN/PT-BR locales name all eight and `i18n.test.ts` asserts every bound skill is named in both languages |
| A-03 grid / geometry | **green now; was red before this run** | `grid.test.ts` (14), `invariants.test.ts` occupancy and opaque-cell-id tests, the three R92/R100 tests in `lifecycle.test.ts`, and 30,600 completed one-hour runs with zero invariant failures — see §4 |
| A-04 recipes | **green** | matrix covers the three fixed recipes across every composition and placement; baseline covers `mixed`; `lifecycle.test.ts` "a fixed recipe spawns deterministically without drawing rng" and the mixed-recipe single-roll test |
| A-05 strategies | **green** | `actions.test.ts` selection/fallback/condition tests; `controls.test.tsx` target-mode and rule-order tests |
| A-06 determinism / checkpoints | **green** | `pinned-run.test.ts` against the committed one-hour golden (13,648 events, `rng` 3151307086) — unchanged by the R92 fix commits; `invariants.test.ts` split-anywhere test; `snapshot.test.ts` (24 tests) including the duplicate-live-position rejection |
| A-07 loop / wipes / stalemate | **green** | `lifecycle.test.ts` (32) wipe-limit and respawn tests; `invariants.test.ts` deadline-boundary and stalemate tests; 5,201 of 30,600 matrix rows exercised the `wipe-limit` stop in a real sweep |
| A-08 fixed builds / raw opportunities | **green** | CSV carries `raw_exp` and `raw_gold` and no field is named net gold or useful upgrades; measured in §5.1 |
| A-09 collection / work limits | **green** | `invariants.test.ts` summary-vs-one-event-budget agreement and "stale entries are skipped but still spend the work budget"; `apps/client/test/experiment-worker.test.ts`; `eventlog.test.tsx` 500-row cap |
| A-10 CLI / performance | **partly open** | CLI CSV/JSON with explicit inputs, seeds, versions and hardware metadata: **green** (§5, §6.1). Workstation benchmarks and the 100-job bounded-concurrency batch: **green as workstation results** (§6.2, §6.4). **Single-VPS concurrency target: open, not tested on the target VPS** (§6.5). **Sub-second goal: evaluated, not asserted** (§6.6) |
| A-11 browser / comparison | **partly open** | six-spec Playwright smoke green including the two comparison slots (§2.3). **R64's visual composition judgement is open** — a human must look (§11) |
| A-12 languages / art | **partly open** | `i18n.test.ts` key parity in both directions plus content-name coverage; the PT-BR smoke drives the whole journey through the shipped translation; art manifest covered in `battlefield.test.tsx`. **Bilingual visual inspection is open** (§11) |
| A-13 verification | **green** | every automated command in §2 and §5–6 run against this commit, with exit status and raw output recorded |
| A-14 human grid decision | **PENDING (requires five human testers)** | measurable half computed in §7 from the complete matrix; the tester protocol is `artifacts/placement-experiment-protocol.md` (§8) |

---

## 11. Gates that are open

None of these were run, and none is claimed to have passed.

1. **A-14, the five-person placement experiment.** Requires five human testers. Protocol delivered;
   gate open. (§8)
2. **R64's visual composition checks** — that the layout *looks* right at 1440×900 and 1280×800,
   that nothing clips at 1100 px, and a bilingual EN/PT-BR inspection. The Playwright suite measures
   horizontal overflow only (`scrollWidth - clientWidth <= 0`), which is a different question from
   whether a composition reads well. A human has to look at the page. Gate open.
3. **The single-VPS concurrency target.** Not tested on the target VPS; no VPS was available to this
   run. Gate open. (§6.5)
4. **The sub-second goal** is not a pass/fail entry here at all: §13 says it is evaluated, and §6.6
   reports the measured distribution rather than a verdict.
5. **The CI workflow has not been observed running on GitHub** from this session. Every step it
   contains was run locally against this commit and passed (§2, §3), which is not the same as a
   green Actions run.

---

## 12. Recommendation: **retain the combat prototype; do not yet treat the placement design as settled**

Scoped honestly to the automated evidence in this report. The human gate is outstanding, so this is
a recommendation about what the machine-measurable half supports, not a milestone sign-off.

**Retain the engine and the simulation contract.** The evidence for this is strong and it is
first-hand:

- 30,600 one-hour runs across every composition, fixed recipe and placement completed with zero
  invariant failures, zero error rows, and a census that matches its parameters exactly.
- Determinism is pinned to a committed golden that a one-millisecond change in RNG consumption would
  break, and that golden is unchanged across the correctness fix this task's evidence run forced.
- Cost is modest and predictable: a twelve-hour catch-up is 608 ms at the median in isolation, a
  twenty-four-hour one 1,135 ms, with peak RSS around 105 MiB per isolated run, and 100 twelve-hour
  jobs clear in 10.6 s at concurrency 16 on this workstation.
- The browser path is wired end to end and works in both shipped languages.

There is nothing in the measured data suggesting the combat model should be replaced with an
offline formula, and §13's fallback of "use profiles to choose the next optimization" is not
triggered — no automated gate failed on performance.

**Do not read the placement question as answered.** Two findings argue for a focused revision before
any expansion, and both come out of §7:

1. Under the stricter reading of §13's own gate sentence, the measured half **fails**: the
   class-aware default placement wins all three fixed recipes outright, so no *recipe* is a reason
   to place differently. Under the looser reading it passes, because the default is beaten in 47 of
   102 composition × recipe cells and often by a wide margin. §13 says that if either gate fails the
   recommendation is simplify/revise and a repeat of a focused experiment before adding maps. Which
   reading the project intends is a decision for the owner, not for this report, and it changes the
   answer — so the report states both rather than choosing the convenient one.
2. The signal that *does* exist is composition-driven, not recipe-driven. If placement is meant to
   be an interesting choice, the lever the data points at is the interaction between party
   composition and geometry, not the recipe.

**Concretely, before anything is added:** run the five-tester session with
`artifacts/placement-experiment-protocol.md`, and have a human perform the R64 visual checks. If the
human gate passes and the owner accepts the looser reading of the measured gate, milestone A's
evidence is complete apart from the VPS target, which needs the VPS. If the human gate fails, §13's
instruction stands: simplify or revise the placement surface and repeat a focused experiment before
adding maps.

**This recommendation authorizes nothing beyond milestone A** (R71). It is not a decision about
milestone B, additional maps, more content, or any production system.
