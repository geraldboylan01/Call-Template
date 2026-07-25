# Consumer Readiness Review

Reviewed 2026-07-25 as part of P2b. Scope: the three engine modules that were
consumer-gated but look consumer-suitable — Mortgage Analysis, Pension
Projection and College Funding.

**Having an engine is not approval.** Each module was assessed against the eight
criteria already applied to the live consumer modules, from the adapter code
rather than from intent.

**Outcome after the 2026-07-26 assumption approvals: all four approved.**

| Module | Outcome | Platform-approved | Adviser-enabled by default |
|---|---|---|---|
| Mortgage Analysis | **Pass** | ✅ | ✅ |
| Loan Analysis | **Pass** | ✅ | ✅ |
| Pension Projection | **Pass**, once assumptions were centrally approved | ✅ | ✅ |
| College Funding | **Pass**, once cost scenarios were centrally approved | ✅ | ✅ |

The two remediation items raised on 2026-07-25 were both assumption-approval
decisions rather than engineering defects, and both were resolved by the
centrally approved Planéir assumptions in
[planeir_assumptions.js](../js/planning/planeir_assumptions.js). The original
findings are kept below because they record why each module was gated.

**Still gated:** `net_retirement_cashflow` has a runnable engine but has not been
reviewed, so it stays invisible to consumers. Having an engine is never approval.

Mortgage Analysis and Loan Analysis are **separate modules, not aliases**:
mortgages, term changes, switching and overpayments on one side; car, personal
and other non-mortgage debt with repayment acceleration on the other.

---

## Mortgage Analysis — PASS

| Criterion | Finding |
|---|---|
| Complete, validated input contract | 5 semantic facts, all with definitions and prompts; contract `approved` |
| Deterministic output | `computeMortgageProjection`, covered by `tests_mortgage_math.js` and `check-consumer-planning` |
| Consumer-safe language | readiness reasons are plain: "Add the mortgage balance", "Add the current annual interest rate" |
| Appropriate disclosures | discloses the repayment-type assumption and warns that interest-only is unsupported; cross-currency warnings surface |
| No unsupported personalised recommendation | amortisation comparison only; recommends no product or action |
| Tested voice and typed collection | every fact has a conversational prompt; exercised by the routing golden fixture |
| Error and missing-data behaviour | per-field `requiredMissing` with a specific reason for each |
| Output rendering | `generated.mortgageInputs` with a `state.js` normalizer and playbook `12_mortgage_playbook.md` |

**Scope limit, disclosed not blocking:** interest-only mortgages are out of
scope in v1. The adapter says so in a warning that reaches the client.

## Pension Projection — APPROVED 2026-07-26 (was: remediation required)

**Resolved.** Growth of 5% and inflation of 2% are now centrally approved,
versioned Planéir assumptions, stated as planning assumptions with the
medium-risk diversified-portfolio basis and an explicit "not a guaranteed
return" disclosure. Neither consumers nor advisers can override them.

**Original blocking items:**

1. **Growth and inflation defaults are unapproved for consumer use.** The
   adapter attaches 5% investment growth and 2% inflation with the reason
   *"Existing pension engine default; review before consumer activation"*
   ([retirement.js:85](../js/planning/adapters/retirement.js:85)). That marker is
   an explicit instruction not to ship these to consumers unreviewed, and a
   projection is only as safe as the assumptions driving it. Needs an approved,
   dated assumption set.
2. **Employer-contribution question for the self-employed.** Fixed in P2b via
   the `pension_employer_contribution_rate` precondition, which skips the
   question for `self_employed` and `contractor`. Listed because it was a
   genuine blocker at review time.

Strong points worth recording: the State Pension rule is dated
(`effective January 2026`), capped to the gross maximum, and carries the PRSI
caveat; and the pre-tax nature of the projection is disclosed with a pointer to
the separate net retirement view.

## College Funding — APPROVED 2026-07-26 (was: remediation required)

**Resolved.** Two standard scenarios are now centrally approved — living at home
at €5,000 a year and living away at €15,000 a year, in today's money, four years
per child — projected at 4% education inflation with the explanation that
education costs tend to rise faster than general consumer prices. Output is
presented as planning estimates, not guaranteed future costs.

**Original blocking item:**

1. **No approved cost scenarios.** The adapter refuses readiness with *"Add at
   least one explicit annual-cost scenario; consumer defaults are not yet
   approved"* and warns that *"College costs must use reviewed, date-versioned
   scenarios before this module is enabled for consumers"*
   ([college_funding.js:31](../js/planning/adapters/college_funding.js:31)).
   Start age 18 and duration 4 years are likewise flagged as defaults "for a
   future consumer release".

The module cannot produce a meaningful consumer figure without a reviewed cost
basis, and the code already says so. Everything else — determinism, rendering,
per-child missing-data handling — is in place.

---

## Not reviewed

`loan_analysis` was approved on 2026-07-26 alongside the others; it shares
`mortgage_math.js` with Mortgage Analysis, which had already passed.

`net_retirement_cashflow` remains `not_reviewed` and invisible to consumers. It
is the obvious next candidate, and its review should cover how its after-tax
projection is presented alongside the pre-tax pension projection.

## How this is enforced

Recorded in each manifest as `consumerReadiness.status` plus `blockingItems`,
and bound by the build:

- `platformConsumerApproved` requires `consumerReadiness.status === 'approved'`;
- `platformConsumerApproved` requires a runnable engine;
- `adviserConsumerEnabled` requires `platformConsumerApproved`;
- the legacy `availability.consumer` must equal the derived value.

`validateAdviserConsumerToggle` applies the same rules server-side, so a UI or
API cannot enable an unreviewed module such as `net_retirement_cashflow`, or a
module with no engine such as `protection_analysis`, for consumers.

An adviser may disable any approved module for their own consumer journey;
disabling only narrows what a consumer sees and needs no gate.
