import { encryptJson, decryptJson, randomId, toBase64Url, sha256Base64Url, hmacSha256Base64Url } from '../consumer/crypto.js';
import { validInviteSigningKey } from '../consumer/invite.js';
import { normalizeDemoPayload, DEMO_SAVED, DEMO_CONFIRMED } from '../../../js/workspace/demo_contract.js';

const COOKIE = 'planeir_demo_session';
const DAY = 86400000;
const nowIso = () => new Date().toISOString();
const secret = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const fail = (status, message, code = 'demo_error') => { throw Object.assign(new Error(message), { status, code }); };
const keyEnv = env => ({ CONSUMER_DATA_ENCRYPTION_KEY: env.DEMO_DATA_ENCRYPTION_KEY, CONSUMER_DATA_ENCRYPTION_KEY_ID: env.DEMO_DATA_ENCRYPTION_KEY_ID || 'demo-v1', CONSUMER_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: env.DEMO_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON });
const encrypt = (env, value, context) => encryptJson(keyEnv(env), value, `planeir/demo/${context}`);
const decrypt = (env, value, context) => decryptJson(keyEnv(env), value, `planeir/demo/${context}`);
const emailHash = (env, email, key = env.DEMO_DATA_ENCRYPTION_KEY) => hmacSha256Base64Url(key, `planeir/demo/email/${email}`);
function lookupKeys(env) {
  let previous = {};
  try { previous = JSON.parse(env.DEMO_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON || '{}'); } catch { /* Encryption helpers reject invalid keys when used. */ }
  return [...new Set([env.DEMO_DATA_ENCRYPTION_KEY, ...Object.values(previous || {}).slice(0, 3)])].filter(validInviteSigningKey);
}
const enabled = env => String(env.DEMO_REQUESTS_ENABLED) === 'true';
function intakeReady(env, dependencies) {
  const mail = dependencies.emailConfig();
  return enabled(env) && validInviteSigningKey(env.DEMO_DATA_ENCRYPTION_KEY)
    && Boolean(mail.apiKey && mail.from && dependencies.adminConfigured);
}

export function demoRouteMethods(path) {
  if (path === '/api/demo/config') return 'GET,OPTIONS';
  if (path === '/api/demo/session') return 'GET,DELETE,OPTIONS';
  if (['/api/demo/requests', '/api/demo/return-links', '/api/demo/access/redeem', '/api/demo/invitations/redeem'].includes(path)) return 'POST,OPTIONS';
  if (/^\/api\/demo\/requests\/dr_[A-Za-z0-9_-]{24}$/.test(path)) return 'GET,PATCH,DELETE,OPTIONS';
  if (/^\/api\/demo\/requests\/dr_[A-Za-z0-9_-]{24}\/confirm$/.test(path)) return 'POST,OPTIONS';
  if (path === '/api/advisor/demo/requests') return 'GET,OPTIONS';
  if (path === '/api/advisor/demo/invitations') return 'GET,POST,OPTIONS';
  if (/^\/api\/advisor\/demo\/invitations\/di_[A-Za-z0-9_-]{24}\/revoke$/.test(path)) return 'POST,OPTIONS';
  if (/^\/api\/advisor\/demo\/requests\/dr_[A-Za-z0-9_-]{24}$/.test(path)) return 'GET,DELETE,OPTIONS';
  if (/^\/api\/advisor\/demo\/requests\/dr_[A-Za-z0-9_-]{24}\/(approve|revoke|send-access-link)$/.test(path)) return 'POST,OPTIONS';
  return null;
}

function cookie(request, token, clear = false) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${clear ? '' : token}; Path=/api/demo; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 7 * 86400}${secure}`;
}
async function sessionFor(request, env) {
  const token = request.headers.get('Cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return env.LEADS_DB.prepare('SELECT * FROM demo_sessions WHERE token_hash = ? AND expires_at > ?').bind(await sha256Base64Url(token), nowIso()).first();
}
async function newSession(request, env, requestId = null, invitationId = null) {
  const token = secret(), hash = await sha256Base64Url(token), csrf = secret();
  return {
    token, hash, csrf, cookie: cookie(request, token),
    statement: env.LEADS_DB.prepare('INSERT INTO demo_sessions (token_hash,request_id,invitation_id,csrf_token,expires_at) VALUES (?,?,?,?,?)')
      .bind(hash, requestId, invitationId, csrf, new Date(Date.now() + 7 * DAY).toISOString())
  };
}
function checkCsrf(request, session) {
  if (!session || request.headers.get('X-Demo-CSRF') !== session.csrf_token) fail(403, 'Refresh your private form and try again.', 'demo_csrf');
}
async function owned(request, env, id, mutate) {
  const session = await sessionFor(request, env);
  if (!session || session.request_id !== id) fail(404, 'Use your private return link to open this form.', 'demo_access_required');
  if (mutate) checkCsrf(request, session);
  const row = await env.LEADS_DB.prepare('SELECT * FROM demo_requests WHERE id = ?').bind(id).first();
  if (!row) fail(404, 'This saved information is no longer available.');
  return { row, session };
}
async function representation(env, row) {
  return { id: row.id, revision: row.revision, confirmedRevision: row.confirmed_revision, confirmedAt: row.confirmed_at,
    accessStatus: row.access_status, createdAt: row.created_at, updatedAt: row.updated_at, generationAvailable: false,
    ...await decrypt(env, row.payload_encrypted, `request/${row.id}`) };
}
async function readBody(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) fail(415, 'Send a JSON request.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Missing request.');
  let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); fail(413, 'That form is too long to save.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { const body = JSON.parse(new TextDecoder().decode(bytes)); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; }
  catch { fail(400, 'Invalid request.'); }
}
function normalize(body) {
  try { return normalizeDemoPayload(body); } catch (error) { fail(400, error.message, 'demo_validation'); }
}
async function makeMail(env, requestId, kind, payload) {
  const id = randomId('de'), timestamp = nowIso();
  return env.LEADS_DB.prepare('INSERT INTO demo_email_outbox (id,request_id,kind,payload_encrypted,created_at,next_attempt_at) VALUES (?,?,?,?,?,?)')
    .bind(id, requestId, kind, await encrypt(env, payload, `email/${id}`), timestamp, timestamp);
}
async function accessMail(env, id, payload, status, kind = 'return') {
  const token = secret(), expires = new Date(Date.now() + DAY).toISOString();
  const url = `https://planeir.ie/demo/#access=${token}`;
  const approved = status === 'approved';
  const subject = approved ? 'Your Planéir demo access is ready' : 'Your Planéir demo request is saved';
  const text = [ `Hi ${payload.contact.fullName},`, approved ? 'Your demo access is available. Review your saved information and confirm it when you are ready.' : DEMO_SAVED,
    `Open your private form: ${url}`, 'This private link expires in 24 hours. You can request a fresh link at https://planeir.ie/demo/.',
    'Analysis generation is not connected yet. No analysis has started.', 'Your saved information remains until you delete it. You can delete it from your private form.',
    'Questions? hello@planeir.ie' ].join('\n\n');
  return [
    // Superseding pending emails also removes their encrypted bearer links.
    env.LEADS_DB.prepare("UPDATE demo_email_outbox SET status='cancelled',payload_encrypted=NULL WHERE request_id=? AND kind!='notification' AND status IN ('pending','failed')").bind(id),
    env.LEADS_DB.prepare('INSERT INTO demo_access_tokens (token_hash,request_id,expires_at) VALUES (?,?,?)').bind(await sha256Base64Url(token), id, expires),
    await makeMail(env, id, kind, { to: [payload.contact.email], subject, text })
  ];
}

export async function processDemoOutbox(env, dependencies) {
  if (!env.LEADS_DB || !env.DEMO_DATA_ENCRYPTION_KEY) return;
  const config = dependencies.emailConfig();
  if (!config.apiKey || !config.from) return;
  const now = nowIso();
  const { results } = await env.LEADS_DB.prepare("SELECT * FROM demo_email_outbox WHERE (status='pending' OR (status='sending' AND lease_until<?)) AND next_attempt_at<=? ORDER BY created_at LIMIT 25").bind(now, now).all();
  for (const row of results) {
    // Do not retry an ambiguous provider response beyond its idempotency window.
    if (Date.parse(row.created_at) < Date.now() - 23 * 3600000 || row.attempts >= 8) {
      await env.LEADS_DB.prepare("UPDATE demo_email_outbox SET status='failed',payload_encrypted=NULL WHERE id=? AND status!='sent'").bind(row.id).run();
      continue;
    }
    const lease = new Date(Date.now() + 120000).toISOString();
    const claimed = await env.LEADS_DB.prepare("UPDATE demo_email_outbox SET status='sending',attempts=attempts+1,lease_until=? WHERE id=? AND attempts=? AND (status='pending' OR (status='sending' AND lease_until<?))")
      .bind(lease, row.id, row.attempts, now).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      const payload = await decrypt(env, row.payload_encrypted, `email/${row.id}`);
      const sent = await dependencies.sendEmail(config, { from: config.from, ...payload, reply_to: config.replyTo || undefined }, `demo-${row.id}`, AbortSignal.timeout(15000));
      await env.LEADS_DB.prepare("UPDATE demo_email_outbox SET status='sent',payload_encrypted=NULL,provider_id=?,sent_at=?,lease_until=NULL WHERE id=? AND status='sending' AND lease_until=?")
        .bind(sent?.id || null, nowIso(), row.id, lease).run();
    } catch {
      // Neither provider errors nor request data are logged.
      await env.LEADS_DB.prepare("UPDATE demo_email_outbox SET status='pending',next_attempt_at=?,lease_until=NULL WHERE id=? AND status='sending' AND lease_until=?")
        .bind(new Date(Date.now() + Math.min(3600000, 60000 * 2 ** row.attempts)).toISOString(), row.id, lease).run();
    }
  }
  await env.LEADS_DB.batch([
    env.LEADS_DB.prepare('DELETE FROM demo_sessions WHERE expires_at<=?').bind(now),
    env.LEADS_DB.prepare('DELETE FROM demo_access_tokens WHERE expires_at<=?').bind(now),
    env.LEADS_DB.prepare("DELETE FROM security_rate_limits WHERE scope IN ('demo-write','demo-recovery','demo-recovery-email','demo-admin') AND window_started_at<?").bind(Date.now() - 3600000),
    env.LEADS_DB.prepare("DELETE FROM demo_email_outbox WHERE status IN ('sent','failed','cancelled') AND created_at<?").bind(new Date(Date.now() - 30 * DAY).toISOString())
  ]);
}

export async function handleDemoRequest(request, env, dependencies) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  const methods = demoRouteMethods(path);
  const reply = (data, status = 200, extra) => dependencies.respond(data, status, methods || 'OPTIONS', extra);
  try {
    if (!methods) return reply({ error: 'Not found.' }, 404);
    if (!methods.split(',').includes(request.method)) return reply({ error: 'Method not allowed.' }, 405);
    const admin = path.startsWith('/api/advisor/demo/');
    if (!request.headers.get('Origin') || !dependencies.trustedOrigin) fail(403, 'Origin not allowed.');
    if (admin) {
      const access = await dependencies.requireAdmin(request.method !== 'GET');
      if (access.response) return access.response;
      if (access.session?.authenticated !== true || access.session?.authEnabled !== true) fail(503, 'Admin sign-in must be configured before managing demos.');
    }
    if (!env.LEADS_DB || !env.DEMO_DATA_ENCRYPTION_KEY) {
      if (path === '/api/demo/config') return reply({ enabled: false, generationAvailable: false });
      fail(503, 'Demo access is unavailable. Your draft stays on this device.', 'demo_unavailable');
    }
    const wakeMail = () => dependencies.waitUntil(processDemoOutbox(env, dependencies).catch(() => console.error('Demo email processing failed.')));
    if (path === '/api/demo/config') {
      await env.LEADS_DB.prepare('SELECT id FROM demo_requests LIMIT 1').first();
      return reply({ enabled: intakeReady(env, dependencies), generationAvailable: false, contractVersion: 'demo-v1' });
    }
    const body = ['POST', 'PATCH'].includes(request.method) ? await readBody(request) : {};
    // Public endpoints are bounded before expensive encryption or email work.
    if (!admin && request.method !== 'GET') {
      const scope = path.endsWith('/return-links') ? 'demo-recovery' : 'demo-write';
      if (!await dependencies.rateLimit(scope, scope === 'demo-recovery' ? 5 : 30)) fail(429, 'Too many requests. Please try again later.');
      if (scope === 'demo-recovery' && body.email && !await dependencies.rateLimit('demo-recovery-email', 3, await emailHash(env, String(body.email).trim().toLowerCase()))) fail(429, 'Please wait before requesting another email.');
    }
    if (path === '/api/demo/session') {
      const session = await sessionFor(request, env);
      if (request.method === 'DELETE') {
        checkCsrf(request, session);
        await env.LEADS_DB.prepare('DELETE FROM demo_sessions WHERE token_hash=?').bind(session.token_hash).run();
        return reply({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', true) });
      }
      if (!session) return reply({ authenticated: false });
      if (session.request_id) {
        const row = await env.LEADS_DB.prepare('SELECT * FROM demo_requests WHERE id=?').bind(session.request_id).first();
        return reply({ authenticated: true, csrfToken: session.csrf_token, request: await representation(env, row) });
      }
      const invitation = await env.LEADS_DB.prepare('SELECT * FROM demo_invitations WHERE id=? AND revoked_at IS NULL AND expires_at>? AND uses<max_uses').bind(session.invitation_id, nowIso()).first();
      return reply({ authenticated: true, csrfToken: session.csrf_token, invitationValid: Boolean(invitation) });
    }
    if (path === '/api/demo/access/redeem') {
      if (!/^[A-Za-z0-9_-]{43}$/.test(body.token || '')) fail(410, 'This link is invalid or expired. Request a fresh private link.');
      const hash = await sha256Base64Url(body.token);
      const token = await env.LEADS_DB.prepare('SELECT * FROM demo_access_tokens WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?').bind(hash, nowIso()).first();
      if (!token) fail(410, 'This link is invalid or expired. Request a fresh private link.');
      const session = await newSession(request, env, token.request_id);
      const timestamp = nowIso();
      const results = await env.LEADS_DB.batch([
        env.LEADS_DB.prepare('UPDATE demo_access_tokens SET consumed_at=?,consumed_by=? WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?').bind(timestamp, session.hash, hash, timestamp),
        env.LEADS_DB.prepare('INSERT INTO demo_sessions (token_hash,request_id,csrf_token,expires_at) SELECT ?,request_id,?,? FROM demo_access_tokens WHERE token_hash=? AND consumed_by=?')
          .bind(session.hash, session.csrf, new Date(Date.now() + 7 * DAY).toISOString(), hash, session.hash)
      ]);
      if (results[0].meta.changes !== 1) fail(410, 'This link was already used. Request a fresh private link.');
      return reply({ ok: true }, 200, { 'Set-Cookie': session.cookie });
    }
    if (path === '/api/demo/invitations/redeem') {
      if (!intakeReady(env, dependencies)) fail(503, 'New demo access is currently paused.');
      const invitation = /^[A-Za-z0-9_-]{43}$/.test(body.token || '') && await env.LEADS_DB.prepare('SELECT * FROM demo_invitations WHERE token_hash=? AND revoked_at IS NULL AND expires_at>? AND uses<max_uses').bind(await sha256Base64Url(body.token), nowIso()).first();
      if (!invitation) fail(410, 'This demo invitation is expired, full or no longer available. You can still request demo access.');
      const current = await sessionFor(request, env);
      if (current?.request_id) {
        checkCsrf(request, current);
        const row = await env.LEADS_DB.prepare('SELECT * FROM demo_requests WHERE id=?').bind(current.request_id).first();
        if (row.access_status === 'revoked') fail(403, 'Demo access has been revoked. Contact hello@planeir.ie.');
        if (row.access_status === 'pending') {
          await env.LEADS_DB.prepare("UPDATE demo_requests SET invitation_id=?,access_status='approved',updated_at=? WHERE id=? AND access_status='pending' AND invitation_id IS NULL").bind(invitation.id, nowIso(), row.id).run();
        }
        return reply({ ok: true });
      }
      const session = await newSession(request, env, null, invitation.id);
      await session.statement.run();
      return reply({ ok: true }, 200, { 'Set-Cookie': session.cookie });
    }
    if (path === '/api/demo/return-links') {
      const email = String(body.email || '').trim().toLowerCase();
      if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
      const hashes = await Promise.all(lookupKeys(env).map(key => emailHash(env, email, key)));
      const { results } = await env.LEADS_DB.prepare(`SELECT * FROM demo_requests WHERE email_hash IN (${hashes.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 10`).bind(...hashes).all();
      for (const row of results) {
        const payload = await decrypt(env, row.payload_encrypted, `request/${row.id}`);
        await env.LEADS_DB.batch(await accessMail(env, row.id, payload, row.access_status));
      }
      wakeMail();
      return reply({ ok: true, message: 'If we have saved information for this email, we’ll send a private return link.' }, 202);
    }
    if (path === '/api/demo/requests') {
      if (!intakeReady(env, dependencies)) fail(503, 'Demo requests are currently paused. Your draft stays on this device.');
      if (body.website) return reply({ ok: true, message: DEMO_SAVED }, 201);
      if (!/^[A-Za-z0-9_-]{43}$/.test(body.submissionId || '')) fail(400, 'Invalid submission identifier. Refresh the page.');
      const payload = normalize(body), submissionHash = await sha256Base64Url(body.submissionId);
      const payloadHash = await sha256Base64Url(JSON.stringify(payload));
      let row = await env.LEADS_DB.prepare('SELECT * FROM demo_requests WHERE submission_hash=?').bind(submissionHash).first();
      const current = await sessionFor(request, env);
      if (current) checkCsrf(request, current);
      if (current?.request_id && current.request_id !== row?.id) fail(409, 'Save changes to your current form or clear this device before starting another.');
      if (!row) {
        const id = randomId('dr'), timestamp = nowIso();
        const status = current?.invitation_id ? 'approved' : 'pending';
        const session = await newSession(request, env, id);
        const statements = [env.LEADS_DB.prepare('INSERT INTO demo_requests (id,submission_hash,initial_payload_hash,email_hash,payload_encrypted,access_status,invitation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .bind(id, submissionHash, payloadHash, await emailHash(env, payload.contact.email), await encrypt(env, payload, `request/${id}`), status, current?.invitation_id || null, timestamp, timestamp),
        session.statement, ...await accessMail(env, id, payload, status)];
        const recipients = dependencies.emailConfig().notificationRecipients;
        if (recipients?.length) statements.push(await makeMail(env, id, 'notification', { to: recipients, subject: 'New Planéir demo request', text: `A demo request has been saved. Review it in your private admin area: https://planeir.ie/app/demos.html?request=${id}` }));
        try { await env.LEADS_DB.batch(statements); }
        catch (error) {
          row = await env.LEADS_DB.prepare('SELECT * FROM demo_requests WHERE submission_hash=?').bind(submissionHash).first();
          if (!row) throw error;
        }
        if (!row) { wakeMail(); return reply({ ok: true, id, revision: 1, accessStatus: status, csrfToken: session.csrf, message: DEMO_SAVED, generationAvailable: false }, 201, { 'Set-Cookie': session.cookie }); }
      }
      if (row.initial_payload_hash !== payloadHash) fail(409, 'This request was already saved with different information. Open your private return link to edit it.');
      const session = await newSession(request, env, row.id); await session.statement.run();
      wakeMail();
      return reply({ ok: true, id: row.id, revision: row.revision, accessStatus: row.access_status, csrfToken: session.csrf, message: DEMO_SAVED, generationAvailable: false }, 200, { 'Set-Cookie': session.cookie });
    }
    const userMatch = /^\/api\/demo\/requests\/(dr_[A-Za-z0-9_-]{24})(\/confirm)?$/.exec(path);
    if (userMatch) {
      const { row } = await owned(request, env, userMatch[1], request.method !== 'GET');
      if (request.method === 'GET') return reply(await representation(env, row));
      if (request.method === 'DELETE') {
        await env.LEADS_DB.prepare('DELETE FROM demo_requests WHERE id=?').bind(row.id).run();
        return reply({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', true) });
      }
      if (body.revision !== row.revision) fail(409, 'This form changed in another tab. Reopen your saved information before saving again.', 'demo_revision_conflict');
      if (userMatch[2]) {
        if (row.access_status !== 'approved') fail(403, row.access_status === 'revoked' ? 'Demo access has been revoked.' : 'Demo approval is required before confirming your information.');
        const result = await env.LEADS_DB.prepare("UPDATE demo_requests SET confirmed_revision=revision,confirmed_payload_encrypted=payload_encrypted,confirmed_at=?,updated_at=? WHERE id=? AND revision=? AND access_status='approved'").bind(nowIso(), nowIso(), row.id, body.revision).run();
        if (!result.meta.changes) fail(409, 'Your information or access changed. Refresh and try again.');
        return reply({ ok: true, id: row.id, revision: row.revision, status: 'confirmed', generationAvailable: false, message: DEMO_CONFIRMED });
      }
      const payload = normalize(body);
      const previousPayload = await decrypt(env, row.payload_encrypted, `request/${row.id}`);
      if (payload.contact.email !== previousPayload.contact.email) fail(400, 'Your saved email cannot be changed here. Contact hello@planeir.ie for help.');
      const result = await env.LEADS_DB.prepare('UPDATE demo_requests SET payload_encrypted=?,email_hash=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').bind(await encrypt(env, payload, `request/${row.id}`), await emailHash(env, payload.contact.email), nowIso(), row.id, body.revision).run();
      if (!result.meta.changes) fail(409, 'This form changed in another tab. Refresh before saving again.', 'demo_revision_conflict');
      return reply({ ok: true, id: row.id, revision: row.revision + 1, accessStatus: row.access_status, generationAvailable: false });
    }
    if (admin) {
      if (path === '/api/advisor/demo/invitations') {
        if (request.method === 'GET') return reply({ invitations: (await env.LEADS_DB.prepare('SELECT id,label,expires_at,max_uses,uses,revoked_at,created_at FROM demo_invitations ORDER BY created_at DESC LIMIT 200').all()).results });
        const days = body.days ?? 7, maxUses = body.maxUses ?? 25;
        if (!Number.isInteger(days) || days < 1 || days > 90 || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000) fail(400, 'Use 1–90 days and 1–10,000 participants.');
        const token = secret(), id = randomId('di');
        const expiresAt = new Date(Date.now() + days * DAY).toISOString();
        await env.LEADS_DB.prepare('INSERT INTO demo_invitations (id,token_hash,label,expires_at,max_uses,created_at) VALUES (?,?,?,?,?,?)').bind(id, await sha256Base64Url(token), String(body.label || 'Demo invitation').trim().slice(0, 120), expiresAt, maxUses, nowIso()).run();
        return reply({ id, url: `https://planeir.ie/demo/#invite=${token}`, expiresAt, maxUses }, 201);
      }
      const invitationMatch = /^\/api\/advisor\/demo\/invitations\/(di_[A-Za-z0-9_-]{24})\/revoke$/.exec(path);
      if (invitationMatch) {
        await env.LEADS_DB.prepare('UPDATE demo_invitations SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(nowIso(), invitationMatch[1]).run();
        return reply({ ok: true });
      }
      if (path === '/api/advisor/demo/requests') {
        const params = new URL(request.url).searchParams;
        const cursor = params.get('cursor') || '';
        const rows = (await env.LEADS_DB.prepare('SELECT * FROM demo_requests WHERE id < ? ORDER BY id DESC LIMIT 101').bind(cursor || 'z').all()).results;
        const selected = rows.slice(0, 100), requests = [];
        for (const row of selected) {
          const item = await representation(env, row);
          const emails = (await env.LEADS_DB.prepare('SELECT kind,status,attempts,sent_at,created_at FROM demo_email_outbox WHERE request_id=? ORDER BY created_at DESC').bind(row.id).all()).results;
          requests.push({ ...item, emails });
        }
        return reply({ requests, nextCursor: rows.length > 100 ? selected.at(-1).id : null });
      }
      const match = /^\/api\/advisor\/demo\/requests\/(dr_[A-Za-z0-9_-]{24})(?:\/(approve|revoke|send-access-link))?$/.exec(path);
      if (match) {
        const row = await env.LEADS_DB.prepare('SELECT * FROM demo_requests WHERE id=?').bind(match[1]).first();
        if (!row) fail(404, 'Demo request not found.');
        if (request.method === 'GET') return reply(await representation(env, row));
        if (request.method === 'DELETE') { await env.LEADS_DB.prepare('DELETE FROM demo_requests WHERE id=?').bind(row.id).run(); return reply({ ok: true }); }
        if (match[2] === 'revoke') {
          await env.LEADS_DB.prepare("UPDATE demo_requests SET access_status='revoked',updated_at=? WHERE id=?").bind(nowIso(), row.id).run();
          return reply({ ok: true });
        }
        const status = match[2] === 'approve' ? 'approved' : row.access_status;
        const payload = await decrypt(env, row.payload_encrypted, `request/${row.id}`);
        await env.LEADS_DB.batch([
          ...(match[2] === 'approve' ? [env.LEADS_DB.prepare("UPDATE demo_requests SET access_status='approved',updated_at=? WHERE id=?").bind(nowIso(), row.id)] : []),
          ...await accessMail(env, row.id, payload, status, 'access')
        ]);
        wakeMail(); return reply({ ok: true, accessStatus: status, emailQueued: true });
      }
    }
    return reply({ error: 'Not found.' }, 404);
  } catch (error) {
    if (String(error.message).includes('demo_invitation_unavailable')) return reply({ error: 'This demo invitation is expired, full or no longer available.', code: 'demo_invitation_unavailable' }, 410);
    if (error.status) return reply({ error: error.message, code: error.code || 'demo_error' }, error.status);
    console.error('Demo operation failed.');
    return reply({ error: 'Your changes could not be saved. Please try again.', code: 'demo_unavailable' }, 503);
  }
}
