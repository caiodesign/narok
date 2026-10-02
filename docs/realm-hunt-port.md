# Realm Refined — Hunt screen port

**Updated:** 2026-09-21. Supersedes `realm-visual-parity-plan.md`, which planned an incremental
parity pass against the old dashboard. The owner instead directed a wholesale replacement:
*"delete the way the html and css is today and use this hunt.html as base. I want it exactly the
way it is, no modifications on the css."* That plan is obsolete and has been removed.

## What is built

`codex-examples/realm-refined/hunt.html` is ported. Strategy is ported too, as the setup form —
see [its own record](realm-strategy-port.md). Bag, Character and Away remain unbuilt mockups.

- `apps/client/src/styles.css` lines 1–754 are **byte-identical** to `hunt.html:11-764`. This is
  checked, not asserted: `diff <(sed -n '11,764p' codex-examples/realm-refined/hunt.html) <(sed -n '1,754p' apps/client/src/styles.css)`
  must be empty. Everything beyond line 754 is the reference's second `<style>` block, the
  refined.css polish, and a labelled additions block.
- `apps/client/src/hud/` holds one module per region of the reference. `hud/model.ts` is the
  shared view-model adapter and records, panel by panel, which of the reference's readouts are
  bound to a measured figure and which were dropped for want of one.
- `apps/client/src/setup.css` held the laboratory's own form styling, because the mockup is a game
  screen and contains no setup form. Since [the Strategy port](realm-strategy-port.md) that form
  wears `strategy.html`, and this file is down to the few things neither design has a vocabulary
  for.

## Binding rulings (R106–R110)

### R106 — `gridCoordinates` is callable by any board renderer, not by `BattlefieldView` alone
Task 10's brief scoped `gridCoordinates` to "this renderer only", meaning `BattlefieldView.tsx`.
That file is now unreachable from `main.tsx`. The rule's intent — coordinate decoding stays out
of the resolver, the strategy layer and the log — is unchanged and still holds. Its letter is
widened: `hud/Battlefield.tsx` and `hud/Compass.tsx` may both call it, being the two components
that draw a spatial view. Nothing else may, and `PositionId` remains opaque everywhere else.

> **Amended by R163 (milestone B Task 8).** The codec (`gridPosition`, `gridCoordinates`) and the
> two content-derived defaults (`defaultPlacement`, `defaultStrategy`) moved to `@narok/data`
> (`packages/data/src/grid.ts`, `strategy.ts`), being content rather than engine, so the
> engine-free client imports them from there; `@narok/sim` re-exports the same functions. The
> intent above is unchanged; the letter now reads **any component that draws a spatial view** —
> the battlefield adapter, the HUD's `Battlefield` and `Compass`, the setup board and the
> laboratory's `BattlefieldView` (now `apps/lab`). R164: `apps/lab` may import `@narok/client`;
> `apps/client` may never import `apps/lab`; the frozen stylesheets and `apps/client/src/hud/**`
> never move.
>
> **R165 (milestone B Task 8; recorded here by the Task 11 sweep, where it was missing).** Because
> `@narok/data` cannot import `SimError`, `gridCoordinates` throws `PositionError` from
> `@narok/data` on a malformed id — same code (`INVALID_INPUT`), same field (`position`), same
> message. The engine translates it back into exactly the old `SimError` at the two places raw input
> reaches the codec (`createGrid`'s `validatePlacement` and `createSimulation`'s guard), so every
> error the simulation raises is byte-identical; only a direct caller of `gridCoordinates` sees
> `PositionError`, and no caller in the repository depends on the old type
> (`packages/sim/test/position-codec.test.ts`).

### R107 — the ported stylesheet is not editable
No rule inside `styles.css` lines 1–754 may be changed, reordered or deleted. Anything the
product needs beyond the design goes in the labelled additions block at the end of the file, or
in a separately imported sheet. A change that "only" adjusts a value is still a change: the diff
above is the acceptance test.

### R108 — no panel is filled with a placeholder
The reference depicts loot, a wallet, a zone, an XP curve, buffs, a threat table and elite flags.
Milestone A publishes none of them. Each such panel is either bound to a real measured figure of
the same shape (`.loot` → retained comparisons, `.orders` → run controls, compass `.zone` →
recipe and grid dimensions, compass death pips → wipes against the wipe limit) or left out.
*(Since the owner decision of 2026-09-30, R154: no wipe limit exists; the compass shows the wipe
count alone — Task 11 sweep.)*
Inventing a number to fill a frame is forbidden, including "for now".

### R109 — a published frame that carries no events must not change the events array's identity
`useExperiment` publishes up to sixty frames a second, and 74% of them at speed 16 carry no
domain event at all. Returning a freshly concatenated array for an empty batch changes
`events` identity on every frame and silently defeats every memo downstream of it. Measured: the
HUD cost 44.4 ms per frame before this rule and 3.85 ms after, against a 16.7 ms budget. Any
future publisher of a per-frame collection is bound by the same rule.

### R110 — `body[data-paused]` tracks the run
The approved stylesheet ships `body[data-paused="true"] .realm * { animation-play-state: paused }`.
The attribute is written from the experiment's status, so the world's fog, embers, sparks, target
rings and cast bars run exactly while a hunt runs. A HUD sitting idle must not animate.

## Known debt

`apps/client/src/BattlefieldView.tsx` (PixiJS), `Comparison.tsx`, `art-manifest.ts` and the
`pixi.js` dependency are unreachable from `main.tsx` but still covered by `battlefield.test.tsx`
and `comparison.test.tsx`, and `hud/Battlefield.tsx` copied the projection helpers rather than
importing them. Retiring them means moving those tests onto the new component first. Left for a
deliberate decision, not a drive-by deletion.
