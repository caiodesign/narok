# narok — specification index

These documents live together at the project root. They describe the work; the game is not implemented. The owner selected **Realm Refined as the primary visual and interaction design on 2026-09-16**.

**For Opus:** start with [Development handoff](docs/opus-handoff.md), then read the specifications below. Inspect the actual [Hunt](codex-examples/realm-refined/hunt.html), [Strategy](codex-examples/realm-refined/strategy.html), [Bag](codex-examples/realm-refined/bag.html), [Character](codex-examples/realm-refined/character.html), and [Away report](codex-examples/realm-refined/away.html). The [gallery](codex-examples/realm-refined/index.html) is a review launcher, not a game homepage.

| Read order | Document | Purpose |
|---|---|---|
| 1 | [Layer 1 design](layer-1-design.md) | Accepted product direction, milestones A/B/C, future boundaries, and unchanged legal/IP constraints |
| 2 | [Realm UI specification](2026-09-16-realm-ui-spec.md) | Primary design, screen behavior, mockup corrections, milestone mapping, and UI acceptance |
| 3 | [Milestone A specification](2026-09-14-milestone-a-spec.md) | Complete scope and prototype rules for the combat experiment |
| 4 | [Simulation contracts](2026-09-14-simulation-contracts-spec.md) | Types, module boundaries, deterministic scheduling, checkpoint and renderer contracts |
| 5 | [Milestone A implementation plan](2026-09-14-milestone-a-plan.md) | Ordered tasks, file paths, executable acceptance examples, commands, and coverage map |

## Status and precedence

The owner approved the review recommendations and requested these specification/plan files. The product direction is inherited from `layer-1-design.md`. New numerical values and detailed mechanics are **selected prototype defaults**, not claims of final balance or separate owner approval. Their purpose is to make milestone A implementable and measurable.

For milestone A, the two specifications resolve the earlier document's open combat questions. If a selected default conflicts with an accepted product constraint, the product constraint wins and the specification must be corrected. Implementers read both specifications, not the plan alone.

The Superpowers architectural workflow informed decomposition and review; its writing-plans workflow informed task contracts, test-first steps, and verification. Existing approval and the explicit request for both specs and plans cover creating this packet. Actual implementation is a subsequent task.

## Execution boundary

For presentation, the Realm UI spec and its five refined screens supersede the older visual studies. Written gameplay specifications override illustrative numbers and obsolete rules still drawn in HTML. `docs/design-recap.md` and `docs/prompts/hunt-screen-mockup.md` are historical; do not use them to restore superseded product decisions. Earlier mockups remain preserved for comparison.

Implement milestone A only. It is a local combat laboratory using disposable experiment state, fixed progression, eight active skills, one map, and three encounter recipes. Its reset/replay controls are experimental controls, not proposed production hunt APIs.

Milestone B introduces authoritative accounts, the persistent hunt lifecycle, actual progression, equipment, potions, shops, and away reports. Milestone C expands content and enables the completed pity/premium experiments. Their remaining decisions are already listed in §15 of the Layer 1 design; do not make speculative implementation plans for them before the combat evidence exists.

After milestone A, record measured results against its acceptance criteria and decide whether to retain the grid. Then create the milestone B spec/plan in this folder.
