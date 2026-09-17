# narok-idle — Layer 1 Design Recap (for review)

> **Historical document — superseded.** Use [current Layer 1 design](../layer-1-design.md), [Realm UI spec](../2026-09-16-realm-ui-spec.md) and [handoff](opus-handoff.md). This earlier recap contains obsolete beta EXP penalties and premium rules; it is not implementation authority.

> **Status:** DRAFT for external review. Not an approved spec.
> **Date:** 2026-09-14
> **Codename:** narok-idle (working name only; final public name must not resemble "Ragnarok")
>
> **Legend**
> - ✅ **Decided** — chosen by the project owner during design Q&A.
> - 🟡 **Proposed default** — suggested by the designer, not yet confirmed; numbers are starting points to be tuned.
> - ❓ **Open** — explicitly unresolved; reviewer input wanted.

---

## 1. Vision

A **browser idle MMORPG** inspired by the *systems* of Ragnarok Online (leveling by hunting, equipment drops, cards, refining, classes, class upgrades, rebirth, MVPs, instances, PvP, pets, mounts), rebuilt for idle play:

- The player's party **hunts automatically** — while the tab is open (live view) and while offline (catch-up on return).
- The player's decisions are **strategy** (skills, potions, targeting, positioning) and **loot** (what to keep/sell).
- Presentation: **isometric open map** (Ragnarok-like camera), not a side-view battle strip.

### Legal / IP constraints ✅
- **No Ragnarok Online (Gravity) or Pokémon assets, names, sprites, maps, music or UI** — not even AI-modified versions of them. AI tools must never receive copyrighted sprites as input (no img2img / LoRA / ControlNet on them).
- Game **mechanics** (idle hunting, stats, cards-as-a-concept, refining-as-a-concept, element charts) are free to use; **expression** is not.
- Norse mythology names are public domain; Ragnarok-specific names (Prontera, Poring, etc.) are not.
- Art for Layer 1 is **placeholder, original or CC0 only**. 🟡 Every asset file records source + license in the art manifest.

---

## 2. Scope: layered roadmap ✅

Each layer gets its own spec → plan → implementation cycle. **This document covers Layer 1 only**, but Layer 1 must leave hooks for later layers.

| Layer | Contents |
|---|---|
| **1. Core loop (this doc)** | 4 classes, party of up to 3, auto-combat with strategy, leveling/stats/skills, equipment drops with random bonuses, shared bag, loot filter, consumables, NPC shop, offline progress, premium flags |
| 2. Build depth | Cards, refine, grades/gems, crafting, buffs expansion, quests, class upgrade |
| 3. Group content | Open-world MVPs, instances, pets |
| 4. Multiplayer economy | Market/trading, party with other players, guilds, PvP |
| 5. Long-term | Rebirth, mounts, seasons |

**Target for Layer 1:** closed beta, ~100 players ✅.

---

## 3. Key product decisions ✅

| Topic | Decision |
|---|---|
| Multiplayer | Online, **solo play first**: accounts + server-authoritative progress; no player interaction until Layer 4 |
| Session model | **Tab open (live view) + offline catch-up** |
| Party | **3 full characters** (own class, level, stats, skills, gear); party of 1–3 🟡 so new accounts can hunt |
| Strategy depth | **Preset rules with sliders** (not a free-form gambit/IF-THEN editor) |
| Hunting areas | **Looks open, simulated as encounters** (see §6) |
| Leveling | **Single level** (no base/job split); skill point every X levels |
| Stats | **6 free-point attributes** (STR/AGI/VIT/INT/DEX/LUK) |
| Items | **Base items + random bonuses**; **rarity determines bonus count** |
| Inventory | **Shared account bag with slots** |
| Classes (MVP) | **Tank, Healer, Physical DPS, Magic DPS** (original names) |
| Elements/families | **Yes:** 5 elements + 6 monster families in MVP |
| Monetization | Cosmetics, convenience, **premium account** (see §11). No pay-to-win *items*; drop rates identical for everyone |
| Art | **Placeholders first**, final art later; art is data-driven/swappable |
| Scale | **~100 concurrent** closed beta, single VPS |
| Stack | **TypeScript** everywhere; **React** UI; PixiJS map |
| Auth | **Email + password**; Discord OAuth later |
| Languages | **PT-BR + English** via i18n keys |

---

## 4. Architecture

### 4.1 Repository layout (pnpm monorepo, TypeScript)

| Package | Responsibility |
|---|---|
| `packages/sim` | **Deterministic** combat/progression simulation. No I/O, no `Math.random()`, no wall clock. Runs on server (authoritative) and client (optional previews/tests). |
| `packages/data` | Typed game content: classes, skills, monsters, items, bonus pools, maps, **board config**, element chart, formulas' constants. Has a content version hash. |
| `packages/protocol` 🟡 | Shared REST/WebSocket schemas (zod) used by server and client. |
| `apps/server` | Node.js + Fastify (REST) + WebSocket; PostgreSQL (Drizzle ORM + migrations); worker-thread pool for catch-up. |
| `apps/client` | React + Vite UI; PixiJS isometric renderer; TanStack Query (REST) + Zustand (live hunt state). |
| `tools/balance` 🟡 | CLI that runs the sim for N hours per map/party and outputs CSV metrics. |

### 4.2 Simulation model: "timeline on demand" ✅

Chosen over (B) a real-time server tick loop with a separate catch-up calculator, and (C) rate-based progress with a cosmetic scene.

- **Event-driven sim**: each actor has a `nextActionAt`; the sim jumps between scheduled events (attacks, casts, moves, regen ticks, buff expiry) instead of fixed frames. Goal: 12h (24h premium) catch-up in well under 1s.
- **Seeded PRNG** stored in sim state; integer math where possible; deterministic tie-breaking (time, then stable actor id).
- Core API: `advance(state, untilSimMs) → { state, events }`.
- **Split invariant (must hold):** `advance(S, T)` ≡ `advance(advance(S, t), T)` for any `t < T` — guarantees live view and offline catch-up agree.

### 4.3 Hunt lifecycle

1. **Start hunt** → server stores a **checkpoint**: party snapshot (derived stats, gear, skills), strategy preset, loot preset, map, attempts used, PRNG state, bad-luck counters, sim time, content version.
2. **Client connects** → server fast-forwards from checkpoint to *now* (capped by offline cap) in a worker thread → commits results in **one transaction** → sends "while you were away" report.
3. **Live mode** → server computes the next **30 s** 🟡 of events and streams them; client plays back ~**2 s** 🟡 behind and requests the next window when < **10 s** 🟡 remain. Future events are previews that become real as time passes (determinism).
4. **Player intervention** (equip, strategy, placement, map change) → commit up to now → apply change → new checkpoint → discard precomputed future → new window.
5. **Commits while live** every ~**20 s** 🟡 (each new window). Crash recovery = re-simulate from last checkpoint → identical results, no lost/duplicated loot.
6. **Sim stop conditions**: death attempts exhausted → town; bag full → per strategy (town or stop looting); potions below threshold → per strategy (town); offline cap reached → pause.
7. **Offline cap semantics** 🟡: progress accrues only until `lastSeenAt + cap` (12h; 24h premium). `lastSeenAt` is refreshed by WebSocket heartbeat (~30 s). On return after the cap, the hunt resumes from where it paused; the uncovered wall time is not simulated.
8. **Premium changes mid-offline** 🟡: `premiumUntil` is an input to the sim, evaluated against sim time → deterministic.

### 4.4 Anti-cheat
Client only renders events and sends **intents**; server validates every command and all strategy/loot preset payloads (schema + business rules).

---

## 5. Characters, classes, stats, skills, leveling

### 5.1 Account & characters
- 3 character slots per account (more slots = future convenience purchase) ✅
- Character names: 3–16 chars, globally unique 🟡
- Duplicate classes allowed in a party 🟡

### 5.2 Classes ✅ (skills 🟡)

| Class | Role | Weapons | Range | Skills (max level 5) 🟡 |
|---|---|---|---|---|
| **Guardian** | Tank | Sword + shield | Melee | **Taunt** (up to 3 enemies target Guardian for 4 s) • **Shield Wall** (+20→40% DEF, 10 s) • **Cleave** (120→200% ATK, target + left/right cells) • **Bulwark** passive (2→10% block) |
| **Cleric** | Healer | Mace / staff | Ranged (spells) | **Heal** (50 + 2×INT, ×(1 + 0.25×(lvl−1))) • **Group Heal** (60% of Heal to all allies) • **Blessing** (party +1→5 STR/INT/DEX, 120 s) • **Smite** (100→180% MATK, +50% vs Undead & Demon) |
| **Ranger** | Physical DPS | Bow | Ranged | **Double Shot** (2 × 70→110% ATK) • **Arrow Rain** (80→140% ATK, 2×2 area) • **Focus** (+5→15% crit, 20 s) • **Keen Eye** passive (+HIT, +2→10% ranged ATK) |
| **Arcanist** | Magic DPS | Staff / rod | Ranged (spells) | **Fire Bolt** (130→250% MATK, Fire) • **Frost Nova** (80→140% MATK, Water, plus-shaped area, −30% attack speed 5 s) • **Mana Shield** (absorb 40→200 dmg) • **Channeling** passive (−4→20% cast time) |

- Data includes `upgradesTo` for Layer 2 class upgrades ✅

### 5.3 Leveling
- Single level, **cap 50** in MVP 🟡
- EXP to next level: `floor(50 × level^2.2)` 🟡
- **Skill points every X levels** ✅ (X is data-configurable); default X = 2, +1 point at creation 🟡 → 26 points by level 50 (16 skills × 5 levels = 80 possible, so builds must choose)
- **Party EXP: even split + party bonus** ✅: each member gets `monsterExp × (1 + 0.1 × (members − 1)) / members`
- Level-gap penalty 🟡: reduced EXP when monster level < character level − 10 (prevents power-leveling on trivial maps)
- Premium: **+25% EXP** ✅
- **Points granted only on first reaching a level** 🟡 (tracked `highestLevelReached`) — prevents farming stat/skill points by de-leveling and re-leveling.

### 5.4 Stats ✅ (formulas 🟡)
Base: all stats start at 1; **30 points at creation**; `3 + floor(level / 5)` points per level-up; raising a stat from `v` costs `2 + floor((v − 1) / 10)`; cap 99.

| Stat | Effects |
|---|---|
| STR | Melee ATK, (future) carry |
| AGI | Attack speed, FLEE |
| VIT | Max HP, DEF, healing received, HP regen |
| INT | MATK, Max MP, MDEF, heal power, MP regen |
| DEX | HIT, ranged ATK, cast speed |
| LUK | Crit chance/damage, status resist. **Does not affect drop rate** ✅ |

Derived formulas 🟡:
- `MaxHP = (classBaseHp + classHpPerLevel × level) × (100 + VIT) / 100`
- `MaxMP = (classBaseMp + classMpPerLevel × level) × (100 + INT) / 100`
- `MeleeATK = weaponAtk + STR + floor(DEX/5) + floor(LUK/5)`
- `RangedATK = weaponAtk + DEX + floor(STR/5) + floor(LUK/5)`
- `MATK = weaponMatk + INT + floor(INT/2)`
- `DEF = armorDef + floor(VIT/2)`; `MDEF = armorMdef + floor(INT/2)`
- Damage after defense: `raw × 100 / (100 + DEF)` (or MDEF for magic); ±10% variance
- `HIT = level + DEX`; `FLEE = level + AGI`; hit chance `clamp(80 + HIT − FLEE, 5, 95)%`
- Crit chance `floor(LUK/3)% + bonuses`; crit = ×1.5 damage and ignores FLEE
- Attack interval `weaponIntervalMs × 100 / (100 + AGI + floor(DEX/4))`, min 300 ms
- Cast time `baseCast × (150 − min(DEX, 99)) / 150`

### 5.5 Auto-spend (premium) ✅
- Per-character **build template** (ordered targets, e.g. "DEX→40, INT→60, rest VIT"); recommended templates per class.
- Level-ups during AFK auto-allocate stat points per template. Non-premium: points accumulate unspent.
- Auto-spend covers **stats only**; skill points are always manual 🟡.

### 5.6 Death ✅
- **Wipe** = all party members dead.
- Each wipe: every party member loses **20% of current level's EXP requirement** (**10% for premium**); **de-level possible**.
- **Death attempts: 1–5**, configured before the hunt; **hard cap 5 for everyone**. Owner's reasoning: 5 × 20% ≈ at most ~1 level lost — the cap *is* the safeguard.
- After max attempts → party sent to town, hunt ends.
- Wipe with attempts left 🟡: respawn at map start with full HP after 30 s, continue hunting.
- Single member death in a won fight 🟡: revives at 10% HP after the encounter; no EXP penalty.

---

## 6. Combat, encounters, strategy

### 6.1 Maps ✅ (content 🟡)
- On screen: isometric open map; party walks between monster groups.
- In sim: each map = level range + weighted **monster group table** (monster types, group size, formation) + walk time between groups.
- **Skip rules: none** in Layer 1 ✅ — the party engages every group it meets.

MVP maps 🟡 (original names, ~3 monster types each):

| Map | Levels |
|---|---|
| Meadow Outskirts | 1–10 |
| Whispering Woods | 8–18 |
| Sunken Crypt | 16–26 |
| Ember Quarry | 24–34 |
| Frostfang Pass | 32–42 |
| Hollow Citadel | 40–50 |

### 6.2 Encounter loop
Walk → **fight** → **loot filter** → **rest** (if thresholds) → next group.

- Regen tick every 5 s 🟡: HP `+max(1, floor(MaxHP/100) + floor(VIT/5))`, MP `+max(1, floor(MaxMP/100) + floor(INT/6))`; multiplier fighting ×0.5, walking ×1, resting ×4.
- Rest 🟡: starts when any member HP < rest-HP% or MP < rest-MP%; ends when all HP ≥ 90% and MP ≥ 80%.

### 6.3 Battlefield / positioning — ⚠️ MUST BE EASY TO CHANGE

**Current choice:** 5×5 grid ✅, but the owner is **not convinced a grid is right** ❓. Requirement ✅: **the positioning model must be swappable without rewriting combat.**

**Design for changeability:**
- All geometry lives behind a `Battlefield` interface inside `packages/sim`; combat logic never touches coordinates directly:
  - `distance(a, b)`, `inRange(actor, target, range)`, `nextStepToward(actor, target)`, `cellsInShape(origin, shape)`, `canReach(actor, target)`, `spawnPositions(formation)`, `placementSlots()`
- **Implementations:**
  - `GridBattlefield` (Layer 1 default) — fully driven by a `BoardConfig` in `packages/data`.
  - `RowsBattlefield` (fallback) — the earlier Front/Back row model, implementable against the same interface if the grid is dropped.
- **`BoardConfig` (data, not code):** `width`, `height`, `playerRows`, `enemyRows` (neutral rows derived), `movement: "4dir" | "8dir"`, `distanceMetric: "manhattan" | "chebyshev"`, `maxEnemiesPerGroup`.
- **Ranges** are per class / per monster / per skill in data.
- **Area shapes** are data: lists of relative cell offsets (e.g. plus shape, 2×2, left/right). Validated against the board at content load.
- **Monster formations** are data, validated against `enemyRows` at content load.
- **Saved placements** in strategy presets are stored as cell coordinates plus the board config hash; if the board config changes, placements are **reset to the class-default formation** and the player is notified (no crashes, no invalid positions).
- **Client** renders the board and generates the placement editor from `BoardConfig` — no hardcoded sizes.
- **Sim tests** run the core combat suite against at least two board configs (and the rows implementation if built) to prove combat is geometry-agnostic.

**Current 5×5 rules (default config):**
```
 row 1  [M][M][M][M][M]   enemy back
 row 2  [M][M][M][M][M]   enemy front
 row 3  [ ][ ][ ][ ][ ]   neutral (no spawns)
 row 4  [P][P][P][P][P]   player front
 row 5  [P][P][P][P][P]   player back
```
- 10 player placement cells (3 characters → 120 layouts); player places freely, saved per strategy preset.
- **4-direction movement**, Manhattan distance (makes blocking meaningful).
- **Ranges:** melee 1; ranged/casters (Ranger, Arcanist, Cleric, ranged monsters) **4**.
- **Area shapes:** Cleave = target + left/right; Arrow Rain = 2×2; Frost Nova = plus shape on target.
- **Max 5 enemies per group.**
- Units out of range step 1 cell toward their target at move speed; cell conflicts resolved by deterministic order (time, then actor id).
- Party returns to its saved placement after each encounter.

Alternatives considered: Front/Back rows (simplest), 4×4 (cramped: 3×3 AoE covers half the board, crowding, trivial ranges), 6 wide × 4 deep, 6×6 (most tactical, most complex).

### 6.4 Targeting & threat 🟡
- Monsters attack the **highest-threat reachable** target.
- Threat: damage dealt → `+damage`; healing → `+floor(heal/2)` on every engaged enemy; Taunt → forced target 4 s and threat set to top + 10%.
- Monster AI: weighted skill list with simple conditions (e.g. self HP below X%).

### 6.5 Damage, elements, families
- Elements ✅: **Neutral, Fire, Water, Earth, Wind**. Chart 🟡: Water > Fire > Earth > Wind > Water; strong ×1.5, reverse ×0.75, Neutral ×1.0.
- Families ✅: **Beast, Undead, Demon, Plant, Insect, Humanoid** (used by bonuses like "+15% vs Undead" and later cards).
- Buffs/debuffs 🟡: timed stat modifiers; reapply refreshes duration (no stacking). MVP statuses: **slow, stun** only.
- Casting 🟡: no interrupts in Layer 1.

### 6.6 Strategy presets ✅ (preset rules + sliders)

**Per character**
- **Skill priority list**: ordered; each skill on/off + one condition with a slider (e.g. Heal: ally HP < 60%; Arrow Rain: enemies in shape ≥ 3; Taunt: when a back-row ally is targeted). Fallback: basic attack. Selection = first enabled skill whose condition holds, off cooldown, enough MP, buff not already active.
- **Potions**: HP potion when HP < X%, MP potion when MP < Y%. **Potion cooldown: 10 s per character** ✅, instant use.
- **Target priority** ✅: *Lowest HP* / *Highest HP* / *Highest level* / *Nearest* / *Attacking [ClassName]* for each party member (label shows class name; appends character name when classes repeat, e.g. "Attacking Ranger (Kaio)").
- **Placement** on the battlefield (§6.3).

**Per party**
- Rest thresholds (HP%, MP%)
- Return to town when HP potions < N
- Bag full behavior: return to town **or** stop looting (auto-sell still applies)
- Death attempts (1–5)

- **3 saved presets** per party 🟡; server validates schema and ranges.

### 6.7 Displayed metrics
Kills/hour, EXP/hour, gold/hour, "time until death" estimate — derived from the event stream.

---

## 7. Items, bonuses, drops, inventory

### 7.1 Equipment ✅ (tiers 🟡)
- **8 slots:** Weapon, Off-hand, Head, Body, Cloak, Shoes, Accessory ×2. Weapons restricted by class.
- Base items in **5 tiers** (level requirement 1 / 10 / 20 / 30 / 40) 🟡.
- **Item instance** (DB): unique id, base item id, rarity, item level (= dropping monster's level), bonuses `[{stat, value}]`, `tradeable` flag, **reserved** `refine`, `cardSlots`, `grade` (unused until Layer 2).

### 7.2 Rarity ✅

| Rarity | Bonus count |
|---|---|
| Common | 0 |
| Uncommon | 1 |
| Rare | 2 |
| Epic | 3 |
| Legendary | 4 |

### 7.3 Random bonuses ✅
- Per-slot-type **bonus pool**; no duplicate stat on one item; value ranges scale with item level (tier = ceil(itemLevel / 10)) 🟡.
- **Mild weighting toward fitting stats: ×2** ✅ for bonuses that suit the item (e.g. DEX/crit on a bow, INT/heal power on a staff); ×1 for other valid bonuses.
  - With ~12 bonuses where 4 fit: ~50% of rolls fit (flat: 33%); a Legendary with all 4 fitting ≈ **1.4%** (flat: 0.2%; ×3: 3.7%).
- Example bonuses: +STR/AGI/VIT/INT/DEX/LUK, +% ATK, +% MATK, +% damage vs family, +% damage vs element, element resist %, +crit, +% attack speed, +% max HP, +HP regen, +% heal power.

### 7.4 Drop rates ✅ (numbers from owner; model 🟡)

**One equipment roll per kill**, stored in parts-per-million (integer math):

| Rarity | Base chance per kill | ppm |
|---|---|---|
| Common | 0.5% | 5,000 |
| Uncommon | 0.2% | 2,000 |
| Rare | 0.05% | 500 |
| Epic | 0.01% | 100 |
| Legendary | 0.001% | 10 |

- **Monster drop multiplier** ✅: each monster scales base rates (normal ×1, tough ×2–3 🟡; elites/MVPs much higher in later layers) so level-appropriate maps yield similar loot **per hour**, not per kill.
- Which base item drops: chosen from the monster's equipment drop list 🟡; item level = monster level (farming weak maps yields low-level gear).
- Gold: every kill (range per monster). Consumables: separate roll per monster data 🟡. No materials in Layer 1.
- **Identical for all players** ✅ (premium does not change rates).

**Expected volume** (assumption ❓: ~1,000 kills/h × 20 h/day = 20,000 kills/day):

| Rarity | / day | / week | / month |
|---|---|---|---|
| Common | 100 | 700 | ~3,000 |
| Uncommon | 40 | 280 | ~1,200 |
| Rare | 10 | 70 | ~300 |
| Epic | 2 | 14 | ~60 |
| Legendary | 0.2 | 1.4 | ~6 |

P(≥1 Legendary): ~18% per day, ~75% per week, ~100% per month. A *specific* legendary base with good bonuses is effectively hundreds of days of farming.

**Bad-luck protection** ✅ (hidden; thresholds 🟡):
- Epic: after 30,000 kills without an Epic+; Legendary: after 150,000 kills without a Legendary.
- Past threshold, chance increases by +10% of base per additional 10,000 kills; resets on drop.
- Counters are **per account**, carried in sim state (deterministic) and persisted.

### 7.5 Inventory ✅ (numbers 🟡)
- **Shared account bag**, 100 slots 🟡; consumables stack to 999 🟡; equipped items don't use slots. Extra slots = future convenience purchase.
- Potions consumed automatically from the bag per strategy.

### 7.6 Loot filter ✅
- Ordered rules, first match wins, mandatory default rule.
- **Conditions:** category (equipment/consumable/material), slot, rarity ≥, bonus count ≥, has bonus [stat], item level ≥.
- **Actions:** **Keep** / **Auto-sell** (converted to gold on pickup, uses no slot) / **Ignore**.
- 3 saved presets 🟡.
- 🟡 Auto-sell price = base item sell price × rarity multiplier (1 / 1.5 / 2.5 / 4 / 7).

### 7.7 Town (Layer 1)
NPC shop (buys items; sells potions), equip/unequip, stat & skill allocation, strategy editor (incl. placement), loot filter editor. No trading ✅ (items already have ids/owners for Layer 4).

- Consumables 🟡: **Small HP Potion** heals 25% Max HP; **Small MP Potion** restores 20% Max MP (percent-based so they stay relevant with the 10 s cooldown).
- Starting kit 🟡: 20 Small HP Potions + class starter weapon.

---

## 8. Server & data

### 8.1 Server
- **REST** (JSON, zod-validated): auth, characters, town actions, presets, hunt start/stop/change.
- **WebSocket**: hunt event windows, reports, heartbeats.
- **Per-account serialization**: commands processed one at a time (row lock on `hunts`).
- **Worker thread pool** for catch-up.
- **Content versioning**: data hash stored with checkpoints; after a balance deploy, hunts continue from their checkpoint using new data (derived stats recomputed on load); client refetches content on mismatch.

### 8.2 Database (PostgreSQL + Drizzle)

| Table | Contents |
|---|---|
| `accounts` | email, password hash, gold, `premium_until`, bag size |
| `sessions` | session id, account id, expiry |
| `characters` | slot, name, class, level, exp, `highest_level_reached`, stats, unspent stat/skill points, skills, build template, auto-spend flag |
| `items` | equipment instances (see §7.1), equipped-by character + slot |
| `stack_items` | account, item id, quantity |
| `strategy_presets` / `loot_presets` | JSON payload + schema version (+ board config hash for placements) |
| `hunts` | one per account: map, status, checkpoint (incl. PRNG + bad-luck counters), attempts used, sim/wall anchors, content version, `last_seen_at` |
| `hunt_reports` | last N away summaries |

**Commit rule:** each simulated segment is committed in **one transaction** (characters, items, stacks, gold, new checkpoint) with an optimistic check on the checkpoint version — abort & retry if it changed; no double-counting.

### 8.3 Auth ✅ (details 🟡)
- Email + password; argon2id hashing; httpOnly Secure SameSite=Lax session cookie; Origin check on mutations and WebSocket upgrade; rate limiting on login and commands.
- No email verification or self-service password reset in beta; admin CLI resets passwords 🟡.

### 8.4 Admin tooling 🟡
CLI scripts: grant/revoke premium, reset password.

---

## 9. Client
- Screens: Login, Town (characters, equipment, stats, skills, shop), **Hunt**, Strategy editor (incl. board placement), Loot filter editor, Away report modal.
- Hunt screen: PixiJS isometric map; on encounter, the board area is highlighted on the map; party panel (HP/MP bars, skills, element strengths/weaknesses), event log, kills/EXP per hour.
- Event player: ~2 s playback delay; requests next window at < 10 s buffer.
- **Art manifest**: sprite keys → files; placeholders replaceable without code changes.
- i18n: react-i18next; PT-BR + EN; game data uses translation keys (`monster.<id>.name`); server returns error **codes**, never display text.

---

## 10. Error handling
- **WebSocket drop:** client reconnects with backoff; server resumes at current sim time.
- **Server crash:** re-simulate from last checkpoint → identical outcome.
- **Invalid commands:** 4xx with error codes; client shows localized messages.
- **Sim invariant violation** (negative HP/stack, invalid position, etc.): hunt safely stopped (party to town), seed + checkpoint logged for exact reproduction.

---

## 11. Monetization & premium ✅
- Cosmetics, convenience (extra character slots, bag slots), **premium account**.
- **Premium perks (Layer 1):** +12 h AFK (24 h total offline cap), +25% EXP, death EXP loss 10% instead of 20%, stat auto-spend. More "premium tools" later.
- Death attempts cap (5) is the same for everyone.
- Drop rates identical for everyone — but note premium's longer AFK ≈ up to 2× loot volume in practice.
- Layer 1 beta: premium granted by admin; **no payment integration**.

---

## 12. Testing
- **Sim (Vitest):** formula unit tests; determinism (same state + seed → identical events); **split invariant** (0→T ≡ 0→t→T); property-based invariants (fast-check); golden snapshot of a 1-hour hunt; combat suite run against ≥2 board configs.
- **Balance CLI:** simulate N hours per map × party composition → kills/h, EXP/h, gold/h, deaths/h, items/day per rarity (CSV).
- **Server:** integration tests against real PostgreSQL (transactions, catch-up, concurrent commands, premium boundary).
- **Client:** component tests for strategy/placement and loot editors; one Playwright smoke test (login → start hunt → events render).
- **CI:** GitHub Actions — typecheck, lint, tests.

## 13. Hosting
- Closed beta: one VPS with Docker Compose (server, PostgreSQL, Caddy for HTTPS).
- Local dev: PostgreSQL in Docker.

---

## 14. Open questions for reviewers ❓

Please give concrete, prioritized feedback. Most valuable:

1. **Battlefield model** — Is a 5×5 grid worth its complexity for an *idle* game, versus Front/Back rows or a different model? Is the `Battlefield` interface abstraction sufficient to swap later?
2. **Determinism** — Risks in the "timeline on demand" approach (JS number determinism, event ordering, content version changes mid-hunt, split invariant). Anything missing?
3. **Drop economy** — Is ~1,000 kills/h a reasonable target? Are the rates + monster multiplier + bad-luck protection sound, especially once a player market exists (Layer 4)?
4. **Death penalty** — 20% (10% premium) per wipe, up to 5 wipes, de-level allowed, applied to all 3 characters while offline. Too harsh / fine?
5. **Premium fairness** — +25% EXP, 24 h AFK, half death penalty, auto-spend: acceptable "convenience", or perceived pay-to-win? Consumer-law concerns (Brazil)?
6. **Stat/skill economy** — Formulas in §5.4; 26 skill points vs 80 possible; stat cost curve. Any degenerate builds?
7. **Scope** — Is Layer 1 realistic for a small team? What should be cut first?
8. **Layer hooks** — Does Layer 1 leave the right hooks for cards, refine, market, PvP (async 3v3 using the same sim?), MVPs?
9. **Security** — Any gaps in auth, command validation, or WebSocket handling?
10. **Anything contradictory or ambiguous** in this document.
