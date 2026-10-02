# Realm Refined — Strategy screen port

**Updated:** 2026-09-21. Companion to [the Hunt port record](realm-hunt-port.md), which still governs
`styles.css`. This one governs `strategy.css` and the setup form.

Milestone A's UI scope is "Hunt and Strategy appearance only" ([phases](phases.md)). Hunt shipped
first; the setup form it opened was the laboratory's own plain styling, because `hunt.html` is a
game screen and contains no form. `strategy.html` *is* that form — a formation board, a per-character
rule editor and party rules — so the setup now wears it.

## What is built

- `apps/client/src/strategy.css` lines 1–653 are **byte-identical** to `strategy.html:98-750`:
  `diff <(sed -n '98,750p' codex-examples/realm-refined/strategy.html) <(sed -n '1,653p' apps/client/src/strategy.css)`
  must be empty. Lines 11–97 of that `<style>` are the shared base already in `styles.css:1-87`, so
  they are not carried twice. Everything after line 653 is the reference's second `<style>` block and
  a labelled additions note.
- The two sheets overlap on 59 selectors and **58 of them are byte-identical**; the only difference
  is `@media (prefers-reduced-motion: reduce)`, where the Hunt sheet adds a cast-bar rule the
  Strategy screen has no cast bar for. Neither sheet overrides the other in any way that changes the
  other screen. This was measured, not assumed.
- `apps/client/src/hud/strategy/` holds the three panes — `FormationPane`, `CharacterPane`,
  `PartyRulesPane` — and `board.ts`, the projection they draw on. `ExperimentControls` still owns the
  draft, the seating, the keyboard model and the validation; only its markup moved.
- `apps/client/src/setup.css` shrank from a whole form to the four things the design has no
  vocabulary for: the accessible cell layer, the move buttons, validation alerts and the empty-state
  copy.

## Binding rulings (R111–R113)

### R111 — the board is computed from the grid, never transcribed from the mockup
`strategy.html` places its cells at literal translates. Those numbers are a 5×5 grid with party rows
3 and 4, which is exactly what `content.grid` publishes, so `board.ts` derives them:
`x = 380 + 62(column − row)`, `y = 126 + 31(column + row)`. `apps/client/test/formation-board.test.ts`
pins every formula to the mockup's own figures — the cell at `translate(380 250)`, the tile quad
`M380 95 690 250 380 405 70 250Z`, the ally half, the hatched neutral lane. A grid of another shape
then draws a correct board instead of a mislabelled copy of this one. Copying a coordinate out of the
mockup into a component is forbidden; add a formula and a test instead.

### R112 — the picture and the controls are separate layers
The reference's board is an `role="img"` SVG with a drag-and-drop demo over it. A drag cannot be
operated from a keyboard and cannot explain why a cell refuses a character, and both are milestone A
requirements (R77, R79, and the UI spec's rule that colour is never the only signal). So the SVG is
scenery — `aria-hidden`, no hit target — and the controls are the same `role="grid"` of buttons the
laboratory always had, positioned and clipped to the diamonds the SVG draws. The cell states use the
colours of the design's own legend (`strategy.css:373-376`), so the key and the board agree. Any
future board renderer keeps this split.

### R113 — the editor's position may be restated; nothing inside it may be
On its own screen the editor *is* the screen: `.editor` centres itself at `min(1320px, 100vw − 56px)`
and its scrim covers everything. Here it is a panel over a running hunt whose transport — Start,
Pause, Stop — lives in the rail, and a full-width editor puts the only run controls on the page out
of reach. `setup.css` therefore restates the band (left gutter to the rail) and, under 1320px, lets
the three columns become two with the third wrapping under them, because the design's fixed outer
columns otherwise squeeze the middle one to nothing and the character rules disappear. That is the
whole of the deviation: position and wrapping. No rule inside `strategy.css` is edited (R107 applies
to it identically).

## What was dropped, and why

Nothing on this screen was filled with a placeholder (R108). Dropped whole:

| Reference region | Why it is not here |
|---|---|
| Preset tabs, the premium fourth slot, Revert, Save preset, Apply next encounter | Milestone A has no saved presets and no running encounter to queue a change for: an edit starts a *new experiment*. Save-versus-apply is milestone B (UI spec §5). |
| Unsaved-draft markers (`.unsaved`, "Unsaved draft") | Same reason — there is no saved preset to be dirty against. |
| "Example tradeoff" projection pane | The reference labels it *illustrative* and its rows are a survival forecast, which the handoff forbids. The laboratory's real before/after lives in the Hunt screen's retained comparisons, measured. |
| Mana reserve rule | No MP reserve exists in the simulation. |
| Potions, bag-full policy, "Return to town" | No items, no town. Travel costs are an open milestone B decision. |
| Drag grips | Replaced by the labelled move buttons R79 requires. The grip column and its width are kept. |

Repurposed rather than dropped: the retreat section's **death pips** became the wipe limit — a real
count against a real configured bound *(superseded: the owner decision of 2026-09-30, R154, removed
the wipe limit; a full wipe ends the hunt, so there is no bound to show — Task 11 sweep)* — and the reference's party-wide **Focus target** chips became
a per-character select, because the simulation's target mode is per strategy and one of its modes
takes an ally as an argument, which a chip cannot carry.

## Known debt

The character tabs ellipsize their class name in the narrower middle column (`.char-tab-class` does
this by design). The class is also on the select directly below, so nothing is lost, and the ported
rule is not editable — noted rather than worked around.
