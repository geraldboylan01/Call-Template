# Consumer Readiness Review

Reviewed 2026-07-25 as part of P2b. Scope: the three engine modules that were
consumer-gated but look consumer-suitable — Mortgage Analysis, Pension
Projection and College Funding.

**Having an engine is not approval.** Each module was assessed against the eight
criteria already applied to the live consumer modules, from the adapter code
rather than from intent.

**Outcome: 1 approved, 2 require remediation.**

| Module | Outcome | Platform-approved |
|---|---|---|
| Mortgage Analysis | **Pass** | ✅ |
| Pension Projection | **Remediation required** | ❌ |
| College Funding | **Remediation required** | ❌ |

Platform approval is not enablement. Mortgage Analysis is approved but ships
with `adviserConsumerEnabled: false`, so **no consumer-facing behaviour changes
until an adviser switches it on**.

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

## Pension Projection — REMEDIATION REQUIRED

Passes seven criteria. Blocked on disclosures.

**Blocking items:**

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

## College Funding — REMEDIATION REQUIRED

**Blocking item:**

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

`net_retirement_cashflow` and `loan_analysis` have engines but were outside the
requested scope. Both are recorded `not_reviewed` and remain invisible to
consumers. `loan_analysis` looks like the strongest next candidate: it shares
`mortgage_math.js` with the module that passed.

## How this is enforced

Recorded in each manifest as `consumerReadiness.status` plus `blockingItems`,
and bound by the build:

- `platformConsumerApproved` requires `consumerReadiness.status === 'approved'`;
- `platformConsumerApproved` requires a runnable engine;
- `adviserConsumerEnabled` requires `platformConsumerApproved`;
- the legacy `availability.consumer` must equal the derived value.

`validateAdviserConsumerToggle` applies the same rules server-side, so a UI or
API cannot enable Pension Projection or College Funding for consumers while
their remediation is outstanding.
