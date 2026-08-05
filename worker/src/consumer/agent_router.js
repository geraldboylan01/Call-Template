/**
 * The protected agent-test HTTP surface.
 *
 * ADVISER AUTHENTICATED. FEATURE FLAGGED OFF BY DEFAULT. SYNTHETIC DATA ONLY.
 * This is a testing facility for advisers and developers; it is not, and must
 * not become, a public typed consumer journey. Adviser authentication and the
 * trusted-origin/CSRF checks are applied by the caller in index.js before any
 * of this runs.
 *
 * No route here accepts a module id from the client. Offers, capacity choices
 * and the execution set are server-owned throughout, exactly as in voice.
 */

import { getConsumerConfig } from './config.js';
import { ConsumerError, notFound } from './errors.js';
import { createConsumerCredential } from './crypto.js';
import { createSessionRecord, deleteSessionData, getSessionRow } from './repository.js';
import { countAgentTestSessions, getActiveAgentMeeting } from './agent_repository.js';
import {
  confirmAgentPlan,
  createAgentTestSession,
  deleteAgentTestSession,
  exportAgentSession,
  getAgentSessionState,
  processAgentTurn,
  resolveAgentCapacity,
  resolveAgentOffer
} from './agent_session.js';
import { createTraceCollector, flushTraces, hashedTraceSessionId } from './tracing.js';

const MAX_BODY_BYTES = 32_000;
const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_-]{20,80}$/;

async function readJson(request, { optional = false } = {}) {
  const text = await request.text();
  if (!text && optional) return {};
  if (!text || new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new ConsumerError(
      text ? 413 : 400,
      text ? 'request_too_large' : 'invalid_json',
      text ? 'Request body is too large.' : 'A JSON body is required.'
    );
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new ConsumerError(400, 'invalid_json', 'Invalid JSON body.');
  }
}

export function agentRouteMatch(pathname) {
  if (pathname === '/api/agent-tests/sessions') return { kind: 'create', methods: ['POST'] };
  const match = /^\/api\/agent-tests\/sessions\/(cs_[A-Za-z0-9_-]{20,80})(?:\/(turns|state|export|decisions\/offer|decisions\/capacity|confirm))?$/
    .exec(pathname);
  if (!match) return null;
  const [, sessionId, child] = match;
  if (!child) return { kind: 'session', sessionId, methods: ['GET', 'DELETE'] };
  const methods = {
    turns: ['POST'],
    state: ['GET'],
    export: ['GET'],
    'decisions/offer': ['POST'],
    'decisions/capacity': ['POST'],
    confirm: ['POST']
  };
  return { kind: child, sessionId, methods: methods[child] };
}

/** Synthetic consent for a test session. No real client data is ever involved. */
function syntheticConsent(config) {
  return {
    analysis: true,
    aiProcessing: false,
    adultConfirmed: true,
    educationOnlyAcknowledged: true,
    manifestId: config.consentManifestId,
    policyVersion: config.consentPolicyVersion,
    analysisNoticeId: config.analysisNoticeId,
    aiNoticeId: config.aiNoticeId,
    privacyNoticeUrl: config.privacyNoticeUrl
  };
}

async function requireAgentMeeting(env, sessionId) {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw notFound();
  const sessionRow = await getSessionRow(env, sessionId);
  if (!sessionRow || sessionRow.deleted_at) throw notFound();
  const meeting = await getActiveAgentMeeting(env, sessionId);
  // A session without an agent meeting is not an agent-test session. Refusing
  // here is what stops these routes reaching an ordinary consumer session.
  if (!meeting) throw notFound();
  return { sessionRow, meeting };
}

function errorPayload(error) {
  if (error instanceof ConsumerError) {
    return { status: error.status, body: { ok: false, code: error.code, message: error.message } };
  }
  console.error('Agent-test route failure', {
    message: error instanceof Error ? error.message : String(error)
  });
  return { status: 500, body: { ok: false, code: 'agent_test_failed', message: 'The test request failed.' } };
}

export async function handleAgentTestRequest(request, env, { pathname, respond, executionCtx = null }) {
  const route = agentRouteMatch(pathname);
  if (!route) return respond({ ok: false, code: 'not_found' }, 404, 'OPTIONS');
  const methods = `${route.methods.join(',')},OPTIONS`;
  if (!route.methods.includes(request.method)) {
    return respond({ ok: false, code: 'method_not_allowed' }, 405, methods);
  }

  try {
    const config = getConsumerConfig(env);
    // Flag off means these routes do not exist at all.
    if (!config.agentTestEnabled) throw notFound();

    if (route.kind === 'create') {
      const active = await countAgentTestSessions(env);
      if (active >= config.agentTestMaxSessions) {
        throw new ConsumerError(429, 'agent_session_limit_reached', 'Too many active test sessions.');
      }
      const body = await readJson(request, { optional: true });
      const scenarioId = typeof body.scenarioId === 'string' ? body.scenarioId.slice(0, 120) : null;
      const created = await createAgentTestSession(env, config, {
        scenarioId,
        createSession: async () => {
          const credential = await createConsumerCredential('');
          await createSessionRecord(env, credential, syntheticConsent(config), config, null);
          return { sessionId: credential.id, credential: credential.credential };
        }
      });
      return respond({
        ok: true,
        sessionId: created.sessionId,
        meetingId: created.meetingId,
        scenarioId: created.scenarioId,
        limits: {
          maxTurns: config.agentTestMaxTurns,
          maxMessageLength: config.maxMessageLength,
          sessionBudgetMicroEur: config.agentTestSessionBudgetMicroEur
        }
      }, 201, methods);
    }

    const { meeting } = await requireAgentMeeting(env, route.sessionId);
    const shared = { sessionId: route.sessionId, meetingId: meeting.id };

    if (route.kind === 'turns') {
      const body = await readJson(request);
      // This transport is only reachable from a cohort in
      // CONSUMER_AGENT_TEST_COHORTS, which is the same list that decides whether
      // conversation text may be exported. A turn here is therefore traced in
      // full — it is one of ours by definition.
      const trace = createTraceCollector({
        env,
        config,
        lane: 'agent_test',
        sessionIdHash: await hashedTraceSessionId(route.sessionId)
      });
      try {
        const result = await processAgentTurn(env, config, {
          ...shared,
          message: body.message,
          expectedRevision: Number.isSafeInteger(body.expectedRevision) ? body.expectedRevision : null,
          trace
        });
        return respond({ ok: true, ...result }, 200, methods);
      } finally {
        flushTraces(trace, executionCtx);
      }
    }

    if (route.kind === 'state') {
      return respond({ ok: true, ...(await getAgentSessionState(env, config, shared)) }, 200, methods);
    }

    if (route.kind === 'export') {
      return respond({ ok: true, ...(await exportAgentSession(env, config, shared)) }, 200, methods);
    }

    if (route.kind === 'decisions/offer') {
      const body = await readJson(request);
      const result = await resolveAgentOffer(env, config, {
        ...shared,
        decision: body.decision,
        expectedRevision: Number.isSafeInteger(body.expectedRevision) ? body.expectedRevision : null
      });
      return respond({ ok: true, ...result }, 200, methods);
    }

    if (route.kind === 'decisions/capacity') {
      const body = await readJson(request);
      const result = await resolveAgentCapacity(env, config, {
        ...shared,
        decision: body.decision,
        replaceChoiceIndex: body.replaceChoiceIndex,
        expectedRevision: Number.isSafeInteger(body.expectedRevision) ? body.expectedRevision : null
      });
      return respond({ ok: true, ...result }, 200, methods);
    }

    if (route.kind === 'confirm') {
      const body = await readJson(request, { optional: true });
      const result = await confirmAgentPlan(env, config, {
        ...shared,
        expectedRevision: Number.isSafeInteger(body.expectedRevision) ? body.expectedRevision : null
      });
      return respond({ ok: true, ...result }, 200, methods);
    }

    if (route.kind === 'session' && request.method === 'GET') {
      return respond({ ok: true, ...(await getAgentSessionState(env, config, shared)) }, 200, methods);
    }

    if (route.kind === 'session' && request.method === 'DELETE') {
      const result = await deleteAgentTestSession(env, config, {
        ...shared,
        deleteSession: () => deleteSessionData(env, route.sessionId, 'deleted')
      });
      return respond({ ok: true, ...result }, 200, methods);
    }

    throw notFound();
  } catch (error) {
    const mapped = errorPayload(error);
    return respond(mapped.body, mapped.status, methods);
  }
}
