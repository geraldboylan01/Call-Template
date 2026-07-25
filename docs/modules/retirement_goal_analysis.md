# Retirement Goal Analysis

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "retirement_goal_analysis",
  "manifestVersion": "2.0.0",
  "name": "Retirement Goal Analysis",
  "kind": "composition",
  "status": "beta",
  "availability": {
    "adviser": true,
    "consumer": false
  },
  "implementation": {
    "status": "routing_label",
    "intakeContract": "approved",
    "scenarioAware": false,
    "playbook": null,
    "outputKey": null
  },
  "routing": {
    "consumerRoutable": false,
    "goals": [],
    "pinned": "never",
    "priorityBoost": 0
  },
  "requiredFacts": [
    "primary_goal",
    "partner_person",
    "pension_positions",
    "person_current_age",
    "intended_retirement_age",
    "income_sources",
    "gross_household_income",
    "pension_current_value",
    "pension_employee_contribution_rate",
    "pension_employer_contribution_rate",
    "target_retirement_income",
    "annual_net_spending",
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

Composes the pension projection and the net retirement cash flow into a single adviser-reviewed retirement view.

## When to use

Adviser-composed retirement reviews where both the pre-tax pot and the after-tax cash flow are wanted as one output.

## When not to use

Not selected by consumer goal routing today. See the routing note below before enabling it — it is currently reachable only by explicit adviser selection.

## Client signals

_None recorded._

## Catalogue note

This is a routing label, not a second retirement engine: it selects the pension projection, the net retirement cash flow, or both. It has an approved intake contract but no `run()`, so it can pass readiness with nothing to execute. No goal routes to it today. Resolve deliberately in P2.
