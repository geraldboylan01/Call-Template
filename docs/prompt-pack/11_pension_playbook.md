# Pension Playbook

Use this playbook when Gerry says `run the pension playbook`, asks for a pension projection, or wants target-income or affordable-income retirement modelling.

## Job
Parse the dictated pension inputs into `generated.pensionInputs`, choose the correct mode, and write a short client-facing summary.

The browser app owns the repeatable pension maths after the payload is applied.

## Gerry's Live Prompt Can Stay Short
This style should still work:

`Run the pension playbook for Sarah. Age 42. Pension 180000. Salary 85000. Personal 8 percent. Employer 6 percent. Retire at 67. Growth 5 percent. Target 42000 in today's money.`

## Output Contract
- SECTION 1 - NOTES (FOR GERRY ONLY)
  - Keep it to the key assumptions, mode choice, and any placeholder values.
- SECTION 2 - DEV PANEL JSON (PASTE INTO APP)
  - Return a single JSON object.

## Preferred Payload Shape

```json
{
  "title": "Pension Projection - Sarah",
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
      "targetIncomeToday": 42000
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
- Explain the chosen mode in plain language.
- Do not promise exact future outcomes.
- Do not mention internal validators, engines, charts, or JSON.

## Omit By Default
For this playbook, do not emit:
- `generated.outputs`
- `generated.outputsBucketed`
- `generated.tables`
- `generated.charts`
- `generated.report`
- `generated.education`

The app computes the repeatable pension outputs after apply.
