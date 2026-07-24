import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  waitForPostgres,
} from "../src/db/client.js";

describe.sequential("Phase 3 hosting readiness", () => {
  let connection: DatabaseConnection;
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig();
    connection = createDatabaseConnection(config.databaseUrl);
    await waitForPostgres(connection.pool);
    app = buildApp(config, { connection });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await connection.pool.end();
  });

  it("serves an unauthenticated liveness probe at /health", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    // No credential required, and no www-authenticate challenge.
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });

  it("prefers the platform-injected PORT over SERVICE_PORT", () => {
    const withPort = loadConfig({
      DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
      SERVICE_PORT: "3000",
      PORT: "8080",
    });
    expect(withPort.port).toBe(8080);

    const withoutPort = loadConfig({
      DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
      SERVICE_PORT: "3000",
    });
    expect(withoutPort.port).toBe(3000);
  });
});
