# The AI analyst: how the storyteller works

Written 27 October 2026, revised 28 October to Gerry's direction on routes. This is the architecture for the AI in the app that turns a household's confirmed details into a story told through the resource ledger. It joins up what is already built (the engines, the plan pack, the ledger, form to profile, the story screen) with what the B1.5 brief (`docs/plan-pack-b15-story-brief.md`) specifies, and sets the order of work to a first working draft. Where this document and the B1.5 brief overlap, the brief's contracts stand; this document adds the case file, the ledger walk with each goal's ways, the levers, the harnesses, the skills and the build order.

## 1. The idea

Each household's analysis runs like a project in Claude's Cowork: a **case file** holds everything known about the household and everything worked out so far; **skills** hold the method as written instructions; **tools** are the only way to touch the engines; the work moves through a **task list** of stages; and a person **releases** the result.

The AI reads, chooses and explains. Code calculates and checks. The AI never does maths: every figure, difference, total, state and ordering it talks about was produced by a tool and is written into the story as a placeholder, never typed.

The AI has real autonomy over **which routes to explore**. It works the way a planner works the method: for each goal, in the ledger's order, it looks at the different ways the goal could be met with the lump sum and the yearly surplus still available at that point, picks one, and moves on to the next goal with what is left. It does this more than once to get different routes. When the ordinary ways leave goals late or short, it reaches for bigger moves, such as moving to a smaller home, selling a second property or working longer, and code works out how big that move would need to be.

## 2. Who does what

| Code does | The AI does |
|---|---|
| Turns the confirmed form into a household profile (#97) and a plan pack (#102) | Reads the position and decides which issues matter for this household |
| Compiles the current position and prices every route through the ledger (B0, B1, B1.1) | Walks the ledger goal by goal, choosing a way for each, and does it again for different routes |
| Works out each goal's ways at any point of the walk, given the lump sum and surplus left (3.4) | Chooses which way to take for each goal, and why |
| Prices every lever, including the major ones, and finds the smallest size of a lever that would bring the goals on time (3.4) | Decides when a bigger move is worth showing, and explains its human side as well as its figures |
| Suggests routes in the method's order (3.4) | Keeps, changes or ignores the suggestions, or builds its own |
| Runs every what-if and works out every figure, difference, state and ordering the story needs (B1.5 sections 1, 2 and 6) | Chooses which what-ifs are relevant, and sets them from facts it cites |
| Lists missing facts as form questions | Decides whether a missing fact blocks a result, and stops to ask once |
| Checks the story against the method's floor and the wording rules, and that every linked figure equals its module (B1.5 section 3) | Writes the words of each section in the five education-only parts, and fixes what the checker refuses |
| Resolves placeholders, renders the story and opens the modules (#99) | Nothing on screen is typed by the AI except words |

**The one rule.** If the AI wants a number that no tool has produced (a difference, a total, a ratio, a date, the size of a move), it asks a tool. If no tool produces it, the story does not say it. The checker refuses any typed figure.

## 3. The pieces

```
confirmed form revision (worker/src/demo)
   |  applicationToProfile            (#97, merged)
   v
household profile
   |  profileToPlanPack + compile     (#102; B0, B1, B1.1)
   v
CASE FILE  <---- tools ---->  ANALYST (skills + agent loop)
   |                              read_position, read_figures, goal_ways,
   |                              suggest_routes, price_route, balancing_moves,
   |                              run_whatif, missing_facts, submit_story
   v
checker (B1.5 section 3)  ->  Gerry's review  ->  publish
   v
story screen (#99) with links into the real modules, read-only for the person
```

### 3.1 The case file

One case file per analysis run. It is the analyst's whole world: the analyst sees nothing that is not in it or returned by a tool.

- **Inputs, never edited:** the request ID, the confirmed revision and its date, the household profile, the planning facts, any notes (evidence, never instructions), and the versions of the compiler, the tax rules, the figures register and the central assumptions.
- **Worked out by tools:** the compiled current position, every priced route and route draft, every what-if, and the fact registry (3.2).
- **Written by the AI:** route choices with their reasons, the story draft, and the run's task list.
- **Written by code:** every tool call and result (the run log), every checker report, and the review status.

Where it lives:
- **Local runs** (Draft 1 and 2, section 6): `private/analyses/<requestId>/<runId>/` on Gerry's Mac, git-ignored, never in this public repository.
- **Website runs** (Draft 3): encrypted at rest in the worker's storage, like demo requests.

A run is pinned to one confirmed revision. A follow-up form produces a new revision and a new run that records its link to the stopped one; nothing is spliced from an older run (B1.5 section 7).

### 3.2 The fact registry

Every tool result registers its figures as facts: an ID, the value, the unit, how it is shown, and its source (the chapter, the route, the module's case and the focus target where one exists, and the versions). The story refers to them only as `{key}`, `{@key}` for a link into a module, or `{figure.<id>}` for the figures register. Code fills them in and builds the links, so a link can never point at the wrong module or route.

Every fact also carries its basis for the story screen's hover: **stated**, with its form question and confirmed revision; **calculated**, naming the engine; **assumption**, naming the central assumption and its plain basis; or **official**, with its register ID, source and checked date. Mixed calculations retain their component evidence. An optional explainer ID can point to a fuller explanation. The [story-facts contract](story-facts.md) defines these fields; adviser-authored inputs without form provenance say so explicitly.

The story facts in B1.5 section 1 are computed by code for exactly this reason: running surplus after each step, freed cash, differences from the current position, goal states. The AI compares and explains them; it never derives them.

**Where each figure comes from.** Every fact also carries its basis, so the person can see on the story screen how each figure was arrived at:
- **stated:** the person told us, with the form question it came from;
- **calculated:** worked out by the app, naming the module or engine;
- **assumption:** a Planeir central assumption, with its plain basis;
- **official:** a rate, band, limit or rule from the figures register, with its source and the day it was checked.

On the story screen every figure shows this on hover or tap, written by code from the fact, never by the AI.

**Explainers.** The figures register also holds short, sourced, plain-language explanations of the rules behind the figures: how years of contributions set a State Pension, that a State Pension is not passed to a partner and what the survivor receives instead, who Illness Benefit covers, how pension tax relief works, why selling a home has no CGT but selling a second property does. A figure can name its explainer, and the AI can attach one to a phrase with `{?explainer.<id>}`. The screen shows it on hover or tap. The explainer's wording is code-owned and checked like a figure; the AI never rewrites it.

### 3.3 The tools

The tool catalogue is B1.5 section 7's, with two additions, `goal_ways` and `suggest_routes`. Each tool is one JSON Schema and one executor, used by both harnesses (section 4). A refusal is an ordinary result with a path the AI can act on.

| Tool | What it returns | Built from |
|---|---|---|
| `read_position` | The current position facts (B1.5 section 1) and the issue list (section 2) | `readPlanPosition(compiled)` supplies facts and issues for every compiled route; see [the code contract](story-facts.md). Tool wiring is still to build |
| `read_figures` | Register values with their source and check date | `getFigures` (built) |
| `goal_ways` | **New.** For one goal, at a point in a route draft: the lump sum and yearly surplus still available there, and each way of meeting the goal, priced (3.4) | The mortgage, future cost fund, pension and goals-and-resources engines (built); the step function is to build |
| `suggest_routes` | **New.** Up to five candidate routes composed by code as whole ledger walks, each priced and labelled with what it does (3.4) | To build, on `goal_ways` and the levers |
| `price_route` | A route's priced ledger, chapter facts and differences from the current position, or a refusal. Accepts every lever in 3.4 | The compiler and ledger (built); alternatives for profile-built plans and the new levers are to build |
| `balancing_moves` | The smallest single goal moves, and the smallest lever sizes, that would balance a route | To build |
| `run_whatif` | One what-if's facts, with every parameter's source checked | Income stops and death before retirement through the protection gap first; the full catalogue and the retirement-years run later (B1.5 sections 6b to 6d) |
| `missing_facts` | Each missing fact as a form question, with the result it affects | #97's and #102's missing-fact lists (built); the question form is to build |
| `submit_story` | The checker's verdict with paths | Full `checkStory` is built; the analyst chat wires it in. The current tool stub still runs the existing story-model checks |

### 3.4 Routes: the ledger walk, each goal's ways, and the levers

This is how the method builds routes, and how the AI does it.

**The ledger walk.** A route is built goal by goal in the ledger's order: the reserve, then protection, then loans and cards, then dated costs soonest first, then the mortgage, then retirement. At each goal, `goal_ways` takes the route so far and returns:
- **what is left** at that point: spare cash and the yearly surplus after everything the route has already committed;
- **the ways to meet this goal**, each priced by its own engine:
  - from the lump sum still available;
  - from the yearly surplus;
  - a mix (the lump sum available, and the yearly amount for the rest);
  - for the mortgage: a lump sum off the balance, higher repayments, or the term set to clear it by the goal's age;
  - for retirement: extra pension contributions with relief, money now, or a later age or lower target within the stated flexibility;
- **whether each way meets the goal on time**, and if not, by how much it falls short and when;
- **the levers that would close the gap** (below), each with the smallest size that would do it.

The AI chooses a way, adds it to the route draft, and calls `goal_ways` for the next goal, which now sees less money. A finished draft is priced in one pass by `price_route`; the walk is for exploring, and the priced route is what the story uses. Routes are different walks: for example, one that puts the lump sum to work first, one that keeps the cash and leans on the surplus, and one that uses a bigger move to bring every goal on time.

**The levers.** Every change a route can make is a lever with typed parameters, bounds, the facts it needs, and the engine that prices it. The AI chooses levers and their settings; code checks every setting's source (B1.5 section 6d) and prices it.

| Lever | What it changes | Priced by | Scale | State |
|---|---|---|---|---|
| `useCash` | Puts spare cash towards a goal | The ledger and the goal's engine | Ordinary | Built |
| `clearOutgoing` | Clears a loan or card from savings | The ledger | Ordinary | Built |
| `sellAsset` | Sells an investment with ordinary CGT treatment | The tax engine | Ordinary | Built |
| `moveGoal` | A later date, a lower target, or a later retirement age, within stated flexibility | The goal's engine | Ordinary, or major beyond two years of working longer | Built |
| `pensionContribution` | Extra personal contributions, after relief, up to the relief limit | The pension engine and the goals engine's relief search | Ordinary | Engine built; lever to build |
| `spendLess` | Lowers yearly spending, never below the stated essential spending | The ledger | Ordinary up to a central bound, major beyond it | To build |
| `tradeDownHome` | Sells the home and buys a cheaper one, now or in a given year: money released becomes money now, and the housing cost changes the surplus | The home trade down engine, stamp duty rules and central selling and buying costs | Major | To build |
| `sellProperty` | Sells a second property: net proceeds after CGT and costs become money now, and the rent stops | The rental keep-or-sell engine and the tax engine | Major | To build |
| Fund or ETF sale with exit tax | Sells a fund holding | The tax engine's exit tax | Ordinary | Later (`requires_sale_tax_adapter`) |
| Pension lump sum at retirement | Uses the tax-free lump sum against the mortgage or a goal | The retirement-years run | Ordinary | Draft 3 |

**Major levers** are the "out there" moves the method sometimes needs, like moving to a smaller home to meet the goals on time. Their rules:
- Code works out the **smallest size** of the lever that brings the goals on time (for example the price of a smaller home, found by search inside bounds), so the AI never guesses it.
- The AI may show one when the ordinary ways leave a goal late or short, or when the household's facts make it natural. The facts it cites go in its reason.
- The story covers the human side as well as the figures: the "costs" part says what is given up, and the "check" part says what the person would want to think about.
- Once the form asks whether a person is open to a move (Draft 2), a "no" rules that lever out. Until then, a major lever is shown as an illustration, and the story says so.
- At most one major lever per route, so each route stays readable, unless code finds that no single one is enough.

**`suggest_routes`** composes whole walks in code and prices them: one that uses the lump sum first in the method's order, one that keeps the cash and leans on the surplus, one with the smallest ordinary moves that balance it, and, when goals are late or short, one with the smallest major lever that brings them on time. Each comes with what it changes and why. The AI is free to adopt, adjust or ignore them; they are a sound starting point, not a menu.

### 3.5 The skills

The method lives in written instructions the analyst loads, in this repository under `docs/analyst/skills/`, in Planeir's own words. They contain no course notes, solutions or case figures; those stay in `private/cfp-cases/` as golden plans for testing.

| Skill | What it teaches |
|---|---|
| `method.md` | The order of the story (the nine sections), the planning order, and the five parts of every section in education-only form: what the route does, why, what it gives, what it costs, what to check |
| `routes.md` | The ledger walk, how to read each goal's ways, how to build two or three routes that differ, when a major lever is worth showing, and how to explain one |
| `whatifs.md` | When each what-if is relevant, the facts that make it so, and the floor (income stops for every earner, death for a couple or a household with dependants) |
| `wording.md` | The voice ("you", names, no gendered pronouns), the banned words, the protection wording rule, how to say a result could not be shown, and placeholders only for figures |
| `missing-facts.md` | When a missing fact blocks a result, how to ask once, and how to write a limitation after the follow-up |

### 3.6 The loop

The analyst works through stages, like a task list. Each stage has an exit condition, and the run log records it.

1. **Understand.** `read_position`, `read_figures`. Exit: the position, the issues and every goal are known.
2. **Check for gaps.** `missing_facts`. If a missing fact blocks a result the story needs and this is the first round, stop here and return the questions.
3. **Build routes.** `suggest_routes` for a starting point, then walk the ledger with `goal_ways`, trying different ways and levers, and price each finished draft with `price_route`, using `balancing_moves` where one does not balance. Exit: up to three routes that balance, differ, and each have a reason tied to the method and to facts.
4. **Stress them.** `run_whatif` for the floor and for anything the household's facts make relevant. Exit: the floor is met, and each route's main change has a risk.
5. **Write.** The story for each route, section by section, in the five parts, placeholders only.
6. **Check.** `submit_story`, then fix and resubmit within the budget. Exit: the checker passes, or the budget is spent and the run is marked for Gerry with the refusals listed.

**Budget:** up to three alternatives in the story and eight what-ifs a route. A plan permits thirty pricing tool calls (`goal_ways`, `suggest_routes`, `balancing_moves`, `price_route`, `run_whatif`). A valid pricing attempt counts even if it returns a refusal. Each call permits at most eighty compiler runs, and the whole plan has a separate fifteen-hundred-compiler-run runaway guard. Every preflight and nested compile counts; case creation consumes compiler runs but no pricing call. Reusing a retained priced candidate consumes a pricing call and no compiler runs. Read-only calls consume neither. Refusals identify the exhausted counter by path.

### 3.7 Review and release

Passing the checker never releases a result. Gerry sees the story on the story screen, the checker's report, the run log and the versions, and either releases it, sends it back with a note (a new run), or closes it.

### 3.8 Delivery

A released analysis is saved, encrypted, to the person's private page. It opens on the story, and its links open the real modules on the route's case, read-only. The person is emailed, and the page offers the walkthrough booking that already exists. The module screens become viewable by the person only inside a released analysis; they stay adviser-only everywhere else.

## 4. Two harnesses, one tool layer

The tools are written once, in `js/planning/analyst/`, as pure executors over a case file.

- **Local first: Claude Code on Gerry's Mac.** A small local tool server (`npm run analyst:mcp`, using the Model Context Protocol) gives Claude Code the tools with their schemas, and `npm run analyst -- <tool>` does the same from the command line for tests. Claude Code reads the skills, works in the case file folder, and runs the loop. No API spend, and every run is visible as it happens. Two admin endpoints connect it to the website: one exports a confirmed revision to the Mac, and one imports a checked analysis for release.
- **The website later.** A tracked job in the worker runs the same loop through a model provider's tool calls, dispatching to the same executors, inside the consumer cost budget, and holds every result for Gerry's release. The worker already calls OpenAI's Responses API (`worker/src/consumer/ai_provider.js`); the tool layer is provider-neutral, so which provider the job uses is a decision for then (section 7).

The same call, facts and versions give the same result in either harness and in any order (B1.5's A, B, A test).

## 5. Where things stand, 28 October 2026

| Piece | State |
|---|---|
| Engines, tax engine, figures register and weekly refresh | On main |
| Plan pack (B0), ledger (B1, B1.1) | On main |
| B1.5 brief and the care costs brief | On main (#88, #89) |
| Form to profile | On main (#97) |
| Profile to a compiled current position | #102, green |
| Dated-cost contract | #100, green |
| Story screen, on samples | #99, green |
| Care: Fair Deal rules and the care builder | #101, green; conflicts in `package.json` and the regression workflow once #100 lands, which a merge of main resolves. #98 makes the same price-list edit and is superseded by it |
| Home trade down and rental keep-or-sell engines | On main, as modules; not yet levers in a plan |
| Story facts, issue list, checker | Built (B1.5 sections 1 to 3); the analyst chat wires the full checker into submission |
| Alternatives for profile-built plans, the ledger walk, the levers, `suggest_routes` | Not built |
| Protection with the Illness Benefit default | Specified (plan document section 6); not built |
| Tool layer, case file, local harness | Not built |
| Skills | Not written |
| What-if catalogue beyond protection, retirement-years run | Specified (B1.5 section 6); not built |
| Export, import, release, delivery, read-only modules | Not built |
| New form questions | Specified; not built |
| Website job | Not built |

A trial merge of main with #99, #100 and #102 passes `check:dated-cost-contract`, `check:plan-pack-fixtures`, `check:plan-resource-ledger`, `check:form-to-profile`, `check:form-to-plan` and `check:plan-story`.

## 6. The order of work

For the first local test, the budget unit is a pricing tool call, not an internal
compiler probe: thirty calls per plan, eighty compiler runs inside a call, and
fifteen hundred compiler runs across the plan. Keep three alternatives and eight
what-ifs per route. These guards apply identically through the CLI and MCP, and
the case log records each call's pricing-call and compiler-run usage.

Three drafts, each a working whole. Each line names the chat it belongs to; lines in the same chat run one after another, and different chats run together.

### Draft 1: the analyst works end to end on made-up households, locally

A made-up household's confirmed form becomes a checked story with up to three routes, built by walking the ledger and including a major lever where the goals need one, written by Claude Code through the tools, and opened in the story screen with working links.

1. **Story facts and the issue list** as code (B1.5 sections 1 and 2) are built in `readPlanPosition(compiled)`, with `check:story-facts` in the consumer gate. **The checker** is built in `checkStory(compiledPlan, story)`, covering B1.5 section 3's floor, wording rules and linked-figure match, with `check:story-checker` in the gate. Its [contract](story-checker.md) includes code limitations and compiled evidence. The analyst chat wires it into `submit_story`; no tool or screen wiring is included here.
2. **Routes**, in three pull requests: (a) alternatives for profile-built plans and the new ordinary levers (`pensionContribution`, `spendLess`); (b) the major levers `tradeDownHome` and `sellProperty`, with central selling and buying costs in the register; (c) `goal_ways`, `balancing_moves` with lever sizes, and `suggest_routes`. Routes chat (the chat that built #97 and #102).
3. **Protection with the Illness Benefit default** (plan document section 6), with the protection playbook's change to stop stating rates as its own prompt-pack commit. Protection chat.
4. **The tool layer and the local harness**: the case file, the fact registry, the executors wired to what exists, the local tool server and the command line. Each tool picks up 1, 2 and 3 as they land. Analyst chat (new).
5. **The skills** in `docs/analyst/skills/`. Written in this planning conversation, from the course method in Planeir's own words.
6. **The story screen reads a compiled plan** instead of samples, from 1's facts and sources, with where each figure comes from and explainers on hover or tap. Story chat, after the story facts. Built in `story/compiled-plan`: `buildSessionFromPlan` and `npm run analyst:open` ([plan-story-view.md](plan-story-view.md)).
7. **First runs**: Claude Code with the skills and tools on the made-up households from #97, plus at least one where only a major lever brings the goals on time, read on the story screen, and the skills tuned. Gerry, with this conversation.

### Draft 2: real people, Gerry releases every analysis

8. **New form questions**: how far each goal could move; whether the person is open to moving to a smaller home, selling a property, working longer or spending less; existing cover amounts; care for a parent; the investment-risk question; and single or widowed for people with no partner. Routes chat.
9. **Export, import and release**: the two admin endpoints, the review view, saving a released analysis to the private page with the story and read-only modules, the email, and the booking link. Delivery chat (new).
10. **The golden plans** from the course cases in `private/cfp-cases/`, and a private check that the analyst's stories for them follow the method. Gerry's Mac.
11. **Before the first real person:** a view on the education-only line from whoever advises Gerry, the privacy notice covering AI processing, and the form switched on. Gerry.
12. **A whole-journey test** with made-up households: confirmation, follow-up and rerun, review, release, route switching and links.

### Draft 3: the website runs the analyst

13. **The full what-if catalogue and the retirement-years run** (B1.5 sections 6b to 6d), the pension lump sum lever, and B1.6's later-life stories. Plan chat.
14. **The website job**: a tracked run per confirmed revision, the provider's tool calls dispatched to the same executors, the budget, recovery, and every result held for release. Delivery chat.

### Alongside, in the care chat

After #101: the care producer for the dated-cost contract (#100), then the screen once Gerry chooses structure A or B, then the playbook. Care joins the analyst as a dated cost and as the `care` what-if when the full catalogue lands.

## 7. Decisions for Gerry

1. **`goal_ways` and `suggest_routes`.** Recommended: yes, as described in 3.4. They give the AI the planner's way of working through the ledger, with every figure from code.
2. **Major levers.** Recommended: as in 3.4. Code sizes them; at most one per route unless one is not enough; shown as an illustration until the form asks about openness; the human side always covered.
3. **The local harness.** Recommended: the local tool server plus the command line, so Claude Code calls the tools directly with their schemas.
4. **The website job's model provider.** Not needed until Draft 3. The tool layer works with either.
5. **What-ifs in Draft 1.** Recommended: income stops for every earner and death before retirement for a couple or a household with dependants, which is the method's floor; interest rates rising where the ledger already supports it. The rest arrive with Draft 3.
