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

## Chart Support
- Supported chart types: `bar`, `line`
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
  - `annotations[]`: trusted chart guide metadata with `label`, optional `xLabel`, optional numeric `yValue`, optional `tone`, and optional `body`.
  - `insights[]`: concise metric card objects below the chart with `label`, optional `value`, optional `detail`, optional `tone`, and optional `featured`. Do not emit strings inside `insights[]`.
- Chart metadata is rendered by trusted components only. Do not emit Chart.js options, plugins, callbacks, HTML, or JavaScript.

## PBS Support
- Preferred output path: `generated.outputsBucketed`
- Optional inputs path: `generated.pbsInputs`
- `generated.outputs` should be omitted by the PBS playbook.
- `generated.assumptions` is supported, but PBS should usually omit it unless Gerry explicitly asks to override the scaffold.
- PBS must use `generated.summaryHtml` and `generated.outputsBucketed`; do not invent `generated.summary`, `generated.metrics`, `generated.buckets`, `generated.assets`, or `generated.liabilities` as the primary app contract.

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
- The runtime supplies defaults for omitted `inflationRate`, `wageGrowthRate`, `horizonEndAge`, `currentYear`, and `minDrawdownMode`.

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
    { "label": "Main number", "value": "EUR 120,000", "detail": "Context", "featured": true }
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
        { "label": "Outcome", "value": "EUR 120,000", "detail": "Context" }
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
