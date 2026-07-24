import { loadConfig } from "../config.js";
import { createDatabaseConnection, waitForPostgres } from "../db/client.js";
import { runSeed } from "./seed.js";

// Loads the demo fixture into the configured database by driving the real
// ingestion, publish, and corrections routes. Run with `make seed` against a
// migrated database. Prints the created identities and API key secrets (this is
// a dev fixture; the secrets exist only for local exploration).
async function main(): Promise<void> {
  const config = loadConfig();
  const connection = createDatabaseConnection(config.databaseUrl);
  try {
    await waitForPostgres(connection.pool);
    const summary = await runSeed(connection);
    console.log("Seed complete.");
    console.log(`  tenant_id:        ${summary.tenantId}`);
    console.log(`  module versions:  ${summary.moduleVersionIds.length}`);
    console.log(`  sessions:         ${Object.keys(summary.sessionIds).length}`);
    console.log(`  event types:      ${summary.eventTypesIngested.length}`);
    console.log(`  correction codes: ${summary.correctionReasonCodes.join(", ")}`);
    console.log("  API keys (dev only):");
    console.log(`    ingest:      ${summary.secrets.ingest}`);
    console.log(`    corrections: ${summary.secrets.corrections}`);
    console.log(`    admin:       ${summary.secrets.admin}`);
  } finally {
    await connection.pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Seed failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
