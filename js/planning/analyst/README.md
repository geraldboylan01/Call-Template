# Local analyst tools

Create a case from an exported **confirmed payload**, using `revision`,
`confirmedRevision`, `confirmedAt`, `information`, `requestId`, `runId` and
`clientLabel`. The revision numbers must match. `calculationDate`, `notes`
(evidence only) and `previousRun: {runId, confirmedRevision}` (a reference to a
stopped run on an earlier confirmed revision) are optional.
Never use the website's latest editable payload as a confirmed export.

```sh
npm run --silent analyst -- init --input /private/path/confirmed-export.json
npm run --silent analyst -- read_position --case private/analyses/request/run --input /private/path/empty.json
npm run --silent analyst:mcp -- --case private/analyses/request/run
```

`empty.json` contains `{}`. Other inputs follow the JSON Schemas in
`contracts.js`, exposed unchanged by MCP `tools/list`. `price_route` accepts
`{"route":{"id":"example","changes":[]},"reason":"Words explaining the route"}`.
The compiler validates every lever, reference and bound. It can refuse a
profile-built alternative when the confirmed form lacks funding facts; the
tool preserves that refusal instead of filling gaps. Use the `--silent` npm
flag when stdout must contain only JSON/MCP frames.

`submit_story` accepts `{story: {routeId, headline, summary, sections}}`.
Sections follow B1.5 section 3 in order, with `id`, `title` and `parts` containing
`does`, `why`, `gives`, `costs`, `check`. The goals section also contains
`goals: [{goalId, title, parts}]`. Narration uses only the case's returned fact
keys; module links require a registered source. The verdict covers shape and
the existing story model's wording/placeholder checks. The full completeness,
protection and module-link equality checker is pending. Passing never releases.

`goal_ways`, `suggest_routes`, `balancing_moves` and `run_whatif` return
`not built yet`. Follow-up PRs can replace their executors as the route and plan
work merges. No skills, screens or website job are connected here.

Each run is saved in `private/analyses/<requestId>/<runId>/case.json` with private
file permissions, immutable hashed inputs and rule versions, facts, drafts,
checker reports and every dispatched call/result. The store rejects version
drift and refuses to overwrite an existing run. A new confirmation starts a new
case; no previous calculations are imported. The file lock spans CLI and MCP
processes so concurrent calls cannot lose budget or log updates. A crashed
process may leave `.lock` or `case.json.next`; after checking that no caller is
running, retain the last complete `case.json` and remove those transient files.

The central limits are three alternatives in the story, eight what-ifs per
route and sixty engine runs. A compiler pricing pass counts once, including a
refused pricing attempt; creating the current position uses the first run.
Schema validation and unavailable tools do not run engines. The dispatcher
charges before each compiler call, even when the compiler refuses its inputs.
Future `goal_ways` calls consume a run, and what-if calls consume both counters.
Read calls and story revisions consume neither. Counters persist across callers
and restarts. All case files stay git-ignored; checks use only #97's invented
households and remove their temporary cases.
