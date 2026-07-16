import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { runConsumerAnalysis } from '../js/planning/orchestrator.js';
import { normalizeHouseholdProfile } from '../js/planning/profile.js';
import { recommendModules } from '../js/planning/routing_rules.js';
import {
  createConsumerCredential,
  decryptJson,
  encryptJson,
  getCurrentEncryptionKeyId,
  getEncryptedPayloadKeyId,
  parseConsumerCredential
} from '../worker/src/consumer/crypto.js';
import { createInitialProfile } from '../worker/src/consumer/repository.js';
import { describeConversationState, extractContextBoundPatch } from '../worker/src/consumer/conversation.js';
import { extractProfilePatchWithAi } from '../worker/src/consumer/ai_provider.js';
import { getConsumerConfig, publicConsumerConfig } from '../worker/src/consumer/config.js';
import { createConsumerInvite, verifyConsumerInvite } from '../worker/src/consumer/invite.js';
import {
  createAdvisorConsumerInvite,
  isAdvisorProtectedPreviewConfig,
  isAdvisorRealtimePreviewConfig,
  isAdvisorRulesOnlyPreviewConfig,
  isAdvisorVoicePreviewConfig
} from '../worker/src/consumer/router.js';
import { validateConsumerDeploymentBootstrap } from './check-consumer-live-deployment.mjs';
import {
  assertBetaBootstrap,
  assertVoiceBudgetSnapshot,
  buildProposedCredential,
  paidRealtimeInfrastructureProofEnabled,
  paidVoiceProviderSmokeEnabled,
  voiceBudgetFromHeaders
} from './check-consumer-live-advisor-bridge.mjs';
import { validatePlanSecurityHeaders } from './check-consumer-static-headers.mjs';
import {
  buildConsumerPlanHeaderRule,
  chooseHeaderRuleMutation,
  headerRuleMatches,
  selectPlaneirZone
} from './upsert-consumer-plan-headers.mjs';
import {
  applyProfilePatch,
  redactSensitiveIdentifiers,
  validateConfirmBody,
  validateConsentBody,
  validateCreateSessionBody,
  validateHandoffBody,
  validateProfilePatchBody,
  validateTurnBody,
  validateVoiceConsentBody,
  validateVoiceSpeechBody
} from '../worker/src/consumer/validators.js';

const root = new URL('../', import.meta.url);
const source = async (path) => readFile(new URL(path, root), 'utf8');
const [
  indexSource,
  routerSource,
  authSource,
  cryptoSource,
  aiSource,
  conversationSource,
  handoffSource,
  repositorySource,
  configSource,
  inviteSource,
  migrationSource,
  providerBudgetMigrationSource,
  voiceConsentMigrationSource,
  voiceHardeningMigrationSource,
  costBudgetSource,
  voiceProviderSource,
  adviserMigrationSource,
  wranglerSource,
  deployWorkflowSource,
  liveAdvisorBridgeSource,
  realtimeInfrastructureProofSource
] = await Promise.all([
  source('worker/src/index.js'),
  source('worker/src/consumer/router.js'),
  source('worker/src/consumer/session_auth.js'),
  source('worker/src/consumer/crypto.js'),
  source('worker/src/consumer/ai_provider.js'),
  source('worker/src/consumer/conversation.js'),
  source('worker/src/consumer/handoff.js'),
  source('worker/src/consumer/repository.js'),
  source('worker/src/consumer/config.js'),
  source('worker/src/consumer/invite.js'),
  source('worker/consumer-migrations/0001_create_consumer_journey.sql'),
  source('worker/consumer-migrations/0002_add_consumer_provider_budget.sql'),
  source('worker/consumer-migrations/0003_add_consumer_voice_consent.sql'),
  source('worker/consumer-migrations/0004_add_consumer_voice_dispatch_and_events.sql'),
  source('worker/src/consumer/cost_budget.js'),
  source('worker/src/consumer/voice_provider.js'),
  source('worker/migrations/0014_create_consumer_handoff_deliveries.sql'),
  source('worker/wrangler.toml'),
  source('.github/workflows/deploy-worker.yml'),
  source('scripts/check-consumer-live-advisor-bridge.mjs'),
  source('scripts/run-consumer-realtime-infrastructure-proof.mjs')
]);

for (const route of [
  '/api/consumer/bootstrap',
  '/api/consumer/sessions',
  'turns|profile|confirm|analyses|handoffs|consent'
]) {
  assert.match(routerSource, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('turns\\|profile\\|confirm\\|analyses\\|handoffs\\|consent', 'turns\\|profile\\|confirm\\|analyses\\|handoffs\\|consent')));
}
assert.match(indexSource, /pathname\.startsWith\('\/api\/consumer\/'\)/);
assert.match(indexSource, /await import\('\.\/consumer\/router\.js'\)/);
assert.match(indexSource, /createConsumerPipelineHandoff/);
assert.match(indexSource, /source[^\n]*'consumer-plan'/);
assert.match(indexSource, /'reviewing', 0, 1, 0, 'consumer-plan'/);
assert.match(indexSource, /PRAGMA table_info\(leads\)/);
assert.match(indexSource, /educationOnlyConsent:\s*true/);
assert.match(indexSource, /cleanupExpiredConsumerSessions/);
assert.match(indexSource, /const isLocalWorker = requestUrl\.protocol === 'http:'/);
assert.match(indexSource, /const allowLocalDev = isLocalWorker/);
assert.match(indexSource, /\/api\/advisor\/consumer-invite/);
assert.match(indexSource, /handleAdvisorConsumerInvite/);
assert.match(indexSource, /requireCsrf:\s*true/);
assert.match(indexSource, /rateScope:\s*'advisor-consumer-invite'/);
assert.match(indexSource, /!advisorAccess\.session\?\.authEnabled \|\| !advisorAccess\.session\?\.authenticated/);
assert.match(routerSource, /X-Consumer-Invite/);
assert.match(routerSource, /verifyConsumerInvite\(provided, env, config\)/);
assert.match(routerSource, /createSessionRecord\(env, credential, consent, config, inviteClaims\)/);
assert.match(routerSource, /createAdvisorConsumerInvite/);
assert.match(routerSource, /mode:\s*'rules_only'/);
assert.match(routerSource, /mode:\s*config\.realtimeEnabled/);
assert.match(routerSource, /\? 'realtime_voice_rules_only'/);
assert.match(routerSource, /config\.voiceEnabled/);
assert.match(routerSource, /\? 'voice_assisted_rules_only'/);
assert.match(routerSource, /parsed\.origin === 'https:\/\/planeir\.ie'/);
assert.match(routerSource, /\^\\\/plan/);
assert.match(routerSource, /isAdvisorRulesOnlyPreviewConfig/);
assert.match(routerSource, /isAdvisorVoicePreviewConfig/);
assert.match(routerSource, /isAdvisorProtectedPreviewConfig/);
assert.match(routerSource, /config\?\.aiRequested !== true/);
assert.match(routerSource, /config\?\.handoffRequested !== true/);
assert.match(routerSource, /config\?\.cohort === 'adviser_test'/);
assert.match(routerSource, /allowedModules === 'house_purchase,liquidity_analysis'/);
assert.match(routerSource, /config\.cohort === 'adviser_test' && !isAdvisorProtectedPreviewConfig\(config\)/);
assert.ok(routerSource.includes('voice\\/(consent|transcriptions|speech)'));
assert.match(routerSource, /voiceConsentIsCurrent/);
assert.match(routerSource, /describeConversationState\(profile, config\)/);
assert.match(routerSource, /speakConsumerQuestion/);
assert.match(routerSource, /withdrawAiConsent/);
assert.match(routerSource, /deleteSessionData/);
assert.match(routerSource, /request\.method === 'DELETE'/);

assert.match(authSource, /X-Consumer-Session/);
assert.doesNotMatch(authSource, /planeir_advisor_session|ADVISOR_SESSION_COOKIE|Cookie/);
assert.match(authSource, /constantTimeEqual/);
assert.match(cryptoSource, /SHA-256/);
assert.match(cryptoSource, /AES-GCM/);
assert.match(cryptoSource, /additionalData/);
assert.match(cryptoSource, /CONSUMER_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON/);
assert.match(cryptoSource, /MAX_ENCRYPTED_JSON_PLAINTEXT_BYTES/);
assert.match(cryptoSource, /HMAC/);
assert.match(repositorySource, /CONSUMER_RATE_LIMIT_HASH_KEY/);
assert.match(inviteSource, /HMAC/);
assert.match(inviteSource, /planeir-consumer/);
assert.match(inviteSource, /payload\.exp - payload\.iat <= config\.inviteMaxTtlHours/);
assert.match(inviteSource, /crypto\.subtle\.sign\('HMAC'/);
assert.match(configSource, /Boolean\(env\.CONSUMER_DB\)/);
assert.match(configSource, /CONSUMER_AI_DATA_POLICY_ID/);
assert.match(configSource, /CONSUMER_ANALYSIS_NOTICE_ID/);
assert.match(configSource, /CONSUMER_CONSENT_MANIFEST_ID/);
assert.match(configSource, /CONSUMER_AI_NOTICE_ID/);
assert.match(configSource, /CONSUMER_PRIVACY_NOTICE_URL/);
assert.match(configSource, /CONSUMER_AI_COMPLEX_SESSION_REQUEST_BUDGET/);
assert.match(configSource, /CONSUMER_HANDOFF_RETENTION_POLICY_ID/);
assert.match(configSource, /CONSUMER_HANDOFF_POLICY_URL/);
assert.match(configSource, /CONSUMER_VOICE_SESSION_BUDGET_EUR_CENTS/);
assert.match(configSource, /voiceSessionBudgetCents \* 10_000/);
assert.match(configSource, /\^\(\?:0\|\[1-9\]\\d\*\)\$/);

assert.match(aiSource, /https:\/\/api\.openai\.com\/v1\/responses/);
assert.match(aiSource, /store:\s*false/);
assert.doesNotMatch(aiSource, /previous_response_id/);
assert.match(aiSource, /text:\s*\{\s*format:\s*\{/s);
assert.match(aiSource, /type:\s*'json_schema'/);
assert.match(aiSource, /strict:\s*true/);
assert.match(aiSource, /max_output_tokens/);
assert.match(aiSource, /AbortController/);
assert.match(aiSource, /Do not calculate/);
assert.match(aiSource, /Do not make approval/);
assert.match(aiSource, /Do not recommend a financial product/);
assert.match(aiSource, /only propose an allowlisted draft patch/);
assert.match(voiceProviderSource, /https:\/\/api\.openai\.com\/v1\/audio\/transcriptions/);
assert.match(voiceProviderSource, /https:\/\/api\.openai\.com\/v1\/audio\/speech/);
assert.doesNotMatch(voiceProviderSource, /\/v1\/realtime|previous_response_id/);
assert.match(voiceProviderSource, /settleConsumerProviderCostUnknown/);
assert.match(voiceProviderSource, /request\.body\.getReader\(\)/);
assert.match(voiceProviderSource, /total > maximumBytes/);
assert.doesNotMatch(voiceProviderSource, /requireBoundedMultipartLength|request\.formData\(\)/);
assert.match(indexSource, /'x-voice-duration-ms'/);
assert.match(indexSource, /'x-voice-request-id'/);
assert.match(conversationSource, /const assistantMessage = question\.prompt/);
assert.match(conversationSource, /suggestion_only_deterministic_rules_authoritative/);
assert.match(conversationSource, /candidateGoalPatch/);
assert.match(conversationSource, /redactSensitiveIdentifiers/);

for (const table of [
  'consumer_sessions', 'consumer_consent_events', 'consumer_profile_revisions', 'consumer_conversation_turns',
  'consumer_ai_attempts', 'consumer_analysis_runs', 'consumer_module_runs',
  'consumer_handoffs', 'consumer_invite_redemptions', 'consumer_invite_uses', 'consumer_events',
  'consumer_rate_limits', 'consumer_rekey_runs'
]) {
  assert.match(migrationSource, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
}
assert.doesNotMatch(migrationSource, /ALTER TABLE (?:leads|clients|published_sessions)/);
assert.match(migrationSource, /payload_encrypted/);
assert.match(migrationSource, /consent_education_only/);
assert.match(migrationSource, /ai_consent_withdrawn_at/);
assert.match(migrationSource, /consent_analysis_notice_id/);
assert.match(migrationSource, /consent_ai_notice_id/);
assert.match(migrationSource, /retention_policy_id TEXT NOT NULL/);
assert.match(providerBudgetMigrationSource, /ALTER TABLE consumer_sessions/);
assert.match(providerBudgetMigrationSource, /CREATE TABLE IF NOT EXISTS consumer_provider_costs/);
assert.match(providerBudgetMigrationSource, /UNIQUE \(session_id, operation, idempotency_key\)/);
assert.match(providerBudgetMigrationSource, /CREATE TABLE IF NOT EXISTS consumer_provider_daily_cost_totals/);
assert.match(voiceConsentMigrationSource, /CREATE TABLE IF NOT EXISTS consumer_voice_consents/);
assert.match(voiceHardeningMigrationSource, /ADD COLUMN dispatched_at TEXT/);
assert.match(voiceHardeningMigrationSource, /CREATE TABLE IF NOT EXISTS consumer_voice_consent_events/);
assert.match(voiceHardeningMigrationSource, /action IN \('granted', 'withdrawn'\)/);
assert.match(costBudgetSource, /summarizeProviderBudget/);
assert.match(repositorySource, /INSERT INTO consumer_provider_costs/);
assert.match(repositorySource, /consumer_provider_daily_cost_totals/);
assert.match(repositorySource, /markConsumerProviderCostInFlight/);
assert.match(repositorySource, /DELETE FROM consumer_voice_consent_events/);
assert.match(adviserMigrationSource, /CREATE TABLE IF NOT EXISTS consumer_handoff_deliveries/);
assert.match(adviserMigrationSource, /handoff_id TEXT PRIMARY KEY/);
assert.match(repositorySource, /env\.CONSUMER_DB/);
assert.doesNotMatch(repositorySource, /env\.LEADS_DB/);
assert.match(repositorySource, /await db\(env\)\.batch\(statements\)/);
assert.match(repositorySource, /commitTurnExchange/);
assert.match(repositorySource, /DELETE FROM consumer_conversation_turns/);
assert.match(repositorySource, /DELETE FROM consumer_profile_revisions/);
assert.match(repositorySource, /status = 'needs_information'/);
assert.match(repositorySource, /readHandoffPackage/);
assert.match(repositorySource, /reserveAiAttempt/);
assert.match(repositorySource, /finalizeAiAttempt/);
assert.match(repositorySource, /consumer_invite_uses/);
assert.match(repositorySource, /EVENT_METADATA_FIELDS/);
assert.match(repositorySource, /profile_revision = \?/);
assert.match(repositorySource, /package_encrypted = NULL, status = 'purged'/);
assert.match(conversationSource, /extractContextBoundPatch/);
assert.equal((conversationSource.match(/idempotency_key_conflict/g) || []).length, 2);
assert.match(handoffSource, /immutablePackage\.contact\.fullName/);
assert.doesNotMatch(handoffSource, /fullName:\s*handoff\.fullName/);
assert.match(handoffSource, /bookingUrl:\s*null, deliveryConfirmed:\s*false/);
assert.match(repositorySource, /status NOT IN \('linking', 'linked', 'delivered'\)/);
assert.match(repositorySource, /\['linking', 'linked', 'delivered'\]\.includes\(retainedHandoff\.status\)/);
assert.match(repositorySource, /status = 'revoked', package_encrypted = NULL/);
assert.match(handoffSource, /claimed\.linking_started_at/);
assert.match(repositorySource, /linkHandoff\(env, sessionId, handoffId, linkingStartedAt/);
assert.match(repositorySource, /markHandoffFailed\(env, sessionId, handoffId, linkingStartedAt/);
assert.ok((repositorySource.match(/AND linking_started_at = \?/g) || []).length >= 4);
assert.match(repositorySource, /SELECT id, session_id, retention_expires_at, linking_started_at/);
assert.match(repositorySource, /status = 'linking' AND linking_started_at <= \?/);
assert.doesNotMatch(repositorySource, /status IN \('pending', 'failed', 'linking'\)/);
assert.doesNotMatch(repositorySource, /profile:\s*context\.profile/);
assert.doesNotMatch(repositorySource, /rollingSummary:/);

for (const flag of [
  'CONSUMER_JOURNEY_ENABLED', 'CONSUMER_AI_INTAKE_ENABLED', 'CONSUMER_VOICE_ENABLED',
  'CONSUMER_MODULE_ROUTING_ENABLED', 'CONSUMER_HANDOFF_ENABLED',
  'CONSUMER_PUBLIC_ACCESS_ENABLED'
]) {
  assert.match(wranglerSource, new RegExp(`${flag} = "false"`));
}
assert.match(wranglerSource, /CONSUMER_ALLOWED_MODULE_IDS = "house_purchase,liquidity_analysis"/);
assert.match(wranglerSource, /CONSUMER_AI_DEFAULT_MODEL = "gpt-5\.6-luna"/);
assert.match(wranglerSource, /CONSUMER_AI_COMPLEX_MODEL = "gpt-5\.6-terra"/);
assert.doesNotMatch(wranglerSource, /OPENAI_API_KEY\s*=/);
assert.doesNotMatch(wranglerSource, /CONSUMER_DATA_ENCRYPTION_KEY\s*=/);
assert.doesNotMatch(wranglerSource, /CONSUMER_INVITE_SECRET/);
assert.match(deployWorkflowSource, /environment:\s*production/);
assert.doesNotMatch(deployWorkflowSource, /test -n "\$CONSUMER_DB_ID"/);
assert.match(deployWorkflowSource, /if \[\[ -n "\$CONSUMER_DB_ID" \]\]; then/);
assert.match(deployWorkflowSource, /if \(databaseId && !\/\^\[0-9a-f\]/);
assert.match(deployWorkflowSource, /ALLOW_LOCAL_DEV_ORIGINS must not be enabled/);
assert.match(deployWorkflowSource, /CONSUMER_ADVISER_TEST_BETA_SOURCE_APPROVED: "true"/);
assert.match(deployWorkflowSource, /CONSUMER_ADVISER_TEST_BETA_OVERRIDE: \$\{\{ vars\.CONSUMER_ADVISER_TEST_BETA_OVERRIDE \}\}/);
assert.match(deployWorkflowSource, /A protected override cannot activate a source-unapproved beta/);
assert.match(
  deployWorkflowSource,
  /activate_realtime_adviser_canary:[\s\S]{0,240}default:\s*false[\s\S]{0,80}type:\s*boolean/
);
assert.match(
  deployWorkflowSource,
  /run_paid_realtime_infrastructure_proof:[\s\S]{0,260}default:\s*false[\s\S]{0,80}type:\s*boolean/
);
assert.match(
  deployWorkflowSource,
  /CONSUMER_REALTIME_ADVISER_CANARY_SOURCE_APPROVED:\s*\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.activate_realtime_adviser_canary == true && 'true' \|\| 'false' \}\}/
);
assert.doesNotMatch(deployWorkflowSource, /CONSUMER_REALTIME_ADVISER_CANARY_SOURCE_APPROVED:\s*"true"/);
assert.doesNotMatch(
  deployWorkflowSource,
  /CONSUMER_REALTIME_ADVISER_CANARY_SOURCE_APPROVED:\s*\$\{\{ vars\./
);
assert.match(
  deployWorkflowSource,
  /RUN_PAID_REALTIME_INFRASTRUCTURE_PROOF:\s*\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.run_paid_realtime_infrastructure_proof == true && 'true' \|\| 'false' \}\}/
);
assert.match(
  deployWorkflowSource,
  /effective_realtime" == "true" && "\$RUN_PAID_REALTIME_INFRASTRUCTURE_PROOF" != "true"[\s\S]{0,220}Realtime activation requires the paid SDP, sideband-tool, and server-hangup proof/
);
assert.match(
  deployWorkflowSource,
  /RUN_PAID_REALTIME_INFRASTRUCTURE_PROOF" == "true" && "\$effective_realtime" != "true"[\s\S]{0,220}requires explicit canary activation/
);
assert.match(deployWorkflowSource, /ADVISOR_SMOKE_PASSWORD is required for the authenticated adviser beta gate/);
assert.match(deployWorkflowSource, /CONSUMER_ADVISER_INVITE_BETA_ENABLED=\$effective_beta/);
assert.match(deployWorkflowSource, /CONSUMER_DB_ID is required for the protected beta/);
assert.match(deployWorkflowSource, /CONSUMER_DB_NAME: "planeir-consumer"/);
assert.match(deployWorkflowSource, /wrangler d1 list --json/);
assert.match(deployWorkflowSource, /wrangler d1 create planeir-consumer --jurisdiction eu/);
assert.doesNotMatch(deployWorkflowSource, /wrangler d1 create planeir-consumer --location/);
assert.match(deployWorkflowSource, /jurisdiction !== "eu"/);
assert.match(deployWorkflowSource, /must have the immutable EU jurisdiction before beta activation/);
assert.match(deployWorkflowSource, /CONSUMER_BETA_CONSENT_POLICY_VERSION: "consumer-adviser-test-v1"/);
assert.match(deployWorkflowSource, /CONSUMER_BETA_CONSENT_MANIFEST_ID: "consumer-adviser-test-manifest-v1"/);
assert.match(deployWorkflowSource, /CONSUMER_BETA_ANALYSIS_NOTICE_ID: "analysis-adviser-test-v1"/);
assert.match(deployWorkflowSource, /CONSUMER_BETA_AI_NOTICE_ID: "ai-adviser-test-v1"/);
assert.match(deployWorkflowSource, /CONSUMER_BETA_PRIVACY_NOTICE_URL: "https:\/\/planeir\.ie\/plan\/privacy\.html"/);
assert.match(deployWorkflowSource, /CONSUMER_BETA_SESSION_TTL_DAYS: "7"/);
assert.match(deployWorkflowSource, /replaceTomlString\(generatedSource, 'CONSUMER_COHORT', 'adviser_test'\)/);
assert.match(deployWorkflowSource, /replaceTomlString\(generatedSource, 'CONSUMER_INVITE_MAX_TTL_HOURS', '24'\)/);
assert.match(deployWorkflowSource, /replaceTomlString\(generatedSource, 'CONSUMER_JOURNEY_ENABLED', 'true'\)/);
assert.match(deployWorkflowSource, /replaceTomlString\(generatedSource, 'CONSUMER_MODULE_ROUTING_ENABLED', 'true'\)/);
assert.match(deployWorkflowSource, /CONSUMER_AI_INTAKE_ENABLED: 'false'/);
assert.match(deployWorkflowSource, /CONSUMER_VOICE_ENABLED: betaEnabled \? 'true' : 'false'/);
assert.match(deployWorkflowSource, /CONSUMER_HANDOFF_ENABLED: 'false'/);
assert.match(deployWorkflowSource, /CONSUMER_BETA_REALTIME_DAILY_BUDGET_EUR_CENTS: "5000"/);
assert.match(deployWorkflowSource, /CONSUMER_BETA_HANDOFF_POLICY_VERSION: "consumer-adviser-handoff-v1"/);
assert.match(deployWorkflowSource, /CONSUMER_BETA_HANDOFF_POLICY_URL: "https:\/\/planeir\.ie\/plan\/privacy\.html#handoff"/);
assert.match(deployWorkflowSource, /CONSUMER_BETA_HANDOFF_RETENTION_POLICY_ID: "consumer-handoff-bridge-30d-v1"/);
assert.match(deployWorkflowSource, /CONSUMER_BETA_HANDOFF_RETENTION_DAYS: "30"/);
assert.match(deployWorkflowSource, /bootstrap config must keep the realtime handoff disabled/);
assert.match(deployWorkflowSource, /CONSUMER_PUBLIC_ACCESS_ENABLED: 'false'/);
assert.match(deployWorkflowSource, /wrangler secret list --config wrangler\.bootstrap\.generated\.toml --format json/);
assert.match(deployWorkflowSource, /randomBytes\(32\)\.toString\('base64url'\)/);
assert.match(deployWorkflowSource, /wrangler secret put "\$secret_name"/);
assert.match(deployWorkflowSource, /upsert-consumer-plan-headers\.mjs/);
assert.match(deployWorkflowSource, /check-consumer-live-deployment\.mjs/);
assert.match(deployWorkflowSource, /check-consumer-live-advisor-bridge\.mjs/);
assert.match(deployWorkflowSource, /check-consumer-static-headers\.mjs/);
assert.match(deployWorkflowSource, /wrangler secret put OPENAI_API_KEY/);
assert.match(
  deployWorkflowSource,
  /run_paid_voice_provider_smoke:[\s\S]{0,220}default:\s*false[\s\S]{0,80}type:\s*boolean/
);
assert.match(
  deployWorkflowSource,
  /RUN_PAID_VOICE_PROVIDER_SMOKE:\s*\$\{\{ github\.event_name == 'workflow_dispatch'.*inputs\.run_paid_voice_provider_smoke/
);
assert.match(
  deployWorkflowSource,
  /Install Realtime canary browser harness[\s\S]{0,120}if:\s*env\.CONSUMER_REALTIME_ADVISER_CANARY_ENABLED == 'true'[\s\S]{0,120}playwright-core@1\.61\.1/
);
assert.match(
  deployWorkflowSource,
  /concurrency:[\s\S]{0,100}group:\s*worker-production[\s\S]{0,320}cancel-in-progress:\s*false/
);
assert.match(
  deployWorkflowSource,
  /CONSUMER_REALTIME_ACTIVATION_DEPLOY_ATTEMPTED=true[\s\S]{0,180}wrangler deploy --config wrangler\.production\.generated\.toml/
);
assert.match(
  deployWorkflowSource,
  /Roll back Realtime after a failed live canary proof[\s\S]{0,180}if:\s*\(failure\(\) \|\| cancelled\(\)\) && env\.CONSUMER_REALTIME_ACTIVATION_DEPLOY_ATTEMPTED == 'true'/
);
assert.match(
  deployWorkflowSource,
  /Roll back Realtime after a failed live canary proof[\s\S]{0,360}wrangler deploy --config wrangler\.bootstrap\.generated\.toml[\s\S]{0,180}CONSUMER_EXPECTED_DEPLOYMENT_MODE=voice_assisted_rules_only/
);
assert.match(
  deployWorkflowSource,
  /Remove generated deployment config[\s\S]{0,80}if:\s*always\(\)/
);
assert.match(deployWorkflowSource, /npm install --global wrangler@4\.110\.0/);
assert.match(deployWorkflowSource, /CONSUMER_BETA_VOICE_SPEECH_MODEL: "tts-1-hd"/);
assert.match(deployWorkflowSource, /CONSUMER_BETA_VOICE_SESSION_BUDGET_EUR_CENTS: "200"/);
assert.match(deployWorkflowSource, /CONSUMER_EXPECTED_DEPLOYMENT_MODE="voice_assisted_rules_only"/);
assert.doesNotMatch(deployWorkflowSource, /vars\.CONSUMER_(?:AI_INTAKE|HANDOFF|PUBLIC_ACCESS)_ENABLED/);

const releaseOrderMarkers = [
  '- name: Upsert protected-beta response security headers',
  '- name: Verify protected-beta static security headers',
  '- name: Apply remote adviser D1 migrations',
  '- name: Apply remote consumer D1 migrations',
  '- name: Deploy Worker code and Durable Object bootstrap',
  '- name: Ensure protected-beta Worker secrets and provider credential',
  '- name: Deploy final Worker configuration',
  '- name: Verify live consumer deployment mode',
  '- name: Smoke check authenticated adviser planning bridge',
  '- name: Roll back Realtime after a failed live canary proof'
];
const releaseOrderPositions = releaseOrderMarkers.map((marker) => deployWorkflowSource.indexOf(marker));
assert.ok(releaseOrderPositions.every((position) => position >= 0), 'The production release sequence is incomplete.');
for (let index = 1; index < releaseOrderPositions.length; index += 1) {
  assert.ok(
    releaseOrderPositions[index] > releaseOrderPositions[index - 1],
    `The production release step is out of order: ${releaseOrderMarkers[index]}`
  );
}
const paidSpeechSmokePosition = liveAdvisorBridgeSource.indexOf('/voice/speech`');
const paidTranscriptionSmokePosition = liveAdvisorBridgeSource.indexOf('/voice/transcriptions`');
const syntheticCleanupPosition = liveAdvisorBridgeSource.indexOf('} finally {');
assert.ok(paidSpeechSmokePosition >= 0, 'The opt-in paid smoke must call server-selected speech.');
assert.ok(
  paidTranscriptionSmokePosition > paidSpeechSmokePosition,
  'The opt-in paid smoke must pass server speech through transcription.'
);
assert.match(liveAdvisorBridgeSource, /requestRawAudioJsonOnce/);
assert.doesNotMatch(liveAdvisorBridgeSource, /requestMultipartJsonOnce|transcriptionForm/);
assert.ok(
  syntheticCleanupPosition > paidTranscriptionSmokePosition,
  'Synthetic-session cleanup must remain in finally after the paid provider round trip.'
);
assert.match(
  liveAdvisorBridgeSource.slice(syntheticCleanupPosition),
  /method:\s*'DELETE'/,
  'The paid smoke finally block must delete the synthetic session.'
);
assert.match(
  liveAdvisorBridgeSource,
  /import \{ runRealtimeInfrastructureProof \} from '\.\/run-consumer-realtime-infrastructure-proof\.mjs'/
);
assert.match(
  liveAdvisorBridgeSource,
  /assert\.equal\([\s\S]{0,100}runPaidRealtimeProof,[\s\S]{0,100}realtimeExpected,[\s\S]{0,180}Realtime activation and its paid infrastructure proof must be enabled together/
);
assert.match(liveAdvisorBridgeSource, /await runRealtimeInfrastructureProof\(\{/);
assert.match(liveAdvisorBridgeSource, /MAX_INVITE_PROPAGATION_ATTEMPTS = 12/);
for (const provenBoundary of [
  'webRtcConnected',
  'sidebandConnected',
  'readOnlyToolSucceeded',
  'providerHangupConfirmed'
]) {
  assert.match(liveAdvisorBridgeSource, new RegExp(`proof\\.${provenBoundary}`));
}

assert.match(realtimeInfrastructureProofSource, /await import\('playwright-core'\)/);
assert.match(realtimeInfrastructureProofSource, /--use-fake-device-for-media-stream/);
assert.match(realtimeInfrastructureProofSource, /controlledSpeechPromise/);
assert.match(realtimeInfrastructureProofSource, /x-realtime-speech-id/);
assert.match(realtimeInfrastructureProofSource, /audio\.srcObject === null/);
assert.match(realtimeInfrastructureProofSource, /controlledSpeechPlayed/);
assert.doesNotMatch(realtimeInfrastructureProofSource, /srcObject instanceof MediaStream/);
assert.doesNotMatch(realtimeInfrastructureProofSource, /new RTCPeerConnection\(\)/);
assert.doesNotMatch(realtimeInfrastructureProofSource, /createDataChannel\('oai-events'\)/);
assert.match(realtimeInfrastructureProofSource, /await launcher\.click\(\)/);
assert.match(realtimeInfrastructureProofSource, /await start\.click\(\)/);
assert.match(realtimeInfrastructureProofSource, /response\.request\(\)\.method\(\) === 'POST'/);
assert.match(realtimeInfrastructureProofSource, /MAX_PROPAGATION_ATTEMPTS = 5/);
assert.match(realtimeInfrastructureProofSource, /MAX_BOOTSTRAP_PROPAGATION_ATTEMPTS = 10/);
assert.match(realtimeInfrastructureProofSource, /created\.status\(\) === 201/);
assert.match(realtimeInfrastructureProofSource, /created\.status\(\) === 503/);
assert.match(
  realtimeInfrastructureProofSource,
  /\['consumer_realtime_unavailable', 'realtime_unavailable'\]\.includes\(errorCode\)/
);
assert.match(realtimeInfrastructureProofSource, /The Realtime call route did not converge after bounded propagation retries/);
assert.match(realtimeInfrastructureProofSource, /errorPayload\?\.error\?\.code/);
assert.match(realtimeInfrastructureProofSource, /x-realtime-lease-id/);
assert.match(realtimeInfrastructureProofSource, /assert\.equal\(proof\.sidebandConnected, true/);
assert.match(realtimeInfrastructureProofSource, /assert\.equal\(proof\.readOnlyToolSucceeded, true/);
assert.match(realtimeInfrastructureProofSource, /response\.request\(\)\.method\(\) === 'DELETE'/);
assert.match(realtimeInfrastructureProofSource, /assert\.equal\(closedPayload\.providerHangupConfirmed, true/);
assert.match(realtimeInfrastructureProofSource, /finally \{/);
assert.match(realtimeInfrastructureProofSource, /await browser\.close\(\)/);
assert.doesNotMatch(realtimeInfrastructureProofSource, /OPENAI_API_KEY|api\.openai\.com/);

const requiredPlanHeaders = new Headers({
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://call-canvas-session-worker.geraldboylan.workers.dev; media-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
  'Strict-Transport-Security': 'max-age=31556952'
});
assert.equal(validatePlanSecurityHeaders(requiredPlanHeaders, {
  workerOrigin: 'https://call-canvas-session-worker.geraldboylan.workers.dev'
}), true);
assert.throws(() => validatePlanSecurityHeaders(new Headers({
  ...Object.fromEntries(requiredPlanHeaders.entries()),
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'"
}), {
  workerOrigin: 'https://call-canvas-session-worker.geraldboylan.workers.dev'
}));
const missingFrameProtectionHeaders = new Headers(requiredPlanHeaders);
missingFrameProtectionHeaders.delete('X-Frame-Options');
assert.throws(() => validatePlanSecurityHeaders(missingFrameProtectionHeaders, {
  workerOrigin: 'https://call-canvas-session-worker.geraldboylan.workers.dev'
}));

const desiredHeaderRule = buildConsumerPlanHeaderRule('https://call-canvas-session-worker.geraldboylan.workers.dev');
assert.equal(desiredHeaderRule.ref, 'planeir_consumer_plan_security_headers_v1');
assert.equal(desiredHeaderRule.action, 'rewrite');
assert.equal(desiredHeaderRule.enabled, true);
assert.equal(desiredHeaderRule.action_parameters.headers['x-frame-options'].value, 'DENY');
assert.equal(headerRuleMatches(desiredHeaderRule, desiredHeaderRule), true);
const reorderedHeaderRule = {
  ref: desiredHeaderRule.ref,
  description: desiredHeaderRule.description,
  expression: desiredHeaderRule.expression,
  action_parameters: {
    headers: Object.fromEntries(Object.entries(desiredHeaderRule.action_parameters.headers)
      .reverse()
      .map(([name, operation]) => [name.toUpperCase(), operation]))
  },
  action: desiredHeaderRule.action
};
assert.equal(
  headerRuleMatches(reorderedHeaderRule, desiredHeaderRule),
  true,
  'Cloudflare header-name casing, object-key order, and an omitted default-enabled value must not force a rewrite.'
);
assert.equal(chooseHeaderRuleMutation(null, desiredHeaderRule).kind, 'create-entrypoint');
const unrelatedHeaderRule = {
  id: 'a'.repeat(32),
  ref: 'unrelated_rule',
  action: 'rewrite'
};
const existingHeaderRuleset = {
  id: 'b'.repeat(32),
  rules: [unrelatedHeaderRule]
};
const appendMutation = chooseHeaderRuleMutation(existingHeaderRuleset, desiredHeaderRule);
assert.equal(appendMutation.kind, 'append-rule');
assert.deepEqual(existingHeaderRuleset.rules, [unrelatedHeaderRule], 'Header-rule selection must not mutate unrelated rules.');
const updateMutation = chooseHeaderRuleMutation({
  id: 'b'.repeat(32),
  rules: [unrelatedHeaderRule, { ...desiredHeaderRule, id: 'c'.repeat(32) }]
}, desiredHeaderRule);
assert.equal(updateMutation.kind, 'update-rule');
assert.equal(updateMutation.ruleId, 'c'.repeat(32));
assert.throws(() => chooseHeaderRuleMutation({
  id: 'b'.repeat(32),
  rules: [
    { ...desiredHeaderRule, id: 'c'.repeat(32) },
    { ...desiredHeaderRule, id: 'd'.repeat(32) }
  ]
}, desiredHeaderRule));
assert.equal(selectPlaneirZone([{
  id: 'e'.repeat(32),
  name: 'planeir.ie',
  status: 'active',
  account: { id: 'f'.repeat(32) }
}], {
  accountId: 'f'.repeat(32),
  zoneName: 'planeir.ie'
}).id, 'e'.repeat(32));

const dormantDeploymentBootstrap = {
  flags: {
    consumerJourneyEnabled: false,
    consumerAiIntakeEnabled: false,
    consumerVoiceEnabled: false,
    consumerModuleRoutingEnabled: false,
    consumerHumanHandoffEnabled: false
  },
  access: { publicAccessEnabled: false, inviteRequired: true },
  allowedModules: [],
  cohort: 'internal',
  ai: { configured: false, noticeId: null },
  voice: { enabled: false },
  handoff: { enabled: false },
  modules: []
};
assert.equal(validateConsumerDeploymentBootstrap(dormantDeploymentBootstrap, { mode: 'dormant' }), true);

const betaDeploymentPolicy = {
  consentPolicyVersion: 'consumer-adviser-test-v1',
  consentManifestId: 'consumer-adviser-test-manifest-v1',
  analysisNoticeId: 'analysis-adviser-test-v1',
  aiNoticeId: 'ai-adviser-test-v1',
  voiceNoticeId: 'voice-adviser-test-v1',
  voiceDataPolicyId: 'openai-audio-adviser-test-v1',
  voiceTranscriptionModel: 'gpt-4o-mini-transcribe',
  voiceSpeechModel: 'tts-1-hd',
  voiceName: 'nova',
  voicePricingVersion: 'openai-audio-eur-safety-2026-07-13-v2',
  voiceSessionBudgetMicroEur: 2_000_000,
  privacyNoticeUrl: 'https://planeir.ie/plan/privacy.html',
  sessionTtlDays: 7
};
const betaDeploymentBootstrap = {
  flags: {
    consumerJourneyEnabled: true,
    consumerAiIntakeEnabled: false,
    consumerVoiceEnabled: true,
    consumerModuleRoutingEnabled: true,
    consumerHumanHandoffEnabled: false
  },
  access: { publicAccessEnabled: false, inviteRequired: true },
  allowedModules: ['house_purchase', 'liquidity_analysis'],
  cohort: 'adviser_test',
  consentPolicyVersion: betaDeploymentPolicy.consentPolicyVersion,
  consentManifestId: betaDeploymentPolicy.consentManifestId,
  analysisNoticeId: betaDeploymentPolicy.analysisNoticeId,
  privacyNoticeUrl: betaDeploymentPolicy.privacyNoticeUrl,
  limits: { sessionTtlDays: betaDeploymentPolicy.sessionTtlDays },
  ai: { configured: false, noticeId: betaDeploymentPolicy.aiNoticeId },
  voice: {
    enabled: true,
    noticeId: betaDeploymentPolicy.voiceNoticeId,
    dataPolicyId: betaDeploymentPolicy.voiceDataPolicyId,
    policyVersion: betaDeploymentPolicy.consentPolicyVersion,
    privacyNoticeUrl: betaDeploymentPolicy.privacyNoticeUrl,
    transcriptionModel: betaDeploymentPolicy.voiceTranscriptionModel,
    speechModel: betaDeploymentPolicy.voiceSpeechModel,
    voice: betaDeploymentPolicy.voiceName,
    pricingVersion: betaDeploymentPolicy.voicePricingVersion,
    sessionBudgetMicroEur: betaDeploymentPolicy.voiceSessionBudgetMicroEur
  },
  handoff: { enabled: false },
  modules: [{ id: 'house_purchase' }, { id: 'liquidity_analysis' }]
};
assert.equal(validateConsumerDeploymentBootstrap(betaDeploymentBootstrap, {
  mode: 'voice_assisted_rules_only',
  expectedPolicy: betaDeploymentPolicy
}), true);
assert.doesNotThrow(() => assertBetaBootstrap(betaDeploymentBootstrap));

const realtimeDeploymentPolicy = {
  ...betaDeploymentPolicy,
  realtimeNoticeId: 'realtime-voice-adviser-test-v2',
  realtimeDataPolicyId: 'openai-realtime-audio-adviser-test-v2',
  realtimeModel: 'gpt-realtime-2.1',
  realtimeVoice: 'marin',
  realtimeReasoningEffort: 'low',
  realtimeTranscriptionModel: 'gpt-4o-mini-transcribe',
  realtimePromptVersion: 'consumer-realtime-orchestrator-v2',
  realtimeToolsetVersion: 'consumer-realtime-tools-v2',
  realtimePricingVersion: 'openai-gpt-realtime-2.1-usd-parity-eur-safety-2026-07-14-v1',
  realtimeSessionBudgetMicroEur: 10_000_000,
  realtimeDailyBudgetMicroEur: 50_000_000
};
const realtimeDeploymentBootstrap = {
  ...betaDeploymentBootstrap,
  flags: {
    ...betaDeploymentBootstrap.flags,
    consumerRealtimeVoiceEnabled: true,
    consumerHumanHandoffEnabled: false
  },
  realtimeVoice: {
    enabled: true,
    noticeId: realtimeDeploymentPolicy.realtimeNoticeId,
    dataPolicyId: realtimeDeploymentPolicy.realtimeDataPolicyId,
    policyVersion: realtimeDeploymentPolicy.consentPolicyVersion,
    privacyNoticeUrl: realtimeDeploymentPolicy.privacyNoticeUrl,
    model: realtimeDeploymentPolicy.realtimeModel,
    voice: realtimeDeploymentPolicy.realtimeVoice,
    reasoningEffort: realtimeDeploymentPolicy.realtimeReasoningEffort,
    transcriptionModel: realtimeDeploymentPolicy.realtimeTranscriptionModel,
    promptVersion: realtimeDeploymentPolicy.realtimePromptVersion,
    toolsetVersion: realtimeDeploymentPolicy.realtimeToolsetVersion,
    pricingVersion: realtimeDeploymentPolicy.realtimePricingVersion,
    maxDurationSeconds: 900,
    idleTimeoutSeconds: 180,
    sessionBudgetMicroEur: 10_000_000,
    warnThresholdMicroEur: 7_500_000,
    dispatchStopMicroEur: 9_700_000,
    safetyReserveMicroEur: 300_000
  },
  handoff: {
    enabled: false,
    policyVersion: null,
    policyUrl: null,
    retentionPolicyId: null,
    packageRetentionDays: null
  }
};
assert.equal(validateConsumerDeploymentBootstrap(realtimeDeploymentBootstrap, {
  mode: 'realtime_voice_rules_only',
  expectedPolicy: realtimeDeploymentPolicy
}), true);
assert.doesNotThrow(() => assertBetaBootstrap(realtimeDeploymentBootstrap, { realtimeExpected: true }));
assert.match(buildProposedCredential(), /^cs_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/);
assert.equal(paidVoiceProviderSmokeEnabled(undefined), false);
assert.equal(paidVoiceProviderSmokeEnabled('false'), false);
assert.equal(paidVoiceProviderSmokeEnabled('true'), true);
assert.throws(() => paidVoiceProviderSmokeEnabled('yes'));
assert.equal(paidRealtimeInfrastructureProofEnabled(undefined), false);
assert.equal(paidRealtimeInfrastructureProofEnabled('false'), false);
assert.equal(paidRealtimeInfrastructureProofEnabled('true'), true);
assert.throws(() => paidRealtimeInfrastructureProofEnabled('yes'));
const paidSmokeBudgetHeaders = new Headers({
  'X-Voice-Limit-Micro-Eur': '2000000',
  'X-Voice-Spent-Micro-Eur': '100000',
  'X-Voice-Remaining-Micro-Eur': '1900000'
});
const paidSmokeBudget = voiceBudgetFromHeaders(paidSmokeBudgetHeaders);
assert.deepEqual(paidSmokeBudget, {
  limitMicroEur: 2_000_000,
  spentMicroEur: 100_000,
  remainingMicroEur: 1_900_000
});
assert.doesNotThrow(() => assertVoiceBudgetSnapshot(paidSmokeBudget, 100_000));
assert.throws(() => voiceBudgetFromHeaders(new Headers({
  'X-Voice-Limit-Micro-Eur': '2000000',
  'X-Voice-Spent-Micro-Eur': '-1',
  'X-Voice-Remaining-Micro-Eur': '1900000'
})));
for (const unsafePayload of [
  { ...betaDeploymentBootstrap, access: { publicAccessEnabled: true, inviteRequired: false } },
  {
    ...betaDeploymentBootstrap,
    flags: { ...betaDeploymentBootstrap.flags, consumerAiIntakeEnabled: true },
    ai: { ...betaDeploymentBootstrap.ai, configured: true }
  },
  { ...betaDeploymentBootstrap, cohort: 'public' },
  { ...betaDeploymentBootstrap, allowedModules: [...betaDeploymentBootstrap.allowedModules, 'retirement'] }
]) {
  assert.throws(() => validateConsumerDeploymentBootstrap(unsafePayload, {
    mode: 'voice_assisted_rules_only',
    expectedPolicy: betaDeploymentPolicy
  }));
  assert.throws(() => assertBetaBootstrap(unsafePayload));
}

const disabledConfig = getConsumerConfig({});
assert.equal(disabledConfig.journeyEnabled, false);
assert.equal(disabledConfig.aiEnabled, false);
assert.equal(disabledConfig.voiceEnabled, false);
assert.equal(disabledConfig.providerCostLimitEurMicros, 0);
assert.equal(disabledConfig.handoffEnabled, false);

const consent = {
  analysis: true,
  aiProcessing: false,
  adultConfirmed: true,
  educationOnlyAcknowledged: true,
  manifestId: 'consumer-manifest-v1',
  policyVersion: 'consumer-v1',
  analysisNoticeId: 'analysis-v1',
  aiNoticeId: 'ai-v1',
  privacyNoticeUrl: 'https://planeir.ie/plan/privacy.html'
};
const consentManifest = {
  manifestId: consent.manifestId,
  policyVersion: consent.policyVersion,
  analysisNoticeId: consent.analysisNoticeId,
  aiNoticeId: consent.aiNoticeId,
  privacyNoticeUrl: consent.privacyNoticeUrl
};
const publicConfig = publicConsumerConfig({
  journeyEnabled: true,
  aiEnabled: false,
  voiceEnabled: false,
  moduleRoutingEnabled: true,
  handoffEnabled: true,
  publicAccessEnabled: false,
  allowedModules: ['house_purchase', 'liquidity_analysis'],
  cohort: 'internal',
  consentPolicyVersion: 'consumer-v1',
  profileSchemaVersion: 1,
  maxMessageLength: 4000,
  maxTurnsPerSession: 80,
  sessionTtlDays: 30,
  defaultModel: 'gpt-5.6-luna',
  complexModel: 'gpt-5.6-terra',
  defaultReasoningEffort: 'low',
  complexReasoningEffort: 'medium',
  aiPromptVersion: 'consumer-intake-v1',
  aiSchemaVersion: 'consumer-profile-patch-v1',
  voiceMaxDurationSeconds: 45,
  voiceSessionBudgetMicroEur: 0,
  handoffPolicyVersion: 'handoff-v1',
  handoffPolicyUrl: 'https://planeir.ie/plan/privacy.html#handoff',
  handoffRetentionPolicyId: 'handoff-retention-v1',
  handoffRetentionDays: 30,
  bookingUrl: 'https://example.com/private-booking'
});
assert.equal(publicConfig.bookingUrl, undefined, 'bootstrap must not disclose the booking URL before a linked handoff');
assert.equal(publicConfig.handoff.policyUrl, 'https://planeir.ie/plan/privacy.html#handoff');
assert.deepEqual(validateCreateSessionBody({ consent }, consentManifest), consent);
for (const invalid of [
  { ...consent, analysis: false },
  { ...consent, adultConfirmed: false },
  { ...consent, educationOnlyAcknowledged: false },
  { ...consent, policyVersion: 'old' }
]) {
  assert.throws(() => validateCreateSessionBody({ consent: invalid }, consentManifest));
}
assert.throws(() => validateCreateSessionBody({
  consent: { ...consent, analysisNoticeId: 'analysis-v2' }
}, consentManifest), (error) => error.code === 'consent_policy_outdated');
assert.deepEqual(validateConsentBody({ aiProcessing: false }), { aiProcessing: false });
assert.throws(() => validateConsentBody({ aiProcessing: true }));
const voiceConsentExpectation = {
  noticeId: 'voice-adviser-test-v1',
  policyVersion: 'consumer-adviser-test-v1',
  privacyNoticeUrl: 'https://planeir.ie/plan/privacy.html'
};
assert.deepEqual(validateVoiceConsentBody({
  granted: true,
  ...voiceConsentExpectation
}, voiceConsentExpectation), {
  granted: true,
  ...voiceConsentExpectation
});
assert.throws(() => validateVoiceConsentBody({
  granted: true,
  ...voiceConsentExpectation,
  noticeId: 'stale-notice'
}, voiceConsentExpectation), (error) => error.code === 'voice_policy_outdated');
assert.deepEqual(validateVoiceConsentBody({
  granted: false,
  noticeId: 'original-notice',
  policyVersion: 'original-policy',
  privacyNoticeUrl: 'https://planeir.ie/plan/privacy.html'
}, voiceConsentExpectation), {
  granted: false,
  noticeId: 'original-notice',
  policyVersion: 'original-policy',
  privacyNoticeUrl: 'https://planeir.ie/plan/privacy.html'
});
assert.deepEqual(validateVoiceSpeechBody({ idempotencyKey: 'voice-speech-1234' }), {
  idempotencyKey: 'voice-speech-1234'
});
assert.throws(() => validateVoiceSpeechBody({
  idempotencyKey: 'voice-speech-1234',
  text: 'Never accept client-supplied speech text.'
}), (error) => error.code === 'voice_speech_text_not_allowed');
assert.deepEqual(validateConfirmBody({ expectedRevision: 3 }), { confirmedPaths: [], expectedRevision: 3 });
assert.throws(() => validateConfirmBody({}));
assert.deepEqual(validateProfilePatchBody({
  patch: {},
  removePaths: ['/assets/0'],
  expectedRevision: 3
}), {
  patch: {},
  removePaths: ['/assets/0'],
  confirmedPaths: [],
  expectedRevision: 3
});
assert.throws(() => validateProfilePatchBody({ patch: {}, removePaths: ['/assets/0/currentValue'], expectedRevision: 3 }));

let profile = createInitialProfile('cs_abcdefghijklmnopqrstuvwxyz', consent, '2026-07-12T12:00:00.000Z');
profile = applyProfilePatch(profile, {
  '/goals/0': {
    goalId: 'goal-home',
    type: 'buy_home',
    title: 'Buy a home',
    priority: 'high',
    status: 'exploring'
  }
}, [], 'consumer_edit');
assert.doesNotThrow(() => normalizeHouseholdProfile(profile));
assert.equal(profile.fieldMetadata['/goals/0/type'].source, 'user_statement');
assert.equal(profile.fieldMetadata['/goals/0/type'].confidence, 'high');
assert.equal(profile.fieldMetadata['/goals/0/type'].confirmedByUser, false);
assert.deepEqual(recommendModules(profile).slice(0, 2).map((item) => item.moduleId), ['house_purchase', 'liquidity_analysis']);
let state = describeConversationState(profile, {
  moduleRoutingEnabled: true,
  allowedModules: ['house_purchase', 'liquidity_analysis']
});
assert.equal(state.stage, 'life_stage_scan');
assert.equal(state.nextQuestion.fieldPaths[0], '/assumptions/values/persona/selfDescription');
const personaPatch = extractContextBoundPatch(profile, state.nextQuestion, 'I am a first-time buyer');
assert.deepEqual(personaPatch, {
  '/assumptions/values/persona/selfDescription': 'first_time_buyer'
});
profile = applyProfilePatch(profile, personaPatch, [], 'consumer_edit');
state = describeConversationState(profile, {
  moduleRoutingEnabled: true,
  allowedModules: ['house_purchase', 'liquidity_analysis']
});
assert.notEqual(state.stage, 'life_stage_scan');
assert.equal(state.nextQuestion.fieldPaths[0], '/expenses/monthlyEssential');
assert.deepEqual(extractContextBoundPatch(profile, state.nextQuestion, '€3,000'), {
  '/expenses/monthlyEssential': { amount: 3000, currency: 'EUR' }
});
const naturalIncomePatch = extractContextBoundPatch(
  profile,
  { fieldPaths: ['/incomeSources'], answerType: 'money' },
  'Our gross annual household income is €65,000 per year'
);
assert.equal(naturalIncomePatch['/incomeSources/0'].grossAnnual.amount, 65000);
const monthlyIncomePatch = extractContextBoundPatch(
  profile,
  { fieldPaths: ['/incomeSources'], answerType: 'money' },
  'I earn €4k/month'
);
assert.equal(monthlyIncomePatch['/incomeSources/0'].grossAnnual.amount, 48000);
const naturalCashPatch = extractContextBoundPatch(
  profile,
  { fieldPaths: ['/assets'], answerType: 'money' },
  'We currently have about €50k in cash savings'
);
assert.equal(naturalCashPatch['/assets/0'].currentValue.amount, 50000);
const naturalSpendingPatch = extractContextBoundPatch(
  profile,
  { fieldPaths: ['/expenses'], answerType: 'money' },
  'Our essential spending is roughly €2,500 per month'
);
assert.equal(naturalSpendingPatch['/expenses/monthlyEssential'].amount, 2500);
const monthlyToAnnualSpending = extractContextBoundPatch(
  profile,
  { fieldPaths: ['/expenses/annualTotal'], answerType: 'money' },
  'We spend €2,000 per month'
);
assert.equal(monthlyToAnnualSpending['/expenses/annualTotal'].amount, 24000);
const annualToMonthlySpending = extractContextBoundPatch(
  profile,
  { fieldPaths: ['/expenses/monthlyEssential'], answerType: 'money' },
  'Our essentials are €30,000 per year'
);
assert.equal(annualToMonthlySpending['/expenses/monthlyEssential'].amount, 2500);
assert.equal(extractContextBoundPatch(
  profile,
  { fieldPaths: ['/assets'], answerType: 'money' },
  'We have €2,000 per month'
), null);
assert.equal(extractContextBoundPatch(
  profile,
  { fieldPaths: ['/incomeSources'], answerType: 'money' },
  '€4,000 monthly and annually'
), null);
assert.deepEqual(extractContextBoundPatch(
  profile,
  { fieldPaths: ['/expenses/currentMonthlyRent'], answerType: 'money' },
  'none'
), {
  '/expenses/currentMonthlyRent': { amount: 0, currency: 'EUR' }
});
assert.equal(extractContextBoundPatch(
  profile,
  { fieldPaths: ['/incomeSources'], answerType: 'money' },
  'I earn €65,000 and my partner earns €30,000'
), null);
const noCashPatch = extractContextBoundPatch(
  profile,
  { fieldPaths: ['/assets'], answerType: 'money' },
  'none'
);
assert.equal(noCashPatch['/assets/0'].currentValue.amount, 0);
const firstTimeBuyerPatch = extractContextBoundPatch(
  profile,
  { fieldPaths: ['/assumptions/values/housePurchase/lendingCategory'], answerType: 'text' },
  'First-time buyer'
);
assert.deepEqual(firstTimeBuyerPatch['/assumptions/values/housePurchase'], {
  lendingCategory: 'first_time_buyer',
  schemeBuyerStatus: 'first_time_buyer'
});

const preparedNoExpenseProfile = applyProfilePatch(profile, {
  '/partner': {
    personId: 'partner-realtime-test',
    role: 'partner',
    displayName: 'Partner',
    employmentStatus: 'employee'
  },
  '/goals/0/targetAmount': { amount: 350000, currency: 'EUR' },
  '/incomeSources/0': {
    incomeId: 'income-none-test',
    ownerId: profile.primaryPerson.personId,
    type: 'employment',
    label: 'Employment income',
    grossAnnual: { amount: 65000, currency: 'EUR' }
  },
  '/assets/0': {
    assetId: 'cash-none-test',
    ownerIds: [profile.primaryPerson.personId],
    type: 'cash',
    label: 'Cash savings',
    currentValue: { amount: 50000, currency: 'EUR' },
    liquid: true
  },
  '/expenses/currentMonthlyRent': { amount: 0, currency: 'EUR' },
  '/assumptions/values/housePurchase': {
    lendingCategory: 'first_time_buyer',
    schemeBuyerStatus: 'first_time_buyer'
  }
}, [], 'consumer_edit');
const exactNoExpensePatch = extractContextBoundPatch(
  preparedNoExpenseProfile,
  { fieldPaths: ['/expenses/monthlyEssential'], answerType: 'money' },
  'none'
);
assert.equal(
  exactNoExpensePatch['/assumptions/values/completionFacts'].confirmedNonePaths['/expenses/monthlyEssential'],
  true
);
const noExpenseProfile = applyProfilePatch(
  preparedNoExpenseProfile,
  exactNoExpensePatch,
  [],
  'consumer_edit'
);
const noExpenseState = describeConversationState(noExpenseProfile, {
  moduleRoutingEnabled: true,
  allowedModules: ['house_purchase', 'liquidity_analysis']
});
assert.equal(noExpenseState.stage, 'goal_specific_questions');
assert.deepEqual(noExpenseState.nextQuestion.fieldPaths, ['/businesses']);
assert.equal(
  noExpenseState.recommendations.find((item) => item.moduleId === 'personal_balance_sheet').readiness.status,
  'missing_information',
  'the exact persona bundle continues gathering Personal Balance Sheet inputs'
);
assert.ok(noExpenseState.recommendations
  .filter((item) => ['house_purchase', 'liquidity_analysis'].includes(item.moduleId))
  .every((item) => item.readiness.status === 'adviser_review_required'));

const siblingNoneProfile = applyProfilePatch(preparedNoExpenseProfile, {
  '/assumptions/values/completionFacts': {
    confirmedNonePaths: { '/expenses/monthlyDiscretionary': true }
  }
}, [], 'consumer_edit');
const siblingNoneState = describeConversationState(siblingNoneProfile, {
  moduleRoutingEnabled: true,
  allowedModules: ['house_purchase', 'liquidity_analysis']
});
assert.equal(siblingNoneState.stage, 'goal_specific_questions');
assert.equal(siblingNoneState.nextQuestion.fieldPaths[0], '/expenses/monthlyEssential');
const previousBuyerPatch = extractContextBoundPatch(
  profile,
  { fieldPaths: ['/assumptions/values/housePurchase/lendingCategory'], answerType: 'text' },
  'I owned a home before'
);
assert.equal(previousBuyerPatch['/assumptions/values/housePurchase'].lendingCategory, 'second_or_subsequent');

const plan = await runConsumerAnalysis({
  profile,
  allowedModuleIds: ['house_purchase', 'liquidity_analysis']
});
assert.ok(plan.analysisPlan);
assert.equal(plan.plan, plan.analysisPlan);
assert.ok(Array.isArray(plan.recommendations));
assert.ok(Array.isArray(plan.results));
assert.ok(Array.isArray(plan.errors));
assert.ok(plan.analysisPlan.selectedModules.every((item) => ['house_purchase', 'liquidity_analysis'].includes(item.moduleId)));

const sensitive = 'PPS 1234567A, IBAN IE29AIBK93115212345678, password hunter12345';
const redacted = redactSensitiveIdentifiers(sensitive);
assert.doesNotMatch(redacted, /1234567A|IE29AIBK93115212345678|hunter12345/);
const validatedTurn = validateTurnBody({ message: sensitive, idempotencyKey: 'turn-redact-1234' }, 4000);
assert.doesNotMatch(validatedTurn.message, /1234567A|IE29AIBK93115212345678|hunter12345/);
const groupedSensitive = redactSensitiveIdentifiers('IBAN IE29 AIBK 9311 5212 3456 78 and card 4242 4242 4242 4242');
assert.doesNotMatch(groupedSensitive, /9311 5212|4242 4242/);
assert.doesNotMatch(redactSensitiveIdentifiers('My home address is 1 Main Street, Dublin; call me.'), /1 Main Street/);
assert.throws(() => validateHandoffBody({
  fullName: 'Test User',
  email: 'test@example.com',
  phone: '',
  requestedHelp: 'My card is 4242 4242 4242 4242',
  consent: true,
  policyVersion: 'handoff-v1',
  policyUrl: 'https://planeir.ie/plan/privacy.html#handoff',
  expectedRevision: 3
}, {
  version: 'handoff-v1',
  url: 'https://planeir.ie/plan/privacy.html#handoff'
}), (error) => error.code === 'handoff_sensitive_data_prohibited');

const inviteKeyBytes = crypto.getRandomValues(new Uint8Array(32));
const inviteSigningKey = Buffer.from(inviteKeyBytes).toString('base64url');
const issuedInvite = await createConsumerInvite({
  CONSUMER_INVITE_SIGNING_KEY: inviteSigningKey
}, {
  cohort: 'internal',
  inviteMaxTtlHours: 24
}, {
  now: Date.UTC(2026, 6, 13, 12, 0, 0),
  ttlHours: 4,
  maxUses: 1
});
assert.match(issuedInvite.token, /^ci1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
assert.equal(issuedInvite.cohort, 'internal');
assert.equal(issuedInvite.maxUses, 1);
assert.equal(issuedInvite.issuedAt, '2026-07-13T12:00:00.000Z');
assert.equal(issuedInvite.expiresAt, '2026-07-13T16:00:00.000Z');
const issuedClaims = await verifyConsumerInvite(issuedInvite.token, {
  CONSUMER_INVITE_SIGNING_KEY: inviteSigningKey
}, {
  cohort: 'internal',
  inviteMaxTtlHours: 24
}, Date.UTC(2026, 6, 13, 12, 0, 0));
assert.equal(issuedClaims.jti, issuedInvite.jti);
assert.equal(issuedClaims.maxUses, 1);

const previewEnv = {
  CONSUMER_JOURNEY_ENABLED: 'true',
  CONSUMER_MODULE_ROUTING_ENABLED: 'true',
  CONSUMER_PUBLIC_ACCESS_ENABLED: 'false',
  CONSUMER_DB: {},
  CONSUMER_DATA_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
  CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
  CONSUMER_INVITE_SIGNING_KEY: inviteSigningKey,
  CONSUMER_CONSENT_POLICY_VERSION: 'consumer-preview-v1',
  CONSUMER_CONSENT_MANIFEST_ID: 'consumer-preview-manifest-v1',
  CONSUMER_ANALYSIS_NOTICE_ID: 'analysis-preview-v1',
  CONSUMER_AI_NOTICE_ID: 'ai-preview-v1',
  CONSUMER_PRIVACY_NOTICE_URL: 'https://planeir.ie/plan/privacy.html',
  CONSUMER_SESSION_TTL_DAYS: '7',
  CONSUMER_INVITE_MAX_TTL_HOURS: '24',
  CONSUMER_ALLOWED_MODULE_IDS: 'house_purchase,liquidity_analysis',
  CONSUMER_COHORT: 'adviser_test',
  CONSUMER_PLAN_BASE_URL: 'https://planeir.ie/plan/'
};
assert.equal(isAdvisorRulesOnlyPreviewConfig(getConsumerConfig(previewEnv)), true);
assert.equal(isAdvisorProtectedPreviewConfig(getConsumerConfig(previewEnv)), true);
assert.equal(isAdvisorRulesOnlyPreviewConfig(getConsumerConfig({
  ...previewEnv,
  CONSUMER_AI_INTAKE_ENABLED: 'true'
})), false);
assert.equal(isAdvisorRulesOnlyPreviewConfig(getConsumerConfig({
  ...previewEnv,
  CONSUMER_HANDOFF_ENABLED: 'true'
})), false);
const previewInvite = await createAdvisorConsumerInvite(previewEnv, {
  now: Date.UTC(2026, 6, 13, 12, 0, 0)
});
assert.deepEqual(Object.keys(previewInvite), ['ok', 'url', 'expiresAt', 'maxUses', 'mode']);
assert.equal(previewInvite.ok, true);
assert.equal(previewInvite.expiresAt, '2026-07-13T16:00:00.000Z');
assert.equal(previewInvite.maxUses, 1);
assert.equal(previewInvite.mode, 'rules_only');
const previewUrl = new URL(previewInvite.url);
assert.equal(previewUrl.origin, 'https://planeir.ie');
assert.equal(previewUrl.pathname, '/plan/');
assert.equal(previewUrl.search, '');
const previewToken = new URLSearchParams(previewUrl.hash.slice(1)).get('invite');
assert.ok(previewToken);
await assert.doesNotReject(() => verifyConsumerInvite(previewToken, previewEnv, {
  cohort: 'adviser_test',
  inviteMaxTtlHours: 24
}, Date.UTC(2026, 6, 13, 12, 0, 0)));

const voicePreviewEnv = {
  ...previewEnv,
  OPENAI_API_KEY: 'test-only-server-secret',
  CONSUMER_VOICE_ENABLED: 'true',
  CONSUMER_VOICE_NOTICE_ID: 'voice-adviser-test-v1',
  CONSUMER_VOICE_DATA_POLICY_ID: 'openai-audio-adviser-test-v1',
  CONSUMER_VOICE_TRANSCRIPTION_MODEL: 'gpt-4o-mini-transcribe',
  CONSUMER_VOICE_SPEECH_MODEL: 'tts-1-hd',
  CONSUMER_VOICE_NAME: 'nova',
  CONSUMER_VOICE_PRICING_VERSION: 'openai-audio-eur-safety-2026-07-13-v2',
  CONSUMER_VOICE_SESSION_BUDGET_EUR_CENTS: '200',
  CONSUMER_VOICE_DAILY_BUDGET_EUR_CENTS: '2000',
  CONSUMER_VOICE_TRANSCRIPTION_RESERVATION_EUR_CENTS: '10',
  CONSUMER_VOICE_SPEECH_RESERVATION_EUR_CENTS: '10'
};
const voicePreviewConfig = getConsumerConfig(voicePreviewEnv);
assert.equal(isAdvisorRulesOnlyPreviewConfig(voicePreviewConfig), false);
assert.equal(isAdvisorVoicePreviewConfig(voicePreviewConfig), true);
assert.equal(isAdvisorProtectedPreviewConfig(voicePreviewConfig), true);
assert.equal(voicePreviewConfig.providerCostLimitEurMicros, 2_000_000);
for (const [field, malformedValue] of [
  ['CONSUMER_VOICE_SESSION_BUDGET_EUR_CENTS', '200oops'],
  ['CONSUMER_VOICE_SESSION_BUDGET_EUR_CENTS', '200.9'],
  ['CONSUMER_VOICE_DAILY_BUDGET_EUR_CENTS', '02000']
]) {
  const malformed = getConsumerConfig({ ...voicePreviewEnv, [field]: malformedValue });
  assert.equal(malformed.voiceEnabled, false, `${field} must reject malformed integer values.`);
  assert.equal(malformed.providerCostLimitEurMicros, 0, `${field} must fail closed.`);
}
const voicePreviewInvite = await createAdvisorConsumerInvite(voicePreviewEnv, {
  now: Date.UTC(2026, 6, 13, 12, 0, 0)
});
assert.equal(voicePreviewInvite.mode, 'voice_assisted_rules_only');

const realtimeVoicePreviewConfig = {
  ...voicePreviewConfig,
  realtimeRequested: true,
  realtimeConfigured: true,
  realtimeEnabled: true,
  handoffRequested: false,
  handoffConfigured: false,
  handoffEnabled: false,
  realtimeNoticeId: 'realtime-voice-adviser-test-v2',
  realtimeDataPolicyId: 'openai-realtime-audio-adviser-test-v2',
  realtimeModel: 'gpt-realtime-2.1',
  realtimeVoice: 'marin',
  realtimeReasoningEffort: 'low',
  realtimeTranscriptionModel: 'gpt-4o-mini-transcribe',
  realtimePromptVersion: 'consumer-realtime-orchestrator-v2',
  realtimeToolsetVersion: 'consumer-realtime-tools-v2',
  realtimePricingVersion: 'openai-gpt-realtime-2.1-usd-parity-eur-safety-2026-07-14-v1',
  realtimeSpeechModel: 'tts-1-hd',
  realtimeSpeechVoice: 'nova',
  realtimeSpeechRateMicroEurPerMillionCharacters: 30_000_000,
  realtimeSessionBudgetMicroEur: 10_000_000,
  realtimeSessionWarnMicroEur: 7_500_000,
  realtimeDailyBudgetMicroEur: 50_000_000,
  realtimeDispatchStopMicroEur: 9_700_000,
  realtimeSafetyReserveMicroEur: 300_000,
  realtimeMaxDurationSeconds: 900,
  realtimeIdleTimeoutSeconds: 180,
  realtimeSilencePromptSeconds: 45,
  realtimeMaxSdpBytes: 32_768,
  realtimeMaxResponses: 40,
  realtimeMaxToolCalls: 24
};
// The previous €2/600s/90s adviser envelope is no longer the approved
// fingerprint; a worker still deployed with it must refuse adviser sessions
// rather than silently running with the outdated limits.
assert.equal(isAdvisorRealtimePreviewConfig({
  ...realtimeVoicePreviewConfig,
  realtimeSessionBudgetMicroEur: 2_000_000,
  realtimeDispatchStopMicroEur: 1_700_000,
  realtimeMaxDurationSeconds: 600,
  realtimeIdleTimeoutSeconds: 90
}), false);
assert.equal(isAdvisorVoicePreviewConfig(realtimeVoicePreviewConfig), false);
assert.equal(isAdvisorRealtimePreviewConfig(realtimeVoicePreviewConfig), true);
assert.equal(isAdvisorProtectedPreviewConfig(realtimeVoicePreviewConfig), true);
assert.match(
  routerSource,
  /isAdvisorVoicePreviewConfig\(config\) \|\| isAdvisorRealtimePreviewConfig\(config\)/,
  'The retained bounded voice fallback must remain authorized inside the approved Realtime canary.'
);
await assert.rejects(() => createAdvisorConsumerInvite({
  ...previewEnv,
  CONSUMER_JOURNEY_ENABLED: 'false'
}), (error) => error.status === 503 && error.code === 'consumer_adviser_preview_unavailable');
await assert.rejects(() => createAdvisorConsumerInvite({
  ...previewEnv,
  CONSUMER_AI_INTAKE_ENABLED: 'true'
}), (error) => error.status === 503 && error.code === 'consumer_adviser_preview_unavailable');
await assert.rejects(() => createAdvisorConsumerInvite({
  ...previewEnv,
  CONSUMER_HANDOFF_ENABLED: 'true'
}), (error) => error.status === 503 && error.code === 'consumer_adviser_preview_unavailable');
await assert.rejects(() => createAdvisorConsumerInvite({
  ...previewEnv,
  CONSUMER_PLAN_BASE_URL: 'https://planeir.ie:8443/plan/'
}), (error) => error.status === 503 && error.code === 'consumer_adviser_preview_unavailable');
await assert.rejects(() => createAdvisorConsumerInvite({
  ...previewEnv,
  CONSUMER_PLAN_BASE_URL: 'javascript:alert(1)'
}), (error) => error.status === 503 && error.code === 'consumer_adviser_preview_unavailable');

const nowSeconds = Math.floor(Date.now() / 1_000);
const invitePayload = Buffer.from(JSON.stringify({
  v: 1,
  aud: 'planeir-consumer',
  jti: Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url'),
  cohort: 'internal',
  iat: nowSeconds,
  exp: nowSeconds + 3_600,
  maxUses: 1
})).toString('base64url');
const inviteKey = await crypto.subtle.importKey(
  'raw',
  inviteKeyBytes,
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign']
);
const inviteSignature = Buffer.from(await crypto.subtle.sign(
  'HMAC',
  inviteKey,
  new TextEncoder().encode(`ci1.${invitePayload}`)
)).toString('base64url');
const signedInvite = `ci1.${invitePayload}.${inviteSignature}`;
const inviteClaims = await verifyConsumerInvite(signedInvite, {
  CONSUMER_INVITE_SIGNING_KEY: inviteSigningKey
}, {
  cohort: 'internal',
  inviteMaxTtlHours: 24
});
assert.equal(inviteClaims.maxUses, 1);
assert.equal(inviteClaims.cohort, 'internal');
const tamperedInviteSignature = `${inviteSignature.startsWith('A') ? 'B' : 'A'}${inviteSignature.slice(1)}`;
const tamperedInvite = `ci1.${invitePayload}.${tamperedInviteSignature}`;
await assert.rejects(() => verifyConsumerInvite(tamperedInvite, {
  CONSUMER_INVITE_SIGNING_KEY: inviteSigningKey
}, {
  cohort: 'internal',
  inviteMaxTtlHours: 24
}), (error) => error.code === 'consumer_invite_required');

const originalFetch = globalThis.fetch;
let capturedAiRequest;
let capturedAiHeaders;
const aiConfig = {
  aiEnabled: true,
  defaultModel: 'gpt-5.6-luna',
  complexModel: 'gpt-5.6-terra',
  defaultReasoningEffort: 'low',
  complexReasoningEffort: 'medium',
  aiTimeoutMs: 1_000,
  aiMaxOutputTokens: 500,
  aiSchemaVersion: 'consumer-profile-patch-v1',
  aiPromptVersion: 'consumer-intake-v1'
};
try {
  globalThis.fetch = async (_url, init) => {
    capturedAiRequest = JSON.parse(init.body);
    capturedAiHeaders = new Headers(init.headers);
    return new Response(JSON.stringify({
      status: 'completed',
      output_text: JSON.stringify({
        assistantMessage: 'A prohibited model answer with €123 should never be surfaced.',
        profilePatch: [],
        goalCandidates: [],
        ambiguities: [],
        suggestedNextIntent: 'review'
      }),
      usage: { input_tokens: 10, output_tokens: 5 }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_test_123' }
    });
  };
  const aiResult = await extractProfilePatchWithAi({
    env: { OPENAI_API_KEY: 'test-only' },
    config: aiConfig,
    session: { stage: 'goal_discovery', aiProcessingConsented: true },
    profile,
    message: sensitive,
    rollingSummary: 'Stage: goal discovery.',
    activeQuestion: state.nextQuestion
  });
  assert.equal(capturedAiRequest.store, false);
  assert.equal(capturedAiRequest.previous_response_id, undefined);
  assert.doesNotMatch(JSON.stringify(capturedAiRequest), /1234567A|IE29AIBK93115212345678|hunter12345/);
  assert.match(capturedAiHeaders.get('x-client-request-id'), /^[0-9a-f-]{36}$/i);
  assert.equal(aiResult.metadata.clientRequestId, capturedAiHeaders.get('x-client-request-id'));
  assert.equal(aiResult.metadata.providerRequestId, 'req_test_123');
  assert.equal(aiResult.metadata.responseStatus, 'completed');

  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'completed', output_text: '{invalid json' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
  await assert.rejects(() => extractProfilePatchWithAi({
    env: { OPENAI_API_KEY: 'test-only' },
    config: aiConfig,
    session: { stage: 'goal_discovery', aiProcessingConsented: true },
    profile,
    message: 'I want to build wealth.',
    rollingSummary: '',
    activeQuestion: state.nextQuestion
  }), (error) => error.code === 'ai_output_invalid' && error.metadata?.model === 'gpt-5.6-luna');

  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output_text: JSON.stringify({
      assistantMessage: 'This valid-looking payload must not be accepted.',
      profilePatch: [],
      goalCandidates: [],
      ambiguities: [],
      suggestedNextIntent: 'review'
    })
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_incomplete_123' }
  });
  await assert.rejects(() => extractProfilePatchWithAi({
    env: { OPENAI_API_KEY: 'test-only' },
    config: aiConfig,
    session: { stage: 'goal_discovery', aiProcessingConsented: true },
    profile,
    message: 'I want to buy a home.',
    rollingSummary: '',
    activeQuestion: state.nextQuestion
  }), (error) => (
    error.code === 'ai_response_incomplete'
    && error.details?.incompleteReason === 'max_output_tokens'
    && error.metadata?.providerRequestId === 'req_incomplete_123'
  ));

  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'failed' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
  await assert.rejects(() => extractProfilePatchWithAi({
    env: { OPENAI_API_KEY: 'test-only' },
    config: aiConfig,
    session: { stage: 'goal_discovery', aiProcessingConsented: true },
    profile,
    message: 'I want to buy a home.',
    rollingSummary: '',
    activeQuestion: state.nextQuestion
  }), (error) => error.code === 'ai_response_not_completed' && error.details?.responseStatus === 'failed');
} finally {
  globalThis.fetch = originalFetch;
}

const oldKey = crypto.getRandomValues(new Uint8Array(32));
const newKey = crypto.getRandomValues(new Uint8Array(32));
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const oldEnv = {
  CONSUMER_DATA_ENCRYPTION_KEY: b64u(oldKey),
  CONSUMER_DATA_ENCRYPTION_KEY_ID: 'consumer-old'
};
const encrypted = await encryptJson(oldEnv, { sentinel: 'financial-value-123' }, 'contract/aad');
assert.doesNotMatch(encrypted, /financial-value-123/);
assert.equal(getCurrentEncryptionKeyId(oldEnv), 'consumer-old');
assert.equal(getEncryptedPayloadKeyId(encrypted), 'consumer-old');
assert.deepEqual(await decryptJson(oldEnv, encrypted, 'contract/aad'), { sentinel: 'financial-value-123' });

const rotatedEnv = {
  CONSUMER_DATA_ENCRYPTION_KEY: b64u(newKey),
  CONSUMER_DATA_ENCRYPTION_KEY_ID: 'consumer-new',
  CONSUMER_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: JSON.stringify({ 'consumer-old': b64u(oldKey) })
};
assert.deepEqual(await decryptJson(rotatedEnv, encrypted, 'contract/aad'), { sentinel: 'financial-value-123' });
const reEncrypted = await encryptJson(rotatedEnv, await decryptJson(rotatedEnv, encrypted, 'contract/aad'), 'contract/aad');
assert.equal(getEncryptedPayloadKeyId(reEncrypted), 'consumer-new');
await assert.rejects(() => decryptJson({
  CONSUMER_DATA_ENCRYPTION_KEY: b64u(newKey),
  CONSUMER_DATA_ENCRYPTION_KEY_ID: 'consumer-new'
}, encrypted, 'contract/aad'));

const credential = await createConsumerCredential();
assert.deepEqual(parseConsumerCredential(credential.credential), { id: credential.id, secret: credential.secret });
assert.equal(parseConsumerCredential('invalid'), null);

console.log('Consumer Worker contracts passed.');
