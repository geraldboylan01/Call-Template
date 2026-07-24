import { randomBytes, randomUUID } from "node:crypto";

import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { DatabaseConnection } from "../db/client.js";
import { sha256Hex } from "../telemetry/canonical-json.js";

// Onboards one firm as a tenant: creates the tenant row (which inherits the
// default retention policy), mints one API key per scope, generates the
// tenant's pseudonymisation secret, and — optionally — publishes an initial
// module version through the real publish route so sessions have something to
// pin. The plaintext key secrets and the pseudonymisation secret are returned
// once; they are the only place plaintext exists (only hashes are stored).

export type ProvisionOptions = {
  slug: string;
  displayName: string;
  moduleTitle?: string;
};

export type ProvisionSummary = {
  tenantId: string;
  secrets: { ingest: string; corrections: string; admin: string };
  tenantSecretsJson: string;
  moduleId?: string;
  moduleVersionId?: string;
};

function base64urlSecret(): string {
  return randomBytes(32).toString("base64url");
}

export async function provisionTenant(
  connection: DatabaseConnection,
  options: ProvisionOptions,
): Promise<ProvisionSummary> {
  const pool = connection.pool;
  const tenantId = randomUUID();
  const secrets = {
    ingest: `pk-ingest-${randomBytes(24).toString("base64url")}`,
    corrections: `pk-corrections-${randomBytes(24).toString("base64url")}`,
    admin: `pk-admin-${randomBytes(24).toString("base64url")}`,
  };
  const tenantSecret = base64urlSecret();
  const tenantSecretsJson = JSON.stringify({
    [tenantId]: { current_version: 1, keys: { "1": tenantSecret } },
  });

  await pool.query(
    `insert into tenants (tenant_id, slug, display_name) values ($1, $2, $3)`,
    [tenantId, options.slug, options.displayName],
  );
  await pool.query(
    `insert into api_keys (tenant_id, key_hash, scopes, actor_label) values
       ($1, $2, array['ingest']::text[], 'voice-orchestrator'),
       ($1, $3, array['corrections']::text[], 'adviser-ui'),
       ($1, $4, array['admin']::text[], 'module-admin')`,
    [
      tenantId,
      sha256Hex(secrets.ingest),
      sha256Hex(secrets.corrections),
      sha256Hex(secrets.admin),
    ],
  );

  let moduleId: string | undefined;
  let moduleVersionId: string | undefined;
  if (options.moduleTitle) {
    // Publish through the real route so provisioning exercises it too. The env
    // secrets provider is irrelevant to publishing (no pseudonymisation).
    const app = buildApp(loadConfig(), { connection });
    try {
      await app.ready();
      moduleId = randomUUID();
      const response = await app.inject({
        method: "POST",
        url: "/v1/module-versions/publish",
        headers: { authorization: `Bearer ${secrets.admin}` },
        payload: {
          module_id: moduleId,
          semantic_version: "1.0.0",
          module_json: { title: options.moduleTitle, sections: [] },
        },
      });
      if (response.statusCode !== 201) {
        throw new Error(`Provision publish failed (${response.statusCode}): ${response.body}`);
      }
      moduleVersionId = (response.json() as { module_version_id: string }).module_version_id;
    } finally {
      await app.close();
    }
  }

  return {
    tenantId,
    secrets,
    tenantSecretsJson,
    ...(moduleId !== undefined ? { moduleId } : {}),
    ...(moduleVersionId !== undefined ? { moduleVersionId } : {}),
  };
}
