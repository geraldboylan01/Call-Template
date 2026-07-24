import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export type DatabaseConnection = {
  db: NodePgDatabase;
  pool: Pool;
};

export type DatabaseTransaction = Parameters<
  Parameters<DatabaseConnection["db"]["transaction"]>[0]
>[0];

/**
 * Resolves TLS for a hosted Postgres. Enabled when the URL asks for it
 * (`sslmode=require|verify-ca|verify-full`, as Neon/Supabase/managed providers
 * do) or `DATABASE_SSL=true`. `DATABASE_SSL_NO_VERIFY=true` relaxes cert
 * verification for providers with self-signed chains. Local/compose URLs carry
 * no sslmode, so SSL stays off and nothing changes for development or tests.
 */
function resolveSsl(
  databaseUrl: string,
): boolean | { rejectUnauthorized: false } | undefined {
  const noVerify = process.env.DATABASE_SSL_NO_VERIFY === "true";
  let sslmode: string | null = null;
  try {
    sslmode = new URL(databaseUrl).searchParams.get("sslmode");
  } catch {
    sslmode = null;
  }
  const wantsSsl =
    noVerify ||
    process.env.DATABASE_SSL === "true" ||
    (sslmode !== null && sslmode !== "disable");
  if (!wantsSsl) return undefined;
  return noVerify ? { rejectUnauthorized: false } : true;
}

export function createDatabaseConnection(databaseUrl: string): DatabaseConnection {
  const ssl = resolveSsl(databaseUrl);
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "planeir-learning-signals",
    connectionTimeoutMillis: 5_000,
    max: 10,
    ...(ssl === undefined ? {} : { ssl }),
  });

  return {
    db: drizzle(pool),
    pool,
  };
}

export async function waitForPostgres(pool: Pool, timeoutMilliseconds = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;

  while (true) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      const remainingMilliseconds = deadline - Date.now();
      if (remainingMilliseconds <= 0) {
        const timeoutSeconds = Math.ceil(timeoutMilliseconds / 1_000);
        throw new Error(`PostgreSQL did not become ready within ${timeoutSeconds} seconds.`, {
          cause: error,
        });
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1_000, remainingMilliseconds)),
      );
    }
  }
}
