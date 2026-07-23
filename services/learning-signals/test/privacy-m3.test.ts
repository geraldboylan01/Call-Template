import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  loadFieldPolicy,
  parseFieldPolicy,
} from "../src/privacy/field-policy.js";
import {
  pseudonymizeIdentifier,
  sanitizeFieldValue,
} from "../src/privacy/field-values.js";
import { redactFreeText } from "../src/privacy/redaction.js";
import {
  EnvSecretsProvider,
  generateTenantSecret,
  RecordingSecretsProvider,
} from "../src/privacy/secrets.js";

const tenantA = "10000000-0000-4000-8000-000000000001";
const tenantB = "20000000-0000-4000-8000-000000000002";

describe("M3 privacy primitives and field policy", () => {
  it("loads a closed, versioned field policy whose defaults never store raw values", () => {
    const policy = loadFieldPolicy();
    const defaulted = parseFieldPolicy(`version: field-policy-v1
notes: {}
fields:
  identity.alias:
    value_class: identifier
    preview: none
`);

    expect(policy.version).toBe("field-policy-v1");
    expect(policy.dlpForwardAllowed).toBe(false);
    expect(policy.fieldKeys()).toContain("finances.total_assets");
    expect(policy.get("finances.total_assets")).toEqual({
      valueClass: "currency",
      preview: "currency_band",
      previewAllowed: true,
      storeRawOperational: false,
      allowedValues: [],
    });
    expect(policy.get("identity.full_name")).toMatchObject({
      preview: "none",
      previewAllowed: false,
      storeRawOperational: false,
    });
    expect(defaulted.dlpForwardAllowed).toBe(false);
    expect(defaulted.get("identity.alias")).toMatchObject({
      previewAllowed: false,
      storeRawOperational: false,
    });
  });

  it("rejects unknown preview formats, unknown keys, aliases, and duplicate YAML keys", () => {
    const invalidPolicies = [
      `version: field-policy-v1
notes:
  dlp_forward_allowed: false
fields:
  client.age:
    value_class: age
    preview: raw_substring
`,
      `version: field-policy-v1
notes:
  dlp_forward_allowed: false
fields:
  client.age:
    value_class: age
    preview: none
    unexpected: true
`,
      `version: field-policy-v1
notes: &notes
  dlp_forward_allowed: false
fields:
  client.age:
    value_class: age
    preview: none
extra: *notes
`,
      `version: field-policy-v1
version: field-policy-v2
notes:
  dlp_forward_allowed: false
fields:
  client.age:
    value_class: age
    preview: none
`,
    ];

    for (const raw of invalidPolicies) {
      expect(() => parseFieldPolicy(raw)).toThrowError("Invalid field policy.");
    }
  });

  it("generates only fixed age, currency, and enum previews rather than raw substrings", () => {
    const policy = loadFieldPolicy();
    const secret = { keyVersion: 7, key: randomBytes(32) };

    expect(
      sanitizeFieldValue("client.age", "34", policy, secret).valuePreview,
    ).toBe("25_34");
    expect(
      sanitizeFieldValue(
        "finances.total_assets",
        "€430,000",
        policy,
        secret,
      ).valuePreview,
    ).toBe("250k_499k");
    expect(
      sanitizeFieldValue(
        "finances.total_assets",
        "€430,000 SENTINEL_XYZ",
        policy,
        secret,
      ).valuePreview,
    ).toBeNull();
    expect(
      sanitizeFieldValue("risk.profile", " Growth ", policy, secret)
        .valuePreview,
    ).toBe("growth");
    expect(
      sanitizeFieldValue(
        "identity.full_name",
        "Aoife Secretname",
        policy,
        secret,
      ).valuePreview,
    ).toBeNull();
  });

  it("normalizes before keyed hashing and separates tenants and key versions", () => {
    const policy = loadFieldPolicy();
    const keyA1 = randomBytes(32);
    const keyA2 = randomBytes(32);
    const keyB1 = randomBytes(32);

    const normalizedA = sanitizeFieldValue(
      "identity.full_name",
      "  JOSÉ\u200B  O'NEILL ",
      policy,
      { keyVersion: 1, key: keyA1 },
    );
    const equivalentA = sanitizeFieldValue(
      "identity.full_name",
      "josé o'neill",
      policy,
      { keyVersion: 1, key: keyA1 },
    );
    const rotatedA = sanitizeFieldValue(
      "identity.full_name",
      "josé o'neill",
      policy,
      { keyVersion: 2, key: keyA2 },
    );
    const otherTenant = sanitizeFieldValue(
      "identity.full_name",
      "josé o'neill",
      policy,
      { keyVersion: 1, key: keyB1 },
    );

    expect(normalizedA.normalizedValueHash).toBe(
      equivalentA.normalizedValueHash,
    );
    expect(rotatedA.normalizedValueHash).not.toBe(
      normalizedA.normalizedValueHash,
    );
    expect(otherTenant.normalizedValueHash).not.toBe(
      normalizedA.normalizedValueHash,
    );
    expect(normalizedA).toMatchObject({
      keyVersion: 1,
      valuePreview: null,
      fieldPolicyVersion: "field-policy-v1",
    });
    expect(JSON.stringify(normalizedA)).not.toContain("josé");

    expect(pseudonymizeIdentifier(" Client-123 ", keyA1)).toBe(
      pseudonymizeIdentifier("client-123", keyA1),
    );
    expect(pseudonymizeIdentifier("client-123", keyA1)).not.toBe(
      pseudonymizeIdentifier("client-123", keyB1),
    );
  });

  it("domain-separates scalar types while normalizing numeric field representations", () => {
    const policy = loadFieldPolicy();
    const secret = { keyVersion: 1, key: randomBytes(32) };
    const literalNull = sanitizeFieldValue(
      "identity.full_name",
      "<null>",
      policy,
      secret,
    );
    const actualNull = sanitizeFieldValue(
      "identity.full_name",
      null,
      policy,
      secret,
    );
    const numericCurrency = sanitizeFieldValue(
      "finances.total_assets",
      430_000,
      policy,
      secret,
    );
    const formattedCurrency = sanitizeFieldValue(
      "finances.total_assets",
      "€430,000",
      policy,
      secret,
    );

    expect(literalNull.normalizedValueHash).not.toBe(
      actualNull.normalizedValueHash,
    );
    expect(numericCurrency.normalizedValueHash).toBe(
      formattedCurrency.normalizedValueHash,
    );
  });

  it("redacts adversarial identifiers and sensitive categories from free text", () => {
    const note =
      "Name: Aoife Secretname. I work at EmployerSentinel Ltd. " +
      "IBAN IE29 AIBK 9311 5212 3456 78, postcode D02 X285, " +
      "born 1985-07-23, account number ACCT778899, diagnosed with diabetes.";
    const redacted = redactFreeText(note);

    for (const forbidden of [
      "Aoife Secretname",
      "EmployerSentinel",
      "IE29 AIBK 9311 5212 3456 78",
      "D02 X285",
      "1985-07-23",
      "ACCT778899",
      "diabetes",
    ]) {
      expect(redacted.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(redacted).toContain("[REDACTED_");
    expect(redacted.length).toBeLessThanOrEqual(4_096);
  });

  it("uses at least 256-bit CSPRNG secrets and retains historical key versions", async () => {
    const generatedA = generateTenantSecret();
    const generatedB = generateTenantSecret();
    expect(Buffer.from(generatedA, "base64url")).toHaveLength(32);
    expect(Buffer.from(generatedB, "base64url")).toHaveLength(32);
    expect(generatedA).not.toBe(generatedB);

    const provider = new RecordingSecretsProvider();
    const keyV1 = randomBytes(32);
    const keyV2 = randomBytes(32);
    provider.setTenantKey(tenantA, 1, keyV1);
    provider.setTenantKey(tenantA, 2, keyV2);

    expect(await provider.getCurrentSecret(tenantA)).toEqual({
      keyVersion: 2,
      key: new Uint8Array(keyV2),
    });
    expect(await provider.getSecret(tenantA, 1)).toEqual({
      keyVersion: 1,
      key: new Uint8Array(keyV1),
    });
    expect(provider.requests).toEqual([
      { tenantId: tenantA, keyVersion: "current" },
      { tenantId: tenantA, keyVersion: 1 },
    ]);
  });

  it("validates env keyrings without exposing configured key material", async () => {
    const keyV1 = generateTenantSecret();
    const keyV2 = generateTenantSecret();
    const provider = new EnvSecretsProvider(
      JSON.stringify({
        [tenantB]: {
          current_version: 2,
          keys: { "1": keyV1, "2": keyV2 },
        },
      }),
    );

    expect(await provider.getCurrentSecret(tenantB)).toMatchObject({
      keyVersion: 2,
    });
    expect(await provider.getSecret(tenantB, 1)).toMatchObject({
      keyVersion: 1,
    });
    expect(() => new EnvSecretsProvider(`{"${tenantB}":{"keys":{}}}`)).toThrowError(
      "Invalid service configuration: TENANT_SECRETS_JSON",
    );
    expect(() =>
      new EnvSecretsProvider(
        JSON.stringify({
          [tenantB]: {
            current_version: 1,
            keys: { "1": Buffer.alloc(31).toString("base64url") },
          },
        }),
      ),
    ).toThrowError("Invalid service configuration: TENANT_SECRETS_JSON");
  });
});
