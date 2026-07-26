# Goal-Driven Module Orchestration — Evaluation and Migration Plan

Proposal under evaluation (Gerry, 2026-07-25):

1. Modules become **adviser-authored artifacts** carrying enough detail about the
   goal they serve and when they should be used.
2. A **background AI orchestrator** runs alongside the Realtime voice agent,
   continuously working out which modules apply.
3. The voice agent's first job is **goal discovery** through genuinely skilled
   conversation, using proper elicitation technique.
4. Once the orchestrator settles the module set, the conversation **switches
   mode** from asking about the person to gathering the specific inputs those
   modules need.
5. The persona layer may not be needed — move to goals-based module choice.

**Verdict: yes, this is the right architecture, and it is a convergence of three
things you have already built rather than a rewrite.** Five corrections are
needed before it is safe to ship. Details below.

---

## 1. Why this works — you are further along than it looks

### It is OpenAI's own documented pattern

The proposal is precisely the **chat-supervisor** pattern: a realtime model owns
the live conversation while a more capable text model reasons in the background
and hands back decisions. Stated benefits are lower cost, higher intelligence on
the hard decisions, and better *perceived* latency because the user is
acknowledged immediately. Measured supervisor turnaround is ~2 seconds.
([openai/openai-realtime-agents](https://github.com/openai/openai-realtime-agents))

**You already run half of it.** `realtime_planner.js` is a background supervisor
today — a silent Responses-API call after every finalized client turn
([realtime_planner.js:461](../worker/src/consumer/realtime_planner.js:461)),
with its own timeout, budget and prompt version. It is just scoped to *fact
extraction* instead of *judgment*. The proposal expands its remit; it does not
introduce a new component.

### Your modules already declare what they are for — and routing ignores it

Every module definition carries `applicableGoals`:

```js
applicableGoals: ['understand_position', 'maintain_liquidity', 'buy_home'],  // liquidity
applicableGoals: ['buy_home'],                                              // house purchase
applicableGoals: ['improve_pension', 'retire', 'retire_early'],             // pension
```
([module_registry.js:303](../js/planning/module_registry.js:303),
[:324](../js/planning/module_registry.js:324),
[:358](../js/planning/module_registry.js:358))

That field is **never read by any routing code**. It is frozen into the public
definition ([module_registry.js:288](../js/planning/module_registry.js:288)) and
that is the end of it. Routing instead runs off a hand-maintained duplicate —
the `ROUTES` table at [goal_plan.js:34](../js/planning/goal_plan.js:34) and the
`route(...)` calls at [routing_rules.js:87](../js/planning/routing_rules.js:87).

So "modules declare which goals they serve" is already the data model. It is
simply not the source of truth. Making it the source of truth is a deletion, not
an addition.

### Adviser-authored, natural-language module specs already ship

`docs/prompt-pack/` is exactly the authoring pattern you are describing,
in production for the adviser workflow:

```markdown
<!-- planeir-planning-module {"moduleId":"liquidity_analysis","outputKey":"generated.liquidityPlan","role":"analysis"} -->

Use this playbook when Gerry says `use the liquidity playbook`, `cash buffer`,
`emergency fund`, `too much cash`, or asks for a cash-only liquidity module.

## Job
Create a focused cash module that shows whether the client has too little,
enough, or too much cash relative to their spending buffer target.

This is not the PBS playbook. Do not show net worth, lifestyle assets, ...
```
([16_liquidity_playbook.md](prompt-pack/16_liquidity_playbook.md))

Natural-language *when to use*, natural-language *when not to use*, plus
machine-readable metadata in an HTML comment — compiled by
[generate-planning-playbook-manifest.mjs](../scripts/generate-planning-playbook-manifest.mjs)
into a generated module, with a `--check` mode wired into `npm run build` and
`npm run check:consumer` so drift fails CI.

**That is the module-authoring workflow, already proven.** It was built for
picking playbooks from Gerry's dictation. The proposal is to point the same
mechanism at consumer goal discovery.

### The persona layer is already legacy

`buildPersonaModulePlan` runs only on the `goalRoutingEnabled === false` branch
([realtime_fact_mapper.js:524](../worker/src/consumer/realtime_fact_mapper.js:524),
[conversation.js:749](../worker/src/consumer/conversation.js:749)). With
`CONSUMER_GOAL_ROUTING_ENABLED` on, goal routing is already primary and the
26KB persona catalogue is a fallback path. Your instinct to drop it is correct —
with one important caveat in §2.3.

---

## 2. Five corrections before this is safe

### 2.1 Free text alone cannot select a module — use two keys

If an adviser writes prose and an LLM matches on it, module selection becomes
non-deterministic and unauditable. That breaks the authority boundary the whole
release process is built on
([consumer-realtime-voice-operations.md](consumer-realtime-voice-operations.md))
and makes the canary gates meaningless.

**Every manifest carries both:**

| Key | Consumer | Purpose |
|---|---|---|
| `whenToUse` / `whenNotToUse` / `clientSignals` — prose | the supervisor LLM | judgment, nuance, matching messy human speech |
| `goals` + `eligibility` predicates — machine-checkable | the deterministic ratifier | audit, safety, reproducibility |

The supervisor **proposes with evidence and confidence**; deterministic code
**ratifies**. A module whose `eligibility` fails can never be selected no matter
what the model says. A module whose eligibility is mandatory cannot be dropped
by the model. You keep the flexibility and keep the audit trail.

### 2.2 Selection is goal × circumstance, not goal alone

"Understand my position" means different modules for a 25-year-old renter, a
farmer, and a company director. Goals drive *candidacy*; circumstances drive
*eligibility filtering*. Without this you rebuild the current bug — the balance
sheet force-added to a 25-year-old with nothing on it
([see the prior diagnosis](realtime-conversation-intelligence-plan.md)).

### 2.3 Kill the persona *router*, keep the circumstance *facts*, rename them

This distinction matters and the current naming hides it. Under
`assumptions.values.persona` sit facts like `property_status`, `has_pension`,
`dependant_count`, `employment_context`, `household_structure`
([realtime_fact_mapper.js:13](../worker/src/consumer/realtime_fact_mapper.js:13)).

**Those are not personas.** They are circumstance signals, and under the new
architecture they become *more* important, not less — they are exactly what
`eligibility` predicates evaluate. What should die is `classifyPlanningPersona` /
`buildPersonaModulePlan` — the idea of bucketing someone into a labelled type
and routing off the label.

So: delete the catalogue and the label, rename `assumptions.values.persona` →
`assumptions.values.circumstances`, and promote those facts to first-class
routing inputs.

### 2.4 Two supervisor tiers — never put judgment on the reply path

The chat-supervisor pattern costs ~2s. You cannot pay that before every reply.

| Tier | Trigger | Budget | Effort | Job |
|---|---|---|---|---|
| **T1 extractor** | every finalized turn | <2s | `low` | facts, goals, questions, corrections — must never block the next question |
| **T2 deliberator** | goal set changes, every N turns, or mode-switch check | 4–6s | `medium` | module fit against the catalogue, confidence, mode-switch recommendation |

T2 runs *while the voice agent is already speaking*, so its latency is hidden.
Current config has the timeouts (`CONSUMER_REALTIME_PLANNER_TIMEOUT_MS=8000`,
catchup `12000`) but not the tiering.

**T2 failure must degrade to deterministic routing**, so the worst case is
exactly today's behaviour rather than a broken call.

### 2.5 Discovery needs a termination criterion

An agent told to "converse until it understands the goals" will ramble. Define
the mode switch explicitly:

```
SWITCH TO INTAKE WHEN
  goalConfidence >= 0.7
  AND at least one module is ratified
  AND (circumstance coverage >= 4 facts OR discoveryTurns >= 6)
FORCE SWITCH AT discoveryTurns >= 8
```

Confidence thresholds around 0.6–0.7 are the common act-vs-ask boundary in voice
agents ([Amazon Science](https://www.amazon.science/blog/reducing-unnecessary-clarification-questions-from-voice-agents)).

Add **hysteresis**: once ratified, a module needs materially stronger contrary
evidence to be dropped, or the plan will thrash mid-call and the client will hear
it.

---

## 3. Target architecture

```
┌─ VOICE (gpt-realtime) ──────────────────────────────────────┐
│  DISCOVERY MODE          │  INTAKE MODE                     │
│  open questions,         │  one precise input at a time,    │
│  reflections, laddering  │  acknowledge → confirm → prompt   │
└───────────┬──────────────┴──────────────┬───────────────────┘
            │ finalized turn              │ signed brief
            ▼                             ▲
┌─ T1 EXTRACTOR (every turn, <2s) ────────┤
│  facts · goals · questions · corrections│
└───────────┬─────────────────────────────┤
            ▼                             │
┌─ T2 DELIBERATOR (on change, 4–6s) ──────┤
│  reads MODULE MANIFEST CATALOGUE        │
│  proposes: moduleId + evidence + conf.  │
└───────────┬─────────────────────────────┤
            ▼                             │
┌─ DETERMINISTIC RATIFIER ────────────────┘
│  goals ∩ eligibility ∩ allowlist ∩ readiness
│  → the 1–3 module plan · the next question · the mode
└─────────────────────────────────────────────────────────────┘
```

The ratifier is the only thing that can change the plan. The supervisor only
ever *proposes*.

---

## 4. The module manifest

Authored as markdown with frontmatter in `docs/modules/<module_id>.md`, compiled
to `js/planning/module_manifest.generated.js` by a new
`scripts/generate-module-manifest.mjs` with a `--check` CI gate — mirroring the
prompt-pack generator exactly.

```yaml
---
moduleId: house_purchase
manifestVersion: 1.0.0
name: House purchase planner
status: beta                 # active | beta | adviser_only | unsupported
consumerAvailable: true
reviewedBy: gerry
reviewedOn: 2026-07-25

# ── Machine-checkable: binds the deterministic ratifier ──
goals: [buy_home]
eligibility:
  requireAll:
    - fact: property_status
      in: [renter, first_time_buyer, buying_soon, homeowner]
  excludeIf:
    - fact: life_stage
      in: [retired, older_retiree]
companionModules: [liquidity_analysis]
requiredFacts:
  - target_home_price
  - gross_household_income
  - cash_savings
  - monthly_spending
  - current_monthly_rent
  - lending_category
factPreconditions:
  current_monthly_rent:
    skipWhen: { fact: property_status, in: [homeowner] }
---

## Purpose
Shows whether and when someone can afford to buy, the deposit they need, and
what the repayments would look like.

## When to use
The person talks about buying a home, getting on the property ladder, saving a
deposit, mortgage approval, or moving house. Also use when someone says they
are "throwing money away on rent".

## When not to use
Do not use when the person already owns and is only asking about their existing
mortgage rate or term — that is `mortgage_analysis`.

## Client signals
- "I want to buy my first place"
- "trying to save a deposit"
- "we're renting and want to get out of it"

## What this needs from the conversation
Target price, household income, savings, monthly spending, current rent, and
whether this is a first-time-buyer application.
```

Three properties that matter:

- **Prose feeds the supervisor; frontmatter binds the ratifier.** Both authored
  by the adviser, in one file, reviewed together.
- **The compiler sanitizes.** Adviser prose is semi-trusted: length-capped,
  delimited, stripped of instruction-like content before it reaches a prompt.
  Frontmatter is schema-validated and fact IDs are checked against
  `semantic_facts.js` at build time — an unknown fact ID fails the build.
- **Adding a module is writing a markdown file**, and CI catches drift the same
  way it does for playbooks today.

**Scaling note:** with ~9 modules the whole catalogue fits comfortably in the T2
prompt and caches well (stable prefix, ~80× cheaper cached input). Past roughly
25 modules, switch to retrieval over manifests. Worth designing the catalogue
accessor behind a function now so that swap is local later.

---

## 5. The conversational craft layer

This is what makes it feel like a trusted human rather than a form. Ground it in
**motivational interviewing**, which is the established evidence base for
eliciting goals and concerns, and which is being actively adapted to LLM agents
([JMIR scoping review](https://www.jmir.org/2025/1/e78417),
[MINT](https://motivationalinterviewing.org/understanding-motivational-interviewing),
[CHI 2026](https://dl.acm.org/doi/full/10.1145/3772318.3791123)).

The technical repertoire is **OARS**:

| Move | In discovery mode | Status today |
|---|---|---|
| **Open questions** | "What's been on your mind about money lately?" | partly — opening question exists |
| **Affirmations** | specific and earned: "You've already worked out the hard part — that you want to stop renting." | absent |
| **Reflections** | restate with slight amplification: "So it's less about the house itself, more about not feeling stuck." | **absent — highest-value gap** |
| **Summaries** | at the mode switch: "So: get out of renting, do it in about three years, without wiping out your savings. Have I got that right?" | absent |

Reflective listening is the single biggest missing move. It is what makes a
person feel heard, it reliably elicits more information than another question,
and it costs one sentence.

Two additions beyond OARS:

- **Laddering** — one "why does that matter to you?" step from stated goal to
  underlying concern. "I want to buy a house" → "so I'm not moving every two
  years" → the real goal is stability, which changes which analyses land.
- **Motivational-state tracking.** The research caveat is direct: LLMs work well
  when the person already has clear goals but **often fail to detect motivational
  states when someone is still forming their view**
  ([ScienceDirect RCT](https://www.sciencedirect.com/science/article/pii/S1071581925000710)).
  So T2 should track `motivationalState: forming | ambivalent | formed` and
  select the conversational strategy from it — the strategy-selector pattern
  from the MI-agent literature. Someone still forming a view gets exploration;
  someone with a formed view gets moved to intake promptly.

**The mode switch is spoken.** The transition from discovery to input-gathering
should be an audible summary-and-check — the S in OARS. It makes the shift feel
intentional rather than abrupt, and doubles as a natural confirmation gate:

> "Right — so what I'm hearing is you want out of renting within about three
> years, without draining the savings you've built. Let me pull up what's most
> useful for that. I'll need to ask you a few specifics — is now a good time?"

**Boundaries.** This is elicitation, not persuasion. No pressure tactics, no
manufactured urgency, no false rapport, no implying human identity — the AI
disclosure stays. MI is collaborative by definition; that is exactly why it is
the right frame for a regulated context.

---

## 6. Migration plan

### Phase 0 — Safety net and the live bug (~1 week, do first regardless)

Everything from P0 of the
[prior plan](realtime-conversation-intelligence-plan.md): the offline
conversation simulator, the young-renter fixture, and the four narrow fixes.

**Non-negotiable prerequisite.** The redesign is weeks of work on the component
that decides what a client is asked; without an offline harness you cannot prove
any phase below is safe, and you would be iterating via paid live probes. The
live bug also should not wait for a redesign.

### Phase 1 — Manifests as data, zero behaviour change (~1 week)

- Author `docs/modules/*.md` for the 9 consumer-relevant modules.
- Build `generate-module-manifest.mjs` + `--check`, wired into `check:consumer`.
- **Assert the generated manifest reproduces today's `ROUTES`,
  `applicableGoals` and `INTAKE_FACTS` exactly.** Nothing reads it yet.

Fully reversible; the diff is additive.

### Phase 2 — Ratifier reads manifests (~1–2 weeks)

- `buildGoalModulePlan` computes from manifests; delete `ROUTES`
  ([goal_plan.js:34](../js/planning/goal_plan.js:34)) and the `route(...)` block
  ([routing_rules.js:87](../js/planning/routing_rules.js:87)).
- Add `eligibility` and `factPreconditions` evaluation.
- Delete `buildPersonaModulePlan` / `classifyPlanningPersona`; retire the
  `goalRoutingEnabled === false` branch; rename `persona` → `circumstances`.
- Simulator proves parity on existing fixtures **and** improvement on the new
  low-asset personas.

At this point the reported bug is structurally impossible: a renter fails
`property_position`'s precondition.

### Phase 3 — T2 supervisor (~2 weeks, flagged)

- Split the planner into T1/T2 with separate budgets and prompt versions.
- T2 proposes `{moduleId, confidence, evidence[]}` against the catalogue;
  ratifier validates; hysteresis on changes.
- New flag `CONSUMER_REALTIME_SUPERVISOR_ENABLED`, defaulting false in
  `wrangler.toml` like every other consumer switch.
- **Fallback to Phase-2 deterministic routing on timeout, low confidence or
  malformed output** — worst case equals Phase 2.

### Phase 4 — Two modes and the craft layer (~2 weeks)

- Separate `buildDiscoveryInstructions` and `buildIntakeInstructions`, both in
  the labelled-section structure from the
  [realtime prompting guide](https://developers.openai.com/cookbook/examples/realtime_prompting_guide)
  (Role & Objective / Personality & Tone / Context / Tools / Rules /
  Conversation Flow / Safety & Escalation).
- OARS moves as explicit sample phrases, with a variety rule.
- Spoken mode-switch summary as a first-class phase.
- Split the prompt into cacheable prefix + volatile suffix; replace the 12KB
  brief injection ([realtime_provider.js:230](../worker/src/consumer/realtime_provider.js:230))
  with the `toConversationGuide` projection.

### Phase 5 — Adviser authoring surface (~1–2 weeks)

`/app/modules.html` alongside the existing adviser pages: author a manifest,
validate it live, **dry-run it against saved transcripts** to see which past
conversations would now select it, then publish behind review. This is what
makes "advisers can add modules" real rather than theoretical.

### Phase 6 — Measurement loop (~1 week)

learning-signals events: `module_proposed` (with confidence + evidence),
`module_ratified` / `module_rejected_by_ratifier`, `mode_switch_turn_index`,
`question_answered_not_applicable`, `goal_confidence_at_switch`. The
supervisor-vs-ratifier disagreement rate is your direct quality signal — a
manifest whose prose keeps getting overruled by its own predicates is a manifest
written badly.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| T2 latency leaks into replies | T2 never gates a reply; runs during agent speech; T1 stays <2s |
| Cost of two model streams | catalogue as cached prefix; T2 on change-trigger, not every turn |
| Adviser prose quality varies | dry-run against saved transcripts (Phase 5) before publish; disagreement-rate monitoring |
| Prompt injection via manifest text | compiler sanitizes, caps, delimits; frontmatter schema-validated at build |
| Module set thrashes mid-call | hysteresis + confidence floor; changes must be explained aloud |
| Discovery rambles | hard turn cap and forced switch (§2.5) |
| Canary gates weakened | ratifier keeps every existing gate; supervisor sits *before* it, never after |
| Catalogue outgrows the prompt | accessor indirection now; retrieval at ~25 modules |

---

## 8. Decisions needed from Gerry

1. **Discovery length.** What is the right feel — 4 turns of discovery before
   getting practical, or 8? This sets the mode-switch cap and materially changes
   the experience.
2. **Manifest authoring format.** Markdown + frontmatter in `docs/modules/`
   (matches prompt-pack, git-reviewed, CI-gated) — or a database-backed manifest
   editable from `/app/` without a deploy? The first is safer and faster to
   build; the second is what "advisers add modules" eventually means. Phase 5
   assumes we start with the first and add the second on top.
3. **Who may author.** Only you, or other advisers later? Determines whether the
   review gate is a git PR or an in-app approval workflow.
4. **T2 model.** `gpt-5.6-terra` at `medium` for genuine judgment, or
   `gpt-5.6-luna` at `low` for cost? Recommendation: terra/medium for T2 (it
   runs a few times per call, hidden behind speech), luna/low for T1 (every
   turn, latency-critical) — which is roughly today's
   `complexModel`/`defaultModel` split, reused.
