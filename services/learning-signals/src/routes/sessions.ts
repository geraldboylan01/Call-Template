import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { authenticationHook } from "../auth/tenant-context.js";
import type { DatabaseConnection } from "../db/client.js";
import { factFindSessions, moduleVersions } from "../db/schema.js";
import { pseudonymizeIdentifier } from "../privacy/field-values.js";
import {
  SecretsUnavailableError,
  type SecretsProvider,
} from "../privacy/secrets.js";
import {
  carriesMismatchedTenant,
  hasOnlyOwnKeys,
} from "../telemetry/ingestion-core.js";

// Opening a session is the one piece of session state that must exist before
// any event can be ingested (the ledger is append-only; the session row is
// state). The voice orchestrator calls this at the start of a fact-find. The
// subject is pseudonymised server-side with the tenant's managed key so the
// raw reference never lands in the store and destroying the key (crypto-
// shredding) unlinks it — the same model M4 erasure relies on.
const sessionBodySchema = z
  .object({
    tenant_id: z.string().uuid().optional(),
    session_id: z.string().uuid().optional(),
    module_id: z.string().uuid(),
    // An opaque, non-identifying reference the caller controls (e.g. its own
    // session or client id). A stable client ref links a returning client
    // across sessions; a per-session ref maximises isolation. It is HMAC'd and
    // never stored.
    subject_ref: z.string().min(1).max(256),
  })
  .strict();

const sessionBodyKeys = new Set([
  "tenant_id",
  "session_id",
  "module_id",
  "subject_ref",
]);

export type SessionRouteDependencies = {
  connection: DatabaseConnection;
  secretsProvider: SecretsProvider;
};

export function registerSessionRoutes(
  app: FastifyInstance,
  dependencies: SessionRouteDependencies,
): void {
  app.post(
    "/v1/sessions",
    {
      bodyLimit: 16 * 1024,
      onRequest: authenticationHook(dependencies.connection, "ingest"),
    },
    async (request, reply) => {
      const tenantContext = request.tenantContext;
      if (!tenantContext) return;

      if (!hasOnlyOwnKeys(request.body, sessionBodyKeys)) {
        return reply.status(400).send({ error: "Invalid session" });
      }
      if (carriesMismatchedTenant(request.body, tenantContext.tenantId)) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      const parsed = sessionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid session" });
      }
      const body = parsed.data;
      const moduleId = body.module_id.toLowerCase();

      // The session's entry version is the module's active published version.
      // A foreign or unpublished module returns 404 (do not leak existence).
      const activeVersions = await dependencies.connection.db
        .select({ moduleVersionId: moduleVersions.moduleVersionId })
        .from(moduleVersions)
        .where(
          and(
            eq(moduleVersions.tenantId, tenantContext.tenantId),
            eq(moduleVersions.moduleId, moduleId),
            eq(moduleVersions.status, "published"),
          ),
        )
        .orderBy(
          desc(moduleVersions.publishedAt),
          desc(moduleVersions.createdAt),
          desc(moduleVersions.moduleVersionId),
        )
        .limit(1);
      const moduleVersionId = activeVersions[0]?.moduleVersionId;
      if (!moduleVersionId) {
        return reply.status(404).send({ error: "Not found" });
      }

      let pseudonymousSubjectId: string;
      let keyVersion: number;
      try {
        const secret = await dependencies.secretsProvider.getCurrentSecret(
          tenantContext.tenantId,
        );
        pseudonymousSubjectId = pseudonymizeIdentifier(body.subject_ref, secret.key);
        keyVersion = secret.keyVersion;
      } catch (error) {
        if (error instanceof SecretsUnavailableError) {
          return reply.status(503).send({ error: "Tenant secret unavailable" });
        }
        throw error;
      }

      const sessionId = (body.session_id ?? randomUUID()).toLowerCase();
      const inserted = await dependencies.connection.db
        .insert(factFindSessions)
        .values({
          sessionId,
          tenantId: tenantContext.tenantId,
          moduleVersionId,
          pseudonymousSubjectId,
          keyVersion,
        })
        .onConflictDoNothing({
          target: [factFindSessions.tenantId, factFindSessions.sessionId],
        })
        .returning({ sessionId: factFindSessions.sessionId });

      if (inserted[0]) {
        return reply.status(201).send({
          session_id: sessionId,
          module_version_id: moduleVersionId,
          key_version: keyVersion,
          status: "started",
          replayed: false,
        });
      }

      // Idempotent open: the session already exists for this tenant. Return it
      // as it stands rather than overwriting anything.
      const existingRows = await dependencies.connection.db
        .select({
          moduleVersionId: factFindSessions.moduleVersionId,
          keyVersion: factFindSessions.keyVersion,
          status: factFindSessions.status,
        })
        .from(factFindSessions)
        .where(
          and(
            eq(factFindSessions.tenantId, tenantContext.tenantId),
            eq(factFindSessions.sessionId, sessionId),
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      if (!existing) throw new Error("Session insert lost its row.");
      return reply.status(200).send({
        session_id: sessionId,
        module_version_id: existing.moduleVersionId,
        key_version: existing.keyVersion,
        status: existing.status,
        replayed: true,
      });
    },
  );
}
