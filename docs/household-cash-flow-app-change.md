# Household cash flow: what is left each year, and what would change it

Status: design chosen 2026-10-13 (the staircase on a wide screen, the single bar on a phone), not started. Stage 1 only.

## Context

A household knows what comes in and what has to go out. The question this module answers is **after everything that has to be paid, what is left each year, and what would change it?**

Nothing in the app answers it yet. The pension and net retirement modules work in retirement, and the personal balance sheet is a stock (what is owned), not a flow. This module is the flow for one ordinary year: income in, tax and costs out, what remains. It is a single-year picture. It is **not** the multi-year cashflow modelling module that the header of `js/planning/tax/engine.js` calls "the cashflow module to come" and `docs/irish-tax-app-change.md` describes. That one projects accounts and drawdown over decades and needs its own brief.

Three options were explored. Two were chosen, **one per kind of screen**, and both draw the same model:

- **Wide screen: the staircase** (option C). Income is a tall block at the left. Each cost steps down from it, one column each, until what is left stands on the floor at the right.
- **Phone: the single bar** (option A, drawn upright). The year is one bar of income, spent from the top down, one segment per cost, with what is left as the last piece.

The idea both must land: **a year of income being used up, and the size of what remains.** The shape has to say the same thing as the numbers, and a client must read it as a shape within three seconds, before reading a figure.

Case 4 is the test of the whole design. It leaves the same amount over as today, but the household is different: no car loan, more going into pensions, less tax. The picture must make that visible, and it is an acceptance test (see Tests).

Reference frames, in the design canvas (private link: https://claude.ai/artifact/Ai8XjedaDuTFvxTc8FmFaS):

| Frame | File in the canvas | What it shows |
|---|---|---|
| `C · Steps · Today selected` | `Steps.dc.html` | Wide, 1920×1080, case 1 selected |
| `C · Steps · Both selected` | `StepsBoth.dc.html` | Wide, 1920×1080, case 4 selected |
| `Phone · Today selected` | `Phone.dc.html` | Phone, 390×1420, case 1 selected |
| `Phone · Both selected` | `PhoneBoth.dc.html` | Phone, 390×1420, case 4 selected |

The canvas also holds frames you must **not** build: the single bar and the narrowing stream at 1920 (`Main`, `BarBoth`, `Flow`, `FlowBoth`), the quarter-turned staircase for phones (`Cascade`, `CascadeBoth`) and the squeezed staircase (`Squeezed`). They were explored and set aside. The squeezed one exists to show why the staircase cannot simply shrink: nine columns in 350px means type under 12px and amounts that collide.

Four things to know before you use the frames:

- They were drawn with **design fixture figures** (tax 48,000 and 44,000), not figures from the tax engine. See "What the sample does in the engine". Their numbers are not what the module will show with engine tax.
- They were built in the design tool and have **not been opened and checked in a browser**. Treat them as a drawing, not a reference implementation.
- They draw no footnote. One is required here (see Words), and it is the only element on screen that is not in a frame.
- Where this brief and a frame disagree, the brief wins. Say which.

It is used two ways at once. It is shared at 1920×1080 on a call while the adviser clicks between cases, and it is re-opened later by the client alone on a laptop or phone with nobody talking. Nothing may depend on spoken context.

## Decisions to confirm

Four defaults are assumed so the work can start. Each is cheap to change now and expensive later.

| # | Decision | Default used | Why it matters |
|---|---|---|---|
| D1 | Where tax comes from | **The Irish tax engine.** Tax is never typed in the payload. Each case's tax is `computeTaxYear`, and the pension change is that engine's marginal effect. | The repo rule is that no module keeps its own tax. It also changes the sample: see the next section. |
| D2 | What "tight" means | **Nothing left over after rounding** (shown left over is €0). Green is anything above that. | Any percentage is a judgement. If a threshold is wanted it belongs in `PLANEIR_ASSUMPTIONS` as a named, disclosed assumption, never in the renderer. |
| D3 | A case that leaves less than nothing | **Rejected on the way in.** The red "short" state has not been drawn. | A real household can be short. The first follow-up is to draw it and lift the rejection. |
| D4 | Module name | **Household cash flow**, kind `household-cash-flow`, id `household_cash_flow`. | The multi-year module will want a name too. Say if this one should be "A year's cash flow" or similar. |

## What the sample does in the engine

Checked 2026-10-13 with `scripts/ie-tax.mjs`, tax year 2026, `married_or_civil_partners`, two people aged 45, rules `ie-tax-2026.1`, employment income only:

| Income split | Income tax | USC | PRSI | Total tax |
|---|---|---|---|---|
| 75,000 / 75,000 | 34,400 | 4,061 | 6,356 | **44,817** |
| 90,000 / 60,000 | 34,400 | 4,563 | 6,356 | 45,320 |
| 120,000 / 30,000 | 35,400 | 6,063 | 6,356 | 47,820 |
| 130,000 / 20,000 | 37,400 | 6,650 | 6,356 | 50,407 |

Two things follow.

1. **The frames' 48,000 is a round design figure, not an engine result.** No split of 150,000 gives exactly 48,000.
2. **The 4,000 tax saving is exact.** A €10,000 pension contribution (`employmentPensionContribution`) lowers income tax by exactly 4,000 in every split above, because it is relieved at 40%. USC and PRSI do not move. So the frames' "tax falls to 44,000" is right in size, and the engine will produce it.

With tax from the engine and a 75,000 / 75,000 household, the four cases are:

| | Today | Clear the car loan | 10,000 more into pensions | Both |
|---|---|---|---|---|
| Tax (shown, to €100) | 44,800 | 44,800 | 40,800 | 40,800 |
| Pensions | none | none | 10,000 | 10,000 |
| Car loan | 6,000 | 0 | 6,000 | 0 |
| **Left over** | **9,200** | **15,200** | **3,200** | **9,200** |
| A month | About €770 | About €1,270 | About €270 | About €770 |

Case 4 still equals today, which is the point of the design. But **case 3 is no longer "nothing left over"**, so the amber "tight" state does not appear in the engine-derived demo. Both fixtures are required in Tests: the design fixture reproduces the frames exactly (including amber), and the engine fixture is what a client would see.

## Defaults assumed

1. **Release surface.** Adviser-only through the Dev Panel, the presenter and the published session viewer. `consumer: false`, as the pension and mortgage modules were. No consumer routing, no voice, no planner facts.
2. **One ordinary year.** Every amount is per year, in today's money. No growth, no inflation, no projection. "Each year" means a typical year.
3. **Pension money is not spent.** The picture treats a pension contribution as leaving the household's spending money, which is what the case is about. The wording is "goes out" and "goes into pensions", never "lost" or "spent". The assumptions table says what the left-over figure is: income after tax, pension contributions and the stated costs.
4. **Rounding on screen.** Every amount to the nearest €100, from unrounded values. Rules in the contract.
5. **No rates, no tax lines in the payload.** The payload carries income and stated costs. Tax and its rules come from the engine, so every module and adviser reads the same number.

## Before you write code

- Pull `main` and create a new branch, for example `household-cash-flow`.
- Read `js/repayment_case_module.js` end to end. It is the closest precedent and this module should feel like its sibling: same clock, same settling discipline, same `build...Module({ rawInputs, selectedCaseId, onSelectCase })` shape, same standalone dev preview (`dev/repayment-module-preview.html`). Then read the commit message of `1d0e895` for the acceptance rule on motion.
- Read `js/planning/tax/engine.js` (the header, `computeTaxYear`, `marginalTax`), `docs/irish-tax-app-change.md` sections 3.2 and 3.4, and `docs/irish-tax-handback.md`. Run `node scripts/ie-tax.mjs year` on a household by hand before you write any code.
- Read how `js/pension_math.js` builds its tax input and people (about line 1132, and the `householdTaxStatus` errors at about 1707), how it calls `marginalTax` (about 1491) and how it renders disclosures with `renderTaxDisclosures` (about 3156). This module does the same things and must not differ.
- Read `js/scenario_cap.js`, `js/presenter_catalogue.js` (`moduleKind`, `scenarios`), `js/video_scene.js` (`getVideoModuleKind`), `js/codex_video_brief.js`, `js/state.js` (`normalizeGenerated`, `normalizeModuleUi`, `mortgageScenarioId`) and `js/render.js` (`buildMortgageScenarioShell`), plus `setMortgageScenarioForModule` in `js/app.js`, because a module the presenter cannot select a case in, or the video cannot describe, is half a module.
- Read `docs/future-cost-fund-app-change.md`. It is a sibling brief with the same wiring and the same discipline (a pure layout function, one motion clock, two fixtures). If it has landed, copy its wiring. If it has not, expect both changes to touch `presenter_catalogue.js`, `state.js`, `render.js` and `app.js`, and land one first.
- Then give a short plan: final field names, the file list, how the selected case is persisted, where the pure layout function sits, and how the width switch is measured. **Wait for the go-ahead before implementing.**

## The contract

Add `generated.householdCashFlowInputs`. Engine in `js/household_cash_flow_math.js`, renderer in `js/household_cash_flow_module.js`, tests in `js/tests_household_cash_flow_math.js`.

### Inputs

| Field | Type | Rule |
|---|---|---|
| `householdLabel` | string, optional | Client-facing, for example "Niamh and Dara". Trimmed, 1 to 60 characters. Shown as a muted line above the heading. Absent: not shown. |
| `householdTaxStatus` | string, optional | `single`, `married_or_civil_partners` or `widowed_or_surviving_civil_partner`. Same values, same errors and same disclosure behaviour as `pensionInputs`. Not given: each person is assessed as single, disclosed. |
| `people` | array, required | 1 to 2 of `{ id, age, label? }`. `id` unique, `[a-z0-9_-]`. `age` an integer from 16 to 110. |
| `income` | array, required | 1 to 6 of `{ personId, type, amount }`. `personId` is a person id or `joint` (split equally, as in the engine). `type` is any Phase 1 income type of `computeTaxYear` **except** `employmentPensionContribution`, which only a case change can produce. `amount` greater than 0, per year, before tax. |
| `outgoings` | array, required | 1 to 6 of `{ id, label, amount }`. Stated, per year, 0 or more. `id` unique and stable, `[a-z0-9_]`. `label` client-facing, 1 to 24 characters, sentence case. Drawn in the order given. |
| `calculationYear` | integer, optional | The tax year. Default: whatever year `pensionInputs` uses as `currentYear`. |
| `baseScenarioId` | string, optional | Must match a case id when present. Default is the first case. |
| `scenarios` | array, required | 1 to `MAX_MODULE_SCENARIO_CASES` (4) cases, from `js/scenario_cap.js`, base included. |

A line that is €0 in every case is not drawn. More than 6 outgoing lines is rejected rather than grouped: the staircase gets one column per line, and the adviser decides what to combine.

There is **no tax line and no left-over field.** A payload that states either is rejected (see Validation). Tax is calculated and left over is `income − everything out`, so neither can disagree with the rest.

Each case:

| Field | Type | Rule |
|---|---|---|
| `id` | string, required | Unique. Stable, because the presenter selects cases by id. |
| `title` | string, optional | Client-facing button name, up to 40 characters. Absent: derived (see Words). |
| `description` | string, optional | One sentence, for the presenter. |
| `changes` | array, optional | 0 to 3 of the two kinds below. The base case has none. |

The two changes that have been designed, and therefore the only two that exist in Stage 1:

| `type` | Fields | Meaning |
|---|---|---|
| `clearOutgoing` | `outgoingId`, `paidFrom?` (`'savings'`) | That line becomes 0. `paidFrom` only changes the wording. |
| `extraPension` | `amount` (> 0), `personId?` (default `joint`) | `amount` more is paid into a personal pension. Becomes an `employmentPensionContribution` item. At most one per case. |

That gives the four sample cases exactly: no changes; `clearOutgoing: car`; `extraPension: 10000`; both. A case states *what changes*, never *what the result is*. The engine solves the amounts.

### The model

- `computeHouseholdCashFlowProjection(rawInputs, { taxFor, calculationYear } = {})`. By default tax is `computeTaxYear({ input }).result.totals.totalTax`, the recurring total of income tax, USC and PRSI, with no lump sums. The `taxFor` option exists so tests can inject the design fixture. It is never reachable from a payload.
- Per case: income items from the payload, plus one `employmentPensionContribution` item for an `extraPension`. The case's tax is that year's total. The change in tax against the base case is what the engine returns for that contribution, so it equals `marginalTax` to the cent. Do not subtract a "40%" yourself.
- `pensions` is the sum of `extraPension` amounts. It is its own line, after tax.
- `outgoingTotal = tax + pensions + Σ outgoings`, and `leftOver = income − outgoingTotal`, both unrounded.
- Levels, for the staircase and the bar: `level₀ = income`, then each line in order subtracts from the one before: tax, pensions, then the stated lines in the order given. The last level is `leftOver`.
- The case with `id === baseScenarioId` is "today". Every `deltaVsToday` on screen is measured against it.

### Rounding

- Show every line to the nearest €100, rounded independently from unrounded values.
- **Shown left over is always shown income minus the sum of the shown lines**, never rounded on its own, so the picture always adds up.
- The month figure is shown left over ÷ 12, to the nearest €10. It is prefixed "About" unless it is exact (500, 1,000, 0).
- Do not "fix" a column by nudging a block.

### Outputs

`computeHouseholdCashFlowProjection(rawInputs)` follows the college engine's shape: `assumptionsTable`, `outputsTable` (one row per case), `tables` (the lines for each case), `charts`, `debug`.

- `debug.cases[]`: `id`, `title`, `description`, `changes`, `lines[]` (`{ id, label, amount, shownAmount, deltaVsToday }`), `levels[]`, `income`, `leftOver`, `shownLeftOver`, `monthly`, `status` (`left_over`, `tight`), `sentence`, `taxBreakdown` (`incomeTax`, `usc`, `prsi`) and `disclosureCodes`.
- `debug.assumptionsUsed`: `IE_TAX_RULES_VERSION`, the tax year, `PLANEIR_ASSUMPTIONS_VERSION`, the household tax status and whether it was defaulted.
- The assumptions table states, in plain words: per-year figures in today's money, tax is an estimate of income tax, USC and PRSI with the disclosures `renderTaxDisclosures` returns for the codes the engine applied, pension contributions are shown after tax relief, and amounts are rounded to the nearest €100. Use the engine's own disclosure text. Do not write tax sentences here.
- `charts` carries **one** ordinary chart (the base case's lines in order, income at the left) for the surfaces with no module to draw for them, chiefly the video summary. This is what `repayment_case_module.js` does. The focused pane shows no charts card for this module.
- `getHouseholdCashFlowCases(rawInputs)` returns `[{ id, title, description }]` for the presenter, like `getMortgageScenarioCases`.

### Validation

Messages follow the existing style and name the field and the case:

- `generated.householdCashFlowInputs.scenarios supports at most 4 cases; received 5.`
- `generated.householdCashFlowInputs.outgoings supports at most 6 lines; received 7.`
- `generated.householdCashFlowInputs.outgoings[0] (Tax): tax is calculated from income by the Irish tax engine and cannot be stated.` Reject any outgoing whose id or label is `tax` (case-insensitive).
- `generated.householdCashFlowInputs.leftOver is not accepted. It is calculated.`
- `generated.householdCashFlowInputs.scenarios[2] (Pay €10,000 more into pensions): leaves €1,200 less than nothing each year, which this screen does not draw yet.` (D3)
- `generated.householdCashFlowInputs.scenarios[1] (Clear the car loan): outgoingId "car" is not one of the outgoings.`
- Also: duplicate case id or outgoing id, unknown case or change key, `baseScenarioId` not matching, a change cleared twice, more than one `extraPension`, an unknown `personId`, `householdTaxStatus` errors worded as `pensionInputs` words them, an `income` item of type `employmentPensionContribution`.
- The session importer in `js/state.js` treats `scenarios` like the other capped arrays: tolerate on the way in, cap with an import warning, never throw.
- `householdCashFlowInputs` is mutually exclusive with the other engine keys in `normalizeGenerated`, handled exactly as `collegeFundingInputs` is, and is cleared by a `videoSummary`.

## On screen

### What is on it

One element carries the screen: the staircase on a wide screen, the bar on a phone. Everything else is quiet. In reading order:

1. `householdLabel` as one muted line, then the question as the heading: "What is left each year, after everything is paid?" The heading is fixed copy, not a payload field.
2. The case buttons. Two to four. One case: no buttons.
3. The answer: a status word, the left-over figure at hero size with "a year", and the month figure in small type.
4. The one sentence saying what this case changes against today.
5. The drawing.
6. One muted footnote (see Words).

On a wide screen the answer sits in a column at the right of the staircase when there is room, and above it when there is not. On a phone it sits above the sentence and the bar.

### Which drawing, and when

Choose by the **width of the module's own content box**, not the device and not the window, because the module sits in a pane (the presenter, the focused view, the session viewer).

- Content width **848 and up**: the staircase.
- Content width **under 832**: the bar.
- Between 832 and 848 keep whichever is showing. This is hysteresis: a vertical scrollbar appearing on the taller bar narrows the box by about 15px, which would otherwise flip the layout back and forth.

Measure with a `ResizeObserver` on the module root and fall back to `window.innerWidth` if it is missing. Render **only the active drawing**. When the width crosses the line, build the other one once, keep the selected case, and do not rerun the engine. 832 is not arbitrary: it is the narrowest content box at which the staircase's nine columns keep names at 14px or more.

Both drawings, and the answer, sentence and buttons, read from the same model object. They differ only in geometry. If they ever disagree, that is a bug.

### The staircase (wide)

A single SVG-or-DOM drawing owned by the module. Build the **layout as a pure function** (`layoutCashFlowChart(model, { width })` returning plain numbers and boxes for both modes) and keep the DOM out of it, so geometry and label collisions can be tested in Node.

Reference is 1728 of content width (the 1920 frame less 96 either side).

| Thing | Rule | Reference value |
|---|---|---|
| Columns | Income, Tax, Pensions, each outgoing line in order, Left over. Call the count `n`. **Pensions is a column only if some case adds a pension**, so the slot is stable across cases. | n = 9 |
| Answer beside | content width at least 1360 | yes |
| Plot width | beside: width − 376 (328 answer + 48 gap). Otherwise width. | 1352 |
| `pitch` | plot width ÷ (n − 1 + ⅔) | 156 |
| Bar width | pitch × ⅔ | 104 |
| Plot height | clamp(300, pitch × 2.9, 450) | 450 |
| Scale | plot height ÷ income. **One scale for the module, the same in every case**, so nothing rescales on a click. | 0.003 px per € |
| Income bar | From the baseline to the top. Light neutral. | |
| Cost bars | Each **hangs** from the previous level: top at the level before, bottom at the level after. Neutral. A cost that changed against today: blue-grey. | |
| Left over | Stands on the baseline, height = shown left over × scale. Green. At €0 there is no bar, and a 3px amber line on the baseline across the column. | |
| Connectors | 1px at 30% text, from a bar's right edge to the next bar's left edge, at the level they share | |
| Baseline | 1px at 32% text across all columns | |
| Amounts | Centred above each bar except left over, 42px above its top at reference, 28/700 | |
| Names | Centred under the baseline, 16px gap, 22/600 muted, wrapping on spaces. A changed line adds a delta line at 20/500 in text colour. | |
| Pension column, no pension in this case | No bar. Name and "€0" at 55% opacity. The slot stays, so bars never shift sideways. | |
| Ghosts | Today's bar, as a 1.5px outline at 55% text, shown **only** when the selected case is not today, today's amount is above 0, and the bar's position or size differs from today's. Fixed: they do not move. | |

Type scales with the pitch: `fs = clamp(pitch ÷ 156, 0.62, 1)`. Amounts `max(16, 28 × fs)`, names `max(14, 22 × fs)`, delta `max(13, 20 × fs)`. At 832 content width the pitch is 96 and `fs` is 0.62.

Between 848 and 1359 the answer sits in a row above the staircase: status word and swatch, the figure with "a year", then the month figure, left-aligned. Only 1920 has been drawn, so check 1366×768 and 1024 by eye and report what looks wrong rather than guessing.

### The bar (phone)

Reference is 350 of content width (a 390 phone with 20px sides). The bar is spent from the top down.

| Thing | Rule | Reference value |
|---|---|---|
| Bar | 64 wide, 700 tall. One scale: 700 ÷ income, the same in every case. | €1,000 = 4.67px |
| Track | Radius 12, clipped. Segments in the order tax, pensions, each line, left over, with 2px gaps. | |
| Changed segment | Blue-grey fill, and the word "less" or "more" in its label | |
| Cleared line | Zero height. A 3px blue tick across the bar at the junction, and a label showing "€0" and "€6,000 less than today". The row stays. | |
| Left over | Green segment at the bottom. At €0, no segment and a 4px amber mark at the floor. | |
| Header row | "Income before tax" muted at 15/500 on the left, "€150,000 a year" at 17/700 on the right, hairline at 18% below it, then 20px, then the bar | |
| Labels | Right of the bar, left edge 84. One per segment, vertically centred on it. Name 15/600 muted, then a 1px leader at 14%, then the amount 17/700 right-aligned. A changed line has a second row, 14/500: "€4,000 less than today". A 12px stub joins the bar to the label. | |
| Pensions | A row only when above 0 | |
| Collisions | Rows may not be within 4px of each other. Push down in order, then clamp the last row to the bar bottom plus 8 and pull the rest back up. | |
| Width | Up to 560, centred. Beyond that the bar and labels stop growing. | |

The answer block above the sentence on a phone: swatch 14 and status word 18/600, the figure at 56/700 with "a year" at 20/500 muted beside it, the month figure at 16/500 muted. The sentence is 18/500 at 1.4 line height with a minimum height of four lines, so the drawing below never moves when a shorter sentence is shown.

### Case buttons

Real `<button>`s in a group with an accessible name, `aria-pressed`, 64px high, radius 8.

- Wide: one row of up to four at 24/600 when they fit, otherwise a 2×2 grid.
- Phone: a 2×2 grid at 15/600, label wrapping to two lines.
- Selected: a 2px blue border and a 16% blue fill, full text colour. Unselected: a 1px hairline at 16%, raised surface, muted text. **Both are the same outer size**: the padding compensates for the border, so nothing shifts on a click. The thicker border is the non-colour cue, with `aria-pressed`.

### Type and colour

Reuse the tokens in `styles/base.css`: `--bg-0` #070c10, `--bg-1` #11171c, `--text` #f7f4ee, `--muted` #a9b5bd, `--electric-blue` #6aa7c8, `--accent-green` #66b89e, `--accent-amber` #d4a64f, `--accent-red` #c96f62. Manrope. Tabular figures on every amount (`font-variant-numeric: tabular-nums`). Radius 12 on surfaces, 8 on controls. New styles go in `styles/base.css` under an `.hcf-` prefix.

Three drawing fills are new. Add them as variables, do not inline them: income `#7d8a92`, a cost `#434f58`, a changed cost `#3f7391`. The text on `#3f7391` is about 4.7:1, so check it.

- Blue marks the selected case **and** what changed against today. Both are neutral emphasis, and a changed line always carries "less" or "more" in words.
- Green means money left over, and always sits beside "Left over".
- Amber means tight and always sits beside "Tight". Red is **not used in Stage 1** (D3).
- Text is in text colours, never the series colour.

### Motion

- One clock for the module: 520ms (`CLICK_MS` in `repayment_case_module.js`), ease-out cubic, **the same acceptance rule as the repayment module**: progress clamped and timed from the first frame, a monotonic token so a stale frame cannot repaint a case the client has left, and a settle timer that is never conditional, because a starved tab never delivers its animation frames.
- What moves: the bars (position and size), the connectors and amount labels that follow them, and on a phone the segments and the labels that follow them. Nothing else moves. Ghosts, names, the baseline and the buttons stay put.
- All text changes in the same frame as the click: the status word, the figures, the sentence, the labels, the button states. Do not count figures up.
- A click while travelling starts from what is currently displayed.
- `prefers-reduced-motion: reduce` means no travel: the new case is drawn at once.
- Do not rebuild the subtree on a click. The elements the client is watching stay put. Do not use `js/scenario_motion.js`: it pairs numbers across a rebuilt subtree, and this module does not rebuild.

### Words

Plain, sentence case, euro with thousands separators, "a year" never "p.a.". It shows what is, and what each case would change, and nothing else.

Fallback case titles when the payload gives none:

| Case | Title |
|---|---|
| no changes | `Today` |
| `clearOutgoing` | `Clear the {label, lower case}` and ` from savings` when `paidFrom` is `savings` |
| `extraPension` | `Pay {€amount} more into pensions` |
| two changes | `Both` |
| three changes | `All three` |

The sentence is derived, never typed. It is one sentence: a **change clause**, then an **effect clause**.

| Case shape | Template |
|---|---|
| today | `Today, {€outgoing} of the {€income} goes out and {€left} is left over.` |
| `clearOutgoing` | `Clearing the {label} {from savings} stops {€amount} a year going out, so {effect}.` |
| `extraPension` | `Paying {€amount} more into pensions lowers tax by {€taxDelta}, so {€net} more goes out each year and {effect}.` |
| two or more changes | `{the same €left is left over as today \| effect}, but {change phrases joined with "and"}, with tax {€x} lower.` |

Effect clause by the change in shown left over against today:

| Change | Wording |
|---|---|
| no change | `the same {€left} is left over as today` |
| exactly doubled | `the amount left over doubles, from {€T} to {€N}` |
| up | `the amount left over rises by {€d}, from {€T} to {€N}` |
| down, not to zero | `the amount left over falls from {€T} to {€N}` |
| down to zero | `nothing is left over` |

The four design-fixture sentences, which are golden strings:

1. `Today, €144,000 of the €150,000 goes out and €6,000 is left over.`
2. `Clearing the car loan from savings stops €6,000 a year going out, so the amount left over doubles, from €6,000 to €12,000.`
3. `Paying €10,000 more into pensions lowers tax by €4,000, so €6,000 more goes out each year and nothing is left over.`
4. `The same €6,000 is left over as today, but the car loan is gone and €10,000 more goes into pensions each year, with tax €4,000 lower.`

The engine-fixture sentences must come out of the same templates:

1. `Today, €140,800 of the €150,000 goes out and €9,200 is left over.`
2. `Clearing the car loan from savings stops €6,000 a year going out, so the amount left over rises by €6,000, from €9,200 to €15,200.`
3. `Paying €10,000 more into pensions lowers tax by €4,000, so €6,000 more goes out each year and the amount left over falls from €9,200 to €3,200.`
4. `The same €9,200 is left over as today, but the car loan is gone and €10,000 more goes into pensions each year, with tax €4,000 lower.`

Footnote, from the model and never typed: `{€income} a year before tax. Tax is an estimate of income tax, USC and PRSI. Amounts are rounded to the nearest €100.` The tax sentence comes from the engine's disclosure for `TAX_ESTIMATE`. This is the one element not drawn in the frames: one muted line at the bottom, 18/26 on a wide screen and 14/20 on a phone.

Never: "we recommend", "you should", "best option", "best", "ideal", "optimal", or the name of any product or provider. Test it (below).

### Accessibility

- Case buttons are real `<button>`s in a group with an accessible name, with `aria-pressed`. One case, no group.
- The drawing is `role="img"` with an `aria-label` that is the status word and figure, plus the sentence. The visible labels are real text and are not read twice.
- The sentence is `aria-live="polite"`, so a presenter's click is announced once.
- Touch targets at least 44px.
- Contrast at least 4.5:1 for text, 3:1 at 24px and above.
- Colour never carries meaning alone: green sits beside "Left over", amber beside "Tight", and blue on a changed line is always matched by "less" or "more".

### Edge cases

- One person (`single`): the engine handles it. The label line is optional.
- One case: no buttons, no ghosts, no "against today" wording. The sentence is the "today" sentence.
- A line that is €0 in the selected case but not in today: kept as a column or row with "€0" and its delta.
- A line that is €0 in every case: not drawn.
- A pension column that no case uses: not a column at all.
- Left over that rounds to €0: "Tight", amber floor mark, "€0 a month".
- Amounts of €1m and over: amounts above bars and axis text go compact ("€1.2m"), and the bar labels follow the pitch rule.
- A long label (24 characters): wraps, never truncates. A long `householdLabel` wraps.
- Six outgoing lines on the narrowest wide screen (n = 10 at 832): names wrap to three lines, which is the layout test's worst case.

## Wiring

Follow the mortgage wiring, one file at a time, and resist a shared refactor in this change.

- `js/state.js`: `householdCashFlowInputs` in `createEmptyGenerated`, `normalizeGenerated` (including the mutual exclusions and the `videoSummary` clearing), and `householdCashFlowScenarioId` in `normalizeModuleUi`.
- `js/render.js`: an `isHouseholdCashFlowModule` check where `isCollegeFundingModule` is checked, and the mount, in the manner of `buildMortgageScenarioShell`. The assumptions and outputs cards still render from the engine's tables.
- `js/app.js`: selected-case get and set with persistence and the read-only guard, a Dev Panel example payload using the four sample cases, and `hasCalculatedGeneratedOutputs`.
- `js/presenter_catalogue.js`: kind (`household-cash-flow`), cases and default case, with stable ids.
- `js/video_scene.js` and `js/codex_video_brief.js`: kind, label and the selected case's figures. The video is 16:9, so it uses the staircase at 1920.
- `dev/household-cash-flow-preview.html`, in the manner of `dev/repayment-module-preview.html`, with `?cases=`, `?preset=` (the design fixture, the engine fixture, one person, six lines, a case with a pension only) and `?width=` so both drawings and the switch can be seen at any width.
- `package.json`: `check:household-cash-flow`, `scripts/check-household-cash-flow.mjs`, listed wherever `check:house-purchase` is listed, which includes `.github/workflows/consumer-regression.yml` and `deploy-worker.yml`.
- No tax rule is copied. This module imports the engine and never imports `rules_ie.js` for a number.

## Tests

Two fixtures, both proved against a reference calculator.

**Design fixture**, tax injected through the `taxFor` option (48,000 for the base and the car-loan case, 44,000 once the pension is in). This is what the frames were drawn from.

| | Today | Clear the car loan | 10,000 more into pensions | Both |
|---|---|---|---|---|
| Tax | 48,000 | 48,000 | 44,000 | 44,000 |
| Pensions | none | none | 10,000 | 10,000 |
| Car loan | 6,000 | 0 | 6,000 | 0 |
| **Left over** | **6,000** | **12,000** | **0** | **6,000** |
| A month | €500 a month | €1,000 a month | €0 a month | €500 a month |
| Status | Left over | Left over | **Tight** | Left over |

**Engine fixture**: Niamh and Dara, 45, `married_or_civil_partners`, 75,000 each in employment, calculation year 2026, with nothing injected, outgoings mortgage 30,000, car loan 6,000, living costs 48,000, children 9,000, insurance 3,000. Expected values are the table in "What the sample does in the engine". Tax is 44,817.49 and 40,817.49 unrounded.

1. **Reference calculator.** In `scripts/check-household-cash-flow.mjs`, a separate calculator that imports nothing from the module and rebuilds each case from first principles. Tax is taken from `computeTaxYear` and `marginalTax` directly. Every figure in both tables equals it, and the engine fixture's tax change for 10,000 into pensions is exactly 4,000.
2. **Invariants over every case in both fixtures.** Shown income equals the sum of shown lines plus shown left over. Levels never rise. The last level equals left over. Left over is never typed, and a payload that types it is rejected.
3. **Case 4 is not case 1.** In both fixtures, case 4's shown left over equals today's, and the staircase's left-over bar is identical, but the model reports car loan, pensions and tax as changed, ghost outlines exist for exactly those columns, and the bar's changed segments are exactly those lines. This is the design's acceptance test.
4. **No second tax.** Change a rule in a test catalogue and the module's tax follows it, which proves it holds no copy. Search `js/household_cash_flow_*.js` for tax rates and bands and find none.
5. **Rejections** with the exact messages: a stated tax line, a typed `leftOver`, a fifth case, a seventh line, duplicate ids, an unknown outgoing id in a change, a pension change twice, a case below zero, `baseScenarioId` not matching, and a `householdTaxStatus` error.
6. **Layout, in Node.** For all four cases of both fixtures at content widths 1728, 1360, 1200, 976, 848 and 832 for the staircase, and 560, 350 and 320 for the bar (a 390 phone and a 360 phone, less 20px each side): no two labels overlap, no label box is crossed by a bar or connector, every box sits inside the container, the plot height equals the formula, and bar heights are identical in every case for a given width (one scale). Type never falls below 14px for names or 16px for amounts.
7. **The switch.** At 831 exactly one drawing is in the DOM and it is the bar. At 848 it is the staircase. Across the line the selected case survives and the engine is not rerun. A jitter of 15px around 840 does not flip it.
8. **Motion discipline.** After any sequence of clicks, including a rapid one and one in a throttled tab, the drawn state equals a fresh render of the last case, and no two figures on the screen disagree. With `prefers-reduced-motion` the new case is drawn at once.
9. **Words.** Render all four cases of both fixtures and scan the visible text and every `aria-label` for the banned phrases, "p.a.", a provider name, and any amount without a thousands separator. The eight golden sentences equal their templates' output.
10. **Wiring.** Presenter case selection by id, the video scene and the codex video brief each resolve the selected case's figures. Extend `check-video-scene.mjs` and `check-codex-video-brief.mjs`.

Before finishing, run `npm run build`, `npm run check:household-cash-flow`, the Irish tax suites via `scripts/run-pension-math-tests.mjs`, `check:video-scene`, `check:codex-video-brief` and `check:consumer-session-payload`. Then open `dev/household-cash-flow-preview.html` at 1920, 1366, 1024, 844 and 390 and look at it, because the frames have not been checked in a browser either.

## Out of scope

- **The short state.** A case that leaves less than nothing needs a drawn state: a red segment, the word "Short", an overflow past income on the bar, and a floor line below zero on the staircase. Frames first, then lift the rejection (D3).
- **Stated tax.** An adviser who knows the actual tax cannot override it here (D1). If that is wanted it needs its own decision, because it breaks "no module keeps its own tax".
- **The money used to clear a loan.** "From savings" is wording only. The balance paid off, and what it does to savings, are not in the household's figures and are not shown. If a payoff amount arrives later it needs its own row and a disclosure, and it must never be added to the yearly picture.
- **More kinds of change.** Cutting a cost, changing income, a second pension, a one-off: each needs wording drawn and approved before it is built. Only the two designed changes exist.
- **More than six lines, grouping, or a long tail called "Other".**
- **A projection.** Anything beyond one year, inflation, drawdown, accounts. That is the multi-year cashflow module's brief.
- **Where the money goes after the pension.** What the contribution is worth, its tax at retirement, or its growth. The retirement module owns that.
- **Existing pension contributions in the household.** The base household takes none, so "10,000 more" means 10,000 on top of nothing. Reject `employmentPensionContribution` in `income` until a case needs it.
- **The other drawings.** The single bar at 1920, the stream, and the quarter-turned staircase for phones are not built. If a tablet in portrait needs something better than the bar, that is a new design.
- **Consumer routing, voice, planner facts, manifest, playbook and goal catalogue entries.** Follow the retirement precedent: do not edit `docs/prompt-pack/`. The playbook, aliases, matrix and master prompt are updated separately once this lands, so they describe what the code does.

## When you finish

End with a contract summary for the prompt pack: field names, the model and the two change kinds, where tax comes from and what `taxFor` is for, the rounding rule, every validation string, the derived copy templates and the width switch, plus the Dev Panel example. Keep to the repo's commit style: short plain-English commits describing what the client sees change.
