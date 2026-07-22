import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export type DatabaseConnection = {
  db: NodePgDatabase;
  pool: Pool;
};

export function createDatabaseConnection(databaseUrl: string): DatabaseConnection {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "planeir-learning-signals",
    connectionTimeoutMillis: 1_000,
    max: 10,
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
