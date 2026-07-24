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

describe.sequential("Phase 0 session registration + provisioning", () => {
  let config: ServiceConfig;
  let connection: DatabaseConnection;
  let app: FastifyInstance;
  let tenantA: ProvisionSummary;
  let tenantB: ProvisionSummary;
  let tenantNoSecret: ProvisionSummary;

  beforeAll(async () => {
    config = loadConfig();
    connection = createDatabaseConnection(config.databaseUrl);
    await waitForPostgres(connection.pool);

    // Provisioning also publishes an initial module version through the real
    // route, so this both onboards the tenants and exercises provisioning.
    tenantA = await provisionTenant(connection, {
      slug: `p0-a-${randomUUID()}`,
      displayName: "Phase0 Firm A",
      moduleTitle: "Retirement readiness",
    });
    tenantB = await provisionTenant(connection, {
      slug: `p0-b-${randomUUID()}`,
      displayName: "Phase0 Firm B",
      moduleTitle: "Protection review",
    });
    tenantNoSecret = await provisionTenant(connection, {
      slug: `p0-c-${randomUUID()}`,
      displayName: "Phase0 Firm C",
      moduleTitle: "Cashflow",
    });

    const secretsProvider = new RecordingSecretsProvider();
    secretsProvider.setTenantKey(tenantA.tenantId, 1, randomBytes(32));
    secretsProvider.setTenantKey(tenantB.tenantId, 1, randomBytes(32));
    // tenantNoSecret intentionally has no key -> the route must fail 503.

    app = buildApp(config, { connection, secretsProvider });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await connection.pool.end();
  });

  async function openSession(
    secret: string,
    payload: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: bearer(secret),
      payload,
    });
    return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
  }

  it("provisions a tenant with one key per scope and an initial published module", async () => {
    expect(tenantA.moduleVersionId).toBeDefined();
    const parsed = JSON.parse(tenantA.tenantSecretsJson) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([tenantA.tenantId]);

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

  it("opens a session, pins the active published version, and closes the ingest gap", async () => {
    const sessionId = randomUUID();
    const opened = await openSession(tenantA.secrets.ingest, {
      session_id: sessionId,
      module_id: tenantA.moduleId,
      subject_ref: "orchestrator-session-ref-1",
    });
    expect(opened.statusCode).toBe(201);
    expect(opened.body).toMatchObject({
      session_id: sessionId,
      module_version_id: tenantA.moduleVersionId,
      key_version: 1,
      status: "started",
      replayed: false,
    });

    // The whole point: an event can now be ingested for the freshly opened
    // session (previously impossible without a raw SQL insert).
    const ingest = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(tenantA.secrets.ingest),
      payload: {
        events: [
          {
            event_id: randomUUID(),
            session_id: sessionId,
            event_type: "session.started",
            attrs: { channel: "voice", source: "orchestrator" },
            occurred_at: new Date().toISOString(),
          },
        ],
      },
    });
    expect(ingest.statusCode).toBe(207);
    expect((ingest.json() as { results: Array<{ status: string }> }).results[0]?.status).toBe(
      "inserted",
    );
  });

  it("is idempotent on re-open and never stores the raw subject reference", async () => {
    const sessionId = randomUUID();
    const subjectRef = `RAW-SUBJECT-${randomUUID()}`;
    const first = await openSession(tenantA.secrets.ingest, {
      session_id: sessionId,
      module_id: tenantA.moduleId,
      subject_ref: subjectRef,
    });
    expect(first.statusCode).toBe(201);
    const replay = await openSession(tenantA.secrets.ingest, {
      session_id: sessionId,
      module_id: tenantA.moduleId,
      subject_ref: subjectRef,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({ session_id: sessionId, replayed: true });

    const row = await connection.pool.query<{ pseudonymous_subject_id: string }>(
      `select pseudonymous_subject_id from fact_find_sessions
        where tenant_id = $1 and session_id = $2`,
      [tenantA.tenantId, sessionId],
    );
    const stored = row.rows[0]?.pseudonymous_subject_id ?? "";
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(subjectRef);
    // The raw reference appears nowhere in the row.
    expect(JSON.stringify(row.rows[0])).not.toContain(subjectRef);
  });

  it("derives tenancy from the key and rejects wrong scope, mismatch, and missing auth", async () => {
    const payload = { module_id: tenantA.moduleId, subject_ref: "ref" };

    const unauthenticated = await app.inject({ method: "POST", url: "/v1/sessions", payload });
    expect(unauthenticated.statusCode).toBe(401);

    // admin/corrections keys lack the ingest scope.
    expect((await openSession(tenantA.secrets.admin, payload)).statusCode).toBe(403);
    expect((await openSession(tenantA.secrets.corrections, payload)).statusCode).toBe(403);

    // Body tenant_id must equal the authenticated tenant.
    const mismatch = await openSession(tenantA.secrets.ingest, {
      ...payload,
      tenant_id: tenantB.tenantId,
    });
    expect(mismatch.statusCode).toBe(403);
  });

  it("returns 404 for a foreign or unknown module (no existence leak)", async () => {
    // tenant A cannot open against tenant B's module.
    const foreign = await openSession(tenantA.secrets.ingest, {
      module_id: tenantB.moduleId,
      subject_ref: "ref",
    });
    expect(foreign.statusCode).toBe(404);

    const unknown = await openSession(tenantA.secrets.ingest, {
      module_id: randomUUID(),
      subject_ref: "ref",
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("fails 503 when the tenant pseudonymisation secret is unavailable", async () => {
    const response = await openSession(tenantNoSecret.secrets.ingest, {
      module_id: tenantNoSecret.moduleId,
      subject_ref: "ref",
    });
    expect(response.statusCode).toBe(503);

    // No partial row was written.
    const rows = await connection.pool.query<{ count: number }>(
      `select count(*)::int as count from fact_find_sessions where tenant_id = $1`,
      [tenantNoSecret.tenantId],
    );
    expect(rows.rows[0]?.count).toBe(0);
  });
});
