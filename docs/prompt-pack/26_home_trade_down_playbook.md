# Home Trade Down Playbook

Use this playbook for `use the home trade down playbook`, trading down, or what a lower mortgage repayment would buy. Use House Purchase for a future purchase plan and Mortgage for paying off the existing loan.

## Job and output
Return the usual NOTES and strict JSON sections. Emit only a short client-facing `summaryHtml` and `homeTradeDownInputs` in `generated`. Describe what the viewer can compare without quoting uncalculated results. The app solves the loan, home budget, released cash and yearly saving. Never supply those outputs yourself.

## Example

```json
{
  "title": "Your home: trading down",
  "generated": {
    "summaryHtml": "<p>Compare staying with what a lower repayment could buy. The home value, costs and loan terms are the figures you gave.</p>",
    "homeTradeDownInputs": {
      "homeValue": 650000,
      "mortgageBalance": 280000,
      "currentAnnualRepayments": 30000,
      "sellingCosts": 15000,
      "buyingCosts": 12000,
      "newLoanTermYears": 15,
      "newLoanAnnualRate": 0.04,
      "baseScenarioId": "stay",
      "scenarios": [
        { "id": "stay", "kind": "stay" },
        { "id": "repay-18000", "kind": "move", "annualRepayment": 18000 },
        { "id": "repay-12000", "kind": "move", "annualRepayment": 12000 },
        { "id": "no-mortgage", "kind": "move", "annualRepayment": 0 }
      ]
    }
  }
}
```

## Required facts
- `homeValue`, `mortgageBalance` and `currentAnnualRepayments`: positive euros; annual repayments include the whole mortgage payment.
- `sellingCosts`, `buyingCosts`: 0 or more. Selling must clear the mortgage and selling costs; buying costs cannot exceed what is released. These are given figures, not a property-tax calculation.
- `newLoanTermYears`: integer 1 to 40. `newLoanAnnualRate`: decimal from 0 to 0.15 (4% is `0.04`). Both are required even for an all-cash case; ask when missing, with no invented default or current market-rate assumption.
- `scenarios`: one to four unique ids. `kind` is `stay` or `move`. Every move gives `annualRepayment`, from 0 to `currentAnnualRepayments`. A repayment of 0 means no new loan. The resulting displayed home budget (cash after selling and buying costs plus the rounded new loan) must also be no more than the current home value. A lower annual repayment can still breach this ceiling when the new term is longer or the rate is lower.
- Optional `baseScenarioId` names an existing case; otherwise the first is the base.
- Optional `title` and `description` speak to the client. Prefer the app's derived titles. Never recommend, rank, or say `we`, `us` or `our`.

Each move states a repayment, not a home price. The app solves the size of the new loan and the home budget. It rounds the new loan to €1,000 and reconciles the displayed cuts; do not reverse-engineer a desired house price into a made-up repayment.

For the ceiling preflight, use the app's monthly-payment calculation exactly. Let `P = annualRepayment / 12`, `r = newLoanAnnualRate / 12` and `n = newLoanTermYears * 12`. The unrounded loan is `P * n` when `r = 0`; otherwise it is `P * (-expm1(-n * log1p(r))) / r` (equivalently `P * (1 - (1 + r)^(-n)) / r`, but use the first form near zero). Round the loan to the nearest €1,000: `loanShown = 1000 * Math.round(loan / 1000)`. Round each of `homeValue`, `mortgageBalance`, `sellingCosts` and `buyingCosts` separately to whole euros using `Math.round`. Then `cashShown = roundedHomeValue - roundedMortgageBalance - roundedSellingCosts - roundedBuyingCosts`; accept the move only when `cashShown + loanShown <= roundedHomeValue`. These are preflight calculations, never additional JSON output fields.

When sale proceeds would not clear the mortgage and selling costs, or buying costs exceed the released proceeds, no case can be modelled. Return NOTES only, explain the constraint and ask for revised figures; if the figures are confirmed, state that this module cannot model that situation instead of emitting invalid JSON. When a required figure is missing, return NOTES only and ask one confirmation question before producing JSON. If a requested move would exceed the home-value ceiling, explain that this screen models trading down and ask for a lower repayment or revised loan terms; do not silently cap the loan, alter a requested repayment or emit a case the app refuses. Ask for any missing figure the screen would describe as given. Do not return fabricated costs, loan terms or a token mortgage balance. A mortgage-free current home is outside this contract; say so rather than using €1.

## Omit
No other engine input, hand-built assumptions, outputs, tables or charts. No `newLoan`, `homeBudget`, `releasedCash` or `freedPerYear` fields. No recommendation about moving, eligibility for a loan or a provider.

The video follows this screen. Leave rental keep-or-sell video wording as it is. This is an adviser Dev Panel playbook; consumer routing requires its own adapter work.
