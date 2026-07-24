import { readFileSync } from "node:fs";

import { parseDocument } from "yaml";
import { z } from "zod";

// The export-boundary allowlists (M7). Strict YAML parsing (no merges/aliases,
// unique keys, closed shapes) mirrors the field-policy and thresholds loaders
// so a malformed file fails fast rather than silently widening what leaves the
// service to a third party.
const propertyKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const observabilityDocumentSchema = z
  .object({
    version: z.string().regex(/^observability-v[1-9][0-9]*$/),
    posthog: z
      .object({
        property_allowlist: z.array(propertyKey).min(1).max(256),
      })
      .strict(),
    otel: z
      .object({
        attribute_allowlist: z.array(propertyKey).min(1).max(256),
      })
      .strict(),
    langfuse: z
      .object({
        generation_field_allowlist: z.array(propertyKey).min(1).max(256),
      })
      .strict(),
    budget: z
      .object({
        default_daily_cap_micros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict();

export type ObservabilityConfig = {
  version: string;
  posthogPropertyAllowlist: ReadonlySet<string>;
  otelAttributeAllowlist: ReadonlySet<string>;
  langfuseGenerationFieldAllowlist: ReadonlySet<string>;
  budgetDefaultDailyCapMicros: number;
};

function uniqueOrThrow(values: readonly string[], label: string): ReadonlySet<string> {
  const set = new Set(values);
  if (set.size !== values.length) {
    throw new Error(`Duplicate ${label} in observability config.`);
  }
  return set;
}

export function parseObservabilityConfig(raw: string): ObservabilityConfig {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
    throw new Error("Invalid observability config.");
  }
  try {
    const document = parseDocument(raw, { merge: false, strict: true, uniqueKeys: true });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new Error("invalid YAML");
    }
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    const parsed = observabilityDocumentSchema.safeParse(value);
    if (!parsed.success) throw new Error("invalid observability shape");
    return {
      version: parsed.data.version,
      posthogPropertyAllowlist: uniqueOrThrow(
        parsed.data.posthog.property_allowlist,
        "posthog property",
      ),
      otelAttributeAllowlist: uniqueOrThrow(
        parsed.data.otel.attribute_allowlist,
        "otel attribute",
      ),
      langfuseGenerationFieldAllowlist: uniqueOrThrow(
        parsed.data.langfuse.generation_field_allowlist,
        "langfuse field",
      ),
      budgetDefaultDailyCapMicros: parsed.data.budget.default_daily_cap_micros,
    };
  } catch {
    throw new Error("Invalid observability config.");
  }
}

const defaultObservabilityUrl = new URL("../../config/observability.yaml", import.meta.url);

export function loadObservabilityConfig(
  url: URL = defaultObservabilityUrl,
): ObservabilityConfig {
  return parseObservabilityConfig(readFileSync(url, "utf8"));
}
