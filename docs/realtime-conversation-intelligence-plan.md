# Realtime Conversation Intelligence Plan

Goal: make the Realtime meeting behave like a competent adviser doing a first
discovery call — open with the client's own story, understand who they are, then
ask only the questions that a person in *their* situation would expect to be
asked, and match the built modules to what they actually said.

This plan does **not** propose giving the model more authority. The
deterministic authority boundary in
[consumer-realtime-voice-operations.md](consumer-realtime-voice-operations.md)
stays exactly as it is. Every intelligence gain below comes from **better
inputs, better ordering, and better phrasing** inside the existing boundary.

---

## 0. Diagnosis: why the 25-year-old gets asked what their home is worth

The reported symptom — a 25-year-old with few assets who wants to buy a first
home is asked *"Do you own your home, and if so, roughly what is it worth?"* —
is not a model failure. It is four deterministic defects compounding. All four
are in our code, and all four are fixable.

### Defect 1 — The balance sheet is force-added before we know anything

[goal_plan.js:195](../js/planning/goal_plan.js:195) injects
`personal_balance_sheet` into any plan with fewer than three modules. For
`buy_home` the plan is `house_purchase` + `liquidity_analysis` = 2 modules, so
the balance sheet is always added as a third.

`personal_balance_sheet` requires `property_position`
([module_registry.js:83](../js/planning/module_registry.js:83)), whose prompt is
literally the question the user heard.

### Defect 2 — The guard that should stop this is unreachable

[goal_plan.js:108](../js/planning/goal_plan.js:108) has a guard —
`shouldAddBalanceSheet` skips it when `isEarlyLife(profile)` and the household
has no meaningful position. `isEarlyLife`
([goal_plan.js:98](../js/planning/goal_plan.js:98)) reads `lifeStage`,
`careerStage`, `selfDescription`, or `primaryPerson.age <= 30`.

For a `buy_home` journey, **none of those are ever collected**.
`person_current_age` appears only in the `pension_projection`,
`net_retirement_cashflow` and `college_funding` intake contracts
([module_registry.js:62-82](../js/planning/module_registry.js:62)) — never in
`house_purchase`, `liquidity_analysis` or `personal_balance_sheet`. So age is
never asked, `isEarlyLife` is always `false`, and the guard is effectively dead
code on the exact path where it matters most.

### Defect 3 — The fact gate is circular

[realtime_fact_mapper.js:532](../worker/src/consumer/realtime_fact_mapper.js:532)
rejects any fact not required by a currently-enabled module. If the client says
*"I'm 25, renting, trying to buy my first place"*, `person_current_age` is
**discarded**, because no selected module needs age. The fact that would have
changed the module selection is thrown away *because of* the module selection.

`property_status` and `life_stage` *are* exempt
([realtime_fact_mapper.js:19](../worker/src/consumer/realtime_fact_mapper.js:19))
— but see Defect 4.

### Defect 4 — The planner prompt forbids the inference that would save us

[realtime_planner.js:162](../worker/src/consumer/realtime_planner.js:162):

> `Numeric, monetary, ownership, and financial-position values must be explicit in the finalized turn.`

"ownership" in that list blocks the planner from emitting
`property_status=renter` or `first_time_buyer` from natural context. There is a
single narrow carve-out for new parents (line 161) and an explicit *"Do not emit
a persona label"*. So the one signal that would decisively suppress the property
question is prohibited by prompt.

### And the question order guarantees it is asked early

[realtime_planner.js:738](../worker/src/consumer/realtime_planner.js:738) orders
missing facts by a **hard-coded global array**. `property_position` is third,
right after `primary_goal` and `partner_person` — before income, before savings,
before anything about the actual home-buying goal.
[realtime_planner.js:877](../worker/src/consumer/realtime_planner.js:877) then
takes `missingFacts[0]` as the next question, verbatim from a static prompt map
([realtime_planner.js:780](../worker/src/consumer/realtime_planner.js:780)).

### Why no test caught it

All five conversation fixtures in
[consumer-realtime-conversations-v2.json](../scripts/fixtures/consumer-realtime-conversations-v2.json)
model asset-rich people: a new parent with a €500k home and €100k pension,
retirement cases, corrections. **There is no young, low-asset persona in the
dataset at all.** And
[check-consumer-realtime-v2-evals.mjs](../scripts/check-consumer-realtime-v2-evals.mjs)
only validates the fixture *shape* (92 lines) — real conversational behaviour is
only exercised by the paid live probe
([run-consumer-realtime-conversation-probe.mjs](../scripts/run-consumer-realtime-conversation-probe.mjs)),
against one hard-coded case. We cannot currently test conversation quality
offline, so we cannot iterate on it.

### The structural problem in one sentence

> The pipeline is `goal → fixed module set → union of every module's required
> facts → fixed global priority order → fixed prompt string`, and every stage is
> decided before we know who we are talking to.

---

## 1. What good looks like — research grounding

Findings from current practice, and what each one implies here.

**One question at a time, in an Acknowledge → Confirm → Prompt shape.** Signal
you heard them, say what you captured, then ask one clear thing. Break richer
responses into exchanges rather than piling them into a turn.
([Cekura](https://www.cekura.ai/blogs/ai-voice-message-response-best-practices))
→ We already cap at one question (`maxQuestions: 1`), but we drop the
*acknowledge* and *confirm* halves, which is what makes it feel like a form.

**Conditional branching beats slot-filling.** The advantage of an LLM intake
layer over a rules engine is that a retirement enquiry gets timeline and savings
questions while an estate enquiry gets family-structure and asset-complexity
questions — the question set is *derived from the stated need*, not a fixed
union.
([Tars](https://hellotars.com/ai-agents/financial-advisor-quiz-chatbot),
[Forbes](https://www.forbes.com/sites/josipamajic/2025/11/06/ai-powered-financial-planning-and-the-rise-of-personalized-financial-independence-tools/))
→ This is precisely our Defect 1/2. We built a slot-filler and are asking it to
behave like an adviser.

**Select the next question by expected information gain, not by list order.**
Conversational clinical intake research selects from a large question bank by
scoring which question most reduces uncertainty about unfilled fields, and shows
a carefully-chosen subset recovers most of the information at a fraction of the
question count.
([arXiv 2604.22067](https://arxiv.org/pdf/2604.22067))
→ Directly replaces `orderedMissingFacts`. Crucially this is a *deterministic
scoring function*, so it keeps the model out of the decision and preserves our
authority boundary.

**Ask rather than guess, but only when uncertainty is real.** Systems get more
stable when agents surface uncertainty at the right moment; conversely,
suppressing unnecessary clarification questions is its own research problem —
confidence-ranked hypotheses decide whether to ask or proceed.
([Amazon Science](https://www.amazon.science/blog/reducing-unnecessary-clarification-questions-from-voice-agents),
[Medium](https://medium.com/@milesk_33/when-agents-learn-to-ask-active-questioning-in-agentic-ai-f9088e249cf7))
→ Gives us the rule for context facts: infer `property_status` from a confident
narrative, ask only when genuinely ambiguous.

**Structure the realtime prompt into labelled sections with sample phrases.**
Role & Objective, Personality & Tone, Context, Tools, Instructions, Conversation
Flow, Safety & Escalation. Bullets over paragraphs; capitals for critical rules;
concrete examples over abstract instruction; explicit variety rules to stop
repetitive phrasing; natural-language conditionals (`IF X THEN Y`) rather than
pseudo-code; word choice matters ("unintelligible" outperformed "inaudible").
([OpenAI realtime prompting guide](https://developers.openai.com/cookbook/examples/realtime_prompting_guide))
→ Our V2 instruction block
([realtime_provider.js:229](../worker/src/consumer/realtime_provider.js:229)) is
16 undifferentiated prohibition sentences plus a 12KB JSON blob. It is almost
the inverse of this guidance.

**Model and cost posture.** `gpt-realtime` handles complex instruction-following
and precise tool calls; `reasoning.effort: low` is the right default for voice,
raised only where latency allows. Cached input is ~80× cheaper than uncached, so
a stable prompt prefix is the single biggest cost lever.
([OpenAI](https://openai.com/index/introducing-gpt-realtime/),
[Forasoft](https://www.forasoft.com/blog/article/openai-realtime-api-voice-agent-production-guide-2026))
→ Argues for splitting our prompt into a **stable cacheable prefix** and a small
volatile suffix, rather than re-sending a fresh 12KB brief every update.

**Test voice agents as conversations, not as units.** Scenario-based simulation
across personas, with adversarial and edge-case coverage, is the standard.
([Cekura](https://www.cekura.ai/blogs/best-practices-for-ai-voice-agent-testing))
→ Our five fixtures and one paid probe are the binding constraint on iteration
speed.

---

## 2. Target architecture

Replace the linear slot-filler with a four-stage adaptive loop. Every stage
stays deterministic and server-owned.

```
ORIENT ──► ROUTE ──► ASK (scored) ──► CONFIRM
  ▲                     │
  └─────────────────────┘   re-orient whenever context facts change
```

| Stage | Owns | Decides |
|---|---|---|
| **Orient** | planner extraction + context facts | who this person is: age band, property status, work, household, dependants, pension existence |
| **Route** | `buildGoalModulePlan` + new relevance gates | which 1–3 modules, and which facts are *applicable* |
| **Ask** | new information-gain scorer | which single question next, and how to phrase it in context |
| **Confirm** | existing visual/spoken confirmation | unchanged |

The key inversion: **relevance gating happens before question generation**, and
**orientation happens before routing**. Today both happen after.

---

## 3. Workstreams

### W1 — Relevance gating (fixes the reported bug)

*Files:* `js/planning/goal_plan.js`, `js/planning/module_registry.js`,
`worker/src/consumer/realtime_fact_mapper.js`

1. **Add fact preconditions to the intake contract.** Extend the intake contract
   with an optional `applicability` predicate per semantic fact. `property_position`
   becomes *not applicable* when `property_status ∈ {renter, first_time_buyer,
   buying_soon, no_property}` — it resolves to `confirm_none` deterministically
   instead of generating a question. Same pattern for `pension_positions` when
   `has_pension === false`, `business_position` when
   `business_context === no_business_interest`, `college_cost_scenarios` when
   `dependant_count === 0`.
2. **Make `isEarlyLife` consult `property_status`**
   ([goal_plan.js:98](../js/planning/goal_plan.js:98)). A stated renter or
   first-time-buyer is the single most decisive signal for the property question
   and is currently ignored entirely.
3. **Break the circular fact gate.** Add a `ROUTING_CONTEXT_FACT_IDS` allowlist
   (`person_current_age`, `property_status`, `life_stage`, `career_stage`,
   `household_structure`, `dependant_count`, `has_pension`,
   `employment_context`) that `realtimeFactAllowed`
   ([realtime_fact_mapper.js:532](../worker/src/consumer/realtime_fact_mapper.js:532))
   accepts regardless of the currently-enabled modules. These facts *determine*
   module selection, so gating them on it is backwards.
4. **Re-route on context change.** When a routing-context fact lands, recompute
   the module plan. A 25-year-old renter should visibly lose the balance sheet
   and gain deposit/affordability questions mid-call.

**Acceptance:** a session whose first turn is *"I'm 25, renting, want to buy my
first place"* never produces a `property_position`, `mortgage_position` or
`target_retirement_income` question.

### W2 — Orientation phase

*Files:* `worker/src/consumer/realtime_planner.js`,
`worker/src/consumer/realtime_provider.js`

The opening should be a genuine open question — *"what brought you here, and
what's on your mind financially?"* — followed by the planner harvesting as much
orientation as the narrative supports, and asking at most **one or two** cheap
orienting questions only where inference is genuinely unsafe.

1. Rewrite the planner prompt rule at
   [realtime_planner.js:162](../worker/src/consumer/realtime_planner.js:162).
   Split the current single rule into two: **monetary and financial-position
   values must remain explicit** (unchanged, correctly conservative), but
   **orientation context may be inferred at `approximate` certainty** with the
   evidence span attached. Add worked examples: *"I'm 25 and renting"* →
   `life_stage=early_adult`, `property_status=renter`,
   `person_current_age=25 (exact)`. Remove "ownership" from the explicit-only
   list; keep property *values* explicit-only.
2. Add a `phase: 'orientation'` between `welcome` and `intake` in
   [realtimeV2PhaseGuidance](../worker/src/consumer/realtime_provider.js:213),
   with a bounded turn budget (default 3) so it cannot become an interrogation.
3. Feed orientation into the narrative summary so acknowledgements become
   specific — *"since you're renting and saving toward a first place…"* rather
   than a generic bridge.

**Acceptance:** for each new persona fixture, ≥3 orientation facts are captured
from the opening narrative alone, with zero extra questions asked.

### W3 — Information-gain question selection

*Files:* `worker/src/consumer/realtime_planner.js`

Replace the hard-coded array at
[realtime_planner.js:738](../worker/src/consumer/realtime_planner.js:738) with a
deterministic scorer. Proposed shape:

```
score(fact) =  moduleBlocking      // blocks a required module = highest weight
             × applicability       // 0 when precondition says not applicable
             × unlockCount         // how many modules/derived facts it releases
             × topicAdjacency      // bonus for staying on the current topic
             ÷ userEffort          // penalise facts the client must go look up
```

Properties that matter:

- **Deterministic and pure** — same profile in, same question out, in browser,
  Worker and tests, exactly like `buildQuestionPlan`
  ([question_plan.js:190](../js/planning/question_plan.js:190)) today.
- **`applicability = 0` short-circuits**, so W1's preconditions are enforced
  structurally rather than by prompt discipline.
- **`topicAdjacency`** fixes the other intelligence tell: jumping cash → pension
  → cash. Group by `questionTopic`
  ([realtime_planner.js:754](../worker/src/consumer/realtime_planner.js:754))
  and finish a topic before moving on.
- Keep the existing array as the **tie-break**, so behaviour is a strict
  refinement rather than a rewrite, and the current fixtures stay green.

**Acceptance:** questions-to-ready drops measurably on the new personas; no
question is ever asked whose `applicability` is 0; no topic is re-entered after
being completed.

### W4 — Rebuild both prompts to the realtime prompting guide

*Files:* `worker/src/consumer/realtime_provider.js`,
`worker/src/consumer/realtime_planner.js`

Restructure
[buildRealtimeConversationV2Instructions](../worker/src/consumer/realtime_provider.js:229)
into labelled sections: **Role & Objective / Personality & Tone / Context /
Tools / Rules / Conversation Flow / Safety & Escalation**. Specifically:

- Add a **sample-phrases block** — 6–10 example acknowledgements and bridges.
  The model imitates examples far more reliably than it follows adjectives, and
  this is the cheapest available win on "sounds intelligent".
- Add an explicit **variety rule** with a do-not-repeat list.
- Convert conditionals to natural language: `IF THE CLIENT GIVES A FIGURE AND A
  CORRECTION IN ONE TURN THEN CONFIRM THE CORRECTED FIGURE ONLY`.
- Add an **unclear-audio** section using "unintelligible", with a fixed recovery
  phrase and a rule never to guess a figure from unclear audio.
- Front the **Conversation Flow** with named states and explicit entry/exit
  conditions matching the Orient/Route/Ask/Confirm loop.
- **Split for prompt caching:** hold the ~90% stable policy text as a fixed
  prefix and append only the volatile brief slice. Given ~80× cached-input
  pricing this is both a cost and a latency win, and it makes A/B prompt
  versioning cleaner under `CONSUMER_REALTIME_PROMPT_VERSION`.

Trim the signed brief injection
([realtime_provider.js:230](../worker/src/consumer/realtime_provider.js:230)) —
12KB of JSON per session update is a large volatile payload; send the
conversation-guide projection
([toConversationGuide](../worker/src/consumer/realtime_planner.js:930)) instead
of the full brief.

**Acceptance:** prompt version bumped to `v5`; cached-token ratio measurably up;
no regression in the existing five fixtures.

### W5 — Offline conversational eval harness (the force multiplier)

*Files:* `scripts/check-consumer-realtime-conversation-sim.mjs` (new),
`scripts/fixtures/consumer-realtime-conversations-v2.json`

This is the highest-leverage item. Without it, every iteration on W1–W4 costs a
paid live probe run, so nothing gets iterated.

1. **Deterministic simulator.** Drive the real
   `composeMeetingBrief` → `orderedMissingFacts` → `conversationalQuestion`
   pipeline with *recorded* planner extractions per turn, asserting on the
   emitted `questionBatch.prompt`, `analyses`, and phase transitions. No network,
   no API key, runs in `npm run check:consumer`.
2. **Forbidden-question assertions per persona.** Each fixture gains a
   `mustNeverAsk` list of fact IDs and regexes. The 25-year-old renter case
   asserts that home value, mortgage balance and retirement income are never
   asked. This is the regression test for the reported bug.
3. **Expand the persona set** from 5 to ~14, covering the population we actually
   serve: young renter FTB · student/graduate · single renter with loan debt ·
   self-employed with no pension · couple with childcare costs · mid-career
   mortgage holder · pre-retiree · retiree in drawdown · company director ·
   farmer · high-net-worth family · lump-sum recipient · education funder ·
   ambiguous "just want a check-up".
4. **LLM-as-judge rubric** on live-probe transcripts, scoring relevance,
   repetition, one-question-at-a-time, warmth and specificity. Cheap, runs only
   on the paid probe, catches what regexes cannot.

**Acceptance:** `npm run check:consumer` fails on the 25-year-old case before
W1 lands and passes after; ≥14 personas green.

### W6 — Close the loop with learning-signals

*Files:* `worker/src/consumer/learning_signals.js`,
`services/learning-signals/`

The telemetry service is already live with a 28-event catalogue. Add the events
that make irrelevance *measurable*:

- `question_asked` (factId, module, score, orientation snapshot)
- `question_answered_not_applicable` — **the direct empirical measure of a
  stupid question**: asked for something the client does not have
- `questions_to_ready` per persona cluster
- `orientation_facts_inferred_vs_asked`
- `module_plan_changed_mid_call` (re-routing working as intended)

A weekly report ranking fact IDs by not-applicable rate tells us exactly which
preconditions to write next, from real calls rather than guesses.

---

## 4. Sequencing

| Phase | Contents | Outcome |
|---|---|---|
| **P0 — this week** | W5.1 + W5.2 + the young-renter fixture; W1.2 (`property_status` in `isEarlyLife`); W1.3 (routing-fact allowlist); W2.1 (planner prompt inference rule) | The reported bug is caught by a test, then fixed. Smallest change that removes the symptom. |
| **P1** | W1.1 full precondition system; W1.4 re-routing; W5.3 persona expansion | No module ever asks a structurally inapplicable question. |
| **P2** | W3 scorer; W2.2/W2.3 orientation phase | Question *order* becomes intelligent, not just filtered. |
| **P3** | W4 prompt rebuild + caching split | Delivery becomes warm and specific; cost per call drops. |
| **P4** | W5.4 judge; W6 telemetry loop | Continuous measurement; further fixes become data-driven. |

P0 is deliberately shaped so the fix ships behind the existing
`CONSUMER_REALTIME_CONVERSATION_V2_ENABLED` canary with no new flags.

---

## 5. Explicitly out of scope

To be clear about what is *not* proposed, since the temptation with "make it
smarter" is to hand the model the wheel:

- The model still never selects modules, calculates, confirms facts, or decides
  eligibility. Routing stays in `buildGoalModulePlan`.
- No new model authority over profile writes. The planner remains a silent
  extractor whose output the Worker validates.
- No change to the visual/spoken confirmation gate before analyses run.
- No relaxation of the monetary-values-must-be-explicit rule. W2 loosens
  *orientation* inference only, at `approximate` certainty with evidence.

The intelligence comes from asking the right question in the right order with
the right context — not from trusting the model with more.

---

## 6. Open questions for Gerry

1. **Orientation question budget** — is 2 orienting questions acceptable before
   the first substantive one, or should orientation be inference-only?
2. **Balance-sheet default** — for a young renter, drop to a 2-module plan, or
   substitute a lighter third module (a savings/deposit view)?
3. **Persona list** — the 14 above are my read of the target market; confirm or
   amend before W5.3 hardens them into fixtures.
