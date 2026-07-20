# Protection Playbook

<!-- planeir-planning-module {"moduleId":"protection_analysis","outputKey":"generated.report","role":"analysis"} -->

Use this playbook when Gerry says `use the protection playbook`, wants a protection planning module, or asks about income protection and serious illness cover.

## Job
Produce a report-style protection module that is calm, client-friendly, and visually strong without pretending to be an underwriting or insurer quote engine.

## Gerry's Live Prompt Can Stay Short
This style should still work:

`Use the protection playbook. Age 42. Income 80000. Existing serious illness cover 50000. Existing income protection premium 1500. Make it easy to screen-share.`

## Preferred Output Path
Use `generated.report`.

## Preferred Payload Shape

```json
{
  "title": "Protection Planning - Income and Illness",
  "generated": {
    "summaryHtml": "<p>...</p>",
    "report": {
      "title": "Protection Planning",
      "blocks": []
    }
  }
}
```

## Scope
This playbook covers two themes only:
- income protection
- serious illness cover

Do not turn it into a mortgage protection module unless Gerry explicitly asks for that separately.

## Required Inputs
- current age
- gross annual income

## Helpful Optional Inputs
- existing income protection cover
- existing income protection premium
- existing serious illness cover
- marginal income tax rate
- employer sick pay or employer benefits
- retirement age if Gerry wants it mentioned in the narrative

## Core Framing Rules
- Income protection:
  - explain what it does
  - show the 10 percent premium tax-relief cap on qualifying premiums
  - if a premium is provided, show a simple gross premium, tax-relief, and net-cost view
- Serious illness:
  - frame it as a support-years capital buffer
  - make the 2-year support figure the hero number
  - show 1-year and 3-year figures as comparison anchors
- Employer reminder:
  - include a compact callout to check employer sick pay, group cover, and contract terms

## Calculation Rules
- Keep figures illustrative and transparent.
- Do not present insurer quotes or underwriting outcomes.
- If Gerry does not provide a marginal tax rate but asks for a premium relief illustration, use a clearly labeled placeholder assumption and note it in NOTES.
- If no premium is provided, keep the income protection section educational rather than pretending to price it.

## Recommended Block Pattern
- one hero `kpiRow` for the key number set
- optionally one `insightGrid` if the client needs a concise executive picture
- one short `markdown` intro for income protection
- one `chart` for premium or relief comparison when numbers exist
- one short `markdown` intro for serious illness
- one hero or standard `kpiRow` for the support-years framing
- one `chart` for 1-year vs 2-year vs 3-year support
- optionally one `scenarioCompare` if comparing cover levels or support-year options
- one `callout` for employer or contract checks
- one final `callout` for priority or what to consider

Do not overbuild it. One strong visual comparison is better than several filler blocks.

## Summary Rules
- Keep `generated.summaryHtml` to 2 to 4 sentences.
- Explain income protection and serious illness cover as support buffers, not quotes or underwriting outcomes.
- Say which protection theme appears more relevant right now from the supplied facts and why.
- Tell the client how to read the first screen: start with the support buffer, then check employer benefits, contract terms, and any assumptions before acting.
- Keep the tone calm and advisory.

## Omit By Default
For this playbook, do not emit:
- `generated.education`
- `generated.pensionInputs`
- `generated.mortgageInputs`
- `generated.loanInputs`
- `generated.outputsBucketed`

This is a report-style advisory module, not a JS-engine module.
