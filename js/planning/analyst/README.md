# Local analyst tools

Start with [Running a local analyst test](../../../docs/analyst/running-a-test.md).
It includes fixture creation, Claude Code registration, the opening prompt and
`analyst:open` for the compiled-plan story screen.

```sh
npm run analyst -- list-fixtures
npm run analyst -- new-case --fixture fictional-mortgage-college-family
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

`read_position({routeId?})` defaults to the pinned current position. It can also
read any retained successfully priced alternative. `facts`, `issues`,
`unavailableIssues`, `goalWalk`, `steps` and `freedCash` come from
`readPlanPosition` for that route. `storyFacts` comes from `compactStoryFacts`
in `js/plan_story_registry.js`: these are the only household placeholder keys a
story may use. `price_route` returns the same route's native facts and
`storyFacts`, with its ledger and setting-source checks.

Submission resolves through `storyFactRegistry`, just as the screen does.
Older metric aliases such as `ledger.cashRemaining` and
`personal_balance_sheet.netWorth` are refused. Use the returned screen keys,
for example `position.spareCash` and `position.netWorth`. Missing facts are
never rendered as amounts; use a returned `.notApplicable` key when available.
`figure.<id>` uses the same effective-date lookup as the screen, and
`{?explainer.<id>}` uses the code-owned explainer catalogue.

`submit_story({story})` checks the nine sections and five parts and runs the
existing model against these shared keys, including goal subsections and
explainers. It validates the proposed story together with previously accepted
stories on their shared compilation. Only accepted drafts become active in
`storyDrafts`; refused drafts remain in the call log. `analyst:open` uses the
same compilation selection and writes `session.json` next to `case.json`.
The full method-floor and linked-value checker is still pending; passing the
available checks never releases or publishes a result.

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
sale. Omitted drafts start an empty walk. A `routeId` refers to a saved draft.
Choose an exploration's returned wire changes, assign the selected route its
own ID, then retain it through `price_route`. Exploration never silently picks
one of several choices sharing a draft ID. Explicit major sizing retains its
sized draft and compilation for `read_position`.

`read_figures` includes explainer IDs; `read_explainers({ids?, figureIds?})`
returns `getExplainers` unchanged. `missing_facts` returns form questions and
implementation gaps. `run_whatif` retains its explicit `not built yet` refusal.

## Private state and budget

Runs live only under git-ignored `private/analyses/<requestId>/<runId>/` with
private file permissions, immutable hashed inputs/rule versions, drafts, facts,
checker reports, budgets and every dispatched call/result. File locking and
atomic saves span CLI and MCP callers. An existing run cannot be overwritten;
version drift requires a fresh run. After a crash, check that no caller is
running before removing a stale `.lock` or `case.json.next` file.

The limits are three alternatives in the story, eight what-ifs per route and
sixty compiler runs. Case creation counts its bridge preflights and the initial
current-position compilation.
After creation, every actual `compilePlanPack` invocation is charged through a
call-local `beforeCompile` callback, including profile-bridge preflights and
nested part c/major-search compiles. The callback stays outside wire packs,
results and files, and refuses before a sixty-first compile. Cached compilation
reads and schema/source validation consume no runs. Budgets survive retries,
process restarts and caller changes. Tests use only invented households.
