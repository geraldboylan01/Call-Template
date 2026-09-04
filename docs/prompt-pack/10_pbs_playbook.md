# PBS Playbook

<!-- planeir-planning-module {"moduleId":"personal_balance_sheet","outputKey":"generated.pbsInputs","role":"analysis"} -->

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
  - Include the outer opening `{` before `"title"` and the final closing `}` after `generated`.

## Preferred Payload Shape

The object must include the outer opening `{` before `"title"` and the final closing `}` after `generated`.

```json
{
  "title": "Personal Balance Sheet",
  "generated": {
    "summaryHtml": "<p>...</p>",
    "pbsInputs": {
      "annualExpenditure": 36000,
      "currentAge": 45,
      "retirementStatus": "not-retired"
    },
    "outputsBucketed": {
      "currencySymbol": "€",
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
- The PBS summary section must use `key: "summary"` and must include a row labelled exactly `"Net worth"`. Do not label the rendered row `"Known net worth"`, `"Net wealth"`, `"Known net wealth"`, or `"Net assets"`.
- If only known values are being included, explain that in SECTION 1 NOTES and/or `summaryHtml`; keep the JSON metric label as `"Net worth"`.

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
- `columns`: exactly `["Asset", "Amount (€)"]`, `["Liability", "Amount (€)"]`, or `["Metric", "Amount (€)"]` for Irish euro planning unless a different currency is explicitly requested.
- `rows`: exactly two values per row, with the second value as a number, for example `["Primary residence", 450000]`.
- `subtotalLabel`
- `subtotalValue`

The `summary` section must use these three rows in this order:
```json
[
  ["Gross assets", 1050000],
  ["Total liabilities", 385000],
  ["Net worth", 665000]
]
```
Its `subtotalLabel` must also be exactly `"Net worth"`, and `subtotalValue` must equal the `"Net worth"` row.

## Optional PBS Alternatives
If Gerry asks for a second version of the PBS, keep the current position in `generated.outputsBucketed.sections` and add alternatives in `generated.outputsBucketed.scenarios`.

Each scenario must include:
- `id`: stable slug, for example `"sell-rental-property"`.
- `title`: client-facing title without the word `scenario`, for example `"Sell Rental Property"`.
- `summaryHtml`: optional short case note.
- `sections`: the same six PBS sections as the current position, fully recalculated for that alternative.
- `movements`: optional animation metadata only. Do not use movements instead of recalculating the scenario sections.

Each scenario's own `sections` array must also include a `summary` section with `key: "summary"`, the same three summary rows, and the exact `"Net worth"` label.

Movement entries:
- Use only these movement actions: `"add"`, `"reduce"`, `"increase"`, or `"remove"`.
- `from.rowLabel` should exactly match the row label in the current-position section.
- `to.rowLabel` should exactly match the target row label in the scenario section when that row exists.
- For a debt that is repaid and disappears from the scenario, keep `to.sectionKey: "liabilities"`, use the original liability row label, and set `action: "reduce"`.

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

For a property sale case, remove or reduce the property in `Legacy`, reduce the relevant debt in `Liabilities`, and put the surplus proceeds in the destination Gerry asked for. Use `Liquidity` only when the proceeds are being kept as cash or reserves. If Gerry asks to redirect the equity into a pension, add it to `Longevity` instead. Ensure `Gross assets`, `Total liabilities`, and `Net worth` reconcile independently in that scenario.

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
This section describes the Dev Panel artifact lane ONLY, where the model has
already produced the finished balance sheet in `generated.outputsBucketed` and
`pbsInputs` carries three optional hints for the liquidity colour coding. The
planning runtime uses the same key name for something entirely different -- the
full native input its deterministic engine calculates FROM. See Runtime Fields
below, and do not mix the two shapes in one object.
- Include `annualExpenditure` only if Gerry provides it or clearly implies it.
- Include `currentAge` only if Gerry provides it or clearly implies it.
- Include `retirementStatus: "retired"` if Gerry says the client is retired. Use `retirementStatus: "not-retired"` only if Gerry explicitly says they are not retired or still working.
- If neither is known, omit `generated.pbsInputs`.
- Do not guess age, annual expenditure, or retirement status.
- Liquidity colour coding is standard three-to-six-month reserve logic unless `retirementStatus` is `"retired"` or `currentAge` is 65 or over. For retired / age 65+ cases, liquidity is red under 12 months, yellow from 12 to under 24 months, and green at 24+ months.

## Runtime Fields
These are the fields of the native `personal_balance_sheet` planning input --
the object the deterministic engine receives. It is NOT the Dev Panel artifact
above: here the engine does every calculation, and nothing in this object is a
total, a subtotal or a net-worth figure.

- `currency` - required non-empty string. Server-supplied; use the value given.
- `assetPositions[]` - required array. Each entry needs all five of:
  - `id` - stable non-empty string identifying this holding
  - `label` - what the client called it, in their words
  - `bucket` - exactly one of `lifestyle_assets`, `spendable_reserves`,
    `retirement_funding`, `concentrated_assets`
  - `amount` - a finite non-negative number
  - `source` - non-empty string naming where the position came from
- `liabilityPositions[]` - required array. Each entry needs `id`, `label`,
  `amount` and `source`. There is no `bucket` on a liability.
- `monthlyExpenditure` - required KEY, whose value is a number or `null`.
  `null` means unknown, and the engine then omits reserve months entirely
  rather than estimating one. Never put a guessed figure here.
- `reconciliationWarnings[]` and `currencyWarnings[]` - required arrays of
  strings. Server-supplied.

### An Empty Array Is A Claim, Not A Silence
`assetPositions: []` asserts the client has no assets, and `liabilityPositions:
[]` asserts they have no debts. Both are real client statements and both are
representable -- "no, nothing else" closes a collection. Neither may be written
because the conversation has not reached the subject yet. Assets or liabilities
that are simply unknown are missing information, not an empty balance sheet.

### Identity, Ownership And Duplicates
- Each position is counted exactly once. `source` plus `id` is its identity, and
  the engine refuses a collection that repeats one.
- Two records describing the same holding are ONE position; two similar holdings
  the client genuinely has are two. That is a reading of the conversation.
- There is no owner field. Whose a holding is belongs in `label` and `id` --
  "Mary's PRSA" and "John's PRSA" are two positions, and a jointly held account
  is one position labelled as joint.

### What The Engine Calculates
Bucket subtotals, gross assets, total liabilities, net worth, spendable reserves
and reserve months. All of it is derived; none of it is ever authored here.

### What This Module Does Not Do
No currency conversion -- mixed currencies are reported as warnings, not
converted. No projection, growth, income, tax or time dimension: it is a
position at a point in time. No scenario levers. Nothing here is a forecast.

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
