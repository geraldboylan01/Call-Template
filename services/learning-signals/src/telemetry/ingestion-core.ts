import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { DatabaseTransaction } from "../db/client.js";
import {
  consentLedger,
  factFindSessions,
  moduleVersions,
  sessionEvents,
  telemetryOutbox,
} from "../db/schema.js";
import { canonicalJson, sha256Hex, type JsonValue } from "./canonical-json.js";
import {
  consentGate,
  type ConsentResolver,
  type ConsentStateResolver,
  type EventConsentClassification,
} from "./consent.js";
import type { EventAttributes, EventCatalog } from "./event-catalog.js";

const attrsObjectSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);

const eventEnvelopeSchema = z
  .object({
    tenant_id: z.string().uuid().optional(),
    event_id: z.string().uuid(),
    session_id: z.string().uuid(),
    event_type: z.string().min(1).max(120),
    attrs: attrsObjectSchema.default({}),
    occurred_at: z.string().datetime({ offset: true }),
    turn_index: z.number().int().nonnegative().max(2_147_483_647).nullable().optional(),
    duration_ms: z.number().int().nonnegative().max(2_147_483_647).nullable().optional(),
  })
  .strict();

const eventEnvelopeKeys = new Set([
  "tenant_id",
  "event_id",
  "session_id",
  "event_type",
  "attrs",
  "occurred_at",
  "turn_index",
  "duration_ms",
]);

type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export type IngestionResult =
  | { event_id: string; status: "inserted" | "duplicate" }
  | { event_id: string; status: "conflict" | "invalid"; error: string };

export type PreparedEvent = {
  index: number;
  eventId: string;
  sessionId: string;
  eventType: string;
  occurredAt: Date;
  turnIndex: number | null;
  durationMs: number | null;
  clientAttrs: EventAttributes;
  persistedAttrs: EventAttributes;
  payloadHash: string;
  consentClassification: EventConsentClassification | undefined;
  consentStateResolver: ConsentStateResolver | undefined;
};

export type IngestionCoreDependencies = {
  catalog: EventCatalog;
  consentResolver: ConsentResolver;
  allowInternalEvents?: boolean;
};

function rawEventId(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "unknown";
  const record = raw as Record<string, unknown>;
  if (!Object.hasOwn(record, "event_id")) return "unknown";
  const value = record.event_id;
  return typeof value === "string" && value.length <= 128 ? value : "unknown";
}

export function hasOnlyOwnKeys(
  raw: unknown,
  allowedKeys: ReadonlySet<string>,
): raw is Record<string, unknown> {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    Object.keys(raw).every((key) => allowedKeys.has(key))
  );
}

export function carriesMismatchedTenant(raw: unknown, tenantId: string): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  return (
    Object.hasOwn(record, "tenant_id") &&
    (typeof record.tenant_id !== "string" ||
      record.tenant_id.toLowerCase() !== tenantId.toLowerCase())
  );
}

function clientPayloadHash(tenantId: string, event: PreparedEvent): string {
  const canonicalEnvelope: JsonValue = {
    tenant_id: tenantId.toLowerCase(),
    event_id: event.eventId.toLowerCase(),
    session_id: event.sessionId.toLowerCase(),
    event_type: event.eventType,
    occurred_at: event.occurredAt.toISOString(),
    turn_index: event.turnIndex,
    duration_ms: event.durationMs,
    attrs: event.clientAttrs,
  };
  return sha256Hex(canonicalJson(canonicalEnvelope));
}

function supportsCurrentStateResolution(
  resolver: ConsentResolver,
): resolver is ConsentResolver & ConsentStateResolver {
  const candidate = resolver as Partial<ConsentStateResolver>;
  return (
    typeof candidate.resolveCurrent === "function" &&
    typeof candidate.resolveCurrentWithClient === "function"
  );
}

export async function prepareEvent(
  raw: unknown,
  index: number,
  tenantId: string,
  requestNow: Date,
  dependencies: IngestionCoreDependencies,
): Promise<{ prepared?: PreparedEvent; result?: IngestionResult }> {
  const eventId = rawEventId(raw);
  if (!hasOnlyOwnKeys(raw, eventEnvelopeKeys)) {
    return {
      result: { event_id: eventId, status: "invalid", error: "event envelope invalid" },
    };
  }
  const parsed = eventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      result: { event_id: eventId, status: "invalid", error: "event envelope invalid" },
    };
  }

  const event: EventEnvelope = parsed.data;
  if (
    !dependencies.allowInternalEvents &&
    !dependencies.catalog.isServiceIngestible(event.event_type)
  ) {
    return {
      result: {
        event_id: event.event_id,
        status: "invalid",
        error: "event_type not allowed",
      },
    };
  }
  const occurredAt = new Date(event.occurred_at);
  if (occurredAt.getTime() > requestNow.getTime() + 5 * 60 * 1000) {
    return {
      result: {
        event_id: event.event_id,
        status: "invalid",
        error: "occurred_at is more than 5 minutes in the future",
      },
    };
  }

  const isLate = occurredAt.getTime() < requestNow.getTime() - 48 * 60 * 60 * 1000;
  const attrsResult = dependencies.catalog.validateIncoming(
    event.event_type,
    event.attrs,
    isLate,
  );
  if (!attrsResult.ok) {
    return {
      result: {
        event_id: event.event_id,
        status: "invalid",
        error: attrsResult.error,
      },
    };
  }

  const consentClassification = dependencies.catalog.consentClassification(
    event.event_type,
  );
  const consentStateResolver = supportsCurrentStateResolution(
    dependencies.consentResolver,
  )
    ? dependencies.consentResolver
    : undefined;

  if (consentClassification === undefined) {
    // Historical v1/v2 catalogs are still accepted for replay and migration
    // tests. They retain their original essential-only behavior. All current
    // M4 catalog events are required to carry a closed classification.
    const consentGranted =
      dependencies.catalog.isEssential(event.event_type) ||
      (await dependencies.consentResolver.canPersist({
        tenantId,
        sessionId: event.session_id,
        eventType: event.event_type,
        scope: "essential",
      }));
    if (!consentGranted) {
      return {
        result: {
          event_id: event.event_id,
          status: "invalid",
          error: "consent scope not granted",
        },
      };
    }
  }

  const prepared: PreparedEvent = {
    index,
    eventId: event.event_id,
    sessionId: event.session_id,
    eventType: event.event_type,
    occurredAt,
    turnIndex: event.turn_index ?? null,
    durationMs: event.duration_ms ?? null,
    clientAttrs: attrsResult.value.clientAttrs,
    persistedAttrs: attrsResult.value.persistedAttrs,
    payloadHash: "",
    consentClassification,
    consentStateResolver,
  };
  prepared.payloadHash = clientPayloadHash(tenantId, prepared);
  return { prepared };
}

/**
 * Resolves the module version a `module.enter` event pins and stamps it into
 * the persisted attributes. The first persisted enter of a module inside a
 * session resolves the then-active published version; later enters of the
 * same module in the same session reuse that pin, so a mid-session publish
 * never changes a session's attribution. Runs after the fact_find_sessions
 * row lock, which serializes concurrent enters of one session.
 */
async function pinModuleVersion(
  transaction: DatabaseTransaction,
  tenantId: string,
  event: PreparedEvent,
  catalog: EventCatalog,
): Promise<IngestionResult | undefined> {
  const moduleId = event.persistedAttrs.module_id;
  if (typeof moduleId !== "string") {
    throw new Error("Validated module entry is missing its module id.");
  }

  const priorPins = await transaction
    .select({
      moduleVersionId: sql<string | null>`${sessionEvents.attrs}->>'module_version_id'`,
    })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, tenantId),
        eq(sessionEvents.sessionId, event.sessionId),
        eq(sessionEvents.eventType, "module.enter"),
        sql`${sessionEvents.attrs}->>'module_id' = ${moduleId}`,
      ),
    )
    .orderBy(asc(sessionEvents.createdAt), asc(sessionEvents.eventId))
    .limit(1);

  let pinnedVersionId = priorPins[0]?.moduleVersionId ?? undefined;
  if (pinnedVersionId === undefined) {
    const activeVersions = await transaction
      .select({ moduleVersionId: moduleVersions.moduleVersionId })
      .from(moduleVersions)
      .where(
        and(
          eq(moduleVersions.tenantId, tenantId),
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
    pinnedVersionId = activeVersions[0]?.moduleVersionId;
    if (pinnedVersionId === undefined) {
      return {
        event_id: event.eventId,
        status: "invalid",
        error: "module_id has no published version",
      };
    }
  }

  event.persistedAttrs = catalog.withServerAttributes(
    event.eventType,
    event.persistedAttrs,
    { module_version_id: pinnedVersionId },
  );
  return undefined;
}

export async function persistPreparedEvent(
  transaction: DatabaseTransaction,
  tenantId: string,
  event: PreparedEvent,
  catalog: EventCatalog,
): Promise<IngestionResult> {
  const session = await transaction
    .select({ sessionId: factFindSessions.sessionId })
    .from(factFindSessions)
    .where(
      and(
        eq(factFindSessions.tenantId, tenantId),
        eq(factFindSessions.sessionId, event.sessionId),
      ),
    )
    .limit(1)
    .for("update");
  if (session.length === 0) {
    return {
      event_id: event.eventId,
      status: "invalid",
      error: "session_id not found",
    };
  }

  if (event.eventType === "module.enter") {
    const pinFailure = await pinModuleVersion(transaction, tenantId, event, catalog);
    if (pinFailure) return pinFailure;
  }

  if (event.consentClassification !== undefined) {
    // A legacy test double cannot assert acceptance for consent-dependent
    // classes. Treat it as an empty state (fail closed) while still allowing
    // contract/improvement persistence under their non-consent legal bases.
    const consentState = event.consentStateResolver
      ? await event.consentStateResolver.resolveCurrent(transaction, {
          tenantId,
          sessionId: event.sessionId,
        })
      : {};
    const gate = consentGate(
      {
        eventType: event.eventType,
        classification: event.consentClassification,
      },
      consentState,
    );
    if (!gate.persist) {
      return {
        event_id: event.eventId,
        status: "invalid",
        error: "consent scope not granted",
      };
    }
  }

  const inserted = await transaction
    .insert(sessionEvents)
    .values({
      tenantId,
      eventId: event.eventId,
      sessionId: event.sessionId,
      eventType: event.eventType,
      ingestionKey: sha256Hex(`${tenantId}:${event.eventId}`),
      payloadHash: event.payloadHash,
      attrs: event.persistedAttrs,
      occurredAt: event.occurredAt,
      turnIndex: event.turnIndex,
      durationMs: event.durationMs,
    })
    .onConflictDoNothing()
    .returning({ receivedAt: sessionEvents.receivedAt });

  if (inserted[0]) {
    if (event.eventType === "consent.withdrawn") {
      const consentType = event.persistedAttrs.consent_type;
      if (typeof consentType !== "string") {
        throw new Error("Validated consent withdrawal is missing its consent type.");
      }
      await transaction.insert(consentLedger).values({
        tenantId,
        sessionId: event.sessionId,
        purpose: consentType,
        action: "withdrawn",
        policyVersion: "telemetry-consent-v1",
        noticeId: "telemetry-consent-notice-v1",
        evidenceHash: event.payloadHash,
        occurredAt: event.occurredAt,
        decisionTs: event.occurredAt,
        receivedAt: inserted[0].receivedAt,
      });
    }
    await transaction.insert(telemetryOutbox).values({
      tenantId,
      eventId: event.eventId,
      configVersion: catalog.version,
    });
    return { event_id: event.eventId, status: "inserted" };
  }

  const existing = await transaction
    .select({ payloadHash: sessionEvents.payloadHash })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, tenantId),
        eq(sessionEvents.eventId, event.eventId),
      ),
    )
    .limit(1);
  if (existing[0]?.payloadHash === event.payloadHash) {
    return { event_id: event.eventId, status: "duplicate" };
  }
  return {
    event_id: event.eventId,
    status: "conflict",
    error: "same event_id, different payload",
  };
}
