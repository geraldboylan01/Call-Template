# Planeir learning signals

This directory contains Planeir's privacy-first, service-to-service
learning-signal layer. It is deliberately isolated from the existing Cloudflare
Worker and its D1 databases: telemetry uses PostgreSQL 16 only. M1 established
the tenant-carrying pilot schema; M2 added authenticated batch ingestion and the
transactional delivery outbox; M3 added pseudonymised extraction corrections and
the versioned field policy; M4 enforces consent, retention, and erasure.

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
