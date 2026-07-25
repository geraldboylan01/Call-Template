# Liquidity reserve

<!-- planeir-module-manifest -->

```json
{
  "moduleId": "liquidity_analysis",
  "manifestVersion": "1.0.0",
  "name": "Liquidity reserve",
  "status": "active",
  "consumerAvailable": true,
  "goals": [
    {
      "type": "maintain_liquidity",
      "role": "direct"
    },
    {
      "type": "buy_home",
      "role": "companion"
    }
  ],
  "pinned": "never",
  "priorityBoost": 0,
  "requiredFacts": [
    "primary_goal",
    "cash_savings",
    "monthly_spending"
  ],
  "eligibility": {
    "requireAll": [],
    "excludeIf": []
  },
  "factPreconditions": {}
}
```

## Purpose

Compares the cash a household actually holds against a deterministic minimum and target emergency reserve, and names any surplus so it can be given a job.

## When to use

The client talks about an emergency fund, a cash buffer, how much to keep in the bank, feeling exposed if their income stopped, or having a lot of money sitting in a current account doing nothing. Also use it alongside a home purchase, so the deposit stays separate from the reserve they should not spend.

## When not to use

Do not use it for a broad "what am I worth" question — that is the Personal Balance Sheet. This analysis shows cash only: never net worth, property, pensions or lifestyle assets.

## Client signals

- "how much should I keep for emergencies"
- "I've a lot sitting in the current account"
- "what happens if I lost my job tomorrow"
- "is it worth keeping this much in cash"
