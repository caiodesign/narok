# Milestone B — technical specification

**Date:** 2026-09-21. **Status:** draft for the owner's decisions; not yet accepted.
**Supersedes nothing.** [Layer 1 design](layer-1-design.md) and the [Realm UI
specification](2026-09-16-realm-ui-spec.md) remain authoritative; where this document and one of
them disagree, they win and this document is wrong.

## 1. Purpose and standing

[`docs/phases.md`](docs/phases.md) opens Phase B with one instruction: *"First: write the milestone B
technical spec and plan. They do not exist yet."* This is that specification. The plan — the ordered,
test-first task list milestone A got in
[`2026-09-14-milestone-a-plan.md`](2026-09-14-milestone-a-plan.md) — is a separate document and is
written only after the decisions in §7 are taken.

Milestone B turns the combat laboratory into a persistent playable loop: accounts, an authoritative
server, a town with equipment and potions, a shared bag with a loot filter, offline catch-up under a
shared cap, and an away report. Its exit criterion is fixed by layer-1 §2: *players can complete
repeated hunt → understand → adjust → hunt cycles; recovery and concurrency checks pass.*

Three things this document deliberately is not:

1. **It is not a licence to start building.** Eleven decisions in §7 are the owner's, and four of
   them (retreat and travel costs, bag overflow, prices and starter grants, the first equipment
   reward) are named in layer-1 §15 as blocking milestone B by name.
2. **It is not a re-specification of milestone A.** The simulation contracts A implements stay as
   they are; §4 extends them and says exactly where.
3. **It is not evidence.** Nothing here is measured. Every number it quotes is either a rule from
   layer-1 or a figure measured during milestone A and cited to
   [`artifacts/milestone-a-results.md`](artifacts/milestone-a-results.md).

### Reading order

| Read | For |
|---|---|
| [Layer 1 design](layer-1-design.md) | The accepted gameplay and architecture rules. Beats this document. |
| [Realm UI specification](2026-09-16-realm-ui-spec.md) | Approved screen behaviour and the correction table that overrides the mockups. |
| [Simulation contracts](2026-09-14-simulation-contracts-spec.md) | The contracts `packages/sim` already implements. |
| [Milestone A spec](2026-09-14-milestone-a-spec.md) and [results](artifacts/milestone-a-results.md) | What is built, what was measured, and the three gates still open. |
| [Hunt port](docs/realm-hunt-port.md) and [Strategy port](docs/realm-strategy-port.md) | Rulings R106–R113, which bind every change to `apps/client`. |

### Decision legend

Carried from layer-1 so the two documents read the same way.

| Mark | Meaning |
|---|---|
| ✅ | Settled by an accepted document. Implement as written. |
| 🟡 | Proposed default. Implement, but it is expected to move once measured. |
| ❓ | **Open decision.** Not implementable. Listed in §7 with options and a recommendation. |

## 2. Scope

### 2.1 What milestone B adds

| Area | Deliverable |
|---|---|
| Accounts | Email and password registration, login, sessions, and server-authoritative account state. |
| Server | Fastify and PostgreSQL, running the same `@narok/sim` package the laboratory and the CLI run. No second simulation. |
| Hunt lifecycle | Authoritative start, stop, reconnect, intervention, checkpointing and recovery. |
| Offline | Catch-up under the shared 12-hour cap, settled before presence is refreshed, with an away report. |
| Town | Equipment across eight slots and five rarities, potions, an NPC shop, a shared bag, a basic loot filter. |
| Progression | Levelling, the parent skill-point curve, universal auto-spend, staged manual allocation in town. |
| Client | The two ported screens keep their design and lose their authority over time; Bag, Character and Away are built. |

### 2.2 What milestone B does not add

Excluded by layer-1 §2 and §14, and not to be smuggled in because the engine happens to support it:
the remaining skills and maps, progression past B's level band, premium purchases or entitlements
with any simulation effect, trading or any player-to-player interaction, cards, refine, crafting,
quests, class upgrades, a second battlefield implementation, de-levelling or EXP death penalties, a
"time until death" estimate, and payments.

Two exclusions are worth stating in the negative because a mockup depicts them: the Away report's
**Manage bag** action is in scope, but the bag it manages is B's bag, not a Layer 2 inventory; and
premium's extra preset slots are Phase C, so a fourth preset tab must not appear.

### 2.3 Where B differs from what A built

| A built | B requires |
|---|---|
| The client owns the clock and runs `@narok/sim` in a worker. | The server owns the clock; the client plays back what the server has already released. |
| A setup edit starts a new experiment. | A strategy edit is saved, and applied to the *next encounter* as a queued snapshot (UI spec §5). |
| State lives in memory and exports to a file. | State is a durable checkpoint committed atomically with progression and inventory. |
| One deterministic seed chosen by the operator. | A seed owned by the hunt, never chosen or reset by a player. |
| No accounts, no network requests at all (R51). | Accounts, sessions and a network protocol — R51 is scoped to the laboratory and does not survive into B's client. |

## 3. The specification

The specification proper is four parts. Each is self-contained, keeps its own section numbering, and
ends with the decisions it could not take. They were drafted in parallel and reconciled here; where
two parts touch the same rule, the part named below owns it.

| Part | Owns | Requirement ids | Lines |
|---|---|---|---|
| [Part 1 — Platform, accounts and persistence](docs/milestone-b/01-platform.md) | Processes, authentication and transport, the REST and WebSocket surface, concurrency and ordering, the PostgreSQL schema and transaction boundaries, the migration runbook, administration, the error taxonomy, operational bounds | `P-01`–`P-44` | 245 |
| [Part 2 — Authoritative hunt lifecycle, offline settlement and commands](docs/milestone-b/02-lifecycle.md) | The eight lifecycle steps as a contract, the B checkpoint envelope, reward identity, offline settlement arithmetic under the 12-hour cap, command ordering, the pending-strategy contract, stop and pause and retreat transitions, collection modes | `B-L01`–`B-L20` | 268 |
| [Part 3 — Items, inventory, town and progression](docs/milestone-b/03-town.md) | The item model across eight slots and five rarities, the drop and pity algorithm, the bag and the loot filter, town and the shop, levelling, auto-spend, staged allocation, respec, death, onboarding, economy metrics | prose and tables | 361 |
| [Part 4 — Client contracts, screens and acceptance](docs/milestone-b/04-client.md) | What the client keeps and loses when the server becomes authoritative, the playback contract, the five screens one by one, the correction table as acceptance criteria, accessibility and localisation, and the milestone's gate list | `B-01`–`B-30` | 393 |

Two id sets to keep apart: Part 2's `B-Lnn` are lifecycle *requirements*; Part 4's `B-nn` are the
milestone's *acceptance gates* and cover all four parts. Rulings continue the repository's single
`Rnn` sequence from R114 (§6).

## 4. Open decisions

The four parts raise **51** decisions between them: 16 in Part 1, 10 in Part 2, 14 in Part 3 and 11
in Part 4. Eight are settled and one — prices — is deferred (§4.0), leaving **42**. Each states its options, its tradeoff and a recommendation in its own part. This section
groups them by what they block, because that is what decides the order they are taken in. None of
them is decided here.

### 4.0 Decided by the owner, 2026-09-21

Recorded in layer-1 where they belong (§4.5, §7.4, §7.5, §15) and applied in the parts.

| Decision | What was decided |
|---|---|
| Stop, Resume and the cost of leaving | **Stop returns to town.** There is no resume of an interrupted encounter: the encounter is abandoned, the return consumes a simulated travel segment, and stopping preserves damage, spent resources, PRNG progression and pity. Starting again begins a new encounter. |
| Bag overflow | **The drop is lost**, audited as lost. The hunt continues; a full bag does not send the party to town. |
| First equipment reward | **A fixed Uncommon item on the first won encounter, rolled by nothing and identical for every account.** One fixed item per class, so it is usable by the character that earns it, and the same item for every account of that class. The owner's reason is explicit: an account must not be worth re-creating for a better roll. |
| Prices | **Deferred.** Not now. The NPC shop and potion purchase cannot ship until prices exist, so the plan sequences them last and behind a flag. |
| Milestone A's laboratory | **Kept.** It moves to its own `apps/lab` with its comparison harness and tests, so it survives while `apps/client` becomes engine-free — keeping it inside `apps/client` would ship the simulation to production, which gate B-02 exists to prevent. |
| Bag, Character and Away stylesheets | **Ported verbatim**, like Hunt and Strategy: byte-identical sheets frozen under a new ruling continuing the R1xx sequence, with anything the product needs confined to a labelled additions block. |
| Two-handed weapons | **They lock the off-hand.** A two-handed weapon occupies `weapon` and forces `offhand` empty; equipping one auto-unequips the off-hand in town, and the command fails if the bag cannot hold what comes off. |

### 4.0.1 Decided by the owner, 2026-09-25

| Decision | What was decided |
|---|---|
| Town-return travel | **10 seconds** (`townReturnTravelMs = 10_000`), on the prototype map whose walk interval is 2 s. Long enough that stopping is a real choice, short enough not to punish it; a content value, tunable per content version without code. |
| What a strategy preset holds | **Placement, per-character strategies, the wipe limit and the rest thresholds.** The start command names a preset and carries none of them itself. |

### 4.1 Blocks writing the milestone B plan

These change the shape of the work, so the plan cannot be sequenced around them. The nine rows the
owner settled or deferred on 2026-09-21 have moved to §4.0. The five below are technical and are
being taken against the recommendation in their part unless the owner says otherwise.

| Decision | The owner's question | What the parts recommend | Detail |
|---|---|---|---|
| One-time starter grants (layer-1 §15) | What does a new account begin with? | Idempotent per account and slot: potions on the first slot, and a character-bound, non-sellable starter weapon | Part 3 §8 #10 |
| HP/MP adjustment on maximum change (layer-1 §15) | What happens to current HP and MP when the maximum moves? | Preserve the absolute value and clamp, with the same rule for level-up, equip, respec and migration. Ratio preservation would hand out free healing | Part 1 §9 #16, Part 3 §8 #12 |
| Checkpoint column type and encoding | How is the checkpoint stored? | `bytea` holding canonical JSON. `jsonb` renormalises keys and numbers and would break the byte-equality the determinism tests rest on | Part 1 §9 #6 |
| Where the loot evaluator runs | One evaluator, two runtimes? | A pure `packages/loot` imported by both sides, with one shared test vector so drift becomes a failing test | Part 4 §7 |
| Pending activation boundary | When exactly does a queued strategy become active? | One atomic activation at the next spawn, before the recipe draw, so activation consumes no RNG and cannot reroll an encounter | Part 2 §9 |

### 4.2 Blocks beta invitations

| Decision | What the parts recommend | Detail |
|---|---|---|
| Admin recovery identity check and credential handoff (left open by layer-1 §8.3) | A short-lived one-time password, forced change at first use, sessions revoked on redemption, one audit row per issuance | Part 1 §9 #4 |
| Registration gating | Invite codes as idempotent redemption rows during the closed beta | Part 1 §9 #3 |
| Backup cadence, retention and objectives | WAL archiving off-host plus periodic dumps, with stated recovery point and recovery time objectives and a restore drill executed before invitations | Part 1 §9 #15 |
| Beta equipment and progression persistence and reset policy | Full persistence with migrations through the closed beta, and one announced end-of-beta reset | Part 3 §8 #4 |
| Character name normalisation and uniqueness | Store the name as entered and enforce uniqueness on an NFKC case-folded key. ASCII-only is hostile with PT-BR as a first-class language | Part 1 §9 #5 |
| Session token format, lifetime and concurrent sessions | An opaque token hashed at rest, with absolute and idle lifetimes. A JWT would make revocation eventual, which layer-1 §8.3 forbids | Part 1 §9 #1 |
| Argon2id parameters and password policy | Choose by measuring verification latency on the target VPS under the login rate limit, and store an algorithm tag so rehash-on-login stays possible | Part 1 §9 #2 |

### 4.3 Safe to carry as proposed defaults

The rest are configuration values or thresholds that want a measurement the project does not have
yet, in several cases the same measurement the open VPS gate needs (§5). The parts recommend
implementing them as 🟡 defaults with a refusal test at every bound, and settling the values against
the Phase C VPS exercise: rate limits and resource bounds, retention windows, the conflict retry
bound, the catch-up worker substrate and queue durability, the scheduler's process boundary, sockets
per account and multi-tab behaviour, same-origin hosting, simulation error-code exposure, hunt seed
provenance, the reward identifier namespace, pity state ownership and thresholds, the stop-reason
vocabulary, how reward accrual is carried, in-flight encounters across a version change, maintenance
downtime against the offline cap, bonus identity scope and value tiers, the protected-item sale
confirmation threshold, dead-member EXP eligibility, the useful-upgrade threshold, production
playback speed, the playback starvation threshold, Strategy as a panel or a route, away-report
acknowledgement, content delivery and version pinning, and the event-history bound.

Two of those are flags rather than defaults, because a wrong answer is expensive. **Client-side
prediction** should be refused outright: it re-creates a second authority and needs the seed the
server must never disclose. **Production playback speed** must not be built as a server catch-up
rate, which would pull outcomes forward against layer-1 §4.4.

## 5. Prerequisites carried from milestone A

Milestone A's results report closes with an instruction, not a formality: *"before anything is added:
run the five-tester session ... and have a human perform the R64 visual checks."*
([`artifacts/milestone-a-results.md`](artifacts/milestone-a-results.md) §12.) Three gates are open
and none of them can be closed by an agent.

| # | Gate | Who closes it | What it blocks in B |
|---|---|---|---|
| A-14 | The five-tester placement experiment. At least four of five testers explain a supported effect of their own change, and more than one placement shows an advantage. Protocol: `artifacts/placement-experiment-protocol.md`. | Five human testers | If it fails, layer-1 §13's instruction stands: simplify or revise the placement surface and repeat a focused experiment **before adding maps or content**. B's town and equipment would be built on a grid the owner has decided to change. |
| R64 | Visual composition sign-off at 1440×900 and 1280×800, no clipping at 1100px, in both languages. The automated suite measures horizontal overflow only. | The owner, looking at the pages | B adds three more screens to the same design language. Signing them off one at a time is cheaper than signing off five at once. |
| §6.5 | The single-VPS concurrency target. Never tested; no VPS was available to the evidence run. | Operations, on the real VPS | §3's topology and §4's persistence cadence are sized against a target nobody has measured. A different answer changes both. |

A-14's second finding also lands directly on B: the measured half of the placement gate fails under
the stricter reading of its own sentence and passes under the looser one, and which reading the
project intends is the owner's call. The recommendation in this document assumes the grid survives.
If it does not, §5's equipment stats and §4's encounter loop are unaffected, but the Strategy
screen's formation pane and the placement half of every gate below change shape.

## 6. Document control

- This document is a draft. It becomes implementable when the decisions in §4 are recorded — in
  layer-1 §15 where they belong, not here — and this file is updated to cite them.
- Amendments follow the milestone A pattern: the amended sentence stays, and the amendment is
  written next to it with its date and reason, as
  [`2026-09-14-milestone-a-spec.md`](2026-09-14-milestone-a-spec.md) does for the renderer.
- Rulings live with the code they bind and keep one global sequence. R51–R110 were recorded per
  task under `.superpowers/sdd/2026-09-14-milestone-a-plan/` (`task-N-rulings.md`, `progress.md`);
  R106–R113 are in [`docs/realm-hunt-port.md`](docs/realm-hunt-port.md) and
  [`docs/realm-strategy-port.md`](docs/realm-strategy-port.md). B's rulings continue that numbering
  from R114 and are recorded the same way — next to the thing they constrain, never only in a
  commit message.
- The milestone B **plan** is a separate document, written after §4 is settled, in the shape of
  [`2026-09-14-milestone-a-plan.md`](2026-09-14-milestone-a-plan.md): ordered tasks, each with its
  tests written first, its explicit file paths and its commit message.
