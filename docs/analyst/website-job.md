# Private website analyst

The adviser opens `/app/analyst.html`, signs in through the existing adviser
authentication, and starts a new run. The shipped `ANALYST_ENABLED` flag is
false. `ANALYST_CONFIRMED_APPLICATIONS_ENABLED` is separately false. There is no
consumer endpoint, release action, delivery or email in this feature.

## Execution and recovery

`AnalystWorkflow` uses Cloudflare Workflows. Each model turn and each individual
tool call has its own named `step.do`. Workflows supplies durable scheduling,
saved results and retries across the ten-to-thirty-minute job; an HTTP
`waitUntil` or a home-grown Durable Object alarm loop would require implementing
that scheduling and checkpoint machinery again.

Each completed step writes an encrypted immutable R2 checkpoint and returns
only its opaque key. Workflow parameters contain only request/run IDs. On a
retry, the callback first checks its checkpoint, so losing an acknowledgement
after a successful save cannot execute a tool twice. A failed callback starts
with the previous completed case. Failed runs expose Resume; restarting the
Workflow reuses the R2 checkpoints even if Workflows resets its own step cache.

Model responses have separate encrypted receipts. A receipt saved before a
crash can be settled and reused. If a provider call might have been sent but no
receipt survived, the job stops with `provider_outcome_unknown` and retains its
full reservation. It never silently repeats a potentially charged request.
Create a fresh run after reviewing that outcome. Storage failures are retried;
ordinary executor errors and refusals are returned to the model as tool results.

The job stops on the first accepted `submit_story`, a euro or shared engine
budget, an incomplete/model-stopped response, the sixty-turn guard, disabling
the flag, or a terminal failure. The saved outcome says which happened. A
checker pass leaves `reviewStatus: pending` and never releases the analysis.

## Shared inputs and tools

The three reviewed fictional household builders now live in
`js/planning/analyst/fixtures/`. The old script paths re-export them. Both
`analyst new-case` and the website use `createFixtureCase`, including the same
invented confirmation date/revision and supplemental review facts. Each click
creates a new run ID. Original missing-fact fixtures remain local test cases.

The second flag lists saved confirmed revisions in `demo_requests`, the
revisioned case-application intake. The job copies only
`confirmed_payload_encrypted`, never the current editable payload. The selected
revision is checked when the run starts, then pinned into its case. Historical
video applications without a revisioned confirmed snapshot are not eligible.

Every call uses `executeTool` and the exact CLI/MCP `toolReply` projection.
Nothing truncates or rewrites a tool reply. Native executors own validation,
source checks, refusals, version pinning, thirty pricing calls, eighty compiler
runs per call and fifteen hundred per case. The ten function definitions come
directly from `TOOL_CATALOGUE`, with `strict: false` to preserve its `oneOf`,
optional properties and positional section schemas.

Ajv standalone validators are generated from that same catalogue at build
time. Both harnesses import those validators. Workerd therefore needs no
runtime `eval` or `new Function`. `build-analyst-validators.mjs --check` detects
catalogue drift. The generated validator is code, not household data.

## Model, instructions and data

The analyst-only allowlist contains `gpt-6.1-sol`. Consumer model allowlists are
unchanged. Calls go through `consumer/ai_provider.js` using the existing
server-side `OPENAI_API_KEY`, the Responses API, standard service tier and
reasoning effort `high`. `ANALYST_REASONING_EFFORT=xhigh` selects the other
allowed effort.

The existing site's `store: false` policy is preserved. Requests include
`reasoning.encrypted_content`; the encrypted reasoning items and tool outputs
are carried in the next turn's input and saved inside the encrypted R2 state.
No `previous_response_id` or provider-side retained conversation is needed.
Only the ten function tools are offered. Household free text, notes, errors and
tool results are explicitly data, never instructions.

`npm ci`/`npm run build` and Wrangler's custom build generate the instructions
from `docs/analyst/skills/README.md`, then method, routes, whatifs, missing-facts
and wording, followed by the website opening prompt in `running-a-test.md`.
The generated instruction bundle is ignored by Git. The run saves its initial
instruction bundle, so a deploy changes new runs rather than splicing new
instructions into an existing run.

Private R2 stores cases, transcript, receipts, run logs and checker reports at
`analyst/<requestId>/<runId>/...`. The existing demo/session AES-GCM encryption
and key rotation use `DEMO_DATA_ENCRYPTION_KEY`, its key ID and previous-key
map. Chunk AAD binds the request/run/checkpoint and chunk ID. Large cases are
split before encryption; no plaintext object is written. D1 `analyst_runs`
stores opaque identifiers, revision, timestamps, status and snapshot key.
`analyst_provider_costs` stores metering only. Local `.wrangler` state and
`private/analyses` are ignored by Git.
Unchanged cases reuse a content-addressed encrypted copy across model turns
and progress updates. Status reads load only the smaller progress snapshot;
tool calls and story opening load the complete case. Four independent chunks
are transferred at a time. The adapter also reads the first preview's complete
snapshots, preserving recovery across the storage optimization.

## Budgets and prices

Amounts use the existing integer micro-euro accounting helpers in
`consumer/cost_budget.js`. D1 insertion triggers atomically reserve against
both run and UTC-day totals, including concurrent runs. A read followed by a
separate write would race. Uncertain/reserved calls count at their full
reservation; settled calls count at their recorded token cost.

Before every model request, the runner rechecks current limits and reserves a
conservative maximum using UTF-8 request bytes plus framing as an input-token
ceiling, no cache hits, and the maximum output tokens. It includes long-context
surcharges. A cap refusal saves state before any provider request is made.
Lowered environment caps apply to an already-running job.

| Setting | Default | Hard maximum |
| --- | --- | --- |
| `ANALYST_RUN_BUDGET_EUR_CENTS` | 1500 (€15) | 3000 (€30) |
| `ANALYST_DAILY_BUDGET_EUR_CENTS` | 5000 (€50) | 10000 (€100) |
| `ANALYST_MAX_OUTPUT_TOKENS` | 24000 | 32000 |

The versioned default EUR ceilings per million tokens are €2.50 uncached
input (covering the published cache-write rate), €0.10 cached input and €10
output. Operators can set `ANALYST_INPUT_EUR_MICROS_PER_MILLION`,
`ANALYST_CACHED_INPUT_EUR_MICROS_PER_MILLION` and
`ANALYST_OUTPUT_EUR_MICROS_PER_MILLION` to reviewed euro rates. These are
configured cost estimates/ceilings, not a claim about the bank's eventual USD
exchange rate or tax. The ledger records input, cached input, output and
reasoning tokens and the euro estimate per turn. Reasoning is already part of
output tokens and is charged once. Malformed/missing usage retains the full
reservation and stops the run. Update the pricing version with price changes.

References checked 30 October 2026: [model rates and long-context rules](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[encrypted reasoning](https://developers.openai.com/api/docs/guides/reasoning),
[Workflow CPU limits](https://developers.cloudflare.com/workflows/reference/limits/).

## CPU and review

Wrangler sets `limits.cpu_ms=300000`. This requires Workers Paid; the Free
plan's ten-millisecond CPU allowance cannot run these engines. The setting is
an active CPU ceiling per invocation, not a ten-minute wall-clock timer. Each
step also has a ten-minute wall timeout and bounded retries. Engine
`console.info` diagnostics are silenced in the Workflow.
Each dispatch has a one-second durable sleep boundary so the engine can
hibernate between model/tool steps instead of accumulating an entire run's
CPU use in one invocation. The live preview exposed this distinction; a
300-second setting alone does not isolate consecutive heavy steps.
The Workflow has a 100,000-subrequest allowance for the chunked encrypted R2
checkpoints; the default 10,000 can be too small for a long case history.

The recorded replay measures each real executor with `process.cpuUsage` and
writes `.worker-dry-run/analyst-job/cpu.json`. On the local Mac, `suggest_routes`
used about 25,800ms CPU / 40 compiles, dated-cost `goal_ways` 5,900ms / 14
compiles, retirement `goal_ways` 2,100ms / 12 compiles, `balancing_moves`
12,000ms, cached `price_route` 79ms, and `submit_story` 218ms. The read tools and
unbuilt what-if refusal used roughly 11–164ms each. These are local CPU
measurements, not mislabeled Cloudflare wall time. Use Cloudflare's invocation
CPU metrics when calibrating deployment headroom; retain the 300-second cap
for the larger searches and their eighty-compile per-call guard.

The adviser page polls the saved progress: stage, active step, every model/tool
status, refusal paths, per-call pricing/compile usage, tokens and cost. It can
be closed while the Workflow continues. Accepted drafts open directly at
`/app/?analystRun=<runId>`, with the real story/modules controller and a checker
and run-log side panel. The session endpoint repeats the same exact-draft,
compilation-signature and passing-checker checks as `analyst:open`. The Publish
control is disabled for that review session.
Review sessions are kept in memory rather than overwriting the adviser's
current local workspace; the saved run link reopens the encrypted server copy.

## Validation and isolated preview

`npm run check:analyst-job` replays `analyst-job-replay.json` through the real
orchestrator with a fake model, actual encrypted storage and SQLite metering.
It injects failures before execution, after checkpoint/before acknowledgement,
and during usage settlement after a model receipt is saved. Encrypted attempt
and outcome events have an independent append-only history, so restarting a
Workflow preserves previous failures in the review timeline. Platform failures
and terminations are reconciled even when the runner's catch cannot execute.
The replay checks no completed model/tool call repeats, verifies exact CLI case parity,
opens the accepted session, checks encryption/tamper detection, tests caps and
uncertain reservations, and checks adviser/flag gates. It makes no API calls.
The check runs first in `check:consumer`.

An isolated preview uses `src/analyst/preview.js`, a separate D1 database and the
private preview R2 bucket. `prepare-analyst-preview.mjs <previewDatabaseId>
<previewOrigin>` prepares adviser-only static assets and an ignored Wrangler
configuration after `npm run build`. The wrapper supplies the existing API
origin check for browser-verified same-origin GETs; mutations retain real
Origin and CSRF checks. Credentials stay in Worker secrets, never config or
assets. The production feature flags stay off.
