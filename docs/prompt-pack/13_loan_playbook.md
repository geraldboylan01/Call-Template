# Loan Playbook

<!-- planeir-planning-module {"moduleId":"loan_analysis","outputKey":"generated.loanInputs","role":"analysis"} -->

Use this playbook when Gerry says `use the loan playbook`, wants a non-housing loan projection, or wants the amortising loan engine without mortgage wording.

## Job
Parse the dictated loan details into `generated.loanInputs` and write a short client-facing summary.

The browser app owns the repeatable loan maths after the payload is applied.

## Gerry's Live Prompt Can Stay Short
This style should still work:

`Use the loan playbook. Balance 18000. Rate 8.5 percent. Start February 2026. Remaining term 4 years. Annual overpayment 500.`

## Preferred Payload Shape

```json
{
  "title": "Loan Projection - Client",
  "generated": {
    "summaryHtml": "<p>...</p>",
    "loanInputs": {
      "currentBalance": 18000,
      "annualInterestRate": 0.085,
      "startDateIso": "2026-02-01",
      "endDateIso": null,
      "remainingTermYears": 4,
      "repaymentType": "repayment",
      "fixedPaymentAmount": null,
      "oneOffOverpayment": 0,
      "annualOverpayment": 500,
      "loanKind": "loan"
    }
  }
}
```

## Important Runtime Correction
Use `generated.loanInputs` for the loan playbook.

Do not use the older workaround that forced non-housing loans through `generated.mortgageInputs`.

## Runtime Fields
- `currentBalance` - required number, greater than 0
- `annualInterestRate` - required annual decimal rate
- `startDateIso` - required `YYYY-MM-DD`
- one of:
  - `endDateIso`
  - `remainingTermYears`
- `repaymentType` - must be `repayment`
- `fixedPaymentAmount` - optional number or `null`
- `oneOffOverpayment` - optional number, default 0
- `oneOffOverpaymentMonth` - optional whole number of months from the start, default 0 (already paid)
  - Set it whenever Gerry puts the money in the future: `in 3 years` -> `36`. The module then opens on that year and offers the year before, that year, and the two after, with paying today alongside. Omit it when the money is in hand.
- `annualOverpayment` - optional number, default 0
- `overpaymentBenefit` - optional, `shorterTerm` (default) or `lowerPayment`
- `baseScenarioId` - optional, required to match a case id when `scenarios` is present
- `scenarios` - optional array of cases, maximum 4
- `loanKind` - prefer `loan`

## Parsing Rules
- Spoken `8.5 percent` -> `0.085`
- Dates must be emitted as `YYYY-MM-DD`
- If Gerry gives an end date, set `endDateIso` and set `remainingTermYears` to `null`
- If Gerry gives a remaining term, set `remainingTermYears` and set `endDateIso` to `null`
- If Gerry gives a fixed monthly payment, set `fixedPaymentAmount`
- If Gerry does not give overpayments, set them to 0
- Always set `repaymentType` to `repayment`
- Set `loanKind` to `loan`

## Cases
Use `scenarios` when Gerry wants to compare clearing the loan faster against carrying on as-is. Phrases that mean cases:
- compare paying it off faster
- what if we cleared it early
- what would clearing the car loan save

Rules are the same as the Mortgage playbook:
- Maximum 4 cases, including the do-nothing case. A fifth case is rejected.
- Each case needs a unique `id` and a short, client-facing `title`.
- A case restates only what it changes; everything else is inherited from the loan.
- A case may override `oneOffOverpayment`, `oneOffOverpaymentMonth`, `annualOverpayment`, `fixedPaymentAmount`, `annualInterestRate`, `overpaymentBenefit`, and the term as either `endDateIso` or `remainingTermYears`, never both.
- Set `baseScenarioId` to the case the others are measured against, normally the do-nothing case.
- Always include the do-nothing case explicitly, or there is no interest saved to show.
- `overpaymentBenefit` defaults to `shorterTerm`, which holds the repayment and clears the loan earlier. Use `lowerPayment` only when Gerry says the client wants the repayment reduced instead.

```json
{
  "title": "Loan Projection - Client",
  "generated": {
    "summaryHtml": "<p>...</p>",
    "loanInputs": {
      "currentBalance": 18000,
      "annualInterestRate": 0.085,
      "startDateIso": "2026-02-01",
      "endDateIso": null,
      "remainingTermYears": 4,
      "repaymentType": "repayment",
      "fixedPaymentAmount": null,
      "loanKind": "loan",
      "overpaymentBenefit": "shorterTerm",
      "baseScenarioId": "current",
      "scenarios": [
        { "id": "current", "title": "No overpayment", "oneOffOverpayment": 0, "annualOverpayment": 0 },
        { "id": "annual-500", "title": "500 a year", "annualOverpayment": 500 },
        { "id": "lump-3k", "title": "3,000 lump sum", "oneOffOverpayment": 3000 }
      ]
    }
  }
}
```

Keep case titles in loan wording, never mortgage wording.

## Best-Guess Defaults
Use placeholders only when needed to keep an exploratory module moving:
- If `startDateIso` is missing, use the first day of the current month and note it in NOTES.
- If both `endDateIso` and `remainingTermYears` are missing, use `remainingTermYears = 5` and note clearly that it is a placeholder term.
- If `fixedPaymentAmount` is not given, use `null`.

## Summary Rules
- Keep `generated.summaryHtml` to 2 to 4 sentences.
- Explain the scenario in plain English using non-housing loan wording, not mortgage wording.
- Use the balance, rate, term/end date or fixed payment, and overpayment facts supplied.
- Tell the client how to read the first screen: with cases, it opens on their current path and the buttons step through the others, each showing when the loan clears and how much of the interest bill goes. Without cases, focus on payoff timing, interest cost and payment structure.
- Never call the per-euro figure a return, a rate or a yield. It is the interest avoided divided by the money put in to avoid it.
- Mention overpayments only if Gerry gave them.

## Omit By Default
For this playbook, do not emit:
- `generated.outputs`
- `generated.outputsBucketed`
- `generated.tables`
- `generated.charts`
- `generated.report`
- `generated.education`
- `generated.mortgageInputs`

The app computes the repeatable loan outputs after apply.

## Rendering Expectations
A loan with cases renders the same repayment-case module as a mortgage, in loan wording throughout: the case ladder and its commitment rails, the note that the monthly repayment is unchanged in every case, the lump-sum timing control, both heroes (when the loan clears, and what share of the interest bill goes), the time rail, the interest bar, the cost bar, the two charts the module draws for itself, the comparison table, the two notes on the per-euro column, and the keep-the-term alternative. See the mortgage playbook's Rendering Expectations for what each part is for. Assumptions and repayment outputs render below it.

- Keep the payload to `generated.loanInputs` plus a concise screen-share summary.
- If Gerry wants a teaching module about borrowing tradeoffs, create a separate Education or Report module instead of mixing block structures into this engine module.

## Good Output Looks Like
- The module uses `generated.loanInputs`, not `generated.mortgageInputs`.
- Summary wording clearly uses loan language.
- Placeholders are limited and called out in NOTES.

## Avoid
- Housing-mortgage language unless Gerry explicitly says the loan is secured on a property.
- Fake repayment tables or charts.
- Extra Report or Education keys in the same engine payload.
