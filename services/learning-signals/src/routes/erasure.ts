import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { authenticationHook } from "../auth/tenant-context.js";
import type { DatabaseConnection } from "../db/client.js";
import type { SubjectErasureService } from "../privacy/erasure.js";
import { SecretsUnavailableError } from "../privacy/secrets.js";
import {
  carriesMismatchedTenant,
  hasOnlyOwnKeys,
} from "../telemetry/ingestion-core.js";

const erasureBodyKeys = new Set(["tenant_id", "subject_identifier"]);

const erasureBodySchema = z
  .object({
    tenant_id: z.string().uuid().optional(),
    subject_identifier: z.string().min(1).max(512),
  })
  .strict();

export type ErasureRouteDependencies = {
  connection: DatabaseConnection;
  erasureService: SubjectErasureService;
};

function hasMeaningfulIdentifier(value: string): boolean {
  return (
    value
      .normalize("NFKC")
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .replace(/\s+/gu, " ")
      .trim().length > 0
  );
}

export function registerErasureRoutes(
  app: FastifyInstance,
  dependencies: ErasureRouteDependencies,
): void {
  app.post(
    "/v1/subjects/erasure-requests",
    {
      bodyLimit: 4 * 1024,
      onRequest: authenticationHook(dependencies.connection, "admin"),
    },
    async (request, reply) => {
      const tenantContext = request.tenantContext;
      if (!tenantContext) return;
      const actorLabel = tenantContext.actorLabel?.trim();
      if (!actorLabel) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      if (!hasOnlyOwnKeys(request.body, erasureBodyKeys)) {
        return reply.status(400).send({ error: "Invalid erasure request" });
      }
      if (carriesMismatchedTenant(request.body, tenantContext.tenantId)) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      const parsed = erasureBodySchema.safeParse(request.body);
      if (
        !parsed.success ||
        !hasMeaningfulIdentifier(parsed.data.subject_identifier)
      ) {
        return reply.status(400).send({ error: "Invalid erasure request" });
      }

      try {
        const result = await dependencies.erasureService.requestErasure({
          tenantId: tenantContext.tenantId,
          actorLabel,
          rawSubjectIdentifier: parsed.data.subject_identifier,
        });
        return reply.status(202).send({
          erasure_request_id: result.requestId,
          status: result.status,
        });
      } catch (error) {
        if (error instanceof SecretsUnavailableError) {
          return reply.status(503).send({
            error: "Tenant secret unavailable",
          });
        }
        throw error;
      }
    },
  );
}
