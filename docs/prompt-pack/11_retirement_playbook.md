# Retirement Playbook

Use this playbook when Gerry says `run the retirement playbook`, asks for a retirement projection, or wants target-income or affordable-income retirement modelling.

## Job
Parse the dictated pension inputs into `generated.pensionInputs`, choose the correct mode, and write a short client-facing summary.

The browser app owns the repeatable retirement maths after the payload is applied.

## Gerry's Live Prompt Can Stay Short
This style should still work:

`Run the retirement playbook for Sarah. Age 42. Pension 180000. Salary 85000. Personal 8 percent. Employer 6 percent. Retire at 67. Growth 5 percent. Target 42000 in today's money.`

## Output Contract
- SECTION 1 - NOTES (FOR GERRY ONLY)
  - Keep it to the key assumptions, mode choice, and any placeholder values.
- SECTION 2 - DEV PANEL JSON (PASTE INTO APP)
  - Return a single strict JSON object.
  - Use straight double quotes only. Do not use smart quotes.
  - Keep notes outside the JSON object.

## Preferred Payload Shape

```json
{
  "title": "Retirement Projection - Sarah",
  "generated": {
    "summaryHtml": "<p>...</p>",
    "pensionInputs": {
      "currentAge": 42,
      "retirementAge": 67,
      "currentSalary": 85000,
      "currentPot": 180000,
      "personalPct": 0.08,
      "employerPct": 0.06,
      "growthRate": 0.05,
      "incomeMode": "target",
      "targetIncomeToday": 42000,
      "rentalIncomeToday": 18000,
      "baseScenarioId": "with-rent",
      "rentalIncomeScenarios": [
        { "id": "with-rent", "title": "With rental income", "rentalIncomeToday": 18000 },
        { "id": "rent-lost", "title": "Rental income lost", "rentalIncomeToday": 0 }
      ]
    }
  }
}
```

## Couple Payload Shape

Use `pensions[]` when Gerry describes a couple or two pension pots working toward one household target.

```json
{
  "title": "Retirement Projection - John and Mary",
  "generated": {
    "summaryHtml": "<p>...</p>",
    "pensionInputs": {
      "currentYear": 2026,
      "inflationRate": 0.02,
      "growthRate": 0.05,
      "wageGrowthRate": 0.02,
      "incomeMode": "target",
      "targetIncomeToday": 70000,
      "targetStartYear": 2052,
      "horizonEndAge": 100,
      "currentAge": 42,
      "retirementAge": 67,
      "currentSalary": 155000,
      "currentPot": 300000,
      "personalPct": 0.07548,
      "employerPct": 0.05548,
      "pensions": [
        { "id": "john", "title": "John", "currentAge": 42, "retirementAge": 67, "currentSalary": 85000, "currentPot": 180000, "personalPct": 0.08, "employerPct": 0.06 },
        { "id": "mary", "title": "Mary", "currentAge": 40, "retirementAge": 66, "currentSalary": 70000, "currentPot": 120000, "personalPct": 0.07, "employerPct": 0.05 }
      ],
      "otherIncomeSources": [
        { "id": "mary-db", "title": "Mary DB pension", "type": "db", "ownerId": "mary", "annualAmountToday": 12000, "startAge": 66, "inflationIndexed": true }
      ]
    }
  }
}
```

## Required Runtime Keys
- `currentAge`
- `retirementAge`
- `currentSalary`
- `currentPot`
- `personalPct`
- `employerPct`
- `growthRate`

## Supported Optional Keys
- `targetIncomeToday`
- `targetIncomePctOfSalary`
- `inflationRate`
- `wageGrowthRate`
- `horizonEndAge`
- `currentYear`
- `incomeMode`
- `affordableEndAges`
- `minDrawdownMode`
- `rentalIncomeToday`
- `baseScenarioId`
- `rentalIncomeScenarios`
- `pensions`
- `incomeStartYear`
- `targetStartYear`
- `targetStartAge`
- `requiredPotReferenceYear`
- `horizonEndYear`
- `includeStatePension`
- `includeEmploymentIncomeDuringBridge`
- `otherIncomeSources`

Only emit optional keys when Gerry gives them, when the playbook requires them, or when a labeled placeholder is needed.

## Contribution Parsing
- Preferred input style is percentage of salary.
- If Gerry gives annual euro contributions instead of percentages:
  - derive the percentage from current salary
  - round sensibly
  - note the conversion in NOTES

## Mode Rules
- `incomeMode = "target"` when Gerry gives a target retirement income or a target percentage of salary.
- `incomeMode = "affordable"` only when Gerry explicitly asks what income the fund can sustain or afford.

## Target Mode
Use target mode when Gerry says things like:
- target retirement income
- want EUR X a year in retirement
- want 50 percent of salary in retirement

Provide at least one of:
- `targetIncomeToday`
- `targetIncomePctOfSalary`

For target mode, omit `horizonEndAge` unless Gerry gives a different depletion age; the runtime defaults required-pot planning to deplete by age 100.

## Affordable Mode
Use affordable mode when Gerry says things like:
- what could they afford in retirement
- what could they sustainably draw
- goal-seek income

For affordable mode:
- set `incomeMode` to `affordable`
- set `affordableEndAges` if Gerry gives depletion ages
- if Gerry does not give depletion ages, use `[85, 90, 95, 100]`
- keep `minDrawdownMode` false unless Gerry explicitly asks for minimum drawdowns

## Rental Income
Use rental income fields when Gerry says things like:
- rental income of EUR X today
- rental income coming in at retirement
- with and without rental income
- rent lost scenario

Rules:
- Treat `rentalIncomeToday` as gross annual rent in today's money.
- Do not net it down for tax, costs, vacancy, or maintenance.
- The runtime inflation-indexes rent from today to retirement and through the retirement horizon.
- In target mode, rental income reduces the pension-funded withdrawal needed.
- In affordable mode, the runtime goal-seeks pension-funded income and then adds gross rental income to show total affordable income.
- For a simple rent assumption, emit only `rentalIncomeToday`.
- For with/without or rent-lost comparisons, emit `rentalIncomeScenarios` and `baseScenarioId`.
- Each `rentalIncomeScenarios` item must include `id`, `title`, and `rentalIncomeToday`.
- If Gerry names the base case, use that case's `id` as `baseScenarioId`.
- If Gerry does not name the base case, use the first mentioned case. For generic "with and without rent", default the base to the with-rent case.

## Couples And State Pension
Use `pensions[]` when Gerry says:
- couple retirement projection
- John pension and Mary pension
- two pensions working toward the same retirement income

Rules:
- Each pension must include `id`, `title`, `currentAge`, `retirementAge`, `currentSalary`, `currentPot`, `personalPct`, and `employerPct`.
- Also include the legacy top-level pension keys (`currentAge`, `retirementAge`, `currentSalary`, `currentPot`, `personalPct`, `employerPct`) for compatibility. Use the first pension's ages, household totals for salary/current pot, and salary-weighted household contribution percentages. The runtime uses `pensions[]` for the actual household calculation.
- Put shared `growthRate`, `wageGrowthRate`, and `inflationRate` at household level unless Gerry gives different rates per person.
- If Gerry says "both retire at X's 65th birthday", derive each member's `retirementAge` so both retirement years match X's age-65 year.
- If Gerry says "both retire at 65", set each member's own `retirementAge` to 65; if their current ages differ, this creates staggered retirement years.
- For staggered retirement years, set `incomeStartYear` to the first retirement year and `requiredPotReferenceYear` to the later retirement year. Gross employment income is included during the bridge by default unless Gerry excludes it.
- Set `targetStartYear` only if Gerry explicitly gives the household income start year. If he gives an age instead, use `targetStartAge`.
- The runtime includes the Irish State Pension by default for each person from age 66, using EUR 15,563.60 p.a. today and inflation-indexing it.
- If Gerry says to exclude State Pension for one person, set that pension member's `includeStatePension` to `false`.

## Other Income Sources
Use `otherIncomeSources[]` for DB pensions and similar income.

Rules:
- Required keys are `id`, `title`, `annualAmountToday`, `inflationIndexed`, and either `startYear` or `ownerId` plus `startAge`.
- If using `startAge` or `endAge` in a couple case, include `ownerId`.
- `ownerId` may be a pension member id or `"household"` when the income starts at the primary/client age rather than one spouse's age.
- `inflationIndexed` must be explicit for non-state, non-rental income.
- `inflationRate` may be set per source when the income source has its own indexation assumption; otherwise the household inflation rate is used.
- Omit `endYear` / `endAge` unless Gerry gives an end point.

## ARF Minimum Withdrawals
- The runtime models Irish ARF minimum withdrawals automatically.
- Do not emit separate fake ARF outputs.
- Mention in NOTES only if Gerry specifically asks about mandatory withdrawals or if it materially affects the explanation.

## Best-Guess Defaults
- If Gerry does not specify target mode or affordable mode:
  - default to `incomeMode = "target"`
  - set `targetIncomePctOfSalary = 0.50`
  - note clearly in NOTES that this is a placeholder target, not a recommendation
- If current pension value is not given:
  - set `currentPot = 0`
  - note the assumption in NOTES

## Summary Rules
- Keep `generated.summaryHtml` to 2 to 4 sentences.
- Explain the retirement-income scenario in plain language, using the client's age, salary, pension value, contributions, retirement age, and target or affordable income goal where known.
- If rental income, State Pension, DB income, or a couple/household projection is included, say how it fits into the retirement-income picture.
- Tell the client how to read the first screen: start with the required pension pot and retirement chart, then check the assumptions that drive the result.
- Do not state whether the client is on track, short, surplus, or does not need a pension pot; the runtime calculates and appends that readiness wording from the retirement outputs.
- Do not promise exact future outcomes.
- Do not mention internal validators, engines, payloads, or JSON.

## Omit By Default
For this playbook, do not emit:
- `generated.outputs`
- `generated.outputsBucketed`
- `generated.tables`
- `generated.charts`
- `generated.report`
- `generated.education`

The app computes the repeatable retirement outputs after apply.

## Rendering Expectations
- The runtime will render assumptions, outputs, and charts from the retirement engine after the payload is applied.
- Keep AI output focused on clean inputs and a short explanation of the selected mode.
- Do not try to create artifact blocks inside the JS-backed retirement payload. If Gerry wants a separate educational explanation, create a separate Education or Report module.

## Good Output Looks Like
- Inputs are complete enough for the engine to run.
- Mode choice is obvious from the summary and NOTES.
- Placeholder targets or unknown pension values are clearly labelled.

## Avoid
- Fake projection tables or charts.
- Mixing `generated.report` or `generated.education` into the retirement engine module.
- Presenting future values as promises.
