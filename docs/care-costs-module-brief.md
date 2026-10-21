# Care costs: what nursing home care could cost, what Fair Deal asks, and the ways a family could pay

Status: revised 21 October 2026 after Gerry's two reviews of PR #89. Every decision is settled. **Nothing is built.** No engine, no screen, no wiring. Adviser-only when it is built (`consumer: false`). The screen design is a separate step after this brief is approved.

## Still open

No decision is waiting on Gerry. Two things wait on others before the build:

1. **The shared plan pieces in PR #88.** Care plugs into three pieces the storyteller brief is adding: one dated-cost contract that college, the future cost fund and care all hand to the ledger; one projection through retirement to age 100 that every later-life stress changes; and one stress registry with central sizes. The field names in this brief's plan-layer section and `summary` are placeholders until #88 names them, and then they change to match.
2. **How an approved retirement fund is assessed.** The HSE and Citizens Information need to confirm how an ARF is valued for Fair Deal, and whether its drawdowns also count as income (open item 7). The stress test follows that rule and never counts the same money twice.

## Decisions, settled 21 October 2026

| # | Decision | Settled |
|---|---|---|
| 1 | Whose care | **Two uses, both in the first release.** (a) A parent or relative the household pays for, only when the client picks or mentions it, with a short set of questions asked only then (see "Questions about a relative's care"). (b) The client's own later-life care as a stress test needing no new questions: for each person in the household in turn, care from age 85 to 90, run through B1.5's projection through retirement (see "One of you needs care"). It is a stress test, never a goal, and takes no money in the ledger. |
| 2 | Care at home | **Not in the first release.** The module covers nursing home care, and says so. |
| 3 | How fast nursing home fees rise | **4% a year: the existing central education and healthcare rate, `inflation.educationRate`.** Its basis already names healthcare costs. One rate for both, so they move together, labelled for care as well. No separate care rate. The plan story's cost stress (2 points higher) then puts care at 6%. |
| 4 | The default weekly fee | **The county average from the HSE's list of agreed prices (list 230) when the county is known, otherwise the national average (€1,312 a week).** The adviser can type a real home's price instead. |
| 5 | Whether the assessment is redone each year | **Yes.** Each year is assessed on the savings left at the end of the year before, and the footnote says a review is assumed each year. |
| 6 | How much of their income a person keeps when paying privately | **The same personal allowance Fair Deal leaves them**, so cases compare like with like. The course checks set it to zero. |
| 7 | Whether the person's pension income rises over the years of care | **Yes, with general prices (2%).** Tax bands stay frozen, as the tax engine already does. |
| 8 | How long a relative's care lasts | **5 years by default, with 3 and 10 years shown beside it.** The course accepts 5 or 10. Whole years only. Life expectancy tables come later as an extra comparison. |
| 9 | Which State pension rate sets the safeguards | **The maximum personal rate of State Pension (Non-Contributory) for someone aged 66 to 79**: €288 a week from 2 January 2026, €298 from January 2027 once in force. |
| 10 | The Nursing Home Loan repayment deadline | **No deadline on screen.** The loan is described as repaid from the estate after death. Revenue says 12 months and the HSE says 18; no figure depends on it. |
| 11 | How the effect on the estate is shown | **In today's money**, with the home holding its value against prices and the loan growing with prices (the CPI, at the central 2%). |
| 12 | The CFP course cases | **They stay private** in `private/cfp-cases/`, never in this public brief. |
| 13 | Name | **"Care costs"**, kind `care-costs`, payload key `careCostInputs`. |
| 14 | Fair Deal only when it lowers the cost (new) | **A case basis `lower_of`, the default everywhere**, including the stress test. Each year the person pays the lower of their assessed contribution and the private fee, with extras on top of both. The three-year limit on the home counts from entering care, not from applying. See "Why Fair Deal never costs more". |
| 15 | Relief in the course checks (new) | **A flat 40%, injected for the private course checks only**, like the course's rates. Never reachable from a payload. Everywhere else relief comes from the tax engine at the payer's real rate. |
| 16 | The home's share in the stress test | **Deferred through the Nursing Home Loan in every year Fair Deal applies.** The partner at home keeps the savings, and the stress reports the loan the estate would carry, in today's money. |
| 17 | Tax relief in the stress test | **Not counted in the first release.** Every stress row carries the review item "Tax relief on nursing home fees may lower this cost", as a plain statement with no figure. |
| 18 | Where the stress test runs | **Through the shared pieces in PR #88, not a hook of its own.** The care engine supplies a yearly extra outgoing to B1.5's single projection through retirement, and "One of you needs care" is an entry in B1.5's stress registry. |

## Context

A client's parent may need nursing home care, now or in a few years. The questions this module answers are: **what could the care cost, what would the Nursing Homes Support Scheme (Fair Deal) ask the parent to pay from their own income and assets, what is left for the family, and what are the ways the family could meet it?**

Nothing in the app answers this. The future cost fund (`js/future_cost_fund_math.js`, brief `docs/future-cost-fund-app-change.md`) funds one dated cost, and its comments name "care for a parent" as an example, but it knows nothing about Fair Deal, the parent's own money or tax relief. The plan document lists "care for a parent: a start, a number of years and a yearly cost" as a fact the profile does not hold yet (`docs/plan-and-routes-implementation-plan.md`, section 6).

The idea the module has to land: **under Fair Deal the parent pays a set share of their income and assets and the HSE pays the rest; the contribution from the home stops after three years; and what the family pays, and when, depends on whose money is used first.**

The same calculator has a second use with no questions of its own: a stress test of the client's own later life, where one person in the household needs care from 85 to 90 and the cost runs through the plan's projection of the household through retirement (see "One of you needs care").

It is used two ways at once, like every module: shared on a call while the adviser clicks between cases, and re-opened later by the client alone. Nothing may depend on spoken context.

## What the client is shown

The picture is not designed yet. This section sets what the screen must say. The design step draws it.

1. **The likely cost.** The weekly fee and what it comes to in a year. By default the county average, or the national average when no county is given (decision 4), named as an average of the HSE's agreed prices, with the list's date.
2. **What Fair Deal asks of the person**, in three parts that add up to their contribution:
   - from income: usually 80% of their income after tax, because they keep a personal allowance;
   - from savings and other assets: 7.5% a year of their value above the first €36,000;
   - from the home: 7.5% of its value a year, **for three years only**, so never more than 22.5% of its value. This cap is the single most important fact on the screen.
   - The HSE pays the rest of the fee.
   - Fair Deal is used only in the years it lowers the cost. In a year where the contribution would reach the fee, the person is shown paying privately and the HSE paying nothing, with the words "Fair Deal would not lower the cost this year". The screen says which years Fair Deal applies.
3. **What is left for the family** in each case, before and after the tax relief the payer can claim.
4. **The ways to meet it**: from the household's money each year, a lump sum set aside now, or (when care starts later) saving each year until it starts.
5. **What it leaves**: how many years the parent's own money lasts, and what the Nursing Home Loan would take from the estate.
6. A footnote with every rule and assumption in use, its source date and version.

### Why Fair Deal never costs more than paying privately

In money terms, using Fair Deal in the years it lowers the cost is never dearer than paying privately throughout. Two rules make sure of it:

- **The contribution can never be more than the cost of care.** In any year, the person pays the lower of the two. A year where the assessed contribution would reach the fee is simply a private year.
- **The three-year limit on the home counts from the day care starts, not from the day of applying.** Someone who has "already been in a nursing home for 3 years" when they apply pays nothing on the home (`ciFairDeal`). So paying privately in the early years never adds years of contribution from the home later. A wealthy person who pays privately for three years, while the home still counts, and then applies, pays nothing on the home from year four.

The Nursing Home Loan does not change this: the deferred amount grows only with prices, so in today's money it is the same as paying when due.

A family may still choose not to use Fair Deal for reasons that are not about money. These never enter the calculation. They go to the plan story's review items (`check_next`) as plain statements, with no figures:

- the loan places a charge on the home;
- wanting a home that charges more than its agreed price;
- the waiting list for Fair Deal funding;
- the five-year look-back on gifts and transfers.

The `private_fee` case remains for a family that chooses not to use the scheme.

### A worked example: the sample, year one

A public sample, made up for this brief. It uses only the rules below, so every figure can be checked by hand.

Mam is 84, widowed, lives alone in Co. Meath and needs nursing home care now. She has a State pension of €15,600 a year (under the over-65 income tax exemption, so no tax), savings of €90,000 and a home worth €320,000 with no mortgage.

| | Rule | Year one |
|---|---|---|
| Weekly fee | Meath average of agreed prices | €1,313, so €68,276 a year |
| From income | Keeps the larger of 20% of €15,600 (€3,120) or 20% of the maximum State Pension (Non-Contributory) at €288 a week (€2,995, decision 9). Pays the rest. | €12,480 |
| From savings | 7.5% of €90,000 less €36,000 | €4,050 |
| From the home | 7.5% of €320,000, years one to three only | €24,000 |
| Her contribution | | **€40,530** (about €779 a week) |
| The HSE pays | Fee less contribution | €27,746 |

Her contribution never reaches the fee, so Fair Deal lowers the cost in every year. From year four the home part stops, so she pays about €16,500 a year if her savings are unchanged. Over three years the home part comes to €72,000, which is the 22.5% cap. With the Nursing Home Loan, that €72,000 is not paid during her life: it is repaid from her estate, increased by the change in prices.

Without Fair Deal (a private fee), the same year costs €68,276, her income less her allowance pays €12,480, and €55,796 is left. Her savings would cover that for under two years; after that the family pays.

## Fair Deal rules, as checked on 21 October 2026

Every figure below is checked against the official page named, on 21 October 2026. **None of them may be typed into the engine.** They go into a versioned rules record (see "Where the rules live").

### Sources

| Key | Source | Date on the page |
|---|---|---|
| `hseFinancialAssessment` | HSE, "Financial assessment: How much you pay towards care", www2.hse.ie/services/schemes-allowances/fair-deal-scheme/financial-assessment/ | None shown |
| `hseThreeYearCap` | HSE, "3-year cap on homes, farms and businesses", www2.hse.ie/services/schemes-allowances/fair-deal-scheme/3-year-cap/ | None shown |
| `hseNursingHomeLoan` | HSE, "Nursing home loan", www2.hse.ie/services/schemes-allowances/fair-deal-scheme/nursing-home-loan/ | None shown |
| `hseAbout` | HSE, "About the Fair Deal scheme", www2.hse.ie/services/schemes-allowances/fair-deal-scheme/about/ | None shown |
| `ciFairDeal` | Citizens Information, "Fair Deal scheme", citizensinformation.ie/en/health/health-services/health-services-for-older-people/fair-deal-scheme/ | Page edited 20 December 2024 |
| `revenueNursingHome` | Revenue, "Nursing home and additional nursing care expenses", revenue.ie/en/personal-tax-credits-reliefs-and-exemptions/health-and-age/health-expenses/nursing-home-and-additional-nursing-care-expenses.aspx | Published 8 September 2026 |
| `revenueHealthExpenses` | Revenue, "Health expenses", revenue.ie/en/personal-tax-credits-reliefs-and-exemptions/health-and-age/health-expenses/index.aspx | Published 12 June 2026 |
| `revenueLoanRepaid` | Revenue, "How is the loan repaid to Revenue?" and "Interest on late payments", revenue.ie/en/life-events-and-personal-circumstances/nursing-homes-fair-deal-loan/ | Published 7 February 2023 |
| `dspStatePensionNonContributory` | gov.ie, "State Pension (Non-contributory)", gov.ie/en/department-of-social-protection/services/state-pension-non-contributory/ | Last updated 7 October 2026 |
| `ciBudget2027` | Citizens Information, "Budget 2027", citizensinformation.ie/en/money-and-tax/budgets/budget-2027/ | Read 21 October 2026 |
| `dohBudget2027OlderPeople` | gov.ie, Department of Health, "Minister for Older People Kieran O'Donnell announces Budget 2027 funding increases" | Last updated 9 October 2026 |
| `hseAgreedPricesList230` | HSE, "Nursing Home Support Scheme Maximum Agreed Prices with Private & Voluntary Nursing Homes", list 230, assets.hse.ie/media/documents/HSE_Section40_List_230_Published_List_04.09.2026.pdf | Date modified 4 September 2026 |
| `hsePublicCostOfCare` | HSE, "Nursing Homes Support Scheme, Cost of Care in Public Nursing Homes", assets.hse.ie/media/documents/NHSS_Cost_of_Care_September_2026_Update.pdf | Effective from 1 September 2026 |
| `igeesNhss2019` | IGEES, Department of Public Expenditure and Reform, "Social Impact Assessment Series: Nursing Home Support Scheme (NHSS)", assets.gov.ie/static/documents/social-impact-assessment-sia-nursing-home-support-scheme-nhss.pdf | August 2019 |

### The contribution

| Rule | Figure | Source |
|---|---|---|
| Single person, from income | 80% of assessable income | `hseFinancialAssessment`, `ciFairDeal` |
| Single person, from assets | 7.5% a year of cash assets and of non-cash assets | `hseFinancialAssessment` |
| Asset disregard, single | First €36,000 of assets not counted | `hseFinancialAssessment`, `ciFairDeal` |
| Couple, from income | 40% of combined assessable income | `hseFinancialAssessment` |
| Couple, from assets | 3.75% a year of combined assets | `hseFinancialAssessment` |
| Asset disregard, couple | First €72,000 not counted | `hseFinancialAssessment` |
| Order the disregard is taken | "discounted from your cash assets first, and then your non-cash assets" | `hseFinancialAssessment` |
| Who is a couple | Married and living together, or living together as life partners for at least three years. Not relatives living together. | `hseFinancialAssessment`, `ciFairDeal` |
| Net value | An asset's value less borrowings for its purchase or improvement | `ciFairDeal` |
| Cash assets | Savings and deposits, stocks and shares, approved retirement funds (value at application), money lent, cash given away in the last five years | `ciFairDeal` |
| Non-cash assets | The home (owned or part owned), other property and land, businesses, overseas property | `ciFairDeal` |
| Deductions from income | Income tax, USC and PRSI; property tax and other legal levies; interest on loans to buy, repair or improve the home; health expenses after tax refund (not Fair Deal contributions); maintenance; a dependent child in full-time education; qualifying redress | `ciFairDeal`, `hseFinancialAssessment` |
| Not more than the cost | The contribution never exceeds the cost of care. If the assessed amount would exceed it, the person may not be eligible for State support. | `hseFinancialAssessment`, `ciFairDeal` |
| The home's price does not matter | "The amount your nursing home charges does not matter." The contribution is the same in any approved home. | `hseFinancialAssessment`, `hseAbout` |
| Reviews | A review can be asked for 12 months after the first assessment or the last review | `hseFinancialAssessment`, `ciFairDeal` |

### Safeguards

| Rule | Figure | Source |
|---|---|---|
| Personal allowance | The person keeps 20% of their income, or 20% of the maximum rate of State Pension (Non-Contributory), whichever is more | `ciFairDeal` |
| A spouse or partner at home | Left with 50% of the couple's income, or the maximum rate of State Pension (Non-Contributory), whichever is more | `ciFairDeal` |
| Maximum State Pension (Non-Contributory), personal rate | €288 a week from 2 January 2026 (aged 66 to 79); €298 a week aged 80 and over | `dspStatePensionNonContributory` |
| Budget 2027 | Most maximum weekly social welfare rates and pensions rise by €10 from January 2027. Derived: €298 (66 to 79) and €308 (80 and over). Record as `announced` until the commencement date is confirmed. | `ciBudget2027`, `dspStatePensionNonContributory` |

### The 3-year cap

| Rule | Figure | Source |
|---|---|---|
| The home | Counted only for the first three years in care, counted from entering care, not from applying | `hseThreeYearCap`, `ciFairDeal` |
| Single person | At most 22.5% of the home's value (7.5% a year for three years) | `hseFinancialAssessment` |
| Couple, one in care | 3.75% a year for three years, at most 11.25% | `ciFairDeal` |
| Couple, both in care | At most 22.5% in total | `ciFairDeal` |
| Already in care three years when applying | Nothing is paid on the home | `ciFairDeal` |
| Proceeds of selling the home | The net proceeds also fall under the cap | `hseThreeYearCap`, `ciFairDeal` |
| Farm or business | Can fall under the cap if a family successor (18 or over) commits to run it for at least six years, and it was actively run by the person, their partner or the successor for at least three of the last five years. A charge is placed on it. | `hseThreeYearCap`, `ciFairDeal` |
| Other assets | Counted for as long as the person is in care | `ciFairDeal` |

### Rent

| Rule | Figure | Source |
|---|---|---|
| Rent from the home while in care | Can be fully exempt on application, with Residential Tenancies Board registration, the rental agreement and the latest Revenue notice of assessment. Citizens Information dates this from 1 February 2024. The HSE page notes "The Government made changes to the rental sector on 1 March 2026". | `ciFairDeal`, `hseFinancialAssessment` |
| Rent from any other property | Counted as general income, so 80% is paid | `ciFairDeal`, `hseFinancialAssessment` |

### Transfers

| Rule | Figure | Source |
|---|---|---|
| Assets given away | Counted if transferred in the five years before the first application, or at any time after it | `hseFinancialAssessment`, `ciFairDeal` |
| Income given away | Income transferred in the five years before the first application counts | `ciFairDeal` |

### The Nursing Home Loan (ancillary State support)

| Rule | Figure | Source |
|---|---|---|
| What it does | The contribution based on land or property in the State can be postponed. The HSE pays it to the nursing home and it is collected after death or on a sale. | `ciFairDeal`, `hseNursingHomeLoan` |
| Security | A Charging Order on the asset, with the written consent of the person and of a spouse or partner | `ciFairDeal` |
| Price adjustment | Inflation or deflation (the CSO's CPI) is added to the amount repaid | `hseNursingHomeLoan` |
| Repaid to | The Revenue Commissioners | `ciFairDeal`, `revenueLoanRepaid` |
| After death | **Sources disagree.** Revenue: within 12 months of the date of death. HSE: within 18 months. Interest runs from the date of death if late. Decision 10. | `revenueLoanRepaid`, `hseNursingHomeLoan` |
| On a sale or transfer during life | Within six months of the sale or transfer | `revenueLoanRepaid`, `hseNursingHomeLoan` |
| Late payment interest | 0.0219% a day | `revenueLoanRepaid` |
| Further deferral | Only for a loan on the main home. A spouse or partner, or a "connected person" (for example a child under 21, or a carer who cared for the person before they went into care) can apply to defer repayment while the home is their only residence, after living there at least three years before the loan application. The amount is CPI-adjusted when the deferral ends. | `hseNursingHomeLoan`, `ciFairDeal` |
| The estate | Cannot be distributed before the loan is repaid without the HSE's written consent | `revenueLoanRepaid` |

### What Fair Deal does not cover

Short-term care (respite, convalescent and day care), and extra charges for things like hairdressing, therapies and activities, which are agreed with the home (`ciFairDeal`, `hseAbout`). There is a set level of funding each year, so an approved person can wait on a list (`ciFairDeal`).

### Tax relief on nursing home fees

| Rule | Detail | Source |
|---|---|---|
| Rate | Relief at the payer's highest rate of tax, as a deduction from total income. The amount relieved at 40% or 20% depends on how much income was taxed at each rate. | `revenueNursingHome`, `revenueHealthExpenses` |
| Condition | The nursing home provides 24-hour on-site nursing care | `revenueNursingHome` |
| Who can claim | Anyone, for their own expenses or another person's, "as long as you paid for them" | `revenueHealthExpenses` |
| Fair Deal | No relief on the HSE's share. Relief on what the person or family pays themselves, which includes a Fair Deal contribution. | `revenueNursingHome` |
| The loan | When repaid, the repayment can be claimed as a health expense against the person's income tax liability, or by the executor against the deceased's. There must be an income tax liability. | `revenueNursingHome` |
| Timing | Can be claimed in real time during the year | `revenueNursingHome` |

### Budget 2027

Budget 2027 (6 October 2026) added €97 million for Fair Deal, for cost pressures and 500 more people, and 1.8 million more home support hours (`dohBudget2027OlderPeople`). I found no change to the contribution rules. The €10 rise in State pensions changes the safeguard rate (above).

### Prices

**Private and voluntary homes.** The HSE publishes the maximum price agreed with each home under the scheme (`hseAgreedPricesList230`, list 230, dated 4 September 2026; the National Treatment Purchase Fund agrees these prices with each home). It lists 411 homes with a price, from €1,192 to €1,508 a week. The simple average is **€1,312**, the median €1,287. The county averages below are my own calculation from that list on 21 October 2026, a simple average of each home's price, not weighted by beds. The list itself gives no averages.

| County | Homes | Average a week | Lowest | Highest |
|---|---|---|---|---|
| Carlow | 5 | €1,256 | €1,220 | €1,277 |
| Cavan | 7 | €1,291 | €1,228 | €1,329 |
| Clare | 12 | €1,260 | €1,224 | €1,304 |
| Cork | 47 | €1,307 | €1,232 | €1,492 |
| Donegal | 13 | €1,259 | €1,234 | €1,279 |
| Dublin | 86 | €1,414 | €1,342 | €1,508 |
| Galway | 31 | €1,269 | €1,210 | €1,319 |
| Kerry | 15 | €1,262 | €1,200 | €1,310 |
| Kildare | 20 | €1,341 | €1,275 | €1,388 |
| Kilkenny | 10 | €1,274 | €1,245 | €1,285 |
| Laois | 3 | €1,284 | €1,270 | €1,304 |
| Leitrim | 2 | €1,276 | €1,274 | €1,277 |
| Limerick | 21 | €1,263 | €1,230 | €1,292 |
| Longford | 3 | €1,276 | €1,233 | €1,320 |
| Louth | 9 | €1,296 | €1,258 | €1,325 |
| Mayo | 17 | €1,272 | €1,247 | €1,333 |
| Meath | 18 | €1,313 | €1,282 | €1,369 |
| Monaghan | 4 | €1,289 | €1,276 | €1,299 |
| Offaly | 5 | €1,262 | €1,232 | €1,281 |
| Roscommon | 8 | €1,254 | €1,225 | €1,278 |
| Sligo | 6 | €1,332 | €1,276 | €1,414 |
| Tipperary | 23 | €1,270 | €1,235 | €1,295 |
| Waterford | 7 | €1,283 | €1,262 | €1,315 |
| Westmeath | 8 | €1,241 | €1,192 | €1,272 |
| Wexford | 14 | €1,265 | €1,212 | €1,305 |
| Wicklow | 17 | €1,338 | €1,285 | €1,373 |
| All counties | 411 | €1,312 | €1,192 | €1,508 |

Leitrim, Longford and Laois have two or three homes each, so their averages move a lot with one home's price. A June 2026 national average of €1,301 (Leitrim €1,223, Dublin €1,407) came with the request for this brief. I could not trace it to an official source, so it is not used: the HSE list is the source.

**Public homes** (`hsePublicCostOfCare`, effective 1 September 2026) list about 114 units from €1,193 to €2,902 a week, a simple average of about €1,970. They are not a default (decision 4).

**The default fee** (decision 4): the county average above when the county is known, otherwise the national average, €1,312. A stated `weeklyFee` replaces either. The stress test always uses the national average, because the household profile holds no location.

Re-read both lists before the module ships, and each time the HSE publishes a new one. Keep each list's number and date, so the history can be set against the 4% growth rate (decision 3).

## Where the rules live

Three kinds of figure, kept in three places. **The engine reads all of them and holds no copy of any.**

1. **Fair Deal rules: a new rules catalogue,** `js/planning/care/fair_deal_rules_ie.js`, built like the tax catalogue (`js/planning/tax/rules_ie.js`). Data only. Blocks by effective date, each with a `ruleId`, `status` (`enacted` or `announced`), `verifiedOn` and its `sources` (the keys above, with their URLs and page dates). `FAIR_DEAL_RULES_VERSION` starts at `ie-fair-deal-2026.1`. A resolver, `resolveFairDealRules(date)`, returns the block in force on a date and holds the latest block for later dates, exactly as `resolveTaxRules` holds Budget figures. It holds: the income shares, the asset rates, the disregards and their order, the cap years, the personal allowance and spouse safeguards, the State Pension (Non-Contributory) reference rates by effective date, the rent rule, the five-year transfer rule, and the loan's terms (CPI, the two conflicting repayment periods with both sources). Never edit a past block: add a new one, bump the version, rerun the tests.
2. **Planning assumptions: a new `care` entry in `js/planning/planeir_assumptions.js`.**
   - **Fee growth is not a new figure.** It is the existing `inflation.educationRate` (4%), whose basis already names education and healthcare costs (decision 3). One value for both, so they always move together. Its basis wording is extended to say the rate is used for education **and care** planning, and a second record, `assumptionRecord('careFeeGrowth')` with key `careFeeGrowthRate`, reads the same value and basis so the care footnote names it for care. No separate care rate is added.
   - `agreedPrices`: the list number (230), its date (2026-09-04), the national average and the county averages above, `checkedOn: '2026-10-21'`, and the URL, for the audit trail. The `basis` says "the average of the HSE's maximum agreed prices for private and voluntary nursing homes in the county, or nationally when the county is not known" and names no home.
   - `relativeCare`: `defaultYears: 5` and `compareYears: [3, 10]` (decision 8), with a `basis` ("Care for a relative is shown over 5 years, with 3 and 10 years beside it. These are planning lengths, not a forecast of how long care lasts.").
   - `ownCareStress`: the central sizes of the "One of you needs care" entry in B1.5's stress registry, kept with the central assumptions as B1.5's stress sizes are. `startAge: 85`, `years: 5`, `approvedOn: '2026-10-21'`, sources `igeesNhss2019`, and a `basis`: "The stress test assumes care from age 85 to 90. This is deliberately longer than the average stay in the scheme, about 2.6 years for men and 3.4 years for women (IGEES, 2019), and half of residents are over 85. It is a prudent stress, not a forecast." In the same report, about a quarter of people leaving the scheme in 2017 had stayed more than four years.
   - The loan's CPI uses the existing `inflation.generalRate`. Money held in cash uses the existing `cash.instantAccessGrossRate` and DIRT from the tax catalogue.
   - Bump `PLANEIR_ASSUMPTIONS_VERSION`, add `assumptionRecord` keys and `ASSUMPTION_LABELS` entries (`careFeeGrowthRate`: "How fast nursing home fees rise (the education and healthcare cost rate)"; `careWeeklyFee`: "Nursing home fee a week"; `ownCareStressAge` and `ownCareStressYears`), update `scripts/fixtures/module-catalogue-authoring-identity.json` because the education basis wording moves, and extend `scripts/check-planeir-assumptions.mjs`.
3. **Tax relief: the shared tax engine**, `js/planning/tax/`. See "The tax engine change".

No figure is fetched from a website during a calculation. A saved result keeps the rules version, the assumptions version and the tax rules version it used, so a later update never silently rewrites an earlier illustration (the same rule as the Illness Benefit assumption in the plan document).

## The engine

Two parts and a shared core, so there is **one funding formula in the app, not two.**

- **The care builder** (`js/care_costs_math.js`, with the Fair Deal assessment in `js/planning/care/fair_deal.js`): from the person's facts and the case, works out, year by year, what is due for care and how much of it the person's own income and money pay. What is left is the family's share. It then asks the tax engine what relief the payer gets on that share.
- **The funding core** (in `js/future_cost_fund_math.js`, extended and exported for the care engine): takes the family's yearly amounts after relief and works out each way of meeting them at the central cash rate after DIRT, with every flow at the start of the year. It already does this for one dated cost. It needs three extensions, below.
- **The tax engine** works out the relief (see below).

### Extending the future cost fund

Its own payload contract stays as it is. These are internal seams:

1. **A cost that starts now.** `startsInYears` may be 0 when the core is called from the care builder. (Its payload range stays 1 to 40 until the future cost fund screen is changed on purpose.) With a start of 0, "save each year first" is not possible, so that way is not offered.
2. **A schedule of costs.** Instead of `annualCostToday` grown at one rate, the core accepts a list of yearly amounts, already in euros of the year they fall in. The care costs are not one rate: the home part stops after year three, and the person's own money changes what is left.
3. **Paying from the household's money each year.** A way with no fund: each year's amount is paid when it falls. The core reports it so the ledger can count it as money each year.

The course's "real rate" method needs no formula of its own. Paying a cost that rises with prices from a fund earning a cash rate, at the start of each year, gives exactly the present value at the real rate, (1 + cash rate) / (1 + inflation) minus 1, that the course uses. The core already models the nominal flows, and the golden check proves the two agree (see Tests).

### Inputs

`generated.careCostInputs`. Every amount is a whole euro a year unless it says a week. No rate, percentage, cap or disregard is accepted in the payload: a payload that carries one is refused with `generated.careCostInputs.<field> is not accepted. Fair Deal rules and rates are set centrally.`

The person cared for:

| Field | Type | Rule |
|---|---|---|
| `personLabel` | string, required | How they are named on screen, for example "Mam". 1 to 24 characters. |
| `age` | integer, required | 18 to 115. Sets the over-65 tax exemption and which State pension rate applies. |
| `county` | string, optional | One of the 26 counties. Picks the county average fee; without it, the national average (decision 4). A county name only, never an address or Eircode. |
| `weeklyFee` | number, optional | The real home's weekly price, which replaces either average. |
| `weeklyExtras` | number, optional | Extra charges not covered by Fair Deal. Default 0, and the footnote says extras are not included. |
| `couple` | object, optional | Present when the person is one of a couple and the partner stays at home: `{ partnerIncomes }`. Assets are then entered as the couple's combined assets. |
| `incomes` | array, required | `{ type, grossAnnual }` using the tax engine's income types (`statePension`, `occupationalPension`, `rentalProfit` and so on). Tax on them comes from the tax engine, never typed. |
| `otherDeductions` | number, optional | Fair Deal deductions the person pays (property tax, home loan interest, health expenses after refund). Default 0. |
| `cash` | number, required | Savings, deposits, shares and other cash assets, net. 0 or more. |
| `home` | object, optional | `{ value, borrowings }`. Absent if the person owns no home. |
| `homeRent` | object, optional | `{ annual, exemptionApplied }`. `exemptionApplied` defaults to true and the footnote says so. |
| `otherProperty` | array, optional | `{ label, value, borrowings, rentAnnual }`. Counted at 7.5% for as long as care lasts, rent counted at 80%. |
| `transferredInLastFiveYears` | object, optional | `{ cash, nonCash }`. Counted in the assessment though no longer the person's to spend. |
| `yearsInCareSoFar` | integer, optional | Default 0. For care already under way, so the 3-year cap counts from when it started. Only with `startsInYears` 0. |

The care and who pays:

| Field | Type | Rule |
|---|---|---|
| `startsInYears` | integer, required | 0 (now) to 40. |
| `durationYears` | integer, optional | 1 to 30, whole years. Default 5, from the central `care.relativeCare.defaultYears` (decision 8). |
| `compareDurations` | array, optional | Up to two other whole-year lengths shown beside the main one. Default 3 and 10, from `care.relativeCare.compareYears`. |
| `payer` | object, required | The household paying: `{ taxStatus, people: [{ id, age, incomes, retiresInYears, incomesAfterRetirement }] }`. Tax and relief come from the tax engine. `retiresInYears` is optional; when present, `incomesAfterRetirement` is required for that person. |
| `baseScenarioId` | string, optional | Must match a case. Default the first. |
| `scenarios` | array, required | 1 to 4 cases (`MAX_MODULE_SCENARIO_CASES`). |

Each case states **how**, never **how much**. The engine solves the amounts.

| Field | Type | Rule |
|---|---|---|
| `id` | string, required | Unique and stable. |
| `title` | string, optional | Button name, checked against the banned wording on the way in. Absent: derived. |
| `basis` | `'lower_of'`, `'fair_deal_with_loan'` or `'private_fee'`, optional | What is due each year. Default `lower_of`, "Fair Deal when it lowers the cost" (decision 14). |
| `personMoney` | `'first'`, `'alongside'` or `'kept'`, required | How the person's own savings are used (below). |
| `familyFunding` | `'each_year'`, `'lump_sum_now'` or `'save_then_pay'`, required | How the family meets its share. `save_then_pay` only when `startsInYears` is 1 or more. |

The three bases:

- `lower_of`: each year, the lower of the assessed Fair Deal contribution and the private fee, with extras on top of both.
- `fair_deal_with_loan`: the same, and in the years Fair Deal applies the home part is deferred through the loan. In a private year nothing is deferred.
- `private_fee`: the family chooses not to use the scheme. The fee every year.

There is no separate "Fair Deal always" basis. It would give exactly the figures `lower_of` gives, because the contribution can never exceed the fee.

The four sample cases, matching the course's options, all on `lower_of` unless named: Mam's money first, the family paying each year; Mam's money alongside the family's; a lump sum set aside now; and the home deferred through the loan (`fair_deal_with_loan`).

### The model, year by year

For each year of care `k` (0-based), at the start of the year:

1. **The fee.** `weeklyFee × 52`, grown from today at the central education and healthcare rate (4%), plus extras grown the same way. 52 weeks a year, stated in the assumptions.
2. **What is due.**
   - `private_fee`: the fee and extras.
   - `lower_of`: the lower of the assessed contribution (below) and the fee, plus extras. **Fair Deal applies** in a year where the contribution is below the fee: the person pays the contribution and the HSE pays the rest. In any other year the person pays the fee, the HSE pays nothing, and the year is marked "Fair Deal would not lower the cost this year".
   - `fair_deal_with_loan`: as `lower_of`, but in the years Fair Deal applies the home part is not due; it is added to the loan. In a private year the loan takes nothing.
3. **The Fair Deal contribution**, assessed afresh each year (decision 5) from the rules in force that year, whether or not Fair Deal applied the year before:
   - **Assessable income**: gross income less the tax the tax engine works out, less `otherDeductions`, plus rent that counts. For a couple, the combined figure, halved.
   - **Income part**: assessable income less the larger of 20% of it or 20% of the yearly maximum State Pension (Non-Contributory) (decision 9), never below zero. For a couple, also never so much that the partner at home is left with less than the larger of half the couple's income or that maximum rate.
   - **Assets**: the savings left at the end of the year before (in the first year of care, the savings then), other property net of borrowings, transferred assets, and the home net of borrowings while the person is in their first three years of care. Those years count from entering care, including `yearsInCareSoFar` and including any years paid privately, never from the year Fair Deal first applies. The home is valued once, when care starts, and held at that value for the three years, so the home part is exactly 7.5% of it a year and the cap is exactly 22.5%. Take off the disregard, cash first and then non-cash. Within non-cash, take it off other property before the home (an open item to confirm with the HSE; it changes only how the contribution is split between the parts, and so how much the loan can defer).
   - **Asset part**: 7.5% (3.75% for a couple) of what is left, split into the savings part, the other property part and the home part.
   - Income given away in the last five years is not modelled in the first release (see Out of scope).
4. **The person's own income** pays the income part in a Fair Deal year, or, in a private year, their income less the allowance of decision 6.
5. **The person's savings** pay what remains, as the case says:
   - `first`: savings pay all of what remains until they run out; then the family pays.
   - `alongside`: the savings are spread over the years of care as an amount rising with the fee, at the start of each year, at the central cash rate after DIRT, so they last exactly as long as the care (the course's "annuity stream"). The family pays the rest from year one, so its relief applies from year one. If a year's spread amount is more than what remains, the excess stays in the savings.
   - `kept`: savings are not spent. The family pays everything the person's income does not.
   - Savings left over earn the central cash rate after DIRT. Under Fair Deal, next year's savings part is assessed on what is left.
6. **The family's share** is what is still due. Never below zero.
7. **Relief** is the payer's fall in income tax from deducting the nursing home part of the family's share (not extras) that year, from the tax engine. Treated as reducing that year's cost, as the course does and as real-time claims allow. Shown separately so the figure before relief is never lost.
8. **The family's share after relief** goes to the funding core.

After the last year: the person's savings left, the loan (the deferred home parts, each grown with prices to the end of care, and also shown in today's money: decision 11), and the home's value less the loan.

**Care past the payer's retirement.** Each year's relief uses the incomes that apply to each paying person that year (`incomesAfterRetirement` from their own `retiresInYears`). When the year by which every paying person has retired falls inside the years of care, the engine splits the family's share into the years before it and the years after. That point matches B1.1, where nothing funds goals once every worker has retired. It reports the lump sum needed at retirement for the years after it, at the central cash rate after DIRT. This is the figure the plan layer adds to the retirement goal.

### Outputs

The same shape as the other engine modules: `assumptionsTable`, `outputsTable` (one row per case), `tables` (the year-by-year rows for each case), `charts` (one chart, for the video summary), `debug`.

- `debug.cases[]`: for each case, `rows[]` of `{ yearIndex, yearInCare, fairDealApplies, assessedContribution, fee, extras, due, incomePart, savingsPart, otherPropertyPart, homePart, deferredToLoan, hsePays, fromIncome, fromSavings, familyBeforeRelief, relief, familyAfterRelief, savingsAtStart, savingsAtEnd }`, and the totals: `fairDealYears` (the years Fair Deal applies), `familyTotalBeforeRelief`, `reliefTotal`, `familyTotalAfterRelief`, `homePartTotal` (never more than the cap), `homePartEndsAfterYear`, `savingsLastYears`, `loanAtEnd`, `loanTodaysMoney`, `estateHomeAfterLoanTodaysMoney`, `lumpSumNow`, `yearlyFromHousehold` (first year and a rising amount), `beforeRetirement` and `afterRetirement` splits, and `retirementCapitalNeeded`.
- `debug.compareDurations[]`: the selected case's headline figures at each comparison length.
- `debug.rulesUsed`: `FAIR_DEAL_RULES_VERSION` and every rule's `ruleId`, `PLANEIR_ASSUMPTIONS_VERSION`, `IE_TAX_RULES_VERSION`, the price list number and date, and whether a fee was the county average or stated.
- `summary` (stable, for the plan adapter): per case, **the shared dated-cost contract** that B1.5 (PR #88) is defining for college, the future cost fund and care alike (the yearly amounts, the lump sum now, the split before and after retirement, and the relief), plus what only care has: the years Fair Deal applies, the person's contribution split, the year the home part ends, how long the person's savings last, and the loan. The names used in this brief are placeholders; once #88 names the contract's fields, `summary` uses those names exactly and this brief is updated to match.
- `getCareCostCases(rawInputs)` and `getDefaultCareCostScenarioId(rawInputs)` for the presenter.

### Validation

Messages name the field and the case, in the existing style:

- `generated.careCostInputs.scenarios[2] (Lump sum now): save_then_pay needs care to start in a later year.`
- `generated.careCostInputs.county must be one of the 26 counties.`
- `generated.careCostInputs.scenarios[0] (Paid privately): basis must be "lower_of", "fair_deal_with_loan" or "private_fee".`
- `generated.careCostInputs.feeGrowthRate is not accepted. Fair Deal rules and rates are set centrally.`
- `generated.careCostInputs.payer.people[0].incomesAfterRetirement is required when retiresInYears is given.`
- Also: a fifth case, a duplicate id, an unknown key, `yearsInCareSoFar` with a later start, `fair_deal_with_loan` with no home, a `couple` with no partner incomes, and banned wording in a title or description.

### The tax engine change

Relief must be the payer's real top rate, never a flat 40%. The tax engine has no health expenses relief today (`js/planning/tax/engine.js` lists the income types it accepts, and `disclosures.js` names medical expenses among the reliefs not modelled).

- Add an item type `nursingHomeExpenses` (an amount paid in the year), allowed for any person. The income tax head takes it off total income before bands are applied. Following Revenue's description, it changes income tax only; USC and PRSI are charged on income before it and do not change. **Confirm this against the Health Expenses Tax and Duty Manual (Part 15-01-12) before building.**
- Relief cannot make tax negative. With no income tax to pay, the relief is zero, and the case shows that.
- Under joint assessment the payer's relief is on the couple's combined liability; record `basis: 'joint'` as the cash flow module does.
- Add the source to `IE_TAX_SOURCES`, bump `IE_TAX_RULES_VERSION`, remove medical expenses from the "not modelled" disclosure only for nursing home fees, and add tests: a standard-rate payer gets 20%; a payer just over the standard-rate band gets 40% on the part above it and 20% on the rest (the Revenue manual's own example shape); a payer under the exemption gets nothing; USC and PRSI do not change; the golden tax cases still pass unchanged.
- The care engine calls `computeTaxYear` twice per payer year (with and without the expense), from the same opening state, never carrying one alternative's state into another (the rule in the plan document).

The private course checks inject a flat 40% relief through the options argument (decision 15), as they inject the course's rates. It is never reachable from a payload, and nothing else uses it.

Later, not in this change: the over-65 DIRT exemption on the person's savings, and relief the person themselves can claim on their own contribution when they pay income tax.

## On screen

The picture waits for a design step. The rules it must keep:

- **Voice.** The client is "you". The person cared for is named by `personLabel`. No gendered pronouns. The HSE and Fair Deal are named; Fair Deal is a State scheme. **Never** "you should", "we recommend", "best", "ideal", "optimal", "better", "worse", "cheapest", a ranking of cases, or the name of any nursing home, provider, insurer or product. No long-term care insurance.
- **The answer is a description, never an instruction.** For example: "Under Fair Deal, Mam pays €40,530 in the first year and the HSE pays the rest." "Her home counts for three years only: €72,000 in total." "With Mam's savings used first, you pay nothing for the first two years." "Set aside today, €61,200 covers your share for all five years." (Figures illustrative.)
- **Tone.** Calm and factual. No alarm styling, no imagery of illness or old age.
- **Rounding.** Yearly amounts to the nearest €100 on screen, weekly amounts to the nearest euro, from unrounded values. A shown total is the rounded sum of unrounded years.
- **Private years.** A year where Fair Deal would not lower the cost says so in those words, "Fair Deal would not lower the cost this year", and shows the HSE paying nothing. Never "not eligible" or "refused".
- **The footnote**, from the model and never typed: the fee and where it came from ("the average of the HSE's agreed prices for private and voluntary homes in Co. Meath, list of 4 September 2026", or "nationally" when no county is given), that fees rise 4% a year (the rate used for education and healthcare costs), that a review of the Fair Deal assessment is assumed each year, the cash rate before and after DIRT, the State pension rate behind the safeguards, that extras are not included unless stated, that relief needs a nursing home with 24-hour on-site nursing care, that care at home is not shown, and the rules version.
- **Accessibility** as in the other modules: real buttons with `aria-pressed`, a chart with an `aria-label` that says the answer, 44px touch targets, contrast at 4.5:1, colour never alone.

## Questions about a relative's care

Asked **only** when the household has a `fund_care` goal, or the client mentions supporting a relative's care. Nothing is asked otherwise, and no question is compulsory to continue the rest of the plan. These are planning inputs for the plan pack and the adviser now; the consumer intake can add them later, with consumer activation still off.

| Question | Fact | Notes |
|---|---|---|
| Who is the care for? | `caredForPeople[].label`, `.relationship` | A first name or "Mam". |
| How old are they? | `.age` | |
| Has their care started? If so, how long ago? If not, roughly when might it start? | `.careStarted`, `.yearsInCareSoFar`, the goal's date | Sets `startsInYears` and the years already counted toward the three-year limit on the home. |
| What income do they have? | `.incomes[]` | Each source and its yearly amount before tax. |
| What savings do they have? | `.cash` | Savings, deposits, shares and any approved retirement fund. |
| Do they own a home? What is it worth, and is anything borrowed against it? | `.home.value`, `.home.borrowings` | |
| Are they one of a couple, with a partner still at home? If so, the partner's income. | `.couple.partnerIncomes` | Couple rules apply. |
| Which county is the nursing home likely to be in? (optional) | `.county` | Picks the county average fee. Without it, the national average. |
| Who in your household would pay? | `payer.people[]` | Their tax position comes from the household facts already held. |

**Never** ask for an address or an Eircode. The household profile deliberately holds no location, and the county is the only place-related fact here. It is kept in the relative's own block, never in the household profile.

Other module inputs (rent from the home, other property, transfers in the last five years, extras) stay available for the adviser to enter, but are not asked.

## One of you needs care: the stress test

The client's own later-life care, shown as a stress test. It needs no new questions: it uses the household facts the plan already holds. It is built with B1.5's later-life stories, because it runs on their projection.

**What is run.** For each person in the household in turn, one run: that person goes into nursing home care from age 85 to 90 (the central `care.ownCareStress`, decision 1), while the other person, if there is one, stays at home. A person already 85 or older starts now and still runs five years. A one-person household has one run. Two people in care at once is not run.

**Why 85 to 90.** It is deliberately longer than the average stay: about 2.6 years for men and 3.4 for women in the IGEES review of the scheme (2019), where half of residents are over 85. It is a prudent stress, not a forecast, and the assumptions table says so in those words.

**The rules applied.**

- Basis `lower_of`: in each year, the lower of the assessed contribution and the private fee. A wealthy household may pay privately in the first years and use Fair Deal once the home stops counting.
- The fee: the national average (€1,312 a week; the profile holds no county), grown at 4% from today. No extras.
- With a partner at home, couple rules: 40% of combined assessable income, 3.75% of combined assets above €72,000, the home at 3.75% for three years (at most 11.25%), and the partner at home keeps the larger of half the couple's income or the maximum State Pension (Non-Contributory). Otherwise, single rules.
- Income: the household's income that year from B1.5's projection through retirement. It is already after tax, so it is the assessable income. It includes ARF drawdowns.
- Assets: the projection's savings and retirement funds at the end of the year before, counted each year. Approved retirement funds count as cash assets under Fair Deal (`ciFairDeal`), so pension funds are assessed. The home is the household's main home, net of any mortgage, holding its value against prices (decision 11). Other property from the balance sheet counts for as long as care lasts.
- **Pension money is never counted twice.** An ARF counted as an asset and its drawdown counted as income could charge the same euro twice: 7.5% of the fund, and 80% of the money drawn from it. The build follows whatever the HSE confirms (open item 7) and asserts, in a test, that no euro is counted both ways in one year. The stress test is built to that answer, so the question goes to the HSE before its build starts.
- The home's part: deferred through the Nursing Home Loan in every year Fair Deal applies (decision 16).
- Tax relief on the household's own care costs: not counted (decision 17). Every stress row carries the review item "Tax relief on nursing home fees may lower this cost".

**Through B1.5's projection, not a module of its own.** B1.5 (PR #88) runs one projection of the household through retirement to age 100, for each investment version it runs, and every later-life stress applies its changes to that same projection. Care does the same: the care engine supplies a **yearly extra outgoing** (the contribution or the fee, less any part deferred to the loan), and the projection meets it from income first and then from savings and retirement funds, year by year. The household's usual spending is not reduced, which is prudent: a partner at home still runs the home, and a single person's home costs largely continue. The Fair Deal assessment each year reads that year's income and the funds left at the end of the year before from the same projection, so the two never drift apart. The care engine adds no hook to `js/net_retirement_math.js` and runs no retirement projection of its own.

**In the stress registry.** "One of you needs care" is an entry in B1.5's stress registry, beside the other stresses, with its central sizes: start age 85 and 5 years (the `care.ownCareStress` record, dated and sourced). The registry runs it once for each person in the household, and the fee stress ("costs rise faster", 2 points higher) applies to care through the same registry.

**What it reports**, for each person's run:

- how many years the household's savings last, and the year they run out, if they do;
- what the partner at home is left with each year after the contribution, beside the household's planned spending;
- whether money runs out before 100, the end of B1.5's projection, and in which year;
- any loan against the estate, in today's money;
- the years Fair Deal applies, and the contribution split into income, savings and home.

It is a stress test: **never a goal, and it takes no money in the resource ledger.**

## The plan layer

How this module feeds the resource ledger (B1, `js/planning/plan_pack/resource_ledger.js`), the freed cash and retirement rules (B1.1, PR #87) and the storyteller (B1.5, PR #88). **This is the plan adapter's work (B2), not the module's first build.** It is set out here so the engine's `summary` carries what the plan needs.

Care plugs into three shared pieces PR #88 is adding, and builds none of its own: **one dated-cost contract** that college, the future cost fund and care all hand to the ledger; **one projection through retirement to age 100** that every later-life stress changes; and **one stress registry** with central sizes. #88 has not named their fields yet. The names below are placeholders, and this section and `summary` change to #88's names when it sets them.

### A goal for care

- Add a goal type `fund_care` to `js/planning/goal_catalogue.js`, with who it is for, the start, the number of years and the basis of the yearly cost. Adviser-only: **no consumer route, no manifest entry, consumer activation off.** Today the nearest fit is `assess_decision` with a `dated_cost` funding fact, which cannot hold any of the Fair Deal facts. This goal, or a mention of supporting a relative's care, is what triggers the questions above.
- **The person cared for is not in the household's net worth**, unless the client is that person. Their facts sit in their own block in the plan pack (`planningInputs.caredForPeople[]`), referenced by the goal. Their savings and home never become household resources, and the ledger never spends them on any other goal ("never double count").

### In the resource ledger

- Care hands the ledger the **shared dated-cost contract**, the same shape college and the future cost fund hand it, so the ledger has one way to read every dated cost.
- Care enters as a dated cost in **start-date order**, like college. A care need starting now (`startsInYears` 0) comes first among dated costs, before the mortgage and retirement. The plan's goal order already lists care for a parent among the dated costs.
- Its two ways of funding, never added together: **money now** is the module's `lumpSumNow`; **money each year** is the family's yearly amounts after relief (they change from year to year, because the home part stops and the person's savings run down). The ledger's `needs` array takes those amounts year by year rather than one repeated figure.
- **Care past the payer's retirement.** B1.1 stops each person's share of the surplus at their retirement. The years of care after retirement therefore move from money each year into the retirement goal, as extra capital needed at retirement (`retirementCapitalNeeded`), and the ledger prints them under retirement as "care after retirement". Without this, those years would show as unfunded with no explanation.

### In the other modules

- **Household cash flow**: a care outgoing in the years it is paid each year, and the payer's tax line reflects the relief through the tax engine's new expense item. One place calculates the relief.
- **Protection gap**: `needed` includes the care payment in the years it is paid.
- **Balance sheet**: when the person cared for is in the household, a Fair Deal loan is a liability secured on the home, growing with prices. When they are not, it is a note only.

### Story facts for the storyteller

Placeholders, so narration never types a figure. To be added to B1.5's registry when it is built (PR #88 is not edited by this change):

| Placeholder | Meaning |
|---|---|
| `{care.<goalId>.yearlyBeforeRelief}`, `.yearlyAfterRelief` | The family's cost in the first year, before and after relief |
| `{care.<goalId>.reliefYearly}`, `.reliefClaimedBy` | The relief and the person who claims it |
| `{care.<goalId>.contributionIncome}`, `.contributionSavings`, `.contributionHome` | The person's contribution, split |
| `{care.<goalId>.homePartEndsYear}` | The calendar year the home part stops |
| `{care.<goalId>.savingsLastYears}` | How many years the person's own savings last |
| `{care.<goalId>.lumpSumNow}` | The lump sum that would meet the family's share today |
| `{care.<goalId>.afterRetirementCapital}` | Extra retirement capital if care runs past the payer's retirement |
| `{care.<goalId>.loanTodaysMoney}` | The loan repaid from the estate, in today's money |
| `{care.<goalId>.fairDealYears}` | The years Fair Deal applies |

**Risks for a relative's care**, each a code fact from a stress run of the same engine: care lasting longer (the 10-year comparison), fees rising faster (B1.5's dated-cost stress of 2 points, so care at 6%), the rules or the relief changing (shown as the rules version and its date, never a guess at a future rule), and the loan reducing the estate.

**A new risk row: "One of you needs care".** An entry in B1.5's stress registry (decision 18), with the central sizes 85 and 5 years, run once for each person on B1.5's projection through retirement. Its row in the risk list shows, for each person, how long savings last, what the partner at home is left with, whether money runs out before 100, and any loan against the estate in today's money. It also feeds what is left at 100 in the later-life stories. The B1.5 brief (PR #88) gains the row when the care engine exists; this branch does not edit #88.

**Review items**, as plain statements with no figures, in B1.5's `check_next`. They never change a figure:

- For every route with a care goal or the stress row: the non-financial reasons a family may choose not to use Fair Deal (a charge on the home, wanting a home priced above its agreed price, the waiting list, the five-year look-back on gifts).
- For every stress row: "Tax relief on nursing home fees may lower this cost" (decision 17).

## Wiring

Follow "Wiring a new engine module" in `docs/future-cost-fund-app-change.md`, row by row, each step with its own check green and its own commit. Rows 1 and 2 (central assumptions, the tax engine) come first. A new row 1b is the Fair Deal rules catalogue. Copy the pattern; do not build a shared registry. **Do not edit `docs/prompt-pack/`**; its playbook is written from the contract summary once the module lands.

## Tests

Two kinds of fixture: public ones, written into the tests, and the course cases, kept private.

**Public fixtures, each proved against a reference calculator** in `scripts/check-care-costs.mjs` that imports nothing from the engine or the rules catalogue's resolver and rebuilds each case year by year from first principles:

1. **The sample above, whose contribution never reaches the fee:** every figure in the year-one table, Fair Deal in every year, and the cap (€72,000 over three years, nothing on the home from year four).
2. **A wealthy single person who pays privately in years 1 to 3 and uses Fair Deal from year 4.** Single, 85, the national average fee, a State pension of €16,000 and an occupational pension of €20,000 a year, savings of €500,000 and a home worth €900,000. In years 1 to 3 the home alone adds €67,500 a year to the assessed contribution, which is well above the fee, so each of those years is private and marked "Fair Deal would not lower the cost this year". From year 4 the home no longer counts, because the three years count from entering care, and the contribution falls well below the fee, so Fair Deal applies. This holds for every `personMoney` setting. **The test that matters:** an engine that counted the three years from the first Fair Deal year would put the home back in year 4 and keep the person private; the test asserts no home part in year 4 or later.
3. **Applying after three years in care:** `yearsInCareSoFar` 3, so nothing is paid on the home in any year.
4. `yearsInCareSoFar` 2: one year of the home part left.
5. A couple with the partner at home, including a low-income couple where the partner's safeguard bites.
6. Income below the State pension, so 20% of the State pension rate sets the allowance.
7. Transferred assets counted though not spendable.
8. Each `personMoney` setting, showing that "alongside" keeps relief from year one and the savings last exactly the length of care.
9. The loan: the deferred home parts, grown with prices, in nominal terms and in today's money, and nothing deferred in a private year.
10. Care past the payer's retirement.
11. Relief: a standard-rate payer, a payer straddling the bands, a payer with no income tax.
12. The default lengths: no `durationYears` gives 5 years with 3 and 10 beside it; no county gives the national average.
13. **The stress test**, run through B1.5's projection and stress registry: a one-person household; a couple, run once for each person, with the partner's safeguard binding in a low-income case; a household whose savings run out before 100, reporting the year; a person already over 85, starting now; the loan in today's money, with the home part deferred only in Fair Deal years; an ARF in drawdown, proving no euro is counted both as an asset and as income in the same year, under the rule the HSE confirms; the review items present on every stress row; and the projection's own figures unchanged when the care entry is not applied.

**Invariants over every case:** under `lower_of`, what is due is never more than the private fee plus extras in any year; the home part never exceeds the cap and appears only in the first three years from entering care; nothing is due after the last year; due equals HSE share plus contribution plus extras under Fair Deal; family share plus person's income plus savings used equals what is due; savings never go below zero; the lump sum funds every later year to within €0.01; relief never exceeds the tax the payer would otherwise pay.

**Rule sources.** With nothing injected, every rate comes from the catalogue or the central assumptions. Change one rule in a test catalogue and the result follows, which proves the engine holds no copy. Dates either side of 1 January 2027 pick the right State pension rate.

**The course cases, private.** The Doyle and Shannon cases are rebuilt through the engine with the course's own rates and a flat 40% relief (decision 15), all injected through the options argument and never reachable from a payload: the course's deposit rates, DIRT treatment and 2% inflation, every flow at the start of the year, the private-fee basis and no personal allowance (decision 6). Their expected figures live in `private/cfp-cases/`, and `npm run check:golden-plans` runs them when the folder is present and reports "not present" otherwise, as the plan story brief proposes. Two known differences, found on 21 October 2026 and written in the private case file as the plan story brief requires:

- **Rounding.** In one case the lump sum reproduces only when the course's own rounded yearly cost is fed in; from unrounded values the engine is €11 higher. Every other figure in that case reproduces to the euro.
- **A part year.** The other case uses a life expectancy with a half year in it, from tables. Its figure reproduces exactly at that part year, but the first release uses whole years only, so the engine gives the figures for the whole years either side. Recorded, not chased with another rate.

The private case file exists on Gerry's Mac only, excluded from git by a local setting. `private/cfp-cases/` is not yet in `.gitignore` on `main`; add it when the golden checks are built (B1.5), before any course file is placed in another checkout.

**Words.** Render every case and scan the visible text and `aria-label`s for the banned phrases, any provider or product name, "p.a.", and any amount without a thousands separator.

Before finishing: `npm run build`, `check:care-costs`, `check:future-cost-fund` (unchanged results for its own payloads), `check:planeir-assumptions`, the Irish tax suites, `check:video-scene`, `check:codex-video-brief`, `check:consumer-session-payload`, `check:no-stale-exports`.

## Out of scope for the first release

- **Care at home** (decision 2): HSE home support (free and not means-tested, with hours set each year in the Budget), the Health (Amendment) (Home Support Providers) Bill 2025, which Citizens Information says was passed in June 2026 and is not yet enacted, relief for employing a carer, Carer's Allowance and the Home Carer Tax Credit.
- **The farm and business cap**, which needs a family successor's six-year commitment.
- **Selling the home during care.** The proceeds fall under the cap, but the engine does not model a sale in the first release.
- **Both partners in care at once**, in the module or the stress test.
- **Income given away in the last five years.**
- **Capital acquisitions tax** on gifts or on the estate, and the course's point that a gift from parent to child "so the child gets the relief" is complicated by the five-year rule. The module shows the rule; it does not model the gift.
- **The over-65 DIRT exemption** and the person's own relief on their contribution (later tax engine changes).
- **The funding waiting list**, Transitional Care Funding, respite and short stays.
- **Long-term care insurance.** Never.
- **Part years of care**, and life expectancy tables as an extra comparison (decision 8).
- Consumer routing, voice, planner facts, manifest, playbook and goal catalogue routing.

## Open items to confirm at build

These are checks, not decisions for Gerry.

1. **The couple formula.** The income part for one of a couple with the partner at home is read from the HSE and Citizens Information wording. Confirm it against Schedule 1 of the Nursing Homes Support Scheme Act 2009, as amended, before building.
2. **USC and PRSI** are unchanged by nursing home relief. Confirm in the Health Expenses Tax and Duty Manual.
3. **The disregard within non-cash assets.** Confirm with the HSE whether the part of the disregard left after cash comes off the home or other property first.
4. **The State pension rate from January 2027**: confirm its commencement date and which age band the safeguard uses.
5. **The loan repayment period** after death: 12 months (Revenue, 2023) or 18 months (HSE). Decision 10 keeps it off the screen until this is settled.
6. **The home's value.** Confirm with the HSE that the home is valued at the first assessment and not revalued at each yearly review, which is how the brief applies the 22.5% cap.
7. **An approved retirement fund (ARF).** Citizens Information lists ARFs among cash assets, at the "value of fund at date of application". Confirm with the HSE and Citizens Information how an ARF is assessed after that: at its value at application only, or revalued at each review. Confirm also whether ARF drawdowns count as income as well. The stress test counts the fund as a cash asset each year and takes income, including drawdowns, from B1.5's projection, so the build follows the confirmed rule and never counts the same money twice.
8. **The shared contracts' names.** Once PR #88 names the dated-cost contract, the projection and the stress registry, rename this brief's placeholders in the plan-layer section and `summary` to match.

## When you finish

End with a contract summary for the prompt pack: field names, the year-by-year model, where every rule and rate comes from, the rounding rules, every validation string and the Dev Panel example. Keep to the repo's commit style: short, plain-English commits describing what the client sees change.
