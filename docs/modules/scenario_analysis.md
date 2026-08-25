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
    "consumer": false,
    "platformConsumerApproved": false,
    "adviserConsumerEnabled": false
  },
  "implementation": {
    "status": "capability",
    "intakeContract": "incomplete",
    "scenarioAware": false,
    "playbook": null,
    "outputKey": null,
    "hasRunnableEngine": false
  },
  "routing": {
    "consumerRoutable": false,
    "goals": [],
    "adviserGoals": [],
    "suggestedWhen": [],
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

Not a standalone analysis. Scenario handling is a composition capability layered over scenario-aware modules, which receive per-module or flat overrides and hash them into their result identity.

## When to use

Never select this directly. Apply scenario overrides to the scenario-aware modules instead — see the catalogue note below.

## When not to use

It has no engine, no fact-find and no adviser availability. The registry entry exists as a placeholder for the capability and must never be routed or offered as a module.

## Client signals

_None recorded._

## Catalogue note

Scenario handling is threaded through `orchestrator.js` `scenarioFor()` into every adapter and hashed into `scenarioSnapshotHash`. The scenario-capable modules, and the levers each one allows, are declared in `js/planning/scenario_catalogue.js`, which derives them from the Master Prompt Pack: Net retirement cash flow, Pension projection, College funding and House purchase.

This note previously named House purchase, Pension projection and Net retirement cash flow. That was wrong twice. College funding was omitted even though the pack makes its scenarios REQUIRED (`14_college_funding_playbook.md:99-119`) and the adapter already selects them per child, and Pension projection was listed as working when the adapter emitted a field (`scenarios`) that `pension_math.js` never reads -- it reads `rentalIncomeScenarios` -- so a pension what-if silently returned the base case.

Personal balance sheet is deliberately absent. The pack does define PBS alternatives (`10_pbs_playbook.md:85-115`), but assigns them to the AI author, which writes fully recalculated sections into `generated.outputsBucketed.scenarios[]`; `computePersonalBalanceSheet(input)` takes no options and the engine has no scenario concept. That gap is recorded in `SCENARIO_ARCHITECTURAL_GAPS`.

This entry is a placeholder for the capability and is the only module with `adviserAvailable: false`.
