# House purchase planner

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "house_purchase",
  "manifestVersion": "2.0.0",
  "name": "House purchase planner",
  "kind": "calculation",
  "status": "beta",
  "availability": {
    "adviser": true,
    "consumer": true
  },
  "implementation": {
    "status": "engine",
    "intakeContract": "approved",
    "scenarioAware": true,
    "playbook": "17_house_purchase_playbook.md",
    "outputKey": "generated.housePurchaseInputs"
  },
  "routing": {
    "consumerRoutable": true,
    "goals": [
      {
        "type": "buy_home",
        "role": "direct"
      }
    ],
    "adviserGoals": [],
    "pinned": "never",
    "priorityBoost": 0
  },
  "requiredFacts": [
    "primary_goal",
    "partner_person",
    "target_home_price",
    "income_sources",
    "gross_household_income",
    "cash_savings",
    "liability_position",
    "liability_monthly_payment",
    "monthly_spending",
    "current_monthly_rent",
    "lending_category",
    "household_structure"
  ],
  "eligibility": {
    "requireAll": [],
    "excludeIf": []
  },
  "factPreconditions": {}
}
```

## Purpose

Illustrates what a household can afford to buy, the deposit they need, the timing, the costs, and the dated Irish support schemes that may apply.

## When to use

The client talks about buying a home, getting on the property ladder, saving a deposit, mortgage approval, or moving house. Also use it when someone says they are throwing money away on rent — the underlying goal is usually buying.

## When not to use

Do not use it when the client already owns their home and is only asking about their existing mortgage rate or term. That is Mortgage analysis.

## Client signals

_None recorded._
