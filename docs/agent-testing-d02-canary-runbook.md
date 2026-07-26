# D-02 — Voice Canary and Production Activation Runbook

**Purpose.** Close D-02 by activating the module-offer and three-analysis
capacity flows in live voice, then in production, after a controlled canary.

**Why this is an operator task.** Every step below needs production credentials
(`CLOUDFLARE_API_TOKEN`, `OPENAI_API_KEY`, `ADVISOR_SMOKE_PASSWORD`), a
protected GitHub environment, and a paid manual workflow dispatch against a live
service. None of that is available to, or appropriate for, an automated agent.
The code, tests and configuration are complete and merged; what follows is the
human-run activation.

**Current state.**

| Environment | `CONSUMER_MODULE_OFFERS_ENABLED` | Status |
|---|---|---|
| Local / CI | on (in the journey harness) | ✅ full journey passes |
| consumer-test | `"true"` in [`wrangler.consumer-test.toml`](../worker/wrangler.consumer-test.toml) | ✅ configured |
| Production | `"false"` in [`wrangler.toml`](../worker/wrangler.toml), enforced by `requiredFalseFlags` | ⏳ pending this runbook |

---

## Step 1 — Deploy with the flag on for the canary

The deploy workflow reads the repository variable `CONSUMER_MODULE_OFFERS_ENABLED`
and overlays it onto the ephemeral production config. It is validated as exactly
`true` or `false` and takes effect only when the adviser beta is itself enabled.

1. Set the repository variable `CONSUMER_MODULE_OFFERS_ENABLED = true`.
2. Dispatch **Deploy Worker** with `activate_realtime_adviser_canary = true` and
   `run_paid_realtime_infrastructure_proof = true` (the workflow requires the
   paid proof in the same run as an activation).
3. Confirm the deployment summary reports
   `CONSUMER_MODULE_OFFERS_ENABLED: true`.

**Rollback at any point:** set the variable back to `false` and redeploy. No
schema change, no migration, no data rewrite.

## Step 2 — Run the conversation canary

Dispatch **Realtime Conversation Probe** with `confirm_paid_conversation = true`
and `keep_probe_session = true` (so the session survives for inspection).

The probe drives a real spoken meeting. To exercise D-02 the conversation must
reach an offer, so use a scenario whose client states one goal but volunteers a
circumstance that makes a *different* analysis relevant. The shape validated in
test is:

> "I'm 52, I own my home and there's still a mortgage on it, and I want to get
> my pension sorted."

That yields `pension_projection` + `personal_balance_sheet` as routed slots and
`mortgage_analysis` as an **offerable opportunity**.

Exercise each branch, one per probe run:

| Run | Client says | Expect |
|---|---|---|
| 1 | "Yes, that would be useful" | `module_offer_decided` / `accepted`; the analysis joins the plan but does not run |
| 2 | "No thanks" | `module_offer_decided` / `declined`; never re-offered |
| 3 | "Maybe — what does that involve?" | `module_offer_uncertain`; nothing changes; the question is asked again |
| 4 | A client with four relevant analyses, then "Swap out the balance sheet" | `capacity_decision_resolved` / `replace` |
| 5 | Same, then "Leave it for another time" | `capacity_decision_resolved` / `defer` |

## Step 3 — Inspect the recorded events

The planning events are now recorded rather than dropped. For a probe session:

```bash
wrangler d1 execute CONSUMER_DB --remote --config worker/wrangler.production.generated.toml --command "SELECT event_name, metadata_json, created_at FROM consumer_events WHERE session_id = 'cs_...' ORDER BY created_at"
```

Expect, in order: `agent_test_session_created` is absent (this is voice),
`goal_plan_evaluated`, `module_offer_presented`, `module_offer_decided`, and —
where the limit was reached — `capacity_decision_presented` and
`capacity_decision_resolved`. Every one carries `channel: "voice"`.

Then confirm the execution set:

```bash
wrangler d1 execute CONSUMER_DB --remote --config worker/wrangler.production.generated.toml --command "SELECT status, module_ids_json FROM consumer_realtime_analysis_plans WHERE session_id = 'cs_...'"
```

The executed `moduleIds` must equal the set the client confirmed — including a
swapped-in analysis and excluding a swapped-out or deferred one.

## Step 4 — What "pass" means

- An offer is spoken, anchored to something the client actually said, in client
  language, with no formal analysis name or module id.
- `record_module_decision` is only ever available while an offer is live.
- Accept / decline / uncertain behave as the table above says; uncertain is
  never treated as acceptance.
- At the limit, the client is told the constraint plainly and chooses; nothing
  suggests which analysis to drop.
- The confirmed set is exactly what executes.

If any check fails, fix it **in the shared planning path**, not with
voice-specific behaviour — the whole point of D-02 is that both transports
inherit one implementation. Re-run from Step 2.

## Step 5 — Production activation

Once the canary passes, `CONSUMER_MODULE_OFFERS_ENABLED = true` is already the
production value from Step 1; the canary *is* the production deployment. Record
the passing canary run id against D-02 in
[agent-testing-parity-contract.md](agent-testing-parity-contract.md) and mark it
fully resolved.

---

## Note on the agent transport

`CONSUMER_AGENT_TEST_ENABLED` stays `"false"` in production permanently. It is a
testing facility, enabled only in the consumer-test environment. It is
deliberately included in the deploy workflow's `requiredFalseFlags` so it cannot
be switched on in production by accident.
