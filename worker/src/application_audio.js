import {
  VOICE_CONSENT_VERSION, VOICE_CONSENT_TEXT, VOICE_MAX_BYTES,
  VOICE_MAX_DURATION_MS, VOICE_TYPES, hasVoicePublicationConsent
} from '../../js/case_application/voice_contract.js';
import { sha256Base64Url } from './consumer/crypto.js';

const DAY = 86_400_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[a-f0-9-]{36}$/;
const now = () => new Date().toISOString();
const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
const changed = (result) => Number(result.meta?.changes || 0) === 1;

function audioEnabled(env) {
  return String(env.APPLICATION_AUDIO_ENABLED) === 'true'
    && Boolean(env.APPLICATION_AUDIO_BUCKET && env.LEADS_DB && env.APPLICATION_DATA_ENCRYPTION_KEY);
}

function audioConfig(env) {
  return { enabled: audioEnabled(env), maxBytes: VOICE_MAX_BYTES, maxDurationMs: VOICE_MAX_DURATION_MS,
    consentVersion: VOICE_CONSENT_VERSION, consentText: VOICE_CONSENT_TEXT };
}

// Reproducible only on the server, so submission retries and the existing
// receipt email carry the same capability. Only its hash is stored in D1.
export async function ensureAudioAccess(env, leadId) {
  if (!audioEnabled(env)) return null;
  const lead = await env.LEADS_DB.prepare('SELECT application_id, created_at, application_deleted_at FROM leads WHERE id = ?').bind(leadId).first();
  if (!lead?.application_id || lead.application_deleted_at) return null;
  const expiresAt = new Date(Date.parse(lead.created_at) + 7 * DAY).toISOString();
  if (expiresAt <= now()) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.APPLICATION_DATA_ENCRYPTION_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`application-audio-v1/${lead.application_id}/${expiresAt}`)));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hash = await sha256Base64Url(token);
  await env.LEADS_DB.prepare('INSERT OR IGNORE INTO application_audio_access (lead_id, token_hash, expires_at) VALUES (?, ?, ?)').bind(leadId, hash, expiresAt).run();
  const grant = await env.LEADS_DB.prepare('SELECT token_hash, revoked_at FROM application_audio_access WHERE lead_id = ?').bind(leadId).first();
  if (grant.revoked_at || grant.token_hash !== hash) return null;
  return { token, expiresAt };
}

export async function voiceMetadata(env, leadId) {
  const row = await env.LEADS_DB.prepare("SELECT v.id, v.bytes, v.duration_ms, v.content_type, v.extension, v.consent_version, v.consent_text, v.consent_at, v.uploaded_at FROM application_voice_notes v JOIN leads l ON l.id = v.lead_id WHERE v.lead_id = ? AND v.state = 'ready' AND l.application_deleted_at IS NULL ORDER BY v.uploaded_at DESC LIMIT 1").bind(leadId).first();
  return row ? { id: row.id, bytes: row.bytes, durationMs: row.duration_ms, contentType: row.content_type,
    extension: row.extension, consentVersion: row.consent_version, consentText: row.consent_text,
    consentAt: row.consent_at, uploadedAt: row.uploaded_at } : null;
}

async function access(env, token) {
  if (!TOKEN_PATTERN.test(token || '')) fail(404, 'This voice-note link is invalid or expired.');
  const row = await env.LEADS_DB.prepare(`SELECT a.* FROM application_audio_access a JOIN leads l ON l.id = a.lead_id
    WHERE a.token_hash = ? AND a.revoked_at IS NULL AND a.expires_at > ? AND l.application_deleted_at IS NULL`).bind(await sha256Base64Url(token), now()).first();
  if (!row) fail(404, 'This voice-note link is invalid or expired.');
  return row;
}

async function readAudioBounded(request, limit) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) fail(413, 'The file is too large. The limit is 10 MiB.');
  if (!request.body) fail(400, 'No file was received.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail(413, 'The file is too large. The limit is 10 MiB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function readJson(request) {
  try { return JSON.parse(new TextDecoder().decode(await readAudioBounded(request, 4096))); }
  catch (error) { if (error.status) throw error; fail(400, 'Invalid request.'); }
}

function matchesAudioSignature(bytes, type) {
  const text = (start, length) => new TextDecoder().decode(bytes.subarray(start, start + length));
  if (bytes.length < 12) return false;
  if (type === 'audio/wav' || type === 'audio/x-wav') return text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE';
  if (type === 'audio/mp4' || type === 'audio/x-m4a') return text(4, 4) === 'ftyp';
  if (type === 'audio/ogg') return text(0, 4) === 'OggS';
  if (type === 'audio/webm') return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if (type === 'audio/mpeg') return text(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0);
  return false;
}

async function prepare(env, body) {
  const grant = await access(env, body.token);
  // Reject before reserving storage or accepting bytes. No private-only path.
  if (!hasVoicePublicationConsent(body)) fail(400, 'Tick the voice-recording permission box, or remove the recording to continue without it.');
  const type = String(body.contentType || '').split(';')[0].toLowerCase();
  if (!ID_PATTERN.test(body.uploadId || '') || !TOKEN_PATTERN.test(body.sha256 || '')
    || !VOICE_TYPES[type] || !Number.isInteger(body.bytes) || body.bytes <= 0 || body.bytes > VOICE_MAX_BYTES
    || !Number.isInteger(body.durationMs) || body.durationMs <= 0 || body.durationMs > VOICE_MAX_DURATION_MS) {
    fail(400, 'Choose a supported audio file of up to two minutes and 10 MiB.');
  }
  const prior = await env.LEADS_DB.prepare('SELECT * FROM application_voice_notes WHERE id = ? AND lead_id = ?').bind(body.uploadId, grant.lead_id).first();
  if (prior) {
    if (prior.sha256 !== body.sha256 || prior.bytes !== body.bytes || prior.content_type !== type || prior.duration_ms !== body.durationMs) fail(409, 'This recording has changed. Choose it again and give permission for the new recording.');
    if (prior.state === 'ready') return { ok: true, ready: true, uploadId: prior.id };
    if (prior.state === 'pending' && prior.expires_at > now()) return { ok: true, uploadId: prior.id };
    fail(409, 'The previous upload is busy or expired. Retry with a new upload.', { retryNew: true });
  }
  await env.LEADS_DB.prepare("UPDATE application_voice_notes SET state = 'deleting', deleted_at = ? WHERE lead_id = ? AND state IN ('pending','uploading') AND expires_at <= ?").bind(now(), grant.lead_id, now()).run();
  const pending = await env.LEADS_DB.prepare("SELECT id FROM application_voice_notes WHERE lead_id = ? AND state IN ('pending','uploading')").bind(grant.lead_id).first();
  if (pending) fail(409, 'Another recording is uploading. Please try again in a few minutes.');
  const attempt = await env.LEADS_DB.prepare('UPDATE application_audio_access SET attempts = attempts + 1 WHERE lead_id = ? AND attempts < 10 AND revoked_at IS NULL AND expires_at > ?').bind(grant.lead_id, now()).run();
  if (!changed(attempt)) fail(429, 'This link has reached its upload limit. Your written application is saved.');
  const createdAt = now();
  const quota = Math.min(5_000_000_000, Math.max(0, Number(env.APPLICATION_AUDIO_QUOTA_BYTES ?? 1_000_000_000) || 0));
  // One SQL statement reserves capacity including in-flight and deletion-pending
  // files. D1 serialises writes; concurrent requests cannot overbook the quota.
  const result = await env.LEADS_DB.prepare(`INSERT OR IGNORE INTO application_voice_notes
    (id, lead_id, object_key, state, bytes, sha256, content_type, extension, duration_ms, consent_version, consent_text, consent_at, created_at, expires_at)
    SELECT ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE COALESCE((SELECT SUM(bytes) FROM application_voice_notes), 0) + ? <= ?
      AND EXISTS (SELECT 1 FROM application_audio_access WHERE lead_id = ? AND revoked_at IS NULL AND expires_at > ?)
      AND EXISTS (SELECT 1 FROM leads WHERE id = ? AND application_deleted_at IS NULL)`).bind(
    body.uploadId, grant.lead_id, `voice/${grant.lead_id}/${body.uploadId}`, body.bytes, body.sha256,
    type, VOICE_TYPES[type], body.durationMs, VOICE_CONSENT_VERSION, VOICE_CONSENT_TEXT,
    createdAt, createdAt, new Date(Date.now() + 15 * 60_000).toISOString(), body.bytes, quota, grant.lead_id, createdAt, grant.lead_id
  ).run();
  if (!changed(result)) fail(409, 'Voice-note storage is full or another upload has started. Your written application is saved.');
  return { ok: true, uploadId: body.uploadId };
}

async function upload(request, env) {
  const token = request.headers.get('X-Application-Audio-Token');
  const grant = await access(env, token);
  const id = request.headers.get('X-Voice-Request-Id');
  // Repeat the explicit permission check on the byte endpoint too.
  if (request.headers.get('X-Voice-Publication-Consent') !== VOICE_CONSENT_VERSION) fail(400, 'Voice-recording publication permission is required.');
  const row = await env.LEADS_DB.prepare('SELECT * FROM application_voice_notes WHERE id = ? AND lead_id = ?').bind(id, grant.lead_id).first();
  if (!row || row.consent_version !== VOICE_CONSENT_VERSION) fail(404, 'Prepare the recording before uploading it.');
  if (row.state === 'ready') return { ok: true, ready: true };
  if (row.state !== 'pending' || row.expires_at <= now()) fail(409, 'This upload is busy or expired. Try again.');
  const bytes = await readAudioBounded(request, Math.min(row.bytes, VOICE_MAX_BYTES));
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const digest = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (bytes.length !== row.bytes || digest !== row.sha256 || contentType !== row.content_type || !matchesAudioSignature(bytes, contentType)) fail(400, 'The audio file did not match the recording you approved. Choose the file again.');
  // Recheck after reading a potentially slow body, before any object write.
  await access(env, token);
  const claimed = await env.LEADS_DB.prepare("UPDATE application_voice_notes SET state = 'uploading' WHERE id = ? AND state = 'pending' AND expires_at > ?").bind(id, now()).run();
  if (!changed(claimed)) fail(409, 'This upload is busy or expired. Try again.');
  try {
    await env.APPLICATION_AUDIO_BUCKET.put(row.object_key, bytes, { httpMetadata: { contentType } });
    // Publish the new recording and retire its predecessor atomically. A delete
    // racing the upload changes its state, so it cannot come back into view.
    await env.LEADS_DB.batch([
      env.LEADS_DB.prepare(`UPDATE application_voice_notes SET state = 'ready', uploaded_at = ?
        WHERE id = ? AND state = 'uploading'
          AND EXISTS (SELECT 1 FROM application_audio_access WHERE lead_id = ? AND revoked_at IS NULL)
          AND EXISTS (SELECT 1 FROM leads WHERE id = ? AND application_deleted_at IS NULL)`).bind(now(), id, grant.lead_id, grant.lead_id),
      env.LEADS_DB.prepare(`UPDATE application_voice_notes SET state = 'deleting', deleted_at = ?
        WHERE lead_id = ? AND id != ? AND state = 'ready'
          AND EXISTS (SELECT 1 FROM application_voice_notes WHERE id = ? AND state = 'ready')`).bind(now(), grant.lead_id, id, id)
    ]);
    const saved = await env.LEADS_DB.prepare('SELECT state FROM application_voice_notes WHERE id = ?').bind(id).first();
    if (saved?.state !== 'ready') fail(409, 'The recording was withdrawn during upload.');
    return { ok: true, ready: true };
  } catch (error) {
    await env.LEADS_DB.prepare("UPDATE application_voice_notes SET state = 'deleting', deleted_at = COALESCE(deleted_at, ?) WHERE id = ? AND state != 'ready'").bind(now(), id).run();
    throw error;
  }
}

export async function handlePublicAudio(request, env, pathname, respond) {
  try {
    if (pathname.endsWith('/config') && request.method === 'GET') return respond(audioConfig(env), 200);
    if (!audioEnabled(env) && !pathname.endsWith('/discard')) fail(503, 'Voice notes are unavailable right now. You can still send a written application.');
    if (pathname.endsWith('/access') && request.method === 'POST') {
      const grant = await access(env, (await readJson(request)).token);
      const ready = await voiceMetadata(env, grant.lead_id);
      return respond({ ok: true, expiresAt: grant.expires_at, hasVoiceNote: Boolean(ready) }, 200);
    }
    if (pathname.endsWith('/prepare') && request.method === 'POST') return respond(await prepare(env, await readJson(request)), 200);
    if (pathname.endsWith('/discard') && request.method === 'POST') {
      const body = await readJson(request);
      const grant = await access(env, body.token);
      await env.LEADS_DB.prepare("UPDATE application_voice_notes SET state = 'deleting', deleted_at = COALESCE(deleted_at, ?) WHERE id = ? AND lead_id = ?")
        .bind(now(), body.uploadId, grant.lead_id).run();
      return respond({ ok: true }, 200);
    }
    if (pathname.endsWith('/upload') && request.method === 'PUT') return respond(await upload(request, env), 200);
    return respond({ error: 'Method not allowed.' }, 405);
  } catch (error) {
    return respond({ error: error.status ? error.message : 'The voice note could not be uploaded. Your written application is saved. Please retry.', retryNew: error.retryNew === true }, error.status || 503);
  }
}

export async function deleteVoiceNotes(env, leadId) {
  await env.LEADS_DB.batch([
    env.LEADS_DB.prepare('UPDATE application_audio_access SET revoked_at = ? WHERE lead_id = ?').bind(now(), leadId),
    env.LEADS_DB.prepare("UPDATE application_voice_notes SET state = 'deleting', deleted_at = COALESCE(deleted_at, ?) WHERE lead_id = ?").bind(now(), leadId)
  ]);
  // Access is already revoked. Retain tombstones for 24 hours so a slow in-flight
  // PUT is deleted again by the cron, rather than leaving an orphan.
  const rows = await env.LEADS_DB.prepare("SELECT object_key FROM application_voice_notes WHERE lead_id = ? AND state = 'deleting'").bind(leadId).all();
  let pending = false;
  for (const row of rows.results || []) {
    try { if (!env.APPLICATION_AUDIO_BUCKET) throw new Error('No bucket'); await env.APPLICATION_AUDIO_BUCKET.delete(row.object_key); }
    catch { pending = true; }
  }
  return { ok: true, deletionPending: pending };
}

export async function cleanupVoiceNotes(env) {
  if (!env.LEADS_DB) return;
  const stamp = now();
  const cutoff = new Date(Date.now() - 365 * DAY).toISOString();
  await env.LEADS_DB.prepare(`UPDATE application_audio_access SET revoked_at = COALESCE(revoked_at, ?)
    WHERE lead_id IN (SELECT id FROM leads WHERE application_deleted_at IS NOT NULL OR (created_at < ? AND status NOT IN ('picked','video-live')))`)
    .bind(stamp, cutoff).run();
  await env.LEADS_DB.prepare(`UPDATE application_voice_notes SET state = 'deleting', deleted_at = COALESCE(deleted_at, ?)
    WHERE (state IN ('pending','uploading') AND expires_at <= ?)
      OR lead_id IN (SELECT lead_id FROM application_audio_access WHERE revoked_at IS NOT NULL)`)
    .bind(stamp, stamp).run();
  if (env.APPLICATION_AUDIO_BUCKET) {
    const rows = await env.LEADS_DB.prepare("SELECT id, object_key, deleted_at FROM application_voice_notes WHERE state = 'deleting' ORDER BY deleted_at LIMIT 100").all();
    for (const row of rows.results || []) {
      try {
        await env.APPLICATION_AUDIO_BUCKET.delete(row.object_key);
        if (Date.parse(row.deleted_at) < Date.now() - DAY) await env.LEADS_DB.prepare("DELETE FROM application_voice_notes WHERE id = ? AND state = 'deleting'").bind(row.id).run();
      } catch { /* Keep the row and its reserved bytes for the next hourly run. */ }
    }
  }
}
