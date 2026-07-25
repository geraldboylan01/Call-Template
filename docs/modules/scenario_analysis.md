# Scenario analysis

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "scenario_analysis",
  "manifestVersion": "2.0.0",
  "name": "Scenario analysis",
  "kind": "composition",
  "status": "unsupported",
  "availability": {
    "adviser": false,
    "consumer": false
  },
  "implementation": {
    "status": "capability",
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

Not a standalone analysis. Scenario handling is a composition capability layered over scenario-aware modules, which receive per-module or flat overrides and hash them into their result identity.

## When to use

Never select this directly. Apply scenario overrides to the scenario-aware modules instead — see the catalogue note below.

## When not to use

It has no engine, no fact-find and no adviser availability. The registry entry exists as a placeholder for the capability and must never be routed or offered as a module.

## Client signals

_None recorded._

## Catalogue note

Scenario handling is threaded through `orchestrator.js` `scenarioFor()` into every adapter and hashed into `scenarioSnapshotHash`. The scenario-aware modules are House purchase, Pension projection and Net retirement cash flow. This entry is a placeholder for that capability and is the only module with `adviserAvailable: false`.
