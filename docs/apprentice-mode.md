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

**The Master Prompt Pack is the authority on what each module can vary.**
`js/planning/scenario_catalogue.js` declares only what the pack authorises, with
the citation beside each entry, and refuses anything else by name. Nothing may
be added to it without an explicit product decision.

| `/run <module>` | Lever | What it varies |
|---|---|---|
| `net_retirement_cashflow` | `annualExpenditureToday` | what the household spends each year in retirement |
| | `availableInvestmentFundToday` | the fund available today to cover the shortfall |
| | `excludedIncomeSourceIds` | an income source that stops — the pack's preferred way to model lost income |
| `pension_projection` | `rentalIncomeToday` | gross annual rent in today's money |
| `college_funding` | `annualCostTodayPerChild` | yearly cost per child — living at home versus away |
| | `oneOffCostTodayPerChild` | a one-off per child, which the pack uses for car support |
| `house_purchase` | `supportCase` | `none` / `htb_only` / `fhs_only` / `htb_and_fhs` |
| | `depositSavingsGrossAer` | the gross rate the deposit savings earn |
| | `mortgageIllustrationRate` | the rate the repayment is illustrated at |
| | `mortgageTermYears` | how long the mortgage is taken over |
| | `emergencyReserveTarget` | cash kept back rather than put into the deposit |

Every `/run` executes the **base case alongside the what-if** and prints both,
because a scenario with nothing to compare against is not a scenario.

### Rental income varies in place

`rentalIncomeToday` is a genuine value, not a with/without toggle. The base is
the client's actual rent; the scenario can be zero, lower, equal or higher:

```
/run pension_projection rentalIncomeToday=0        # sells the property
/run pension_projection rentalIncomeToday=30000    # buys another
/run pension_projection rentalIncomeToday=15000    # has none yet, considering a BTL
```

It is applied by scaling the rental income sources the client already has,
**proportionally**, so a household with two rented properties keeps its shape and
every source keeps its own start year, end year and inflation treatment. Where
there is no rental income yet, the what-if adds one starting at the client's
intended retirement age. The pack's top-level `rentalIncomeToday` field is
deliberately left unset: the engine adds it *on top of* the income sources
(`pension_math.js:797-803`), so writing both would count the rent twice.

### Net retirement runs on the adviser path

`net_retirement_cashflow` is adviser-routable but `platformConsumerApproved:
false`, and stays that way. `/run` reaches it through `runPlanningModule`, which
asks whether a module has an engine rather than whether it is approved for the
public product — so teaching calls exercise the adviser capability without
opening a consumer gate. `runConsumerAnalysis` still refuses the module.

### Personal balance sheet

PBS scenario capability **is authorised** by the pack ("Optional PBS
Alternatives", `10_pbs_playbook.md:85-115`) — the pack assigns it to the AI
author, which writes fully recalculated sections. What is missing is the
deterministic transformation layer that would let an engine construct one, so it
is recorded in `SCENARIO_ARCHITECTURAL_GAPS` as
`authorised_missing_execution_layer`. **Not unsupported — unbuilt.**

### When a what-if cannot be expressed

Ask for it anyway. A refused lever, or one the engine silently ignores, is
recorded at the top of the bundle as a **capability gap** and put to you as a
capability question — never compiled into a lesson, and never closed by widening
a module's levers. That is how this testing period is meant to discover where the
existing capability is too narrow.

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
