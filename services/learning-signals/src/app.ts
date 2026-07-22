import Fastify, { LogController, type FastifyInstance } from "fastify";

import type { ServiceConfig } from "./config.js";

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

export function buildApp(config: ServiceConfig): FastifyInstance {
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger:
      config.nodeEnv === "test" || config.logLevel === "silent"
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: [
                "req.headers.authorization",
                "request.headers.authorization",
                "headers.authorization",
              ],
              censor: "[REDACTED]",
            },
          },
  });

  normalizeReadyResult(app);

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
