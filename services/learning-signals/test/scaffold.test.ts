import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig, type ServiceConfig } from "../src/config.js";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  waitForPostgres,
} from "../src/db/client.js";
import {
  applyDifferentialPrivacy,
  NotImplementedError,
} from "../src/privacy/differential-privacy.js";

describe("M0 learning-signal scaffold", () => {
  let config: ServiceConfig;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    config = loadConfig();
    connection = createDatabaseConnection(config.databaseUrl);
    await waitForPostgres(connection.pool);
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  it("runs only against PostgreSQL 16 with drizzle migrations applied", async () => {
    const versionResult = await connection.pool.query<{ server_version_num: string }>(
      "show server_version_num",
    );
    const migrationResult = await connection.pool.query<{ migration_table: string | null }>(
      "select to_regclass('drizzle.__drizzle_migrations')::text as migration_table",
    );
    const migrationCountResult = await connection.pool.query<{ migration_count: number }>(
      "select count(*)::integer as migration_count from drizzle.__drizzle_migrations",
    );

    expect(Number(versionResult.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(160_000);
    expect(Number(versionResult.rows[0]?.server_version_num)).toBeLessThan(170_000);
    expect(migrationResult.rows[0]?.migration_table).toBe("drizzle.__drizzle_migrations");
    expect(migrationCountResult.rows[0]?.migration_count).toBeGreaterThan(0);
  });

  it("boots Fastify without optional third-party credentials", async () => {
    const app = buildApp({
      ...config,
      posthogApiKey: undefined,
      langfusePublicKey: undefined,
      langfuseSecretKey: undefined,
      langfuseHost: undefined,
      otelExporterOtlpEndpoint: undefined,
    });

    await expect(app.ready()).resolves.toBeUndefined();
    await app.close();
  });

  it("rejects every non-PostgreSQL database URL", () => {
    expect(() =>
      loadConfig({
        ...process.env,
        DATABASE_URL: "sqlite://telemetry.db",
      }),
    ).toThrowError("Invalid service configuration: DATABASE_URL");
  });

  it("keeps differential-privacy noise behind the pilot guard", () => {
    expect(() =>
      applyDifferentialPrivacy(42, { dpEnabled: true, epsilon: config.dpEpsilon }),
    ).toThrowError(new NotImplementedError("DP noise not enabled for pilot"));
  });
});
