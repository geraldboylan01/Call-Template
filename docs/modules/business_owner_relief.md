# Business owner relief (legacy)

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "business_owner_relief",
  "manifestVersion": "2.0.0",
  "name": "Business owner relief (legacy)",
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

Backward-compatible adviser-only business succession and relief module id, retained so existing adviser sessions and saved plans keep resolving.

## When to use

Only where an existing saved plan or adviser session already references this id.

## When not to use

Do not use it for new work. See the catalogue note below: business_relief_analysis is the current id and the duplication needs a deliberate decision.

## Client signals

_None recorded._

## Catalogue note

Legacy id retained for backward compatibility with saved adviser plans. Overlaps `business_relief_analysis`. P2 must merge or record why both are kept.
