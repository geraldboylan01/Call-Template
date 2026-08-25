# Apprentice mode — teaching Planéir by advising a call yourself

Two runners already existed, and both cast the APP as the adviser:
[`agent-call.mjs`](../scripts/agent-call.mjs) has you play the client, and
[`run-consumer-agent-call.mjs`](../scripts/run-consumer-agent-call.mjs) has a
model play the client and grades the app afterwards. Neither captures a *better*
trajectory to learn from.

This is the third one. **A model plays the client, you play the adviser, and the
app records what its rules would have done instead.** The gap between those two
is the teaching signal.

## The loop

| Stage | Who | Costs |
|---|---|---|
| 1. Capture | Planéir, locally | one planner extraction per client turn |
| 2. Analyse | Claude Code or Codex | your existing subscription |
| 3. Approve | **you** | — |
| 4. Implement | Claude Code or Codex | your existing subscription |
| 5. Replay | deterministic | nothing |

Stages 1, 4 and 5 are mechanical. Stage 2 is the only place a model decides
anything, and it can only propose. Stage 3 is enforced in code.

## Running a call

```bash
node ./scripts/teach-call.mjs start --caller=callers/mary.md --id=mary1
node ./scripts/teach-call.mjs client "I'm 52 and I'd like to go part-time at 60"
node ./scripts/teach-call.mjs say    "Before that — tell me about Tom's pension"
node ./scripts/teach-call.mjs finish
```

Two speakers, two commands. `client` buffers what the person said; `say` commits
the turn with your reply. One turn, one transaction: the planner extracts from
the client's words, and **your** words are what the meeting recorded as the
answer — so the profile advances on your trajectory and the client responds to
you, not to the app.

Whoever plays the client — a Claude Code subagent, or a person — gets the brief
and the client-visible conversation and **nothing else**: no planning state, no
module ids, no baseline. Same separation
[`agent-clients/openai.mjs`](../scripts/agent-clients/openai.mjs) already keeps.

Inside `say`, lead a line with:

| | |
|---|---|
| `/run <module> [lever=value ...]` | run an analysis on these assumptions — **this is how a what-if gets captured** |
| `/note <why you did that>` | the single most valuable thing you can leave |
| `/fix <what the app got wrong>` | correct what it heard |

A lever the engine cannot vary is **recorded, not rejected**. An assumption a
real conversation needs and the manifests do not have is the most useful thing
this loop can find.

### The baseline is never shown during the call

What the app would have said is written to disk and revealed only in the bundle,
after `finish`. This is the same rule the grading sheet already follows for the
judge's score ([`grading.mjs`](../scripts/agent-harness/grading.mjs)): a
demonstration anchored to the baseline cannot be used to check the baseline.

### Flags

- `--shadow=deterministic` (default) — the baseline costs **nothing**: the
  question the engine would ask, the analyses it would offer, what it is still
  short of, and the rule or manifest field behind each.
- `--shadow=full` — adds one renderer call per turn to capture the words and the
  **tool choice**, run against a throwaway clone of the database so its tool
  calls cannot mutate the meeting. Worth it when you are working on when the app
  decides to run the analyses.
- `--offline` — swaps the extraction for the deterministic fallback. Checks the
  plumbing; **never evidence of anything**, because the baseline is then not the
  real system's decision.

## Teaching from it

```
/teach mary1
```

Claude Code (or Codex, pointed at `teaching/pending/mary1/README.md`) reads the
bundle and the live repository, and puts each proposal to you as:

```
Existing behaviour:    ...
Adviser's behaviour:   ...
Why it appears better: ...
Proposed lesson:       ...
Do not apply when:     ...
Potential risks:       ...
Recommended tests:     ...
```

Then:

```bash
node ./scripts/teach-lesson.mjs approve mary1 --as="<your own words>"
node ./scripts/teach-lesson.mjs approve mary1 --accept-as-written
node ./scripts/teach-lesson.mjs reject  mary1 --why="one-off, not a rule"
```

**If you restate it, your words replace the agent's** and become what gets
compiled. `approve` prompts at the terminal; if it refuses because there is no
terminal, that is the gate working.

## What stops an unapproved lesson changing anything

Three independent things, and all three have to be got past:

1. Proposals live in `teaching/pending/`, which is **gitignored and read by no
   runtime code**. Writing one changes nothing.
2. `teach-lesson.mjs compile` refuses any lesson that is not `approved` **and**
   whose text does not still hash to what was approved. Edit an approved lesson
   and it needs approving again.
3. `npm run check:teaching-lessons` runs inside `npm run check:consumer` and
   fails the build if any file in the tree claims a lesson that is not approved
   with a matching hash — catching a change that bypassed the compiler entirely.

An approval made without a terminal prompt is recorded as
`approval.interactive: false` and reported by the check. It is not invalid, but
it is the first thing to look at.

## Which layer a lesson lands in

Ordered by what it costs at runtime, cheapest first. **A lesson may land at
layer N only if it genuinely cannot be expressed at N−1** — that ordering is
what stops the per-turn prompt growing with every lesson, which is where latency
comes from.

| | Layer | Cost per turn |
|---|---|---|
| 1 | Deterministic planning — `js/planning/*`, `conversation.js` | zero |
| 2 | Manifests and registries — `docs/modules/*.md`, `semantic_facts.js` | zero after turn one (cached prefix) |
| 3 | Cached prompt prose — `catalogue_prompt.js` | cached; costs a version bump |
| 4 | Per-turn state item — `liveVolatileStateItem()` | **paid every turn**; fixed budget, must displace something |
| 5 | Module engines — `js/planning/adapters/*` | zero tokens, but changes what a number **means** |

Layer 5 is never a teaching-loop change. Neither is `LIVE_PROMPT_VERSION`,
`wrangler.toml`, or anything in `.github/workflows/` — those are deployment
decisions.

## What-if analyses

Each scenario-aware module declares its levers in its manifest, under
`implementation.scenarioLevers`: what may vary, within what range, and what it
means in a client's terms. [`js/planning/scenario_levers.js`](../js/planning/scenario_levers.js)
reads them and validates strictly, so a lever out of range is refused with a
readable message rather than silently ignored — a model told nothing would
describe base-case results as though the scenario had run.

Currently declared:

| Module | Levers |
|---|---|
| `pension_projection` | `retirement_age`, `annual_contribution`, `growth_rate` |
| `net_retirement_cashflow` | `retirement_age`, `annual_expenditure`, `present_value_rate` |
| `house_purchase` | `targetPropertyPrice`, `plannedMonthlySavings`, `mortgageTermYears`, `mortgageIllustrationRate`, `emergencyReserveTarget` |

`scenarioPromptSection()` generates the prompt text from those manifests, so it
can never name an assumption the engine would refuse. **It is not yet wired into
the live prompt** — doing so bumps `LIVE_PROMPT_VERSION` and the deploy pin in
`.github/workflows/deploy-worker.yml`, which is a deployment decision.

## A two-week block

- **Days 1–2** — three calls, **change nothing**. Establish the baseline
  divergence rate, and prove the read-back can describe what you did before it
  is trusted to change anything.
- **Days 3–8** — one or two calls a day through the whole loop. Scenario-heavy
  callers first: people whose questions are inherently what-ifs.
  [`callers/EXAMPLE.md`](../callers/EXAMPLE.md) is already one.
- **Days 9–10** — replay the whole caller set.

If nothing has been rejected by the end of it, the analysis is rubber-stamping
and the loop is not yet trustworthy.

## Privacy

`teaching/pending/` is gitignored: it holds a real person's finances.
`teaching/lessons/` is committed and must be **de-identified** — "a client with
a DB pension who does not know its value", never a name and a set of figures.
`check:teaching-lessons` scans the corpus for email addresses, PPS-shaped
numbers, IBANs and phone numbers and fails on any of them.
