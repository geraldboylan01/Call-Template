# Household cash flow: what is left each year, and what would change it

Status: design chosen 2026-10-13 (the staircase on a wide screen, the single bar on a phone), decisions D1 to D6 settled 2026-10-13, not started. Stage 1 only.

If this file ever conflicts with another copy of it on `main`, this branch's version wins (decided 2026-10-13).

## Context

A household knows what comes in and what has to go out. The question this module answers is **after everything you pay, what is left each year, and what would change it?**

Nothing in the app answers it yet. The pension and net retirement modules work in retirement, and the personal balance sheet is a stock (what is owned), not a flow. This module is the flow for one ordinary year: income in, tax and costs out, what remains. It is a single-year picture. It is **not** the multi-year cashflow modelling module that the header of `js/planning/tax/engine.js` calls "the cashflow module to come" and `docs/irish-tax-app-change.md` describes. That one projects accounts and drawdown over decades and needs its own brief.

Three options were explored. Two were chosen, **one per kind of screen**, and both draw the same model:

- **Wide screen: the staircase** (option C). Income is a tall block at the left. Each cost steps down from it, one column each, until what is left stands on the floor at the right.
- **Phone: the single bar** (option A, drawn upright). The year is one bar of income, spent from the top down, one segment per cost, with what is left as the last piece.

The idea both must land: **a year of income being used up, and the size of what remains.** The shape has to say the same thing as the numbers, and a client must read it as a shape within three seconds, before reading a figure.

Case 4 is the test of the whole design. It leaves the same amount over as today, but the household is different: no car loan, more going into pensions, less tax. The picture must make that visible, and it is an acceptance test (see Tests).

Two readers use this module's output, not only the screen. The protection gap and goals modules will read each person's take-home pay, the total outgoings and the amount left over **in a plan**. So the engine's output carries a stable `summary` for them (see Outputs), and nothing a plan needs may exist only on the screen.

Reference frames, in the design canvas (private link: https://claude.ai/artifact/Ai8XjedaDuTFvxTc8FmFaS):

| Frame | File in the canvas | What it shows |
|---|---|---|
| `C · Steps · Today selected` | `Steps.dc.html` | Wide, 1920×1080, case 1 selected |
| `C · Steps · Both selected` | `StepsBoth.dc.html` | Wide, 1920×1080, case 4 selected |
| `Phone · Today selected` | `Phone.dc.html` | Phone, 390×1420, case 1 selected |
| `Phone · Both selected` | `PhoneBoth.dc.html` | Phone, 390×1420, case 4 selected |

The canvas also holds frames you must **not** build: the single bar and the narrowing stream at 1920 (`Main`, `BarBoth`, `Flow`, `FlowBoth`), the quarter-turned staircase for phones (`Cascade`, `CascadeBoth`) and the squeezed staircase (`Squeezed`). They were explored and set aside. The squeezed one exists to show why the staircase cannot simply shrink: nine columns in 350px means type under 12px and amounts that collide.

Five things to know before you use the frames:

- They were drawn with **design fixture figures** (tax 48,000 and 44,000), not figures from the tax engine. See "What the sample does in the engine". Their numbers are not what the module will show with engine tax.
- **Their words are superseded, and they are not being redrawn yet.** They were drawn before the voice was settled (D5) and speak about "Niamh and Dara" in the third person. They will be redrawn together with the red "short" state (D3), which is next. Until then take geometry and structure from the frames and every word from this brief, and where the two disagree the brief wins.
- They were built in the design tool and have **not been opened and checked in a browser**. Treat them as a drawing, not a reference implementation.
- They draw no footnote. One is required here (see Words), and it is the only element on screen that is not in a frame.
- Where this brief and a frame disagree, the brief wins. Say which.

It is used two ways at once. It is shared at 1920×1080 on a call while the adviser clicks between cases, and it is re-opened later by the client alone on a laptop or phone with nobody talking. Nothing may depend on spoken context.

## Decisions

| # | Decision | Settled as |
|---|---|---|
| D1 | Where tax comes from | **The Irish tax engine is the default.** A person's take-home pay may also be **stated**, and then it overrides the engine's tax for that person. The screen and the assumptions say which was used. A payslip figure beats an estimate. The change a case makes to tax is always the engine's estimate. |
| D2 | What "tight" means | **Nothing left over after rounding** (shown left over is €0). Green is anything above that. No percentage threshold. |
| D3 | A case that leaves less than nothing | **Rejected on the way in, for now.** The red "short" state is being designed. It must land **before the plan work**, because plans will read households that are short. |
| D4 | Module name | **Household cash flow**, kind `household-cash-flow`, id `household_cash_flow`. |
| D5 | Voice | **"You" in all on-screen words.** Derived wording, headings, labels, the footnote and the assumptions table speak to the household as "you" and "your". |
| D6 | Per-person take-home for a couple | **Settled: allocated by income share.** The engine assesses a couple's income tax jointly, as one figure, so per-person take-home needs an allocation rule. Each person's share is their income before tax over the household's. The output marks it `basis: 'allocated'` and the assumptions table says so. The rule is in "The model". |

## What the sample does in the engine

Checked 2026-10-13 with `scripts/ie-tax.mjs` against the engine on `main`, tax year 2026, `married_or_civil_partners`, two people aged 45, employment income only. These figures move whenever the tax rules move, which is often, so **nothing in a test may hard-code them** (see Tests):

| Income split | Income tax | USC | PRSI | Total tax |
|---|---|---|---|---|
| 75,000 / 75,000 | 34,400 | 4,061 | 6,356 | **44,817** |
| 90,000 / 60,000 | 34,400 | 4,563 | 6,356 | 45,320 |
| 120,000 / 30,000 | 35,400 | 6,063 | 6,356 | 47,820 |
| 130,000 / 20,000 | 37,400 | 6,650 | 6,356 | 50,407 |

Two things follow.

1. **The frames' 48,000 is a round design figure, not an engine result.** No split of 150,000 gives exactly 48,000.
2. **The 4,000 tax saving is exact.** A €10,000 pension contribution (`employmentPensionContribution`) lowers income tax by exactly 4,000 in every split above, whoever pays it and whether it is `joint`, because it is relieved at 40%. USC and PRSI do not move. So the frames' "tax falls to 44,000" is right in size, and the engine will produce it.

With tax from the engine and a 75,000 / 75,000 household, the four cases are:

| | Today | Clear the car loan | 10,000 more into pensions | Both |
|---|---|---|---|---|
| Tax (shown, to €100) | 44,800 | 44,800 | 40,800 | 40,800 |
| Pensions | none | none | 10,000 | 10,000 |
| Car loan | 6,000 | 0 | 6,000 | 0 |
| **Left over** | **9,200** | **15,200** | **3,200** | **9,200** |
| A month | About €770 | About €1,270 | About €270 | About €770 |

Case 4 still equals today, which is the point of the design. But **case 3 is no longer "nothing left over"**, so the amber "tight" state does not appear in the engine-derived demo. Both fixtures are required in Tests: the design fixture reproduces the frames' figures exactly (including amber), and the engine fixture is what a client would see.

A stated take-home changes this. If Niamh's payslips say her take-home is 50,000 a year and Dara's is left to the engine, tax is 25,000 for Niamh and about 22,409 for Dara, so 47,409 in all (shown 47,400), and today's left over is 6,600 rather than 9,200. A payslip can differ a lot from the estimate, so "which was used" is not a footnote detail.

## Defaults assumed

1. **Release surface.** Adviser-only through the Dev Panel, the presenter and the published session viewer. `consumer: false`, as the pension and mortgage modules were. No consumer routing, no voice, no planner facts. The plan adapter is a later change (see Out of scope).
2. **One ordinary year.** Every amount is per year, in today's money. No growth, no inflation, no projection. "Each year" means a typical year.
3. **Pension money is not spent.** The picture treats a pension contribution as leaving the household's spending money, which is what the case is about. The wording is "goes out" and "goes into your pensions", never "lost" or "spent". The assumptions table says what the left-over figure is: income after tax, pension contributions and the stated costs.
4. **Rounding on screen.** Every amount to the nearest €100, from unrounded values. Rules in the contract.
5. **No rates and no tax lines in the payload.** The payload carries income, stated costs and, optionally, a person's take-home. Tax rules come from the engine, so every module and adviser reads the same number.
6. **Take-home means before the pension contribution a case adds.** Take-home is income minus tax (income tax, USC and PRSI). A case's extra pension contribution is its own line after that, so take-home never changes by the contribution itself, only by the tax it saves.

## Before you write code

- Pull `main` and create a new branch from it for the work, for example `household-cash-flow`. This brief lives on `module/household-cash-flow`.
- Read `js/repayment_case_module.js` end to end. It is the closest precedent and this module should feel like its sibling: same clock, same settling discipline, same `build...Module({ rawInputs, selectedCaseId, onSelectCase })` shape, same standalone dev preview (`dev/repayment-module-preview.html`). Then read the commit message of `1d0e895` for the acceptance rule on motion.
- Read `js/planning/tax/engine.js` (the header, `computeTaxYear`, `marginalTax`), `docs/irish-tax-app-change.md` sections 3.2 and 3.4, and `docs/irish-tax-handback.md`. Run `node scripts/ie-tax.mjs year` on a household by hand before you write any code, and **print `result.assessments` and `result.people`**: under joint assessment income tax is one figure for the couple, while USC and PRSI are per person. The allocation in "The model" exists because of that.
- Read how `js/pension_math.js` builds its tax input and people (about line 1132, and the `householdTaxStatus` errors at about 1707), how it calls `marginalTax` (about 1491) and how it renders disclosures with `renderTaxDisclosures` (about 3156). This module does the same things and must not differ.
- Read `js/planning/adapters/common.js` (`createModuleRunResult`) and `js/planning/adapters/retirement.js`. They show how a plan reads a module's result, which is why `summary` is shaped as it is. Do not write the adapter in this change.
- Read `js/scenario_cap.js`, `js/presenter_catalogue.js` (`moduleKind`, `scenarios`), `js/video_scene.js` (`getVideoModuleKind`), `js/codex_video_brief.js`, `js/state.js` (`normalizeGenerated`, `normalizeModuleUi`, `mortgageScenarioId`) and `js/render.js` (`buildMortgageScenarioShell`), plus `setMortgageScenarioForModule` in `js/app.js`, because a module the presenter cannot select a case in, or the video cannot describe, is half a module.
- Read `docs/future-cost-fund-app-change.md`. It is a sibling brief with the same wiring and the same discipline (a pure layout function, one motion clock, two fixtures). If it has landed, copy its wiring. If it has not, expect both changes to touch `presenter_catalogue.js`, `state.js`, `render.js` and `app.js`, and land one first.
- Then give a short plan: final field names, the file list, how the selected case is persisted, where the pure layout function sits, how the width switch is measured, and where the per-person allocation lives. **Wait for the go-ahead before implementing.**

## The contract

Add `generated.householdCashFlowInputs`. Engine in `js/household_cash_flow_math.js`, renderer in `js/household_cash_flow_module.js`, tests in `js/tests_household_cash_flow_math.js`.

### Inputs

| Field | Type | Rule |
|---|---|---|
| `householdTaxStatus` | string, optional | `single`, `married_or_civil_partners` or `widowed_or_surviving_civil_partner`. Same values, same errors and same disclosure behaviour as `pensionInputs`. Not given: each person is assessed as single, disclosed. |
| `people` | array, required | 1 to 2 of `{ id, age, label?, statedTakeHome? }`. See below. |
| `income` | array, required | 1 to 6 of `{ personId, type, amount }`. `personId` is a person id or `joint` (split equally, as in the engine). `type` is any Phase 1 income type of `computeTaxYear` **except** `employmentPensionContribution`, which only a case change can produce. `amount` greater than 0, per year, before tax. |
| `outgoings` | array, required | 1 to 6 of `{ id, label, amount }`. Stated, per year, 0 or more. `id` unique and stable, `[a-z0-9_]`. `label` client-facing, 1 to 24 characters, sentence case, a noun phrase ("Mortgage", "Living costs"), never third person. Drawn in the order given. |
| `calculationYear` | integer, optional | The tax year. Default: whatever year `pensionInputs` uses as `currentYear`. |
| `baseScenarioId` | string, optional | Must match a case id when present. Default is the first case. |
| `scenarios` | array, required | 1 to `MAX_MODULE_SCENARIO_CASES` (4) cases, from `js/scenario_cap.js`, base included. |

`people[]`:

| Field | Rule |
|---|---|
| `id` | Unique, `[a-z0-9_-]`. Opaque and stable: a plan adapter will map profile person ids onto it, and it is carried unchanged into `summary`. |
| `age` | Integer, 16 to 110. |
| `label` | Client-facing first name, 1 to 40 characters. **Required when there are two people**, because the screen must say which person's take-home was used. Optional for one. |
| `statedTakeHome` | Optional number, per year, **after income tax, USC and PRSI and before any pension contribution a case adds** (so it is a payslip figure for someone who pays no extra pension). Greater than 0 and less than that person's income before tax. When present it replaces the estimate for that person's tax (see The model). |

A line that is €0 in every case is not drawn. More than 6 outgoing lines is rejected rather than grouped: the staircase gets one column per line, and the adviser decides what to combine.

There is **no tax line and no left-over field.** A payload that states either is rejected (see Validation). Tax is estimated or derived from the stated take-home, and left over is `income − everything out`, so neither can disagree with the rest. There is no `householdLabel`: the screen does not name the household (see Words).

Each case:

| Field | Type | Rule |
|---|---|---|
| `id` | string, required | Unique. Stable, because the presenter selects cases by id. |
| `title` | string, optional | Client-facing button name, up to 40 characters, in the second person. Absent: derived (see Words). |
| `description` | string, optional | One sentence, for the presenter. |
| `changes` | array, optional | 0 to 3 of the two kinds below. The base case has none. |

The two changes that have been designed, and therefore the only two that exist in Stage 1:

| `type` | Fields | Meaning |
|---|---|---|
| `clearOutgoing` | `outgoingId`, `paidFrom?` (`'savings'`) | That line becomes 0. `paidFrom` only changes the wording. |
| `extraPension` | `amount` (> 0), `personId?` (default `joint`) | `amount` more is paid into a personal pension. Becomes an `employmentPensionContribution` item. At most one per case. |

That gives the four sample cases exactly: no changes; `clearOutgoing: car`; `extraPension: 10000`; both. A case states *what changes*, never *what the result is*. The engine solves the amounts.

### The model

- `computeHouseholdCashFlowProjection(rawInputs, { taxFor, calculationYear } = {})`. By default each case is run through `computeTaxYear` with the payload's income, plus one `employmentPensionContribution` item for an `extraPension`, recurring tax only and no lump sums. The `taxFor` option exists so tests can inject the design fixture: it returns each person's tax for a case (24,000 each for the base, 22,000 each with the pension in). It is never reachable from a payload.
- **Each person's estimated tax** is their own USC and their own PRSI from `result.people[]`, plus a share of income tax.
  - **Separately assessed** (a `single` status, or one person): that person's own income tax.
  - **Jointly assessed** (D6): the household income tax is one figure. In the base case each person's share is their income before tax over the household's. A case's **change** in household income tax against the base goes to whoever pays the contribution, split by amount, so a `joint` contribution splits it equally. Nothing else moves.
- **Each person's tax in a case:**
  - Nothing stated: the estimate above.
  - `statedTakeHome` given: `incomeBeforeTax − statedTakeHome` in the base case, **plus the engine's estimated change** for that person in the case. The stated figure sets the level and the engine supplies only the change, because a payslip cannot know what a pension contribution would save.
- `taxTotal` is the sum of the people's tax. With nothing stated it equals the engine's `totals.recurringTax` for that case, to the cent.
- **`takeHome` for a person** is `incomeBeforeTax − tax`. The household's is the sum. A pension contribution is not subtracted here.
- `pensionContributions` is the sum of `extraPension` amounts. It is its own line, after tax.
- `statedTotal` is the sum of the stated outgoing lines, with cleared lines at 0.
- `totalOutgoings = taxTotal + pensionContributions + statedTotal`, and `leftOver = income − totalOutgoings`, both unrounded. Equivalently `leftOver = takeHomeTotal − pensionContributions − statedTotal`, and a test asserts it.
- Levels, for the staircase and the bar: `level₀ = income`, then each line in order subtracts from the one before: tax, pensions, then the stated lines in the order given. The last level is `leftOver`.
- The case with `id === baseScenarioId` is "today". Every `deltaVsToday` on screen is measured against it.

### Rounding

- Show every line to the nearest €100, rounded independently from unrounded values.
- **Shown left over is always shown income minus the sum of the shown lines**, never rounded on its own, so the picture always adds up.
- The month figure is shown left over ÷ 12, to the nearest €10. It is prefixed "About" unless it is exact (500, 1,000, 0).
- Do not "fix" a column by nudging a block.
- `summary` carries unrounded values and, where the screen shows one, the shown value beside it (see Outputs). A plan reads the unrounded figure.

### Outputs

`computeHouseholdCashFlowProjection(rawInputs)` follows the college engine's shape: `assumptionsTable`, `outputsTable` (one row per case), `tables` (the lines for each case), `charts`, `debug`, **and `summary`**.

**`summary` is the contract a plan reads.** It is plain JSON, not under `debug`, and its names are stable once shipped, because the protection gap and goals modules will depend on them. A plan adapter later maps it into a `semanticResult`. This change writes `summary` and not the adapter.

```
summary: {
  calculationYear, baseCaseId, period: 'year', currency: 'EUR',
  taxStatus, taxStatusDefaulted,
  cases: [{
    id, title,
    income:   { total, byPerson: [{ personId, gross }] },
    takeHome: { total,
                byPerson: [{ personId, gross, tax, takeHome,
                             taxSource,            // 'stated' | 'estimated'
                             basis,                // 'own' | 'allocated'
                             estimatedTakeHome }]  // what the engine says, for comparison
              },
    outgoings: { tax, pensionContributions,
                 stated: [{ id, label, amount }], statedTotal,
                 total },                          // tax + pensionContributions + statedTotal
    leftOver: { amount, shown, monthly, status }   // status: 'left_over' | 'tight' | 'short'
  }]
}
```

- **Take-home per person, total outgoings and left over are the three things plans need**, and they are `takeHome.byPerson[]`, `outgoings.total` and `leftOver.amount`.
- `basis` is `allocated` for a person in a jointly assessed couple and `own` otherwise (D6). A reader must not treat an allocated figure as a payslip.
- `status` is `short` in the type and **unreachable in Stage 1**, because such a case is rejected (D3). A plan reader must still handle it, so say so in the contract summary.
- Every figure is per year. A reader divides by 12.
- Invariants a test asserts for every case: the people's `takeHome` sum to `takeHome.total`; the people's `tax` sum to `outgoings.tax`; `takeHome.total − pensionContributions − statedTotal = leftOver.amount`; `income.total − outgoings.total = leftOver.amount`.

Also:

- `debug.cases[]`: `id`, `title`, `description`, `changes`, `lines[]` (`{ id, label, amount, shownAmount, deltaVsToday }`), `levels[]`, `sentence`, `taxBreakdown` (`incomeTax`, `usc`, `prsi`, per person where jointly assessed the income tax is the allocated share) and `disclosureCodes`.
- `debug.assumptionsUsed`: `IE_TAX_RULES_VERSION` read at run time, the tax year, `PLANEIR_ASSUMPTIONS_VERSION`, the household tax status and whether it was defaulted, and `taxSourceByPerson`.
- `debug.warnings[]`: a stated take-home that differs from the estimate by more than 15%. A warning, never a rejection, because a payslip is allowed to differ.
- The assumptions table states, in plain words and in the second person: per-year figures in today's money; **which tax was used for each person** (the disclosure line, below); pension contributions are shown after tax relief; for a couple, income tax is assessed together, so each person's share is an allocation by income share and their take-home is marked `allocated` (D6); and amounts are rounded to the nearest €100. Use the engine's own disclosure text (`renderTaxDisclosures`) for the estimated parts and do not write tax sentences of your own.
- `charts` carries **one** ordinary chart (the base case's lines in order, income at the left) for the surfaces with no module to draw for them, chiefly the video summary. This is what `repayment_case_module.js` does. The focused pane shows no charts card for this module.
- `getHouseholdCashFlowCases(rawInputs)` returns `[{ id, title, description }]` for the presenter, like `getMortgageScenarioCases`.

The disclosure line saying which tax was used is derived, never typed, one per person, and appears in the assumptions table and, summarised, in the footnote (see Words):

| Person | Line |
|---|---|
| stated | `Your tax for {label} uses the take-home pay you gave, {€statedTakeHome} a year. The change each case makes to it is an estimate.` |
| estimated | `Your tax for {label} is an estimate of income tax, USC and PRSI.` |
| one person, stated | `Your tax uses the take-home pay you gave, {€statedTakeHome} a year. The change each case makes to it is an estimate.` |
| one person, estimated | `Your tax is an estimate of income tax, USC and PRSI.` |

### Validation

Messages follow the existing style and name the field and the case:

- `generated.householdCashFlowInputs.scenarios supports at most 4 cases; received 5.`
- `generated.householdCashFlowInputs.outgoings supports at most 6 lines; received 7.`
- `generated.householdCashFlowInputs.outgoings[0] (Tax): tax is calculated from income by the Irish tax engine and cannot be stated as a cost. Give a person's take-home in people[].statedTakeHome instead.` Reject any outgoing whose id or label is `tax` (case-insensitive).
- `generated.householdCashFlowInputs.leftOver is not accepted. It is calculated.`
- `generated.householdCashFlowInputs.people[0] (Niamh): statedTakeHome (€80,000) must be less than income before tax (€75,000).`
- `generated.householdCashFlowInputs.people[1] needs a label when there are two people.`
- `generated.householdCashFlowInputs.scenarios[2] (Pay €10,000 more into your pensions): leaves €1,200 less than nothing each year, which this screen does not draw yet.` (D3)
- `generated.householdCashFlowInputs.scenarios[1] (Clear your car loan): outgoingId "car" is not one of the outgoings.`
- Also: duplicate case id, outgoing id or person id, unknown case, person or change key, `baseScenarioId` not matching, a line cleared twice, more than one `extraPension`, an unknown `personId`, `householdTaxStatus` errors worded as `pensionInputs` words them, an `income` item of type `employmentPensionContribution`, and a `statedTakeHome` for a person who has no income.
- The session importer in `js/state.js` treats `scenarios` like the other capped arrays: tolerate on the way in, cap with an import warning, never throw.
- `householdCashFlowInputs` is mutually exclusive with the other engine keys in `normalizeGenerated`, handled exactly as `collegeFundingInputs` is, and is cleared by a `videoSummary`.

## On screen

### What is on it

One element carries the screen: the staircase on a wide screen, the bar on a phone. Everything else is quiet. In reading order:

1. One muted line, "Your household cash flow", then the question as the heading: "After everything you pay, what is left each year?" Both are fixed copy, not payload fields.
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

The income column's name is "Your income before tax". Type scales with the pitch: `fs = clamp(pitch ÷ 156, 0.62, 1)`. Amounts `max(16, 28 × fs)`, names `max(14, 22 × fs)`, delta `max(13, 20 × fs)`. At 832 content width the pitch is 96 and `fs` is 0.62.

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
| Header row | "Your income before tax" muted at 15/500 on the left, "€150,000 a year" at 17/700 on the right, hairline at 18% below it, then 20px, then the bar | |
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
- Amber means tight and always sits beside "Tight". Red is **not used in Stage 1** (D3); the short state is being designed and lands before the plan work.
- Text is in text colours, never the series colour.

### Motion

- One clock for the module: 520ms (`CLICK_MS` in `repayment_case_module.js`), ease-out cubic, **the same acceptance rule as the repayment module**: progress clamped and timed from the first frame, a monotonic token so a stale frame cannot repaint a case the client has left, and a settle timer that is never conditional, because a starved tab never delivers its animation frames.
- What moves: the bars (position and size), the connectors and amount labels that follow them, and on a phone the segments and the labels that follow them. Nothing else moves. Ghosts, names, the baseline and the buttons stay put.
- All text changes in the same frame as the click: the status word, the figures, the sentence, the labels, the button states. Do not count figures up.
- A click while travelling starts from what is currently displayed.
- `prefers-reduced-motion: reduce` means no travel: the new case is drawn at once.
- Do not rebuild the subtree on a click. The elements the client is watching stay put. Do not use `js/scenario_motion.js`: it pairs numbers across a rebuilt subtree, and this module does not rebuild.

### Words

**Everything on screen speaks to the household as "you" and "your" (D5).** That covers derived wording, the heading, labels, button titles, the footnote and the assumptions table. A label is a noun phrase an adviser writes ("Mortgage", "Living costs") and never says "the household", "the couple", "the client", "they" or "their". A person's first name appears on screen **only** where two people must be told apart, which is the tax-source line. The engine's own disclosure text is already written to "you" (`js/planning/tax/disclosures.js`). If any of it is not, that is a change to a file other modules share: report it, do not paraphrase it here.

Plain, sentence case, euro with thousands separators, "a year" never "p.a.". It shows what is, and what each case would change, and nothing else.

Fixed copy: muted line `Your household cash flow`, heading `After everything you pay, what is left each year?`, income label `Your income before tax`, statuses `Left over` and `Tight`.

Fallback case titles when the payload gives none:

| Case | Title |
|---|---|
| no changes | `Today` |
| `clearOutgoing` | `Clear your {label, lower case}` and ` from savings` when `paidFrom` is `savings` |
| `extraPension` | `Pay {€amount} more into your pensions` |
| two changes | `Both` |
| three changes | `All three` |

The sentence is derived, never typed. It is one sentence: a **change clause**, then an **effect clause**.

| Case shape | Template |
|---|---|
| today | `Today, {€outgoing} of your {€income} goes out and you have {€left} left over.` |
| `clearOutgoing` | `Clearing your {label, lower case} {from savings} stops {€amount} a year going out, so {effect}.` |
| `extraPension` | `Paying {€amount} more into your pensions lowers your tax by {€taxDelta}, so {€net} more goes out each year and {effect}.` |
| two or more changes | `{effect, first letter capitalised}, but {change phrases joined with "and"}, with your tax {€x} lower.` |

Change phrases for two or more changes: `your {label, lower case} is gone` and `{€amount} more goes into your pensions each year`. If tax goes up instead of down the clause says "higher", and if it does not move the clause is omitted.

Effect clause by the change in shown left over against today:

| Change | Wording |
|---|---|
| no change | `you have the same {€left} left over as today` |
| exactly doubled | `the amount you have left over doubles, from {€T} to {€N}` |
| up | `the amount you have left over rises by {€d}, from {€T} to {€N}` |
| down, not to zero | `the amount you have left over falls from {€T} to {€N}` |
| down to zero | `you have nothing left over` |

The four design-fixture sentences, which are golden strings:

1. `Today, €144,000 of your €150,000 goes out and you have €6,000 left over.`
2. `Clearing your car loan from savings stops €6,000 a year going out, so the amount you have left over doubles, from €6,000 to €12,000.`
3. `Paying €10,000 more into your pensions lowers your tax by €4,000, so €6,000 more goes out each year and you have nothing left over.`
4. `You have the same €6,000 left over as today, but your car loan is gone and €10,000 more goes into your pensions each year, with your tax €4,000 lower.`

The engine-fixture sentences must come out of the same templates (figures as in "What the sample does in the engine", which the reference calculator recomputes):

1. `Today, €140,800 of your €150,000 goes out and you have €9,200 left over.`
2. `Clearing your car loan from savings stops €6,000 a year going out, so the amount you have left over rises by €6,000, from €9,200 to €15,200.`
3. `Paying €10,000 more into your pensions lowers your tax by €4,000, so €6,000 more goes out each year and the amount you have left over falls from €9,200 to €3,200.`
4. `You have the same €9,200 left over as today, but your car loan is gone and €10,000 more goes into your pensions each year, with your tax €4,000 lower.`

Footnote, from the model and never typed: `Your income before tax is {€income} a year. {tax-source sentence} Amounts are rounded to the nearest €100.` The tax-source sentence is the disclosure line from Outputs: with everything estimated, `Your tax is an estimate of income tax, USC and PRSI.`; with everything stated, `Your tax uses the take-home pay you gave. The change each case makes to it is an estimate.`; mixed, `Your tax uses the take-home pay you gave for {label} and an estimate for {label}. The change each case makes to it is an estimate.` This is the one element not drawn in the frames: one muted line at the bottom, 18/26 on a wide screen and 14/20 on a phone.

Never: "we recommend", "you should", "best option", "best", "ideal", "optimal", or the name of any product or provider. Test it (below).

### Accessibility

- Case buttons are real `<button>`s in a group with an accessible name, with `aria-pressed`. One case, no group.
- The drawing is `role="img"` with an `aria-label` that is the status word and figure, plus the sentence. The visible labels are real text and are not read twice.
- The sentence is `aria-live="polite"`, so a presenter's click is announced once.
- Touch targets at least 44px.
- Contrast at least 4.5:1 for text, 3:1 at 24px and above.
- Colour never carries meaning alone: green sits beside "Left over", amber beside "Tight", and blue on a changed line is always matched by "less" or "more".

### Edge cases

- One person (`single`): the engine handles it and `basis` is `own`. `label` is optional and the tax-source line has no name.
- Two people, one stated and one estimated: mixed tax-source sentence, and the stated person's tax is the payslip level plus the engine's change.
- Both stated: household tax is `income − the two take-homes`, and a case's change is still the engine's.
- A stated take-home far from the estimate: a `debug.warnings` entry, no rejection, and the screen still says which was used.
- One case: no buttons, no ghosts, no "against today" wording. The sentence is the "today" sentence.
- A line that is €0 in the selected case but not in today: kept as a column or row with "€0" and its delta.
- A line that is €0 in every case: not drawn.
- A pension column that no case uses: not a column at all.
- Left over that rounds to €0: "Tight", amber floor mark, "€0 a month".
- Amounts of €1m and over: amounts above bars and axis text go compact ("€1.2m"), and the bar labels follow the pitch rule.
- A long label (24 characters): wraps, never truncates.
- Six outgoing lines on the narrowest wide screen (n = 10 at 832): names wrap to three lines, which is the layout test's worst case.

## Wiring

Follow the mortgage wiring, one file at a time, and resist a shared refactor in this change.

- `js/state.js`: `householdCashFlowInputs` in `createEmptyGenerated`, `normalizeGenerated` (including the mutual exclusions and the `videoSummary` clearing), and `householdCashFlowScenarioId` in `normalizeModuleUi`.
- `js/render.js`: an `isHouseholdCashFlowModule` check where `isCollegeFundingModule` is checked, and the mount, in the manner of `buildMortgageScenarioShell`. The assumptions and outputs cards still render from the engine's tables.
- `js/app.js`: selected-case get and set with persistence and the read-only guard, a Dev Panel example payload using the four sample cases (with one person's `statedTakeHome` in a second example), and `hasCalculatedGeneratedOutputs`.
- `js/presenter_catalogue.js`: kind (`household-cash-flow`), cases and default case, with stable ids.
- `js/video_scene.js` and `js/codex_video_brief.js`: kind, label and the selected case's figures. The video is 16:9, so it uses the staircase at 1920.
- `dev/household-cash-flow-preview.html`, in the manner of `dev/repayment-module-preview.html`, with `?cases=`, `?preset=` (the design fixture, the engine fixture, one person, one stated and one estimated, both stated, six lines, a case with a pension only) and `?width=` so both drawings and the switch can be seen at any width.
- `package.json`: `check:household-cash-flow`, `scripts/check-household-cash-flow.mjs`, listed wherever `check:house-purchase` is listed, which includes `.github/workflows/consumer-regression.yml` and `deploy-worker.yml`.
- No tax rule is copied. This module imports the engine and never imports `rules_ie.js` for a number.

## Tests

Two fixtures, both proved against a reference calculator.

**Design fixture**, tax injected through the `taxFor` option (24,000 each for the base and the car-loan case, 22,000 each once the pension is in). This is what the frames were drawn from.

| | Today | Clear the car loan | 10,000 more into pensions | Both |
|---|---|---|---|---|
| Tax | 48,000 | 48,000 | 44,000 | 44,000 |
| Pensions | none | none | 10,000 | 10,000 |
| Car loan | 6,000 | 0 | 6,000 | 0 |
| **Left over** | **6,000** | **12,000** | **0** | **6,000** |
| A month | €500 a month | €1,000 a month | €0 a month | €500 a month |
| Status | Left over | Left over | **Tight** | Left over |

**Engine fixture**: Niamh and Dara, 45, `married_or_civil_partners`, 75,000 each in employment, calculation year 2026, with nothing injected, outgoings mortgage 30,000, car loan 6,000, living costs 48,000, children 9,000, insurance 3,000. **Do not hard-code the tax figures.** The reference calculator derives them from `computeTaxYear` and `marginalTax` at test time, so a rules change does not break the suite, and the table in "What the sample does in the engine" is an illustration of 2026-10-13 only.

**Stated fixture**: the engine fixture with Niamh's `statedTakeHome` at 50,000 and Dara's left to the engine.

1. **Reference calculator.** In `scripts/check-household-cash-flow.mjs`, a separate calculator that imports nothing from the module and rebuilds each case from first principles. Tax comes from `computeTaxYear` and `marginalTax` directly. Every figure in the fixtures equals it, to the cent.
2. **Invariants over every case in every fixture.** The `summary` invariants in Outputs. Shown income equals the sum of shown lines plus shown left over. Levels never rise. The last level equals left over. A payload that types a left-over figure is rejected.
3. **Stated take-home.**
   - The stated person's base-case tax is `gross − statedTakeHome` exactly.
   - Their change in a case equals the change the engine estimates for that person from the same contribution, to the cent. The stated figure sets the level and never the change.
   - With nothing stated, household tax equals the engine's `totals.recurringTax`.
   - The disclosure line for each person says `stated` or `estimated` correctly, and the footnote's tax-source sentence agrees with the lines.
   - A stated figure at or above that person's gross is rejected with the exact message.
4. **Allocation (D6).** For jointly assessed couples at several income splits, the two people's tax sums to the household's, `basis` is `allocated`, and a contribution by one person moves only that person's tax. For `single` with two people, `basis` is `own` and each figure is the engine's own for that person.
5. **Case 4 is not case 1.** In every fixture, case 4's shown left over equals today's, and the staircase's left-over bar is identical, but the model reports car loan, pensions and tax as changed, ghost outlines exist for exactly those columns, and the bar's changed segments are exactly those lines. This is the design's acceptance test.
6. **No second tax.** Change a rule in a test catalogue and the module's tax follows it, which proves it holds no copy. Search `js/household_cash_flow_*.js` for tax rates and bands and find none.
7. **Rejections** with the exact messages: a stated tax line, a typed `leftOver`, a fifth case, a seventh line, duplicate ids, an unknown outgoing id in a change, a pension change twice, a case below zero, `baseScenarioId` not matching, a missing label for two people, and a `householdTaxStatus` error.
8. **Layout, in Node.** For all four cases of every fixture at content widths 1728, 1360, 1200, 976, 848 and 832 for the staircase, and 560, 350 and 320 for the bar (a 390 phone and a 360 phone, less 20px each side): no two labels overlap, no label box is crossed by a bar or connector, every box sits inside the container, the plot height equals the formula, and bar heights are identical in every case for a given width (one scale). Type never falls below 14px for names or 16px for amounts.
9. **The switch.** At 831 exactly one drawing is in the DOM and it is the bar. At 848 it is the staircase. Across the line the selected case survives and the engine is not rerun. A jitter of 15px around 840 does not flip it.
10. **Motion discipline.** After any sequence of clicks, including a rapid one and one in a throttled tab, the drawn state equals a fresh render of the last case, and no two figures on the screen disagree. With `prefers-reduced-motion` the new case is drawn at once.
11. **Words.** Render all four cases of every fixture and scan the visible text and every `aria-label` for the banned phrases, "p.a.", a provider name, any amount without a thousands separator, and **third person**: "the household", "the couple", "the client", "they", "their". The only first names on screen are in the tax-source line, and only with two people. The eight golden sentences equal their templates' output.
12. **Wiring.** Presenter case selection by id, the video scene and the codex video brief each resolve the selected case's figures. Extend `check-video-scene.mjs` and `check-codex-video-brief.mjs`.

Before finishing, run `npm run build`, `npm run check:household-cash-flow`, the Irish tax suites via `scripts/run-pension-math-tests.mjs`, `check:video-scene`, `check:codex-video-brief` and `check:consumer-session-payload`. Then open `dev/household-cash-flow-preview.html` at 1920, 1366, 1024, 844 and 390 and look at it, because the frames have not been checked in a browser either.

## Out of scope

- **The short state, and lifting the D3 rejection.** A case that leaves less than nothing needs a drawn state: a red segment, the word "Short", an overflow past income on the bar, and a floor line below zero on the staircase. The design is under way. It is a separate change and **must land before the plan work**, because the protection gap and goals modules will read households that are short. Until then `status: 'short'` exists in the type and is unreachable.
- **Redrawing the frames.** They are redrawn with the short state, in the second person. That is a design task, not a build one, and the build does not wait for it: this brief wins until it is done.
- **The plan adapter.** `js/planning/adapters/household_cash_flow.js`, the module registry and manifest entries, routing, goal catalogue entries and anything that makes a plan call this module. `summary` is its input and is written here. Stated take-home arriving from a profile's income facts is the adapter's job.
- **The money used to clear a loan.** "From savings" is wording only. The balance paid off, and what it does to savings, are not in the household's figures and are not shown. If a payoff amount arrives later it needs its own row and a disclosure, and it must never be added to the yearly picture.
- **More kinds of change.** Cutting a cost, changing income, a second pension, a one-off: each needs wording drawn and approved before it is built. Only the two designed changes exist.
- **More than six lines, grouping, or a long tail called "Other".**
- **A projection.** Anything beyond one year, inflation, drawdown, accounts. That is the multi-year cashflow module's brief.
- **Where the money goes after the pension.** What the contribution is worth, its tax at retirement, or its growth. The retirement module owns that.
- **Existing pension contributions in the household.** The base household takes none, so "10,000 more" means 10,000 on top of nothing, and a stated take-home must be one that has none deducted. Reject `employmentPensionContribution` in `income` until a case needs it.
- **A stated take-home that varies by month, or a bonus.** One figure a year per person.
- **The other drawings.** The single bar at 1920, the stream, and the quarter-turned staircase for phones are not built. If a tablet in portrait needs something better than the bar, that is a new design.
- **Consumer routing, voice, planner facts, manifest, playbook and goal catalogue entries.** Follow the retirement precedent: do not edit `docs/prompt-pack/`. The playbook, aliases, matrix and master prompt are updated separately once this lands, so they describe what the code does.

## When you finish

End with a contract summary for the prompt pack: field names, the model and the two change kinds, where tax comes from and what a stated take-home does, the allocation convention for couples, the `summary` shape and its invariants, the rounding rule, every validation string, the derived copy templates (in the second person) and the width switch, plus the Dev Panel examples. Keep to the repo's commit style: short plain-English commits describing what the client sees change.
