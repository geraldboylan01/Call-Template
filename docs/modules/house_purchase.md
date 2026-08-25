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
    "consumer": true,
    "platformConsumerApproved": true,
    "adviserConsumerEnabled": true
  },
  "implementation": {
    "status": "engine",
    "intakeContract": "approved",
    "scenarioAware": true,
    "playbook": "17_house_purchase_playbook.md",
    "outputKey": "generated.housePurchaseInputs",
    "hasRunnableEngine": true,
    "scenarioLevers": [
      {
        "id": "targetPropertyPrice",
        "type": "money",
        "min": 1,
        "max": 5000000,
        "means": "the price of the house they are actually aiming at"
      },
      {
        "id": "plannedMonthlySavings",
        "type": "money",
        "min": 0,
        "max": 50000,
        "means": "what they can put aside each month towards the deposit"
      },
      {
        "id": "mortgageTermYears",
        "type": "integer",
        "min": 1,
        "max": 50,
        "means": "how long they take the mortgage over"
      },
      {
        "id": "mortgageIllustrationRate",
        "type": "rate",
        "min": 0,
        "max": 1,
        "means": "the rate the repayment is illustrated at"
      },
      {
        "id": "emergencyReserveTarget",
        "type": "money",
        "min": 0,
        "max": 500000,
        "means": "cash they intend to keep back rather than put into the deposit"
      }
    ]
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
    "suggestedWhen": [
      {
        "reason": "You mentioned buying, so I can put affordability and deposit timing alongside this.",
        "anyOf": [
          {
            "fact": "property_status",
            "in": [
              "first_time_buyer",
              "buying_soon"
            ]
          }
        ]
      }
    ],
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
  "factPreconditions": {},
  "clientBenefit": "work out the deposit, what is likely to be affordable, the mortgage you would need, and the savings path to get there",
  "consumerReadiness": {
    "status": "approved",
    "reviewedOn": "2026-07-25",
    "blockingItems": []
  },
  "consumerLanguage": {
    "consumerShortLabel": "a review of your home-purchase affordability and savings path",
    "consumerOfferDescription": "We can look at the deposit you may need, likely mortgage affordability and the savings path toward the purchase",
    "consumerConfirmationDescription": "review your home-purchase affordability and savings path",
    "offerQuestion": "Would that be useful?"
  }
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
