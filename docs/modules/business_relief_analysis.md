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
        "role": "direct",
        "requiresFact": "business_exit_intent"
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

Adviser-reviewed, date-versioned business relief analysis for succession and disposal.

## When to use

Adviser-led succession or exit planning where business relief conditions need to be applied against dated rules.

## When not to use

Never route this from a consumer conversation. See the catalogue note below: this overlaps the legacy business_owner_relief id and the pair needs resolving.

## Client signals

_None recorded._

## Catalogue note

Overlaps the legacy `business_owner_relief` id. Both are adviser-only with overlapping goals. P2 must merge them or record why both are kept.
