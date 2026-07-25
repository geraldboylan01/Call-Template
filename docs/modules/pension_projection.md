# Pension projection

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "pension_projection",
  "manifestVersion": "1.0.0",
  "name": "Pension projection",
  "status": "beta",
  "consumerAvailable": false,
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
  "pinned": "never",
  "priorityBoost": 0,
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

- "is my pension on track"
- "should I be putting more in"
- "what does my employer match"
- "could I retire at sixty"
