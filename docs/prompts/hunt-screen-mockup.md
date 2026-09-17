# Prompt: narok-idle — Hunt screen, static style study

> **Archived exploration prompt.** The owner selected Realm Refined on 2026-09-16. Use [Realm UI specification](../../2026-09-16-realm-ui-spec.md) and [developer handoff](../opus-handoff.md); do not execute this old three-direction brief as the current design task.

> Paste everything below the line into the building agent. It is self-contained; the agent
> does not need the rest of this repo.

---

## Task

Build a **static visual mockup of the Hunt screen** for `narok-idle`, a browser idle MMORPG.
This is a **style study**, not an implementation. I am choosing a visual direction, so you will
produce the **same screen three times in three different aesthetics**.

Nothing is interactive. No JavaScript. Every state that would normally be produced by code is
**drawn statically** — a cooldown is painted as a cooldown, a bar is painted at 62%, a casting
skill is painted mid-cast.

## Deliverables

Three files, in `mockups/`:

| File | Direction |
|---|---|
| `hunt-a-basalt.html` | A — Carved basalt (dark Norse) |
| `hunt-b-phosphor.html` | B — Amber phosphor (retro CRT) |
| `hunt-c-console.html` | C — Tactical console (dense HUD) |

Each file is **fully self-contained**: one `<style>` block in the head, markup in the body.
No shared stylesheet, no build step, no bundler. I open the file in a browser and it works.

**All three files use the identical layout, identical DOM structure, and identical copy and
numbers.** Only the styling differs. I want to compare skins, not layouts. Write the markup
once and reskin it.

## Hard constraints

- **No JavaScript.** Not a single `<script>` tag. No `:target` or checkbox hacks either — there
  is nothing to toggle.
- **No images, no icon fonts, no placeholder-image services, no SVG files on disk.** Every visual
  element is CSS or inline `<svg>` written by you.
- **The one permitted external request is Google Fonts** via `<link>`, for the families named in
  each direction below. Give every `font-family` a real local fallback stack so the page is still
  correct offline.
- **No character art.** Party members and monsters are abstract tokens — a shape plus a letter or
  a simple inline-SVG glyph. Do not attempt sprites or figures.
- **Intellectual property:** this game must not derive from Ragnarok Online or Pokémon in any way.
  Do not use their names, place names, monster names, colour schemes, or UI arrangements. Every
  name below is original; use them exactly as written.
- **Target viewport 1440×900.** It must not break or scroll horizontally down to 1100px wide.
  Below that, graceful degradation is enough — I will not evaluate phone width.
- **English copy.** Sentence case. No i18n attributes.

## The screen

A single full-viewport screen, no page scroll. Four regions:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ TOP BAR   map · state · attempts          gold · bag · premium · [Stop]  │
├─────────────────────────────────────────────────────┬────────────────────┤
│                                                     │  PARTY             │
│                                                     │  ┌──────────────┐  │
│                 STAGE                               │  │ Bjorn  Grd 24│  │
│      isometric ground + 5×5 board overlay           │  │ hp/mp/exp    │  │
│                                                     │  │ 4 skills     │  │
│                                                     │  └──────────────┘  │
│                                                     │  ┌──────────────┐  │
│                                                     │  │ Sigrun Clr 23│  │
│                                                     │  └──────────────┘  │
│                                                     │  ┌──────────────┐  │
│                                                     │  │ Kaio   Rng 25│  │
│                                                     │  └──────────────┘  │
├────────────────────────────┬────────────────────────┤                    │
│ METRICS                    │ LOOT                   │  PRESETS           │
├────────────────────────────┴────────────────────────┤  strategy / loot   │
│ EVENT LOG (10 lines, newest at the bottom)          │                    │
└─────────────────────────────────────────────────────┴────────────────────┘
```

The right rail is a fixed ~340px column. The left column flexes. The stage takes the majority of
the vertical space; metrics, loot and log share the bottom band.

### 1. Top bar

- Map: **Ember Quarry**, level range **24–34**
- Hunt state: **Fighting** — show this as a live, active state. The other two states are Walking
  and Resting; they do not need to appear.
- Death attempts: **2 of 5 used** — five pips, two spent
- Gold: **184,220**
- Bag: **47 / 100**
- Premium: active, **17h 42m** of offline cap remaining
- A **Stop hunt** button. Destructive-adjacent: make it deliberate, not loud.

### 2. Stage — isometric ground and battlefield

The real game renders an isometric map here in PixiJS. Draw a **static placeholder** that reads as
isometric ground: a diamond tile grid, receding, suggesting a quarry floor. CSS transforms
(`rotateX` plus `rotateZ` on a grid) or a repeating diamond gradient both work. Keep it quiet — it
is a backdrop, not the subject.

Overlaid on that ground, an encounter is in progress on the **5×5 battlefield**:

```
 row 1   .   Quarry Revenant   .   .   .          enemy back
 row 2   Cinder Grub  .  Slagjaw  Cinder Grub  .  enemy front
 row 3   .   .   .   .   .                        neutral, never occupied
 row 4   .   .   Bjorn   .   .                    party front
 row 5   .   Sigrun  .   Kaio  .                  party back
```

- Project the board **in the same isometric perspective as the ground**, so it sits on the floor
  rather than floating above it. If perspective ever fights legibility, legibility wins — a gently
  skewed board is fine, an unreadable one is not.
- Row 3 must read as structurally neutral. It is a no-spawn lane, and that should be visible.
- Each token: a shape, a one-letter or glyph mark, and a **thin HP bar**.
  - Bjorn 61% · Sigrun 85% · Kaio 90%
  - Quarry Revenant 100% · Slagjaw 44% · Cinder Grub (front-left) 100% ·
    Cinder Grub (front-right) 12%
- Party tokens and enemy tokens must be distinguishable at a glance without reading the labels.
- **One AoE telegraph:** Kaio's *Arrow Rain* is landing on a 2×2 area covering rows 1–2,
  columns 3–4. This is the most visually charged moment on the screen.
- A small encounter counter is welcome if it earns its place — for example, group 3 of an endless
  run. Do not add chrome that says nothing.

### 3. Party rail — three character cards

| | Bjorn | Sigrun | Kaio |
|---|---|---|---|
| Class | Guardian (tank) | Cleric (healer) | Ranger (physical DPS) |
| Level | 24 | 23 | 25 |
| HP | 412 / 680 | 290 / 340 | 355 / 395 |
| MP | 88 / 140 | 96 / 410 | 130 / 180 |
| EXP to next | 61% | 44% | 12% |
| Element | Neutral | Neutral | Wind |
| Status | *Shield Wall*, 6s left | *Blessing*, 94s left | *Focus*, 11s left |

Each card shows **four skill slots**, in this order, in these states:

- **Bjorn:** Taunt (ready) · Shield Wall (**active**) · Cleave (**cooling down, ~40% elapsed**) ·
  Bulwark (**passive** — permanently on, never a button)
- **Sigrun:** Heal (ready) · Group Heal (**not enough MP**) · Blessing (active) · Smite (ready)
- **Kaio:** Double Shot (ready) · Arrow Rain (**casting right now**) · Focus (active) ·
  Keen Eye (passive)

Five states must be separable without a legend — **ready, active, cooling down, casting,
unaffordable** — plus **passive**, which should read as a different kind of thing entirely. This
is the hardest part of the brief. Solve it properly.

Sigrun's MP at 96/410 should be legible as a problem.

### 4. Metrics strip

Four figures, tabular numerals so they do not jitter:

- Kills / hour **1,142**
- EXP / hour **84,300**
- Gold / hour **12,480**
- Time until death **~3h 20m**

Only the last is an estimate. Let it look like an estimate.

### 5. Loot feed

Recent drops, newest first. Five rarity tiers, each with its own colour, ordered
**Common · Uncommon · Rare · Epic · Legendary**. Rarity colour is the strongest signal here.

| Item | Rarity | Note |
|---|---|---|
| Emberforged Longbow | Epic | 3 bonuses · item lv 31 |
| Warden's Ashen Cloak | Rare | 2 bonuses · item lv 29 |
| Small HP Potion ×3 | — | consumable |
| Ashplate Greaves | Uncommon | 1 bonus · item lv 28 |
| Cracked Ore Band | Common | **auto-sold · +240g** |
| Gjallarhorn Fragment | Legendary | 4 bonuses · item lv 30 · older drop |

The auto-sold row gets a distinct treatment: it never entered the bag, it became gold. Make that
legible. The Legendary row anchors the top of the colour ramp and should look genuinely rare —
the one place a little drama is earned.

### 6. Event log

Ten lines, newest at the bottom, the list clearly scrolled to its end. Line types need distinct
but restrained treatment; the log is read by scanning, not by staring.

```
Kaio hits Slagjaw for 284
Cinder Grub hits Bjorn for 96
Bjorn casts Shield Wall
Slagjaw hits Bjorn for 311 (blocked 88)
Sigrun heals Bjorn for 142
Kaio crits Cinder Grub for 612
Cinder Grub is defeated
Warden's Ashen Cloak dropped
Sigrun reaches level 23
Kaio is casting Arrow Rain
```

Crits, drops, level-ups and defeats each deserve their own weight. Do not colour every line.

### 7. Preset chips

Two small controls at the bottom of the rail, each showing a current selection and an edit
affordance:

- Strategy: **Sustain** (one of three saved presets)
- Loot filter: **Rare and up**

These lead to editors that do not exist yet. They should look like they lead somewhere.

---

## The three directions

Same screen, three worlds. Each has a fixed palette and type pairing — use them, do not
substitute. Within each direction, **spend your boldness in one place** and keep everything else
disciplined.

### A — `hunt-a-basalt.html` · Carved basalt

Cold volcanic stone and worked iron, lit by ember. Panels feel cut and fitted rather than stacked.
The vernacular is masonry and metalwork, not parchment and swords.

```
--basalt    #0C0F12   page ground
--slab      #161B21   panels
--slab-lit  #1F262E   raised panels, card heads
--steel     #6E8AA6   cold accent: bars, rules, active states
--ember     #C8963E   loot, rarity ramp anchor, the AoE telegraph
--bone      #DDE3E8   primary text
```

- **Type:** `Fraunces` for the map name and character names — use its optical-size and soft axes
  deliberately; this is the one place type is a visual element. `Inter Tight` for everything else,
  with `font-variant-numeric: tabular-nums` on all figures.
- **Texture:** panels get **notched corners** via `clip-path`, never `border-radius`. A hairline
  highlight on the top edge and a darker hairline on the bottom edge give the sense of a cut slab.
  Use this bevel consistently and sparingly — it is the grammar of the whole skin.
- **Spend the boldness on the board.** The 5×5 tiles read as etched stone; the Arrow Rain 2×2
  glows ember against the cold steel of everything else. The rails stay quiet.
- Avoid: parchment textures, fake gold gradients, drop shadows as decoration, glow on anything
  except the telegraph.

### B — `hunt-b-phosphor.html` · Amber phosphor

A CRT terminal running a game. Hard edges, bevelled windows, phosphor colour. Reference the era
through construction — 2px borders, double bevels, zero radius — not through nostalgia props.

```
--void      #14121C   page ground
--shell     #1E1A2E   panels
--phosphor  #F0B429   primary amber: highlights, active states
--magenta   #D9418C   enemies, damage, danger
--cyan      #4CC9E0   party, healing, progress
--paper     #E8E2D4   primary text
```

- **Type:** `Silkscreen` for panel titles and the map name only — it is a display face and becomes
  unreadable if you set data in it. `IBM Plex Mono` for everything else, including all numbers.
- **Texture:** every panel is a window with a **title bar**. Borders are 2px and hard.
  `border-radius: 0` everywhere, no exceptions. Bevels are two-tone: light on top-left, dark on
  bottom-right. Bars are segmented into discrete blocks, not smooth fills.
- A **scanline overlay** (repeating-linear-gradient, around 3% opacity) goes over the **stage
  only** — never over text panels, where it would wreck legibility.
- **Spend the boldness on the party cards.** They are the windowed centrepiece: title bars, hard
  bevels, blocky segmented bars, phosphor-bright skill slots.
- Avoid: acid green — this is an amber-and-magenta machine. No blur, no bloom, no curved-screen
  vignette, no faux chromatic aberration.

### C — `hunt-c-console.html` · Tactical console

An instrument, not a game skin. Density is the aesthetic. Information is carried entirely by
hierarchy, alignment and hairline rules. No bevels, no decorative fills, no container that exists
only to contain.

```
--ground    #10141A   page
--surface   #171D26   panels, barely distinct from the page — that is the point
--rule      #27313F   hairlines, the only structural device
--text      #C3CCD8   primary text
--signal    #5FB3A1   progress, health, allies, OK
--alert     #E0714F   damage, danger, enemies, the telegraph
```

- **Type:** `Barlow` in one family, two widths — `Barlow Semi Condensed` for labels and dense
  columns, `Barlow` for everything else. Tabular numerals throughout. No second family.
- **Texture:** none. Strict 4px baseline grid. Bars are 4px tall. Panels are separated by a 1px
  rule and nothing else. Whitespace is tight and even.
- **Spend the boldness on the metrics strip and event log.** They should read like a live telemetry
  readout — the densest, most precise thing on screen, and the reason someone would pick this
  direction.
- Avoid: rounded cards, shadows, gradients, any panel background more than one step off the page
  background.

---

## Quality bar

- Real semantic HTML: `<header>`, `<main>`, `<aside>`, `<ul>`, and `<table>` where a table is a
  table. Class names describe the thing, not the look.
- Visible `:focus-visible` on the Stop hunt button and the two preset chips.
- Contrast: body text at least 4.5:1 against its background, in all three files. Check the dimmest
  text you write, not the brightest.
- `prefers-reduced-motion` respected. If you add motion at all, add **one** thing — a single pulse
  on the Arrow Rain telegraph is the only motion I would expect. No hover transitions on every
  panel.
- CSS custom properties for the palette at `:root`. Keep specificity flat; do not write selectors
  that cancel each other out.
- Do not write comments explaining the design. The file should be legible without them.

## Do not

- Do not invent a different layout per file. Same structure, three skins.
- Do not use lorem ipsum, `via.placeholder.com`, `picsum.photos`, or emoji as icons.
- Do not add screens, modals, navigation to other pages, or a settings panel.
- Do not add an all-caps tracked-out eyebrow label above each panel heading, meta strings joined
  with middle dots, or an arrow appended to button text. These are the defaults; I will recognise
  them.
- Do not soften the brief toward a generic dark SaaS dashboard. Direction C is dense and precise,
  which is not the same thing as generic.

## When you are done

In three or four sentences, say what the strongest idea in each file is and which direction you
would ship. Do not summarise the file contents back to me.
