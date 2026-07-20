# Mortgage Playbook

<!-- planeir-planning-module {"moduleId":"mortgage_analysis","outputKey":"generated.mortgageInputs","role":"analysis"} -->

Use this playbook when Gerry says `use the mortgage playbook`, wants a mortgage projection, or wants to test repayment and overpayment scenarios on a housing loan.

This playbook is for an existing housing loan with a balance, rate, and repayment path. Use the House Purchase playbook for a future purchase, buying capacity, deposit target, purchase date, household affordability, or Help to Buy / First Home Scheme screen.

## Job
Parse the dictated mortgage details into `generated.mortgageInputs` and write a short client-facing summary.

The browser app owns the repeatable mortgage maths after the payload is applied.

## Boundary With House Purchase
- Existing mortgage balance, repayment, term, payoff, or overpayment -> `generated.mortgageInputs`.
- Future target home, borrowing capacity, protected cash, buying costs, deposit timing, or Irish purchase-support screening -> `generated.housePurchaseInputs`.
- Do not combine both contracts in one module.
- Do not use a mortgage projection as a substitute for the House Purchase planner's affordability and scheme screens.

## Gerry's Live Prompt Can Stay Short
This style should still work:

`Use the mortgage playbook. Balance 320000. Rate 4.25 percent. Start January 2026. End December 2052. Repayment. Annual overpayment 3000.`

## Preferred Payload Shape

```json
{
  "title": "Mortgage Projection - Client",
  "generated": {
    "summaryHtml": "<p>...</p>",
    "mortgageInputs": {
      "currentBalance": 320000,
      "annualInterestRate": 0.0425,
      "startDateIso": "2026-01-01",
      "endDateIso": "2052-12-01",
      "remainingTermYears": null,
      "repaymentType": "repayment",
      "fixedPaymentAmount": null,
      "oneOffOverpayment": 0,
      "annualOverpayment": 3000,
      "loanKind": "mortgage"
    }
  }
}
```

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
- `annualOverpayment` - optional number, default 0
- `loanKind` - optional, prefer `mortgage`

## Parsing Rules
- Spoken `4.25 percent` -> `0.0425`
- Dates must be emitted as `YYYY-MM-DD`
- If Gerry gives an end date, set `endDateIso` and set `remainingTermYears` to `null`
- If Gerry gives a remaining term, set `remainingTermYears` and set `endDateIso` to `null`
- If Gerry gives a fixed monthly payment, set `fixedPaymentAmount`
- If Gerry does not give overpayments, set them to 0
- Always set `repaymentType` to `repayment`

## Best-Guess Defaults
Use placeholders only when needed to keep an exploratory module moving:
- If `startDateIso` is missing, use the first day of the current month and note it in NOTES.
- If both `endDateIso` and `remainingTermYears` are missing, use `remainingTermYears = 25` and note clearly that it is a placeholder term.
- If `fixedPaymentAmount` is not given, use `null`.

## Summary Rules
- Keep `generated.summaryHtml` to 2 to 4 sentences.
- Describe the scenario in plain English using the balance, rate, term or end date, repayment structure, and overpayment facts supplied.
- Tell the client how to read the first screen: focus on repayment, term/end date, interest cost, and how any overpayment changes the path.
- Mention overpayments only if Gerry gave them.
- Do not claim that the modeled payment path is the only possible structure.

## Omit By Default
For this playbook, do not emit:
- `generated.outputs`
- `generated.outputsBucketed`
- `generated.tables`
- `generated.charts`
- `generated.report`
- `generated.education`
- `generated.housePurchaseInputs`
- `generated.loanInputs`

The app computes the repeatable mortgage outputs after apply.

## Rendering Expectations
- The runtime will render payment structure, outputs, and charts from the mortgage engine after the payload is applied.
- Keep the payload to `generated.mortgageInputs` plus a concise screen-share summary.
- If Gerry wants affordability teaching or a narrative tradeoff report, create a separate Education or Report module rather than mixing block structures into this engine module.

## Good Output Looks Like
- Balance, rate, start date, term/end date, repayment type, and overpayments are cleanly parsed.
- Placeholders are limited and clearly identified in NOTES.
- Summary wording explains the scenario without overstating certainty.

## Avoid
- Interest-only structures, unless the runtime explicitly supports them in future.
- Fake amortisation tables or charts.
- Loan wording for a housing mortgage module.
