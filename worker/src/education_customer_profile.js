import { encryptJson, decryptJson } from './consumer/crypto.js';

export function educationCryptoEnv(env) {
  return {
    CONSUMER_DATA_ENCRYPTION_KEY: env.APPLICATION_DATA_ENCRYPTION_KEY,
    CONSUMER_DATA_ENCRYPTION_KEY_ID: env.APPLICATION_DATA_ENCRYPTION_KEY_ID || 'application-v1',
    CONSUMER_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: env.APPLICATION_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON
  };
}
const aad = (type, id) => `education/profile/${type}/${id}`;

export async function getSavedEducationProfile(env, type, id) {
  const row = await env.LEADS_DB.prepare('SELECT contact_encrypted FROM education_customer_profiles WHERE source_type = ? AND source_id = ?').bind(type, id).first();
  return row ? decryptJson(educationCryptoEnv(env), row.contact_encrypted, aad(type, id)) : null;
}

export async function handleEducationProfile(request, env, hooks) {
  if (new URL(request.url).pathname !== '/api/education-calls/profile') return null;
  const reply = (payload, status = 200) => Response.json(payload, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!['GET', 'PATCH'].includes(request.method)) return reply({ error: 'Method not allowed.' }, 405);
  try {
    let body;
    if (request.method === 'GET') body = Object.fromEntries(new URL(request.url).searchParams);
    else {
      const raw = await request.text();
      if (raw.length > 5000) return reply({ error: 'Profile request is too large.' }, 413);
      body = JSON.parse(raw);
    }
    const context = await hooks.resolveCustomer(request, body, { profileOnly: true });
    if (request.method === 'GET') return reply({ profile: context.contact || null });
    const fullName = String(body.contact?.fullName || '').trim();
    const email = String(body.contact?.email || '').trim().toLowerCase();
    if (!fullName || fullName.length > 200 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply({ error: 'Save your name and a valid email address in your profile.' }, 400);
    }
    const contact = { fullName, email, phone: context.contact?.phone || '' };
    const encrypted = await encryptJson(educationCryptoEnv(env), contact, aad(context.sourceType, context.sourceId));
    await env.LEADS_DB.prepare(`INSERT INTO education_customer_profiles (source_type, source_id, contact_encrypted, created_at, updated_at)
      VALUES (?, ?, ?, unixepoch(), unixepoch()) ON CONFLICT(source_type, source_id)
      DO UPDATE SET contact_encrypted = excluded.contact_encrypted, updated_at = unixepoch()`)
      .bind(context.sourceType, context.sourceId, encrypted).run();
    return reply({ profile: contact });
  } catch (error) {
    return reply({ error: error.status ? error.message : 'Your saved profile could not be opened.', code: error.code || 'profile_unavailable' }, error.status || 400);
  }
}
