import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabaseConnection, waitForPostgres } from "./db/client.js";

const config = loadConfig();
const connection = createDatabaseConnection(config.databaseUrl);
const app = buildApp(config);

try {
  await waitForPostgres(connection.pool);
  await app.listen({ host: config.host, port: config.port });
} catch (_error) {
  console.error("Learning-signal service failed to start.");
  await connection.pool.end();
  process.exitCode = 1;
}

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await app.close();
  await connection.pool.end();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

