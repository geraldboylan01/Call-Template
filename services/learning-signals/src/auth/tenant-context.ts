import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { DatabaseConnection } from "../db/client.js";
import { sha256Hex } from "../telemetry/canonical-json.js";

export type TenantContext = {
  tenantId: string;
  scopes: readonly string[];
  actorLabel: string | null;
};

export type AuthenticationResult =
  | { ok: true; context: TenantContext }
  | { ok: false; statusCode: 401 | 403 };

declare module "fastify" {
  interface FastifyRequest {
    tenantContext: TenantContext | null;
  }
}

function bearerSecret(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1];
}

export async function authenticateApiKey(
  pool: Pool,
  authorization: string | undefined,
  requiredScope?: string,
): Promise<AuthenticationResult> {
  const secret = bearerSecret(authorization);
  if (!secret) return { ok: false, statusCode: 401 };

  const result = await pool.query<{
    tenant_id: string;
    scopes: string[];
    actor_label: string | null;
  }>(
    `select key.tenant_id, key.scopes, key.actor_label
     from api_keys key
     join tenants tenant on tenant.tenant_id = key.tenant_id
     where key.key_hash = $1
       and key.revoked_at is null
       and tenant.status = 'active'
     limit 1`,
    [sha256Hex(secret)],
  );

  const row = result.rows[0];
  if (!row) return { ok: false, statusCode: 401 };
  if (requiredScope && !row.scopes.includes(requiredScope)) {
    return { ok: false, statusCode: 403 };
  }

  return {
    ok: true,
    context: {
      tenantId: row.tenant_id,
      scopes: row.scopes,
      actorLabel: row.actor_label,
    },
  };
}

export function authenticationHook(
  connection: DatabaseConnection,
  requiredScope?: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const result = await authenticateApiKey(
      connection.pool,
      request.headers.authorization,
      requiredScope,
    );
    if (!result.ok) {
      if (result.statusCode === 401) {
        reply.header("www-authenticate", 'Bearer realm="planeir-telemetry"');
        await reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      await reply.status(403).send({ error: "Forbidden" });
      return;
    }
    request.tenantContext = result.context;
  };
}
