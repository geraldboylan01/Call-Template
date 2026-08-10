/**
 * The bootstrap the Worker serves must satisfy the check that verifies it live.
 *
 * WHY THIS EXISTS. `check-consumer-live-deployment.mjs` is the gate that decides
 * whether a deployed Worker is running the approved protected configuration. It
 * reads `/api/consumer/bootstrap` and asserts field by field. The payload it
 * reads is produced by `publicConsumerConfig`.
 *
 * Those two were never compared to each other. The unit tests fed the validator
 * a payload built BY HAND in the test file, so the fixtures agreed with the
 * validator and the validator agreed with the fixtures, while the real
 * serialiser quietly emitted a different shape. `voice.sessionBudgetMicroEur`
 * was asserted live and never serialised at all, so the protected branch of that
 * validator could not pass against a real Worker -- and nobody found out until a
 * deploy got far enough to run it.
 *
 * This check closes that loop offline: the config that will actually ship, put
 * through the real serialiser, handed to the real validator. No hand-built
 * payloads. If a field is asserted live, it is proven to exist here first.
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

import { getConsumerConfig, publicConsumerConfig } from '../worker/src/consumer/config.js';
import { DEPLOY_VERIFICATION_HEADER, handleConsumerRequest } from '../worker/src/consumer/router.js';
import { getAvailableConsumerModules } from '../worker/src/consumer/analysis.js';
import {
  validateConsumerDeploymentBootstrap,
  validateConsumerDeploymentEnvelope
} from './check-consumer-live-deployment.mjs';
import { shippedConsumerEnv } from './lib/shipped-consumer-config.mjs';

let checks = 0;
const check = (label, run) => {
  checks += 1;
  run();
  console.info(`[BootstrapContract] PASS: ${label}`);
};

/**
 * Bindings and secrets, which are not in wrangler.toml. Presence is what the
 * config reads -- never the value -- so a placeholder is faithful here.
 */
/**
 * Values the deploy environment supplies, which source deliberately leaves blank
 * so a Worker built from the repo alone cannot enable anything. Stand-ins here:
 * this check proves the SHAPE of the bootstrap against the live validator, not
 * the specific notice identifiers, which live in the GitHub environment.
 */
const DEPLOY_ENVIRONMENT = Object.freeze({
  CONSUMER_CONSENT_MANIFEST_ID: 'consumer-consent-v1',
  CONSUMER_ANALYSIS_NOTICE_ID: 'analysis-preview-v1',
  CONSUMER_AI_NOTICE_ID: 'ai-preview-v1',
  CONSUMER_PRIVACY_NOTICE_URL: 'https://planeir.ie/plan/privacy.html',
  CONSUMER_VOICE_NOTICE_ID: 'voice-openai-audio-adviser-test-v2',
  CONSUMER_VOICE_DATA_POLICY_ID: 'openai-audio-adviser-test-v1'
});

const key = (fill) => Buffer.alloc(32, fill).toString('base64url');
const RUNTIME_BINDINGS = Object.freeze({
  ...DEPLOY_ENVIRONMENT,
  OPENAI_API_KEY: 'test-key-not-used',
  CONSUMER_DATA_ENCRYPTION_KEY: key(11),
  CONSUMER_RATE_LIMIT_HASH_KEY: key(23),
  CONSUMER_INVITE_SIGNING_KEY: key(37),
  CONSUMER_DB: {},
  CONSUMER_SESSIONS: {},
  CONSUMER_REALTIME_SESSIONS: {}
});

/** Exactly what the Worker's bootstrap route returns, for a given environment. */
function serveBootstrap(env) {
  const baseConfig = getConsumerConfig(env);
  const availableModules = baseConfig.journeyEnabled ? getAvailableConsumerModules(baseConfig) : [];
  const config = Object.freeze({
    ...baseConfig,
    allowedModules: availableModules.map((module) => module.id)
  });
  return { ...publicConsumerConfig(config), modules: availableModules };
}

/**
 * The expected policy the workflow derives from CONSUMER_BETA_* variables. The
 * live check builds this from the GitHub environment; here it is built from the
 * same approved values the workflow pins, so the two cannot drift apart without
 * this failing.
 */
function expectedPolicyFor(env) {
  const config = getConsumerConfig({ ...env, ...RUNTIME_BINDINGS });
  return {
    consentPolicyVersion: config.consentPolicyVersion,
    consentManifestId: config.consentManifestId,
    analysisNoticeId: config.analysisNoticeId,
    aiNoticeId: config.aiNoticeId,
    privacyNoticeUrl: config.privacyNoticeUrl,
    sessionTtlDays: config.sessionTtlDays,
    voiceNoticeId: config.voiceNoticeId,
    voiceDataPolicyId: config.voiceDataPolicyId,
    voiceTranscriptionModel: config.voiceTranscriptionModel,
    voiceSpeechModel: config.voiceSpeechModel,
    voiceName: config.voiceName,
    voicePricingVersion: config.voicePricingVersion,
    voiceSessionBudgetMicroEur: config.voiceSessionBudgetMicroEur,
    realtimeNoticeId: config.realtimeNoticeId,
    realtimeDataPolicyId: config.realtimeDataPolicyId,
    realtimeModel: config.realtimeModel,
    realtimeVoice: config.realtimeVoice,
    realtimeReasoningEffort: config.realtimeReasoningEffort,
    realtimeTranscriptionModel: config.realtimeTranscriptionModel,
    realtimePromptVersion: config.realtimePromptVersion,
    realtimeToolsetVersion: config.realtimeToolsetVersion,
    realtimePricingVersion: config.realtimePricingVersion,
    realtimeSessionBudgetMicroEur: config.realtimeSessionBudgetMicroEur
  };
}

/* ------------------------------------------------- the realtime canary */

const realtimeEnv = { ...shippedConsumerEnv({ realtime: true }), ...RUNTIME_BINDINGS };

check('the realtime canary bootstrap satisfies the live deployment check', () => {
  assert.equal(
    validateConsumerDeploymentBootstrap(serveBootstrap(realtimeEnv), {
      mode: 'realtime_voice_rules_only',
      expectedPolicy: expectedPolicyFor(realtimeEnv)
    }),
    true
  );
});

// THE LIVE LANE IS VERIFIED AGAINST ITS OWN PROMPT AND TOOLSET.
//
// The deploy deliberately substitutes planeir-live-* into the realtime settings
// when the live lane is on, so the lease records the prompt and the tool surface
// that actually ran. The live check compared against the v2 orchestrator pair
// regardless of lane, so a correct live deployment failed its own canary and was
// rolled back -- the deployment was right and the proof was stale.
check('the live lane is verified against its own prompt and toolset, not the v2 pair', () => {
  const liveEnv = {
    ...shippedConsumerEnv({ realtime: true }),
    ...RUNTIME_BINDINGS,
    CONSUMER_LIVE_VOICE_ENABLED: 'true',
    CONSUMER_REALTIME_PROMPT_VERSION: 'planeir-live-conversation-v5',
    CONSUMER_REALTIME_TOOLSET_VERSION: 'planeir-live-tools-v1'
  };
  const payload = serveBootstrap(liveEnv);
  assert.equal(payload.realtimeVoice.conversationVersion, 'live',
    'the fixture must actually be running the live lane');
  const policy = {
    ...expectedPolicyFor(liveEnv),
    realtimePromptVersion: 'consumer-realtime-orchestrator-v9',
    realtimeToolsetVersion: 'consumer-realtime-tools-v7',
    livePromptVersion: 'planeir-live-conversation-v5',
    liveToolsetVersion: 'planeir-live-tools-v1'
  };
  assert.equal(
    validateConsumerDeploymentBootstrap(payload, {
      mode: 'realtime_voice_rules_only',
      expectedPolicy: policy
    }),
    true,
    'a live deployment carrying the live pair must pass'
  );
  // And the check still has teeth: the v2 pair on the live lane is wrong.
  assert.throws(
    () => validateConsumerDeploymentBootstrap(
      { ...payload, realtimeVoice: { ...payload.realtimeVoice, promptVersion: 'consumer-realtime-orchestrator-v9' } },
      { mode: 'realtime_voice_rules_only', expectedPolicy: policy }
    ),
    /promptVersion does not match/,
    'the v2 prompt on the live lane must still fail'
  );
});

/* ---------------------------------------------------- the voice beta */

const voiceEnv = { ...shippedConsumerEnv({ realtime: false }), ...RUNTIME_BINDINGS };

check('the voice-only beta bootstrap satisfies the live deployment check', () => {
  assert.equal(
    validateConsumerDeploymentBootstrap(serveBootstrap(voiceEnv), {
      mode: 'voice_assisted_rules_only',
      expectedPolicy: expectedPolicyFor(voiceEnv)
    }),
    true
  );
});

/* ------------------------------------------------- fail-closed in source */

// The committed configuration, with every secret present, must still serve a
// dormant bootstrap. This is what stops an ordinary push enabling paid capability:
// the source defaults are off, and only the workflow's protected rewrite turns
// them on. If this ever passes as a beta, source-level fail-closed is gone.
const sourceEnv = {
  ...Object.fromEntries(
    [...readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8')
      .matchAll(/^(CONSUMER_[A-Z0-9_]+) = "([^"]*)"$/gm)].map(([, name, value]) => [name, value])
  ),
  ...RUNTIME_BINDINGS
};

check('the committed source configuration still serves a dormant bootstrap', () => {
  const bootstrap = serveBootstrap(sourceEnv);
  assert.equal(bootstrap.flags.consumerJourneyEnabled, false, 'source must not enable the journey');
  assert.equal(bootstrap.flags.consumerVoiceEnabled, false, 'source must not enable voice');
  assert.equal(bootstrap.flags.consumerRealtimeVoiceEnabled, false, 'source must not enable realtime');
  assert.equal(validateConsumerDeploymentBootstrap(bootstrap, { mode: 'dormant' }), true);
});

// SPEND FIGURES ARE NEVER PUBLIC -- in any mode, dormant or live. These are
// internal operating controls: what a call may cost, when dispatch stops, what
// is held back for teardown. An unauthenticated endpoint publishing them tells
// anyone who asks what a call costs us, and hands them the number to aim at.
const SPEND_FIELDS = Object.freeze([
  'sessionBudgetMicroEur', 'dailyBudgetMicroEur', 'dispatchStopMicroEur',
  'warnThresholdMicroEur', 'safetyReserveMicroEur', 'costLimitEurMicros'
]);

check('the public bootstrap exposes no spend figure, in any mode', () => {
  for (const [label, env] of [['realtime canary', realtimeEnv], ['voice beta', voiceEnv], ['dormant', sourceEnv]]) {
    const bootstrap = serveBootstrap(env);
    for (const block of ['voice', 'realtimeVoice']) {
      for (const field of SPEND_FIELDS) {
        assert.equal(bootstrap[block][field], undefined,
          `${label}: ${block}.${field} must not appear on the public bootstrap`);
      }
    }
    // Belt and braces: no micro-euro figure anywhere in the serialised payload,
    // whatever it might be called in future.
    const serialised = JSON.stringify(bootstrap);
    for (const amount of [2_000_000, 10_000_000, 20_000_000, 50_000_000, 9_700_000, 7_500_000, 300_000]) {
      assert.ok(!serialised.includes(String(amount)),
        `${label}: the public bootstrap leaks the figure ${amount}`);
    }
  }
});

/* ------------------------------------ every asserted field is serialised */

// The specific defect: the live check read a field the serialiser never emitted,
// so it compared undefined against a real number. Nothing the live check reads
// may be missing from the payload -- null is a deliberate "off", undefined is a
// field that does not exist.
check('the live check reads no field the bootstrap leaves undefined', () => {
  const bootstrap = serveBootstrap(realtimeEnv);
  for (const [block, fields] of [
    ['voice', ['enabled', 'noticeId', 'dataPolicyId', 'transcriptionModel', 'speechModel',
      'voice', 'pricingVersion']],
    ['realtimeVoice', ['enabled', 'noticeId', 'dataPolicyId', 'model', 'voice', 'reasoningEffort',
      'transcriptionModel', 'promptVersion', 'toolsetVersion', 'pricingVersion',
      'maxDurationSeconds', 'idleTimeoutSeconds']]
  ]) {
    for (const field of fields) {
      assert.notEqual(bootstrap[block][field], undefined,
        `${block}.${field} is asserted by the live deployment check but never serialised`);
    }
  }
});

/* ------------------------------------ the protected envelope route */

const VERIFICATION_KEY = 'B'.repeat(43);

async function requestEnvelope(env, headers = {}) {
  const pathname = '/api/consumer/deployment-envelope';
  const response = await handleConsumerRequest(
    new Request(`https://worker.test${pathname}`, { method: 'GET', headers }),
    env,
    {
      pathname,
      clientIp: '203.0.113.10',
      respond: (body, status, _methods, extra = {}) => new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json', ...extra }
      }),
      respondBinary: (body, status) => new Response(body, { status })
    }
  );
  return { status: response.status, body: JSON.parse(await response.text()) };
}

const keyedEnv = { ...realtimeEnv, CONSUMER_DEPLOY_VERIFICATION_KEY: VERIFICATION_KEY };

await (async () => {
  checks += 1;
  const { status, body } = await requestEnvelope(keyedEnv, { [DEPLOY_VERIFICATION_HEADER]: VERIFICATION_KEY });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(
    validateConsumerDeploymentEnvelope(body, {
      mode: 'realtime_voice_rules_only',
      expectedPolicy: expectedPolicyFor(realtimeEnv)
    }),
    true
  );
  // The figures the deploy gate exists to verify are genuinely present.
  assert.equal(body.voice.sessionBudgetMicroEur, 2_000_000);
  assert.equal(body.realtimeVoice.sessionBudgetMicroEur, 10_000_000);
  console.info('[BootstrapContract] PASS: deploy verification reads the live envelope with the header');
})();

// Every way of not holding the credential must be indistinguishable from the
// route not existing -- not 401, not 403, and never the figures.
for (const [label, headers, env] of [
  ['no header at all', {}, keyedEnv],
  ['an empty header', { [DEPLOY_VERIFICATION_HEADER]: '' }, keyedEnv],
  ['a wrong key of the same length', { [DEPLOY_VERIFICATION_HEADER]: 'C'.repeat(43) }, keyedEnv],
  ['a correct prefix, truncated', { [DEPLOY_VERIFICATION_HEADER]: VERIFICATION_KEY.slice(0, 20) }, keyedEnv],
  ['the right header when no secret is configured', { [DEPLOY_VERIFICATION_HEADER]: VERIFICATION_KEY }, realtimeEnv],
  ['an empty header when no secret is configured', { [DEPLOY_VERIFICATION_HEADER]: '' }, realtimeEnv],
  // A misconfigured short secret must authorise nobody, even the caller who
  // presents it exactly. Without a minimum length, setting the variable to a
  // single character would make the envelope trivially guessable.
  ['a matching header against a too-short configured secret',
    { [DEPLOY_VERIFICATION_HEADER]: 'short' },
    { ...realtimeEnv, CONSUMER_DEPLOY_VERIFICATION_KEY: 'short' }]
]) {
  await (async () => {
    checks += 1;
    const { status, body } = await requestEnvelope(env, headers);
    assert.equal(status, 404, `${label} must be refused, got ${status}`);
    assert.equal(body.code, 'not_found', `${label} must not reveal that the route exists`);
    const serialised = JSON.stringify(body);
    for (const amount of [2_000_000, 10_000_000, 50_000_000]) {
      assert.ok(!serialised.includes(String(amount)), `${label} leaked a spend figure`);
    }
    console.info(`[BootstrapContract] PASS: refused — ${label}`);
  })();
}

/* --------------------- the live session's own ceiling, privately */

/**
 * The smallest D1 stub `getConsumerProviderBudget` needs. The route reads the
 * ceiling from the SESSION ROW rather than from config, because the row is
 * written at creation and a bug there -- a session created with the wrong
 * ceiling -- is exactly what the deploy smoke check exists to catch.
 */
const sessionRowEnv = (row) => ({
  ...keyedEnv,
  CONSUMER_DB: {
    prepare: () => ({
      bind: () => ({ first: async () => row }),
      first: async () => row
    })
  }
});
const LIVE_ROW = Object.freeze({
  provider_cost_limit_eur_micros: 2_000_000,
  spent_eur_micros: 0,
  known_actual_eur_micros: 0,
  reserved_or_unknown_eur_micros: 0,
  released_eur_micros: 0
});

async function requestSessionEnvelope(env, headers) {
  const pathname = '/api/consumer/deployment-envelope';
  const response = await handleConsumerRequest(
    new Request(`https://worker.test${pathname}?session=cs_${'a'.repeat(24)}`, { method: 'GET', headers }),
    env,
    {
      pathname,
      clientIp: '203.0.113.10',
      respond: (body, status, _m, extra = {}) => new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json', ...extra }
      }),
      respondBinary: (body, status) => new Response(body, { status })
    }
  );
  return { status: response.status, body: JSON.parse(await response.text()) };
}

await (async () => {
  checks += 1;
  const { status, body } = await requestSessionEnvelope(
    sessionRowEnv(LIVE_ROW), { [DEPLOY_VERIFICATION_HEADER]: VERIFICATION_KEY }
  );
  assert.equal(status, 200, JSON.stringify(body));
  // This is the figure deploy #278 could not find anywhere.
  assert.equal(body.session.providerCostLimitMicroEur, 2_000_000);
  assert.equal(body.session.spentMicroEur, 0);
  console.info('[BootstrapContract] PASS: the live session ceiling is readable with the credential');
})();

await (async () => {
  checks += 1;
  // A session created with the wrong ceiling must be visible as such, or the
  // check would pass on any number the row happened to hold.
  const { body } = await requestSessionEnvelope(
    sessionRowEnv({ ...LIVE_ROW, provider_cost_limit_eur_micros: 500_000 }),
    { [DEPLOY_VERIFICATION_HEADER]: VERIFICATION_KEY }
  );
  assert.equal(body.session.providerCostLimitMicroEur, 500_000,
    'the route must report the row it read, not the configured default');
  console.info('[BootstrapContract] PASS: a wrong session ceiling is reported, not masked');
})();

for (const [label, headers] of [
  ['no header', {}],
  ['a wrong key', { [DEPLOY_VERIFICATION_HEADER]: 'C'.repeat(43) }]
]) {
  await (async () => {
    checks += 1;
    const { status, body } = await requestSessionEnvelope(sessionRowEnv(LIVE_ROW), headers);
    assert.equal(status, 404, `${label} must not reach the session ceiling`);
    assert.ok(!JSON.stringify(body).includes('2000000'), `${label} leaked the session ceiling`);
    console.info(`[BootstrapContract] PASS: session ceiling refused — ${label}`);
  })();
}

/* ------------------------- consumer surfaces carry no figures */

check('the consumer never receives a spend figure, only availability', () => {
  const routerSource = readFileSync(new URL('../worker/src/consumer/router.js', import.meta.url), 'utf8');
  // voiceBudgetPayload is the one function allowed to face a consumer, and it
  // returns availability only. Anything responding with a raw provider budget
  // would hand the browser limit/spent/remaining.
  const payloadFn = routerSource.slice(routerSource.indexOf('function voiceBudgetPayload'));
  const body = payloadFn.slice(0, payloadFn.indexOf('\n}'));
  assert.match(body, /return \{\s*available:/, 'voiceBudgetPayload must return availability only');
  for (const field of ['limitMicroEur,', 'spentMicroEur,', 'remainingMicroEur,']) {
    assert.ok(!body.includes(`  ${field}`), `voiceBudgetPayload must not return ${field}`);
  }
  // The transcription route was the last surface still returning the raw budget.
  // Scoped to that branch specifically: an identical line exists in the session
  // state response, so a repo-wide match would pass even with this one broken.
  const branchStart = routerSource.indexOf("if (route.kind === 'voice_transcriptions') {");
  assert.ok(branchStart > 0, 'the transcription branch could not be located');
  const branch = routerSource.slice(branchStart, routerSource.indexOf('const body = validateVoiceSpeechBody', branchStart));
  assert.match(branch, /voiceAvailability: voiceBudgetPayload\(/,
    'the transcription route must report availability instead of figures');
  // Only the response statement itself. Destructuring the budget out is fine --
  // required, in fact -- so the check is what gets SENT, not what is named.
  const responded = branch.split('\n').find((line) => line.includes('return respond('));
  assert.ok(responded, 'the transcription route must respond');
  assert.doesNotMatch(responded, /[,{]\s*voiceBudget\s*[,}]/,
    'the transcription route must not respond with the raw provider budget');
  assert.doesNotMatch(responded, /respond\(result,/,
    'the transcription route must not respond with the provider result verbatim');
});

console.info(`\n[BootstrapContract] ${checks} assertions passed: the config that ships, through the `
  + 'real serialiser, satisfies the real live-deployment gate.');
