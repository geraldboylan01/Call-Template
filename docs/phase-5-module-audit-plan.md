# Phase 5 — deterministic module audit: closing summary

Phase 4 proved the conversational architecture: speech reaches a canonical
profile, corrections supersede stale facts, readiness closes, and the right
module is selected. Phase 5 asked the next question of the module layer, and
only that question:

> Given a correct canonical client profile, does each module receive the
> correct inputs, apply the correct assumptions, execute safely, and produce
> the correct financial result?

A perfect conversation is not enough. This phase treated the module layer as
independently untrustworthy until proven otherwise. This document is the
closing record of what it established — kept at its original path so links to
it still resolve.

## What Phase 5 established

Every deterministic module Planéir can run has now been audited against
arithmetic written separately from the engine under test. Across eight modules:

- **Nine defects were found and fixed.** Six produced a wrong or misleading
  number; three produced a wrong or unusable failure. Every one is pinned by a
  regression that fails if it returns.
- **Two of the nine were cross-module**, in the shared run wrapper, and were
  fixed once for all eight.
- **All eight runnable modules now declare a `validateInput` contract**, so a
  breach of a module's input contract is reported as an input defect rather
  than surfacing as an engine crash.
- **Three behaviours that looked like defects were tested and proved correct**,
  and are now asserted in both directions so a later change cannot quietly
  "fix" them into something wrong.
- **Two open product decisions were closed by the owner**, not decided here.
- **166 deterministic checks** were added across eight new audit suites, all
  wired into `npm run check:consumer`.

What this does *not* establish: the compositions (`retirement_goal_analysis`,
`scenario_analysis`) have no engine of their own and were not separately
audited; adviser-only relief modules were out of scope; and this phase tested
calculation, not presentation. The phase ran entirely on deterministic checks —
no live model calls were needed to reproduce any defect.

## What was audited

Verified against the registry, not assumed.

| Module | Kind | Status | Engine | Consumer | Prereq | `validateInput` |
| --- | --- | --- | --- | --- | --- | --- |
| `liquidity_analysis` | calculation | active | `liquidity_reserve.js` | yes | — | yes |
| `house_purchase` | calculation | beta | `house_purchase/engine.js` | yes | `liquidity_analysis` | yes |
| `pension_projection` | calculation | beta | `pension_math.js` | yes | — | yes |
| `net_retirement_cashflow` | calculation | beta | `net_retirement_math.js` | **no** | — | yes |
| `mortgage_analysis` | calculation | beta | `mortgage_math.js` | yes | — | yes |
| `loan_analysis` | calculation | beta | `mortgage_math.js` | yes | — | yes |
| `college_funding` | calculation | beta | `college_funding_math.js` | yes | — | yes |
| `personal_balance_sheet` | calculation | beta | `personal_balance_sheet.js` | yes | — | yes |

Two facts about that list that shaped the work:

- **`net_retirement_cashflow` is runnable but not consumer-available.** It has
  an engine and executes, but `consumerAvailable` is false, so no consumer
  regression exercises it. It was audited as an adviser-path engine.
- **`mortgage_analysis` and `loan_analysis` share one engine.** Both call
  `computeMortgageProjection`. The amortisation engine was tested deeply once;
  the two modules were tested only on selection, mapping, type separation and
  the output contract.

## How it was tested

The standard used throughout, recorded here because later phases inherit it.

- Expected values came from a **reference calculation written separately from
  the production engine**, or from a case simple enough to check by hand. Each
  audit suite imports nothing from the engine it checks except the versioned
  constants it verifies were applied. A module was never called "correct"
  because it returned `ok:true`, because the number looked reasonable, or
  because it matched what the same engine produced last week.
- Where rounding made exact equality wrong, an explicit tolerance was stated
  rather than the assertion loosened. Where every amount was a whole number of
  euro, no tolerance was used — one would only have hidden error.
- Assertions resolve rows by **semantic identity, never array position**. A
  Phase 4 evaluator defect was reading `incomeSources[0]`; nothing here does.
- Every defect answers four questions: what was wrong, which financial or
  data-model assumption caused it, whether it could affect other modules, and
  what regression prevents recurrence.

## The defect class this phase existed to find

The House Purchase failure that opened the phase was not a one-off. Its shape
generalises, and the generalisation was the thing hunted:

> **A household aggregate and its per-owner decomposition are computed by two
> different rules that are never reconciled against each other.**

`currentCashSavings` summed every cash holding once. `cashSavingsContributions`
re-filtered the same holdings per applicant. Jointly held cash matched both
applicants and was counted twice; household-held cash matched neither and
disappeared. The engine's own contract caught it — loudly, which is why it was
findable at all.

Two things followed, and both are now closed:

1. **Wherever a module computes both a household total and a per-owner split,
   the split is asserted to reconcile to the total.** That single invariant was
   the highest-yield test in the phase.
2. **The silent version of the defect is gone.** `ownerId: 'household'` used to
   be legal on the singular-owner collections, and every per-person consumer
   matched on a person id and so could not see it: a household-owned income
   counted in `netHouseholdIncome` while contributing zero to every applicant's
   `grossAnnualIncome`. Ownership now follows what the thing is.

## Defects found and fixed

| # | Module | What was wrong | Regression |
| --- | --- | --- | --- |
| 1 | `house_purchase` | The per-owner cash split was a filter, not a partition: joint cash counted twice, household-held cash vanished | `check-module-input-contracts` |
| 2 | every module | A module crash was reported to the client as `analysis_missing_information`, with a bare `ok:false` behind it | `check-module-input-contracts` |
| 3 | `personal_balance_sheet` | The same holding supplied twice was summed silently, and `reconciliationDifference` still read zero | `check-personal-balance-sheet-audit` |
| 4 | `liquidity_analysis` | An uncomparable reserve reported as at or above target, in a positive tone | `check-liquidity-audit` |
| 5 | `liquidity_analysis` | The cohort read `primaryPerson` alone: order-dependent, and a 4× difference in target | `check-liquidity-audit` |
| 6 | `mortgage_math` | Payoff detection required exactly zero, so half of realistic mortgages were reported never repaid | `check-mortgage-math-audit` |
| 7 | `mortgage_analysis`, `loan_analysis` | A null dereference where a diagnostic belonged | `check-mortgage-math-audit` |
| 8 | every module | A profile the schema refuses surfaced as `unknown_module_failure`, not `module_input_invalid` | `check-pension-projection-audit` |
| 9 | `college_funding` | `children: []` invented a 13-year-old and produced a college plan for a dependant nobody had | `check-college-funding-audit` |

### 1. The cash split was a filter, not a partition

`cashSavingsContributions` re-filtered every cash holding per applicant instead
of dividing it between them. It now partitions: each holding is divided among
whichever applicants own it, the rows are rounded to the cent, and any residual
from rounding is placed on the largest row so the split always sums to the
household total the engine was given. **Blast radius:** any adapter deriving a
per-owner split from a household total — which is why invariant 1 above was
applied to every subsequent module.

### 2. A crash reported as missing information

Any throw inside a module run reached the client as
`analysis_missing_information`, which tells a client to supply facts they have
already supplied, and hides a defect from whoever could fix it. Phase 5 added a
structured failure vocabulary in `js/planning/module_failures.js`:
`module_input_invalid`, `module_execution_failed`, `readiness_not_met`,
`unsupported_state`, `unknown_module_failure`.

Two properties of that module matter more than the codes:

- **The classifier reads a carried code and never sniffs messages.** Message
  sniffing is how a classifier silently starts lying when an engine reworks its
  wording.
- **Two audiences are kept apart.** `detail` carries the engine's own text and
  stays server-side; `clientFailureMessage(code)` is what a client may see, and
  names no fields and no stacks.

### 3. A balance sheet that counted a holding twice

The engine guarded its buckets, its signs and its finiteness, but never that a
position appears once. The same €50,000 holding supplied twice became €100,000
of net worth — and `reconciliationDifference` still read zero, because doubling
both sides of a consistent sum keeps it consistent. Fixed by asserting position
identity, where identity is the source collection **plus** the id: a cash
holding and a business interest may legitimately share an id while being two
different things, and rejecting that would refuse a correct balance sheet.

`reconciliationDifference` is not an oracle, and the audit treats it as what it
is. The engine computes `netWorth = gross − liabilities` and then
`difference = gross − liabilities − netWorth`, so it is zero by construction
and can only catch a rounding slip. Independent arithmetic is the real check.

### 4. A gap of zero is a claim

`surplusCash` and `shortfallCash` both fell back to `0` whenever the target or
the cash could not be established, and every reader downstream decides the
household is fine by asking whether the shortfall is above zero. A household
whose monthly spending had never been captured was told, in a positive tone,
that its reserve was at or above target. Unknown is now `null` — falsy in the
same `> 0` guards those readers already use — and the engine states its own
`position`, including `'unknown'`.

### 5. The cohort ignored the partner

`resolveLiquidityCohort` read `primaryPerson` alone, so a retired client with a
working partner was told to hold 24 months of spending rather than 6 — four
times the target on the same facts — and entering the couple the other way
round produced the opposite answer. See **Product decisions** below for the
rule that replaced it.

### 6. Payoff detection was a coin flip

It required the balance to reach exactly zero, which floating-point arithmetic
reaches only by luck. Across €250,000 over 25 years at rates from 1% to 6%,
**51 of 101 runs** finished with a residue like 0.00000000012 and were reported
as never repaid — in prose, on the same screen as "Remaining balance at term
end: €0.00". The summary literally read "not fully repaid … leaving €0.00
outstanding". Money is measured to the cent, so anything below half a cent is
now settled, and the sweep is pinned as a regression.

### 7. A null dereference where a diagnostic belonged

Building an input for a profile with no matching liability threw
`Cannot read properties of null`. Readiness refuses this, so only a direct
caller reached it, but every other audited module fails with a sentence naming
what is absent. It now does too.

### 8. A malformed profile reported as an unknown failure

`runPlanningModule` normalised the profile *before* the labelled input phase, so
a profile the schema refuses — a retirement age already behind the client —
surfaced as `unknown_module_failure`, which the taxonomy defines as "treat as a
defect and read the detail". It is an invalid input and now says so.
**Blast radius: every module**, since the wrapper is shared; fixed once there.

### 9. The phantom child

`children: []` — an explicit statement that there are no children — fell
through to the legacy `childrenCount`/`childCurrentAge` path, which invented one
child aged thirteen and produced a **€20,000 today / €25,832 nominal** college
plan for a dependant nobody had. An *absent* `children` key genuinely does mean
"legacy shape"; an *empty* one means "none". They are now told apart, and the
legacy shape is verified still working. **Blast radius: college funding only** —
no other engine has a legacy-default path of this kind.

### Also closed, alongside the numbered nine

- **A liquidity buffer override of `-3` or `0` silently became the policy
  default**, so an adviser could type one figure and the illustration use
  another. The engine is deliberately forgiving, which is right for a renderer
  handling a half-filled form and wrong as the last word before a client is
  given a number. It now reports as `module_input_invalid`.
- **`college_funding` refuses an inflation rate that is not the approved
  education rate**, so the general rate can never be substituted silently.

## Deliberately not defects

Three behaviours looked wrong on first reading and were proved correct by
testing rather than by assumption. Each is now asserted in both directions, so
a later change cannot quietly turn one into a real defect.

- **A staggered-retirement household's combined pot is smaller at the later
  reference year than the sum of each pot at its own retirement.** That is the
  earlier retiree funding the household through the bridge years. Setting the
  target income to zero leaves both pots intact.
- **A retired pot shrinks slightly against pure growth.** That is ARF minimum
  drawdown, the documented post-retirement treatment.
- **A surplus year in `net_retirement_cashflow` does not offset a later
  shortfall.** Each year's gap is funded on its own terms.

And one design boundary, confirmed against the playbook rather than inferred:

- **`net_retirement_cashflow` does not read `/pensions`, and must not.** It
  compares NET spending need with NET recurring income, and exists precisely
  where pension taxation is too uncertain for a true net-income projection. A
  €20,000 gross DB pension becoming €20,000 of spendable income would
  understate the requirement by exactly the tax nobody deducted, and the answer
  would still look reasonable. Only a **stated net amount** becomes income
  there; a source carrying only `grossAnnual` is excluded rather than read as
  net. Verified structurally: cash and liquid investments reach the net fund;
  illiquid investments, investments with liquidity unstated, pension-typed
  assets, pension positions, property and business do not.

The consequence is that a DB pension can reach `pension_projection` as income
sourced from `/pensions` while `buildNetRetirementInput` never sees it. That is
the intended boundary, not a gap to close, but it is worth knowing when the two
modules' figures are read side by side.

## Product decisions taken

Two decisions belonged to the owner and were taken by the owner, not here.

- **The retired liquidity guide applies only when every adult has retired.**
  That is what the policy's own wording says ("a working household", "a retired
  household") and why the buffer is larger in retirement at all: earned income
  has stopped. A stated household retirement status still outranks the
  per-person reading.
- **Where more than one mortgage could validly be analysed, Planéir asks which
  one rather than selecting silently.** Selection uses stable entity identity,
  not array position; reversing the order of the liabilities changes nothing.
  `selectLiabilityOfType` returns the candidates and whether the choice is
  ambiguous, with no first-match fallback.

## Ownership model, as it now stands

| Thing | Owner field | Arity | `'household'` |
| --- | --- | --- | --- |
| `employment`, `self_employment` income | `ownerIds` | exactly one real person | invalid |
| `pension`, `state_pension` income | `ownerIds` | exactly one real person | invalid |
| `rental`, `other` income | `ownerIds` | one or two real people | invalid |
| pension positions | `ownerId` | exactly one real person | invalid |
| assets, liabilities, properties, businesses | `ownerIds` | one or more | **legal** |
| combined household figures | `householdIncome` (not a position) | n/a | n/a |

The pseudo-owner remains legal only on the `ownerIds` collections, where "the
household owns this" needs no per-person decomposition to be correct. A
combined household figure may answer a module contract that asks for a combined
household figure. It can never satisfy a readiness requirement for a specific
person's income.

The partition of `INCOME_TYPES` into single-owner and joint-capable is asserted
at load time, so adding an income type without deciding its ownership arity
fails immediately rather than defaulting to whichever branch runs first.

**On migrating historical state.** A legacy singular `ownerId` naming a real
person migrates silently — it is the same claim in a different shape. A legacy
`ownerId: 'household'` on a singular-owner collection does **not** migrate: it
fails loudly, because turning it into two named owners would manufacture
ownership the client never stated. One existing test pinned the old behaviour
by asserting `ownerId === 'household'` for shared income; it was rewritten to
assert both real owners, plus a new case proving a joint *salary* is refused.

## Assumptions and rules

Growth and inflation come from `PLANEIR_ASSUMPTIONS`, State Pension from
`IRISH_STATE_PENSION_CONTRIBUTORY`, and each is applied exactly once — asserted,
not assumed. Every assumption a module uses is declared back to the client with
its basis.

The ARF minimum drawdown rates were hardcoded constants in `pension_math.js` —
dated Irish rules living in a file that is not the rules file. They now sit in
the versioned catalogue as `IRISH_ARF_MINIMUM_DRAWDOWN`, read through
`irishArfMinimumRate()`, **at exactly their previous values**, pinned by a
regression asserting the drawdown result is identical to a figure recorded
before the move.

## The regression estate

Eight new suites, 166 deterministic checks, all in `npm run check:consumer`.

| Suite | Checks | What it holds |
| --- | --- | --- |
| `check-module-input-contracts.mjs` | 23 | House Purchase cash partition; the failure taxonomy |
| `check-ownership-model.mjs` | 15 | Income and pension ownership invariants |
| `check-personal-balance-sheet-audit.mjs` | 19 | PBS arithmetic; no double counting |
| `check-liquidity-audit.mjs` | 27 | Reserve arithmetic, cohort rule, stated position |
| `check-mortgage-math-audit.mjs` | 27 | Annuity engine; mortgage and loan routing |
| `check-pension-projection-audit.mjs` | 22 | Pension timing, product types, ARF relocation |
| `check-net-retirement-audit.mjs` | 18 | Net cashflow; the gross/net boundary |
| `check-college-funding-audit.mjs` | 15 | College timing, overlap peak, phantom child |

Detail worth keeping about what those checks prove:

- **Timing was measured before anything rested on it.** Pension growth periods
  equal `retirementAge − currentAge`; a contribution is made in every year where
  age is below the retirement age, so the retirement year itself receives none;
  contributions are added before that year's growth; salary escalates from the
  second year. The first/last-year off-by-one is not present in either place.
- **Product types separate.** A PRB grows but receives no contribution even when
  the record carries contribution rates. A DB pension is income exactly once and
  never a pot — proved with a DB record carrying a `currentValue` of €999,999
  that contributes nothing. State Pension never enters a funded pot.
- **The rate convention is nominal** (annual ÷ 12), applied consistently by both
  the payment function and the schedule — asserted explicitly, so a future
  switch to an effective-rate conversion has to be deliberate.
- **The college peak is a household peak.** A 17-year-old and a 14-year-old
  overlap in exactly one year, and that year is asserted to cost more than the
  final, most-inflated year — which is what a naive maximum over one inflating
  series would have returned.
- **Modules that share a basis agree.** PBS and `liquidity_analysis` draw the
  same monthly-spending basis, so their months-of-cover figures reconcile.
- **Failing closed is tested as behaviour, not hoped for.** Unknown spending
  stays `null` and blocks readiness rather than becoming zero; a child already
  past the college start age is refused rather than costed at a deflated
  past-year price; cross-currency holdings are excluded and disclosed by
  currency rather than reported as missing.

## What Phase 5 changed in production code

Engines: `college_funding_math.js`, `liquidity_reserve.js`, `mortgage_math.js`,
`pension_math.js`, `personal_balance_sheet.js`.

Planning layer: `module_failures.js` (new), `module_registry.js`, `profile.js`,
`ireland_rules.js`, `contracts.js`, `orchestrator.js`, `result_summary.js`,
`reconciliation.js`, and the `house_purchase`, `liquidity`, `mortgage`, `loan`,
`retirement`, `college_funding`, `personal_balance_sheet` and `common` adapters.

## Carried forward

Cross-cutting work that Phase 5 completed is not repeated here; what remains
open is:

- **The scenario-level invariant in `net_retirement_cashflow`.** The engine does
  not infer the link between losing an income and gaining sale proceeds — the
  scenario author states both. That is deliberate flexibility, and keep-versus-
  sell is proved to work exactly once in each direction. But it means a
  malformed scenario could state one without the other. Best folded into
  whatever next touches scenarios.
- **Whether the profile schema should keep admitting `'household'`** on the
  `ownerIds` collections indefinitely. It is correct there today; the question
  is whether it stays worth the exception.

Carried forward from Phase 4, and not reopened by this phase:

- **A.** Deterministic evidence rules versus natural speech. The likely
  long-term direction is semantic interpretation plus exact transcript
  evidence plus deterministic ownership validation, rather than enumerating
  regex phrasings. Not a calculation concern.
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
  household. Both are reflected in how the Phase 5 tests assert.
