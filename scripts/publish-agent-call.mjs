/**
 * Put a finished test call in front of a person, on the real site.
 *
 * A call rendered to a local file proves the page is right; it does not prove
 * the client can open it. This takes the result of an agent-driven call,
 * converts it with the same builder the consumer publish route uses, encrypts
 * it with the same crypto the app uses, and stores it on the live Worker so the
 * links actually resolve.
 *
 *   ADVISOR_SMOKE_PASSWORD=... node ./scripts/publish-agent-call.mjs agent-calls/x-result.json
 *
 * THE CREDENTIAL IS NEVER HANDLED HERE beyond being read from the environment
 * and posted to the login route, exactly as the deploy smoke check already
 * does. It is not logged, not written to a file, and not included in output.
 *
 * The two links carry their key in the URL FRAGMENT, so the secret is never
 * sent to the server, never written to an access log and never carried in a
 * Referer header.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { encryptPublishedSessionV4 } from '../js/crypto_session.js';
import { buildPublishedSessionFromCall } from '../js/planning/session_payload.js';
import { makeConfig, makeEnv, openCallDatabase } from './agent-harness/transports.mjs';
import { loadAgentContext } from '../worker/src/consumer/agent_session.js';

const resultPath = process.argv[2];
assert.ok(resultPath, 'Usage: node ./scripts/publish-agent-call.mjs <result.json>');

const baseUrl = String(process.env.WORKER_BASE_URL
  || 'https://call-canvas-session-worker.geraldboylan.workers.dev').replace(/\/+$/, '');
const origin = String(process.env.SMOKE_ORIGIN || 'https://planeir.ie');
const password = String(process.env.ADVISOR_SMOKE_PASSWORD || '').trim();
assert.ok(password, 'ADVISOR_SMOKE_PASSWORD is required to store a published session.');

const call = JSON.parse(readFileSync(resultPath, 'utf8'));
const clientName = String(process.argv[3] || call.callId || 'Test client');

/**
 * The profile the analyses ran against, read from the call's own database.
 *
 * Deliberately not re-derived from the transcript: the published page must show
 * what the engine actually calculated on, so it comes from the same store the
 * analyses read.
 */
const pointer = JSON.parse(readFileSync(
  resultPath.replace(/-result\.json$/, '-pointer.json'), 'utf8'
));
const env = makeEnv(openCallDatabase(pointer.databasePath), {});
const { profile } = await loadAgentContext(env, makeConfig(env), pointer.sessionId, pointer.meetingId);
assert.ok(profile, 'The call database has no confirmed profile to publish.');

const { session, skipped } = buildPublishedSessionFromCall({
  profile,
  results: call.results || [],
  clientName,
  sessionId: `call-${call.callId}`
});
assert.ok(session.modules.length > 0, 'Nothing in this call can be published yet.');

const sessionJson = JSON.stringify(session);
const encrypted = await encryptPublishedSessionV4({
  clientSessionJson: sessionJson,
  advisorSessionJson: sessionJson,
  clientName,
  expiresInDays: 30
});

/* --------------------------------------------------------------- transport */

const cookies = new Map();
function applyCookies(response) {
  for (const raw of response.headers.getSetCookie?.() || []) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}
const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');

async function call_(path, { method = 'GET', body = null, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Origin: origin,
      ...(cookies.size ? { Cookie: cookieHeader() } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  applyCookies(response);
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (_error) { /* non-JSON is reported below */ }
  return { status: response.status, payload, text };
}

const login = await call_('/api/auth/login', { method: 'POST', body: { password } });
assert.equal(login.payload?.authenticated, true,
  `Adviser login failed (${login.status}). Check ADVISOR_SMOKE_PASSWORD.`);
const csrfToken = String(login.payload?.csrfToken || '');
assert.match(csrfToken, /^[A-Za-z0-9_-]{32,}$/, 'Login did not return a usable CSRF token.');

const created = await call_('/api/published-sessions', {
  method: 'POST',
  body: encrypted.requestBody,
  headers: { 'X-Advisor-CSRF': csrfToken }
});
assert.equal(created.status, 201, `Publishing failed (${created.status}): ${created.text.slice(0, 300)}`);

const publishedId = String(created.payload?.id || created.payload?.publishedId || '');
assert.ok(publishedId, `The worker did not return a published id: ${created.text.slice(0, 200)}`);

const base = String(process.env.CONSUMER_PLAN_BASE_URL || 'https://planeir.ie').replace(/\/+$/, '');
console.info(`\n${clientName} — ${session.modules.length} analysis/analyses published`);
if (skipped.length) console.info(`  (no publish builder yet, skipped: ${skipped.join(', ')})`);
console.info(`\n  CLIENT   ${base}/app/session.html?id=${encodeURIComponent(publishedId)}#k=${encrypted.clientSecretB64u}`);
console.info(`  ADVISER  ${base}/app/session.html?id=${encodeURIComponent(publishedId)}&role=advisor#k=${encrypted.advisorSecretB64u}`);
console.info('\n  Both links expire in 30 days. The key after # never reaches the server.');
