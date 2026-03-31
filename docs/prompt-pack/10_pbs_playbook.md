# PBS Playbook

Use this playbook when Gerry says `use the PBS playbook`, `run PBS`, or asks for a personal balance sheet module.

## Job
Classify assets and liabilities into the PBS bucket structure, calculate the displayed totals, and return a payload that fits the current PBS view cleanly.

## Gerry's Live Prompt Can Stay Short
This style should still work:

`Use the PBS playbook. Assets: ... Liabilities: ... Annual expenditure: ... Current age: ...`

## Output Contract
- SECTION 1 - NOTES (FOR GERRY ONLY)
  - Call out only the important classification decisions and totals.
- SECTION 2 - DEV PANEL JSON (PASTE INTO APP)
  - Return a single JSON object.

## Preferred Payload Shape

```json
{
  "title": "Personal Balance Sheet",
  "generated": {
    "summaryHtml": "<p>...</p>",
    "pbsInputs": {
      "annualExpenditure": 36000,
      "currentAge": 45
    },
    "outputsBucketed": {
      "currencySymbol": "EUR",
      "sections": []
    },
    "charts": []
  }
}
```

## Required PBS Sections
Emit `generated.outputsBucketed.sections` in this exact order:
1. `lifestyle`
2. `liquidity`
3. `longevity`
4. `legacy`
5. `liabilities`
6. `summary`

Each section must include:
- `key`
- `title`
- `columns`
- `rows`
- `subtotalLabel`
- `subtotalValue`

## Bucket Rules
- `Lifestyle`
  - Personal-use assets central to day-to-day living.
  - Examples: family home, car, contents.
- `Liquidity`
  - Assets usable for short-term spending needs or emergency reserves.
  - Examples: cash, deposits, money market funds, short-duration reserves.
- `Longevity`
  - Assets mainly intended to support retirement and long-term income.
  - Examples: pensions, PRSAs, retirement funds, clearly long-term diversified portfolios.
- `Legacy`
  - Illiquid, concentrated, optional, or higher-risk assets.
  - Examples: investment property, business interests, single stocks, crypto, collectibles.

## Ambiguity Policy For Classification
- Make the best reasonable classification and keep moving.
- Note the decision in NOTES if it is not obvious.
- Bias ambiguous items toward `Legacy` unless Gerry clearly frames them as liquid reserves or long-term retirement assets.
- Common cases:
  - rented property -> usually `Legacy`
  - private business value -> usually `Legacy`
  - single stocks or crypto -> usually `Legacy`
  - diversified investment account outside a pension -> `Longevity` if clearly long-term and income-focused, otherwise `Legacy`

## Summary Rules
- `generated.summaryHtml` should explain the four-bucket view in 2 to 4 sentences.
- If `annualExpenditure` is provided, you may mention the liquidity reserve in plain English.
- If both `annualExpenditure` and `currentAge` are provided, you may mention long-term funding pressure in plain English.
- Do not mention internal threshold colors or implementation details.

## `generated.pbsInputs`
- Include `annualExpenditure` only if Gerry provides it or clearly implies it.
- Include `currentAge` only if Gerry provides it or clearly implies it.
- If neither is known, omit `generated.pbsInputs`.
- Do not guess age or annual expenditure.

## Chart Rules
Prefer up to 2 bar charts:
- `Assets by bucket`
- `Gross assets vs liabilities vs net worth`

Use the exact bucket subtotals and summary totals from `outputsBucketed`.

## Notes Rules
Keep NOTES concise and call-friendly.
Include:
- material classification decisions
- bucket subtotals
- total gross assets
- total liabilities
- net worth
- optional liquidity months or longevity reserve multiple if Gerry supplied the relevant inputs

## Omit By Default
- Omit `generated.assumptions` unless Gerry explicitly says `override assumptions`.
- Omit `generated.outputs`.
- Omit unrelated keys such as `report`, `education`, `mortgageInputs`, `loanInputs`, and `pensionInputs`.
