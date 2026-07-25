# Mortgage analysis

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "mortgage_analysis",
  "manifestVersion": "1.0.0",
  "name": "Mortgage analysis",
  "status": "beta",
  "consumerAvailable": false,
  "goals": [
    {
      "type": "optimise_mortgage",
      "role": "direct"
    }
  ],
  "pinned": "never",
  "priorityBoost": 0,
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

- "should I switch"
- "are we paying over the odds"
- "my fixed rate is ending"
- "is it worth overpaying"
