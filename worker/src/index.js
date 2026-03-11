const PAYLOAD_VERSION = 1;
const SESSION_KEY_PREFIX = 'sessions/';
const SESSION_KEY_SUFFIX = '.json';
const LEAD_KEY_PREFIX = 'leads/';
const MAX_CT_B64_LENGTH = 2_800_000;
const MAX_IV_B64_LENGTH = 64;
const MAX_SALT_B64_LENGTH = 128;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 80;
const MAX_LEAD_NAME_LENGTH = 120;
const MAX_LEAD_EMAIL_LENGTH = 160;
const MAX_LEAD_PHONE_LENGTH = 40;
const MAX_LEAD_REASON_LENGTH = 2_000;

const ALLOWED_LEAD_STAGES = new Set([
  'buying-a-home',
  'building-wealth',
  'retirement-planning',
  'financial-education',
  'other'
]);

const requestBuckets = new Map();

function getAllowedOrigins(env) {
  const raw = String(env.ALLOWED_ORIGINS || '');
  return new Set(raw.split(',').map((value) => value.trim()).filter(Boolean));
}

function getCorsOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) {
    return null;
  }

  const allowedOrigins = getAllowedOrigins(env);
  if (allowedOrigins.has(origin)) {
    return origin;
  }

  try {
    const parsed = new URL(origin);
    const isLocalDev = parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    const isGithubPages = parsed.protocol === 'https:' && parsed.hostname.endsWith('.github.io');

    if (isLocalDev || isGithubPages) {
      return origin;
    }
  } catch (_error) {
    return false;
  }

  return false;
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin'
  };

  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin)
    }
  });
}

function parseJsonBody(request) {
  return request.json();
}

function normalizeLeadValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeLeadConsent(value) {
  if (value === true) {
    return true;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === 'yes' || normalized === 'on';
  }

  return false;
}

function isSafeSessionId(rawId) {
  return typeof rawId === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(rawId);
}

function getSessionKey(sessionId) {
  return `${SESSION_KEY_PREFIX}${sessionId}${SESSION_KEY_SUFFIX}`;
}

function validatePublishPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be a JSON object.');
  }

  if (Number(payload.v) !== PAYLOAD_VERSION) {
    throw new Error('Unsupported payload version.');
  }

  if (typeof payload.saltB64 !== 'string' || payload.saltB64.length === 0 || payload.saltB64.length > MAX_SALT_B64_LENGTH) {
    throw new Error('Invalid saltB64.');
  }

  if (typeof payload.ivB64 !== 'string' || payload.ivB64.length === 0 || payload.ivB64.length > MAX_IV_B64_LENGTH) {
    throw new Error('Invalid ivB64.');
  }

  if (typeof payload.ctB64 !== 'string' || payload.ctB64.length === 0 || payload.ctB64.length > MAX_CT_B64_LENGTH) {
    throw new Error('Invalid ctB64.');
  }

  return {
    v: PAYLOAD_VERSION,
    saltB64: payload.saltB64,
    ivB64: payload.ivB64,
    ctB64: payload.ctB64
  };
}

function validateLeadPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be a JSON object.');
  }

  const fullName = normalizeLeadValue(payload.fullName);
  const email = normalizeLeadValue(payload.email).toLowerCase();
  const phone = normalizeLeadValue(payload.phone);
  const stage = normalizeLeadValue(payload.stage);
  const reason = normalizeLeadValue(payload.reason);
  const understandsEarlyAccess = normalizeLeadConsent(payload.understandsEarlyAccess);
  const openToRecording = normalizeLeadConsent(payload.openToRecording);

  if (!fullName) {
    throw new Error('Full name is required.');
  }

  if (fullName.length > MAX_LEAD_NAME_LENGTH) {
    throw new Error('Full name is too long.');
  }

  if (!email) {
    throw new Error('Email is required.');
  }

  if (email.length > MAX_LEAD_EMAIL_LENGTH) {
    throw new Error('Email is too long.');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Email address is invalid.');
  }

  if (phone.length > MAX_LEAD_PHONE_LENGTH) {
    throw new Error('Phone number is too long.');
  }

  if (stage && !ALLOWED_LEAD_STAGES.has(stage)) {
    throw new Error('Planning stage is invalid.');
  }

  if (!reason) {
    throw new Error('Help request is required.');
  }

  if (reason.length > MAX_LEAD_REASON_LENGTH) {
    throw new Error('Help request is too long.');
  }

  if (!understandsEarlyAccess) {
    throw new Error('Early-access acknowledgement is required.');
  }

  if (!openToRecording) {
    throw new Error('Recording consent is required for this early-access call.');
  }

  return {
    fullName,
    email,
    phone,
    reason,
    stage,
    understandsEarlyAccess,
    openToRecording,
    source: 'landing-page'
  };
}

function checkRateLimit(clientIp) {
  const now = Date.now();
  const key = clientIp || 'unknown';
  const existing = requestBuckets.get(key);

  if (!existing || now - existing.windowStart > RATE_LIMIT_WINDOW_MS) {
    requestBuckets.set(key, {
      windowStart: now,
      count: 1
    });
    return true;
  }

  if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  existing.count += 1;
  requestBuckets.set(key, existing);

  if (requestBuckets.size > 5000) {
    const cutoff = now - RATE_LIMIT_WINDOW_MS * 3;
    for (const [mapKey, value] of requestBuckets.entries()) {
      if (value.windowStart < cutoff) {
        requestBuckets.delete(mapKey);
      }
    }
  }

  return true;
}

async function handlePublish(request, env, origin) {
  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400, origin);
  }

  let validated;
  try {
    validated = validatePublishPayload(body);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Invalid payload.' }, 400, origin);
  }

  const sessionId = crypto.randomUUID();
  const objectKey = getSessionKey(sessionId);

  await env.SESSIONS_BUCKET.put(objectKey, JSON.stringify(validated), {
    httpMetadata: {
      contentType: 'application/json'
    }
  });

  return jsonResponse({ sessionId }, 200, origin);
}

async function handleLeadSubmit(request, env, origin) {
  const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: 'Too many requests. Please try again later.' }, 429, origin);
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400, origin);
  }

  let validated;
  try {
    validated = validateLeadPayload(body);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Invalid payload.' }, 400, origin);
  }

  const leadId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const datePath = createdAt.slice(0, 10);
  const objectKey = `${LEAD_KEY_PREFIX}${datePath}/${createdAt.replace(/[:.]/g, '-')}-${leadId}.json`;

  await env.SESSIONS_BUCKET.put(objectKey, JSON.stringify({
    id: leadId,
    createdAt,
    ...validated
  }), {
    httpMetadata: {
      contentType: 'application/json'
    }
  });

  return jsonResponse({ ok: true, leadId }, 201, origin);
}

async function handleGetSession(request, env, origin, sessionId) {
  const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: 'Too many requests. Please try again later.' }, 429, origin);
  }

  const objectKey = getSessionKey(sessionId);
  const object = await env.SESSIONS_BUCKET.get(objectKey);

  if (!object) {
    return jsonResponse({ error: 'Session not found.' }, 404, origin);
  }

  const payload = await object.text();

  return new Response(payload, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin)
    }
  });
}

async function handleRevoke(env, origin, sessionId) {
  const objectKey = getSessionKey(sessionId);
  await env.SESSIONS_BUCKET.delete(objectKey);
  return jsonResponse({ ok: true }, 200, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = getCorsOrigin(request, env);

    if (origin === false) {
      return jsonResponse({ error: 'Origin not allowed.' }, 403, null);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(origin)
        }
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/leads') {
      return handleLeadSubmit(request, env, origin);
    }

    if (request.method === 'POST' && url.pathname === '/api/publish') {
      return handlePublish(request, env, origin);
    }

    const getMatch = /^\/api\/session\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && getMatch) {
      const sessionId = getMatch[1];
      if (!isSafeSessionId(sessionId)) {
        return jsonResponse({ error: 'Invalid session id.' }, 400, origin);
      }

      return handleGetSession(request, env, origin, sessionId);
    }

    const revokeMatch = /^\/api\/revoke\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'POST' && revokeMatch) {
      const sessionId = revokeMatch[1];
      if (!isSafeSessionId(sessionId)) {
        return jsonResponse({ error: 'Invalid session id.' }, 400, origin);
      }

      return handleRevoke(env, origin, sessionId);
    }

    return jsonResponse({ error: 'Not found.' }, 404, origin);
  }
};
