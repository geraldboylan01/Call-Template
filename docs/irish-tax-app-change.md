# Irish tax engine: the foundation for cashflow modelling

App change brief for Claude Code. Paste this whole file as the prompt.
Version 4, 22 September 2026. Replaces versions 1 to 3. Suggested repo path: `docs/irish-tax-app-change.md`.

Part A is the build for this change. Part B is design only: read it so nothing in Part A blocks it, but do not build it.

## 0. What changed since version 1

- The engine is now the foundation for a dedicated cashflow modelling module. The retirement module is its first consumer, not its home (section 3).
- The SFT follows its legislated steps to €2.8m in 2029 and is then held there. The law raises it with average weekly earnings from 2030 and it can never fall, but future earnings growth cannot be known, so the engine does not forecast it and says so wherever a later-year SFT is used (4.8, 8.2). Versions 2 and 3 projected it with an earnings growth assumption; that is withdrawn, along with version 3's margin flag.
- The projection policy separates parameters each Budget sets, which are frozen, from changes the law has already fixed by date and amount, which are applied (section 5).
- Reliefs with qualifying conditions are asserted in the input, never inferred (decision 7).
- Uncertain figures are treated cautiously and stated plainly (decision 9).
- Part B specifies the next tax heads (investment income and gains, CGT, CAT, ARF on death) so that today's interfaces and state can carry them.

# Part A: build now

## 1. Why

Planéir is working towards a cashflow modelling module that projects a household's income, spending, assets and tax year by year, far into the future. Nearly every figure in it depends on Irish tax, and the app has none today. The retirement module (`js/pension_math.js`, playbook `11_retirement_playbook.md`) works only in gross figures: it cannot show net income, what a retirement lump sum is worth after tax, what breaching the Standard Fund Threshold (SFT) costs, or what a pension contribution really costs after relief.

Build the tax engine once, as a standalone deterministic library with a dated rules catalogue. Prove it on the retirement module, and shape it so the cashflow module can use it unchanged.

## 2. Decisions already made

These are settled. If one blocks you, stop and say so instead of working around it.

1. **Deterministic code only.** No model-generated arithmetic anywhere in this path.
2. **Projection policy** (section 5). Parameters that each Budget sets are frozen at their latest enacted values and never indexed, because Budgets often leave them unchanged (Budget 2026 did). Changes already legislated with fixed dates and amounts are applied. Where the law ties a future figure to data that does not exist yet, as it does for the SFT from 2030, the engine holds the last known value and says so.
3. **Sources.** Values come from Revenue guidance and legislation (4.10), never from third-party calculators. The PwC, Deloitte and KPMG calculators are references for stating assumptions and for manual spot checks only. No scraping and no network calls.
4. **Assumptions travel with the numbers.** Disclosures are generated from the rules actually applied, plus a standing list of what is not modelled (section 8).
5. **One implementation.** JS for the app, exposed through a Node CLI so Python scripts such as `bridge_model.py` call it instead of reimplementing tax.
6. **Education framing.** Figures are estimates. Nothing says "you will pay" or recommends an action.
7. **Reliefs are asserted, never inferred.** Where a relief depends on facts the engine cannot check (principal private residence, Retirement Relief, Business or Agricultural Relief, the dwelling house exemption), the input carries an explicit claim that the conditions are met, and the output discloses that this was assumed. The engine never decides eligibility from other facts.
8. **One place for tax.** The retirement module, the future cashflow module, Reports and scripts all call this engine. No module calculates tax itself.
9. **Lean cautious and state only what is known.** Where a future figure cannot be known, hold the last known value instead of forecasting it, provided that errs against the client, and say plainly that the real figure will differ. Where an assumption is unavoidable, use the cautious end of a documented, reputable range, record its source and disclose it. Planéir would rather tell someone they may fall short than tell them they are fine when they are not.

## 3. Architecture

### 3.1 Layout

```
js/planning/tax/
  rules_ie.js        dated catalogue and legislated schedules (data only)
  resolve.js         resolveTaxRules(year)
  engine.js          computeTaxYear, marginalTax, solveForNet
  heads/             one module per tax head
    income_tax.js  usc.js  prsi.js  lump_sum.js  sft.js  arf_imputed.js
  disclosures.js     disclosure code to client text
scripts/ie-tax.mjs   CLI over the same functions
js/tests_ie_tax.js   golden cases
```

Each head exports `{ id, phase, compute(context) }` and returns line items tagged with rule ids, plus disclosure codes. The engine runs the heads in a fixed order (pension events first, then income tax, USC and PRSI) and assembles the totals. Follow the catalogue style of `js/planning/ireland_rules.js` (rule ids, effective dates, source objects). Keep `IRISH_ARF_MINIMUM_DRAWDOWN` in `ireland_rules.js`, corrected per 4.9, and import it. Move the SFT values out of `computeSft` in `pension_math.js` into `rules_ie.js`, keeping `computeSft` exported as a thin wrapper so existing imports still work.

### 3.2 Input: one household tax year

```json
{
  "year": 2026,
  "status": "married_or_civil_partners",
  "people": [
    { "id": "mary", "age": 67, "birthYear": 1959, "receivingStatePensionContributory": true },
    { "id": "john", "age": 69, "birthYear": 1957, "receivingStatePensionContributory": true }
  ],
  "items": [
    { "personId": "mary", "type": "statePension", "amount": 15563.6 },
    { "personId": "mary", "type": "arfDistribution", "amount": 30000 },
    { "personId": "john", "type": "occupationalPension", "amount": 22000 },
    { "personId": "joint", "type": "rentalProfit", "amount": 12000 }
  ],
  "events": [
    { "type": "benefitCrystallisation", "personId": "john", "fundValue": 900000, "lumpSum": 225000 }
  ]
}
```

- `status` is `single`, `married_or_civil_partners` or `widowed_or_surviving_civil_partner`. With `single` and two people, assess each separately. With `married_or_civil_partners` and one person, treat the spouse as having no income.
- Phase 1 item types: `statePension`, `occupationalPension`, `arfDistribution`, `employment`, `employmentPensionContribution`, `rentalProfit`. The engine creates `lumpSumScheduleE` itself from a crystallisation event.
- Phase 1 event type: `benefitCrystallisation`.
- `personId: "joint"` splits an item equally between the two people.
- Part B types (`depositInterest`, `fundDisposal`, `fundDeemedDisposal`, `fundDistribution`, `shareDisposal`, `dividend`, `propertyDisposal`, `giftMade`, `giftReceived`, `inheritanceReceived`, `death`) must be rejected with an error saying they are not supported yet. Never return an untaxed result for them.

### 3.3 State carried between years

Lifetime limits and carry-forwards live in an explicit, serialisable state object:

```json
{ "people": { "john": { "lumpSumsSince2005": 0, "sftUsed": 0, "unrelievedLumpSumTax": 0 } } }
```

`computeTaxYear({ state, input, assumptions })` returns `{ result, nextState }` and never mutates its arguments. Reserve, but do not use yet, these per-person keys for Part B: `cgtLossesCarriedForward`, `revisedEntrepreneurReliefUsed`, `catReceivedByGroup` (A, B and C, since 5 December 1991) and `fundLots` (cost, value and deemed-disposal dates per holding).

### 3.4 Functions the cashflow module will rely on

- `computeTaxYear`, as above.
- `marginalTax({ state, input, delta })`: the extra tax, by head, from adding one item (for example €10,000 more ARF withdrawal for Mary). The cashflow module will use it to decide which pot to draw from first, so it must equal the difference between two full calculations to the cent.
- `solveForNet({ state, input, adjustable, targetNet })`: finds the amount that brings household net income to a target, within €1. `adjustable` is a function from one amount to the items it produces, so callers keep control of how the amount is split. The retirement engine's net mode (7.4) is its first user.
- Every result carries `rulesVersion`, `rulesYear`, `heldForward`, `assumptionsVersion` and the disclosure codes applied.

Performance: a 60-year household projection with a solver in every year should run in under 300 ms in Node. Report timings.

## 4. Phase 1 rules (tax year 2026)

Verified 22 September 2026 against the sources in 4.10. Transcribe exactly and take no value from anywhere else.

### 4.1 Conventions

- **Age** means age attained during the tax year, as `ageAtYear` already computes. A rule that starts at an age applies for the whole year in which that age is reached. The exception is where the statute tests age "for the whole of the year" (ARF imputed distributions, 4.9): there the attained age must be one higher.
- **Part-year rate changes** use one blended annual rate weighted by months in force, assuming income arrives evenly through the year. This is how PwC's calculator treats the October PRSI increases.
- **Rounding** happens only for display, to the nearest euro. Calculations stay unrounded and golden tests compare to the cent.

### 4.2 Income tax

| Item | 2026 |
|---|---|
| Rates | 20% standard, 40% higher |
| Standard rate band, single | €44,000 |
| Standard rate band, widowed or surviving civil partner without qualifying children | €44,000 |
| Standard rate band, married or civil partners, one income | €53,000 |
| Increase for a second income | Up to €35,000, capped at the lower earner's income and usable only against that income |
| Personal credit | €2,000 single, €4,000 married, €2,540 widowed without dependent children |
| Employee (PAYE) credit | €2,000 per person with qualifying income, limited to 20% of that person's qualifying income |
| Age credit | €245 single or widowed, €490 married, where the person (or either spouse) reaches 65 in the year |

Qualifying income for the employee credit: the State Pension and other Social Protection income, occupational and DB pensions and annuities, ARF distributions (Schedule E emoluments under PAYE by s.784A TCA), employment income, and the Schedule E part of a lump sum. Rental profit does not qualify.

For a jointly assessed couple, compute one liability on total income with a band of €53,000 plus min(€35,000, the lower earner's total income) when both have income. Because the increase can never exceed the lower earner's income, this gives the same result as Revenue's allocation. Credits are €4,000 personal, each spouse's employee credit, and €490 age credit if either spouse reaches 65. Where two people are assessed as single, each is a separate assessment.

### 4.3 Over-65 exemption and marginal relief

Where the person (or either spouse) reaches 65 in the year:

- Total income at or below €18,000 (single or widowed) or €36,000 (married): no income tax.
- Total income above the limit but not above twice it: tax is the lower of normal tax and 40% of the income above the limit.

Total income here includes the State Pension and the Schedule E part of a lump sum, but not the part of a lump sum taxed at 20% (ring-fenced, 4.7). The limit increases for dependent children are not modelled.

### 4.4 USC (per person)

| Item | 2026 |
|---|---|
| Exempt | Aggregate income of €13,000 or less |
| Standard rates | 0.5% to €12,012, 2% to €28,700, 3% to €70,044, 8% above |
| Reduced rates | 0.5% to €12,012 and 2% above, from the year the person reaches 70, while aggregate income is €60,000 or less |
| Surcharge | An extra 3% on non-PAYE income (in Phase 1, rental profit) above €100,000 |

Aggregate income excludes the State Pension and other Social Protection payments, both for the charge itself and for the €13,000 and €60,000 tests. The medical card concession is not modelled.

### 4.5 PRSI (per person)

Rates, applied by date and blended within a year (4.1):

| Change date | New rate | Blended annual rate |
|---|---|---|
| 1 Oct 2025 | 4.2% | 2026: 4.2375% |
| 1 Oct 2026 | 4.35% | 2027: 4.3875% |
| 1 Oct 2027 | 4.5% | 2028: 4.55% |
| 1 Oct 2028 | 4.7% | 2029 onward: 4.7% |

Liability, on ARF withdrawals, rental profit and earnings only:

- Under 66: liable.
- 66 to 69: liable unless the person is receiving the State Pension (Contributory) or reached 66 before 1 January 2024 (born before 1958).
- 70 or over: not liable.
- Never on the State Pension, occupational or DB pensions, or annuities.

Not modelled: Class K, minimum contributions, the PRSI credit for low earners and weekly thresholds.

### 4.6 Treatment by income type

| Item type | Income tax | USC | PRSI | Employee credit |
|---|---|---|---|---|
| `statePension` | Yes | No | No | Yes |
| `occupationalPension` (DB, annuity, other PAYE pension) | Yes | Yes | No | Yes |
| `arfDistribution` (includes vested PRSA) | Yes | Yes | Per 4.5 | Yes |
| `employment` | Yes, after `employmentPensionContribution` | Yes, on the full salary | Per 4.5, on the full salary | Yes |
| `rentalProfit` | Yes | Yes, and counts for the surcharge | Per 4.5 | No |
| `lumpSumScheduleE` (lump sum above a cumulative €500,000) | Yes, at the marginal rate | Yes | No (assumption, see 12) | Yes |

### 4.7 Retirement lump sums

- Lifetime tax-free limit: €200,000 across all retirement lump sums paid since 7 December 2005.
- The next slice, up to a cumulative €500,000, is taxed at 20%. Since 1 January 2025 this "standard chargeable amount" has been a fixed €500,000 less the tax-free €200,000; it was previously 25% of the SFT. It is ring-fenced: no credits or reliefs apply, and it is not part of total income.
- Any amount above a cumulative €500,000 is Schedule E income for that year, taxed at the marginal rate with USC. The engine adds it to the person's income for that year (4.6) rather than applying a flat 40%.
- Earlier lump sums use up the tax-free and 20% slices first.

Revenue's worked example (Pensions Manual Chapter 27, Example 4) is golden case G6.

### 4.8 SFT, chargeable excess tax and the lump sum credit

**Threshold** (s.787O TCA as amended by Finance Act 2024):

| Year | What the law says | What the engine uses |
|---|---|---|
| 2026 to 2029 | €2.2m, €2.4m, €2.6m and €2.8m, fixed in law | Those amounts |
| 2030 | The higher of €2.8m and €2.8m scaled by the growth in CSO average weekly earnings from Q1 2025 to Q3 2029 | €2.8m, held |
| 2031 onward | The higher of the previous year's SFT and that SFT scaled by the year's Q3-to-Q3 growth in average weekly earnings | The last known figure, held |

- Future earnings growth cannot be known, so the engine does not project the formula and holds no earnings assumption. From 2030 it holds the threshold at the last known value: €2.8m until Revenue publishes a figure, then that figure.
- Because the law says the threshold can never fall, the last known value is its lowest possible level. Holding it therefore never understates CET, and any CET shown for a crystallisation in 2030 or later may be overstated. Disclose this every time (`SFT_HELD`, 8.2).
- Record each officially published SFT as a fixed amount. It applies to its own year and is held for later years until the next one is published.

**When it is tested.** The SFT is per person and is tested at each benefit crystallisation event (BCE). In the retirement module the BCE is a member's retirement (lump sum plus transfer of the rest to drawdown), tested at the SFT for that member's own retirement year. The current engine tests every member at `requiredPotReferenceYear`; fix that.

**Charge.**

- Chargeable excess = max(0, SFT already used + fund value crystallised - SFT).
- CET = chargeable excess × the higher rate of income tax for that year (40%). CET is ring-fenced: no reliefs, allowances or deductions.
- Credit (s.787RA TCA): the 20% tax deducted from the lump sum (4.7), plus any 20% lump sum tax on earlier lump sums since 2011 not yet used this way, is set against CET. Tax on the Schedule E part of a lump sum is never creditable. The credit cannot exceed the CET, and any unused credit carries forward to later BCEs. With the full €300,000 slice used, the credit is €60,000.
- The administrator pays the net CET out of the fund, so the drawdown fund is fund - lump sum - net CET. An ARF distribution used to reimburse CET is not taxed as income (s.784A(3A)).

### 4.9 ARF imputed distributions (correction)

`IRISH_ARF_MINIMUM_DRAWDOWN` currently applies 4% from retirement at any age and 5% from attained age 70. The statute applies only where the holder is 60 or over for the whole of the tax year, and uses 5% where they are 70 or over for the whole year. Correct it to:

- attained age 60 or under: no imputed distribution;
- attained 61 to 70: 4%;
- attained 71 or over: 5%;
- fund above €2m and attained 61 or over: 6%.

Keep modelling the imputed amount as withdrawn and valuing it on the opening balance (Revenue values the fund at 30 November; disclosed). Update the assumptions row text to match.

### 4.10 Sources

- Revenue, tax rates, bands and reliefs: https://www.revenue.ie/en/personal-tax-credits-reliefs-and-exemptions/tax-relief-charts/index.aspx
- Revenue, Employee Tax Credit: https://www.revenue.ie/en/personal-tax-credits-reliefs-and-exemptions/income-and-employment/employee-tax-credit/index.aspx
- Revenue, age exemption and marginal relief (TDM Part 07-01-18): https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-07/07-01-18.pdf
- Revenue, USC: https://www.revenue.ie/en/jobs-and-pensions/usc/index.aspx and reduced rates: https://www.revenue.ie/en/jobs-and-pensions/usc/reduced-rates.aspx
- Note for Guidance on s.531AN (2026 USC bands): https://www.charteredaccountants.ie/taxsourcetotal/1997/en/act/pub/0039/nfg/sec0531AN-nfg.html
- Revenue, PRSI and USC for older persons: https://www.revenue.ie/en/life-events-and-personal-circumstances/older-persons/prsi-usc.aspx
- gov.ie, changes to PRSI from 2024: https://www.gov.ie/en/publication/70400-changes-to-pay-related-social-insurance-prsi
- S.I. No. 534 of 2024 (PRSI increases 2024 to 2028, with the Social Welfare (Miscellaneous Provisions) Act 2024): https://www.irishstatutebook.ie/eli/2024/si/534/made/en/pdf
- Oireachtas answer on Class S PRSI on ARF distributions: https://www.oireachtas.ie/en/debates/question/2018-11-21/241/
- Note for Guidance on s.784A (ARF distributions as emoluments): https://www.charteredaccountants.ie/taxsource/1997/en/act/pub/0039/nfg/sec0784A-nfg.html
- Revenue, taxation of retirement lump sums: https://www.revenue.ie/en/jobs-and-pensions/pension/private/retirement-lump-sums.aspx
- Revenue Pensions Manual Chapter 27 (lump sums and the CET credit): https://www.revenue.ie/en/tax-professionals/tdm/pensions/chapter-27.pdf
- Revenue, chargeable excess tax and the SFT schedule: https://www.revenue.ie/en/jobs-and-pensions/pension/private/chargeable-excess-tax.aspx
- s.787O TCA, the SFT amounts to 2029 and the earnings indexation from 2030: https://www.charteredaccountants.ie/taxsourcetotal/1997/en/act/pub/0039/sec0787O.html
- Revenue Pensions Manual Chapter 25 (SFT and BCEs): https://www.revenue.ie/en/tax-professionals/tdm/pensions/chapter-25.pdf
- Revenue Pensions Manual Chapter 28 (imputed distributions): https://www.revenue.ie/en/tax-professionals/tdm/pensions/chapter-28.pdf

Disclosure style references only: PwC (https://www.pwc.ie/issues/budget/income-tax-calculator.html), Deloitte (https://services.deloitte.ie/) and KPMG's income tax calculator notes.

## 5. Projection policy and assumptions

`resolveTaxRules(year)`:

1. **Parameters each Budget sets.** Take the latest catalogue year at or before `year` (today only 2026) and use its values unchanged in euro terms. Never index them.
2. **Changes the law fixes by date and amount.** Apply them by date: PRSI to 2028, SFT amounts to 2029, and any SFT figure Revenue has since published. Hold each at its last value afterwards.
3. **Formulas that depend on data not yet published.** Do not evaluate or forecast them. The SFT from 2030 is held at its last known value under step 2.
4. Return `rulesYear`, `heldForward`, `status`, `version` and `sftBasis` (`fixed` for a legislated or published figure, `held` for a year that uses the last known figure).

Years before 2026 throw.

Add one Planéir assumption to `js/planning/planeir_assumptions.js` and bump `PLANEIR_ASSUMPTIONS_VERSION` to `planeir-assumptions-1.2.0`:

- `taxProjection`: policy `freeze_budget_parameters_apply_fixed_law_hold_unknowns`, with a plain-language `basis` and `disclosure` covering the three steps above. Expose it through `assumptionRecord('taxProjection')` so the module's assumptions table shows it.

Rules are law and live in the tax catalogue. Planéir's policy for the years ahead lives in the assumptions file.

## 6. Build details

### 6.1 `rules_ie.js` shape

```js
export const IE_TAX_RULES_VERSION = 'ie-tax-2026.1';

export const IE_TAX_RULES_BY_YEAR = Object.freeze({
  2026: Object.freeze({
    status: 'enacted',          // 'announced' from Budget day until the Finance Act passes
    enactedBy: 'Finance Act 2025',
    verifiedOn: '2026-09-22',
    incomeTax: { /* 4.2 */ },
    ageExemption: { /* 4.3 */ },
    usc: { /* 4.4 */ },
    lumpSum: { lifetimeTaxFree: 200000, standardRateCeiling: 500000 }
  })
});

export const IE_LEGISLATED_SCHEDULES = Object.freeze({
  prsiRate: [ /* 4.5, by effective date */ ],
  standardFundThreshold: {
    fixed: [ /* 2026 to 2029, then each year Revenue publishes, with its source */ ],
    afterLastKnown: 'hold',   // 4.8: never projected
    indexationNote: 's.787O TCA: indexed to CSO average weekly earnings from 2030; cannot fall'
  }
});

export const IE_TAX_SOURCES = Object.freeze({ /* 4.10 */ });
```

### 6.2 `disclosures.js`

One dictionary from disclosure code to client-facing text (section 8), with placeholders filled from the catalogue and assumptions. No figure is typed into disclosure text by hand.

### 6.3 CLI: `scripts/ie-tax.mjs`

Commands `year`, `marginal`, `solve` and `rules <year>`. Each reads JSON from a file path or stdin and writes JSON to stdout, including disclosure text. Bad input exits non-zero with the validation message. Add `"tax:estimate": "node scripts/ie-tax.mjs"` to `package.json`.

### 6.4 Tests: `js/tests_ie_tax.js`

Follow the pattern of `js/tests_pension_math.js` and wire it into the same runner. Cover every golden case in section 9, the rule resolution checks, the SFT checks and the ARF checks.

## 7. Wire into the retirement engine (`js/pension_math.js`)

### 7.1 New optional inputs

| Key | Level | Values | Default |
|---|---|---|---|
| `householdTaxStatus` | `pensionInputs` | `single`, `married_or_civil_partners`, `widowed_or_surviving_civil_partner` | `single`, so two members are assessed as two single people (disclosed) |
| `targetIncomeBasis` | `pensionInputs` | `gross`, `net` | `gross` |
| `lumpSum` | member (top level in the single-member shape) | `{ "mode": "none" }`, `{ "mode": "max" }` (25% of the fund), `{ "mode": "amount", "amount": 500000 }` | `none` |
| `priorLumpSumsSince2005` | member | euro | 0 |
| `sftAlreadyUsed` | member | euro, capital value of earlier BCEs including DB pensions | 0 |
| `unrelievedLumpSumTax` | member | euro, 20% lump sum tax since 2011 not yet set against CET | 0 |
| `rentalIncomeOwnerId` | `pensionInputs` | a member id, or `joint` (split equally) | the only member, or `joint` for two |
| `taxTreatment` | each `otherIncomeSources[]` item | `occupational_pension`, `rental`, `employment`, `social_welfare`, `non_taxable` | from `type`: `db` and `annuity` map to `occupational_pension`, `rental` to `rental`, anything else to `occupational_pension` with a disclosure |

These seed the engine's starting state (3.3). A lump sum `amount` above the fund throws. Above 25% of the fund it is allowed with a disclosure (an occupational scheme's salary and service route can permit it). Other income owned by `household`, `joint` or `family` splits equally between members for tax.

### 7.2 Benefit crystallisation at retirement

For each member, in their retirement year and before that year's withdrawals, on every projected path (current and max):

1. Fund = projected balance; take the lump sum per `lumpSum`.
2. Call the SFT head's `crystallise` function to get the lump sum tax, SFT, chargeable excess, CET, credit and drawdown fund. It needs no income data, so it can run before the year's withdrawals are known.
3. Replace the balance with the drawdown fund.
4. Include the same `benefitCrystallisation` event in that year's `computeTaxYear` call, so the Schedule E part is taxed with the year's income and `nextState` records the lump sum, SFT used and any unused credit.
5. Net lump sum = lump sum - 20% tax - the extra household tax caused by the Schedule E part (`marginalTax`).

The lump sum leaves the projection as cash and does not fund income. This is disclosed.

### 7.3 Tax in every projected year

Build each year's input from the simulation and carry the state forward:

- State Pension: per member (split the current household figure).
- Pension withdrawals, mandatory plus elected: that member's `arfDistribution`.
- Bridge employment income: that member's `employment`, with that year's personal pension contribution as `employmentPensionContribution`.
- Rent: `rentalProfit`, per `rentalIncomeOwnerId`.
- Other income: per owner and `taxTreatment`.

Store income tax, USC, PRSI, total tax and net income per year, per path.

### 7.4 After-tax target (`targetIncomeBasis: "net"`)

The yearly target becomes net income: `targetIncomeToday` inflated exactly as now. Use `solveForNet` with an `adjustable` that splits the elected withdrawal pro rata across members, as today. If the target cannot be met, the shortfall is the net gap at maximum withdrawal. Where mandatory withdrawals alone overshoot, record the net surplus as today. The required-pot search and the affordable goal seek keep their structure and run on the net-aware simulation; in affordable mode the result becomes the sustainable net income.

### 7.5 What "required pot" means now

Required and projected pots are compared as drawdown funds after crystallisation. The projected path crystallises each member once, at their retirement. The required-pot search starts from drawdown funds at `requiredPotReferenceYear` and never crystallises. With no lump sum and no SFT breach the drawdown fund equals the pot, so results are unchanged. Label the rows accordingly, for example "after lump sum and tax at retirement".

### 7.6 Net cost of contributing today

For each member with a salary, in `currentYear` only, report the annual and monthly net cost of their current personal contribution and of the maximum relievable one: contribution plus the (negative) `marginalTax` of adding it as `employmentPensionContribution`. The household's income for this is every member's salary plus any other income active in `currentYear`. USC and PRSI are not relieved.

### 7.7 Outputs and chart

Add these rows and keep every existing one:

- First year of income: income tax, USC and PRSI; net income in nominal terms and in today's money; effective tax rate.
- First year the State Pension is fully in payment (every member with it included is receiving it): net income, nominal and in today's money.
- Per member with a lump sum: gross, tax and net.
- Per member at retirement: fund, the SFT and its year (for 2030 or later, labelled as held at the last known figure, with the `SFT_HELD` note), chargeable excess, gross CET, credit applied, net CET, credit carried forward and drawdown fund. Where a breach occurs, this replaces the current SFT sentence.
- Per member with a salary: net cost of the current and maximum personal contributions, monthly and annual.
- In net mode, the "Target income" rows read "Target net income".

In the chart's income panel add a visible "Net income (current)" line and income tax, USC and PRSI datasets hidden by default. In net mode label the required line "Required net income". Include every new series in the CSV. Follow the existing `pensionDrawdownComposite` patterns in `render.js` and `charts.js`, and keep the default view as uncluttered as it is now. Put the per-year tax series and the crystallisation results in `debug` too.

Rewrite the post-2029 SFT wording in `buildSftSummarySentence` to match `SFT_HELD`. The current text calls future increases unpredictable; the accurate position is that the law raises the threshold with average weekly earnings from 2030 and it can never fall, but the size of those increases cannot be known, so the projection holds it at €2.8m and any chargeable excess tax shown for 2030 or later may be overstated.

### 7.8 Compatibility

Payloads without the new keys must reproduce every existing output row exactly, with three deliberate exceptions, all corrections:

1. A member whose fund exceeds the SFT now pays CET at retirement.
2. ARF imputed distribution timing (4.9).
3. The SFT is tested at each member's own retirement year (4.8) instead of `requiredPotReferenceYear`, which can change breach flags for couples who retire in different years.

Update pinned expectations only for those reasons and list every changed case, with before and after values, in your handback. The new tax rows appear for every payload; in gross mode they are information only.

If the retirement-cases change (`pensionInputs.scenarios[]`) has landed, the new keys are payload-level, every case inherits them, and each case must still equal its standalone payload.

## 8. Disclosures

Every tax figure on screen carries these. Render them in the module's assumptions area using the existing table patterns: standing items always, applied items only when triggered, and a compact "Not included" line with the full list in the module's notes if space is tight.

What we took from the Big Four calculators: open by saying results are approximate and rounded; name each simplification in plain words (PwC blends the October PRSI change into one rate and assumes anyone 66 or over draws the State Pension; Deloitte states age as age attained in the year and warns that personal circumstances can change the result); say when eligibility for a credit or relief is assumed rather than checked; and point to personal advice. Unlike them, show only what applies to this case plus one standing "not included" list.

### 8.1 Always shown with tax figures

- `TAX_ESTIMATE`: Tax figures are estimates to help you understand your position, not a tax calculation or tax advice. They are rounded to the nearest euro.
- `TAX_RULES_HELD`: They use Irish tax rules for {rulesYear} ({enactedBy}). Later years keep the same bands, credits and thresholds in euro terms, so if future Budgets raise them your tax would be lower than shown.
- `TAX_LEGISLATED_CHANGES`: Changes the law has already fixed by date and amount are included: PRSI rises each October to 2028, and the Standard Fund Threshold rises to €2.8 million in 2029.
- `TAX_RESIDENCE`: This assumes you are resident and domiciled in Ireland for the whole year and that all your income comes from Ireland.
- `TAX_CREDITS_INCLUDED`: Only the personal, employee (PAYE) and age tax credits are included.
- `TAX_AGE_RULE`: Age-related rules apply for the whole of the year in which you reach that age.
- One status line: `STATUS_JOINT` (You are assessed jointly as a married couple or civil partners.), `STATUS_SINGLE` (You are assessed as a single person.), `STATUS_WIDOWED` (You are assessed as a widowed person or surviving civil partner without dependent children.), or `STATUS_DEFAULT_SINGLE` (Your tax status wasn't given, so each of you is assessed as a single person. If you are married or in a civil partnership, your tax would usually be lower.). Add `STATUS_SPOUSE_NO_INCOME` (Your spouse or civil partner is assumed to have no income.) where it applies.

### 8.2 Shown when applied

- `WITHDRAWAL_SPLIT`: Withdrawals come from each person's pension in proportion to its size, not arranged to reduce tax.
- `USC_STATE_PENSION_EXEMPT`: The State Pension is not subject to USC.
- `USC_REDUCED_70`: Reduced USC rates apply from age 70 while your income, not counting the State Pension, is €60,000 or less.
- `USC_SURCHARGE`: Rental profit above €100,000 a year pays an extra 3% USC.
- `IT_AGE_EXEMPTION`: In {years}, income is within the over-65 exemption limit, so no income tax is due.
- `IT_MARGINAL_RELIEF`: In {years}, marginal relief for people over 65 lowers the income tax due.
- `PRSI_UNTIL_SPC`: PRSI is charged on pension withdrawals, rent and earnings until the State Pension (Contributory) starts or you reach 70.
- `PRSI_PRE_2024_COHORT`: You reached 66 before 2024, so PRSI stops at 66.
- `PRSI_BLENDED`: Where the PRSI rate changes during a year, one blended rate is used, assuming income is spread evenly across the year.
- `PRSI_NONE_ON_PENSIONS`: No PRSI is charged on the State Pension or occupational pensions.
- `RENT_AS_ENTERED`: Rent is taxed on the amount entered, treated as profit after expenses.
- `RENT_SPLIT_JOINT`: Rent is split equally between you.
- `OTHER_INCOME_AS_PENSION`: {title} is taxed like an Irish occupational pension.
- `LUMP_SUM_RULES`: Retirement lump sums: the first €200,000 over your lifetime is tax-free, the next €300,000 is taxed at 20%, and anything above that is taxed as income at your top rate.
- `LUMP_SUM_PRIOR`: Earlier lump sums of €{amount} already count towards those limits.
- `LUMP_SUM_AS_CASH`: The lump sum is shown as cash at retirement. It is not used to fund your income in this projection.
- `LUMP_SUM_ABOVE_25`: A lump sum above 25% of the fund is assumed to be allowed by your scheme's rules.
- `SFT_THRESHOLD`: The Standard Fund Threshold used for {year} is €{amount}.
- `SFT_HELD`: From 2030 the law raises the threshold in line with average weekly earnings and it can never fall, but future earnings growth cannot be predicted, so it is held here at €{heldAmount}, its lowest possible level. Any chargeable excess tax shown for {year} may therefore be overstated. Raise it for every crystallisation in a year whose `sftBasis` is `held`, and wherever a later-year SFT is shown.
- `SFT_CET`: The amount above the threshold is taxed at {rate} and paid from the fund before the rest moves to drawdown.
- `SFT_CREDIT`: The 20% tax on your lump sum is set against that charge.{ €{amount} of unused credit carries forward.}
- `SFT_ALREADY_USED`: €{amount} of your threshold is treated as already used by earlier benefits.
- `ARF_MINIMUM`: Minimum ARF withdrawals are modelled as taken: 4% a year from the year you turn 61, 5% from the year you turn 71, and 6% while the fund is above €2 million. They are based on the fund's value at the start of each year.
- `NET_TARGET`: Your target is after tax. Withdrawals are set each year so that your income after income tax, USC and PRSI meets it.
- `NET_COST_CONTRIBUTIONS`: Net cost is after income tax relief at your top rate. USC and PRSI are still paid on pension contributions.

### 8.3 Not included (standing list)

1. Other tax credits and reliefs, including medical expenses, rent, mortgage interest, home carer, dependent relative, blind person and single person child carer credits, and higher exemption limits for dependent children.
2. The reduced USC rate for medical card holders.
3. The higher State Pension for claiming after 66, and the Qualified Adult Increase.
4. Tax on savings and investments outside pensions: DIRT, exit tax, capital gains tax and dividends.
5. Foreign pensions, non-residence and double taxation agreements.
6. Buying an annuity at retirement. All drawdown is modelled through an ARF.
7. The Personal Fund Threshold, and valuing defined benefit pensions against the SFT (enter any threshold already used instead).
8. PRSI Class K, minimum PRSI contributions and the PRSI credit for low earners.
9. Auto-enrolment (MyFutureFund) contributions, which get a State top-up rather than tax relief.
10. Tax on death, including inherited ARFs and capital acquisitions tax.
11. Pension adjustment orders, the years of marriage, separation or bereavement, and part-year residence.

Items 4 and 10 come off this list as Part B heads land.

### 8.4 Wording rules

Plain English, second person, at most two sentences per item. "Estimated", never "you will pay", and no advice. Figures come from the catalogue through placeholders. No em dashes in any user-facing text.

## 9. Golden cases

Tax year 2026 unless stated. SP means the State Pension of €15,563.60. Expected values were derived from the section 4 rules and match Revenue's own worked example where one exists (G6).

| ID | Case | Expected |
|---|---|---|
| G1 | Single, 67, receiving SPC. SP + ARF €30,000 | Income tax €5,180.44; USC €432.82; PRSI €0; net €39,950.34 |
| G2 | Married, both 72, both receiving SPC. A: SP + ARF €40,000. B: SP only | Band €68,563.60; credits €8,490; income tax €6,248.16; USC A €619.82 (reduced), B €0; net €64,259.22 |
| G2b | G2 assessed as two single people | Income tax €9,180.44; USC €619.82; net €61,326.94 |
| G3 | Single, 65, no State Pension yet. Rental profit €20,000 only | Income tax €800.00 by marginal relief (normal tax would be €1,755.00); USC €219.82; PRSI €847.50; net €18,132.68 |
| G4 | Single, 62. ARF €50,000 only | Income tax €7,200.00; USC €1,032.82; PRSI €2,118.75; net €39,648.43 |
| G9 | Single, 60. Rental profit €150,000 | Income tax €49,200.00; USC €9,530.62 including the €1,500 surcharge; PRSI €6,356.25; net €84,913.13 |
| G10a | Year 2029. Single, 67, born 1962, deferring SPC to 70. ARF €40,000 | Income tax €3,755.00; USC €732.82; PRSI €1,880.00 at 4.7%; net €33,632.18 |
| G10b | Same person in 2032, aged 70 | Income tax €3,755.00 (2026 rules held); USC €619.82 (reduced); PRSI €0; net €35,625.18 |
| G13 | Widowed, 68, receiving SPC. SP + DB pension €20,000 | Income tax €2,327.72; USC €219.82; PRSI €0; net €33,016.06 |
| G14 | Single, 70, receiving SPC. SP + DB pension €12,000 | Income tax €1,267.72; USC €0 (aggregate €12,000 is within €13,000); net €26,295.88 |
| G6 | Revenue Chapter 27, Example 4: lump sums of €180,000, then €150,000, then €450,000 | Second: 20% slice €130,000, tax €26,000. Third: 20% slice €170,000, tax €34,000, Schedule E part €280,000 (Revenue shows €112,000 at 40%) |
| G5 | BCE in 2029. Fund €3,200,000; lump sum €500,000 | Lump sum tax €60,000; chargeable excess €400,000; gross CET €160,000; credit €60,000; net CET €100,000; drawdown fund €2,600,000; net lump sum €440,000 |
| G5b | BCE in 2029. Fund €3,600,000; lump sum €900,000 | 20% tax €60,000; Schedule E part €400,000 (taxed in that year's income); chargeable excess €800,000; gross CET €320,000; credit €60,000 only; net CET €260,000; drawdown fund €2,440,000 |
| G7 | BCE in 2026. Fund €2,275,000; lump sum €500,000 | Chargeable excess €75,000; gross CET €30,000; credit applied €30,000; net CET €0; credit carried forward €30,000; drawdown fund €1,775,000 |
| G15 | BCE in 2031, SFT held. Fund €3,400,000; lump sum €500,000 | SFT €2,800,000 (`sftBasis` `held`); chargeable excess €600,000; gross CET €240,000; credit €60,000; net CET €180,000; drawdown fund €2,720,000; net lump sum €440,000; `SFT_HELD` raised |
| G11 | Single, 42, salary €85,000. Contributions of €6,800 (8%) and €21,250 (the 25% maximum at 42) | Relief €2,720.00, net cost €4,080.00 a year (€340.00 a month). Relief €8,500.00, net cost €12,750.00 a year (€1,062.50 a month) |
| G12 | Engine, net mode. `currentYear` 2026, single, 67, retiring now, SP included, pot €500,000, `targetIncomeToday` €40,000 | First-year pension withdrawals €30,087.11 (mandatory €20,000, elected €10,087.11); net income €40,000. Tolerance €1 |
| G5e | Engine. `currentYear` 2029, `currentAge` and `retirementAge` 65, pot €3,200,000, `lumpSum` amount €500,000 | Same crystallisation figures as G5 in the outputs and `debug` |

Rule resolution checks:

- `resolveTaxRules(2040)`: `rulesYear` 2026, `heldForward` true, single band €44,000, credits, exemption limits and USC bands exactly as 2026, PRSI 4.7%, SFT €2,800,000, `sftBasis` `held`.
- Blended PRSI: 2026 4.2375%, 2027 4.3875%, 2028 4.55%, 2029 4.7%.

SFT checks:

- 2026 €2,200,000; 2027 €2,400,000; 2028 €2,600,000; 2029 €2,800,000.
- 2030, 2031, 2035 and 2040: €2,800,000 each, `sftBasis` `held`.
- With a published figure recorded for 2030 (test with a hypothetical €3,000,000): 2030 resolves to €3,000,000 with `sftBasis` `fixed`, and 2031 and 2040 resolve to €3,000,000 with `sftBasis` `held`.
- Recording a published figure below the previous year's is rejected, because the law does not allow the threshold to fall.

ARF checks (opening value, attained age):

- €500,000: age 60 gives €0; 61 gives €20,000; 70 gives €20,000; 71 gives €25,000.
- €2,100,000: age 61 gives €126,000; age 58 gives €0.

## 10. Acceptance checklist

- [ ] Every golden case passes to the cent (solver cases to €1).
- [ ] Every screen or export that uses an SFT for 2030 or later carries the `SFT_HELD` note.
- [ ] Existing tests pass unchanged, except the cases listed in the handback under 7.8.
- [ ] No year after 2026 produces different bands, credits, exemption limits or USC thresholds.
- [ ] The SFT matches section 9, is never projected past the last known figure, and never falls from one year to the next.
- [ ] `computeTaxYear` never mutates its inputs, and `nextState` survives a JSON round trip.
- [ ] `marginalTax` equals the difference between two `computeTaxYear` calls to the cent.
- [ ] Part B item and event types are rejected with a clear error.
- [ ] No tax figure appears on screen without its disclosures, and every applied rule emits its code.
- [ ] The CLI returns the same numbers as the browser engine for the golden cases.
- [ ] Performance is within 3.4.
- [ ] Invalid inputs fail with an error that names the field.
- [ ] No network calls and no new runtime dependencies.
- [ ] No em dashes in new user-facing text.

## 11. Do not

- Build anything in Part B.
- Edit `docs/prompt-pack/`. Gerry updates the retirement playbook and `MASTER_PROJECT_PROMPT.md` together, so list what they need in your handback instead.
- Change State Pension amounts, escalation or start ages, or any value in `planeir_assumptions.js` beyond adding `taxProjection` and the version bump.
- Project the SFT past the last known figure, or add an earnings growth assumption for it.
- Take any value from a calculator or website outside 4.10.
- Round inside calculations.
- Silently fix anything in this brief that looks wrong against the code or the sources. Stop and report it.

## 12. Verify before release (Gerry)

1. The employee credit on ARF distributions is reasoned from s.784A (ARF distributions are Schedule E emoluments under PAYE) and s.472 (the credit for PAYE emoluments). Confirm.
2. No PRSI on the Schedule E part of a lump sum is an assumption. Confirm.
3. USC on the Schedule E part follows Chapter 27, which has the administrator apply marginal income tax and USC where no payroll notification is held.
4. Spot-check G11 in the PwC or Deloitte calculator (a single salary with a pension contribution is squarely what they handle). If you also try G4 by entering the ARF as salary, expect PRSI to differ: PwC blends the October 2026 increase as we do, while Deloitte ignores it.

## 13. Handback

1. What changed, by file.
2. The new `pensionInputs` keys, allowed values and defaults, ready for the retirement playbook and MASTER.
3. Every pinned test whose expected values changed, with before and after figures and which of the three 7.8 reasons applies.
4. Confirmation that the SFT resolves to €2.8m with `sftBasis` `held` for every year from 2030 until a published figure is recorded.
5. Timings.
6. Anything in this brief that disagreed with the code or the sources, and what you did about it.

## 14. Keeping it current

1. **Budget day.** Budget 2027 is due on Tuesday 6 October 2026. Add a `2027` block with `status: 'announced'` and switch it to `'enacted'` once the Finance Act passes. Never edit a past year's block. Update the legislated schedules if the Budget changes them.
2. **Official SFT.** The 2030 figure depends on CSO earnings for Q3 2029, which are first published in late November 2029. When Revenue publishes the SFT for 2030 or any later year, record it as a fixed amount with its source. Later years then hold that figure until the next one is published.
3. After any update: update `verifiedOn`, bump `IE_TAX_RULES_VERSION`, rerun the golden cases (they pin their tax year, so they stay valid) and add at least one case for the new year.

# Part B: the next tax heads (design only, do not build)

Nothing in Part A may make these hard to add. The item and event types, the state keys and the head interface in section 3 must hold them without breaking changes. Rates below are 2026 values; verify each against Revenue when its head is built, and give each its own brief with golden cases.

| Head | What the cashflow module needs it for | Rules to encode |
|---|---|---|
| Deposit interest (DIRT) | Returns on cash and deposits | 33% deducted at source |
| Funds and ETFs (exit tax) | Returns on Irish, EU, EEA and equivalent OECD funds and life policies | 38% from 1 January 2026 on gains, with a deemed disposal every eight years whose tax is credited against the eventual sale. No annual exemption and no relief for losses against other gains. Track each holding's cost, value and eight-year dates in `fundLots` |
| Shares and other assets (CGT) | Selling investments, property or a business | 33%. €1,270 annual exemption per person, not transferable. Losses carried forward. Market value on disposals to connected persons. Principal private residence relief (asserted). No CGT on death, and transfers between spouses are neutral |
| Dividends | Income from shares | Taxed as income with USC and PRSI. Dividend withholding tax of 25% is a credit. Counts as non-PAYE income for the USC surcharge |
| Rental profit | Letting property | Profit after allowable expenses, including mortgage interest on residential lettings, feeds the existing income tax, USC and PRSI heads. Check current landlord reliefs at build time |
| CAT | Gifts, inheritances and the estate at death | Lifetime thresholds by relationship: A €400,000, B €40,000, C €20,000. 33% above the threshold. Aggregation within each group since 5 December 1991. €3,000 small gift exemption per donor per recipient per year. Spouses and civil partners exempt. Dwelling house exemption, Business Relief and Agricultural Relief (90%) asserted |
| ARF and vested PRSA on death | What heirs actually receive from a pension | Moved into the surviving spouse's own ARF: no tax then, income tax on later withdrawals. Taken as cash by the spouse: income tax at the deceased's marginal rate. Child under 21: CAT only. Child 21 or over: 30% income tax and no CAT. Anyone else: marginal income tax and CAT |
| CGT and CAT on the same event | Gifting assets to children | CGT paid by the giver is credited against the child's CAT on the same asset, clawed back if the child disposes of it within two years |
| Stamp duty on property | Buying property | Reuse the house purchase module's rules |

Phase 3, for business owners and farmers, needs specialist review before any build: Retirement Relief (aged 55 to 69: €10m on transfers to a child and €750,000 to anyone else; 70 or over: €3m and €500,000; six-year clawback on transfers to a child; deferral of CGT on the excess above €10m while the child holds the assets for 12 years), Revised Entrepreneur Relief (10% up to a €1.5m lifetime limit from 2026), incorporation relief, corporation tax and close company rules, salary against dividend extraction, and self-employment income with the earned income credit. Gerry's CGT and CAT relief cheat sheet can go into the repo as the logic reference for these heads (conditions first, then qualifying proportions, then arithmetic), but its figures must still come from the catalogue.

Consumers waiting on Part B:

- The cashflow module itself, which needs its own brief for accounts, spending, drawdown order and charts. This engine is its tax layer, and `marginalTax` is what lets it choose the cheapest pot to draw from each year.
- Net Retirement Cash Flow, whose "sell the rental" case currently ignores CGT on the sale.
- AAM Report scripts on CGT when selling a rental, which can call the CLI.
- The retirement module's balance left at the horizon, which could show what heirs receive after tax on death.
