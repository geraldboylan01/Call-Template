import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestRuntime, captureEmail, writtenApplication, wavFixture, voicePayload, uploadOptions } from './lib/application-test-runtime.mjs';
import { VOICE_CONSENT_TEXT, VOICE_CONSENT_VERSION } from '../js/case_application/voice_contract.js';
import { toPublicCase } from '../js/case_application/index.js';

const mail = captureEmail();
let checks = 0;
async function check(label, fn) { const runtime = createTestRuntime(); try { await fn(runtime); console.log(`ok - ${label}`); checks++; } finally { runtime.close(); } }
async function submitted(r) {
  const body = writtenApplication(); const result = await r.call('/api/applications', body);
  assert.equal(result.status, 201, JSON.stringify(result.json));
  const lead = r.sql.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
  return { body, token: result.json.voiceAccess.token, leadId: lead.id };
}
async function ready(r, token) {
  const bytes = wavFixture(); const payload = voicePayload(token, bytes);
  assert.equal((await r.call('/api/applications/voice-note/prepare', payload)).status, 200);
  assert.equal((await r.call('/api/applications/voice-note/upload', bytes, uploadOptions(payload))).status, 200);
  return payload;
}
try {
  await check('text-only submission remains valid; retries do not duplicate leads or email', async r => {
    const before = mail.emails.length;
    const { body, token } = await submitted(r);
    const again = await r.call('/api/applications', body);
    assert.equal(again.status, 200); assert.equal(again.json.voiceAccess.token, token);
    assert.equal(r.sql.prepare('SELECT COUNT(*) n FROM leads').get().n, 1);
    assert.equal(mail.emails.length - before, 2);
    assert.equal((await r.call('/api/applications', { ...body, application: { question: 'Different question' } })).status, 409);
    const grant = r.sql.prepare('SELECT * FROM application_audio_access').get();
    assert.notEqual(grant.token_hash, token); assert.equal(JSON.stringify(grant).includes(token), false);
    const receipt = mail.emails.at(-1); assert.match(receipt.text, /#voice=/);
    const publicCase = JSON.stringify(toPublicCase(body.application));
    assert.ok(!publicCase.includes('More time with family') && !publicCase.includes('Running out of savings'));
  });
  await check('every voice path rejects missing, false, string, and stale publication consent', async r => {
    const body = writtenApplication();
    assert.equal((await r.call('/api/applications', { ...body, voiceNote: { consentPublication: false } })).status, 400);
    assert.equal(r.sql.prepare('SELECT COUNT(*) n FROM leads').get().n, 0);
    const { token } = await submitted(r);
    for (const consent of [undefined, false, 'true', 1]) {
      assert.equal((await r.call('/api/applications/voice-note/prepare', { ...voicePayload(token), consentPublication: consent })).status, 400);
    }
    assert.equal((await r.call('/api/applications/voice-note/prepare', { ...voicePayload(token), consentVersion: 'old-version' })).status, 400);
    assert.equal(r.sql.prepare('SELECT COUNT(*) n FROM application_voice_notes').get().n, 0);
    const payload = voicePayload(token); await r.call('/api/applications/voice-note/prepare', payload);
    const options = uploadOptions(payload); delete options.headers['X-Voice-Publication-Consent'];
    assert.equal((await r.call('/api/applications/voice-note/upload', wavFixture(), options)).status, 400);
    assert.equal(r.bucket.writes, 0);
  });
  await check('recording, consent evidence, private playback, filter and replacement stay linked', async r => {
    const { token, leadId } = await submitted(r); const first = await ready(r, token); const auth = await r.login();
    const row = r.sql.prepare('SELECT * FROM application_voice_notes').get();
    assert.equal(row.consent_text, VOICE_CONSENT_TEXT); assert.equal(row.consent_version, VOICE_CONSENT_VERSION); assert.ok(row.consent_at);
    const detail = await r.call(`/api/advisor/leads/${leadId}/application`, undefined, { headers: auth });
    assert.equal(detail.json.voiceNote.id, first.uploadId);
    assert.ok(!JSON.stringify(detail.json).includes('object_key'));
    const download = await r.call(`/api/advisor/leads/${leadId}/voice-note`, undefined, { headers: auth });
    assert.equal(download.status, 200); assert.match(download.response.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await download.response.arrayBuffer()), wavFixture());
    const list = await r.call('/api/advisor/clients?voice=yes', undefined, { headers: auth });
    assert.equal(list.json.clients.length, 1); assert.equal(list.json.clients[0].hasVoiceNote, true);
    // Lost success response: same prepared ID/file returns ready, no second PUT.
    assert.equal((await r.call('/api/applications/voice-note/prepare', first)).json.ready, true);
    assert.equal(r.bucket.writes, 1);
    const second = await ready(r, token);
    assert.equal(r.sql.prepare("SELECT id FROM application_voice_notes WHERE state='ready'").get().id, second.uploadId);
    assert.equal(r.sql.prepare('SELECT state FROM application_voice_notes WHERE id=?').get(first.uploadId).state, 'deleting');
  });
  await check('anonymous reads, wrong capability, wrong origin and CSRF-free deletes fail', async r => {
    const { token, leadId } = await submitted(r); await ready(r, token);
    assert.equal((await r.call(`/api/advisor/leads/${leadId}/voice-note`)).status, 401);
    r.env.ADVISOR_SESSION_SECRET = '';
    assert.equal((await r.call(`/api/advisor/leads/${leadId}/voice-note`)).status, 401);
    r.env.ADVISOR_SESSION_SECRET = randomBytes(32).toString('base64url');
    assert.equal((await r.call('/api/applications/voice-note/prepare', voicePayload(randomBytes(32).toString('base64url')))).status, 404);
    assert.equal((await r.call('/api/applications/voice-note/prepare', voicePayload(token), { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    const auth = await r.login(); delete auth['X-Advisor-CSRF'];
    assert.equal((await r.call(`/api/advisor/leads/${leadId}/voice-note`, undefined, { method: 'DELETE', headers: auth })).status, 403);
  });
  await check('tampered bytes, unsupported types and streamed oversize bodies never reach R2', async r => {
    const { token } = await submitted(r);
    assert.equal((await r.call('/api/applications/voice-note/prepare', { ...voicePayload(token), bytes: 10485761 })).status, 400);
    assert.equal((await r.call('/api/applications/voice-note/prepare', { ...voicePayload(token), durationMs: 120001 })).status, 400);
    assert.equal((await r.call('/api/applications/voice-note/prepare', { ...voicePayload(token), contentType: 'text/html' })).status, 400);
    const bytes = Buffer.alloc(100, 60); const fake = voicePayload(token, bytes);
    await r.call('/api/applications/voice-note/prepare', fake);
    assert.equal((await r.call('/api/applications/voice-note/upload', bytes, uploadOptions(fake))).status, 400);
    await r.call('/api/applications/voice-note/discard', { token, uploadId: fake.uploadId });
    const payload = voicePayload(token); await r.call('/api/applications/voice-note/prepare', payload);
    const changed = Buffer.from(wavFixture()); changed[50] ^= 1;
    assert.equal((await r.call('/api/applications/voice-note/upload', changed, uploadOptions(payload))).status, 400);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(payload.bytes)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
    assert.equal((await r.call('/api/applications/voice-note/upload', stream, uploadOptions(payload))).status, 413);
    assert.equal(r.bucket.writes, 0);
  });
  await check('quota reservations include pending uploads and protect concurrent submissions', async r => {
    const one = await submitted(r); const two = await submitted(r);
    r.env.APPLICATION_AUDIO_QUOTA_BYTES = String(wavFixture().length);
    const result = await Promise.all([one, two].map(item => r.call('/api/applications/voice-note/prepare', voicePayload(item.token))));
    assert.deepEqual(result.map(item => item.status).sort(), [200, 409]);
    assert.equal(r.sql.prepare('SELECT SUM(bytes) n FROM application_voice_notes').get().n, wavFixture().length);
    assert.equal(r.sql.prepare('SELECT COUNT(*) n FROM leads').get().n, 2);
  });
  await check('uncertain storage failures retain the written case and can be retried', async r => {
    const { token } = await submitted(r); const payload = voicePayload(token);
    await r.call('/api/applications/voice-note/prepare', payload); r.bucket.failPut = true;
    assert.equal((await r.call('/api/applications/voice-note/upload', wavFixture(), uploadOptions(payload))).status, 503);
    assert.equal(r.sql.prepare("SELECT COUNT(*) n FROM application_voice_notes WHERE state='ready'").get().n, 0);
    assert.equal(r.sql.prepare('SELECT COUNT(*) n FROM leads').get().n, 1);
    assert.equal((await r.call('/api/applications/voice-note/prepare', payload)).json.retryNew, true);
    r.bucket.failPut = false; await ready(r, token);
    await r.cron(); assert.equal(r.objects.size, 1);
  });
  await check('delete racing an upload cannot resurrect a recording; failed erasure retries', async r => {
    const { token, leadId } = await submitted(r); const auth = await r.login();
    const payload = voicePayload(token); await r.call('/api/applications/voice-note/prepare', payload);
    r.bucket.failDelete = true;
    r.bucket.duringPut = async () => {
      const result = await r.call(`/api/advisor/leads/${leadId}/application`, undefined, { method: 'DELETE', headers: auth });
      assert.equal(result.json.audioDeletionPending, true);
    };
    assert.equal((await r.call('/api/applications/voice-note/upload', wavFixture(), uploadOptions(payload))).status, 409);
    assert.equal((await r.call(`/api/advisor/leads/${leadId}/voice-note`, undefined, { headers: auth })).status, 404);
    assert.equal((await r.call('/api/applications/voice-note/access', { token })).status, 404);
    r.bucket.failDelete = false; r.bucket.duringPut = null;
    await r.cron(); assert.equal(r.objects.size, 0);
  });
  await check('expiry removes unselected recordings and stale uploads but keeps selected cases', async r => {
    const first = await submitted(r); await ready(r, first.token);
    const second = await submitted(r); await ready(r, second.token);
    const third = await submitted(r); const pending = voicePayload(third.token); await r.call('/api/applications/voice-note/prepare', pending);
    const old = new Date(Date.now() - 366 * 86400000).toISOString();
    r.sql.prepare('UPDATE leads SET created_at=? WHERE id IN (?,?)').run(old, first.leadId, second.leadId);
    r.sql.prepare("UPDATE leads SET status='picked' WHERE id=?").run(second.leadId);
    r.sql.prepare('UPDATE application_voice_notes SET expires_at=? WHERE id=?').run(old, pending.uploadId);
    await r.cron();
    assert.equal(r.objects.size, 1);
    assert.equal(r.sql.prepare("SELECT lead_id FROM application_voice_notes WHERE state='ready'").get().lead_id, second.leadId);
    assert.equal(r.sql.prepare('SELECT state FROM application_voice_notes WHERE id=?').get(pending.uploadId).state, 'deleting');
  });
  await check('assistant confirmation offers recording to the person; no agent permission is inherited', async r => {
    const application = writtenApplication();
    const result = await r.call('/api/agent/applications', { person: { name: application.fullName, email: application.email }, application: application.application, consent: { videoPublication: true, educationOnly: true } });
    assert.equal(result.status, 202); assert.equal(result.json.voiceAccess, undefined);
    const token = /#t=([A-Za-z0-9_-]{43})/.exec(mail.emails.at(-1).text)[1];
    const confirmed = await r.call('/api/agent/applications/confirm', { token });
    assert.equal(confirmed.status, 200); assert.ok(confirmed.json.voiceAccess.token);
    assert.equal(r.sql.prepare('SELECT COUNT(*) n FROM application_voice_notes').get().n, 0);
  });
  await check('disabled audio still permits written applications and exposes no upload capability', async r => {
    r.env.APPLICATION_AUDIO_ENABLED = 'false';
    const result = await r.call('/api/applications', writtenApplication()); assert.equal(result.status, 201); assert.equal(result.json.voiceAccess, undefined);
    assert.equal((await r.call('/api/applications/voice-note/config')).json.enabled, false);
    assert.equal((await r.call('/api/applications/voice-note/prepare', {})).status, 503);
  });
  console.log(`\n${checks} voice-note integration checks passed.`);
} finally { mail.restore(); }
