# Future Cost Fund Playbook

Use this playbook when Gerry says `use the future cost fund playbook`, or asks how to have the money ready for one cost that starts on a known date: college, school fees, care for a parent, or anything else that runs for a set number of years. It compares the ways of funding that cost: a lump sum today, saving every year, part of each, or starting to save later.

## Job
Parse the cost and the ways of funding it into `generated.futureCostFundInputs`, then write a short client-facing summary.

The browser app owns the maths after the payload is applied. It grows the cost by the central price rate, grows the fund at the central cash rate after DIRT, solves the lump sum and the yearly amount for each case, and draws the fund over the years.

## How It Differs From College Funding
- College Funding answers **what will college cost**: per child, across scenarios such as living at home or away.
- Future Cost Fund answers **how do you have the money ready for one dated cost**: a lump sum now against saving each year, and when to start.
- Run College Funding first when the question is the size of the cost. Run this playbook when the yearly cost is known and the question is how to fund it.

## Gerry's Live Prompt Can Stay Short
This style should work:

`Use the future cost fund playbook. College in 8 years for four years, 15000 a year in today's money. Show a lump sum, saving every year, half and half, and starting in 3 years.`

## Output Contract
- SECTION 1 - NOTES (FOR GERRY ONLY)
  - Keep it to the key assumptions, placeholders, and any non-obvious case choice.
  - One line per case naming how it is funded. The app calculates the amounts, so do not estimate them.
- SECTION 2 - DEV PANEL JSON (PASTE INTO APP)
  - Return a single strict JSON object.
  - Use straight double quotes only. Do not use smart quotes.
  - Keep notes outside the JSON object.

## Preferred Payload Shape

```json
{
  "title": "College - Ways to Have the Money Ready",
  "generated": {
    "summaryHtml": "<p>College starts in 8 years and runs for four. This shows what each way of saving would ask of you, and that every way covers the same cost: what changes is when the money leaves your hands. Start with the buttons, then follow your fund to the year the cost begins.</p>",
    "futureCostFundInputs": {
      "costTitle": "College",
      "costKind": "education",
      "startsInYears": 8,
      "durationYears": 4,
      "annualCostToday": 15000,
      "baseScenarioId": "lump-sum",
      "scenarios": [
        { "id": "lump-sum", "title": "Lump sum today", "lumpShare": 1 },
        { "id": "every-year", "title": "Save every year", "lumpShare": 0 },
        { "id": "half-and-half", "title": "Half and half", "lumpShare": 0.5 },
        { "id": "start-later", "title": "Start in 3 years", "lumpShare": 0, "savingStartsInYears": 3 }
      ]
    }
  }
}
```

## Required Inputs
- `costTitle`: the client-facing name of the cost, shown as the heading. 1 to 60 characters. For example `College`, `School fees`, `Care for Mam`.
- `costKind`: `"education"` or `"general"`. Required, with no default. It picks the central price rate: education costs rise faster than general prices. Use `education` for college and school fees, `general` for everything else.
- `startsInYears`: whole years from today until the cost's first year. 1 to 40.
- `durationYears`: how many years the cost runs. 1 to 30. A one-off cost is 1.
- `annualCostToday`: one year of the cost in today's money. Greater than 0.
- `scenarios`: 1 to 4 cases.

Each case needs:
- `id`: unique and stable.
- `lumpShare`: the share of the whole cost funded by a lump sum today, from 0 to 1. Default 0.

Optional on each case:
- `title`: the button name. Without one the app uses `Lump sum today`, `Save every year`, `Part now, part each year` or `Start in {n} years`.
- `description`: one sentence.
- `savingStartsInYears`: when yearly saving begins, in whole years from today. Default 0. Must be less than `startsInYears`, unless `lumpShare` is 1.

`baseScenarioId` is optional and must match a case id. The default is the first case.

## Choosing the Cases
- A case states **how** the cost is funded, never **how much**. The app solves every amount. Never put a euro figure in a case.
- If Gerry does not name the cases, use the four standard ones: a lump sum today (`lumpShare` 1), saving every year (`lumpShare` 0), half and half (`lumpShare` 0.5), and starting later (`lumpShare` 0 with `savingStartsInYears` about a third of the years before the cost, at least 1). Drop the start-later case when the cost starts in 1 year.
- At most 4 cases. A fifth is rejected and the whole module fails to apply.
- Order them as Gerry gives them. Otherwise lump sum first, then the rest from least to most delay.

## Rates Are Central
- Do not emit any rate. `priceGrowthRate`, `savingsGrowthRate`, `inflationRate` and `dirtRate` are each rejected with `generated.futureCostFundInputs.<field> is not accepted. Rates are set centrally in the Planéir assumptions.`
- Education costs rise 4% a year and general prices 2%. The fund earns the central instant-access cash rate, 0.2% before DIRT, with DIRT at 33% taken each year.
- If Gerry dictates a different rate, keep the central rates, build the module, and say in NOTES that the rate he gave is not used.

## Not Modelled
Say so in NOTES when it matters, and keep the payload as it is:
- **Money already set aside for the cost.** The fund starts from nothing.
- **A stated saving amount**, such as `what if they save 5000 a year`. The app solves amounts. Build the closest case and name the gap in NOTES.
- **Investing the fund.** The fund is held in cash at the central rate. Growth is small at that rate, so the cases mostly differ in when the money goes in.
- **Grants, tax relief or anything paid out of the fund.**
- **More than one cost.** One module per dated cost. Two children starting college in different years are two modules.

## Runtime Outputs
- Case buttons with a derived amount line, for example `€10,800 a year for 8 years`.
- A headline per case, for example `Putting in €10,800 a year for 8 years covers the whole cost.`
- A support line: what you pay in, what growth adds, and the total the cost needs.
- A chart of the fund over the years, rising as money goes in and taken out by the cost in yearly blocks. The cost never moves between cases; only the path to it does.
- A footnote naming the rates in use. Amounts are rounded to the nearest €100.

## Summary Rules
- Keep `generated.summaryHtml` to 2 to 4 sentences, spoken to the client as `you`.
- Say what the cost is, when it starts and how long it runs, that every case covers the same cost, and what differs between them.
- Never `we recommend`, `you should`, `best`, `ideal`, `optimal`, or the name of a bank, product or provider.
- Keep it client-facing and avoid implementation terms.

## Omit By Default
For this playbook, emit only `generated.summaryHtml` and `generated.futureCostFundInputs`. Do not emit:
- `generated.collegeFundingInputs`
- `generated.pensionInputs`
- `generated.mortgageInputs`
- `generated.loanInputs`
- `generated.outputsBucketed`
- `generated.education`
- hand-built `generated.assumptions`, `generated.outputs`, `generated.tables` or `generated.charts`

This is a JS-engine module. The app calculates outputs and charts.
