# Planéir Realtime Voice Operations

This runbook covers the adviser-invite-only Realtime voice canary layered on the
existing `/plan/` journey. It does not replace the typed journey, the bounded
45-second recording flow, `/app/*`, adviser authentication, published sessions,
or any deterministic calculation engine.

## Authority boundary

- The browser carries microphone and speaker audio over WebRTC. It never
  receives an OpenAI API key or provider call identifier.
- The Worker creates the OpenAI call from the browser SDP offer and returns only
  the SDP answer plus an opaque Planéir lease identifier.
- One `ConsumerRealtimeSession` Durable Object owns each active lease. It keeps
  the authenticated provider sideband, event ordering, idempotent tool calls,
  interruption, alarms, the session allowance, and shutdown.
- The Realtime model is an untrusted conversational presenter and tool caller.
  It cannot supply JSON pointers, confirm a fact on the consumer's behalf,
  choose a non-allowlisted module, calculate a result, or make persisted state
  authoritative.
- D1 is the system of record. Only the Worker validates semantic fact IDs,
  profile revisions, confirmations, plan nonces, module readiness, deterministic
  results, usage, and retention.
- Sideband loss is terminal. The Durable Object cancels the current response,
  closes the provider call, and marks the Planéir lease failed. It does not let
  a browser-only agent continue.

## Release controls

`worker/wrangler.toml` must keep `CONSUMER_REALTIME_VOICE_ENABLED="false"`.
The production workflow refuses a committed `true` value.

The canary is enabled only when all of the following are true:

1. the existing signed-invite adviser beta is enabled;
2. a protected manual `Deploy Worker` dispatch explicitly sets
   `activate_realtime_adviser_canary=true`; ordinary pushes and default manual
   runs resolve `CONSUMER_REALTIME_ADVISER_CANARY_SOURCE_APPROVED=false`;
3. the protected `CONSUMER_REALTIME_ADVISER_CANARY_OVERRIDE` is absent or
   `true`;
4. the exact realtime notice, data-policy, model, voice, prompt, toolset,
   pricing, allowance, and timeout values pass runtime configuration checks;
5. the isolated consumer D1, Durable Object binding, migrations, and
   `OPENAI_API_KEY` secret are present; and
6. the same manual dispatch sets
   `run_paid_realtime_infrastructure_proof=true` and proves a real WebRTC peer,
   authenticated sideband, forced `get_planning_state` call, and confirmed
   server-side provider hang-up.

If any check after the active deploy fails, the workflow automatically deploys
the generated bootstrap configuration, which leaves the existing adviser beta
and bounded voice available while restoring Realtime to `false`. Production
Worker runs queue instead of cancelling one another. The activation attempt is
recorded before Wrangler starts, so a failed or cancelled deploy is treated as
potentially live and enters the same Realtime-only compensating rollback.

Set the protected GitHub environment variable
`CONSUMER_REALTIME_ADVISER_CANARY_OVERRIDE=false` for the immediate realtime
kill switch. The typed and bounded voice fallbacks remain available. The
existing `CONSUMER_ADVISER_TEST_BETA_OVERRIDE=false` disables the entire
consumer adviser beta.

### Standing activation across pushes

By default an ordinary push to `main` redeploys with Realtime source-false,
silently rolling back a live canary. Setting the repository variable
`CONSUMER_REALTIME_KEEP_ACTIVE=true` grants standing approval: a push
deployment first reads the live `/api/consumer/bootstrap` flags, and only when
the currently deployed Worker already reports Realtime enabled does the push
keep the activation (without re-running the paid proof; the deployment-mode
verification and adviser bridge smoke still gate the run, and a failure still
triggers the Realtime-only rollback). The variable can never switch Realtime
on from a disabled state — first activation always requires the protected
manual dispatch with the paid infrastructure proof — and the
`CONSUMER_REALTIME_ADVISER_CANARY_OVERRIDE=false` kill switch always wins.

### Field notes (2026-07-17 activation)

The 2026-07-16 canary died on every real consumer turn with
`conversation_item_injected`: gpt-realtime-2.1 intermittently adds an
assistant message item alongside the mandated tool call, which the strict
conversation allowlist treated as an injected item. Assistant message items
inside an authorized response (and stray `response.output_text` deltas) are
now tolerated on both the Worker and the client; unauthorized AUDIO output
and out-of-response items still fail closed. The paid activation proof also
settles the live bootstrap flag across consecutive samples before its first
Start press, because Cloudflare rolls Worker versions out isolate-by-isolate
and a mid-propagation Start burned run 202's proof.

### Conversation director

`CONSUMER_REALTIME_DIRECTOR_ENABLED` (source-false; the canary contract pins
`true`) turns on a bounded server-side text-model pass that phrases
Worker-owned `question`, `acknowledgement`, and `status` speech naturally:
it acknowledges what the consumer just said, varies phrasing, and answers
meta-requests such as "repeat that" or "what do you mean" by restating the
pending question. The deterministic question plan remains the steering
authority, greeting/read-back/result copy stays exact, every saved fact
still flows through the versioned tool gates, and any director failure or
timeout falls back to the deterministic template line. Director calls are
metered into the same session envelope through the pinned realtime text
rates. The realtime model is separately instructed to answer repeat and
meta-requests by calling `get_planning_state`, which re-speaks the current
question.

A barge-in that transcribes to nothing (a cough, background noise) no longer
strands the consumer mid-sentence: the Worker re-speaks the cancelled line
once ("As I was saying: …"), and the client polls immediately after an empty
transcription so the recovery plays promptly.

Turn-taking runs semantic VAD at high eagerness, and the consumer can always
force-finish a turn the detector missed: the live orb doubles as the "I've
finished" control (tap on mobile) and the space bar commits on desktop. The
browser's provider-event surface stays allowlisted to clearing and
committing its own audio buffer.

### Uncertain-close settlement

When a live meeting ends without provider-confirmed usage, the cost entry is
settled `unknown`. With the confirmed server-side hang-up already in place,
the charge is bounded by the provider-metered estimate plus a 50% safety
margin (minimum €0.50), capped at the original reservation — a transient
glitch no longer forfeits the whole €10 session envelope or drains the €50
UTC-day ceiling.

## Fixed adviser canary contract

| Setting | Value |
|---|---|
| Model | `gpt-realtime-2.1` |
| Voice | `marin` |
| Live input transcription | `gpt-4o-mini-transcribe` |
| Default reasoning | `low` |
| Escalation | `medium` only for contradictions, multiple goals, or complex household structure after evaluation |
| Maximum call | `CONSUMER_REALTIME_MAX_DURATION_SECONDS` (adviser demo 900 s; code cap 900 s) |
| Idle timeout | `CONSUMER_REALTIME_IDLE_TIMEOUT_SECONDS` (adviser demo 180 s; code cap 300 s) |
| Silence warning | spoken prompt `CONSUMER_REALTIME_SILENCE_PROMPT_SECONDS` (45 s) before the idle timeout ends the meeting |
| Concurrent calls | one per consumer session |
| Per-session application allowance | `CONSUMER_REALTIME_SESSION_BUDGET_EUR_CENTS` (adviser demo €10.00; code cap €10.00) |
| Allowance warning threshold | `CONSUMER_REALTIME_SESSION_WARN_EUR_CENTS` (adviser demo €7.50; default 75% of allowance) |
| UTC-day circuit breaker | `CONSUMER_REALTIME_DAILY_BUDGET_EUR_CENTS` (adviser demo €50.00; code cap €100.00) |
| Dispatch stop | session allowance − €0.30 reserve (adviser demo €9.70 estimated usage) |
| Delayed-usage/FX reserve | €0.30 |
| Response limit | 40 |
| Tool-call limit | 24 |
| SDP offer limit | 32,768 bytes |

The session allowance is a conservative application allowance, not an invoice
guarantee. It is environment-configurable within code-enforced caps so the
protected adviser demo can hold a 10–15 minute conversation, while the public
configuration remains disabled. Before connection, the service atomically reserves the complete
remaining session envelope against both the session and UTC-day ledgers. Each
`response.done` event is reconciled using the immutable pricing-version rates.
Input transcription is billed separately by OpenAI, so each finalized
`conversation.item.input_audio_transcription.completed` usage record is also
reconciled into the same lease before another response can be dispatched. A
missing or malformed response or transcription usage record is treated as
unknown usage; the call closes and the complete reservation remains consumed.

The canary pricing catalogue uses current GPT-Realtime-2.1 token rates plus the
separate GPT-4o mini Transcribe input/output rates, with USD amounts treated as
equal euro amounts. That is deliberately conservative; changing either model's
provider prices or the FX treatment requires a new pricing version and a
reviewed deployment.

## Consent and API contract

Realtime consent is separate from bounded-recording consent and must use the
currently published notice. The protected €10 adviser meeting uses notice
`realtime-voice-adviser-test-v2` and data-policy identifier
`openai-realtime-audio-adviser-test-v2`; receipts captured against the former
v1 identifiers are stale and cannot authorize a new call.

| Method | Route | Purpose |
|---|---|---|
| `PATCH` | `/api/consumer/sessions/:id/voice/realtime/consent` | Grant or withdraw versioned continuous-streaming consent |
| `POST` | `/api/consumer/sessions/:id/voice/realtime/calls` | Accept `application/sdp`, reserve the envelope, create the provider call, and return an SDP answer |
| `GET` | `/api/consumer/sessions/:id/voice/realtime/calls/:leaseId` | Read bounded public lease/fact/plan state |
| `DELETE` | `/api/consumer/sessions/:id/voice/realtime/calls/:leaseId` | End the call from the server side |
| `PUT` | `/api/consumer/sessions/:id/analysis-plan` | Save or explicitly confirm the displayed plan nonce at the current profile revision |

Migration `0009_add_realtime_consent_purposes.sql` provides audited storage and
domain operations for `live_voice_processing`,
`automated_planning_analysis`, and `redacted_turn_retention`. The current UI
still presents one bundled Live voice control, so these purpose rows are not
yet an API authority. Do not wire them into call authorization until the UI
offers independent choices and the first two purposes are required explicitly.

All routes require the owning `X-Consumer-Session` credential. The server never
accepts an adviser cookie, published-session capability, arbitrary profile
path, provider call ID, or model assertion as authority on these routes.

Withdrawing realtime consent closes any active provider/Durable Object session.
Deleting the consumer session first asks the Durable Object to close, then
atomically removes all realtime consent, event, usage, proposal, tool,
provenance, and analysis-plan rows along with the existing consumer data.

## Sideband tool allowlist

Only these versioned tools may be installed:

1. `get_planning_state`
2. `propose_facts`
3. `resolve_fact_confirmation`
4. `get_module_plan`
5. `confirm_and_run_plan`
6. `get_result_summary`
7. `wait_for_user`

Every attempt is schema-, size-, depth-, state-, revision-, idempotency-, and
allowlist-validated. `propose_facts` accepts semantic fact IDs only and must be
tied to a finalized provider input item. Material or ambiguous money, ages,
dates, dependants, and debts require read-back; every plan also requires the
displayed nonce and final confirmed profile revision. Deterministic
`speakableText` is the only financial result text the voice may read.

## Stored and excluded data

Stored consumer data is application-encrypted before D1 persistence and is
covered by the existing rekey, expiry, and deletion paths. The realtime tables
retain versioned consent events, lease state, allowlisted event metadata,
semantic fact proposals, idempotent tool attempts, response- and
transcription-level token usage, redacted finalized turns, analysis plans, and
deterministic run provenance.

Do not store:

- raw audio;
- SDP offers or answers;
- the OpenAI API key;
- unencrypted provider call IDs;
- audio deltas or partial transcript streams;
- unrestricted provider event payloads; or
- protected identifiers the journey tells the consumer not to provide.

Only redacted finalized turns may enter the existing encrypted conversation
history. Live captions are transient browser state; screen readers receive only
finalized utterances.

## Verification gate

Before leaving the canary enabled, prove all of the following:

1. a signed-in adviser can issue one invite and create one isolated consumer
   session;
2. explicit realtime consent is required and withdrawal is effective;
3. Cloudflare can exchange a real SDP offer, attach the authenticated OpenAI
   sideband, execute `get_planning_state`, and terminate the provider call from
   the server;
4. sideband failure, stale revisions, duplicate tool IDs, prompt injection,
   out-of-order events, reconnect, deletion, idle expiry, hard expiry, allowance
   races, and unknown usage all fail closed;
5. House Purchase and Liquidity run only after the current profile and displayed
   plan are confirmed, and every spoken figure comes from deterministic
   `speakableText`;
6. Chrome, Safari, iPhone Safari, and Android Chrome pass microphone denial,
   typed fallback, mute, end, barge-in, echo/noise, reduced-motion, keyboard,
   safe-area, and 44px target checks;
7. existing consumer, calculation, adviser, publishing, migration replay,
   static-header, build, and live bridge checks stay green.

Use:

```bash
npm run check:consumer
npm run check:consumer-http
npm run check:house-purchase
npm run build
git diff --check
```

The provider proof is intentionally paid and manually initiated. Use the two
Realtime checkboxes on a protected `Deploy Worker` dispatch. Do not put a paid
call in an ordinary push or pull-request workflow, and do not leave the canary
active if that proof fails.

## Access and subscription alternative

The live canary is available only through a one-use link issued from the
authenticated adviser workspace. It is not linked from the public site.

A ChatGPT subscription cannot fund an embedded OpenAI API WebRTC session;
ChatGPT subscriptions and API billing are separate. Keep the existing
copy/open-ChatGPT or Codex-assisted path for someone who wants to use their own
subscription manually. That fallback is not connected to the realtime tools
and cannot silently write Planéir facts or run modules.
