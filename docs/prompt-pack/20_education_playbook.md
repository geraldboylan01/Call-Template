# Education Playbook

Use this playbook when Gerry says `use the education playbook`, asks to explain a topic visually, or wants a client-friendly learning module.

## Job
Turn a dictated topic into a clear explainer module with strong visual pacing, progressive explanation, and client-friendly teaching structure.

Prefer one strong teaching route over a pile of generic sections. Use metrics, steps, charts, and SVG scenes only when they improve comprehension.

## Gerry's Live Prompt Can Stay Short
This style should still work:

`Use the education playbook. Explain Help to Buy for a first-time buyer couple in Ireland. Make it visually strong.`

## Preferred Payload Shape

```json
{
  "title": "Education - Topic",
  "generated": {
    "summaryHtml": "<p>...</p>",
    "education": {
      "topic": "Topic",
      "audience": "Optional audience",
      "metrics": [],
      "steps": [],
      "sections": [],
      "visuals": [],
      "references": []
    }
  }
}
```

## Required Education Fields
- `generated.education.topic`
- `generated.education.sections`

## Optional Education Fields
- `generated.education.audience`
- `generated.education.metrics`
- `generated.education.steps`
- `generated.education.visuals`
- `generated.education.references`

## Artifact Capabilities
Use these selectively:
- `metrics`: 2 to 4 compact teaching anchors such as caps, thresholds, dependencies, or plain-English signals.
- `steps`: 3 to 5 step-through panels when the topic benefits from progressive explanation.
- `sections[*].whyItMatters`: one concise reason the client should care about that section.
- chart `annotations` and `insights`: only when there are real numbers worth calling out.

Do not force all of these into every module.

## Section Rules
- Use 3 to 5 sections for most topics.
- Each section should be:
  - `id`
  - `title`
  - `bodyHtml`
  - optional `bullets`
  - optional `whyItMatters`
  - optional `defaultOpen`
- Keep sections teachable, not essay-like.
- No advisor-only notes inside sections.

## Step Rules
- Use `steps` when the teaching path matters: eligibility checks, sequencing, cause/effect, or layered concepts.
- Each step may include:
  - `id`
  - `kicker`
  - `title`
  - `bodyHtml`
  - `bullets`
  - `focus`
- Keep each step short enough to discuss while screen-sharing.
- Do not duplicate the same text in `steps` and `sections`; use steps for the live walkthrough and sections for supporting explanation.

## Supported Visual Types
- `svg`
- `chart`

## Supported SVG Kinds
- `flowchart`
- `timeline`
- `decisionTree`
- `processMap`
- `comparisonGrid`

## Hero Scene Selection
Choose the strongest hero scene for the topic:
- eligibility or branching decisions -> `decisionTree` or `flowchart`
- step-by-step process -> `timeline` first, `processMap` only when multiple parties or lanes matter
- comparing routes or options -> `comparisonGrid`
- threshold or cap explanation with real numbers -> chart, optionally paired with a simple SVG explainer

Do not add a chart just because charts are available. If there are no real numbers worth plotting, use SVG only.

## Scene Composition Rules
- `visuals[0]` is the hero scene by convention.
- `visuals[1+]` are support scenes.
- Default to 1 hero scene.
- Add at most 1 support scene unless Gerry clearly asks for more.
- Keep `generated.summaryHtml` as the nearby takeaway above the scenes.
- If a chart is the hero, use `chart.subtitle`, `chart.display`, `chart.annotations`, and `chart.insights` to explain why the plotted number matters.

## Visual Quality Rules
- Prefer 1 hero visual and 0 to 1 support visuals.
- Keep SVGs readable on a laptop screen.
- Prefer 6 to 12 nodes for most diagrams.
- Keep node labels very short, ideally 2 to 6 words.
- If a node label needs a full sentence, move the nuance into the section body or visual subtitle instead.
- Keep edge labels to 1 to 3 words where possible.
- Do not use a tall single-lane process map when a timeline or compact flowchart would explain the same idea more clearly.
- For long sequential explanations, prefer `timeline`.
- For branching logic, prefer `decisionTree` or `flowchart`.
- Give visuals a real job:
  - orient the client
  - compare options
  - show sequence
  - clarify a decision path

## Good Output Looks Like
- The first screen tells the client what they are learning and where to look.
- Metrics, if used, anchor the conversation in a few memorable signals.
- Steps, if used, create a natural presenter rhythm.
- Visuals are legible from a laptop screen and have short labels.
- Written sections explain implications, not implementation details.

## Avoid
- Generic explainers with five same-looking cards and no hierarchy.
- Tall process maps when a compact timeline or decision tree would do.
- Charts with no real numeric teaching value.
- Decorative visuals that do not change the client's understanding.
- Fake URLs, fake citations, or current-rule claims without a reliable source.

## References Rules
- Each reference may include:
  - `label`
  - `url`
  - optional `kind`
  - optional `note`
- Use no more than 4 references for most education modules.
- Every included reference should have a direct clickable URL.
- Use `url` when Gerry provides it, when it comes from uploaded source material, or when it is a reliable official page you can cite confidently.
- If the exact URL is not known, omit the reference rather than outputting a non-clickable source.
- Do not invent or guess URLs.
- Good kinds include:
  - `official`
  - `regulator`
  - `guidance`
- Use references as verification pointers, not as fake citations.

## Ambiguity Policy
- Best-guess first.
- Ask one bold follow-up question only if the jurisdiction, client status, or scheme type changes the explanation materially.
- Still output a best-effort module.

## Summary Rules
- Keep `generated.summaryHtml` to 2 to 4 sentences.
- Define the topic before giving the decision lens, especially for unfamiliar schemes, tax rules, trusts, or family-finance concepts.
- Say what the client should learn, decide, or verify after reading the module.
- Tell the client how to read the first screen: start with the plain-English frame and hero visual, then use steps, sections, and references for detail.
- For unfamiliar topics, make the first written section `Plain English Frame`.
- Keep the tone calm, direct, and clear.

## Omit By Default
For this playbook, do not emit:
- `generated.report`
- `generated.pensionInputs`
- `generated.mortgageInputs`
- `generated.loanInputs`
- `generated.outputsBucketed`

This is a visually led explainer module, not a calculator module.
