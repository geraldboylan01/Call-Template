# Mortgage Playbook

<!-- planeir-planning-module {"moduleId":"mortgage_analysis","outputKey":"generated.mortgageInputs","role":"analysis"} -->

Use this playbook when Gerry says `use the mortgage playbook`, wants a mortgage projection, or wants to compare repayment and overpayment options on a housing loan.

This playbook is for an existing housing loan with a balance, rate, and repayment path. Use the House Purchase playbook for a future purchase, buying capacity, deposit target, purchase date, household affordability, or Help to Buy / First Home Scheme screen.

## Job
Parse the dictated mortgage details into `generated.mortgageInputs`, set up the cases Gerry wants to compare, and write a short client-facing summary.

The browser app owns the repeatable mortgage maths after the payload is applied, including every comparison figure: interest saved, time saved, amount paid in, and the interest saved per euro paid in.

## Boundary With House Purchase
- Existing mortgage balance, repayment, term, payoff, or overpayment -> `generated.mortgageInputs`.
- Future target home, borrowing capacity, protected cash, buying costs, deposit timing, or Irish purchase-support screening -> `generated.housePurchaseInputs`.
- Do not combine both contracts in one module.
- Do not use a mortgage projection as a substitute for the House Purchase planner's affordability and scheme screens.

## Gerry's Live Prompt Can Stay Short
Both of these should work:

`Use the mortgage playbook. Balance 320000. Rate 4.25 percent. Start January 2026. End December 2052. Repayment. Annual overpayment 3000.`

`Use the mortgage playbook. Balance 320000. Rate 4.25 percent. End December 2052. Compare doing nothing, 3000 a year, a 25000 lump sum, and both.`

## Preferred Payload Shape

A single path, when Gerry describes only one:

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

Cases, when Gerry wants to compare options:

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
      "loanKind": "mortgage",
      "overpaymentBenefit": "shorterTerm",
      "baseScenarioId": "current",
      "scenarios": [
        { "id": "current", "title": "No overpayment", "oneOffOverpayment": 0, "annualOverpayment": 0 },
        { "id": "annual-3k", "title": "3,000 a year", "annualOverpayment": 3000 },
        { "id": "lump-25k", "title": "25,000 lump sum", "oneOffOverpayment": 25000 },
        { "id": "both", "title": "Lump sum and 3,000 a year", "oneOffOverpayment": 25000, "annualOverpayment": 3000 }
      ]
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
- `oneOffOverpaymentMonth` - optional whole number of months from the start, default 0 (already paid)
- `annualOverpayment` - optional number, default 0
- `overpaymentBenefit` - optional, `shorterTerm` (default) or `lowerPayment`
- `baseScenarioId` - optional, required to match a case id when `scenarios` is present
- `scenarios` - optional array of cases, maximum 4
- `loanKind` - optional, prefer `mortgage`

## Cases
Use `scenarios` when Gerry wants to compare options rather than model one path. Phrases that mean cases:
- compare overpayments
- lump sum versus paying extra each year
- what would overpaying save
- what if we cleared 25000 off it
- what if we switched to 3.2 percent

Rules:
- Maximum 4 cases, including the do-nothing case. A fifth case is rejected.
- Each case needs a unique `id` and a client-facing `title`.
- A case restates only what it changes. Everything it leaves out is inherited from the loan itself, so a rate correction reaches every case that did not override it.
- A case may override `oneOffOverpayment`, `oneOffOverpaymentMonth`, `annualOverpayment`, `fixedPaymentAmount`, `annualInterestRate`, `overpaymentBenefit`, and the term as either `endDateIso` or `remainingTermYears`, never both.
- Set `baseScenarioId` to the case everything else is measured against. Normally this is the do-nothing case. If the client already overpays and is asking about doing more, make their current position the base so the saving shown is the saving from here.
- Always include the base case explicitly. Without something to compare against, there is no interest saved to show.
- Order cases from least to most action. The buttons read left to right as an increasing commitment.

### Naming Cases
Case titles are buttons on a live call, so keep them short, concrete, and in the client's own terms.
- Good: `No overpayment`, `3,000 a year`, `25,000 lump sum`, `Lump sum and 3,000 a year`, `Switch to 3.2%`
- Avoid: `Scenario 1`, `Base case`, `Aggressive overpayment strategy`, `Option B`
- Do not put the word `scenario` in a title.

## When The Lump Sum Is Paid
`oneOffOverpaymentMonth` is the number of whole months from the start of the schedule before the lump sum lands. `0`, the default, means it is already paid, so it comes off the opening balance and the schedule never charges interest on it.

Rules:
- Leave it out unless Gerry says the money is not available yet. The module has its own control for deferring it, and the client can move it on the call.
- Set it when Gerry states a date: a bonus in March, a policy maturing in two years, a sale that has not closed.
- Waiting costs money, and the module says so: the same lump sum removes less interest the longer it waits, because it has fewer months and a smaller balance to work against.

## Overpayment Benefit
An Irish lender asks the borrower which they want when capital is paid off a mortgage:
- keep the repayment the same and finish earlier (`shorterTerm`), or
- keep the term and reduce the repayment (`lowerPayment`).

Rules:
- Default to `shorterTerm` and only set `lowerPayment` when Gerry says the client wants the repayment reduced, or asks to see what that choice costs.
- `shorterTerm` holds the contractual repayment, so every case is measured on the same basis and the comparison reads honestly.
- Regular and annual overpayments always shorten the term; `overpaymentBenefit` governs the lump sum.

## Parsing Rules
- Spoken `4.25 percent` -> `0.0425`
- Dates must be emitted as `YYYY-MM-DD`
- If Gerry gives an end date, set `endDateIso` and set `remainingTermYears` to `null`
- If Gerry gives a remaining term, set `remainingTermYears` and set `endDateIso` to `null`
- If Gerry gives a fixed monthly payment, set `fixedPaymentAmount`
- A monthly overpayment is a higher repayment: express `pay 1,800 a month instead of 1,662` as `fixedPaymentAmount: 1800` on that case
- If Gerry does not give overpayments, set them to 0
- Always set `repaymentType` to `repayment`

## Best-Guess Defaults
Use placeholders only when needed to keep an exploratory module moving:
- If `startDateIso` is missing, use the first day of the current month and note it in NOTES.
- If both `endDateIso` and `remainingTermYears` are missing, use `remainingTermYears = 25` and note clearly that it is a placeholder term.
- If `fixedPaymentAmount` is not given, use `null`.
- If Gerry asks to compare overpayments without naming amounts, build a do-nothing case plus two round, clearly-flagged placeholder cases and say in NOTES that the amounts are illustrative.

## Summary Rules
- Keep `generated.summaryHtml` to 2 to 4 sentences.
- Describe the scenario in plain English using the balance, rate, term or end date, repayment structure, and the cases being compared.
- Tell the client how to read the first screen: it opens on their current path, the buttons step through the cases, and each case answers two things side by side -- when the mortgage clears, and how much of the interest bill goes. The table underneath shows every case at once.
- Mention overpayments only if Gerry gave them.
- Do not state the interest saved, the payoff date, or the per-euro figure as a number. The runtime calculates those and they must not be duplicated or contradicted in the summary.
- Never call the per-euro figure a return, a rate or a yield. It is the interest avoided divided by the money put in to avoid it, and the module carries two paragraphs explaining why that is a different question from every other measure on the screen. A summary that calls it a return contradicts them.
- Do not claim that the modeled payment path is the only possible structure.

## Caveats Worth Carrying
Include these in client-facing wording when they apply, either in `summaryHtml` or in NOTES:
- On a fixed rate, most Irish lenders only allow a limited overpayment each year without a breakage fee, commonly around 10 percent of the balance. A modelled lump sum needs checking with the lender first.
- Cases shorten the term by default. Taking the benefit as a lower repayment instead is a choice the lender will ask about, and it saves materially less interest.
- Money used to clear a mortgage is money not held as a reserve or invested. The comparison shows the interest saved, not whether overpaying is the best use of the cash.

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
The runtime renders one module, top to bottom, from `generated.mortgageInputs`. It answers one question: what does overpaying actually buy the client.

- A case ladder. Each card carries the money that case commits and a rail filled to its share of the largest commitment, so the cards read as increasing commitment rather than four equal options. **The module opens on the base case**, so every figure starts on the path the client is already on and the click is what changes it.
- A note under the ladder stating that the monthly repayment is the same in every case. This is the one thing a client cannot infer from the screen and will otherwise get wrong, so do not restate it in the summary.
- A timing control for when the lump sum is paid, which recalculates every case.
- **Two heroes, side by side and permanently labelled**: when the mortgage clears, and what proportion of the interest bill goes and what it costs. Both read the same on every case; only the values move.
- A time rail spanning the whole term, an interest bar cut at what this case still pays, and a cost bar of the client's own money on the identical scale.
- Two charts, drawn by the module itself rather than by the charts card, which this module does not show: the remaining balance against the base case, and the interest charged each year.
- A table with one row per case, and two notes explaining the per-euro column, which ranks the cases differently from every other measure on the screen.
- A closing section on the alternative: keep the term and lower the repayment instead, and what that costs in interest.

Notes for authoring:
- Each case button shows its own outcome, so the comparison can be read before anything is clicked.
- Keep the payload to `generated.mortgageInputs` plus a concise screen-share summary.
- If Gerry wants affordability teaching or a narrative tradeoff report, create a separate Education or Report module rather than mixing block structures into this engine module.

## Good Output Looks Like
- Balance, rate, start date, term/end date, repayment type, and cases are cleanly parsed.
- There is an explicit do-nothing case for the alternatives to be measured against.
- Case titles are short and read as options a client would recognise.
- Placeholders are limited and clearly identified in NOTES.
- Summary wording explains the comparison without restating the numbers the runtime calculates.

## Avoid
- Interest-only structures, unless the runtime explicitly supports them in future.
- Fake amortisation tables, comparison figures, or charts.
- More than 4 cases.
- Cases that differ only cosmetically, such as 3,000 and 3,100 a year.
- Loan wording for a housing mortgage module.
