import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";

import type { DatabaseTransaction } from "../db/client.js";

export const CONSENT_TYPES = [
  "service_improvement_telemetry",
  "partner_benchmarking",
  "optional_demographics",
  "marketing_referral",
] as const;

export type ConsentType = (typeof CONSENT_TYPES)[number];
export type ConsentAction = "granted" | "denied" | "withdrawn";

export const EVENT_CONSENT_CLASSIFICATIONS = [
  "contract_necessity",
  "improvement_signal",
  "optional_demographics",
  "marketing_referral",
  "consent_control",
] as const;

export type EventConsentClassification =
  (typeof EVENT_CONSENT_CLASSIFICATIONS)[number];

export type ResolvedConsentDecision = {
  action: ConsentAction;
  decisionTs: Date;
  receivedAt: Date;
  consentId: string;
};

export type ConsentState = Readonly<
  Partial<Record<ConsentType, ResolvedConsentDecision>>
>;

export type ConsentStateRequest = {
  tenantId: string;
  sessionId: string;
};

/**
 * Both methods implement the same query. The transaction overload keeps API
 * ingestion and consent resolution in one PostgreSQL transaction; the client
 * overload lets the outbox re-check current consent immediately before a
 * third-party delivery.
 */
export interface ConsentStateResolver {
  resolveCurrent(
    transaction: DatabaseTransaction,
    request: ConsentStateRequest,
  ): Promise<ConsentState>;
  resolveCurrentWithClient(
    client: PoolClient,
    request: ConsentStateRequest,
  ): Promise<ConsentState>;
}

type ConsentStateRow = {
  consent_id: string;
  purpose: string;
  action: string;
  decision_ts: Date;
  received_at: Date;
};

const currentConsentSql = `
  select distinct on (purpose)
         consent_id, purpose, action, decision_ts, received_at
    from consent_ledger
   where tenant_id = $1::uuid
     and session_id = $2::uuid
   order by purpose,
            decision_ts desc,
            received_at desc,
            case action
              when 'withdrawn' then 3
              when 'denied' then 2
              when 'granted' then 1
              else 0
            end desc,
            consent_id desc
`;

function isConsentType(value: string): value is ConsentType {
  return (CONSENT_TYPES as readonly string[]).includes(value);
}

function isConsentAction(value: string): value is ConsentAction {
  return value === "granted" || value === "denied" || value === "withdrawn";
}

function consentStateFromRows(rows: readonly ConsentStateRow[]): ConsentState {
  const state: Partial<Record<ConsentType, ResolvedConsentDecision>> = {};
  for (const row of rows) {
    if (!isConsentType(row.purpose) || !isConsentAction(row.action)) {
      // The M4 database constraints make this unreachable. Failing closed by
      // ignoring an unrecognised row is safer than treating it as acceptance.
      continue;
    }
    state[row.purpose] = {
      action: row.action,
      decisionTs: new Date(row.decision_ts),
      receivedAt: new Date(row.received_at),
      consentId: row.consent_id,
    };
  }
  return Object.freeze(state);
}

export class PostgresConsentStateResolver
  implements ConsentStateResolver, ConsentResolver
{
  async canPersist(request: ConsentRequest): Promise<boolean> {
    return request.scope === "essential";
  }

  async resolveCurrent(
    transaction: DatabaseTransaction,
    request: ConsentStateRequest,
  ): Promise<ConsentState> {
    const result = await transaction.execute<ConsentStateRow>(
      sql`
        select distinct on (purpose)
               consent_id, purpose, action, decision_ts, received_at
          from consent_ledger
         where tenant_id = ${request.tenantId}::uuid
           and session_id = ${request.sessionId}::uuid
         order by purpose,
                  decision_ts desc,
                  received_at desc,
                  case action
                    when 'withdrawn' then 3
                    when 'denied' then 2
                    when 'granted' then 1
                    else 0
                  end desc,
                  consent_id desc
      `,
    );
    return consentStateFromRows(result.rows);
  }

  async resolveCurrentWithClient(
    client: PoolClient,
    request: ConsentStateRequest,
  ): Promise<ConsentState> {
    const result = await client.query<ConsentStateRow>(currentConsentSql, [
      request.tenantId,
      request.sessionId,
    ]);
    return consentStateFromRows(result.rows);
  }
}

export type ConsentGateEvent = {
  eventType: string;
  classification: EventConsentClassification | undefined;
};

export type ConsentGateContext = {
  /**
   * Set by metrics/partner jobs from the durable subject restriction written
   * on withdrawal. The outbox normally relies on the live current state, but
   * may also pass this flag when it has already joined that restriction.
   */
  processingRestricted?: boolean;
};

export type ConsentGateDecision = {
  persist: boolean;
  forwardPosthog: boolean;
  forwardOtel: boolean;
  includeMetrics: boolean;
  includePartner: boolean;
  reason:
    | "allowed"
    | "consent_not_granted"
    | "withdrawn"
    | "unclassified_event"
    | "purpose_limited";
};

export function consentAccepted(
  state: ConsentState,
  consentType: ConsentType,
): boolean {
  return state[consentType]?.action === "granted";
}

export function hasCurrentWithdrawal(state: ConsentState): boolean {
  return Object.values(state).some((decision) => decision?.action === "withdrawn");
}

/**
 * The single, side-effect-free M4 consent choke point. Event configuration
 * chooses one closed classification; this exhaustive matrix owns all legal
 * processing decisions so configuration cannot weaken the policy.
 *
 * Optional-purpose data is deliberately not sent to the shared analytics or
 * trace sinks. A later purpose-bound sink may be added explicitly, but must
 * not inherit PostHog/OTel eligibility by accident.
 */
export function consentGate(
  event: ConsentGateEvent,
  state: ConsentState,
  context: ConsentGateContext = {},
): ConsentGateDecision {
  const restricted =
    context.processingRestricted === true || hasCurrentWithdrawal(state);
  const serviceImprovementAccepted = consentAccepted(
    state,
    "service_improvement_telemetry",
  );
  const partnerBenchmarkingAccepted = consentAccepted(
    state,
    "partner_benchmarking",
  );

  switch (event.classification) {
    case "contract_necessity": {
      const forward = serviceImprovementAccepted && !restricted;
      return {
        persist: true,
        forwardPosthog: forward,
        forwardOtel: forward,
        includeMetrics: !restricted,
        // Contract records are not repurposed into partner cohorts. Partner
        // jobs consume explicitly classified improvement signals instead.
        includePartner: false,
        reason: restricted
          ? "withdrawn"
          : forward
            ? "allowed"
            : "consent_not_granted",
      };
    }

    case "improvement_signal": {
      const forward = serviceImprovementAccepted && !restricted;
      const includePartner = partnerBenchmarkingAccepted && !restricted;
      return {
        // Minimized improvement signals persist and feed internal metrics
        // under the documented legitimate-interest basis.
        persist: true,
        forwardPosthog: forward,
        forwardOtel: forward,
        includeMetrics: !restricted,
        includePartner,
        reason: restricted
          ? "withdrawn"
          : forward
            ? "allowed"
            : "consent_not_granted",
      };
    }

    case "optional_demographics": {
      const ownConsent = consentAccepted(state, "optional_demographics");
      const persist = ownConsent && !restricted;
      return {
        persist,
        forwardPosthog: false,
        forwardOtel: false,
        includeMetrics: persist,
        includePartner:
          persist && partnerBenchmarkingAccepted,
        reason: restricted
          ? "withdrawn"
          : persist
            ? "purpose_limited"
            : "consent_not_granted",
      };
    }

    case "marketing_referral": {
      const persist =
        consentAccepted(state, "marketing_referral") && !restricted;
      return {
        persist,
        forwardPosthog: false,
        forwardOtel: false,
        includeMetrics: false,
        includePartner: false,
        reason: restricted
          ? "withdrawn"
          : persist
            ? "purpose_limited"
            : "consent_not_granted",
      };
    }

    case "consent_control":
      return {
        persist: true,
        forwardPosthog: false,
        forwardOtel: false,
        includeMetrics: false,
        includePartner: false,
        reason: "purpose_limited",
      };

    default:
      return {
        persist: false,
        forwardPosthog: false,
        forwardOtel: false,
        includeMetrics: false,
        includePartner: false,
        reason: "unclassified_event",
      };
  }
}

// Kept as a source-compatible name while M2 call sites are migrated. It now
// performs real PostgreSQL resolution; it is no longer an allow-all pilot.
export class PilotConsentResolver extends PostgresConsentStateResolver {}

export type ConsentRequest = {
  tenantId: string;
  sessionId: string;
  eventType: string;
  scope: "essential";
};

/** @deprecated M4 call sites must use ConsentStateResolver + consentGate. */
export interface ConsentResolver {
  canPersist(request: ConsentRequest): Promise<boolean>;
}
