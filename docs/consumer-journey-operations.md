# Planéir Consumer Journey Operations

This runbook covers the separately feature-flagged consumer planning journey at
`/plan/` and `/api/consumer/*`. It does not change the adviser workspace,
adviser authentication, published-session capabilities, or existing lead
capture routes.

The separate adviser-invite Realtime WebRTC canary is covered by
`docs/consumer-realtime-voice-operations.md`. Where that runbook is stricter
for continuous streaming, sideband tools, or realtime cost reconciliation, its
realtime-specific controls apply while the existing typed and bounded voice
contracts remain unchanged.

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
- In the bounded adviser-test voice flow, OpenAI processes a bounded microphone recording
  into a reviewable transcript and may synthesize only the exact deterministic
  Planéir question. Voice is a transport layer: it does not enable model-driven
  intake, select modules, calculate results, or advance journey state.
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
| `OPENAI_API_KEY` | Server-side OpenAI API key; never exposed to browser code | AI intake or voice enabled |

Do not reuse the encryption, invite-signing, and rate-limit keys for one
another. A missing or invalid required key keeps the affected capability fail
closed.

### Capability and policy variables

Every production capability flag ships as `false`:

| Name | Initial value | Purpose |
|---|---|---|
| `CONSUMER_JOURNEY_ENABLED` | `false` | Master processing kill switch |
| `CONSUMER_AI_INTAKE_ENABLED` | `false` | Natural-language structured extraction |
| `CONSUMER_VOICE_ENABLED` | `false` | Reviewed speech-to-text and exact-question speech transport |
| `CONSUMER_REALTIME_VOICE_ENABLED` | `false` | Continuous WebRTC voice with authoritative Durable Object sideband |
| `CONSUMER_MODULE_ROUTING_ENABLED` | `false` | Goal-to-module routing |
| `CONSUMER_HANDOFF_ENABLED` | `false` | Consented adviser handoff |
| `CONSUMER_PUBLIC_ACCESS_ENABLED` | `false` | Session creation without a signed invite |

These committed values are an immutable dormant baseline for the current
release workflow. Do not change them in `worker/wrangler.toml`. The protected
production environment may generate one narrowly defined ephemeral override:
the adviser-test, signed-invite, voice-assisted rules-only mode documented below.
That mode can turn on only the master journey, deterministic module routing, and
the reviewed voice transport. Model-driven AI intake, handoff, and public access
remain forced off.

Policy-controlled values must be supplied from approved, published text. Blank
values are intentional and must not be replaced with guessed identifiers,
durations, or URLs:

| Name | Initial value | Purpose |
|---|---|---|
| `CONSUMER_CONSENT_POLICY_VERSION` | `consumer-v1` | Version attached to consent receipts; review before enablement |
| `CONSUMER_CONSENT_MANIFEST_ID` | empty | Immutable approved manifest binding the policy version, analysis notice, AI notice, and privacy URL shown together |
| `CONSUMER_ANALYSIS_NOTICE_ID` | empty | Exact analysis notice accepted at session creation |
| `CONSUMER_AI_NOTICE_ID` | empty | Exact optional AI-processing notice accepted at session creation |
| `CONSUMER_VOICE_NOTICE_ID` | empty | Exact optional microphone, transcription, and AI-generated-voice notice |
| `CONSUMER_PRIVACY_NOTICE_URL` | empty | Published HTTPS privacy notice |
| `CONSUMER_AI_DATA_POLICY_ID` | empty | Approved provider/data-processing policy identifier |
| `CONSUMER_VOICE_DATA_POLICY_ID` | empty | Approved OpenAI audio-processing policy identifier |
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
| `CONSUMER_VOICE_TRANSCRIPTION_MODEL` | empty | Server-side speech-to-text model; fixed by reviewed deployment |
| `CONSUMER_VOICE_SPEECH_MODEL` | empty | Server-side exact-question speech model; fixed by reviewed deployment |
| `CONSUMER_VOICE_NAME` | empty | Reviewed synthetic voice name |
| `CONSUMER_VOICE_PRICING_VERSION` | empty | Auditable conservative reservation catalogue version; not an invoice-price claim |
| `CONSUMER_VOICE_TIMEOUT_MS` | `25000` | Abort timeout for a single provider call |
| `CONSUMER_VOICE_MAX_AUDIO_BYTES` | `1000000` | Worker-enforced maximum uploaded recording size |
| `CONSUMER_VOICE_MAX_DURATION_SECONDS` | `45` | Browser recording deadline and claimed-duration validation ceiling |
| `CONSUMER_VOICE_MAX_SPEECH_CHARACTERS` | `1200` | Maximum server-owned question length sent to speech synthesis |
| `CONSUMER_VOICE_SESSION_BUDGET_EUR_CENTS` | `0` | Conservative application voice allowance per consumer session; zero fails closed |
| `CONSUMER_VOICE_DAILY_BUDGET_EUR_CENTS` | `0` | Conservative aggregate application voice allowance per UTC day; zero fails closed |
| `CONSUMER_VOICE_TRANSCRIPTION_RESERVATION_EUR_CENTS` | `0` | Atomic cost reservation before transcription; zero fails closed |
| `CONSUMER_VOICE_SPEECH_RESERVATION_EUR_CENTS` | `0` | Atomic cost reservation before speech synthesis; zero fails closed |
| `CONSUMER_BOOKING_URL` | empty | Optional HTTPS booking seam |

The numeric values above are conservative operational starting points, not
privacy, legal, or financial-policy decisions. Review observed latency, quality,
and cost before changing them.

## Protected adviser-test voice activation

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
- `CONSUMER_VOICE_ENABLED=true`;
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
| `CONSUMER_BETA_VOICE_NOTICE_ID` | `voice-adviser-test-v1` |
| `CONSUMER_BETA_VOICE_DATA_POLICY_ID` | `openai-audio-adviser-test-v1` |
| `CONSUMER_BETA_VOICE_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` |
| `CONSUMER_BETA_VOICE_SPEECH_MODEL` | `tts-1-hd` |
| `CONSUMER_BETA_VOICE_NAME` | `nova` |
| `CONSUMER_BETA_VOICE_PRICING_VERSION` | `openai-audio-eur-safety-2026-07-13-v2` |
| `CONSUMER_BETA_VOICE_SESSION_BUDGET_EUR_CENTS` | `200` (€2.00 application allowance) |
| `CONSUMER_BETA_VOICE_DAILY_BUDGET_EUR_CENTS` | `2000` (€20.00 UTC-day application allowance) |
| `CONSUMER_BETA_VOICE_TRANSCRIPTION_RESERVATION_EUR_CENTS` | `10` |
| `CONSUMER_BETA_VOICE_SPEECH_RESERVATION_EUR_CENTS` | `10` |
| `CONSUMER_BETA_PRIVACY_NOTICE_URL` | `https://planeir.ie/plan/privacy.html` |
| `CONSUMER_BETA_SESSION_TTL_DAYS` | `7` |

There are no protected switches for model-driven AI intake, handoff, public
access, the cohort, policy values, voice models, voice name, application allowances, TTL,
or module allowlist. Adding or changing one is a separate reviewed release. The
OpenAI credential enables only the fixed audio routes because
`CONSUMER_AI_INTAKE_ENABLED` remains forced `false`.

The deployment resolves the D1 inventory by the exact name
`planeir-consumer`. It fails on duplicates. If none exists while the effective
mode is enabled, it creates exactly that database with Cloudflare's immutable
EU jurisdiction restriction, re-reads the inventory, validates the UUID, and
exports it only to the current job environment. It never commits the ID and
never substitutes `LEADS_DB`. An existing exact-name database is accepted for
activation only when Cloudflare reports its immutable jurisdiction as `eu`.
An existing database without that restriction fails closed; Cloudflare does not
permit adding or changing jurisdiction after creation.

The workflow next resolves the active `planeir.ie` zone in the configured
Cloudflare account and upserts one response-header transform rule with stable
reference `planeir_consumer_plan_security_headers_v1`. It updates only that
rule or appends it to the phase ruleset; unrelated rules are not replaced. The
live header verifier then checks `/plan/` and `/plan/privacy.html` before any
remote D1 migration or Worker deployment.

Only after that edge gate passes does the workflow apply both remote D1
migration streams and deploy the reviewed Worker and Durable Object code with
Realtime explicitly held `false` in a generated bootstrap configuration. It
then checks the Worker secret inventory for the exact
names `CONSUMER_DATA_ENCRYPTION_KEY`, `CONSUMER_RATE_LIMIT_HASH_KEY`, and
`CONSUMER_INVITE_SIGNING_KEY`. Each missing name receives a newly generated
independent 32-byte base64url value through `wrangler secret put`. Existing
names are never written, so a normal deployment cannot rotate an established
key. Values are never printed or added to a file. The protected GitHub
`OPENAI_API_KEY` secret is mandatory in effective voice-beta mode and is written
to the Worker as the server-only provider credential. Deployment fails before
activation if it is absent or contains whitespace; its value is never printed.
Wrangler 4.110 deploys a secret-only version when `secret put` runs. The
bootstrap deployment therefore completes before the first secret mutation, and
every secret command uses that same Realtime-disabled configuration. Only the
final reviewed deployment may apply the protected Realtime canary overlay. An
ordinary push keeps that overlay source-false. A protected manual dispatch must
select both `activate_realtime_adviser_canary` and
`run_paid_realtime_infrastructure_proof`; if its SDP, sideband tool, hang-up, or
later live check fails, CI redeploys the Realtime-disabled bootstrap config.
Production Worker deployments are non-cancellable by later runs, and the
activation-attempt marker is written before the external deploy begins so a
failure or cancellation cannot silently skip the compensating rollback.

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
   invite-required, voice-assisted rules-only, model-driven AI intake off, and
   limited to the fixed €2 session application allowance. It then authenticates as the configured
   adviser smoke account, issues a one-use private link, consumes it to create
   one synthetic voice-capable session with model-driven AI intake declined,
   and requires deletion of that session before running the existing
   adviser/published-session smoke. Invite, cookie, CSRF, session credentials,
   and audio are never printed.

Normal pushes and manual dispatches use the default-false
`run_paid_voice_provider_smoke` input and make no provider call in that bridge
smoke. Only a manual `workflow_dispatch` with that checkbox explicitly enabled
spends provider allowance: it asks the protected Worker to synthesize its exact
deterministic question, passes that bounded MP3 back through transcription,
verifies the 10-cent-plus-10-cent reservations, and still deletes the synthetic
session in `finally` even if either provider boundary fails.

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

For the protected voice beta, store `OPENAI_API_KEY` as a GitHub Actions secret
on the protected `production` environment. CI validates it and provisions the
same value as a Cloudflare Worker secret without printing it. For manual
non-production setup, add it only after the applicable voice or AI notice and
data-processing policy are approved:

```bash
npx wrangler secret put OPENAI_API_KEY
```

Adding a database, secrets, or policy values does not enable a capability. The
seven source-controlled flags remain the dormant baseline. Effective activation
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

The adviser-test voice transport does not invoke that extraction path. It uses
`gpt-4o-mini-transcribe` only for a recording capped at 45 seconds by the UI and
1,000,000 audio bytes by the Worker. The browser posts the recording as a raw
audio body with its reviewed audio media type plus bounded
`X-Voice-Duration-Ms` and `X-Voice-Request-Id` headers. When `Content-Length` is
present the Worker rejects an oversized declaration before reading; because
browsers do not portably guarantee that header for generated request bodies, it
is not required. The Worker streams and counts every body to the same hard byte
limit before constructing the provider file. It returns the transcript for
review and uses
`tts-1-hd` with `nova` only
to speak the exact server-selected deterministic question. Before either call,
the Worker atomically reserves 10 cents from its conservative reviewed cost
catalogue. It
refuses the call when the reservation would exceed 200 cents for the session or
2,000 cents across the UTC day. Every dispatched voice call currently keeps the
full reservation because the synchronous provider response is not an auditable
EUR invoice. This is a deliberately conservative application dispatch guard,
not invoice reconciliation; provider pricing and foreign-exchange changes must
be reviewed before changing the dated catalogue. A reservation may be released
only when non-dispatch is proven. These €2 and €20 values are application-level
voice allowances, not guarantees or invoice-level caps on actual OpenAI spend;
provider pricing, usage accounting, currency conversion, and billing can differ.
Keep provider-account billing limits and alerts as a separate operational
safeguard. Budget exhaustion leaves typed rules-only operation available and
never falls through to an unmetered provider call.

The provider abort remains active while the response body is consumed. The
Worker rejects unknown response media types, malformed declared lengths,
transcription bodies above 256 KiB, and speech bodies above 5,000,000 bytes; a
missing response `Content-Length` is read through the same streaming byte bound.

If the provider times out, refuses a request, returns invalid structured output,
or any budget is exhausted, processing continues in clearly labelled rules-only
mode. Do not silently invent a fact or substitute a model-generated calculation.

## Safe rollout order

Use this order independently in each environment:

1. Keep all source `wrangler.toml` capability flags false and validate the
   source-approved adviser-test constants.
2. Test create, resume, correction, consent withdrawal, expiry, and deletion
   locally with the master journey enabled but AI, public access, and handoff
   disabled.
3. Let CI resolve or create the exact isolated D1, replay both migration streams
   locally, and dry-run the Worker.
4. Upsert and verify the path-scoped edge header rule, then apply both remote D1
   migration streams.
5. Only after those prerequisites, let CI create missing encryption, rate-limit,
   and invite keys, provision the protected OpenAI credential, and deploy.
6. Use the protected activation procedure to enable the `adviser_test` cohort.
   The generated production config enables the master journey, routing, and
   bounded voice transport together only for the fixed initial allowlist and
   signed-invite audience.
7. Treat model-driven AI intake as a later, separate reviewed release.
   Configuring an OpenAI secret or AI data-policy ID does not enable it in the
   current production workflow; the voice beta sends audio only to its bounded
   transcription and exact-question speech routes.
8. Treat handoff as a later, separate reviewed release. Its published policy
   must define adviser-lead retention and pipeline visibility, minimal sharing,
   revocation, purge, deletion, and retry behaviour before the workflow is
   expanded to permit it.
9. Consider public access, a wider cohort, or another module only as a separate
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
| `PATCH` | `/api/consumer/sessions/:id/voice/consent` | Grant or withdraw the versioned optional voice-processing consent |
| `POST` | `/api/consumer/sessions/:id/voice/transcriptions` | Transcribe one bounded microphone recording into reviewable text |
| `POST` | `/api/consumer/sessions/:id/voice/speech` | Synthesize only the exact current deterministic Planéir question |
| `POST` | `/api/consumer/sessions/:id/handoffs` | Create a separately consented minimal adviser handoff |
| `DELETE` | `/api/consumer/sessions/:id` | Delete consumer session data |

Session routes require the owning `X-Consumer-Session: <id>.<secret>` credential
and return `Cache-Control: no-store`. Turn requests require a unique idempotency
key so retries do not double-charge or duplicate state. Authenticated deletion
and AI-consent withdrawal remain available when the processing kill switch is
off, preserving a narrow data-rights plane during an incident.

Voice consent is independent of analysis consent and model-driven AI intake.
Each real grant or withdrawal appends a versioned consent event while the
current row remains the fast authorization check; both are purged by authenticated
session deletion. Transcription accepts only an allowlisted raw audio media type,
a bounded duration header, and an idempotency header. The Worker enforces the
audio limit while consuming the request stream, including when the browser omits
`Content-Length`; it never
commits the returned text as a turn until the user reviews and sends it through
the ordinary deterministic turn route. Speech requests contain only an
idempotency key because the server derives the exact current question. Both
provider routes reserve budget atomically before making an external call.
Immediately before `fetch`, the reservation receives its one-way in-flight
timestamp only if the exact current notice, data-policy identifier, policy
version, privacy URL, and unwithdrawn grant still match. A withdrawal that
commits first prevents dispatch and the reservation is released as `not_sent`.
A withdrawal that commits after that transition applies to future and not-yet-
in-flight operations; it cannot recall a provider request already in flight.

`POST /api/advisor/consumer-invite` requires the authenticated adviser cookie
and matching `X-Advisor-CSRF` header. It is limited to 12 attempts per hour per
client IP and returns `Cache-Control: no-store`. Each signed invitation expires
within four hours and can create one consumer session only. The issuer fails
closed unless production is exactly the `adviser_test`, invite-only,
voice-assisted rules-only mode with the fixed two-module allowlist.

Success returns `{ "ok": true, "url": "https://planeir.ie/plan/#invite=…",
"expiresAt": "…", "maxUses": 1, "mode": "voice_assisted_rules_only" }` in
the protected voice beta. Expected failures
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
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://call-canvas-session-worker.geraldboylan.workers.dev; media-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(self), geolocation=()
Strict-Transport-Security: max-age=31556952
```

Configure these at the Cloudflare zone/edge (or move `/plan/*` to a host that
supports response headers) without changing headers for existing adviser pages
or any non-`/plan` route. `microphone=(self)` permits capture only in the
same-origin Planéir planning pages; camera and geolocation remain denied. Verify
both `/plan/` and `/plan/privacy.html` with `curl -sSI`. Keep
`CONSUMER_JOURNEY_ENABLED=false` if any header is absent or if production HTML
contains a localhost connection source.

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
environment. It establishes the release prerequisites in this order:

1. validates Cloudflare credentials, source approval, and the protected rollback
   override;
2. asserts all seven consumer capability flags are exactly `false` in source;
3. runs the full regression, static build, and fresh dual-D1 HTTP lifecycle;
4. resolves the exact `planeir-consumer` D1 and creates it only if missing;
5. creates a disposable same-directory Wrangler config with either dormant
   flags or the fixed adviser-test voice-assisted rules-only overlay;
6. replays adviser and consumer migrations into separate fresh local D1 state
   and dry-run bundles the Worker;
7. upserts only the stable path-scoped response-header rule and verifies the
   live static headers;
8. applies `LEADS_DB` migrations and conditionally applies `CONSUMER_DB`
   migrations when that binding exists;
9. deploys the reviewed Worker and Durable Object bootstrap with Realtime held
   false;
10. creates only missing consumer data Worker secrets, preserving every
    existing value, and provisions the protected OpenAI credential while still
    using the Realtime-disabled bootstrap configuration; and
11. deploys the final reviewed configuration, which may activate Realtime only
    for the explicit protected manual canary; and
12. for that canary, proves a real WebRTC SDP exchange, authenticated sideband,
    forced read-only planning tool, and confirmed server-side provider hang-up,
    with an automatic Realtime-only rollback on any subsequent failure.

It next asserts that the live
bootstrap is either fully dormant or exactly `adviser_test`, invite-required,
voice-assisted rules-only, text-AI-disabled, limited to a conservative €2
application allowance per session, and
limited to House Purchase and Liquidity. In beta mode it also
runs the authenticated adviser-to-consumer bridge smoke and requires cleanup of
its synthetic consumer session. Ordinary pushes remain Realtime source-false.
The legacy bounded-voice smoke remains provider-free unless its separate manual
input is enabled; a Realtime activation always requires its paid infrastructure
proof in the same protected manual dispatch. The
existing live published-session smoke runs last. Do not run those production
smoke flows during consumer development because they create and then delete or
revoke real remote records.

Browser release QA must cover desktop and mobile; keyboard-only navigation;
44-pixel touch targets; notice, adult, and consent gates; interrupted/resumed
sessions; corrections and focus retention after rerender; assumptions and
uncertainty copy; typed rules-only fallback; voice and AI consent withdrawal;
deletion; handoff
disabled/enabled states; and a regression pass through `/app/`.

## Rollback and incident response

For an intake, provider, or privacy incident:

1. Set the protected `CONSUMER_ADVISER_TEST_BETA_OVERRIDE` environment variable
   to exactly `false` and manually dispatch the Worker deployment. Do not edit
   the committed false flags.
2. Model-driven AI intake and handoff are already forced off in this beta. A
   voice-provider or cost-ledger incident requires the same protected `false`
   override because voice is intentionally coupled to this narrow adviser-test
   activation. If a later release permits a broader capability, use its
   independently reviewed kill switch as well.
3. Revoke outstanding signed invites if audience access is implicated.
4. Keep authenticated deletion and AI withdrawal reachable. Preserve only the
   encrypted records and allowlisted audit metadata required for incident
   review; never print decrypted values.
5. Revoke or rotate affected secrets and follow the versioned rotation process.
6. Use a reviewed, additive compensating migration if remediation is needed. Do
   not edit or drop existing adviser, lead, client, or published-session tables.

Disabling the consumer journey does not alter `/app/`, `/api/advisor/*`, public
lead capture, scheduling, publishing, or client-viewer routes.
