# Local analyst tools

Start with [Running a local analyst test](../../../docs/analyst/running-a-test.md).
It includes fixture creation, Claude Code registration, the opening prompt and
`analyst:open` for the compiled-plan story screen.

```sh
npm run analyst -- list-fixtures
npm run analyst -- new-case --fixture fictional-trade-down
npm run --silent analyst -- read_position --case <directory> --input <file.json>
npm run --silent analyst:mcp -- --case <directory>
npm run --silent analyst:open -- <directory>
```

`init --input <confirmed-export.json>` still accepts a saved confirmed form:
`requestId`, `runId`, matching `revision` and `confirmedRevision`, `confirmedAt`,
`information` and `clientLabel`. Optional fields are `calculationDate`, `notes`
(evidence only) and `previousRun: {runId, confirmedRevision}`. A new confirmation
starts a new run; older calculations are never spliced into it.

## Facts and story keys

`read_position({routeId?, keys?})` defaults to current and also reads retained
priced routes. Its default facts contain only key, display, unit, status and
basis kind, with no `current.*` aliases. Asking for up to twenty keys returns
those facts' full source and basis. `storyFacts` lists canonical screen keys;
`storyRequirements` supplies the checker's section floor and limitation IDs.
The full native facts, issues, goal walk, steps and provenance remain in the
case, and the screen shows their bases on hover.

Submission resolves through `storyFactRegistry`, just as the screen does.
Older metric aliases such as `ledger.cashRemaining` and
`personal_balance_sheet.netWorth` are refused. Use the returned screen keys,
for example `position.spareCash` and `position.netWorth`. Missing facts are
never rendered as amounts; use a returned `.notApplicable` key when available.
`figure.<id>` uses the same effective-date lookup as the screen, and
`{?explainer.<id>}` uses the code-owned explainer catalogue.

`submit_story({story})` runs the full `checkStory` contract, including the
section floor, ordered goals, limitations, wording and native linked figures.
It checks all selected stories against the same compilation. Only a passing
draft becomes active; refusals and full reports remain in the run log and
`checkerReports`. `analyst:open` requires a matching passing report and checks
again before preparing `session.json`. Passing never releases a result.

## Pricing and exploration

The `price_route` schema is generated from the lever catalogue, including
one-off/recurring pension contributions and all property levers. Full-B1
`profileToPlanPack(..., {routes})` selects the supported chapters and retains
refusals, with `settingSourceChecks` from the native source validator.

`goal_ways({goalId, route?, routeId?})` calls `goalWays`. `suggest_routes({})`
calls `suggestRoutes`, returning up to five independent native walks.
`balancing_moves({route?, routeId?})` calls `balancingMoves` for ordinary goal
moves and lever sizes; an explicit `type: tradeDownHome` or `sellProperty`
uses `sizeMajorMove`, with optional `year` and the recorded `propertyId` for a
sale. Omitted drafts start with dear loans and cards cleared from spare cash,
dearest rate first, unless the reserve, an otherwise on-time goal or recorded
early-repayment terms prevent it. Mortgages stay with their own goal ways.
Retained routes report omitted clearances as notes and required inefficiency
facts. A `routeId` refers to a saved draft.
Each candidate has a reusable `candidateId` and a priced wire route with its
own ID. Select it with `price_route({candidateId})` or its unchanged wire route;
the stored compilation is reused. Changed settings or IDs require fresh pricing.
Exploration results retain every full compilation in the case. Explicit major
sizing also retains its sized route for `read_position`.

Replies contain compact goals and shortfalls, annual remaining money, changes
and sources, major sizes/bounds, refusals and story keys. They never expose a
compilation or plan pack. Both harnesses use the same projection; MCP sends the
JSON once as text, with no structuredContent. The fixture checks enforce a
60 KB limit per reply. Pricing calls can take up to a minute.

`read_figures` returns a hundred-entry index page with `nextOffset`; ask for up
to ten `ids` for full detail. `read_explainers({ids?, figureIds?})` returns the
code-owned wording unchanged. `missing_facts` returns form questions and
implementation gaps. `run_whatif` still returns `not built yet`; the story must
report that limitation in risks, alongside the checker's code limitations.

## Private state and budget

Runs live only under git-ignored `private/analyses/<requestId>/<runId>/` with
private file permissions, immutable hashed inputs/rule versions, drafts, facts,
checker reports, budgets and every dispatched call/result. File locking and
atomic saves span CLI and MCP callers. An existing run cannot be overwritten;
version drift requires a fresh run. After a crash, check that no caller is
running before removing a stale `.lock` or `case.json.next` file.

The limits are three alternatives in the story, eight what-ifs per route and
thirty pricing tool calls per plan. Each call permits at most eighty compiler
runs, with a separate fifteen-hundred-run guard for the plan. Case creation
counts its bridge preflights and initial compilation against the plan guard.
After creation, every actual `compilePlanPack` invocation is charged through a
call-local `beforeCompile` callback, including profile-bridge preflights and
nested part c/major-search compiles. The callback stays outside wire packs,
results and files, and refuses before exceeding either compiler guard. Selecting
a cached candidate uses a pricing call but no compiler runs. Read-only tools
and schema validation consume no pricing calls. Valid pricing attempts that
return refusals still count, including the unavailable what-if tool. Budgets survive retries,
process restarts and caller changes. Tests use only invented households.
