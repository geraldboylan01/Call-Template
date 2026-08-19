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
| `liquidity_analysis` | calculation | active | `liquidity_reserve.js` | yes | — | **yes** |
| `house_purchase` | calculation | beta | `house_purchase/engine.js` | yes | `liquidity_analysis` | **yes** |
| `pension_projection` | calculation | beta | `pension_math.js` | yes | — | **yes** |
| `net_retirement_cashflow` | calculation | beta | `net_retirement_math.js` | **no** | — | **yes** |
| `mortgage_analysis` | calculation | beta | `mortgage_math.js` | yes | — | **yes** |
| `loan_analysis` | calculation | beta | `mortgage_math.js` | yes | — | **yes** |
| `college_funding` | calculation | beta | `college_funding_math.js` | yes | — | no |
| `personal_balance_sheet` | calculation | beta | `personal_balance_sheet.js` | yes | — | **yes** |

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

## Ownership model

| Thing | Owner field | Arity | `'household'` |
| --- | --- | --- | --- |
| `employment`, `self_employment` income | `ownerIds` | exactly one real person | invalid |
| `pension`, `state_pension` income | `ownerIds` | exactly one real person | invalid |
| `rental`, `other` income | `ownerIds` | one or two real people | invalid |
| pension positions | `ownerId` | exactly one real person | invalid |
| assets, liabilities, properties, businesses | `ownerIds` | one or more | **legal** |
| combined household figures | `householdIncome` (not a position) | n/a | n/a |

A combined household figure may answer a module contract that asks for a
combined household figure. It can never satisfy a readiness requirement for a
specific person's income.

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
2. **The silent version of this defect is closed.** `ownerId: 'household'` was
   a legal value on the singular-owner collections, and every per-person
   consumer matched on a person id and so could not see it: a household-owned
   income counted in `netHouseholdIncome` while contributing zero to every
   applicant's `grossAnnualIncome`. Ownership now follows what the thing is —
   single-owner for salaries, trades, pensions in payment, State Pension
   entitlements and pension positions; `ownerIds` naming both real people for
   genuinely joint income; and a `householdIncome` aggregate that is not a
   position and can never answer "what does each of you earn?". The pseudo-owner
   remains legal only on the `ownerIds` collections (assets, liabilities,
   properties, businesses), where "the household owns this" needs no per-person
   decomposition to be correct.

## Audit order

Ordered by where a wrong answer is most likely and least visible, not by
module size.

| # | Module | Why here |
| --- | --- | --- |
| 1 | `house_purchase` | Done. Known failure, conversational side already proven. |
| 2 | `personal_balance_sheet` | **Done.** Ownership never double-counts; the engine now refuses a position supplied twice. |
| 3 | `liquidity_analysis` | **Done.** Arithmetic proved independently; an uncomparable reserve no longer reads as a pass, and the cohort rule no longer depends on who was entered first. |
| 4 | `mortgage_math` (shared engine) | **Done.** Payment and schedule match an independently written annuity; payoff detection no longer depends on float luck. |
| 5 | `mortgage_analysis` + `loan_analysis` | **Done alongside step 4.** Selection, mapping, type separation and output contract, on the proven engine. |
| 6 | `pension_projection` | **Done.** Timing measured before anything rested on it; PRB, DB and State Pension treatments all proved. |
| 7 | `net_retirement_cashflow` | **Done.** The gross/net boundary is structural, not incidental; arithmetic proved row by row. |
| 8 | `college_funding` | Next, and last. Self-contained, one non-standard assumption (education inflation), lowest blast radius. |

## Per-module audit specifications

### 2. `personal_balance_sheet` — AUDITED

Every figure was checked against arithmetic written separately from the engine,
in `scripts/check-personal-balance-sheet-audit.mjs`. 19 checks.

**What was already right.** PBS reads no ownership at all: it aggregates each
position once from its own collection, so a joint holding cannot be doubled by
having two owners. A joint €100,000 asset contributes €100,000. A partner-only
holding appears at full value without being reassigned. The generic/specialist
overlap guard works — a home recorded both as a property asset and as a
property record blocks the sheet until someone says which it is, and the
unreviewed record stays out either way. Negative net worth is reported, not
clamped. A holding with no value, or one in another currency, fails closed and
names the field; the cross-currency reason says the currency rather than
claiming the figure is missing. PBS and `liquidity_analysis` draw the same
monthly-spending basis, so their months-of-cover figures agree.

**The defect found.** The engine guarded its buckets, its signs and its
finiteness but never that a position appears once. The same €50,000 holding
supplied twice became €100,000 of net worth — and `reconciliationDifference`
still read zero, because doubling both sides of a consistent sum keeps it
consistent. Fixed by asserting position identity, where identity is the source
collection **plus** the id: a cash holding and a business interest may
legitimately share an id while being two different things, and rejecting that
would refuse a correct balance sheet.

**On `reconciliationDifference`.** It is not an oracle. The engine computes
`netWorth = gross - liabilities` and then `difference = gross - liabilities -
netWorth`, so it is zero by construction and can only catch a rounding slip.
Independent arithmetic is the real check; the difference is asserted for what
it is worth and no more. No rounding tolerance is used, because every amount in
these cases is a whole number of euro — a tolerance would only hide error.

### 3. `liquidity_analysis` — AUDITED

Checked against arithmetic written separately from the engine, in
`scripts/check-liquidity-audit.mjs`. 27 checks. An existing test compares the
adapter against `computeLiquidityReserve(input)`; that proves the adapter has
not drifted from the engine and is **not** evidence the engine is right.

**What was already right.** €12,000 against €2,000 a month is 6.0 months, a
€6,000 floor and a €12,000 target; read as retired the same household targets
€48,000 and reports a true €36,000 shortfall. The 3/6 and 12/24 guides come
from the versioned policy, are applied once, and the run is stamped with the
policy version. Zero or unknown spending yields nulls rather than `Infinity`.
The target can never fall below the floor. An annual spending figure gives an
identical reserve to the monthly one. Cash is a household total, so ownership
shape changes nothing and a jointly held holding counts once; investments and
property never inflate the reserve; foreign currency is excluded and disclosed.
Liquidity and the balance sheet agree on spending, spendable cash and months of
cover.

**Defect 1 — a gap of zero is a claim.** `surplusCash` and `shortfallCash` both
fell back to `0` whenever the target or the cash could not be established, and
every reader downstream decides the household is fine by asking whether the
shortfall is above zero. A household whose monthly spending had never been
captured was told, in a positive tone, that its reserve was at or above target.
Unknown is now `null` — falsy in the same `> 0` guards those readers already
use — and the engine states its own `position`, including `'unknown'`.

**Defect 2 — the cohort ignored the partner.** `resolveLiquidityCohort` read
`primaryPerson` alone, so a retired client with a working partner was told to
hold 24 months of spending rather than 6 — four times the target on the same
facts — and entering the couple the other way round produced the opposite
answer. The retired guide now applies only when **every** adult has retired,
which is what the policy's own wording says ("a working household", "a retired
household") and why the buffer is larger in retirement at all: earned income
has stopped. A stated household retirement status still outranks the per-person
reading. **This was a product decision, taken by the owner, not a judgement
made here.**

**Also added.** An input contract. The engine is deliberately forgiving — right
for a renderer handling a half-filled form, wrong as the last word before a
client is given a number: a buffer override of `-3` or `0` silently became the
policy default, so an adviser could type one figure and the illustration use
another. That now reports as `module_input_invalid`.

### 4. `mortgage_math` — AUDITED (with modules 5)

Checked against a reference implementation written from the annuity formula
`P = B·i / (1 − (1+i)^−n)`, plus a schedule re-simulated period by period, both
in `scripts/check-mortgage-math-audit.mjs` and importing nothing from the code
under test. 23 checks covering the engine and both modules over it.

**What was already right.** The payment matches the independent annuity to
machine precision, and lifetime interest, principal and total paid match a
re-simulated schedule. `totalPaid = interest + principal` holds across five
rate and term combinations, every period charges the rate on its own opening
balance, the payment splits exactly into interest plus principal, and the
annual rollup reconciles to the monthly schedule. The rate convention is
nominal (annual ÷ 12), applied consistently by both the payment function and
the schedule — asserted explicitly so a future switch to an effective-rate
conversion has to be deliberate. Zero rate, a one-month term, a payment above
the balance, one-off and annual overpayments all behave correctly; an annual
overpayment shortens the term at an unchanged payment. Negative amortisation,
a zero or negative balance, a negative rate, a missing term and interest-only
are all refused rather than modelled.

**Defect 1 — payoff detection was a coin flip.** It required the balance to
reach EXACTLY zero, which floating-point arithmetic reaches only by luck.
Across €250,000 over 25 years at rates from 1% to 6%, **half** the runs
finished with a residue like 0.00000000012 and were reported as never repaid —
in prose, on the same screen as "Remaining balance at term end: €0.00". The
summary literally read "not fully repaid … leaving €0.00 outstanding". Money is
measured to the cent, so anything below half a cent is now settled, and the
sweep is pinned as a regression.

**Defect 2 — a null dereference where a diagnostic belonged.** Building an
input for a profile with no matching liability threw
`Cannot read properties of null`. Readiness refuses this, so only a direct
caller reaches it, but every other audited module fails with a sentence naming
what is absent. It now does too.

**Defect 3 — a silent pick between two mortgages.** `selectMortgage` falls back
to the first matching liability, so a household with two got an analysis of one
and nothing said which. The choice is now declared in `assumptionsUsed` when
there is more than one candidate. **Whether it should instead ask which
mortgage the client means is left open** — the figures are correct for a real
mortgage of theirs, and choosing between "name it" and "ask" is a product call.

### 5. `mortgage_analysis` and `loan_analysis` — AUDITED

Audited alongside the engine rather than separately, since the plan already
scoped them to what differs. Both map balance, rate and term without rescaling
(rate stays a fraction, months convert to years) and stamp their own loan kind.
Type separation holds in both directions: a loan never makes mortgage analysis
relevant and a mortgage never makes loan analysis relevant. A jointly owned
mortgage is analysed once at its full balance. Both run end to end against
independently computed figures. The amortisation maths is **not** re-tested per
module.

### 6. `pension_projection` — AUDITED

Checked against a pot accumulated from first principles in
`scripts/check-pension-projection-audit.mjs`, importing nothing from
`pension_math.js` except the versioned constants it verifies were applied.
21 checks, in three layers: hand-checkable micro-cases, reference-calculator
cases, then realistic households.

**Timing, measured before anything rested on it.** Growth periods equal
`retirementAge − currentAge`: €100,000 at 5% goes 100,000 → 105,000 → 110,250.
A contribution is made in every year where age is below the retirement age, so
the retirement year itself receives none. Contributions are added **before**
that year's growth, so the first contribution earns growth immediately.
Salary escalates from the second year, so the first contribution is a share of
today's pay — the first/last-year off-by-one is not present in either place.

**Product types, all correct.** A DC pot and its contributions aggregate once
per person. A PRB grows but receives no contribution **even when the record
carries contribution rates**. A paid-up scheme behaves the same way. A
defined-benefit pension is income exactly once and never a pot — proved with a
DB record carrying a `currentValue` of €999,999, which contributes nothing to
the pot; a DB with no stated income adds nothing rather than adding zero. State
Pension never enters a funded pot, is counted once per eligible person, takes
its start age and escalation from the rules catalogue, and stays individually
switchable.

**Ownership holds.** Every pension stays attached to its own person while the
household resources combine: separate ages, retirement ages, pots and salaries
per member, with nothing leaking across owners. A partner with no pension
recorded is asked about rather than treated as zero.

**Two things deliberately NOT recorded as defects**, having been tested rather
than assumed — both looked like defects first:

- With staggered retirement the combined pot at the later reference year is
  *smaller* than the sum of each pot at its own retirement. That is the earlier
  retiree funding the household through the bridge years. Setting the target
  income to zero leaves both pots intact, which is asserted in both directions.
- A retired pot shrinks slightly against pure growth. That is ARF minimum
  drawdown, the documented post-retirement treatment.

**Defect found — a malformed profile reported as an unknown failure.**
`runPlanningModule` normalised the profile *before* the labelled input phase,
so a profile the schema refuses (a retirement age already behind the client)
surfaced as `unknown_module_failure` — which the taxonomy defines as "treat as
a defect and read the detail". It is an invalid input and now says so. **Blast
radius: every module**, since the wrapper is shared; fixed once there.

**Assumption sourcing — since resolved.** Growth and inflation come from
`PLANEIR_ASSUMPTIONS` and are applied exactly once; State Pension comes from
`IRISH_STATE_PENSION_CONTRIBUTORY`. The ARF minimum drawdown rates were
hardcoded constants in `pension_math.js` — dated Irish rules in a file that is
not the rules file. They now live in the catalogue as
`IRISH_ARF_MINIMUM_DRAWDOWN` with `irishArfMinimumRate()`, at exactly their
previous values, pinned by a regression asserting the drawdown result is
identical to a figure recorded before the move.

**Blast radius into step 7.** `net_retirement_math.js` is a genuinely separate
engine — it shares the adapter *file* with pension projection but none of the
accumulation, ARF or State Pension code. Nothing found here propagates to it.
One thing for that audit to check: DB pensions reach `pension_projection` as
income sourced from `/pensions`, while `buildNetRetirementInput` reads only
`/incomeSources`, so the two modules may not see the same DB income.

### 7. `net_retirement_cashflow` — AUDITED

Checked against a required-fund calculation written from first principles in
`scripts/check-net-retirement-audit.mjs`, importing nothing from
`net_retirement_math.js`. 18 checks.

**What it is for**, from the playbook rather than inferred: it compares the
household's NET spending need with NET recurring income and converts the annual
shortfalls into the required NET investment fund today. The playbook says it
exists precisely "where pension taxation is too uncertain for a true net-income
pension projection", that "all income and expenditure figures are treated as
after-tax net amounts", and it names using `generated.pensionInputs` here as an
anti-pattern.

**The pension gap is the design, and it holds.** Gross pension pots and gross DB
or State Pension income do not flow in from `/pensions`, and must not: a €20,000
gross DB pension becoming €20,000 of spendable income would understate the
requirement by exactly the tax nobody deducted, and the answer would still look
reasonable. Verified structurally:

| Source | Reaches the net fund? |
| --- | --- |
| cash | yes |
| investment marked liquid | yes |
| investment marked illiquid | no |
| investment with liquidity unstated | no (fail-closed) |
| pension-typed asset | **no** |
| pension position in `/pensions` | **no** |
| property, business | no |

Income follows the same gate: only a **stated net amount** becomes income. A
source carrying only `grossAnnual` is excluded rather than read as net; where
both are stated the net figure wins. A client-supplied net DB or net State
Pension amount *is* counted, at its net figure — that is the supported route.

**Arithmetic.** Year zero is today, un-inflated and undiscounted; each later
year carries one period of each. A forty-one-year projection matches the
reference row by row and in total. Income start and end ages are exact. A
surplus year is reported and deliberately does not offset a later shortfall.

**Scenarios.** Keep-versus-sell works exactly once in each direction: selling
the rental raises the requirement by precisely the lost rent and the fund by
precisely the stated proceeds, with neither double counted. Overrides and
additional sources apply only to what they name, and the base scenario is
unaffected by the existence of others. Note the engine does **not** infer the
link between losing an income and gaining proceeds — the scenario author states
both. That is deliberate flexibility, not a defect, but it means a malformed
scenario could state one without the other.

**Failing closed.** Unknown spending stays `null`, blocks readiness and is
refused by the contract — it never becomes zero, which would report a household
as needing no fund at all. An unknown fund withholds the surplus/gap comparison
rather than asserting either. No recorded liquid assets errs toward showing a
gap, which is the conservative direction.

**No defects found.** The module was already correct on every axis tested. It
gains a `validateInput` contract and this audit.

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

- **Adopt `validateInput` across the registry.** Seven of eight declare it;
  only `college_funding` does not. Each module declaring its own normaliser moves an input
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
