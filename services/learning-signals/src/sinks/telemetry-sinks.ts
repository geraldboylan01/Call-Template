import { sha256Hex, type JsonPrimitive } from "../telemetry/canonical-json.js";
import type { ServiceConfig } from "../config.js";

export type ForwardedTelemetryEvent = {
  deliveryId: string;
  eventId: string;
  eventType: string;
  occurredAt: string;
  receivedAt: string;
  properties: Record<string, JsonPrimitive>;
};

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

export interface LangfuseSink {
  capture(event: ForwardedTelemetryEvent): Promise<void>;
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
  async capture(_event: ForwardedTelemetryEvent): Promise<void> {}
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
  readonly attempts: ForwardedTelemetryEvent[] = [];

  async capture(event: ForwardedTelemetryEvent): Promise<void> {
    this.attempts.push(structuredClone(event));
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
  ) {}

  async capture(event: ForwardedTelemetryEvent): Promise<void> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        event: event.eventType,
        timestamp: event.receivedAt,
        properties: {
          distinct_id: event.eventId,
          $insert_id: `${event.deliveryId}:posthog`,
          ...event.properties,
        },
      }),
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

class FetchOtelSpanSink implements TraceSink {
  constructor(private readonly endpoint: URL) {}

  async exportSpan(event: ForwardedTelemetryEvent): Promise<void> {
    const identity = sha256Hex(`${event.deliveryId}:otel`);
    const { startTimeUnixNano, endTimeUnixNano } = otelSpanTimestamps(event);
    const attributes = [
      { key: "telemetry.event_id", value: { stringValue: event.eventId } },
      { key: "telemetry.event_type", value: { stringValue: event.eventType } },
      ...Object.entries(event.properties)
        .map(([key, value]) => otelAttribute(`telemetry.${key}`, value))
        .filter((attribute): attribute is object => attribute !== undefined),
    ];
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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
                    attributes,
                  },
                ],
              },
            ],
          },
        ],
      }),
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

export function createTelemetrySinks(config: ServiceConfig): {
  posthog: AnalyticsSink;
  otel: TraceSink;
  langfuse: LangfuseSink;
  kms: KmsSink;
  dlp: DlpSink;
} {
  return {
    posthog: config.posthogApiKey
      ? new FetchPostHogSink(config.posthogApiKey, posthogEndpoint(config.posthogHost))
      : new NoopPostHogSink(),
    otel: config.otelExporterOtlpEndpoint
      ? new FetchOtelSpanSink(otelEndpoint(config.otelExporterOtlpEndpoint))
      : new NoopOtelSpanSink(),
    // M2 has no approved Langfuse, KMS, or DLP call path. Their ports are
    // installed as explicit no-ops so later milestones cannot bypass these
    // boundaries; M2's outbox remains PostHog + OTel only.
    langfuse: new NoopLangfuseSink(),
    kms: new NoopKmsSink(),
    dlp: new NoopDlpSink(),
  };
}
