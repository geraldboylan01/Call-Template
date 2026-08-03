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
import { getAvailableConsumerModules } from '../worker/src/consumer/analysis.js';
import { validateConsumerDeploymentBootstrap } from './check-consumer-live-deployment.mjs';
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

// A dormant Worker must not publish the commercial envelope either. These
// figures are only meaningful for an active, invite-only canary.
check('a dormant bootstrap exposes no cost envelope', () => {
  const bootstrap = serveBootstrap(sourceEnv);
  for (const [block, field] of [
    ['voice', 'sessionBudgetMicroEur'],
    ['realtimeVoice', 'sessionBudgetMicroEur'],
    ['realtimeVoice', 'dispatchStopMicroEur'],
    ['realtimeVoice', 'warnThresholdMicroEur'],
    ['realtimeVoice', 'safetyReserveMicroEur']
  ]) {
    assert.equal(bootstrap[block][field], null, `${block}.${field} must be null while dormant`);
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
      'voice', 'pricingVersion', 'sessionBudgetMicroEur']],
    ['realtimeVoice', ['enabled', 'noticeId', 'dataPolicyId', 'model', 'voice', 'reasoningEffort',
      'transcriptionModel', 'promptVersion', 'toolsetVersion', 'pricingVersion',
      'sessionBudgetMicroEur', 'maxDurationSeconds', 'idleTimeoutSeconds',
      'dispatchStopMicroEur', 'warnThresholdMicroEur', 'safetyReserveMicroEur']]
  ]) {
    for (const field of fields) {
      assert.notEqual(bootstrap[block][field], undefined,
        `${block}.${field} is asserted by the live deployment check but never serialised`);
    }
  }
});

console.info(`\n[BootstrapContract] ${checks} assertions passed: the config that ships, through the `
  + 'real serialiser, satisfies the real live-deployment gate.');
