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

## 7. One-paragraph answer

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
