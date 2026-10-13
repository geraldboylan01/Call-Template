# Future cost fund: a dated cost, and the ways to have the money ready

Status: design chosen (option A, "the hill"), assumptions settled 2026-10-13. **Engine, central assumptions and DIRT rule built (branch `module/future-cost-fund`); screen and wiring not started.** Stage 1 only.

## Build status

Built, in this order, with every figure in the Tests tables reproduced to the nearest €100:

- `js/planning/planeir_assumptions.js`: the `cash` entry (0.2% gross), `assumptionRecord('cashRate')`, the `cashGrowthRate` label, version `planeir-assumptions-1.3.0`, approved 2026-10-13.
- `js/planning/tax/rules_ie.js` and `resolve.js`: the `dirt` block (33%, `ie.dirt.2026`) and `IE_TAX_SOURCES.revenueDirt`. Main was already on `ie-tax-2026.2` when this landed (PR #54, capital gains tax), so `IE_TAX_RULES_VERSION` is `ie-tax-2026.3`. The capital gains entries are untouched. The catalogue fixture `scripts/fixtures/module-catalogue-authoring-identity.json` follows the assumptions version bump.
- `js/future_cost_fund_math.js`: `normalizeFutureCostFundInputs`, `computeFutureCostFundProjection(rawInputs, { assumptions, calculationYear, taxCatalogue })`, `getFutureCostFundCases`, `getDefaultFutureCostFundScenarioId`. `taxCatalogue` is a second injection point beside `assumptions`, so a test can change the DIRT rule and watch the fund follow it.
- `js/tests_future_cost_fund_math.js` (12 cases) and `scripts/check-future-cost-fund.mjs`, which proves the engine against a reference calculator that imports nothing from it and finds every amount by bisection. `npm run check:future-cost-fund`. The projection accepts a cost starting within 40 years, keeping each case to at most 70 annual rows with the 30-year cost duration limit.
- Two DIRT tests in `js/tests_ie_tax.js`: 33% in 2026, held forward unchanged in 2031, and a changed catalogue rate moves nothing else.

Differences from this brief:

- `PLANEIR_ASSUMPTIONS.cash.basis` does **not** name the two banks. The brief's own rule is that no provider name reaches a client-facing string, and `assumptionRecord('cashRate').reason` is built from `basis`. The banks, rates, effective dates and URLs are in `cash.observed`, for the audit trail only. A test scans for it.
- The model's rows are `{ yearIndex, openingBalance, payment, cost, closingBalance }` as specified. `openingBalance` is the previous closing balance grown by one year at the net rate.
- DIRT was re-checked on Revenue's page on 2026-10-13: 33%, "Published: 24 April 2026". Budget 2027 coverage found did not mention DIRT. Revenue's page is the source; the Finance documents were not read.

Not built: the screen, the layout function, motion, words, `state.js`/`render.js`/`app.js`/presenter/video wiring, the dev preview, and listing `check:future-cost-fund` in `.github/workflows/consumer-regression.yml` and `deploy-worker.yml`. `npm run build`, `check:video-scene` and `check:codex-video-brief` are untouched by this change and were not rerun here.

One failure that predates this work: `scripts/check-module-catalogue-authoring.mjs` fails on a migration filename (`0019_add_application_voice_notes.sql` against the expected `0018_add_agent_application_requests.sql`), identically on unmodified `main`.

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

Everything the module needs is a **central** Planéir assumption, so every module and every adviser reads the same number. Nothing is typed into the payload.

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

There are no rate fields. A payload that carries `priceGrowthRate`, `savingsGrowthRate`, `inflationRate` or `dirtRate` is rejected: `generated.futureCostFundInputs.priceGrowthRate is not accepted. Rates are set centrally in the Planéir assumptions.`

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

A single drawing, SVG, owned by the module. Build the **layout as a pure function** (`layoutFutureCostChart(model, width)` returning plain numbers and boxes) and keep DOM out of it, so geometry and label collisions can be tested in Node.

Coordinates, reference frame 1776 wide:

| Thing | Rule | Reference value |
|---|---|---|
| Year columns | `N = startsInYears + durationYears`. `yearW = (width − gutter) / N` | gutter 96, N 12, yearW 140 |
| `x(t)` | `gutter + yearW × t`. Flows happen on these boundaries. | |
| Plot height | width 1200 and up: 540. 720 to 1199: 420. Under 720: 300. | 540 |
| `yMax` | Smallest of 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^k at or above **peak ÷ 0.8**, where peak is the largest opening balance **over all cases**. The fund never reaches above 80% of the axis, which leaves room for the cost panel header and the labels. Never per case, so the axis does not rescale on a click. | 100,000 at the design fixture, 120,000 at the central defaults |
| Gridlines | Baseline (zero) and one at half of `yMax`. Labelled "€0" and, for 120,000, "€60,000". | |
| Cost panel | Raised surface behind the cost years, `x(startsInYears)` to the right edge, full plot height, radius 12 | x 1216, w 560 |
| Fund | Area at 30% blue, 3px blue line on top | |
| Cost blocks | One per cost year. Left `x(s+k) + 6`, width `yearW − 12`, top at that year's opening balance, height `cost × scale`. 2px border at 92% text, 8% text fill, radius 4. Amount inside at 22/700 when the block is at least 72px wide, otherwise omitted and listed under the chart. | |
| Axis | Ticks on every boundary, labels centred on them: "Today", "Year 1" … Cost years in full text colour and 700, others muted. Thin to every second label when `yearW` is under 56. | |

The fund polyline has a fixed number of points per case so cases can be interpolated point by point. For each year `t`: the opening balance (before that year's flows), the closing balance (after payment and cost), then 7 interior points `closing × (1 + r)^(k/8)` for k = 1 to 7. Opening and closing share an `x`, which draws the riser. One final point at `x(N)`. That is `N × 9 + 1` points, all clamped at zero.

The cost blocks are computed from the selected case's own rows and must not move between solved cases. Assert it.

### Direct labels

Text is always in text colours, never the series colour. Every label sits on its mark.

- **Lump sum** (when `lumpShare > 0`): "You pay in €86,100 today", starting 14px right of the first riser, 22/700.
- **Yearly** (when `lumpShare < 1`): "You pay in €10,800 a year", or "and €5,400 a year" when the lump label is also showing. Right-aligned, ending 10px left of the anchor year `savingStartsInYears + ceil(n / 2)` (plus 1 when the lump label shows).
- **Placement**: a label's top is the highest pixel row the line reaches under the label's span, minus 46px, so it never sits on the line however steeply the line climbs.
- **Gap** (when `savingStartsInYears > 0`): "Nothing set aside for 3 years" in muted, just above the baseline in the empty years.
- **The fund**: "Money in the fund, growing 0.13% a year", inside the area, near the baseline, at about the middle of the saving years. The rate is the after-DIRT rate and comes from the model.
- **Cost panel header**: "The cost: €87,200 in total", then a green dot and "Covered by the fund".

### Narrow layout

Frames `PhoneA` and `PhoneA2`. Same drawing, different constants and fewer words:

- Plot 300 high, `yearW` 29, left inset 10, content width 358.
- Blocks 25 wide (`yearW − 4`, left `+2`), no text inside. The yearly amounts go in one muted line under the chart: "The cost by year: year 8 €20,500, year 9 €21,300, year 10 €22,200, year 11 €23,100."
- The cost panel header is three short lines: "The cost", "€87,200", green dot and "Covered". The full "Covered by the fund" moves under the chart.
- Labels drop "You pay in" ("€86,100 today", "€10,800 a year", "and €5,400 a year") at 14/700. The fund label is two lines at 12/600: "In the fund, growing 0.13% a year". The gap label is two lines in a 80px box.
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

Headline, derived (the verb agrees: "covers" for one thing, "cover" for two):

| Case | Sentence |
|---|---|
| lump sum only | `€86,100 set aside today covers the whole cost.` |
| yearly only | `€10,800 a year for 8 years covers the whole cost.` |
| yearly, delayed | `€17,300 a year for 5 years, starting in year 3, covers the whole cost.` |
| both | `€43,000 today and €5,400 a year for 8 years cover the whole cost.` |

Support: `You pay in €86,500 and growth adds €700. Together that is the €87,200 the cost needs.` When growth rounds to zero: `You pay in €87,200, which is the whole €87,200 the cost needs.`

Fallback case titles when the payload gives none: `Lump sum today`, `Save every year`, `Part now, part each year`, `Start in {n} years`.

Footnote, from the model and never typed: `€15,000 a year in today's money. Education costs rise 4% a year. Savings earn 0.2% a year before DIRT and 0.13% after DIRT at 33%. Amounts are rounded to the nearest €100.` For a general cost, "Prices rise 2% a year." replaces the education sentence.

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
- 25 or more columns: `yearW` shrinks, axis labels thin out, block amounts move to the list under the chart.
- Amounts of €1m and over: axis labels go compact ("€500k"), block labels follow the 72px rule.
- A case that cannot be solved: rejected on the way in, never drawn.
- `costTitle` 60 characters: wraps, never truncates.
- Growth that rounds to zero: the zero-growth support sentence, and the fund label still names the rate.

## Wiring

Follow the mortgage wiring, one file at a time, and resist a shared refactor in this change.

- Central assumptions first (above): `js/planning/planeir_assumptions.js`, `js/planning/tax/rules_ie.js`, `js/planning/tax/resolve.js`.
- `js/state.js`: `futureCostFundInputs` in `createEmptyGenerated`, `normalizeGenerated` (including the mutual exclusions and the `videoSummary` clearing), and `futureCostFundScenarioId` in `normalizeModuleUi`.
- `js/render.js`: an `isFutureCostFundModule` check where `isCollegeFundingModule` is checked, and the mount, in the manner of `buildMortgageScenarioShell`. The assumptions and outputs cards still render from the engine's tables.
- `js/app.js`: selected-case get and set with persistence and the read-only guard, a Dev Panel example payload using the four sample cases, and `hasCalculatedGeneratedOutputs`.
- `js/presenter_catalogue.js`: kind, cases and default case, with stable ids.
- `js/video_scene.js` and `js/codex_video_brief.js`: kind, label and the selected case's figures.
- `dev/future-cost-fund-preview.html`, in the manner of `dev/repayment-module-preview.html`, with `?cases=` and `?preset=` parameters for the central defaults, the design fixture, a general cost and a 25-column case.
- `package.json`: `check:future-cost-fund`, `scripts/check-future-cost-fund.mjs`, listed wherever `check:house-purchase` is listed, including `.github/workflows/consumer-regression.yml` and `deploy-worker.yml`.

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
