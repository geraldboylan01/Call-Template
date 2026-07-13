import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const DORMANT_MODE = 'dormant';
const VOICE_ASSISTED_RULES_ONLY_MODE = 'voice_assisted_rules_only';
const INITIAL_MODULE_IDS = Object.freeze(['house_purchase', 'liquidity_analysis']);
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3_000;

function sortedStrings(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value || '')).filter(Boolean).sort()
    : [];
}

function expectedPolicyFromEnvironment(env) {
  return {
    consentPolicyVersion: String(env.CONSUMER_BETA_CONSENT_POLICY_VERSION || '').trim(),
    consentManifestId: String(env.CONSUMER_BETA_CONSENT_MANIFEST_ID || '').trim(),
    analysisNoticeId: String(env.CONSUMER_BETA_ANALYSIS_NOTICE_ID || '').trim(),
    aiNoticeId: String(env.CONSUMER_BETA_AI_NOTICE_ID || '').trim(),
    voiceNoticeId: String(env.CONSUMER_BETA_VOICE_NOTICE_ID || '').trim(),
    voiceDataPolicyId: String(env.CONSUMER_BETA_VOICE_DATA_POLICY_ID || '').trim(),
    voiceTranscriptionModel: String(env.CONSUMER_BETA_VOICE_TRANSCRIPTION_MODEL || '').trim(),
    voiceSpeechModel: String(env.CONSUMER_BETA_VOICE_SPEECH_MODEL || '').trim(),
    voiceName: String(env.CONSUMER_BETA_VOICE_NAME || '').trim(),
    voicePricingVersion: String(env.CONSUMER_BETA_VOICE_PRICING_VERSION || '').trim(),
    voiceSessionBudgetMicroEur: Number.parseInt(
      String(env.CONSUMER_BETA_VOICE_SESSION_BUDGET_EUR_CENTS || ''),
      10
    ) * 10_000,
    privacyNoticeUrl: String(env.CONSUMER_BETA_PRIVACY_NOTICE_URL || '').trim(),
    sessionTtlDays: Number.parseInt(String(env.CONSUMER_BETA_SESSION_TTL_DAYS || ''), 10)
  };
}

export function validateConsumerDeploymentBootstrap(payload, {
  mode = DORMANT_MODE,
  expectedPolicy = {}
} = {}) {
  assert(payload && typeof payload === 'object', 'Consumer bootstrap must be a JSON object.');
  assert.ok(
    [DORMANT_MODE, VOICE_ASSISTED_RULES_ONLY_MODE].includes(mode),
    `Unsupported consumer deployment mode: ${mode}`
  );

  const flags = payload.flags || {};
  const access = payload.access || {};
  const ai = payload.ai || {};
  const voice = payload.voice || {};
  const handoff = payload.handoff || {};

  assert.equal(flags.consumerAiIntakeEnabled, false, 'AI intake must remain disabled.');
  assert.equal(flags.consumerHumanHandoffEnabled, false, 'Consumer handoff must remain disabled.');
  assert.equal(access.publicAccessEnabled, false, 'Public consumer access must remain disabled.');
  assert.equal(access.inviteRequired, true, 'A signed invite must remain required.');
  assert.equal(ai.configured, false, 'The rules-only beta must not expose configured AI.');
  assert.equal(handoff.enabled, false, 'The rules-only beta must not expose handoff.');

  if (mode === DORMANT_MODE) {
    assert.equal(flags.consumerVoiceEnabled, false, 'The dormant deployment must keep voice disabled.');
    assert.equal(voice.enabled, false, 'The dormant deployment must not expose configured voice.');
    assert.equal(flags.consumerJourneyEnabled, false, 'The dormant deployment must keep the journey disabled.');
    assert.equal(flags.consumerModuleRoutingEnabled, false, 'The dormant deployment must keep routing disabled.');
    assert.deepEqual(sortedStrings(payload.allowedModules), [], 'The dormant deployment must expose no modules.');
    assert.deepEqual(
      sortedStrings(payload.modules?.map((module) => module?.id)),
      [],
      'The dormant deployment must return no module descriptors.'
    );
    return true;
  }

  assert.equal(flags.consumerJourneyEnabled, true, 'The protected beta must enable the master journey.');
  assert.equal(flags.consumerVoiceEnabled, true, 'The protected beta must enable only the reviewed voice transport.');
  assert.equal(flags.consumerModuleRoutingEnabled, true, 'The protected beta must enable deterministic module routing.');
  assert.equal(voice.enabled, true, 'The protected beta voice transport is not configured.');
  assert.equal(payload.cohort, 'adviser_test', 'The protected beta cohort must be adviser_test.');
  assert.deepEqual(
    sortedStrings(payload.allowedModules),
    [...INITIAL_MODULE_IDS].sort(),
    'The protected beta module allowlist changed.'
  );
  assert.deepEqual(
    sortedStrings(payload.modules?.map((module) => module?.id)),
    [...INITIAL_MODULE_IDS].sort(),
    'The protected beta module descriptors changed.'
  );

  for (const field of [
    'consentPolicyVersion',
    'consentManifestId',
    'analysisNoticeId',
    'privacyNoticeUrl'
  ]) {
    assert.ok(expectedPolicy[field], `Expected ${field} is required for live verification.`);
    assert.equal(payload[field], expectedPolicy[field], `Live ${field} does not match the protected environment.`);
  }
  assert.ok(expectedPolicy.aiNoticeId, 'Expected aiNoticeId is required for live verification.');
  assert.equal(ai.noticeId, expectedPolicy.aiNoticeId, 'Live AI notice ID does not match the protected environment.');
  for (const [field, expectedField] of [
    ['noticeId', 'voiceNoticeId'],
    ['dataPolicyId', 'voiceDataPolicyId'],
    ['transcriptionModel', 'voiceTranscriptionModel'],
    ['speechModel', 'voiceSpeechModel'],
    ['voice', 'voiceName'],
    ['pricingVersion', 'voicePricingVersion']
  ]) {
    assert.ok(expectedPolicy[expectedField], `Expected ${expectedField} is required for live verification.`);
    assert.equal(voice[field], expectedPolicy[expectedField], `Live voice ${field} does not match the protected environment.`);
  }
  assert.ok(
    Number.isSafeInteger(expectedPolicy.voiceSessionBudgetMicroEur)
      && expectedPolicy.voiceSessionBudgetMicroEur > 0,
    'Expected voiceSessionBudgetMicroEur is required for live verification.'
  );
  assert.equal(
    voice.sessionBudgetMicroEur,
    expectedPolicy.voiceSessionBudgetMicroEur,
    'Live voice session budget does not match the protected environment.'
  );
  assert.ok(Number.isInteger(expectedPolicy.sessionTtlDays), 'Expected sessionTtlDays is required for live verification.');
  assert.equal(payload.limits?.sessionTtlDays, expectedPolicy.sessionTtlDays, 'Live session TTL does not match the protected environment.');
  return true;
}

async function main() {
  const baseUrl = String(process.env.WORKER_BASE_URL || '').trim().replace(/\/+$/, '');
  const origin = String(process.env.SMOKE_ORIGIN || '').trim();
  const mode = String(process.env.CONSUMER_EXPECTED_DEPLOYMENT_MODE || DORMANT_MODE).trim();
  assert.ok(/^https:\/\//.test(baseUrl), 'WORKER_BASE_URL must be an HTTPS URL.');
  assert.ok(/^https:\/\//.test(origin), 'SMOKE_ORIGIN must be an HTTPS origin.');

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/consumer/bootstrap`, {
        headers: {
          Accept: 'application/json',
          Origin: origin,
          'Cache-Control': 'no-cache'
        }
      });
      const text = await response.text();
      assert.equal(response.status, 200, `Consumer bootstrap returned ${response.status}: ${text}`);
      assert.equal(
        response.headers.get('access-control-allow-origin'),
        origin,
        'Consumer bootstrap did not return the expected CORS origin.'
      );

      let payload;
      try {
        payload = JSON.parse(text);
      } catch (_error) {
        throw new Error('Consumer bootstrap did not return valid JSON.');
      }
      validateConsumerDeploymentBootstrap(payload, {
        mode,
        expectedPolicy: expectedPolicyFromEnvironment(process.env)
      });
      console.log(`Verified live consumer deployment mode: ${mode}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }
  throw lastError || new Error('Consumer deployment verification failed.');
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
