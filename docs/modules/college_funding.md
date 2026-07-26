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
    "consumer": true,
    "platformConsumerApproved": true,
    "adviserConsumerEnabled": true
  },
  "implementation": {
    "status": "engine",
    "intakeContract": "approved",
    "scenarioAware": false,
    "playbook": "14_college_funding_playbook.md",
    "outputKey": "generated.collegeFundingInputs",
    "hasRunnableEngine": true
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
  "factPreconditions": {},
  "clientBenefit": "estimate what college is likely to cost using our standard living-at-home and living-away figures, and show the saving needed to fund four years for each child",
  "consumerReadiness": {
    "status": "approved",
    "reviewedOn": "2026-07-26",
    "blockingItems": []
  },
  "consumerLanguage": {
    "consumerShortLabel": "an estimate of future college costs and the saving required",
    "consumerOfferDescription": "We can estimate the future cost of four years of college for {childPossessive} education and compare a situation where they attend nearby and live at home with one where they need accommodation away from home. We can then show the level of saving that may be required",
    "consumerConfirmationDescription": "estimate the future cost of {childPossessive} college education",
    "consumerCapacityDescription": "an estimate of the future cost of {childPossessive} college education",
    "offerQuestion": "Would that be useful?",
    "offerClauses": []
  }
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
