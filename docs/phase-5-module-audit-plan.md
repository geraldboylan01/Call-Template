# Phase 5 — deterministic module audit plan

Phase 4 proved the conversational architecture: speech reaches a canonical
profile, corrections supersede stale facts, readiness closes, and the right
module is selected. Phase 5 asks the next question and only that question:

> Given a correct canonical client profile, does each module receive the
> correct inputs, apply the correct assumptions, execute safely, and produce
> the correct financial result?

A perfect conversation is not enough. This phase treats the module layer as
independently untrustworthy until proven otherwise.

## Testing philosophy

Deterministic-first, and independent of the implementation being tested.

- Expected values come from a **reference calculation written separately from
  the production engine**, or from a case simple enough to check by hand. A
  module is never "correct" because it returned `ok:true`, because the number
  looked reasonable, or because it matched what the same engine produced last
  week.
- Where rounding makes exact equality wrong, state an explicit tolerance
  rather than loosening the assertion.
- Assert on **semantic identity, never array position**. A Phase 4 evaluator
  defect was reading `incomeSources[0]`; resolve rows by id or owner instead.
- Every bug found answers four questions: what was wrong, which
  financial/data-model assumption caused it, could it affect other modules,
  and what regression prevents recurrence.

## Current runnable inventory

Verified against the registry, not assumed.

| Module | Kind | Status | Engine | Consumer | Prereq | `validateInput` |
| --- | --- | --- | --- | --- | --- | --- |
| `liquidity_analysis` | calculation | active | `liquidity_reserve.js` | yes | — | no |
| `house_purchase` | calculation | beta | `house_purchase/engine.js` | yes | `liquidity_analysis` | **yes** |
| `pension_projection` | calculation | beta | `pension_math.js` | yes | — | no |
| `net_retirement_cashflow` | calculation | beta | `net_retirement_math.js` | **no** | — | no |
| `mortgage_analysis` | calculation | beta | `mortgage_math.js` | yes | — | no |
| `loan_analysis` | calculation | beta | `mortgage_math.js` | yes | — | no |
| `college_funding` | calculation | beta | `college_funding_math.js` | yes | — | no |
| `personal_balance_sheet` | calculation | beta | `personal_balance_sheet.js` | yes | — | no |

Two corrections to the working list:

- **`net_retirement_cashflow` is runnable but not consumer-available.** It has
  an engine and executes, but `consumerAvailable` is false, so it never runs
  through the consumer path. Audit it as an adviser-path engine; do not assume
  a consumer regression exercises it.
- **`mortgage_analysis` and `loan_analysis` still share one engine.** Both call
  `computeMortgageProjection` from `js/mortgage_math.js`. Test the amortisation
  engine deeply **once**; for the two modules test only selection, mapping and
  the output contract.

`retirement_goal_analysis` and `scenario_analysis` are compositions with no
engine of their own, and the adviser-only relief modules are out of scope.

## The defect class Phase 5 exists to find

The House Purchase failure was not a one-off. Its shape generalises, and the
generalisation is the thing to hunt:

> **A household aggregate and its per-owner decomposition are computed by two
> different rules that are never reconciled against each other.**

`currentCashSavings` summed every cash holding once. `cashSavingsContributions`
re-filtered the same holdings per applicant. Jointly held cash matched both
applicants and was counted twice; household-held cash matched neither and
disappeared. The engine's own contract caught it — loudly, which is why it was
findable at all.

Two consequences for the rest of the audit:

1. **Wherever a module computes both a household total and a per-owner split,
   assert that the split reconciles to the total.** That single invariant is
   the highest-yield test in this phase.
2. **A silent version of this defect is already latent.** `ownerId: 'household'`
   is a legal value on the singular-owner collections (`incomeSources`,
   `pensions`), and `normalizeHouseholdProfile` accepts it, but every
   per-person consumer matches on a person id and so cannot see it. A
   household-owned income counts in `netHouseholdIncome` while contributing
   zero to every applicant's `grossAnnualIncome`. Today both modules probed
   fail closed at readiness rather than producing a wrong number
   (`house_purchase` blocks on "no applicant has income"; `pension_projection`
   returns `missing_information`), so this is latent, not live — but it is the
   same defect with the loud failure removed. Each module's audit must state
   explicitly what it does with a `'household'`-owned singular record.

## Audit order

Ordered by where a wrong answer is most likely and least visible, not by
module size.

| # | Module | Why here |
| --- | --- | --- |
| 1 | `house_purchase` | Done. Known failure, conversational side already proven. |
| 2 | **`personal_balance_sheet`** | The remaining home of the defect class above, and the one place it fails silently. See recommendation below. |
| 3 | `liquidity_analysis` | `house_purchase`'s prerequisite, so its correctness is load-bearing for a module already audited. Small engine, fast to close. |
| 4 | `mortgage_math` (shared engine) | One deep amortisation audit serving two modules. Highest reuse per unit of effort. |
| 5 | `mortgage_analysis` + `loan_analysis` | Selection, mapping and output contract only, on the engine proven at step 4. |
| 6 | `pension_projection` | Largest assumption surface and the product-type rules (PRB, DB, ARF) that must not blur. |
| 7 | `net_retirement_cashflow` | Shares retirement assumptions with step 6; audit after them, and note it is adviser-path only. |
| 8 | `college_funding` | Self-contained, one non-standard assumption (education inflation), lowest blast radius. |

## Per-module audit specifications

### 2. `personal_balance_sheet`

**Key outputs to verify independently:** `grossAssets`, `totalLiabilities`,
`netWorth`, `spendableReserves`, `reserveMonths`, per-bucket totals.

**Input-contract invariants:**
- `grossAssets - totalLiabilities - netWorth === 0`. The engine already
  computes this as `reconciliationDifference`; the audit holds it at zero
  rather than merely reporting it.
- Bucket totals sum to `grossAssets` with no holding in two buckets and none
  in none.
- Every asset, liability, property and business in the profile appears exactly
  once; count the inputs and the classified outputs and compare.
- A property and its `associatedLiabilityIds` mortgage are not netted twice.

**Hand-checkable case:** one €300,000 property, one €200,000 mortgage, one
€10,000 cash holding. Net worth is €110,000. Nothing else.

**Realistic case:** couple, jointly owned home with mortgage, one individually
owned car loan, joint cash, one individually held investment, one pension.

**Edge cases:** zero assets; liabilities exceeding assets (negative net worth
must be reported, not floored at zero); an asset with no `currentValue`; a
liability with no balance; cross-currency holdings excluded consistently from
both the bucket and the total.

**Household/ownership risks — the priority here.** This module reads every
`ownerIds` collection. Test each holding under all four ownership shapes:
sole, both-persons, `'household'`, and empty. A joint holding must contribute
its value **once** to household net worth. If a per-owner view exists, it must
reconcile to the household total.

**Assumption risks:** `spendableReserves` and `reserveMonths` must draw the
same liquidity policy as `liquidity_analysis`, from `planeir_assumptions.js`,
applied once. Two modules deriving a reserve from two copies of the rule is a
divergence waiting to happen.

**Shared engine:** none, but its reserve concept overlaps `liquidity_analysis`
— verify they agree rather than testing each in isolation.

### 3. `liquidity_analysis`

**Key outputs:** `currentCash`, `monthlyExpenditure`, `monthsCovered`,
`minimumCash`, `targetCash`, `surplusCash`/`shortfallCash`.

**Input-contract invariants:** `monthsCovered === currentCash /
monthlyExpenditure`; `minimumCash === monthlyExpenditure × minimumBufferMonths`
and likewise for target; exactly one of surplus/shortfall is non-zero;
`currentCash` matches the same cash population `house_purchase` uses.

**Hand-checkable case:** €12,000 cash, €2,000/month spending, working
household → 6.0 months covered, €6,000 minimum, €12,000 target, zero
shortfall. Every number checkable mentally.

**Realistic case:** couple with €25,000 across three accounts and €4,100/month
spending.

**Edge cases:** zero spending (division by zero must not yield `Infinity` in
an output); zero cash; retired status flipping the 3/6 buffer to 12/24;
spending known only as an annual total.

**Household/ownership risks:** low — it aggregates. Confirm it aggregates
**once**, including `'household'`-owned and unattributed cash.

**Assumption risks:** the 3/6 and 12/24 buffers and `policyVersion` must come
from `PLANEIR_ASSUMPTIONS.liquidity` and be applied once. Retired-vs-working
selection is the switch to test, including a couple where only one person is
retired.

**Carried-forward:** the essential-versus-total monthly spending definition
(item C) blocks this module by design. Fail-closed is correct — do not
substitute one for the other to make a test pass.

### 4. `mortgage_math` — shared engine, deep audit

**Key outputs:** `openingBalance`, `paymentUsedMonthly`, `payoffYear`,
`totalInterestLifetime`, `totalPaidLifetime`, and the amortisation schedule.

**Reference calculation:** implement the standard annuity payment
`P = B·i / (1 - (1+i)^-n)` in the test file, deliberately separate from
`mortgage_math.js`, and compare. This is the clearest case in Phase 5 for an
independent reference implementation.

**Invariants:** the schedule's closing balance reaches zero at `payoffYear`;
`totalPaidLifetime === totalInterestLifetime + openingBalance`; every period's
interest equals `balance × periodic rate`; principal plus interest equals the
payment each period.

**Hand-checkable case:** €100,000 at 0% over 10 years → €833.33/month, zero
total interest, `totalPaid === 100,000`. The zero-rate case also guards the
annuity formula's division-by-zero branch.

**Realistic case:** €280,000 at 3.9% over 27 years remaining.

**Edge cases:** zero interest rate; term of one month; a stated payment below
the interest accrual (negative amortisation — must be refused or reported, not
silently looped forever); a payment above the balance; overpayments; balance
already zero.

**Assumption risks:** rate conversion is the classic defect — confirm whether
the annual rate is divided by 12 or converted geometrically, and that one
convention is used consistently. Confirm the term is remaining, not original.

### 5. `mortgage_analysis` and `loan_analysis`

Do **not** re-test the amortisation maths. Test only what differs:

- **Selection:** `selectMortgage` prefers the liability named by
  `assumptions.values.mortgage.liabilityId`, then falls back to the first
  liability of that type. Test with two mortgages present — the fallback
  picking an arbitrary one is a real risk worth pinning.
- **Type separation:** a `loan` liability must never reach `mortgage_analysis`
  and vice versa.
- **Mapping:** balance, rate and remaining term reach the engine unmodified
  and in the right units (rate as a fraction, term in months).
- **Output contract:** the semantic result exposes the engine's numbers
  unchanged.
- **Household/ownership:** a jointly owned mortgage is analysed once, at full
  balance, not once per owner — the direct analogue of the cash-split defect.

### 6. `pension_projection`

**Key outputs:** `projectedPotAtRetirement`, `projectedPotAtIncomeStart`,
`requiredPot`, `gapVsRequired`/`surplusVsRequired`, `retirementYear`,
`depletionAgeProjected`.

**Reference calculation:** future value of a pot plus a contribution stream,
written independently: `FV = P(1+g)^n + Σ C(1+g)^(n-t)`.

**Invariants:** exactly one of gap/surplus is non-zero; `retirementYear`
follows from current age and intended retirement age; contributions apply for
the correct number of periods (the off-by-one on the first and last year is
the likeliest arithmetic defect); growth is applied once per period.

**Hand-checkable case:** €100,000 pot, no contributions, 5% growth, 1 year →
€105,000. Then 2 years → €110,250. Any deviation localises a compounding bug
immediately.

**Realistic case:** age 45, €150,000 pot, €1,000/month combined contribution,
retirement at 65.

**Edge cases:** already at retirement age (zero periods); zero pot with
contributions only; zero contributions; retirement age below current age.

**Product-type correctness — the priority here:**
- Contribution-capable and non-contributory products stay distinct.
  `NON_CONTRIBUTORY_PENSION_TYPES` already names `buyout_bond` and
  `defined_benefit`; assert a PRB/buyout bond receives **no** ongoing
  contributions even when a household contribution figure exists.
- A defined-benefit pension is treated as an income stream, not a funded pot.
  It must never be added to `projectedPotAtRetirement`.
- ARF remains a post-retirement drawdown treatment unless the data model
  deliberately changes.

**Household/ownership risks:** pensions carry a singular `ownerId`. Per-person
pots stay per-person and are not silently merged; an absent partner's pension
is not treated as zero unless explicitly confirmed; and a `'household'`-owned
pension must be handled explicitly rather than disappearing from every
per-owner view.

**Assumption risks:** growth, inflation, State Pension and contribution
treatment must all come from the versioned rules and be applied exactly once.
State Pension is the highest-risk item — verify it is added once, at the right
age, on the right basis, and not double-counted against target income.

### 7. `net_retirement_cashflow`

**Key outputs:** `requiredNetFundToday`, `firstYearShortfall`,
`surplusVsRequired`/`gapVsRequired`.

**Invariants:** the required fund discounts the income need at the versioned
inflation rate over the right horizon; the first-year shortfall equals target
income minus guaranteed income for year one; exactly one of gap/surplus is
non-zero.

**Hand-checkable case:** target €40,000/year, guaranteed €15,000/year → first
year shortfall exactly €25,000, before any discounting.

**Realistic case:** couple, both State Pensions, one DB pension, one DC pot.

**Edge cases:** guaranteed income exceeding the target (surplus, not negative
shortfall); zero guaranteed income; retirement already begun.

**Household/ownership risks:** two State Pensions for a couple must be counted
once each, not once per household member per person. A single-person household
must not receive a partner's State Pension.

**Assumption risks:** shares retirement assumptions with `pension_projection`
— assert both read the same versioned values rather than testing each against
its own expectation. Audit immediately after step 6 while that context is live.

**Note:** adviser-path only (`consumerAvailable: false`).

### 8. `college_funding`

**Key outputs:** `firstCollegeYear`, `finalCollegeYear`, `fundingPeriodYears`,
`costTodayRange`, `nominalCostRange`, `peakAnnualCostRange`.

**Invariants:** `finalCollegeYear - firstCollegeYear + 1 === durationYears`
(4); `firstCollegeYear` follows from the dependant's age and `startAge` (18);
nominal cost equals today's cost inflated at the **education** rate (4%), not
the general rate (2%); ranges are ordered low ≤ high.

**Hand-checkable case:** one child aged 17, living at home (€5,000/year today),
4% education inflation → first year cost €5,200 in one year's time. Directly
checkable.

**Realistic case:** two children aged 8 and 11, one living away, one at home.

**Edge cases:** child already 18 or older (zero funding period); child aged 0;
two children with overlapping college years — the peak annual cost must
capture the overlap, which is the module's whole point and its likeliest bug;
no dependants.

**Household/ownership risks:** dependants have no owner, so the risk is
per-child rather than per-owner. Assert costs are per child and not applied
once per parent.

**Assumption risks:** the education inflation rate (4%) must be sourced from
`PLANEIR_ASSUMPTIONS.inflation.educationRate` and applied exactly once, and
must not be silently replaced by the general rate. The €5,000/€15,000 scenario
costs and the 18/4 start and duration come from the same versioned record.

## Cross-cutting work, once, for every module

- **Adopt `validateInput` across the registry.** Only `house_purchase`
  declares it today. Each module declaring its own normaliser moves an input
  contract breach out of the run phase, where it otherwise masquerades as an
  engine crash. Do this as each module is audited.
- **Reconcile aggregate against decomposition** wherever both exist.
- **State the `'household'` owner behaviour** for every module that reads a
  singular-owner collection, and decide whether the profile schema should keep
  admitting a value that no per-person consumer handles.
- **Confirm assumptions are read from the versioned record, not re-stated**,
  and applied exactly once.

## Explicitly out of scope

Carried forward from Phase 4 and not reopened by this phase unless a module
audit proves a real architectural dependency:

- **A.** Deterministic evidence rules versus natural speech. The likely
  long-term direction is semantic interpretation plus exact transcript
  evidence plus deterministic ownership validation, rather than enumerating
  regex phrasings. Not a Phase 5 calculation concern.
- **B.** Collection completeness. "That is the only property we own" is not
  "we own no property"; that belongs in a `completedPaths` mechanism, not
  `confirmedNone`. Do not conflate "no items" with "no additional items".
- **C.** Monthly spending definition. Liquidity and the balance sheet want
  essential spending excluding housing; clients answer with total spending.
  The current fail-closed behaviour is correct and stays. This is conversational
  UX wording, not an engine defect.
- **D.** Dense-sentence numeric evidence refusal.
- **E.** Evaluator defects, not product defects: array-order assumptions and
  the expectation that joint savings belong to the primary rather than the
  household. Both are already reflected in how the Phase 5 tests assert.
