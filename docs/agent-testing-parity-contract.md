# Voice / Text Parity Contract and Divergent-Behaviour Register

**Status:** A0 deliverable, delivered alongside the A1 extraction and updated
after the D-01 / D-02 / D-03 corrections. This is the authoritative
classification of consumer-planning behaviour into *shared*,
*transport-specific* and *divergent*. It is the reference the agent-testing
transport is built against.

**Register at a glance.** D-01 resolved · **D-02 code-complete and validated in
test; production activation BLOCKED pending re-canary after D-05** · D-03
resolved · D-04 open by design · **D-05 and D-06 live incidents, root-caused and fixed** ·
D-07 comment corrected, two planning authorities remain by design · **D-08 consumer
typed lane delivered behind `CONSUMER_TYPED_LANE_ENABLED`, off in source** ·
**D-09 code-complete; it changes live voice and needs its own canary.**

**Companion documents.** [agent-testing-environment-plan.md](agent-testing-environment-plan.md)
(the phased plan), [realtime-intelligence-implementation-plan.md](realtime-intelligence-implementation-plan.md)
(the build that produced the current v2 meeting).

**Governing principle.** One planning engine, multiple transports. Only audio
capture, speech generation, interruption handling and provider-specific realtime
mechanics may differ.

---

## 1. How to read this document

Every behaviour is one of three classes.

| Class | Meaning | Obligation |
|---|---|---|
| **shared** | Must be identical across transports | Exactly one implementation; parity fixtures assert equality |
| **transport** | Legitimately differs | Isolated per-transport test; excluded from parity assertions |
| **divergent** | Differs today and should not | Registered in §5 with an owner, an impact assessment and a resolution phase |

A behaviour may not be silently reclassified. Moving something out of
**divergent** requires a code change plus a characterisation update with a
written justification.

---

## 2. The shared core after A1

These now have exactly one implementation, in a module that knows nothing about
audio, WebRTC, leases or the provider.

| Behaviour | Implementation |
|---|---|
| Goal routing, ranking, three-analysis cap, opportunities, capacity | [`buildGoalModulePlan`](../js/planning/goal_plan.js:387) |
| Conversation state (stage, next question, recommendations, slots) | [`describeConversationState`](../worker/src/consumer/conversation.js:701) |
| Question planning and suppression of acknowledged-missing facts | [`buildQuestionPlan`](../worker/src/consumer/question_plan.js:63) |
| Consumer-safe module language, offers, capacity choice, confirmation summary | [`module_offers.js`](../js/planning/module_offers.js) |
| Planner extraction → profile candidates | [`mapPlannerExtractionToCandidates`](../worker/src/consumer/planning_facts.js) |
| Per-fact validation, mapping, projection, confirmation policy | [`planFactProposal`](../worker/src/consumer/planning_facts.js) |
| Fact mapping primitives (`mapRealtimeProposalFact`, `applyMappedRealtimeFact`, dependency ordering) | [`planning_facts.js`](../worker/src/consumer/planning_facts.js) |
| The planning state slice handed to brief composition | [`buildPlanningStateSlice`](../worker/src/consumer/planning_context.js) |
| Consent- and lease-free planning context | [`buildPlanningContext`](../worker/src/consumer/planning_context.js) |
| Consumer-boundary projection of routing state | [`toConsumerRealtimePlanningLists`](../worker/src/consumer/planning_context.js) |
| Applying a whole planner batch to the profile | [`applyPlannerCandidates`](../worker/src/consumer/planning_turn.js) |
| Brief composition, signing, persistence, plan preparation | [`composeAndPersistBrief`](../worker/src/consumer/planning_turn.js) |
| Module-offer decision (accept / decline / uncertain) | [`resolveModuleOffer`](../worker/src/consumer/planning_turn.js) |
| Capacity decision (replace / defer / unclear) | [`resolveCapacityDecision`](../worker/src/consumer/planning_turn.js) |
| Plan-change telemetry | [`recordPlanEvaluation`](../worker/src/consumer/planning_turn.js) |
| Execution-set rules | [`resolveExecutionModuleIds`](../worker/src/consumer/planning_turn.js), [`resolveConfirmationCandidateModuleIds`](../worker/src/consumer/planning_turn.js) |
| Analysis preparation and execution | [`realtime_analysis.js`](../worker/src/consumer/realtime_analysis.js) |
| Final confirmation of the analysis set | [`confirmPlanSelection`](../worker/src/consumer/planning_turn.js) |
| Text/agent transport (A2) — session, turns, projections | [`agent_session.js`](../worker/src/consumer/agent_session.js), [`agent_text_channel.js`](../worker/src/consumer/agent_text_channel.js) |

**This table describes the V2 core, and the V2 core is no longer what production
voice runs.** Since `CONSUMER_MODULE_PLANNER_MODE=apply` went live (deploy #333,
2026-09-04) the live lane plans through
[`direct_module_planner.js`](../worker/src/consumer/direct_module_planner.js) and
`MeetingBriefV3`, not `composeAndPersistBrief` and `MeetingBriefV2`. The agent
transport still runs the V2 core. See **D-07**.

The silent planner ([`extractRealtimePlannerTurn`](../worker/src/consumer/realtime_planner.js:482))
was already transport-independent: it takes a plain string. A typed message is a
valid input to it unchanged.

---

## 3. Behaviour that must be identical

Given semantically equivalent turns, both transports must produce identical:

1. `profile.goals` — types, priorities, statuses, order
2. accumulated semantic facts — ids, canonical values, certainty, status
3. `goalAssessment` — primary, active, deferred, confidence
4. `moduleSlots` — ids, slot order, source, `selectionState`, availability, intake status
5. `moduleOpportunities` — ids and states
6. `capacity` — `used`, `atLimit`, `overflowModuleIds`, `replaceableModuleIds`
7. `brief.questionBatch.primaryFact.factId` and `brief.stillNeeded` ordering
8. `brief.moduleOffer.moduleId` and `brief.capacityDecision.candidateModuleId`
9. `analysisPlan.moduleIds` and the executed module id set
10. `confirmationSummary` text
11. absence of internal module terminology in every client-facing field
12. absence of any `withheldOpportunities` id in any consumer-facing projection

Items 1–7, 11 and 12 are already locked by
[`check-consumer-turn-characterisation.mjs`](../scripts/check-consumer-turn-characterisation.mjs).

---

## 4. D15 — the execution-set investigation

This was the one open question that had to be settled before any transport could
claim parity. It is settled.

### 4.1 What was found

Two filters both looked like execution rules. As of commit `40ac8b8`, before
this work:

```js
// js/planning/goal_plan.js:528 — still present, unchanged
const executionModuleIds = moduleSlots
  .filter((slot) => slot.selectionState === 'selected')
  .filter((slot) => slot.availability === 'ready' || slot.availability === 'needs_facts')

// worker/src/consumer/realtime_analysis.js — the inline duplicate, since
// replaced by a call to resolveConfirmationCandidateModuleIds (same behaviour)
const moduleIds = (planningState.moduleSlots || [])
  .filter((slot) => ['ready', 'needs_facts'].includes(slot.availability))
  .map((slot) => slot.moduleId)
  .filter((moduleId) => config.allowedModules.includes(moduleId));
```

### 4.2 Is the difference deliberate?

**No.** The chronology is unambiguous:

| Commit | Date | What it did |
|---|---|---|
| `0017eda` | 2026-07-20 | Added `prepareRealtimeVoiceAnalysisPlan` with `['ready','needs_facts']`. At that moment `executionModuleIds` used the **identical** filter — the new code was an inline copy of the then-current rule. |
| `3c71c07` | 2026-07-26 00:48 | *"EXECUTE exactly that set. `executionModuleIds` derives from confirmed selections only; acceptance alone does not execute."* |
| `bf0c265` | 2026-07-26 09:16 | *"accepted … adds the module to the intended set and opens its question queue, **but does not run it**."* Test list includes *"an accepted module staying out of the execution set before final confirmation"*. |
| `32b3a62` | 2026-07-26 10:23 | Added `selectionState === 'selected'` to `executionModuleIds`: *"marked accepted rather than selected and **cannot execute before the final confirmation**"*. **Did not touch `realtime_analysis.js`.** |

So the tightening in `32b3a62` was deliberate and documented three times over;
the copy in `realtime_analysis.js` simply was not updated with it. The divergence
is **accidental drift from a copy-paste**, not a realtime-specific decision.

### 4.3 Is there a realtime-specific reason to keep it?

**No.** Nothing about audio capture, voice activity detection, barge-in,
transcription or provider mechanics bears on *which analyses execute*. The
question is answered entirely by accumulated profile state and the client's
confirmation. Searching the voice path produced no reasoning, comment or commit
message connecting realtime mechanics to the execution set.

### 4.4 But the two filters answer different questions

The correct resolution is not "delete one". They are answers to two genuinely
different questions, which had simply never been named:

> **Q1 — which analyses do we read out for the client to confirm?**
> Every runnable slot, *including* one just accepted from an offer. Excluding an
> accepted offer here would read back a list omitting the very analysis the
> client asked for a turn earlier.
>
> **Q2 — which analyses may execute?**
> Only the set the client confirmed. `executionModuleIds` expresses exactly this.

Both are now named and shared:
[`resolveConfirmationCandidateModuleIds`](../worker/src/consumer/planning_turn.js)
and [`resolveExecutionModuleIds`](../worker/src/consumer/planning_turn.js).

### 4.5 The missing link — since implemented

The two questions were never connected, because **`confirmedModuleIds` was never
written by production code.** It is read at [`goal_plan.js:423`](../js/planning/goal_plan.js:423),
cleared on replacement at [`module_offers.js:368`](../js/planning/module_offers.js:368),
and otherwise written only by test scripts. Step 4 of the P3 flow
(OFFER → RECORD → COLLECT → **CONFIRM** → EXECUTE) shipped its *spoken* half
([`buildVoiceConfirmationSummary`](../worker/src/consumer/realtime_completion.js:73),
[`handleSpokenCompletionTurn`](../worker/src/consumer/realtime_session.js)) but never
its *persistence* half.

Consequence: `selectionState` is `accepted` forever for an accepted offer, so
`executionModuleIds` permanently excludes it — and `executionModuleIds` is
therefore **currently dead in the voice path**. The looser copy in
`realtime_analysis.js` is what actually decides execution today, and it happens
to produce the outcome the client expects.

### 4.6 The final authoritative rule

> **The set offered for confirmation** = runnable module slots
> (`resolveConfirmationCandidateModuleIds`).
> **Confirmation** records that exact set as `confirmedModuleIds`.
> **The set that may execute** = `resolveExecutionModuleIds`, which after
> confirmation equals the confirmed set.

Both transports inherit this. A mismatch between the prepared set and
`executionModuleIds` then becomes a detectable conflict rather than a silent
difference — which is the correct behaviour when the profile has changed between
preparation and confirmation.

### 4.7 The correction, delivered separately from A1

Implementing §4.6 requires writing `confirmedModuleIds` at confirmation time.
That is a **live voice behaviour change**, so it was deliberately excluded from
the mechanical extraction and delivered afterwards as its own reviewed change.
See **D-01** below for what shipped.

Two facts made it a safe, well-scoped follow-up:

- [`confirmProfileRevision`](../worker/src/consumer/repository.js:699) rewrites the
  **same** revision in place rather than bumping it, so `confirmedModuleIds` can
  be folded into the confirmed payload without breaking the `expectedRevision`
  and plan-nonce equality checks in `handleSpokenCompletionTurn`.
- The **net observable outcome is unchanged**: an accepted module executes today
  (via the loose copy) and would execute after the correction (via a genuine
  confirmation). What changes is that the reason becomes correct and checkable,
  and `executionModuleIds` stops being dead code.

---

## 5. Divergent-behaviour register

### D-01 — `confirmedModuleIds` is never written; two execution-set definitions

| | |
|---|---|
| **Status** | **RESOLVED.** |
| **Class** | was divergent → now shared |
| **Approved rule** | Accepting an optional analysis does not by itself authorise execution. Only analyses in the final set the client confirmed may execute. |
| **What was implemented** | [`confirmPlanSelection`](../worker/src/consumer/planning_turn.js) records `confirmedModuleIds` — exactly the set read out to the client — and then confirms the profile revision. Both confirmation paths use it: the spoken completion in the Durable Object and `POST /api/consumer/sessions/{id}/confirm` in the router. The duplicated inline execution filter in `realtime_analysis.js` was already replaced in A1 by the named shared rule. |
| **Revision safety** | [`confirmProfileRevision`](../worker/src/consumer/repository.js:699) rewrites the **same** revision in place rather than bumping it, so folding the confirmed set into the profile first leaves `current_profile_revision` unchanged. Every `expectedRevision` equality check and the analysis-plan nonce binding continue to hold unmodified. |
| **Runtime verification** | [`confirmAndRunRealtimeAnalysisPlan`](../worker/src/consumer/realtime_analysis.js) now fails closed with `analysis_plan_not_confirmed` if the prepared plan's `moduleIds` do not equal `resolveExecutionModuleIds` at execution time. The existing revision guards already make this unreachable in normal operation (any planning write nulls `confirmed_profile_revision`); it exists so that if the two ever disagree, nothing runs. |
| **Tests** | [`check-consumer-shared-planning.mjs`](../scripts/check-consumer-shared-planning.mjs): acceptance alone does not execute but IS read out for confirmation; after confirmation the execution set equals the confirmed set exactly; the spoken confirmation describes exactly the set that will execute, in client language. |
| **Live voice change?** | **Yes — mechanism, not outcome.** An accepted analysis executed before (via the stale duplicate rule) and executes now (via a genuine confirmation). `executionModuleIds` is no longer dead code, and an unconfirmed set can no longer run. |
| **Rollback** | Revert the change. No schema change, no migration, no data rewrite: `confirmedModuleIds` is an additive field inside the existing encrypted profile payload, and every reader already defaults it to `[]`. Profiles written by the new code remain valid for the old code. |

### D-02 — module offers and capacity decisions cannot fire in live voice

| | |
|---|---|
| **Status** | **Code-complete and validated in the test environment. Production activation pending a controlled voice canary.** |
| **Class** | was divergent → now shared |
| **Original defect** | The Durable Object's `publicState` never carried `moduleOpportunities` or `capacity`. `composeMeetingBrief` reads exactly those two fields to build `moduleOffer` and `capacityDecision`, so both were unconditionally `null` in the canary. Since [`realtimeToolsForState`](../worker/src/consumer/realtime_provider.js:298) gates `record_module_decision` and `resolve_capacity_decision` on those fields, neither tool was ever offered to the model. Both flows were wired, handler-tested and dead end to end. |
| **What was implemented** | [`buildPlanningStateSlice`](../worker/src/consumer/planning_context.js) carries `moduleOpportunities` and `capacity` **unconditionally for every transport**. The earlier `includeOpportunityState` flag was removed outright: a per-transport state shape is what caused the defect, so it must not survive as a permanent option. |
| **Rollout control** | ONE shared decision, taken in `composeMeetingBrief` from `config.moduleOffersEnabled` (`CONSUMER_MODULE_OFFERS_ENABLED`). On means every transport offers; off means none does. It gates *presentation*, never state shape. |
| **Environments** | `"true"` in [`wrangler.consumer-test.toml`](../worker/wrangler.consumer-test.toml). `"false"` in the committed production config, enforced by the deploy workflow's `requiredFalseFlags`, and settable at deploy time via the `CONSUMER_MODULE_OFFERS_ENABLED` repository variable. |
| **Validated** | The full journey passes end to end through the agent transport against a real migrated database: offer produced and spoken in client language · `record_module_decision` gated on a live offer · accepted / declined / uncertain · no incorrect re-offer · three-analysis limit reached · capacity decision produced · `resolve_capacity_decision` gated on a live decision · replace / defer / unclear · confirmed execution set · no internal id or hidden opportunity in the consumer projection. See [`check-consumer-agent-journey.mjs`](../scripts/check-consumer-agent-journey.mjs) and [`check-consumer-agent-api.mjs`](../scripts/check-consumer-agent-api.mjs). |
| **Live voice change?** | **Not yet.** Production keeps `CONSUMER_MODULE_OFFERS_ENABLED = "false"`, so live voice behaviour is byte-identical to today. |
| **Remaining to close D-02** | The controlled realtime voice canary and production activation, per [agent-testing-d02-canary-runbook.md](agent-testing-d02-canary-runbook.md). Both require production credentials and a paid dispatch, so they are operator steps. |
| **Rollback** | The flag alone. No schema change, no migration. |

### D-03 — `primary_goal_focus` cannot be saved on a fresh profile

| | |
|---|---|
| **Status** | **RESOLVED.** |
| **Class** | was divergent → now shared |
| **Original defect** | `primary_goal_focus` maps to the scalar path `/assumptions/values/planning/primaryGoalType`, but `assumptions.values.planning` did not exist on a fresh profile and a JSON-pointer patch cannot write through a missing parent. Every such candidate was rejected with `invalid_profile_patch`, so a client's explicitly stated primary goal was silently discarded and ranking fell back to mention order. |
| **What was implemented** | `normalizeAssumptions` in [`profile.js`](../js/planning/profile.js) now guarantees `assumptions.values.planning` exactly as it has always guaranteed `assumptions.values.persona`. This is the root cause, not the symptom: any future scalar planning fact would have failed the same way. |
| **Why it is safe** | An empty `planning: {}` is indistinguishable from absent to every reader — `planningValues()` in [`goal_plan.js`](../js/planning/goal_plan.js) already defaults to `{}`. Where no primary preference is stated, nothing is written and behaviour is unchanged. |
| **Tests** | [`check-consumer-shared-planning.mjs`](../scripts/check-consumer-shared-planning.mjs): a fresh profile exposes an empty planning object; the scalar path persists; a fresh profile with three goals and an explicit primary honours the stated preference over mention order and resolves the priority question; and the control case — no stated preference — still uses mention order and still asks the priority question. |
| **Characterisation** | The golden recorded the change precisely: each scenario gained one profile revision (a fact that used to fail now saves) and lost its `primary_goal_focus` rejection. Goals, module slots, questions, `stillNeeded`, capacity, execution set and every brief field are **unchanged** — these fixtures each state a single goal, so stated focus and mention order agree. Recorded in the golden's `changeLog`. |
| **Live voice change?** | **Yes.** A stated primary goal now ranks its analyses first. This is the intended product behaviour and was the whole purpose of `primary_goal_focus`. It only becomes observable in a multi-goal meeting. |
| **Rollback** | Revert. Additive and backward-compatible: profiles carrying `planning: {}` are valid for the old code, which already tolerated the field being absent. |

### D-05 — a multi-goal opening turn produced a live clarification loop

| | |
|---|---|
| **Status** | **Root-caused and fixed.** Awaiting a live re-test. |
| **Class** | was a live defect → now covered by regression |
| **Incident** | In a live realtime meeting the client opened with *"I'm 25 and early in my career. I want to get a broader picture of my financial position, and I'm hoping to buy a house in the future, so I want to make sure I'm properly set up for that."* The assistant repeatedly said it had not understood and asked for the point to be repeated, and never progressed past the opening. |
| **Root cause** | Stating two goals in one turn sets `requiresGoalPriorityQuestion`, which makes [`describeConversationState`](../worker/src/consumer/conversation.js) return empty `moduleSlots` **and** empty `recommendations`. `composeMeetingBrief` built `questionBatch` **only** from the missing facts of routed analyses, so with no recommendations it emitted `questionBatch: null`. The conversational v2 phase guidance instructs the model to *"ask exactly the single server-authored questionBatch.prompt"* — with none, it had nothing to say and fell back to asking the client to repeat themselves. Every subsequent turn produced the same empty brief, so the loop could not break. |
| **Not a regression** | Reproduced identically at commit `40ac8b8`, before the A0/A1 extraction. Not stale deployment either: the live frontend build id and the live Worker were both `933ee0c`. |
| **The deeper point** | The deterministic clarification question existed the whole time in `state.nextQuestion`. It simply never reached the brief. Commit `32b3a62` had already declared *"THE PRIORITY QUESTION NO LONGER BLOCKS"* and fixed `buildGoalModulePlan` — but not `describeConversationState`. Same half-fix shape as D-01. |
| **Fix** | `composeMeetingBrief` falls back to `state.nextQuestion` when there are no missing facts. **A live meeting can no longer receive a brief with no question**, whatever the cause — which is a stronger invariant than fixing this one trigger. |
| **Tests** | [`check-consumer-multi-goal-opening.mjs`](../scripts/check-consumer-multi-goal-opening.mjs) — the exact utterance, under the exact production allowlist and the full catalogue: both goals recognised, age recorded, no fragment misclassification, a real advancing question, no request to repeat, no internal terminology, and the loop breaking once answered. Plus the same utterance end to end through the agent transport in [`check-consumer-agent-journey.mjs`](../scripts/check-consumer-agent-journey.mjs). |
| **Characterisation** | Unchanged — the fallback only fires where there was previously no question at all. |
| **Live voice change?** | **Yes, and it is the point:** a meeting that previously had nothing to say now asks the deterministic clarification question. |
| **Open** | Whether the opening greeting also failed is **not established**. A plausible mechanism exists (`refreshJourneyState` suppresses `session.update` when the policy hash is unchanged, and the greeting is only authorised on `session.updated`), but confirming it needs the meeting's `consumer_realtime_events` rows, which are not available here. |

### D-06 — a planner failure blamed the client and looped forever

| | |
|---|---|
| **Status** | **Root-caused and fixed.** Awaiting a live re-test. |
| **Class** | was a live defect → now covered by regression |
| **Incident** | Second live meeting, on `5d105a8` (greeting working). Client: *"Well, I'm 25 and I'm mostly interested in saving up for buying a house in the future…"*. Assistant: *"Sorry, the last planning note couldn't be updated. Could you restate only that last point…"* — twice, including after the client made the goal completely explicit. UI stayed at 0 focus areas, 0 understood. |
| **Root cause** | The spoken wording came directly from `planner_recovery` / `planner_degraded`, reached when the separate silent Responses planner failed even though the Realtime conversation model had heard the client correctly. The original broad `try` also misclassified accounting, persistence, telemetry and refresh failures as planner-extraction failures. **Asking the client to rephrase cannot fix any of those internal faults**, so every later turn could start with the same disruption. |
| **Ruled out by reproduction** | Against a real migrated database with the exact production allowlist and flags, the candidate path is **healthy**: `buy_home` accepted, `primary_goal_focus` accepted, age 25 accepted, unsupported siblings (`home_purchase_timeframe_years`, `savings_goal`) rejected **independently** with `realtime_fact_not_supported` without blocking anything, and the resulting brief carried both analyses and a real question. So Q4–Q7 are answered: no candidate blocked the goal. |
| **Deployment vs code** | **Both surfaces are hardened.** The repeated spoken preamble was a code defect. A current production-shaped local probe passes with the newly provisioned project key, which makes the deployed credential/model permission the leading explanation for the trigger; the original live event is still required for certainty. |
| **Fix** | Four parts. (1) [`deterministicFallbackExtraction`](../worker/src/consumer/planning_facts.js) still salvages goals and age without a network. (2) No planner failure path may mention a technical issue, saving problem or planning note, or ask for a repeat/rephrase; the Realtime model acknowledges the turn naturally and continues from the signed brief. (3) Extraction, accounting, candidate application and refresh now have separate failure stages, preventing a post-apply fault from being mistaken for a failed extraction or applied twice. (4) deployment must pass the production-shaped Responses planner probe before Realtime can activate. |
| **Not just the apology text** | Internal degradation remains visible in bounded operational telemetry, but it is never made the opening sentence of a client response. |
| **Observability** | `realtime.planner.deferred`, `degraded`, `accounting_failed`, `apply_failed` and `refresh_failed` distinguish the exact non-content failure stage. |
| **Tests** | [`check-consumer-multi-goal-opening.mjs`](../scripts/check-consumer-multi-goal-opening.mjs) — the exact two live utterances: the fallback recovers goal and age; the salvaged turn persists and advances with a real question that never asks for a restatement; an unsupported sibling is rejected independently while `buy_home` survives and becomes primary; and the failure handling itself is asserted. |
| **Still unknown** | The exact error on the original deployed call. That needs its `realtime.planner.deferred` event. The current code, schema, model and newly created project key pass the live planner probe, so the final deployment should replace/verify its protected credential and re-run the gated canary. |

### D-04 — the typed `/turns` journey is a different pipeline

| | |
|---|---|
| **Status** | Open by design. |
| **Class** | divergent |
| **Evidence** | [`processTurn`](../worker/src/consumer/conversation.js:483) uses [`extractContextBoundPatch`](../worker/src/consumer/conversation.js:344) plus `extractProfilePatchWithAi`, not the silent planner; returns the raw question as the assistant message; has no brief, offer, capacity, confirmation or execution. |
| **Impact** | It is the pre-v2 journey. The front end already retired it ([`js/plan/app.js:246`](../js/plan/app.js:246)). |
| **Resolution** | The agent transport must NOT extend it. Reuse its idempotency, rate-limit and turn-persistence shell only, and route extraction through the shared core. |
| **Phase** | A2. |

### D-07 — two live planning authorities; the agent transport is on the archived one

| | |
|---|---|
| **Status** | **Comment corrected. Two planning authorities remain, by design for now.** |
| **Class** | divergent |
| **Evidence** | [`agent_text_channel.js:1-20`](../worker/src/consumer/agent_text_channel.js) states its instructions are *"the exact string the live voice meeting is given"*. It imports [`realtime_provider.js`](../worker/src/consumer/realtime_provider.js) — `buildRealtimeConversationV2Instructions` and `realtimeToolsForState` — and dispatches to `planning_turn.js`, producing `MeetingBriefV2`. The live lane imports [`live/catalogue_prompt.js`](../worker/src/consumer/live/catalogue_prompt.js) and [`live/live_tools.js`](../worker/src/consumer/live/live_tools.js), and produces `MeetingBriefV3` via the direct-module planner and its independent verifier. In `apply` mode the live lane's `get_state` returns `DirectModuleToolStateV1`, not `liveStateProjection`, and `save_facts` is not even in the toolset ([`live_provider.js:29-31`](../worker/src/consumer/live/live_provider.js)). |
| **Impact** | The comment is false and the test that guards it (`check-consumer-agent-api.mjs`) asserts the structural sharing against the V2 source, so it passes while the claim is untrue. Both lanes write to `consumer_realtime_meeting_briefs` under different `schema_version` values. Anyone reading that header will reasonably conclude a consumer typed lane can be built on the agent transport for free; it cannot, because that would put typed users on a different planner, brief and readiness definition from spoken users. |
| **Resolution** | The header now states plainly that this file speaks for the archived v2 lane, names the two artefacts that diverged, and points at D-07/D-08. The agent transport stays on the V2 core and remains an adviser test harness. The consumer typed lane (**D-08**) is built on the live lane instead. Retiring the V2 core is a separate decision, not taken here. |
| **Phase** | T0. Delivered. |

### D-08 — consumer typed lane: a second transport on the live lane

| | |
|---|---|
| **Status** | Registered before build, per §9 rule 6. |
| **Class** | transport (see §6), with the exceptions listed below |
| **What it is** | A text-native consumer journey. Planéir does not speak; messages render on screen; the screen may present a compact module card built from planner state. It runs inside the same `ConsumerLiveSession` Durable Object as voice, over the Responses API, with **no** Realtime connection, microphone, audio element or lease timer semantics. |
| **Shared, and asserted** | Direct-module planner, verifier and certificate; module contracts; `handleClientTurn` ingest and turn persistence; tool definitions and handlers (`get_state`, `confirm_and_run`); every rules section of the catalogue prompt; the whole confirmation barrier. |
| **Deliberately different** | Turn boundary (a message arrives whole); no barge-in; no ASR; no audio metering; no compliance L2 numeric containment (nothing is spoken); **planner timing** — a typed turn awaits the planner before replying, where voice schedules it in the background; **delivery evidence** — see below. |
| **`readbackFullyDelivered`** | Text does not port the playback machinery. `transcriptMatched` holds by construction because the server writes the certified `confirmationPrompt` verbatim as the assistant turn; `responseCompleted` is the persisted turn plus a 200; `playbackCompleted` is replaced by **reply-binding** — the approving turn's `answersTurnId` must equal the offer's `assistantTurnId`. That is strictly stronger: an audio ack proves sound was emitted, reply-binding proves the approval was made against the exact plan on screen. Everything else in the barrier is unchanged. |
| **Prompt** | `buildLiveCataloguePrompt({ directModulePlanning, channel })`. Only delivery-shape sections vary. Every rules section is byte-identical across channels, asserted by `check-live-typed-lane.mjs`. There is no second prompt pack. |
| **Structured input** | A card submission compiles to exactly ONE client turn (`inputMode: 'form'`) and enters the same ingest. There is no second fact write path, so chat answers and field answers cannot drift into two versions of the client's finances. |
| **Parity obligation** | [`check-live-transport-parity.mjs`](../scripts/check-live-transport-parity.mjs) drives the same utterances through both transports on a real Durable Object and a real migrated database, with the planner's opinion scripted identically, then asserts identical stored client transcript, `modules[].status`, `missing[].path` sets, `blocked[].path` sets, `selection.origin`, `readyToConfirm` and `provisional`. Wording parity is not claimed. Verified to have teeth by mutation: a typed lane that reshapes the transcript fails it. |
| **Other gates** | [`check-live-typed-lane.mjs`](../scripts/check-live-typed-lane.mjs) (one prompt pack, one toolset, planner-before-reply ordering, the card cannot invent a field or leak internal vocabulary), [`check-live-typed-confirmation.mjs`](../scripts/check-live-typed-confirmation.mjs) (the read-back and reply binding), [`check-module-input-display.mjs`](../scripts/check-module-input-display.mjs) (the display contract against the engines' own inputs), and the typed assertions added to `check-consumer-live.mjs` (no microphone, no audio, no orb, no disabled composer). |
| **Phase** | T1–T4. Delivered. |

### D-09 — the direct-module planner has no acknowledged-unknown state

| | |
|---|---|
| **Status** | Open. Affects live voice today. |
| **Class** | divergent (against the V2 fact layer, which does model this) |
| **Evidence** | `EXTRACTOR_PROMPT` ([`direct_module_planner.js:181`](../worker/src/consumer/direct_module_planner.js)): *"AN ANSWER THAT IS STILL UNSURE IS NOT AN ANSWER … keep the module collecting and record what is still missing, so the conversation asks once more."* There is no path by which a client's "I don't know" stops the question recurring. The V2 fact layer models exactly this — `estimate_requested` → `blocked_unknown`, `answerPolicy ∈ value \| value_or_none \| unknown_allowed` ([`question_plan.js:157-163`](../js/planning/question_plan.js)) — but that projection is not what `apply` mode returns. |
| **Impact** | In live voice a client who cannot answer is asked again. In typed mode a "Not sure" control would have nowhere to land and would build the loop into the UI. |
| **Resolution** | A server-owned `acknowledgedUnknown` set in the planner envelope; a `blocked[]` array on the module item; both bound into the certificate so an unknown cannot be retracted between certification and execution. The extractor either covers the path with an approved `direct_module_policy.js` default and discloses it in `assumptions[]`, or leaves the module collecting with the path blocked and stops generating a question for it. |
| **What was implemented** | A server-owned acknowledged set in the planner envelope, and a server-DERIVED `blocked[]` on each module item -- derived rather than authored so there is no new field for the model to get wrong. `partitionAcknowledgedUnknown` runs BEFORE the readiness rules, because those rules reason about what is still outstanding and a requirement the client has closed is not outstanding; running it after left a module marked `needs_clarification` with no clarification left to ask. A blocked path with an approved default is covered and disclosed as an assumption; one without makes the module unrunnable, and it is forced out of `ready`. The set is bound into the certificate as `acknowledgedUnknownHash`, so an unknown cannot be retracted between certification and execution. |
| **Live voice change?** | **Yes.** Voice has the same gap today and gains the same fix. Staged separately with its own canary, as D-01/D-02/D-03 were: the flag is `CONSUMER_TYPED_LANE_ENABLED` for the typed half, but the planner change applies to every apply-mode meeting and needs a voice canary before production. |
| **Phase** | T5. Code-complete; **production activation pending a controlled voice canary.** |

---

## 6. Transport-specific behaviour

Legitimately different. Tested per transport; excluded from parity assertions.

| Behaviour | Voice | Text/agent |
|---|---|---|
| Turn segmentation | semantic VAD; [`isLikelyIncompleteRealtimeUtterance`](../worker/src/consumer/realtime_planner.js:221) coalesces mid-clause fragments | a message arrives whole |
| Transcription errors | real ASR failures, empty transcripts, `transcription.failed` | none |
| Interruption / barge-in | cancelled-response recovery, `resumeInterruptedSpeech` | none |
| Filler and latency masking | matters | no perceived latency |
| Assistant wording | OpenAI Realtime model speaking from the signed brief | a Responses-API call using the **same** instructions and tools |
| `wait_for_user` | meaningful | filtered out |
| Usage accounting | audio + transcription tokens, dispatch-stop budget | text tokens only |
| Session policy | `session.update` + policy-hash pinning | none |
| Turn serialisation | Durable Object single-threading + planner ordinal guard | optimistic `expectedRevision` concurrency |
| Evidence binding | opaque provider item id | server-issued turn id |
| Termination | provider hang-up, lease closure, outro speech | HTTP response |

### 6.1 Consumer typed lane (D-08) vs live voice

The table above compares live voice with the **adviser agent test** transport.
The consumer typed lane is a different transport again, on the live lane.

| Behaviour | Live voice | Consumer typed |
|---|---|---|
| Provider API | Realtime (WebRTC audio + server sideband socket) | Responses, one call per turn |
| Microphone, audio element, orb | required | **absent** |
| Turn boundary | semantic VAD | the message arrives whole |
| Interruption / barge-in | real | none |
| Planner timing | background; the reply goes first | **awaited before the reply**, so the card and the reply cannot be stale |
| Read-back delivery evidence | audio playback ack + transcript equality | persisted assistant turn + reply-binding on `answersTurnId` |
| Compliance L2 numeric containment | scans spoken figures against `sourcedFigures` | not applicable; nothing is spoken |
| Session lifetime | hard and idle lease expiry, priced per audio minute | session TTL only |
| Structured input | none | a card compiles to one client turn, `inputMode: 'form'` |
| Delivery-shape prompt sections | one question per breath-group | may present a grouped card |

Everything not in this table is shared and parity-asserted, including the whole
confirmation barrier apart from the delivery-evidence row.

**Wording parity is not achievable and is not claimed.** Parity is asserted on
planning state, never on prose.

---

## 7. What A1 changed, and what it did not

### Changed (structure only)

- `realtime_session.js`: 3,706 → 3,188 lines. It no longer contains planning
  logic; it delegates to `planning_context.js`, `planning_facts.js` and
  `planning_turn.js`.
- The offline simulator calls the production service instead of a hand-copy.
  Its three stale source-line references — all of which had drifted — are gone.

### Explicitly not changed by A1

- No planning behaviour. Verified by the characterisation golden and the full
  realtime suite.
- The three defects A1 uncovered were registered, not fixed, so the extraction
  could be reviewed as a pure move.

### Changed afterwards, as separate reviewed corrections

- **D-03** — profile normalisation guarantees `assumptions.values.planning`, so a
  stated primary goal persists and ranks. Live behaviour change, visible only in
  a multi-goal meeting.
- **D-01** — `confirmPlanSelection` writes `confirmedModuleIds` at final
  confirmation on both confirmation paths, and execution fails closed if the
  prepared set and the confirmed set disagree. Live mechanism change; same
  outcome.
- **D-02** — `moduleOpportunities` and `capacity` are carried unconditionally for
  every transport; presentation is gated by the shared
  `CONSUMER_MODULE_OFFERS_ENABLED` rollout control, which is off in production.
  **No live voice behaviour change until that flag is turned on.**

---

## 8. Test obligations

| Gate | Script | Enforces |
|---|---|---|
| Characterisation | [`check-consumer-turn-characterisation.mjs`](../scripts/check-consumer-turn-characterisation.mjs) | Full planning-state golden per fixture turn; regenerating it requires a documented intent |
| Conversation behaviour | [`check-consumer-realtime-conversation-sim.mjs`](../scripts/check-consumer-realtime-conversation-sim.mjs) | must-ask / must-never-ask / module selection, through the production service |
| Realtime control plane | [`check-consumer-realtime.mjs`](../scripts/check-consumer-realtime.mjs) | 5,099 lines of adversarial voice-transport assertions |
| Offers and capacity | [`check-consumer-module-offers.mjs`](../scripts/check-consumer-module-offers.mjs) | Deterministic offer, capacity, replacement, deferral, confirmed-set execution |
| Event schema | [`check-consumer-realtime-events.mjs`](../scripts/check-consumer-realtime-events.mjs) | Realtime emitter types stay in the voice transport and carry no content |

Still to be added (A4): `check-consumer-transport-parity.mjs`, asserting the
eleven fields of §3 across the V2 core's two transports.

Delivered for the LIVE lane's two transports (D-08):

| Gate | Script | Enforces |
|---|---|---|
| Transport parity | [`check-live-transport-parity.mjs`](../scripts/check-live-transport-parity.mjs) | Same utterances, both transports, real DO and real database, planner scripted identically: identical stored transcript, module readiness, outstanding and blocked requirements, attribution and confirmation readiness |
| Typed lane | [`check-live-typed-lane.mjs`](../scripts/check-live-typed-lane.mjs) | One prompt pack with only delivery-shape sections differing; one toolset; the planner completes before the reply; the card cannot invent a field or leak a module id, pointer or revision; an acknowledged unknown stops the question and cannot make a module ready |
| Typed confirmation | [`check-live-typed-confirmation.mjs`](../scripts/check-live-typed-confirmation.mjs) | The certified prompt is persisted byte-identical; delivery needs no playback evidence; reply binding refuses an unbound, mismatched or superseded approval |
| Display contract | [`check-module-input-display.mjs`](../scripts/check-module-input-display.mjs) | Every field the engines accept is described or explicitly hidden with a reason; every enum is imported from its validator; no descriptor names a path no engine produces |

---

## 9. Rules for the agent transport

1. It must call `processConsumerTurn`-family functions in `planning_turn.js`. It
   must not compose a question, choose a module, or write a fact by any other
   route.
2. It must import `buildRealtimeConversationV2Instructions` and
   `realtimeToolsForState` — never author its own instructions or tool list.
3. It must project through three explicit tiers: public consumer, tester
   diagnostic, internal-only. `withheldOpportunities`, brief signatures and plan
   nonces never leave the server.
4. It must not accept a module id from the client on any route.
5. Utterance-mode turns are parity-eligible; action-mode turns carry
   `decisionMode: "action"` and are excluded from parity fixtures.
6. Any behaviour it needs that voice lacks must be registered in §5 before it is
   built, not discovered afterwards.
