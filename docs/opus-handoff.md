# Development handoff for Opus

**Updated:** 2026-09-16. The owner approved Realm Refined as the main screen design. This repository contains specifications and design prototypes, not an implemented game.

## Read before coding

1. [Layer 1 product design](../layer-1-design.md): accepted gameplay rules and milestone boundaries.
2. [Realm UI specification](../2026-09-16-realm-ui-spec.md): approved screen behavior and corrections to sample HTML.
3. [Milestone A scope](../2026-09-14-milestone-a-spec.md) and [simulation contracts](../2026-09-14-simulation-contracts-spec.md): read both completely.
4. [Milestone A plan](../2026-09-14-milestone-a-plan.md): execute against those contracts, preserving newer files.

## Main design

Open these pages in a browser and inspect their composition, not just their source:

- [Hunt](../codex-examples/realm-refined/hunt.html)
- [Strategy](../codex-examples/realm-refined/strategy.html)
- [Bag and loot filter](../codex-examples/realm-refined/bag.html)
- [Character](../codex-examples/realm-refined/character.html)
- [Away report](../codex-examples/realm-refined/away.html)

Their [preview images](../codex-examples/realm-refined/previews/) document the 1440×900 appearance. `index.html` is only a review gallery. Do not implement it as the game’s homepage or reproduce the Compare original footer.

Keep the Realm world, iron/bronze framing, fantasy headings and rarity palette. Preserve the refined interactions: automatic skill inspection; explicit save versus next-encounter apply; real equipment tradeoffs and eligibility; preview-before-spending; Manage bag as the primary full-bag return action. Build reusable components and authoritative state flows, not a production dependency on the demo scripts.

The original `mockups/` and supplied screenshots are historical references and must remain preserved. The earlier `codex-examples/core-hunt-*.html` studies are also historical. Do not revert the main design to them.

## Scope and contradictions

Start with milestone A unless the owner separately changes scope. Adapt Realm’s appearance to the combat laboratory’s fixed builds, eight skills and measured comparisons. Do not implement inventory, progression, premium, away reports or production server lifecycle in A simply because the complete design depicts them.

Written gameplay rules override sample copy/numbers. In particular: no beta EXP loss, universal auto-spend, shared offline cap, no survival forecast, one default wipe, and the parent skill-point curve. See the complete correction table in the Realm UI spec. Do not copy unsupported focus modes, mana rules, premium claims, material slots or demo skill costs into the simulator.

After A, present its real test/benchmark/human-placement evidence and the retain/simplify recommendation. Draft the milestone B technical specification before implementing pending strategy versions, persistent inventory and offline state. This handoff specifies their intended UI semantics but does not claim the full B backend design exists.

## Suggested kickoff instruction

> Read README.md and docs/opus-handoff.md, then the linked product, UI, milestone A and simulation specifications. Implement milestone A following its plan. Realm Refined is the primary visual direction; adapt only the screens/features in A’s scope, with the corrections in the UI spec. Preserve all mockups and historical designs. Do not substitute mockup values for the simulation contracts. Report actual verification evidence and any unresolved gate.
