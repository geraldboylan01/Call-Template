# Liquidity Playbook

<!-- planeir-planning-module {"moduleId":"liquidity_analysis","outputKey":"generated.liquidityPlan","role":"analysis"} -->

Use this playbook when Gerry says `use the liquidity playbook`, `cash buffer`, `emergency fund`, `too much cash`, or asks for a cash-only liquidity module.

## Job
Create a focused cash module that shows whether the client has too little, enough, or too much cash relative to their spending buffer target.

This is not the PBS playbook. Do not show net worth, lifestyle assets, pensions, property, liabilities, or broad asset buckets. The only financial position shown here is cash / deposits / near-cash reserve.

## Gerry's Live Prompt Can Stay Short
This style should work:

`Use the liquidity playbook. Working client. Cash 110000. Annual spend 48000.`

For a retired client:

`Use the liquidity playbook. Retired client. Cash 90000. Annual spend 60000.`

## Output Contract
- SECTION 1 - NOTES (FOR GERRY ONLY)
  - State current cash, spending, target reserve, surplus or shortfall, and any source dates used.
- SECTION 2 - DEV PANEL JSON (PASTE INTO APP)
  - Return a single JSON object.
  - Include the outer opening `{` before `"title"` and the final closing `}` after `generated`.

## Preferred Payload Shape

```json
{
  "title": "Liquidity Plan - Client",
  "generated": {
    "summaryHtml": "<p>...</p>",
    "liquidityPlan": {
      "currencySymbol": "€",
      "clientStatus": "not-retired",
      "annualExpenditure": 48000,
      "currentCash": 110000,
      "cashItems": [
        { "label": "Current account", "amount": 18000 },
        { "label": "Deposit account", "amount": 92000 }
      ],
      "headline": "The emergency fund is covered. The excess cash now needs a job.",
      "primaryActionLabel": "Cash to put to work",
      "primaryActionDetail": "Keep six months accessible, then decide where the surplus belongs: debt reduction, pension, long-term investment, or known spending.",
      "evidenceCards": [
        {
          "label": "Emergency fund guide",
          "value": "3-6 months",
          "detail": "Use current Irish or official consumer guidance if verified.",
          "sourceLabel": "CCPC",
          "sourceUrl": "https://www.ccpc.ie/manage-your-money/jargon-buster"
        }
      ],
      "nextSteps": [
        { "label": "Lock the reserve", "detail": "Keep the target emergency fund accessible." },
        { "label": "Name the surplus", "detail": "Show the amount above target so it can be assigned." },
        { "label": "Choose the destination", "detail": "Discuss debt, pension, investment, or planned spending." }
      ]
    }
  }
}
```

## Strict Schema Guardrails
- Use `generated.liquidityPlan` as the primary module contract.
- Do not emit `generated.outputsBucketed`; that is PBS-style and too broad for this module.
- Do not emit `generated.pbsInputs`.
- Do not emit `generated.outputs`, `generated.assumptions`, `generated.tables`, `generated.report`, or `generated.education` unless Gerry explicitly asks for an extra table or report.
- Numeric money fields must be plain numbers, not formatted strings. Use `110000`, not `"€110,000"`.
- Use `€`, not `EUR`, in displayed strings and `currencySymbol`.
- Do not invent spending, retirement status, source statistics, or account splits. If current cash is supplied as one number, use `currentCash` and omit `cashItems`.

## Runtime Fields
- `currencySymbol`: use `"€"` for Irish euro planning unless Gerry specifies another currency.
- `clientStatus`: `"not-retired"` or `"retired"`.
- `annualExpenditure`: annual household spending as a number. Use this when Gerry gives annual spend.
- `monthlyExpenditure`: optional alternative when Gerry gives monthly spend instead.
- `currentCash`: total cash / deposit / near-cash reserve.
- `cashItems[]`: optional account breakdown. Each item supports `label` and numeric `amount`.
- `minimumBufferMonths`: optional override. Default is 3 for working clients and 12 for retired clients.
- `targetBufferMonths`: optional override. Default is 6 for working clients and 24 for retired clients.
- `headline`: optional hero sentence. If omitted, the renderer creates one from the calculation.
- `primaryActionLabel`: optional short action label.
- `primaryActionDetail`: optional plain-English action detail.
- `evidenceCards[]`: optional source-backed context cards.
- `nextSteps[]`: optional action list. Each item supports `label` and `detail`.

## Threshold Logic
Working / not retired:
- Red: under 3 months of spending.
- Yellow: 3 months to under 6 months.
- Green: 6 months or more.
- Above 6 months: keep the six-month reserve accessible and frame the extra amount as cash that needs a job.

Retired:
- Red: under 12 months of spending.
- Yellow: 12 months to under 24 months.
- Green: 24 months or more.
- Above 24 months: keep the two-year reserve accessible and frame the extra amount as cash that needs a job.

The formula is:

`currentCash / (annualExpenditure / 12)`

If monthly spending is supplied instead:

`currentCash / monthlyExpenditure`

## Client Wording Rules
- This module is about the cash issue only.
- If cash is below the red threshold, the message is: build the emergency fund before return-seeking investments.
- If cash is between the red threshold and target, the message is: the reserve is started, but keep building.
- If cash is at or above target, the message is: the safety buffer is protected; surplus cash should be assigned to a job.
- Use "put cash to work", "cash needs a job", "inflation erodes idle cash", and "accessible reserve" where appropriate.
- Avoid shaming the client for holding cash. The tone should make safety feel good while making idle surplus feel costly.
- Avoid generic investment promises. Do not say surplus cash will earn a specific return unless Gerry supplied the assumption.

## Evidence / Research Rules
- Evidence is optional but powerful for this playbook.
- Use dated and source-backed facts only.
- If you have not been given current source facts, either omit `evidenceCards` or use stable guidance such as emergency-fund ranges from official consumer bodies.
- Good evidence types:
  - Irish household deposits from Central Bank of Ireland.
  - Irish deposit rates from Central Bank of Ireland.
  - Irish CPI inflation from CSO.
  - Emergency-fund guidance from CCPC or another reputable consumer body.
- Each evidence card should include `label`, `value`, `detail`, `sourceLabel`, and `sourceUrl` when available.
- Do not fabricate URLs, quotes, statistics, or publication dates.

## Notes Rules
Keep NOTES concise and call-friendly:
- current cash
- annual or monthly spending
- calculated months of cash
- target reserve
- cash surplus or shortfall
- retired / not-retired threshold used
- source dates for any evidence cards

## Omit By Default
For this playbook, do not emit:
- `generated.outputsBucketed`
- `generated.pbsInputs`
- `generated.outputs`
- `generated.assumptions`
- `generated.tables`
- `generated.charts`
- `generated.report`
- `generated.education`
- `generated.pensionInputs`
- `generated.netRetirementInputs`
- `generated.mortgageInputs`
- `generated.loanInputs`

## Good Output Looks Like
- First screen answers: current cash, target cash, months of spending, and surplus / shortfall.
- The advice changes with the status:
  - too little cash -> build emergency fund first
  - enough / too much cash -> protect reserve and put surplus to work
- Evidence cards support the behavioral point without turning the module into a research report.

## Avoid
- Reusing the personal balance sheet module.
- Showing net worth.
- Showing non-cash assets.
- Treating excess cash as simply "green" without naming the surplus action.
- Guessing client spend or retirement status.
