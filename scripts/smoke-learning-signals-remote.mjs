// Remote smoke test for the learning-signal integration.
//
// Verifies the EXACT path the worker uses — the real emitter's event shapes,
// through the live hosted service — without needing a voice call. It reads the
// same three env vars the worker uses and NEVER prints the ingest key.
//
// Usage (values stay in your shell; nothing is echoed):
//   LEARNING_SIGNALS_URL="https://<your-service>" \
//   LEARNING_SIGNALS_INGEST_KEY="<ingest key>" \
//   LEARNING_SIGNALS_MODULE_ID="<module id>" \
//   node ./scripts/smoke-learning-signals-remote.mjs
//
// It opens two sessions (a completed call and a technical drop) and ingests
// their minimised summaries, reporting only non-secret results (status codes,
// generated session ids, inserted counts).

import { randomUUID } from "node:crypto";

import { buildSessionSummary } from "../worker/src/consumer/learning_signals.js";

const url = (process.env.LEARNING_SIGNALS_URL || "").replace(/\/+$/, "");
const key = process.env.LEARNING_SIGNALS_INGEST_KEY || "";
const moduleId = process.env.LEARNING_SIGNALS_MODULE_ID || "";

function fail(message) {
  console.error(`SMOKE FAILED: ${message}`);
  process.exit(1);
}

// Never surface the key itself — only whether it is present.
if (!url) fail("LEARNING_SIGNALS_URL is not set");
if (!key) fail("LEARNING_SIGNALS_INGEST_KEY is not set (value hidden)");
if (!moduleId) fail("LEARNING_SIGNALS_MODULE_ID is not set");

async function post(path, body, timeoutMs = 15000) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
}

async function warmHealth() {
  // Free hosts cold-start; allow up to ~60s for the first hit.
  const started = Date.now();
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(15000) });
      if (response.ok) {
        console.log(`health: ${response.status} (warm in ${Math.round((Date.now() - started) / 1000)}s)`);
        return;
      }
      console.log(`health attempt ${attempt}: ${response.status}, retrying...`);
    } catch {
      console.log(`health attempt ${attempt}: no response yet (cold start?), retrying...`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  fail("service did not become healthy — check the URL and that the service is up");
}

async function deliverCall(label, summaryInput) {
  const { events } = buildSessionSummary(summaryInput);

  const opened = await post("/v1/sessions", {
    module_id: moduleId,
    subject_ref: `smoke_${randomUUID()}`,
  });
  if (opened.status === 503) {
    fail("POST /v1/sessions -> 503: set TENANT_SECRETS_JSON on the service for this tenant");
  }
  if (opened.status === 401 || opened.status === 403) {
    fail(`POST /v1/sessions -> ${opened.status}: the ingest key/tenant is wrong (value hidden)`);
  }
  if (opened.status !== 201 || !opened.json?.session_id) {
    fail(`POST /v1/sessions -> ${opened.status} (${opened.text.slice(0, 120)})`);
  }
  const sessionId = opened.json.session_id;

  const ingest = await post("/v1/telemetry/events", {
    events: events.map((event) => ({
      event_id: randomUUID(),
      session_id: sessionId,
      event_type: event.event_type,
      attrs: event.attrs,
      occurred_at: event.occurred_at,
      ...(event.duration_ms !== undefined ? { duration_ms: event.duration_ms } : {}),
    })),
  });
  if (ingest.status !== 207) {
    fail(`POST /v1/telemetry/events -> ${ingest.status} (${ingest.text.slice(0, 120)})`);
  }
  const results = ingest.json?.results ?? [];
  const inserted = results.filter((r) => r.status === "inserted").length;
  const rejected = results.filter((r) => r.status !== "inserted");
  if (rejected.length > 0) {
    fail(`some events rejected: ${JSON.stringify(rejected)}`);
  }
  console.log(`  ${label}: session ${sessionId.slice(0, 8)} — ${inserted}/${results.length} events inserted (${events.map((e) => e.event_type).join(", ")})`);
}

console.log(`smoke against ${url}`);
await warmHealth();

const now = Date.now();
await deliverCall("completed call", {
  status: "completed",
  reason: "user_ended",
  activatedAtMs: now - 180000,
  responseCount: 6,
});
await deliverCall("technical drop", {
  status: "failed",
  reason: "sideband_lost",
  activatedAtMs: now - 45000,
  responseCount: 2,
});

console.log("\nSMOKE PASSED — the live service accepted the emitter's calls.");
console.log("Now compute metrics against the service DB:");
console.log('  DATABASE_URL="<external db url>" make metrics');
