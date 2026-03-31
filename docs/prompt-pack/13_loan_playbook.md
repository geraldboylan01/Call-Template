# Loan Playbook

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
- `annualOverpayment` - optional number, default 0
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

## Best-Guess Defaults
Use placeholders only when needed to keep an exploratory module moving:
- If `startDateIso` is missing, use the first day of the current month and note it in NOTES.
- If both `endDateIso` and `remainingTermYears` are missing, use `remainingTermYears = 5` and note clearly that it is a placeholder term.
- If `fixedPaymentAmount` is not given, use `null`.

## Summary Rules
- Keep `generated.summaryHtml` to 2 to 4 sentences.
- Explain the scenario in plain English using loan wording, not mortgage wording.
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
