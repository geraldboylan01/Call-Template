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
const RESEND_EMAILS_API_URL = 'https://api.resend.com/emails';
const LEAD_SOURCE_LABEL = 'Planeir landing page';
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://planeir.ie',
  'https://www.planeir.ie',
  'https://geraldboylan01.github.io'
]);
const TRUEISH_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

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
const LEAD_STAGE_LABELS = {
  'buying-a-home': 'Buying a home',
  'building-wealth': 'Building wealth',
  'retirement-planning': 'Retirement planning',
  'financial-education': 'Financial education',
  other: 'Other'
};
const CALL_OUTCOME_LABELS = {
  'clearer-understanding': 'Clearer understanding',
  reassurance: 'Reassurance',
  'decision-support': 'Decision support',
  'comparing-options': 'Comparing options',
  'sense-check-on-a-plan': 'Sense-check on a plan',
  other: 'Other'
};

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

function normalizeEnvValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isTruthyEnvValue(value) {
  if (value === true) {
    return true;
  }

  const normalized = normalizeEnvValue(value).toLowerCase();
  return TRUEISH_ENV_VALUES.has(normalized);
}

function splitEmailList(value) {
  return normalizeEnvValue(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatOptionalText(value) {
  const normalized = normalizeLeadValue(value);
  return normalized || 'Not provided';
}

function formatLeadSelection(value, labels) {
  const normalized = normalizeLeadValue(value);
  if (!normalized) {
    return 'Not provided';
  }

  return labels[normalized] || normalized;
}

function formatLeadConsent(value) {
  return value ? 'Yes' : 'No';
}

function buildLeadSummaryRows(lead, leadId) {
  return [
    ['Lead ID', leadId ? String(leadId) : 'Not available'],
    ['Full name', formatOptionalText(lead.fullName)],
    ['Email', formatOptionalText(lead.email)],
    ['Phone', formatOptionalText(lead.phone)],
    ['Planning stage', formatLeadSelection(lead.stage, LEAD_STAGE_LABELS)],
    ['Requested outcome', formatLeadSelection(lead.callOutcome, CALL_OUTCOME_LABELS)],
    ['Understands this is a free recorded call', formatLeadConsent(lead.understandsRecordedCall)],
    ['Understands recording may be used as educational content', formatLeadConsent(lead.understandsEducationalContent)],
    ['Submitted at', formatOptionalText(lead.createdAt)],
    ['Source', LEAD_SOURCE_LABEL]
  ];
}

function buildLeadNotificationText(lead, leadId) {
  const summary = buildLeadSummaryRows(lead, leadId)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');

  return [
    'New Planeir request-a-call submission',
    '',
    summary,
    '',
    'Main question / concern:',
    formatOptionalText(lead.reason)
  ].join('\n');
}

function buildLeadNotificationHtml(lead, leadId) {
  const rows = buildLeadSummaryRows(lead, leadId)
    .map(([label, value]) => `
      <tr>
        <td style="padding:10px 12px;border:1px solid #d9e2ea;background:#f7fafc;font-weight:600;vertical-align:top;">${escapeHtml(label)}</td>
        <td style="padding:10px 12px;border:1px solid #d9e2ea;vertical-align:top;">${escapeHtml(value)}</td>
      </tr>
    `)
    .join('');

  const reasonHtml = escapeHtml(formatOptionalText(lead.reason)).replace(/\n/g, '<br />');

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f1f5f9;color:#102a43;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #d9e2ea;border-radius:16px;overflow:hidden;">
      <div style="padding:24px 24px 12px;background:#0f2233;color:#ffffff;">
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.8;">Planeir lead notification</p>
        <h1 style="margin:0;font-size:24px;line-height:1.25;">New request-a-call submission</h1>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;">
          A new lead was submitted through the Planeir landing page.
        </p>
        <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.5;">
          ${rows}
        </table>
        <h2 style="margin:24px 0 12px;font-size:18px;line-height:1.3;">Main question / concern</h2>
        <div style="padding:16px;border:1px solid #d9e2ea;border-radius:12px;background:#f7fafc;font-size:14px;line-height:1.7;">
          ${reasonHtml}
        </div>
      </div>
    </div>
  </body>
</html>`;
}

function buildLeadConfirmationText(lead) {
  return [
    `Hi ${lead.fullName},`,
    '',
    'Thanks for getting in touch with Planeir.',
    'Gerry has received your request for a free call and will review it shortly.',
    'If the request looks like a good fit for the format, you will hear back.',
    '',
    'Best,',
    'Planeir'
  ].join('\n');
}

function buildLeadConfirmationHtml(lead) {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f1f5f9;color:#102a43;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #d9e2ea;border-radius:16px;overflow:hidden;">
      <div style="padding:24px;background:#0f2233;color:#ffffff;">
        <h1 style="margin:0;font-size:24px;line-height:1.25;">Thanks for getting in touch</h1>
      </div>
      <div style="padding:24px;font-size:15px;line-height:1.7;">
        <p style="margin:0 0 16px;">Hi ${escapeHtml(lead.fullName)},</p>
        <p style="margin:0 0 16px;">
          Gerry has received your request for a free call and will review it shortly.
        </p>
        <p style="margin:0 0 16px;">
          If the request looks like a good fit for the format, you will hear back.
        </p>
        <p style="margin:0;">Best,<br />Planeir</p>
      </div>
    </div>
  </body>
</html>`;
}

function getLeadEmailConfig(env) {
  const apiKey = normalizeEnvValue(env.RESEND_API_KEY);
  const from = normalizeEnvValue(env.LEAD_EMAIL_FROM);
  const notificationRecipients = splitEmailList(env.LEAD_NOTIFICATION_TO);
  const replyTo = splitEmailList(env.LEAD_REPLY_TO)[0] || '';
  const confirmationEnabled = isTruthyEnvValue(env.LEAD_CONFIRMATION_EMAIL_ENABLED);

  return {
    apiKey,
    from,
    notificationRecipients,
    replyTo,
    confirmationEnabled
  };
}

function buildEmailIdempotencyKey(leadId, createdAt, kind) {
  const base = String(leadId || createdAt || kind).replace(/[^a-zA-Z0-9_-]/g, '-');
  return `lead-${base}-${kind}`;
}

async function sendEmailWithResend(config, payload, idempotencyKey) {
  const response = await fetch(RESEND_EMAILS_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();
  let data = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch (_error) {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Resend request failed with status ${response.status}.`);
  }

  return data;
}

async function sendLeadEmails(env, lead, leadId) {
  const config = getLeadEmailConfig(env);

  if (!config.apiKey || !config.from) {
    console.warn('Lead email sending skipped because provider credentials are not configured.');
    return;
  }

  if (config.notificationRecipients.length > 0) {
    try {
      await sendEmailWithResend(config, {
        from: config.from,
        to: config.notificationRecipients,
        subject: `New Planeir call request: ${lead.fullName}`,
        html: buildLeadNotificationHtml(lead, leadId),
        text: buildLeadNotificationText(lead, leadId),
        reply_to: lead.email
      }, buildEmailIdempotencyKey(leadId, lead.createdAt, 'internal'));
    } catch (error) {
      console.error('Lead internal notification email failed', {
        leadId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  } else {
    console.warn('Lead notification email skipped because LEAD_NOTIFICATION_TO is not configured.');
  }

  if (!config.confirmationEnabled) {
    return;
  }

  try {
    await sendEmailWithResend(config, {
      from: config.from,
      to: [lead.email],
      subject: 'We received your Planeir call request',
      html: buildLeadConfirmationHtml(lead),
      text: buildLeadConfirmationText(lead),
      reply_to: config.replyTo || undefined
    }, buildEmailIdempotencyKey(leadId, lead.createdAt, 'confirmation'));
  } catch (error) {
    console.error('Lead confirmation email failed', {
      leadId,
      email: lead.email,
      error: error instanceof Error ? error.message : String(error)
    });
  }
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

async function handleLeadSubmit(request, env, origin, ctx) {
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

    const leadId = result.meta?.last_row_id ?? null;
    const emailLead = {
      ...validated,
      phone,
      stage,
      callOutcome,
      createdAt
    };
    const emailTask = sendLeadEmails(env, emailLead, leadId).catch((error) => {
      console.error('Lead email notification failed', {
        leadId,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(emailTask);
    } else {
      await emailTask;
    }

    return jsonResponse({
      ok: true,
      leadId
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
  async fetch(request, env, ctx) {
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
      return handleLeadSubmit(request, env, origin, ctx);
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
