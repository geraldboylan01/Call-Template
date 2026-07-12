# Artifact Payload Examples

Representative payloads for testing the upgraded module renderer through the existing Dev Panel paste-JSON workflow.

## PBS / Balance Sheet

PBS examples should keep the summary contract exact: the summary section uses `key: "summary"`, rows labelled `Gross assets`, `Total liabilities`, and `Net worth`, and `subtotalLabel: "Net worth"`. Scenario `movements` are only animation metadata; keep scenario sections fully recalculated and use canonical movement actions such as `add` and `reduce`.

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

## Liquidity Plan

Liquidity examples must stay cash-only. They should use `generated.liquidityPlan`, not PBS `outputsBucketed`.

```json
{
  "title": "Liquidity Plan - Client",
  "generated": {
    "summaryHtml": "<p>This module focuses only on cash. The reserve target is six months of spending; anything above that should have a clear job rather than sitting idle and being eroded by inflation.</p>",
    "liquidityPlan": {
      "currencySymbol": "€",
      "clientStatus": "not-retired",
      "annualExpenditure": 48000,
      "currentCash": 110000,
      "cashItems": [
        { "label": "Current account", "amount": 18000 },
        { "label": "Deposit account", "amount": 72000 },
        { "label": "Prize bonds / instant-access cash", "amount": 20000 }
      ],
      "headline": "The emergency fund is covered. The excess cash now needs a job.",
      "primaryActionLabel": "Cash to put to work",
      "primaryActionDetail": "Keep six months accessible, then decide where the surplus belongs: debt reduction, pension, long-term investment, or known spending.",
      "evidenceCards": [
        {
          "label": "Emergency fund guide",
          "value": "3-6 months",
          "detail": "Use official consumer guidance or current source facts where verified.",
          "sourceLabel": "CCPC",
          "sourceUrl": "https://www.ccpc.ie/manage-your-money/jargon-buster"
        }
      ],
      "nextSteps": [
        { "label": "Lock the reserve", "detail": "Keep the six-month emergency fund accessible and separate from investment decisions." },
        { "label": "Name the surplus", "detail": "Show the cash amount above target so the client can see what is available to put to work." },
        { "label": "Choose the destination", "detail": "Agree whether surplus cash should clear expensive debt, fund pension, invest gradually, or cover a known near-term cost." }
      ]
    }
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

## Net Retirement Cash Flow

```json
{
  "title": "Net Retirement Cash Flow - Property Income Scenarios",
  "generated": {
    "summaryHtml": "<p>This projection compares the household net spending need against net income sources and converts the annual shortfalls into a required net investment fund today. It uses the stated expenditure, rental income, assumed 50% Irish State Pension from age 66, and the selected after-tax net growth rate. Start with the required net fund and income-versus-expenditure chart, then use the scenario buttons to see how losing the Irish rental income changes the result.</p>",
    "netRetirementInputs": {
      "currentYear": 2026,
      "currentAge": 60,
      "horizonEndAge": 100,
      "annualExpenditureToday": 90000,
      "expenditureInflationRate": 0.02,
      "presentValueRate": 0.04,
      "availableInvestmentFundToday": 1027000,
      "planningNote": "All income and expenditure figures are treated as after-tax net amounts. Pension funds are pre-tax and should not be compared directly with the required net fund unless pension withdrawal tax has been allowed for separately.",
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

## Mortgage / Loan

These examples model an existing borrowing balance and repayment path. Use the separate House Purchase contract below for a future target home, deposit path, purchase timing, household affordability, or Irish purchase-support screen.

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

## House Purchase

House Purchase examples must contain only `generated.summaryHtml` and `generated.housePurchaseInputs`. The runtime calculates all capacity, cash, timing, mortgage, affordability, scheme, bottleneck, action, table, and chart results.

```json
{
  "title": "House Purchase Plan - Aoife and Conor",
  "generated": {
    "summaryHtml": "<p>This plan brings your income, protected savings, monthly saving and target new-build home into one route-to-buying view. Start with the current capacity, cash target and estimated timing, then check whether income, deposit or household headroom is the main constraint. Help to Buy and First Home Scheme indicators are screening illustrations only and should be confirmed with the relevant official body and lender before being treated as dependable funding.</p>",
    "housePurchaseInputs": {
      "schemaVersion": 1,
      "calculationDateIso": "2026-07-11",
      "lendingCategory": "first_time_buyer",
      "applicationType": "joint",
      "applicants": [
        {
          "id": "applicant-1",
          "label": "Aoife",
          "age": 34,
          "employmentStatus": "employee",
          "grossAnnualIncome": 68000,
          "variableAnnualIncome": 0,
          "lenderRecognisedVariableAnnualIncome": 0,
          "incomeReliability": "stable",
          "existingMonthlyDebtPayments": 0,
          "schemeBuyerStatus": "first_time_buyer",
          "freshStartReason": null,
          "previouslyOwnedPropertyAnywhere": false,
          "retainedInterestInPreviousProperty": false,
          "rightToResideInIreland": true
        },
        {
          "id": "applicant-2",
          "label": "Conor",
          "age": 35,
          "employmentStatus": "employee",
          "grossAnnualIncome": 52000,
          "variableAnnualIncome": 0,
          "lenderRecognisedVariableAnnualIncome": 0,
          "incomeReliability": "stable",
          "existingMonthlyDebtPayments": 0,
          "schemeBuyerStatus": "first_time_buyer",
          "freshStartReason": null,
          "previouslyOwnedPropertyAnywhere": false,
          "retainedInterestInPreviousProperty": false,
          "rightToResideInIreland": true
        }
      ],
      "currentCashSavings": 70000,
      "cashSavingsContributions": [
        { "ownerId": "applicant-1", "amount": 40000 },
        { "ownerId": "applicant-2", "amount": 30000 }
      ],
      "amountRingfencedForOtherGoals": 10000,
      "emergencyReserveMode": "suggested",
      "emergencyReserveTarget": null,
      "currentMonthlySavings": 1800,
      "plannedMonthlySavings": 1800,
      "lumpSums": [],
      "monthlyNetHouseholdIncome": 6900,
      "monthlyEssentialExpensesExcludingHousingDebtAndRent": 2700,
      "currentMonthlyRent": 2100,
      "dependants": 0,
      "otherKnownMonthlyCommitments": 0,
      "estimatedMonthlyOwnershipCosts": 350,
      "targetPropertyPrice": 475000,
      "targetPurchaseDate": "2028-06-30",
      "acquisitionType": "new_build",
      "dwellingType": "house",
      "intendedUse": "principal_private_residence",
      "localAuthorityCode": "dublin_city",
      "tenantNoticeReceived": false,
      "lenderCapacity": {
        "status": "not_obtained",
        "amount": null,
        "lenderId": "unknown",
        "isMaximumAvailable": false,
        "macroPrudentialException": false,
        "htbQualifyingLender": null
      },
      "depositSavingsGrossAer": 0.02,
      "dirtRate": 0.33,
      "mortgageIllustrationRate": 0.035,
      "mortgageTermYears": 35,
      "purchaseCosts": {
        "stampDutyMode": "rules",
        "customStampDuty": null,
        "legalAndConveyancing": 3200,
        "valuation": 200,
        "surveyOrEngineer": 400,
        "movingAndFurnishing": 5000,
        "contingency": 2500
      },
      "helpToBuy": {
        "taxCompliant": null,
        "revenueApprovedDeveloperOrApprover": null,
        "expectedIncomeTaxAndDirtPaidPriorFourYears": null,
        "confirmedClaimAmount": 0
      },
      "firstHomeScheme": {
        "applicationStatus": "not_applied",
        "confirmedEquityAmount": 0,
        "siteEquity": 0
      }
    }
  }
}
```

## College Funding

```json
{
  "title": "College Funding - Children",
  "generated": {
    "summaryHtml": "<p>This module compares possible college funding targets for three children with staggered college timing, showing living at home versus going away and the effect of one-off car support. The key planning decision is how much liquidity to ring-fence for education before deciding what can be moved into longer-term retirement assets.</p>",
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
