# College funding

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "college_funding",
  "manifestVersion": "2.0.0",
  "name": "College funding",
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
    "playbook": "14_college_funding_playbook.md",
    "outputKey": "generated.collegeFundingInputs"
  },
  "routing": {
    "consumerRoutable": true,
    "goals": [
      {
        "type": "fund_education",
        "role": "direct"
      }
    ],
    "adviserGoals": [],
    "suggestedWhen": [
      {
        "reason": "You have children to plan for, so I can put education costs alongside this.",
        "anyOf": [
          {
            "fact": "education_funding_intent",
            "equals": true
          },
          {
            "fact": "dependant_count",
            "min": 1
          },
          {
            "profileHas": "dependants"
          }
        ]
      }
    ],
    "pinned": "never",
    "priorityBoost": 0
  },
  "requiredFacts": [
    "primary_goal",
    "dependants",
    "dependant_current_age",
    "college_cost_scenarios"
  ],
  "eligibility": {
    "requireAll": [],
    "excludeIf": []
  },
  "factPreconditions": {}
}
```

## Purpose

Projects the cost of each child’s education against a reviewed cost scenario and shows what needs to be saved.

## When to use

The client raises paying for a child’s education, college or third-level costs, or saving for a specific child’s future.

## When not to use

Do not use it for general saving with no education aim, or where the "children" mentioned are adults with no dependency.

## Client signals

_None recorded._
