# Loan analysis

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "loan_analysis",
  "manifestVersion": "1.0.0",
  "name": "Loan analysis",
  "status": "beta",
  "consumerAvailable": false,
  "goals": [
    {
      "type": "manage_loan",
      "role": "direct"
    }
  ],
  "pinned": "never",
  "priorityBoost": 0,
  "requiredFacts": [
    "primary_goal",
    "loan_position",
    "loan_current_balance",
    "loan_annual_interest_rate",
    "loan_remaining_term_months"
  ],
  "eligibility": {
    "requireAll": [],
    "excludeIf": []
  },
  "factPreconditions": {}
}
```

## Purpose

Deterministic amortisation for non-housing debt, and what changes if it is repaid faster.

## When to use

The client mentions a car loan, credit union loan, personal loan or a credit card balance, or asks whether to clear a debt before saving or investing.

## When not to use

Do not use it for a mortgage — that is Mortgage analysis.

## Client signals

- "I've a car loan"
- "should I clear the credit card first"
- "credit union loan"
