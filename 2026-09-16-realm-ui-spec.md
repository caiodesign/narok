# Realm — Primary UI and Interaction Specification

**Date:** 2026-09-16\
**Status:** Owner-selected design direction and accepted review refinements. Implementation contract for presentation; not a new combat/economy specification.\
**Parent:** [Layer 1 product design](layer-1-design.md)\
**Developer entry point:** [Opus handoff](docs/opus-handoff.md)

## 1. Authority and scope

Use `codex-examples/realm-refined/` as the main design reference. Preserve its Realm fantasy identity and improve fidelity through real components and authoritative data. Do not restart visual exploration or substitute the earlier light Codex studies, tactical console, or generic dashboard styling.

Precedence is domain-specific:

1. Product rules and delivery boundaries: `layer-1-design.md`.
2. Milestone A mechanics and technical interfaces: its scope spec and simulation contracts.
3. Screen behavior and mandatory corrections to mockups: this document.
4. Layout, art direction and visual composition: the five refined HTML screens and their `previews/` images.
5. Older `mockups/`, supplied screenshots, earlier Codex examples and archived prompts: history only.

This UI approval does not authorize implementing milestones B/C ahead of the combat experiment. Demo JavaScript is not production architecture. The review gallery and “Compare original” navigation do not belong in the game.

## 2. Reference and milestone map

| Screen | Main reference | A: combat laboratory | B/C: persistent game |
| --- | --- | --- | --- |
| Hunt | [hunt.html](codex-examples/realm-refined/hunt.html) | Realm shell, board, party resources, automatic skill activity, factual log and measured session metrics | Authoritative hunt controls, loot, inventory, persistent presets |
| Strategy | [strategy.html](codex-examples/realm-refined/strategy.html) | Placement and supported skill rules during setup; edits start a new experiment | Saved drafts and explicit next-encounter application |
| Bag / loot filter | [bag.html](codex-examples/realm-refined/bag.html) | Excluded | Equipment inspection, comparison, protection, filter evaluation, sale |
| Character | [character.html](codex-examples/realm-refined/character.html) | Fixed-build selection only; no allocation/equipment screens | Town equipment and manual allocation; full skills as content is introduced |
| Away report | [away.html](codex-examples/realm-refined/away.html) | Excluded; laboratory comparison remains separate | Settled offline report, current hunt state, actionable inventory recovery |

In A, omit unsupported economy/premium/loot controls. Do not leave fake balances, disabled production menus, or pretend away simulation around the combat laboratory. Use the approved appearance with the actual A requirements: four classes, level-10 presets, eight active skills, Meadow Outskirts, and its encounter recipes. Quarry art/layout is a style reference, not a replacement content table.

## 3. Visual system

- World-first composition: a full isometric scene, framed party/target information, compact session readout, recent loot, and automatic skill activity. Preserve the sense of inhabiting a place.
- Iron surfaces, warm bronze rules and corners, restrained ember effects. Keep full ornament on major windows; internal groups use quieter dividers and surfaces.
- Keep the supplied original SVG/geometric identity until production assets exist. All assets remain replaceable through the art manifest and subject to the parent provenance/IP rules.
- Use Alegreya SC for headings and Alegreya Sans or a legible local fallback for body copy. Dense figures use tabular numerals. Decorative typography is not required for every number or helper label.
- Target at least 14px body copy and 12px secondary text at normal desktop scale; increase spacing or allow scrolling before shrinking critical information. Text contrast at least 4.5:1, with readable disabled-state explanations.
- Preserve resource colors (HP green, MP blue, EXP gold) and Common/Uncommon/Rare/Epic/Legendary accents. Rarity also appears in text. Casting, damage, and selection must have text/shape cues rather than relying on hue alone.
- Primary desktop reference: 1440×900; validate 1280×800 and 1100px width. Internal scrolling is acceptable at shorter heights; it must be visible/discoverable and keyboard-accessible. No hidden actions, intersecting panels, or horizontal clipping. Mobile redesign is not part of this specification.
- Respect reduced motion; information must remain complete with animation disabled. Keyboard focus and selection are visible. Formation supports keyboard placement as well as pointer interaction.

## 4. Hunt

The party resources, current encounter, target, and skill activity must be readable together. Keep the legendary/recent loot rows clear of the action panel. Session figures are secondary to the world and immediate resource problems.

Skills are automatically selected by strategy. Clicking a skill inspects it; it does not cast it. Do not show number-key casting hints. Distinguish ready, active, cooldown, casting, unavailable, and passive. A passive is never presented as a cast button.

Inspection shows the factual reason a skill is waiting: cooldown remaining, insufficient MP, condition not met, invalid/out-of-range target, or other supported scheduler reason. Use actual public state; do not infer a guaranteed future cast. Show MP cost alongside the shortage and link to editing the relevant rule.

Combat, Loot, and System log tabs filter the same bounded event history. Preserve user scroll position when inspecting history; offer return-to-latest. Reduced motion must not suppress newly received events.

Production Stop/Resume reflects acknowledged authoritative state and preserves HP/MP, cooldowns, RNG and encounter progress. Pending/error states are explicit. A laboratory playback pause is labeled as such and remains governed by milestone A, not the mockup’s production wording.

Observed rates include their measurement window and handle zero duration. Replace mockup “time until death” with a supported observed metric such as hunt duration or potion usage. No survival forecast in Layer 1.

## 5. Strategy

Keep formation, per-character priority rules and party rules in the same editor. All supported roster members and saved presets work in the implemented milestone; the demo’s disabled tabs are not the intended product behavior.

Rule order is explicit: the first enabled, eligible, ready and affordable skill wins. Basic attack is the fallback, outside the reorderable active-skill list. Passive skills do not enter the list. Use only target modes/conditions supported by the gameplay contract, at the proper per-character or per-party scope.

Production draft lifecycle:

| Action | Result |
| --- | --- |
| Edit | Changes a draft; current hunt remains unchanged. |
| Save preset | Saves a versioned preset; does not change a running hunt. |
| Apply next encounter | Saves and queues that exact validated version; current fight keeps its active rules. |
| Revert | Restores the last saved preset, including toggles, thresholds and placement. |
| Close with unsaved changes | Offer Keep editing / Discard / Save; never silently lose the draft. |

Before accepting a production apply command, settle elapsed progress to its server cutoff. Activate the pending snapshot before spawning the next encounter, including after walking/resting. If currently fighting, wait until that fight ends. Show active and pending versions separately. Later edits to the saved preset must not mutate the queued snapshot. A newer acknowledged apply replaces the pending version. Persist pending state across reconnect/recovery; reject stale writes with a recoverable conflict message. Stopping must not secretly activate it or reset encounter state. Exact production payload/schema and same-timestamp ordering belong in milestone B’s technical contract before implementation.

For milestone A, all setup edits require a new experiment; never import the production queue lifecycle into A.

Replace static “projected effect” numbers with the existing measured paired-run comparison in A. In the persistent game, omit projections until an independently specified preview system exists. Do not ship illustrative values, a survival estimate, or a decorative slider that implies a working predictor.

## 6. Bag and loot filter

Inventory grid, pinned details and rule preview remain distinct regions. A pinned item panel must not hide its equip requirements or actions. Search, category filters, item selection, pin/unpin and sorting must work when this screen ships.

Comparison identifies a real eligible character and equipped slot/item. Show actual before/after stats, signed deltas, and tradeoffs; bonus count alone is not an upgrade recommendation. Label percentage-point differences accurately. Include level/class/slot restrictions. If nothing is equipped, compare against an empty slot. Derived-stat previews must use the shared rules, not copied mockup arithmetic.

Manual equipment changes remain town-only. While hunting, allow inspection but explain “Return to town to equip.” An under-level character cannot equip; state the required and current levels. Do not create equipment exceptions merely because the mockup draws an enabled action.

Protection and filter precedence:

1. Existing locked items are excluded from bulk sale. Legendary drops are protected from automatic sale/ignore and receive Keep disposition.
2. For other drops, evaluate ordered exceptions top-to-bottom; first match wins.
3. Then evaluate the rarity/default rule, with a mandatory fallback for supported categories.

“Always kept” means protected disposition, not unlimited capacity: if Keep cannot fit, use the configured bag-full policy. Explicit individual sale of protected valuable items requires a deliberate confirmation; locked items must first be unlocked. Do not silently add lost items to the bag.

The preview runs the actual evaluator against recent drop records without altering them. Show proposed disposition, matching rule and the difference from the currently active filter. Apply affects future drops after the acknowledged server cutoff, never retroactively sells existing inventory. Validate and version this command with the hunt state in milestone B. Label unsaved edits and preserve them on recoverable failures.

Bulk sale previews exact unlocked item count and gold, then reconciles with the server response. Prevent duplicate submission. All slot/category/wallet counters derive from one returned state. Auto-sell consumes no bag slot and continues when the bag is full if the chosen policy keeps hunting. Materials tabs/rules remain hidden until materials exist.

## 7. Character and progression

Preserve equipment around the character silhouette, attributes in the middle, and skills on the right. Selecting a character updates all three consistently. Manual changes are town-only.

Each attribute + control shows its cost and previews before/after values. Stage changes; Apply validates and commits atomically, Reset restores the starting values. Show unspent versus pending cost clearly. Recompute affected combat stats using game formulas. If account state changes before submission, refresh/revalidate rather than overspending or discarding a draft without explanation.

Skill upgrades show current rank, next-rank effect, cost and prerequisites before confirmation. After commitment update rank, point balance, derived effects and dependent unlocks together. Locked skills state the missing prerequisites. Use the product skill-point curve, not the “every 2 levels” mockup copy.

Auto-spend is available to everyone in beta. Remove its premium badge and disable no allocation feature on entitlement grounds. Insufficient points carry forward according to the product’s ordered-target policy. Equipment comparison and skill values are data-driven; do not turn example rolls or suggested AGI deltas into balance rules.

## 8. Away report

Reports describe settled, already credited progress. Reading or reopening a report must not grant rewards again. Show time away and actual simulated duration separately, including cap/stoppage reasons where they differ.

Keep the party outcomes, earned totals, notable loot and chronological timeline. Separate party wipes used this hunt, wipes during this absence, and individual member deaths. No EXP-loss language during beta.

Lead with an actionable exceptional state. For a full bag while hunting, show lost Keep drops, ongoing auto-sales/EXP/gold, and primary **Manage bag**. Secondary **Return to hunt** views the still-running hunt. Do not say Collect, Resume or Start when no such operation is needed. The management route must open the actual same account/hunt inventory, not the demo’s separate snapshot.

If the hunt stopped, show its actual reason and the correct available restart action. If a cap was reached, distinguish stopped accrual from a combat failure. After managing the bag, refresh the report action state from current inventory; do not keep warning that the bag is full after space is freed. Missed drops remain lost; reopening the report cannot reclaim them.

Keep the timeline visible at 1440×900; allow obvious internal scroll at shorter heights while retaining the primary action. Highlight valuable finds without obscuring the recovery action. No premium comparisons interrupt the report.

## 9. Required corrections to illustrative HTML

| Mockup content | Implementation requirement |
| --- | --- |
| Premium 17h42m offline cap | Shared beta cap; 12h is the current proposed product default. Remaining time is derived, never copied. |
| Premium-only stat auto-spend | Available to everyone. |
| Wipe caused 10% level loss | No beta EXP loss or de-leveling. |
| One skill point every 2 levels | Parent curve: one at creation and one every four levels. |
| Time until death / +45m forecast | Excluded from Layer 1; observed metrics or measured A/B experiment results only. |
| Five wipes selected | Valid example only; default one, configurable 1–5. |
| Party focus Highest threat / Element-weak | Not the supported player priority list; use parent modes per character. Monster threat remains a separate system. |
| Additional mana-reserve/buff-refresh controls | Show only after the dependent rules are specified; not part of A’s supported conditions. |
| Group Heal, Shield Wall, buffs, passive ranks | Later content; A retains its eight specified skills and no generic buffs/blocks. |
| Equipment rows, prices, stats, example upgrade deltas | Fixtures, not approved balance data. |
| Materials / paid bag expansion / fixed fourth preset slot | Not authorization to add materials, payments or a fixed entitlement policy to beta. |
| Mock Hunt, Character and later Away snapshots differ | Live implementation uses one coherent authoritative account state. |
| LocalStorage and DOM-only mutations | Prototype affordances, not authoritative persistence. |
| Gallery, Compare original, fixed-draft/illustrative labels | Review tooling, not production navigation or filler UI. |

## 10. Implementation and acceptance

Implement reusable window frames, unit frames, resource bars, skill state displays, inventory tiles, item comparisons and draft controls using the existing React/PixiJS architecture. Share tokens rather than copying five inline stylesheets. Preserve visual identity while keeping simulation/state transitions outside rendering.

Required checks at the milestone where the behavior ships:

- Visual checks at 1440×900 and 1280×800, plus no horizontal clipping at 1100px; long localized names and PT-BR do not hide controls.
- Hunt skill states remain distinguishable with animation disabled; inspection never casts a skill; log history and keyboard controls work.
- Draft/save/apply and active/pending strategy states are distinct; failures and reconnect do not silently change rules. A edits still create a new experiment.
- Loot preview matches the real evaluator; protected items and full-bag disposition interact as specified; filter changes do not touch existing items.
- Equipment eligibility and town restrictions are enforced on both client and server; comparisons use actual selected gear.
- Attribute/skill preview, reset, commit, insufficient points, stale state and repeated submission are tested.
- Away report reopening never double-credits; full bag, running, stopped and capped states have correct copy/actions; counts reconcile with inventory.
- No obsolete premium benefits, EXP penalties, fake forecasts or mock balance values leak into the product.

The current HTML was rendered at 1440×900/1280×800 and selected demo interactions were checked. That evidence validates the design prototype only, not these production requirements or the simulator.
