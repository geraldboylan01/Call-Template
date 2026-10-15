# Rental Keep or Sell Playbook

Use this playbook when Gerry says `use the rental keep or sell playbook`, or asks what a rental property gives the client each year if they keep it, against what they would have in hand if they sold it.

## Job
Parse the property's figures into `generated.rentalKeepOrSellInputs`, then write a short client-facing summary.

The browser app owns the rest. It cuts the rent down, line by line, to what is left each year, cuts the sale price down to what would be in hand, and draws both.

## Gerry's Live Prompt Can Stay Short
This style should work:

`Use the rental keep or sell playbook. Rent 1500 a month. Loan repayments 13000 a year, running costs 2500, tax on the rent about 3700. It would sell for 320000 with 6000 of selling costs, they owe 180000, and the tax on the gain would be about 21000.`

## Output Contract
- SECTION 1 - NOTES (FOR GERRY ONLY)
  - Keep it to the key assumptions.
  - One line each for Keep and Sell with the result: what is left each year, and what would be in hand.
  - When a tax figure is missing, NOTES is the whole reply until Gerry confirms it: see Tax Is Stated, Not Calculated.
- SECTION 2 - DEV PANEL JSON (PASTE INTO APP)
  - Return a single strict JSON object.
  - Use straight double quotes only. Do not use smart quotes.
  - Keep notes outside the JSON object.

## Preferred Payload Shape

```json
{
  "title": "Rental Property - Keep or Sell",
  "generated": {
    "summaryHtml": "<p>This shows what the property gives you each year if you keep it, and what you would have in hand if you sold it. Rent, costs, the loan and tax are as you gave them. Start with Keep to see the rent cut down to what is left each year, then press Sell.</p>",
    "rentalKeepOrSellInputs": {
      "rentPerYear": 18000,
      "loanRepaymentsPerYear": 13000,
      "runningCostsPerYear": 2500,
      "taxOnRentalProfitPerYear": 3700,
      "salePrice": 320000,
      "sellingCosts": 6000,
      "loanBalance": 180000,
      "taxOnGain": 21000
    }
  }
}
```

## Required Inputs
All eight are required, in euros:
- `rentPerYear`: greater than 0. Rent received in a year, so a monthly rent times 12.
- `loanRepaymentsPerYear`: 0 or more. Capital and interest together.
- `runningCostsPerYear`: 0 or more. Management, repairs, the Local Property Tax, service charges and anything else the property costs to hold.
- `taxOnRentalProfitPerYear`: 0 or more. The tax on the rental profit each year.
- `salePrice`: greater than 0.
- `sellingCosts`: 0 or more. Agent, legal and other costs of selling.
- `loanBalance`: 0 or more. What is owed today, repaid from the sale.
- `taxOnGain`: 0 or more. The capital gains tax on the sale.

Optional:
- `baseScenarioId`: `"keep"` or `"sell"`. The default is `"keep"`.

Any other key is refused with `generated.rentalKeepOrSellInputs.<key> is not an input of this module.`

## The Two Cases Are Fixed
Keep and Sell. There is no `scenarios` array, and one is refused. To compare anything else, such as a different sale price or a rent rise, build a second module and say so in NOTES.

## Tax Is Stated, Not Calculated
The app calculates no tax for this module, and its footnote tells the client that the figures are as stated. So both tax figures must come from Gerry. Never put a figure you worked out yourself into the payload as if he had given it.
- If Gerry gives the tax figures, use them as given.
- If one is missing, do not return the JSON yet. Work out a suggestion with the Irish tax overlay and show the working in NOTES:
  - **Tax on the rental profit:** the rent less the allowable costs, including the interest part of the loan repayments but not the capital, taxed at the client's marginal rate with USC and PRSI.
  - **Tax on the gain:** the sale price less the purchase price and the costs of buying and selling, less the annual exemption, at the capital gains tax rate.
  - Name anything the suggestion had to assume, such as the purchase price or the interest part of the repayments.
- Then ask one bold question asking Gerry to confirm the figures or give his own. Return SECTION 2 once he answers, using the figures he confirms.
- Never put a tax figure at 0 unless Gerry says there is none.

## Not Modelled
Say so in NOTES when it matters, and keep the payload as it is:
- **Growth** in rent, costs or the property's value. The sale is at today's price.
- **What the client would do with the money in hand.**
- **Any case other than Keep and Sell.**

## Runtime Outputs
- Two buttons, Keep and Sell, each with its answer line, for example `−€1,200 a year` and `€113,000 in hand`.
- One bar, cut down step by step from the rent or the sale price to what is left.
- A sentence, for example `The rent does not cover the loan repayments, running costs and tax: €1,200 short each year.`
- A footnote saying the figures are as stated and tax is not calculated here.
- Amounts are shown to the nearest euro, and every row adds down to the last line.

## Summary Rules
- Keep `generated.summaryHtml` to 2 to 4 sentences, spoken to the client as `you`.
- Say what the module shows (what the property gives each year if kept, and what would be in hand if sold), which figures drive it, and how to read the screen: Keep first, then Sell.
- Never say which case is better. The screen shows what is, and what each case would change.
- Never `we recommend`, `you should`, `best`, `ideal`, `optimal`, `p.a.`, `we`, `us`, `our`, or the name of a bank, product or provider.
- Keep it client-facing and avoid implementation terms.

## Omit By Default
For this playbook, emit only `generated.summaryHtml` and `generated.rentalKeepOrSellInputs`. Do not emit:
- `generated.mortgageInputs`
- `generated.loanInputs`
- `generated.outputsBucketed`
- `generated.report`
- hand-built `generated.assumptions`, `generated.outputs`, `generated.tables` or `generated.charts`

This is a JS-engine module. The app lays out every figure and draws the screen.
