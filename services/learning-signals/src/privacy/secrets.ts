import { createHmac, randomBytes } from "node:crypto";

import { z } from "zod";

import type { ServiceConfig } from "../config.js";

const maxKeyVersion = 32_767;
const canonicalTenantIdSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const keyVersionTextSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => Number(value) <= maxKeyVersion);
const encodedSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43,}$/);

const tenantSecretConfigSchema = z
  .object({
    current_version: z.number().int().min(1).max(maxKeyVersion),
    keys: z.record(keyVersionTextSchema, encodedSecretSchema),
  })
  .strict()
  .superRefine((entry, context) => {
    if (!Object.hasOwn(entry.keys, String(entry.current_version))) {
      context.addIssue({
        code: "custom",
        message: "current key version is missing",
      });
    }
  });

const tenantSecretsDocumentSchema = z.record(
  canonicalTenantIdSchema,
  tenantSecretConfigSchema,
);

export type TenantSecret = {
  keyVersion: number;
  key: Uint8Array;
};

export interface SecretsProvider {
  getCurrentSecret(tenantId: string): Promise<TenantSecret>;
  getSecret(tenantId: string, keyVersion: number): Promise<TenantSecret>;
  /**
   * Returns a point-in-time copy of every retained tenant key, ordered by
   * version. Rights requests must use the whole retained keyring because key
   * rotation intentionally breaks linkage between versions.
   */
  getRetainedSecrets(tenantId: string): Promise<readonly TenantSecret[]>;
}

export class SecretsUnavailableError extends Error {
  constructor() {
    super("Tenant secret is unavailable.");
    this.name = "SecretsUnavailableError";
  }
}

type TenantKeyring = {
  currentVersion: number;
  keys: ReadonlyMap<number, Uint8Array>;
};

function decodeSecret(encoded: string): Uint8Array {
  const decoded = Buffer.from(encoded, "base64url");
  if (
    decoded.byteLength < 32 ||
    decoded.toString("base64url") !== encoded.replace(/=+$/, "")
  ) {
    throw new Error("Invalid tenant secret configuration.");
  }
  return new Uint8Array(decoded);
}

function cloneSecret(keyVersion: number, key: Uint8Array): TenantSecret {
  return { keyVersion, key: structuredClone(key) };
}

export class EnvSecretsProvider implements SecretsProvider {
  private readonly keyrings = new Map<string, TenantKeyring>();

  constructor(serializedConfig: string | undefined) {
    if (!serializedConfig) return;

    let value: unknown;
    try {
      value = JSON.parse(serializedConfig);
    } catch {
      throw new Error("Invalid service configuration: TENANT_SECRETS_JSON");
    }
    const parsed = tenantSecretsDocumentSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error("Invalid service configuration: TENANT_SECRETS_JSON");
    }

    try {
      for (const [tenantId, entry] of Object.entries(parsed.data)) {
        const keys = new Map<number, Uint8Array>();
        for (const [version, encoded] of Object.entries(entry.keys)) {
          keys.set(Number(version), decodeSecret(encoded));
        }
        this.keyrings.set(tenantId, {
          currentVersion: entry.current_version,
          keys,
        });
      }
    } catch {
      throw new Error("Invalid service configuration: TENANT_SECRETS_JSON");
    }
  }

  async getCurrentSecret(tenantId: string): Promise<TenantSecret> {
    const keyring = this.keyrings.get(tenantId.toLowerCase());
    if (!keyring) throw new SecretsUnavailableError();
    const key = keyring.keys.get(keyring.currentVersion);
    if (!key) throw new SecretsUnavailableError();
    return cloneSecret(keyring.currentVersion, key);
  }

  async getSecret(tenantId: string, keyVersion: number): Promise<TenantSecret> {
    const key = this.keyrings.get(tenantId.toLowerCase())?.keys.get(keyVersion);
    if (!key) throw new SecretsUnavailableError();
    return cloneSecret(keyVersion, key);
  }

  async getRetainedSecrets(
    tenantId: string,
  ): Promise<readonly TenantSecret[]> {
    const keyring = this.keyrings.get(tenantId.toLowerCase());
    if (!keyring || keyring.keys.size === 0) {
      throw new SecretsUnavailableError();
    }
    return [...keyring.keys.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([keyVersion, key]) => cloneSecret(keyVersion, key));
  }
}

export class KmsSecretsProvider implements SecretsProvider {
  async getCurrentSecret(_tenantId: string): Promise<TenantSecret> {
    throw new SecretsUnavailableError();
  }

  async getSecret(
    _tenantId: string,
    _keyVersion: number,
  ): Promise<TenantSecret> {
    throw new SecretsUnavailableError();
  }

  async getRetainedSecrets(
    _tenantId: string,
  ): Promise<readonly TenantSecret[]> {
    throw new SecretsUnavailableError();
  }
}

export type RecordingSecretRequest = {
  tenantId: string;
  keyVersion: number | "current" | "retained";
};

export class RecordingSecretsProvider implements SecretsProvider {
  readonly requests: RecordingSecretRequest[] = [];

  private readonly keyrings = new Map<string, { currentVersion: number; keys: Map<number, Uint8Array> }>();

  setTenantKey(
    tenantId: string,
    keyVersion: number,
    key: Uint8Array,
    makeCurrent = true,
  ): void {
    if (
      key.byteLength < 32 ||
      !Number.isInteger(keyVersion) ||
      keyVersion < 1 ||
      keyVersion > maxKeyVersion
    ) {
      throw new Error("Invalid recording tenant secret.");
    }
    const canonicalTenantId = tenantId.toLowerCase();
    const existing = this.keyrings.get(canonicalTenantId);
    const keyring = existing ?? { currentVersion: keyVersion, keys: new Map() };
    keyring.keys.set(keyVersion, structuredClone(key));
    if (makeCurrent) keyring.currentVersion = keyVersion;
    this.keyrings.set(canonicalTenantId, keyring);
  }

  async getCurrentSecret(tenantId: string): Promise<TenantSecret> {
    const canonicalTenantId = tenantId.toLowerCase();
    this.requests.push({ tenantId: canonicalTenantId, keyVersion: "current" });
    const keyring = this.keyrings.get(canonicalTenantId);
    if (!keyring) throw new SecretsUnavailableError();
    const key = keyring.keys.get(keyring.currentVersion);
    if (!key) throw new SecretsUnavailableError();
    return cloneSecret(keyring.currentVersion, key);
  }

  async getSecret(tenantId: string, keyVersion: number): Promise<TenantSecret> {
    const canonicalTenantId = tenantId.toLowerCase();
    this.requests.push({ tenantId: canonicalTenantId, keyVersion });
    const key = this.keyrings.get(canonicalTenantId)?.keys.get(keyVersion);
    if (!key) throw new SecretsUnavailableError();
    return cloneSecret(keyVersion, key);
  }

  async getRetainedSecrets(
    tenantId: string,
  ): Promise<readonly TenantSecret[]> {
    const canonicalTenantId = tenantId.toLowerCase();
    this.requests.push({
      tenantId: canonicalTenantId,
      keyVersion: "retained",
    });
    const keyring = this.keyrings.get(canonicalTenantId);
    if (!keyring || keyring.keys.size === 0) {
      throw new SecretsUnavailableError();
    }
    return [...keyring.keys.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([keyVersion, key]) => cloneSecret(keyVersion, key));
  }
}

export function generateTenantSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hmacSha256Hex(key: Uint8Array, message: string): string {
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

export function createSecretsProvider(config: ServiceConfig): SecretsProvider {
  return config.tenantSecretProvider === "kms"
    ? new KmsSecretsProvider()
    : new EnvSecretsProvider(config.tenantSecretsJson);
}
