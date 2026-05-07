# Artifact Module Upgrade Notes

## What Changed

Planeir still renders trusted components from structured JSON. This upgrade keeps the Dev Panel paste-JSON workflow and the existing playbook boundaries, while adding more expressive artifact-style primitives.

Runtime changes:
- Charts now support optional structured presentation metadata: `subtitle`, `display`, `annotations`, and `insights`.
- Education modules now support optional `metrics`, `steps`, and `sections[*].whyItMatters`.
- Report modules now support three additional trusted block types: `insightGrid`, `scenarioCompare`, and `accordion`.
- Styling was refreshed toward a calmer institutional surface with tighter card radii, richer hierarchy, chart insight cards, and more deliberate Education/Report presentation.

Preserved behavior:
- Pension, mortgage, and loan modules remain JS-engine modules. Their playbooks should still emit only engine inputs plus a concise summary.
- PBS remains `outputsBucketed` first, with optional chart metadata.
- Report and Education remain whitelisted structured renderers.
- Arbitrary model-generated HTML/JS is still not executed. HTML fields remain sanitized text fragments, and charts/SVG/report blocks are internal components.

## New Structured Fields

Chart fields:
- `subtitle`: short chart context.
- `display.variant`: `hero`, `wide`, or `compact`.
- `display.valueFormat`: `currency`, `percent`, or `number`.
- `display.xAxisTitle` and `display.yAxisTitle`.
- `display.showLegend`, `display.stacked`, and `display.highlightDataset`.
- `annotations[]`: `label`, optional `xLabel`, optional numeric `yValue`, optional `tone`, optional `body`.
- `insights[]`: `label`, optional `value`, optional `detail`, optional `tone`, optional `featured`.

Education fields:
- `generated.education.metrics[]`: compact teaching anchors.
- `generated.education.steps[]`: step-through panels with `id`, `kicker`, `title`, `bodyHtml`, `bullets`, and `focus`.
- `generated.education.sections[*].whyItMatters`: concise implication callout.
- `generated.education.sections[*].defaultOpen`: controls initial section expansion.

Report blocks:
- `insightGrid`: executive insight cards, optionally `layout: "featured"`.
- `scenarioCompare`: scenario cards with metrics and client-facing callouts.
- `accordion`: progressive disclosure for caveats, assumptions, and verification details.

## How To Test

1. Open `/app/` in local development.
2. Open the Dev Panel.
3. Use the built-in examples:
   - `PBS: Balance Sheet Artifact Demo`
   - `Education: Guided HTB Artifact Demo`
   - `Report: Artifact Blocks Demo`
4. Paste examples from `docs/prompt-pack/91_artifact_payload_examples.md` for full regression coverage across PBS, Pension, Mortgage, Loan, Education, and Report.
5. Run `npm run build` to verify the static app build.

## Prompt Targeting Guidance

Future prompts should ask for artifact primitives by communication need, not by template:
- Use `metrics` when a few numbers or labels anchor the topic.
- Use `steps` when the client needs a guided walkthrough.
- Use chart `annotations` when one plotted point or threshold needs attention.
- Use `insightGrid` when a report needs a strong executive picture.
- Use `scenarioCompare` only for real scenarios or tradeoffs.
- Use `accordion` for details that should be available but not visually dominant.
- Treat every JSON title, label, callout, and body field as client-visible. Do not emit advisor-only labels such as `Practical adviser framing`, `Presenter interpretation`, `talk track`, or `for Gerry`.

Avoid forcing every module to use all capabilities. Static summaries and simple tables are still correct when they best serve the call.
