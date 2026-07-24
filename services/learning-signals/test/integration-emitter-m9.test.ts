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
import { MetricsRunner, utcDateString } from "../src/jobs/metrics-runner.js";
import { provisionTenant, type ProvisionSummary } from "../src/provision/provision.js";
import { RecordingSecretsProvider } from "../src/privacy/secrets.js";

// Integration proof for the voice-orchestrator emitter (integration Phase 2).
// It imports the REAL worker emitter — worker/src/consumer/learning_signals.js —
// and feeds its output through the REAL service routes against real Postgres,
// exactly as a finished call would. This is the end-to-end contract the manual
// "one real call" exercise depends on: if this is green, the only thing left
// for a real call is a human actually speaking to the orb.

type BuiltEvent = {
  event_type: string;
  attrs: Record<string, unknown>;
  occurred_at: string;
  duration_ms?: number;
};
type EmitterModule = {
  buildSessionSummary(input: {
    status: string;
    reason: string;
    activatedAtMs: number;
    responseCount: number;
    nowMs?: number;
  }): { events: BuiltEvent[] };
};

// A URL specifier keeps tsc from trying (and failing) to type the plain-JS
// worker module; tsx resolves the real path at runtime.
const emitterModuleUrl = new URL(
  "../../../worker/src/consumer/learning_signals.js",
  import.meta.url,
).href;

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

describe.sequential("Phase 2 emitter to service integration", () => {
  let config: ServiceConfig;
  let connection: DatabaseConnection;
  let app: FastifyInstance;
  let tenant: ProvisionSummary;
  let emitter: EmitterModule;

  beforeAll(async () => {
    config = loadConfig();
    connection = createDatabaseConnection(config.databaseUrl);
    await waitForPostgres(connection.pool);
    emitter = (await import(emitterModuleUrl)) as EmitterModule;

    tenant = await provisionTenant(connection, {
      slug: `p2-${randomUUID()}`,
      displayName: "Phase2 Firm",
      moduleTitle: "Test Planner",
    });
    const secretsProvider = new RecordingSecretsProvider();
    secretsProvider.setTenantKey(tenant.tenantId, 1, randomBytes(32));
    app = buildApp(config, { connection, secretsProvider });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await connection.pool.end();
  });

  // Mirrors the emitter's deliverSessionSummary transport, but in-process via
  // inject: open the session, then ingest the built events against it.
  async function deliverThroughRoutes(events: BuiltEvent[]): Promise<string> {
    const open = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: bearer(tenant.secrets.ingest),
      payload: { module_id: tenant.moduleId, subject_ref: `cs_${randomUUID()}` },
    });
    expect(open.statusCode).toBe(201);
    const sessionId = (open.json() as { session_id: string }).session_id;

    const ingest = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(tenant.secrets.ingest),
      payload: {
        events: events.map((event) => ({
          event_id: randomUUID(),
          session_id: sessionId,
          event_type: event.event_type,
          attrs: event.attrs,
          occurred_at: event.occurred_at,
          ...(event.duration_ms !== undefined ? { duration_ms: event.duration_ms } : {}),
        })),
      },
    });
    expect(ingest.statusCode).toBe(207);
    const results = (ingest.json() as { results: Array<{ status: string; error?: string }> }).results;
    for (const result of results) {
      expect(result, JSON.stringify(result)).toMatchObject({ status: "inserted" });
    }
    return sessionId;
  }

  async function eventTypesFor(sessionId: string): Promise<string[]> {
    const rows = await connection.pool.query<{ event_type: string }>(
      `select event_type from session_events where tenant_id = $1 and session_id = $2 order by event_type`,
      [tenant.tenantId, sessionId],
    );
    return rows.rows.map((row) => row.event_type);
  }

  it("accepts a completed call's summary and lands the full lifecycle", async () => {
    const activatedAtMs = Date.now() - 3 * 60 * 1000;
    const { events } = emitter.buildSessionSummary({
      status: "completed",
      reason: "user_ended",
      activatedAtMs,
      responseCount: 7,
    });
    const sessionId = await deliverThroughRoutes(events);
    const types = await eventTypesFor(sessionId);
    expect(types).toContain("session.started");
    expect(types).toContain("call.connected");
    expect(types).toContain("session.completed");
    expect(types).not.toContain("call.dropped");

    const completed = await connection.pool.query<{ outcome: string; turn_count: number }>(
      `select attrs->>'outcome' as outcome, (attrs->>'turn_count')::int as turn_count
         from session_events
        where tenant_id = $1 and session_id = $2 and event_type = 'session.completed'`,
      [tenant.tenantId, sessionId],
    );
    expect(completed.rows[0]).toMatchObject({ outcome: "completed", turn_count: 7 });
  });

  it("accepts a mid-call technical drop and tags the abandonment cause", async () => {
    const { events } = emitter.buildSessionSummary({
      status: "failed",
      reason: "sideband_lost",
      activatedAtMs: Date.now() - 60 * 1000,
      responseCount: 2,
    });
    const sessionId = await deliverThroughRoutes(events);
    const types = await eventTypesFor(sessionId);
    expect(types).toContain("call.dropped");
    expect(types).toContain("session.completed");

    const completed = await connection.pool.query<{ outcome: string; cause: string }>(
      `select attrs->>'outcome' as outcome, attrs->>'abandonment_cause' as cause
         from session_events
        where tenant_id = $1 and session_id = $2 and event_type = 'session.completed'`,
      [tenant.tenantId, sessionId],
    );
    expect(completed.rows[0]).toMatchObject({ outcome: "failed", cause: "technical" });
  });

  it("accepts a connect failure with no connection", async () => {
    const { events } = emitter.buildSessionSummary({
      status: "failed",
      reason: "provider_error",
      activatedAtMs: Number.NaN,
      responseCount: 0,
    });
    const sessionId = await deliverThroughRoutes(events);
    const types = await eventTypesFor(sessionId);
    expect(types).toContain("call.connect_failed");
    expect(types).not.toContain("call.connected");
    expect(types).not.toContain("call.dropped");
  });

  it("produces completion and reliability metrics from the emitted calls", async () => {
    // Everything ingested above is stamped received_at = now, so it lands on
    // today's UTC metric day.
    const metricDate = utcDateString(new Date());
    await new MetricsRunner({ pool: connection.pool }).runDay(metricDate, tenant.tenantId);

    const snapshots = await connection.pool.query<{ metric_name: string; value: number | null }>(
      `select metric_name, value from metric_daily_snapshots
        where tenant_id = $1 and metric_date = $2
          and metric_name in ('completion_rate', 'connection_success_rate', 'mid_call_drop_rate')`,
      [tenant.tenantId, metricDate],
    );
    const byName = new Map(snapshots.rows.map((row) => [row.metric_name, row.value]));
    // Three sessions started; all three have a session.completed event.
    expect(byName.get("completion_rate")).toBe(1);
    // Two of three connected (the connect-failure did not).
    const connectionRate = byName.get("connection_success_rate");
    expect(connectionRate).not.toBeNull();
    expect(connectionRate).toBeCloseTo(2 / 3, 10);
    // One technical drop out of two connected.
    expect(byName.get("mid_call_drop_rate")).toBeCloseTo(1 / 2, 10);
  });
});
