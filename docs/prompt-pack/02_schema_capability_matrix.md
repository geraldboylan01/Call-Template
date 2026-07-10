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
- `charts`
- `pensionInputs`
- `netRetirementInputs`
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

## PBS Support
- Preferred output path: `generated.outputsBucketed`
- Optional inputs path: `generated.pbsInputs`
- `generated.outputs` should be omitted by the PBS playbook.
- `generated.assumptions` is supported, but PBS should usually omit it unless Gerry explicitly asks to override the scaffold.
- PBS must use `generated.summaryHtml` and `generated.outputsBucketed`; do not invent `generated.summary`, `generated.metrics`, `generated.buckets`, `generated.assets`, or `generated.liabilities` as the primary app contract.
- PBS `outputsBucketed.sections` must include the six standard sections in order: `lifestyle`, `liquidity`, `longevity`, `legacy`, `liabilities`, `summary`.
- The summary section must use `key: "summary"` and the exact rows `Gross assets`, `Total liabilities`, and `Net worth`; use `Net worth` as the row label and subtotal label even when the values are known-values-only.
- PBS alternatives belong in `generated.outputsBucketed.scenarios[]`; every scenario must contain fully recalculated sections, including its own `summary` section with the exact `Net worth` label.
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
- The runtime calculates `generated.assumptions`, `generated.outputs`, `generated.tables`, and `generated.charts`; the playbook should not hand-build those fields.
- Required fund outputs are after-tax net figures. Do not compare them directly with pension balances or gross pension withdrawals unless pension withdrawal tax has been allowed for separately.

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
- Shorthand at-home/away inputs are also supported: `atHomeAnnualCostTodayPerChild`, `awayAnnualCostTodayPerChild`, and `carSupportTodayPerChild`.
- The runtime validates unique child ids, non-negative current ages, start age greater than current age, positive durations, non-negative inflation, and plain numeric money inputs.
- The runtime calculates `generated.assumptions`, `generated.outputs`, `generated.tables`, and `generated.charts`; the playbook should not hand-build those fields.

## Mortgage Support
- Use `generated.mortgageInputs`
- Runtime-supported keys:
  - `currentBalance`
  - `annualInterestRate`
  - `startDateIso`
  - `endDateIso`
  - `remainingTermYears`
  - `repaymentType`
  - `fixedPaymentAmount`
  - `oneOffOverpayment`
  - `annualOverpayment`
  - `loanKind`
- Current runtime rejects `interestOnly`.

## Loan Support
- Use `generated.loanInputs`
- Use the same engine field names as mortgage inputs.
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
