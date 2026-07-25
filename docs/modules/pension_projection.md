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
    "consumer": false
  },
  "implementation": {
    "status": "engine",
    "intakeContract": "approved",
    "scenarioAware": true,
    "playbook": "11_retirement_playbook.md",
    "outputKey": "generated.pensionInputs"
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
    "pension_employee_contribution_rate",
    "pension_employer_contribution_rate",
    "target_retirement_income"
  ],
  "eligibility": {
    "requireAll": [],
    "excludeIf": []
  },
  "factPreconditions": {}
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
