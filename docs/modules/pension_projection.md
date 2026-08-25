# Pension projection

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "pension_projection",
  "manifestVersion": "2.0.0",
  "name": "Pension projection",
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
    "playbook": "11_retirement_playbook.md",
    "outputKey": "generated.pensionInputs",
    "hasRunnableEngine": true,
    "scenarioLevers": [
      {
        "id": "retirement_age",
        "type": "integer",
        "min": 50,
        "max": 75,
        "means": "the age they actually stop or cut back, rather than the one already on file"
      },
      {
        "id": "annual_contribution",
        "type": "money",
        "min": 0,
        "max": 200000,
        "means": "what goes into the pension each year from here on"
      },
      {
        "id": "growth_rate",
        "type": "rate",
        "min": -0.05,
        "max": 0.12,
        "means": "the net growth assumed between now and then"
      }
    ]
  },
  "routing": {
    "consumerRoutable": true,
    "goals": [
      {
        "type": "improve_pension",
        "role": "direct"
      },
      {
        "type": "retire",
        "role": "direct"
      },
      {
        "type": "retire_early",
        "role": "direct"
      }
    ],
    "adviserGoals": [],
    "suggestedWhen": [
      {
        "reason": "You have a pension, so I can show whether it is on track for the retirement you want.",
        "anyOf": [
          {
            "fact": "has_pension",
            "equals": true
          },
          {
            "profileHas": "pension"
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
    "pension_positions",
    "person_current_age",
    "intended_retirement_age",
    "income_sources",
    "gross_household_income",
    "pension_current_value",
    "pension_contribution_status",
    "pension_employee_contribution_rate",
    "pension_employer_contribution_rate",
    "pension_projected_annual_income",
    "pension_benefit_start_age",
    "pension_retirement_lump_sum",
    "target_retirement_income"
  ],
  "eligibility": {
    "requireAll": [],
    "excludeIf": []
  },
  "factPreconditions": {
    "pension_employer_contribution_rate": {
      "skipWhen": {
        "fact": "employment_context",
        "in": [
          "self_employed",
          "contractor"
        ]
      },
      "reason": "A sole trader or contractor has no employer, so an employer contribution rate is not a question that can be answered."
    }
  },
  "clientBenefit": "project how your pension may develop using our approved 5% growth and 2% inflation planning assumptions, and show whether your current contributions and retirement timing look aligned with what you want",
  "consumerReadiness": {
    "status": "approved",
    "reviewedOn": "2026-07-26",
    "blockingItems": []
  },
  "consumerLanguage": {
    "consumerShortLabel": "a projection of whether your pension may be on track",
    "consumerOfferDescription": "We can project how your pension may develop based on your current pension value, contributions and intended retirement timing, using our approved long-term planning assumptions: 5% annual investment growth intended to represent a medium-risk diversified portfolio and 2% annual inflation. Investment returns are not guaranteed",
    "consumerConfirmationDescription": "project whether your pension may be on track",
    "offerQuestion": "Would you like to see that?"
  }
}
```

## Purpose

Projects pre-tax pension pots forward and shows readiness against a target retirement income.

## When to use

The client asks whether their pension is on track, whether they are paying in enough, about contribution rates or an employer match, or whether they could retire at a particular age.

## When not to use

Do not use it for what the household will actually have to live on after tax — that is Net retirement cash flow. Use both together when the client is planning retirement rather than just building a pot.

## Client signals

_None recorded._
