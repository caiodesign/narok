# Realm refined

**Selected main design, 2026-09-16.** These five screens are the owner's primary visual/interaction reference. Developers must also read the [Realm UI specification](../../2026-09-16-realm-ui-spec.md) and [Opus handoff](../../docs/opus-handoff.md): written gameplay rules override obsolete sample premium, death, progression and forecast copy. The gallery is a review launcher, not the game homepage. The demo behavior described below is not a production implementation contract.

Open `index.html` directly in a browser. No build step or server is required. The five screens are linked through the bottom navigation; “Compare original” opens the corresponding untouched Opus mockup.

This is a desktop design prototype, built from the five Realm studies in `../../mockups/`. It preserves their original SVG world, fantasy typography, bronze/iron materials, item colors, and layout language. Shared refinements live in `refined.css` and `refined.js`. Google Fonts is optional; local font fallbacks remain available.

## Design decisions

- Keep the world prominent and the main window frames ornamental. Quiet the nested frames.
- Present skill slots as automatic activity that can be inspected, rather than manual casting shortcuts.
- Separate saving a preset from queuing it for the next encounter.
- Compare equipment using concrete stat tradeoffs and enforce the displayed level requirement.
- Stage attribute and skill spending before committing it.
- Treat offline rewards as already credited. A full bag makes Manage bag the primary return action.
- Keep the away timeline visible at the 1440×900 reference size. Shorter desktops scroll inside panels; navigation and major actions remain available.

## Try the interactions

| Screen | Implemented local interactions |
| --- | --- |
| Hunt | Select a skill to inspect its state; switch Combat/Loot/System tabs; pause/resume the preview; open Strategy or Bag. |
| Strategy | Edit Sigrun’s Sustain thresholds and toggles, restore example defaults, save locally, revert to the last save, or queue the draft. |
| Bag | Inspect the pinned future upgrade; see why equipping is blocked; sell the example group of 12 Common items; confirm the displayed fixed filter draft. |
| Character | Stage an attribute, reset or apply; preview a skill upgrade and learn/cancel. AGI includes an illustrative derived-stat preview. |
| Away report | Open the full-bag scenario, review the filter, or return to Hunt. |

`bag.html?from=away` opens the later full-inventory scenario; the visible item grid is an excerpt. The default Hunt, Strategy, Character and Bag pages depict an earlier snapshot. The away report depicts a later return, with level-ups and a full bag. They are linked design examples, not a synchronized game simulation.

Only Strategy saves its example values in this browser (`realm-refined-sustain` and `realm-refined-queued`). Other local demo actions reset on reload. No account, server, real inventory or game simulation is connected. The queued strategy illustrates application timing; it does not run a new encounter. Forecast values and equipment roll comparisons are illustrative. Formation dragging, additional characters/presets, item selection, search and complete filter editing remain visual studies.

## Verification

Rendered and visually reviewed all five screens at 1440×900 and 1280×800. Checked navigation, horizontal overflow, strategy save/queue, attribute preview/reset/apply, skill upgrades, full-bag routing, bulk-sale capacity updates, blocked under-level equipping, and gallery preview loading in Chromium. Originals and supplied screenshots are unchanged.
