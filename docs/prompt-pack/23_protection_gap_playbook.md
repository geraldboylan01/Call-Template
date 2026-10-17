# Protection Gap Playbook

Use this playbook when Gerry says `use the protection gap playbook`, or asks what would happen if one income stopped: how big the gap would be each year, and how many months savings would fill it.

## Job
Parse the household, what each person brings home, what the household needs, its savings and the events to show into `generated.protectionGapInputs`.

The browser app owns everything else. For each case it works out what comes in, the gap or what is left over, and how many months savings would fill the gap, and it draws the screen. It also writes the module summary from its own figures, so this playbook writes none.

## How It Differs From the Protection Playbook
- Protection Gap shows **the size of the hole and the time**: if one income stopped, what would come in, what is still needed, and how long savings would last. It never shows a cover amount, a premium, a policy, a product or a provider.
- The Protection playbook is a report-style explainer about income protection and serious illness cover.
- Run Protection Gap when the question is how exposed the household is. Run the Protection playbook when Gerry wants to explain how cover works.

## Gerry's Live Prompt Can Stay Short
This style should work:

`Use the protection gap playbook. Niamh and Dara, both 45. Niamh takes home 57000, Dara 45000. They need 96000 a year and have 60000 in savings. Show either of them unable to work on 13000 a year from the State, and Niamh dying: survivor's pension 13500, the mortgage cleared and living costs lower, so they'd need 60000.`

## Output Contract
- SECTION 1 - NOTES (FOR GERRY ONLY)
  - Keep it to the key assumptions.
  - One line per case naming what it changes. The app calculates the gap and the months, so do not estimate them.
  - When a figure the cases need is missing, NOTES is the whole reply until Gerry confirms it: see Figures Gerry Gives.
- SECTION 2 - DEV PANEL JSON (PASTE INTO APP)
  - Return a single strict JSON object.
  - Use straight double quotes only. Do not use smart quotes.
  - Keep notes outside the JSON object.

## Preferred Payload Shape

```json
{
  "title": "Protection Gap - If One Income Stopped",
  "generated": {
    "protectionGapInputs": {
      "householdLabel": "Niamh and Dara, both 45",
      "people": [
        { "id": "niamh", "label": "Niamh", "takeHome": 57000 },
        { "id": "dara", "label": "Dara", "takeHome": 45000 }
      ],
      "needed": 96000,
      "savings": 60000,
      "scenarios": [
        { "id": "today" },
        { "id": "niamh-cannot-work", "event": { "type": "cannotWork", "personId": "niamh", "statePayment": 13000 } },
        { "id": "dara-cannot-work", "event": { "type": "cannotWork", "personId": "dara", "statePayment": 13000 } },
        {
          "id": "niamh-died",
          "event": {
            "type": "dies",
            "personId": "niamh",
            "survivorsPension": 13500,
            "neededAfter": 60000,
            "neededBecause": ["mortgageCleared", "livingCostsLower"]
          }
        }
      ]
    }
  }
}
```

## Required Inputs
- `people`: 1 or 2 people, each `{ id, label, takeHome }`.
  - `id`: lower case letters, numbers, `-` or `_`, unique.
  - `label`: the person's name as the client would say it, 1 to 24 characters. It is shown on screen.
  - `takeHome`: what the person brings home in a year after income tax, USC and PRSI, in whole euros, 0 or more. Someone at home with no income has 0.
- `needed`: what the household needs each year, in whole euros, greater than 0: the mortgage or rent, bills and living costs together.
- `savings`: savings that could fill a gap, in whole euros, 0 or more.
- `scenarios`: 1 to 4 cases.

Optional:
- `householdLabel`: one line, 1 to 60 characters, for example `Niamh and Dara, both 45`.
- `baseScenarioId`: must match a case id. The default is the first case.

All money is in whole euros. A figure with cents is refused.

## The Cases
Each case is `{ id, title?, description?, event? }`. A case with no `event` is today. A case changes one thing:

- **Cannot work:** `"event": { "type": "cannotWork", "personId": "niamh", "statePayment": 13000 }`. That person's take-home stops. `statePayment` is required, per year, in whole euros, 0 or more. A positive amount starts a State payment; explicit 0 models no State payment.
  - If Gerry says no State payment, use explicit 0 and do not suggest a payment he has ruled out. Missing is different from zero: never infer zero because a figure was omitted.
- **Dies:** `"event": { "type": "dies", "personId": "niamh", "survivorsPension": 13500 }`. Needs two people. That person's take-home stops and a survivor's pension starts, per year, 0 or more.
  - `neededAfter` is optional: what the household would need after the death, lower than `needed`. A higher need is refused.
  - `neededBecause` is optional and needs `neededAfter`: `mortgageCleared`, `livingCostsLower`, or both. The app names the reason in its sentence.

Rules:
- With more than one case, the base case (the first, unless `baseScenarioId` names another) is today and has no event. An event on the base case is refused.
- At most 4 cases. A fifth is rejected and the whole module fails to apply.
- If Gerry does not name the cases, use today, each person unable to work, and, with two people, the death he describes. Keep to 4, and say in NOTES which case was left out.
- Leave `title` out. The app names each case `Today`, `Niamh cannot work` or `If Niamh died`. Give a title only when Gerry asks for one, up to 40 characters.
- A person with no take-home cannot be the one whose income stops.

## Figures Gerry Gives
The screen tells the client that take-home pay and State payments are as given, so every figure in the payload must come from Gerry: take-home pay, what is needed, savings, State payments and survivor's pensions. Never put a figure you worked out yourself, or a placeholder, into the payload as if he had given it.

When one is missing, do not return the JSON yet:
- **Take-home pay.** If Gerry gives gross pay, work out a take-home with the Irish tax overlay and show the working.
- **State payment or survivor's pension.** Name the payment that would fit and its current weekly personal rate, times 52: Illness Benefit or Invalidity Pension for someone who cannot work, and Widow's, Widower's or Surviving Civil Partner's (Contributory) Pension after a death. Say that it depends on eligibility, including the person's PRSI record where applicable. The future automated illness scenario will use the centrally versioned Illness Benefit assumption described in `docs/irish-illness-disability-payment-reference.md`; the current manual screen still uses confirmed figures and does not recalculate the partner's tax. Do not add a client form question predicting future disability benefits.
- **What is needed, or savings.** Ask for them; suggest nothing unless Gerry has given something to work from, such as monthly spending.
- Put these in NOTES as suggestions, then ask one bold question asking Gerry to confirm them or give his own. Return both sections once he answers, using the figures he confirms.
- **What is needed after a death.** Only when Gerry says what would change, such as the mortgage being cleared or living costs falling. Otherwise leave `neededAfter` out and the need stays the same. This one never needs a question.

## The Wording Limit
Nothing in the payload may recommend, rank, or mention cover, a premium, a policy, insurance, a quote, a product or a provider, or refer to anyone in the third person. Write people by name.

The app refuses any key containing `cover`, `premium`, `policy`, `product`, `provider`, `insurer` or `quote`, at any level, with `generated.protectionGapInputs.<key>: this screen shows the gap and the time, never a cover amount, a premium or a product.`

It also refuses a title, description, household line or person's name containing any of these, in any case, with a message naming the field:
- `we recommend`, `you should`, `best`, `ideal`, `optimal`, `p.a.`
- `cover`, `covers`, `covered`, `covering`, `coverage`, `premium`, `policy`, `policies`, any word starting `insur`, any word starting `quote`, `income protection`, `serious illness`
- `he`, `she`, `his`, `her`, `hers`, `him`, `the household`, `the client`
- `Bank of Ireland`, `AIB`, `PTSB`, `Permanent TSB`, `Revolut`, `Zurich`, `Irish Life`, `Davy`

Gerry's own words often carry these (`Sinéad is on her own`), so never copy them into a title, description or household line. Leave titles out, and keep the household line to names and ages, for example `Sinéad, 38`.

The fields `gap`, `months`, `spare` and `leftOver` are calculated and refused with `generated.protectionGapInputs.<key> is not accepted. It is calculated.`
- `gap`, `months`, `spare` and `leftOver`, which are calculated, with `generated.protectionGapInputs.<key> is not accepted. It is calculated.`

If Gerry asks for a cover amount or a premium, build the module without it and say in NOTES that this screen never shows one, and that the Protection playbook is the place for that conversation.

## Not Modelled
Say so in NOTES when it matters, and keep the payload as it is:
- **Tax.** Take-home and State payments are as given. When one income stops, the other person's tax can change, and the app's footnote says so.
- **Interest or inflation on savings.** Savings only fill the gap, at the same size every year.
- **A need that rises after a death.**
- **More than one event in a case, or more than two people.**

## Runtime Outputs
- Case buttons, a bar of what comes in against what is needed, and a strip of 36 months for how long savings last.
- An answer for each case, for example `You are €38,000 a year short. Your savings would last 19 months.` or `You have €6,000 a year left over. There is nothing for your savings to fill.`
- A sentence on what the case changes, and a footnote.
- The module summary: an opening line, then each case's answer.

## Summary
Do not emit `generated.summaryHtml`. The app writes the summary from its own figures, so it can never say what this screen may not. A summary sent with this module is replaced.

## Omit By Default
For this playbook, emit only `generated.protectionGapInputs`. Do not emit:
- `generated.summaryHtml`
- `generated.report`
- `generated.education`
- any other engine input, such as `generated.householdCashFlowInputs` or `generated.pensionInputs`
- hand-built `generated.assumptions`, `generated.outputs`, `generated.tables` or `generated.charts`

This is a JS-engine module. The app calculates every figure and writes every word on the screen.
