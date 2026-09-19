# Milestone A — human placement experiment protocol (A-14)

This is the session script for the five-tester placement experiment required by
`2026-09-14-milestone-a-spec.md` §13. It exists because **no automated agent may run this gate**
(task-11 ruling R66): an agent cannot invent tester names, predictions, observations or
explanations, and simulating five people would make the one genuinely human gate in milestone A
worthless. The automated half of the evidence is already measured and is recorded in
`artifacts/milestone-a-results.md`; this document is what turns the remaining half from
`PENDING` into a result.

Run it, fill in the record sheet, and A-14 can be closed by whoever scores it.

---

## 1. What §13 actually asks for

> Human experiment: five testers, three fixed recipes, same party for placement comparisons, and at
> least two setup changes per tester. Record setup, result, what they expected, and their
> explanation of the outcome. Working gate: at least four testers can explain a supported effect of
> their own placement/strategy change, and measured results show more than one placement has an
> advantage across the three recipes. These are experiment thresholds, not statistical proof. If
> either gate fails, recommend simplify/revise and repeat a focused experiment before adding maps.

Restated as the two gates you are scoring:

- **Gate H (human, open — this protocol closes it).** At least **4 of 5** testers can explain a
  **supported** effect of a change *they themselves made*. "Supported" is defined in §6 below and is
  scored by someone other than the tester.
- **Gate M (measured, already closed by the CLI).** More than one placement shows an advantage
  across the three recipes. This was computed from a complete 30,600-row matrix and is reported in
  `artifacts/placement-analysis.md`. Testers are **not** shown that file before their session —
  telling them the answer first would anchor their predictions and destroy Gate H.

---

## 2. Before the session (facilitator)

1. Build and serve the exact tree under test, and record the git commit SHA on the record sheet:
   ```sh
   pnpm --filter @narok/client build
   pnpm --filter @narok/client preview --port 4173 --strictPort --host 127.0.0.1
   ```
2. Confirm the page opens at `http://127.0.0.1:4173/` and reads **Narok combat laboratory**.
3. Print or copy one record sheet (§5) per tester.
4. Testers work **one at a time or on separate machines**; they must not see each other's results
   or predictions. Five independent judgements is the whole point of the sample.
5. Do **not** show any tester `artifacts/placement-analysis.md`, `artifacts/matrix.csv`, or the
   results report before their session ends.

The laboratory keeps only **two** comparison slots (A = earlier run, B = latest run). Everything
else has to be written down as it happens, which is why the record sheet asks for the numbers
trial by trial.

---

## 3. The shared baseline every tester starts from

Identical for all five testers, so placement comparisons are like-for-like:

| Setting | Value |
|---|---|
| Roster size | 3 |
| Party | Guardian (p0), Cleric (p1), Ranger (p2) |
| Placement | the default the page opens with — do not change it for the baseline trials |
| Recipes | **Melee**, **Ranged**, **Clustered** — the three fixed recipes, in that order |
| Seed | `1` for every baseline trial, and the same seed again in the paired change trial |
| Rest HP % / Rest MP % | leave at the page defaults |
| Wipe limit | leave at the page default |
| Strategy rules | leave at the page defaults for the baseline trials |
| Speed | **16×** |
| Language | either; record which one was used |

`Mixed` is deliberately excluded: §13 asks for the three *fixed* recipes.

**How long one trial runs.** Press **Start experiment**, let it run at 16× until the
**Simulated elapsed** readout reaches **at least 15 min**, then press **Stop experiment**. That is
roughly one minute of real time per trial. Read the numbers off the comparison slot the stop just
filled — never off a running board.

---

## 4. What each tester does

**Step 1 — three baseline trials.** With the shared baseline above, run one trial for each of the
three recipes (Melee, Ranged, Clustered). Record the readout for each (record sheet, rows B1–B3).

**Step 2 — at least two setup changes, each one paired.** The tester now makes **at least two**
changes of their own choosing. §13 allows either kind:

- a **placement** change — move one or more party members to different cells in the party rows,
  by click or by arrow keys and Enter; or
- a **strategy** change — change a character's target mode, reorder its rules, or change a rule
  threshold.

For each change, **one change at a time**, and for each:

1. Write the change down **and write the prediction down before pressing Start.** A prediction
   recorded after seeing the result is not a prediction, and a trial whose prediction box is blank
   or back-filled does not count toward Gate H.
2. Re-run the **same recipe and the same seed** as the baseline trial it is paired with, for the
   same 15 simulated minutes. Holding recipe and seed fixed is what makes the pair a comparison of
   the change rather than a comparison of two different fights.
3. Record the readout (rows C1, C2, …).
4. Write the explanation: *what happened, and why the tester thinks their change caused it* —
   and, critically, **what on screen shows it** (a specific event-log line, a board observation, a
   metric that moved). The cited evidence is what makes an explanation "supported".

A tester may do more than two changes. Two is the floor, not the target.

**Step 3 — closing question.** Ask each tester, in their own words: *"Which placement would you
use for each of the three recipes, and why?"* Record the answer verbatim. It is not itself a gate,
but it is the qualitative signal that decides retain-vs-simplify if Gate H is marginal.

---

## 5. Record sheet (one per tester)

```
Tester:                        Date:                  Language used: EN / PT-BR
Build commit SHA:                                     Facilitator:
```

One row per trial. Every field is filled in from the comparison slot after the stop, except
**Prediction**, which is written before pressing Start.

| # | Recipe | Seed | Placement (p0 / p1 / p2 cells) | Strategy change (if any) | Prediction (written BEFORE start) | Simulated elapsed | Kills | Kills/hour | Encounters won | Wipes | Damage dealt | Effective healing | Stop reason | Tester's explanation | Evidence they cited |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B1 | Melee | 1 | default | — | (baseline — no prediction needed) | | | | | | | | | | |
| B2 | Ranged | 1 | default | — | (baseline — no prediction needed) | | | | | | | | | | |
| B3 | Clustered | 1 | default | — | (baseline — no prediction needed) | | | | | | | | | | |
| C1 | | 1 | | | | | | | | | | | | | |
| C2 | | 1 | | | | | | | | | | | | | |
| C3 | | | | | | | | | | | | | | | |

Closing question — which placement per recipe, and why (verbatim):

```
Melee:
Ranged:
Clustered:
```

---

## 6. Scoring Gate H

Scored by the facilitator or a reviewer, **not** by the tester, one tester at a time.

A tester **passes** if at least one of their own change trials satisfies all three of:

1. **The prediction was recorded before the run.** No back-filled predictions.
2. **The stated effect is real in the recorded numbers** — the metric the tester points at actually
   moved between the paired baseline trial and the change trial, in the direction they describe.
   The effect does not have to match their prediction; a tester who predicted wrongly and then
   correctly explained why they were wrong passes, and that is arguably the stronger result.
3. **The explanation is supported by something observable on the page** — the cited event-log line,
   board state or metric exists and says what the tester says it says. The reviewer must be able to
   find it. An explanation that is merely plausible but cites nothing does not count.

An explanation that is **contradicted** by the recorded numbers fails, no matter how confident.

**Gate H passes if 4 or 5 of the 5 testers pass.** Record the count, and record *which* tester
failed and on what ground — a failure that all five share points at the interface, not at the
testers, and that distinction is what the retain/simplify recommendation turns on.

---

## 7. Reporting the outcome back

When the session is done, update `artifacts/milestone-a-results.md`:

- Replace the A-14 row's `PENDING (requires five human testers)` with the observed result: the
  tester count, the pass count for Gate H, and the date.
- Attach the five completed record sheets (or a transcription of them) next to the report.
- If **either** gate fails, §13 is explicit about what follows: recommend **simplify/revise**, and
  repeat a focused experiment before adding maps. Do not close milestone A on a failed gate.
- Gate M's result is already recorded in `artifacts/placement-analysis.md` and does not need to be
  re-derived from the tester session; the human sample is far too small to measure it and was never
  meant to.

---

## 8. What this protocol deliberately does not cover

Two other gates also need human eyes and are **not** part of this session (they are listed as open
in `artifacts/milestone-a-results.md`):

- **R64's visual composition checks** — judging that the layout *looks right* at 1440×900 and
  1280×800, that nothing clips at 1100 px, and a bilingual EN/PT-BR inspection. The Playwright
  suite measures horizontal overflow only, which is not the same thing as a design judgement.
- **The single-VPS concurrency target** — that requires the target VPS, not a workstation.

They can be folded into the same session if a tester is willing, but they are scored separately and
neither is part of Gate H.
