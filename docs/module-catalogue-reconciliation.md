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
