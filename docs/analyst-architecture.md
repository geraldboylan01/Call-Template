# The AI analyst: how the storyteller works

Written 27 October 2026. This is the architecture for the AI in the app that turns a household's confirmed details into a story told through the resource ledger. It joins up what is already built (the engines, the plan pack, the ledger, form to profile, the story screen) with what the B1.5 brief (`docs/plan-pack-b15-story-brief.md`) specifies, and sets the order of work to a first working draft. Where this document and the B1.5 brief overlap, the brief's contracts stand; this document adds the case file, the harnesses, the skills, one extra tool and the build order.

## 1. The idea

Each household's analysis runs like a project in Claude's Cowork: a **case file** holds everything known about the household and everything worked out so far; **skills** hold the method as written instructions; **tools** are the only way to touch the engines; the work moves through a **task list** of stages; and a person **releases** the result.

The AI reads, chooses and explains. Code calculates and checks. The AI never does maths: every figure, difference, total, state and ordering it talks about was produced by a tool and is written into the story as a placeholder, never typed.

## 2. Who does what

| Code does | The AI does |
|---|---|
| Turns the confirmed form into a household profile (#97) and a plan pack (#102) | Reads the position and decides which issues matter for this household |
| Compiles the current position and prices every route through the ledger (B0, B1, B1.1) | Chooses up to three plausible routes, inside the client's stated flexibility |
| Runs every what-if and works out every figure, difference, state and ordering the story needs (B1.5 sections 1, 2 and 6) | Chooses which what-ifs are relevant, and sets them from facts it cites |
| Suggests routes and balancing moves in the method's order (section 5) | Decides which suggestions to keep, change or ignore, and why |
| Lists missing facts as form questions | Decides whether a missing fact blocks a result, and stops to ask once |
| Checks the story against the method's floor and the wording rules, and that every linked figure equals its module (B1.5 section 3) | Writes the words of each section in the five education-only parts, and fixes what the checker refuses |
| Resolves placeholders, renders the story and opens the modules (#99) | Nothing on screen is typed by the AI except words |

**The one rule.** If the AI wants a number that no tool has produced (a difference, a total, a ratio, a date), it asks a tool. If no tool produces it, the story does not say it. The checker refuses any typed figure.

## 3. The pieces

```
confirmed form revision (worker/src/demo)
   |  applicationToProfile            (#97, merged)
   v
household profile
   |  profileToPlanPack + compile     (#102; B0, B1, B1.1)
   v
CASE FILE  <---- tools ---->  ANALYST (skills + agent loop)
   |                              read_position, read_figures, suggest_routes,
   |                              price_route, balancing_moves, run_whatif,
   |                              missing_facts, submit_story
   v
checker (B1.5 section 3)  ->  Gerry's review  ->  publish
   v
story screen (#99) with links into the real modules, read-only for the person
```

### 3.1 The case file

One case file per analysis run. It is the analyst's whole world: the analyst sees nothing that is not in it or returned by a tool.

- **Inputs, never edited:** the request ID, the confirmed revision and its date, the household profile, the planning facts, any notes (evidence, never instructions), and the versions of the compiler, the tax rules, the figures register and the central assumptions.
- **Worked out by tools:** the compiled current position, every priced route, every what-if, and the fact registry (3.2).
- **Written by the AI:** route choices with their reasons, the story draft, and the run's task list.
- **Written by code:** every tool call and result (the run log), every checker report, and the review status.

Where it lives:
- **Local runs** (Draft 1 and 2, section 6): `private/analyses/<requestId>/<runId>/` on Gerry's Mac, git-ignored, never in this public repository.
- **Website runs** (Draft 3): encrypted at rest in the worker's storage, like demo requests.

A run is pinned to one confirmed revision. A follow-up form produces a new revision and a new run that records its link to the stopped one; nothing is spliced from an older run (B1.5 section 7).

### 3.2 The fact registry

Every tool result registers its figures as facts: an ID, the value, the unit, how it is shown, and its source (the chapter, the route, the module's case and the focus target where one exists, and the versions). The story refers to them only as `{key}`, `{@key}` for a link into a module, or `{figure.<id>}` for the figures register. Code fills them in and builds the links, so a link can never point at the wrong module or route.

The story facts in B1.5 section 1 are computed by code for exactly this reason: running surplus after each step, freed cash, differences from the current position, goal states. The AI compares and explains them; it never derives them.

### 3.3 The tools

The tool catalogue is B1.5 section 7's, with one addition, `suggest_routes`. Each tool is one JSON Schema and one executor, used by both harnesses (section 4). A refusal is an ordinary result with a path the AI can act on.

| Tool | What it returns | Built from |
|---|---|---|
| `read_position` | The current position facts (B1.5 section 1) and the issue list (section 2) | The compiled current route (#102); the story facts and issue scan are to build |
| `read_figures` | Register values with their source and check date | `getFigures` (built) |
| `suggest_routes` | **New.** Up to five candidate routes composed by code from the change primitives in the method's order (reserve, then protection, then inefficiencies, then goals soonest first, then retirement), each kept inside the stated flexibility, priced, and labelled with the method step it serves | The ledger and route primitives (built); the composer is to build |
| `price_route` | A route's priced ledger, chapter facts and differences from the current position, or a refusal | The compiler and ledger (built); profile-built plans need alternatives switched on (#102 is current position only) |
| `balancing_moves` | The smallest single goal moves that would balance a route | To build |
| `run_whatif` | One what-if's facts, with every parameter's source checked | Income stops and death before retirement through the protection gap first; the full catalogue and the retirement-years run later (B1.5 sections 6b to 6d) |
| `missing_facts` | Each missing fact as a form question, with the result it affects | #97's and #102's missing-fact lists (built); the question form is to build |
| `submit_story` | The checker's verdict with paths | The story model's checks (#99) now; the full checker is to build |

**Why `suggest_routes`.** "Most plausible" has a method behind it: a route follows the planning order, stays inside what the client said could move, balances without counting money twice, changes as little as it can, and differs from the other routes. Code can test all of that. So code proposes candidates that already pass those tests, and the AI chooses among them, adjusts them through `price_route`, or composes its own. The AI stays free to choose (the routes are suggestions, never a menu), but it starts from routes that are already sound. It also makes the first draft reliable before the AI's own judgement has been tuned against the golden plans.

### 3.4 The skills

The method lives in written instructions the analyst loads, in this repository under `docs/analyst/skills/`, in Planeir's own words. They contain no course notes, solutions or case figures; those stay in `private/cfp-cases/` as golden plans for testing.

| Skill | What it teaches |
|---|---|
| `method.md` | The order of the story (the nine sections), the planning order behind every route, and the five parts of every section in education-only form: what the route does, why, what it gives, what it costs, what to check |
| `routes.md` | What makes a route plausible, how to compose one from the primitives, at most three beside the current position, and how routes should differ |
| `whatifs.md` | When each what-if is relevant, the facts that make it so, and the floor (income stops for every earner, death for a couple or a household with dependants) |
| `wording.md` | The voice ("you", names, no gendered pronouns), the banned words, the protection wording rule, how to say a result could not be shown, and placeholders only for figures |
| `missing-facts.md` | When a missing fact blocks a result, how to ask once, and how to write a limitation after the follow-up |

### 3.5 The loop

The analyst works through stages, like a task list. Each stage has an exit condition, and the run log records it.

1. **Understand.** `read_position`, `read_figures`. Exit: the position, the issues and every goal are known.
2. **Check for gaps.** `missing_facts`. If a missing fact blocks a result the story needs and this is the first round, stop here and return the questions.
3. **Choose routes.** `suggest_routes`, then `price_route` and `balancing_moves` until up to three routes balance and differ. Exit: each route has a reason tied to the method and to facts.
4. **Stress them.** `run_whatif` for the floor and for anything the household's facts make relevant. Exit: the floor is met, and each route's main change has a risk.
5. **Write.** The story for each route, section by section, in the five parts, placeholders only.
6. **Check.** `submit_story`, then fix and resubmit within the budget. Exit: the checker passes, or the budget is spent and the run is marked for Gerry with the refusals listed.

**Budget:** up to three routes, eight what-ifs a route and sixty engine runs a plan, as B1.5 sets them, tuned once real runs exist.

### 3.6 Review and release

Passing the checker never releases a result. Gerry sees the story on the story screen, the checker's report, the run log and the versions, and either releases it, sends it back with a note (a new run), or closes it.

### 3.7 Delivery

A released analysis is saved, encrypted, to the person's private page. It opens on the story, and its links open the real modules on the route's case, read-only. The person is emailed, and the page offers the walkthrough booking that already exists. The module screens become viewable by the person only inside a released analysis; they stay adviser-only everywhere else.

## 4. Two harnesses, one tool layer

The tools are written once, in `js/planning/analyst/`, as pure executors over a case file.

- **Local first: Claude Code on Gerry's Mac.** A small local tool server (`npm run analyst:mcp`, using the Model Context Protocol) gives Claude Code the tools with their schemas, and `npm run analyst -- <tool>` does the same from the command line for tests. Claude Code reads the skills, works in the case file folder, and runs the loop. No API spend, and every run is visible as it happens. Two admin endpoints connect it to the website: one exports a confirmed revision to the Mac, and one imports a checked analysis for release.
- **The website later.** A tracked job in the worker runs the same loop through a model provider's tool calls, dispatching to the same executors, inside the consumer cost budget, and holds every result for Gerry's release. The worker already calls OpenAI's Responses API (`worker/src/consumer/ai_provider.js`); the tool layer is provider-neutral, so which provider the job uses is a decision for then (section 7).

The same call, facts and versions give the same result in either harness and in any order (B1.5's A, B, A test).

## 5. Where things stand, 27 October 2026

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
| Story facts, issue list, checker | Specified (B1.5 sections 1 to 3); not built |
| Alternatives for profile-built plans; protection with the Illness Benefit default | Not built (#102 is current position only) |
| Tool layer, case file, local harness, `suggest_routes` | Not built |
| Skills | Not written |
| What-if catalogue beyond protection, retirement-years run | Specified (B1.5 section 6); not built |
| Export, import, release, delivery, read-only modules | Not built |
| New form questions | Specified; not built |
| Website job | Not built |

A trial merge of main with #99, #100 and #102 passes `check:dated-cost-contract`, `check:plan-pack-fixtures`, `check:plan-resource-ledger`, `check:form-to-profile`, `check:form-to-plan` and `check:plan-story`.

## 6. The order of work

Three drafts, each a working whole. Each line names the chat it belongs to; lines in the same chat run one after another, and different chats run together.

### Draft 1: the analyst works end to end on made-up households, locally

A made-up household's confirmed form becomes a checked story with up to three routes, written by Claude Code through the tools, and opened in the story screen with working links.

1. **Story facts and the issue list** as code (B1.5 sections 1 and 2). Plan chat.
2. **The checker** (B1.5 section 3's floor, wording rules, and the linked-figure match). Plan chat, after 1.
3. **Alternatives for profile-built plans**, then **protection with the Illness Benefit default** (B2 step 3; the protection playbook stops stating rates in its own prompt-pack change). B2 chat, two pull requests.
4. **The tool layer and the local harness**: the case file, the fact registry, the executors for the tools in 3.3 wired to what exists, `suggest_routes`, the local tool server and the command line. Each tool picks up 1, 2 and 3 as they land. Analyst chat (new).
5. **The skills** in `docs/analyst/skills/`. Written in this planning conversation, from the course method in Planeir's own words.
6. **The story screen reads a compiled plan** instead of samples, from 1's facts and sources. Story chat, after 1.
7. **First runs**: Claude Code with the skills and tools on the five made-up households from #97, read on the story screen, the skills tuned. Gerry, with this conversation.

### Draft 2: real people, Gerry releases every analysis

8. **New form questions**: how far each goal could move, existing cover amounts, care for a parent, the investment-risk question; and single or widowed for people with no partner. B2 chat.
9. **Export, import and release**: the two admin endpoints, the review view, saving a released analysis to the private page with the story and read-only modules, the email, and the booking link. Delivery chat (new).
10. **The golden plans** from the course cases in `private/cfp-cases/`, and a private check that the analyst's stories for them follow the method. Gerry's Mac.
11. **Before the first real person:** a view on the education-only line from whoever advises Gerry, the privacy notice covering AI processing, and the form switched on. Gerry.
12. **A whole-journey test** with made-up households: confirmation, follow-up and rerun, review, release, route switching and links.

### Draft 3: the website runs the analyst

13. **The full what-if catalogue and the retirement-years run** (B1.5 sections 6b to 6d), and B1.6's later-life stories. Plan chat.
14. **The website job**: a tracked run per confirmed revision, the provider's tool calls dispatched to the same executors, the budget, recovery, and every result held for release. Delivery chat.

### Alongside, in the care chat

After #101: the care producer for the dated-cost contract (#100), then the screen once Gerry chooses structure A or B, then the playbook. Care joins the analyst as a dated cost and as the `care` what-if when the full catalogue lands.

## 7. Decisions for Gerry

1. **`suggest_routes`.** Recommended: yes, as described in 3.3. Without it, the first drafts depend on the AI composing every route from scratch.
2. **The local harness.** Recommended: the local tool server plus the command line, so Claude Code calls the tools directly with their schemas.
3. **The website job's model provider.** Not needed until Draft 3. The tool layer works with either.
4. **What-ifs in Draft 1.** Recommended: income stops for every earner and death before retirement for a couple or a household with dependants, which is the method's floor; interest rates rising where the ledger already supports it. The rest arrive with Draft 3.
