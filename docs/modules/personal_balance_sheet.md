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
    "consumer": true,
    "platformConsumerApproved": true,
    "adviserConsumerEnabled": true
  },
  "implementation": {
    "status": "engine",
    "intakeContract": "approved",
    "scenarioAware": false,
    "playbook": "10_pbs_playbook.md",
    "outputKey": "generated.pbsInputs",
    "hasRunnableEngine": true
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
    "adviserGoals": [],
    "suggestedWhen": [],
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
    "monthly_spending",
    "specialist_asset_reconciliation"
  ],
  "eligibility": {
    "requireAll": [],
    "excludeIf": []
  },
  "factPreconditions": {},
  "clientBenefit": "create a clear breakdown of what you own and what you owe, and show how your cash, investments, pensions, property and debts fit together — including whether you are holding more cash than you need, and whether the overall shape looks aligned with your longer-term plans",
  "consumerReadiness": {
    "status": "approved",
    "reviewedOn": "2026-07-25",
    "blockingItems": []
  },
  "consumerLanguage": {
    "consumerShortLabel": "a review of your overall financial picture",
    "consumerOfferDescription": "We can look at your overall financial picture by bringing together what you own, what you owe and where your money is currently held. This can help show whether you may be keeping too much in cash, how your assets and debts fit together, and how your current position supports your longer-term goals",
    "consumerConfirmationDescription": "put together a review of your overall financial picture",
    "offerQuestion": "Would that be useful?",
    "offerClauses": [
      {
        "text": ", including retirement",
        "when": {
          "anyGoal": [
            "retire",
            "retire_early",
            "improve_pension"
          ]
        }
      }
    ]
  }
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
