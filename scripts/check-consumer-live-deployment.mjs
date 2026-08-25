import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import { APPROVED_CONSUMER_MODULE_IDS } from '../worker/src/consumer/config.js';
import { DEPLOY_VERIFICATION_HEADER } from '../worker/src/consumer/router.js';

const DORMANT_MODE = 'dormant';
const RULES_ONLY_MODE = 'rules_only';
const REALTIME_VOICE_RULES_ONLY_MODE = 'realtime_voice_rules_only';
// Imported, never restated. This assertion is what failed deploy #274: the
// allowlist was widened in the Worker config and left at two modules here, so a
// Worker that deployed exactly as intended was then judged non-compliant.
const INITIAL_MODULE_IDS = APPROVED_CONSUMER_MODULE_IDS;
// Cloudflare may serve the previous Worker version briefly after a successful
// deploy. Keep rollback verification fail-closed, but allow enough time to
// observe the newly deployed kill-switch state at every edge.
const MAX_ATTEMPTS = 40;
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
    realtimeNoticeId: String(env.CONSUMER_BETA_REALTIME_NOTICE_ID || '').trim(),
    realtimeDataPolicyId: String(env.CONSUMER_BETA_REALTIME_DATA_POLICY_ID || '').trim(),
    realtimeModel: String(env.CONSUMER_BETA_REALTIME_MODEL || '').trim(),
    realtimeVoice: String(env.CONSUMER_BETA_REALTIME_VOICE || '').trim(),
    realtimeReasoningEffort: String(env.CONSUMER_BETA_REALTIME_REASONING_EFFORT || '').trim(),
    realtimeTranscriptionModel: String(env.CONSUMER_BETA_REALTIME_TRANSCRIPTION_MODEL || '').trim(),
    realtimePromptVersion: String(env.CONSUMER_BETA_REALTIME_PROMPT_VERSION || '').trim(),
    realtimeToolsetVersion: String(env.CONSUMER_BETA_REALTIME_TOOLSET_VERSION || '').trim(),
    // The live lane runs its own prompt and its own smaller tool surface, and
    // the deploy substitutes them into the realtime settings precisely so the
    // lease records what actually ran. Verification has to expect the same pair
    // or it proves the deployment wrong for being right.
    livePromptVersion: String(env.CONSUMER_BETA_LIVE_PROMPT_VERSION || '').trim(),
    liveToolsetVersion: String(env.CONSUMER_BETA_LIVE_TOOLSET_VERSION || '').trim(),
    realtimePricingVersion: String(env.CONSUMER_BETA_REALTIME_PRICING_VERSION || '').trim(),
    realtimeSessionBudgetMicroEur: Number.parseInt(
      String(env.CONSUMER_BETA_REALTIME_SESSION_BUDGET_EUR_CENTS || ''),
      10
    ) * 10_000,
    handoffPolicyVersion: String(env.CONSUMER_BETA_HANDOFF_POLICY_VERSION || '').trim(),
    handoffPolicyUrl: String(env.CONSUMER_BETA_HANDOFF_POLICY_URL || '').trim(),
    handoffRetentionPolicyId: String(env.CONSUMER_BETA_HANDOFF_RETENTION_POLICY_ID || '').trim(),
    handoffRetentionDays: Number.parseInt(String(env.CONSUMER_BETA_HANDOFF_RETENTION_DAYS || ''), 10),
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
    [DORMANT_MODE, RULES_ONLY_MODE, REALTIME_VOICE_RULES_ONLY_MODE].includes(mode),
    `Unsupported consumer deployment mode: ${mode}`
  );

  const flags = payload.flags || {};
  const access = payload.access || {};
  const ai = payload.ai || {};
  const voice = payload.voice || {};
  const realtimeVoice = payload.realtimeVoice || {};
  const handoff = payload.handoff || {};

  assert.equal(flags.consumerAiIntakeEnabled, false, 'AI intake must remain disabled.');
  const handoffExpected = false;
  assert.equal(flags.consumerHumanHandoffEnabled === true, handoffExpected, 'Consumer handoff does not match the protected canary mode.');
  assert.equal(access.publicAccessEnabled, false, 'Public consumer access must remain disabled.');
  assert.equal(access.inviteRequired, true, 'A signed invite must remain required.');
  assert.equal(ai.configured, false, 'The rules-only beta must not expose configured AI.');
  assert.equal(handoff.enabled === true, handoffExpected, 'The handoff disclosure does not match the protected canary mode.');

  if (mode === DORMANT_MODE) {
    assert.equal(flags.consumerVoiceEnabled, false, 'The dormant deployment must keep voice disabled.');
    assert.equal(flags.consumerRealtimeVoiceEnabled === true, false, 'The dormant deployment must keep realtime voice disabled.');
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
  assert.equal(flags.consumerVoiceEnabled, false, 'The removed 45-second voice lane must remain disabled.');
  assert.equal(flags.consumerModuleRoutingEnabled, true, 'The protected beta must enable deterministic module routing.');
  assert.equal(voice.enabled, false, 'The removed recorder must not be exposed by the protected beta.');
  assert.equal(voice.availability?.status, 'removed', 'The bootstrap must identify the old recorder as removed.');
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
  assert.ok(Number.isInteger(expectedPolicy.sessionTtlDays), 'Expected sessionTtlDays is required for live verification.');
  assert.equal(payload.limits?.sessionTtlDays, expectedPolicy.sessionTtlDays, 'Live session TTL does not match the protected environment.');

  if (mode === REALTIME_VOICE_RULES_ONLY_MODE) {
    assert.equal(flags.consumerRealtimeVoiceEnabled, true, 'The realtime adviser canary is not enabled.');
    assert.equal(realtimeVoice.enabled, true, 'The realtime adviser canary is not configured.');
    assert.equal(realtimeVoice.conversationVersion, 'live',
      'The archived controlled lane must never be published as the active conversation version.');
    for (const [field, expectedField] of [
      ['noticeId', 'realtimeNoticeId'],
      ['dataPolicyId', 'realtimeDataPolicyId'],
      ['model', 'realtimeModel'],
      ['voice', 'realtimeVoice'],
      ['reasoningEffort', 'realtimeReasoningEffort'],
      ['transcriptionModel', 'realtimeTranscriptionModel'],
      ['promptVersion', 'livePromptVersion'],
      ['toolsetVersion', 'liveToolsetVersion'],
      ['pricingVersion', 'realtimePricingVersion']
    ]) {
      assert.ok(expectedPolicy[expectedField], `Expected ${expectedField} is required for live verification.`);
      assert.equal(
        realtimeVoice[field],
        expectedPolicy[expectedField],
        `Live realtime voice ${field} does not match the protected environment.`
      );
    }
    // Duration and idle timeout stay public: they are user-facing meeting
    // limits, not commercial information. The four cost figures do not.
    assert.equal(realtimeVoice.maxDurationSeconds, 900, 'Live realtime duration limit changed.');
    assert.equal(realtimeVoice.idleTimeoutSeconds, 180, 'Live realtime idle timeout changed.');
    for (const field of [
      'sessionBudgetMicroEur', 'dispatchStopMicroEur', 'warnThresholdMicroEur', 'safetyReserveMicroEur'
    ]) {
      assert.equal(
        realtimeVoice[field],
        undefined,
        `The public bootstrap must not expose realtimeVoice.${field}.`
      );
    }
    assert.equal(handoff.policyVersion, null, 'Disabled handoff must expose no policy.');
    assert.equal(handoff.policyUrl, null, 'Disabled handoff must expose no policy URL.');
    assert.equal(handoff.retentionPolicyId, null, 'Disabled handoff must expose no retention policy.');
    assert.equal(handoff.packageRetentionDays, null, 'Disabled handoff must expose no retention period.');
  } else {
    assert.equal(flags.consumerRealtimeVoiceEnabled === true, false, 'Realtime voice must remain disabled outside its canary.');
    assert.equal(realtimeVoice.enabled === true, false, 'Realtime voice must fail closed outside its canary.');
  }
  return true;
}

/**
 * The live spend envelope, read from the protected route.
 *
 * Pushing a configuration is not evidence that the configuration is what is now
 * running, so this still has to be checked against the deployed Worker -- it
 * just must not be checked against a payload the whole internet can read.
 */
export function validateConsumerDeploymentEnvelope(payload, {
  mode = DORMANT_MODE,
  expectedPolicy = {}
} = {}) {
  assert(payload && typeof payload === 'object', 'The deployment envelope must be a JSON object.');
  const voice = payload.voice || {};
  const realtimeVoice = payload.realtimeVoice || {};

  if (mode === DORMANT_MODE) {
    assert.equal(voice.enabled, false, 'A dormant deployment must not report a live voice envelope.');
    assert.equal(realtimeVoice.enabled, false, 'A dormant deployment must not report a live realtime envelope.');
    assert.equal(voice.sessionBudgetMicroEur, null, 'A dormant deployment must expose no voice budget.');
    assert.equal(realtimeVoice.sessionBudgetMicroEur, null, 'A dormant deployment must expose no realtime budget.');
    return true;
  }

  assert.equal(voice.enabled, false, 'The removed recorder must not have a live deployment envelope.');
  assert.equal(voice.sessionBudgetMicroEur, null, 'The removed recorder must expose no spend envelope.');

  if (mode === REALTIME_VOICE_RULES_ONLY_MODE) {
    assert.ok(
      Number.isSafeInteger(expectedPolicy.realtimeSessionBudgetMicroEur)
        && expectedPolicy.realtimeSessionBudgetMicroEur > 0,
      'Expected realtimeSessionBudgetMicroEur is required for live verification.'
    );
    assert.equal(realtimeVoice.enabled, true, 'The realtime canary envelope is not live.');
    assert.equal(
      realtimeVoice.sessionBudgetMicroEur,
      expectedPolicy.realtimeSessionBudgetMicroEur,
      'Live realtime voice session budget changed.'
    );
    assert.equal(realtimeVoice.dispatchStopMicroEur, 9_700_000, 'Live realtime dispatch stop changed.');
    assert.equal(realtimeVoice.warnThresholdMicroEur, 7_500_000, 'Live realtime warning threshold changed.');
    assert.equal(realtimeVoice.safetyReserveMicroEur, 300_000, 'Live realtime safety reserve changed.');
  } else {
    assert.equal(realtimeVoice.enabled, false, 'Typed rules-only mode must not expose a call envelope.');
    assert.equal(realtimeVoice.sessionBudgetMicroEur, null, 'Typed rules-only mode must expose no call budget.');
  }
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
      await verifyLiveCostEnvelope(baseUrl, origin, mode);
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

/**
 * Read the envelope from the protected route, and prove it is protected.
 *
 * The unauthenticated probe is not decoration: a route that answers without the
 * credential would publish the ceilings anyway, which is the whole thing this
 * design exists to prevent. It is checked on every deploy, against the Worker
 * that is actually running.
 */
async function verifyLiveCostEnvelope(baseUrl, origin, mode) {
  const url = `${baseUrl}/api/consumer/deployment-envelope`;
  const key = String(process.env.CONSUMER_DEPLOY_VERIFICATION_KEY || '').trim();

  // This probe needs no credential and always runs, in every mode. Proving the
  // ceilings are not publicly readable is the whole point of the design, so it
  // is checked against the running Worker on every single deploy.
  const unauthenticated = await fetch(url, { headers: { Accept: 'application/json', Origin: origin } });
  assert.equal(
    unauthenticated.status,
    404,
    'The deployment envelope answered without the protected credential. It must not be readable publicly.'
  );

  // A dormant deployment provisions no Worker secrets, and has no live envelope
  // to check -- the public bootstrap has already proven voice and realtime are
  // off. Any active mode must produce the credential.
  if (mode === DORMANT_MODE && key.length < 32) return;
  assert.ok(
    key.length >= 32,
    'CONSUMER_DEPLOY_VERIFICATION_KEY is required to verify the live spend envelope of an active '
      + 'deployment. The deploy workflow provisions it; a local run must supply the same value.'
  );

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Origin: origin,
      'Cache-Control': 'no-cache',
      [DEPLOY_VERIFICATION_HEADER]: key
    }
  });
  const text = await response.text();
  assert.equal(
    response.status,
    200,
    `The deployment envelope returned ${response.status}. The Worker secret and the workflow value `
      + `must match. Body: ${text}`
  );
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    throw new Error('The deployment envelope did not return valid JSON.');
  }
  validateConsumerDeploymentEnvelope(payload, {
    mode,
    expectedPolicy: expectedPolicyFromEnvironment(process.env)
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
