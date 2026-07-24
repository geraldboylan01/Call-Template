import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { authenticationHook } from "../auth/tenant-context.js";
import type { DatabaseConnection } from "../db/client.js";
import { moduleVersions } from "../db/schema.js";
import {
  NoopObservabilitySpanSink,
  type ObservabilitySpanSink,
} from "../sinks/observability-spans.js";
import type { Clock } from "../telemetry/clock.js";
import type { ConsentResolver } from "../telemetry/consent.js";
import type { EventCatalog } from "../telemetry/event-catalog.js";
import {
  carriesMismatchedTenant,
  hasOnlyOwnKeys,
  persistPreparedEvent,
  prepareEvent,
  type IngestionResult,
  type PreparedEvent,
} from "../telemetry/ingestion-core.js";
import type { IngestionMetrics } from "../telemetry/metrics.js";

const batchSchema = z
  .object({
    tenant_id: z.unknown().optional(),
    events: z.array(z.unknown()).min(1).max(500),
  })
  .strict();

const batchKeys = new Set(["tenant_id", "events"]);

export type TelemetryRouteDependencies = {
  connection: DatabaseConnection;
  catalog: EventCatalog;
  clock: Clock;
  consentResolver: ConsentResolver;
  metrics: IngestionMetrics;
  spans?: ObservabilitySpanSink;
};

export function registerTelemetryRoutes(
  app: FastifyInstance,
  dependencies: TelemetryRouteDependencies,
): void {
  app.post(
    "/v1/telemetry/events",
    {
      bodyLimit: 3 * 1024 * 1024,
      onRequest: authenticationHook(dependencies.connection, "ingest"),
    },
    async (request, reply) => {
      const tenantContext = request.tenantContext;
      if (!tenantContext) return;

      if (!hasOnlyOwnKeys(request.body, batchKeys)) {
        return reply.status(400).send({ error: "Invalid event batch" });
      }
      const batchResult = batchSchema.safeParse(request.body);
      if (!batchResult.success) {
        return reply.status(400).send({ error: "Invalid event batch" });
      }
      if (
        carriesMismatchedTenant(batchResult.data, tenantContext.tenantId) ||
        batchResult.data.events.some((raw) =>
          carriesMismatchedTenant(raw, tenantContext.tenantId),
        )
      ) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      const requestNow = dependencies.clock.now();
      const results: Array<IngestionResult | undefined> = new Array(
        batchResult.data.events.length,
      );
      const preparedEvents: PreparedEvent[] = [];
      for (const [index, raw] of batchResult.data.events.entries()) {
        const preparation = await prepareEvent(
          raw,
          index,
          tenantContext.tenantId,
          requestNow,
          dependencies,
        );
        if (preparation.result) results[index] = preparation.result;
        if (preparation.prepared) preparedEvents.push(preparation.prepared);
      }

      let conflictCount = 0;
      if (preparedEvents.length > 0) {
        await dependencies.connection.db.transaction(async (transaction) => {
          for (const event of preparedEvents.toSorted(
            (left, right) =>
              left.sessionId.localeCompare(right.sessionId) ||
              left.eventId.localeCompare(right.eventId),
          )) {
            const result = await persistPreparedEvent(
              transaction,
              tenantContext.tenantId,
              event,
              dependencies.catalog,
            );
            results[event.index] = result;
            if (result.status === "conflict") conflictCount += 1;
          }
        });
      }

      for (let index = 0; index < conflictCount; index += 1) {
        dependencies.metrics.incrementIdempotencyConflict(tenantContext.tenantId);
      }

      // Operational span: batch and outcome counts only, never event content.
      let insertedCount = 0;
      let invalidCount = 0;
      for (const result of results) {
        if (result?.status === "inserted") insertedCount += 1;
        else if (result?.status === "invalid") invalidCount += 1;
      }
      (dependencies.spans ?? new NoopObservabilitySpanSink()).record({
        name: "learning_signals.ingest_batch",
        attributes: {
          tenant_id: tenantContext.tenantId,
          batch_size: results.length,
          inserted: insertedCount,
          invalid: invalidCount,
          conflicts: conflictCount,
        },
      });
      return reply.status(207).send({ results: results as IngestionResult[] });
    },
  );

  app.get(
    "/internal/metrics",
    { onRequest: authenticationHook(dependencies.connection, "admin") },
    async (request, reply) => {
      const tenantContext = request.tenantContext;
      if (!tenantContext) return;
      const conflictCount = dependencies.metrics.getIdempotencyConflictCount(
        tenantContext.tenantId,
      );
      return reply
        .type("text/plain; version=0.0.4; charset=utf-8")
        .send(
          [
            "# HELP planeir_telemetry_idempotency_conflicts_total Conflicting replays requiring alerting.",
            "# TYPE planeir_telemetry_idempotency_conflicts_total counter",
            `planeir_telemetry_idempotency_conflicts_total ${conflictCount}`,
            "",
          ].join("\n"),
        );
    },
  );

  app.get(
    "/v1/module-versions/:moduleVersionId",
    { onRequest: authenticationHook(dependencies.connection) },
    async (request, reply) => {
      const tenantContext = request.tenantContext;
      if (!tenantContext) return;
      const params = z
        .object({ moduleVersionId: z.string().uuid() })
        .safeParse(request.params);
      if (!params.success) return reply.status(404).send({ error: "Not found" });

      const rows = await dependencies.connection.db
        .select({
          moduleVersionId: moduleVersions.moduleVersionId,
          moduleId: moduleVersions.moduleId,
          semanticVersion: moduleVersions.semanticVersion,
          status: moduleVersions.status,
        })
        .from(moduleVersions)
        .where(
          and(
            eq(moduleVersions.tenantId, tenantContext.tenantId),
            eq(moduleVersions.moduleVersionId, params.data.moduleVersionId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return reply.status(404).send({ error: "Not found" });
      return reply.send({
        module_version_id: row.moduleVersionId,
        module_id: row.moduleId,
        semantic_version: row.semanticVersion,
        status: row.status,
      });
    },
  );
}
