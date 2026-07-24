import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  waitForPostgres,
} from "../src/db/client.js";
import { runSeed, type SeedSummary } from "../src/seed/seed.js";
import { loadEventCatalogRegistry } from "../src/telemetry/event-catalog.js";

describe.sequential("M8 seed fixtures", () => {
  let connection: DatabaseConnection;
  let summary: SeedSummary;

  beforeAll(async () => {
    const config = loadConfig();
    connection = createDatabaseConnection(config.databaseUrl);
    await waitForPostgres(connection.pool);
    summary = await runSeed(connection);
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  it("publishes 2 modules x 2 versions through the publish route", () => {
    expect(summary.moduleVersionIds).toHaveLength(4);
    expect(new Set(summary.moduleVersionIds).size).toBe(4);
  });

  it("exercises every service-ingestible event type plus the derived correction event", () => {
    const catalog = loadEventCatalogRegistry().current;
    // The pipeline can only ingest 'service' events directly; 'internal' ones
    // (extraction.corrected) arrive via the corrections route. The seed must
    // still land every catalog event type in the ledger.
    const expected = catalog.eventTypes();
    for (const eventType of expected) {
      expect(summary.eventTypesIngested).toContain(eventType);
    }
    // And no stray/unknown type leaked in.
    for (const eventType of summary.eventTypesIngested) {
      expect(expected).toContain(eventType);
    }
  });

  it("records the derived extraction.corrected event and every correction reason code", async () => {
    expect(summary.correctionReasonCodes).toEqual([
      "formatting",
      "incorrect_value",
      "misclassified",
      "missing_value",
      "other",
    ]);
    const derived = await connection.pool.query<{ change_kind: string; count: number }>(
      `select attrs->>'change_kind' as change_kind, count(*)::int as count
         from session_events
        where tenant_id = $1 and event_type = 'extraction.corrected'
        group by attrs->>'change_kind'`,
      [summary.tenantId],
    );
    const byChangeKind = new Map(derived.rows.map((row) => [row.change_kind, row.count]));
    // Five changed corrections and one unchanged (both change_kinds exercised).
    expect(byChangeKind.get("changed")).toBe(5);
    expect(byChangeKind.get("unchanged")).toBe(1);
  });

  it("stores no raw correction value — only hashes and policy-bounded previews", async () => {
    const rows = await connection.pool.query<{
      before_hash: string;
      after_hash: string;
      before_preview: string | null;
    }>(
      `select before_hash, after_hash, before_preview
         from adviser_corrections where tenant_id = $1`,
      [summary.tenantId],
    );
    expect(rows.rows.length).toBe(6);
    for (const row of rows.rows) {
      expect(row.before_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.after_hash).toMatch(/^[0-9a-f]{64}$/);
      // No raw seed value ("Jane Doe", "50000", ...) is a substring of a preview.
      if (row.before_preview) {
        expect(row.before_preview).not.toContain("Jane");
        expect(row.before_preview).not.toContain("50000");
      }
    }
  });

  it("records the declined and withdrawn consent decisions in the ledger", async () => {
    const declined = await connection.pool.query<{ count: number }>(
      `select count(*)::int as count from consent_ledger
        where tenant_id = $1 and session_id = $2
          and purpose = 'service_improvement_telemetry' and action = 'denied'`,
      [summary.tenantId, summary.sessionIds.declined],
    );
    expect(declined.rows[0]?.count).toBe(1);

    // The withdrawal flowed through the ingestion pipeline, which appended a
    // 'withdrawn' ledger row from the consent.withdrawn event.
    const withdrawn = await connection.pool.query<{ count: number }>(
      `select count(*)::int as count from consent_ledger
        where tenant_id = $1 and session_id = $2 and action = 'withdrawn'`,
      [summary.tenantId, summary.sessionIds.withdrawn],
    );
    expect(withdrawn.rows[0]?.count).toBe(1);
  });

  it("pins the active published module version at module.enter", async () => {
    const pins = await connection.pool.query<{ module_version_id: string | null }>(
      `select attrs->>'module_version_id' as module_version_id
         from session_events
        where tenant_id = $1 and event_type = 'module.enter'`,
      [summary.tenantId],
    );
    expect(pins.rows.length).toBeGreaterThan(0);
    for (const row of pins.rows) {
      // Every enter was stamped with one of the versions we published.
      expect(summary.moduleVersionIds).toContain(row.module_version_id);
    }
  });
});
