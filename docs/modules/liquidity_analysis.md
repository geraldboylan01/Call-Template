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
    "consumer": true
  },
  "implementation": {
    "status": "engine",
    "intakeContract": "approved",
    "scenarioAware": false,
    "playbook": "16_liquidity_playbook.md",
    "outputKey": "generated.liquidityPlan"
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
  "factPreconditions": {}
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
