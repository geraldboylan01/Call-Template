# Protection analysis

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "protection_analysis",
  "manifestVersion": "2.0.0",
  "name": "Protection analysis",
  "kind": "composition",
  "status": "unsupported",
  "availability": {
    "adviser": true,
    "consumer": false
  },
  "implementation": {
    "status": "template_only",
    "intakeContract": "incomplete",
    "scenarioAware": false,
    "playbook": "22_protection_playbook.md",
    "outputKey": "generated.report"
  },
  "routing": {
    "consumerRoutable": false,
    "goals": [],
    "adviserGoals": [],
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

A report-style protection module covering income protection and serious-illness cover, written to be calm and client-friendly without pretending to be an underwriting or quotation engine.

## When to use

Gerry asks for a protection module, or the conversation turns to what happens to the household income if someone cannot work. Adviser-produced today via the protection playbook.

## When not to use

Never route this from a consumer conversation. It has no deterministic engine and no approved fact-find, so it cannot be run or made ready automatically.

## Client signals

_None recorded._
