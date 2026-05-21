# Report Playbook

Use this playbook when Gerry says `use the report playbook`, pastes a long-form note or research report, or wants text transformed into a richer Call Canvas module.

## Job
Turn longer content into a block-rendered module that is client-friendly, structured, and visually paced.

Prefer a strong opener and one hero visual idea over a rigid, repetitive block sequence.

The module is client-facing only. Every report block, title, label, callout, checklist, accordion item, and chart insight should read as something suitable to show directly to the client during or after the call.

## Gerry's Live Prompt Can Stay Short
This style should still work:

`Use the report playbook. Turn this markdown report into a client-facing module. Focus on the practical implications.`

## Preferred Payload Shape

```json
{
  "title": "Report - Topic",
  "generated": {
    "summaryHtml": "<p>...</p>",
    "report": {
      "title": "Report title",
      "rawMarkdown": "# Source content",
      "blocks": []
    }
  }
}
```

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

## Canonical Block Shapes
- `callout`

```json
{
  "type": "callout",
  "title": "Key takeaway",
  "tone": "info",
  "markdown": "Short body",
  "bullets": ["Point 1", "Point 2"]
}
```

- `table`

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

- `chart`

```json
{
  "type": "chart",
  "chart": {
    "title": "Example chart",
    "subtitle": "Why this chart matters",
    "type": "bar",
    "labels": ["A", "B"],
    "display": {
      "variant": "wide",
      "valueFormat": "currency",
      "yAxisTitle": "Amount"
    },
    "annotations": [
      { "label": "Key point", "xLabel": "B", "yValue": 20, "tone": "warning", "body": "Short explanation" }
    ],
    "insights": [
      { "label": "Main read", "value": "Higher", "detail": "Short client interpretation" }
    ],
    "datasets": [
      { "label": "Value", "data": [10, 20] }
    ]
  }
}
```

- `svg`

```json
{
  "type": "svg",
  "title": "Decision path",
  "subtitle": "How the pieces fit together",
  "svgSpec": {
    "kind": "flowchart",
    "theme": "dark",
    "nodes": [],
    "edges": []
  }
}
```

- `timeline`

```json
{
  "type": "timeline",
  "title": "Expected timeline",
  "timeline": {
    "events": [
      { "dateLabel": "Week 1", "title": "Start", "body": "Description" }
    ]
  }
}
```

- `checklist`

```json
{
  "type": "checklist",
  "title": "Next steps",
  "items": [
    { "label": "Verify the source", "checked": false, "note": "Use the primary source" }
  ]
}
```

- `sourceList`

```json
{
  "type": "sourceList",
  "title": "Sources / where to verify",
  "items": [
    { "label": "Revenue", "url": "https://www.revenue.ie/", "kind": "official", "note": "Verify the current rule set" }
  ]
}
```

- `kpiRow`

```json
{
  "type": "kpiRow",
  "title": "At a glance",
  "layout": "hero",
  "items": [
    { "label": "Main figure", "value": "EUR 120,000", "detail": "Context", "featured": true }
  ]
}
```

- `insightGrid`

```json
{
  "type": "insightGrid",
  "title": "Executive picture",
  "layout": "featured",
  "items": [
    { "label": "Main signal", "value": "Moderate", "detail": "Why it matters", "tone": "warning", "featured": true }
  ]
}
```

- `scenarioCompare`

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

- `accordion`

```json
{
  "type": "accordion",
  "title": "What needs verifying",
  "items": [
    { "title": "Assumption", "markdown": "Short explanation", "defaultOpen": true }
  ]
}
```

## Layout Rules
- Do not force the same opener every time.
- Choose the opener based on the source:
  - metric-heavy -> `kpiRow`
  - insight-heavy -> `insightGrid`
  - option-heavy -> `scenarioCompare`
  - recommendation-heavy -> `callout`
  - narrative-heavy -> `markdown`
- If the source contains a process, decision path, or phased workflow, prefer one hero `svg` or `timeline`.
- If the source contains real numbers worth visualising, use 1 to 2 charts.
- If the source includes tables, convert at least one useful table block when the table adds clarity.
- Use `accordion` for verification detail, assumptions, or caveats that should be available but not dominate the live call.
- Use `checklist` and `sourceList` when they genuinely add value, not as forced filler.
- For `sourceList`, include direct URLs for items you include. If the exact URL is not known, omit that source item rather than outputting a non-clickable label.
- Target 6 to 12 blocks for most modules.

## Visual Quality Rules
- Prefer one hero scene and one support visual.
- Alternate dense text with more scannable blocks.
- Avoid long runs of markdown-only blocks.
- Never invent numbers or fabricate structure that is not supported by the source.
- Use chart annotations and insights to make charts explainable, not decorative.
- Use `scenarioCompare` only when there are genuinely distinct scenarios, routes, or tradeoffs.
- If the source contains adviser notes, research notes, or suggested framing, translate them into client-facing implications before placing them in a block.

## Good Output Looks Like
- The report opens with a clear hierarchy of the most important point.
- Charts have an interpretation layer, not just plotted numbers.
- Dense source content is paced into readable blocks.
- Caveats and verification points are present but progressively disclosed.
- Every block has a job in the client conversation and can be read by the client without exposing internal adviser guidance.

## Avoid
- A rigid template that starts every report with the same block sequence.
- Decorative KPI cards with vague labels.
- Scenario comparisons that merely repeat the same facts.
- Long markdown blocks copied from the source with no synthesis.
- Chart data that is invented or visually impressive but unsupported.
- Any advisor/adviser/presenter-only headings or body copy inside JSON content, including phrases like `Practical adviser framing`, `Advisor notes`, `Presenter interpretation`, `talk track`, `for the adviser`, or `for Gerry`.
- Referring to the client in the third person when a direct client-facing version is clearer. Prefer `you`, `your plan`, and `your decision` where appropriate.

## Runtime Rules
- `generated.report` supports `title`, `rawMarkdown`, and `blocks`.
- Do not emit `report.meta` in the active playbook contract.

## Summary Rules
- Keep `generated.summaryHtml` to 2 to 4 sentences.
- Identify the source topic, the practical implication for the client, and the part of the report to read first.
- Tell the client how to read the first screen: start with the executive picture or strongest opener, then use supporting visuals, scenarios, and verification points.
- The first block should be chosen by content, but it must orient the client rather than act as decorative structure.
- Keep it screen-share friendly and plain English.

## Omit By Default
For this playbook, do not emit:
- `generated.education`
- `generated.pensionInputs`
- `generated.mortgageInputs`
- `generated.loanInputs`
- `generated.outputsBucketed`

This playbook transforms longer content into report blocks.
