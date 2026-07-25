# Business Owner Analysis

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "business_owner_analysis",
  "manifestVersion": "2.0.0",
  "name": "Business Owner Analysis",
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
        "type": "business_planning",
        "role": "direct"
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

Adviser-reviewed planning around a household business interest.

## When to use

Adviser-led work for a company director or owner-manager where the business interest materially shapes the plan.

## When not to use

Never route this from a consumer conversation. Consumer use waits for a code-owned general business-owner analysis.

## Client signals

_None recorded._
