import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { loadConfig } from "../config.js";
import { createDatabaseConnection, waitForPostgres } from "./client.js";

const config = loadConfig();
const connection = createDatabaseConnection(config.databaseUrl);

try {
  await waitForPostgres(connection.pool);
  await migrate(connection.db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
  console.log("PostgreSQL migrations applied successfully.");
} finally {
  await connection.pool.end();
}

