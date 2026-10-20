# Plan pack v1: authoring contract

Implemented 19 October 2026. B0 checks whether a route can be compiled through the existing calculators. A `compiled` result says nothing about affordability, goal coverage or how much cash should be reserved. The resource ledger is explicitly `not_computed`; B1 supplies those decisions. B1 is available explicitly with `--ledger`; its contract is below. Neither mode activates a plan screen or consumer routing.

## Run locally

```sh
npm run check:plan-pack -- scripts/fixtures/plan-packs/valid-small.json
npm run check:plan-pack -- scripts/fixtures/plan-packs/requires-b1.json
npm run check:plan-pack-fixtures
node scripts/check-plan-pack.mjs scripts/fixtures/plan-packs/valid-small.json --json
```

The first example succeeds. The second reports `requires_resource_ledger` and exits 1. Invalid packs and engine refusals also exit 1. For machine-readable stdout, invoke Node directly; npm prints its own command banner. Native renderer diagnostics go to stderr.

`--output <new-file.json>` saves the complete result, including diagnostics. It creates a new file exclusively: it cannot overwrite the source, an existing output or an existing symlink. An unresolved or invalid result is saved only as a diagnostic artifact, with `casePacks: null`. No model calls, network access or paid services are used.

## Schema and ownership

The executable schema is `js/planning/plan_pack/schema.js`, shared by the compiler and CLI. Its strict runtime normalizer is the authority; this document describes the same contract rather than defining a second validator. It delegates household validation to `normalizeHouseholdProfile` and engine validation to the existing module pipeline. Unknown fields and unknown versions fail. JSON must contain finite numbers and ordinary objects, without prototype keys or executable values.

| Top-level field | Contract |
|---|---|
| `planPackVersion` | Required, exactly `1`. |
| `clientName` | Required non-empty display string. |
| `calculationDate` | Required valid `YYYY-MM-DD`, equal to `household.assumptions.calculationDateIso`. Dated builders use this value, not the machine's current year. |
| `household` | Required canonical HouseholdProfile v1. IDs and current financial facts live here once. Fields the household normalizer would discard are refused, including unsupported aliases and explicitly null optional fields it omits. All money must be EUR. |
| `planningInputs` | Optional strict transition object, described below. No per-chapter payloads, calculated outputs or arbitrary fields. |
| `goalFlexibility` | Optional object keyed by existing goal ID. Each field is a two-element inclusive `[minimum, maximum]` range. |
| `routes` | Required array: `current` first, no changes; up to three alternatives. Unique IDs matching `[a-z][a-z0-9_-]{0,63}`. B0 preserves input order; B1 applies the neutral order below. |
| `chapters` | Required non-empty array of distinct chapter IDs from the table below, in author order. |
| `narration` | Optional object keyed by existing route ID, containing non-empty template strings. |

Canonical profile examples are in `scripts/fixtures/plan-packs/valid-small.json`. Profile and financial assumptions remain subject to their existing validators. Existing adviser adapters may use central defaults: their readiness assumptions and warnings are retained in the output. This is not a new assumptions catalogue.

## Transition facts

All monetary numbers below are annual EUR unless specified otherwise. They are stated facts or explicit author choices, never a second copy of a chapter's results.

| `planningInputs` field | Contract |
|---|---|
| `takeHomeBasis` | When cash flow or protection is requested, exactly `after_personal_pension`: net income is the amount reaching the bank after today's personal pension deduction. |
| `spendingBasis` | When cash flow or protection is requested, exactly `regular_costs_including_debt_excluding_tax_and_pensions`. `household.expenses.annualTotal` must be stated. Essential spending alone is insufficient. |
| `spendingLabel` | Author-supplied wording for spending left after identified debt payments. Required by cash flow. Copied verbatim, subject to the native module's existing input limits; never shortened or recategorised. |
| `householdTaxStatus` | Cash flow requires `single`, `married_or_civil_partners` or `widowed_or_surviving_civil_partner`. A partner record does not establish joint assessment. |
| `personalPensionContributions` | Array of `{personId, annualAmount}`; unique owners, non-negative amounts including confirmed zero. Only for a person whose current personal contribution is not already represented by employee rates on profile pensions. Employer contributions are not a bank deduction. |
| `cashAssetId` | Existing cash-asset ID funding route changes. Optional when there is exactly one cash account; otherwise required for cash use. |
| `outgoingBindings` | Array of `{id, liabilityId, label?}`. Each ID and liability is unique. Outgoing IDs use lowercase letters/digits/underscores; `tax`, `pensions`, `left_over` and `living` are reserved. Label defaults to the unchanged liability label. |
| `goalBindings` | Array of `{goalId, personId?, liabilityId?}`. Unique goal IDs. Retirement-age moves identify their person (implicit only in a one-person household). A debt binding must match the goal and liability type. |
| `chapterGoals` | Object mapping a chapter ID to its existing goal ID. Pension, net retirement and college require an unambiguous relevant goal; multiple goals are never resolved by array order or priority. |
| `protectionCases` | Up to three `{id, event}` records beside code-owned `today`. Event fields are `type`, `personId`, `statePayment`, `survivorsPension`, `neededAfter`, `neededBecause`; the native protection validator applies. A State payment may be explicitly zero. No hypothetical benefit is selected automatically. |
| `leftOverEachYear` | Signed stated annual left over before goal-saving transfers, used only without the cash-flow chapter. Refused if that chapter is present, because cash flow owns this result. B1 requires it when cash flow is absent. |

Current pension rates use each owner's recorded employment income. Paid-up/non-contributing positions and pension types without personal contributions are handled explicitly; missing contribution facts require confirmation. Cash flow may use its native estimate where complete per-person bank pay is absent; the result says `includes_estimated_bank_pay` and emits a warning. A stated zero is never replaced by an estimate. Protection requires stated bank income per actual person and refuses missing or joint amounts rather than splitting a household total.

Protection remains the existing manual illustration. It does not recalculate the partner's tax for an illness event. Central Illness Benefit, its duration and scenario-specific tax are B2 work described in the implementation plan. A changed spending route with a previously stated post-death spending amount is refused until that route has an explicit spending basis.

## Route changes

A route is `{id, title?, changes?}`. Titles use neutral wording and existing provider/recommendation restrictions. Every alternative starts from a fresh clone of the same opening household. Changes never accumulate across alternatives.

```json
{
  "id": "clear_car",
  "title": "Clear the car loan",
  "changes": [
    {"type": "clearOutgoing", "outgoingId": "car", "paidFrom": "savings"}
  ]
}
```

These change families are accepted:

- `useCash`: `{type, goalId, amount}`. Amount is a positive whole-euro number, `whole` or `remaining`. Numeric amounts can fund a bound debt in B0. Other goals and symbolic amounts report B1 `requires_resource_ledger`.
- `clearOutgoing`: `{type, outgoingId, paidFrom: "savings"}`. Uses the referenced liability's opening balance. The household cash balance and debt are reduced once; a fully cleared debt removes its contractual payment from annual spending. Partial cash repayments retain the contractual payment and let the amortisation engine calculate the changed term.
- `sellAsset`: `{type, assetId}`. B1 only: sell one entire investment holding; proceeds are calculated after tax and selling costs and deposited in the selected cash account. Duplicate sales, assigned assets, funds/ETFs and unknown tax treatment are refused. Partial lots are outside v1.
- `moveGoal`: `{type, goalId, retirementAge?, targetIncomeToday?, clearByAge?, targetDate?, targetAmount?}`. At least one field, each within the goal's stated flexibility. Ages are whole years; money is non-negative EUR; dates are valid ISO dates. Retirement fields require a retirement goal; use `targetIncomeToday`, not `targetAmount`, for its annual income target. `clearByAge` requires a mortgage goal. Dated/non-retirement funding changes require B1. Retirement ages cannot precede the person's current age or exceed 100; goal dates cannot move into the past.

Repeated/conflicting changes, two goals changing the same person's retirement age, funding a liability twice, spending beyond its balance or overdrawing the selected cash account are refused. B0's cash bookkeeping does **not** protect an emergency reserve or determine spendable surplus. Those are B1 calculations, so a successful B0 route must not be presented as affordable.

## Chapter builders

| Chapter ID | B0 behaviour |
|---|---|
| `personal_balance_sheet` | Existing adviser adapter and published-session payload builder. |
| `liquidity_analysis` | Existing cash-reserve adapter and central reserve policy. Its reserve illustration is not a plan allocation. |
| `household_cash_flow` | Adviser-only transition builder, current contributions, native cash-flow/tax engine. No consumer adapter registration. |
| `protection_gap` | Adviser-only transition builder, stated per-person bank pay and confirmed manual payment cases. |
| `mortgage_analysis` | Existing mortgage builder/engine; current contractual payment is retained. Explicit route cash is a native comparison against the opening debt. |
| `loan_analysis` | Same boundary through the existing loan builder; its current selector supports loans, not credit-card analysis. |
| `pension_projection` | Existing pension builder and engine; selected retirement target and person's bounded age change are applied to its profile view. |
| `net_retirement_cashflow` | Existing builder for stated spending and income streams. A moved-goal route reports B2 `requires_profile_adapter`, since the adapter does not price that changed target. |
| `college_funding` | Existing adviser builder and engine, using the explicitly selected education goal. |
| `future_cost_fund` | B2 `requires_profile_adapter`: the existing payload pipeline has no explicit pack-date input. The compiler does not substitute the system year. |
| `goals_and_resources` | B1 `requires_resource_ledger`. Its engine's derived funding cases cannot be authored, chosen by proximity or relabelled as a different route. |

Property chapters are outside v1 and fail validation. Insufficient facts produce an `invalid` result with `missing_information` at their source path; the author can supply those facts without waiting for a later implementation. An unsupported income type reports the later builder needed. Ambiguous chapter goals/debts require an explicit selection. Native engine refusals remain failures, and calculated non-finite totals cannot be serialized as null or zero.

## Compiled result and provenance

`status` is `compiled`, `invalid` or `requires_later_stage`. A successful result contains:

- `source`: normalized author pack once, with a stable hash.
- `versions`: compiler, central assumptions, Irish tax rules and Irish rules catalogue versions; the explicit calculation date is retained separately.
- `routes[].chapterCases`: exact chapter-to-case ID mappings, with source changes and resolved narration.
- `chapters[].cases[]`: input and input hash, original calculator payload, derived engine output, typed metrics, native case ID, assumptions, warnings and provenance.
- `casePacks[]`: one existing version-1 case pack per route, each checked through `checkCasePack` before export.

Distinct cases are hashed from their financial input, chapter, calculation date and versions. Route titles and narration do not change financial case IDs. Equal settings reuse one case; at most four cases per chapter. `provenance.uses` records every referencing route and its exact change pointers. `builderHousehold` preserves the actual profile view used for the first matching case, including adapter-specific selections/overrides. The compiled native input and recorded cash-assignment assumption retain B1’s balance-sheet purpose split; the publisher receives that same validated input instead of rebuilding the unsplit profile. Together with the original normalized source, transition inputs, builder version and compiled input snapshot, this makes the adapter boundary reproducible without pretending that a derived input was a separately stated client fact.

Plan case IDs identify different compiled input settings. `nativeCaseId` identifies the selected case *inside* that calculator, such as `route` versus `current` for a mortgage cash comparison. Protection's today/illness/death cases remain native event cases. B3 must respect both mappings when building a linked screen; loading separate case packs today does not implement linked route selection.

Any invalid route suppresses all compiled chapters and exports. A later-stage requirement may retain completed chapters for diagnostics, but `casePacks` remains null until every requested route and chapter compiles. No partial plan is exported as a success.

## Narration placeholders

The AI/author supplies prose. Code validates templates, substitutes registered results for that route, and escapes the complete rendered string for HTML. There is no expression evaluation, arbitrary object traversal, cross-route reference, label repair or natural-language paraphrasing.

Literal digits, currency symbols and percentages are refused. Literal calculated conclusions `covered`, `affordable`, `balanced` and `recommended` are refused, alongside existing module wording/provider restrictions. These syntactic checks are not an AI semantic review; B4 still owns final authoring instructions and sentence quality.

Use `{route.cashUsed}`, `{route.goalsMoved}`, `{route.goalChangeCount}`, `{plan.calculationDate}` and requested-chapter metrics below:

| Prefix | Registered metric suffixes |
|---|---|
| `household_cash_flow` | `income`, `bankTakeHome`, `tax`, `pensions`, `leftOver` |
| `liquidity_analysis` | `currentCash`, `monthlyExpenditure`, `monthsCovered`, `minimumCash`, `targetCash`, `surplusCash`, `shortfallCash` |
| `personal_balance_sheet` | `grossAssets`, `totalLiabilities`, `netWorth`, `spendableReserves`, `reserveMonths` |
| `mortgage_analysis`, `loan_analysis` | `monthlyPayment`, `totalInterest`, `interestSaved` |
| `pension_projection` | `requiredPot`, `projectedPot`, `retirementYear` |
| `net_retirement_cashflow` | `requiredFundToday`, `availableInvestmentFundToday` |
| `college_funding` | `firstCollegeYear`, `finalCollegeYear`, `fundingPeriodYears` |
| `protection_gap.<native-event-id>` | `moneyIn`, `gap`, `months` |

Money uses EUR formatting to cents; counts and durations use number formatting; calendar years have no thousands separator. Goal names and dates are text. Missing computed values fail: for example an unbounded protection runway has no finite `months` placeholder. Unknown paths and malformed braces fail even when another chapter requires a later stage.

Example: `This route uses {route.cashUsed} of savings. It leaves {household_cash_flow.leftOver} each year.` Figures in templates must come from the registry. This is a local contract example, not the B4 authoring playbook or a prompt-pack rollout.


## B1: explicit resource checks

Updated 20 October 2026. Run the joined example and the independent regression checks:

```sh
npm run check:plan-pack -- scripts/fixtures/plan-packs/valid-b1.json --ledger
npm run check:plan-resource-ledger
```

The programmatic equivalent is `compilePlanPack(pack, {resourceLedger: true})`. Check `scope` and `resourceLedger.stage/status`; a B0 result with `not_computed` must never pass as a resource-checked plan. The schema version remains 1; the compiler is versioned independently. B3 must require the resource check.

Additional transition facts are strict and optional until the relevant goal needs them:

| Field | Contract |
|---|---|
| `goalFundingFacts` | Unique goal IDs. `{goalId, kind?, dependantId?, currentAnnualSaving?, costKind?, durationYears?, debtTarget?}`. Only fields used by that goal's funding kind are accepted. |
| `assetAssignments` | Unique assets: `{assetId, goalId}`. Existing cash assigned to a dated/college goal remains an asset but is unavailable to any other goal or the reserve. Cash committed to dated spending is shown under Lifestyle in the balance sheet, with its original label and total value preserved; Liquidity contains only free cash. This follows explicit funding facts, with no label inference. Other assignment kinds need B2. |
| `goalSavingBasis` | `excluded_from_regular_costs`: stated regular spending and left over exclude goal-saving transfers. Current saving is counted separately, once. Required for dated goals. |
| `goalFundingLabel` | Author wording for the cash-flow transfer row, required when goal saving is positive. No label rewriting. |
| `retirementIncomeBasis` | `net`, with explicit household tax status, when retirement is priced. |
| `openingTaxState` | Optional canonical shared-engine history keyed by actual person IDs. Each route receives a fresh copy; alternatives never inherit each other's gains/losses. Unknown/discarded fields fail. |

An education goal normally binds one child by `dependantId`, with `currentAnnualSaving` including explicit zero. It uses central college assumptions and the profile's chosen college scenario; the goal may supply its own annual cost/date. An explicitly dated cost uses `kind: dated_cost`, its goal amount/date, `costKind` (`general` or `education`), positive whole `durationYears`, and current annual saving. The native future-cost fund prices it. Multiple college goals cannot price the same child twice.

A debt goal names its liability and the person whose age defines the target. Its target is the goal's future date, a bounded `clearByAge` move for a mortgage, or the explicit fact `debtTarget: current_contract`. Date-based debt targets use calendar-year offsets; current contracts use the remaining term rounded up to whole years. One liability cannot be priced by two goals. A partial debt-balance target (`targetAmount`) needs a later adapter; it is not silently treated as full clearance. Native amortisation determines the extra repayment and `whole` cash requirement. A cash payment on a goal already met by the current contract keeps that repayment schedule and shortens the loan.

Retirement timing uses each named person’s retirement age; a goal `targetDate` needs a later date-to-age adapter. Quantitative targets on informational goals also require a funding contract. Unsupported goal fields never disappear from the pricing.

One combined household retirement goal uses the existing contribution search and pension/shared-tax engines, preserving each member's own retirement age. Growth counts gross contributions; yearly requirements count their extra cost after relief. Today's pension deduction is already in bank pay. Different named personal increases are retained separately; joint changes cannot overlap either person's own change. If protection is requested after a pension change, cash flow must also be present so protection gets the resulting per-person bank pay. Protection's native whole-euro input boundary is explicitly rounded; the ledger, tax and cash allocation retain full precision and the rounding is recorded in provenance.

The resource order is cash-flow deficit, opening central-policy reserve, explicit outgoing clearances, loan funding, dated costs by start date, mortgage and retirement. Goal priority does not reorder this method. `whole` resolves the native amount needed today. `remaining` takes only cash left after explicit/whole commitments, up to the goal's limit. Cash is never borrowed from the reserve. Annual left over is held constant, including years between different retirement dates; it is a funding assumption throughout. No future salary rise or loan-expiry windfall is credited. Each dated goal's saving ends when its cost starts. No accumulated annual surplus is silently turned into an opening lump sum.

`current` keeps actual payments, saving and pension deductions, with no new goal funding. It can compile while short or while goals remain unmet. Alternatives apply the required payments for their targets and must protect the reserve and balance every model year. An unbalanced alternative returns `unbalanced_route`, retains its diagnostic ledger and exports no case packs. A relief-capped retirement goal can have affordable contributions and an unmet target: `balanced` and `goalsCovered` are separate results.

Each ledger retains the reserve input/result, cash opening/allocated/remaining, hypothetical investment valuation and explicit sales, fixed goal order, yearly requirements/planned amounts/allocations/shortfalls, goal states and native pricing input/results. Goal state is `covered`, `partly` or `not`; the shared native `stateWord` supplies “Covered”, “Partly covered” or “Not covered” to narration and human output. Timeline fields remain offsets: `firstShortYear`, `firstMoneyYear`, `coveredFromYear`; the narration registry converts available timeline values to calendar years. Current debt/pension requirements describe the extra funding the target needs; planned zero records that those increases are not being made today. Current's budget shortfall is separate from its unmet funding requirements.

Route order is current first, then cash committed, number of distinct changed entities, then author order for ties. No outcome score ranks routes. Ledger-only annual funding changes are recorded separately from authored changes.

### Investment-sale facts and disclosure

Canonical investment assets retain optional `baseCost` and `sellingCosts` EUR money, `acquisitionDate`, `saleInterest` and `investmentTaxTreatment` (`ordinary_cgt`, `fund_exit_tax`, `unknown`). These fields are refused on non-investment assets. Current market value and actual owners are required to price a sale. A known ordinary-CGT asset with missing base cost uses the approved €0 assumption; a supplied zero remains distinguishable as stated. If the acquisition date is missing, no indexation is assumed. Property-only reliefs never apply to this event.

The shared tax engine accepts `investmentDisposal` and settles all explicit sales in one route together, using its dated rates, losses and one annual exemption per person. The current rate's announced/enacted status remains visible. The ledger adds only net proceeds, removes the sold holding's value, and preserves a prominent disclosure: “Base cost not supplied. This illustration assumes a €0 base cost, so the full sale value is treated as a gain before applicable costs and allowances.” This is an illustration assumption, not a statement of actual tax cost. Existing disclosures explain the scope and other gains/losses excluded from the estimate.

Unallocated holdings and one hypothetical sale batch appear separately. That batch is priced from opening history and is never another cash resource or a second tax allowance. Funds/ETFs and unknown treatment stay visibly unpriced and cannot fund a route without their later tax adapter. Selling an assigned asset requires a later reassignment contract. The existing asset-intake question asks for base cost only when exploring a sale and states it is optional. Automatic sale routing and a dedicated asset form remain intake work.

B1 narration adds `{ledger.cashAvailable}`, `{ledger.reserve}`, `{ledger.cashRemaining}`, `{ledger.yearlyRemaining}`, `{ledger.balanceStatus}` and `{goals.<goalId>.state}`, `{goals.<goalId>.firstShortYear}`, `{goals.<goalId>.firstMoneyYear}`, `{goals.<goalId>.coveredFromYear}`. Missing timeline values fail if referenced; never invent a date. All references remain within the route.

The native goals screen still needs B2's exact route adapter, and the future-cost-fund screen still needs an explicit dated input boundary. A priced ledger does not relabel an existing native case or complete those screen adapters. Illness tax/duration and automatic consumer profile routing also remain B2; the linked plan view is B3 and AI authoring is B4.
