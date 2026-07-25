# Net retirement cash flow

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "net_retirement_cashflow",
  "manifestVersion": "2.0.0",
  "name": "Net retirement cash flow",
  "kind": "calculation",
  "status": "beta",
  "availability": {
    "adviser": true,
    "consumer": false
  },
  "implementation": {
    "status": "engine",
    "intakeContract": "approved",
    "scenarioAware": true,
    "playbook": "15_net_retirement_cashflow_playbook.md",
    "outputKey": "generated.netRetirementInputs"
  },
  "routing": {
    "consumerRoutable": true,
    "goals": [
      {
        "type": "retire",
        "role": "companion"
      },
      {
        "type": "retire_early",
        "role": "companion"
      }
    ],
    "pinned": "never",
    "priorityBoost": 0
  },
  "requiredFacts": [
    "primary_goal",
    "person_current_age",
    "annual_net_spending",
    "income_sources",
    "asset_position"
  ],
  "eligibility": {
    "requireAll": [],
    "excludeIf": []
  },
  "factPreconditions": {}
}
```

## Purpose

Shows after-tax income against after-tax spending through retirement, including any shortfall and the fund needed to close it.

## When to use

The client wants to know whether the money will last, or what they will actually have to live on once tax is taken out. It runs alongside the pension projection for a retirement goal.

## When not to use

Do not use it on its own to answer a question about pot growth or contribution rates — that is the Pension projection.

## Client signals

_None recorded._
