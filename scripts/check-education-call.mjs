import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createTestRuntime } from './lib/application-test-runtime.mjs';
import { EDUCATION_CALL, educationCallDuration, educationCallScheduleIntroduction } from '../js/workspace/education_call.js';
import { validateHandoffBody } from '../worker/src/consumer/validators.js';
import { createConsumerCredential } from '../worker/src/consumer/crypto.js';
import { createSessionRecord, getSessionRow, getCurrentProfile, createAnalysisRun, completeAnalysisRun, getHandoff, readHandoffPackage } from '../worker/src/consumer/repository.js';
import { requestAdviserHandoff } from '../worker/src/consumer/handoff.js';
import { createConsumerPipelineHandoff } from '../worker/src/index.js';

const advisor = createTestRuntime({ ZOOM_ACCOUNT_ID: 'test-account', ZOOM_CLIENT_ID: 'test-client', ZOOM_CLIENT_SECRET: 'test-secret', ZOOM_USER_ID: 'test-host' });
const consumer = createTestRuntime();
const migrations = new URL('../worker/consumer-migrations/', import.meta.url);
for (const file of readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort()) consumer.sql.exec(readFileSync(new URL(file, migrations), 'utf8'));
const env = { ...advisor.env, CONSUMER_DB: consumer.db, CONSUMER_DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64url') };
const config = { sessionTtlDays: 7, cohort: 'automated_test', handoffEnabled: true, handoffRetentionDays: 30, handoffRetentionPolicyId: 'call-contact-30d-v1' };
const policy = { version: 'private-call-contact-v1', url: 'https://planeir.ie/privacy/#optional-call' };
const originalFetch = globalThis.fetch;
const meetings = [], emails = [];
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.startsWith('https://zoom.us/oauth/token')) return new Response(JSON.stringify({ access_token: 'fixture-token' }));
  if (target === 'https://api.zoom.us/v2/users/test-host/meetings') {
    meetings.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: 123456789, join_url: 'https://zoom.us/j/123456789', password: 'fixture-passcode' }));
  }
  if (target === 'https://api.resend.com/emails') {
    emails.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: `fixture-email-${emails.length}` }));
  }
  throw new Error(`Unexpected external request in test: ${target}`);
};

try {
  const credential = await createConsumerCredential();
  await createSessionRecord(env, credential, {
    aiProcessing: false, manifestId: 'fixture-manifest', policyVersion: 'fixture-policy',
    analysisNoticeId: 'fixture-privacy', aiNoticeId: 'fixture-ai', privacyNoticeUrl: 'https://planeir.ie/privacy/'
  }, config);
  consumer.sql.prepare('UPDATE consumer_sessions SET confirmed_profile_revision = current_profile_revision WHERE id = ?').run(credential.id);
  let row = await getSessionRow(env, credential.id);
  const profile = await getCurrentProfile(env, row);
  const body = {
    fullName: 'Call Test', email: 'call-test@example.com', phone: '',
    requestedHelp: 'Talk through my housing comparison.', consent: true,
    policyVersion: policy.version, policyUrl: policy.url, expectedRevision: 1,
    callOfferVersion: EDUCATION_CALL.version, callOfferAcknowledged: true
  };
  assert.throws(() => validateHandoffBody({ ...body, callOfferAcknowledged: false }, policy));
  assert.throws(() => validateHandoffBody({ ...body, callOfferVersion: 'another-offer' }, policy));
  const handoff = validateHandoffBody(body, policy);
  const request = () => requestAdviserHandoff({ env, config, sessionRow: row, profile, handoff, createPipelineHandoff: (packet) => createConsumerPipelineHandoff(advisor.env, packet) });
  await assert.rejects(request(), (error) => error.code === 'current_analysis_required');
  assert.equal(advisor.sql.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 0);

  const run = await createAnalysisRun(env, row, profile, ['house_purchase']);
  await completeAnalysisRun(env, run, row.id, { results: [{ moduleId: 'house_purchase', outputs: { privateFixtureFigure: 987654321 } }] }, ['house_purchase']);
  row = await getSessionRow(env, credential.id);
  const delivered = await request();
  assert.equal(delivered.handoff.status, 'linked');
  assert.equal(delivered.handoff.callOfferVersion, EDUCATION_CALL.version);
  const savedPackage = await readHandoffPackage(env, await getHandoff(env, row.id));
  assert.equal(savedPackage.callOfferVersion, EDUCATION_CALL.version);
  assert.ok(savedPackage.consent.sharedDataDigestB64u);
  await request();
  assert.equal(advisor.sql.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 1, 'Retry must not duplicate the call request');
  const lead = advisor.sql.prepare('SELECT * FROM leads').get();
  assert.equal(lead.source, EDUCATION_CALL.leadSource);
  assert.equal(lead.consent_free_call, 0);
  assert.equal(lead.consent_recording, 0);
  assert.ok(lead.client_id, 'The request must appear in the existing client pipeline');
  assert.equal(educationCallDuration({ source: lead.source }), 40);
  assert.equal(educationCallDuration({ source: 'landing-page' }), 30);
  assert.match(educationCallScheduleIntroduction({ source: lead.source }), /€100.*40 minutes/);
  assert.doesNotMatch(JSON.stringify(advisor.sql.prepare('SELECT * FROM lead_events').all()), /987654321/, 'Calculated figures must not be copied to the scheduling queue');

  const auth = await advisor.login();
  const route = `/api/advisor/leads/${lead.id}/send-schedule-email`;
  const schedule = { scheduledStartAt: '2030-04-16T09:00:00.000Z', scheduledEndAt: '2030-04-16T09:40:00.000Z', scheduledTimezone: 'Europe/Dublin' };
  const wrongDuration = await advisor.call(route, { ...schedule, scheduledEndAt: '2030-04-16T09:30:00.000Z' }, { headers: auth });
  assert.equal(wrongDuration.status, 400);
  assert.equal(meetings.length, 0);
  const scheduled = await advisor.call(route, schedule, { headers: auth });
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.json));
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].duration, 40);
  assert.equal(meetings[0].settings.auto_recording, 'none');
  assert.doesNotMatch(meetings[0].agenda, /Free/);
  const clientEmail = emails.find((email) => email.to.includes('call-test@example.com'));
  assert.match(clientEmail.text, /€100.*40 minutes/);
  assert.doesNotMatch(clientEmail.text, /free education call/);
  const invite = Buffer.from(clientEmail.attachments[0].content, 'base64').toString('utf8');
  assert.match(invite, /DTSTART:20300416T090000Z/);
  assert.match(invite, /DTEND:20300416T094000Z/);
  assert.match(invite, /https:\/\/zoom.us\/j\/123456789/);
  assert.equal((await advisor.call(route, schedule, { headers: auth })).status, 200);
  assert.equal(meetings.length, 1, 'Resending the same proposed time must reuse its Zoom meeting');
  const savedLead = advisor.sql.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
  assert.ok(savedLead.schedule_response_token);
  await advisor.call(`/api/leads/schedule-response?lead=${lead.id}&token=${savedLead.schedule_response_token}&response=accept`);
  assert.equal(advisor.sql.prepare('SELECT schedule_response_status FROM leads WHERE id = ?').get(lead.id).schedule_response_status, 'accepted');
  console.log('Education call: post-analysis consent, pipeline delivery, private 40-minute Zoom invitation, accept link and retry checks passed.');
} finally { globalThis.fetch = originalFetch; advisor.close(); consumer.close(); }
