import { z } from "zod";

const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const envBoolean = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const environmentSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .refine(
      (value) => value.startsWith("postgresql://") || value.startsWith("postgres://"),
      "must use the PostgreSQL protocol",
    ),
  SERVICE_HOST: z.string().min(1).default("127.0.0.1"),
  SERVICE_PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  POSTHOG_API_KEY: optionalText,
  POSTHOG_HOST: z.string().url().default("https://eu.i.posthog.com"),
  LANGFUSE_PUBLIC_KEY: optionalText,
  LANGFUSE_SECRET_KEY: optionalText,
  LANGFUSE_HOST: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().url().optional(),
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().url().optional(),
  ),
  TENANT_SECRET_PROVIDER: z.enum(["kms", "env"]).default("env"),
  TENANT_SECRETS_JSON: optionalText,
  DP_ENABLED: envBoolean,
  DP_EPSILON: z.coerce.number().positive().default(1),
  PARQUET_EXPORT_ENABLED: envBoolean,
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
  OUTBOX_RETRY_BASE_MS: z.coerce.number().int().min(1).max(60_000).default(1_000),
  OUTBOX_RETRY_MAX_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(86_400_000)
    .default(60_000),
});

export type ServiceConfig = {
  databaseUrl: string;
  host: string;
  port: number;
  nodeEnv: "development" | "test" | "production";
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  posthogApiKey: string | undefined;
  posthogHost: string;
  langfusePublicKey: string | undefined;
  langfuseSecretKey: string | undefined;
  langfuseHost: string | undefined;
  otelExporterOtlpEndpoint: string | undefined;
  tenantSecretProvider: "kms" | "env";
  tenantSecretsJson: string | undefined;
  dpEnabled: boolean;
  dpEpsilon: number;
  parquetExportEnabled: boolean;
  outboxPollIntervalMs: number;
  outboxRetryBaseMs: number;
  outboxRetryMaxMs: number;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const invalidFields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid service configuration: ${invalidFields.join(", ")}`);
  }

  return {
    databaseUrl: result.data.DATABASE_URL,
    host: result.data.SERVICE_HOST,
    port: result.data.SERVICE_PORT,
    nodeEnv: result.data.NODE_ENV,
    logLevel: result.data.LOG_LEVEL,
    posthogApiKey: result.data.POSTHOG_API_KEY,
    posthogHost: result.data.POSTHOG_HOST,
    langfusePublicKey: result.data.LANGFUSE_PUBLIC_KEY,
    langfuseSecretKey: result.data.LANGFUSE_SECRET_KEY,
    langfuseHost: result.data.LANGFUSE_HOST,
    otelExporterOtlpEndpoint: result.data.OTEL_EXPORTER_OTLP_ENDPOINT,
    tenantSecretProvider: result.data.TENANT_SECRET_PROVIDER,
    tenantSecretsJson: result.data.TENANT_SECRETS_JSON,
    dpEnabled: result.data.DP_ENABLED,
    dpEpsilon: result.data.DP_EPSILON,
    parquetExportEnabled: result.data.PARQUET_EXPORT_ENABLED,
    outboxPollIntervalMs: result.data.OUTBOX_POLL_INTERVAL_MS,
    outboxRetryBaseMs: result.data.OUTBOX_RETRY_BASE_MS,
    outboxRetryMaxMs: result.data.OUTBOX_RETRY_MAX_MS,
  };
}
