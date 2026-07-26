# Realtime Intelligence — Complete Implementation Plan

**Status:** implementation-ready. Supersedes and consolidates
[realtime-conversation-intelligence-plan.md](realtime-conversation-intelligence-plan.md)
(tactical diagnosis) and
[goal-driven-module-orchestration-plan.md](goal-driven-module-orchestration-plan.md)
(architecture evaluation). Read those for the underlying reasoning; this document
is the build.

Three requirements were added after the architecture review:

- **R1 — Conversational memory into intake.** Anything the client has already
  said must never be asked again cold. When a module needs an attribute of
  something they already mentioned, the question must reference the mention:
  *"You said you own a house — could we get a value for that?"*
- **R2 — A directed, calming opening.** Not "what brings you here today?" —
  settle the client, reduce stress, then ask directed questions, using the
  technique the best financial planners actually use.
- **R3 — Adviser module administration.** View and edit modules in the adviser
  area: change which goals a module serves so it surfaces in more calls, and
  prioritise modules (e.g. always include the Personal Balance Sheet where
  possible) — replacing today's hardcoded behaviour.

---

## 1. Diagnosis of the two new gaps

### R1 — why the conversation forgets

The pipeline does retain a valueless position. A complete statement like *"I own
a house"* survives the fragment filter at
[realtime_planner.js:618](../worker/src/consumer/realtime_planner.js:618) and is
written as a `property_position` fact with an `entityId` of `home` and no
`amount`. Readiness then correctly reports `/properties/0/currentValue` missing.

The failure is at the **last step**. `conversationalQuestion`
([realtime_planner.js:767](../worker/src/consumer/realtime_planner.js:767)) is a
static map keyed on `factId` alone:

```js
const prompts = {
  property_position: 'Do you own your home, and if so, roughly what is it worth?',
  cash_savings: 'Roughly how much do you currently hold in cash or savings?',
  ...
};
```

There is exactly **one** hand-rolled context-aware case in the whole system —
property value, detected by regex-matching the readiness reason string
([realtime_planner.js:770](../worker/src/consumer/realtime_planner.js:770)):

```js
const propertyValueMissing = factId === 'property_position'
  && /\b(?:current value|currently worth)\b/i.test(reason);
```

That one special case proves the mechanism works and shows it was never
generalised. Nothing else — pensions, loans, rent, income — gets it, and even
the property case does not reference the earlier mention.

**And the model is forbidden from fixing it.** The intake phase guidance says:

> `Ask exactly the single server-authored questionBatch.prompt. Do not add a second question.`
> ([realtime_provider.js:220](../worker/src/consumer/realtime_provider.js:220))

So although the signed brief *does* carry `understood` facts
([realtime_planner.js:728](../worker/src/consumer/realtime_planner.js:728)), the
model can see what the client already said and is still required to read the
robotic static string verbatim. The intelligence is present in the data and
suppressed at the point of delivery.

**Second-order problem:** a fact the client stated but which failed validation is
dropped silently, then re-asked cold. There is no register of "they mentioned
this, we could not use it" — which is exactly the case where a human would say
*"sorry, I didn't catch the figure for the house — how much roughly?"*

### R2 — why the opening is flat

[realtimeV2PhaseGuidance](../worker/src/consumer/realtime_provider.js:213):

```js
discovery: 'Begin with what brought the client here. Reflect the purpose naturally; ...'
goal_discovery: 'Begin with what brought the client here. Listen for every goal ...'
```

and the fallback prompt
([semantic_facts.js:107](../js/planning/semantic_facts.js:107)):
*"What brought you here today, and what would you most like help with?"*

Two problems, both confirmed by the research in §2:

1. **It is an open void, not a direction.** A nervous person asked an unbounded
   question gives a thin answer.
2. **It is implicitly problem-framed.** "What would you like help with?" asks the
   client to lead with a deficiency, which the research shows is the *worst*
   opening move.

There is also no framing turn — nothing that tells the client what is about to
happen, how long it takes, or why personal questions are coming. That framing is
the single most cited anxiety reducer in the practice literature.

### R3 — what is hardcoded that should be adviser-editable

| Behaviour | Currently | Should be |
|---|---|---|
| which goals a module serves | `applicableGoals` in code ([module_registry.js:303](../js/planning/module_registry.js:303)) + duplicated `ROUTES` ([goal_plan.js:34](../js/planning/goal_plan.js:34)) | adviser-editable, one source |
| "always include the balance sheet where possible" | `shouldAddBalanceSheet` + the injection at [goal_plan.js:195](../js/planning/goal_plan.js:195) | a `pinned` / `priorityBoost` setting on the module |
| module on/off for consumers | `consumerAvailable` in code + `CONSUMER_ALLOWED_MODULE_IDS` env | adviser toggle within the code-owned safety envelope |

---

## 2. Research: how the best planners open

**Lead with vision, not with current reality.** This is the substantive finding.
Intentional Change Theory distinguishes the *Negative Emotional Attractor* —
opening on problems triggers stress, defensiveness and narrowed cognition, so
clients fixate on short-term issues and resist new ideas — from the *Positive
Emotional Attractor*, where an aspirational opening activates openness,
creativity and motivation. Asked to assess their current situation first, people
focus on what is missing and what could go wrong.
([Kitces — Inspired Discovery](https://www.kitces.com/blog/financial-advisor-inspired-discovery-meeting-vision-question-intentional-positive-emotional-attractor-ideal-real-self/),
[Columbia SPS](https://sps.columbia.edu/news/discovery-meetings-asking-right-questions-uncover-client-goals))

Recommended vision-first wordings include *"If you could design your ideal
financial future, what would it look like?"* — directed and answerable, but
aspirational.

**Set the agenda before asking anything.** Stating the purpose, the topics, the
duration and why personal detail is needed *sets expectations, reduces client
anxiety and demonstrates professionalism*. Being explicit — "I'll ask some
detailed questions about your finances to understand how I can best help" —
builds trust and makes people more willing to share.
([eMoney](https://emoneyadvisor.com/blog/key-strategies-for-conducting-productive-discovery-meetings/),
[Asset-Map](https://www.asset-map.com/blog/financial-advisor-meeting-agenda))

**The 80/20 rule.** The client should talk ~80% of the time; the adviser listens
and guides. Ask about the emotions and values behind the numbers, not only the
numbers.
([Just Vanilla](https://www.justvanilla.com/blog/critical-discovery-questions-for-financial-advisors))

**Meet them at their stage.** Prospects in a discovery conversation are usually
*pre-contemplation* (unaware of the problem) or *contemplation* (aware but not
acting). Scaled questions — "on a scale of one to ten, how satisfied are you
with…" — surface dissatisfaction without confrontation and are easy to answer
under stress.
([Kitces — TTM framework](https://www.kitces.com/blog/discovery-meeting-questions-framework-transtheoretical-model-ttm/))

**Acknowledge feeling before moving on.** Empathic acknowledgement — "that
sounds stressful" — before problem-solving is repeatedly identified as what
builds the relationship, more than technical skill.

### The resulting opening sequence

Six beats, replacing the single open question. **Beats 1 and 2 are one agent
turn**; the vision question does not arrive until the client has spoken.

| Beat | Purpose | Wording |
|---|---|---|
| **1 Settle** | lower stakes, invite openness, disclose | *(Gerry's wording, final)* "Thanks for taking the time to chat to me today, Planéir's AI assistant. This is really just a conversation where I try to learn about you, so I can understand what your goals and worries are and where I can help. The more you tell me, the higher quality my analysis can be, so don't hold back." |
| **2 Frame** | agenda-setting; the anxiety reducer | "I'll ask a bit about what you'd like your money to do for you, then some specifics so I can pull up the analyses that actually fit. Takes about ten minutes, and you can skip anything you'd rather not answer." |
| **3 Warm-up** | easy, concrete, gets them talking | "To start — tell me a bit about where you're at right now. Work, home, that kind of thing." |
| **4 Vision (PEA)** | aspirational, no imposed horizon | "If things went really well with your money from here — what does that look like?" |
| **5 Ground** | vision → concrete goal | "And what would need to change to get there?" |
| **6 Direct probe** | scaled or targeted, adapted to what they said | "On a scale of one to ten, how settled do you feel about that at the moment?" |

**Why the warm-up beat exists.** Asking someone to articulate their ideal
financial future as the very first thing they say is a lot — it is abstract, and
a nervous person flounders. Beat 3 is deliberately easy and factual, so they are
already talking before the aspirational question lands.

It also does double duty: *work, home, that kind of thing* is exactly the
circumstance set the eligibility predicates need — `employment_context`,
`household_structure`, `property_status`, `life_stage` — so the beat that settles
the client is also the beat that harvests the routing facts. It is not a spent
turn.

**No horizon is named.** "Three years" is dropped: an arbitrary timeframe fits a
25-year-old and a 60-year-old differently and quietly imposes a frame. Better to
let the client set their own horizon — and whatever they volunteer ("in about
five years I'd like to…") is itself a routing signal T2 should capture.

**Disclosure is carried by beat 1** — "me today, Planéir's AI assistant" — which
satisfies the standing requirement at
[realtime_provider.js:186](../worker/src/consumer/realtime_provider.js:186) and
[:234](../worker/src/consumer/realtime_provider.js:234) (*never pretend to be a
human adviser*) without a separate compliance sentence. A fixture asserts beat 1
always contains the disclosure clause, so a later tone edit cannot silently drop
it.

**"Don't hold back" is an invitation to the client, never a licence for the
agent to probe.** The existing prohibitions on PPS numbers, account numbers,
credentials and exact addresses are unchanged.

---

## 3. Target architecture

```
┌─ VOICE (gpt-realtime) ───────────────────────────────────────────┐
│ DISCOVERY MODE                    │ INTAKE MODE                  │
│ settle → frame → vision → ground  │ reflect → back-reference →    │
│ reflections, laddering, scaled Qs  │ one precise ask              │
└──────────┬────────────────────────┴──────────┬───────────────────┘
           │ finalized turn                    │ signed brief
           ▼                                   ▲
┌─ T1 EXTRACTOR (every turn, <2s, low) ────────┤
│ facts · goals · questions · corrections      │
│ + mention register (incl. unvalidated)       │
└──────────┬───────────────────────────────────┤
           ▼                                   │
┌─ T2 DELIBERATOR (on change, 4–6s, medium) ───┤
│ reads RESOLVED MODULE CATALOGUE              │
│ proposes moduleId + evidence + confidence    │
│ tracks motivationalState                     │
└──────────┬───────────────────────────────────┤
           ▼                                   │
┌─ DETERMINISTIC RATIFIER ─────────────────────┘
│ goals ∩ eligibility ∩ allowlist ∩ readiness
│ → module plan · next question · mode
└──────────┬───────────────────────────────────
           ▼
┌─ QUESTION COMPOSER (new) ────────────────────
│ missing fact + established context + client's own words
│ → context-aware prompt with back-reference
└──────────────────────────────────────────────
           ▲
┌─ RESOLVED MODULE CATALOGUE ──────────────────
│ git manifest (docs/modules/*.md)  ⊕  D1 adviser overlay
└──────────────────────────────────────────────
```

The ratifier remains the only thing that can change the plan. The composer is
new and is what delivers R1.

---

## 4. Implementation specification

### 4.1 Module manifests — `docs/modules/*.md` → generated

**New:** `scripts/generate-module-manifest.mjs` (+ `--check`), modelled exactly on
[generate-planning-playbook-manifest.mjs](../scripts/generate-planning-playbook-manifest.mjs).
Output `js/planning/module_manifest.generated.js`. Wire `--check` into
`npm run build` and `npm run check:consumer`.

```yaml
---
moduleId: house_purchase
manifestVersion: 1.0.0
name: House purchase planner
status: beta
consumerAvailable: true

# machine-checkable — binds the ratifier, NOT adviser-editable in-app
goals: [buy_home]
eligibility:
  requireAll:
    - { fact: property_status, in: [renter, first_time_buyer, buying_soon, homeowner] }
  excludeIf:
    - { fact: life_stage, in: [retired, older_retiree] }
requiredFacts: [target_home_price, gross_household_income, cash_savings, monthly_spending, current_monthly_rent, lending_category]
factPreconditions:
  current_monthly_rent:
    skipWhen: { fact: property_status, in: [homeowner] }

# adviser-editable in-app (see §4.5)
priorityBoost: 0
pinned: never          # never | when_eligible
---

## Purpose / When to use / When not to use / Client signals
(prose — feeds the T2 supervisor, sanitized and delimited at compile time)
```

Build-time validation: fact IDs must exist in
[semantic_facts.js](../js/planning/semantic_facts.js); goals must be in
`GOAL_TYPES`; prose is length-capped and stripped of instruction-like content
before it can reach a prompt.

### 4.2 The question composer — R1

**New:** `worker/src/consumer/question_composer.js`. Replaces
`conversationalQuestion` ([realtime_planner.js:767](../worker/src/consumer/realtime_planner.js:767)).

Two new data structures:

**Mention register** — every client statement about a fact, whether or not it
validated. Persisted per session (new column on the realtime meeting row).

```js
{ factId, entityId, clientPhrase, turnIndex, status: 'captured' | 'unvalidated' | 'partial' }
```

`clientPhrase` is the client's own wording from `evidenceText` — "the house in
Cork", "my gaff" — not our label. Back-references must use their words.

**Established context** — computed per missing fact:

| Kind | Meaning | Composed question |
|---|---|---|
| `entity_known` | entity exists, attribute missing | "You mentioned the house — roughly what's it worth these days?" |
| `mention_unvalidated` | said it, we couldn't use it | "Sorry, I didn't catch the figure for the house — roughly how much?" |
| `related_mention` | adjacent context exists | "You said you're renting at the moment — what's the rent each month?" |
| `none` | genuinely new | the plain question |

```js
export function composeQuestion(missingFact, { profile, mentions, brief }) {
  // → { prompt, backReference, contextKind, evidenceTurnIndex }
}
```

The **server still owns the exact string**, so the authority boundary is
unchanged — the string is now *composed from state* instead of looked up.

**Prompt change required.** [realtime_provider.js:220](../worker/src/consumer/realtime_provider.js:220)
becomes: deliver `questionBatch.prompt` with its meaning intact; a brief
reflection may precede it; never add a second question, never alter a figure or
a named entity. Without this the composer's output is still read robotically.

**Never-re-ask invariant:** the composer throws if asked to generate a `none`-kind
question for a fact with a `captured` mention. That turns the class of bug into a
test failure rather than a live embarrassment.

### 4.3 Two conversation modes — R2

Split `buildRealtimeConversationV2Instructions`
([realtime_provider.js:229](../worker/src/consumer/realtime_provider.js:229))
into `buildDiscoveryInstructions` and `buildIntakeInstructions`, both structured
per the [realtime prompting guide](https://developers.openai.com/cookbook/examples/realtime_prompting_guide):
Role & Objective / Personality & Tone / Context / Tools / Rules / Conversation
Flow / Safety & Escalation, with sample phrases and an explicit variety rule.

New phases in `realtimeV2PhaseGuidance`: `settle_and_frame` → `warm_up` →
`vision` → `ground` → `directed_discovery` → `mode_switch` → `intake`.

`settle_and_frame` is the only agent-only phase and must emit beats 1 and 2 as a
single turn, ending on the beat 3 question. `warm_up` must not advance to
`vision` until the client has produced at least one finalized turn — the whole
point of the beat is that the aspirational question lands on someone who is
already talking.

`mode_switch` is a spoken summary-and-check — the S of OARS — and doubles as a
natural confirmation gate:

> "So: out of renting within about three years, without draining the savings
> you've built. Have I got that right? Let me pull up what's most useful for
> that — I'll need a few specifics."

Split the prompt into a cacheable stable prefix and a volatile suffix, and
replace the 12KB brief injection
([realtime_provider.js:230](../worker/src/consumer/realtime_provider.js:230))
with the `toConversationGuide` projection. Cached input is roughly 80× cheaper,
so this is both a latency and a cost win.

### 4.4 T1 / T2 supervisor split

| | T1 extractor | T2 deliberator |
|---|---|---|
| trigger | every finalized turn | goal set changes, every 3 turns, or mode-switch check |
| budget | <2s | 4–6s (runs while the agent is speaking) |
| model | `defaultModel`, `low` | `complexModel`, `medium` |
| output | facts, goals, questions, corrections, **mentions** | module proposals + evidence + confidence, `motivationalState` |

T2 failure (timeout, low confidence, malformed) degrades to deterministic
routing, so the worst case equals the pre-supervisor behaviour. Flag:
`CONSUMER_REALTIME_SUPERVISOR_ENABLED`, false in `wrangler.toml` like every other
consumer switch.

**Mode switch — agent-driven, with a floor and a ceiling.** The agent decides
when discovery is done and may finish early when it is confident; deterministic
code only enforces the boundaries.

```
AGENT MAY REQUEST INTAKE at any time via the ready_for_intake tool.
THE RATIFIER GRANTS IT ONLY IF   (the floor)
    at least one module is ratified
    AND circumstance coverage >= 3 facts
    AND goalConfidence >= 0.7
FORCE SWITCH AT discoveryTurns >= 10   (the ceiling)
```

New tool `ready_for_intake` in `REALTIME_V2_TOOL_DEFINITIONS`
([realtime_provider.js:119](../worker/src/consumer/realtime_provider.js:119)),
carrying the agent's stated reason and confidence. A refused request returns the
floor's unmet condition as guidance, so the agent knows what is still missing
rather than simply being blocked — the same shape as the existing rejection
guidance contract.

This keeps the agent in charge of pacing without letting it end discovery before
the system can actually route. The floor is deliberately lower than the old
automatic rule (3 circumstance facts, not 4) because the agent asking to move on
is itself evidence.

Hysteresis: a ratified module needs materially stronger contrary evidence to be
dropped, or the plan thrashes audibly mid-call.

### 4.5 Adviser module administration — R3

**Migration** `worker/consumer-migrations/0014_create_module_overrides.sql`:

```sql
CREATE TABLE module_overrides (
  module_id TEXT PRIMARY KEY,
  added_goals TEXT NOT NULL DEFAULT '[]',
  removed_goals TEXT NOT NULL DEFAULT '[]',
  priority_boost INTEGER NOT NULL DEFAULT 0,
  pinned TEXT NOT NULL DEFAULT 'never',      -- never | when_eligible
  consumer_enabled INTEGER,                  -- NULL = inherit manifest
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE module_override_audit (...);    -- every change, who and when
```

**Resolution:** `resolveModuleCatalogue(env)` = generated manifest ⊕ overlay,
cached per revision.

**The safety envelope is asymmetric — turning a module OFF is always allowed,
turning one ON is constrained.** Disabling can only ever narrow what a consumer
sees, so it needs no gate; enabling can expose an unready analysis, so it stays
inside the code-owned envelope. Concretely, the overlay may never:

- enable a module whose manifest has `consumerAvailable: false` or an incomplete
  intake contract;
- add a goal outside `GOAL_TYPES`;
- modify `eligibility`, `requiredFacts` or `factPreconditions` (code-owned);
- bypass `CONSUMER_ALLOWED_MODULE_IDS`.

Editable: goals, priority, pinning, and the consumer on/off toggle. Every change
is audited.

**Multi-adviser is deferred, not designed out.** No role gates are built now —
the surface is single-adviser behind the existing `requireAdvisorSession`. But
`updated_by` and the audit table are populated from day one, so adding per-adviser
permissions later is a gate in front of an existing route rather than a schema
migration.

**`pinned: when_eligible` replaces the hardcoded balance-sheet injection** at
[goal_plan.js:195](../js/planning/goal_plan.js:195) — the behaviour Gerry
described wanting to control becomes a setting instead of a branch.

**Worker routes** (register in the methods table near
[index.js:276](../worker/src/index.js:276), auth via `requireAdvisorSession`
[index.js:4973](../worker/src/index.js:4973), matching the analytics routes):

| Route | Method | Purpose |
|---|---|---|
| `/api/advisor/modules` | GET | list resolved modules with base vs override shown |
| `/api/advisor/modules/:id` | GET, PATCH | read / edit goals, priority, pinning, toggle |
| `/api/advisor/modules/:id/preview` | POST | dry-run against saved transcripts: which past calls would now select it |

**UI:** `app/modules.html` + `js/module_manager.js`, following
[access.html](../app/access.html) / `js/access_manager.js` structure and the
existing CSP and `call-canvas-worker-base-url` meta pattern. Link from the
`app/index.html` topbar beside Client Pipeline and Call Analytics.

Per module the page shows — **read-only view is as important as the editing**:

| Panel | Content | Editable |
|---|---|---|
| Identity | name, id, status, manifest version | no |
| **Goals** | which goals surface this module in a call | **yes** |
| **Inputs** | every fact the module needs, its question, whether it is required or preconditioned away | no (view) |
| **When used** | plain-English trigger summary + eligibility predicates | no (view) |
| **Priority** | boost, and `pinned: when_eligible` | **yes** |
| **Consumer visibility** | on/off | **yes** |
| History | audit trail of overrides | no |

The Inputs and When-used panels answer the question Gerry actually asked —
*what does this module ask people, and when does it fire* — which today is only
answerable by reading `INTAKE_FACTS` and the `ROUTES` table in source.

The preview endpoint matters: it is what stops a well-meant goal edit from
quietly wrecking routing for everyone.

### 4.6 Ratifier reads manifests

`buildGoalModulePlan` ([goal_plan.js:177](../js/planning/goal_plan.js:177))
computes from the resolved catalogue. Delete `ROUTES`
([goal_plan.js:34](../js/planning/goal_plan.js:34)) and the `route(...)` block
([routing_rules.js:87](../js/planning/routing_rules.js:87)). Add `eligibility`
and `factPreconditions` evaluation. Delete `buildPersonaModulePlan` /
`classifyPlanningPersona` and the `goalRoutingEnabled === false` branch
([realtime_fact_mapper.js:524](../worker/src/consumer/realtime_fact_mapper.js:524),
[conversation.js:749](../worker/src/consumer/conversation.js:749)). Rename
`assumptions.values.persona` → `assumptions.values.circumstances` — those facts
become first-class routing inputs, not persona colouring.

**Correction (P0, verified 2026-07-25): the circular fact gate is a v1-only
defect and does not affect the shipped v2 path.** The earlier diagnosis was
wrong. The gate at
[realtime_session.js:2955](../worker/src/consumer/realtime_session.js:2955) is
guarded by `&& !context.config.realtimeConversationV2Enabled`, so in the
conversational v2 meeting `realtimeFactAllowed` never rejects anything —
`person_current_age` and every other volunteered fact is written. The offline
simulator initially applied the gate unconditionally and reported drops that
production does not perform; it now mirrors the production condition exactly.

No change is made to `realtimeFactAllowed` in P0. The v1 path keeps its gate
because v1 is the rollback target and loosening it adds risk without touching the
live defect. When v1 is retired in P2 the function and its callers go with it.

### 4.7 Information-gain question ordering

Replace the hardcoded array at
[realtime_planner.js:738](../worker/src/consumer/realtime_planner.js:738):

```
score = moduleBlocking × applicability × unlockCount × topicAdjacency ÷ userEffort
```

`applicability = 0` short-circuits, so §4.6 preconditions are enforced
structurally. `topicAdjacency` stops the cash → pension → cash jumping. Keep the
existing array as tie-break so current fixtures stay green. Deterministic and
pure, exactly like `buildQuestionPlan`
([question_plan.js:190](../js/planning/question_plan.js:190)).

### 4.8 Offline conversation simulator

**New:** `scripts/check-consumer-realtime-conversation-sim.mjs`. Drives the real
`composeMeetingBrief` → ordering → composer pipeline with recorded planner
extractions. No network. Runs in `npm run check:consumer`.

Per-fixture assertions:

- `mustNeverAsk` — fact IDs and regexes that must never be generated
- `mustBackReference` — after stating "I own a house", the value question must
  contain a back-reference (`contextKind !== 'none'`)
- `mustNotRepeat` — no fact with a `captured` mention is ever asked cold
- `maxQuestionsToReady`, `modeSwitchTurnIndex`

#### Test scenarios

> **Naming.** These are **test scenarios** — scripted fake clients the harness
> replays. They are not personas and have no runtime existence. The runtime
> `classifyPlanningPersona` / `buildPersonaModulePlan` router is deleted in P2
> (§4.6); routing is goals × circumstances. The only reason the test suite needs
> a spread of client types is that a routing bug is invisible until you replay a
> client the current fixtures do not contain — which is exactly how the
> 25-year-old case shipped.

Expand from 5 to 14. The value of each scenario is its `mustNeverAsk` list: that
is where "intelligent" is encoded as an assertion.

| # | Scenario | Goal(s) | Must never be asked |
|---|---|---|---|
| 1 | `new_parent_full_regression` *(exists)* | understand_position, fund_education | — |
| 2 | `correction_and_multi_fact` *(exists)* | — | — |
| 3 | `short_answers_and_fragments_do_not_loop` *(exists)* | — | — |
| 4 | `detour_and_safety` *(exists)* | — | — |
| 5 | `spoken_retirement_completion` *(exists)* | retire | — |
| 6 | **`young_renter_first_home`** — 25, renting, saving a deposit, few assets | buy_home | property value · mortgage balance · retirement income · pension value |
| 7 | `student_no_assets` — 21, part-time work, wants to start | understand_position | property · pension · retirement age · dependants |
| 8 | `self_employed_no_pension` — 38, sole trader, irregular income | improve_pension | **employer contribution rate** · property value |
| 9 | `mid_career_mortgage_switcher` — 42, owns home, reviewing rate | optimise_mortgage | **current monthly rent** · target home price · lending category |
| 10 | `pre_retiree_pension_check` — 58, DB + DC pensions | retire | target home price · college costs |
| 11 | `retiree_drawdown` — 68, ARF + State Pension | understand_position | **intended retirement age** · employer contribution rate · target home price |
| 12 | `education_funder` — 44, children aged 8 and 11 | fund_education | retirement income before dependant ages |
| 13 | `ambiguous_checkup` — "I just want to know if I'm doing okay" | understand_position (low confidence) | any intake question before discovery has explored |
| 14 | `goal_conflict_priority` — states four goals at once | overloaded | any module-specific fact before the priority question |

Scenarios 8, 9 and 11 are the sharpest tests. Asking a sole trader what their
*employer* contributes, asking a homeowner their *rent*, or asking a 68-year-old
when they *intend to retire* are all questions the current pipeline will happily
generate, and each is the same class of failure as the reported bug.

Deferred to a second wave: company director · farmer · lump-sum recipient ·
couple with childcare. Business and agricultural modules are `consumerAvailable:
false`, so they exercise the adviser-handoff path rather than intake
intelligence, and are better added once the handoff path is itself under test.

---

## 4a. P0 as delivered — 2026-07-25

| Change | File | Effect |
|---|---|---|
| Offline conversation simulator + 4 scenarios | [check-consumer-realtime-conversation-sim.mjs](../scripts/check-consumer-realtime-conversation-sim.mjs), [consumer-realtime-scenarios.json](../scripts/fixtures/consumer-realtime-scenarios.json) | conversational behaviour testable with no network; wired into `check:consumer` |
| **Slot-ordered question queue** | [realtime_planner.js](../worker/src/consumer/realtime_planner.js) `orderedMissingFacts` | the meeting opens on the analysis the client's stated goal selected, not on whatever ranks highest in a flat global list |
| `property_status` in the balance-sheet decision | [goal_plan.js](../js/planning/goal_plan.js) `shouldAddBalanceSheet` / `declaredNoProperty` | a declared renter or first-time buyer with no meaningful position no longer gets the balance sheet forced in |
| Planner extracts orientation context | [realtime_planner.js](../worker/src/consumer/realtime_planner.js) `PLANNER_SYSTEM_PROMPT` | ownership *status*, age and life stage may be inferred from clear context, with worked examples; monetary and position *values* stay explicit-only |

The slot-ordering change was pulled forward from P7. It is the smallest change
that fixes the largest share of the observed nonsense, and it is a strict
refinement — the previous flat list survives as the tie-break within a slot, so
existing fixtures were unaffected.

Measured effect:

| Scenario | Opening question before | After |
|---|---|---|
| `self_employed_no_pension` | "Do you own your home, and if so, roughly what is it worth?" | "Do you have an occupational pension, PRSA, personal pension, AVC or defined-benefit pension…?" |
| `mid_career_mortgage_switcher` | "Do you own your home, and if so, roughly what is it worth?" | "Is there a mortgage on the home, and roughly what is still outstanding?" |
| `young_renter_first_home` | property value queued via a forced balance sheet | "Roughly how much do you currently hold in cash or savings?" — no balance sheet, no property question |

**Still open after P0**, each with a named later phase:

- A self-employed client can still be asked for an *employer* contribution rate
  once a pension exists — needs the P2 `factPreconditions`.
- Stated context is still not referenced back ("you said you own a house…") —
  that is R1 / P3, the question composer.
- Whether the planner actually *emits* orientation facts is prompt behaviour the
  offline harness cannot prove. It needs one live probe run, and that is the
  first thing to check when the canary is next activated.

## 4b. P1 as delivered — 2026-07-25

> **Corrected the same day.** P1 originally authored **nine** manifests, selected
> by `intakeContract.status === 'approved'` — a measure of consumer intake
> readiness mistaken for the catalogue. That silently dropped six
> adviser-available modules, including `protection_analysis`, which has a live
> adviser playbook. The manifest set is now the **complete 16-module registry**,
> with availability, routing eligibility and implementation status recorded as
> independent axes, and an anti-narrowing assertion that fails the build if any
> registered module lacks a manifest. Full inventory and reasoning:
> [module-catalogue-reconciliation.md](module-catalogue-reconciliation.md).

Sixteen manifests authored in [docs/modules/](modules/), compiled by
[generate-module-manifest.mjs](../scripts/generate-module-manifest.mjs) into
`js/planning/module_manifest.generated.js`. **Nothing reads the generated file** —
verified by grep. `--check` is wired into `check:consumer`, generation into
`npm run build`.

Authoring format follows the prompt-pack precedent rather than the YAML
frontmatter sketched in §4.1: an HTML comment marker locates a fenced JSON
block, prose follows as markdown headings. Zero dependencies, same shape as
[generate-planning-playbook-manifest.mjs](../scripts/generate-planning-playbook-manifest.mjs).

**The parity assertion is behavioural, not structural.** Rather than importing
the `ROUTES` table, the generator runs `buildGoalModulePlan` once per goal type
and compares the resulting slots to the manifests. That matters because P2
deletes `ROUTES`; a structural check would have to be rewritten at exactly the
moment it is most needed. Each manifest must reproduce live routing goal-for-goal
and role-for-role, the registry's intake facts exactly, and its name, status and
`consumerAvailable`. Both assertions were negative-tested: mutating a goal or
adding a fact fails `--check` with a diff.

`balance_sheet_default` is compiled to `pinned: "when_eligible"` rather than to a
goal, which is what lets P2 replace `shouldAddBalanceSheet` with manifest data.

Adviser prose is treated as semi-trusted: length-capped, whitespace-normalised,
and rejected at build time if it contains instruction-like text, because it is
destined for a model prompt.

### Three divergent representations, now visible

The generator reports — without failing — where the registry's `applicableGoals`
disagrees with what actually routes. This is the field P2 must resolve, and it is
worse than it looked:

| Module | `applicableGoals` | Actually routed |
|---|---|---|
| `liquidity_analysis` | + `understand_position` | `buy_home`, `maintain_liquidity` |
| `personal_balance_sheet` | **all 14 goals** | `understand_position`, `build_wealth` |
| `retirement_goal_analysis` | `improve_pension`, `retire`, `retire_early` | **nothing — orphaned** |

`applicableGoals` is read by no routing code at all. `routing_rules.js`
`recommendModules` is a *second* live table, used by `runConsumerAnalysis` to
default module ids when none are passed explicitly. `goal_plan.js` `ROUTES` is
the third and is the one the conversation uses. P2 collapses all three onto the
manifest; `retirement_goal_analysis` needs a deliberate decision (give it routes,
or mark it adviser-selection-only) rather than silent inheritance.

## 5. Phasing

| Phase | Scope | Ships |
|---|---|---|
| **P0** ✅ **done 2026-07-25** | §4.8 simulator + 4 scenarios; slot-ordered question queue; `property_status` in the balance-sheet decision; planner orientation-extraction prompt | live bug fixed, safety net in place, `check:consumer` green |
| **P1** ✅ **done 2026-07-25** | §4.1 nine manifests + generator + `--check`; behavioural parity assertion; nothing reads them yet | zero behaviour change, fully reversible |
| **P2a** ✅ **done 2026-07-25** | Both routers read the manifest; `ROUTES` and the hand-written `route()` block deleted; alias + capability rules; convergence tests | one routing source; divergence impossible |
| **P2b** (~1 wk) | Delete the persona router (`classifyPlanningPersona` / `buildPersonaModulePlan`), retire the `goalRoutingEnabled === false` branch, rename `assumptions.values.persona` → `circumstances`; add `eligibility` / `factPreconditions` | employer-contribution class of question closed |
| **P3** (~1 wk) | §4.2 composer + mention register + prompt rule change | **R1 done** |
| **P4** (~2 wk) | §4.3 two modes, five-beat opening, OARS, cache split | **R2 done** |
| **P5** (~2 wk) | §4.4 T1/T2 supervisor behind flag | background orchestration |
| **P6** (~1–2 wk) | §4.5 overlay table, routes, `app/modules.html`, preview | **R3 done** |
| **P7** (~1 wk) | §4.7 scorer; learning-signals events | measurement loop |

P0 first regardless — the redesign touches the component that decides what a
client gets asked, and without the offline harness every iteration costs a paid
live probe.

R1 (P3) lands before R2 (P4) deliberately: back-referencing is what makes the
intake half feel human, and it is a smaller change than the opening rebuild.

---

### P2 entry conditions

The catalogue reconciliation is complete (items 1–5 of
[module-catalogue-reconciliation.md](module-catalogue-reconciliation.md) §7 are
implemented and negative-tested). P2 may proceed, but must additionally resolve
these before deleting anything:

1. **`retirement_goal_analysis`** — approved intake contract, no engine, routed
   by nothing. Give it routes or mark it adviser-selection-only. A deliberate
   decision, not silent inheritance.
2. **`business_owner_relief` vs `business_relief_analysis`** — duplicate
   adviser-only identities with overlapping goals. Merge, or record why both stay.
3. **`applicableGoals`** — the third representation, read by no routing code.
   Deleting it is safe; making it authoritative is not, since
   `personal_balance_sheet` declares all fourteen goals.
4. **`recommendModules`** — still live inside `runConsumerAnalysis` as the
   execution-time default when no explicit module ids are passed. It must be
   migrated or explicitly kept; deleting `ROUTES` alone does not cover it.
5. **`adviserAvailable` is enforced by nothing today.** If P6's admin UI is to
   resolve adviser modules from the manifest, P2 should make the registry field
   authoritative rather than decorative.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Composer produces a wrong back-reference ("you said you own a house" when they did not) | back-reference only from `captured`/`partial` mentions with a stored evidence turn; simulator asserts every back-reference against the transcript |
| Relaxing the verbatim rule lets the model drift | meaning-preserving delivery only; figures and named entities immutable; regression fixtures assert no figure is ever altered |
| Vision-first opening feels vague to practical clients | beat 4 grounds within one turn; force-switch at 8 turns; A/B against the plain opening on the probe |
| Adviser goal edit wrecks routing | preview endpoint dry-runs against saved transcripts before publish; overlay cannot touch eligibility; full audit |
| T2 latency leaks into replies | T2 never gates a reply; T1 stays <2s; degrade to deterministic routing |
| Module set thrashes mid-call | hysteresis + confidence floor; changes explained aloud |
| Catalogue outgrows the T2 prompt | accessor indirection now; retrieval at ~25 modules |

---

## 7. Decisions — all settled 2026-07-25

1. **Opening tone.** Beat 1 is Gerry's wording including the disclosure clause,
   final. Beat 2 approved as drafted. Warm-up beat added before the vision
   question; imposed horizon removed. Beats 4–6 may get tone edits once heard
   aloud — not blocking.
2. **Discovery length.** Agent-driven via `ready_for_intake`, deterministic floor,
   hard ceiling at **10 turns**.
3. **Who may author.** Single-adviser for now, no role gates built. `updated_by`
   and audit populated from day one so multi-adviser is a later gate, not a
   migration.
4. **Consumer on/off.** Yes — the overlay can hide a module from consumers.
   Asymmetric envelope: disabling is unconstrained, enabling stays inside the
   code-owned limits.

**Open, non-blocking:** the ~14 eval personas (§4.8). I will draft these as part
of P0 and put them up for review rather than hold the build — they define what
the regression suite treats as "intelligent", so they are worth a read, but a
draft is a better starting point than a blank question.

---

## 4c. P3 as delivered — 2026-07-26

The offer-then-collect flow. A relevant module is never added silently and never
starts its own fact-find before the client agrees to it.

### The spoken flow

**1 — Offer.** One turn, one module, three parts:

> "You mentioned **you own your home**. I can **show your current mortgage
> repayment path and compare the alternatives — changing the term, switching, or
> making extra repayments**. Would that be useful?"

The anchor is a circumstance the client actually supplied, resolved from
accumulated profile state. The benefit is owned by the module manifest
(`clientBenefit`), so adding a module never means editing a conversation branch.
**If no anchor can be found, no offer is made** — silence beats generic
promotional copy.

**2 — Record.** Accept, decline or leave uncertain, into
`planning.acceptedModuleIds` / `planning.declinedModuleIds`. A decline is
durable: the module is never offered again and its questions never open.

**3 — Collect.** Only after acceptance. Module-specific questions come from
selected modules alone, so an unaccepted module contributes nothing to the
queue — the guarantee is structural, not a filter applied at the point of
speech.

**4 — Confirm.** The whole set, in plain language, never internal ids:

> "So I will put together **Personal balance sheet and Mortgage analysis**. Have
> I got that right?"

**5 — Execute exactly that set.** `executionModuleIds` derives from confirmed
selections only. Acceptance alone does not execute.

### Why the voice can still answer instantly

`composeModuleOffer(opportunity, { profile })` takes no transcript. There is no
turn parameter to pass, so however quickly the voice replies, it cannot change
which module is offered — only accumulated structured state can. That is
asserted directly.

### Delivered

| Piece | Where |
|---|---|
| Offer composition, anchors, confirmation summary | [module_offers.js](../js/planning/module_offers.js) |
| Three-state opportunities behind the hard visibility filter | [goal_plan.js](../js/planning/goal_plan.js) |
| 16 assertions across offer, accept, decline, collect, confirm, execute | [check-consumer-module-offers.mjs](../scripts/check-consumer-module-offers.mjs) |

### Remaining

The deterministic layer produces the offer text, the decision fields and the
confirmation summary. **The realtime session does not yet expose a tool for the
voice agent to record accept/decline**, so today the decision has to be written
through the planning profile rather than spoken. That tool plus its handler is
the next step, and it is small compared with the flow it completes.

### P3 completion — spoken decisions, 2026-07-26

`record_module_decision` closes the loop. The design constraint is that a bare
"yes" must be safe, so **the model cannot name a module**: the tool takes only a
decision, and the server resolves it against the single offer carried in the
signed brief (`meetingBrief.moduleOffer`). An unoffered analysis therefore
cannot be added, and nothing can be executed from the tool.

| Decision | Effect |
|---|---|
| `accepted` | persisted, module joins the intended set, its question queue opens, **nothing runs** |
| `declined` | persisted durably, questions never open, not offered again unless the client reverses it |
| `uncertain` | recorded as an event and **changes nothing** — "maybe" and "tell me more" are not acceptance |

The tool is only present in the toolset while an offer is active
(`realtimeToolsForState`), so it cannot be called against nothing, and calling it
with no active offer fails with `realtime_no_active_module_offer`.

A decision replaces any earlier one for that module, so a reversal is a clean
state change rather than two contradictory records. Persistence goes through
`recordRealtimeModuleDecision`, a revisioned profile write — a decision is not a
financial fact, so it does not use the fact-proposal machinery, but it is still
durable and conflict-checked.

Offers may now be anchored to **an explicit client request** as well as a
circumstance: a client who stated the goal is already anchored by their own
words ("You asked about your mortgage, so I can…"), while a circumstance-driven
offer still has to quote a fact back. Ungrounded offers remain suppressed.
