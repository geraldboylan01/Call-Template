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
    "consumer": false
  },
  "implementation": {
    "status": "engine",
    "intakeContract": "approved",
    "scenarioAware": false,
    "playbook": "12_mortgage_playbook.md",
    "outputKey": "generated.mortgageInputs"
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
  "factPreconditions": {}
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
