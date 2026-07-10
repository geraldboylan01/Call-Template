# College Funding Playbook

Use this playbook when Gerry says `use the college funding playbook`, asks for education funding options, asks to ring-fence college costs, or wants to compare children living at home versus going away for college.

## Job
Parse the family and college-cost facts into `generated.collegeFundingInputs`, then write a short client-facing summary.

The browser app owns the repeatable college funding maths after the payload is applied. It calculates today’s-money targets, future nominal costs, timing, scenario tables, and charts.

## Gerry's Live Prompt Can Stay Short
This style should work:

`Use the college funding playbook. Eldest child age 2 and newborn twins. College starts at 18 for each child. Four years each. Inflation 2 percent. At home 5000 per child per year. Away from home 15000 per child per year. Car support 10000 each.`

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
      "children": [
        {
          "id": "eldest",
          "title": "Eldest child",
          "currentAge": 2,
          "collegeStartAge": 18,
          "collegeDurationYears": 4
        },
        {
          "id": "twin-1",
          "title": "Twin 1",
          "currentAge": 0,
          "collegeStartAge": 18,
          "collegeDurationYears": 4
        },
        {
          "id": "twin-2",
          "title": "Twin 2",
          "currentAge": 0,
          "collegeStartAge": 18,
          "collegeDurationYears": 4
        }
      ],
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
- `children[]` when children have different current ages, different college start ages, or different course durations
- legacy shared-age timing fields may be used where all children have identical timing:
  - `childrenCount`
  - `childCurrentAge`
  - `collegeStartAge`
  - `collegeDurationYears`
- `inflationRate`
- `scenarios`

Each child needs:
- `id`
- `title`
- `currentAge`
- `collegeStartAge`
- `collegeDurationYears`

Each scenario needs:
- `id`
- `title`
- `annualCostTodayPerChild` or `oneOffCostTodayPerChild`

## Optional Inputs
- `currentYear`
- `currencySymbol` (use `€` for Irish euro planning, not `EUR`)
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

## Child Timing Rules
- Use `children[]` whenever children have different current ages, different college start ages, or different course durations.
- The legacy shared-age fields may continue to be used where all children have identical timing.
- If `children[]` is present and contains valid children, the app uses `children[]` and derives `childrenCount` from `children.length`.
- Do not combine `children[]` with `childrenCount` to create additional children.
- Every child id must be unique.
- `currentAge` must be zero or greater.
- `collegeStartAge` must be greater than `currentAge`.
- `collegeDurationYears` must be greater than zero.

## Calculation Rules
- Treat annual costs as per child, per academic year, in today's money.
- Treat one-off support as per child and paid only in that child's first college year.
- Future nominal cost is inflation-indexed from today into each college year.
- The annual timeline runs from the earliest child college start year through the latest child college final year.
- For each year, the app sums inflation-adjusted costs for every child attending in that year.
- Do not include tax, grants, investment returns, loan funding, or deposit interest unless Gerry explicitly asks for a separate report-style module.
- If costs may overlap with retirement or a planned career change, state that in `summaryHtml` and `planningNote`.

## Runtime Outputs
- The app generates total cost in today's money, total future nominal cost, first college year, final college year, overall family funding period, peak annual cost, and peak number of children attending at the same time.
- The app generates annual profile tables with one column per child, children attending, and annual family cost.
- The primary chart is a stacked annual funding profile by child, with separate scenario stacks.

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
