# Artifact Payload Examples

Representative payloads for testing the upgraded module renderer through the existing Dev Panel paste-JSON workflow.

## PBS / Balance Sheet

```json
{
  "title": "Personal Balance Sheet - Client",
  "generated": {
    "summaryHtml": "<p>This balance sheet groups your assets by the job they do: lifestyle, short-term liquidity, retirement funding, and concentrated or optional legacy wealth. Start with net worth, then look at how much is readily available versus tied up in property, pensions, or higher-risk holdings. The main decision is whether the current mix gives enough accessible reserves while still supporting long-term income.</p>",
    "pbsInputs": {
      "annualExpenditure": 42000,
      "currentAge": 44
    },
    "outputsBucketed": {
      "currencySymbol": "€",
      "sections": [
        {
          "key": "lifestyle",
          "title": "Lifestyle",
          "columns": ["Asset", "Amount (€)"],
          "rows": [["Family home", 525000]],
          "subtotalLabel": "Lifestyle assets",
          "subtotalValue": 525000
        },
        {
          "key": "liquidity",
          "title": "Liquidity",
          "columns": ["Asset", "Amount (€)"],
          "rows": [["Cash", 12000], ["Savings", 18000]],
          "subtotalLabel": "Liquid reserves",
          "subtotalValue": 30000
        },
        {
          "key": "longevity",
          "title": "Longevity",
          "columns": ["Asset", "Amount (€)"],
          "rows": [["PRSA", 95000], ["Employer pension", 240000]],
          "subtotalLabel": "Longevity assets",
          "subtotalValue": 335000
        },
        {
          "key": "legacy",
          "title": "Legacy",
          "columns": ["Asset", "Amount (€)"],
          "rows": [["Buy-to-let property", 340000]],
          "subtotalLabel": "Legacy assets",
          "subtotalValue": 340000
        },
        {
          "key": "liabilities",
          "title": "Liabilities",
          "columns": ["Liability", "Amount (€)"],
          "rows": [["Mortgage", 220000]],
          "subtotalLabel": "Total liabilities",
          "subtotalValue": 220000
        },
        {
          "key": "summary",
          "title": "Summary",
          "columns": ["Metric", "Amount (€)"],
          "rows": [["Gross assets", 1230000], ["Total liabilities", 220000], ["Net worth", 1010000]],
          "subtotalLabel": "Net worth",
          "subtotalValue": 1010000
        }
      ],
      "scenarios": [
        {
          "id": "sell-rental-property",
          "title": "Sell Rental Property",
          "summaryHtml": "<p>This case shows what changes if the buy-to-let property is sold, the mortgage is cleared, and surplus proceeds move into liquid reserves. Read it against the current balance sheet to see whether the same net worth becomes more flexible and less concentrated. The key question is whether extra liquidity is worth giving up the rental-property exposure.</p>",
          "sections": [
            {
              "key": "lifestyle",
              "title": "Lifestyle",
              "columns": ["Asset", "Amount (€)"],
              "rows": [["Family home", 525000]],
              "subtotalLabel": "Lifestyle assets",
              "subtotalValue": 525000
            },
            {
              "key": "liquidity",
              "title": "Liquidity",
              "columns": ["Asset", "Amount (€)"],
              "rows": [["Cash", 12000], ["Savings", 18000], ["Cash from sale", 120000]],
              "subtotalLabel": "Liquid reserves",
              "subtotalValue": 150000
            },
            {
              "key": "longevity",
              "title": "Longevity",
              "columns": ["Asset", "Amount (€)"],
              "rows": [["PRSA", 95000], ["Employer pension", 240000]],
              "subtotalLabel": "Longevity assets",
              "subtotalValue": 335000
            },
            {
              "key": "legacy",
              "title": "Legacy",
              "columns": ["Asset", "Amount (€)"],
              "rows": [],
              "subtotalLabel": "Legacy assets",
              "subtotalValue": 0
            },
            {
              "key": "liabilities",
              "title": "Liabilities",
              "columns": ["Liability", "Amount (€)"],
              "rows": [],
              "subtotalLabel": "Total liabilities",
              "subtotalValue": 0
            },
            {
              "key": "summary",
              "title": "Summary",
              "columns": ["Metric", "Amount (€)"],
              "rows": [["Gross assets", 1010000], ["Total liabilities", 0], ["Net worth", 1010000]],
              "subtotalLabel": "Net worth",
              "subtotalValue": 1010000
            }
          ],
          "movements": [
            {
              "label": "Sell rental property",
              "from": { "sectionKey": "legacy", "rowLabel": "Buy-to-let property", "amount": 340000 },
              "to": [
                { "sectionKey": "liabilities", "rowLabel": "Mortgage", "amount": 220000, "action": "reduce" },
                { "sectionKey": "liquidity", "rowLabel": "Cash from sale", "amount": 120000, "action": "add" }
              ]
            }
          ]
        }
      ]
    },
    "charts": [
      {
        "title": "Assets by bucket",
        "subtitle": "Shows what each part of the balance sheet is meant to do.",
        "type": "bar",
        "labels": ["Lifestyle", "Liquidity", "Longevity", "Legacy"],
        "display": {
          "variant": "wide",
          "valueFormat": "currency",
          "yAxisTitle": "Asset value"
        },
        "insights": [
          { "label": "Liquid buffer", "value": "€30,000", "detail": "About 8.6 months of spending.", "tone": "positive" }
        ],
        "datasets": [
          { "label": "Assets", "data": [525000, 30000, 335000, 340000] }
        ]
      }
    ]
  }
}
```

## Retirement Projection

```json
{
  "title": "Retirement Projection - Client",
  "generated": {
    "summaryHtml": "<p>This projection tests whether your current pension value, salary, contributions, retirement age, and growth assumption can support a target retirement income. Start with the required pension pot and retirement chart, then check the assumptions table to see which facts are driving the result. Treat the figures as a planning scenario to review, not a promise of future pension income.</p>",
    "pensionInputs": {
      "currentAge": 42,
      "retirementAge": 67,
      "currentSalary": 85000,
      "currentPot": 180000,
      "personalPct": 0.08,
      "employerPct": 0.06,
      "growthRate": 0.05,
      "inflationRate": 0.02,
      "wageGrowthRate": 0.02,
      "incomeMode": "target",
      "targetIncomeToday": 42000,
      "currentYear": 2026,
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

## Couple Retirement Projection

```json
{
  "title": "Retirement Projection - John and Mary",
  "generated": {
    "summaryHtml": "<p>This projection looks at John and Mary as one household against a shared retirement-income target. It includes their salaries, pension values, contributions, retirement ages, rental income, State Pension, and Mary's DB pension so the first screen can show how the income stack fits together. Start with the required pension pot and household income chart, then check the assumptions that need verifying.</p>",
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
      "rentalIncomeToday": 18000,
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

## Mortgage / Loan

```json
{
  "title": "Mortgage Projection - Client",
  "generated": {
    "summaryHtml": "<p>This mortgage projection shows how the current balance, interest rate, term dates, repayment structure, and annual overpayment shape the repayment path. Start with the repayment, end-date, and interest figures, then use the chart to see how overpayments change the path. Treat this as a scenario view to discuss, not a promise of future rates or lender treatment.</p>",
    "mortgageInputs": {
      "currentBalance": 320000,
      "annualInterestRate": 0.0425,
      "startDateIso": "2026-01-01",
      "endDateIso": "2052-12-01",
      "repaymentType": "repayment",
      "fixedPaymentAmount": null,
      "oneOffOverpayment": 0,
      "annualOverpayment": 3000,
      "loanKind": "mortgage"
    }
  }
}
```

```json
{
  "title": "Loan Projection - Client",
  "generated": {
    "summaryHtml": "<p>This loan projection shows how the stated balance, rate, remaining term, and annual overpayment affect payoff timing and interest cost. Start with the repayment and end-date figures, then check how the overpayment changes the path. The decision is whether the faster payoff is worth the cash-flow tradeoff.</p>",
    "loanInputs": {
      "currentBalance": 18000,
      "annualInterestRate": 0.085,
      "startDateIso": "2026-02-01",
      "endDateIso": null,
      "remainingTermYears": 4,
      "repaymentType": "repayment",
      "fixedPaymentAmount": null,
      "oneOffOverpayment": 0,
      "annualOverpayment": 500,
      "loanKind": "loan"
    }
  }
}
```

## College Funding

```json
{
  "title": "College Funding - Twins",
  "generated": {
    "summaryHtml": "<p>This module compares possible college funding targets for two children, showing living at home versus going away and the effect of one-off car support. The key planning decision is how much liquidity to ring-fence for education before deciding what can be moved into longer-term retirement assets.</p>",
    "collegeFundingInputs": {
      "currentYear": 2026,
      "childrenCount": 2,
      "childCurrentAge": 13,
      "collegeStartAge": 18,
      "collegeDurationYears": 4,
      "inflationRate": 0.02,
      "atHomeAnnualCostTodayPerChild": 5000,
      "awayAnnualCostTodayPerChild": 15000,
      "carSupportTodayPerChild": 10000
    }
  }
}
```

## Education

```json
{
  "title": "Education - Help to Buy Decision Path",
  "generated": {
    "summaryHtml": "<p>Help to Buy is a tax-refund support that may help fund a qualifying new-build purchase, but only if the buyer, property, tax record, and claim sequence all line up. Start with the funding stack and decision path to separate confirmed savings from conditional support. The key next step is to verify eligibility before treating the refund as part of the dependable deposit.</p>",
    "education": {
      "topic": "Help to Buy for first-time buyers",
      "audience": "First-time buyer couple in Ireland",
      "metrics": [
        { "label": "Main dependency", "value": "Eligibility", "detail": "Buyer and property rules come first." },
        { "label": "Funding role", "value": "Deposit support", "detail": "Treat it as conditional support.", "tone": "warning" }
      ],
      "steps": [
        {
          "id": "buyer",
          "kicker": "Step 1",
          "title": "Confirm buyer status",
          "bodyHtml": "<p>Start with whether each buyer meets the first-time buyer and tax compliance conditions.</p>",
          "focus": "This decides whether the conversation continues to property and funding checks."
        },
        {
          "id": "property",
          "kicker": "Step 2",
          "title": "Check the property",
          "bodyHtml": "<p>The property must fit the current scheme conditions.</p>",
          "focus": "A good buyer can still fail the scheme if the property does not qualify."
        }
      ],
      "visuals": [
        {
          "type": "chart",
          "title": "Illustrative funding stack",
          "chart": {
            "title": "Funding stack",
            "subtitle": "Conditional support should be separated from confirmed funds.",
            "type": "bar",
            "labels": ["Savings", "HTB support", "Mortgage"],
            "display": {
              "variant": "hero",
              "valueFormat": "currency",
              "yAxisTitle": "Funding amount"
            },
            "annotations": [
              { "label": "Conditional", "xLabel": "HTB support", "yValue": 30000, "tone": "warning", "body": "Use only once eligibility is confirmed." }
            ],
            "datasets": [
              { "label": "Amount", "data": [60000, 30000, 360000] }
            ]
          }
        }
      ],
      "sections": [
        {
          "id": "plain-english",
          "title": "Plain English Frame",
          "bodyHtml": "<p>Help to Buy is a tax refund mechanism that may support the deposit on a qualifying new-build home.</p>",
          "bullets": ["It is not a universal grant.", "It should be checked before being treated as confirmed funds."],
          "whyItMatters": "Clients often anchor on the headline amount before checking whether the purchase path qualifies."
        }
      ],
      "references": [
        {
          "label": "Revenue - Help to Buy",
          "url": "https://www.revenue.ie/en/property/help-to-buy-incentive/index.aspx",
          "kind": "official",
          "note": "Verify current scheme wording before relying on limits."
        }
      ]
    }
  }
}
```

## Report

```json
{
  "title": "Report - Retirement Readiness Review",
  "generated": {
    "summaryHtml": "<p>This report frames retirement readiness around resilience, funding path, and the decisions that still need testing. Start with the executive picture to see the main signal, then use the chart, scenario comparison, and verification points to understand what is strong and what needs checking. The next focus is whether contribution affordability and retirement-income assumptions are strong enough before acting.</p>",
    "report": {
      "title": "Retirement readiness review",
      "blocks": [
        {
          "type": "insightGrid",
          "title": "Executive picture",
          "layout": "featured",
          "items": [
            { "label": "Readiness signal", "value": "Moderate", "detail": "Current assets support the target path, but contribution discipline remains important.", "tone": "warning", "featured": true }
          ]
        },
        {
          "type": "chart",
          "title": "Projected pension path",
          "chart": {
            "title": "Projected pension path",
            "subtitle": "Illustrative path using current assumptions.",
            "type": "line",
            "labels": ["2026", "2031", "2036", "2041", "2046", "2051"],
            "display": {
              "variant": "wide",
              "valueFormat": "currency",
              "yAxisTitle": "Projected fund value"
            },
            "annotations": [
              { "label": "Retirement", "xLabel": "2051", "tone": "positive", "body": "Target retirement point in this example." }
            ],
            "datasets": [
              { "label": "Current path", "data": [180000, 260000, 370000, 520000, 720000, 980000] },
              { "label": "Lower-return path", "data": [180000, 245000, 330000, 445000, 590000, 760000] }
            ]
          }
        },
        {
          "type": "scenarioCompare",
          "title": "Scenario comparison",
          "scenarios": [
            {
              "label": "Current path",
              "summary": "Maintains current contributions and assumptions.",
              "tone": "positive",
              "metrics": [
                { "label": "Estimated fund", "value": "€980k", "detail": "Illustrative retirement value" }
              ],
              "callout": "Useful as the base case, not a guarantee."
            },
            {
              "label": "Lower-return path",
              "summary": "Shows the effect of a more cautious growth assumption.",
              "tone": "warning",
              "metrics": [
                { "label": "Estimated fund", "value": "€760k", "detail": "Lower projected retirement value" }
              ],
              "callout": "Use this to discuss resilience rather than fear."
            }
          ]
        },
        {
          "type": "accordion",
          "title": "What needs verifying",
          "items": [
            { "title": "Contribution affordability", "markdown": "Check whether the current contribution can be maintained through other life-stage changes.", "defaultOpen": true },
            { "title": "Tax and product assumptions", "markdown": "Verify pension rules, tax relief, charges, and fund assumptions before turning this into advice." }
          ]
        }
      ]
    }
  }
}
```
