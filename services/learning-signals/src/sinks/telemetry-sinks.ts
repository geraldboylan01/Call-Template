import { sha256Hex, type JsonPrimitive } from "../telemetry/canonical-json.js";
import type { ServiceConfig } from "../config.js";
import {
  loadObservabilityConfig,
  type ObservabilityConfig,
} from "./observability-config.js";

export type ForwardedTelemetryEvent = {
  deliveryId: string;
  eventId: string;
  // Opaque per-session analytics id (see analyticsSessionId). The RAW
  // session_id is deliberately never placed on the forwarded event, so no
  // sink can leak it — PostHog groups by this opaque id instead.
  analyticsSessionId: string;
  eventType: string;
  occurredAt: string;
  receivedAt: string;
  properties: Record<string, JsonPrimitive>;
};

/**
 * Opaque, deterministic, per-session analytics id used as the PostHog
 * distinct_id. Derived from the internal session_id under a fixed namespace so
 * it groups a session's events for funnels without exposing the raw session_id
 * to PostHog, and it is never the `pseudonymous_subject_id`. One-way: PostHog
 * cannot recover the session_id, and no subject identifier is involved.
 */
export function analyticsSessionId(sessionId: string): string {
  const hex = sha256Hex(`planeir:posthog-distinct:v1:${sessionId.toLowerCase()}`);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export type PostHogCapture = {
  event: string;
  timestamp: string;
  properties: Record<string, JsonPrimitive>;
};

/**
 * Builds the PostHog capture body for a forwarded event. Anonymous-only:
 * `$process_person_profile` is forced false, `distinct_id` is the opaque
 * per-session id, and ONLY properties on the configured allowlist survive — a
 * deny-by-default boundary independent of what the catalog projected. No
 * identify/alias/group and no subject identifier can be produced here.
 */
export function buildPostHogCapture(
  event: ForwardedTelemetryEvent,
  propertyAllowlist: ReadonlySet<string>,
): PostHogCapture {
  const properties: Record<string, JsonPrimitive> = {
    distinct_id: event.analyticsSessionId,
    $insert_id: `${event.deliveryId}:posthog`,
    // Keeps every event anonymous — PostHog creates no person profile and the
    // distinct_id is never merged with an identity.
    $process_person_profile: false,
  };
  for (const [key, value] of Object.entries(event.properties)) {
    if (value !== null && propertyAllowlist.has(key)) properties[key] = value;
  }
  return { event: event.eventType, timestamp: event.receivedAt, properties };
}

export interface PostHogSink {
  capture(event: ForwardedTelemetryEvent): Promise<void>;
}

export interface OtelSpanSink {
  exportSpan(event: ForwardedTelemetryEvent): Promise<void>;
}

export type SubjectDeletionRequest = {
  deletionId: string;
  tenantId: string;
  /**
   * Tenant-namespaced, one-way identifiers derived from every retained
   * subject-key version. Raw subject identifiers never cross this boundary.
   */
  externalSubjectIds: readonly string[];
  externalSubjectKeyVersions: readonly number[];
  /**
   * Opaque session UUIDs let a trace backend remove historical pilot spans
   * which predate subject-aware trace attributes.
   */
  sessionIds: readonly string[];
};

/**
 * M4's rights-deletion capability. Kept as a strict extension so existing
 * capture-only M2 test doubles remain valid PostHogSink implementations.
 */
export interface AnalyticsSink extends PostHogSink {
  deletePerson(request: SubjectDeletionRequest): Promise<void>;
}

/**
 * M4's trace-deletion capability. OTLP itself has no standard deletion RPC,
 * so a configured exporter must supply a backend-specific implementation.
 */
export interface TraceSink extends OtelSpanSink {
  deleteTraces(request: SubjectDeletionRequest): Promise<void>;
}

/**
 * A masked Langfuse generation trace. Metadata only: model, token counts,
 * latency, cost, and opaque ids. No prompt, completion, input, or output text
 * ever appears — that is the whole point of routing Langfuse through our own
 * interface. Keys are the snake_case allowlist from observability config.
 */
export type LangfuseGeneration = Record<string, JsonPrimitive>;

/**
 * The masking function registered on the Langfuse boundary. Langfuse's default
 * behavior captures full prompts/completions; for Planeir that would be the
 * raw fact-find conversation. This keeps EXACTLY the allowlisted metadata
 * fields (dropping `gen_ai.prompt.*`, `gen_ai.completion.*`, `input`,
 * `output`, and any unknown key) and coerces to primitives, so no content can
 * survive even if a caller passes it.
 */
export function maskLangfuseGeneration(
  raw: Record<string, unknown>,
  fieldAllowlist: ReadonlySet<string>,
): LangfuseGeneration {
  const masked: LangfuseGeneration = {};
  for (const key of fieldAllowlist) {
    const value = raw[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      masked[key] = value;
    }
  }
  return masked;
}

export interface LangfuseSink {
  captureGeneration(generation: LangfuseGeneration): Promise<void>;
}

export type TenantKeyRequest = {
  tenantId: string;
  keyVersion: number;
};

export interface KmsSink {
  resolveTenantKey(request: TenantKeyRequest): Promise<Uint8Array | null>;
}

export type DlpInspectionResult = {
  allowed: boolean;
  categories: string[];
};

export interface DlpSink {
  inspect(event: ForwardedTelemetryEvent): Promise<DlpInspectionResult>;
}

export class NoopPostHogSink implements AnalyticsSink {
  async capture(_event: ForwardedTelemetryEvent): Promise<void> {}

  async deletePerson(_request: SubjectDeletionRequest): Promise<void> {}
}

export class NoopOtelSpanSink implements TraceSink {
  async exportSpan(_event: ForwardedTelemetryEvent): Promise<void> {}

  async deleteTraces(_request: SubjectDeletionRequest): Promise<void> {}
}

export class NoopLangfuseSink implements LangfuseSink {
  async captureGeneration(_generation: LangfuseGeneration): Promise<void> {}
}

export class NoopKmsSink implements KmsSink {
  async resolveTenantKey(_request: TenantKeyRequest): Promise<null> {
    return null;
  }
}

export class NoopDlpSink implements DlpSink {
  async inspect(_event: ForwardedTelemetryEvent): Promise<DlpInspectionResult> {
    return { allowed: true, categories: [] };
  }
}

export class RecordingPostHogSink implements AnalyticsSink {
  readonly attempts: ForwardedTelemetryEvent[] = [];
  readonly successes: ForwardedTelemetryEvent[] = [];
  readonly deletionAttempts: SubjectDeletionRequest[] = [];
  readonly deletionSuccesses: SubjectDeletionRequest[] = [];
  private remainingFailures: number;
  private remainingDeletionFailures: number;

  constructor(failuresBeforeSuccess = 0, deletionFailuresBeforeSuccess = 0) {
    this.remainingFailures = failuresBeforeSuccess;
    this.remainingDeletionFailures = deletionFailuresBeforeSuccess;
  }

  async capture(event: ForwardedTelemetryEvent): Promise<void> {
    const captured = structuredClone(event);
    this.attempts.push(captured);
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("PostHog recording sink configured failure.");
    }
    this.successes.push(captured);
  }

  async deletePerson(request: SubjectDeletionRequest): Promise<void> {
    const captured = structuredClone(request);
    this.deletionAttempts.push(captured);
    if (this.remainingDeletionFailures > 0) {
      this.remainingDeletionFailures -= 1;
      throw new Error("PostHog recording sink configured deletion failure.");
    }
    this.deletionSuccesses.push(captured);
  }
}

export class RecordingOtelSpanSink implements TraceSink {
  readonly attempts: ForwardedTelemetryEvent[] = [];
  readonly successes: ForwardedTelemetryEvent[] = [];
  readonly deletionAttempts: SubjectDeletionRequest[] = [];
  readonly deletionSuccesses: SubjectDeletionRequest[] = [];
  private remainingFailures: number;
  private remainingDeletionFailures: number;

  constructor(failuresBeforeSuccess = 0, deletionFailuresBeforeSuccess = 0) {
    this.remainingFailures = failuresBeforeSuccess;
    this.remainingDeletionFailures = deletionFailuresBeforeSuccess;
  }

  async exportSpan(event: ForwardedTelemetryEvent): Promise<void> {
    const captured = structuredClone(event);
    this.attempts.push(captured);
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("OTel recording sink configured failure.");
    }
    this.successes.push(captured);
  }

  async deleteTraces(request: SubjectDeletionRequest): Promise<void> {
    const captured = structuredClone(request);
    this.deletionAttempts.push(captured);
    if (this.remainingDeletionFailures > 0) {
      this.remainingDeletionFailures -= 1;
      throw new Error("OTel recording sink configured deletion failure.");
    }
    this.deletionSuccesses.push(captured);
  }
}

export class RecordingLangfuseSink implements LangfuseSink {
  readonly attempts: LangfuseGeneration[] = [];

  async captureGeneration(generation: LangfuseGeneration): Promise<void> {
    this.attempts.push(structuredClone(generation));
  }
}

export class RecordingKmsSink implements KmsSink {
  readonly requests: TenantKeyRequest[] = [];
  private readonly key: Uint8Array | null;

  constructor(key: Uint8Array | null = null) {
    this.key = key ? structuredClone(key) : null;
  }

  async resolveTenantKey(request: TenantKeyRequest): Promise<Uint8Array | null> {
    this.requests.push(structuredClone(request));
    return this.key ? structuredClone(this.key) : null;
  }
}

export class RecordingDlpSink implements DlpSink {
  readonly attempts: ForwardedTelemetryEvent[] = [];
  private readonly result: DlpInspectionResult;

  constructor(
    result: DlpInspectionResult = { allowed: true, categories: [] },
  ) {
    this.result = structuredClone(result);
  }

  async inspect(event: ForwardedTelemetryEvent): Promise<DlpInspectionResult> {
    this.attempts.push(structuredClone(event));
    return structuredClone(this.result);
  }
}

class FetchPostHogSink implements AnalyticsSink {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint: URL,
    private readonly propertyAllowlist: ReadonlySet<string>,
  ) {}

  async capture(event: ForwardedTelemetryEvent): Promise<void> {
    const capture = buildPostHogCapture(event, this.propertyAllowlist);
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey, ...capture }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("PostHog delivery failed.");
  }

  async deletePerson(_request: SubjectDeletionRequest): Promise<void> {
    // A PostHog project ingestion key cannot authorize person deletion.
    // Keep the request retryable until a management-API deletion adapter and
    // its separate credential are configured; never report a false success.
    throw new Error("PostHog person deletion is not configured.");
  }
}

class FetchLangfuseSink implements LangfuseSink {
  constructor(
    private readonly endpoint: URL,
    private readonly publicKey: string,
    private readonly secretKey: string,
  ) {}

  async captureGeneration(generation: LangfuseGeneration): Promise<void> {
    // The generation is already masked to metadata by the forward worker; this
    // adapter only transports it. Basic auth uses the tenant-agnostic project
    // keys; no subject credential is ever involved.
    const authorization = Buffer.from(
      `${this.publicKey}:${this.secretKey}`,
    ).toString("base64");
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${authorization}`,
      },
      body: JSON.stringify({
        batch: [
          {
            type: "generation-create",
            id: generation.generation_id,
            body: generation,
          },
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Langfuse delivery failed.");
  }
}

function otelAttribute(key: string, value: JsonPrimitive): object | undefined {
  if (value === null) return undefined;
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

export function otelSpanTimestamps(
  event: Pick<ForwardedTelemetryEvent, "occurredAt" | "receivedAt">,
): { startTimeUnixNano: string; endTimeUnixNano: string } {
  const startMilliseconds = Math.max(0, Date.parse(event.occurredAt));
  const endMilliseconds = Math.max(startMilliseconds, Date.parse(event.receivedAt));
  return {
    startTimeUnixNano: String(BigInt(startMilliseconds) * 1_000_000n),
    endTimeUnixNano: String(BigInt(endMilliseconds) * 1_000_000n),
  };
}

/**
 * Builds the OTLP span attributes for a forwarded event. `event_id` and
 * `event_type` are always present as ids; every other attribute must be on the
 * configured allowlist. Deny-by-default: nothing outside the allowlist — and
 * no payload fragment — can reach the trace backend.
 */
export function buildOtelSpanAttributes(
  event: ForwardedTelemetryEvent,
  attributeAllowlist: ReadonlySet<string>,
): object[] {
  return [
    { key: "telemetry.event_id", value: { stringValue: event.eventId } },
    { key: "telemetry.event_type", value: { stringValue: event.eventType } },
    ...Object.entries(event.properties)
      .filter(([key]) => attributeAllowlist.has(key))
      .map(([key, value]) => otelAttribute(`telemetry.${key}`, value))
      .filter((attribute): attribute is object => attribute !== undefined),
  ];
}

export function buildOtelSpanPayload(
  event: ForwardedTelemetryEvent,
  attributeAllowlist: ReadonlySet<string>,
): object {
  const identity = sha256Hex(`${event.deliveryId}:otel`);
  const { startTimeUnixNano, endTimeUnixNano } = otelSpanTimestamps(event);
  return {
    resourceSpans: [
      {
        scopeSpans: [
          {
            scope: { name: "planeir.learning-signals" },
            spans: [
              {
                traceId: identity.slice(0, 32),
                spanId: identity.slice(32, 48),
                name: event.eventType,
                kind: 1,
                startTimeUnixNano,
                endTimeUnixNano,
                attributes: buildOtelSpanAttributes(event, attributeAllowlist),
              },
            ],
          },
        ],
      },
    ],
  };
}

class FetchOtelSpanSink implements TraceSink {
  constructor(
    private readonly endpoint: URL,
    private readonly attributeAllowlist: ReadonlySet<string>,
  ) {}

  async exportSpan(event: ForwardedTelemetryEvent): Promise<void> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildOtelSpanPayload(event, this.attributeAllowlist)),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("OTel delivery failed.");
  }

  async deleteTraces(_request: SubjectDeletionRequest): Promise<void> {
    // OTLP has no standard trace-deletion operation. A backend-specific
    // adapter must replace this method before external deletion can complete.
    throw new Error("Trace deletion is not configured.");
  }
}

function posthogEndpoint(host: string): URL {
  return new URL("/capture/", host);
}

function otelEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/v1/traces";
  return url;
}

function langfuseEndpoint(host: string): URL {
  return new URL("/api/public/ingestion", host);
}

export function createTelemetrySinks(
  config: ServiceConfig,
  observability: ObservabilityConfig = loadObservabilityConfig(),
): {
  posthog: AnalyticsSink;
  otel: TraceSink;
  langfuse: LangfuseSink;
  kms: KmsSink;
  dlp: DlpSink;
} {
  return {
    posthog: config.posthogApiKey
      ? new FetchPostHogSink(
          config.posthogApiKey,
          posthogEndpoint(config.posthogHost),
          observability.posthogPropertyAllowlist,
        )
      : new NoopPostHogSink(),
    otel: config.otelExporterOtlpEndpoint
      ? new FetchOtelSpanSink(
          otelEndpoint(config.otelExporterOtlpEndpoint),
          observability.otelAttributeAllowlist,
        )
      : new NoopOtelSpanSink(),
    // Langfuse activates (M7) only when Cloud EU credentials are present; the
    // forward worker masks every generation to metadata before it reaches this
    // sink. Absent credentials keep the dormant no-op. KMS and DLP remain
    // no-op ports with no approved call path.
    langfuse:
      config.langfusePublicKey && config.langfuseSecretKey
        ? new FetchLangfuseSink(
            langfuseEndpoint(config.langfuseHost ?? "https://cloud.langfuse.com"),
            config.langfusePublicKey,
            config.langfuseSecretKey,
          )
        : new NoopLangfuseSink(),
    kms: new NoopKmsSink(),
    dlp: new NoopDlpSink(),
  };
}
