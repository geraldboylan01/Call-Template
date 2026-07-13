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

These committed values are an immutable dormant baseline for the current
release workflow. Do not change them in `worker/wrangler.toml`. The protected
production environment may generate one narrowly defined ephemeral override:
the adviser-test, signed-invite, rules-only mode documented below. That mode can
turn on only the master journey and deterministic module routing. AI, handoff,
and public access remain forced off.

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

## Protected adviser-test activation

The reviewed workflow contains the explicit source constant
`CONSUMER_ADVISER_TEST_BETA_SOURCE_APPROVED=true`. A protected GitHub
environment variable named `CONSUMER_ADVISER_TEST_BETA_OVERRIDE` may be absent,
`true`, or `false`. An absent or `true` override follows the source approval;
`false` is the emergency rollback. A protected override can never turn on a
source-unapproved mode, and any other value fails deployment.

Source approval builds a disposable Wrangler configuration with this fixed
mode and approved policy set:

- `CONSUMER_JOURNEY_ENABLED=true`;
- `CONSUMER_MODULE_ROUTING_ENABLED=true`;
- `CONSUMER_COHORT=adviser_test`;
- `CONSUMER_INVITE_MAX_TTL_HOURS=24`;
- `CONSUMER_AI_INTAKE_ENABLED=false`;
- `CONSUMER_HANDOFF_ENABLED=false`;
- `CONSUMER_PUBLIC_ACCESS_ENABLED=false`; and
- `CONSUMER_ALLOWED_MODULE_IDS=house_purchase,liquidity_analysis`.

| Source-approved value | Fixed deployment value |
|---|---|
| `CONSUMER_DB_NAME` | `planeir-consumer` |
| `CONSUMER_BETA_CONSENT_POLICY_VERSION` | `consumer-adviser-test-v1` |
| `CONSUMER_BETA_CONSENT_MANIFEST_ID` | `consumer-adviser-test-manifest-v1` |
| `CONSUMER_BETA_ANALYSIS_NOTICE_ID` | `analysis-adviser-test-v1` |
| `CONSUMER_BETA_AI_NOTICE_ID` | `ai-adviser-test-v1` |
| `CONSUMER_BETA_PRIVACY_NOTICE_URL` | `https://planeir.ie/plan/privacy.html` |
| `CONSUMER_BETA_SESSION_TTL_DAYS` | `7` |

There are no protected switches for AI, handoff, public access, the cohort,
policy values, TTL, or module allowlist. Adding or changing one is a separate
reviewed release. An `OPENAI_API_KEY`, if already present for another purpose,
cannot make this mode use AI.

The deployment resolves the D1 inventory by the exact name
`planeir-consumer`. It fails on duplicates. If none exists while the effective
mode is enabled, it creates exactly that database with Cloudflare's immutable
EU jurisdiction restriction, re-reads the inventory, validates the UUID, and
exports it only to the current job environment. It never commits the ID and
never substitutes `LEADS_DB`. An existing exact-name database is accepted for
activation only when Cloudflare reports its immutable jurisdiction as `eu`.
An existing database without that restriction fails closed; Cloudflare does not
permit adding or changing jurisdiction after creation.

The Worker secret inventory is then checked for the exact names
`CONSUMER_DATA_ENCRYPTION_KEY`, `CONSUMER_RATE_LIMIT_HASH_KEY`, and
`CONSUMER_INVITE_SIGNING_KEY`. Each missing name receives a newly generated
independent 32-byte base64url value through `wrangler secret put`. Existing
names are never written, so a normal deployment cannot rotate an established
key. Values are never printed or added to a file.

The workflow next resolves the active `planeir.ie` zone in the configured
Cloudflare account and upserts one response-header transform rule with stable
reference `planeir_consumer_plan_security_headers_v1`. It updates only that
rule or appends it to the phase ruleset; unrelated rules are not replaced. The
live header verifier then checks `/plan/` and `/plan/privacy.html` before any
D1 migration or Worker deployment.

The existing `CLOUDFLARE_API_TOKEN` must therefore cover the configured account
and have Workers/D1 access plus Zone Read and Zone Transform Rules Write
permission for `planeir.ie`. Missing permission fails closed before consumer
activation. The protected `ADVISOR_SMOKE_PASSWORD` secret must match the live
adviser login; an effective beta fails before provisioning if that secret is
absent, and fails its post-deploy authenticated bridge check if it is stale.

Activation procedure:

1. Confirm the source approval constant and fixed values above remain exact.
2. Run the local regression, dual-D1 lifecycle, and browser acceptance gates.
3. Confirm the adviser-authenticated invite issuer is available. A successful
   adviser login may issue a short-lived link, but `/plan/` still creates no
   session without the signed invite.
4. Push the reviewed source or manually dispatch `Deploy Worker`. CI resolves
   or provisions only the missing infrastructure described above, validates the
   generated config, replays migrations locally, and dry-run bundles before
   applying remote migrations or deploying.
5. After deployment, CI verifies the live bootstrap is exactly adviser-test,
   invite-required, and rules-only. It then authenticates as the configured
   adviser smoke account, issues a one-use private link, consumes it to create
   one synthetic rules-only consumer session, and requires deletion of that
   session before running the existing adviser/published-session smoke. Invite,
   cookie, CSRF, and session credentials are never printed.

To stop processing, set the protected
`CONSUMER_ADVISER_TEST_BETA_OVERRIDE=false` and manually dispatch the workflow.
The next deployment restores the committed dormant flags. Existing D1 and
secrets are retained; rollback never deletes or rotates them.

## Provision the separate consumer D1 database

Production CI owns idempotent provisioning. It lists D1 databases, accepts only
one exact `planeir-consumer` match, requires its jurisdiction to be `eu` before
activation, and creates that name only when the source-approved beta is
effective and no match exists. The resulting UUID is
kept only in the job environment and appended to the disposable Wrangler
config. It is not a GitHub variable and is never committed.

For a manual non-production environment, provision from `worker/`:

```bash
npx wrangler d1 create planeir-consumer --jurisdiction eu
```

Do not substitute `--location weur`: a location hint optimizes latency but does
not restrict where the database can run or store data. D1 jurisdiction is
immutable, so it cannot be retrofitted to an existing database.

Do not invent, commit, or manually copy a production database ID into a
protected variable. The base `worker/wrangler.toml` intentionally contains only
a commented binding template.

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

On first source-approved deployment, CI creates only missing consumer secrets
with independent random 32-byte base64url values. It never writes an existing
secret name. For manual non-production setup or an explicitly controlled
rotation, use Wrangler interactively; never paste values into `wrangler.toml`
or GitHub variables:

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
five source-controlled flags remain the dormant baseline. Effective activation
requires the source approval constant and no protected `false` rollback
override.

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

1. Keep all source `wrangler.toml` capability flags false and validate the
   source-approved adviser-test constants.
2. Let CI resolve or create the exact isolated D1, replay both migration streams
   locally, and dry-run the Worker.
3. Let CI create only missing encryption, rate-limit, and invite keys, then
   upsert and verify the path-scoped edge header rule.
4. Test create, resume, correction, consent withdrawal, expiry, and deletion
   locally with the master journey enabled but AI, public access, and handoff
   disabled.
5. Use the protected activation procedure to enable the `adviser_test` cohort.
   The generated production config enables the master journey and routing
   together only for the fixed initial allowlist and signed-invite audience.
6. Treat AI as a later, separate reviewed release. Configuring an OpenAI secret
   or data-policy ID does not enable it in the current production workflow.
7. Treat handoff as a later, separate reviewed release. Its published policy
   must define adviser-lead retention and pipeline visibility, minimal sharing,
   revocation, purge, deletion, and retry behaviour before the workflow is
   expanded to permit it.
8. Consider public access, a wider cohort, or another module only as a separate
   reviewed release; the current deployment generator has no switch for them.

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
| `POST` | `/api/advisor/consumer-invite` | Issue an adviser-authenticated, one-use private test invitation |
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

`POST /api/advisor/consumer-invite` requires the authenticated adviser cookie
and matching `X-Advisor-CSRF` header. It is limited to 12 attempts per hour per
client IP and returns `Cache-Control: no-store`. Each signed invitation expires
within four hours and can create one consumer session only. The issuer fails
closed unless production is exactly the `adviser_test`, invite-only,
rules-only mode with the fixed two-module allowlist.

Success returns `{ "ok": true, "url": "https://planeir.ie/plan/#invite=…",
"expiresAt": "…", "maxUses": 1, "mode": "rules_only" }`. Expected failures
are `401` for no adviser session, `403` for a missing or stale CSRF token, `429`
for the rate limit, and a deliberately generic `503` when any protected-beta
invariant or signing dependency is unavailable. Never log or paste the returned
URL because its fragment is a bearer invitation until redeemed or expired.

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
Strict-Transport-Security: max-age=31556952
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
environment. Before any remote migration or Worker deployment it:

1. validates Cloudflare credentials, source approval, and the protected rollback
   override;
2. asserts all five consumer capability flags are exactly `false` in source;
3. runs the full regression, static build, and fresh dual-D1 HTTP lifecycle;
4. resolves the exact `planeir-consumer` D1 and creates it only if missing;
5. creates a disposable same-directory Wrangler config with either dormant
   flags or the fixed adviser-test rules-only overlay;
6. replays adviser and consumer migrations into separate fresh local D1 state
   and dry-run bundles the Worker;
7. creates only missing consumer Worker secrets, preserving every existing
   value; and
8. upserts only the stable path-scoped response-header rule and verifies the
   live static headers.

Only then does it apply `LEADS_DB` migrations, conditionally apply `CONSUMER_DB`
migrations when that binding exists, and deploy. It next asserts that the live
bootstrap is either fully dormant or exactly `adviser_test`, invite-required,
rules-only, and limited to House Purchase and Liquidity. In beta mode it also
runs the authenticated adviser-to-consumer bridge smoke and requires cleanup of
its synthetic consumer session. The existing live published-session smoke runs
last. Do not run those production smoke flows during consumer development
because they create and then delete or revoke real remote records.

Browser release QA must cover desktop and mobile; keyboard-only navigation;
44-pixel touch targets; notice, adult, and consent gates; interrupted/resumed
sessions; corrections and focus retention after rerender; assumptions and
uncertainty copy; rules-only fallback; AI withdrawal; deletion; handoff
disabled/enabled states; and a regression pass through `/app/`.

## Rollback and incident response

For an intake, provider, or privacy incident:

1. Set the protected `CONSUMER_ADVISER_TEST_BETA_OVERRIDE` environment variable
   to exactly `false` and manually dispatch the Worker deployment. Do not edit
   the committed false flags.
2. AI and handoff are already forced off in this beta. If a later release
   permits either one, use its independently reviewed kill switch as well.
3. Revoke outstanding signed invites if audience access is implicated.
4. Keep authenticated deletion and AI withdrawal reachable. Preserve only the
   encrypted records and allowlisted audit metadata required for incident
   review; never print decrypted values.
5. Revoke or rotate affected secrets and follow the versioned rotation process.
6. Use a reviewed, additive compensating migration if remediation is needed. Do
   not edit or drop existing adviser, lead, client, or published-session tables.

Disabling the consumer journey does not alter `/app/`, `/api/advisor/*`, public
lead capture, scheduling, publishing, or client-viewer routes.
