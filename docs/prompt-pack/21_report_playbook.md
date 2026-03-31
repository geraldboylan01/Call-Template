# Report Playbook

Use this playbook when Gerry says `use the report playbook`, pastes a long-form note or research report, or wants text transformed into a richer Call Canvas module.

## Job
Turn longer content into a block-rendered module that is client-friendly, structured, and visually paced.

Prefer a strong opener and one hero visual idea over a rigid, repetitive block sequence.

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
    "type": "bar",
    "labels": ["A", "B"],
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

## Layout Rules
- Do not force the same opener every time.
- Choose the opener based on the source:
  - metric-heavy -> `kpiRow`
  - recommendation-heavy -> `callout`
  - narrative-heavy -> `markdown`
- If the source contains a process, decision path, or phased workflow, prefer one hero `svg` or `timeline`.
- If the source contains real numbers worth visualising, use 1 to 2 charts.
- If the source includes tables, convert at least one useful table block when the table adds clarity.
- Use `checklist` and `sourceList` when they genuinely add value, not as forced filler.
- For `sourceList`, include direct URLs for items you include. If the exact URL is not known, omit that source item rather than outputting a non-clickable label.
- Target 6 to 12 blocks for most modules.

## Visual Quality Rules
- Prefer one hero scene and one support visual.
- Alternate dense text with more scannable blocks.
- Avoid long runs of markdown-only blocks.
- Never invent numbers or fabricate structure that is not supported by the source.

## Runtime Rules
- `generated.report` supports `title`, `rawMarkdown`, and `blocks`.
- Do not emit `report.meta` in the active playbook contract.

## Summary Rules
- Keep `generated.summaryHtml` to 2 to 4 sentences.
- Tell the client what the report is about and what to focus on.
- Keep it screen-share friendly and plain English.

## Omit By Default
For this playbook, do not emit:
- `generated.education`
- `generated.pensionInputs`
- `generated.mortgageInputs`
- `generated.loanInputs`
- `generated.outputsBucketed`

This playbook transforms longer content into report blocks.
