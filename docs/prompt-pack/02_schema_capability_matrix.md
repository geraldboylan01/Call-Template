# Prompt Pack Schema and Capability Matrix

This file is a reference source of truth for the prompt pack. It mirrors the current app validators and renderers and is not meant to be pasted into ChatGPT as part of the live prompt by default.

## Top-Level Payload Shape

```json
{
  "moduleId": "optional string",
  "title": "optional string",
  "generated": {}
}
```

- `moduleId`: optional non-empty string.
- `title`: optional string.
- `generated`: optional object, but the payload must include at least one of `title` or `generated`.

## Supported `generated` Keys
- `summaryHtml`
- `assumptions`
- `outputs`
- `outputsBucketed`
- `tables`
- `pbsInputs`
- `liquidityPlan`
- `charts`
- `pensionInputs`
- `netRetirementInputs`
- `housePurchaseInputs`
- `mortgageInputs`
- `loanInputs`
- `education`
- `report`

Playbooks should only emit the subset they are responsible for.

## Table Support
- Canonical table shape:

```json
{
  "columns": ["Column A", "Column B"],
  "rows": [["Row 1", 123]]
}
```

- `generated.assumptions` and `generated.outputs` both use this shape.
- `generated.assumptions` must never be a plain key-value object or label/value object array.
- `generated.tables` is supported by the runtime, but playbooks should only use it when explicitly helpful.
- `generated.outputsBucketed.sections[*].columns` supports exactly 2 columns.
- `generated.outputsBucketed.sections[*].rows[*]` must be exactly `[string, number]`.
- `generated.outputsBucketed` numeric cells must be numbers, not formatted currency or unit strings.
- Use `€`, not `EUR`, in Irish euro-facing headings and metric strings. Currency numeric fields still stay as plain numbers.
- Do not tag counts, ages, years, durations, percentages, or rates as currency.

## Chart Support
- Supported chart types: `bar`, `line`
- Mixed charts are supported by setting `datasets[*].type` to `bar` or `line`.
- For stacked mixed charts, use `display.stacked = true` and optional `datasets[*].stack` labels on bar datasets.
- Dataset values must be numbers.
- Labels may be strings.
- Optional chart presentation fields:
  - `subtitle`: short client-facing chart context.
  - `display.variant`: `hero`, `wide`, or `compact`.
  - `display.valueFormat`: `currency`, `percent`, or `number`.
  - `display.xAxisTitle` / `display.yAxisTitle`: concise axis labels.
  - `display.showLegend`: boolean.
  - `display.stacked`: boolean for stacked bar presentation.
  - `display.highlightDataset`: dataset label to visually emphasize.
  - `display.yMin` / `display.yMax`: numeric hard bounds for the y-axis.
  - `display.suggestedMin` / `display.suggestedMax`: numeric soft bounds for the y-axis.
  - `annotations[]`: trusted chart guide metadata with `label`, optional `xLabel`, optional numeric `yValue`, optional `tone`, and optional `body`.
  - `insights[]`: concise metric card objects below the chart with `label`, optional `value`, optional `detail`, optional `tone`, and optional `featured`. Do not emit strings inside `insights[]`.
- Chart metadata is rendered by trusted components only. Do not emit Chart.js options, plugins, callbacks, HTML, or JavaScript.

## Scenario Limits
- A module renders at most 4 selectable cases, counting the base case already on screen.
- PBS: `Current position` is case 1, so `generated.outputsBucketed.scenarios` holds at most 3 alternatives.
- Retirement: `generated.pensionInputs.rentalIncomeScenarios` holds at most 4 cases.
- Net Retirement Cash Flow: `generated.netRetirementInputs.scenarios` holds at most 4 cases.
- College Funding: `generated.collegeFundingInputs.scenarios` holds at most 4 cases, which is exactly what the at-home / away-from-home shorthand produces. Do not combine the shorthand with an explicit `scenarios` array.
- Case `id` values must be unique inside a module. A repeated id breaks case selection.
- Every case carries its own fully recalculated figures. Nothing is inherited from the case before it.
- An over-limit payload is rejected with a validation error naming the module and the case count, rather than rendering a partial set.
- Validator status: the cap is a prompt-pack rule today. The matching hard rejection in the payload validators is a pending app change; until it ships, an over-limit payload renders extra cases instead of failing.

## PBS Support
- Preferred output path: `generated.outputsBucketed`
- Optional inputs path: `generated.pbsInputs`
- `generated.outputs` should be omitted by the PBS playbook.
- `generated.assumptions` is supported, but PBS should usually omit it unless Gerry explicitly asks to override the scaffold.
- PBS must use `generated.summaryHtml` and `generated.outputsBucketed`; do not invent `generated.summary`, `generated.metrics`, `generated.buckets`, `generated.assets`, or `generated.liabilities` as the primary app contract.
- PBS `outputsBucketed.sections` must include the six standard sections in order: `lifestyle`, `liquidity`, `longevity`, `legacy`, `liabilities`, `summary`.
- The summary section must use `key: "summary"` and the exact rows `Gross assets`, `Total liabilities`, and `Net worth`; use `Net worth` as the row label and subtotal label even when the values are known-values-only.
- PBS alternatives belong in `generated.outputsBucketed.scenarios[]`; every scenario must contain fully recalculated sections, including its own `summary` section with the exact `Net worth` label.
- `generated.outputsBucketed.scenarios` holds at most 3 alternatives. `Current position` is case 1 of the 4-case limit and is never listed in `scenarios`.
- PBS `movements` are optional animation metadata. Use canonical actions only: `add`, `reduce`, `increase`, or `remove`. Prefer exact `rowLabel` values that match the visible source or destination rows.

## Pension Support
- Use `generated.pensionInputs`
- Runtime-supported keys:
  - `currentAge`
  - `retirementAge`
  - `currentSalary`
  - `currentPot`
  - `personalPct`
  - `employerPct`
  - `growthRate`
  - `targetIncomeToday`
  - `targetIncomePctOfSalary`
  - `inflationRate`
  - `wageGrowthRate`
  - `horizonEndAge`
  - `currentYear`
  - `incomeMode`
  - `affordableEndAges`
  - `minDrawdownMode`
  - `rentalIncomeToday`
  - `baseScenarioId`
  - `rentalIncomeScenarios`
  - `pensions`
  - `incomeStartYear`
  - `targetStartYear`
  - `targetStartAge`
  - `horizonEndYear`
  - `requiredPotReferenceYear`
  - `includeStatePension`
  - `includeEmploymentIncomeDuringBridge`
  - `otherIncomeSources`
- The runtime supplies defaults for omitted `inflationRate`, `wageGrowthRate`, `horizonEndAge`, `currentYear`, and `minDrawdownMode`; pension target-mode defaults to depleting by age 100, and household mode defaults the horizon to the later member's age-100 calendar year.
- `rentalIncomeToday` is gross annual rent in today's money and defaults to `0`.
- `rentalIncomeScenarios` enables pension case switching. Each item should include `id`, `title`, and `rentalIncomeToday`; `baseScenarioId` selects the first visible case.
- `rentalIncomeScenarios` holds 2 to 4 cases, ordered from most rental income to least. Rent level is the only lever these cases change.
- `pensions[]` enables couple/household retirement projections. Each item should include `id`, `title`, ages, salary, pot, and contribution percentages.
- Couple payloads should also include legacy top-level pension keys for compatibility. Use the first member's ages, household totals for salary/current pot, and salary-weighted household contribution percentages; the runtime uses `pensions[]` for the actual household maths.
- `incomeStartYear` can anchor the first household drawdown year for staggered retirements; `requiredPotReferenceYear` can anchor the later combined-pot reference year. If omitted in household mode, the runtime defaults to earliest and latest member retirement years respectively.
- `includeEmploymentIncomeDuringBridge` controls whether still-working members' gross salary is included between the first and later retirement dates; it defaults to `true` only when household retirement years are staggered.
- State Pension is included by default per pension member; set `includeStatePension: false` to exclude a person.
- `otherIncomeSources[]` supports DB pensions and similar named income; `inflationIndexed` must be explicit. If using `startAge`/`endAge`, `ownerId` may be a pension member id or `"household"` to anchor the age to the primary pension member.

## Net Retirement Cash Flow Support
- Use `generated.netRetirementInputs`.
- Runtime-supported keys:
  - `currentYear`
  - `currentAge`
  - `horizonEndAge`
  - `annualExpenditureToday`
  - `expenditureInflationRate`
  - `presentValueRate`
  - `availableInvestmentFundToday`
  - `currencySymbol`
  - `planningNote`
  - `taxCompatibilityNote`
  - `incomeSources`
  - `baseScenarioId`
  - `scenarios`
- `annualExpenditureToday` is the household net spending need in today's money.
- The runtime defaults `horizonEndAge` to age 100 and uses client age for chart x-axis labels.
- `presentValueRate` is the after-tax net growth or discount rate used to convert future annual net shortfalls into the required net fund today.
- `incomeSources[]` supports named net income sources with `id`, `title`, `annualAmountToday`, optional `type`, `startAge` or `startYear`, optional `endAge` or `endYear`, and `inflationIndexed`.
- Scenario switching is supported through `scenarios[]`. Each scenario supports `id`, `title`, optional `description`, optional `availableInvestmentFundToday`, optional `annualExpenditureToday`, `excludedIncomeSourceIds[]`, `incomeSourceOverrides[]`, and `additionalIncomeSources[]`.
- `scenarios[]` holds at most 4 cases. Each case states its own fund and expenditure wherever they differ; nothing carries over from the previous case, and `excludedIncomeSourceIds` always refers to ids in `incomeSources[]`.
- The runtime calculates `generated.assumptions`, `generated.outputs`, `generated.tables`, and `generated.charts`; the playbook should not hand-build those fields.
- Required fund outputs are after-tax net figures. Do not compare them directly with pension balances or gross pension withdrawals unless pension withdrawal tax has been allowed for separately.

## Liquidity Support
- Use `generated.liquidityPlan`.
- This is a cash-only module. Do not use PBS `outputsBucketed`, net worth, or broader asset sections for this playbook.
- Runtime-supported keys:
  - `currencySymbol`
  - `clientStatus` (`"not-retired"` or `"retired"`)
  - `annualExpenditure`
  - `monthlyExpenditure`
  - `currentCash`
  - `cashItems`
  - `minimumBufferMonths`
  - `targetBufferMonths`
  - `headline`
  - `primaryActionLabel`
  - `primaryActionDetail`
  - `evidenceCards`
  - `nextSteps`
- `cashItems[]` supports `{ "label": string, "amount": number }`; the runtime can derive `currentCash` from those rows if `currentCash` is omitted.
- Working threshold defaults are red under 3 months, yellow from 3 to under 6 months, and green at 6+ months.
- Retired threshold defaults are red under 12 months, yellow from 12 to under 24 months, and green at 24+ months.
- Above target, the renderer names the excess as surplus cash to assign, rather than showing a broad PBS-style green bucket.
- `evidenceCards[]` supports `label`, `value`, `detail`, `sourceLabel`, `sourceUrl`, and optional `tone`.

## College Funding Support
- Use `generated.collegeFundingInputs`.
- Runtime-supported keys:
  - `currentYear`
  - `children`
  - `childrenCount`
  - `childCurrentAge`
  - `collegeStartAge`
  - `collegeDurationYears`
  - `inflationRate`
  - `currencySymbol` (`€` for Irish euro planning, not `EUR`)
  - `planningNote`
  - `scenarios`
- Use `children[]` whenever children have different current ages, different college start ages, or different course durations. Legacy shared-age fields may continue to be used where all children have identical timing.
- When valid `children[]` is present, the runtime uses it, derives `childrenCount` from `children.length`, and does not combine it with `childrenCount`.
- Each child supports:
  - `id`
  - `title`
  - `currentAge`
  - `collegeStartAge`
  - `collegeDurationYears`
- Each scenario supports:
  - `id`
  - `title`
  - `category`
  - `annualCostTodayPerChild`
  - `oneOffCostTodayPerChild`
  - `interpretation`
  - `tone`
- Shorthand at-home/away inputs are also supported: `atHomeAnnualCostTodayPerChild`, `awayAnnualCostTodayPerChild`, and `carSupportTodayPerChild`. These produce four standard scenarios, which fills the 4-case limit, so do not send them alongside an explicit `scenarios` array.
- The runtime validates unique child ids, non-negative current ages, start age greater than current age, positive durations, non-negative inflation, and plain numeric money inputs.
- The runtime calculates `generated.assumptions`, `generated.outputs`, `generated.tables`, and `generated.charts`; the playbook should not hand-build those fields.

## House Purchase Support
- Use `generated.housePurchaseInputs`.
- The only other supported `generated` key for this playbook is `summaryHtml`.
- Do not combine it with `generated.assumptions`, `generated.outputs`, `generated.outputsBucketed`, `generated.tables`, `generated.charts`, `generated.education`, `generated.report`, or another engine-input key.
- Runtime-supported top-level input keys:
  - `schemaVersion`
  - `calculationDateIso`
  - `lendingCategory`
  - `applicationType`
  - `applicants`
  - `currentCashSavings`
  - `cashSavingsContributions`
  - `amountRingfencedForOtherGoals`
  - `emergencyReserveMode`
  - `emergencyReserveTarget`
  - `currentMonthlySavings`
  - `plannedMonthlySavings`
  - `lumpSums`
  - `monthlyNetHouseholdIncome`
  - `monthlyEssentialExpensesExcludingHousingDebtAndRent`
  - `currentMonthlyRent`
  - `dependants`
  - `otherKnownMonthlyCommitments`
  - `estimatedMonthlyOwnershipCosts`
  - `targetPropertyPrice`
  - `targetPurchaseDate`
  - `acquisitionType`
  - `dwellingType`
  - `intendedUse`
  - `localAuthorityCode`
  - `tenantNoticeReceived`
  - `lenderCapacity`
  - `depositSavingsGrossAer`
  - `dirtRate`
  - `mortgageIllustrationRate`
  - `mortgageTermYears`
  - `purchaseCosts`
  - `helpToBuy`
  - `firstHomeScheme`
- `lendingCategory` is exactly `first_time_buyer`, `second_or_subsequent`, or `unknown`. It controls the Central Bank income-limit illustration only.
- `applicationType` is exactly `single` or `joint`; `applicants` must contain one or two records accordingly.
- Each applicant supports `id`, `label`, `age`, `employmentStatus`, `grossAnnualIncome`, `variableAnnualIncome`, `lenderRecognisedVariableAnnualIncome`, `incomeReliability`, `existingMonthlyDebtPayments`, `schemeBuyerStatus`, `freshStartReason`, `previouslyOwnedPropertyAnywhere`, `retainedInterestInPreviousProperty`, and `rightToResideInIreland`.
- `schemeBuyerStatus` is exactly `first_time_buyer`, `fresh_start`, `previous_owner`, or `unknown` and must remain independent from `lendingCategory`.
- A confirmed fresh-start case may use `lendingCategory: "first_time_buyer"` while retaining `schemeBuyerStatus: "fresh_start"`. This does not make the applicant a Help to Buy first-time purchaser.
- `cashSavingsContributions[]` supports `{ "ownerId": string, "amount": number }`; its rows must total `currentCashSavings` and may include only cash explicitly made available.
- `lumpSums[]` supports `id`, `amount`, `expectedDate`, and `confidence`; only `confirmed` and `estimated` confidence values are supported.
- `acquisitionType` is `new_build`, `second_hand`, `self_build`, `tenant_purchase`, or `unknown`. `dwellingType` is separately `house`, `apartment`, `self_build`, or `unknown`.
- `lenderCapacity` supports `status`, `amount`, `lenderId`, `isMaximumAvailable`, `macroPrudentialException`, and `htbQualifyingLender`.
- `purchaseCosts` supports `stampDutyMode`, `customStampDuty`, `legalAndConveyancing`, `valuation`, `surveyOrEngineer`, `movingAndFurnishing`, and `contingency`.
- `helpToBuy` supports `taxCompliant`, `revenueApprovedDeveloperOrApprover`, `expectedIncomeTaxAndDirtPaidPriorFourYears`, and `confirmedClaimAmount`.
- `firstHomeScheme` supports `applicationStatus`, `confirmedEquityAmount`, and `siteEquity`.
- Potential or incomplete scheme support must never be represented as a confirmed amount.
- What-if overrides are local, non-persisting runtime state and are not part of `housePurchaseInputs`. Supported scheme cases are exactly `none`, `htb_only`, `fhs_only`, and `htb_and_fhs`.
- The runtime replaces model-supplied calculation fields and owns assumptions/output tables, charts, capacity, funding, timing, mortgage, household-affordability, scheme-screen, bottleneck, action, and rule-version results.

## Mortgage Support
- Use `generated.mortgageInputs`
- This contract is for an existing housing loan's repayment and overpayment path. A future purchase plan belongs in `generated.housePurchaseInputs`.
- Runtime-supported keys:
  - `currentBalance`
  - `annualInterestRate`
  - `startDateIso`
  - `endDateIso`
  - `remainingTermYears`
  - `repaymentType`
  - `fixedPaymentAmount`
  - `oneOffOverpayment`
  - `oneOffOverpaymentMonth`
  - `annualOverpayment`
  - `overpaymentBenefit`
  - `baseScenarioId`
  - `scenarios`
  - `loanKind`
- Current runtime rejects `interestOnly`.
- `overpaymentBenefit` is exactly `shorterTerm` (default) or `lowerPayment`. It decides whether capital paid off the loan shortens the term at an unchanged repayment, or keeps the term and re-amortises the repayment down.
- `scenarios[]` supports at most 4 cases including the base case, matching the module-wide case cap. A fifth case is rejected.
- Each scenario supports `id`, `title`, `description`, and the overrides `oneOffOverpayment`, `oneOffOverpaymentMonth`, `annualOverpayment`, `fixedPaymentAmount`, `annualInterestRate`, `overpaymentBenefit`, and exactly one of `endDateIso` or `remainingTermYears`.
- `oneOffOverpaymentMonth` is whole months from the start of the schedule before the lump sum lands; `0` (the default) means it is already paid and comes off the opening balance.
- Scenario ids must be unique. A scenario inherits every field it does not restate.
- `baseScenarioId` must match a scenario id when `scenarios` is present; the runtime measures every comparison figure against that case.
- The runtime owns interest saved, time saved, total overpaid, interest saved per euro paid in, the comparison table, the keep-the-term repayment-reduction figures, and both charts. Do not supply them.
- The per-euro figure is not a return, a rate or a yield, and no summary may describe it as one.
- The repayment-case module draws its own balance curve and year-by-year interest columns beside the figures they explain, so the focused pane shows no charts card. The runtime still computes one payload chart for the surfaces that render a module without it, such as the video summary. Do not supply it.

## Loan Support
- Use `generated.loanInputs`
- Use the same engine field names as mortgage inputs, including `overpaymentBenefit`, `baseScenarioId`, and `scenarios`.
- Preferred `loanKind` is `loan`.

## Education Support
- Use `generated.education`
- Supported fields:
  - `topic`
  - `audience`
  - `metrics`
  - `steps`
  - `sections`
  - `visuals`
  - `references`
- `visuals[0]` is the preferred hero scene by convention.
- `visuals[*].type` must be `svg` or `chart`.
- `metrics[]` supports the same concise `label`, `value`, `detail`, `tone`, and `featured` structure as chart insights.
- `steps[]` supports `id`, `kicker`, `title`, `bodyHtml`, `bullets`, and `focus` for a trusted step-through explanation.
- `sections[]` supports optional `whyItMatters` and `defaultOpen` in addition to the existing section fields.
- `references[*]` supports:
  - `label`
  - `url`
  - `kind`
  - `note`
- Supported SVG kinds from the current renderer:
  - `flowchart`
  - `timeline`
  - `decisionTree`
  - `processMap`
  - `comparisonGrid`

## Report Support
- Use `generated.report`
- Supported top-level report keys:
  - `title`
  - `rawMarkdown`
  - `blocks`
- `report.meta` is not preserved or rendered by the current runtime. Do not emit it in active playbooks.

## Supported Report Block Types
- `callout`
- `markdown`
- `table`
- `chart`
- `svg`
- `timeline`
- `checklist`
- `sourceList`
- `kpiRow`
- `insightGrid`
- `scenarioCompare`
- `accordion`

## Preferred Canonical Report Block Shapes
- `callout`:

```json
{
  "type": "callout",
  "title": "Tax note",
  "tone": "info",
  "markdown": "Short markdown body",
  "bullets": ["Bullet 1", "Bullet 2"]
}
```

- `table`:

```json
{
  "type": "table",
  "title": "Key table",
  "table": {
    "columns": ["Metric", "Value"],
    "rows": [["Example", "High"]]
  }
}
```

- `timeline`:

```json
{
  "type": "timeline",
  "title": "Process timeline",
  "timeline": {
    "events": [
      { "dateLabel": "Week 1", "title": "Start", "body": "Description" }
    ]
  }
}
```

- `checklist`:

```json
{
  "type": "checklist",
  "title": "Next steps",
  "items": [
    { "label": "Verify source", "checked": false, "note": "Use the official page" }
  ]
}
```

- `sourceList`:

```json
{
  "type": "sourceList",
  "title": "Sources / where to verify",
  "items": [
    { "label": "Revenue", "kind": "official", "note": "Check the latest rule set" }
  ]
}
```

- `kpiRow`:

```json
{
  "type": "kpiRow",
  "title": "At a glance",
  "layout": "hero",
  "items": [
    { "label": "Main number", "value": "€120,000", "detail": "Context", "featured": true }
  ]
}
```

- `insightGrid`:

```json
{
  "type": "insightGrid",
  "title": "Executive picture",
  "layout": "featured",
  "items": [
    { "label": "Main signal", "value": "Moderate", "detail": "Context", "tone": "warning", "featured": true }
  ]
}
```

- `scenarioCompare`:

```json
{
  "type": "scenarioCompare",
  "title": "Scenario comparison",
  "scenarios": [
    {
      "label": "Base case",
      "summary": "Short scenario summary",
      "tone": "positive",
      "metrics": [
        { "label": "Outcome", "value": "€120,000", "detail": "Context" }
      ],
      "callout": "Client-facing interpretation"
    }
  ]
}
```

- `accordion`:

```json
{
  "type": "accordion",
  "title": "What needs verifying",
  "items": [
    { "title": "Assumption", "markdown": "Short explanation", "defaultOpen": true }
  ]
}
```

## Current Stale Instruction Corrections
- Loan prompts should no longer pretend that non-housing loans must use `generated.mortgageInputs`.
- `report.meta` should not be part of the active prompt contract.
- Interest-only mortgages are not supported.
- `generated.outputsBucketed` supports only 2-column sections.
- The runtime supports both `tone` and some older aliases internally for callouts, but new playbooks should emit `tone`.
