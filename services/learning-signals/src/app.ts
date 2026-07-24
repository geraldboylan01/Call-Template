import Fastify, { LogController, type FastifyInstance } from "fastify";

import type { ServiceConfig } from "./config.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/client.js";
import { loadFieldPolicy, type FieldPolicy } from "./privacy/field-policy.js";
import {
  createSecretsProvider,
  type SecretsProvider,
} from "./privacy/secrets.js";
import {
  SubjectErasureService,
  type SubjectErasureServiceOptions,
} from "./privacy/erasure.js";
import { registerCorrectionsRoutes } from "./routes/corrections.js";
import { registerErasureRoutes } from "./routes/erasure.js";
import { registerModuleVersionRoutes } from "./routes/module-versions.js";
import { registerTelemetryRoutes } from "./routes/telemetry.js";
import {
  createObservabilitySpanSink,
  type ObservabilitySpanSink,
} from "./sinks/observability-spans.js";
import { SystemClock, type Clock } from "./telemetry/clock.js";
import { PilotConsentResolver, type ConsentResolver } from "./telemetry/consent.js";
import {
  loadEventCatalogRegistry,
  type EventCatalog,
} from "./telemetry/event-catalog.js";
import { InMemoryIngestionMetrics, type IngestionMetrics } from "./telemetry/metrics.js";

function normalizeReadyResult(app: FastifyInstance): void {
  const fastifyReady = app.ready.bind(app);

  // Fastify's runtime promise currently fulfills with its thenable server
  // instance even though its TypeScript contract exposes a void readiness
  // result. Keep callback-style readiness intact for Fastify internals while
  // giving service callers the stable Promise<void> lifecycle contract.
  app.ready = ((callback?: (error: Error | null) => void | Promise<void>) => {
    if (callback) {
      return fastifyReady(callback);
    }
    return fastifyReady().then(() => undefined);
  }) as FastifyInstance["ready"];
}

export type AppDependencies = {
  connection?: DatabaseConnection;
  catalog?: EventCatalog;
  clock?: Clock;
  consentResolver?: ConsentResolver;
  metrics?: IngestionMetrics;
  fieldPolicy?: FieldPolicy;
  secretsProvider?: SecretsProvider;
  erasureService?: SubjectErasureService;
  spans?: ObservabilitySpanSink;
  logStream?: { write(message: string): void };
};

export function buildApp(
  config: ServiceConfig,
  dependencies: AppDependencies = {},
): FastifyInstance {
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    // JSON.parse retains these as own data properties. The ingestion catalog
    // then rejects them per item, preserving batch isolation without merging
    // untrusted objects or allowing prototype mutation.
    onProtoPoisoning: "ignore",
    onConstructorPoisoning: "ignore",
    logger:
      config.nodeEnv === "test" || config.logLevel === "silent"
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: [
                "req.headers.authorization",
                "req.raw.headers.authorization",
                "req.body",
                "request.headers.authorization",
                "request.body",
                "headers.authorization",
                "res.body",
                "response.body",
              ],
              censor: "[REDACTED]",
            },
            ...(dependencies.logStream ? { stream: dependencies.logStream } : {}),
          },
  });

  normalizeReadyResult(app);
  app.decorateRequest("tenantContext", null);

  const ownsConnection = dependencies.connection === undefined;
  const connection = dependencies.connection ?? createDatabaseConnection(config.databaseUrl);
  const catalog = dependencies.catalog ?? loadEventCatalogRegistry().current;
  const clock = dependencies.clock ?? new SystemClock();
  const consentResolver =
    dependencies.consentResolver ?? new PilotConsentResolver();
  const fieldPolicy = dependencies.fieldPolicy ?? loadFieldPolicy();
  const secretsProvider =
    dependencies.secretsProvider ?? createSecretsProvider(config);
  const erasureService =
    dependencies.erasureService ??
    new SubjectErasureService({
      pool: connection.pool,
      secretsProvider,
      clock,
    } satisfies SubjectErasureServiceOptions);
  const spans = dependencies.spans ?? createObservabilitySpanSink(config);
  registerTelemetryRoutes(app, {
    connection,
    catalog,
    clock,
    consentResolver,
    metrics: dependencies.metrics ?? new InMemoryIngestionMetrics(),
    spans,
  });
  registerCorrectionsRoutes(app, {
    connection,
    catalog,
    clock,
    consentResolver,
    fieldPolicy,
    secretsProvider,
  });
  registerErasureRoutes(app, {
    connection,
    erasureService,
  });
  registerModuleVersionRoutes(app, {
    connection,
    clock,
  });

  if (ownsConnection) {
    app.addHook("onClose", async () => {
      await connection.pool.end();
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const reportedStatusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    const statusCode =
      typeof reportedStatusCode === "number" && reportedStatusCode < 500
        ? reportedStatusCode
        : 500;
    request.log.error(
      {
        errorName,
        method: request.method,
        requestId: request.id,
        route: request.routeOptions.url,
        statusCode,
      },
      "request failed",
    );
    void reply.status(statusCode).send({
      error: statusCode === 500 ? "Internal server error" : "Request rejected",
    });
  });

  return app;
}
