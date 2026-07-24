import type { ServiceConfig } from "../config.js";

// Operational OTel spans for the jobs the M7 spec names — ingestion, outbox
// drain, retention purge, and metrics runs. By construction these carry only
// ids, counts, and durations; a payload fragment can never be an attribute
// value because the value type is a primitive the call sites build from
// operational data, never from event content.
export type OperationalSpanAttributes = Record<string, string | number | boolean>;

export type OperationalSpan = {
  name: string;
  attributes: OperationalSpanAttributes;
};

export interface ObservabilitySpanSink {
  record(span: OperationalSpan): void;
}

export class NoopObservabilitySpanSink implements ObservabilitySpanSink {
  record(_span: OperationalSpan): void {}
}

export class RecordingObservabilitySpanSink implements ObservabilitySpanSink {
  readonly spans: OperationalSpan[] = [];

  record(span: OperationalSpan): void {
    this.spans.push({ name: span.name, attributes: { ...span.attributes } });
  }
}

function otelAttributeValue(value: string | number | boolean): object {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: value };
}

/**
 * Fire-and-forget OTLP job-span exporter. Failures are swallowed: observability
 * must never affect the job it observes. Only the operational span name and its
 * primitive attributes are exported.
 */
class FetchObservabilitySpanSink implements ObservabilitySpanSink {
  constructor(private readonly endpoint: URL) {}

  record(span: OperationalSpan): void {
    const attributes = Object.entries(span.attributes).map(([key, value]) => ({
      key,
      value: otelAttributeValue(value),
    }));
    const now = String(BigInt(Date.now()) * 1_000_000n);
    void fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                scope: { name: "planeir.learning-signals.jobs" },
                spans: [
                  {
                    name: span.name,
                    kind: 1,
                    startTimeUnixNano: now,
                    endTimeUnixNano: now,
                    attributes,
                  },
                ],
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }
}

export function createObservabilitySpanSink(
  config: ServiceConfig,
): ObservabilitySpanSink {
  if (!config.otelExporterOtlpEndpoint) return new NoopObservabilitySpanSink();
  const url = new URL(config.otelExporterOtlpEndpoint);
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/v1/traces";
  return new FetchObservabilitySpanSink(url);
}
