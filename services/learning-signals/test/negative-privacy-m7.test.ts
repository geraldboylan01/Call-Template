import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig, type ServiceConfig } from "../src/config.js";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  waitForPostgres,
} from "../src/db/client.js";
import { BudgetGuardrail } from "../src/jobs/budget.js";
import { MetricsRunner, utcDateString } from "../src/jobs/metrics-runner.js";
import { RetentionPurgeJob } from "../src/jobs/retention.js";
import { loadFieldPolicy } from "../src/privacy/field-policy.js";
import { RecordingSecretsProvider } from "../src/privacy/secrets.js";
import { LangfuseForwardWorker } from "../src/outbox/langfuse-worker.js";
import { OutboxWorker } from "../src/outbox/worker.js";
import { loadObservabilityConfig } from "../src/sinks/observability-config.js";
import { RecordingObservabilitySpanSink } from "../src/sinks/observability-spans.js";
import {
  buildOtelSpanPayload,
  buildPostHogCapture,
  RecordingLangfuseSink,
  RecordingOtelSpanSink,
  RecordingPostHogSink,
} from "../src/sinks/telemetry-sinks.js";
import { sha256Hex } from "../src/telemetry/canonical-json.js";
import type { Clock } from "../src/telemetry/clock.js";
import {
  EventCatalogRegistry,
  loadEventCatalogRegistry,
} from "../src/telemetry/event-catalog.js";

class FixedClock implements Clock {
  constructor(private readonly value: Date) {}
  now(): Date {
    return new Date(this.value);
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function fullDatabaseDump(connection: DatabaseConnection): Promise<string> {
  const tables = await connection.pool.query<{ schemaname: string; tablename: string }>(
    `select schemaname, tablename from pg_tables
      where schemaname not in ('pg_catalog', 'information_schema')
      order by schemaname, tablename`,
  );
  const chunks: string[] = [];
  for (const table of tables.rows) {
    const qualified = `${quoteIdentifier(table.schemaname)}.${quoteIdentifier(table.tablename)}`;
    const rows = await connection.pool.query<{ dump: string }>(
      `select coalesce(jsonb_agg(to_jsonb(row_data))::text, '[]') as dump
         from ${qualified} as row_data`,
    );
    chunks.push(`${table.schemaname}.${table.tablename}:${rows.rows[0]?.dump ?? "[]"}`);
  }
  return chunks.join("\n");
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

describe.sequential("M7 negative privacy suite", () => {
  let config: ServiceConfig;
  let connection: DatabaseConnection;
  let catalogs: EventCatalogRegistry;
  let app: FastifyInstance;
  let spanSink: RecordingObservabilitySpanSink;
  let clock: FixedClock;

  const observability = loadObservabilityConfig();

  // Sentinels threaded through the scenario. NONE may survive anywhere.
  const suffix = randomUUID().replaceAll("-", "");
  const piiBefore = `SENTINEL-PII-NAME-${suffix}`;
  const piiAfter = `SENTINEL-PII-NAME2-${suffix}`;
  const providerKey = `sk-SENTINEL-PROVIDER-${suffix}`;
  const apiKeySecret = `SENTINEL-APIKEY-${suffix}`;
  const sentinels = [piiBefore, piiAfter, providerKey, apiKeySecret];

  const tenantId = randomUUID();
  const moduleId = randomUUID();
  const moduleVersionId = randomUUID();
  const sessionId = randomUUID();
  const extractionId = randomUUID();

  const posthog = new RecordingPostHogSink();
  const otel = new RecordingOtelSpanSink();
  const langfuse = new RecordingLangfuseSink();

  beforeAll(async () => {
    config = loadConfig();
    connection = createDatabaseConnection(config.databaseUrl);
    await waitForPostgres(connection.pool);
    catalogs = loadEventCatalogRegistry();
    clock = new FixedClock(new Date());
    spanSink = new RecordingObservabilitySpanSink();

    const secretsProvider = new RecordingSecretsProvider();
    secretsProvider.setTenantKey(tenantId, 1, randomBytes(32));

    await connection.pool.query(
      `insert into tenants (tenant_id, slug, display_name) values ($1, $2, 'M7 Negative')`,
      [tenantId, `m7-neg-${tenantId}`],
    );
    await connection.pool.query(
      `insert into api_keys (tenant_id, key_hash, scopes, actor_label)
       values ($1, $2, array['ingest','corrections','admin']::text[], 'adviser-ui')`,
      [tenantId, sha256Hex(apiKeySecret)],
    );
    await connection.pool.query(
      `insert into module_versions (
         module_version_id, tenant_id, module_id, semantic_version, status,
         module_body_jsonb, content_hash, published_at
       ) values ($1, $2, $3, '1.0.0', 'published', '{"sections":[]}'::jsonb, $4, now())`,
      [moduleVersionId, tenantId, moduleId, sha256Hex(`m:${moduleVersionId}`)],
    );
    await connection.pool.query(
      `insert into fact_find_sessions (
         session_id, tenant_id, module_version_id, pseudonymous_subject_id
       ) values ($1, $2, $3, $4)`,
      [sessionId, tenantId, moduleVersionId, sha256Hex(`subj:${sessionId}`)],
    );
    await connection.pool.query(
      `insert into consent_ledger (
         tenant_id, session_id, purpose, action, policy_version, notice_id,
         evidence_hash, occurred_at, decision_ts
       ) values ($1, $2, 'service_improvement_telemetry', 'granted',
                 'm7-v1', 'm7-notice', $3, now(), now())`,
      [tenantId, sessionId, sha256Hex(`consent:${sessionId}`)],
    );
    // An identifier field (preview policy = none): a correction stores only
    // hashes and no preview, so the raw value cannot survive.
    await connection.pool.query(
      `insert into field_extractions (
         extraction_id, tenant_id, session_id, field_path, value_class,
         normalized_value_hash, key_version, extraction_status, field_policy_version
       ) values ($1, $2, $3, 'identity.full_name', 'identifier', $4, 1, 'extracted', 'field-policy-v1')`,
      [extractionId, tenantId, sessionId, sha256Hex(`ex:${extractionId}`)],
    );

    app = buildApp(config, {
      connection,
      catalog: catalogs.current,
      clock,
      fieldPolicy: loadFieldPolicy(),
      secretsProvider,
      spans: spanSink,
    });
    await app.ready();

    const now = clock.now();
    // Phase A: valid categorical ingestion (exercises ingestion + outbox).
    const events = [
      {
        event_id: randomUUID(),
        session_id: sessionId,
        event_type: "module.enter",
        attrs: { module_id: moduleId },
        occurred_at: now.toISOString(),
        turn_index: 0,
      },
      {
        event_id: randomUUID(),
        session_id: sessionId,
        event_type: "question.prompted",
        attrs: { question_kind: "identity", sequence: 1, question_id: "q.identity.name" },
        occurred_at: now.toISOString(),
        turn_index: 1,
      },
    ];
    const ingest = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(apiKeySecret),
      payload: { events },
    });
    expect(ingest.statusCode).toBe(207);

    // Phase B: adviser correction with raw PII in before/after and a provider
    // key pasted into the note. The route hashes values and discards notes.
    const correction = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(apiKeySecret),
      payload: {
        session_id: sessionId,
        extraction_id: extractionId,
        idempotency_key: randomUUID(),
        before_raw: piiBefore,
        after_raw: piiAfter,
        reason_code: "incorrect_value",
        note: `please rotate ${providerKey}`,
      },
    });
    expect(correction.statusCode).toBe(201);

    // Phase C: provider usage (trigger enqueues the Langfuse outbox).
    await connection.pool.query(
      `insert into provider_usage (
         tenant_id, session_id, provider, model, operation,
         input_tokens, output_tokens, cost_micros, latency_ms
       ) values ($1, $2, 'openai', 'gpt-4o', 'turn', 40, 80, 5000, 150)`,
      [tenantId, sessionId],
    );

    // Phase D: drain every forwarding path into the Recording sinks.
    const drainClock = new FixedClock(new Date(now.getTime() + 60_000));
    const outboxWorker = new OutboxWorker({
      pool: connection.pool,
      catalogs,
      clock: drainClock,
      posthog,
      otel,
      spans: spanSink,
      retryBaseMilliseconds: 1,
      retryMaxMilliseconds: 10,
    });
    await outboxWorker.drainAvailable();
    const langfuseWorker = new LangfuseForwardWorker({
      pool: connection.pool,
      langfuse,
      clock: drainClock,
      observability,
      retryBaseMilliseconds: 1,
      retryMaxMilliseconds: 10,
    });
    await langfuseWorker.drainAvailable();

    // Phase E: run the metrics, budget, and purge jobs (operational spans).
    const metricDate = utcDateString(now);
    await new MetricsRunner({ pool: connection.pool, spans: spanSink }).runDay(metricDate, tenantId);
    await new BudgetGuardrail({ pool: connection.pool, observability, spans: spanSink }).evaluateDay(metricDate, tenantId);
    await new RetentionPurgeJob({ pool: connection.pool, clock, spans: spanSink }).runOnce();
  });

  afterAll(async () => {
    await app.close();
    await connection.pool.end();
  });

  it("persists the correction as hashes only, never the raw sentinel value", async () => {
    const stored = await connection.pool.query<{ count: number }>(
      `select count(*)::int as count from adviser_corrections
        where tenant_id = $1 and extraction_id = $2`,
      [tenantId, extractionId],
    );
    expect(stored.rows[0]?.count).toBe(1);
  });

  it("forwarded at least one PostHog, OTel, and Langfuse payload", () => {
    // A vacuous scan would pass; prove the surfaces are actually populated.
    expect(posthog.attempts.length).toBeGreaterThan(0);
    expect(otel.attempts.length).toBeGreaterThan(0);
    expect(langfuse.attempts.length).toBeGreaterThan(0);
    expect(spanSink.spans.length).toBeGreaterThan(0);
  });

  it("leaks no sentinel into any telemetry table (full database dump)", async () => {
    const dump = await fullDatabaseDump(connection);
    for (const sentinel of sentinels) {
      expect(dump).not.toContain(sentinel);
    }
  });

  it("leaks no sentinel into any PostHog capture payload", () => {
    const wire = posthog.attempts
      .map((event) => JSON.stringify(buildPostHogCapture(event, observability.posthogPropertyAllowlist)))
      .join("\n");
    const raw = JSON.stringify(posthog.attempts);
    for (const sentinel of sentinels) {
      expect(wire).not.toContain(sentinel);
      expect(raw).not.toContain(sentinel);
    }
  });

  it("leaks no sentinel into any OTel span payload", () => {
    const wire = otel.attempts
      .map((event) => JSON.stringify(buildOtelSpanPayload(event, observability.otelAttributeAllowlist)))
      .join("\n");
    for (const sentinel of sentinels) {
      expect(wire).not.toContain(sentinel);
    }
  });

  it("leaks no sentinel into any Langfuse generation trace", () => {
    const traces = JSON.stringify(langfuse.attempts);
    for (const sentinel of sentinels) {
      expect(traces).not.toContain(sentinel);
    }
  });

  it("leaks no sentinel into any operational job span", () => {
    const spans = JSON.stringify(spanSink.spans);
    for (const sentinel of sentinels) {
      expect(spans).not.toContain(sentinel);
    }
  });

  it("leaks no sentinel into captured application logs on the error path", async () => {
    let logText = "";
    const loggedApp = buildApp(
      { ...config, nodeEnv: "production", logLevel: "error" },
      {
        connection,
        catalog: catalogs.current,
        clock,
        fieldPolicy: loadFieldPolicy(),
        logStream: {
          write(message) {
            logText += message;
          },
        },
      },
    );
    await loggedApp.ready();

    // Force a 500 while sentinels are in the request body: a failing trigger on
    // the outbox insert aborts ingestion after the body was parsed.
    const triggerName = `m7_neg_fail_${suffix}`;
    const functionName = `m7_neg_fail_fn_${suffix}`;
    await connection.pool.query(
      `create function ${functionName}() returns trigger language plpgsql as $$
       begin raise exception using errcode = 'P0001', message = 'boom'; end; $$`,
    );
    await connection.pool.query(
      `create trigger ${triggerName} before insert on telemetry_outbox
       for each row execute function ${functionName}()`,
    );
    try {
      const response = await loggedApp.inject({
        method: "POST",
        url: "/v1/telemetry/events",
        headers: bearer(apiKeySecret),
        payload: {
          events: [
            {
              event_id: randomUUID(),
              session_id: sessionId,
              event_type: "question.prompted",
              // Sentinels ride in the body; the error path must not serialize it.
              attrs: { question_kind: "identity", sequence: 1, note: piiBefore },
              occurred_at: clock.now().toISOString(),
              turn_index: 2,
            },
          ],
        },
      });
      // The disallowed attr means the item is invalid; the request still parses
      // the sentinel-bearing body, which is what the log scrubber must handle.
      expect([207, 500]).toContain(response.statusCode);
      // Also drive a guaranteed 500 with a valid event so the outbox trigger fires.
      const valid = await loggedApp.inject({
        method: "POST",
        url: "/v1/telemetry/events",
        headers: bearer(apiKeySecret),
        payload: {
          events: [
            {
              event_id: randomUUID(),
              session_id: sessionId,
              event_type: "question.prompted",
              attrs: { question_kind: "identity", sequence: 3 },
              occurred_at: clock.now().toISOString(),
              turn_index: 3,
            },
          ],
        },
      });
      expect(valid.statusCode).toBe(500);
      expect(logText).toContain("request failed");
      for (const sentinel of sentinels) {
        expect(logText).not.toContain(sentinel);
      }
      expect(logText.toLowerCase()).not.toContain("authorization");
    } finally {
      await connection.pool.query(`drop trigger ${triggerName} on telemetry_outbox`);
      await connection.pool.query(`drop function ${functionName}()`);
      await loggedApp.close();
    }
  });
});
