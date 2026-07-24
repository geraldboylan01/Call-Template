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
import { provisionTenant, type ProvisionSummary } from "../src/provision/provision.js";
import { RecordingSecretsProvider } from "../src/privacy/secrets.js";

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

// A minimised call summary exactly as the Cloudflare Worker emits it, so the
// analytics read model is exercised against realistic production-shaped data.
type CallScenario = {
  connected: boolean;
  dropTechnical?: boolean;
  connectFailed?: boolean;
  outcome: "completed" | "abandoned" | "failed";
  abandonmentCause?: "technical" | "non_technical";
  turnCount: number;
  durationMs?: number;
  causeDetail?: string;
};

describe.sequential("M0 analytics read endpoints", () => {
  let config: ServiceConfig;
  let connection: DatabaseConnection;
  let app: FastifyInstance;
  let tenantA: ProvisionSummary;
  let tenantB: ProvisionSummary;

  async function emitCall(tenant: ProvisionSummary, scenario: CallScenario): Promise<void> {
    const opened = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: bearer(tenant.secrets.ingest),
      payload: { module_id: tenant.moduleId, subject_ref: `call-${randomUUID()}` },
    });
    expect(opened.statusCode).toBe(201);
    const sessionId = (opened.json() as { session_id: string }).session_id;
    const now = new Date().toISOString();

    const events: Array<Record<string, unknown>> = [
      {
        event_id: randomUUID(),
        session_id: sessionId,
        event_type: "session.started",
        attrs: { channel: "voice", source: "orchestrator" },
        occurred_at: now,
      },
    ];
    if (scenario.connected) {
      events.push({
        event_id: randomUUID(),
        session_id: sessionId,
        event_type: "call.connected",
        attrs: { channel: "voice" },
        occurred_at: now,
      });
    } else if (scenario.connectFailed) {
      events.push({
        event_id: randomUUID(),
        session_id: sessionId,
        event_type: "call.connect_failed",
        attrs: { cause_class: "technical", cause_detail: scenario.causeDetail ?? "provider_error" },
        occurred_at: now,
      });
    }
    if (scenario.dropTechnical) {
      events.push({
        event_id: randomUUID(),
        session_id: sessionId,
        event_type: "call.dropped",
        attrs: { cause_class: "technical", cause_detail: scenario.causeDetail ?? "network_dropout" },
        occurred_at: now,
      });
    }
    const completedAttrs: Record<string, unknown> = {
      outcome: scenario.outcome,
      turn_count: scenario.turnCount,
    };
    if (scenario.abandonmentCause) completedAttrs.abandonment_cause = scenario.abandonmentCause;
    const completed: Record<string, unknown> = {
      event_id: randomUUID(),
      session_id: sessionId,
      event_type: "session.completed",
      attrs: completedAttrs,
      occurred_at: now,
    };
    if (scenario.durationMs !== undefined) completed.duration_ms = scenario.durationMs;
    events.push(completed);

    const ingest = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(tenant.secrets.ingest),
      payload: { events },
    });
    expect(ingest.statusCode).toBe(207);
    for (const result of (ingest.json() as { results: Array<{ status: string }> }).results) {
      expect(result.status).toBe("inserted");
    }
  }

  beforeAll(async () => {
    config = loadConfig();
    connection = createDatabaseConnection(config.databaseUrl);
    await waitForPostgres(connection.pool);

    tenantA = await provisionTenant(connection, {
      slug: `m0-a-${randomUUID()}`,
      displayName: "Analytics Firm A",
      moduleTitle: "Retirement readiness",
    });
    tenantB = await provisionTenant(connection, {
      slug: `m0-b-${randomUUID()}`,
      displayName: "Analytics Firm B",
      moduleTitle: "Protection review",
    });

    const secretsProvider = new RecordingSecretsProvider();
    secretsProvider.setTenantKey(tenantA.tenantId, 1, randomBytes(32));
    secretsProvider.setTenantKey(tenantB.tenantId, 1, randomBytes(32));

    app = buildApp(config, { connection, secretsProvider });
    await app.ready();

    // Tenant A: 4 calls with distinct terminal shapes.
    await emitCall(tenantA, { connected: true, outcome: "completed", turnCount: 8, durationMs: 120_000 });
    await emitCall(tenantA, {
      connected: true,
      dropTechnical: true,
      outcome: "failed",
      abandonmentCause: "technical",
      turnCount: 3,
      durationMs: 30_000,
      causeDetail: "network_dropout",
    });
    await emitCall(tenantA, {
      connected: false,
      connectFailed: true,
      outcome: "failed",
      abandonmentCause: "technical",
      turnCount: 0,
      causeDetail: "provider_error",
    });
    await emitCall(tenantA, {
      connected: true,
      outcome: "abandoned",
      abandonmentCause: "non_technical",
      turnCount: 2,
      durationMs: 15_000,
    });

    // Tenant B: a single, different call, used to prove isolation.
    await emitCall(tenantB, { connected: true, outcome: "completed", turnCount: 5, durationMs: 90_000 });
  });

  afterAll(async () => {
    await app.close();
    await connection.pool.end();
  });

  it("provisions a least-privilege read key alongside the existing scopes", async () => {
    expect(tenantA.secrets.read).toMatch(/^pk-read-/);
    const keys = await connection.pool.query<{ scopes: string[] }>(
      `select scopes from api_keys where tenant_id = $1 order by scopes`,
      [tenantA.tenantId],
    );
    expect(keys.rows.map((row) => row.scopes).sort()).toEqual([
      ["admin"],
      ["corrections"],
      ["ingest"],
      ["read"],
    ]);
  });

  it("returns headline totals, outcome mix, rates, engagement and causes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/analytics/overview",
      headers: bearer(tenantA.secrets.read),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as any;

    expect(body.totals.started).toBe(4);
    expect(body.totals.connected).toBe(3);
    expect(body.totals.connect_failed).toBe(1);
    expect(body.totals.dropped_technical).toBe(1);
    expect(body.totals.completed).toBe(4); // every finished call emits session.completed
    expect(body.totals.outcome).toEqual({ completed: 1, abandoned: 1, failed: 2 });
    expect(body.totals.abandonment).toEqual({ technical: 2, non_technical: 1 });
    expect(body.totals.distinct_subjects).toBe(4);

    expect(body.rates.connection_success).toBeCloseTo(3 / 4);
    expect(body.rates.completion).toBeCloseTo(1); // event-based, matches the snapshot view
    expect(body.rates.clean_completion).toBeCloseTo(1 / 4); // outcome-based end-to-end success
    expect(body.rates.technical_drop).toBeCloseTo(1 / 3);
    expect(body.rates.post_connect_completion).toBeCloseTo(1 / 3); // never exceeds 1

    expect(body.engagement.median_duration_ms).toBeCloseTo(30_000); // median of 15k,30k,120k
    expect(body.engagement.median_turn_count).toBeCloseTo(2.5); // continuous median of 0,2,3,8

    expect(body.causes.connect_failed).toEqual([{ cause: "provider_error", n: 1 }]);
    expect(body.causes.dropped_technical).toEqual([{ cause: "network_dropout", n: 1 }]);
  });

  it("returns a daily timeseries that reconciles with the overview", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/analytics/timeseries",
      headers: bearer(tenantA.secrets.read),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as any;
    const totalStarted = body.series.reduce((sum: number, row: any) => sum + row.started, 0);
    expect(totalStarted).toBe(4);
    expect(body.interval).toBe("day");
  });

  it("isolates tenants — B's read key never sees A's calls", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/analytics/overview",
      headers: bearer(tenantB.secrets.read),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as any;
    expect(body.totals.started).toBe(1);
    expect(body.totals.outcome.completed).toBe(1);
  });

  it("rejects unauthenticated and wrong-scope requests", async () => {
    const anon = await app.inject({ method: "GET", url: "/v1/analytics/overview" });
    expect(anon.statusCode).toBe(401);

    for (const wrongScope of [tenantA.secrets.ingest, tenantA.secrets.admin, tenantA.secrets.corrections]) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/analytics/overview",
        headers: bearer(wrongScope),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("validates the date range", async () => {
    const inverted = await app.inject({
      method: "GET",
      url: "/v1/analytics/overview?from=2026-02-01&to=2026-01-01",
      headers: bearer(tenantA.secrets.read),
    });
    expect(inverted.statusCode).toBe(400);

    const tooLong = await app.inject({
      method: "GET",
      url: "/v1/analytics/overview?from=2020-01-01&to=2026-01-01",
      headers: bearer(tenantA.secrets.read),
    });
    expect(tooLong.statusCode).toBe(400);

    const notADate = await app.inject({
      method: "GET",
      url: "/v1/analytics/overview?from=2026-02-30&to=2026-03-01",
      headers: bearer(tenantA.secrets.read),
    });
    expect(notADate.statusCode).toBe(400);

    const malformed = await app.inject({
      method: "GET",
      url: "/v1/analytics/overview?from=not-a-date",
      headers: bearer(tenantA.secrets.read),
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("never leaks pseudonyms, hashes, secrets or raw attrs", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/analytics/overview",
      headers: bearer(tenantA.secrets.read),
    });
    const raw = response.body;
    // `distinct_subjects` (a count) is fine; the pseudonym itself must not leak.
    expect(raw).not.toMatch(/pseudonym/i);
    expect(raw).not.toMatch(/subject_id|subject_ref/i);
    expect(raw).not.toMatch(/key_hash|payload_hash|ingestion_key/i);
    expect(raw).not.toMatch(/[0-9a-f]{64}/); // no sha256 hashes (pseudonyms/keys)
    expect(raw).not.toContain("pk-read-");
  });

  it("serves alerts for the range", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/analytics/alerts",
      headers: bearer(tenantA.secrets.read),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as any;
    expect(Array.isArray(body.alerts)).toBe(true);
  });
});
