// Production proof using synthetic audio and a temporary database record.
// No public application is submitted and no email is sent. Credentials stay in
// process memory; all test records and objects are removed in finally.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { VOICE_CONSENT_VERSION, VOICE_MAX_BYTES } from '../js/case_application/voice_contract.js';

const base = process.env.WORKER_BASE_URL || 'https://api.planeir.ie';
const origin = process.env.SMOKE_ORIGIN || 'https://planeir.ie';
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const password = process.env.ADVISOR_SMOKE_PASSWORD;
const config = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8');
const database = /binding\s*=\s*"LEADS_DB"[\s\S]*?database_id\s*=\s*"([a-f0-9-]+)"/.exec(config)?.[1];
const hash = bytes => createHash('sha256').update(bytes).digest('base64url');

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  return fetch(`${base}${path}`, { method, body, headers: { Origin: origin, ...headers }, signal: AbortSignal.timeout(60_000) });
}
async function json(path, body, headers = {}) {
  const response = await request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
  return { status: response.status, data: await response.json() };
}
async function query(sql, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(30_000)
  });
  const data = await response.json();
  assert(response.ok && data.success, `Synthetic voice-check database operation failed (${response.status}).`);
  return data.result;
}
function audioFixture() {
  const bytes = Buffer.alloc(VOICE_MAX_BYTES);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(44_100, 24); bytes.writeUInt32LE(88_200, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let offset = 44; offset < bytes.length; offset += 2) bytes.writeInt16LE(Math.round(1600 * Math.sin((offset - 44) / 2 * 2 * Math.PI * 440 / 44_100)), offset);
  return bytes;
}

const availability = await (await request('/api/applications/voice-note/config')).json();
if (!availability.enabled) {
  assert(!/^APPLICATION_AUDIO_ENABLED\s*=\s*"true"/m.test(config), 'Voice uploads should be enabled but production reports them unavailable.');
  console.log('[ApplicationVoiceLive] Uploads intentionally disabled.');
  process.exit(0);
}
assert(account && apiToken && password && database, 'Live verification requires existing deployment and advisor smoke credentials.');
assert.equal(availability.consentVersion, VOICE_CONSENT_VERSION);
const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }), headers: { 'Content-Type': 'application/json' } });
assert.equal(login.status, 200, 'Advisor smoke login failed.');
const session = await login.json();
assert.equal(session.authenticated, true);
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert(cookie && session.csrfToken, 'Authenticated cookie and CSRF token are required.');

const applicationId = `app_voice_smoke_${randomUUID()}`;
const uploadToken = randomBytes(32).toString('base64url');
let leadId;
try {
  const stamp = new Date().toISOString();
  const rows = await query(`INSERT INTO leads (created_at, full_name, email, help_reason, source, application_id)
    VALUES (?, 'Voice-note deployment check', 'voice-note-check@example.invalid', 'Synthetic deployment check; no applicant.', 'case-application', ?) RETURNING id`, [stamp, applicationId]);
  leadId = rows[0].results[0].id;
  await query('INSERT INTO application_audio_access (lead_id, token_hash, expires_at) VALUES (?, ?, ?)', [String(leadId), hash(uploadToken), new Date(Date.now() + 15 * 60_000).toISOString()]);
  const bytes = audioFixture();
  const payload = { token: uploadToken, uploadId: randomUUID(), sha256: hash(bytes), bytes: bytes.length, contentType: 'audio/wav', durationMs: Math.ceil((bytes.length - 44) / 88_200 * 1000), consentVersion: VOICE_CONSENT_VERSION };
  const endpoint = `/api/advisor/leads/${leadId}/voice-note`;
  assert.equal((await json('/api/applications/voice-note/prepare', { ...payload, consentPublication: false })).status, 400, 'Unchecked consent must fail.');
  assert.equal((await json('/api/applications/voice-note/prepare', { ...payload, consentPublication: true })).status, 200);
  const uploadHeaders = { 'Content-Type': payload.contentType, 'X-Application-Audio-Token': uploadToken, 'X-Voice-Request-Id': payload.uploadId };
  assert.equal((await request('/api/applications/voice-note/upload', { method: 'PUT', headers: uploadHeaders, body: bytes.subarray(0, 44) })).status, 400, 'The byte endpoint must also require consent.');
  const uploaded = await request('/api/applications/voice-note/upload', { method: 'PUT', headers: { ...uploadHeaders, 'X-Voice-Publication-Consent': VOICE_CONSENT_VERSION }, body: bytes });
  assert.equal(uploaded.status, 200, 'Maximum-size synthetic audio upload failed.');
  assert.equal((await uploaded.json()).ready, true);
  assert.equal((await request(endpoint)).status, 401, 'Anonymous audio access must fail.');
  const download = await request(endpoint, { headers: { Cookie: cookie } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('Cache-Control'), /no-store/);
  assert.equal(hash(Buffer.from(await download.arrayBuffer())), payload.sha256, 'Private download must match the approved recording.');
  const evidence = await query('SELECT consent_version, consent_text, consent_at FROM application_voice_notes WHERE id = ?', [payload.uploadId]);
  assert.equal(evidence[0].results[0].consent_version, VOICE_CONSENT_VERSION);
  assert(evidence[0].results[0].consent_at && evidence[0].results[0].consent_text.includes('YouTube'));
  assert.equal((await request(endpoint, { method: 'DELETE', headers: { Cookie: cookie } })).status, 403, 'Deletion must require CSRF protection.');
  console.log('[ApplicationVoiceLive] Required consent, maximum-size upload, private download, consent evidence and CSRF passed.');
} finally {
  if (leadId) {
    const deletion = await request(`/api/advisor/leads/${leadId}/voice-note`, { method: 'DELETE', headers: { Cookie: cookie, 'X-Advisor-CSRF': session.csrfToken } });
    assert.equal(deletion.status, 200, `Synthetic recording cleanup failed for ${applicationId}.`);
    assert.equal((await deletion.json()).deletionPending, false, `Synthetic storage cleanup remains pending for ${applicationId}.`);
    assert.equal((await json('/api/applications/voice-note/access', { token: uploadToken })).status, 404);
    await query('DELETE FROM application_voice_notes WHERE lead_id = ?', [String(leadId)]);
    await query('DELETE FROM application_audio_access WHERE lead_id = ?', [String(leadId)]);
    await query('DELETE FROM leads WHERE id = ? AND application_id = ?', [String(leadId), applicationId]);
    console.log('[ApplicationVoiceLive] Test audio and database records removed; upload link revoked. No email sent.');
  }
}
