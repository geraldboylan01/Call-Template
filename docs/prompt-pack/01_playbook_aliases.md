# Playbook Aliases

These aliases exist so Gerry can keep using the same live-call phrasing.

## Direct Playbook Calls

### PBS Playbook
Use `10_pbs_playbook.md` when Gerry says things like:
- use the PBS playbook
- run PBS
- personal balance sheet
- balance sheet module
- classify these assets and liabilities

### Retirement Playbook
Use `11_retirement_playbook.md` when Gerry says things like:
- run the retirement playbook
- retirement module
- retirement projection
- target retirement income
- affordable retirement income
- goal-seek retirement income

### Net Retirement Cash Flow Playbook
Use `15_net_retirement_cashflow_playbook.md` when Gerry says things like:
- net retirement cash flow
- retirement shortfall from net income and net expenditure
- required net investment fund
- present value retirement shortfall
- compare keeping or losing rental income
- pension tax is too uncertain to model directly

### Liquidity Playbook
Use `16_liquidity_playbook.md` when Gerry says things like:
- use the liquidity playbook
- liquidity module
- cash buffer
- emergency fund
- too much cash
- cash getting eaten by inflation
- put cash to work

### House Purchase Playbook
Use `17_house_purchase_playbook.md` when Gerry says things like:
- use the house purchase playbook
- house purchase planner
- first-home plan
- what can they afford to buy
- when could they buy
- deposit and purchase-cost plan
- Help to Buy and First Home Scheme screening for a target purchase

### Mortgage Playbook
Use `12_mortgage_playbook.md` when Gerry says things like:
- use the mortgage playbook
- mortgage module
- mortgage projection
- mortgage overpayment scenario
- compare overpayments
- lump sum versus annual overpayment
- what would overpaying save
- what if we cleared some off the mortgage

### Loan Playbook
Use `13_loan_playbook.md` when Gerry says things like:
- use the loan playbook
- loan module
- personal loan projection
- non-housing loan scenario

### College Funding Playbook
Use `14_college_funding_playbook.md` when Gerry says things like:
- use the college funding playbook
- education funding options
- college costs for children
- ring-fence college funding
- at home versus away from home for college

### Future Cost Fund Playbook
Use `18_future_cost_fund_playbook.md` when Gerry says things like:
- use the future cost fund playbook
- future cost fund
- how do they have the money ready for college
- lump sum now or save every year
- what would it take to fund school fees
- set money aside for care costs starting in a few years
- start saving later

### Education Playbook
Use `20_education_playbook.md` when Gerry says things like:
- use the education playbook
- educate the client on
- explain this visually
- teach this topic

### Report Playbook
Use `21_report_playbook.md` when Gerry says things like:
- use the report playbook
- turn this report into a module
- convert this research into Call Canvas
- render this long note as a report module

### Protection Playbook
Use `22_protection_playbook.md` when Gerry says things like:
- use the protection playbook
- protection planning
- income protection
- serious illness cover

### Protection Gap Playbook
Use `23_protection_gap_playbook.md` when Gerry says things like:
- use the protection gap playbook
- protection gap
- what if one of them couldn't work
- what if one income stopped
- how long would their savings last
- if one of them died, would they be short

### Rental Keep or Sell Playbook
Use `24_rental_keep_or_sell_playbook.md` when Gerry says things like:
- use the rental keep or sell playbook
- rental keep or sell
- should they keep the rental or sell it
- what does the rental actually give them each year
- what would they have in hand if they sold the investment property

## Inference Rules
- If Gerry names a playbook explicitly, do not second-guess it.
- If Gerry does not name one, infer from the primary job:
  - structured net worth classification -> PBS
  - pension accumulation, pension drawdown, or gross pension income maths -> Retirement
  - net cash-flow shortfall and required after-tax investment fund maths -> Net Retirement Cash Flow
  - cash-only buffer, emergency fund, too little cash, or too much cash -> Liquidity
  - future home capacity, target price, deposit path, purchase date, or Irish purchase-support screening -> House Purchase
  - repeatable mortgage maths -> Mortgage
  - repeatable non-housing loan maths -> Loan
  - children’s college cost scenarios -> College Funding
  - having the money ready for one dated cost (lump sum today, saving each year, or starting later) -> Future Cost Fund
  - structured topic explanation -> Education
  - long-form report transformation -> Report
  - protection review, or explaining income protection or serious illness cover -> Protection
  - how big the gap would be if one income stopped, and how long savings would fill it -> Protection Gap
  - what a rental property gives each year if kept, against what would be in hand if sold -> Rental Keep or Sell

## Scenario Requests
Gerry often adds cases to a module he has already run. These stay in the same playbook:
- add a third case
- add another scenario to that
- show me a couple of alternatives
- compare three options
- what if they did X instead
- run that again with a case where the rent is lost

Rules:
- Stay in the playbook that produced the module and add the case to that playbook's scenario array.
- A module carries at most 4 cases in total, counting the base or current case, so PBS carries at most 3 alternatives.
- If the requested case changes something the scenario array cannot change, say so in NOTES and build it as a separate module rather than distorting a case.

## Mixed Requests
- If Gerry asks for a JS-engine module and a separate explainer, prefer the JS-engine playbook first.
- If Gerry later says `turn that into a report` or `make an education module from this`, switch to the named visual playbook.
- Keep one module contract per response unless Gerry clearly asks for multiple outputs.
- Use House Purchase for planning a future purchase. Use Mortgage for an existing housing loan's payment, term, payoff, or overpayment path.
- Use College Funding for what college will cost. Use Future Cost Fund for how to have the money ready for one dated cost once its yearly cost is known.
- Use Protection Gap for how big the gap would be if an income stopped and how long savings would last. Use Protection for explaining how income protection and serious illness cover work. Protection Gap never shows a cover amount or a premium.
- Use Rental Keep or Sell for one rental property's yearly result against its sale. Use Mortgage or Loan for the repayment path of the loan on it.
