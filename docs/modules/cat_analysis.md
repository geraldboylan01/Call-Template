# Capital Acquisitions Tax analysis

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "cat_analysis",
  "manifestVersion": "2.0.0",
  "name": "Capital Acquisitions Tax analysis",
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
        "type": "transfer_wealth",
        "role": "direct"
      }
    ],
    "suggestedWhen": [
      {
        "reason": "You raised passing on wealth, which Gerry should review for the tax thresholds that apply.",
        "anyOf": [
          {
            "fact": "wealth_transfer_intent",
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

Adviser-only Capital Acquisitions Tax planning around gifts, inheritance and thresholds.

## When to use

Adviser-led wealth-transfer work where dated CAT thresholds and reliefs are applied by hand under review.

## When not to use

Never route this from a consumer conversation. Consumer use waits for deterministic, date-versioned CAT rules and tests. A wealth-transfer goal should defer to an adviser handoff instead.

## Client signals

_None recorded._
