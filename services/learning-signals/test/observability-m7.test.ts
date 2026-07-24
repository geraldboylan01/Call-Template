import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type ServiceConfig } from "../src/config.js";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  waitForPostgres,
} from "../src/db/client.js";
import { BudgetGuardrail } from "../src/jobs/budget.js";
import { LangfuseForwardWorker } from "../src/outbox/langfuse-worker.js";
import { loadObservabilityConfig } from "../src/sinks/observability-config.js";
import {
  createObservabilitySpanSink,
  NoopObservabilitySpanSink,
} from "../src/sinks/observability-spans.js";
import {
  analyticsSessionId,
  buildOtelSpanAttributes,
  buildPostHogCapture,
  createTelemetrySinks,
  maskLangfuseGeneration,
  NoopLangfuseSink,
  NoopOtelSpanSink,
  NoopPostHogSink,
  RecordingLangfuseSink,
  type ForwardedTelemetryEvent,
} from "../src/sinks/telemetry-sinks.js";
import type { Clock } from "../src/telemetry/clock.js";
import { sha256Hex } from "../src/telemetry/canonical-json.js";

class FixedClock implements Clock {
  constructor(private readonly value: Date) {}
  now(): Date {
    return new Date(this.value);
  }
}

const observability = loadObservabilityConfig();

function forwardedEvent(overrides: Partial<ForwardedTelemetryEvent> = {}): ForwardedTelemetryEvent {
  return {
    deliveryId: randomUUID(),
    eventId: randomUUID(),
    analyticsSessionId: analyticsSessionId(randomUUID()),
    eventType: "question.prompted",
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    properties: {
      question_kind: "income",
      sequence: 1,
      question_id: "q.income.total",
      // Not on the allowlist — a deny-by-default boundary must drop it.
      leaked_answer: "SENTINEL-VALUE",
    },
    ...overrides,
  };
}

describe.sequential("M7 observability integrations", () => {
  let config: ServiceConfig;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    config = loadConfig();
    connection = createDatabaseConnection(config.databaseUrl);
    await waitForPostgres(connection.pool);
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  it("captures PostHog events anonymously with an opaque per-session distinct_id", () => {
    const rawSessionId = randomUUID();
    const subjectId = sha256Hex("subject:example");
    const event = forwardedEvent({ analyticsSessionId: analyticsSessionId(rawSessionId) });
    const capture = buildPostHogCapture(event, observability.posthogPropertyAllowlist);

    expect(capture.event).toBe("question.prompted");
    expect(capture.properties.$process_person_profile).toBe(false);
    // distinct_id is the opaque per-session id — never the subject pseudonym,
    // the raw session_id, or the per-event id.
    expect(capture.properties.distinct_id).toBe(event.analyticsSessionId);
    expect(capture.properties.distinct_id).toBe(analyticsSessionId(rawSessionId));
    expect(capture.properties.distinct_id).not.toBe(subjectId);
    expect(capture.properties.distinct_id).not.toBe(rawSessionId);
    expect(capture.properties.distinct_id).not.toBe(event.eventId);
    expect(capture.properties.$insert_id).toBe(`${event.deliveryId}:posthog`);
    // Allowlisted properties survive; everything else is dropped.
    expect(capture.properties.question_kind).toBe("income");
    expect(capture.properties.question_id).toBe("q.income.total");
    expect(capture.properties.leaked_answer).toBeUndefined();
    // No identify/alias/group keys are ever produced.
    for (const key of Object.keys(capture.properties)) {
      expect(["$set", "$set_once", "$group_set", "$groups"]).not.toContain(key);
    }
    // Deterministic per session, and the raw session_id is not a substring.
    expect(analyticsSessionId(rawSessionId)).toBe(analyticsSessionId(rawSessionId));
    expect(event.analyticsSessionId).not.toContain(rawSessionId);
  });

  it("exports OTel span attributes from the allowlist only", () => {
    const event = forwardedEvent();
    const attributes = buildOtelSpanAttributes(event, observability.otelAttributeAllowlist) as Array<{
      key: string;
    }>;
    const keys = attributes.map((attribute) => attribute.key);
    expect(keys).toContain("telemetry.event_id");
    expect(keys).toContain("telemetry.event_type");
    expect(keys).toContain("telemetry.question_kind");
    expect(keys).toContain("telemetry.question_id");
    expect(keys).not.toContain("telemetry.leaked_answer");
  });

  it("masks a Langfuse generation down to metadata, stripping all content", () => {
    const raw = {
      generation_id: "gen-1",
      tenant_id: "t-1",
      session_id: "s-1",
      request_id: "r-1",
      provider: "openai",
      model: "gpt",
      input_tokens: 10,
      output_tokens: 20,
      cached_input_tokens: 0,
      latency_ms: 120,
      cost_micros: 3400,
      // Everything below is content Langfuse would capture by default.
      input: "SENTINEL raw prompt",
      output: "SENTINEL raw completion",
      "gen_ai.prompt.0.content": "SENTINEL prompt fragment",
      "gen_ai.completion.0.content": "SENTINEL completion fragment",
      metadata_note: "SENTINEL note",
    };
    const masked = maskLangfuseGeneration(raw, observability.langfuseGenerationFieldAllowlist);
    expect(masked).toEqual({
      generation_id: "gen-1",
      tenant_id: "t-1",
      session_id: "s-1",
      request_id: "r-1",
      provider: "openai",
      model: "gpt",
      input_tokens: 10,
      output_tokens: 20,
      cached_input_tokens: 0,
      latency_ms: 120,
      cost_micros: 3400,
    });
    expect(JSON.stringify(masked)).not.toContain("SENTINEL");
  });

  it("installs zero-network no-op sinks and span sink when credentials are absent", () => {
    const sinks = createTelemetrySinks(
      {
        ...config,
        posthogApiKey: undefined,
        otelExporterOtlpEndpoint: undefined,
        langfusePublicKey: undefined,
        langfuseSecretKey: undefined,
      },
      observability,
    );
    expect(sinks.posthog).toBeInstanceOf(NoopPostHogSink);
    expect(sinks.otel).toBeInstanceOf(NoopOtelSpanSink);
    expect(sinks.langfuse).toBeInstanceOf(NoopLangfuseSink);
    expect(
      createObservabilitySpanSink({ ...config, otelExporterOtlpEndpoint: undefined }),
    ).toBeInstanceOf(NoopObservabilitySpanSink);
  });

  it("forwards provider usage to Langfuse as masked metadata via the outbox", async () => {
    const tenantId = randomUUID();
    const sessionId = randomUUID();
    const moduleVersionId = randomUUID();
    await connection.pool.query(
      `insert into tenants (tenant_id, slug, display_name) values ($1, $2, 'M7 LF')`,
      [tenantId, `m7-lf-${tenantId}`],
    );
    await connection.pool.query(
      `insert into module_versions (
         module_version_id, tenant_id, module_id, semantic_version, status,
         module_body_jsonb, content_hash, published_at
       ) values ($1, $2, $3, '1.0.0', 'published', '{}'::jsonb, $4, now())`,
      [moduleVersionId, tenantId, randomUUID(), sha256Hex(`m:${moduleVersionId}`)],
    );
    await connection.pool.query(
      `insert into fact_find_sessions (
         session_id, tenant_id, module_version_id, pseudonymous_subject_id
       ) values ($1, $2, $3, $4)`,
      [sessionId, tenantId, moduleVersionId, sha256Hex(`subj:${sessionId}`)],
    );
    // The AFTER INSERT trigger enqueues a provider_usage_outbox row.
    await connection.pool.query(
      `insert into provider_usage (
         tenant_id, session_id, provider, model, operation,
         input_tokens, output_tokens, cost_micros, latency_ms
       ) values ($1, $2, 'openai', 'gpt-4o', 'turn', 111, 222, 3400, 175)`,
      [tenantId, sessionId],
    );
    const enqueued = await connection.pool.query<{ count: number }>(
      `select count(*)::int as count from provider_usage_outbox where tenant_id = $1`,
      [tenantId],
    );
    expect(enqueued.rows[0]?.count).toBe(1);

    const langfuse = new RecordingLangfuseSink();
    const worker = new LangfuseForwardWorker({
      pool: connection.pool,
      langfuse,
      clock: new FixedClock(new Date(Date.now() + 60_000)),
      observability,
      retryBaseMilliseconds: 1,
      retryMaxMilliseconds: 10,
    });
    const drained = await worker.drainAvailable();
    expect(drained).toBeGreaterThanOrEqual(1);

    const generation = langfuse.attempts.find((g) => g.session_id === sessionId);
    expect(generation).toBeDefined();
    expect(generation).toMatchObject({
      tenant_id: tenantId,
      session_id: sessionId,
      provider: "openai",
      model: "gpt-4o",
      input_tokens: 111,
      output_tokens: 222,
      cost_micros: 3400,
      latency_ms: 175,
    });
    // Only allowlisted metadata keys — no content, no prompt/completion.
    for (const key of Object.keys(generation ?? {})) {
      expect(observability.langfuseGenerationFieldAllowlist.has(key)).toBe(true);
    }

    const processed = await connection.pool.query<{ processed_at: Date | null }>(
      `select processed_at from provider_usage_outbox where tenant_id = $1`,
      [tenantId],
    );
    expect(processed.rows[0]?.processed_at).toBeInstanceOf(Date);
  });

  it("raises a per-tenant provider budget alert only when the daily cap is crossed", async () => {
    const overCap = randomUUID();
    const underCap = randomUUID();
    const overrideTenant = randomUUID();
    const spendDate = "2026-05-20";
    const spendAt = new Date(Date.UTC(2026, 4, 20, 12, 0, 0));

    async function seedSpend(tenantId: string, label: string, costMicros: number): Promise<void> {
      await connection.pool.query(
        `insert into tenants (tenant_id, slug, display_name) values ($1, $2, $3)`,
        [tenantId, `m7-b-${label}-${tenantId}`, `M7 budget ${label}`],
      );
      const moduleVersionId = randomUUID();
      await connection.pool.query(
        `insert into module_versions (
           module_version_id, tenant_id, module_id, semantic_version, status,
           module_body_jsonb, content_hash, published_at
         ) values ($1, $2, $3, '1.0.0', 'published', '{}'::jsonb, $4, now())`,
        [moduleVersionId, tenantId, randomUUID(), sha256Hex(`m:${moduleVersionId}`)],
      );
      const sessionId = randomUUID();
      await connection.pool.query(
        `insert into fact_find_sessions (
           session_id, tenant_id, module_version_id, pseudonymous_subject_id
         ) values ($1, $2, $3, $4)`,
        [sessionId, tenantId, moduleVersionId, sha256Hex(`subj:${sessionId}`)],
      );
      await connection.pool.query(
        `insert into provider_usage (
           tenant_id, session_id, provider, model, operation, cost_micros, latency_ms, created_at
         ) values ($1, $2, 'openai', 'gpt', 'turn', $3, 100, $4)`,
        [tenantId, sessionId, costMicros, spendAt.toISOString()],
      );
    }

    // Default cap is 50,000,000 micros.
    await seedSpend(overCap, "over", 60_000_000);
    await seedSpend(underCap, "under", 10_000_000);
    await seedSpend(overrideTenant, "override", 8_000_000);
    // A low per-tenant override cap makes the override tenant breach at 8M.
    await connection.pool.query(
      `insert into tenant_provider_budgets (tenant_id, daily_cap_micros) values ($1, 5000000)`,
      [overrideTenant],
    );

    const guardrail = new BudgetGuardrail({
      pool: connection.pool,
      observability,
      spans: new NoopObservabilitySpanSink(),
    });
    const result = await guardrail.evaluateDay(spendDate);
    expect(result.alertCount).toBeGreaterThanOrEqual(2);

    const alerts = await connection.pool.query<{
      tenant_id: string;
      spend_micros: string;
      cap_micros: string;
    }>(
      `select tenant_id, spend_micros, cap_micros from provider_budget_alerts
        where spend_date = $1 and tenant_id = any($2::uuid[])`,
      [spendDate, [overCap, underCap, overrideTenant]],
    );
    const byTenant = new Map(alerts.rows.map((row) => [row.tenant_id, row]));

    expect(byTenant.has(underCap)).toBe(false);
    expect(byTenant.get(overCap)).toMatchObject({
      spend_micros: "60000000",
      cap_micros: "50000000",
    });
    expect(byTenant.get(overrideTenant)).toMatchObject({
      spend_micros: "8000000",
      cap_micros: "5000000",
    });

    // Idempotent: re-running the same day does not duplicate alerts.
    await guardrail.evaluateDay(spendDate);
    const afterRerun = await connection.pool.query<{ count: number }>(
      `select count(*)::int as count from provider_budget_alerts
        where spend_date = $1 and tenant_id = $2`,
      [spendDate, overCap],
    );
    expect(afterRerun.rows[0]?.count).toBe(1);
  });
});
