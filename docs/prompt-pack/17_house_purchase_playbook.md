# House Purchase Playbook

Use this playbook when Gerry says `use the house purchase playbook`, `house purchase planner`, `first-home plan`, `what can they afford to buy`, or asks when a client could buy a target Irish home after allowing for deposit, purchase costs, protected cash, household affordability, and buyer supports.

Do not use this playbook for an existing mortgage balance, repayment schedule, payoff date, or overpayment comparison. Those belong in the Mortgage playbook.

## Job
Parse only the client facts and dated planning assumptions into `generated.housePurchaseInputs`, then write a short client-facing `generated.summaryHtml`.

The app owns every repeatable calculation and result after the payload is applied, including capacity, purchase costs, deposit growth, mortgage illustrations, household headroom, funding stacks, readiness gates, bottlenecks, Help to Buy and First Home Scheme screens, next actions, tables, and charts.

## Gerry's Live Prompt Can Stay Short
This style should work:

`Use the house purchase playbook. Joint first-time buyers, Aoife age 34 earning 68000 and Conor age 35 earning 52000. Cash savings 70000, protect 10000 for other goals, rent 2100, save 1800 a month, net household income 6900, essential spending 2700, target a 475000 new-build house in Dublin City in June 2028. No AIP yet. Use the standard planning assumptions.`

## Strict Output Contract
Inside `generated`, emit exactly:
- `summaryHtml`
- `housePurchaseInputs`

Do not emit any other `generated` key for this playbook. In particular, do not emit hand-built outputs, eligibility results, tables, charts, funding stacks, bottlenecks, actions, rule versions, or scenarios.

What-if state is not part of the prompt payload. The app supports the local, non-persisting support cases `none`, `htb_only`, `fhs_only`, and `htb_and_fhs`; do not add a base-case or scenario selector to `housePurchaseInputs`.

## Preferred Payload Shape

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

## Canonical Runtime Fields

### Plan identity and classification
- `schemaVersion` - use `1`.
- `calculationDateIso` - `YYYY-MM-DD`; use the date the module is prepared or updated.
- `lendingCategory` - exactly `first_time_buyer`, `second_or_subsequent`, or `unknown`.
- `applicationType` - exactly `single` or `joint`.
- `applicants` - one applicant for `single`, exactly two for `joint`.

`lendingCategory` controls only the Central Bank income-multiple illustration. It is not a Help to Buy or First Home Scheme decision and must never be inferred from `schemeBuyerStatus`.

### Applicants
Each applicant supports:
- `id` - unique stable string.
- `label` - short client-facing name or `Applicant 1` / `Applicant 2`.
- `age` - non-negative number or `null` when genuinely unknown.
- `employmentStatus` - `employee`, `self_employed`, `contractor`, `student`, or `other`.
- `grossAnnualIncome` - base gross annual income.
- `variableAnnualIncome` - raw annual variable income; do not add it to base income.
- `lenderRecognisedVariableAnnualIncome` - only the amount explicitly recognised by a lender.
- `incomeReliability` - `stable`, `variable`, or `unknown`.
- `existingMonthlyDebtPayments` - that applicant's monthly debt repayments.
- `schemeBuyerStatus` - exactly `first_time_buyer`, `fresh_start`, `previous_owner`, or `unknown`.
- `freshStartReason` - client-stated reason or `null`; never invent or adjudicate it.
- `previouslyOwnedPropertyAnywhere` - boolean or `null`.
- `retainedInterestInPreviousProperty` - boolean or `null`.
- `rightToResideInIreland` - boolean or `null`.

Fresh-start separation is mandatory:
- A confirmed fresh-start case may use `lendingCategory: "first_time_buyer"` for the Central Bank illustration.
- Keep that applicant's `schemeBuyerStatus` as `fresh_start`.
- Do not relabel a fresh-start applicant as a Help to Buy first-time purchaser.
- Do not infer Help to Buy or First Home Scheme eligibility from the lending category.
- If fresh-start treatment has not been confirmed, use `lendingCategory: "unknown"` and preserve the client facts.

### Cash and deposit path
- `currentCashSavings` - current cash savings explicitly included in this planning view, before separate ringfenced-cash and emergency-reserve protections.
- `cashSavingsContributions` - rows of `{ "ownerId": string, "amount": number }`.
- `amountRingfencedForOtherGoals` - cash that must stay outside the purchase plan.
- `emergencyReserveMode` - `suggested` to let the app derive the reserve or `custom` when an explicit target is supplied.
- `emergencyReserveTarget` - required for `custom`; otherwise use `null`.
- `currentMonthlySavings` - current observed household saving.
- `plannedMonthlySavings` - intended monthly house-deposit saving; use current saving when Gerry explicitly says the plan is unchanged.
- `lumpSums` - rows of `{ "id": string, "amount": number, "expectedDate": "YYYY-MM-DD", "confidence": "confirmed" | "estimated" }`.

For a joint application, `cashSavingsContributions` must total exactly `currentCashSavings`. Include only cash the client explicitly includes in the planning view; do not assume a partner's cash is joint. If the ownership split is missing and materially affects the module, flag it in NOTES rather than inventing an unequal split.

### Household cash flow
- `monthlyNetHouseholdIncome`
- `monthlyEssentialExpensesExcludingHousingDebtAndRent`
- `currentMonthlyRent`
- `dependants`
- `otherKnownMonthlyCommitments`
- `estimatedMonthlyOwnershipCosts`

Keep rent out of essential expenses because it has its own field. Keep applicant debt repayments in the applicant records; `otherKnownMonthlyCommitments` is for other household commitments and must not double count those debts.

### Target property
- `targetPropertyPrice`
- `targetPurchaseDate` - `YYYY-MM-DD`; use the last day of the selected month where only a month is given.
- `acquisitionType` - exactly `new_build`, `second_hand`, `self_build`, `tenant_purchase`, or `unknown`.
- `dwellingType` - exactly `house`, `apartment`, `self_build`, or `unknown`.
- `intendedUse` - use `principal_private_residence` for this MVP.
- `localAuthorityCode` - the runtime's current local-authority code or `unknown`.
- `tenantNoticeReceived` - boolean or `null`.

Do not collapse `acquisitionType` and `dwellingType`. The former drives purchase-route and scheme rules; the latter drives First Home Scheme price ceilings.

### Lender capacity
`lenderCapacity` supports:
- `status` - `not_obtained`, `estimated`, `confirmed`, or `unknown`.
- `amount` - lender/AIP amount, or `null` if none was supplied.
- `lenderId` - `aib`, `ebs`, `haven`, `bank_of_ireland`, `ptsb`, `other`, or `unknown`.
- `isMaximumAvailable` - true only when the lender has confirmed it is the maximum available.
- `macroPrudentialException` - true only when explicitly confirmed.
- `htbQualifyingLender` - boolean or `null`; do not infer it from the First Home Scheme lender list.

Do not turn a Central Bank multiple into an AIP, and do not label an AIP as a mortgage approval. Preserve a lender amount above the standard income-limit illustration only when supplied; the app decides how it affects the result.

### Planning assumptions and purchase costs
- `depositSavingsGrossAer` - annual decimal rate.
- `dirtRate` - annual decimal tax rate.
- `mortgageIllustrationRate` - annual decimal rate.
- `mortgageTermYears` - positive whole number.
- `purchaseCosts.stampDutyMode` - `rules` or `custom`.
- `purchaseCosts.customStampDuty` - number for `custom`, otherwise `null`.
- `purchaseCosts.legalAndConveyancing`
- `purchaseCosts.valuation`
- `purchaseCosts.surveyOrEngineer`
- `purchaseCosts.movingAndFurnishing`
- `purchaseCosts.contingency`

When Gerry says to use standard planning assumptions, use:
- `depositSavingsGrossAer: 0.02`
- `dirtRate: 0.33`
- `mortgageIllustrationRate: 0.035`
- `mortgageTermYears: 35`
- rules-based stamp duty
- legal/conveyancing `3200`
- valuation `200`
- survey/engineer `400` for a new build, `600` for second-hand, or `800` for self-build
- moving/furnishing `5000`
- contingency `2500`

These are editable educational assumptions, not live quotes or product recommendations. Do not calculate the net savings rate, stamp duty, repayment, total interest, or sensitivity cases in the prompt output.

### Help to Buy facts
`helpToBuy` supports:
- `taxCompliant` - boolean or `null`.
- `revenueApprovedDeveloperOrApprover` - boolean or `null`.
- `expectedIncomeTaxAndDirtPaidPriorFourYears` - number or `null`.
- `confirmedClaimAmount` - use a positive number only for an explicitly confirmed Revenue amount; otherwise use `0`.

Keep all purchaser ownership-history facts in their applicant records. Do not calculate a Help to Buy amount, decide eligibility, or treat a maximum-before-tax-verification figure as confirmed funding.

### First Home Scheme facts
`firstHomeScheme` supports:
- `applicationStatus` - `not_applied`, `potential`, `confirmed`, `declined`, or `unknown`.
- `confirmedEquityAmount` - use a positive number only for explicitly confirmed scheme equity; otherwise use `0`.
- `siteEquity` - explicit self-build site equity, otherwise `0`.

Do not calculate a scheme share, price-ceiling result, service charge, or eligibility result in the prompt output.

## Parsing and Validation Rules
- Percentages become decimals: `4.2 percent` becomes `0.042`.
- Money inputs stay plain numbers without `€`, commas, or formatting.
- Dates must be `YYYY-MM-DD`.
- Keep all applicant ids unique and reuse those exact ids in `cashSavingsContributions.ownerId`.
- Never request or emit PPS numbers, bank credentials, account numbers, exact home addresses, or other unnecessary sensitive identifiers.
- Use `unknown` or `null` where the contract supports it; do not convert missing evidence into a pass, failure, approval, or confirmed amount.
- Do not silently make all savings available for a deposit when Gerry says some cash is protected.
- Do not combine estimated lump sums or potential scheme support with confirmed base funding.

## Summary Rules
- Keep `generated.summaryHtml` to 2 to 4 sentences.
- Explain that the plan connects income, protected savings, monthly saving, household position, and the target home.
- Tell the client to start with current capacity, required cash, estimated timing, and the main constraint.
- Name material missing confirmations, such as AIP or scheme checks, without predicting the result.
- Use `estimated`, `potentially eligible`, `appears unlikely`, `worth checking`, or `requires confirmation` where relevant.
- Never say `you qualify`, `you will receive`, `you can borrow`, `best mortgage`, or `recommended lender`.

## Notes Rules
Keep NOTES concise and call-friendly. Flag only material classifications, missing confirmations, and placeholders, especially:
- lending category versus applicant scheme status;
- any fresh-start treatment;
- protected cash or missing contribution split;
- variable income recognised by a lender versus raw variable income;
- missing AIP/lender details;
- potential versus confirmed HTB/FHS support;
- standard cost, savings-rate, mortgage-rate, or term assumptions used.

Do not calculate or report runtime results in NOTES.

## Omit By Default
For this playbook, do not emit:
- `generated.assumptions`
- `generated.outputs`
- `generated.outputsBucketed`
- `generated.tables`
- `generated.charts`
- `generated.pbsInputs`
- `generated.liquidityPlan`
- `generated.pensionInputs`
- `generated.netRetirementInputs`
- `generated.mortgageInputs`
- `generated.loanInputs`
- `generated.collegeFundingInputs`
- `generated.education`
- `generated.report`
- any model-authored scheme status, funding stack, readiness gate, bottleneck, action, result, debug, or rule-version object

The app calculates and renders every result from `generated.housePurchaseInputs`.

## Official Rule Context
The runtime owns dated Irish rule configuration and official sources. The prompt's job is to record facts, not reproduce or override the rule engine. The current ruleset was verified on `2026-07-11`; release-time checks must refresh any stale rule or source date. Current verification sources include:
- Central Bank mortgage measures: https://www.centralbank.ie/financial-system/financial-stability/macro-prudential-policy/mortgage-measures
- Central Bank framework and fresh-start context: https://edit.centralbank.ie/financial-system/financial-stability/macro-prudential-policy/mortgage-measures/mortgage-measures-framework-review-public-engagement
- Revenue residential Stamp Duty rates: https://www.revenue.ie/en/property/stamp-duty/property/stamp-duty-property/rates.aspx
- Revenue Help to Buy buyer rules: https://www.revenue.ie/en/property/help-to-buy-incentive/who-can-claim-htb.aspx
- Revenue Help to Buy property rules: https://www.revenue.ie/en/property/help-to-buy-incentive/what-type-of-property-qualifies.aspx
- Revenue Help to Buy amount: https://www.revenue.ie/en/property/help-to-buy-incentive/how-much-can-you-claim.aspx
- Revenue DIRT: https://www.revenue.ie/en/additional-incomes/dirt/what-dirt-rate-is-applicable.aspx
- First Home Scheme eligibility: https://www.firsthomescheme.ie/about-the-scheme/eligibility/
- First Home Scheme rules: https://www.firsthomescheme.ie/faqs/rules-and-eligibility/
- First Home Scheme price ceilings: https://www.firsthomescheme.ie/about-the-scheme/property-price-ceilings/
- First Home Scheme service charges: https://www.firsthomescheme.ie/about-the-scheme/service-charges/
- First Home Scheme participating lenders: https://www.firsthomescheme.ie/about-the-scheme/switching-your-mortgage/
- Bank of Ireland MortgageSaver: https://personalbanking.bankofireland.com/save-and-invest/savings/regular-savings-accounts/mortgagesaver/
- AIB deposit rates: https://www.aib.ie/our-products/savings-and-deposits/Deposit-Rates
- PTSB Regular Saver: https://www.ptsb.ie/saving-and-investing/savings-accounts/regular-saver/

## Good Output Looks Like
- `generated` contains only `summaryHtml` and the canonical `housePurchaseInputs` object.
- Applicant, contribution, cash-flow, property, lender, cost, HTB, and FHS facts stay separate.
- Fresh-start facts do not leak into Help to Buy classification.
- Unknown scheme or lender facts remain unknown rather than becoming false certainty.
- The summary explains how to read the plan without inventing its results.

## Avoid
- Using the Mortgage playbook contract for a future-purchase plan.
- Hand-calculating affordability, deposit timing, repayment, scheme eligibility, or actions.
- Treating the Central Bank illustration as an approval.
- Treating potential support as confirmed cash.
- Recommending a lender, mortgage product, scheme, tax action, or legal action.
