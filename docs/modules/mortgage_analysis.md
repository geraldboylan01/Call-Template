# Mortgage analysis

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "mortgage_analysis",
  "manifestVersion": "2.0.0",
  "name": "Mortgage analysis",
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
    "playbook": "12_mortgage_playbook.md",
    "outputKey": "generated.mortgageInputs",
    "hasRunnableEngine": true
  },
  "routing": {
    "consumerRoutable": true,
    "goals": [
      {
        "type": "optimise_mortgage",
        "role": "direct"
      }
    ],
    "adviserGoals": [],
    "suggestedWhen": [
      {
        "reason": "You have a mortgage, so I can look at the rate and remaining term alongside the overall picture.",
        "anyOf": [
          {
            "profileHas": "mortgage"
          }
        ]
      }
    ],
    "pinned": "never",
    "priorityBoost": 0
  },
  "requiredFacts": [
    "primary_goal",
    "mortgage_position",
    "mortgage_current_balance",
    "mortgage_annual_interest_rate",
    "mortgage_remaining_term_months"
  ],
  "eligibility": {
    "requireAll": [],
    "excludeIf": []
  },
  "factPreconditions": {},
  "clientBenefit": "show your current mortgage repayment path and compare the alternatives — changing the term, switching, or making extra repayments",
  "consumerReadiness": {
    "status": "approved",
    "reviewedOn": "2026-07-26",
    "blockingItems": []
  },
  "consumerLanguage": {
    "consumerShortLabel": "a comparison of your mortgage repayment options",
    "consumerOfferDescription": "We can look at your current mortgage repayment path and compare what may happen if you changed the term, switched arrangement or made additional repayments",
    "consumerConfirmationDescription": "compare your mortgage repayment options",
    "offerQuestion": "Would you like to examine that?"
  }
}
```

## Purpose

Deterministic amortisation of an existing mortgage: balance, rate, remaining term, and the effect of changing any of them.

## When to use

The client has a mortgage already and is asking about the rate, the term, overpaying, switching lender, or a fixed rate coming to an end.

## When not to use

Do not use it for someone who has not bought yet. Affordability, deposit and approval belong to the House purchase planner.

## Client signals

_None recorded._
