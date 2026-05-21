# College Funding Playbook

Use this playbook when Gerry says `use the college funding playbook`, asks for education funding options, asks to ring-fence college costs, or wants to compare children living at home versus going away for college.

## Job
Parse the family and college-cost facts into `generated.collegeFundingInputs`, then write a short client-facing summary.

The browser app owns the repeatable college funding maths after the payload is applied. It calculates today’s-money targets, future nominal costs, timing, scenario tables, and charts.

## Gerry's Live Prompt Can Stay Short
This style should work:

`Use the college funding playbook. Twins age 13. College starts at 18. Four years. Inflation 2 percent. At home 5000 per child per year. Away from home 15000 per child per year. Car support 10000 each.`

## Output Contract
- SECTION 1 - NOTES (FOR GERRY ONLY)
  - Keep it to the key assumptions, placeholders, and any non-obvious scenario choice.
- SECTION 2 - DEV PANEL JSON (PASTE INTO APP)
  - Return a single strict JSON object.
  - Use straight double quotes only. Do not use smart quotes.
  - Keep notes outside the JSON object.

## Preferred Payload Shape

```json
{
  "title": "College Funding - Children",
  "generated": {
    "summaryHtml": "<p>This module compares college funding targets in today's money and future nominal terms. It helps decide how much liquidity should be ring-fenced before moving surplus cash into longer-term assets.</p>",
    "collegeFundingInputs": {
      "currentYear": 2026,
      "childrenCount": 2,
      "childCurrentAge": 13,
      "collegeStartAge": 18,
      "collegeDurationYears": 4,
      "inflationRate": 0.02,
      "planningNote": "Education costs are modelled separately from normal household spending because they may overlap with early retirement.",
      "scenarios": [
        {
          "id": "at-home-no-car",
          "title": "At home, no car support",
          "category": "At home",
          "annualCostTodayPerChild": 5000,
          "oneOffCostTodayPerChild": 0,
          "interpretation": "Lower education funding target if both children live at home during college."
        },
        {
          "id": "at-home-with-car",
          "title": "At home, with car support",
          "category": "At home",
          "annualCostTodayPerChild": 5000,
          "oneOffCostTodayPerChild": 10000,
          "interpretation": "Adds car support to the at-home college scenario."
        },
        {
          "id": "away-no-car",
          "title": "Away from home, no car support",
          "category": "Away from home",
          "annualCostTodayPerChild": 15000,
          "oneOffCostTodayPerChild": 0,
          "interpretation": "Higher funding target reflecting accommodation and wider living costs."
        },
        {
          "id": "away-with-car",
          "title": "Away from home, with car support",
          "category": "Away from home",
          "annualCostTodayPerChild": 15000,
          "oneOffCostTodayPerChild": 10000,
          "interpretation": "Stress-test scenario including away-from-home college costs and car support.",
          "tone": "warning"
        }
      ]
    }
  }
}
```

## Required Inputs
- `childrenCount`
- `childCurrentAge`
- `collegeStartAge`
- `collegeDurationYears`
- `inflationRate`
- `scenarios`

Each scenario needs:
- `id`
- `title`
- `annualCostTodayPerChild` or `oneOffCostTodayPerChild`

## Optional Inputs
- `currentYear`
- `currencySymbol`
- `planningNote`
- scenario `category`
- scenario `interpretation`
- scenario `tone`

## Shorthand Scenario Inputs
If Gerry gives only the common at-home / away-from-home / car support pattern, you may omit `scenarios` and emit:
- `atHomeAnnualCostTodayPerChild`
- `awayAnnualCostTodayPerChild`
- `carSupportTodayPerChild`

The app will create four standard scenarios from those values.

## Calculation Rules
- Treat annual costs as per child, per academic year, in today's money.
- Treat one-off support as per child and paid in the first college year.
- Future nominal cost is inflation-indexed from today into each college year.
- Do not include tax, grants, investment returns, loan funding, or deposit interest unless Gerry explicitly asks for a separate report-style module.
- If costs may overlap with retirement or a planned career change, state that in `summaryHtml` and `planningNote`.

## Summary Rules
- Keep `generated.summaryHtml` to 2 to 4 sentences.
- Explain the scenario comparison, the child facts driving the timing, and the planning decision.
- Tell the client to start with the funding range, then compare today’s-money and future nominal costs.
- Keep it client-facing and avoid implementation terms.

## Omit By Default
For this playbook, do not emit:
- `generated.education`
- `generated.pensionInputs`
- `generated.mortgageInputs`
- `generated.loanInputs`
- `generated.outputsBucketed`
- hand-built `generated.outputs`
- hand-built `generated.charts`

This is a JS-engine module. The app calculates outputs and charts.
