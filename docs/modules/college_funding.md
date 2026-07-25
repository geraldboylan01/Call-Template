# College funding

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "college_funding",
  "manifestVersion": "1.0.0",
  "name": "College funding",
  "status": "beta",
  "consumerAvailable": false,
  "goals": [
    {
      "type": "fund_education",
      "role": "direct"
    }
  ],
  "pinned": "never",
  "priorityBoost": 0,
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
  "factPreconditions": {}
}
```

## Purpose

Projects the cost of each child’s education against a reviewed cost scenario and shows what needs to be saved.

## When to use

The client raises paying for a child’s education, college or third-level costs, or saving for a specific child’s future.

## When not to use

Do not use it for general saving with no education aim, or where the "children" mentioned are adults with no dependency.

## Client signals

- "college for the kids"
- "third level is going to be expensive"
- "saving for the children"
