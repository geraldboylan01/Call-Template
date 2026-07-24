import { loadConfig } from "../config.js";
import { createDatabaseConnection, waitForPostgres } from "../db/client.js";
import { provisionTenant } from "./provision.js";

// Onboards a firm as a tenant. Usage:
//   npm run provision -- <slug> "<display name>" ["<initial module title>"]
// Prints the API key secrets and the pseudonymisation secret ONCE — store them
// in your secret manager. Add the printed TENANT_SECRETS_JSON entry to the
// service's environment (or KMS) before ingesting sessions or corrections for
// this tenant, since both pseudonymise with the managed key.
async function main(): Promise<void> {
  const [slug, displayName, moduleTitle] = process.argv.slice(2);
  if (!slug || !displayName) {
    console.error('Usage: npm run provision -- <slug> "<display name>" ["<module title>"]');
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const connection = createDatabaseConnection(config.databaseUrl);
  try {
    await waitForPostgres(connection.pool);
    const summary = await provisionTenant(connection, {
      slug,
      displayName,
      ...(moduleTitle ? { moduleTitle } : {}),
    });
    console.log(`Provisioned tenant ${summary.tenantId} (${slug}).`);
    console.log("API keys — store securely, shown once:");
    console.log(`  ingest:      ${summary.secrets.ingest}`);
    console.log(`  corrections: ${summary.secrets.corrections}`);
    console.log(`  admin:       ${summary.secrets.admin}`);
    console.log(`  read:        ${summary.secrets.read}   (analytics dashboard; set as the Worker's LEARNING_SIGNALS_READ_KEY)`);
    console.log("Add this entry to TENANT_SECRETS_JSON (merge with any existing tenants):");
    console.log(`  ${summary.tenantSecretsJson}`);
    if (summary.moduleVersionId) {
      console.log(`Published module ${summary.moduleId} version 1.0.0 -> ${summary.moduleVersionId}`);
    }
  } finally {
    await connection.pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Provision failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
