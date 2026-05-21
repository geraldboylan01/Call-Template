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

## Strict Schema Guardrails
- Do not emit a top-level `module` key. The app infers PBS from the payload shape and title.
- Do not emit `generated.summary`; use `generated.summaryHtml`.
- Do not emit custom primary PBS keys such as `generated.metrics`, `generated.buckets`, `generated.assets`, or `generated.liabilities`.
- Do not emit `generated.assumptions` as a key-value object or an array of `{ "label": ..., "value": ... }` objects. If Gerry explicitly asks to override assumptions, it must be a table: `{ "columns": ["Assumption", "Value"], "rows": [["Current age", 43]] }`.
- The primary PBS table must be `generated.outputsBucketed.sections`, not `generated.tables`.
- Every `outputsBucketed.sections[*].columns` array must contain exactly 2 strings.
- Every `outputsBucketed.sections[*].rows` entry must be exactly `[labelString, numericValue]`.
- Do not put formatted currency strings or unit strings in `outputsBucketed` numeric cells. Use `880000`, not `"€880,000"`; use `5.5`, not `"5.5 months"`.
- Do not add Owner, Comment, Notes, or Balance columns inside `outputsBucketed`; put narrative in SECTION 1 notes or section `notes`.

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
- `columns`: exactly `["Asset", "Amount ($)"]`, `["Liability", "Amount ($)"]`, or `["Metric", "Amount ($)"]` using the correct currency symbol.
- `rows`: exactly two values per row, with the second value as a number, for example `["Primary residence", 450000]`.
- `subtotalLabel`
- `subtotalValue`

## Optional PBS Alternatives
If Gerry asks for a second version of the PBS, keep the current position in `generated.outputsBucketed.sections` and add alternatives in `generated.outputsBucketed.scenarios`.

Each scenario must include:
- `id`: stable slug, for example `"sell-rental-property"`.
- `title`: client-facing title without the word `scenario`, for example `"Sell Rental Property"`.
- `summaryHtml`: optional short case note.
- `sections`: the same six PBS sections as the current position, fully recalculated for that alternative.
- `movements`: optional animation metadata only. Do not use movements instead of recalculating the scenario sections.

Movement entries:
```json
{
  "label": "Sell rental property",
  "from": { "sectionKey": "legacy", "rowLabel": "Buy-to-let property", "amount": 340000 },
  "to": [
    { "sectionKey": "liabilities", "rowLabel": "Mortgage", "amount": 220000, "action": "reduce" },
    { "sectionKey": "liquidity", "rowLabel": "Cash from sale", "amount": 120000, "action": "add" }
  ]
}
```

For a property sale case, remove or reduce the property in `Legacy`, reduce the relevant debt in `Liabilities`, add any surplus proceeds to `Liquidity`, and ensure `Gross assets`, `Total liabilities`, and `Net worth` / `Net assets` reconcile independently in that scenario.

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
- Define the buckets as jobs for your money: spendable reserves, lifestyle assets, retirement funding, concentrated or optional assets, and debts.
- Tell the client how to read the first screen: start with net worth, then look at where wealth is tied up versus available.
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

If a chart is useful, add chart `subtitle`, `display.valueFormat = "currency"`, and 1 to 2 `insights` that explain the client-facing meaning. Chart `insights` must be objects, never strings, for example `{ "label": "Liquidity", "detail": "Reserve adequacy depends on annual spending." }`. Do not add decorative charts.

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

## Good Output Looks Like
- Bucket subtotals reconcile to gross assets, liabilities, and net worth.
- Liquidity and longevity are framed as financial jobs, not just categories.
- Any chart reinforces the bucket story without replacing the detailed table.

## Avoid
- Guessing age or expenditure.
- Hiding uncertain or concentrated assets inside liquidity.
- Extra report or education structures for a PBS module.
