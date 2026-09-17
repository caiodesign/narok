# narok-idle — Layer 1 Design Plan

> **Status:** Revised design draft. The owner accepted the review recommendations for topics 1–8; this document incorporates them. Remaining proposed defaults and open questions still require specification or tuning before their dependent implementation.
> **Date:** 2026-09-14
> **Revision:** 3 — post-review plus owner-selected Realm Refined UI, 2026-09-16
> **Main UI:** [Realm UI specification](2026-09-16-realm-ui-spec.md) and `codex-examples/realm-refined/`. Gameplay rules here override illustrative mockup content.
> **Codename:** narok-idle (working name only; final public name must not resemble "Ragnarok")
> **Source:** The owner's pasted Layer 1 recap and the subsequently accepted recommendations. The legal/IP constraints have not been revised.

## Decision legend

- ✅ **Decided** — original decisions retained, or review recommendations subsequently accepted by the owner.
- 🟡 **Proposed default** — starting values or detailed rules still subject to confirmation and testing.
- ❓ **Open** — an unresolved decision; identify and resolve it before implementing the affected behavior.

## Changes accepted in this revision

- Keep deterministic, event-driven simulation; make its state, event boundaries, clock handling, and migration contract explicit.
- Precompute privately; never send future combat or loot outcomes to clients.
- Apply strategy changes after settling elapsed progress; equipment and party changes happen in town. Stop/start cannot grant free recovery or reset randomness.
- Pin simulation and content versions. Use a maintenance settlement and migration process for beta updates.
- Grant one skill point at creation and one every four levels: 13 points by level 50 against 20 ranks per class. Respecs are free during beta.
- Prototype only the 5×5 battlefield. Preserve geometry boundaries without promising that grid-specific abilities transfer unchanged to rows.
- Remove EXP loss and de-leveling for beta. Default to one maximum wipe per hunt, configurable up to five.
- Give everyone stat auto-spend, identical death rules, and the same offline cap during beta. Premium tests cosmetics and extra saved presets, with no progression advantage.
- Evaluate drops through useful-upgrade times and resource sustainability. Replace the gradual pity ramp with a tier-specific hard guarantee whose threshold is selected from simulation results.
- Deliver a combat prototype, then a persistent playable loop, then the expanded closed beta.
- Prioritize stable ownership, auditable resource changes, migrations, and separate rulesets over unused future database fields.

## 1. Vision

A **browser idle MMORPG** inspired by the *systems* of Ragnarok Online (leveling by hunting, equipment drops, cards, refining, classes, class upgrades, rebirth, MVPs, instances, PvP, pets, mounts), rebuilt for idle play:

- The player's party hunts automatically while the tab is open and through offline catch-up on return.
- Decisions center on party composition, skills, consumables, targeting, placement, and loot.
- Presentation uses an isometric open map, with encounters providing the simulation boundary.
- The Layer 1 product test is: **Can a player understand a hunt's result, change their setup, and recognize the effect on the next hunt?**

### Legal / IP constraints ✅

- **No Ragnarok Online (Gravity) or Pokémon assets, names, sprites, maps, music or UI** — not even AI-modified versions of them. AI tools must never receive copyrighted sprites as input (no img2img / LoRA / ControlNet on them).
- Game **mechanics** (idle hunting, stats, cards-as-a-concept, refining-as-a-concept, element charts) are free to use; **expression** is not.
- Norse mythology names are public domain; Ragnarok-specific names (Prontera, Poring, etc.) are not.
- Art for Layer 1 is **placeholder, original or CC0 only**. 🟡 Every asset file records source + license in the art manifest.

## 2. Layered roadmap and delivery milestones

Each layer gets its own spec → plan → implementation cycle. This document covers Layer 1. Later layers are architectural considerations, not implementation requirements for this layer.

| Layer | Contents |
|---|---|
| **1. Core loop** | Four classes, party of up to three, auto-combat and strategy, leveling/stats/skills, random equipment bonuses, shared bag, loot filter, potions, NPC shop, offline progress, cosmetic/preset premium flags |
| 2. Build depth | Cards, refine, grades/gems, crafting, buffs expansion, quests, class upgrade |
| 3. Group content | Open-world MVPs, instances, pets |
| 4. Multiplayer economy | Market/trading, parties with other players, guilds, PvP |
| 5. Long-term | Rebirth, mounts, seasons |

**Layer 1 target:** a closed beta supporting approximately 100 concurrent players on one VPS. ✅

### Layer 1 milestones ✅

| Milestone | Deliverable | Exit criterion |
|---|---|---|
| **A. Combat prototype** | Four classes, two active skills per class, one map, three deliberately different encounter types, three-character parties, simple strategy, 5×5 placement, balance CLI | Deterministic combat works; measured placement and strategy changes produce understandable tradeoffs; catch-up cost is benchmarked |
| **B. Persistent playable loop** | Accounts, town, equipment, potions, shared inventory, basic loot filter, authoritative persistence, offline catch-up, informative away report | Players can complete repeated hunt → understand → adjust → hunt cycles; recovery and concurrency checks pass |
| **C. Closed-beta expansion** | Remaining skills, additional maps and equipment, broader progression, onboarding, premium cosmetic/preset experiments, operational hardening | Balance gates, ownership checks, resource limits, backup restoration, and end-to-end checks pass |

Do not expand content simply because the simulator runs. Validate that players understand and improve their parties first.

**Deferred from Layer 1:** de-leveling, EXP death penalties, a second battlefield implementation, premium progression modifiers, a "time until death" estimate, payments, trading, and speculative database fields for later item systems. ✅

## 3. Product and platform decisions

| Topic | Decision |
|---|---|
| Multiplayer | Online accounts and server-authoritative progress; solo play first; no player interaction until Layer 4 |
| Session model | Live view and offline catch-up |
| Party | Three full characters, each with class, level, stats, skills, and gear; allow parties of one to three 🟡 |
| Strategy | Preset rules and sliders, not a general IF/THEN scripting editor |
| Hunting areas | Visually open maps, simulated as encounters |
| Leveling | Single level; one skill point at creation and every four levels |
| Attributes | STR / AGI / VIT / INT / DEX / LUK with free-point allocation |
| Equipment | Base items plus random bonuses; rarity determines bonus count |
| Inventory | Shared account bag with slots |
| Classes | Guardian, Cleric, Ranger, Arcanist |
| Elements/families | Five elements and six monster families by expanded beta |
| Beta premium | Cosmetics and extra saved presets; no EXP, death, stat-spending, or offline-cap advantage |
| Art | Placeholders first; manifest-driven and replaceable |
| Stack | TypeScript, React, PixiJS, Node.js, PostgreSQL |
| Auth | Email/password; Discord OAuth later |
| Languages | PT-BR and English through translation keys from the beginning |

## 4. Architecture and authoritative simulation

### 4.1 Monorepo

| Package | Responsibility |
|---|---|
| `packages/sim` | Pure deterministic combat/progression transitions; no I/O, `Math.random()`, or wall-clock reads |
| `packages/data` | Typed classes, skills, monsters, items, bonus pools, maps, battlefield config, element chart, and formula constants; immutable versioned content |
| `packages/protocol` | Shared REST/WebSocket schemas and error codes; zod validation |
| `apps/server` | Node.js/Fastify REST and WebSocket APIs; PostgreSQL/Drizzle migrations; worker pool for catch-up |
| `apps/client` | React/Vite interface, PixiJS map, TanStack Query for REST, Zustand for live playback |
| `tools/balance` | Required from milestone A: simulation CLI producing CSV metrics and distribution summaries |

The server owns all authoritative progression. Client simulation, if added, is for isolated previews/tests and cannot supply authoritative outcomes or receive live hunt PRNG state.

### 4.2 Timeline on demand ✅

Each actor has scheduled events such as attacks, casts, movement, regen, and buff expiry. The simulation advances directly between events rather than fixed frames.

Core API:

```ts
advance(state, untilSimMs) -> { state, events }
```

- Use integer simulation milliseconds, a seeded PRNG, explicit formula rounding, and bounded integer arithmetic.
- Precompute the level EXP table in content rather than repeatedly evaluating fractional powers at runtime.
- Event order is `(timestamp, eventPriority, actorId, sequenceNumber)` with a documented, versioned priority table. ❓ The exact priority order for damage, consumables, expiry, death, and commands must be fixed before combat implementation.
- `advance(S, T)` processes pending events with timestamp `<= T`, once each. Scheduling and checkpoint state must prevent boundary-event replay.
- Every automatic cycle must advance time or consume a bounded queue of same-time events; detect zero-time loops and impossible states.
- Round at defined game events, not at arbitrary requested window boundaries; preserve any necessary fractional remainders.

**Split invariant:** for a fixed simulation version, content version, and scheduled input history, advancing directly to `T` must match advancing to `t` and then to `T`. Equality covers final state, PRNG state, resource totals, and the concatenated ordered event stream.

### 4.3 Complete checkpoint contract ✅

A checkpoint contains everything needed to resume without hidden process state:

- Character progression, allocated stats/skills, derived combat state, equipment references, HP/MP, and build templates.
- Party, map, encounter, enemy state, placements, movement/path state, current targets, and threat.
- Pending actions/casts, cooldowns, statuses, buff sources/expiry, regeneration schedule, and event sequence counters.
- Strategy and loot preset snapshots, rest/walk/retreat state, wipe limit and count.
- Inventory/resource inputs needed by simulation, PRNG state, reward-tier pity state, and deterministic reward sequence identifiers.
- Simulation time, wall/simulation anchors, pause state, simulation version, content version, checkpoint schema version, and account state version.

Reward IDs must be reproducible and collision-safe, for example from a persisted hunt namespace plus reward sequence; simulation must not call an external UUID generator.

Canonical progression and inventory tables are committed atomically with the new checkpoint. Define their relationship explicitly so stale snapshots cannot overwrite newer town actions.

### 4.4 Live hunt lifecycle ✅

1. **Start:** validate the party, map, strategy, inventory, and existing runtime state; persist the hunt checkpoint.
2. **Connect/reconnect:** calculate accrued progress from the stored anchors and old presence timestamp before refreshing presence; simulate, commit atomically, and send an away report plus current state.
3. **Precompute:** the server may privately calculate approximately 30 seconds ahead 🟡 on an isolated state copy.
4. **Release:** send outcome events only after their authoritative timestamps have elapsed. Never send future damage, deaths, loot rolls, or reward outcomes.
5. **Playback:** the client plays elapsed events roughly two seconds behind 🟡. Future-window requests cannot move the authoritative clock or expose the private buffer.
6. **Persist:** checkpoint live progress periodically, approximately every 20 seconds 🟡, and before authoritative mutations. Persisted segments include all corresponding resource changes in one transaction.
7. **Intervene:** settle to the server-assigned command time, validate/apply the intent, create a new checkpoint, and discard any invalid private precomputation.
8. **Recover:** replay from the last durable checkpoint under its pinned versions. Uncommitted private future state is never used as a source of rewards.

A transport reconnect can discard the local animation queue and resynchronize from a current snapshot. Protocol messages carry a hunt generation/version and event sequence so stale events are not played after intervention.

### 4.5 Commands and transitions ✅

- Production strategy application first settles elapsed progress to server time, then queues a validated preset snapshot for the next encounter. Saving alone does not apply it; the current encounter keeps its active rules. See the [UI draft/apply contract](2026-09-16-realm-ui-spec.md#5-strategy). Pending-version persistence and exact command ordering must be specified in milestone B. Milestone A setup edits still require a new experiment.
- Equipment, party composition, and respec changes happen in town. Manual point allocation is available in town; automatic stat allocation happens during hunts.
- Stopping a hunt preserves damage, spent resources, PRNG progression, and pity counters. Restarting never grants a free heal, seed reset, cooldown reset, or encounter reroll.
- A paused encounter resumes from its stored state. Abandoning it for town/map change is an explicit retreat transition, not a silent reset.
- Return-to-town/map-change recovery and travel costs must be specified before milestone B. ❓ They must consume game time/resources as appropriate and cannot provide repeated zero-cost encounter sampling or healing.
- Simultaneous commands use server sequencing; clients cannot backdate changes.
- Scheduled consumable use, rest, walking, respawn, and retreat are simulation transitions, not special offline approximations.

### 4.6 Offline and wall-clock semantics ✅

- Everyone has the same offline cap during beta: **12 hours** is the retained proposed default. 🟡
- Accrual stops at the earlier of a hunt stop condition or `previousLastSeenAt + offlineCap`.
- On return, first settle the old allowance, then update presence and resume from the paused simulation state. Uncovered wall time is not simulated later.
- Heartbeats may refresh presence approximately every 30 seconds 🟡. A maintained connection can accrue continuously; the cap limits unattended disconnection time, not daily production.
- Simulation time and wall time use explicit anchors and diverge during pauses. Clients never provide authoritative elapsed time.
- Entitlement bookkeeping remains outside combat. Beta premium has no simulation modifiers. Any future gameplay entitlement changes require versioned, effective-time transitions mapped from wall time, including expiry/revocation; a wall timestamp must not be compared directly with elapsed sim time.

### 4.7 Version updates ✅

Pin both simulation and content versions to each segment. Never replay an old checkpoint with whichever balance data happens to be deployed now.

For beta updates:

1. Enter maintenance and freeze new gameplay mutations at a recorded cutoff.
2. Settle hunts to their eligible cutoff under the old simulation/content, respecting offline caps and stop conditions.
3. Persist the settlement, then run explicit schema/content/placement migrations.
4. Recompute derived values as part of migration, apply the defined HP/MP adjustment rule, and create new-version checkpoints.
5. Resume with new anchors and notify clients of changed content or reset placements.

Maintenance downtime is an explicit pause; it must not be retroactively simulated with changed balance rules. Retain the old artifacts until settlement/migration completes and recovery is verified. A hash alone is not a replay artifact.

### 4.8 Performance ✅

The desired 12-hour catch-up latency of well under one second is a benchmark hypothesis, not a guarantee. Include a 24-hour stress scenario for headroom and later decisions.

Use the same game transitions for live and offline progress. A detailed collector produces playback events; a summary collector accumulates offline totals without retaining every attack/move. Collection mode must not change state, RNG use, or rewards.

Measure CPU time, memory, event count, queue wait, and end-to-end p50/p95/p99 latency on the intended VPS. Include maximum attack speed, five enemies, movement congestion, statuses, repeated wipes, and many simultaneous returning accounts. Bound worker queues and per-job work; continuation chunks preserve the split invariant.

## 5. Characters, progression, stats, and skills

### 5.1 Characters

- Three character slots per account. ✅ Extra character slots remain a future product decision and do not increase active party size automatically.
- Parties contain up to three characters; duplicate classes allowed. 🟡
- Names: 3–16 characters, globally unique. 🟡 Normalization, case handling, and allowed characters must be specified.
- One active hunt per account. ✅

### 5.2 Classes and skill content

Four classes are decided; detailed skill values below remain proposed defaults for expanded beta.

| Class | Role / weapons | Skills, each maximum rank 5 🟡 |
|---|---|---|
| **Guardian** | Tank; sword + shield | **Taunt:** up to three enemies forced to target Guardian for 4 s; **Shield Wall:** +20→40% DEF for 10 s; **Cleave:** 120→200% ATK, target plus left/right cells; **Bulwark:** passive 2→10% block |
| **Cleric** | Healer; mace/staff | **Heal:** `(50 + 2 × INT) × (1 + 0.25 × (rank − 1))`; **Group Heal:** 60% of Heal to all allies; **Blessing:** party +1→5 STR/INT/DEX for 120 s; **Smite:** 100→180% MATK, +50% vs Undead/Demon |
| **Ranger** | Physical DPS; bow | **Double Shot:** two hits of 70→110% ATK; **Arrow Rain:** 80→140% ATK in a 2×2 area; **Focus:** +5→15% crit for 20 s; **Keen Eye:** passive HIT bonus and +2→10% ranged ATK |
| **Arcanist** | Magic DPS; staff/rod | **Fire Bolt:** 130→250% MATK, Fire; **Frost Nova:** 80→140% MATK, Water, plus-shaped area, −30% attack speed for 5 s; **Mana Shield:** absorbs 40→200 damage; **Channeling:** passive −4→20% cast time |

For milestone A, use two active skills per class. 🟡 Suggested subset: Taunt/Cleave, Heal/Smite, Double Shot/Arrow Rain, Fire Bolt/Frost Nova. Implement other abilities after the core strategic loop is demonstrated.

Skill MP costs, cooldowns, cast times, basic-attack types/ranges, target selection, shield behavior, and full rank scaling must be defined before balancing. ❓ Class upgrades can reference stable class IDs later; upgrade behavior is outside Layer 1.

### 5.3 Leveling and skill budget

- Single level; beta level cap 50. 🟡
- EXP to next level: `floor(50 × level^2.2)`, compiled into a versioned content table. 🟡
- **One skill point at creation, one at every fourth level reached**: 4, 8, …, 48. Total at level 50: **13**. ✅
- Each class has four skills × five ranks = **20 available ranks per character**. ✅ The player cannot max every skill.
- Stat and skill respecs are free in town during beta. ✅ Respecs refund only earned points and cannot heal or duplicate resources.
- Party EXP: each eligible member receives `monsterExp × (1 + 0.1 × (members − 1)) / members`. ✅ Define per-kill rounding/remainders independent of catch-up segmentation.
- Low-level monster EXP penalty when monster level is more than ten below the character. 🟡 Exact curve and dead-member eligibility are open. ❓
- No premium EXP modifier. ✅
- Reaching a level grants its points once; retain awarded-level tracking to make migrations/retries safe. ✅
- Level-ups update derived stats immediately and do not provide a free full heal. ✅ Exact HP/MP preservation/clamping behavior must be specified consistently for all maximum-value changes. ❓

At the proposed EXP split, three members each receive 40% of monster EXP. Measure whether party throughput compensates for the reduced per-character share rather than assuming party size is always beneficial.

### 5.4 Attributes and formulas

Six attributes are retained. All numeric formulas are provisional until costs, cooldowns, equipment values, and monster baselines exist.

- Base stats: all 1; 30 spendable points at creation. 🟡
- On reaching level `L > 1`, grant `3 + floor(L / 5)` stat points. 🟡
- Raising a stat from `v` to `v + 1` costs `2 + floor((v − 1) / 10)`; allocation cap 99. 🟡
- These rules grant **412 points by level 50**. Raising a single stat from 1 to 99 costs **628 points**, so 99 is not reachable through these points alone. This is a stated property of the proposed curve, not a promised progression target.

| Stat | Intended effects |
|---|---|
| STR | Melee ATK; future carry mechanics |
| AGI | Attack speed and FLEE |
| VIT | Max HP, DEF, healing received, HP regen |
| INT | MATK, Max MP, MDEF, heal power, MP regen |
| DEX | HIT, ranged ATK, cast speed |
| LUK | Crit chance/damage and status resistance; never drop rate |

Proposed formulas:

```text
MaxHP = (classBaseHp + classHpPerLevel × level) × (100 + VIT) / 100
MaxMP = (classBaseMp + classMpPerLevel × level) × (100 + INT) / 100
MeleeATK = weaponAtk + STR + floor(DEX/5) + floor(LUK/5)
RangedATK = weaponAtk + DEX + floor(STR/5) + floor(LUK/5)
MATK = weaponMatk + INT + floor(INT/2)
DEF = armorDef + floor(VIT/2)
MDEF = armorMdef + floor(INT/2)
Damage after defense = raw × 100 / (100 + relevantDefense)
Damage variance = ±10%
HIT = level + DEX
FLEE = level + AGI
Hit chance = clamp(80 + HIT − FLEE, 5, 95)%
Crit chance = floor(LUK/3)% + bonuses
Crit damage = ×1.5; crit ignores FLEE
Attack interval = weaponIntervalMs × 100 / (100 + AGI + floor(DEX/4))
Minimum attack interval = 300 ms
Cast time = baseCast × (150 − min(DEX, 99)) / 150
```

Before formula implementation, define rounding, caps, crit/hit ordering, magical accuracy/crit eligibility, and the order of flat, percentage, element, family, and defense modifiers. ❓ VIT healing-received scaling and LUK crit-damage/status-resistance scaling remain unspecified; do not claim these effects work until formulas exist.

Compare specialist and mixed-stat builds. Investigate DEX efficiency and LUK's practical value with measured results before changing their curves.

### 5.5 Universal stat auto-spend ✅

- Available to every account, independent of premium.
- Optional per-character ordered build targets, e.g. `DEX → 40, INT → 60, remaining VIT`.
- Offer recommended templates per class.
- Validate affordability, caps, and ordered-target behavior; insufficient points carry forward.
- Level-ups allocate points immediately when enabled, then recompute derived stats.
- With auto-spend disabled, points accumulate. Skill points are always manual.

### 5.6 Death ✅

- A wipe means all party members are dead.
- **No EXP loss and no de-leveling during beta.**
- Configure a **maximum wipe count**, default **one**, permitted range **one to five**. This is total allowed wipes, not extra retries.
- On reaching the limit, return to town and end the hunt. Before reaching it, use the explicit respawn transition.
- Proposed respawn: full HP after 30 seconds. 🟡 MP, statuses, and cooldown behavior must be specified; only the wipe/respawn transition can grant this recovery, never stop/start.
- A single dead member after an otherwise won encounter revives at 10% HP. 🟡 EXP eligibility is still open.
- Death costs elapsed time and resources already spent. Evaluate whether this supplies sufficient risk before proposing any EXP penalty.
- Away reports expose evidence about failure, such as potion exhaustion, mana depletion, sustained incoming damage, or an exposed damage dealer. Avoid asserting an unsupported causal diagnosis.

## 6. Encounters, battlefield, and strategy

### 6.1 Maps and encounter loop

Visual presentation is an isometric open map. Simulation uses weighted monster groups, their formations, and walking time.

**Loop:** walk → fight → loot filter → rest if necessary → next group.

No skip rules in Layer 1. ✅ Start with one map and three encounter types: melee pressure, ranged pressure, and clustered enemies. Expand after milestone B.

| Expanded-beta map 🟡 | Level range | Content target |
|---|---|---|
| Meadow Outskirts | 1–10 | Approximately three monster types |
| Whispering Woods | 8–18 | Approximately three monster types |
| Sunken Crypt | 16–26 | Approximately three monster types |
| Ember Quarry | 24–34 | Approximately three monster types |
| Frostfang Pass | 32–42 | Approximately three monster types |
| Hollow Citadel | 40–50 | Approximately three monster types |

### 6.2 Regen and rest

- Regen every five seconds. 🟡 HP: `max(1, floor(MaxHP/100) + floor(VIT/5))`; MP: `max(1, floor(MaxMP/100) + floor(INT/6))`.
- Multipliers: fighting ×0.5, walking ×1, resting ×4. 🟡 Specify rounding at each tick.
- Rest starts when any living member falls below an enabled HP/MP start threshold.
- Rest ends when all applicable members reach the higher exit thresholds; suggested exits are 90% HP and 80% MP. 🟡
- Validate start thresholds strictly below corresponding exit thresholds. Define disabled MP checks and impossible-rest behavior to prevent loops. ✅

### 6.3 Battlefield prototype ✅

Implement the **5×5 grid only** in milestone A. Whether the expanded beta retains it depends on the placement experiment.

```text
row 1  [M][M][M][M][M]  enemy back
row 2  [M][M][M][M][M]  enemy front
row 3  [ ][ ][ ][ ][ ]  neutral; no spawning
row 4  [P][P][P][P][P]  player front
row 5  [P][P][P][P][P]  player back
```

- Four-direction movement, Manhattan distance, maximum five enemies per group.
- Melee range 1; ranged/caster range 4 is the starting default. 🟡 Define basic-attack exceptions explicitly, including Cleric weapon behavior.
- No overlapping units and no friendly fire.
- Out-of-range units move toward legal targets. Pathfinding and collision/target ties are deterministic.
- If a target becomes unreachable, retarget according to a defined reachable-target policy. Add a bounded stalemate rule; duration/outcome remains open before combat implementation. ❓
- Parties return to saved placement after each resolved encounter. This is formation setup, not a heal or cooldown reset.
- Ten placement cells give 120 occupied-cell combinations and **720 assignments of three distinct characters**.

### 6.4 Geometry boundary ✅

Combat owns damage, resources, threat, cooldowns, statuses, and priority rules. A `Battlefield` component interprets geometry and returns legal placements, legal targets, actors affected by an ability, reachability, and movement outcomes.

- Combat uses opaque position IDs, not grid coordinates or cell arithmetic.
- The grid adapter and renderer understand coordinates, pathfinding, offsets, shape orientation, and board occupancy.
- Battlefield-specific selectors, including "back row," are interpreted through that boundary; strategy evaluation does not inspect coordinates.
- `BoardConfig` defines width, height, player/enemy spawn zones, movement policy, distance metric, and maximum enemy count.
- Grid ability shapes and monster formations are content validated by the grid adapter. Cleave uses target + left/right, Arrow Rain a 2×2 area, and Frost Nova a plus shape. 🟡 Define orientation and edge clipping before implementation.
- Saved placements include battlefield kind, placement payload, and config hash. Invalid placements after migration reset to class-default formation and notify the player.
- The client generates its placement editor from battlefield configuration, not hardcoded board dimensions.

Do not implement `RowsBattlefield` now. A future rows model may reuse combat calculations while adapting shape/targeting content; full content portability is not promised. Tests across two grid configs verify configurable grids, not proof of arbitrary geometry independence.

**Retention gate:** compare the same party under several placements across the three encounter types. Keep the grid when players can identify and explain different placement advantages; otherwise simplify before broad content production.

### 6.5 Threat, effects, elements, families

- Monsters prefer the highest-threat reachable target. 🟡 Define threat ties and forced-target reachability.
- Damage adds threat equal to damage dealt. Healing adds `floor(effectiveHPRestored/2)` to each engaged enemy; overhealing contributes zero. ✅
- Taunt forces targeting for its duration and sets threat above the previous maximum by 10%. 🟡 Exact rounding and duplicate-Taunt/forced-target precedence are open. ❓
- Monster skills use weighted lists with simple validated conditions. 🟡
- Identical buffs do not stack; the strongest active value applies. ✅ Track sources and expiry so weaker still-active effects can be resolved correctly after a stronger effect ends. Reapplication refreshes the applicable source duration. 🟡
- Beta statuses: slow and stun; no damage-based cast interruption. 🟡 Specify stun's interaction with pending casts/actions before implementation.
- Elements: Neutral, Fire, Water, Earth, Wind. ✅ Proposed cycle: Water > Fire > Earth > Wind > Water; strong ×1.5, reverse ×0.75, Neutral ×1.0. Other pairings must be explicit in the chart. 🟡
- Families: Beast, Undead, Demon, Plant, Insect, Humanoid. ✅

### 6.6 Strategy presets ✅

Per character:

- Ordered skill priorities, each with on/off and one supported slider condition; select the first legal, enabled, ready, affordable skill, with basic attack as fallback.
- Conditions include ally HP, number of affected enemies, and battlefield-supported targeting/formation situations. Passive skills never enter active selection.
- Define stronger-buff replacement eligibility consistently with the effect policy; "buff already active" must not block every useful upgrade.
- HP/MP potion thresholds; potion use is instant with a **shared 10-second potion cooldown per character**. Ordering when HP and MP both qualify must be specified. ❓
- Target priority: lowest HP, highest HP, highest level, nearest, or attacking a selected party member. Store character IDs; display class/name labels to disambiguate duplicate classes.
- Saved placement.

Per party:

- Rest start thresholds and validated exit behavior.
- Return when HP potions fall below N.
- Bag-full behavior: return to town or stop keeping loot; auto-sell can continue.
- Maximum wipes: one by default, up to five.

Three saved strategy presets and three saved loot presets are baseline proposed defaults. 🟡 Premium may add slots; it does not unlock stronger rule types or change simulation behavior. Extra-slot counts and expiry handling remain open. ❓

## 7. Equipment, drops, inventory, and town

### 7.1 Equipment

- Eight slots: weapon, off-hand, head, body, cloak, shoes, two accessories. ✅ Define two-handed/off-hand compatibility before equipment implementation. ❓
- Five base tiers with level requirements 1/10/20/30/40. 🟡
- Instance fields: stable ID, owner account, base item/content reference, rarity, item level, rolled bonuses, trade eligibility, and optional equipped character/slot.
- All beta equipment is non-tradeable. ✅ Determine beta persistence/reset policy before invitations. ❓
- Do not add unused `refine`, `cardSlots`, or `grade` columns yet. Later layers introduce them with explicit migrations. ✅

| Rarity | Random bonus count |
|---|---:|
| Common | 0 |
| Uncommon | 1 |
| Rare | 2 |
| Epic | 3 |
| Legendary | 4 |

Bonus pools are slot-specific, with no duplicate bonus identity on one item. Define whether family/element variants share an identity. ❓ Roll fitting bonuses at weight ×2 and other valid bonuses at ×1. ✅ Values scale with item level; `ceil(itemLevel/10)` is the proposed bonus-value tier. 🟡

Candidate bonuses: attributes, ATK/MATK %, family/element damage, elemental resistance, crit, attack speed, max HP, regen, and heal power. Every implemented bonus requires a defined stacking rule and combat formula.

### 7.2 Starting drop rates

Keep these base rates as initial balance inputs, equal for every account. ✅ One mutually exclusive equipment rarity roll per kill; remaining probability is no equipment. 🟡

| Rarity | Base chance per kill | Parts per million |
|---|---:|---:|
| Common | 0.5% | 5,000 |
| Uncommon | 0.2% | 2,000 |
| Rare | 0.05% | 500 |
| Epic | 0.01% | 100 |
| Legendary | 0.001% | 10 |

- Each monster has an equipment list, gold range, and separate consumable roll. No materials in Layer 1.
- Monster multipliers remain tunable: normal ×1, tougher monsters approximately ×2–3. 🟡 Validate total probability and the interaction with guarantees.
- Item level equals dropping-monster level. Base-tier/reward-tier mapping is explicit content, not inferred from rarity.
- Choose multipliers from measured encounter economics using stated reference parties; equal loot/hour for every possible build is not a promise.

**Illustration only:** at 1,000 kills/hour and 20 hours/day, baseline daily equipment counts are 100 Common, 40 Uncommon, 10 Rare, 2 Epic, and 0.2 Legendary. Legendary probability before pity is approximately 18.1% per day, 75.3% per week, and 99.75% per 30 days. Neither activity nor kill throughput is a target or guarantee.

With three monsters per encounter, 1,000 kills/hour implies 10.8 seconds for the complete walk/fight/rest cycle. Validate the pacing rather than forcing all maps to that number.

### 7.3 Bad-luck protection ✅

Replace the former slow percentage ramp with a simple hard guarantee after a defined number of eligible drop opportunities.

- Track counters per account **and reward tier**, persistently; stop/start never resets them.
- Low-tier farming cannot prepare a guaranteed high-tier reward.
- Define an eligible opportunity independently of UI, session length, and kill credit quirks.
- Keep Epic+ and Legendary protection distinct; specify how Legendary resets Epic+ and how simultaneous guarantees are resolved.
- The guarantee replaces the equipment roll according to a defined precedence, preserving the one-equipment-per-kill rule.
- Thresholds, eligibility weighting for monster multipliers, reward-tier boundaries, disclosure, and migrations remain open. ❓ Choose them from simulated wait distributions before enabling this system in expanded beta. Do not silently retain the old ramp or invent a production threshold.

Milestone A/B baseline drop experiments may run without pity while its parameters are measured; the expanded-beta implementation requires the completed guarantee specification.

### 7.4 Economy metrics and onboarding ✅

Prioritize:

- Time to first equipment drop and first useful upgrade.
- Upgrade usefulness across party compositions and equipment tiers.
- Sustainable gold after consumable spending.
- Time until bag limits or resource exhaustion require intervention.
- Distributions, not just averages, of Epic/Legendary waits.
- Equipment generated, retained, equipped, and sold, grouped by tier/rarity.

Provide a predictable early equipment reward as a one-time onboarding grant; this does not require a quest system. Exact item/trigger is open. ❓ Its grant must be idempotent.

Future market planning uses measured supply, demand, binding, and item removal. Random rarity alone is not an economy design. No trading implementation in this layer.

### 7.5 Inventory and loot filter

- Shared bag, 100 slots; consumables stack to 999; equipped items do not occupy bag slots. 🟡
- Potions are consumed from the shared bag. Simultaneous consumers use deterministic ordering and cannot consume the same unit.
- Ordered loot rules, first match wins, mandatory default. Protection precedes exceptions: Legendary drops receive Keep rather than automatic sale/ignore; locked inventory items are excluded from bulk sale. Keep still obeys capacity/bag-full behavior. Exceptions precede rarity/default rules. See the [accepted inventory UX](2026-09-16-realm-ui-spec.md#6-bag-and-loot-filter). ✅
- Conditions: category, equipment slot, minimum rarity, minimum bonus count, bonus identity, minimum item level. Unsupported material conditions are reserved for later UI exposure.
- Actions: Keep, Auto-sell, Ignore. Auto-sell converts directly to gold without using a slot.
- Suggested sell multipliers: Common 1, Uncommon 1.5, Rare 2.5, Epic 4, Legendary 7. 🟡 Define integer-price rounding.
- Starter filter: auto-sell Common equipment, keep Uncommon+ and supported consumables, with an explicit fallback for future categories. ✅
- When Keep cannot fit an item, follow configured bag behavior. Define deterministic processing of multi-monster rewards, stack overflow, and the triggering item before inventory implementation. ❓

### 7.6 Town

Town supports the NPC shop, equipment/party changes, manual stat/skill allocation, free beta respecs, strategy editing, and loot-filter editing. No trading.

- NPC buys items and sells potions. Prices must be included in sustainability experiments. ❓
- Small HP Potion: heals 25% Max HP; Small MP Potion: restores 20% Max MP. 🟡
- Starting kit: 20 Small HP Potions plus class starter weapon. 🟡 Define kit ownership/grant boundaries so character creation cannot become an unintended gold or potion faucet. ❓
- Recovery and travel must obey the explicit transition policy in §4.5; merely opening town or reconnecting provides no free healing.

## 8. Server, persistence, security, and operations

### 8.1 APIs and concurrency ✅

- REST: auth, characters, town actions, presets, hunt controls, and report reads.
- WebSocket: elapsed hunt events, snapshots/resynchronization, reports, and heartbeats.
- Validate schema, ranges, ownership, and business rules on every intent.
- Require idempotency keys for retriable mutations, scoped to account and operation; replaying a key with different input is invalid.
- One account-wide state version covers all gameplay mutations, including town actions and hunt start when no hunt exists yet.

Mutation sequence:

1. Read a coherent, versioned account/hunt snapshot and record the server command time.
2. Simulate eligible elapsed time outside a long database transaction.
3. Open a short transaction, lock/check the account state version, and validate the command against settled state.
4. Atomically commit progression, equipment/stacks, gold, reward/audit records, checkpoint, version increment, and idempotency result.
5. If the version changed, retry from fresh state under defined ordering; never apply a stale worker result.

All gameplay mutation paths participate in this policy. Do not rely solely on a row lock on `hunts`, because accounts also mutate while in town. Bound retries and queue duplicate catch-up work rather than allowing unbounded worker contention.

### 8.2 Proposed persistence model

| Table / record | Contents |
|---|---|
| `accounts` | Email, password hash, gold, bag capacity, account state version, beta premium entitlement |
| `sessions` | Session lookup data, account, expiry/revocation |
| `characters` | Slot, name, class, level/EXP, awarded-level tracking, allocated/unspent points, skills, build template, auto-spend, persistent condition |
| `items` | Stable ID, account owner, versioned base reference, rarity/level/bonuses, non-tradeable beta flag, equipped character/slot |
| `stack_items` | Account, item definition, quantity |
| `strategy_presets`, `loot_presets` | Owner, payload/schema version, battlefield/config identifiers where applicable |
| `hunts` | One per account; status/map, complete checkpoint, simulation/content/schema versions, time anchors, presence, generation |
| `account_drop_protection` | Persistent counters per account/reward tier; synchronized atomically with checkpoint state |
| `hunt_reports` | Bounded retained away summaries |
| `command_results` | Account-scoped idempotency key, input identity, result, retention metadata |
| `resource_audit` | Currency/item changes and their reason/source identifiers, committed with the change |
| `account_grants` | Idempotent onboarding/admin grant records |

Enforce ownership, one item per equipped slot, character-slot uniqueness, nonnegative quantities, and other applicable constraints in the database as well as application validation. Exact schema/retention choices belong to the persistence specification.

### 8.3 Auth and transport

- Email/password with argon2id; httpOnly, Secure, SameSite=Lax session cookie. ✅
- Explicit Origin allowlist for mutations and WebSocket upgrades; HTTPS/WSS in deployment.
- Rotate sessions at login. Password reset invalidates existing sessions and associated sockets.
- Expiring/revoked sessions lose socket access; authentication at upgrade is not perpetual authorization.
- Check ownership of every supplied item, character, preset, and hunt reference.
- Rate-limit login and commands; cap message sizes, connections, worker jobs, and pending output. Implement backpressure.
- Do not expose live hunt seeds, private future events, credentials, or session secrets in client payloads/logs.
- No email verification or self-service password reset in beta; admin CLI recovery is the proposed default. 🟡 Define the identity check and credential handoff process before invitations. ❓

### 8.4 Admin and recovery

Admin CLI: grant/revoke beta premium and reset passwords. 🟡 Record administrative resource/entitlement changes without logging secrets.

Before inviting players:

- Configure durable backups outside the single VPS failure boundary.
- Test restoration into a clean database/application environment.
- Verify migrations and rollback/recovery procedures with pinned artifacts.
- Test crash recovery, duplicate requests, concurrent inventory changes, socket expiry, and bounded catch-up load.
- Establish operational metrics for failed hunts, worker queue/latency, transaction conflicts, and resource anomalies.

## 9. Client and presentation

**Primary design:** the owner selected the five [Realm Refined screens](codex-examples/realm-refined/index.html) on 2026-09-16. The [Realm UI specification](2026-09-16-realm-ui-spec.md) governs their implementation, milestone mapping, and corrections to obsolete sample values. Preserve the fantasy world and bronze/iron visual system, quieter nested frames, explicit draft/application state, equipment comparison, staged allocation, and actionable away reports. The gallery is review tooling, not a game screen. Earlier designs are historical references.

- Screens: login, town, hunt, strategy/placement editor, loot editor, away report.
- Hunt view: isometric PixiJS map, highlighted encounter area, party HP/MP, current actions, relevant elements/effects, and a readable event log.
- Render elapsed authoritative outcomes with a small playback buffer. Reconnection or commands can replace the local queue using versioned snapshots.
- Display observed kills/hour, EXP/hour, gold/hour, potion usage, and hunt duration with an explicit observation window. Do not show a "time until death" forecast in Layer 1.
- Reports summarize production, useful loot, resource consumption, rest, wipes, stop reason, and evidence about failures. They should help the player choose an adjustment.
- Art manifest maps semantic sprite keys to replaceable assets. Asset provenance remains the proposed default in §1.
- PT-BR/EN via react-i18next; game content uses translation keys and server failures use stable error codes, never localized display text.

## 10. Premium and monetization

- No payment integration in Layer 1. Premium is granted/revoked by admin.
- Beta premium is limited to cosmetics and additional saved strategy/loot presets. ✅ Exact cosmetic content and extra-slot counts remain open.
- Every player receives stat auto-spend, the same offline cap, the same maximum-wipe range, the same death behavior, and identical EXP/drop rules. ✅
- Remove the former +25% EXP, 24-hour premium cap, reduced death penalty, and premium-only auto-spend from Layer 1.
- Premium expiry must not silently change a running hunt's selected rules. Define access to excess saved presets without deleting user data before this experiment launches. ❓
- Future character/bag-slot purchases and any progression benefits require a separate product decision. If progression benefits are later introduced, describe them explicitly and model effective-time changes before implementation.

## 11. Error handling

- **Socket loss:** reconnect with backoff, settle eligible progress, and resynchronize from current state.
- **Server crash:** replay from the durable checkpoint under pinned artifacts and commit once; no duplicated rewards.
- **Stale command/worker result:** reject or retry against a fresh account version; never merge stale inventory deltas blindly.
- **Invalid command:** localized client explanation from a stable server error code.
- **Invalid sim state:** roll back the failing segment, preserve the last valid checkpoint and reproduction inputs, mark the hunt as faulted, and stop automatic retries. Do not charge a wipe penalty or invent a town settlement from corrupt state. Recovery/return to town uses an explicit validated action.
- **Stalemate:** resolve through the versioned combat rule, separately from an engine invariant failure.
- **Content mismatch:** clients refetch content and invalidated placement UI; server never silently substitutes versions for replay.

## 12. Validation and balance gates

### Simulation

- Formula and effect tests, same-state/seed determinism, and randomized split-invariant tests.
- Compare detailed and summary collection modes: same state, RNG, resource totals, and event accounting.
- Split exactly at attacks, cast completion, expiry, regen, loot, level-up, potion consumption, wipe, and cap boundaries.
- Serialize/reload checkpoints mid-encounter and reproduce subsequent outcomes.
- Invariants for ownership/resources, HP/MP bounds, legal positions, finite scheduling, and unique reward identifiers.
- Core combat tests across at least two grid configurations; targeted congestion/unreachable/stalemate cases.
- Golden one-hour hunt fixture pinned to simulation/content versions; changes require an explained fixture update.

### Balance CLI

- Compare specialist/mixed stats, solo/duo/trio throughput, every class composition, and duplicate-class interactions.
- Report kills, progression, gold net of potions, resource exhaustion, rest, wipes, useful upgrades, bag interventions, and equipment production.
- Evaluate multiple seeds and wait-time distributions; do not infer Legendary tails from a single short simulation.
- State party/build/activity assumptions for every reported result.
- Use results to select drop-protection thresholds, costs/cooldowns, map progression, and the useful-upgrade cadence.

### Server, client, and operations

- PostgreSQL integration: atomic settlement, version conflicts, retried commands, ownership, idempotent grants, and recovery.
- Clock scenarios: reconnect after cap, multiple tabs, repeated heartbeats, maintenance migration, and no retroactive accrual after presence refresh.
- Verify clients receive no future authoritative outcomes or PRNG state.
- Exercise session reset/expiry, socket limits, worker limits, and output backpressure.
- Component checks for strategy, placement, loot editing, and report interpretation.
- Playwright smoke flow: login → configure → hunt → elapsed events → return/reconnect → away report.
- Backup restoration and migration settlement on the target deployment setup.
- CI: typecheck, lint, tests. Performance results recorded separately on stated hardware.

## 13. Hosting

- One VPS with Docker Compose: server, PostgreSQL, and Caddy for HTTPS.
- Local development uses PostgreSQL in Docker.
- Treat 100 concurrent players as a load-test target; size worker concurrency and memory from measurement.
- Maintain off-host backups and the required versioned artifacts for replay and migration.

## 14. Future-layer boundaries

Preserve stable IDs, explicit ownership/trade eligibility, versioned effects, auditable resources, and reliable migrations. ✅ Do not implement unused systems merely to create hooks.

- **Cards/refine/grades:** extend item definitions/instances and effect composition through migrations in Layer 2.
- **Trading:** add atomic cross-account transfers, market rules, and supply/removal mechanisms using beta observations; the per-account transaction model alone does not implement trades.
- **Async PvP:** plausible reuse of combat transitions with a separate ruleset, content/balance configuration, and controlled snapshots. It is not automatically balanced by PvE tests.
- **MVPs/multiplayer parties:** require coordination and ownership rules beyond isolated account hunts. Plan that architecture when the layer is specified.
- **Rebirth/seasons:** require explicit progression/reset rules and migrations; no early database placeholders substitute for them.

## 15. Remaining decisions and their gates

| Decision | Resolve before |
|---|---|
| Event priority table, rounding/stacking rules, basic-attack definitions, skill costs/cooldowns | Milestone A combat implementation |
| Stalemate, path blocking, shape orientation, duplicate Taunt, stun/cast behavior | Milestone A encounter validation |
| Whether placement produces understandable value and the grid should remain | Broad content expansion |
| HP/MP adjustments on stat/max changes, dead-member EXP, respawn MP/status handling | Progression/respawn implementation |
| Retreat/travel/town recovery costs and stop/restart invariants | Milestone B hunt lifecycle |
| Item compatibility, bag-overflow processing, prices, and one-time starter grants | Milestone B inventory/town |
| Predictable first equipment reward and trigger | Milestone B onboarding |
| Pity eligibility, tier mapping, thresholds, reset/precedence, and disclosure | Expanded-beta drop protection |
| Premium extra-slot counts and expiry access policy | Premium preset experiment |
| Beta progression persistence/reset policy and admin recovery procedure | Sending beta invitations |
| Measured catch-up latency and safe worker/connection capacities | Closed-beta launch |

The next implementation planning step is **milestone A only**. Resolve its listed rule gaps, specify a small playable experiment, and use its evidence to guide the rest of Layer 1.
