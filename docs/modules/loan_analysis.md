# Loan analysis

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "loan_analysis",
  "manifestVersion": "2.0.0",
  "name": "Loan analysis",
  "kind": "calculation",
  "status": "beta",
  "availability": {
    "adviser": true,
    "consumer": true,
    "platformConsumerApproved": true,
    "adviserConsumerEnabled": true
  },
  "implementation": {
    "status": "engine",
    "intakeContract": "approved",
    "scenarioAware": false,
    "playbook": "13_loan_playbook.md",
    "outputKey": "generated.loanInputs",
    "hasRunnableEngine": true
  },
  "routing": {
    "consumerRoutable": true,
    "goals": [
      {
        "type": "manage_loan",
        "role": "direct"
      }
    ],
    "adviserGoals": [],
    "suggestedWhen": [
      {
        "reason": "You mentioned a loan, so I can show what clearing it earlier would change.",
        "anyOf": [
          {
            "profileHas": "loan"
          }
        ]
      }
    ],
    "pinned": "never",
    "priorityBoost": 0
  },
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
  "factPreconditions": {},
  "clientBenefit": "show what happens if you keep making normal repayments versus paying it off faster, including the interest you would save and the effect on your monthly cash flow",
  "consumerReadiness": {
    "status": "approved",
    "reviewedOn": "2026-07-26",
    "blockingItems": []
  },
  "consumerLanguage": {
    "consumerShortLabel": "a comparison of your loan repayment options",
    "consumerOfferDescription": "We can compare continuing with the current repayments against paying it down faster, including the potential interest saved and the effect on your monthly cash flow",
    "consumerConfirmationDescription": "compare your loan repayment options",
    "offerQuestion": "Would you like to look at that?"
  }
}
```

## Purpose

Deterministic amortisation for non-housing debt, and what changes if it is repaid faster.

## When to use

The client mentions a car loan, credit union loan, personal loan or a credit card balance, or asks whether to clear a debt before saving or investing.

## When not to use

Do not use it for a mortgage — that is Mortgage analysis.

## Client signals

_None recorded._
