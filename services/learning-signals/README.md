# Planeir learning signals

This directory contains Planeir's privacy-first, service-to-service
learning-signal layer. It is deliberately isolated from the existing Cloudflare
Worker and its D1 databases: telemetry uses PostgreSQL 16 only. M1 established
the tenant-carrying pilot schema; M2 added authenticated batch ingestion and the
transactional delivery outbox; M3 added pseudonymised extraction corrections and
the versioned field policy; M4 enforces consent, retention, and erasure; M5
added module-version publishing, version pinning, and per-version performance;
M6 added the daily metric views, runner, and alerts; M7 added the hardened
observability integrations (PostHog/Langfuse/OTel) behind masking and allowlist
boundaries with a blocking negative-privacy suite; M8 adds the v2 event-type
catalog, the demo seed that drives the real pipeline, and this documentation.

## Run everything in five commands

From the repository root, against a clean checkout:

```sh
docker compose up -d        # 1. PostgreSQL 16
make db-reset               # 2. recreate the volume and apply every migration
make test                   # 3. full suite against real Postgres (the gate)
make lint                   # 4. tsc --noEmit
make seed                   # 5. load the demo fixture through the real routes
```

`make db-reset` already runs `db-up` + `db-migrate`; run `make db-migrate`
on its own to apply new migrations without dropping data. The milestone gate
is `docker compose up -d && make db-reset && make db-migrate && make test`.

## Stack decision

Before this scaffold was written, the following established Planeir files were
inspected: `package.json`, `package-lock.json`, the root `README.md`, `.gitignore`,
`.github/workflows/consumer-regression.yml`, `worker/wrangler.toml`,
`worker/wrangler.consumer-test.toml`, `worker/src/index.js`,
`worker/src/consumer/router.js`, `worker/src/consumer/config.js`,
`worker/src/consumer/validators.js`, `worker/src/consumer/repository.js`,
`worker/consumer-migrations/0001_create_consumer_journey.sql`,
`scripts/check-consumer-worker.mjs`, and `scripts/check-consumer-http.mjs`.

Planeir currently uses Node 22 ES modules, a framework-free Cloudflare Worker,
handwritten validation, raw D1 SQL migrations, and `node:assert` scripts. Because
the repository has no existing framework, ORM, schema library, or test runner,
this isolated service uses the brief's complete approved Node stack: Node 22,
TypeScript, Fastify, Drizzle ORM with drizzle-kit migrations, Zod, and Vitest.

## Local gate

From the repository root:

```sh
docker compose up -d
make db-migrate
make test
make lint
```

`make test` connects to PostgreSQL and fails unless it is PostgreSQL 16 and the
Drizzle migration ledger exists. It has no SQLite or in-memory fallback. Copy
`.env.example` to `.env` only when local overrides are needed; never commit real
credentials.

## Data boundaries

Three stores with different owners, contents, and lifetimes. The learning-signal
ledger is the middle box; it never holds conversational content, and nothing
leaves it to a partner without passing the export gate.

```
  ┌──────────────────────────────┐        ┌────────────────────────────────────┐
  │  OPERATIONAL TENANT STORE     │        │  LEARNING-SIGNAL LEDGER (this svc)  │
  │  (firm-owned, out of scope)   │        │  PostgreSQL 16, tenant-scoped       │
  │                               │  minimised, keyed,                          │
  │  • transcripts, audio         │  hashed, banded  │  • session_events         │
  │  • raw answers & field values │ ───────────────► │    (append-only ledger)   │
  │  • FCA suitability evidence   │  (never raw text)│  • field_extractions      │
  │  • client identity            │                  │    (hashes + previews)    │
  │                               │                  │  • adviser_corrections    │
  │  Governed by the firm's own   │                  │  • provider_usage, consent│
  │  schedule and legal holds.    │                  │  • metric_* snapshots      │
  └──────────────────────────────┘                  └───────────┬────────────────┘
                                                                 │
                       consent gate + persist-first outbox       │  export gate:
                                                                 │  k>=30 users,
                          ┌──────────────────────────────────────┤  >=3 tenants,
                          │                │                      │  <=80% dominance
                          ▼                ▼                      ▼
                 ┌──────────────┐  ┌──────────────┐   ┌─────────────────────────┐
                 │  PostHog     │  │  Langfuse    │   │  PARTNER EXPORT         │
                 │  (anonymous, │  │  (metadata-  │   │  (threshold-gated       │
                 │   allowlist) │  │   only, mask)│   │   aggregates; SQL only) │
                 └──────────────┘  └──────────────┘   └─────────────────────────┘
                 OTel spans: ids/counts/durations only, allowlisted attributes.
```

- **Operational tenant store** (out of scope): the firm's own system of record for
  transcripts, audio, raw answers, client identity, and FCA suitability evidence.
  This service never receives raw content — only minimised, hashed, banded
  signals derived from it.
- **Learning-signal ledger** (this service): tenant-scoped PostgreSQL. Every read
  is scoped to the credential's tenant; a foreign UUID returns 404. `session_events`
  is append-only.
- **Third-party lenses** (PostHog, Langfuse, OTel): disposable analysis surfaces
  fed asynchronously from the outbox, behind consent gating and export allowlists.
  Anything needed long-term lives in the ledger, the source of truth.
- **Export gate** (partner reporting): aggregates only, suppressed unless k ≥ 30
  users, ≥ 3 tenants, and ≤ 80% single-tenant dominance. Schema + threshold SQL
  only; no delivery mechanism in the pilot.

## Consent gating matrix

Current consent per `(tenant, session, purpose)` is the latest ledger decision
by `decision_ts` (server `received_at` breaks ties). `consentGate` is the single
decision function, applied before persistence and again before each async
delivery. Persist decides whether the minimised row enters the ledger; forward
decides PostHog/OTel delivery; partner decides eligibility for aggregated export.

| Event class (catalog `consent_class`) | Persist to ledger | Forward to PostHog/OTel | Partner-export eligible |
| --- | --- | --- | --- |
| `contract_necessity` (session/question/module/call/review/nudge) | Always | Requires `service_improvement_telemetry` | No |
| `improvement_signal` (question.completed, extraction.*, survey.response) | Always (legitimate interest) | Requires `service_improvement_telemetry` | Requires `partner_benchmarking` |
| `optional_demographics` (demographics.band.recorded) | Requires `optional_demographics` (fail closed) | With service consent | With `partner_benchmarking` |
| `marketing_referral` (marketing.referral.recorded) | Requires `marketing_referral` (fail closed) | Not forwarded to shared sinks | No |
| `consent_control` (consent.withdrawn) | Always | Never | No |

A current withdrawal flips forwarding off for the session, suppresses pending
outbox deliveries, excludes the subject from the next metrics run, and queues
deletion of purpose-dependent rows. The seed exercises a fully consented, a
declined, and a withdrawn session so all three paths are covered.

See below for the full details: [secret rotation](#tenant-key-provisioning-and-rotation),
the [FCA regulatory-record split](#regulatory-retention-boundary), and the
[environment contract](../../.env.example) (every variable documented; absent
optional vars install No-op sinks).

## Timestamp convention

`session_events.occurred_at` is a client timestamp. It is used only with
`turn_index` to order events inside a session and must not decide reporting or
retention windows. Daily metric windows use the server-set `received_at`.
Retention and purge jobs use the server-set `created_at`.

The `session_events` table is an append-only pilot ledger. PostgreSQL rejects
updates and truncation and rejects ordinary deletes. Retention, consent
withdrawal, and erasure use a narrowly authorised transaction path; the database
trigger writes an audit row for every event removed, while the owning job writes
its aggregate completion audit. Month-range partitioning by `received_at` is the
documented scale path, but is intentionally not enabled at pilot volume.

## M2 ingestion contract

`POST /v1/telemetry/events` requires an active API key with the `ingest` scope
and accepts 1–500 event envelopes. Tenant identity is always derived from the
key. A legacy `tenant_id` is accepted only when it exactly matches that identity;
otherwise the whole request is rejected with 403 before any write.

The versioned event allowlist and per-event JSON Schemas live in
`config/telemetry-events.v1.json` through
`config/telemetry-events.v3.json`. Startup loads every retained
`telemetry-events.vN.json` file into a version registry; ingestion uses the
latest revision while pending outbox rows retain the exact revision that
validated them. The schemas allow only primitive bounded numbers, booleans, and
enumerated categories. Unknown event types and attributes, nested values,
strings over 256 characters, client-supplied `late`, and attributes over 4 KiB
are rejected per item. No transcript, raw answer, or raw field value has a
schema representation.

Structurally valid batches return HTTP 207 with an ordered result for every
item: `inserted`, `duplicate`, `conflict`, or `invalid`. The canonical payload
hash excludes the server-owned `late` flag, so an identical replay cannot become
a conflict merely because it later crosses the 48-hour threshold.

A newly inserted event and its reference-only `telemetry_outbox` row commit in
one PostgreSQL transaction. The request path never calls PostHog or OpenTelemetry.
The background worker projects only catalog-allowlisted properties, tracks sink
delivery independently, and retries failures with capped exponential backoff
measured from the end of each delivery attempt. Absent optional credentials
install no-op sinks and perform no network calls. PostHog and OpenTelemetry are
the only M2 outbox destinations. Langfuse, KMS, and DLP already have explicit
interfaces plus No-op and Recording fakes, but remain dormant in M2 rather than
being called from the request path or outbox worker.

An API key with the `admin` scope can scrape `GET /internal/metrics`. The
Prometheus-format conflict counter is process-local and tenant-scoped from that
key, so one tenant cannot observe another tenant's replay conflicts.

## M3 corrections and field policy

`POST /v1/adviser-corrections` requires an active API key with the
`corrections` scope and a nonblank authenticated `actor_label`. Tenant and actor
identity are derived only from that key. The request accepts a tenant-scoped
session and extraction UUID, a required opaque UUID idempotency key, scalar `before_raw` and
`after_raw` values, an optional closed reason code, and an optional note. A
body-supplied reviewer role or any unknown property is rejected. A foreign
tenant's extraction is indistinguishable from a nonexistent extraction and
returns 404.

The startup-validated `config/field_policy.yaml` is the sole allowlist for field
classification and previews. It permits only the closed preview formats
`age_band`, `currency_band`, `enum`, and `none`. Previews are fixed bands or
allowlisted categories, never substrings; raw operational storage defaults to
false. Unknown fields fail closed. Every persisted preview also has a
PostgreSQL length check of at most 64 characters.

Correction values are normalized in memory and then HMAC-SHA-256 hashed with the
current tenant key. Rows contain only hashes, fixed-band previews where policy
permits them, value classes, policy/key versions, and authenticated actor
pseudonyms. The original extraction hash remains unchanged; only its status is
set to `corrected`. The correction row, status change,
`extraction.corrected` append-only ledger event, and reference-only outbox row
commit in one transaction. An identical idempotent replay returns the original
correction; a changed payload returns 409. Replays use the row's historical key
version, so rotation does not create false conflicts.

M0-M2 exposed no supported correction or extraction write endpoint. The upgrade
migration therefore labels any manually inserted pre-M3 rows
`legacy-pre-policy`, removes the database policy-version defaults, and requires
every M3+ writer to state the version it actually applied. A legacy correction
has no canonical raw request envelope from which the M3 keyed idempotency
fingerprint could be reproduced, so its old key is not replay-compatible; new
M3 corrections have the complete replay guarantee described above.

Adviser `note` text is always locally redacted and then discarded in the pilot.
It is not persisted, logged, placed in the outbox, or sent to DLP or another
third party. The shipped policy keeps DLP note forwarding disabled. Regex
redaction is defence in depth and is not treated as sufficient authority to
retain note content.

### Tenant key provisioning and rotation

The pilot `env` provider reads `TENANT_SECRETS_JSON`. Each tenant key must be
base64url-encoded CSPRNG output of at least 32 bytes (256 bits), and must be
created in a secret-management workflow rather than committed to a file or
source control. The KMS provider is deliberately fail-closed until its managed
implementation is supplied. An empty pilot keyring still allows the service and
all no-op third-party ports to boot without external credentials; correction
writes for an unprovisioned tenant return a generic unavailable response.

Rotate a tenant key as follows:

1. Generate a new independent CSPRNG key of at least 32 bytes in the approved
   secret manager.
2. Add it under the next integer entry in that tenant's `keys` map while
   retaining every historical entry still needed for replay verification.
3. Set `current_version` to the new entry and deploy the keyring atomically.
   New writes immediately record the new `key_version`.
4. Do not update or re-HMAC old rows. Linkage across key versions intentionally
   breaks; that is the privacy boundary, not a migration defect.
5. Remove an historical key only after the applicable retention window and
   idempotent-replay window have both expired. Until then, it is required to
   verify old replays without exposing raw values.

The JSON shape is:

```json
{
  "00000000-0000-4000-8000-000000000000": {
    "current_version": 2,
    "keys": {
      "1": "historical-base64url-secret",
      "2": "current-base64url-secret"
    }
  }
}
```

## M4 consent enforcement

The current consent state for each `(tenant, session, consent_type)` is the
latest ledger decision by `decision_ts`, with server-controlled `received_at`
as the tiebreaker. `consentGate` is the single decision function used before
persistence and again immediately before asynchronous delivery.

Contract-necessity events always enter the minimised ledger. Improvement-derived
signals also enter the ledger and remain eligible for legitimate-interests
quality metrics, but require accepted partner-benchmarking consent before cohort
use. Optional-demographic and marketing-referral signals fail closed before
persistence unless their exact purpose is accepted. PostHog and OTel delivery
requires accepted service-improvement consent. A withdrawal serializes with the
outbox on the session row, suppresses pending delivery, excludes the
pseudonymous subject from the next metrics run, and queues deletion of
purpose-dependent rows.

## M4 retention and erasure

The daily retention job reads the tenant's policy and uses only server-set
`created_at` timestamps. `pseudonymous_telemetry_days` governs learning-ledger
signals, `operational_payload_days` governs only operational rows held inside
this service, and `consent_ledger_days` is the separate legal-hold window.
Every tenant/table purge attempt records its cutoff and affected-row count.

`POST /v1/subjects/erasure-requests` requires an active `admin` key with an
authenticated actor label. The raw subject identifier exists only in request
memory. The service recomputes the subject HMAC under every retained tenant key
version, scrubs matching local rows in a transaction, records the audited local
completion, and queues pseudonymous deletion commands for the analytics and
trace sink interfaces. External deletion is asynchronous and retryable; no
third-party call occurs in the request path.

Tenant offboarding uses crypto-shredding: after all required operational
handoffs and retention obligations are satisfied, destroy every version of the
tenant secret in the authoritative secret manager. That makes any residual
pseudonymous identifiers unlinkable. Do not reuse, export, or escrow a destroyed
key.

### Regulatory retention boundary

This service is not the tenant's FCA suitability-evidence archive. Tenant-owned
transcripts, audio, raw answers, and other regulatory records belong in a
separate tenant-scoped operational store governed by the firm's own approved
schedule and legal holds. They are outside this purge job. The learning ledger
contains only minimised categorical, numeric, hashed, or fixed-band signals, and
its shorter retention policy must never be presented as deleting those separate
regulatory records.

## M5 module versioning and performance

`POST /v1/module-versions/publish` requires an active API key with the `admin`
scope. The body carries `module_id`, a strict `semantic_version`
(`MAJOR.MINOR.PATCH` with optional prerelease), and the firm-authored
`module_json`. The service canonicalizes `module_json` RFC 8785-style
(recursively key-sorted, whitespace-free) and stores
`content_hash = sha256(canonical)` beside the body. Publishing the same
`(module_id, semantic_version)` again with an identical hash replays with 200
and the original `module_version_id`; a different hash returns 409. Rows are
created directly in `published` status, and PostgreSQL triggers make published
and retired rows immutable against UPDATE, DELETE, and TRUNCATE, so a version
id can never change meaning after a session has pinned it. `module_json` is
module structure authored by the firm — never conversational content — and the
publish and performance routes never log request or response bodies.

### Version pinning

A session pins the version of each module at its first persisted
`module.enter` for that module: ingestion resolves the module's most recently
published version inside the insert transaction and stamps
`module_version_id` into the event's attributes. The attribute is declared
`server_owned` in `config/telemetry-events.v4.json`; a client that supplies it
is rejected per item. Re-entering the same module later in the session reuses
the existing stamp, so a publish mid-session never moves a session between
versions. `module.enter` for a module with no published version is rejected
per item. The v4 catalog introduces bounded identifier formats (`uuid`,
`id_slug`) for these structural references; both are anchored lowercase
charsets with no room for free text, and `question_id` is never forwarded to
third-party sinks.

### Performance metrics

`GET /v1/module-versions/:id/performance` requires the `admin` scope and is
tenant-scoped: a foreign or unknown id returns 404. All attribution is per
module segment — a `module.enter` event stamped with the requested version,
spanning until the session's next `module.enter` of any module (or the end of
the session). `fact_find_sessions.entry_module_version_id` is never consulted.
The 28-day window selects segments by the enter event's `occurred_at`;
corrections attributed through those segments count regardless of when the
adviser made them. Within a fixed window the metrics are:

- `sessions_entered`: distinct sessions with at least one qualifying segment.
- `completion_rate` / `abandonment_rate`: share of segments containing a
  `module.exit` for the same module with `outcome=completed`; every other
  segment (explicit abandon or missing exit) counts as abandoned. Rates are
  rounded to 4 decimal places, `0.0` when no segments exist.
- `median_module_duration_ms`: interpolated median (`percentile_cont`) of the
  first in-segment `module.exit` `duration_ms`, regardless of outcome;
  segments without an exit duration are excluded; `0` when none exist.
- `correction_rate_by_field`: extractions attribute to a segment through their
  `source_event_id`; per `field_key`, the share of attributed extractions with
  at least one value-changing correction (`before_hash <> after_hash`).
- `critical_correction_count`: value-changing corrections on attributed
  extractions whose `value_class` is `identifier` or `currency` — the classes
  where a wrong value corrupts identity or money facts.
- `booked_meeting_conversion`: share of `sessions_entered` with at least one
  `meeting.booked` event anywhere in the session.
- `top_abandonment_questions`: for each abandoned segment, the last
  `question.prompted` in the segment carrying a `question_id`; the top 5
  question ids by count, ties broken by `question_id` ascending.
- `calibration`: attributed extractions with a stored `confidence`, bucketed
  into deciles (`0.8-0.9`; `1.0` folds into `0.9-1.0`), with `approval_rate`
  the share never value-changed by a correction. Only non-empty buckets are
  returned, ascending.

## M6 daily metrics jobs

The pilot KPIs are computed by SQL views (migration `0009_m6_metric_snapshots`),
materialized daily into `metric_daily_snapshots` and evaluated against
`config/thresholds.yaml` into `metric_alerts` by a small runner. There is no
Airflow: an in-app scheduler (`startDailyMetrics`, mirroring the retention
scheduler) runs the previous complete UTC day hourly and idempotently, and
operators who prefer cron invoke `src/jobs/metrics-cli.ts` (`make metrics`,
optional `DATE=YYYY-MM-DD`) instead. Every view emits one uniform shape
(`tenant_id, metric_date, metric_name, dimension, numerator, denominator,
value, reviewed_denominator`), so the runner materializes any of them with a
single statement. The Postgres ledger is the single source of truth; snapshots
are derived and rebuildable, and re-running a date deletes and rebuilds only
that date's derived rows — the append-only event ledger is never touched.

Every metric excludes withdrawn subjects via `metrics_included_sessions` (the
same `subject_metric_exclusions` rule as the M4 daily job). Definitions are
pinned in the SQL comment above each view; the exact denominators are:

- **completion_rate** — sessions with a `session.completed` event ÷ sessions
  with `session.started`, by the start event's UTC `received_at` date.
- **dropoff_rate_by_module** (dimension = pinned M5 `module_version_id`) — a
  module segment (a `module.enter`) is a drop when it is the session's last
  entered segment and the session was abandoned (`session.completed` outcome
  `abandoned`/`failed`, or no `session.completed`); ÷ segments of that version
  entered. Attribution is by the version stamped on the enter event, never
  `fact_find_sessions.entry_module_version_id`.
- **median_question_time** — `percentile_cont(0.5)` over
  `question.completed.occurred_at − question.prompted.occurred_at`, paired on
  `(session_id, question_id, turn_index)`. Pairs < 0 or > 30 min are data
  errors, discarded from the median and reported separately as
  `question_time_discarded`.
- **correction_rate_by_field** (dimension = field key) — extractions with a
  value-changing correction (`before_hash <> after_hash`) ÷ proposed
  extractions **whose session has a completed review** (the "% reviewed"
  guard; `reviewed_denominator` restates it). Snapshotted at the session's
  `review.completed` date.
- **calibration_approval_rate** (dimension = confidence bucket) — fixed edges
  `[0,0.5,0.7,0.85,0.95,1.0]` (top bucket closed so 1.0 lands in `0.95-1.0`);
  approval = fraction not changed by review. Review-gated like corrections.

v2 KPI additions:

- **Reliability** — `connection_success_rate` (`call.connected` ÷ starts),
  `mid_call_drop_rate` (`call.hung_up` with `cause_class = 'technical'` ÷
  connected), `turn_latency_p95_ms` (p95 of `provider_usage.latency_ms`).
  Alerts: connection success < 98% or drop rate > 5% (both `critical`). Every
  `call.hung_up` and abandoned `session.completed` carries a technical vs
  non-technical cause so product KPIs can exclude infra-caused abandonment.
- **Adviser adoption** — `review_turnaround_median_ms` (completion →
  `review.completed`), `pct_reviewed_within_7d`, `pct_reviewed` (the guard
  headline), and `reviews_abandoned`. Correction and calibration KPIs always
  carry their reviewed denominator.
- **Unit economics** — `cost_per_completed_factfind`, `cost_per_booked_meeting`,
  and `tenant_daily_cost_micros` (sum over a month = cost per tenant-month),
  from `provider_usage.cost_micros` (the M1 column the spec calls
  `estimated_cost_minor`). Alert when `cost_per_completed_factfind` exceeds
  1.5× its trailing-28-day baseline, once the baseline has ≥ 3 days.
- **Reconciliation** — daily ledger vs PostHog-forwarded count. Over events the
  consent gate marked forwardable (a non-suppressed `telemetry_outbox` row),
  divergence = not-yet-delivered ÷ expected; alert above 2%. PostHog and
  Langfuse are disposable lenses (1-year / 30-day free-tier retention); any
  long-lived signal such as calibration history lives in the ledger.

Thresholds live in `config/thresholds.yaml`, loaded at runtime (never
hardcoded) and strictly validated; a run records the `thresholds_version` that
produced its alerts.

## M7 observability integrations

All third-party observability sits behind the M2 sink interfaces with No-op and
Recording fakes. The app boots and the whole suite passes with zero external
credentials (No-op sinks, zero network). Export allowlists live in
`config/observability.yaml`, loaded at runtime and strictly validated —
deny-by-default: only enumerated keys ever leave the service.

- **PostHog** (`buildPostHogCapture`): EU host default, server-side
  anonymous-only capture. Every event sets `$process_person_profile: false`;
  there is no identify/alias/group call and no autocapture/session-replay. The
  `distinct_id` is an opaque, deterministic per-session id (`analyticsSessionId`,
  a namespaced hash of the internal session_id) — never the
  `pseudonymous_subject_id` and never the raw session_id, which is stripped from
  the forwarded event entirely. Only allowlisted properties survive
  (event_type is the event name; module_version_id, question_id, duration_ms,
  status/categorical attrs, etc.).
- **Langfuse** (metadata-only): `maskLangfuseGeneration` is the registered mask
  — it keeps only the allowlisted metadata (model, provider, token counts,
  latency, cost_micros, request_id, session_id, tenant_id) and drops all
  `gen_ai.prompt.*`, `gen_ai.completion.*`, `input`, `output`, and any unknown
  key, so the raw fact-find conversation can never reach Langfuse. Provider
  usage forwards persist-first / async: an AFTER INSERT trigger enqueues a
  `provider_usage_outbox` row in the same transaction as the provider_usage
  insert, and `LangfuseForwardWorker` drains it, masking each row before export.
  Prefer Langfuse Cloud EU (Hobby) for the pilot; absent credentials keep the
  dormant no-op sink.
- **OTel**: per-event spans (`buildOtelSpanPayload`) carry `event_id`,
  `event_type`, and allowlisted attributes only. Operational spans for the
  ingestion, outbox-drain, retention-purge, and metrics jobs
  (`ObservabilitySpanSink`) carry only ids, counts, and durations — never a
  payload fragment.
- **Budget guardrails** (`BudgetGuardrail`): a per-tenant daily provider-spend
  counter (real cost, not consent-filtered) against a configurable cap
  (`tenant_provider_budgets.daily_cap_micros`, else the observability default).
  Crossing the cap records a `provider_budget_alerts` row; the pilot never
  hard-stops sessions. Runs from the metrics scheduler and `make metrics`.

`question_id` became a forwardable attribute in `telemetry-events.v6.json`
(reconciling M5's earlier stance) so PostHog/OTel can attribute question-level
funnels; it is still an opaque module-authored slug, never conversational
content.

### Negative privacy suite (blocking)

`test/negative-privacy-m7.test.ts` threads sentinel PII, a sentinel provider
key, and a sentinel API key through a full seeded scenario — categorical
ingestion, an adviser correction (raw values in before/after, provider key in
the note), and provider usage — then drains every forwarding path into
Recording fakes and runs the metrics/budget/purge jobs. It asserts no sentinel
appears in: any telemetry table (full database dump), any PostHog capture, any
OTel span, any Langfuse trace, any operational job span, or the captured
application logs on a forced error path. The suite fails the milestone if any
sentinel survives.

## M8 catalog v2 additions and the demo seed

`config/telemetry-events.v7.json` adds the v2 event types to the allowlist, each
with a closed attrs schema (categorical/numeric/id only, `late` reserved,
deny-by-default). The registry still loads every retained `vN` file; ingestion
uses v7 while pending outbox rows keep the revision that validated them.

- Adviser portal: `review.queue_viewed` (plus `review.started/completed/abandoned`
  from earlier milestones).
- Module authoring: `module.created`, `module.edited`, `module.test_run`,
  `module.published`, `module.rolled_back`.
- Reliability: `call.connect_failed`, `call.dropped` (plus `call.connected`,
  `call.hung_up`).
- Re-engagement: `nudge.sent`, `session.resumed`.
- Satisfaction: `survey.response` — an integer `score` 1–5 and a categorical
  `reason` only. There is no free-text survey field anywhere in the schema.

Module-authoring and adviser-portal events are tenant-level, not tied to a
client fact-find, but the ledger is session-keyed; the seed attaches them to a
dedicated per-tenant "operations" session, and that is the intended convention.

`make seed` (or `npm run seed`) loads the demo fixture by driving the real
routes — module versions through the publish route, every telemetry event
through `/v1/telemetry/events`, and every correction through
`/v1/adviser-corrections`. Only setup rows with no HTTP surface (tenant, one API
key per scope, sessions, granted/denied consent, proposed extractions) use SQL.
The fixture is: 1 tenant on the default retention policy; 2 modules × 2 published
versions; 6 sessions that together exercise **every** catalog event type
(including the derived `extraction.corrected`), every correction reason code and
both change kinds, a declined-consent session, and a withdrawn-consent session
whose withdrawal flows through ingestion. Because the seed uses the real
pipeline, running it validates ingestion, version pinning, consent gating, and
correction sanitisation. `test/seed-m8.test.ts` runs the seed and asserts full
event-type coverage and the privacy invariants (no raw value stored).

## Integration Phase 0: onboarding a firm and opening sessions

Two pieces make a real voice call able to feed the ledger.

**Provision a firm as a tenant** (`make provision SLUG=... NAME="..." MODULE="..."`,
or `npm run provision -- <slug> "<name>" ["<module title>"]`). This creates the
tenant, mints one API key per scope, generates the tenant's pseudonymisation
secret, and publishes an initial module version through the real publish route.
The key secrets and the `TENANT_SECRETS_JSON` entry are printed **once** — store
them in your secret manager and add the secret entry to the service environment
(both `/v1/sessions` and `/v1/adviser-corrections` pseudonymise with the managed
key, so a session open returns 503 until it is present).

**Open a session** before ingesting events. The ledger is append-only and the
session row is state, so the orchestrator calls this at the start of a fact-find:

```
POST /v1/sessions        Authorization: Bearer <ingest key>
{ "module_id": "<uuid>", "subject_ref": "<opaque, non-identifying ref>",
  "session_id": "<uuid, optional>" }
→ 201 { session_id, module_version_id, key_version, status: "started" }
```

`tenant_id` comes from the key (a mismatched body `tenant_id` is 403); a foreign
or unpublished `module_id` is 404 (no existence leak); the active published
version of the module is pinned as the session's entry version; and the call is
idempotent on `(tenant, session_id)` (a re-open returns the existing session with
`replayed: true`). `subject_ref` is an opaque reference the caller controls — a
stable client ref links a returning client across sessions, a per-session ref
maximises isolation. It is HMAC'd with the tenant key into
`pseudonymous_subject_id` and **never stored raw**. After the session is open,
the orchestrator ingests `session.started`, `question.*`, `session.completed`,
etc. through `/v1/telemetry/events` exactly as the seed does.

This closes the only gap that made real-call ingestion impossible: sessions no
longer require a raw SQL insert. The remaining integration work (Phase 1) is the
emit + minimisation layer inside the voice orchestrator, and is out of this
service.
