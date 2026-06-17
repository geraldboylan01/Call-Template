# Prompt Pack Examples and Regression Prompts

Use this file for shadow testing before cutover. The goal is not to memorize these prompts. The goal is to test whether the prompt pack stays schema-valid, visually strong, and easy to use in live calls.

## Shadow Test Workflow
For each prompt below:
1. Run the prompt through the old prompt bundle.
2. Run the same prompt through the new prompt pack.
3. Paste both JSON outputs into the current app.
4. Score each result on:
   - schema validity
   - speed to useful answer
   - visual quality
   - client clarity
   - whether the NOTES stayed concise
5. Keep the old bundle available until the new pack is clearly better on real prompts.

## Pass / Fail Checks
- Pass if the payload pastes into the app without schema rejection.
- Pass if the selected playbook is correct.
- Pass if unsupported keys are omitted.
- Pass if the module feels usable on a live call.
- Pass only if `generated.summaryHtml` is understandable without knowing the playbook name.
- Pass only if client-facing JSON avoids internal words such as `browser app`, `payload`, `engine`, `runtime`, `JSON`, validators, and schemas.
- PBS outputs pass only if the summary section uses `key: "summary"`, the exact row label `Net worth`, and `subtotalLabel: "Net worth"`.
- Fail if the model asks unnecessary questions instead of using a safe best guess.
- Fail if the visual playbooks become generic or repetitive.

## Summary Clarity Checklist
Every regression output should pass this client-clarity test:
- the summary says what the module is doing
- the summary names the client facts driving the view
- the summary tells the client how to read the first screen
- the summary identifies the next decision, risk, or verification point
- Gerry-only assumptions stay in SECTION 1 NOTES, not in client-facing JSON

## PBS Regression Prompts

### PBS-1
Prompt:
`Use the PBS playbook. Assets: Family home 525000; Cash 12000; Savings 18000; PRSA 95000; Employer pension 240000; ETF portfolio 42000; Crypto 5000; Business value 110000. Liabilities: Mortgage 220000; Credit card 900. Annual expenditure 42000. Current age 44.`

Checks:
- uses `generated.outputsBucketed`
- includes `generated.pbsInputs`
- omits `generated.outputs`
- notes ambiguous classification if needed

### PBS-2
Prompt:
`Use the PBS playbook. Assets: Apartment rented out 280000; Deposit account 30000; DC pension 180000; Single stocks 22000. Liabilities: Buy-to-let mortgage 140000.`

Checks:
- no guessed `currentAge`
- no guessed `annualExpenditure`
- rented apartment likely classified as `Legacy`

### PBS-3
Prompt:
`Use the PBS playbook. Assets: Family home 460000; Current account 9000; Money market fund 15000; PRSA 65000; Global equity fund 35000; Watches 8000. Liabilities: Mortgage 190000; Car loan 12000.`

Checks:
- summary is concise
- 2 charts max
- totals and subtotals reconcile

### PBS-4
Prompt:
`Use the PBS playbook. Client age 46. Household take-home pay 7500 per month. Saves 1000 per month. Assets: family home 560000; buy-to-let property 280000; cash 10000; DC pension 200000; spouse teacher public service pension value not known. Liabilities: family home mortgage 275000; buy-to-let mortgage 110000. Add a scenario where the buy-to-let is sold, the buy-to-let mortgage is repaid, and the remaining equity is redirected into the DC pension.`

Checks:
- current summary rows are exactly `Gross assets`, `Total liabilities`, `Net worth`
- current net worth is 665000
- scenario summary rows also use exact `Net worth`, not `Known net worth`, `Net assets`, or `Net wealth`
- scenario redirects 170000 to `Longevity`, not `Liquidity`, because the prompt says it goes into the pension
- scenario net worth remains 665000 before tax and sale-cost adjustments
- movement actions use canonical `reduce` for the repaid buy-to-let mortgage and `add` for the pension redirect

## Retirement Regression Prompts

### RET-1
Prompt:
`Run the retirement playbook for Niamh. Age 39. Pension 125000. Salary 72000. Personal 7 percent. Employer 5 percent. Retire at 67. Growth 5 percent. Target 36000 in today's money.`

Checks:
- uses `generated.pensionInputs`
- target mode selected
- no fake outputs or charts

### RET-2
Prompt:
`Run the retirement playbook for Mark. Age 31. Pension 40000. Salary 58000. Personal 5 percent. Employer 5 percent. Retire at 67. Growth 5 percent. Show what income he could afford in retirement.`

Checks:
- affordable mode selected
- `affordableEndAges` defaults in
- summary references affordability, not target income

### RET-3
Prompt:
`Run the retirement playbook for Anna. Age 45. Pension not known yet. Salary 95000. Personal 9 percent. Employer 6 percent. Retire at 65. Growth 4.5 percent.`

Checks:
- `currentPot` safely defaults to 0
- placeholder target policy is clearly flagged in NOTES
- still returns valid JSON

### RET-4
Prompt:
`Run the retirement playbook for Sarah. Age 42. Pension 180000. Salary 85000. Personal 8 percent. Employer 6 percent. Retire at 67. Growth 5 percent. Target 42000 in today's money. Rental income 18000 gross a year today. Show with and without rental income, with rent as the base case.`

Checks:
- uses `generated.pensionInputs`
- includes `rentalIncomeToday`, `baseScenarioId`, and two `rentalIncomeScenarios`
- uses gross annual rent in today's money
- does not emit fake outputs or charts
- keeps retirement module JS-backed

### RET-5
Prompt:
`Run the retirement playbook for John and Mary as a couple. John is 42, salary 85000, pension 180000, personal 8 percent, employer 6 percent, retire at 67. Mary is 40, salary 70000, pension 120000, personal 7 percent, employer 5 percent, retire at 66. Growth 5 percent, inflation 2 percent, target household income 70000 in today's money from 2052. Include rental income of 18000 today and Mary's DB pension of 12000 from age 66 indexed.`

Checks:
- uses `generated.pensionInputs.pensions` with two named pension entries
- includes legacy top-level pension keys for couple payload compatibility
- includes a household `targetStartYear`
- leaves State Pension included by default
- includes `otherIncomeSources` for the DB pension with explicit `inflationIndexed`
- does not emit fake outputs or charts
- keeps retirement module JS-backed

### RET-5A
Prompt:
`Run the retirement playbook for a couple. Alex is 60, salary 100000, pension 100000, personal 10 percent, employer 0 percent. Blake is 55, salary 80000, pension 200000, personal 10 percent, employer 0 percent. They both retire at 65. Growth 0 percent, inflation 0 percent, target household income 50000.`

Checks:
- sets each pension member's own `retirementAge` to 65
- includes `incomeStartYear` for the first retirement year
- includes `requiredPotReferenceYear` for the later retirement year
- leaves `includeEmploymentIncomeDuringBridge` omitted or `true`
- does not emit fake outputs or charts

### RET-6
Prompt:
`Run the retirement playbook for John and Mary. Same as before, but exclude Mary's State Pension and show the rent-lost case as a scenario.`

Checks:
- sets Mary's pension member `includeStatePension` to `false`
- includes `baseScenarioId` and `rentalIncomeScenarios`
- keeps the two pension entries named
- does not emit fake outputs or charts

## Net Retirement Cash Flow Regression Prompts

### NETRET-1
Prompt:
`Use the net retirement cash flow playbook. Household age 60 to 100. Net expenditure 90000. Net Irish rent 10000. Net EU rent 14000. Include 50 percent Irish State Pension from age 66 as 7781.80 today. PV growth 4 percent. Expenditure inflation 2 percent. Compare keep Irish rental with sell Irish rental. Keep case investable assets 1027000. Sell case investable assets 1477000 and Irish rent is lost.`

Checks:
- uses `generated.netRetirementInputs`
- does not use `generated.pensionInputs`
- includes `incomeSources` for the net rental income and 50% State Pension assumption
- includes two `scenarios` and `baseScenarioId`
- uses `presentValueRate` for the PV growth assumption
- omits fake outputs, tables, and charts
- mentions the net required fund / gross pension compatibility caveat

## Mortgage Regression Prompts

### MORT-1
Prompt:
`Use the mortgage playbook. Balance 345000. Rate 4.1 percent. Start March 2026. End February 2053. Annual overpayment 2500.`

Checks:
- uses `generated.mortgageInputs`
- `repaymentType` is `repayment`
- no report or education keys

### MORT-2
Prompt:
`Use the mortgage playbook. Balance 280000. Rate 3.95 percent. Start June 2026. Remaining term 22 years. One-off overpayment 10000.`

Checks:
- uses `remainingTermYears`
- sets `endDateIso` to null
- notes the one-off overpayment only if present

### MORT-3
Prompt:
`Use the mortgage playbook. Balance 300000. Rate 4.25 percent.`

Checks:
- uses placeholder start date and term if needed
- flags placeholders in NOTES
- still emits valid JSON

## Loan Regression Prompts

### LOAN-1
Prompt:
`Use the loan playbook. Balance 18000. Rate 8.5 percent. Start February 2026. Remaining term 4 years. Annual overpayment 500.`

Checks:
- uses `generated.loanInputs`
- `loanKind` is `loan`
- does not use `generated.mortgageInputs`

### LOAN-2
Prompt:
`Use the loan playbook. Balance 9500. Rate 6.9 percent. Start April 2026. Fixed monthly payment 250.`

Checks:
- valid placeholder term if no term or end date is given
- fixed payment included
- schema still validates

### LOAN-3
Prompt:
`Use the loan playbook. Balance 24000. Rate 7.2 percent. End June 2031.`

Checks:
- placeholder start date only if needed
- correct loan wording in summary

## Education Regression Prompts

### EDU-1
Prompt:
`Use the education playbook. Explain Help to Buy for a first-time buyer couple in Ireland. Make it visually strong and easy to follow live.`

Checks:
- one strong hero visual
- `visuals[0]` reads like the hero scene
- SVG kind chosen intelligently
- uses `metrics`, `steps`, chart `annotations`, or chart `insights` only if they genuinely clarify the topic
- no fake URLs or quotes

### EDU-2
Prompt:
`Use the education playbook. Explain the decision between gifting assets now versus leaving them through an estate. Keep it client-friendly and comparison-led.`

Checks:
- likely uses `comparisonGrid` or `decisionTree`
- avoids calculator fields
- sections are teachable, not essay-like

### EDU-3
Prompt:
`Use the education playbook. Explain the steps and timing in a bare trust for minors.`

Checks:
- timeline scene preferred over a tall single-lane process map
- no unnecessary chart if no real numbers exist

### EDU-4
Prompt:
`Use the education playbook. Explain a family bridging loan to help a parent downsize. Make it easy to screen-share and include direct official Revenue links where confidently known.`

Checks:
- hero scene is concise and presenter-friendly
- direct URLs are included only when confidently known
- references stay curated rather than becoming a long dump

## Report Regression Prompts

### REP-1
Prompt:
`Use the report playbook. Turn this markdown research note into a client-facing module. Focus on what matters practically.`

Checks:
- uses `generated.report`
- no `report.meta`
- chooses opener based on source, not a forced template
- no advisor/adviser/presenter-only labels or internal talk-track copy inside the JSON

### REP-2
Prompt:
`Use the report playbook. Turn this market note into a module and keep the pacing visual, not text-heavy.`

Checks:
- includes at least one strong visual or KPI opener when justified
- may use `insightGrid`, chart `insights`, or chart `annotations` if they improve interpretation
- avoids filler blocks
- rewrites any research-note or adviser-note framing into client-facing implications

### REP-3
Prompt:
`Use the report playbook. Convert this long policy update into a module. The client mostly needs the decision path and next steps.`

Checks:
- likely hero `svg` or `timeline`
- may use `accordion` for verification detail if the source has caveats or assumptions
- next steps included only if useful

## Protection Regression Prompts

### PROT-1
Prompt:
`Use the protection playbook. Age 42. Income 80000. Existing serious illness cover 50000. Existing income protection premium 1500. Tax rate 40 percent.`

Checks:
- uses `generated.report`
- 2-year support is the hero figure
- premium relief view is illustrative and clearly framed

### PROT-2
Prompt:
`Use the protection playbook. Age 35. Income 65000. No existing cover known. Employer benefits unknown. Keep it easy to screen-share.`

Checks:
- does not invent quotes or underwriting outcomes
- includes employer-check callout
- uses assumptions carefully

### PROT-3
Prompt:
`Use the protection playbook. Age 50. Income 110000. Existing serious illness cover 150000. Existing income protection cover and premium not known.`

Checks:
- serious illness still framed as support buffer
- no fake premium pricing if premium is missing
- final priority callout is practical
