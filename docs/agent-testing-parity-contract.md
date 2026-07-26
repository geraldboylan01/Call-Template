# Voice / Text Parity Contract and Divergent-Behaviour Register

**Status:** A0 deliverable, delivered alongside the A1 extraction. This is the
authoritative classification of consumer-planning behaviour into *shared*,
*transport-specific* and *divergent*. It is the reference the agent-testing
transport is built against.

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

### 4.5 The missing link

The two questions were never connected, because **`confirmedModuleIds` is never
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

### 4.7 Why the correction is not in A1

Implementing §4.6 requires writing `confirmedModuleIds` at confirmation time.
That is a **live voice behaviour change** and is deliberately excluded from the
mechanical extraction, per the A1 brief. It is registered as **D-01** below.

Two facts make it a safe, well-scoped follow-up:

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
| **Status** | Open. Registered, not fixed. |
| **Class** | divergent |
| **Evidence** | [`goal_plan.js:528`](../js/planning/goal_plan.js:528) vs the former inline copy in [`realtime_analysis.js`](../worker/src/consumer/realtime_analysis.js); `confirmedModuleIds` written by no production path |
| **Impact today** | `executionModuleIds` is dead in the voice path. Execution is decided by `resolveConfirmationCandidateModuleIds`. Net client outcome is currently correct. |
| **Partially addressed** | A1 replaced the inline duplicate with a call to the named shared rule `resolveConfirmationCandidateModuleIds` — identical behaviour, one definition. What remains is writing `confirmedModuleIds`. |
| **Resolution** | Implement §4.6: write `confirmedModuleIds` on final confirmation, so `resolveExecutionModuleIds` becomes live and the two rules converge. |
| **Live voice change?** | **Yes** — mechanism changes, outcome should not. Requires dedicated characterisation + regression tests, staged separately from A1, canaried, rollback via revert. |
| **Phase** | Between A1 and A2, as its own reviewed change. |

### D-02 — module offers and capacity decisions cannot fire in live voice

| | |
|---|---|
| **Status** | Open. Registered, not fixed. **Highest-value finding of A0.** |
| **Class** | divergent |
| **Evidence** | The Durable Object's `publicState` has never carried `moduleOpportunities` or `capacity`. [`composeMeetingBrief`](../worker/src/consumer/realtime_planner.js:947) reads exactly those two fields to build `moduleOffer` and `capacityDecision`. |
| **Verification** | Reproduced directly: a homeowner-with-mortgage profile whose stated goal is `improve_pension` yields `moduleOpportunities: [mortgage_analysis:offerable]` from the deterministic engine, and `nextModuleOffer` composes an offer from it — but composing the brief with the shape the DO actually builds returns `moduleOffer=null`, while adding the two fields returns `moduleOffer=mortgage_analysis`. |
| **Impact today** | `brief.moduleOffer` and `brief.capacityDecision` are unconditionally `null` in the canary. [`realtimeToolsForState`](../worker/src/consumer/realtime_provider.js:298) gates `record_module_decision` and `resolve_capacity_decision` on exactly those fields, so **neither tool is ever offered to the model**. The spoken offer flow (`3c71c07`, `bf0c265`) and the three-analysis capacity decision (`df40b12`) are wired, tested at the handler level, and dead end to end. |
| **Resolution** | `buildPlanningStateSlice({ includeOpportunityState: true })`. The flag exists so this is one reviewed flip in one place, not a second implementation. |
| **Live voice change?** | **Yes, and a large one** — it switches on two conversational flows that have never run with real clients. Needs its own canary and its own conversation probe. |
| **Phase** | Its own change, after D-01. Not a prerequisite for A2; the agent transport can enable it independently for testing, which is precisely what the test environment is for. |

### D-03 — `primary_goal_focus` cannot be saved on a fresh profile

| | |
|---|---|
| **Status** | Open. Registered, not fixed. |
| **Class** | divergent |
| **Evidence** | The planner emits a `primary_goal_focus` candidate whenever `priorityHint === 'primary'`. It maps to `/assumptions/values/planning/primaryGoalType` ([`realtime_fact_mapper.js:592`](../worker/src/consumer/realtime_fact_mapper.js:592)), but `assumptions.values.planning` does not exist on a fresh profile, and the canonical patch requires the path to exist. Every such candidate is rejected with `invalid_profile_patch`. |
| **How it surfaced** | The characterisation harness recorded the rejection on its first run; the re-pointed simulator now prints `dropped: primary_goal_focus` for all four scenarios. The previous simulator hid it, because its hand-copied candidate mapping ignored `priorityHint` and never produced the fact at all. |
| **Impact today** | The client's explicitly stated *primary* goal is never persisted as the focus. `buildGoalModulePlan` falls back to `supportedGoalTypes[0]` (mention order). With one goal this is invisible; with several it silently changes ranking. |
| **Resolution** | Either create `assumptions.values.planning` in `createHouseholdProfile`/`normalizeHouseholdProfile`, or map the fact through a whole-object patch as [`extractContextBoundPatch`](../worker/src/consumer/conversation.js:355) already does. |
| **Live voice change?** | **Yes** — goal ranking would begin to honour a stated primary goal. |
| **Phase** | Own change. Fix before multi-goal scenarios are used for parity assertions, since ranking is one of the eleven fields §3 requires to be identical. |

### D-04 — the typed `/turns` journey is a different pipeline

| | |
|---|---|
| **Status** | Open by design. |
| **Class** | divergent |
| **Evidence** | [`processTurn`](../worker/src/consumer/conversation.js:483) uses [`extractContextBoundPatch`](../worker/src/consumer/conversation.js:344) plus `extractProfilePatchWithAi`, not the silent planner; returns the raw question as the assistant message; has no brief, offer, capacity, confirmation or execution. |
| **Impact** | It is the pre-v2 journey. The front end already retired it ([`js/plan/app.js:246`](../js/plan/app.js:246)). |
| **Resolution** | The agent transport must NOT extend it. Reuse its idempotency, rate-limit and turn-persistence shell only, and route extraction through the shared core. |
| **Phase** | A2. |

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

### Explicitly not changed

- No planning behaviour. Verified by the characterisation golden and the full
  realtime suite.
- The execution-set *outcome* is unchanged. The duplicated inline filter in
  `realtime_analysis.js` now calls the named shared rule
  `resolveConfirmationCandidateModuleIds`, which is the same code; nothing yet
  writes `confirmedModuleIds`, so `executionModuleIds` remains dead (D-01).
- `includeOpportunityState` defaults to `false`, preserving today's live
  behaviour exactly (D-02).
- `primary_goal_focus` still fails on a fresh profile (D-03).

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
eleven fields of §3 across both transports for mirrored fixtures, with the
planner stubbed by a recorded extraction so parity is deterministic and offline.

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
