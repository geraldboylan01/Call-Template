# Planéir Consumer Journey Operations

This runbook covers the separately feature-flagged consumer planning journey at
`/plan/` and `/api/consumer/*`. It does not change the adviser workspace,
adviser authentication, published-session capabilities, or existing lead
capture routes.

## Safety and data boundary

- Consumer profiles, conversations, analyses, consent receipts, invite
  redemptions, and rate-limit counters belong in the separate `CONSUMER_DB` D1
  binding. They must not be added to the existing adviser database.
- After an explicitly consented handoff, the existing `LEADS_DB` receives a
  separate lead containing only the name, email, optional phone number, and
  requested-help text shown in the handoff form, plus a minimal delivery and
  consent receipt created through adviser migration `0014`. It never receives
  the consumer profile or calculation results. The encrypted delivery bridge
  remains in `CONSUMER_DB` only for its approved package-retention window.
- The browser receives an opaque `X-Consumer-Session` credential and keeps it
  in `sessionStorage` only. It is never put in a cookie, `localStorage`, an
  analytics event, or a handoff package. D1 stores only its hash.
- Consumer payloads are application-encrypted before persistence. A separate
  keyed hash pseudonymises rate-limit subjects before they reach D1.
- A model may propose allowlisted profile patches. Deterministic code validates
  and applies them; models do not calculate financial outputs, decide consent,
  or write trusted state directly.
- The journey is educational, for adults aged 18 or over, and is not advice,
  approval, eligibility confirmation, or a product recommendation.

## Required Worker configuration

Keep secrets in the uncommitted `worker/.dev.vars` for local development and in
Cloudflare Worker secrets for deployed environments. Never add a real secret,
database ID, or consumer payload to source control or browser code.

### Secrets

| Name | Purpose | Required when |
|---|---|---|
| `CONSUMER_DATA_ENCRYPTION_KEY` | 32-byte base64url AES-GCM root key | Journey enabled |
| `CONSUMER_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON` | JSON map of up to three prior key IDs to keys | A bounded rotation window is active |
| `CONSUMER_INVITE_SIGNING_KEY` | 32-byte base64url HMAC key for signed `ci1` invites | Public access is disabled |
| `CONSUMER_RATE_LIMIT_HASH_KEY` | Separate 32-byte base64url HMAC key for rate-limit subject hashes | Journey enabled |
| `OPENAI_API_KEY` | Server-side Responses API key | AI intake enabled |

Do not reuse the encryption, invite-signing, and rate-limit keys for one
another. A missing or invalid required key keeps the affected capability fail
closed.

### Capability and policy variables

Every production capability flag ships as `false`:

| Name | Initial value | Purpose |
|---|---|---|
| `CONSUMER_JOURNEY_ENABLED` | `false` | Master processing kill switch |
| `CONSUMER_AI_INTAKE_ENABLED` | `false` | Natural-language structured extraction |
| `CONSUMER_MODULE_ROUTING_ENABLED` | `false` | Goal-to-module routing |
| `CONSUMER_HANDOFF_ENABLED` | `false` | Consented adviser handoff |
| `CONSUMER_PUBLIC_ACCESS_ENABLED` | `false` | Session creation without a signed invite |

Policy-controlled values must be supplied from approved, published text. Blank
values are intentional and must not be replaced with guessed identifiers,
durations, or URLs:

| Name | Initial value | Purpose |
|---|---|---|
| `CONSUMER_CONSENT_POLICY_VERSION` | `consumer-v1` | Version attached to consent receipts; review before enablement |
| `CONSUMER_CONSENT_MANIFEST_ID` | empty | Immutable approved manifest binding the policy version, analysis notice, AI notice, and privacy URL shown together |
| `CONSUMER_ANALYSIS_NOTICE_ID` | empty | Exact analysis notice accepted at session creation |
| `CONSUMER_AI_NOTICE_ID` | empty | Exact optional AI-processing notice accepted at session creation |
| `CONSUMER_PRIVACY_NOTICE_URL` | empty | Published HTTPS privacy notice |
| `CONSUMER_AI_DATA_POLICY_ID` | empty | Approved provider/data-processing policy identifier |
| `CONSUMER_HANDOFF_POLICY_VERSION` | empty | Exact handoff consent version |
| `CONSUMER_HANDOFF_POLICY_URL` | empty | Published HTTPS policy covering the encrypted bridge and separate adviser-record retention |
| `CONSUMER_HANDOFF_RETENTION_POLICY_ID` | empty | Approved handoff-retention policy identifier |
| `CONSUMER_HANDOFF_RETENTION_DAYS` | empty | Approved encrypted-package retention, 1-365 days |

The runtime treats a missing notice, HTTPS privacy URL, AI policy, handoff
policy URL/version, or retention configuration as an unavailable capability. A
feature flag alone must never bypass those checks.

### Operational limits and model routing

| Name | Initial value | Purpose |
|---|---|---|
| `CONSUMER_DATA_ENCRYPTION_KEY_ID` | `consumer-v1` | Current encryption-envelope key ID |
| `CONSUMER_REKEY_BATCH_SIZE` | `25` | Maximum encrypted records re-keyed by each scheduled batch, bounded to 1-100 |
| `CONSUMER_INVITE_MAX_TTL_HOURS` | `168` | Maximum accepted signed-invite lifetime |
| `CONSUMER_ALLOWED_MODULE_IDS` | `house_purchase,liquidity_analysis` | Consumer module allowlist |
| `CONSUMER_COHORT` | `internal` | Rollout cohort label, not access control |
| `CONSUMER_SESSION_TTL_DAYS` | `30` | Candidate non-handoff session lifetime; policy review required |
| `CONSUMER_MAX_MESSAGE_LENGTH` | `4000` | Intake message ceiling |
| `CONSUMER_MAX_TURNS_PER_SESSION` | `80` | Session turn ceiling |
| `CONSUMER_AI_DEFAULT_MODEL` | `gpt-5.6-luna` | Ordinary extraction tier |
| `CONSUMER_AI_COMPLEX_MODEL` | `gpt-5.6-terra` | Ambiguous-turn escalation tier |
| `CONSUMER_AI_DEFAULT_REASONING_EFFORT` | `low` | Ordinary extraction effort |
| `CONSUMER_AI_COMPLEX_REASONING_EFFORT` | `medium` | Escalated extraction effort |
| `CONSUMER_AI_PROMPT_VERSION` | `consumer-intake-v1` | Auditable prompt version |
| `CONSUMER_AI_TIMEOUT_MS` | `15000` | Upstream timeout |
| `CONSUMER_AI_MAX_OUTPUT_TOKENS` | `1200` | Per-call output ceiling |
| `CONSUMER_AI_REQUEST_TOKEN_RESERVATION` | `8000` | Atomic reservation before an AI request |
| `CONSUMER_AI_SESSION_REQUEST_BUDGET` | `24` | All-tier request cap per session |
| `CONSUMER_AI_DAILY_REQUEST_BUDGET` | `1000` | All-tier daily request cap |
| `CONSUMER_AI_COMPLEX_SESSION_REQUEST_BUDGET` | `4` | Complex-tier request cap per session |
| `CONSUMER_AI_COMPLEX_DAILY_REQUEST_BUDGET` | `100` | Complex-tier daily request cap |
| `CONSUMER_AI_SESSION_TOKEN_BUDGET` | `25000` | Token cap per session |
| `CONSUMER_AI_DAILY_TOKEN_BUDGET` | `250000` | Daily token cap |
| `CONSUMER_BOOKING_URL` | empty | Optional HTTPS booking seam |

The numeric values above are conservative operational starting points, not
privacy, legal, or financial-policy decisions. Review observed latency, quality,
and cost before changing them.

## Provision the separate consumer D1 database

Provision once per Cloudflare environment from `worker/`:

```bash
npx wrangler d1 create planeir-consumer
```

Do not invent or commit a database ID. Before consumer activation, store the ID
returned by Cloudflare as the `CONSUMER_DB_ID` variable on the protected GitHub
`production` environment. Optionally set `CONSUMER_DB_NAME`; it defaults to
`planeir-consumer`. The base `worker/wrangler.toml` intentionally contains only
a commented binding template. While the value is absent and every consumer flag
is false, the deployment workflow preserves the existing Worker deployment with
no consumer binding or consumer migration. Once supplied, it validates the value
and appends an active `CONSUMER_DB` binding to a disposable deploy config.

The migration streams are deliberately separate:

- `worker/migrations/` applies to `LEADS_DB` and includes the minimal adviser
  delivery receipt in `0014_create_consumer_handoff_deliveries.sql`.
- `worker/consumer-migrations/` applies only to `CONSUMER_DB` and contains all
  consumer journey records.

Never point both bindings at the same database. Never run consumer migrations
against `LEADS_DB`.

## Local setup

1. Install dependencies and generate independent keys from the repository root:

   ```bash
   npm ci
   npm run generate:consumer-key
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

   The consumer-key generator prints the encryption-key assignment. Use the key
   printed by the final command only for `CONSUMER_RATE_LIMIT_HASH_KEY`. Copy the
   required entries from `worker/.dev.vars.example` into the existing uncommitted
   `worker/.dev.vars`, preserving current Zoom, Resend, and adviser secrets.

2. Create a same-directory, uncommitted Wrangler config for local testing:

   ```bash
   cd worker
   cp wrangler.toml wrangler.consumer.local.generated.toml
   ```

   Append the active binding below, replacing the marker with the actual ID
   returned when the consumer database was provisioned:

   ```toml
   [[d1_databases]]
   binding = "CONSUMER_DB"
   database_name = "planeir-consumer"
   database_id = "<actual Cloudflare consumer database ID>"
   migrations_dir = "consumer-migrations"
   ```

   Never commit this generated file. Delete it after the local run.

3. Replay both migration streams against fresh local D1 state:

   ```bash
   rm -rf ../.worker-dry-run/local-d1
   npx wrangler d1 migrations apply LEADS_DB --local --config wrangler.consumer.local.generated.toml --persist-to ../.worker-dry-run/local-d1
   npx wrangler d1 migrations apply CONSUMER_DB --local --config wrangler.consumer.local.generated.toml --persist-to ../.worker-dry-run/local-d1
   ```

4. Generate a short-lived private invite. The first run may generate a signing
   key, but only when no signing key is deployed yet:

   ```bash
   cd ..
   npm run generate:consumer-invite -- --cohort internal --ttl-hours 24 --max-uses 1 --plan-url http://127.0.0.1:5500/plan/
   ```

   Put the generated `CONSUMER_INVITE_SIGNING_KEY` in `.dev.vars`. Every later
   invite must be generated with that same key in the command's environment.
   Running the generator without a key after deployment creates a different key
   and therefore an unusable invite.

5. Start the Worker with the generated config and serve the static site:

   ```bash
   cd worker
   npx wrangler dev --config wrangler.consumer.local.generated.toml --persist-to ../.worker-dry-run/local-d1
   ```

   In a second terminal:

   ```bash
   python3 -m http.server 5500 --bind 127.0.0.1
   ```

   Start with all five capability flags false. Supply approved local notice IDs
   and an HTTPS privacy URL before deliberately enabling the master flag.

## Signed private invites

An invite has the form `ci1.<payload>.<signature>` and is authenticated with
HMAC-SHA-256. Its signed claims include audience, unique `jti`, cohort, issued
time, expiry, and maximum uses. The Worker validates the signature and lifetime,
then atomically counts redemption by a hash of `jti`; the raw invite is not
persisted.

The generated link puts the invite in the URL fragment. The plan page removes
that fragment immediately and keeps the token in the current tab's
`sessionStorage`. Anyone holding an unexpired link can redeem it up to its signed
maximum, so share it through an approved private channel.

For an established environment, load the existing key from the approved
operator secret manager without echoing it, then run:

```bash
CONSUMER_INVITE_SIGNING_KEY="$CONSUMER_INVITE_SIGNING_KEY" npm run generate:consumer-invite -- --cohort internal --ttl-hours 24 --max-uses 1
```

Rotate the signing key as a controlled access change: outstanding invites signed
with the old key stop working immediately.

## Production secret setup

Set secrets interactively; do not paste them into `wrangler.toml` or GitHub
variables:

```bash
cd worker
npx wrangler secret put CONSUMER_DATA_ENCRYPTION_KEY
npx wrangler secret put CONSUMER_RATE_LIMIT_HASH_KEY
npx wrangler secret put CONSUMER_INVITE_SIGNING_KEY
```

Add `OPENAI_API_KEY` only after the AI notice and data-processing policy are
approved and configured:

```bash
npx wrangler secret put OPENAI_API_KEY
```

Adding a database, secrets, or policy values does not enable a capability. The
five source-controlled flags remain the release controls.

## API model policy and intelligence level

The API uses the least intelligence needed for bounded fact extraction:

1. Deterministic rules run first and remain the fallback.
2. Ordinary free-text extraction uses the default model with low reasoning.
3. Code escalates only materially ambiguous turns to the complex model with
   medium reasoning and separate complex-tier request caps.
4. OpenAI receives only the latest message, current deterministic question, a
   bounded rolling summary, and the profile slice relevant to that stage. The
   Responses API uses strict JSON Schema output, `store: false`, an abort
   timeout, output ceilings, and atomic request/token reservations. Provider
   retention and abuse monitoring must match the approved account data policy.
5. Model output is an untrusted proposal. Paths, operations, values, types, and
   provenance are validated before state changes.
6. Calculations, readiness gates, warnings, consent, module allowlists, and
   journey transitions remain deterministic.

If the provider times out, refuses a request, returns invalid structured output,
or any budget is exhausted, processing continues in clearly labelled rules-only
mode. Do not silently invent a fact or substitute a model-generated calculation.

## Safe rollout order

Use this order independently in each environment:

1. Provision `CONSUMER_DB`, configure its protected deployment variable, and
   deploy with every capability flag false.
2. Let CI replay both migration streams locally, then apply adviser migrations
   and consumer migrations remotely. Verify existing adviser routes.
3. Configure independent encryption, rate-limit, and invite keys. Publish and
   approve the privacy, analysis, and optional AI notices, assign one immutable
   consent-manifest ID to that exact set, then set all identifiers and the HTTPS URL.
4. Enable only the master journey for the `internal` cohort. Keep public access,
   AI, module routing, and handoff false. Test create, resume, correction,
   consent withdrawal, expiry, and deletion in rules-only mode.
5. Enable module routing only for the explicit initial allowlist.
6. Configure the approved AI data-policy ID and OpenAI secret; then enable AI
   for the internal cohort. Review schema failures, fallback rate, escalation,
   latency, and both ordinary and complex budget counters.
7. Publish the approved handoff policy, then configure its exact HTTPS URL,
   version, bridge-retention policy ID, and bridge-retention days. Enable
   handoff only after that policy also defines separate adviser-lead retention
   and pipeline visibility, minimal sharing, revocation, purge, deletion, and
   retry behaviour are verified.
8. Consider public access or a wider cohort only as a separate reviewed release.

`CONSUMER_PUBLIC_ACCESS_ENABLED=false` is a second audience gate: creating a
session requires a valid, unexpired, signed invite. The cohort label is
observability metadata, not an access control.

Pension, net retirement cash-flow, mortgage, and college adapters may report
readiness but remain outside the initial allowlist. Personal Balance Sheet, CAT,
business relief, and agricultural relief stay adviser-only until their
deterministic engines and dated rules are complete.

## API surface

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/consumer/bootstrap` | Public flags, approved notices, limits, modules, and optional booking URL |
| `POST` | `/api/consumer/sessions` | Create an adult, consented consumer session |
| `GET` | `/api/consumer/sessions/:id` | Resume the owning session |
| `POST` | `/api/consumer/sessions/:id/turns` | Process an idempotent guided turn |
| `PATCH` | `/api/consumer/sessions/:id/profile` | Apply and optionally confirm reviewed patches |
| `POST` | `/api/consumer/sessions/:id/confirm` | Confirm the current profile revision |
| `POST` | `/api/consumer/sessions/:id/analyses` | Run an allowlisted deterministic analysis |
| `PATCH` | `/api/consumer/sessions/:id/consent` | Withdraw optional AI processing for the session |
| `POST` | `/api/consumer/sessions/:id/handoffs` | Create a separately consented minimal adviser handoff |
| `DELETE` | `/api/consumer/sessions/:id` | Delete consumer session data |

Session routes require the owning `X-Consumer-Session: <id>.<secret>` credential
and return `Cache-Control: no-store`. Turn requests require a unique idempotency
key so retries do not double-charge or duplicate state. Authenticated deletion
and AI-consent withdrawal remain available when the processing kill switch is
off, preserving a narrow data-rights plane during an incident.

## Retention, deletion, and logging

- The hourly Worker cleanup expires non-handoff sessions in `CONSUMER_DB`
  without changing the existing adviser cleanup schedule.
- A user-requested delete removes conversation turns, profile revisions,
  analyses, module runs, AI attempts, consent events, events, and the credential
  record. Pseudonymous anti-abuse counters and invite-redemption receipts follow
  their separately bounded cleanup windows; review those windows as part of the
  privacy schedule.
- A handoff creates a separately consented adviser lead containing the exact
  contact fields and requested-help text disclosed in the form. Its encrypted
  bridge package is purged from `CONSUMER_DB` after the exact configured
  retention period. `LEADS_DB` keeps the lead plus minimal delivery/consent
  metadata under the separately published adviser-record policy; it never gets
  the consumer profile or calculation output.
- A linked/delivered consumer handoff row is retained only while its browser
  session remains live or while its encrypted bridge package is still inside
  the approved retention window. After session deletion/expiry and package
  purge, the scheduled job removes the consumer handoff and session tombstones;
  the separately governed adviser lead remains in `LEADS_DB`.
- A stale `linking` lease is reconciled against the idempotent `LEADS_DB`
  delivery receipt. Completion, failure, and cleanup updates are fenced to the
  exact claimed lease timestamp, so an older request cannot alter a renewed
  delivery. Confirmed delivery becomes `linked`; confirmed non-delivery becomes
  retryable before expiry. An expired package is purged once its lease is stale,
  while a fresh in-flight delivery is allowed to finish.
- Telemetry uses allowlisted metadata only. Never log messages, profiles,
  contacts, secrets, credentials, invite tokens, decrypted results, model input,
  or model output.
- Any change to notice text, purpose, shared fields, or duration requires a new
  version/identifier and a review of existing consent and deletion handling.

There is intentionally no default production handoff-retention period in source.
Legal/privacy owners must publish the handoff policy and provide its URL,
identifier, and duration before the capability can become available.

## Encryption-key rotation

The encrypted envelope includes a key identifier, and the hourly Worker job can
re-key every encrypted consumer column without exposing plaintext or record
identifiers. Each batch writes aggregate progress to `consumer_rekey_runs`;
those non-personal audit rows are removed after 180 days.

Use this procedure:

1. Set `CONSUMER_JOURNEY_ENABLED=false` and deploy so the data-rights plane
   remains available while new writes pause.
2. Generate a new 32-byte key. Keep the outgoing key under its old ID in
   `CONSUMER_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON`, set the new key as
   `CONSUMER_DATA_ENCRYPTION_KEY`, and assign a new
   `CONSUMER_DATA_ENCRYPTION_KEY_ID`. Never change key material under an
   existing ID; retain at most three previous keys.
3. Deploy. Each cron invocation scans and conditionally re-encrypts up to
   `CONSUMER_REKEY_BATCH_SIZE` profile, summary, turn, analysis, module, and
   handoff envelopes. Logs and `consumer_rekey_runs` contain only key ID and
   aggregate counts: `scanned`, `rotated`, `failed`, and `remaining`.
4. In staging, invoke the scheduled handler with
   `curl /cdn-cgi/handler/scheduled`. In production, monitor the durable ledger
   until at least two consecutive runs show `failed = 0` and `remaining = 0`.
   Investigate any malformed or unreadable envelope before removing a prior key.
5. Complete a create/read/update/delete canary with the new write key. Remove
   only the fully drained old key from the previous-key map, deploy again, and
   repeat the read/delete canary before re-enabling the journey.

Do not print keys, ciphertext, record IDs, or decrypted data during inventory or
rotation. If the secret and key ID cannot change atomically, keep the master
journey disabled through the entire change.

## Static security-header activation gate

The source page includes a restrictive meta CSP for local development. The
production build removes localhost API origins, but `frame-ancestors` is not
enforced from a meta tag. Before enabling the journey, the edge serving
`/plan/*` must add response headers equivalent to:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://call-canvas-session-worker.geraldboylan.workers.dev; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

Configure these at the Cloudflare zone/edge (or move `/plan/*` to a host that
supports response headers) without changing headers for existing adviser pages.
Verify both `/plan/` and `/plan/privacy.html` with `curl -sSI`. Keep
`CONSUMER_JOURNEY_ENABLED=false` if any header is absent or if production HTML
contains a localhost connection source. Voice requires a separately reviewed
Permissions Policy change later.

## Verification and deployment gate

Run from the repository root:

```bash
npm run check:consumer
npm run check:house-purchase
npm run check:module-media
npm run check:video-summary
npm run check:video-scene
npm run check:codex-video-brief
npm run check:success-animation
npm run build
git diff --check
```

The pull-request regression workflow also replays every adviser migration into
one fresh local SQLite database and every consumer migration into a different
fresh database, then checks integrity and foreign keys. It bundles the Worker
without deploying.

The production deployment job is attached to the protected GitHub `production`
environment. Before any remote write it:

1. validates Cloudflare configuration and any supplied consumer database binding;
2. asserts all five consumer capability flags are exactly `false` in source;
3. runs the full regression and build gate;
4. creates a disposable same-directory Wrangler config, adding the protected
   real `CONSUMER_DB_ID` only when it has been provisioned;
5. always replays adviser migrations and, when bound, consumer migrations into
   separate fresh local D1 state; and
6. dry-run bundles the Worker.

Only then does it apply `LEADS_DB` migrations, conditionally apply `CONSUMER_DB`
migrations when that binding exists, deploy, and run the existing live
published-session smoke check. Do not run that production smoke flow during
consumer development because it creates and revokes real remote sessions.

Browser release QA must cover desktop and mobile; keyboard-only navigation;
44-pixel touch targets; notice, adult, and consent gates; interrupted/resumed
sessions; corrections and focus retention after rerender; assumptions and
uncertainty copy; rules-only fallback; AI withdrawal; deletion; handoff
disabled/enabled states; and a regression pass through `/app/`.

## Rollback and incident response

For an intake, provider, or privacy incident:

1. Set `CONSUMER_JOURNEY_ENABLED=false` and deploy that configuration.
2. If only the provider path is affected, set
   `CONSUMER_AI_INTAKE_ENABLED=false`; keep rules-only mode available only after
   review.
3. If handoff is affected, set `CONSUMER_HANDOFF_ENABLED=false` independently.
4. Keep authenticated deletion and AI withdrawal reachable. Preserve only the
   encrypted records and allowlisted audit metadata required for incident
   review; never print decrypted values.
5. Revoke or rotate affected secrets and follow the versioned rotation process.
6. Use a reviewed, additive compensating migration if remediation is needed. Do
   not edit or drop existing adviser, lead, client, or published-session tables.

Disabling the consumer journey does not alter `/app/`, `/api/advisor/*`, public
lead capture, scheduling, publishing, or client-viewer routes.
