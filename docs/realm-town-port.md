# Realm Refined — Bag, Character and Away port

**Updated:** 2026-10-02 (milestone B Task 10, fix round 1). Companion to [the Hunt port record](realm-hunt-port.md)
(R106–R110, `styles.css`) and [the Strategy port record](realm-strategy-port.md) (R111–R113,
`strategy.css`). This one governs `bag.css`, `character.css` and `away.css` and the three screens
built on them. The owner's decision (milestone B index §4.0) is that the three remaining sheets are
ported verbatim, frozen exactly as R107 and R113 freeze Hunt and Strategy.

## What is built

The three sheets are each mockup's **first `<style>` block, byte for byte** — each file has only
that one block (the rest of its styling is the gallery's `refined.css`, whose game-relevant polish
already lives in `styles.css`'s additions). Ranges confirmed on 2026-10-01 against the working tree,
by locating `<style>` and `</style>` in each file:

| Sheet | Reference range | Sheet range | Acceptance test |
|---|---|---|---|
| `apps/client/src/bag.css` | `bag.html:11-761` (`<style>` on 10, `</style>` on 762) | `1-751` | `diff <(sed -n '11,761p' codex-examples/realm-refined/bag.html) <(sed -n '1,751p' apps/client/src/bag.css)` |
| `apps/client/src/character.css` | `character.html:11-822` (`<style>` on 10, `</style>` on 823) | `1-812` | `diff <(sed -n '11,822p' codex-examples/realm-refined/character.html) <(sed -n '1,812p' apps/client/src/character.css)` |
| `apps/client/src/away.css` | `away.html:11-713` (`<style>` on 10, `</style>` on 714) | `1-703` | `diff <(sed -n '11,713p' codex-examples/realm-refined/away.html) <(sed -n '1,703p' apps/client/src/away.css)` |

Each `diff` prints nothing. `apps/client/test/stylesheet-port.test.ts` evaluates all five
invariants — these three and the two in the Hunt and Strategy records — in Node on every test run,
and also checks that each range is exactly the file's first `<style>` block. Since fix round 1 it
compares **exact bytes**: no line ending is normalised in the test. Line endings are normalised in
one place only, the repository's `.gitattributes`, which checks `codex-examples/realm-refined/*.html`
and `apps/client/src/*.css` out with LF on every platform; the test fails on a CR in either file,
checks that each sheet begins with its reference range byte for byte, and checks that after each
town sheet's frozen range come only blank lines and then its one labelled Additions block.

Everything after each frozen range is a labelled **Additions** block, product-side and small:

- `bag.css`: the Ignore verdict (the reference only draws Keep and Auto-sell), and the comparison's
  character chooser.
- `away.css`: `.verdict--failure`, the frame mark for a combat stop (a cap or a full bag never takes it).
- `character.css`: nothing yet.

### The collision, measured

The three sheets were written as standalone pages, so each restates the shared base. Measured
whole-rule — selector text and body, whitespace-normalised, at-rules keyed with their condition —
against `styles.css:1-754`:

| Sheet | Rules | Selectors shared with Hunt | Shared bodies that differ |
|---|---|---|---|
| `bag.css` | 312 | 81 | 0 |
| `character.css` | 283 | 69 | 4 — `:root`, `.realm` (`min-width: 1100px`), `.preset-edit`, `.drop--legendary` |
| `away.css` | 303 | 77 | 2 — `:root`, `.drop-name` |

The task brief measured 94 / 80 / 91 shared and 6 / 10 / 8 differing with a per-selector count;
splitting selector lists reproduces roughly its shared counts (95 / 82 / 90 here), and the
differing counts depend on how duplicate rules are merged. Either way the finding is the same:
**Character and Away redefine `:root` (and Character `.realm`), and even an identical body,
declared later in the cascade, re-wins over `styles.css`'s own additions block.** Loading the
three sheets globally would restyle Hunt. The test asserts it: with `character.css` left mounted,
Hunt's computed `:root` tokens or `.realm` box change.

## Binding rulings (R180–R196)

### R180 — the three town sheets are not editable

R107's words, applied to `bag.css:1-751`, `character.css:1-812` and `away.css:1-703`: no rule
inside the frozen range may be changed, reordered or deleted, including "only" a value. Additions
go in the labelled block after the range. *Why:* the owner decided the three remaining sheets are
ported verbatim and frozen exactly as Hunt and Strategy are; the `diff` commands above are the test,
not a promise.

### R181 — route-scoped loading

Each town sheet is imported by its own screen module as raw text (`import sheet from
'../bag.css?raw'`) and mounted by `useRouteSheet` (`apps/client/src/town/sheets.ts`) as one
`<style data-route-sheet="…">` element only while that screen is mounted; `main.tsx` imports none of
them. *Why:* the measured collision above — `:root` (Character, Away) and `.realm` (Character)
differ, and a plain CSS import cannot be unloaded once Vite has injected it, so a sheet loaded
globally, or left loaded after its screen closed, would restyle Hunt. Proven by
`stylesheet-port.test.ts` (Hunt's computed `:root` tokens and `.realm` box identical before a
screen mounts its sheet and after it unmounts) and by `e2e/client.spec.ts` against the built bundle.
The three screens are also lazily loaded chunks, so a session that never opens them never fetches
their sheets.

### R182 — no placeholder on the three screens

R108 extends to Bag, Character and Away: every panel is bound to real account state or left out.
No placeholder rarity, price, stat, timeline row or name, including "for now". *Why:* every number
in the three mockups is a fixture (UI spec §9), and part 4 §4 requires one coherent authoritative
account state. Left out, by region: Bag — the Materials tab, the bag expansion, the premium offline
timer, sell prices and gold values, the drop source line and flavour text; Character — the town
name, the Shop button, the premium badge and toggle, the element/affinity chip, roll ranges, sell
price, the mockup's attribute hints, the fixture "Not yet learnable" skills; Away — the time split
(the report carries no walk/fight/rest split for the absence), the per-tier loot ramp, the hour
ticks, level-up marks (no event records the instant a level was reached) and a version-2 report's
missing sections (R194).

### R183 — loot presets carry their payload on `GET /api/presets`

`GET /api/presets` now returns each loot preset's `payload` and `payloadSchemaVersion` beside its
identity (`apps/server/src/routes/hunts.ts`; `apps/server/test/client-reads.db.test.ts`). *Why:*
the Bag screen's filter pane shows the saved rules and previews them through the shared evaluator
(part 4 §3.3, B-14), and the server had no other read of them. A read only: loot presets still have
no save route (R188).

### R184 — Away shows the counts the report carries, and no other (withdrawn)

*Withdrawn by the controller in fix round 1 (`task-10-fix1.md`, I2): part 4 §3.5 binds, so the
server's report was extended (version 3, R191–R194) rather than the spec waived. Kept for the
record.*

The away report (`AwayReport` version 2, `apps/server/src/reports/away.ts`; the protocol carries
only the socket's `{type: 'report', reportId}` notice) carries two wipe counts — `wipesThisHunt`
and `outcomes.wipes` for this absence — and no per-member deaths. The screen shows the two counts,
separately, and no third. It likewise leaves out the reference's per-member results, notable
drops, time split and timeline: the report carries none of them. There is no wipe limit to draw
pips against — a full wipe ends the hunt and returns the party to town, fully healed (R154). *Why:*
part 4 §3.5 asks for three counts, but inventing a figure the server never sent is exactly what
R182 forbids; adding member deaths, a timeline or per-member results is a report-schema change for
the server, not a client fill-in. Part 4 §3.5's "never hide the timeline" is therefore open until a
timeline exists to show.

### R185 — the sale selection, behind `VITE_FEATURE_SHOP`

Prices are deferred (spec §4.0) and `/api/inventory/sell` is unimplemented, so **B-15 stays open
behind prices**. The client half is built in `town/model.ts` and `town/SaleControls.tsx`: a bulk
selection excludes locked items (and bound and protected ones), counting what it kept; a locked
item's own sale is refused until the player unlocks it through the lock command; every preview
counts items and slots freed only — no gold, no price key. Every sale control is reached only
through `App.tsx`'s `SHOP_ENABLED ? SALE_KIT : null`, where `SHOP_ENABLED` is
`import.meta.env.VITE_FEATURE_SHOP === 'true'` (`src/features.ts`), off by default.
`test/shop-flag.test.ts` builds the bundle both ways: with the flag unset no sale entry point
(`data-sale`) is in it, and with it on the marker is. The NPC shop and potion purchase ship no
route, no component and no price key. *Why:* the controller's ruling — no price may be invented and
no reconciliation test written against a route that does not exist.

### R186 — a skill's lock names the rule's own requirements

Content defines no skill-to-skill or level prerequisite, so a skill that cannot be raised names
what `upgradeSkill` actually requires: being in town, an unspent skill point, room under the rank
cap (`content.progression.maxSkillRank`). *Why:* part 4 §3.4 requires a locked skill to name its
missing prerequisites, and the only prerequisites that exist are those; the mockup's "Level 30 /
Double Shot 5" rows are fixtures.

### R187 — comparisons and previews use the item's own figures

The Bag comparison is the candidate's definition base values (weapon ATK/MATK, DEF/MDEF, attack
interval) and its rolled bonuses, stacked by `@narok/data`'s `stackBonuses`, against the worn
item's, with signed deltas (percentage-point values labelled as such). The Character combat block
shows the server's derived stats as they are; neither screen projects an "after" combat stat.
*Why:* derived stats are the engine's formula (`deriveCharacter` in `@narok/sim`), and the client
runs no engine (B-02); a second copy of the formula is what part 4 §1 forbids.

### R188 — the loot-filter draft is local; Apply sends a saved version

The rarity rules are editable as a local draft, marked edited, revertable; the preview runs
`@narok/loot`'s `evaluate` over the equipment the bag holds — the only drop records the client
reads — and mutates none of them. Apply sends the selected preset's *saved* version to the running
hunt (`POST /api/hunts/current/loot`), governing future drops only. B has no loot-preset save
route, so a dirty draft cannot be applied, and the pane says so. *Why:* applying a draft the server
never stored would apply something no version names (part 4 §3.3: "apply a filter retroactively"
and unversioned applies are both forbidden).

### R189 — guards for the town commands

Equip, unequip, allocate, upgrade-skill and sell send the account version of the newest read the
player acted on; lock and apply-loot read the version at the moment of sending, as Save and Apply
do (R170). Every success re-reads the whole account; every refusal is recorded and rethrown, and a
stale-version refusal re-reads too. *Why:* the first group is town-only, so in town the version is
stable and a different one means the player's picture — and an allocation draft's quoted cost — is
stale; lock and apply-loot are allowed mid-hunt, where the version moves at every settled
encounter and a read-time guard would refuse nearly every command.

### R190 — the loot filter named is the one the hunt runs

`HuntResponse` carries the server's `activeLoot` and `pendingLoot`. The Orders window's Loot filter
button, Away's "Current loot filter" and the Bag filter pane's default tab name the running hunt's
active loot preset; in town they name the preset a start would use (`useHunt`'s
`startLootPresetId`, the one `start` sends). The pane marks that preset Active (or "Used to start"
in town) and a preset applied but still waiting for earlier drops as Applied next; a pending loot
filter re-reads the hunt on each phase change, as a pending strategy does. *Why:* the first preset
in the list is only an alphabetical accident; naming a filter the hunt is not running misleads the
player about what happens to their drops (part 4 §3.3 reads "the active and draft loot presets").

### R191 — the away timeline is bounded and chronological

The report's timeline is folded from the events the settlement produced (`hunt/digest.ts`): a
member's death, a revive (with its source — Idun's Apple or the Revive skill), a party wipe and the
engine's stop are one entry each; runs of encounters won and of kept drops lost to a full bag fold
into one entry at the run's first event, counting the rest, and a course event closes a run. The
offline cap, when it bit and no stop came first, is appended at `capCutoffWall`. At most **nine**
entries are kept — the most recent — and `timelineOmitted` counts the earlier ones let go; the
screen adds the return mark, making the reference's ten marks on one track. The report body scrolls
internally; the actions sit in the footer outside it. *Why:* part 4 §3.5 asks for the chronological
timeline, and an unbounded list of every win would be neither readable nor bounded in the report
row; the stop is always the last event, and the latest stretch is what the player returns to. No
entry is written that the engine did not emit: there are no level-up marks, because no event records
the instant a level was reached.

### R192 — the settlement digest

A settlement that will be described by an away report (the feed's connect after an absence) asks
the segment runner for a digest: the engine then advances in `'events'` mode — which changes no
state, RNG draw or reward (layer-1 §4.8; `digest.test.ts` proves the committed state is identical)
— and each accepted step's events are folded into per-member death and revive counts and the R191
timeline, then let go; only the events `collect` asked for are returned. The digest has its own job
slot in the segment pool, so a joiner never receives a result without one. *Why:* a summary
settlement keeps no events, and per-member deaths and the order of events exist nowhere else; the
digest is derived only from what the settlement itself settles.

### R193 — notable loot

The report's notable loot is the absence's **kept equipment** drops, rarest first in content's own
rarity order (`RARITIES`), earliest first within a rarity, at most **six**, with the total kept
beside it (`notableTotal`; the screen says how many more are in the bag). *Why:* content defines no
"notable" rule, so no rarity threshold is invented — every kept equipment drop is eligible and the
order alone decides what leads; six is the reference's own list length, a display bound and not a
rarity rule. Auto-sold drops were never the player's to inspect, and lost ones are not loot the
player has (part 4 §3.5: never imply missed drops can be reclaimed). The list sits in the loot pane
inside the scrolling body; it cannot obscure the recovery action.

### R194 — report version 3, and older reports

`AWAY_REPORT_VERSION` is 3. Version 3 adds `mapId`, `party` (each member's character id, class,
level and EXP before and after, deaths and revives during the absence), `memberDeaths` (the third
count, summed over the absence, beside `wipesThisHunt` and `outcomes.wipes`), `notable`,
`notableTotal`, `timeline` and `timelineOmitted`. Under the owner's 7c rules a wipe ends the hunt,
so both wipe counts are 0 or 1; the three counts still render separately. A version-2 report already
stored is **decoded, not reset**: `decodeAwayReport` maps its absent fields to `null` and the screen
leaves those sections out rather than drawing an empty or zero one. *Why:* only the latest report
per account is kept and it ages out under `reportRetentionMs`, so a decoder that tolerates the old
shape costs one function and no operator step; a report that never carried a figure must not be
shown as having counted none (R182).

### R195 — a town screen shows its own commands' refusals

Town commands reach their screens unswallowed. Each screen catches the rejection of the command it
sent and renders the server's stable code (`serverError.<CODE>`) where that command lives: Bag —
an equip or lock under the item tip, an Apply in the filter pane's footer; Character — an
allocation in the attribute pane, a skill rank in the skill pane (the staged rank is kept), an
unequip in the gear pane's item tip (the tip stays open). The hook's `commandError` stays the Hunt
shell's. A stale account version has already re-read the account in the command layer (R189), so
the Character screen re-reads only on a cost refusal. *Why:* part 4 §3.1 requires every refusal to
be rendered from the server's code; showing the account's last error under an item tip would blame
the bag for a Hunt start refused earlier, and swallowing a skill or unequip refusal made a refused
command look like nothing happened.

### R196 — loot-filter drafts are kept per preset and across refreshes

The filter pane keeps one draft per preset, so switching tabs never discards one, and a newly read
version of a preset leaves an edited draft in place, still marked edited against the version now
saved. Revert is the only way a draft goes. *Why:* part 4 §3.3 requires the draft "preserved across
recoverable failures"; a refresh or a tab switch is not the player's decision to drop it.

## Component map

| Reference region | Component | Bound to |
|---|---|---|
| `bag.html` `.statusbar` (back seal, screen name, ledger) | `town/BagScreen.tsx` | `useHunt` inventory (gold, `usedSlots`/`capacity`), hunt zone and status |
| `.bag.win` tabs, search, sort | `BagScreen` + `town/model.ts` `queryBag`, `categoryCounts` | inventory items and consumable stacks |
| `.bag-grid` cells | `BagScreen` | unequipped items and consumable stacks; `.cell--empty` × server free slots |
| `.itemtip` (pin bar, head, facts, bonuses, actions) | `BagScreen` | the selected or pinned entry; lock is a command |
| `.tip-compare`, `.comparison`, `.eligibility` | `town/ItemCompare.tsx` | a real eligible character, its real worn item in the target slot (`model.compareItems`, `equipBlock`) |
| `.bag-foot` capacity, `.bulk` | `BagScreen`; `town/SaleControls.tsx` (flagged, R185) | inventory |
| `.filter.win` presets, ramp, exceptions, preview, footer | `town/FilterPane.tsx` | loot presets (R183), `@narok/loot` evaluator (R188) |
| `character.html` `.townbar`, `.purse` | `town/CharacterScreen.tsx` | hunt status, inventory |
| `.charwin` roster, vitals, expline | `CharacterScreen` | `GET /api/characters` (level, EXP, HP/MP) |
| `.gear-pane` doll and `.itip` | `town/GearPane.tsx` | worn items per slot; Unequip is a town-only command |
| `.attrs` list, allocation preview, auto-spend, combat | `town/AttributePane.tsx` | allocated attributes, gear attribute bonuses, stat points, `@narok/progression` costs, server-derived stats |
| `.skills` list, preview, foot | `town/SkillPane.tsx` | class skills (content), ranks, skill points, `nextSkillPointLevel` over `content.progression.skillPoints` |
| `away.html` `.herald` (title, time away, cap meter, map) | `town/AwayReport.tsx` | report `timeAwayMs`, `simulatedMs`, cap window `capCutoffWall − awayFromWall`, the report's own `mapId` |
| `.verdict` and `.attempts` | `AwayReport` | report `copyKey`, `stopReason`; three counts — `wipesThisHunt`, `outcomes.wipes`, `memberDeaths` (R194) |
| `.party-results` | `AwayReport` | report `party` (level and EXP before/after, deaths, revives), names from the roster; encounters won and lost |
| `.ledger-grid` totals and loot | `AwayReport` | report outcomes (kills, wins, raw EXP, raw gold, consumables, drop dispositions) |
| `.notable` | `AwayReport` | report `notable`, `notableTotal` (R193) |
| `.chronicle` | `AwayReport` | report `timeline`, `timelineOmitted` (R191), positioned over `awayFromWall → returnedAtWall` |
| `.actions` | `AwayReport` + `model.awayView` | report actions ordered against the *current* inventory; the filter named by R190 |
| `.timesplit`, `.ramp`, `.hours`, level-up marks | — | left out (R182) |

`App.tsx` routes `hunt | bag | character | away` over one `useHunt`; Strategy stays the
`SetupOverlay` panel. The Hunt Orders window gains the reference's second preset button (Loot
filter → Bag) and a Party button (→ Character); a report notice from the socket opens Away once per
report id.

## Known debt

- B-15 is open behind prices (R185); B-22's visual composition of the three screens at 1440×900,
  1280×800 and 1100px, in EN and PT-BR, is a human observation not yet made.
- Loot presets cannot be saved (R188); the auto-spend template is shown read-only.
