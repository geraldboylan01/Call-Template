# Household cash flow: what is left each year, and what would change it

Status: design chosen 2026-10-13 (the staircase on a wide screen, the single bar on a phone), decisions D1 to D6 settled 2026-10-13 and D7 the same evening, built. Stage 1 only.

If this file ever conflicts with another copy of it on `main`, this branch's version wins (decided 2026-10-13).

## Build status

Everything in Stage 1 is built, in two changes on `module/household-cash-flow`: the engine, then the screen and the wiring. The shortfall (D3) is built as its own change on `household-cash-flow-short`, described in "The short state" below, and today's pension contributions are the one follow-up still to come.

- `js/household_cash_flow_math.js`: the engine, with `summary` for the plan. `js/household_cash_flow_view.js`: the words, the width switch and the geometry for both drawings, with no DOM so they are checked in Node. `js/household_cash_flow_module.js`: the drawing, its own 520ms clock and `presenterSelectScenario`.
- State, paste pipeline, render, app, presenter catalogue, video scene and codex brief wiring, two Dev Panel examples, `dev/household-cash-flow-preview.html`, the `.hcf-` styles and the CI listing. The wiring followed "Wiring a new engine module" in `docs/future-cost-fund-app-change.md`, not this brief's own first list below.
- `npm run check:household-cash-flow` runs the engine against its reference calculator and the engine, view, module and wiring suites. The video scene and codex brief are proved in `check-video-scene.mjs` and `check-codex-video-brief.mjs`.
- The module was looked at in a browser at 1920 and at 390, through the preview page. It has not been looked at on a real phone.

Differences from this brief as first written:

- **Type floors.** The staircase's type follows the column down to the floors (16 for amounts, 14 for names, 13 for the delta line), with no lower clamp on the scale, so ten columns still fit their amounts at 848.
- **The width is measured by a probe.** A zero-height strip as wide as the module's content box, because beside the answer the chart is only part of the content. The module keeps 28px of side padding, for an amount centred on a bar to reach a little past the plot.
- **Today's label.** It is two lines at a wide pitch and three at a narrow one ("Today", "€9,200", "left over").
- **A short case was refused in three places**, not one: the engine, the paste pipeline (which projects the payload before applying it) and the session importer (which drops it with a warning). The short-state change lifted all three together, and nothing refuses a short case now.
- **Normalised inputs write back `householdTaxStatus` and `mappedFromJoint`**, so a saved payload normalises to itself. The test that proves it covers a status, no status, a stated take-home and a one-person household.
- **Not built, as agreed:** the hover read-off (`attachScrub`), the plan adapter, and today's pension contributions.

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
| `Short · €20,000 more into your pensions selected` | `ShortWide.dc.html` | Wide, 1920×1080, a left over year tipped under: the steps run past the floor |
| `Short · Today short (living costs €60,000)` | `TodayShortWide.dc.html` | Wide, 1920×1080, today itself short, with the outlines of today as a fixed reference |
| `Short on a phone · €20,000 more into your pensions selected` | `ShortPhone.dc.html` | Phone, 390×1480, the costs run past the end of income |
| `Short on a phone · Today short (living costs €60,000)` | `TodayShortPhone.dc.html` | Phone, 390×1480, today short |

The canvas also holds frames you must **not** build: the single bar and the narrowing stream at 1920 (`Main`, `BarBoth`, `Flow`, `FlowBoth`), the quarter-turned staircase for phones (`Cascade`, `CascadeBoth`) and the squeezed staircase (`Squeezed`). They were explored and set aside. The squeezed one exists to show why the staircase cannot simply shrink: nine columns in 350px means type under 12px and amounts that collide.

Five things to know before you use the frames:

- They were first drawn with **design fixture figures** (tax 48,000 and 44,000), not figures from the tax engine. See "What the sample does in the engine". The staircase and phone frames were later redrawn with engine figures (tax 44,800 and 40,800 at the rules of 10 October), in the second person, together with the short frames. The golden strings in the tests keep the design fixture, because it is injected and the rules cannot move it.
- **Their words.** The first frames were drawn before the voice was settled (D5) and speak about "Niamh and Dara" in the third person. The redrawn ones speak in the second person. Where a frame and this brief disagree on a word, the brief wins.
- They were built in the design tool and have **not been opened and checked in a browser**. Treat them as a drawing, not a reference implementation.
- They draw no footnote. One is required here (see Words), and it is the only element on screen that is not in a frame.
- Where this brief and a frame disagree, the brief wins. Say which.

It is used two ways at once. It is shared at 1920×1080 on a call while the adviser clicks between cases, and it is re-opened later by the client alone on a laptop or phone with nobody talking. Nothing may depend on spoken context.

## Decisions

| # | Decision | Settled as |
|---|---|---|
| D1 | Where tax comes from | **The Irish tax engine is the default.** A person's take-home pay may also be **stated**, and then it overrides the engine's tax for that person. The screen and the assumptions say which was used. A payslip figure beats an estimate. The change a case makes to tax is always the engine's estimate. |
| D2 | What "tight" means | **Nothing left over after rounding** (shown left over is €0). Green is anything above that. No percentage threshold. |
| D3 | A case that leaves less than nothing | **Settled: drawn as Short, not refused.** The screen draws it (red, always beside the word "Short"), the engine summarises it, the paste pipeline and the session importer accept it. It landed **before the plan work**, because plans read households that are short. Status follows the amount shown: above €0 is left over, exactly €0 is tight, below €0 is short. The monthly figure in `summary` is signed. See "The short state". |
| D4 | Module name | **Household cash flow**, kind `household-cash-flow`, id `household_cash_flow`. |
| D5 | Voice | **"You" in all on-screen words.** Derived wording, headings, labels, the footnote and the assumptions table speak to the household as "you" and "your". |
| D6 | Per-person take-home for a couple | **Settled: allocated by income share.** The engine assesses a couple's income tax jointly, as one figure, so per-person take-home needs an allocation rule. Each person's share is their income before tax over the household's. The output marks it `basis: 'allocated'` and the assumptions table says so. The rule is in "The model". |
| D7 | Pension money: gross for growth, after relief for cash flow | **Settled 13 October, evening.** A contribution is drawn at its full amount on the Pensions line, because that is what goes into the pension, and the income tax relief on it shows as lower tax. What it costs the household is the difference, which is what moves left over. This is already how the model works; the assumptions wording below is corrected to say it. Any other module that sets a contribution against the household's money (goals and resources, the plan's resource ledger) uses the cost after relief; anything about pension growth uses the full amount. |

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
    leftOver: { amount, shown, monthly, status }   // status: 'left_over' | 'tight' | 'short'. amount, shown and monthly are SIGNED: negative when short
  }]
}
```

- **Take-home per person, total outgoings and left over are the three things plans need**, and they are `takeHome.byPerson[]`, `outgoings.total` and `leftOver.amount`.
- `basis` is `allocated` for a person in a jointly assessed couple and `own` otherwise (D6). A reader must not treat an allocated figure as a payslip.
- `status` is `short` when the amount shown is below €0, and then `amount`, `shown` and `monthly` are negative. The status follows the SHOWN figure, so a case that is short by €40 unrounded shows €0 and is `tight`. `monthly` is rounded as a size first and given its sign afterwards, so a short year and a left over year of the same size round alike. A plan reader must handle all three statuses.
- Every figure is per year. A reader divides by 12.
- Invariants a test asserts for every case: the people's `takeHome` sum to `takeHome.total`; the people's `tax` sum to `outgoings.tax`; `takeHome.total − pensionContributions − statedTotal = leftOver.amount`; `income.total − outgoings.total = leftOver.amount`.

Also:

- `debug.cases[]`: `id`, `title`, `description`, `changes`, `lines[]` (`{ id, label, amount, shownAmount, deltaVsToday }`), `levels[]`, `sentence`, `taxBreakdown` (`incomeTax`, `usc`, `prsi`, per person where jointly assessed the income tax is the allocated share) and `disclosureCodes`.
- `debug.assumptionsUsed`: `IE_TAX_RULES_VERSION` read at run time, the tax year, `PLANEIR_ASSUMPTIONS_VERSION`, the household tax status and whether it was defaulted, and `taxSourceByPerson`.
- `debug.warnings[]`: a stated take-home that differs from the estimate by more than 15%. A warning, never a rejection, because a payslip is allowed to differ. Also a person's tax held at €0 (see "Tax is never below nothing" in the build notes).
- The assumptions table states, in plain words and in the second person: per-year figures in today's money; **which tax was used for each person** (the disclosure line, below); pension contributions are shown in full, and the income tax relief on them shows as lower tax (D7); for a couple, income tax is assessed together, so each person's share is an allocation by income share and their take-home is marked `allocated` (D6); and amounts are rounded to the nearest €100. Use the engine's own disclosure text (`renderTaxDisclosures`) for the estimated parts and do not write tax sentences of your own.
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
- *(Removed by the short-state change: a case that leaves less than nothing used to be refused with "leaves €X less than nothing each year, which this screen does not draw yet." It is drawn now.)*
- `generated.householdCashFlowInputs.outgoings[0] (mortgage).label ("Best mortgage"): this screen speaks to you in plain words. It never recommends or ranks, never names a product or a provider, never says "the household", "the couple", "the client", "they" or "their", and writes amounts with a thousands separator.` The same message, with its own path, for `people[i].label`, `scenarios[i].title` and `scenarios[i].description`.
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
| Today's outlines | Today's bar, as a 1.5px outline at 55% text. Drawn **only** when the selected case is not today, and then only on (a) a column whose own amount changed against today and where today had an amount to outline (Tax, a cleared line), and (b) the last column, whenever its figure differs from today's. **Never** on a column that only moved because a line above it changed, and none on a Pensions column today did not have. Fixed: they do not move. | |
| Key | A small key near the chart, in the free space above the right-hand columns: a 36×18 outline swatch and the word "Today" at 22/600 muted. Shown whenever any outline is drawn, and not otherwise. | |
| Last column's label | Above the last column's outline, or above the bar when that stands higher, two centred lines at 18/600: "Today", then today's figure in words: "€9,200 left over", "€0 left over" or "€2,800 short". Shown with the outline. It is what stops an outline above the floor in the Short column being read as part of what is short. | |

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

### The short state

A case may leave less than nothing. It is an ordinary year, drawn on the same scale as every other, with its own word and its own colour (D3).

**What the engine says.**

- `status` follows the amount SHOWN: above €0 `left_over`, exactly €0 `tight`, below €0 `short`.
- In `summary`, `leftOver.amount`, `shown` and `monthly` are negative when short. The invariants are unchanged, and a short case is simply a left over below zero.
- On the screen the figure and the month have no sign, because the word beside them carries it.
- The ledger tables (`outputsTable` and the per-case `tables`) keep the sign: left over is negative, and the month reads "About −€230 a month". The one chart for surfaces that cannot draw the module, and the video scene, say "Short" with the size, as the screen does.

**The staircase.** The steps keep falling past the floor, and what is short hangs below it.

| Thing | Rule |
|---|---|
| Scale | The same as every other case. A step that crosses the floor is one bar, drawn on the one scale. |
| Room below the floor | `deepest × scale + 20` px, kept **in every case** (the deepest short case in the payload sets it), so nothing moves on a click. Names sit below it. None when no case is short. |
| Floor | 55% text when room is kept, 32% otherwise, and named "€0" at its left end: 18/500 muted, right-aligned 4px left of the plot, centred on the line. It lives in the 28px the module keeps either side. |
| The short bar | The last column. `#c96f62`, as wide as the others, hanging from the floor down to the depth where the last step ended, so the last step and the red bar end at the same depth. Beside the word "Short" under it. |
| Amounts | Above each bar, as before. A step that starts below the floor has its amount above its own top, inside the room. |
| Today's outlines | Unchanged. The last column's outline stands on the floor when today was left over and hangs from it when today was short. Its label ("Today" and "€2,800 short", or "€9,200 left over") sits above whichever stands higher **above** the floor, and never below it. |

**The bar.** The costs run past the end of income.

| Thing | Rule |
|---|---|
| Scale | 700 ÷ income, as before. |
| Room | `deepest × scale + 16` px below the 700, kept in every case. The track and the chart are that much taller. None when no case is short. |
| End of income | A 1px hairline at 60% text, 6px wider than the bar each side, once room is kept. |
| The short part | A red segment: the part of the costs that runs past the end of income, from the 700 line down. Costs above it are drawn as before. |
| Row | "Short" with the size, centred on the red part, and placed with the same rules as the other rows, pulled up from the bottom of the room plus 8. |
| Sentence | Keeps the room of the longest case's sentence, measured in the browser once the module is on the page, never less than four lines. The short sentences run to five lines on a 390 phone, so four is not enough. |

**Colour and motion.** Red is the colour of the last mark, **decided by the figure being drawn and not the case being chosen**, so a click that crosses the floor changes colour where the mark crosses it, and settles on the case.

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
- Amber means tight and always sits beside "Tight". Red (`--accent-red`, #c96f62) means short and always sits beside "Short": the swatch in the answer, and the bar or segment that hangs below the floor or past the end of income.
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

Fixed copy: muted line `Your household cash flow`, heading `After everything you pay, what is left each year?`, income label `Your income before tax`, statuses `Left over`, `Tight` and `Short`.

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
| today, short | `Today, {€outgoing} goes out against your {€income}, and you are short by {€short}.` |
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
| the same, and short | `you are short by the same {€S} as today` |
| now short, left over or tight today | `you are short by {€N}` |
| now short, and short today | `you are short by {€N} instead of {€S}` (whether more or less) |
| short today, now above zero | `you have {€N} left over instead of being short by {€S}` |
| short today, now exactly zero | `you have nothing left over instead of being short by {€S}` |

`{€S}` is today's shortfall and `{€N}` is this case's, both with no sign. The effect clause is chosen on the SHOWN figures, and the same-as-today test comes first, so a case that is short by exactly what today is short by is "the same", and one that moves by €100 is "instead of".

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

The short sentences, which are golden strings (the engine fixture with living costs of 60,000, so today is short; the tax is the engine's at the rules of 10 October, and the tests derive it rather than hard-code it):

1. `Today, €152,800 goes out against your €150,000, and you are short by €2,800.`
2. `Clearing your car loan from savings stops €6,000 a year going out, so you have €3,200 left over instead of being short by €2,800.`
3. `Paying €10,000 more into your pensions lowers your tax by €4,000, so €6,000 more goes out each year and you are short by €8,800 instead of €2,800.`
4. `You are short by the same €2,800 as today, but your car loan is gone and €10,000 more goes into your pensions each year, with your tax €4,000 lower.`

And from left over to short, with 20,000 into pensions on the engine fixture: `Paying €20,000 more into your pensions lowers your tax by €8,000, so €12,000 more goes out each year and you are short by €2,800.`

Three effect clauses are not on a frame and were approved in the plan: "nothing left over instead of being short by", "short by €N instead of €S" when the shortfall is smaller, and left over to short with no "instead of". The tests prove them with the design fixture, so their figures are literal: today short by €6,000 clears to `you have nothing left over instead of being short by €6,000`, living costs of €62,000 and the car loan cleared give `you are short by €2,000 instead of €8,000`.

On screen a short figure has **no sign**. The word carries it: "Short", "€2,800 a year" and "About €230 a month". Nothing says "negative", "deficit" or "overdrawn".

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
- Short: "Short", the size with no sign, a red mark below the floor (or past the end of income on the bar), and "About €230 a month" beside it. See "The short state".
- Short by less than €50 unrounded: shows €0, so it is Tight, and its `amount` in `summary` is still the exact negative.
- Amounts of €1m and over: amounts above bars and axis text go compact ("€1.2m"), and the bar labels follow the pitch rule.
- A long label (24 characters): wraps, never truncates.
- Six outgoing lines on the narrowest wide screen (n = 10 at 832): names wrap to three lines, which is the layout test's worst case.

## Wiring

**Superseded by the list in `docs/future-cost-fund-app-change.md`, "Wiring a new engine module", which is the one that was followed.** It lists every file in order and includes three this list missed: `js/module_pipeline.js`, the presenter hook in `js/app.js`, and the charts guard in `js/render.js`. The list below is what this brief first said and is kept for what it records about this module's own needs.

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
5. **Case 4 is not case 1.** In every fixture, case 4's shown left over equals today's, and the staircase's left-over bar is identical, but the model reports car loan, pensions and tax as changed, today's outlines exist for exactly the changed columns where today had an amount (tax and the car loan, not pensions) and for the last column when its figure differs, none on any column that only moved, and the bar's changed segments are exactly those lines. A case that changes only a pension contribution draws an outline on Tax and nothing on the stated lines below it, which is the €6,000, €9,000 and €3,000 boxes the first drawing wrongly put behind their labels. The key and the last column's "Today" label are present exactly when an outline is. This is the design's acceptance test.
6. **No second tax.** Change a rule in a test catalogue and the module's tax follows it, which proves it holds no copy. Search `js/household_cash_flow_*.js` for tax rates and bands and find none.
7. **Rejections** with the exact messages: a stated tax line, a typed `leftOver`, a fifth case, a seventh line, duplicate ids, an unknown outgoing id in a change, a pension change twice, `baseScenarioId` not matching, a missing label for two people, and a `householdTaxStatus` error.
8. **Layout, in Node.** For all four cases of every fixture at content widths 1728, 1360, 1200, 976, 848 and 832 for the staircase, and 560, 350 and 320 for the bar (a 390 phone and a 360 phone, less 20px each side): no two labels overlap, no label box is crossed by a bar or connector, every box sits inside the container, the plot height equals the formula, and bar heights are identical in every case for a given width (one scale). Type never falls below 14px for names or 16px for amounts.
9. **The switch.** At 831 exactly one drawing is in the DOM and it is the bar. At 848 it is the staircase. Across the line the selected case survives and the engine is not rerun. A jitter of 15px around 840 does not flip it.
10. **Motion discipline.** After any sequence of clicks, including a rapid one and one in a throttled tab, the drawn state equals a fresh render of the last case, and no two figures on the screen disagree. With `prefers-reduced-motion` the new case is drawn at once.
11. **Words.** Render all four cases of every fixture and scan the visible text and every `aria-label` for the banned phrases, "p.a.", a provider name, any amount without a thousands separator, and **third person**: "the household", "the couple", "the client", "they", "their". The only first names on screen are in the tax-source line, and only with two people. The eight golden sentences equal their templates' output.
12. **Wiring.** Presenter case selection by id, the video scene and the codex video brief each resolve the selected case's figures. Extend `check-video-scene.mjs` and `check-codex-video-brief.mjs`.

Before finishing, run `npm run build`, `npm run check:household-cash-flow`, the Irish tax suites via `scripts/run-pension-math-tests.mjs`, `check:video-scene`, `check:codex-video-brief` and `check:consumer-session-payload`. Then open `dev/household-cash-flow-preview.html` at 1920, 1366, 1024, 844 and 390 and look at it, because the frames have not been checked in a browser either.

## Out of scope

- **The short state** is built: see "The short state" and "Build notes (short state)". The frames were redrawn with it.
- **The plan adapter.** `js/planning/adapters/household_cash_flow.js`, the module registry and manifest entries, routing, goal catalogue entries and anything that makes a plan call this module. `summary` is its input and is written here. Stated take-home arriving from a profile's income facts is the adapter's job.
- **The money used to clear a loan.** "From savings" is wording only. The balance paid off, and what it does to savings, are not in the household's figures and are not shown. If a payoff amount arrives later it needs its own row and a disclosure, and it must never be added to the yearly picture.
- **More kinds of change.** Cutting a cost, changing income, a second pension, a one-off: each needs wording drawn and approved before it is built. Only the two designed changes exist.
- **More than six lines, grouping, or a long tail called "Other".**
- **A projection.** Anything beyond one year, inflation, drawdown, accounts. That is the multi-year cashflow module's brief.
- **Where the money goes after the pension.** What the contribution is worth, its tax at retirement, or its growth. The retirement module owns that.
- **Existing pension contributions in the household, in this change.** The base household takes none, so "10,000 more" means 10,000 on top of nothing, and a stated take-home must be one that has none deducted. Reject `employmentPensionContribution` in `income`. **This is the first follow-up after the screen lands** (see "Follow-up: today's pension contributions"), because a plan's households usually pay into a pension today.
- **A stated take-home that varies by month, or a bonus.** One figure a year per person.
- **The other drawings.** The single bar at 1920, the stream, and the quarter-turned staircase for phones are not built. If a tablet in portrait needs something better than the bar, that is a new design.
- **Consumer routing, voice, planner facts, manifest, playbook and goal catalogue entries.** Follow the retirement precedent: do not edit `docs/prompt-pack/`. The playbook, aliases, matrix and master prompt are updated separately once this lands, so they describe what the code does.

## Follow-up: today's pension contributions

Decided 13 October 2026, evening. A separate change, after the screen has landed and before the plan work, because the plan's illustrative household (Niamh and Dara) pays 5% and 4% today and this module cannot show it yet.

- Each person may carry today's personal contribution, per year, gross. It becomes an `employmentPensionContribution` item in **every** case, so the Pensions column exists in today's case and tax and take-home follow it (D7).
- An `extraPension` change adds to it. The sentence templates stay: "Paying €10,000 more into your pensions" is still the extra.
- Decide in the plan, and say which: whether `statedTakeHome` is before or after today's contribution. A payslip's net pay is after it.
- Give the field name, the validation strings and the new fixture in the plan, and wait for the go-ahead, as for the main change.

## Build notes (engine)

Built on this branch, after merging main. Files: `js/household_cash_flow_math.js`, `js/tests_household_cash_flow_math.js`, `scripts/check-household-cash-flow.mjs`. Run it with `node scripts/check-household-cash-flow.mjs`. The npm script and the workflow lists wait for the wiring stage. `js/pension_math.js` now exports `PENSION_EARNINGS_CAP` and `maxRelievablePersonalContribution`.

Settled while building, and these override anything above that reads differently:

- **Relief limit.** An `extraPension` above the relievable maximum is refused, with a message naming the person and the limit. A `joint` contribution is split before the limit is applied. When today's contributions arrive, the limit applies to today's plus the extra. The tax engine itself relieves any contribution in full, so this guard is the only thing that stops an overstated saving.
- **`summary`.** Each case also carries `pensionContributions: { gross, taxRelief, costAfterRelief }`. `outgoings.pensionContributions` stays the gross figure, so the invariants are as written.
- **Base case.** A base case that carries changes is refused.
- **Today's contributions.** An internal per-person field, 0, not accepted from a payload yet.
- **`"joint"` in a one-person household** is mapped to that person, for income and as the default for `extraPension`. The engine refuses it for one person.
- **"No second tax" is proved three ways**, because `computeTaxYear` has no catalogue seam to inject a test catalogue through: (1) the module's tax equals `computeTaxYear` at test time, (2) a scan of the module's source finds no tax import beyond the engine, resolver, disclosures and `IE_TAX_FIRST_YEAR`, and no rate, band or credit literal, (3) `taxFor` is the only seam and a payload cannot reach it. Test 6 above is superseded by this.

Found while building:

- A couple's `joint` contribution is relieved at each person's own marginal rate, so with a low earner it can save less than 40%.
- The engine's `TAX_ESTIMATE` disclosure says tax figures are "rounded to the nearest euro", while this screen rounds to €100. Both appear in the assumptions table. That sentence is the shared engine's, so it is reported here and not reworded.
- The engine's disclosures say "They" of tax figures. The words test allows that in engine-owned text and is strict about text this module writes.

Not built: the screen, the wiring and the plan adapter.

### Tax is never below nothing

Found by review after the screen merged. A stated take-home sets the level of a person's tax (`income − statedTakeHome`) and the engine supplies only what a case changes, so a stated figure close to gross pay left a person with almost no tax to relieve, and a pension case then subtracted more relief than there was tax. €75,000 gross, €74,999 stated and €10,000 more into a pension gave tax of −€3,999 and a take-home of €78,999.

- **Each person's tax is held at €0 or more, in every case.** Relief cannot be more than the tax paid.
- **Relief is realised per person**: what a person's tax would have been with no extra contribution, less what it is, never below nothing. So `taxRelief` in `pensionContributions` is what there was to relieve (€1 in the example above, not €4,000), and `costAfterRelief` is the gross contribution less that (€9,999). The invariants are unchanged.
- **The cap is recorded.** A `debug.warnings` entry names the case, the person and the figure it would have been, and says it is held at €0. The screen says nothing; the tax figure is simply never negative.
- **Nothing changes in an ordinary case**: the cap only binds where a stated figure leaves less tax than the relief. The check script has the example as a fixture, and its reference calculator applies the same rule independently.

## Build notes (short state)

Built as its own change on `household-cash-flow-short`, after the engine, screen and wiring. It also carries the tax floor above.

**The engine** (`js/household_cash_flow_math.js`). The refusal is gone. `statusFor` has its third value. `monthlyFor` returns a signed `amount` and an unsigned `text`: it rounds the size and gives it the sign afterwards, because `Math.round(-2.5)` is -2 and `Math.round(2.5)` is 3, and a short year of €300 must round like a left over year of €300. `effectClause` and the today sentence have the short wording. The ledger tables carry the sign and the chart says "Short".

**The view** (`js/household_cash_flow_view.js`). `readCashFlowModel` no longer throws and carries `deepest`. `layoutStairs` keeps `band` and a "€0" label, `layoutBar` keeps `reserve` and `incomeEnd`. `stairsGeometry` and `barGeometry` give the last mark a `short` kind. The layout checks run over the short shapes at every width, and also check that nothing reaches the names and that what hangs fits the room kept.

**The module** (`js/household_cash_flow_module.js`). One `markShort` decides the last mark's colour from the figure being drawn. The sentence's room is measured.

**Paste pipeline and session import.** Neither needed a change of logic: both project the payload, and the projection no longer throws. Their comments were wrong and are corrected. A short session is kept and tables are derived.

**Review lessons applied.** Rows 4, 12, 15, 17 and 18 of the wiring list were tightened after the first modules were reviewed, and this change checked the module against them:

- Row 4: text a payload supplies (a person's label, an outgoing's label, a case's title and description) is held to the module's wording **on the way in**, not only in a test. The engine owns the list and the view imports it, so there is one. This module does not write its own `summaryHtml`, because its limit is the education-only wording and not a regulatory one.
- Row 12: the session importer cuts cases with `capImportedEngineCases`, which keeps the named base among the cases kept, and `householdCashFlowInputs` is in `RUNTIME_OWNED_INPUT_KEYS`. Both came from main.
- Row 15: no charts card in the grid or in the patch path. Already so.
- Row 17: the video's figures are the SHOWN ones. "Other outgoings" was the rounded total of the stated lines, which can differ from the lines drawn by a few hundred, and is now their sum as shown. The chart has at most ten points, under the fourteen a video keeps.
- Row 18: the module's own wiring tests now include an import that cannot be read taking its stored figures with it, and a cut that keeps the base.

**Where it differs from the frames**

- The "€0" label is 18px, not 20, so it fits the 28px the module keeps beside the plot.
- The phone frame's text column is 350px wide. The module's is 306 on a 390 phone, because it keeps 28px beside the bar for the staircase's amounts. The sentence's room is measured for that reason.
- The selected case button gives back the border's pixel on every side. It gave it back only sideways, so a button whose label wrapped to three lines was 2px taller selected and moved the bar by 2px on a phone. On a 390 phone the bar now sits at the same height in every case.

**Tests.** Engine: the frames' sentences as golden strings under the design fixture, the three effect clauses that are not on a frame, a short case in each direction, status following the shown figure, and the sign of the month. Reference calculator: five short payloads (today short, tipped under, stated, assessed separately, and the design fixture) against the engine. View: every shape check also runs over three short shapes, plus the geometry below the floor and on the bar. Module: the colour follows the figure at every frame of a click that crosses the floor. Wiring: a short payload is accepted by the paste and kept by the session import. Video: a short case says "Short" and its size.

**Review follow-up (16 October).** Income that rounds to €0 is refused in the engine with `generated.householdCashFlowInputs.income: your income before tax rounds to €0 on this screen. Give a yearly total of at least €50.` This applies to the household total, using the screen's nearest-€100 rounding.

The staircase's plotted span is at most 600px and the bar's at most 900px, including the shortfall padding. When income plus the deepest shortfall would exceed that span, income and every case use the same reduced scale. Ordinary cases keep their existing scale. Below 400px of chart width, the income header and each row stack their name above the amount; row heights include wrapping and the delta line. Node layout checks now include 252, 280 and 320px, plus 196px for a 252px module after its side padding.

**Looked at in the real app** at 320 and 390, with the pending #72 grid declaration, through every short-fixture case: the modules measure 252 and 322px, no text runs past them, and the chart stays at the same position on a case change. Earlier preview checks covered 1920, 1360 and 390 (`?preset=short`, `?preset=tipped`, `?preset=shortdesign`). Not on a physical phone.

## When you finish

End with a contract summary for the prompt pack: field names, the model and the two change kinds, where tax comes from and what a stated take-home does, the allocation convention for couples, the `summary` shape and its invariants, the rounding rule, every validation string, the derived copy templates (in the second person) and the width switch, plus the Dev Panel examples. Keep to the repo's commit style: short plain-English commits describing what the client sees change.
