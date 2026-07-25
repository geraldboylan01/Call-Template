# Business Relief Analysis

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "business_relief_analysis",
  "manifestVersion": "2.0.0",
  "name": "Business Relief Analysis",
  "kind": "composition",
  "status": "adviser_only",
  "availability": {
    "adviser": true,
    "consumer": false,
    "platformConsumerApproved": false,
    "adviserConsumerEnabled": false
  },
  "implementation": {
    "status": "template_only",
    "intakeContract": "incomplete",
    "scenarioAware": false,
    "playbook": null,
    "outputKey": null,
    "hasRunnableEngine": false
  },
  "routing": {
    "consumerRoutable": false,
    "goals": [],
    "adviserGoals": [
      {
        "type": "business_planning",
        "role": "direct",
        "requiresFact": "business_exit_intent"
      }
    ],
    "suggestedWhen": [
      {
        "reason": "You are planning an exit from the business, which Gerry should review for the reliefs that may apply.",
        "anyOf": [
          {
            "fact": "business_exit_intent",
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
  "factPreconditions": {},
  "clientBenefit": "",
  "consumerReadiness": {
    "status": "not_applicable",
    "reviewedOn": "",
    "blockingItems": []
  }
}
```

## Purpose

Adviser-reviewed, date-versioned business relief analysis for succession and disposal.

## When to use

Adviser-led succession or exit planning where business relief conditions need to be applied against dated rules.

## When not to use

Never route this from a consumer conversation. See the catalogue note below: this overlaps the legacy business_owner_relief id and the pair needs resolving.

## Client signals

_None recorded._

## Catalogue note

Overlaps the legacy `business_owner_relief` id. Both are adviser-only with overlapping goals. P2 must merge them or record why both are kept.
