# Future cost fund: a dated cost, and the ways to have the money ready

Status: design chosen (option A, "the hill"), assumptions settled 2026-10-13. **Built: the central assumptions, the engine, the screen and the app wiring (branch `future-cost-fund-screen`, after PR #55).** Stage 1 only.

## Build status

Everything in Stage 1 is built. The engine and the central assumptions landed in PR #55 (see "Wiring a new engine module" for every file, in order). The screen and the wiring followed on `future-cost-fund-screen`:

- `js/future_cost_fund_view.js`: the words, the geometry and where every label sits, with no DOM, so they are checked in Node.
- `js/future_cost_fund_module.js`: the drawing, the 520ms clock and `presenterSelectScenario`.
- State, paste pipeline, render, app, presenter, video scene and codex brief wiring, the Dev Panel example, `dev/future-cost-fund-preview.html`, the `.fcf-` styles and the CI listing.
- `npm run check:future-cost-fund` runs four suites: the engine against its reference calculator, the view (words, geometry, label collisions at 358, 720, 1000 and 1776), the module (clock and DOM, driven with a DOM shim and fake timers) and the wiring (paste pipeline, session import, presenter catalogue). The video scene and codex brief are proved in `check-video-scene.mjs` and `check-codex-video-brief.mjs`.

Differences from this brief as first written:

- `PLANEIR_ASSUMPTIONS.cash.basis` does **not** name the two banks. No provider name reaches a client-facing string, and `assumptionRecord('cashRate').reason` is built from `basis`. The banks, rates, dates and URLs are in `cash.observed`, for the audit trail only.
- `startsInYears` is 1 to 40, so a case has at most 70 columns, not 130.
- The phone plot is **320** high, not 300. The fund peaks at 80% of the axis, so the top 20% is 64px, which is exactly the height of the cost panel's three-line header.
- Axis names are spaced from the width of the widest name (every year, then every 2, 5, 10, 20 or 50) and never touch, instead of fixed tiers. The year the cost starts is always named.
- The cost panel's header sits inside the panel when its title fits on one line, and in a row above the chart when it does not (a one-year cost, or a very large total).
- Label order is as agreed: the yearly label is placed first, the lump label is stacked clear of it, and as a last resort the lump label sits inside the area just under the riser. A label wording that would reach the cost panel drops "You pay in".
- Headlines describe the case ("Putting in €10,800 a year for 8 years covers the whole cost.") rather than instructing, and every on-screen word speaks to "you".
- `js/module_pipeline.js` and the presenter hook in `js/app.js` were missing from the first wiring list. They are in the list below.
- The hover read-off the repayment module gained later (`attachScrub`) is **not** in this change. It is a follow-up; the layout keeps the data it needs.

One failure that predates this work: `scripts/check-module-catalogue-authoring.mjs` fails on a migration filename (`0019_add_application_voice_notes.sql` against the expected `0018_add_agent_application_requests.sql`), identically on unmodified `main`. A separate change fixes it.

## Context

A client knows a cost is coming on a date: college, care for a parent, school fees. The question this module answers is **what does it take to have the money ready, and what are the ways to get there?**

Nothing in the app answers it yet. `js/college_funding_math.js` projects what the cost will be (inflated, per child, per year) but has no savings side: no growth rate, no lump sum, no yearly amount. This module is that missing half, and it is generic. It takes one dated cost and up to four ways of funding it.

The design is option A of three that were explored. The idea it has to land: **every way arrives at the same place. What differs is when the money leaves the client's hands, and how much of the total is growth rather than their own money.**

The screen is the fund over the years. It rises as money goes in, peaks when the cost starts, and the cost then takes it out in four labelled blocks. The right-hand side (the cost) never moves when the case changes. Only the path to it does. That is the whole point of the picture, so it is also an acceptance test (see Tests).

Reference frames, in the design canvas (private link: https://claude.ai/artifact/W6BGCAdkP72nGHQasZRq9w):

| Frame | What it shows |
|---|---|
| `A · The hill · lump sum today` (`Main.dc.html`) | 1920×1080, case 1 selected |
| `A · The hill · start in 3 years` (`OptionA2.dc.html`) | 1920×1080, case 4 selected |
| `A on a phone` (`PhoneA.dc.html`, `PhoneA2.dc.html`) | 390 wide, cases 1 and 3 |

The frames carry the geometry and the copy structure. Three things to know before you use them:

- They were drawn with the **design fixture** (prices 3%, savings 2%), not the central assumptions below, so their figures are not what the module will show. They have not been redrawn at the central numbers, and the picture changes (see "What this does to the picture").
- They were built in the design tool and have not been opened and checked in a browser, so treat them as a drawing, not a reference implementation.
- Where this brief and a frame disagree, the brief wins. Tell me which.

Use it two ways at once. It is shared at 1920×1080 on a call while the adviser clicks between cases, and it is re-opened later by the client alone on a laptop or phone with nobody talking. Nothing may depend on spoken context.

## Assumptions: settled

Everything the module needs is a **central** Planeir assumption, so every module and every adviser reads the same number. Nothing is typed into the payload.

| Assumption | Value | Where it lives |
|---|---|---|
| Education cost growth | 4% a year | `PLANEIR_ASSUMPTIONS.inflation.educationRate`, exists |
| General price growth | 2% a year | `PLANEIR_ASSUMPTIONS.inflation.generalRate`, exists |
| Cash interest, before DIRT | 0.2% a year | **new**: `PLANEIR_ASSUMPTIONS.cash.instantAccessGrossRate` |
| DIRT | 33% | **new**: the Irish tax catalogue, `js/planning/tax/rules_ie.js` |
| Cash interest, after DIRT | 0.134% a year | derived: `0.2% × (1 − 0.33)`, never stored |

A cost uses the education rate when it is an education cost and the general rate otherwise. `costKind` is **required** in the payload with no default, because silently using the general rate on an education cost "would understate every future year" (the comment in `scripts/check-college-funding-audit.mjs`).

### Where the cash rate comes from

Checked 2026-10-13 against each bank's own rate sheet. The two plain instant-access accounts, each with no balance limit and no conditions:

| Bank | Account | Rate quoted | Source |
|---|---|---|---|
| Bank of Ireland | Instant Access Demand / Demand Deposit | 0.10% AER, variable, €1 minimum | Deposit Interest Rates Table, "effective from the start of business on 14th September 2026" (personalbanking.bankofireland.com/save-and-invest/savings/bank-of-ireland-deposit-rates/) |
| AIB | Personal Demand Deposit Account | 0.25% AER, 0.25% gross annual interest rate, no maximum | Deposit Rates, "Rates applicable from 13 May 2025" (aib.ie/our-products/savings-and-deposits/Deposit-Rates) |

AIB's sheet carries an old date, but its own Online Saver page, read the same day, still quotes the same 3.00% and 0.25% "currently", so I treat the sheet as live. The average is 0.175%, rounded to one decimal place: **0.2%**.

**Both are quoted gross.** AIB's sheet has both an "A.E.R." and a "Gross Annual Interest Rate" column and says interest "is subject to Deposit Interest Retention Tax (DIRT), where applicable, at the prevailing rate on the day interest is paid". Bank of Ireland's table footnote says "Interest is subject to Deposit Interest Retention Tax (DIRT) at the prevailing rate". So DIRT comes off afterwards, as the interest is credited each year, and the fund compounds at the after-DIRT rate.

**The higher headline rates are not used, deliberately.** AIB's Online Saver is "up to 3.00% AER" but only on a monthly limit of €1,000, rising by €1,000 a month to €12,000 and resetting in month 13, funded by a standing order of €10 to €1,000 a month, and 0.25% above that. Bank of Ireland's SuperSaver (2.00%, 0.50% above €30,000), GoalSaver and MortgageSaver (2.00% up to €14,999, 0.50% above) are regular savers. None of them takes a €65,000 lump sum, or a fund that builds to €87,000, at the headline rate. Averaging them would give 2.5% and would be wrong for any sum this module deals with.

Re-verify both banks before this ships and again whenever the assumptions version moves.

### DIRT is not in the engine

I checked. DIRT is not in `PLANEIR_ASSUMPTIONS` and not in the Irish tax catalogue (`js/planning/tax/rules_ie.js`, which has income tax, USC, PRSI, pension lump sums and the SFT, and only a disclosure sentence mentioning DIRT at `js/planning/tax/disclosures.js:320`). The only place it exists is inside the house purchase engine as its own copy: `HOUSE_PURCHASE_RULES.dirtRate` 0.33 in `js/house_purchase/config.js`, applied as `grossAer × (1 − dirtRate)` in `js/house_purchase/engine.js`.

The catalogue's own rule is that "nothing else in the app should carry its own copy of a band, credit or rate", so DIRT goes into the catalogue (see Central assumptions, below) and this module reads it from there. Revenue's DIRT page (published 24 April 2026) gives 33%. Budget 2027 was delivered on 6 October 2026. The coverage I found did not mention DIRT, but I did not read the Finance documents, so **confirm the rate on Revenue's page again before merging**.

### What this does to the picture

The same 15,000-a-year cost, starting in 8 years, for four years:

| | Design fixture (3% prices, 2% savings) | Central (education 4%, cash 0.134% after DIRT) |
|---|---|---|
| Cost in total | €79,500 | €87,200 |
| Lump sum today | €65,800 | €86,100 |
| Yearly for 8 years | €8,800, paid in €70,500 | €10,800, paid in €86,500 |
| Half and half | €32,900 + €4,400, paid in €68,200 | €43,000 + €5,400, paid in €86,300 |
| Start in 3 years | €14,500 for 5, paid in €72,700 | €17,300 for 5, paid in €86,600 |
| Growth, cases 1 to 4 | 13,700 / 9,000 / 11,300 / 6,800 | 1,100 / 700 / 900 / 600 |

Cash at 0.13% against costs rising 4% means growth is about 1% of the total. The fund line is nearly flat between payments, the four ways pay in within about €500 of each other, and the money in the fund when the cost starts (about €87,000) is almost the whole cost. This is what the central assumptions say, not a defect, and the screen is still right: the shape and the numbers agree. But "how much is growth" stops being a difference worth a hero, and "when" does most of the work. Everything below holds at both sets of numbers.

## Defaults I have assumed

1. **Release surface.** Adviser-only through the Dev Panel and presenter, `consumer: false`, as pension and mortgage were. No consumer routing, no voice, no planner facts in this change.
2. **Rounding on screen.** Every planning amount to the nearest €100, from unrounded values, and the footnote says so. Rules in the contract.
3. **No rates in the payload.** Unlike `inflationRate` on `collegeFundingInputs`, this module takes no rate from the payload. Advisers cannot override assumptions, and the point is that everyone is aligned.

## Before you write code

- Pull `main` and create a new branch, for example `future-cost-fund`.
- Read `js/repayment_case_module.js` end to end. It is the closest precedent and this module should feel like its sibling: same clock, same settling discipline, same `build...Module({ rawInputs, selectedCaseId, onSelectCase })` shape, same standalone dev preview (`dev/repayment-module-preview.html`). Then read the commit message of `1d0e895` for the acceptance rule on motion.
- Read `js/college_funding_math.js` for the normaliser, validator and `computeCollegeFundingProjection` output shape (`assumptionsTable`, `outputsTable`, `tables`, `charts`, `debug`), and `scripts/check-college-funding-audit.mjs` for how an engine is proved against an independent reference calculator.
- Read `js/mortgage_math.js` (`getMortgageScenarioCases`, `baseScenarioId`, the scenario error strings), `js/scenario_cap.js`, and the mortgage case selection wiring in `js/app.js` (`setMortgageScenarioForModule`, `window.__setMortgageScenario`), `js/state.js` (`normalizeGenerated`, `normalizeModuleUi`, `mortgageScenarioId`) and `js/render.js` (`buildMortgageScenarioShell`).
- Read `js/presenter_catalogue.js` (`moduleKind`, `scenarios`), `js/video_scene.js` (`getVideoModuleKind`) and `js/codex_video_brief.js`, because a module the presenter cannot select a case in, or the video cannot describe, is half a module.
- Read `js/planning/planeir_assumptions.js` (`PLANEIR_ASSUMPTIONS`, `assumptionRecord`, `ASSUMPTION_LABELS`) and `scripts/check-planeir-assumptions.mjs`.
- Read `js/planning/tax/rules_ie.js` (its header says how to add a rule and what to bump), `js/planning/tax/resolve.js` (`buildResolvedRules`, which lists the fields it returns explicitly, so a new block does not appear until it is added there), and `js/tests_ie_tax.js`.
- Then give me a short plan: final field names, the file list, how the selected case is persisted, and where the pure layout function sits. **Wait for my go-ahead before implementing.**

## Central assumptions: what to add

Do this first, in its own commit, because the engine depends on it.

1. **`js/planning/planeir_assumptions.js`.** A new `cash` entry:
   - `instantAccessGrossRate: 0.002`.
   - `basis`: "A 0.2% interest rate is used for money held in instant-access cash. It is the rounded average of the standard instant-access rates Bank of Ireland (0.10%) and AIB (0.25%) quoted in the Republic of Ireland in October 2026, before DIRT."
   - `disclosure`: "This is a planning assumption, not a quoted rate. Banks can change instant-access rates at any time, and regular-saver and notice accounts pay more."
   - The two observed rates with their effective dates and URLs, for the audit trail.
   - Bump `PLANEIR_ASSUMPTIONS_VERSION` to `planeir-assumptions-1.3.0` and `PLANEIR_ASSUMPTIONS_APPROVED_ON`.
   - Add `assumptionRecord('cashRate')` and an `ASSUMPTION_LABELS` entry (`cashGrowthRate`: "Interest on money held in cash") so the assumption has an approved consumer-safe name. Extend `scripts/check-planeir-assumptions.mjs`.
2. **`js/planning/tax/rules_ie.js`.** A `dirt` block in the 2026 rules: `ruleId: 'ie.dirt.2026'`, `rate: 0.33`, its source, a new `IE_TAX_SOURCES.revenueDirt` entry pointing at Revenue's DIRT rate page. Update `verifiedOn`, bump `IE_TAX_RULES_VERSION` to `ie-tax-2026.3` (main was already on `ie-tax-2026.2` after the capital gains tax change), and rerun the golden cases. Add `dirt: block.dirt` to `buildResolvedRules` in `js/planning/tax/resolve.js`. Later years hold the latest block unchanged, which is the catalogue's existing policy for Budget-set rates. Nothing else in the tax engine starts using DIRT.
3. **Do not touch house purchase in this change.** It carries its own 2% gross deposit default and its own 33%. See Out of scope.

## The contract

Add `generated.futureCostFundInputs`. Engine in `js/future_cost_fund_math.js`, renderer in `js/future_cost_fund_module.js`, tests in `js/tests_future_cost_fund_math.js`.

### Inputs

| Field | Type | Rule |
|---|---|---|
| `costTitle` | string, required | Client-facing name of the cost, shown as the module heading. "College", "Care for Mam", "School fees". Trimmed, 1 to 60 characters. |
| `costKind` | `'education'` or `'general'`, **required** | Picks the central price rate. No default. |
| `startsInYears` | integer, required | Years from today until the cost's first year. 1 to 40. |
| `durationYears` | integer, required | How many years the cost runs. 1 to 30. |
| `annualCostToday` | number, required | One year of the cost in today's money. Greater than 0. |
| `baseScenarioId` | string, optional | Must match a case id when present. Default is the first case. |
| `scenarios` | array, required | 1 to `MAX_MODULE_SCENARIO_CASES` (4) cases, from `js/scenario_cap.js`. |

There are no rate fields. A payload that carries `priceGrowthRate`, `savingsGrowthRate`, `inflationRate` or `dirtRate` is rejected: `generated.futureCostFundInputs.priceGrowthRate is not accepted. Rates are set centrally in the Planeir assumptions.`

Each case:

| Field | Type | Rule |
|---|---|---|
| `id` | string, required | Unique. Stable, because the presenter selects cases by id. |
| `title` | string, optional | Client-facing button name. Absent: derived (see Words). |
| `description` | string, optional | One sentence. |
| `lumpShare` | number, optional | 0 to 1. The share of the whole cost funded by a lump sum today. Default 0. |
| `savingStartsInYears` | integer, optional | When yearly saving begins. Default 0. Must be less than `startsInYears` unless `lumpShare` is 1, in which case it is ignored. |

That gives the four sample cases exactly: `lumpShare: 1`; `lumpShare: 0`; `lumpShare: 0.5`; `lumpShare: 0, savingStartsInYears: 3`. A case states *how* the cost is funded, never *how much*. The engine solves the amounts. (Stated amounts are out of scope, see below.)

### The model

All flows happen at the **start** of a year. This is the convention that reproduces the sample, so it is the one to use and it must be written into the assumptions table.

- `computeFutureCostFundProjection(rawInputs, { assumptions, calculationYear } = {})`. By default `assumptions` is `resolvePlanningAssumptions()` and DIRT is `resolveTaxRules(calculationYear).dirt.rate`. The options argument exists so tests can inject the design fixture. It is never reachable from a payload.
- `priceGrowthRate` is `inflation.educationRate` for `'education'` and `inflation.generalRate` for `'general'`.
- `cashRateNet = cash.instantAccessGrossRate × (1 − dirtRate)`. DIRT is taken when the interest is credited, once a year, so the fund compounds at the net rate each year. (House purchase applies the same `gross × (1 − DIRT)` but compounds monthly. This module's flows are annual, so it compounds annually.)
- Cost year `k` (0-based) is paid at the start of year `startsInYears + k` and equals `annualCostToday × (1 + priceGrowthRate)^(startsInYears + k)`.
- Money held grows by `cashRateNet` over each year.
- `requiredToday` is the present value of all cost years at `cashRateNet`.
- Lump sum today: `lumpShare × requiredToday`.
- Yearly saving: `n = startsInYears − savingStartsInYears` payments, at the start of years `savingStartsInYears … startsInYears − 1`, each sized so the present value of the stream is `(1 − lumpShare) × requiredToday`.
- `paidIn = lumpSumToday + n × yearlyAmount`, `growth = totalCost − paidIn`, both unrounded.
- Year by year the engine returns `{ yearIndex, openingBalance, payment, cost, closingBalance }`. The closing balance in the last cost year is zero, and the engine asserts it to within €0.01.

### Rounding

- Show amounts rounded to the nearest €100, from unrounded values.
- The yearly cost blocks are rounded independently. The total is the rounded sum of the unrounded years. The design fixture's own blocks therefore add to €79,600 against a €79,500 total, and the footnote says "Amounts are rounded to the nearest €100". Do not "fix" this by nudging a block.
- **Growth on screen is always shown total minus shown paid-in**, never rounded on its own, so the support sentence always adds up.
- Rates are shown whole when they are whole ("4%") and to at most two decimals otherwise ("0.2%", "0.13%").

### Outputs

`computeFutureCostFundProjection(rawInputs)` follows the college engine's shape: `assumptionsTable`, `outputsTable` (one row per case), `tables` (the annual rows for each case), `charts`, `debug`.

- `debug.cases[]`: `id`, `title`, `description`, `lumpShare`, `savingStartsInYears`, `savingYears`, `lumpSumToday`, `yearlyAmount`, `paidIn`, `growth`, `rows[]`, `peakOpeningBalance`.
- `debug.assumptionsUsed`: the price rate and where it came from, the cash rate before and after DIRT, the DIRT rate, `PLANEIR_ASSUMPTIONS_VERSION` and `IE_TAX_RULES_VERSION`. The assumptions table lists the same, in plain words, and states the start-of-year timing.
- `charts` carries **one** ordinary chart (fund balance at the start of each year for the base case) for the surfaces with no module to draw for them, chiefly the video summary. This is what `repayment_case_module.js` does. The focused pane shows no charts card for this module.
- `getFutureCostFundCases(rawInputs)` returns `[{ id, title, description }]` for the presenter, like `getMortgageScenarioCases`.

### Validation

Messages follow the existing style and name the field and the case:

- `generated.futureCostFundInputs.scenarios supports at most 4 cases; received 5.`
- `generated.futureCostFundInputs.scenarios[1] (Start in 3 years): savingStartsInYears must be less than startsInYears.`
- `generated.futureCostFundInputs.costKind must be "education" or "general".`
- Also: duplicate id, unknown case key, `baseScenarioId` not matching, `lumpShare` outside 0 to 1, non-integer years, `durationYears` over 30.
- The session importer in `js/state.js` treats `scenarios` like the other capped arrays: tolerate on the way in, cap with an import warning, never throw.
- `futureCostFundInputs` is mutually exclusive with the other engine keys in `normalizeGenerated`, handled exactly as `collegeFundingInputs` is, and is cleared by a `videoSummary`.

## On screen

### What is on it

One element carries the screen: the fund. Everything else is quiet. In reading order:

1. The cost's name as the heading (`costTitle`), and one muted line: "A four-year cost starting in 8 years".
2. The case buttons. Two to four, one row. Each shows the case title and a derived amount line ("€8,800 a year for 8 years"). One case: no buttons.
3. The answer as a sentence, then one muted support line.
4. The chart.
5. A muted footnote with the assumptions in use.

### The chart

A single drawing, SVG, owned by the module. The **layout is a pure function** (`layoutFutureCostChart(projection, { width })` in `js/future_cost_fund_view.js`, returning plain numbers and boxes) with no DOM in it, so geometry and label collisions are tested in Node.

Coordinates, reference frame 1776 wide:

| Thing | Rule | Reference value |
|---|---|---|
| Year columns | `N = startsInYears + durationYears`. `yearW = (width − gutter) / N` | gutter 96, N 12, yearW 140 |
| `x(t)` | `gutter + yearW × t`. Flows happen on these boundaries. | |
| Plot height | width 1200 and up: 540. 720 to 1199: 420. Under 720: 320. | 540 |
| `yMax` | Smallest of 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^k at or above **peak ÷ 0.8**, where peak is the largest opening balance **over all cases**. The fund never reaches above 80% of the axis, which leaves room for the cost panel header and the labels. Never per case, so the axis does not rescale on a click. | 100,000 at the design fixture, 120,000 at the central defaults |
| Gridlines | Baseline (zero) and one at half of `yMax`. Labelled "€0" and, for 120,000, "€60,000". | |
| Cost panel | Raised surface behind the cost years, `x(startsInYears)` to the right edge, full plot height, radius 12 | x 1216, w 560 |
| Fund | Area at 30% blue, 3px blue line on top | |
| Cost blocks | One per cost year. Left `x(s+k) + inset`, width `yearW − 2 × inset`, where inset is 6 (2 on a phone) and shrinks to 10% of the column in a long run so a block never reaches zero. Top at that year's opening balance, height `cost × scale`. 2px border at 92% text, 8% text fill, radius 4. Amount inside at 22/700 when the block is at least 72px wide, otherwise omitted and listed under the chart. | |
| Axis | Ticks on every boundary, labels centred on them: "Today", "Year 1" … Cost years in full text colour and 700, others muted. The step is the smallest of 1, 2, 5, 10, 20, 50 for which `step × yearW` is at least the width of the widest name, so two names never touch. The year the cost starts is always named, and any name that would crowd it gives way. | step 1 at 1776, 2 at 358 (12 columns) |

The fund polyline has a fixed number of points per case so cases can be interpolated point by point. For each year `t`: the opening balance (before that year's flows), the closing balance (after payment and cost), then 7 interior points `closing × (1 + r)^(k/8)` for k = 1 to 7. Opening and closing share an `x`, which draws the riser. One final point at `x(N)`. That is `N × 9 + 1` points, all clamped at zero.

The cost blocks are computed from the selected case's own rows and must not move between solved cases. Assert it.

### Direct labels

Text is always in text colours, never the series colour. Every label sits on its mark.

- **Lump sum** (when `lumpShare > 0`): "You pay in €86,100 today", starting 14px right of the first riser, 22/700.
- **Yearly** (when `lumpShare < 1`): "You pay in €10,800 a year", or "and €5,400 a year" when the lump label is also showing. Right-aligned, ending 10px left of the anchor year `savingStartsInYears + ceil(n / 2)` (plus 1 when the lump label shows).
- **Placement, in this order.** The yearly label first. Then the lump label against the line. A label's top is the highest pixel row the line reaches under the label's span, minus 46px (30 on a phone), so it never sits on the line however steeply the line climbs. If the lump label would meet the yearly label it is stacked clear above it, and if there is no room above, it sits inside the area just under the riser's top edge. A wording that would reach the cost panel drops "You pay in".
- **Gap** (when no lump sum is paid and `savingStartsInYears > 0`, and the empty years are wide enough to hold it): "Nothing set aside for 3 years" in muted, just above the baseline in the empty years.
- **The fund**: "Your fund, growing 0.13% a year", inside the area, near the baseline, at about the middle of the saving years. The rate is the after-DIRT rate and comes from the model. In a short run it becomes "Your fund", and where even that does not fit it is left out.
- **Cost panel header**: "What you need: €87,200 in total", then a green dot and "Covered by your fund".

### Narrow layout

Frames `PhoneA` and `PhoneA2`. Same drawing, different constants and fewer words:

- Plot 320 high, `yearW` 29, left inset 10, content width 358.
- Blocks 25 wide (`yearW − 4`, left `+2`), no text inside. The yearly amounts go in one muted line under the chart: "The cost by year: year 8 €20,500, year 9 €21,300, year 10 €22,200, year 11 €23,100."
- The cost panel header is three short lines: "What you need", "€87,200", green dot and "Covered". The full "Covered by your fund" moves under the chart.
- Labels drop "You pay in" ("€86,100 today", "€10,800 a year", "and €5,400 a year") at 14/700. The fund label is two lines at 12/600: "Your fund, growing 0.13% a year". The gap label is two lines in a 80px box.
- Axis labels on every second year only. Gridline labels at 11px.
- Case buttons in a 2×2 grid, at least 72 tall, name 15/20, amount 13/18. Headline 20/26, support 14/20.
- Between 720 and 1200 wide, use the desktop layout with the 420px plot. I have only drawn 1920 and 390, so check the rest by eye at 1366×768 and 1024 and tell me what looks wrong rather than guessing.

### Type and colour

Reuse the existing tokens in `styles/base.css`: `--bg-0` #070c10, `--bg-1` #11171c, `--text` #f7f4ee, `--muted` #a9b5bd, `--electric-blue` #6aa7c8, `--accent-green` #66b89e, `--accent-amber`, `--accent-red`. Manrope. Tabular figures on every amount (`font-variant-numeric: tabular-nums`). Radius 12 on surfaces, 8 on controls. New styles go in `styles/base.css` under a `.fcf-` prefix.

- Blue marks the fund and the selected case. Green appears once, the "Covered" dot, and always next to that word. Amber and red are **not used in Stage 1**, because every solved case is covered (see Out of scope).
- Heading 56/64 700 on 1920, 28/34 on a phone. Headline sentence 44/52 700, 20/26 on a phone. Support 22/32 muted. Buttons 22/28 name, 18/24 amount.
- Selected button: raised surface, 1px blue border plus a 1px ring, name at 800. The non-colour cues are the raised fill and the weight, and `aria-pressed`.

### Motion

- One clock for the module: 520ms (`CLICK_MS` in `repayment_case_module.js`), ease-out cubic, **the same acceptance rule as the repayment module**: progress clamped and timed from the first frame, a monotonic token so a stale frame cannot repaint a case the client has left, and a settle timer that is never conditional, because a starved tab never delivers its animation frames.
- What moves: the fund polyline and area (point by point, from what is displayed to the target) and the position of the two payment labels, which follow the line. Nothing else moves. The cost blocks and the cost panel stay put.
- All text changes in the same frame as the click: the headline, the support line, the labels, the button states. Do not count figures up, because the headline sentence changes shape between cases.
- A click while travelling starts from what is currently displayed.
- `prefers-reduced-motion: reduce` means no travel: the new case is drawn at once.
- Do not rebuild the subtree on a click. The elements the client is watching stay put.

### Words

Plain, sentence case, euro with thousands separators, "a year" never "p.a.". It shows what is and what each case would change, nothing else.

Case button amount line, derived:

| Case | Amount line |
|---|---|
| lump sum only | `€86,100 today` |
| yearly only | `€10,800 a year for 8 years` |
| both | `€43,000 today and €5,400 a year` |

Headline, derived. It describes the case and never instructs, the same form as the sibling modules, and the verb is always "covers":

| Case | Sentence |
|---|---|
| lump sum only | `Setting aside €86,100 today covers the whole cost.` |
| yearly only | `Putting in €10,800 a year for 8 years covers the whole cost.` |
| yearly, delayed | `Putting in €17,300 a year for 5 years, starting in year 3, covers the whole cost.` |
| both | `Putting in €43,000 today and €5,400 a year for 8 years covers the whole cost.` |

Support: `You pay in €86,500 and growth adds €700. Together that is the €87,200 you need.` When growth rounds to zero: `You pay in €87,200, which is the whole €87,200 you need.`

Fallback case titles when the payload gives none: `Lump sum today`, `Save every year`, `Part now, part each year`, `Start in {n} years`.

Footnote, from the model and never typed: `€15,000 a year in today’s money. Education costs rise 4% a year. Your savings earn 0.2% a year before DIRT, and 0.13% after DIRT at 33%. Amounts are rounded to the nearest €100.` For a general cost, "Prices rise 2% a year." replaces the education sentence.

Subtitle: "A four-year cost starting in 8 years". Number words for 1 to 10, digits above, and "1 year" not "1 years".

Never: "we recommend", "you should", "best option", "best", "ideal", "optimal", or the name of any product or provider. That includes the two banks. The sources in the assumptions file are for the audit trail and never reach a client-facing string. Test it (below).

### Accessibility

- Case buttons are real `<button>`s in a group with an accessible name, with `aria-pressed`. One case, no group.
- The chart is `role="img"` with an `aria-label` that is the headline plus the support line plus one sentence on the shape. The visible labels are not read twice.
- Touch targets at least 44px.
- Contrast at least 4.5:1 for text, 3:1 at 24px and above.
- Colour never carries meaning alone: green always sits beside "Covered".

### Edge cases

- `startsInYears` 1: one saving year. A yearly case is one payment.
- `durationYears` 1: one block.
- Up to 70 columns (a cost starting in 40 years and running for 30): `yearW` shrinks, axis names thin out by width, block insets shrink and block amounts move to the list under the chart.
- Amounts of €1m and over: axis labels go compact ("€500k"), block labels follow the 72px rule.
- A case that cannot be solved: rejected on the way in, never drawn.
- `costTitle` 60 characters: wraps, never truncates.
- Growth that rounds to zero: the zero-growth support sentence, and the fund label still names the rate.

## Wiring a new engine module

This is the list the next engine modules follow, instead of their own briefs' lists. It is every file this module touched, in the order it was done, with what each one needed. Each step ended with the module's own check green and its own commit, so a mistake is found one file after it was made.

Two things to know first.

- **Copy the pattern, do not abstract it.** Eight files each keep their own list of engine keys, and each engine key clears every other one. A new module adds a line to each list. Resist a shared registry in the same change: it is a refactor of every existing module, and it belongs in its own pull request.
- **`check:no-stale-exports` is a ratchet.** Anything exported that nothing outside its file imports fails it. Export a helper only when a second file uses it.

| # | File | What it needed |
|---|---|---|
| 1 | `js/planning/planeir_assumptions.js` | Only if the module needs a rate that is not central yet. A new entry with a `basis`, a `disclosure` and its sources for the audit trail, a version bump and `APPROVED_ON`, an `assumptionRecord` key, and an `ASSUMPTION_LABELS` entry. The basis must not name a provider. |
| 2 | `js/planning/tax/rules_ie.js`, `js/planning/tax/resolve.js`, `js/tests_ie_tax.js` | Only if the module needs a statutory rate. A new block in the year's rules with a `ruleId` and a source, an `IE_TAX_RULES_VERSION` bump, **and** the field added to `buildResolvedRules`, which lists what it returns explicitly, so a new block is invisible until it is added there. A test that the rate resolves, is held forward, and that changing it moves nothing else. |
| 3 | `scripts/fixtures/module-catalogue-authoring-identity.json` | Follows an assumptions version bump: the version appears in the reason strings. |
| 4 | `js/<module>_math.js` | The engine. A normaliser that throws with `generated.<key>.<field>` messages and refuses what must come from central assumptions. **Any client-facing text the payload supplies (case titles, descriptions, labels) is checked against the module's banned wording here, on the way in, not only in a test.** A module with a hard limit on wording does not take `generated.summaryHtml` from a payload at all, because every surface shows it (focused view, overview card, presenter) and a written summary cannot be checked reliably. The engine writes it from its own answers (`protectionGapSummaryHtml`, escaped) and the apply function sets it on paste, on a summary sent on its own, on import in `state.js` and on load. A saved summary is cleared when its inputs cannot be read, so it never stays on the generic module left behind. The inline editor refuses it and the summary card is read-only. If the base case has a meaning (today, with no event), the normaliser enforces it. A projection returning `assumptionsTable`, `outputsTable`, `tables`, `charts` and `debug`. `get…Cases` and `getDefault…ScenarioId` for the presenter. The case cap from `js/scenario_cap.js`. An options argument for test injection that a payload cannot reach. |
| 5 | `js/tests_<module>_math.js`, `scripts/check-<module>.mjs`, `package.json` | The unit suite, a reference calculator that imports nothing from the engine, and the `check:<module>` script. |
| 6 | `js/<module>_view.js` | Everything the screen decides that is not a DOM node: the words, the geometry for any container width, and where each label sits, with the checks that nothing overlaps. Pure, so a check can ask it without a browser. |
| 7 | `js/tests_<module>_view.js` | Copy, words scan, axis, blocks, label collisions at 358, 720, 1000 and 1776 wide over several payload shapes. |
| 8 | `js/<module>_module.js` | The drawing: `build<Module>Module({ rawInputs, selectedCaseId, onSelectCase })` returning an element or `null`. The 520ms clock as a factory that takes its timers (token, settle timer, finished flag). `presenterSelectScenario(id)` on the root. No subtree rebuild on a click. Reduced motion read at click time. |
| 9 | `styles/base.css` | A block under the module's own prefix, in the brand tokens at the top of the file. |
| 10 | `dev/<module>-preview.html` | The module alone, with `?preset=` for the central figures, the design figures and the edge shapes. |
| 11 | `js/tests_<module>_module.js` | The clock and the module run against a small DOM shim and fake time: a starved tab, a late frame, a click mid-travel, reduced motion, and after any sequence of clicks a screen equal to a fresh render of the last case. |
| 12 | `js/state.js` | `createEmptyGenerated`; a tolerant session importer that cuts cases with `capImportedEngineCases` (which keeps the base case among the cases kept), drops what the engine refuses with a warning, and never throws; the key in `RUNTIME_OWNED_INPUT_KEYS`, so a payload that cannot be read takes its stored tables and charts with it; the key in `normalizeGenerated`; the new module's `null` in **every higher-priority branch** of the exclusion chain, and its own branch at the end that derives `assumptions`, `outputs`, `tables` and `charts`; and `<module>ScenarioId` in `normalizeModuleUi`. |
| 13 | `js/module_pipeline.js` | **Not in the first brief.** The import; the apply function that derives the tables and records the projection; a refresh in `ensureGenerated`, because the engine reads central assumptions that move between save and open; the validator; the key in `normalizePayload`; the new module's `null` in **every list that clears the other engine modules** and a branch of its own in `mergeGeneratedPatch`; and the branch in `applyNormalizedPayloadToModule`. The Dev Panel and `check-case-pack.mjs` both run this file. |
| 14 | `js/app.js` | The in-memory map, its reset on a new session and its entry in the presenter snapshot's `mapKeys`; get and set for the selected case (remember, persist on `ui`, forget a case the payload no longer has, read-only guard); `window.__set…Scenario` and `window.__get…ScenarioForModule`; **the presenter hook, `setScenario`'s kind list, which was not in the first brief and throws for an unknown kind**; the Dev Panel example payload; `hasCalculatedGeneratedOutputs`; the lists that clear the other engines; and the module's id in `getCodexVideoActiveScenarios` and the scene manifest's `activeScenario`. |
| 15 | `js/render.js` | The import; `is<Module>Module`; the label and token; the overview line; the heading; `blocksGeneratedTableEditing`; a shell builder beside `buildMortgageScenarioShell`; the mount in the generic grid; a read-only summary card when the engine writes the summary (row 4); no charts card, in the grid and in the patch path (`patchCharts`), or the card reappears after the first click. |
| 16 | `js/presenter_catalogue.js` | The kind in `moduleKind`, the cases in `scenarios`, and the default case. Case ids must be stable. |
| 17 | `js/video_scene.js`, `js/codex_video_brief.js` | The kind and label; a resolve branch that shows the selected case's own figures (the figures that add up first, because a story shows three) and its own chart; the scenario key in `normalizeScenarioSelection`. A video chart keeps 14 points: a longer chart goes through `sampleChartAcross`, keeping the points that matter, or the video cuts it off. |
| 18 | `js/tests_<module>_wiring.js` | The paste pipeline accepts it and derives its tables; a rate or a fifth case is refused with the engine's message; setting it clears the others and the reverse; load refreshes; an import tolerates too many cases, including one whose base was cut; an unreadable import clears stored figures; the presenter catalogue lists it. |
| 19 | `scripts/check-video-scene.mjs`, `scripts/check-codex-video-brief.mjs` | A case each, with a model-supplied output that must be replaced. |
| 20 | `.github/workflows/consumer-regression.yml`, `.github/workflows/deploy-worker.yml` | `npm run check:<module>` beside `check:house-purchase`. |
| 21 | `docs/<module>-app-change.md` | Build status, what differs from the brief, and this list. The contract summary goes in the pull request description. **Do not edit `docs/prompt-pack/`**: the playbook is written from the contract summary once the module lands. |

Rows 4, 12, 15, 17 and 18 were tightened on 15 October 2026 from Codex's reviews of the first modules. The shared fixes are in `state.js` and `video_scene.js` already; a new module only has to use them.

What this list deliberately does not include, because a first release does not need it: `js/planning/module_registry.js`, the module manifest and playbook, consumer routing and the planner's facts. They are the consumer stage, and they come with a reviewed intake contract.

## Tests

Two fixtures, both proved against a reference calculator.

**Central defaults**: an education cost, 15,000 a year, starting in 8 years, for 4 years, with nothing injected. Prices 4%, cash 0.2% gross, 0.134% after DIRT.

| | Case 1 | Case 2 | Case 3 | Case 4 |
|---|---|---|---|---|
| Lump sum today | 86,100 | none | 43,000 | none |
| Yearly | none | 10,800 for 8 | 5,400 for 8 | 17,300 for 5 |
| You pay in | 86,100 | 86,500 | 86,300 | 86,600 |
| Growth | 1,100 | 700 | 900 | 600 |

The yearly costs are 20,500, 21,300, 22,200 and 23,100, total 87,200, and the opening balance when the cost starts is about 87,000 in all four cases.

**Design fixture**, injected through the options argument (prices 3%, cash 2% with DIRT set to 0, because the design assumed savings grow 2% and nothing came off it), which is what the design frames were drawn from:

| | Case 1 | Case 2 | Case 3 | Case 4 |
|---|---|---|---|---|
| Lump sum today | 65,800 | none | 32,900 | none |
| Yearly | none | 8,800 for 8 | 4,400 for 8 | 14,500 for 5 |
| You pay in | 65,800 | 70,500 | 68,200 | 72,700 |
| Growth | 13,700 | 9,000 | 11,300 | 6,800 |

Costs 19,000, 19,600, 20,200 and 20,800, total 79,500, opening balance at the cost start about 77,100.

1. **Reference calculator.** In `scripts/check-future-cost-fund.mjs`, a separate calculator that imports nothing from the engine and rebuilds each case year by year from first principles, as `check-college-funding-audit.mjs` does. Every figure in both tables equals it.
2. **Invariants over every case in every fixture.** The closing balance in the last cost year is within €0.01 of zero. The balance never goes negative. Opening balance at the cost start is identical across solved cases. `paidIn + growth` equals the total cost.
3. **Rate sources.** With nothing injected: an education cost uses 4%, a general cost uses 2%, the cash rate is the central 0.2% and the net rate is exactly `0.2% × (1 − DIRT)` with DIRT read from `resolveTaxRules`. The footnote and `assumptionsUsed` name the values and both versions. Change the DIRT rule in a test catalogue and the fund follows it, which proves the engine holds no copy.
4. **Rejections** with the exact messages: fifth case, duplicate id, unknown key, delayed start at or after the cost start, bad `baseScenarioId`, out-of-range share, missing or invalid `costKind`, and any rate field in the payload.
5. **Layout, in Node.** For all four cases of both fixtures at 1776 and at 358 wide, no two direct labels overlap, no label box is crossed by the line, the peak is at most 80% of `yMax`, and all boxes sit inside the container. Cost blocks are identical across the four cases.
6. **Motion discipline.** After any sequence of clicks, including a rapid one and one in a throttled tab, the drawn state equals a fresh render of the last case, and no two figures on the screen disagree.
7. **Words.** Render all four cases and scan the visible text and `aria-label`s for the banned phrases, a bank or provider name, "p.a.", and any amount without a thousands separator.
8. **Wiring.** Presenter case selection by id, the video scene and the codex video brief each resolve the selected case's figures. Extend `check-video-scene.mjs` and `check-codex-video-brief.mjs`.
9. **The catalogue change.** The Irish tax golden cases all still pass unchanged, and a new test reads `resolveTaxRules(2026).dirt.rate` and `resolveTaxRules(2031).dirt.rate`, both 0.33, the second marked held forward.

Before finishing, run `npm run build`, `npm run check:future-cost-fund`, `check:planeir-assumptions`, the Irish tax suites via `scripts/run-pension-math-tests.mjs`, `check:video-scene`, `check:codex-video-brief`, `check:consumer-session-payload` and `check:college-funding-audit`.

## Out of scope

- **Stated amounts.** "What if I save €5,000 a year?" needs states that are not designed: covered with money left over (green), tight (amber), short (red). Amounts the client states never reach this engine in Stage 1. If they arrive, reject. I will draw those frames before they are built.
- **Where the money is held.** Cash at 0.13% is the only rate here. The central 5% invested rate exists, but showing a cost funded from an invested pot is a different promise to the client and needs its own decision and disclosure. It would fit as a second dimension on a case. Not in this change.
- **Aligning house purchase.** `js/house_purchase/config.js` carries a 2% gross deposit default (1.34% after DIRT) and its own 33%, verified 2026-07-11 against regular-saver products. That is not the central cash rate. Moving it changes house purchase deposit timelines, so it is a separate change with its own review. Flagged, not done.
- **DIRT exemptions and special accounts.** Over-65 and incapacity exemption, Special Savings Incentive Accounts and the like. Say in the assumptions table that DIRT is applied at the standard rate.
- A bridge from `college_funding` (feeding its annual cost series in as a dated cost), and any change to the college module or its inflation default.
- Consumer routing, voice, planner facts, manifest, playbook and goal catalogue entries. Follow the retirement precedent: do not edit `docs/prompt-pack/`. The playbook, aliases, matrix and master prompt are updated separately once this lands, so they describe what the code does.
- Tax beyond DIRT on interest. Grants, wrappers and anything on the way out are not modelled. Say so in the assumptions table.
- Money already set aside for the cost.
- Redrawing the design frames at the central numbers. Worth doing before the chart is polished, because the fund line is nearly flat, but it is a design task, not a build one.

## When you finish

End with a contract summary for the prompt pack: field names, the model and its timing convention, where each rate comes from, the rounding rule, every validation string, the derived copy templates, and the Dev Panel example. Keep to the repo's commit style: short plain-English commits describing what the client sees change.
