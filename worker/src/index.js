const PAYLOAD_VERSION = 1;
const SESSION_KEY_PREFIX = 'sessions/';
const SESSION_KEY_SUFFIX = '.json';
const MAX_CT_B64_LENGTH = 2_800_000;
const MAX_IV_B64_LENGTH = 64;
const MAX_SALT_B64_LENGTH = 128;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 80;
const MAX_LEAD_NAME_LENGTH = 120;
const MAX_LEAD_EMAIL_LENGTH = 160;
const MAX_LEAD_PHONE_LENGTH = 40;
const MAX_LEAD_REASON_LENGTH = 2_000;
const PREFLIGHT_MAX_AGE_SECONDS = 86_400;
const DEFAULT_ALLOWED_REQUEST_HEADERS = 'Content-Type';
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://planeir.ie',
  'https://www.planeir.ie',
  'https://geraldboylan01.github.io'
]);

const ALLOWED_LEAD_STAGES = new Set([
  'buying-a-home',
  'building-wealth',
  'retirement-planning',
  'financial-education',
  'other'
]);

const ALLOWED_CALL_OUTCOMES = new Set([
  'clearer-understanding',
  'reassurance',
  'decision-support',
  'comparing-options',
  'sense-check-on-a-plan',
  'other'
]);

const requestBuckets = new Map();

function getAllowedOrigins(env) {
  const raw = String(env.ALLOWED_ORIGINS || '');
  const configuredOrigins = raw.split(',').map((value) => value.trim()).filter(Boolean);
  return new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...configuredOrigins
  ]);
}

function normalizePathname(pathname) {
  if (pathname.length <= 1) {
    return pathname;
  }

  return pathname.replace(/\/+$/, '');
}

function getRouteConfig(pathname) {
  if (pathname === '/api/leads') {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  if (pathname === '/api/publish') {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  if (/^\/api\/session\/[^/]+$/.test(pathname)) {
    return {
      methods: 'GET,OPTIONS'
    };
  }

  if (/^\/api\/revoke\/[^/]+$/.test(pathname)) {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  return null;
}

function getAllowedRequestHeaders(request) {
  const requestedHeaders = request.headers.get('Access-Control-Request-Headers');
  return requestedHeaders || DEFAULT_ALLOWED_REQUEST_HEADERS;
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

function corsHeaders(origin, methods, requestHeaders) {
  const headers = {
    'Access-Control-Allow-Methods': methods || 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': requestHeaders || DEFAULT_ALLOWED_REQUEST_HEADERS,
    'Access-Control-Max-Age': String(PREFLIGHT_MAX_AGE_SECONDS),
    Vary: requestHeaders ? 'Origin, Access-Control-Request-Headers' : 'Origin'
  };

  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

function jsonResponse(data, status, origin, methods, requestHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin, methods, requestHeaders)
    }
  });
}

function optionsResponse(request, origin, methods) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin, methods, getAllowedRequestHeaders(request))
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

function normalizeOptionalLeadValue(value) {
  const normalized = normalizeLeadValue(value);
  return normalized ? normalized : null;
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
  const callOutcome = normalizeLeadValue(payload.callOutcome);
  const reason = normalizeLeadValue(payload.reason);
  const understandsRecordedCall = normalizeLeadConsent(
    payload.understandsRecordedCall ?? payload.understandsEarlyAccess
  );
  const understandsEducationalContent = normalizeLeadConsent(
    payload.understandsEducationalContent ?? payload.openToRecording
  );

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

  if (callOutcome && !ALLOWED_CALL_OUTCOMES.has(callOutcome)) {
    throw new Error('Requested call outcome is invalid.');
  }

  if (!reason) {
    throw new Error('Help request is required.');
  }

  if (reason.length > MAX_LEAD_REASON_LENGTH) {
    throw new Error('Help request is too long.');
  }

  if (!understandsRecordedCall) {
    throw new Error('Recorded-call acknowledgement is required.');
  }

  if (!understandsEducationalContent) {
    throw new Error('Educational-content consent is required for this free call.');
  }

  return {
    fullName,
    email,
    phone,
    reason,
    stage,
    callOutcome,
    understandsRecordedCall,
    understandsEducationalContent,
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
    return jsonResponse({ error: 'Invalid JSON body.' }, 400, origin, 'POST,OPTIONS');
  }

  let validated;
  try {
    validated = validatePublishPayload(body);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Invalid payload.' }, 400, origin, 'POST,OPTIONS');
  }

  const sessionId = crypto.randomUUID();
  const objectKey = getSessionKey(sessionId);

  try {
    await env.SESSIONS_BUCKET.put(objectKey, JSON.stringify(validated), {
      httpMetadata: {
        contentType: 'application/json'
      }
    });
  } catch (error) {
    console.error('Failed to store published session', {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: 'Could not publish this session right now.' }, 500, origin, 'POST,OPTIONS');
  }

  return jsonResponse({ sessionId }, 200, origin, 'POST,OPTIONS');
}

async function handleLeadSubmit(request, env, origin) {
  const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: 'Too many requests. Please try again later.' }, 429, origin, 'POST,OPTIONS');
  }

  if (!env.LEADS_DB) {
    console.error('LEADS_DB binding is missing for lead submission');
    return jsonResponse({ error: 'Lead capture is not configured right now.' }, 500, origin, 'POST,OPTIONS');
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400, origin, 'POST,OPTIONS');
  }

  let validated;
  try {
    validated = validateLeadPayload(body);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Invalid payload.' }, 400, origin, 'POST,OPTIONS');
  }

  const createdAt = new Date().toISOString();
  const phone = normalizeOptionalLeadValue(validated.phone);
  const stage = normalizeOptionalLeadValue(validated.stage);
  const callOutcome = normalizeOptionalLeadValue(validated.callOutcome);

  try {
    const result = await env.LEADS_DB.prepare(`
      INSERT INTO leads (
        created_at,
        full_name,
        email,
        phone,
        help_reason,
        stage,
        call_outcome,
        consent_free_call,
        consent_recording,
        source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      createdAt,
      validated.fullName,
      validated.email,
      phone,
      validated.reason,
      stage,
      callOutcome,
      validated.understandsRecordedCall ? 1 : 0,
      validated.understandsEducationalContent ? 1 : 0,
      validated.source
    ).run();

    if (!result.success) {
      throw new Error('Lead insert did not succeed.');
    }

    return jsonResponse({
      ok: true,
      leadId: result.meta?.last_row_id ?? null
    }, 201, origin, 'POST,OPTIONS');
  } catch (error) {
    console.error('Failed to store lead submission', {
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: 'Could not save your request right now. Please try again shortly.' }, 500, origin, 'POST,OPTIONS');
  }
}

async function handleGetSession(request, env, origin, sessionId) {
  const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: 'Too many requests. Please try again later.' }, 429, origin, 'GET,OPTIONS');
  }

  const objectKey = getSessionKey(sessionId);
  const object = await env.SESSIONS_BUCKET.get(objectKey);

  if (!object) {
    return jsonResponse({ error: 'Session not found.' }, 404, origin, 'GET,OPTIONS');
  }

  const payload = await object.text();

  return new Response(payload, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin, 'GET,OPTIONS')
    }
  });
}

async function handleRevoke(env, origin, sessionId) {
  const objectKey = getSessionKey(sessionId);
  await env.SESSIONS_BUCKET.delete(objectKey);
  return jsonResponse({ ok: true }, 200, origin, 'POST,OPTIONS');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = normalizePathname(url.pathname);
    const routeConfig = getRouteConfig(pathname);
    const origin = getCorsOrigin(request, env);
    const requestHeaders = getAllowedRequestHeaders(request);

    if (origin === false) {
      return jsonResponse({ error: 'Origin not allowed.' }, 403, null, routeConfig?.methods, requestHeaders);
    }

    if (request.method === 'OPTIONS') {
      if (!routeConfig) {
        return jsonResponse({ error: 'Not found.' }, 404, origin, 'OPTIONS', requestHeaders);
      }

      return optionsResponse(request, origin, routeConfig.methods);
    }

    if (request.method === 'POST' && pathname === '/api/leads') {
      return handleLeadSubmit(request, env, origin);
    }

    if (request.method === 'POST' && pathname === '/api/publish') {
      return handlePublish(request, env, origin);
    }

    const getMatch = /^\/api\/session\/([^/]+)$/.exec(pathname);
    if (request.method === 'GET' && getMatch) {
      const sessionId = getMatch[1];
      if (!isSafeSessionId(sessionId)) {
        return jsonResponse({ error: 'Invalid session id.' }, 400, origin, 'GET,OPTIONS');
      }

      return handleGetSession(request, env, origin, sessionId);
    }

    const revokeMatch = /^\/api\/revoke\/([^/]+)$/.exec(pathname);
    if (request.method === 'POST' && revokeMatch) {
      const sessionId = revokeMatch[1];
      if (!isSafeSessionId(sessionId)) {
        return jsonResponse({ error: 'Invalid session id.' }, 400, origin, 'POST,OPTIONS');
      }

      return handleRevoke(env, origin, sessionId);
    }

    return jsonResponse({ error: 'Not found.' }, 404, origin, routeConfig?.methods, requestHeaders);
  }
};
