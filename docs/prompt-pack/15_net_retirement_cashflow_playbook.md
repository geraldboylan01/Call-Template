# Net Retirement Cash Flow Playbook

<!-- planeir-planning-module {"moduleId":"net_retirement_cashflow","outputKey":"generated.netRetirementInputs","role":"analysis"} -->

Use this playbook when Gerry wants to model retirement spending from net expenditure and net income, where pension taxation is too uncertain for a true net-income pension projection.

## Job
Parse the dictated net cash-flow inputs into `generated.netRetirementInputs`, choose the base scenario, and write a short client-facing summary.

The browser app owns the repeatable present-value maths, annual shortfall table, charts, and scenario switching after the payload is applied.

## Gerry's Live Prompt Can Stay Short
This style should work:

`Use the net retirement cash flow playbook. Client age 60, spouse age 60. Project to age 100. Net spending 90000. Net Irish rent 10000. Net EU rent 14000. Assume 50 percent Irish State Pension from 66, 7781.80 today. PV growth 4 percent, expenditure inflation 2 percent. Compare keeping the Irish rental with selling it, where Irish rent is lost and investable assets rise from 1027000 to 1477000.`

## Output Contract
- SECTION 1 - NOTES (FOR GERRY ONLY)
  - Keep it to the key assumptions, scenario choice, and any placeholder values.
  - Mention that required fund figures are net / after-tax and should not be compared directly with gross pension balances.
- SECTION 2 - DEV PANEL JSON (PASTE INTO APP)
  - Return a single strict JSON object.
  - Use straight double quotes only. Do not use smart quotes.
  - Keep notes outside the JSON object.

## Preferred Payload Shape

```json
{
  "title": "Net Retirement Cash Flow - Client",
  "generated": {
    "summaryHtml": "<p>This projection compares your household net spending need with net income sources and converts the annual shortfalls into the required net investment fund today. It uses the stated net expenditure, rental income, State Pension assumption, and selected after-tax growth rate. Start with the required net fund and the income-versus-expenditure chart, then use the scenario buttons to test what happens if a net income source is lost.</p>",
    "netRetirementInputs": {
      "currentYear": 2026,
      "currentAge": 60,
      "horizonEndAge": 100,
      "annualExpenditureToday": 90000,
      "expenditureInflationRate": 0.02,
      "presentValueRate": 0.04,
      "availableInvestmentFundToday": 1027000,
      "planningNote": "All income and expenditure figures are treated as after-tax net amounts.",
      "incomeSources": [
        { "id": "irish-rent", "title": "Irish rental income", "annualAmountToday": 10000, "startAge": 60, "inflationIndexed": true },
        { "id": "eu-rent", "title": "Non-Irish EU rental income", "annualAmountToday": 14000, "startAge": 60, "inflationIndexed": true },
        { "id": "half-irish-state-pension", "title": "50% Irish State Pension", "annualAmountToday": 7781.8, "startAge": 66, "inflationIndexed": true }
      ],
      "baseScenarioId": "keep-irish-rental",
      "scenarios": [
        { "id": "keep-irish-rental", "title": "Keep Irish rental", "availableInvestmentFundToday": 1027000 },
        { "id": "sell-irish-rental", "title": "Sell Irish rental", "availableInvestmentFundToday": 1477000, "excludedIncomeSourceIds": ["irish-rent"] }
      ]
    }
  }
}
```

## Required Runtime Keys
- `currentAge`
- `horizonEndAge`
- `annualExpenditureToday`
- `presentValueRate`

## Supported Optional Keys
- `currentYear`
- `expenditureInflationRate`
- `availableInvestmentFundToday`
- `currencySymbol`
- `planningNote`
- `taxCompatibilityNote`
- `incomeSources`
- `baseScenarioId`
- `scenarios`

Only emit optional keys when Gerry gives them, when the playbook requires them, or when a labeled placeholder is needed.

## Core Modelling Rules
- Treat `annualExpenditureToday` as the client's annual net spending need in today's money.
- Treat every `incomeSources[].annualAmountToday` as net annual income in today's money.
- The projection defaults to the client age axis and runs to age 100 unless Gerry gives a different `horizonEndAge`.
- Use `presentValueRate` as the after-tax net growth or discount rate for required-fund maths.
- Use `expenditureInflationRate` to inflate the spending need from today through the projection.
- Use `incomeSources[].inflationIndexed = true` when the income should inflate with the expenditure/inflation assumption.
- Use `incomeSources[].inflationIndexed = false` when the income is flat nominal.
- The engine calculates each year's net shortfall, the present value of each shortfall, and the required net investment fund today.

## Income Sources
Each income source should include:
- `id`
- `title`
- `annualAmountToday`
- `startAge` or `startYear`
- `inflationIndexed`

Optional income source keys:
- `type`
- `endAge` or `endYear`
- `inflationRate`
- `includeInBase`

Use income sources for:
- net rental income
- net foreign pension income
- net annuity income
- client-supplied net State Pension assumptions
- other recurring after-tax income

Do not use the default pension State Pension logic from the retirement playbook here. If Gerry says 50% of the Irish State Pension, enter it as a named net income source if he gives or approves the amount.

## Scenario Rules
Use `scenarios[]` when Gerry wants a case button such as:
- keep rental property versus sell rental property
- rental income continues versus rental income lost
- spouse income included versus excluded
- lower spending after children finish college
- foreign pension included versus excluded

Each scenario should include:
- `id`
- `title`

Scenario optional keys:
- `availableInvestmentFundToday`
- `annualExpenditureToday`
- `description`
- `excludedIncomeSourceIds`
- `incomeSourceOverrides`
- `additionalIncomeSources`

For lost-income cases, prefer `excludedIncomeSourceIds`.

For changed-income cases, use:

```json
"incomeSourceOverrides": [
  { "sourceId": "irish-rent", "annualAmountToday": 0 }
]
```

For scenario-only income, use `additionalIncomeSources`.

## Summary Rules
- Keep `generated.summaryHtml` to 2 to 4 sentences.
- Explain that the module compares net spending with net income sources and calculates the required net investment fund today.
- Tell the client to start with the required net fund, income-versus-expenditure chart, and scenario buttons.
- Mention the main decision or verification point, such as whether losing rental income is offset by higher investable assets.
- Include the pension compatibility caveat in client-facing language when pension assets are part of the wider conversation.
- Do not promise future outcomes.
- Do not mention internal validators, engines, payloads, or JSON.

## Tax And Pension Compatibility
Always preserve this logic:
- Required fund figures are after-tax net amounts.
- Pension funds and pension withdrawals are usually pre-tax or gross before PAYE.
- A gross pension balance is not directly comparable with the required net investment fund unless pension withdrawal tax has been modelled separately.
- If the client has multiple tax regimes, joint/separate assessment, credits, or foreign pension treatment, state that these need separate verification.

## Omit By Default
For this playbook, do not emit:
- `generated.outputs`
- `generated.outputsBucketed`
- `generated.tables`
- `generated.charts`
- `generated.pensionInputs`
- `generated.education`
- `generated.report`

The app computes the repeatable outputs, annual table, and charts after apply.

## Rendering Expectations
- The runtime will render assumptions, outputs, annual net shortfall table, scenario buttons, and charts from the net cash-flow engine after the payload is applied.
- The annual chart shows net income as stacked bars by income source and net expenditure as a line; the net shortfall is the implied gap, not a separate plotted series.
- The x-axis uses client age by default and extends to age 100 unless `horizonEndAge` says otherwise.
- The fund chart floors the available fund path at zero after depletion.
- Keep AI output focused on clean inputs and a short explanation of the selected scenario structure.
- Do not try to create artifact blocks inside the JS-backed net retirement payload.

## Good Output Looks Like
- Inputs are complete enough for the engine to run.
- Net expenditure, net income sources, PV growth rate, and projection age range are explicit.
- Scenario IDs are stable and human-readable.
- Lost income is modelled through `excludedIncomeSourceIds` or source overrides.
- Pension tax compatibility is clearly caveated.

## Avoid
- Using `generated.pensionInputs` when the problem is net cash-flow and tax is unresolved.
- Mixing gross pension withdrawals with net expenditure as if they are equivalent.
- Hand-building annual shortfall tables or charts.
- Treating net rental income as gross rental income.
