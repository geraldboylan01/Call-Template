# Module Catalogue Reconciliation

Requested before P2, to establish that the manifest registry represents the
**complete** Planéir catalogue and cannot narrow the adviser portal. P2 is
blocked until the corrective action in §7 lands.

**Headline: the nine manifests authored in P1 were selected by the wrong
criterion.** I filtered on `intakeContract.status === 'approved'` — a measure of
*consumer intake readiness* — and treated the result as the catalogue. It is
not. Sixteen modules are registered; six adviser-available modules have no
manifest.

---

## 1. Why only nine manifests were created

[generate-module-manifest.mjs](../scripts/generate-module-manifest.mjs) was
authored against the set of modules with an approved intake contract, because
P1's parity assertion compares `requiredFacts` to
`intakeContract.semanticFactIds`, and a module with an incomplete contract has
none to compare.

That is a defensible criterion for *"which modules can the consumer conversation
collect facts for"*. It is the wrong criterion for *"what is in the catalogue"*,
and I did not distinguish the two. The result silently dropped every
adviser-only and template-only module.

The error is one of framing, not of data: nothing was mis-derived, but the
selection excluded two-fifths of the registry without saying so.

---

## 2. Complete inventory

### 2.1 Registered planning modules — 16

| # | Module id | Status | Intake | Engine | Adviser | Consumer | Consumer-routable | Manifest (P1) |
|---|---|---|---|---|---|---|---|---|
| 1 | `personal_balance_sheet` | beta | approved | yes | ✅ | ✅ | ✅ | ✅ |
| 2 | `liquidity_analysis` | active | approved | yes | ✅ | ✅ | ✅ | ✅ |
| 3 | `house_purchase` | beta | approved | yes | ✅ | ✅ | ✅ | ✅ |
| 4 | `pension_projection` | beta | approved | yes | ✅ | ❌ | ✅ | ✅ |
| 5 | `net_retirement_cashflow` | beta | approved | yes | ✅ | ❌ | ✅ | ✅ |
| 6 | `mortgage_analysis` | beta | approved | yes | ✅ | ❌ | ✅ | ✅ |
| 7 | `loan_analysis` | beta | approved | yes | ✅ | ❌ | ✅ | ✅ |
| 8 | `college_funding` | beta | approved | yes | ✅ | ❌ | ✅ | ✅ |
| 9 | `retirement_goal_analysis` | beta | approved | **no** | ✅ | ❌ | **orphaned** | ✅ |
| 10 | `protection_analysis` | unsupported | incomplete | no | ✅ | ❌ | ❌ | **❌ MISSING** |
| 11 | `cat_analysis` | adviser_only | incomplete | no | ✅ | ❌ | ❌ | **❌ MISSING** |
| 12 | `business_owner_analysis` | adviser_only | incomplete | no | ✅ | ❌ | ❌ | **❌ MISSING** |
| 13 | `business_relief_analysis` | adviser_only | incomplete | no | ✅ | ❌ | ❌ | **❌ MISSING** |
| 14 | `business_owner_relief` (legacy) | adviser_only | incomplete | no | ✅ | ❌ | ❌ | **❌ MISSING** |
| 15 | `agricultural_relief` | adviser_only | incomplete | no | ✅ | ❌ | ❌ | **❌ MISSING** |
| 16 | `scenario_analysis` | unsupported | incomplete | no | **❌** | ❌ | ❌ | ❌ (correctly — see §4) |

`adviserAvailable` is true for 15 of 16 — every module except `scenario_analysis`.
**The manifests therefore cover 9 of 15 adviser-available modules.**

### 2.2 Deterministic calculation engines — 8

Modules with a live `run()`: `liquidity_analysis`, `house_purchase`,
`pension_projection`, `net_retirement_cashflow`, `mortgage_analysis`,
`loan_analysis`, `college_funding`, `personal_balance_sheet`.

Backing code: [liquidity_reserve.js](../js/liquidity_reserve.js),
[house_purchase/](../js/house_purchase/) (6 files),
[pension_math.js](../js/pension_math.js),
[net_retirement_math.js](../js/net_retirement_math.js),
[mortgage_math.js](../js/mortgage_math.js) (serves both mortgage and loan),
[college_funding_math.js](../js/college_funding_math.js),
[personal_balance_sheet.js](../js/personal_balance_sheet.js).

`retirement_goal_analysis` is registered and has an approved intake contract but
**no engine** — consistent with the integration plan calling it a routing label
rather than a second retirement engine.

### 2.3 Adviser portal capability — a separate axis

**The adviser portal does not import `module_registry` at all.** Its flow is
dictation → prompt pack → Dev Panel JSON → [state.js](../js/state.js)
`normalizeGenerated` → [render.js](../js/render.js). Verified by grep: no
`js/planning/*` import exists in `js/state.js`, `js/render.js` or `js/app.js`.

Renderable payload keys (17): `summaryHtml`, `assumptions`, `outputs`, `tables`,
`outputsBucketed`, `charts`, `pbsInputs`, `liquidityPlan`, `pensionInputs`,
`collegeFundingInputs`, `housePurchaseInputs`, `netRetirementInputs`,
`mortgageInputs`, `loanInputs`, `education`, `report`, `videoSummary`.

Adviser playbooks carrying a module marker (9):
`personal_balance_sheet`, `pension_projection`, `mortgage_analysis`,
`loan_analysis`, `college_funding`, `net_retirement_cashflow`,
`liquidity_analysis`, `house_purchase`, **`protection_analysis`**.

Non-module playbooks: Education (20), Report (21), plus the core contract,
aliases, schema matrix and Irish tax overlay.

Two adviser capabilities exist as payload keys with no planning-module identity
at all: **Education** (`generated.education`) and **Video summary**
(`generated.videoSummary`).

### 2.4 The narrowing funnel

```
16 registered
→ 15 adviserAvailable
→  9 approved intake contract          ← the P1 manifest set
→  8 with a deterministic engine
→  8 reachable by goal routing
→  3 consumerAvailable
→  2 permitted by CONSUMER_ALLOWED_MODULE_IDS ("house_purchase,liquidity_analysis")
```

Only two modules can actually reach a consumer today. Anything that treats the
manifest set as "the catalogue" is reasoning about the wrong layer.

---

## 3. Master-prompt list vs the manifests

The ten named modules, reconciled:

| # | Master prompt | Registry id | Manifested |
|---|---|---|---|
| 1 | Personal Balance Sheet | `personal_balance_sheet` | ✅ |
| 2 | Liquidity Analysis | `liquidity_analysis` | ✅ |
| 3 | House Purchase Planner | `house_purchase` | ✅ |
| 4 | Pension Projection | `pension_projection` | ✅ |
| 5 | Retirement Goal Analysis | `retirement_goal_analysis` | ✅ |
| 6 | **Scenario Analysis** | `scenario_analysis` | ❌ — capability, see §4 |
| 7 | Mortgage Analysis | `mortgage_analysis` | ✅ |
| 8 | **CAT Analysis** | `cat_analysis` | ❌ |
| 9 | **Business-owner Relief** | `business_owner_relief` **and** `business_relief_analysis` | ❌ |
| 10 | **Agricultural Relief** | `agricultural_relief` | ❌ |

**The "nine of ten with one missing" framing does not hold.** The two sets
overlap without either containing the other:

- Six of the master-prompt ten are manifested; **four are not**.
- Three of my nine — `net_retirement_cashflow`, `loan_analysis`,
  `college_funding` — are not in the master-prompt ten at all.

### The missing tenth module: `protection_analysis`

If the question is *which single real module is absent from both lists*, the
answer is **Protection analysis**. It is:

- registered in `module_registry.js` (`adviserAvailable: true`);
- the subject of a full adviser playbook,
  [22_protection_playbook.md](prompt-pack/22_protection_playbook.md);
- present in the generated playbook manifest with `outputKey: generated.report`;
- named in the integration plan's registry policy;
- **absent from the master-prompt ten and from the P1 manifests.**

It is a live adviser module that both inventories overlooked.

---

## 4. Scenario Analysis is a capability, not a module

The integration plan states it directly
([consumer-ai-journey-integration-plan.md §7](consumer-ai-journey-integration-plan.md)):

> `scenario_analysis` is a composition capability over scenario-aware modules; it does not calculate independently.

The code agrees. `scenarioOverrides` is threaded through
[orchestrator.js:38](../js/planning/orchestrator.js:38) `scenarioFor()`, which
resolves per-module or flat overrides, into every adapter via
[common.js:145](../js/planning/adapters/common.js:145), and is hashed into
`scenarioSnapshotHash` at
[module_registry.js:836](../js/planning/module_registry.js:836). Retirement
adapters take a `scenarioId`; House Purchase takes overrides directly.

The `scenario_analysis` registry entry is a **placeholder**: `unsupported`,
incomplete intake, no engine, and the only module with
`adviserAvailable: false`. It should be represented as a capability flag on
scenario-aware modules, never as a routable module.

The same reasoning applies to `retirement_goal_analysis` — a routing label with
no engine — which is why it routes from nothing today. That is consistent with
the design, not a bug, but it should be recorded as `composition` rather than
left looking like an orphan.

---

## 5. Catalogue hygiene issues found

1. **Duplicate business-relief identity.** `business_owner_relief` (legacy) and
   `business_relief_analysis` both exist, both `adviser_only`, with overlapping
   goals. Needs a deliberate merge or a documented reason to keep both.
2. **`adviserAvailable` is read by nothing.** Grep finds no consumer outside
   `module_registry.js`. Like `applicableGoals`, it is declared and unused — so
   nothing currently enforces adviser availability at all.
3. **Education and Video summary have no module identity**, despite being real
   adviser outputs with renderers and (for Education) a playbook.
4. **`retirement_goal_analysis` has an approved intake contract but no engine**,
   so it can pass readiness and then have nothing to run.

---

## 6. Can the manifests narrow the adviser portal?

**Not today** — the adviser portal never reads `module_registry`, so there is no
path by which a manifest could remove an adviser capability. But that safety is
accidental, and it ends at P6, when the adviser module admin UI starts resolving
its list from the manifest registry. A manifest set covering only 9 of 15
adviser-available modules would, at that point, make six modules invisible.

This is the substantive risk the reconciliation was called for, and it is real.

---

## 7. Corrective action — required before P2

1. **Manifest the full catalogue: all 16 registered modules**, not the
   intake-approved subset.
2. **Separate the axes** that P1 conflated, as independent recorded fields:
   - `availability.adviser` / `availability.consumer`
   - `routing.consumerRoutable`, `routing.goals`, `routing.pinned`
   - `implementation.status`: `engine` | `template_only` | `routing_label` |
     `capability` | `planned`
   - `implementation.intakeContract`: `approved` | `incomplete`
   - `implementation.playbook` and `implementation.outputKey` where one exists
3. **Relax the parity assertion** so `requiredFacts` is compared only for
   approved intake contracts, and `goals`/`pinned` only for consumer-routable
   modules. Adviser-only modules assert availability and status instead.
4. **Represent Scenario Analysis as a capability**, with a `scenarioAware`
   boolean on the modules that accept overrides, and mark the `scenario_analysis`
   entry `implementation.status: capability` so it can never be routed.
5. **Add an anti-narrowing assertion**: every module with
   `adviserAvailable: true` in the registry must have a manifest. This is the
   check that makes the P1 mistake impossible to repeat.
6. Record the hygiene issues in §5 as explicit P2 decisions rather than letting
   them be inherited silently.

Until items 1–5 are done, P2 must not switch `buildGoalModulePlan` onto the
manifests or delete `ROUTES`, `recommendModules` or `applicableGoals`.

---

## 8. The definitive 16-entry catalogue

Generated from the live registry, manifests and playbook manifest on
2026-07-25. "Auto-routing" is what goal routing actually does today, verified
behaviourally, not what a declaration claims.

| User-facing name | Internal ID | Implementation type | Engine | Adviser | Consumer | Auto-routing | Current output | Recommended long-term treatment |
|---|---|---|---|---|---|---|---|---|
| Personal balance sheet | `personal_balance_sheet` | Runnable engine | ✅ | ✅ | ✅ | `understand_position`, `build_wealth` (direct) + **pinned when eligible** | `generated.pbsInputs` | Keep. Replace the hardcoded default-add with the manifest `pinned` setting; make it adviser-tunable in P6. |
| Liquidity reserve | `liquidity_analysis` | Runnable engine | ✅ | ✅ | ✅ | `maintain_liquidity` (direct), `buy_home` (companion) | `generated.liquidityPlan` | Keep as-is. The only `active` module and the most mature. |
| House purchase planner | `house_purchase` | Runnable engine | ✅ | ✅ | ✅ | `buy_home` (direct) | `generated.housePurchaseInputs` | Keep. Scenario-aware. Add P2 `factPreconditions` so a homeowner is never asked rent. |
| Pension projection | `pension_projection` | Runnable engine | ✅ | ✅ | ❌ | `improve_pension`, `retire`, `retire_early` (direct) | `generated.pensionInputs` | Promote to `consumerAvailable` once the employer-contribution precondition lands. Scenario-aware. |
| Net retirement cash flow | `net_retirement_cashflow` | Runnable engine | ✅ | ✅ | ❌ | `retire`, `retire_early` (companion) | `generated.netRetirementInputs` | Keep paired with pension projection. Scenario-aware. |
| Mortgage analysis | `mortgage_analysis` | Runnable engine | ✅ | ✅ | ❌ | `optimise_mortgage` (direct) | `generated.mortgageInputs` | Keep. Shares `mortgage_math.js` with loan analysis. |
| Loan analysis | `loan_analysis` | Runnable engine | ✅ | ✅ | ❌ | `manage_loan` (direct) | `generated.loanInputs` | Keep. |
| College funding | `college_funding` | Runnable engine | ✅ | ✅ | ❌ | `fund_education` (direct) | `generated.collegeFundingInputs` | Keep. Consumer release waits on reviewed, date-versioned cost scenarios. |
| Retirement Goal Analysis | `retirement_goal_analysis` | **Routing label** | ❌ | ✅ | ❌ | **none** | — | **Adviser-selection-only (decided).** No automatic consumer routes until its intended output and its relationship to the two retirement engines are separately reviewed. Its approved intake contract is misleading and should be re-labelled. |
| Protection analysis | `protection_analysis` | Template-only | ❌ | ✅ | ❌ | none | `generated.report` | Keep adviser-only. Real playbook and renderer, no engine. Never routable until a deterministic adapter exists. |
| Capital Acquisitions Tax analysis | `cat_analysis` | Template-only | ❌ | ✅ | ❌ | none | — | Keep adviser-only. Needs date-versioned CAT rules + tests before any route. |
| Business Owner Analysis | `business_owner_analysis` | Template-only | ❌ | ✅ | ❌ | none | — | Keep adviser-only. Genuinely distinct from business relief — general planning, not a tax relief. |
| Business Relief Analysis | `business_relief_analysis` | Template-only | ❌ | ✅ | ❌ | none | — | **Canonical business-relief identity.** Keep adviser-only. See §9. |
| Business owner relief (legacy) | `business_owner_relief` | Template-only | ❌ | ✅ | ❌ | none | — | **Retire to an alias of `business_relief_analysis`.** Not a distinct module. See §9. |
| Agricultural relief | `agricultural_relief` | Template-only | ❌ | ✅ | ❌ | none | — | Keep adviser-only. Needs date-versioned rules + tests. |
| Scenario analysis | `scenario_analysis` | **Capability** | ❌ | ❌ | ❌ | none | — | Never a module. Represent as `scenarioAware` on House purchase, Pension projection and Net retirement cash flow. Consider removing the placeholder id entirely in P2. |

**Totals:** 8 runnable engines · 6 template-only · 1 routing label · 1 capability.
15 adviser-available · 3 consumer-available · 8 auto-routed (of which 1 is
pinned rather than goal-routed).

**The non-runnable entries must never surface as runnable reports.** Nine of the
sixteen have no engine. `implementation.status` is the field that distinguishes
them, and P6's adviser UI must render `template_only`, `routing_label` and
`capability` as non-executable.

---

## 9. Business relief: duplicates, and which is canonical

**Recommendation: they are duplicates, not distinct modules and not a
routing-label/module pair. `business_relief_analysis` is canonical;
`business_owner_relief` should be retired to an alias rather than deleted.**

Evidence across every axis asked for:

| Axis | `business_relief_analysis` | `business_owner_relief` |
|---|---|---|
| Playbook | none | none |
| Engine | none | none |
| Output key | none | none |
| Required facts | none (incomplete intake) | none (incomplete intake) |
| Registry label | "Business Relief Analysis" | "Business owner relief (legacy)" |
| Declared goals | `business_planning`, `transfer_wealth` | `business_planning` |
| **Goal routing** | **routed** — [routing_rules.js:102](../js/planning/routing_rules.js:102) on `business_planning` + `businessExit` | **nothing routes to it** |
| **Fact mappings** | **3 mappings** — `business_context`, `business_exit_intent`, `agricultural_assets` ([semantic_facts.js:820,828,836](../js/planning/semantic_facts.js:820)) | **none** |
| **Persona catalogue** | used by 2 personas | **none** |
| Test fixtures | persona golden + voice frontend slot fixture | registry-coverage assertions only |

Two findings settle it:

1. **The persona catalogue's constant named `BUSINESS_RELIEF` points at
   `BUSINESS_RELIEF_ANALYSIS`** ([persona_catalogue.js:19](../js/planning/persona_catalogue.js:19)).
   The legacy *name* survives as a variable while the legacy *id* does not. That
   is a rename that was completed everywhere except the registry entry.

2. **The stated justification for keeping it is not borne out.**
   [contracts.js:93](../js/planning/contracts.js:93) says it is a
   "Backward-compatible id used by existing adviser modules and saved plans".
   But the adviser portal never resolves a module id against the planning
   registry: `validModuleIds` is built from `appState.session.modules`
   ([app.js:3737](../js/app.js:3737)) — session-local ids — and the Dev Panel
   payload's `moduleId` is optional free text that no validator checks against
   `MODULE_IDS`. A historical session containing the string would render
   identically whether or not the registry entry exists. No consumer analysis
   run can reference it either, since it has never been consumer-available or
   routable.

**Why alias rather than delete.** The code evidence says deletion is safe, but I
cannot inspect Gerry's stored R2 sessions or D1 rows from here, and the
conservative move costs nothing: keep `business_owner_relief` resolvable as an
alias that maps to `business_relief_analysis`, and drop it as a separate
catalogue entry so it stops appearing as a distinct adviser module. If a stored
payload does carry the old id, it still resolves; nothing is lost, and the
catalogue stops showing two entries for one analysis.

`business_owner_analysis` is **not** part of this duplication — general
business-owner planning is a genuinely different thing from a date-versioned
tax relief, and both are routed independently.

---

## 10. Recorded decisions — 2026-07-25

1. **`retirement_goal_analysis` stays adviser-selection-only.** No automatic
   consumer routes until its intended output and its relationship with pension
   projection and net retirement cash flow are separately reviewed. Its approved
   intake contract is misleading given it has no engine, and should be
   re-labelled as part of that review.
2. **Business relief** — investigated above; recommendation is alias, pending
   sign-off.
3. **P2 must replace both routing paths together.** `buildGoalModulePlan` and
   the execution-time `recommendModules` fallback inside `runConsumerAnalysis`
   must move to the manifest in the same change, with **behavioural tests
   proving conversation selection and executed modules cannot diverge** — the
   same profile must yield the same module set through both paths.
4. **Registry authoritative for adviser availability only after classification.**
   The classification is complete (§8). Adviser-only modules stay available;
   `template_only`, `routing_label` and `capability` entries must never be
   presented as runnable reports.

**Approved 2026-07-25 and implemented in P2:**

- `business_relief_analysis` is canonical. `business_owner_relief` is retained
  only as a resolvable alias in `RETIRED_MODULE_ID_ALIASES` and is no longer a
  registry entry, manifest, adviser selector option or module count.
- `scenario_analysis` stays as a documented cross-module capability, classified
  `implementation.status: capability`, and is excluded by construction from
  adviser selectors, consumer routing, runnable counts and output expectations.

---

## 11. One behaviour change in P2, and the decision behind it

Migrating both routers onto the manifest exposed a real divergence that had been
live: for `understand_position`, `buildGoalModulePlan` selects only the Personal
Balance Sheet, while `recommendModules` also recommended `liquidity_analysis`
(the old `route.position.liquidity.v1`). A client told "I'll put together your
overall position" could have had a cash-reserve analysis run as well.

The convergence test caught this immediately. **Resolved in favour of the
conversation**: the `understand_position → liquidity_analysis` edge was dropped
from `liquidity_analysis`'s `adviserGoals`, so the execution default now matches
what the client is actually told. No golden fixture covered
`understand_position`, so nothing pinned the old behaviour.

The alternative — adding the edge to consumer routing so the conversation also
offers liquidity — is a **product decision**, not a refactor, and it would change
what live clients are shown. Flagged for Gerry rather than taken unilaterally:

> Should a client whose goal is "understand my position" receive a cash-reserve
> analysis alongside the Personal Balance Sheet? Today they receive the balance
> sheet only. If yes, add `understand_position` to `liquidity_analysis`'s
> `routing.goals` and the conversation will follow.

**Answered 2026-07-25.** The Personal Balance Sheet stays the strong default,
but the journey is no longer confined to it. Companion analyses are now
*suggested* from accumulated circumstances and confirmed by the client before
anything extra runs — see §12.

Everything else in P2 is behaviour-preserving. Route rule ids changed form
(`route.buy_home.v1` → `manifest.buy_home.house_purchase.v1`); they are recorded
in telemetry, so historical `goal_plan_evaluated` events use the old strings.

---

## 12. Three selection states — selected, suggested, deferred

Implemented 2026-07-25. An overall-position request opens on the Personal
Balance Sheet and then keeps listening, without ever quietly widening what runs.

| State | Meaning | Where it lives | Executed? |
|---|---|---|---|
| `selected` | directly supports the client's stated goal, or a suggestion the client confirmed | `plan.moduleSlots` | **yes** |
| `suggested` | circumstances give a clear reason to consider it, and it has a real engine | `plan.suggestedModules` | **no — until confirmed** |
| `deferred` | relevant on the evidence but not analysable (no engine) | `plan.deferredModules` | no |

`executionModuleIds` is derived from `moduleSlots` alone, so a suggestion cannot
reach the analysis layer without passing through confirmation. That is the
structural guarantee behind "do not silently execute additional modules".

### How a suggestion arises

Manifests carry `routing.suggestedWhen`: a client-facing `reason` plus `anyOf`
conditions over **accumulated profile state** — circumstance facts
(`property_status`, `has_pension`, `dependant_count`, …) resolved through their
existing `semantic_facts` path mappings, and `profileHas` predicates over
recorded positions (`mortgage`, `pension`, `loan`, `cash`, `dependants`,
`business`, `property`).

Because the predicates read the profile rather than a turn, a suggestion appears
when the evidence exists and not before — the voice model can stay immediate and
conversational without being the thing that decides the module set. The build
rejects a suggestion rule with no client-facing reason, since a suggestion that
cannot be explained must not be offered.

### The journey, as tested

```
understand_position, nothing else known
  selected : personal_balance_sheet          EXECUTES: personal_balance_sheet
  suggested: —

… client mentions they own their home and have a pension
  selected : personal_balance_sheet          EXECUTES: personal_balance_sheet
  suggested: mortgage_analysis, pension_projection

… client mentions two children
  selected : personal_balance_sheet          EXECUTES: personal_balance_sheet
  suggested: college_funding, mortgage_analysis, pension_projection
  deferred : protection_analysis             (relevant, but no engine)

… client confirms the mortgage
  selected : personal_balance_sheet, mortgage_analysis
  suggested: pension_projection
```

Nine assertions in
[check-consumer-routing-convergence.mjs](../scripts/check-consumer-routing-convergence.mjs)
hold this: the balance-sheet-only start, suggestion only after evidence, a
reason on every suggestion, non-execution before confirmation, promotion on
confirmation, mutual exclusivity of the three states, engine-less modules
deferring rather than being offered, stability and monotonicity as facts
accumulate, and exact execution of the confirmed set.

### Remaining wiring

The plan now produces the three states; the realtime conversation does not yet
speak the suggestions aloud or collect the confirmation. That belongs with the
P3 question composer and the spoken confirmation flow, which is where the
"explain the addition and confirm the final set" wording will live.
`confirmedModuleIds` is read from `assumptions.values.planning`, so the voice
and typed journeys can both write it.
