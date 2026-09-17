# Milestone A — Combat Prototype Specification

**Date:** 2026-09-14\
**Updated:** 2026-09-16 — primary UI reference added; combat defaults unchanged.\
**Status:** Ready for implementation review; detailed mechanics and numbers below are selected prototype defaults.\
**Parent:** [Layer 1 design](layer-1-design.md)\
**Technical contract:** [Simulation contracts](2026-09-14-simulation-contracts-spec.md)\
**Implementation:** [Milestone A plan](2026-09-14-milestone-a-plan.md)

## 1. Objective and approach

Prove that a player can understand an automated encounter, change a party's placement or skill priorities, and recognize the resulting tradeoff. Prove that one deterministic simulator supports playback and accelerated execution with identical outcomes.

Three approaches were considered:

| Approach | Advantage | Cost / decision |
|---|---|---|
| **Headless simulator plus a small browser laboratory** | Tests correctness and whether a human understands placement | Selected; disposable experiment state avoids waiting for accounts and inventory |
| Headless simulator only | Fastest way to benchmark transitions | Insufficient to decide whether the grid is understandable |
| Persistent game slice immediately | Closer to production experience | Accounts, transactions, and inventory delay the unanswered combat experiment |

The laboratory is explicitly an isolated preview/test harness, consistent with the parent document's allowance for client simulation. It is not a server-authoritative release. Never transfer its rewards or snapshots into future production accounts.

## 2. Requirements

| ID | Requirement |
|---|---|
| A-01 | Four classes; party sizes one, two, or three; duplicate classes permitted |
| A-02 | Eight active skills: Taunt, Cleave, Heal, Smite, Double Shot, Arrow Rain, Fire Bolt, Frost Nova |
| A-03 | Data-driven 5×5 grid, configurable spawn zones, deterministic blocking/pathfinding, no friendly fire |
| A-04 | One map with melee-pressure, ranged-pressure, and clustered-enemy recipes |
| A-05 | Ordered enabled skill rules, HP/count thresholds, and the five parent target-priority modes |
| A-06 | Integer event times, seeded RNG, complete snapshots, chunk-independent state and event ordering |
| A-07 | Repeated walk/fight/rest/respawn loop, configurable total wipe limit 1–5, bounded stalemates |
| A-08 | Fixed level-10 builds, measured raw reward opportunities, no actual progression or persistent economy |
| A-09 | Detailed and summary collection with identical state; bounded execution and event retention |
| A-10 | CSV balance runs and performance reports with explicit inputs, seeds, versions, and hardware metadata |
| A-11 | Browser setup, isometric playback, party bars, event explanation, and paired-run comparison |
| A-12 | PT-BR/English UI keys and original geometric placeholders, with a swappable visual manifest |
| A-13 | Checkpoint/replay, split, geometry, lifecycle, and browser smoke verification |
| A-14 | Human placement experiment and documented retain/simplify recommendation |

### Excluded from A

Accounts, server APIs, WebSockets, PostgreSQL, production offline caps, inventory, rolled equipment, potions, shops, point allocation, progression, premium, cards/refine, and public hosting. There are no fake versions of those systems. EXP/gold values are **raw opportunity metrics**, never spendable balances or character EXP.

Only the eight rank-1 skills are available. Each level-10 preset uses two of its three earned skill points; the third is unspent. Full rank scaling and 13-point level-50 builds belong to later content.

## 3. Fixed build data

Attributes are ordered STR/AGI/VIT/INT/DEX/LUK. Each level-10 build has a 64-point budget under the parent curve; unused points remain unspent. The editor selects presets; it does not allocate arbitrary stats in A.

| Class | Attributes | Spent / unspent | Base HP / per level | Base MP / per level | Weapon ATK / MATK | Armor DEF / MDEF | Basic interval |
|---|---|---|---|---|---|---|---|
| Guardian | 11/1/11/1/6/1 | 50 / 14 | 100 / 15 | 30 / 3 | 25 / 0 | 12 / 3 | 1,600 ms |
| Cleric | 1/1/6/16/1/1 | 45 / 19 | 70 / 10 | 70 / 8 | 10 / 22 | 5 / 8 | 1,800 ms |
| Ranger | 1/6/6/1/16/1 | 55 / 9 | 80 / 11 | 40 / 5 | 28 / 0 | 6 / 3 | 1,400 ms |
| Arcanist | 1/1/6/16/6/1 | 55 / 9 | 60 / 9 | 80 / 9 | 5 / 25 | 4 / 8 | 1,900 ms |

Party actors have stable IDs `p0`, `p1`, `p2` assigned by roster order. Enemy IDs are `e0`…`e4` within an encounter; the encounter counter disambiguates them in events. Ties use lexical ASCII ID order, making equal-time enemy actions precede party actions. This is an explicit prototype rule, not simultaneous damage.

Derived stats use the parent's formulas with final flooring for HP/MP, ATK, MATK, DEF, and MDEF. Clamp current HP/MP to their maxima; damage cannot take HP below zero. Basic intervals use ceiling after division and a 300 ms minimum. All movement takes 500 ms.

Guardian and Ranger basic attacks use melee/ranged ATK respectively and physical defense. Cleric and Arcanist basics are Neutral magic using MATK and MDEF, range four, without MP cost. Guardian basic range is one; Ranger basic range is four. Magic always hits and cannot crit in A. Physical basics and physical skills use accuracy and crit rules below.

VIT affects only the implemented HP/DEF/regen formulas in A. LUK affects only crit chance and the listed ATK contributions. Additional VIT healing-received and LUK crit-damage/status-resistance effects are outside this experiment and are not advertised in the UI.

## 4. Damage and randomness

Use basis points (`10,000 = 100%`) for multiplicative factors. Execute these steps separately, flooring after each step:

1. `raw = floor(offensiveStat * skillPowerBp / 10000)`.
2. `raw = floor(raw * elementBp / 10000)`.
3. `raw = floor(raw * familyBp / 10000)`.
4. `raw = floor(raw * varianceBp / 10000)`.
5. If critical, `raw = floor(raw * 15000 / 10000)`.
6. `damage = max(1, floor(raw * 100 / (100 + defense)))` for a hit; zero for a miss.
7. HP reduction and damage threat use effective damage, capped at remaining HP.

There are no shields, blocks, item percentage bonuses, or generic stat buffs in A.

For each valid physical hit attempt draw, in order: crit roll in `[0, 9999]`, accuracy roll in `[0, 9999]`, variance integer in `[9000, 11000]`. Consume all three even for a miss. Crit chance is `floor(LUK/3) * 100` basis points, clamped to 10,000; crit bypasses accuracy. Otherwise hit chance is `clamp(80 + HIT - FLEE, 5, 95) * 100` basis points. A magic hit consumes only variance. Dead/invalid targets consume no hit draws. Healing and Taunt consume no RNG.

Use xorshift32 with nonzero unsigned 32-bit state and rejection sampling for bounded integers. The exact algorithm and RNG vectors are in the technical contract. All target iteration and PRNG consumption are stable; never use iteration order from an unordered external source.

### Element chart

Rows are attack element; columns are defender element. All values are basis points.

| | Neutral | Fire | Water | Earth | Wind |
|---|---:|---:|---:|---:|---:|
| Neutral | 10000 | 10000 | 10000 | 10000 | 10000 |
| Fire | 10000 | 10000 | 7500 | 15000 | 10000 |
| Water | 10000 | 15000 | 10000 | 10000 | 7500 |
| Earth | 10000 | 7500 | 10000 | 10000 | 15000 |
| Wind | 10000 | 10000 | 15000 | 7500 | 10000 |

All six parent families are valid content IDs. Smite applies 15,000 family basis points to Undead/Demon and 10,000 otherwise. Party defenders are Neutral/Humanoid for this prototype.

## 5. Skills and action timing

| Skill | MP | Cooldown | Base cast | Range | Rank-1 effect |
|---|---:|---:|---:|---:|---|
| Taunt | 8 | 8,000 ms | 0 | 4 | Force up to three legal enemies to the caster for 4,000 ms |
| Cleave | 6 | 4,000 ms | 0 | 1 | 12,000 bp physical damage to target and horizontal neighbors |
| Heal | 8 | 2,500 ms | 800 ms | 4 | Restore `50 + 2*INT` HP to one living ally, capped at missing HP |
| Smite | 7 | 3,000 ms | 600 ms | 4 | 10,000 bp Neutral magic, family multiplier above |
| Double Shot | 6 | 3,000 ms | 0 | 4 | Two physical hits of 7,000 bp against the same target |
| Arrow Rain | 12 | 6,000 ms | 700 ms | 4 | 8,000 bp physical damage to enemies in anchored 2×2 shape |
| Fire Bolt | 8 | 3,000 ms | 900 ms | 4 | 13,000 bp Fire magic |
| Frost Nova | 12 | 6,000 ms | 900 ms | 4 | 8,000 bp Water magic in a plus shape; apply 30% attack-rate slow for 5,000 ms to surviving hits |

- Cast duration is `ceil(baseCast * (150 - min(DEX,99)) / 150)`, at least 1 ms even for base cast zero. Basics also resolve at start +1 ms.
- Spend MP and start the skill cooldown at cast start. Effects occur at completion. Damage does not interrupt casts.
- The next action decision occurs at cast completion plus the actor's current basic interval. Moving schedules the next decision 500 ms later without additional recovery. An idle actor retries in 500 ms.
- Targets are chosen at start and resolved against current state at completion. Dead or now-out-of-range single targets fizzle with no refund. AoE follows a living primary target's current position; if the primary is dead/out of range the whole cast fizzles. AoE secondary actors must be inside the clipped shape; they need not be within the caster's primary-target range.
- Double Shot is one atomic completion: hit one, process death, then hit two only if the same target survives. No retarget between hits.
- Process AoE targets by actor ID. Finish death processing after each hit but evaluate encounter completion after the whole cast. Mutually simultaneous lethal events resolve in queue order.
- Dead actors have no actionable casts. Their scheduled actor events become stale through action tokens/encounter epochs.

## 6. Strategy and target selection

Each actor has two ordered active-skill rules, an enabled flag for each, and a target-priority mode. Reordering, enabling, and slider edits happen in setup and take effect on the next **new experiment**. Mid-hunt production intervention is milestone B.

Conditions:

- `always` for any damaging skill.
- `ally-hp-below` from 1–99%, strictly below, for Heal; choose lowest HP percentage among legal living allies, including self, then ID.
- `targets-at-least` from 1–5 for damaging AoE; evaluate eligible primary targets and select the one affecting most enemies, then configured target priority, then ID.
- `ally-targeted` for Taunt: at least one reachable living enemy is currently targeting a different party member; Taunt picks up to three enemies by configured target priority, then ID.

An action decision scans enabled rules in order. Skip unaffordable, cooling-down, unsatisfied, or unreachable choices. The first eligible choice supplies a primary target. Cast if in range; otherwise take one legal step toward an in-range cell. If no skill qualifies, select and approach a basic-attack target. An actor never occupies the target's cell.

Priority modes are lowest absolute HP, highest absolute HP, highest level, nearest, and attacking a selected party ID. The last mode filters first; if there are no matching enemies it falls back to nearest. Distances come from the battlefield. Ties end with ID. Monsters use forced targets, then threat, then nearest, then ID; they have only basic attacks in A.

Default rules:

| Class | First rule | Second rule | Default target |
|---|---|---|---|
| Guardian | Taunt when ally targeted | Cleave if targets ≥2 | Nearest |
| Cleric | Heal if ally HP <60% | Smite always | Lowest HP |
| Ranger | Arrow Rain if targets ≥3 | Double Shot always | Lowest HP |
| Arcanist | Frost Nova if targets ≥3 | Fire Bolt always | Lowest HP |

## 7. Threat and statuses

Threat belongs to each living enemy and is keyed by party ID. Effective damage adds that amount of threat on the damaged enemy. A completed heal adds `floor(actualRestoration/2)` to every living engaged enemy. Overhealing adds zero.

Taunt sets caster threat to `max(1, ceil(previousMaximum * 1.1))`; force takes precedence over threat while active and reachable. Latest successful Taunt replaces the forced source and expiry, including casts from duplicate Guardians. If its source dies or is unreachable, use normal threat; the timed record can remain until expiry. Expiry occurs before actions at that timestamp.

Slow records are per source with explicit expiry. Effective slow is the maximum active attack-rate reduction, not their sum. Reapplying from the same source refreshes expiry. Action recovery is `ceil(baseDerivedInterval * 10000 / (10000 - slowBp))`. Slow changes neither already-scheduled recovery nor movement/cast duration. Only newly scheduled recovery uses the current effect.

Stun is supported as a deterministic test effect, although no A skill inflicts it: decision and cast-completion events move to the latest active stun expiry, retaining MP expenditure and cooldown. Expiry is processed first, then the postponed event. It does not cancel the cast. This closes the scheduler contract without adding monster skill content.

## 8. Battlefield rules

Coordinates exist only in grid data/adapter/renderer. Rows/columns are zero-based internally; displayed rows are one-based. Player spawn rows are 3–4, enemy rows 0–1, neutral row 2. Default board width/height is 5.

- Occupancy blocks movement, including allies. No line-of-sight blocking for attacks; occupied cells do not intercept projectiles.
- Use breadth-first search toward any unoccupied cell satisfying the requested range. Neighbor order: up, left, right, down. Current actor occupancy is ignored for its own starting cell; target occupancy is never ignored.
- Movement checks occupancy again when the step executes. Queue order resolves conflicts. Actors with no route consider other targets; if none exist, idle for 500 ms.
- Manhattan range is inclusive. A target already in range is reachable even if it is otherwise surrounded.
- Shapes are anchored on the primary target with fixed world orientation: Cleave offsets `(-1,0),(0,0),(1,0)`; Arrow Rain `(0,0),(1,0),(0,1),(1,1)`; Frost Nova `(0,0),(-1,0),(1,0),(0,-1),(0,1)`. Pairs mean `(columnDelta,rowDelta)`. Clip at edges; never wrap.
- Geometry returns actor IDs, not cells, to combat. Do not implement rows as a second model in A.

Spawn validation rejects duplicates, out-of-board positions, wrong zones, empty rosters, and oversized groups. Default placement assigns the first Guardian to `(2,3)`; remaining roster members take `(1,4),(3,4),(2,4)` in that order, skipping occupied cells. If no Guardian, members use `(1,4),(3,4),(2,4)`.

The alternate automated-test board is 6×6 with player rows 4–5, enemy rows 0–1, neutral rows 2–3. Tests provide explicit legal placements and do not assert identical combat outcomes across board sizes.

## 9. Map and monsters

Map ID `meadow-lab`; walking time between encounters 2,000 ms. Players can select one fixed recipe or the weighted mix. Fixed-recipe mode consumes no recipe-selection RNG; mixed mode rolls once per encounter. Every recipe has weight one.

| Monster | Level / family / element | HP / MP | ATK / MATK | DEF / MDEF | HIT / FLEE | Basic | Raw EXP / gold per kill |
|---|---|---|---|---|---|---|---|
| Briar Boar | 10 / Beast / Earth | 180 / 0 | 26 / 0 | 10 / 4 | 18 / 14 | Physical, range 1, 1,800 ms | 30 / 3 |
| Reed Slinger | 10 / Plant / Wind | 110 / 0 | 22 / 0 | 4 / 6 | 22 / 16 | Physical, range 4, 2,000 ms | 30 / 3 |
| Mossling | 10 / Plant / Earth | 75 / 0 | 16 / 0 | 3 / 3 | 16 / 12 | Physical, range 1, 1,700 ms | 18 / 2 |

Monsters have zero crit, move in 500 ms, and do not regenerate. Their physical hit attempts still consume all three physical RNG draws for a stable protocol. MP zero disables MP-rest relevance.

| Recipe | Composition and positions `(column,row)` |
|---|---|
| Melee pressure | Three Briar Boars at `(1,1),(2,1),(3,1)` |
| Ranged pressure | Briar Boar at `(2,1)`, Reed Slingers at `(0,0),(4,0)` |
| Clustered enemies | Five Mosslings at `(1,0),(2,0),(3,0),(1,1),(2,1)` |

These values are test inputs, not a claim that all recipes are balanced. Defeated monsters add raw EXP/gold opportunities to metrics; no items are rolled in A.

## 10. Loop, recovery, and bounded failure

Start an experiment with full HP/MP, zero cooldowns, selected seed, and a 2,000 ms walk before the first group. This setup is a disposable experiment reset, not a production hunt-start action.

At encounter spawn, party placement resets, enemies spawn, threat/status state clears, the encounter deadline is scheduled for +120,000 ms, and all first action decisions are scheduled for +500 ms. Party cooldown timestamps carry between encounters.

Regen ticks use one global 5,000 ms schedule from simulation origin. Only living party members regenerate. Per tick: compute the parent base amount, apply fighting 1/2, walking 1, resting 4 with flooring, then minimum one and cap to missing resource. Dead/respawning members do not regenerate.

On victory, revive dead members at `max(1, floor(maxHP/10))`, preserve MP, clear encounter statuses/casts/threat, preserve cooldowns, then rest or walk. Rest starts if HP <50% or MP <30% for any eligible member; it ends when all are at HP ≥90% and MP ≥80%. MP-zero actors skip MP conditions. Rest reevaluates on regen ticks, and walking begins immediately on the successful tick. Setup may change starts within HP 0–89 and MP 0–79; zero disables that start check, but exits remain fixed once rest has started.

On wipe, increment the total wipe counter. If it reaches the configured limit (default one, range 1–5), stop with reason `wipe-limit`. Otherwise wait 30,000 ms, restore party HP/MP fully, clear encounter statuses/casts/threat, preserve cooldown timestamps, then walk to a newly selected group. Only this explicit wipe transition provides the respawn recovery.

At a 120,000 ms encounter deadline, completed same-time actions resolve first. If neither side won, stop with `stalemate`, preserving state for inspection and granting no unearned rewards. Do not count it as a wipe. A final kill exactly at the deadline wins.

A stopped experiment does not accrue time or regen. Calling `advance` again returns the same state and no events. CPU work limits yield a resumable state rather than converting a long computation into a game loss.

## 11. Browser laboratory

Use [Realm Refined and its UI contract](2026-09-16-realm-ui-spec.md) as the primary presentation direction. Adapt Hunt/Strategy to the laboratory requirements below; the full five-screen design does not expand A's scope. Use actual A content, measured comparisons, and supported public explanations. Omit production loot, wallet, premium, allocation, away-report and next-encounter-apply behavior. Mockup numbers, skills and survival forecasts do not override this spec.

Use React for controls and PixiJS for the isometric board; a dedicated worker runs the same package as the CLI. The worker and renderer exchange the public projected state and elapsed event batches; full snapshots are confined to explicit experiment import/export. No production token/account is accepted.

Setup controls: roster/class per slot, recipe/mix, seed, placement, rule order/enabled flags/thresholds, target modes, rest thresholds, wipe limit, language. Support selecting a character and then a legal cell by click or keyboard; color is not the sole signal of selection or invalid placement.

Run controls: start, pause playback, resume, speed 1×/4×/16×, and stop experiment. Changing setup while a run exists requires starting a new experiment and labels the old run as retained comparison A. Pause freezes the laboratory clock; it is not an offline-cap experiment. Retain the last two completed/stopped summaries for comparison.

Playback uses logical elapsed time with a constant 2,000 simulation-ms buffer; its wall-time delay is 2,000 ms divided by playback speed. The worker never publishes events beyond its supplied elapsed simulation target. Clip the final frame at stop time. Bound visible event history to 500 entries and worker batches to 1,000 domain events; use a 25-scheduled-event work budget and acknowledgements/backpressure rather than accumulating an unbounded future. If a batch unexpectedly exceeds the domain-event bound, surface a protocol invariant error rather than dropping events.

Show party HP/MP, cast/current target, damage and healing received/dealt, encounter duration, walking/rest time, kills, wipes, stop reason, raw EXP/gold opportunities, and observed kills/hour. Per-hour denominator is actual simulated elapsed duration, not the requested horizon after an early stop. Zero duration displays an em dash. Explain visible targeting with factual labels such as "Taunted by Guardian" and "Highest threat".

English/PT-BR keys cover controls, validation, events, skill/class/monster names, status labels, and comparison metrics. Draw original polygons/circles and use a local manifest of shape/color keys. No external artwork or image generation is required.

## 12. CLI and measurement

Required command surface:

```sh
pnpm balance run --hours 1 --seeds 1:100 --recipe mixed --party guardian,cleric,ranger --out artifacts/baseline.csv
pnpm balance matrix --hours 1 --seeds 1:100 --out artifacts/matrix.csv
pnpm balance benchmark --hours 12,24 --runs 20 --out artifacts/performance.json
```

`matrix` enumerates all unordered class multisets of sizes 1–3 (34 compositions), all three fixed recipes, and three placements: default, front line, and spread. Front line assigns roster to `(1,3),(2,3),(3,3)`; spread to `(0,3),(2,4),(4,3)`. Run pairings use identical seed inputs, noting that divergent actions consume RNG differently and do not preserve identical later random draws.

CSV columns: simulation/content versions, seed, roster, recipe, placement, requested_ms, elapsed_ms, stop_reason, kills, wins, wipes, rest_ms, walk_ms, fight_ms, raw_exp, raw_gold, damage_dealt, effective_healing, kills_per_hour. Store per-actor detail in a companion JSON file. No field is called net gold or useful upgrades until the real economy exists.

Benchmark runs use summary collection, include process/runtime/CPU/OS metadata, record wall duration and peak sampled RSS, and report p50/p95/p99 across runs. If normal parties stop early, mark that sample short; separately run the engine stress fixture described in the contracts so a requested 12/24-hour workload is actually simulated. Do not extrapolate full-duration cost from a one-minute wipe.

## 13. Acceptance and evidence

Automated correctness:

- Same input/seed produces byte-equivalent canonical final state and ordered domain events.
- Direct, chunked, JSON-restored, and summary-mode runs agree on state and metrics.
- Exact-boundary tests cover status expiry, regen, casts, deaths, timeout, rest exit, and respawn.
- Geometry never overlaps live units, wraps shapes, or emits coordinates from combat APIs.
- Work-budget yields can resume without losing events or consuming extra RNG.
- Browser smoke: configure → start → see elapsed events → pause → resume → finish/stop → compare, in both languages.

Performance evidence: capture measured 12/24-hour results, including a maximum-event stress fixture and a batch of 100 jobs. Do not call the single-VPS concurrency target validated until tested on that VPS. The sub-second goal is evaluated, not asserted.

Human experiment: five testers, three fixed recipes, same party for placement comparisons, and at least two setup changes per tester. Record setup, result, what they expected, and their explanation of the outcome. Working gate: at least four testers can explain a supported effect of their own placement/strategy change, and measured results show more than one placement has an advantage across the three recipes. These are experiment thresholds, not statistical proof. If either gate fails, recommend simplify/revise and repeat a focused experiment before adding maps.

Deliver `artifacts/milestone-a-results.md` with correctness commands/results, versions, benchmark hardware, raw result paths, tester observations, and a retain/simplify recommendation. No fabricated measurements. This file is produced during execution, not by this planning packet.
