import type { JsonPrimitive } from "../telemetry/canonical-json.js";
import type { FieldPolicy, FieldPolicyEntry } from "./field-policy.js";
import { hmacSha256Hex, type TenantSecret } from "./secrets.js";

export type RawFieldValue = JsonPrimitive;

export type SanitizedFieldValue = {
  valueClass: FieldPolicyEntry["valueClass"];
  normalizedValueHash: string;
  keyVersion: number;
  valuePreview: string | null;
  fieldPolicyVersion: string;
};

export class FieldPolicyUnavailableError extends Error {
  constructor() {
    super("Field policy is unavailable.");
    this.name = "FieldPolicyUnavailableError";
  }
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function requireSecretKey(secret: Uint8Array): void {
  if (secret.byteLength < 32) throw new Error("Invalid tenant secret.");
}

export function normalizeScalar(value: RawFieldValue): string {
  if (value === null) return "<null>";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid field value.");
    return Object.is(value, -0) ? "0" : String(value);
  }
  return normalizeText(value);
}

export function normalizeFingerprintValue(value: RawFieldValue): JsonPrimitive {
  return typeof value === "string" ? normalizeText(value) : value;
}

export function pseudonymizeIdentifier(
  identifier: string,
  secret: Uint8Array,
): string {
  requireSecretKey(secret);
  return hmacSha256Hex(
    secret,
    `planeir:pseudonym:v1:${normalizeText(identifier)}`,
  );
}

export const pseudonymize_identifier = pseudonymizeIdentifier;

export function pseudonymizeActor(
  actorLabel: string,
  secret: Uint8Array,
): string {
  requireSecretKey(secret);
  return hmacSha256Hex(secret, `planeir:actor:v1:${normalizeText(actorLabel)}`);
}

function parseAge(value: RawFieldValue): number | undefined {
  const normalized = normalizeScalar(value);
  if (!/^[0-9]{1,3}$/.test(normalized)) return undefined;
  const age = Number(normalized);
  return age >= 0 && age <= 130 ? age : undefined;
}

function ageBand(value: RawFieldValue): string | null {
  const age = parseAge(value);
  if (age === undefined) return null;
  if (age < 18) return "under_18";
  if (age < 25) return "18_24";
  if (age < 35) return "25_34";
  if (age < 45) return "35_44";
  if (age < 55) return "45_54";
  if (age < 65) return "55_64";
  if (age < 75) return "65_74";
  return "75_plus";
}

function parseCurrency(value: RawFieldValue): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  const match =
    /^(?:(?:eur|gbp|usd)\s*|[€£$]\s*)?(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s*(?:eur|gbp|usd)?$/.exec(
      normalized,
    );
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNumber(value: RawFieldValue): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = normalizeText(value);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function typedFallback(value: RawFieldValue): string {
  if (value === null) return "null:";
  if (typeof value === "boolean") return `boolean:${value ? "true" : "false"}`;
  if (typeof value === "number") {
    return `number:${Object.is(value, -0) ? "0" : String(value)}`;
  }
  return `string:${normalizeText(value)}`;
}

function currencyBand(value: RawFieldValue): string | null {
  const amount = parseCurrency(value);
  if (amount === undefined) return null;
  if (amount < 0) return "negative";
  if (amount < 10_000) return "under_10k";
  if (amount < 50_000) return "10k_49k";
  if (amount < 100_000) return "50k_99k";
  if (amount < 250_000) return "100k_249k";
  if (amount < 500_000) return "250k_499k";
  if (amount < 1_000_000) return "500k_999k";
  return "1m_plus";
}

function normalizedForHash(
  value: RawFieldValue,
  entry: FieldPolicyEntry,
): string {
  if (entry.valueClass === "age") {
    const age = parseAge(value);
    return age === undefined ? typedFallback(value) : `age:${age}`;
  }
  if (entry.valueClass === "currency" || entry.valueClass === "number") {
    const number =
      entry.valueClass === "currency"
        ? parseCurrency(value)
        : parseNumber(value);
    return number === undefined || !Number.isFinite(number)
      ? typedFallback(value)
      : `${entry.valueClass}:${number}`;
  }
  if (entry.valueClass === "date") {
    const normalized = normalizeScalar(value);
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(normalized)
      ? `date:${normalized}`
      : typedFallback(value);
  }
  return typedFallback(value);
}

function previewValue(
  value: RawFieldValue,
  entry: FieldPolicyEntry,
): string | null {
  if (!entry.previewAllowed) return null;
  if (entry.preview === "age_band") return ageBand(value);
  if (entry.preview === "currency_band") return currencyBand(value);
  if (entry.preview === "enum") {
    const normalized = normalizeScalar(value);
    return entry.allowedValues.includes(normalized) ? normalized : null;
  }
  return null;
}

export function sanitizeFieldValue(
  fieldKey: string,
  rawValue: RawFieldValue,
  policy: FieldPolicy,
  tenantSecret: TenantSecret,
): SanitizedFieldValue {
  const entry = policy.get(fieldKey);
  if (!entry) throw new FieldPolicyUnavailableError();
  requireSecretKey(tenantSecret.key);
  if (
    !Number.isInteger(tenantSecret.keyVersion) ||
    tenantSecret.keyVersion < 1 ||
    tenantSecret.keyVersion > 32_767
  ) {
    throw new Error("Invalid tenant secret.");
  }

  const normalized = normalizedForHash(rawValue, entry);
  const valuePreview = previewValue(rawValue, entry);
  if (valuePreview && valuePreview.length > 64) {
    throw new Error("Invalid field policy preview.");
  }

  return {
    valueClass: entry.valueClass,
    normalizedValueHash: hmacSha256Hex(
      tenantSecret.key,
      `planeir:field:v1:${fieldKey}:${normalized}`,
    ),
    keyVersion: tenantSecret.keyVersion,
    valuePreview,
    fieldPolicyVersion: policy.version,
  };
}

export const sanitize_field_value = sanitizeFieldValue;
