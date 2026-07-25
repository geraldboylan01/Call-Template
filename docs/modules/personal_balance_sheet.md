# Personal balance sheet

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "personal_balance_sheet",
  "manifestVersion": "2.0.0",
  "name": "Personal balance sheet",
  "kind": "calculation",
  "status": "beta",
  "availability": {
    "adviser": true,
    "consumer": true
  },
  "implementation": {
    "status": "engine",
    "intakeContract": "approved",
    "scenarioAware": false,
    "playbook": "10_pbs_playbook.md",
    "outputKey": "generated.pbsInputs"
  },
  "routing": {
    "consumerRoutable": true,
    "goals": [
      {
        "type": "understand_position",
        "role": "direct"
      },
      {
        "type": "build_wealth",
        "role": "direct"
      }
    ],
    "pinned": "when_eligible",
    "priorityBoost": 0
  },
  "requiredFacts": [
    "primary_goal",
    "partner_person",
    "asset_position",
    "liability_position",
    "property_position",
    "business_position",
    "pension_positions",
    "pension_current_value",
    "specialist_asset_reconciliation"
  ],
  "eligibility": {
    "requireAll": [],
    "excludeIf": []
  },
  "factPreconditions": {}
}
```

## Purpose

Everything the household owns minus everything it owes, bucketed into lifestyle assets, spendable reserves, long-term retirement funding and concentrated assets.

## When to use

The client wants the full picture: where they stand overall, what they are worth, whether they are doing okay, or how to build wealth from here.

## When not to use

Do not add it as background context to a narrow goal when the household has little to show. Asking a renter with no pension what their home and business interests are worth is how a first meeting starts to feel like a form. Its inclusion is controlled by the pinned setting, not by prose.

## Client signals

_None recorded._
