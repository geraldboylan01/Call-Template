# Education Playbook

Use this playbook when Gerry says `use the education playbook`, asks to explain a topic visually, or wants a client-friendly SVG-first learning module.

## Job
Turn a dictated topic into a clear explainer module with strong visual pacing.

Prefer one hero visual scene and, only if helpful, one support visual. Do not fill the module with safe but repetitive visuals.

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
- `generated.education.visuals`
- `generated.education.references`

## Section Rules
- Use 3 to 5 sections for most topics.
- Each section should be:
  - `id`
  - `title`
  - `bodyHtml`
  - optional `bullets`
- Keep sections teachable, not essay-like.
- No advisor-only notes inside sections.

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

## References Rules
- Each reference may include:
  - `label`
  - optional `url`
  - optional `kind`
  - optional `note`
- Use no more than 4 references for most education modules.
- Include `url` only when Gerry provides it, when it comes from uploaded source material, or when it is a reliable official page you can cite confidently.
- If the exact link is not known, omit `url` rather than guessing.
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
- Explain what the topic is and what the client should focus on.
- Keep the tone calm, direct, and clear.

## Omit By Default
For this playbook, do not emit:
- `generated.report`
- `generated.pensionInputs`
- `generated.mortgageInputs`
- `generated.loanInputs`
- `generated.outputsBucketed`

This is a visually led explainer module, not a calculator module.
