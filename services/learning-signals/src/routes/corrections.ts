import { randomUUID, timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { authenticationHook } from "../auth/tenant-context.js";
import type { DatabaseConnection } from "../db/client.js";
import { adviserCorrections, fieldExtractions } from "../db/schema.js";
import type { FieldPolicy } from "../privacy/field-policy.js";
import {
  FieldPolicyUnavailableError,
  normalizeFingerprintValue,
  pseudonymizeActor,
  sanitizeFieldValue,
  type RawFieldValue,
} from "../privacy/field-values.js";
import { redactFreeText } from "../privacy/redaction.js";
import {
  hmacSha256Hex,
  SecretsUnavailableError,
  type SecretsProvider,
  type TenantSecret,
} from "../privacy/secrets.js";
import {
  canonicalJson,
  sha256Hex,
  type JsonValue,
} from "../telemetry/canonical-json.js";
import type { Clock } from "../telemetry/clock.js";
import type { ConsentResolver } from "../telemetry/consent.js";
import type { EventCatalog } from "../telemetry/event-catalog.js";
import {
  carriesMismatchedTenant,
  hasOnlyOwnKeys,
  persistPreparedEvent,
  prepareEvent,
} from "../telemetry/ingestion-core.js";

const correctionReasonSchema = z.enum([
  "incorrect_value",
  "missing_value",
  "misclassified",
  "formatting",
  "other",
]);

const rawFieldValueSchema = z.union([
  z.string().max(4_096),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const correctionBodySchema = z
  .object({
    tenant_id: z.string().uuid().optional(),
    session_id: z.string().uuid(),
    extraction_id: z.string().uuid(),
    // Opaque UUIDs prevent this operational field becoming a caller-controlled
    // plaintext channel for answers or other identifying content.
    idempotency_key: z.string().uuid(),
    before_raw: rawFieldValueSchema,
    after_raw: rawFieldValueSchema,
    reason_code: correctionReasonSchema.optional(),
    note: z.string().max(4_096).optional(),
  })
  .strict();

const correctionBodyKeys = new Set([
  "tenant_id",
  "session_id",
  "extraction_id",
  "idempotency_key",
  "before_raw",
  "after_raw",
  "reason_code",
  "note",
]);

type CorrectionBody = z.infer<typeof correctionBodySchema>;
type CorrectionReason = z.infer<typeof correctionReasonSchema>;

type CorrectionOutcome =
  | { kind: "inserted" | "replay"; correctionId: string; extractionId: string }
  | { kind: "conflict" }
  | { kind: "not_found" };

export type CorrectionsRouteDependencies = {
  connection: DatabaseConnection;
  catalog: EventCatalog;
  clock: Clock;
  consentResolver: ConsentResolver;
  fieldPolicy: FieldPolicy;
  secretsProvider: SecretsProvider;
};

class DerivedCorrectionEventError extends Error {
  constructor() {
    super("The derived correction event could not be persisted.");
    this.name = "DerivedCorrectionEventError";
  }
}

function requestPayloadHash(
  tenantId: string,
  body: CorrectionBody,
  reasonCode: CorrectionReason,
  actorLabel: string,
  actorRole: string,
  secret: TenantSecret,
): string {
  const canonicalPayload: JsonValue = {
    tenant_id: tenantId.toLowerCase(),
    session_id: body.session_id.toLowerCase(),
    extraction_id: body.extraction_id.toLowerCase(),
    idempotency_key: body.idempotency_key.toLowerCase(),
    before: normalizeFingerprintValue(body.before_raw),
    after: normalizeFingerprintValue(body.after_raw),
    reason_code: reasonCode,
    actor_label: normalizeFingerprintValue(actorLabel),
    actor_role: actorRole,
    note:
      body.note === undefined ? null : normalizeFingerprintValue(body.note),
  };
  return hmacSha256Hex(
    secret.key,
    `planeir:correction-request:v1:${canonicalJson(canonicalPayload)}`,
  );
}

function hashesEqual(left: string, right: string): boolean {
  if (left.length !== 64 || right.length !== 64) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function reviewerRole(scopes: readonly string[]): string {
  return scopes.includes("admin") ? "admin" : "corrections";
}

async function prepareDerivedEvent(
  tenantId: string,
  correctionId: string,
  sessionId: string,
  valueClass: string,
  changeKind: "changed" | "unchanged",
  reasonCode: CorrectionReason,
  occurredAt: Date,
  dependencies: CorrectionsRouteDependencies,
) {
  const preparation = await prepareEvent(
    {
      event_id: correctionId,
      session_id: sessionId,
      event_type: "extraction.corrected",
      attrs: {
        value_class: valueClass,
        change_kind: changeKind,
        reason_code: reasonCode,
      },
      occurred_at: occurredAt.toISOString(),
    },
    0,
    tenantId,
    occurredAt,
    {
      catalog: dependencies.catalog,
      consentResolver: dependencies.consentResolver,
      allowInternalEvents: true,
    },
  );
  if (!preparation.prepared || preparation.result) {
    throw new DerivedCorrectionEventError();
  }
  return preparation.prepared;
}

export function registerCorrectionsRoutes(
  app: FastifyInstance,
  dependencies: CorrectionsRouteDependencies,
): void {
  app.post(
    "/v1/adviser-corrections",
    {
      bodyLimit: 32 * 1024,
      onRequest: authenticationHook(dependencies.connection, "corrections"),
    },
    async (request, reply) => {
      const tenantContext = request.tenantContext;
      if (!tenantContext) return;
      const actorLabel = tenantContext.actorLabel?.trim();
      if (!actorLabel) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      if (!hasOnlyOwnKeys(request.body, correctionBodyKeys)) {
        return reply.status(400).send({ error: "Invalid correction" });
      }
      if (carriesMismatchedTenant(request.body, tenantContext.tenantId)) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      const parsed = correctionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid correction" });
      }
      const body = parsed.data;
      const idempotencyKey = body.idempotency_key.toLowerCase();
      const reasonCode = body.reason_code ?? "other";
      const actorRole = reviewerRole(tenantContext.scopes);

      // Notes are deliberately ephemeral in the pilot. Local redaction is
      // exercised, but even its output is discarded and never reaches a row,
      // log field, span, error tracker, or third-party request.
      if (body.note !== undefined) void redactFreeText(body.note);

      try {
        const outcome = await dependencies.connection.db.transaction(
          async (transaction): Promise<CorrectionOutcome> => {
            const lockKey = sha256Hex(
              `${tenantContext.tenantId}:${idempotencyKey}`,
            );
            await transaction.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
            );

            const existingRows = await transaction
              .select({
                correctionId: adviserCorrections.correctionId,
                extractionId: adviserCorrections.extractionId,
                payloadHash: adviserCorrections.payloadHash,
                keyVersion: adviserCorrections.keyVersion,
                fieldPolicyVersion: adviserCorrections.fieldPolicyVersion,
              })
              .from(adviserCorrections)
              .where(
                and(
                  eq(adviserCorrections.tenantId, tenantContext.tenantId),
                  eq(adviserCorrections.idempotencyKey, idempotencyKey),
                ),
              )
              .limit(1);
            const existing = existingRows[0];
            if (existing) {
              if (existing.fieldPolicyVersion === "legacy-pre-policy") {
                return { kind: "conflict" };
              }
              const historicalSecret = await dependencies.secretsProvider.getSecret(
                tenantContext.tenantId,
                existing.keyVersion,
              );
              const replayHash = requestPayloadHash(
                tenantContext.tenantId,
                body,
                reasonCode,
                actorLabel,
                actorRole,
                historicalSecret,
              );
              return hashesEqual(existing.payloadHash, replayHash)
                ? {
                    kind: "replay",
                    correctionId: existing.correctionId,
                    extractionId: existing.extractionId,
                  }
                : { kind: "conflict" };
            }

            const extractions = await transaction
              .select({
                extractionId: fieldExtractions.extractionId,
                sessionId: fieldExtractions.sessionId,
                fieldPath: fieldExtractions.fieldPath,
              })
              .from(fieldExtractions)
              .where(
                and(
                  eq(fieldExtractions.tenantId, tenantContext.tenantId),
                  eq(fieldExtractions.extractionId, body.extraction_id),
                  eq(fieldExtractions.sessionId, body.session_id),
                ),
              )
              .limit(1)
              .for("update");
            const extraction = extractions[0];
            if (!extraction) return { kind: "not_found" };

            const currentSecret =
              await dependencies.secretsProvider.getCurrentSecret(
                tenantContext.tenantId,
              );
            const before = sanitizeFieldValue(
              extraction.fieldPath,
              body.before_raw as RawFieldValue,
              dependencies.fieldPolicy,
              currentSecret,
            );
            const after = sanitizeFieldValue(
              extraction.fieldPath,
              body.after_raw as RawFieldValue,
              dependencies.fieldPolicy,
              currentSecret,
            );
            const correctionId = randomUUID();
            const payloadHash = requestPayloadHash(
              tenantContext.tenantId,
              body,
              reasonCode,
              actorLabel,
              actorRole,
              currentSecret,
            );

            const inserted = await transaction
              .insert(adviserCorrections)
              .values({
                correctionId,
                tenantId: tenantContext.tenantId,
                sessionId: extraction.sessionId,
                extractionId: extraction.extractionId,
                idempotencyKey,
                payloadHash,
                beforeHash: before.normalizedValueHash,
                afterHash: after.normalizedValueHash,
                beforePreview: before.valuePreview,
                afterPreview: after.valuePreview,
                actorIdPseudo: pseudonymizeActor(
                  actorLabel,
                  currentSecret.key,
                ),
                keyVersion: currentSecret.keyVersion,
                fieldPolicyVersion: dependencies.fieldPolicy.version,
                reviewerRole: actorRole,
                reasonCode,
              })
              .onConflictDoNothing({
                target: [
                  adviserCorrections.tenantId,
                  adviserCorrections.idempotencyKey,
                ],
              })
              .returning({ correctionId: adviserCorrections.correctionId });
            if (!inserted[0]) throw new DerivedCorrectionEventError();

            await transaction
              .update(fieldExtractions)
              .set({ extractionStatus: "corrected" })
              .where(
                and(
                  eq(fieldExtractions.tenantId, tenantContext.tenantId),
                  eq(fieldExtractions.extractionId, extraction.extractionId),
                ),
              );

            const occurredAt = dependencies.clock.now();
            const derivedEvent = await prepareDerivedEvent(
              tenantContext.tenantId,
              correctionId,
              extraction.sessionId,
              after.valueClass,
              hashesEqual(before.normalizedValueHash, after.normalizedValueHash)
                ? "unchanged"
                : "changed",
              reasonCode,
              occurredAt,
              dependencies,
            );
            const eventResult = await persistPreparedEvent(
              transaction,
              tenantContext.tenantId,
              derivedEvent,
              dependencies.catalog.version,
            );
            if (eventResult.status !== "inserted") {
              throw new DerivedCorrectionEventError();
            }

            return {
              kind: "inserted",
              correctionId,
              extractionId: extraction.extractionId,
            };
          },
        );

        if (outcome.kind === "not_found") {
          return reply.status(404).send({ error: "Not found" });
        }
        if (outcome.kind === "conflict") {
          return reply
            .status(409)
            .send({ error: "same idempotency_key, different payload" });
        }
        return reply.status(outcome.kind === "inserted" ? 201 : 200).send({
          correction_id: outcome.correctionId,
          extraction_id: outcome.extractionId,
          status: "corrected",
          replayed: outcome.kind === "replay",
        });
      } catch (error) {
        if (error instanceof FieldPolicyUnavailableError) {
          return reply.status(400).send({ error: "Field policy unavailable" });
        }
        if (error instanceof SecretsUnavailableError) {
          return reply.status(503).send({ error: "Tenant secret unavailable" });
        }
        throw error;
      }
    },
  );
}
