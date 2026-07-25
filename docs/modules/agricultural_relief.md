# Agricultural relief

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "agricultural_relief",
  "manifestVersion": "2.0.0",
  "name": "Agricultural relief",
  "kind": "composition",
  "status": "adviser_only",
  "availability": {
    "adviser": true,
    "consumer": false
  },
  "implementation": {
    "status": "template_only",
    "intakeContract": "incomplete",
    "scenarioAware": false,
    "playbook": null,
    "outputKey": null
  },
  "routing": {
    "consumerRoutable": false,
    "goals": [],
    "adviserGoals": [
      {
        "type": "agricultural_planning",
        "role": "direct"
      }
    ],
    "suggestedWhen": [
      {
        "reason": "You have agricultural assets, which Gerry should review for the reliefs that may apply.",
        "anyOf": [
          {
            "fact": "agricultural_assets",
            "equals": true
          }
        ]
      }
    ],
    "pinned": "never",
    "priorityBoost": 0
  },
  "requiredFacts": [],
  "eligibility": {
    "requireAll": [],
    "excludeIf": []
  },
  "factPreconditions": {}
}
```

## Purpose

Adviser-only agricultural succession and relief planning.

## When to use

Adviser-led work for a farming household where agricultural relief conditions apply.

## When not to use

Never route this from a consumer conversation. Consumer use waits for deterministic, date-versioned rules and tests.

## Client signals

_None recorded._
