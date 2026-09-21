# narok — Delivery phases

**Date:** 2026-09-17\
**Sources:** [Opus handoff](opus-handoff.md), [Layer 1 design](../layer-1-design.md), [Realm UI spec](../2026-09-16-realm-ui-spec.md), [Milestone A spec](../2026-09-14-milestone-a-spec.md), [Simulation contracts](../2026-09-14-simulation-contracts-spec.md), [Milestone A plan](../2026-09-14-milestone-a-plan.md), [Realm Refined](../codex-examples/realm-refined/README.md).

This is a phase index, not a new specification. The linked documents are authoritative. [`design-recap.md`](design-recap.md) is historical and superseded: its EXP death penalty, premium perks, survival forecast and "skill point every 2 levels" rule were replaced by `layer-1-design.md` and the UI spec. It is used here only to describe the content of later phases.

## Phase 0 — Repository preparation

- Work on a branch, not `main`.
- Preserve every spec, `mockups/`, `codex-examples/core-hunt-*` and the supplied screenshots.
- Install pnpm and record exact runtime/package versions.

## Phase A — Combat laboratory (next)

**Goal:** a disposable local laboratory proving whether 5×5 placement and strategy create understandable decisions. No accounts, server, inventory, progression, premium or away reports.

| Step | Deliverable | Plan tasks |
|---|---|---|
| **A1. Foundations** | pnpm monorepo; typed content (4 level-10 classes, 8 skills, 3 monsters, 3 recipes, element chart); deterministic xorshift32 RNG | 1 |
| **A2. Simulation core** | Grid geometry and pathfinding, area shapes, stat and damage formulas, snapshots, stable event queue | 2–4 |
| **A3. Combat** | Rule priority, targeting, casts, threat, Taunt, slow/stun; walk → fight → rest → respawn loop with wipe limit and stalemate | 5–6 |
| **A4. Simulation API** | Chunked `advance` with split invariance, summary mode, public projection | 7 |
| **A5. Balance CLI** | `run`, `matrix` (34 compositions × 3 recipes × 3 placements), `benchmark` (12h/24h) | 8 |
| **A6. Browser laboratory** | Worker, playback clock (pause, 1×/4×/16×), setup controls, isometric PixiJS board, event log, two-run comparison, EN/PT-BR | 9–10 |
| **A7. Evidence** | Playwright e2e, CI, real benchmarks, **five-tester placement experiment**, `artifacts/milestone-a-results.md` with retain/simplify recommendation | 11 |

**Realm Refined in A:** Hunt and Strategy appearance only.

- Hunt: world view, party frames, inspectable skill states (inspection never casts), tabbed event log, measured session metrics.
- Strategy: formation and rule editor; every change starts a new experiment.
- Excluded: Bag, Character, Away report, loot, wallets, premium and forecasts.

**Gate:** at least four of five testers explain the effect of their own change, and measurements show more than one placement has an advantage. Otherwise simplify/revise the grid before expanding.

## Phase B — Persistent playable loop

**First:** write the milestone B technical spec and plan. They do not exist yet.

- **Backend:** accounts (email + password), Fastify + PostgreSQL, authoritative hunt lifecycle, offline catch-up with the shared 12h cap, checkpoint recovery.
- **Town:** equipment (8 slots, 5 rarities), potions, NPC shop, shared bag, basic loot filter.
- **Realm screens:**
  - Hunt: authoritative Stop/Resume, loot, persistent presets.
  - Strategy: save versus apply-next-encounter, active and pending versions shown separately.
  - Bag and loot filter: real comparisons, level and town-only equip rules, protected items, filter preview, bulk sale.
  - Character: staged attributes with apply/reset, skill upgrades on the parent curve (one at creation, one every four levels), auto-spend for everyone.
  - Away report: settled progress, **Manage bag** as the primary action when the bag is full.
- **Open decisions:** retreat/town costs, bag overflow, prices, starter grants, first equipment reward.
- **Gate:** repeated hunt → understand → adjust cycles; recovery and concurrency checks pass.

## Phase C — Closed-beta expansion

- Remaining skills (Shield Wall, Group Heal, Blessing, passives, …).
- Remaining maps (Whispering Woods → Hollow Citadel), more equipment, progression to level 50.
- Onboarding, drop pity, premium cosmetic/preset experiments.
- Operations: backups, resource limits, VPS load test (~100 concurrent players).
- **Gate:** balance, ownership, resource-limit, backup-restore and end-to-end checks pass.

## Later layers (not planned)

| Layer | Content |
|---|---|
| 2 | Cards, refine, crafting, quests, class upgrade |
| 3 | MVPs, instances, pets |
| 4 | Market, player parties, guilds, PvP |
| 5 | Rebirth, mounts, seasons |
