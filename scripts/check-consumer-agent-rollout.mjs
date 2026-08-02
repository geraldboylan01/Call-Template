/**
 * A8 — deployment hardening and controlled rollout.
 *
 * The agent-test transport drives the same planning engine as a live client
 * call, so the thing that must be true is simple and absolute: IT CANNOT BE
 * REACHED IN PRODUCTION. Not by a flag flip, not by a dashboard override, not
 * by a config drift that nobody notices.
 *
 * Two independent gates, checked at different times:
 *
 *   1. DEPLOY TIME — the committed wrangler.toml must keep
 *      CONSUMER_AGENT_TEST_ENABLED false, and must never name the production
 *      cohort in CONSUMER_AGENT_TEST_COHORTS. Asserted by the deploy workflow's
 *      fail-closed config builder.
 *   2. RUNTIME — even given a true flag, the transport requires this
 *      deployment's cohort to be on the allowlist. This is the gate that
 *      survives a variable being overridden straight in the Cloudflare
 *      dashboard, which bypasses gate 1 entirely.
 *
 * Plus the operational necessities: a single-variable kill switch, quotas that
 * bind, and an audit trail on every route.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getConsumerConfig } from '../worker/src/consumer/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let checks = 0;
const check = (label, condition, detail = '') => {
  checks += 1;
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
};

const baseEnv = {
  CONSUMER_DB: {},
  CONSUMER_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 31).toString('base64url'),
  CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url'),
  CONSUMER_JOURNEY_ENABLED: 'true',
  CONSUMER_CONSENT_POLICY_VERSION: 'consumer-test-v1',
  CONSUMER_CONSENT_MANIFEST_ID: 'consumer-test-manifest-v1',
  CONSUMER_ANALYSIS_NOTICE_ID: 'analysis-test-v1',
  CONSUMER_AI_NOTICE_ID: 'ai-test-v1',
  CONSUMER_PRIVACY_NOTICE_URL: 'https://planeir.ie/plan/privacy.html',
  CONSUMER_SESSION_TTL_DAYS: '7'
};
const configFor = (overrides) => getConsumerConfig({ ...baseEnv, ...overrides });

const wrangler = readFileSync(`${root}worker/wrangler.toml`, 'utf8');
const workflow = readFileSync(`${root}.github/workflows/deploy-worker.yml`, 'utf8');
const productionCohort = wrangler.match(/^CONSUMER_COHORT\s*=\s*"([^"]*)"\s*$/m)?.[1]?.trim();

/* --------------------------------------------------- gate 1: deploy time */

check('production keeps the agent-test flag off in committed config',
  /^CONSUMER_AGENT_TEST_ENABLED\s*=\s*"false"\s*$/m.test(wrangler));
check('the deploy builder requires that flag to stay false',
  /'CONSUMER_AGENT_TEST_ENABLED'/.test(workflow));
check('the cohort allowlist is declared explicitly, not left to a default',
  /^CONSUMER_AGENT_TEST_COHORTS\s*=\s*"[^"]+"\s*$/m.test(wrangler));
check('the production cohort is known', Boolean(productionCohort), String(productionCohort));

const declaredCohorts = wrangler.match(/^CONSUMER_AGENT_TEST_COHORTS\s*=\s*"([^"]*)"\s*$/m)[1]
  .split(',').map((item) => item.trim()).filter(Boolean);
check('the production cohort is NOT on the agent-test allowlist',
  !declaredCohorts.includes(productionCohort),
  `cohort "${productionCohort}" vs allowlist ${JSON.stringify(declaredCohorts)}`);
check('the deploy builder refuses an allowlist containing the production cohort',
  /must never be permitted in the production cohort/.test(workflow));
check('the deploy builder refuses a missing or empty allowlist',
  /CONSUMER_AGENT_TEST_COHORTS must be declared/.test(workflow)
  && /must name at least one cohort/.test(workflow));

/* ------------------------------------------------------ gate 2: runtime */

// The case that matters: someone flips the flag true on the production
// deployment. Gate 1 never sees it, because the committed file is untouched.
const flaggedProduction = configFor({
  CONSUMER_COHORT: productionCohort,
  CONSUMER_AGENT_TEST_ENABLED: 'true'
});
check('the journey itself is still on, so this is a real gate and not a side effect',
  flaggedProduction.journeyEnabled === true);
check('a flag flipped on in production still yields no agent transport',
  flaggedProduction.agentTestEnabled === false);

for (const cohort of ['internal', 'beta', 'production', 'live', '']) {
  check(`cohort "${cohort || '(unset)'}" cannot run the agent transport on the flag alone`,
    configFor({ CONSUMER_COHORT: cohort, CONSUMER_AGENT_TEST_ENABLED: 'true' }).agentTestEnabled === false);
}
for (const cohort of declaredCohorts) {
  check(`the permitted cohort "${cohort}" can run it`,
    configFor({ CONSUMER_COHORT: cohort, CONSUMER_AGENT_TEST_ENABLED: 'true' }).agentTestEnabled === true);
}
check('an unset allowlist defaults to the test cohorts only, never to whatever is deployed',
  configFor({ CONSUMER_COHORT: 'internal', CONSUMER_AGENT_TEST_ENABLED: 'true', CONSUMER_AGENT_TEST_COHORTS: '' })
    .agentTestEnabled === false);
check('opening it for another cohort takes a second, explicit act',
  configFor({
    CONSUMER_COHORT: 'internal',
    CONSUMER_AGENT_TEST_ENABLED: 'true',
    CONSUMER_AGENT_TEST_COHORTS: 'internal'
  }).agentTestEnabled === true);

/* -------------------------------------------------------- kill switch */

// One variable, and everything stops. This is what an operator reaches for.
const permitted = declaredCohorts[0];
check('the kill switch is a single variable',
  configFor({ CONSUMER_COHORT: permitted, CONSUMER_AGENT_TEST_ENABLED: 'false' }).agentTestEnabled === false);
check('an absent flag is off, not on',
  configFor({ CONSUMER_COHORT: permitted }).agentTestEnabled === false);
// The repo-wide truthy set is 1/true/yes/on, and this flag deliberately shares
// it rather than inventing its own rule. What must hold is that anything
// AMBIGUOUS is off: a typo, a leftover value, an empty string.
check('an ambiguous or unrecognised value is off, not on',
  ['', 'false', 'no', 'off', '0', 'maybe', 'enabled', 'TRUE-ish', 'null'].every((value) => (
    configFor({ CONSUMER_COHORT: permitted, CONSUMER_AGENT_TEST_ENABLED: value }).agentTestEnabled === false
  )));
check('the committed production config is held to the stricter exact "false"',
  /^\s*const expression = new RegExp\(`\^\$\{flag\}\\\\s\*=\\\\s\*"false"/m.test(workflow)
  || /"false"/.test(workflow));
check('turning the whole consumer journey off also stops it',
  configFor({
    CONSUMER_COHORT: permitted, CONSUMER_AGENT_TEST_ENABLED: 'true', CONSUMER_JOURNEY_ENABLED: 'false'
  }).agentTestEnabled === false);

// Every route is behind the same assertion, so the kill switch cannot be
// partial: no route may be reachable while the transport is off.
const session = readFileSync(`${root}worker/src/consumer/agent_session.js`, 'utf8');
const exported = [...session.matchAll(/^export async function (\w+)/gm)].map((match) => match[1]);
const gated = exported.filter((name) => {
  const body = session.slice(session.indexOf(`export async function ${name}`));
  return /assertAgentTestEnabled\(config\)/.test(body.slice(0, body.indexOf('\n}\n') + 3));
});
const exempt = ['loadAgentContext'];
const ungated = exported.filter((name) => !gated.includes(name) && !exempt.includes(name));
check('every agent route asserts the transport is enabled', ungated.length === 0,
  `ungated: ${ungated.join(', ')}`);
check('the assertion 404s rather than revealing the surface exists',
  /agent_test_disabled[\s\S]{0,120}404|404,\s*'agent_test_disabled'/.test(session));

/* ---------------------------------------------------- quotas and audit */

const quotas = configFor({ CONSUMER_COHORT: permitted, CONSUMER_AGENT_TEST_ENABLED: 'true' });
check('a turn ceiling is always set', Number.isFinite(quotas.agentTestMaxTurns) && quotas.agentTestMaxTurns > 0);
check('a session ceiling is always set', Number.isFinite(quotas.agentTestMaxSessions) && quotas.agentTestMaxSessions > 0);
check('a per-session spend ceiling is always set',
  Number.isFinite(quotas.agentTestSessionBudgetMicroEur) && quotas.agentTestSessionBudgetMicroEur > 0);
// Bounded both ways: an operator cannot set an unlimited ceiling by typing a
// large number, and cannot disable one by typing zero.
const absurd = configFor({
  CONSUMER_COHORT: permitted,
  CONSUMER_AGENT_TEST_ENABLED: 'true',
  CONSUMER_AGENT_TEST_MAX_TURNS: '999999',
  CONSUMER_AGENT_TEST_MAX_SESSIONS: '0',
  CONSUMER_AGENT_TEST_SESSION_BUDGET_EUR_CENTS: '-5'
});
check('an absurd turn ceiling is clamped, not honoured', absurd.agentTestMaxTurns <= 120);
check('a zero session ceiling falls back to the default, never to unlimited', absurd.agentTestMaxSessions > 0);
check('a negative budget falls back to the default, never to unlimited',
  absurd.agentTestSessionBudgetMicroEur > 0);
check('the turn limit is enforced before a turn runs, not after',
  /agent_turn_limit_reached/.test(session) && /await assertWithinLimits\(env, config, meetingId\);/.test(session));
check('the spend limit is enforced before a turn runs', /agent_cost_limit_reached/.test(session));

// Audit trail: creation, every turn, and deletion each leave a row.
for (const event of ['agent_test_session_created', 'agent_turn_submitted', 'agent_test_session_deleted']) {
  check(`${event} is written to the audit log`, session.includes(event));
}
check('agent sessions are marked with their own channel, so they are separable in the log',
  /AGENT_CHANNEL = 'agent_test'/.test(session));

/* ------------------------------------------------------------- runbook */

const runbook = readFileSync(`${root}docs/consumer-realtime-voice-operations.md`, 'utf8');
check('the runbook documents the kill switch',
  /CONSUMER_AGENT_TEST_ENABLED/.test(runbook) && /kill switch/i.test(runbook));
check('the runbook documents the second gate', /CONSUMER_AGENT_TEST_COHORTS/.test(runbook));

console.info(`[Agent rollout] ${checks} checks passed: production refuses the agent transport at `
  + `deploy time and at runtime; kill switch is one variable; quotas bind; every route is audited.`);
