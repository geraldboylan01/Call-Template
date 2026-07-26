# Liquidity reserve

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "liquidity_analysis",
  "manifestVersion": "2.0.0",
  "name": "Liquidity reserve",
  "kind": "calculation",
  "status": "active",
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
    "playbook": "16_liquidity_playbook.md",
    "outputKey": "generated.liquidityPlan",
    "hasRunnableEngine": true
  },
  "routing": {
    "consumerRoutable": true,
    "goals": [
      {
        "type": "maintain_liquidity",
        "role": "direct"
      },
      {
        "type": "buy_home",
        "role": "companion"
      }
    ],
    "adviserGoals": [],
    "suggestedWhen": [
      {
        "reason": "I can also check your cash reserve against what you spend, so we know what is genuinely spare.",
        "anyOf": [
          {
            "profileHas": "cash"
          }
        ]
      }
    ],
    "pinned": "never",
    "priorityBoost": 0
  },
  "requiredFacts": [
    "primary_goal",
    "cash_savings",
    "monthly_spending"
  ],
  "eligibility": {
    "requireAll": [],
    "excludeIf": []
  },
  "factPreconditions": {},
  "clientBenefit": "check whether you have the right amount of money you can actually reach for everyday spending, emergencies and anything coming up soon, without leaving too much long-term money sitting uninvested",
  "consumerReadiness": {
    "status": "approved",
    "reviewedOn": "2026-07-25",
    "blockingItems": []
  },
  "consumerLanguage": {
    "consumerShortLabel": "a review of your accessible cash and emergency reserves",
    "consumerOfferDescription": "We can look at whether you have an appropriate amount available in cash for emergencies and near-term spending, while also considering whether too much of your longer-term money may be sitting uninvested",
    "consumerConfirmationDescription": "review your accessible cash and emergency reserves",
    "consumerCapacityDescription": "a review of your accessible cash and emergency reserves",
    "offerQuestion": "Would that be useful?",
    "offerClauses": []
  }
}
```

## Purpose

Compares the cash a household actually holds against a deterministic minimum and target emergency reserve, and names any surplus so it can be given a job.

## When to use

The client talks about an emergency fund, a cash buffer, how much to keep in the bank, feeling exposed if their income stopped, or having a lot of money sitting in a current account doing nothing. Also use it alongside a home purchase, so the deposit stays separate from the reserve they should not spend.

## When not to use

Do not use it for a broad "what am I worth" question — that is the Personal Balance Sheet. This analysis shows cash only: never net worth, property, pensions or lifestyle assets.

## Client signals

_None recorded._
