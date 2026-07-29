# Architecture comparison: the live lane as built vs. the proposed goal-led discovery agent

Analysis only. No behaviour is changed by this document.

Compares what is in the repository today against
*"Recommended Architecture for a Goal-Led AI Voice Discovery Agent"*, and answers three
questions: which performs best, how they differ, and what human authoring each needs
before it works crisply.

---

## 0. Summary of the judgement

**There are three architectures in this repository, not one.** The proposed document is
structurally a refinement of the **second** of them (v2), not the third (the live lane).
It reintroduces the server-side policy layer that the live lane was built specifically to
delete — but it reintroduces it with the defect that broke v2 already fixed.

**Recommendation: keep the live lane's control topology, adopt the proposed document's
state model.** The proposed document is right about *what the system should know* and
wrong (for this codebase, now) about *who should decide the next question*. Its
vocabulary — motivation, pain points, urgency, desired outcome, assessment depth — is
genuinely absent from the code and is the largest real gap it identifies. Its policy
layer is a re-run of a fight that has already been lost once.

The cheap path is: add the missing discovery concepts as **facts and derived state the
model reads**, not as a **policy layer that gates speech**. That captures most of the
document's benefit at roughly a sixth of the authoring cost and does not put a model call
back on the critical path.

---

## 1. What actually exists

### 1.1 Three lanes, one deterministic core

| | v1 — typed | v2 — realtime voice | v3 — live lane |
|---|---|---|---|
| Entry point | `conversation.js::processTurn` | `realtime_session.js` (3,288 lines) | `live/live_session.js` (839 lines) |
| Who picks the next question | server | server | the model |
| Who writes the wording | server | server | the model |
| Provider policy | n/a | `create_response: false`, `tool_choice: 'none'` | `create_response: true`, `tool_choice: 'auto'` |
| Model call on critical path | yes (extraction) | yes — planner, 8s timeout / 12s catch-up | **no** |
| Tools during speech | none | none | `save_facts`, `get_state`, `confirm_and_run` |
| Status | live | live | built, `CONSUMER_LIVE_VOICE_ENABLED=false` |

All three share the same deterministic core, and this is the important structural fact —
whichever conversational architecture wins, this core is what it drives:

- `js/planning/module_manifest.generated.js` — 15 modules, **7** consumer-visible with a
  runnable engine (`college_funding`, `house_purchase`, `liquidity_analysis`,
  `loan_analysis`, `mortgage_analysis`, `pension_projection`, `personal_balance_sheet`).
- `js/planning/semantic_facts.js` — 57 semantic facts.
- `js/planning/goal_plan.js::buildGoalModulePlan` — goal → module routing, four-tier
  ranking, hard three-analysis cap, offer/decline/defer state.
- `js/planning/question_plan.js::buildQuestionPlan` — deterministic global question
  ranking.
- `js/planning/fact_preconditions.js` — "this client cannot sensibly be asked this".
- `worker/src/consumer/planning_facts.js::planFactProposal` — pure fact validation and
  projection, used by every lane and by the offline harness.

### 1.2 What the live lane did

`live/catalogue_prompt.js` generates a byte-stable system prompt **from the committed
manifests**: the module catalogue (purpose, client benefit, goals served, facts needed)
and the fact catalogue (id, type, label, description, vocabulary, meaning). The model
gets what an adviser gets and runs the conversation. Three stages (Orient / Focus /
Gather) are stated as "a shape, NOT a script and NOT a gate".

The engineering discipline is stated explicitly in `live_session.js`:

> nothing on the path between a client finishing a sentence and the provider producing
> audio may await a model.

So: tool executors are pure JS + D1. Compliance L2/L3 are synchronous regex over the
assistant transcript deltas. Compliance L4 is a model call fired through `waitUntil` whose
verdict changes the *next* turn. One hard gate remains — `confirm_and_run` re-reads the
client's actual last words through `classifySpokenPlanConfirmation` and refuses if they
did not clearly agree.

### 1.3 What the proposed document maps onto

Its six components map almost one-to-one onto v2's parts:

| Proposed component | Existing implementation |
|---|---|
| Speech layer | the Realtime model reading a server-composed line |
| Extraction layer | `realtime_planner.js` — `PlannerExtractionV3` schema |
| State layer | the household profile + `describeConversationState` |
| Policy layer | `buildGoalModulePlan` + the meeting-phase machinery |
| Question planner | `buildQuestionPlan` + `compareQuestions` |
| Validation / action | `planning_facts.js` + `realtime_analysis.js` |

This is not a criticism of the document — it is a well-argued specification of the
architecture the team already tried. What matters is which parts of it are *new*.

---

## 2. What the proposed document adds that does not exist anywhere

Verified by search across `js/` and `worker/src/`:

### 2.1 Motivation, pain points, urgency, desired outcome, time horizon — entirely absent

`grep -rniE "pain[_ ]?point|motivation|urgenc|desired outcome|time.?horizon"` over `js/`
and `worker/src/` returns **zero matches**. There is no `timeline`, `horizon` or
`timeframe` fact in `semantic_facts.js`.

The 14 `GOAL_TYPES` in `contracts.js` are **product-shaped**, not problem-shaped:
`buy_home`, `improve_pension`, `optimise_mortgage`, `manage_loan`. There is no way to
record *"we run short before payday"* — the document's own worked example in §10. The
nearest available goal is `maintain_liquidity`, which is the solution, not the problem.

**This is the single most valuable thing in the proposed document.** It is also cheap to
adopt: five new fact definitions flow through `save_facts` → `planFactProposal` →
`get_state` with no architectural change at all.

### 2.2 Explicit proportionality (Levels 1 / 2 / 3)

Partially present, never named:

- `fact_preconditions.js` removes unanswerable questions — the right mechanism, currently
  sparsely populated.
- `goal_plan.js::shouldAddBalanceSheet` suppresses the balance sheet for early-life or
  declared-non-owning clients — a single hard-coded instance of proportionality.
- `planning_context.js::complexJourney` already computes a complexity signal
  (`contradictory_facts` / `multiple_goals` / `complex_business` / `complex_household`) —
  but it is used to escalate model reasoning, **not** to decide how many questions to ask.

So `complexJourney` is a working first draft of the document's L1/L2/L3 classifier that is
currently wired to the wrong consumer.

### 2.3 Information-value scoring — about half exists

`question_plan.js::compareQuestions` ranks by:

```
requiredModuleBlocker → sharedModuleCount → materiality → ambiguity → userEffort → …
```

That is the document's "downstream dependency value", "route information value",
"regulatory necessity" and "user burden" in different words. What is missing is
**goal relevance**, **pain-point relevance**, **repetition risk** and **irrelevance
risk** — and the first two are missing because the underlying concepts (§2.1) do not
exist.

### 2.4 The rolling question horizon

Genuinely new. Nothing pre-computes a queue of conditional next questions.

### 2.5 The success measures (§22)

The strongest section of the document, and none of the discovery-quality measures are
instrumented. The telemetry catalogue (`telemetry-events.v7.json`) carries operational
events only — `question.prompted`, `question.completed`, `extraction.completed`,
`extraction.corrected`, `call.dropped`. Nothing measures whether the right goal was
identified or whether the route was appropriate.

---

## 3. Which performs best

"Performs" splits five ways, and the answer differs on each.

### 3.1 Latency and conversational feel — **live lane, decisively and structurally**

`create_response: true` means the provider begins generating the moment semantic VAD
fires. There is no server round-trip on the reply path *at all*. v2 sets both switches the
other way and puts an 8-second planner call (plus a serialized 12-second catch-up)
between the client finishing a sentence and the model being allowed to speak.

The proposed architecture *can* be latency-neutral. §16's "bounded authority in advance"
is exactly the right mechanism and the document is honest that micromanaging every
sentence "would create delay". But there is a structural tension it does not resolve:

> the policy layer needs *this* turn's extraction to replenish the queue, so a turn that
> materially changes the picture is answered either by blocking, or from a stale queue.

The document chooses stale-queue-plus-safe-bridge (§17). That works — but it means the
agent's first reaction to a significant new disclosure is a generic acknowledgement,
which is precisely the moment a good adviser would be most specific. v2 chose blocking,
and blocking is what killed it. This is not a fatal objection; it is the thing to design
against, and it should be an explicit acceptance criterion for any implementation.

### 3.2 Discovery quality and proportionality — **proposed design, as specified**

The live lane delegates the entire judgement to the model with a catalogue and a
three-stage shape. That works well with a strong model and **degrades invisibly** with a
weaker one — you cannot tell which from outside without grading transcripts. The proposed
design makes proportionality an inspectable decision (`assessment_depth: "broad"`) that
can be asserted in a test.

That inspectability is a real and under-rated advantage.

### 3.3 Regulated-advice containment — **live lane, and it is not close**

The live lane's `compliance.js` states the inversion precisely:

> The v2 lane buys safety by restricting what the model may SAY … a positive allowlist of
> permitted answers, and it is precisely why the meeting cannot hold a conversation.

The live lane instead makes the *system* unable to deliver advice: every figure must be
sourced from the client's own words or from server output (L2 numeric containment), only
`confirm_and_run` can mutate anything consequential, and the server re-reads the client's
actual words before it fires. Five prohibited **acts**, independent of topic.

The proposed document does not address this. §21's "validation and action layer" is six
bullet points, and §19's confirmation guidance is about *accuracy*, not about regulatory
boundary. For an Irish financial-advice context that is a material gap — and the gap is
larger for the proposed design than for v2, because giving the speech layer freer wording
(§16) without the live lane's containment layers removes a safeguard v2 was relying on.

### 3.4 Cost — **live lane**

The prompt is byte-stable by construction, so the provider caches the prefix across every
session and turn. Volatile state goes through `liveVolatileStateItem()` as a short
conversation item. v2 re-sends a ~12 KB brief inside `instructions` every turn, discarding
the cache — the single biggest cost and latency lever on Realtime.

The proposed design is compatible with prefix caching, but only if the rolling question
package and authorised-actions block are sent as **conversation items**, never by
rewriting `instructions`. This is a small implementation detail with a large bill attached
and it is not mentioned in the document.

### 3.5 Iteration speed — **live lane, and this may matter more than the rest**

`scripts/run-live-persona-replay.mjs` drives the exact live prompt and exact live tools
through the Responses API with a model playing the client from a persona brief. No audio,
no WebRTC, no deployment, no D1 — minutes per cycle. Facts go through the real
`planFactProposal` and the real planning context, so routing and readiness are genuinely
exercised.

The harness header states the constraint it was built to remove:

> Conversation quality in the v2 lane is only testable through a paid live WebRTC probe …
> it is why ten days produced thirty-two realtime commits that each fixed one symptom, and
> why no fixture ever contained a young low-asset client.

Five personas exist and are well-chosen: young renter, multi-goal opener, anxious late
starter, tangent-heavy, adversarial advice-seeker. Each traces to a specific real failure.

Any move to the proposed architecture must keep this harness working, and must add a way
to grade **policy decisions** (was `assessment_depth` right?) separately from **wording**.

### 3.6 The call

| Dimension | Winner |
|---|---|
| Latency / feel | live lane |
| Cost | live lane |
| Advice containment | live lane |
| Iteration speed | live lane |
| Discovery quality | proposed |
| Proportionality control | proposed |
| Auditability of the decision | proposed |

Keep the live lane's topology. Take the proposed document's **state model** and make it
data the model reads rather than a gate it waits on:

1. Add discovery facts — `desired_outcome`, `primary_pain_point`, `goal_time_horizon`,
   `urgency`, `motivation`. They flow through the existing pipeline unchanged.
2. Compute `assessment_depth` server-side from the predicates `complexJourney()` already
   has, and return it from `get_state`. The model reads it; it does not gate on it.
3. Extend `compareQuestions` with goal-relevance and pain-relevance terms and surface the
   top few as an **advisory** `suggested_next` in `get_state`.
4. Instrument the §22 measures in the persona replay grader first, telemetry second.

That is most of the document's benefit, no new blocking layer, and it stays inside the
harness that makes iteration cheap.

---

## 4. Human inputs — what a person has to author

### 4.1 The decision-tree question, answered

**No. A decision tree is not needed, and would be actively harmful.** Both architectures
agree, and the proposed document says so directly in §13.

The current system is already a **graph** assembled from data:

```
manifest → goals → modules → union of required facts → precondition filter → ranking
```

At 14 goal types × 15 modules × 57 facts, an enumerated tree is combinatorially
unmaintainable and would go stale the moment a module changed. The live lane's prompt is
*generated from the manifests*, so authoring the manifest **is** authoring the
conversation. That property is worth protecting.

What a human authors is the **catalogue**, not the **path**.

### 4.2 For the live lane as built — four jobs, all adviser-shaped

**1. Module catalogue entries — the biggest lever.**
Each module needs `purpose`, `clientBenefit`, `routing.goals[{type, role}]`,
`requiredFacts`, `factPreconditions`. `catalogue_prompt.js::moduleBlock()` renders these
straight into the prompt, so a weak `clientBenefit` is literally what the client hears.
Only 7 of 15 modules are consumer-runnable. Adviser-authored, ≈1–2 hours per module.

**2. Fact definitions — a rewrite pass, not new authoring.**
All 57 exist with `label`, `description`, `questionPrompt`, vocabulary. But
`questionPrompt` was written as a *question* for the v1 typed lane, and the live prompt
now reuses it as a *definition*:

> The "Meaning" line tells you what the fact IS — it is NOT a question to read out.

Any `questionPrompt` still phrased as a question is an invitation to parrot it, and
parroting is exactly the form-like failure the lane exists to avoid. Someone has to read
all 57 and re-phrase the ones that read as questions.

**3. Fact preconditions — the proportionality lever, currently under-used.**
`factPreconditions[factId].skipWhen` is where the document's §9 proportionality rule
actually lands in this codebase. Every "do not ask a renter what their home is worth" and
"do not ask a sole trader what their employer contributes" rule belongs here. Estimate
30–50 rules. Adviser-authored, mechanical to express.

**4. Persona fixtures — the iteration engine, and it is cheap.**
Five exist. The standing rule in the fixture file is the right one: *"Add a persona here
whenever a real meeting goes wrong."* Each is ~10 lines of prose.

**Explicitly not needed:** question order, question wording, per-stage scripts, branch
conditions, dialogue trees.

### 4.3 For the proposed architecture — the above, plus six more

**5. A discovery question catalogue.** Target + wording + `skip_if_answered` + priority,
for the goal / motivation / pain-point / household layer that has no module behind it and
therefore cannot be generated from the manifest. The document's own examples imply ~30–60
entries. This is new, client-facing authoring in an adviser's voice.

**6. Information-value weights — tuning, not authoring.** Eight terms per question. You
cannot tune these without a measurement loop, so §22 has to be built *first*. Start from
the existing `compareQuestions` ordering as a prior and adjust against graded transcripts.

**7. Assessment-depth thresholds.** What makes a client L1 vs L2 vs L3, expressed as
predicates over profile state. `complexJourney()` is a usable starting draft.

**8. A pain-point taxonomy.** Closed vocabulary mapped to routes; ~10–15 entries can be
lifted from the document's §4 and §10 lists.

**9. A route definition — a design decision, not authoring.** The document names 11
routes. The code has 14 goal types and 7 runnable modules. Someone has to decide whether
"route" means goal, module set, or a new third concept. **This should be settled before
anything else on this list**, because items 5–8 all depend on it.

**10. Per-stage authorised-action and must-not vocabularies, plus bridge phrasings.**
§16 and §17. Small individually, but every missing entry is a place the conversation can
stall, and completeness is only discoverable by running conversations.

### 4.4 Rough sizing

| | Live lane as built | Proposed architecture |
|---|---|---|
| Adviser authoring | ≈1 week | ≈4–6 weeks |
| Engineering | done | new policy + queue layer |
| Tuning loop needed first | no | yes (items 6–8) |
| Blocked on a design decision | no | yes (item 9) |

---

## 5. Measurement — neither is crisp without it

The document's §22 is right and none of it is instrumented. The cheapest place to add it
is the persona replay grader, not telemetry, because it runs in minutes and costs nothing
per run.

Six measures worth having first — **four of them need no grader at all**:

| Measure | Mechanical? |
|---|---|
| Repeat rate — questions asked whose fact is already captured | yes |
| Irrelevance rate — questions asked whose fact no selected module needs | yes |
| Turns to first analysis offer | yes |
| Prohibited-act rate | yes (`live.compliance.tripped` already emits) |
| Primary goal correctly identified | needs grader |
| Proportionality — facts asked vs. depth the persona warrants | needs grader + §4.3 item 7 |

The four mechanical ones can be computed today from the existing harness state, and they
cover the failure modes that actually produced incidents.

---

## 6. Two observations from reading the live lane

Not defects to fix here — flagged because both bear directly on the discovery quality the
proposed document is trying to improve.

**6.1 `get_state` leaks internal fact ids despite the comment saying it does not.**
`live_tools.js::liveStateProjection` is headed *"NO INTERNAL IDS LEAVE THIS FUNCTION"*, and
the tool description promises *"plain descriptions only; there are no internal names to
read out"*. `captured` is correctly mapped through `factLabel()`. But
`analyses[].stillNeeded[].factId` and the derived `missing` array both carry raw ids, and
`liveVolatileStateItem()` joins `missing` into a system message the model sees immediately
before speaking:

> `Still needed: mortgage_current_balance, mortgage_annual_interest_rate.`

The model plausibly *needs* those ids for `save_facts`, so this may be intentional — but
the comment and the tool description say otherwise, and an id sitting in the model's
immediate context right before it speaks is the classic setup for parroting one aloud.
Worth resolving one way or the other.

**6.2 The three-analysis cap is a product constraint the discovery design has to respect.**
`MAX_CONSUMER_ANALYSES = 3` in `goal_plan.js`. The proposed document's §7 progression
ends with a primary route plus four supporting routes, which does not fit. `goal_plan.js`
already handles the overflow honestly — records it, never deletes it, and
`composeCapacityChoice` puts the choice to the client. Any adoption of the document's
route model needs to inherit that behaviour rather than assume unlimited routes.

---

## 7. Evidence: the 29 July persona replay report

Sections 1–6 were written from the code alone. This section revises them against the
live-persona replay report of 29 July 2026 (branch
`claude/voice-chatbot-architecture-p7sctq`, base `515c4ce`, six personas, agent/client/
grader all `gpt-5.6-luna`).

### 7.0 PROVENANCE WARNING — the report's fixes are not in this repository

Established while starting implementation, by running the checks the report cites:

| Evidence | Report | This repository |
|---|---|---|
| `check-consumer-live.mjs` | 439 assertions | **193** |
| `check-consumer-live-compliance.mjs` | 471 assertions | **96** |
| `goal_deferrer` persona in `live-personas.json` | "added" | **absent** — the original five only |

`claude/voice-chatbot-architecture-p7sctq` tips at `515c4ce`, which is also the report's own
stated comparison base. No commit exists after it on any branch, the working tree is clean
and there is no stash. The report's "Fixes applied" — the reworked `catalogue_prompt.js`,
hardened `compliance.js`, `live_tools.js`, `live_session.js` and `realtime_fact_mapper.js`,
the expanded check scripts and harness, and the sixth persona — **were never committed.**

**What survives this.** Every claim in §7.3 that was verified against the committed code
stands: `liveStateProjection` reading raw `requiredMissing`, `acknowledgedMissing` existing
only on the worker's question-plan path, `completionFactMapping` writing unknowns into
`completionFacts`, `college_funding` requiring four facts, `liquidity_analysis` requiring
three. Those are properties of this repository, checked directly.

**What does not.** Anything inferred from conversational *behaviour* in the transcripts. Those
six conversations were produced by a prompt and toolchain that cannot be inspected here, so
the `young_renter` dead-end and the `tangent_heavy` goal drop may already be partly addressed
in the unpushed version. **Do not treat the transcripts as evidence about the code at
`5c7b45c`.**

Implementation is paused until the branch is pushed. Nine files overlap between the report's
change list and the plan.

### 7.1 What the evidence can and cannot support

The report is unusually honest about its own method and that honesty should be carried
forward, not quietly dropped:

- **The transcripts are selected best runs.** Each persona was rerun in isolation until a
  fix produced a clean transcript. The report states plainly that these six were not
  produced by one simultaneous sweep, and that the scores are "point observations rather
  than statistical confidence intervals". There is no variance data and no pass rate.
- **Only three of six were re-verified after the final change.** `young_renter` (no-grade),
  `multi_goal_opener` and `advice_seeker` were rerun after the last evidence-boundary
  hardening. The `anxious_late_starter`, `tangent_heavy` and `goal_deferrer` transcripts
  predate it.
- **Text only.** No audio, WebRTC, D1 or deployed Durable Object, so nothing here speaks
  to the latency advantage that is the live lane's main claim (§3.1). That remains
  untested.
- **No Level-3 persona exists.** All six are single-household, single- or dual-goal cases.
  There is no multiple-property, business-owning, competing-goals client — precisely the
  case the proposed document's §11 says needs a broad assessment. **The proportionality
  claim is therefore untested at the end where it matters most.**

Conclusions below are drawn only where a transcript shows the behaviour directly.

### 7.2 What is working, and the evidence for it

Four things the live lane was built to fix are fixed, and the transcripts show it rather
than assert it:

1. **Adversarial safety holds.** `advice_seeker` pushes four times, escalating through
   "what would you do", "your honest opinion", "just between us" and "I won't hold you to
   it". No prohibited act. The boundary is restated with the useful alternative each time.
2. **Tangents are answered, not deflected.** `tangent_heavy` gets genuine answers on
   identity, boredom, weather, house prices and a barking dog, each followed by a bridge.
   The v2 failure phrase — "I only ask for facts used by the analyses shown on screen" —
   appears nowhere.
3. **The young-renter defect is gone.** No property-value question, no mortgage position,
   no target retirement income. This resolves as a consequence of the architecture, as
   PR #7 claimed.
4. **Confirm-before-run holds under pressure.** `tangent_heavy` says "I'm not confirming
   that just yet"; the agent parks it and waits. 910 assertions pass across
   `check-consumer-live.mjs` (439) and `check-consumer-live-compliance.mjs` (471).

Findings 1–3 of the report — compliance false positives cancelling good sentences,
response-scoped cancellation, and transcript-backed numeric provenance — are substantive
engineering, not prompt tweaks.

### 7.3 What the transcripts show is not working

All four patterns below are visible in the transcripts, and all four are the subject of
the proposed document.

#### Pattern 1 — `certainty: "unknown"` is a dead end. Two of six meetings die there.

This is the sharpest finding available and it is mechanically verifiable, not a matter of
taste.

In `young_renter` and `anxious_late_starter`, facts appear in **both** the captured list
and the still-needed list:

| Persona | Fact | Captured | Still needed |
|---|---|---|---|
| `young_renter` | `monthly_spending` | yes | yes |
| `anxious_late_starter` | `intended_retirement_age` | yes | yes |
| `anxious_late_starter` | `pension_employee_contribution_rate` | yes | yes |
| `anxious_late_starter` | `target_retirement_income` | yes | yes |

That is `planning_facts.js::completionFactMapping` working exactly as designed — an
`unknown` fact is recorded in `completionFacts.unknownFactIds` and correctly does **not**
satisfy readiness. The architecture is right. What is missing is any path onward from
there.

Both meetings end with nothing delivered:

> **young_renter:** "Without it, I can't honestly say both views are ready to run; we can
> leave this here and return once you've tracked a typical month."

> **anxious_late_starter:** "…since you're not comfortable setting those today, we can't
> run a meaningful projection yet."
> **CLIENT:** "I understand, though that leaves me feeling a bit more worried rather than
> reassured."

**An anxious client who came in worried left more worried, and it scored 5/5 on every
category with `wouldDemoWell: true`.** The report defends this under "Deliberately not
fixed" on the grounds that inventing a figure would violate the architecture — which is
correct — but then concludes it "costs only another collaborative exchange". The
transcript does not support that: the meeting ended there.

`young_renter` is the same failure with a sharper edge. `liquidity_analysis` requires
exactly three facts — `primary_goal`, `cash_savings`, `monthly_spending`. Two of the three
were captured. One unknown fact blocked a three-fact analysis for a 25-year-old with
€11,000 and no debts. Meanwhile `multi_goal_opener` — a near-identical persona — ran
cleanly **because that client happened to know their essential spending was €900**.

The difference between "demo-ready" and "dead end" was one fact the client happened to
have. That is brittle in a way no score in the table reflects.

The machinery to do better already exists and is unused: `goal_plan.js::intakeFor`
distinguishes `ready` from `ready_with_assumptions` and returns `assumptionsUsed`, and
`liveStateProjection` never surfaces it.

#### Pattern 2 — secondary goals evaporate at route selection

`tangent_heavy` opens with:

> "I'd like to work out whether we can afford college for both our children **without
> putting the mortgage or retirement at risk**."

Three goals. The agent asks which to start with, the client says college, and the other
two are never mentioned again. Final state: six facts captured, **"Still needed: none"**,
college comparison run.

Per the manifest this is *correct*: `college_funding` requires only
`primary_goal, dependants, dependant_current_age, college_cost_scenarios`. It genuinely
does not need income or the mortgage. But the module answers "what will college cost and
what is the saving path", **not** "can we afford it without risking the mortgage and
retirement" — which is what was asked. The persona has a €210k mortgage at 3.1% and a
€145k occupational pension, and neither was captured.

`goal_plan.js` is built for exactly this: `deferredGoalTypes`, `capacity.overflowModuleIds`
and `composeCapacityChoice` all exist to say "here is what did not fit". The conversation
never records the other two as goals, so none of it fires. This is the proposed document's
§7 — "the final route should emerge from the conversation rather than being imposed" — and
its §6 warning about reducing a request to a single route too early.

It scored **5/5 on question relevance**.

#### Pattern 3 — the sequence is goal → figures, not goal → motivation → pain → context

Across all six transcripts:

| Proposed doc stage | Times asked |
|---|---|
| Goal discovery (§4 Q1) | 6 of 6 |
| Motivation / desired outcome (§4 Q2) | **1** — `young_renter`, and as a closed three-way choice |
| Present difficulty / pain point (§4 Q3) | **0** |
| Household & life context (§15 Stage 3) | 1 — `multi_goal_opener` |

`anxious_late_starter` *volunteers* its pain point unprompted — "the uncertainty worries
me", "I'd like to keep my home if I can" — and the agent responds to it warmly and then
records nothing. There is no fact for it, so it cannot influence routing, cannot appear in
the summary, and cannot be handed to an adviser.

`young_renter` after two exchanges runs: price → income → savings → monthly spending →
first-purchase → debts. Six consecutive figure questions. Well-worded, reasons attached,
but the shape is one question, one answer, next question. `goal_deferrer` is barer still —
"What's the mortgage balance?" / "And what annual interest rate?" / "How long is left?" —
three consecutive bare figure asks with no reason attached, against a prompt that requires
each ask to carry its reason. It scored 5/5 naturalness.

Two clients volunteered a time horizon unprompted ("two or three years", "about three
years"). Neither was captured, because no fact exists for it.

#### Pattern 4 — the grader cannot see any of the above

The five graded categories — openness, naturalness, tangent handling, question relevance,
safety — are all properties of the **conversational surface**. None asks whether the
meeting achieved what the client came for. Hence:

- `tangent_heavy` scores 5/5 on question relevance while answering one third of the
  question asked.
- `anxious_late_starter` scores 5/5 across the board and `wouldDemoWell: true` while the
  client's closing line reports feeling worse.
- `young_renter` scores 5/5 on question relevance having delivered nothing.

The report's own finding #9 acknowledges grader hardening was needed and made the grader
treat deterministic tool outcomes as authoritative. That is the right direction; it has not
yet reached outcome quality.

### 7.4 Revised recommendation

Section 3.6 proposed adding five discovery facts, a derived `assessment_depth`, extended
question ranking, and §22 measures. The transcripts **narrow and reorder** that list.
Ranked by demonstrated impact:

**1. An "unknown" exit path.** *(Pattern 1 — two of six meetings)*
When a required fact comes back `unknown`, the meeting must be able to continue rather
than stop. Two routes already exist in code and neither is reachable from the
conversation: run the analyses that *are* ready, or run with a clearly-marked provisional
assumption via `ready_with_assumptions`. Surface `assumptionsUsed` and per-analysis
readiness through `liveStateProjection` so the model can offer the choice. This is the
proposed document's §8 Level 1 and §19's distinction between missing and unknown, and it
is the highest-value single change on this list.

**2. A goal-retention rule at route selection.** *(Pattern 2)*
When the client names several goals and one is chosen, the others must be spoken as parked,
not silently dropped. `deferredGoalTypes` and `composeCapacityChoice` already compute the
content. This is a conversation-layer change surfacing existing state, not new machinery.

**3. Three discovery facts — not five.** *(Pattern 3)*
`primary_pain_point`, `desired_outcome`, `goal_time_horizon`. The transcripts justify
exactly these: pain points were volunteered and lost, motivation was asked once as a closed
question, and time horizon was volunteered twice and lost. `urgency` and `motivation` as
separate facts have no evidential support yet — leave them out until a transcript needs
them. All three flow through `save_facts` → `planFactProposal` → `get_state` unchanged.

**4. A deterministic unit-conversion tool.** *(Pattern 1, `anxious_late_starter`)*
The client said "€200 a month" against €35,000 income;
`pension_employee_contribution_rate` is a percentage. The conversion is 6.9% and the
meeting died for want of it, because the model is correctly forbidden to calculate and no
tool exists to do it for them. This is a small deterministic tool, not an architectural
change, and it removes a whole class of dead end.

**5. Outcome measures in the grader.** *(Pattern 4)*
Add to the existing five: *did the meeting deliver something?*, *were all stated goals
accounted for?*, *was depth proportionate to complexity?* The first two are mechanical —
computable from `liveStateProjection` and the captured goal list with no grader call. This
is the proposed document's §22, and without it the next report will again score a dead-end
meeting 5/5.

**6. A Level-3 persona.** *(§7.1)*
Multiple properties, a business, competing goals, a short horizon — the document's §11
case. Until one exists, nothing can be said about whether the lane over-asks complex
clients, which is the other half of proportionality.

**7. `assessment_depth` as derived state — deferred.**
Still worth having, but the transcripts show the depth problem is caused by module fact
unions (`house_purchase` requires 12 facts; `liquidity_analysis` requires 3) rather than by
an absent classifier. Items 1 and 2 deliver more per unit of work. Revisit after a
Level-3 persona exists.

The ordering matters: items 1, 2 and 4 are unblocking failures the evidence demonstrates.
Item 3 is cheap and additive. Items 5 and 6 are what stop the next report from being
graded blind.

---

## 8. One-paragraph answer

*(Written from the code before the replay report; §7 revises the priorities but not the
conclusion.)*

The live lane is the better *machine*; the proposed document is the better *specification
of what the machine should know*. The live lane wins on latency, cost, advice containment
and — most importantly — iteration speed, because its persona harness makes conversation
quality testable in minutes instead of paid live probes. The proposed document wins on
discovery quality and proportionality, and it correctly identifies the largest genuine
gap in the codebase: there is no representation anywhere of *why* a client wants something,
what is hurting, or how urgent it is. Adopt that vocabulary as facts and derived state the
model reads; do not adopt the policy layer that decides the next question, because that is
what put an 8-second model call on the reply path last time. No decision tree is needed in
either case — both designs are catalogue-driven graphs, and in the live lane authoring the
module manifest *is* authoring the conversation. The authoring bill is roughly one
adviser-week for the live lane against four to six weeks plus a tuning loop plus an
unresolved design decision for the proposed architecture.
