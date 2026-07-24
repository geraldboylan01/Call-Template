import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { DatabaseConnection } from "../db/client.js";
import { loadFieldPolicy } from "../privacy/field-policy.js";
import { RecordingSecretsProvider } from "../privacy/secrets.js";
import { sha256Hex } from "../telemetry/canonical-json.js";
import { loadEventCatalogRegistry } from "../telemetry/event-catalog.js";

// A deterministic dev/CI fixture that drives the REAL pipeline: module versions
// are published through the publish route, every telemetry event is ingested
// through /v1/telemetry/events, and every correction goes through
// /v1/adviser-corrections. Only the setup rows with no HTTP surface (tenant,
// API keys, sessions, granted/denied consent, proposed extractions) are written
// with SQL. Running the seed therefore also validates ingestion, pinning,
// consent gating, and correction sanitisation end to end.

export type SeedSummary = {
  tenantId: string;
  secrets: { ingest: string; corrections: string; admin: string };
  moduleVersionIds: string[];
  sessionIds: Record<string, string>;
  eventTypesIngested: string[];
  correctionReasonCodes: string[];
};

type EventEnvelope = {
  event_id: string;
  session_id: string;
  event_type: string;
  attrs: Record<string, unknown>;
  occurred_at: string;
  turn_index?: number;
  duration_ms?: number;
};

const CONSENT_PURPOSES = [
  "service_improvement_telemetry",
  "partner_benchmarking",
  "optional_demographics",
  "marketing_referral",
] as const;

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

export async function runSeed(connection: DatabaseConnection): Promise<SeedSummary> {
  const config = loadConfig();
  const catalog = loadEventCatalogRegistry().current;
  const secretsProvider = new RecordingSecretsProvider();

  const tenantId = randomUUID();
  secretsProvider.setTenantKey(tenantId, 1, randomBytes(32));
  const app = buildApp(config, {
    connection,
    catalog,
    fieldPolicy: loadFieldPolicy(),
    secretsProvider,
  });
  await app.ready();

  try {
    return await seedWithApp(connection, app, tenantId, catalog.version);
  } finally {
    await app.close();
  }
}

async function seedWithApp(
  connection: DatabaseConnection,
  app: FastifyInstance,
  tenantId: string,
  catalogVersion: string,
): Promise<SeedSummary> {
  const pool = connection.pool;
  const secrets = {
    ingest: `seed-ingest-${randomUUID()}`,
    corrections: `seed-corrections-${randomUUID()}`,
    admin: `seed-admin-${randomUUID()}`,
  };

  // --- Tenant + one API key per scope (tenant inherits the default retention
  // policy via its column default). ---------------------------------------
  await pool.query(
    `insert into tenants (tenant_id, slug, display_name)
     values ($1, $2, 'Planeir Seed Firm')`,
    [tenantId, `seed-${tenantId}`],
  );
  await pool.query(
    `insert into api_keys (tenant_id, key_hash, scopes, actor_label) values
       ($1, $2, array['ingest']::text[], 'voice-orchestrator'),
       ($1, $3, array['corrections']::text[], 'adviser-ui'),
       ($1, $4, array['admin']::text[], 'module-admin')`,
    [
      tenantId,
      sha256Hex(secrets.ingest),
      sha256Hex(secrets.corrections),
      sha256Hex(secrets.admin),
    ],
  );

  // --- 2 modules x 2 published versions, all through the publish route. -----
  const moduleA = randomUUID();
  const moduleB = randomUUID();
  const moduleVersionIds: string[] = [];
  async function publish(moduleId: string, semver: string, title: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/module-versions/publish",
      headers: bearer(secrets.admin),
      payload: {
        module_id: moduleId,
        semantic_version: semver,
        module_json: { title, sections: [{ id: "income", fields: ["finances.annual_income"] }] },
      },
    });
    if (response.statusCode !== 201) {
      throw new Error(`Seed publish failed (${response.statusCode}): ${response.body}`);
    }
    const versionId = (response.json() as { module_version_id: string }).module_version_id;
    moduleVersionIds.push(versionId);
    return versionId;
  }
  await publish(moduleA, "1.0.0", "Retirement readiness");
  const moduleALatest = await publish(moduleA, "1.1.0", "Retirement readiness");
  await publish(moduleB, "1.0.0", "Protection review");
  await publish(moduleB, "1.1.0", "Protection review");

  // --- Sessions. S1-S3 fully consented, S4 declined, S5 withdrawn, S6 is the
  // tenant "operations" session that hosts module-authoring and adviser-portal
  // events (which are tenant-level, not tied to a client fact-find). ---------
  const sessions = {
    completed: randomUUID(),
    abandonedTechnical: randomUUID(),
    resumed: randomUUID(),
    declined: randomUUID(),
    withdrawn: randomUUID(),
    operations: randomUUID(),
  };
  async function seedSession(sessionId: string, moduleVersionId: string): Promise<void> {
    await pool.query(
      `insert into fact_find_sessions (
         session_id, tenant_id, module_version_id, pseudonymous_subject_id
       ) values ($1, $2, $3, $4)`,
      [sessionId, tenantId, moduleVersionId, sha256Hex(`seed-subject:${sessionId}`)],
    );
  }
  for (const sessionId of Object.values(sessions)) {
    await seedSession(sessionId, moduleALatest);
  }

  // --- Consent state. Granted-for-all lets the fully consented sessions
  // persist optional-demographics and marketing events too. -----------------
  async function grantAll(sessionId: string): Promise<void> {
    for (const purpose of CONSENT_PURPOSES) {
      await pool.query(
        `insert into consent_ledger (
           tenant_id, session_id, purpose, action, policy_version, notice_id,
           evidence_hash, occurred_at, decision_ts
         ) values ($1, $2, $3, 'granted', 'seed-consent-v1', 'seed-notice-v1', $4, now(), now())`,
        [tenantId, sessionId, purpose, sha256Hex(`consent:${sessionId}:${purpose}`)],
      );
    }
  }
  await grantAll(sessions.completed);
  await grantAll(sessions.abandonedTechnical);
  await grantAll(sessions.resumed);
  await grantAll(sessions.operations);
  // A declined-consent session: service-improvement explicitly denied. Contract
  // and improvement events still persist under their legal bases, but nothing
  // forwards to third parties.
  await pool.query(
    `insert into consent_ledger (
       tenant_id, session_id, purpose, action, policy_version, notice_id,
       evidence_hash, occurred_at, decision_ts
     ) values ($1, $2, 'service_improvement_telemetry', 'denied',
               'seed-consent-v1', 'seed-notice-v1', $3, now(), now())`,
    [tenantId, sessions.declined, sha256Hex(`consent:${sessions.declined}`)],
  );
  // A withdrawn-consent session: granted first, then withdrawn via the event
  // below so the withdrawal flows through the real pipeline.
  await grantAll(sessions.withdrawn);

  const now = Date.now();
  const iso = (offsetSeconds: number): string =>
    new Date(now - 3_600_000 + offsetSeconds * 1000).toISOString();
  let sequence = 0;
  const events: EventEnvelope[] = [];
  function emit(
    sessionId: string,
    eventType: string,
    attrs: Record<string, unknown>,
    extra: Partial<EventEnvelope> = {},
  ): void {
    events.push({
      event_id: randomUUID(),
      session_id: sessionId,
      event_type: eventType,
      attrs,
      occurred_at: iso(sequence++),
      ...extra,
    });
  }

  // S1 — a fully successful, fully consented fact-find. Exercises the client
  // lifecycle plus optional demographics, marketing, and a survey.
  emit(sessions.completed, "session.started", { channel: "voice", source: "orchestrator" });
  emit(sessions.completed, "call.connected", { channel: "voice" });
  emit(sessions.completed, "module.enter", { module_id: moduleA }, { turn_index: 0 });
  emit(
    sessions.completed,
    "question.prompted",
    { question_kind: "income", sequence: 1, question_id: "q.income.total" },
    { turn_index: 1 },
  );
  emit(
    sessions.completed,
    "question.completed",
    { outcome: "answered", value_class: "provided", question_id: "q.income.total", duration_bucket: "5_to_15s" },
    { turn_index: 1, duration_ms: 8_000 },
  );
  emit(
    sessions.completed,
    "extraction.completed",
    { field_kind: "income", result: "extracted", confidence_band: "high" },
    { turn_index: 1, duration_ms: 400 },
  );
  emit(sessions.completed, "demographics.band.recorded", { dimension: "age", band: "45_to_54" });
  emit(sessions.completed, "marketing.referral.recorded", { channel: "adviser", campaign_category: "branded" });
  emit(sessions.completed, "module.exit", { module_id: moduleA, outcome: "completed" }, { turn_index: 2, duration_ms: 120_000 });
  emit(sessions.completed, "meeting.booked", { channel: "voice" });
  emit(sessions.completed, "session.completed", { outcome: "completed", turn_count: 6 }, { duration_ms: 180_000 });
  emit(sessions.completed, "survey.response", { score: 5, reason: "very_helpful" });

  // S2 — a call with a technical connect failure and a mid-call drop.
  emit(sessions.abandonedTechnical, "session.started", { channel: "voice", source: "orchestrator" });
  emit(sessions.abandonedTechnical, "call.connect_failed", { cause_class: "technical", cause_detail: "provider_error" });
  emit(sessions.abandonedTechnical, "call.connected", { channel: "voice" });
  emit(sessions.abandonedTechnical, "module.enter", { module_id: moduleA }, { turn_index: 0 });
  emit(sessions.abandonedTechnical, "call.dropped", { cause_class: "technical", cause_detail: "network_dropout" });
  emit(sessions.abandonedTechnical, "call.hung_up", { cause_class: "technical", cause_detail: "network_dropout" });
  emit(
    sessions.abandonedTechnical,
    "session.completed",
    { outcome: "abandoned", turn_count: 2, abandonment_cause: "technical" },
    { duration_ms: 45_000 },
  );

  // S3 — abandoned then re-engaged via a nudge and resumed.
  emit(sessions.resumed, "session.started", { channel: "voice", source: "orchestrator" });
  emit(sessions.resumed, "call.connected", { channel: "voice" });
  emit(sessions.resumed, "module.enter", { module_id: moduleB }, { turn_index: 0 });
  emit(
    sessions.resumed,
    "question.prompted",
    { question_kind: "risk", sequence: 1, question_id: "q.risk.profile" },
    { turn_index: 1 },
  );
  emit(sessions.resumed, "nudge.sent", { channel: "email", nudge_kind: "resume" });
  emit(sessions.resumed, "session.resumed", { source: "nudge" });
  emit(
    sessions.resumed,
    "question.completed",
    { outcome: "answered", value_class: "banded", question_id: "q.risk.profile", duration_bucket: "under_5s" },
    { turn_index: 2, duration_ms: 4_000 },
  );
  emit(sessions.resumed, "module.exit", { module_id: moduleB, outcome: "completed" }, { turn_index: 3, duration_ms: 90_000 });
  emit(sessions.resumed, "session.completed", { outcome: "completed", turn_count: 4 }, { duration_ms: 200_000 });
  emit(sessions.resumed, "survey.response", { score: 3, reason: "neutral" });

  // S4 — declined consent: persists under legal basis, forwards to nobody.
  emit(sessions.declined, "session.started", { channel: "voice", source: "orchestrator" });
  emit(
    sessions.declined,
    "question.prompted",
    { question_kind: "identity", sequence: 1, question_id: "q.identity.name" },
    { turn_index: 1 },
  );
  emit(
    sessions.declined,
    "question.completed",
    { outcome: "declined", value_class: "not_provided", question_id: "q.identity.name" },
    { turn_index: 1, duration_ms: 3_000 },
  );
  emit(sessions.declined, "session.completed", { outcome: "completed", turn_count: 2 }, { duration_ms: 60_000 });

  // S5 — consent withdrawn mid-flight (the withdrawal is a real event).
  emit(sessions.withdrawn, "session.started", { channel: "voice", source: "orchestrator" });
  emit(
    sessions.withdrawn,
    "question.completed",
    { outcome: "answered", value_class: "provided", question_id: "q.income.total" },
    { turn_index: 1, duration_ms: 6_000 },
  );
  emit(sessions.withdrawn, "consent.withdrawn", { consent_type: "service_improvement_telemetry" });

  // S6 — module authoring + adviser-portal events (tenant operations).
  emit(sessions.operations, "module.created", { module_id: moduleB });
  emit(sessions.operations, "module.edited", { module_id: moduleB, change_scope: "questions" });
  emit(sessions.operations, "module.test_run", { module_id: moduleB, outcome: "passed" });
  emit(sessions.operations, "module.published", { module_id: moduleB, module_version_id: moduleALatest });
  emit(sessions.operations, "module.rolled_back", { module_id: moduleB, module_version_id: moduleALatest });
  emit(sessions.operations, "review.queue_viewed", { reviewer_role: "adviser", queue_depth_bucket: "6_to_20" });
  emit(sessions.operations, "review.started", { reviewer_role: "adviser" });
  emit(sessions.operations, "review.completed", { reviewer_role: "adviser", corrections_made: "some" });
  emit(sessions.operations, "review.abandoned", { stage: "income" });

  // --- Ingest every event through the real batch route. ---------------------
  const ingestResponse = await app.inject({
    method: "POST",
    url: "/v1/telemetry/events",
    headers: bearer(secrets.ingest),
    payload: { events },
  });
  if (ingestResponse.statusCode !== 207) {
    throw new Error(`Seed ingestion failed (${ingestResponse.statusCode}): ${ingestResponse.body}`);
  }
  const results = (ingestResponse.json() as {
    results: Array<{ event_id: string; status: string; error?: string }>;
  }).results;
  const rejected = results.filter((result) => result.status !== "inserted");
  if (rejected.length > 0) {
    throw new Error(`Seed ingestion rejected events: ${JSON.stringify(rejected)}`);
  }

  // --- Proposed extractions + one correction per reason code (through the real
  // corrections route, which emits extraction.corrected internally). Includes
  // an unchanged correction so both change_kinds are exercised. --------------
  const corrections: Array<{
    field: string;
    before: string | number | null;
    after: string | number | null;
    reason: string;
  }> = [
    { field: "finances.annual_income", before: "50000", after: "55000", reason: "incorrect_value" },
    { field: "finances.total_assets", before: "430000", after: null, reason: "missing_value" },
    { field: "risk.profile", before: "balanced", after: "growth", reason: "misclassified" },
    { field: "goals.retirement_age", before: "65", after: "66", reason: "formatting" },
    { field: "client.age", before: "45", after: "46", reason: "other" },
    { field: "identity.full_name", before: "Jane Doe", after: "Jane Doe", reason: "incorrect_value" },
  ];
  const correctionReasonCodes = new Set<string>();
  for (const correction of corrections) {
    const extractionId = randomUUID();
    await pool.query(
      `insert into field_extractions (
         extraction_id, tenant_id, session_id, field_path, value_class,
         normalized_value_hash, key_version, extraction_status,
         field_policy_version, confidence
       ) values ($1, $2, $3, $4, 'currency', $5, 1, 'extracted', 'field-policy-v1', 0.8)`,
      [extractionId, tenantId, sessions.completed, correction.field, sha256Hex(`ex:${extractionId}`)],
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(secrets.corrections),
      payload: {
        session_id: sessions.completed,
        extraction_id: extractionId,
        idempotency_key: randomUUID(),
        before_raw: correction.before,
        after_raw: correction.after,
        reason_code: correction.reason,
      },
    });
    if (response.statusCode !== 201) {
      throw new Error(`Seed correction failed (${response.statusCode}): ${response.body}`);
    }
    correctionReasonCodes.add(correction.reason);
  }

  const ingestedTypes = await pool.query<{ event_type: string }>(
    `select distinct event_type from session_events where tenant_id = $1 order by event_type`,
    [tenantId],
  );

  void catalogVersion;
  return {
    tenantId,
    secrets,
    moduleVersionIds,
    sessionIds: sessions,
    eventTypesIngested: ingestedTypes.rows.map((row) => row.event_type),
    correctionReasonCodes: [...correctionReasonCodes].toSorted(),
  };
}
