const PAYLOAD_VERSION = 1;
const SESSION_KEY_PREFIX = 'sessions/';
const SESSION_KEY_SUFFIX = '.json';
const PUBLISHED_PAYLOAD_VERSION = 2;
const PUBLISHED_SPLIT_PAYLOAD_VERSION = 3;
const PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION = 4;
const WORKER_SOURCE_FINGERPRINT = 'worker-v5-lead-scheduling-2026-05-08-1';
const PUBLISHED_KEY_LENGTH = 32;
const PUBLISHED_SESSION_KEY_PREFIX = 'published/v2/';
const PUBLISHED_CLIENT_KEY_PREFIX = 'published/client/';
const PUBLISHED_ADVISOR_KEY_PREFIX = 'published/advisor/';
const PUBLISHED_EMAIL_ASSET_KEY_PREFIX = 'published/email-assets/';
const PUBLISHED_SESSION_KIND = 'published-session';
const PUBLISHED_CLIENT_KIND = 'published-client-session';
const PUBLISHED_ADVISOR_KIND = 'published-advisor-session';
const MAX_CT_B64_LENGTH = 2_800_000;
const MAX_IV_B64_LENGTH = 64;
const MAX_SALT_B64_LENGTH = 128;
const MAX_WRAP_CT_B64U_LENGTH = 12_000;
const MAX_AUTH_HASH_B64U_LENGTH = 128;
const MAX_CAPABILITY_TOKEN_B64U_LENGTH = 128;
const MAX_PUBLISHED_RECOVERY_SECRET_B64U_LENGTH = 128;
const MAX_PUBLISHED_RECOVERY_PAYLOAD_B64U_LENGTH = 4_096;
const MAX_QR_IMAGE_DATA_URL_LENGTH = 1_500_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 80;
const PUBLISHED_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLISHED_ALLOWED_EXPIRY_DAYS = new Set([7, 30, 90]);
const PUBLISHED_CLIENT_LINK_HOSTS = new Set(['planeir.ie', 'www.planeir.ie']);
const PUBLISHED_CLIENT_LINK_PATHS = new Set(['/app/session.html', '/session.html']);
const ADVISOR_SESSION_COOKIE = 'planeir_advisor_session';
const ADVISOR_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ADVISOR_AUTH_PBKDF2_ITERATIONS = 100_000;
const ADVISOR_LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const ADVISOR_LOGIN_RATE_LIMIT_MAX = 10;
const ADVISOR_ADMIN_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const ADVISOR_ADMIN_RATE_LIMIT_MAX = 60;
const MAX_ADVISOR_PASSWORD_LENGTH = 256;
const MAX_LEAD_NAME_LENGTH = 120;
const MAX_LEAD_EMAIL_LENGTH = 160;
const MAX_LEAD_PHONE_LENGTH = 40;
const MAX_LEAD_REASON_LENGTH = 2_000;
const MAX_LEAD_AVAILABILITY_LENGTH = 1_200;
const MAX_LEAD_ADVISOR_NOTES_LENGTH = 4_000;
const MAX_LEAD_SCHEDULE_MESSAGE_LENGTH = 4_000;
const MAX_LEAD_SCHEDULE_LOCATION_LENGTH = 240;
const MAX_CLIENT_NAME_LENGTH = 160;
const MAX_CLIENT_EMAIL_LENGTH = 160;
const MAX_USER_AGENT_LENGTH = 512;
const MAX_ADVISOR_SESSION_TOKEN_LENGTH = 4096;
const PREFLIGHT_MAX_AGE_SECONDS = 86_400;
const DEFAULT_ALLOWED_REQUEST_HEADERS = 'Content-Type';
const RESEND_EMAILS_API_URL = 'https://api.resend.com/emails';
const PLANEIR_SITE_URL = 'https://planeir.ie';
const PLANEIR_EMAIL_CARD_URL = `${PLANEIR_SITE_URL}/assets/brand/planeir-social-card.png`;
const PLANEIR_EMAIL_CARD_ALT = 'Planeir - Irish financial education calls. Educational only, not financial advice.';
const LEAD_SOURCE_LABEL = 'Planeir landing page';
const DEFAULT_LEAD_SCHEDULE_TIMEZONE = 'Europe/Dublin';
const DEFAULT_LEAD_SCHEDULE_LOCATION = 'Zoom meeting link to be created automatically';
const DEFAULT_LEAD_SCHEDULE_DURATION_MINUTES = 30;
const LEAD_SCHEDULE_RESPONSE_TTL_MS = 48 * 60 * 60 * 1000;
const ZOOM_OAUTH_TOKEN_URL = 'https://zoom.us/oauth/token';
const ZOOM_API_BASE_URL = 'https://api.zoom.us/v2';
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://planeir.ie',
  'https://www.planeir.ie',
  'https://geraldboylan01.github.io'
]);
const DEFAULT_SESSION_ADVISOR_NOTIFICATION_TO = ['geraldboylan@gmail.com'];
const TRUEISH_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const HKDF_SALT = new Uint8Array(32);
const PUBLISHED_RECOVERY_INFO = 'planeir/publish/recovery/v1';
const PUBLISHED_AUTH_INFO = Object.freeze({
  client: 'planeir/publish/client-auth/v1',
  advisor: 'planeir/publish/advisor-auth/v1'
});

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
const ALLOWED_LEAD_STATUSES = new Set([
  'new',
  'reviewing',
  'awaiting-client',
  'booked',
  'declined',
  'archived'
]);
const LEAD_STATUS_LABELS = {
  new: 'New',
  reviewing: 'Reviewing',
  'awaiting-client': 'Awaiting client',
  booked: 'Booked',
  declined: 'Declined',
  archived: 'Archived'
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

  if (pathname === '/api/published-sessions') {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  if (pathname === '/api/advisor/published-sessions') {
    return {
      methods: 'GET,OPTIONS'
    };
  }

  if (pathname === '/api/advisor/leads') {
    return {
      methods: 'GET,OPTIONS'
    };
  }

  if (/^\/api\/advisor\/leads\/\d+$/.test(pathname)) {
    return {
      methods: 'GET,PATCH,OPTIONS'
    };
  }

  if (/^\/api\/advisor\/leads\/\d+\/send-schedule-email$/.test(pathname)) {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  if (pathname === '/api/leads/schedule-response') {
    return {
      methods: 'GET,OPTIONS'
    };
  }

  if (pathname === '/api/auth/session') {
    return {
      methods: 'GET,OPTIONS'
    };
  }

  if (pathname === '/api/auth/login') {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  if (pathname === '/api/auth/logout') {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  if (/^\/api\/session\/[^/]+$/.test(pathname)) {
    return {
      methods: 'GET,OPTIONS'
    };
  }

  if (/^\/api\/published-sessions\/[^/]+\/(?:client|advisor)$/.test(pathname)) {
    return {
      methods: 'GET,OPTIONS'
    };
  }

  if (/^\/api\/advisor\/published-sessions\/[^/]+$/.test(pathname)) {
    return {
      methods: 'GET,OPTIONS'
    };
  }

  if (/^\/api\/revoke\/[^/]+$/.test(pathname)) {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  if (/^\/api\/published-sessions\/[^/]+\/revoke$/.test(pathname)) {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  if (/^\/api\/published-sessions\/[^/]+\/extend$/.test(pathname)) {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  if (/^\/api\/published-sessions\/[^/]+\/send-email$/.test(pathname)) {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  if (/^\/api\/published-sessions\/[^/]+\/send-advisor-notification$/.test(pathname)) {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  if (/^\/api\/published-sessions\/[^/]+\/client-pin\/setup$/.test(pathname)) {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  if (/^\/api\/published-sessions\/[^/]+\/client-access\/reset$/.test(pathname)) {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  if (/^\/api\/published-sessions\/[^/]+\/unlocked$/.test(pathname)) {
    return {
      methods: 'POST,OPTIONS'
    };
  }

  if (/^\/email-assets\/qr\/[^/]+\/[^/]+$/.test(pathname)) {
    return {
      methods: 'GET,OPTIONS'
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

    if (isLocalDev) {
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
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  return headers;
}

function noStoreHeaders() {
  return {
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    Expires: '0'
  };
}

function securityHeaders(extraHeaders = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Planeir-Worker-Fingerprint': WORKER_SOURCE_FINGERPRINT,
    ...extraHeaders
  };
}

function jsonResponse(data, status, origin, methods, requestHeaders, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin, methods, requestHeaders),
      ...securityHeaders(extraHeaders)
    }
  });
}

function assetResponse(body, status, contentType, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': contentType,
      ...securityHeaders(extraHeaders)
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

function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
}

function requireTrustedOrigin(origin, methods) {
  if (origin) {
    return null;
  }

  return jsonResponse({ error: 'Origin not allowed.' }, 403, null, methods || 'POST,OPTIONS');
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

function normalizeLongText(value) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
}

function normalizeLeadStatus(value, fallback = 'new') {
  const normalized = normalizeLeadValue(value).toLowerCase();
  if (ALLOWED_LEAD_STATUSES.has(normalized)) {
    return normalized;
  }

  return fallback;
}

function normalizeScheduleResponseStatus(value) {
  const normalized = normalizeLeadValue(value).toLowerCase();
  return ['pending', 'accepted', 'declined', 'expired'].includes(normalized) ? normalized : '';
}

function normalizeOptionalIsoDate(value, label) {
  const normalized = normalizeLeadValue(value);
  if (!normalized) {
    return '';
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} is invalid.`);
  }

  return parsed.toISOString();
}

function normalizeEnvValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeUserAgent(value) {
  const normalized = normalizeEnvValue(value);
  if (!normalized) {
    return '';
  }

  return normalized.slice(0, MAX_USER_AGENT_LENGTH);
}

function parseCookies(request) {
  const header = request.headers.get('Cookie');
  if (!header) {
    return new Map();
  }

  return new Map(
    header
      .split(';')
      .map((entry) => {
        const separatorIndex = entry.indexOf('=');
        if (separatorIndex < 0) {
          return [normalizeEnvValue(entry), ''];
        }

        return [
          normalizeEnvValue(entry.slice(0, separatorIndex)),
          entry.slice(separatorIndex + 1).trim()
        ];
      })
      .filter(([key]) => key)
  );
}

function fromBase64UrlBytes(base64Url, maxLength = MAX_ADVISOR_SESSION_TOKEN_LENGTH) {
  if (typeof base64Url !== 'string' || !base64Url || base64Url.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(base64Url)) {
    throw new Error('Base64url value is malformed.');
  }

  const normalized = base64Url
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function getAdvisorAuthConfig(env) {
  const sessionSecret = normalizeEnvValue(env.ADVISOR_SESSION_SECRET);
  const password = normalizeEnvValue(env.ADVISOR_PASSWORD);
  const passwordHashB64u = normalizeEnvValue(env.ADVISOR_PASSWORD_HASH_B64U);
  const passwordSaltB64u = normalizeEnvValue(env.ADVISOR_PASSWORD_SALT_B64U);

  const enabled = Boolean(
    sessionSecret
      && (
        password
        || (passwordHashB64u && passwordSaltB64u)
      )
  );

  return {
    enabled,
    sessionSecret,
    password,
    passwordHashB64u,
    passwordSaltB64u
  };
}

function constantTimeEquals(leftBytes, rightBytes) {
  const left = leftBytes instanceof Uint8Array ? leftBytes : new Uint8Array(leftBytes);
  const right = rightBytes instanceof Uint8Array ? rightBytes : new Uint8Array(rightBytes);
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }

  return diff === 0;
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256'
    },
    false,
    ['sign', 'verify']
  );
}

async function importHkdfSecret(secretBytes) {
  const secret = secretBytes instanceof Uint8Array ? secretBytes : new Uint8Array(secretBytes);
  if (secret.length === 0) {
    throw new Error('Secret material is required.');
  }

  return crypto.subtle.importKey(
    'raw',
    secret,
    'HKDF',
    false,
    ['deriveBits']
  );
}

async function deriveHkdfBytes(secretBytes, info, length) {
  const keyMaterial = await importHkdfSecret(secretBytes);
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: HKDF_SALT,
      info: new TextEncoder().encode(info)
    },
    keyMaterial,
    length * 8
  );
  return new Uint8Array(derivedBits);
}

async function signAdvisorSessionPayload(sessionSecret, payloadBytes) {
  const key = await importHmacKey(sessionSecret);
  const signature = await crypto.subtle.sign('HMAC', key, payloadBytes);
  return toBase64Url(new Uint8Array(signature));
}

async function createAdvisorSessionToken(config) {
  const csrfToken = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ADVISOR_SESSION_TTL_MS;
  const payload = {
    sub: 'advisor',
    iat: issuedAt,
    exp: expiresAt,
    csrf: csrfToken
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const payloadB64u = toBase64Url(payloadBytes);
  const signatureB64u = await signAdvisorSessionPayload(config.sessionSecret, payloadBytes);

  return {
    token: `${payloadB64u}.${signatureB64u}`,
    csrfToken,
    expiresAt: new Date(expiresAt).toISOString()
  };
}

async function readAdvisorSession(request, env) {
  const config = getAdvisorAuthConfig(env);
  if (!config.enabled) {
    return {
      authEnabled: false,
      authenticated: false,
      csrfToken: '',
      expiresAt: null
    };
  }

  const cookies = parseCookies(request);
  const token = normalizeEnvValue(cookies.get(ADVISOR_SESSION_COOKIE));
  if (!token) {
    return {
      authEnabled: true,
      authenticated: false,
      csrfToken: '',
      expiresAt: null
    };
  }

  const tokenParts = token.split('.');
  if (tokenParts.length !== 2) {
    return {
      authEnabled: true,
      authenticated: false,
      csrfToken: '',
      expiresAt: null
    };
  }

  try {
    const payloadBytes = fromBase64UrlBytes(tokenParts[0]);
    const expectedSignature = await signAdvisorSessionPayload(config.sessionSecret, payloadBytes);
    const expectedSignatureBytes = new TextEncoder().encode(expectedSignature);
    const actualSignatureBytes = new TextEncoder().encode(tokenParts[1]);
    if (!constantTimeEquals(expectedSignatureBytes, actualSignatureBytes)) {
      return {
        authEnabled: true,
        authenticated: false,
        csrfToken: '',
        expiresAt: null
      };
    }

    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!payload || payload.sub !== 'advisor' || !payload.csrf || Number(payload.exp) <= Date.now()) {
      return {
        authEnabled: true,
        authenticated: false,
        csrfToken: '',
        expiresAt: null
      };
    }

    return {
      authEnabled: true,
      authenticated: true,
      csrfToken: String(payload.csrf),
      expiresAt: new Date(Number(payload.exp)).toISOString()
    };
  } catch (_error) {
    return {
      authEnabled: true,
      authenticated: false,
      csrfToken: '',
      expiresAt: null
    };
  }
}

function buildAdvisorSessionCookie(token, maxAgeSeconds = Math.floor(ADVISOR_SESSION_TTL_MS / 1000)) {
  return `${ADVISOR_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${Math.max(0, maxAgeSeconds)}`;
}

function buildExpiredAdvisorSessionCookie() {
  return `${ADVISOR_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
}

async function deriveAdvisorPasswordHash(password, saltBytes) {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: saltBytes,
      iterations: ADVISOR_AUTH_PBKDF2_ITERATIONS
    },
    passwordKey,
    256
  );
  return new Uint8Array(derivedBits);
}

async function verifyAdvisorPassword(password, config) {
  const normalizedPassword = typeof password === 'string' ? password : '';
  if (!normalizedPassword || normalizedPassword.length > MAX_ADVISOR_PASSWORD_LENGTH) {
    return false;
  }

  if (config.password) {
    const expectedBytes = new TextEncoder().encode(config.password);
    const actualBytes = new TextEncoder().encode(normalizedPassword);
    return constantTimeEquals(expectedBytes, actualBytes);
  }

  const expectedHashBytes = fromBase64UrlBytes(config.passwordHashB64u);
  const saltBytes = fromBase64UrlBytes(config.passwordSaltB64u);
  const actualHashBytes = await deriveAdvisorPasswordHash(normalizedPassword, saltBytes);
  return constantTimeEquals(expectedHashBytes, actualHashBytes);
}

async function importPublishedRecoveryKey(sessionSecret) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${PUBLISHED_RECOVERY_INFO}:${sessionSecret}`)
  );

  return crypto.subtle.importKey(
    'raw',
    digest,
    {
      name: 'AES-GCM',
      length: 256
    },
    false,
    ['encrypt', 'decrypt']
  );
}

async function derivePublishedAuthHash(secretB64u, role) {
  const info = role === 'advisor' ? PUBLISHED_AUTH_INFO.advisor : PUBLISHED_AUTH_INFO.client;
  const secretBytes = fromBase64UrlBytes(secretB64u, MAX_PUBLISHED_RECOVERY_SECRET_B64U_LENGTH);
  if (secretBytes.length !== PUBLISHED_KEY_LENGTH) {
    throw new Error('Published recovery secret is invalid.');
  }
  const capabilityBytes = await deriveHkdfBytes(secretBytes, info, PUBLISHED_KEY_LENGTH);
  return sha256Base64Url(capabilityBytes);
}

async function validatePublishedRecoveryPayload(payload, auth) {
  if (payload === null || typeof payload === 'undefined') {
    return null;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Recovery payload is invalid.');
  }

  const clientSecretB64u = normalizeLeadValue(payload.clientSecretB64u);
  const advisorSecretB64u = normalizeLeadValue(payload.advisorSecretB64u);
  if (!isBase64UrlValue(clientSecretB64u, MAX_PUBLISHED_RECOVERY_SECRET_B64U_LENGTH)) {
    throw new Error('Recovery client secret is invalid.');
  }
  if (!isBase64UrlValue(advisorSecretB64u, MAX_PUBLISHED_RECOVERY_SECRET_B64U_LENGTH)) {
    throw new Error('Recovery advisor secret is invalid.');
  }

  const [clientAuthHashB64u, advisorAuthHashB64u] = await Promise.all([
    derivePublishedAuthHash(clientSecretB64u, 'client'),
    derivePublishedAuthHash(advisorSecretB64u, 'advisor')
  ]);

  if (clientAuthHashB64u !== auth.clientAuthHashB64u) {
    throw new Error('Recovery client secret does not match the published session.');
  }
  if (advisorAuthHashB64u !== auth.advisorAuthHashB64u) {
    throw new Error('Recovery advisor secret does not match the published session.');
  }

  return {
    clientSecretB64u,
    advisorSecretB64u
  };
}

async function encryptPublishedRecoveryPayload(env, recovery) {
  if (!recovery) {
    return null;
  }

  const config = getAdvisorAuthConfig(env);
  if (!config.sessionSecret) {
    return null;
  }

  const key = await importPublishedRecoveryKey(config.sessionSecret);
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(recovery));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes
    },
    key,
    plaintextBytes
  );

  return {
    recoveryPayloadB64u: toBase64Url(new Uint8Array(ciphertext)),
    recoveryIvB64u: toBase64Url(ivBytes)
  };
}

async function decryptPublishedRecoveryPayload(env, row) {
  if (!row?.recoveryPayloadB64u || !row?.recoveryIvB64u) {
    return null;
  }

  const config = getAdvisorAuthConfig(env);
  if (!config.sessionSecret) {
    return null;
  }

  const key = await importPublishedRecoveryKey(config.sessionSecret);
  const ciphertextBytes = fromBase64UrlBytes(row.recoveryPayloadB64u, MAX_PUBLISHED_RECOVERY_PAYLOAD_B64U_LENGTH);
  const ivBytes = fromBase64UrlBytes(row.recoveryIvB64u, 64);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes
    },
    key,
    ciphertextBytes
  );

  const payload = JSON.parse(new TextDecoder().decode(plaintext));
  if (!payload || typeof payload !== 'object') {
    throw new Error('Published recovery payload is invalid.');
  }

  const clientSecretB64u = normalizeLeadValue(payload.clientSecretB64u);
  const advisorSecretB64u = normalizeLeadValue(payload.advisorSecretB64u);
  if (!isBase64UrlValue(clientSecretB64u, MAX_PUBLISHED_RECOVERY_SECRET_B64U_LENGTH)) {
    throw new Error('Published recovery client secret is invalid.');
  }
  if (!isBase64UrlValue(advisorSecretB64u, MAX_PUBLISHED_RECOVERY_SECRET_B64U_LENGTH)) {
    throw new Error('Published recovery advisor secret is invalid.');
  }

  return {
    clientSecretB64u,
    advisorSecretB64u
  };
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

function extractEmailAddress(value) {
  const normalized = normalizeEnvValue(value);
  const match = /<([^<>]+)>/.exec(normalized);
  const candidate = normalizeEnvValue(match ? match[1] : normalized).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : '';
}

function isAllowedPublishedNotificationLinkProtocol(url) {
  if (url.protocol === 'https:') {
    return true;
  }

  return url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

function validatePublishedNotificationLink(value, publishedId, hashKey, label) {
  const normalized = normalizeLeadValue(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_error) {
    throw new Error(`${label} is invalid.`);
  }

  if (!isAllowedPublishedNotificationLinkProtocol(parsed)) {
    throw new Error(`${label} must use HTTPS in production.`);
  }

  const searchKeys = [...parsed.searchParams.keys()];
  if (searchKeys.length !== 1 || searchKeys[0] !== 'pub') {
    throw new Error(`${label} query is invalid.`);
  }

  const publishedParam = normalizeLeadValue(parsed.searchParams.get('pub'));
  if (publishedParam !== publishedId) {
    throw new Error(`${label} does not match this session.`);
  }

  const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  const hashParams = new URLSearchParams(hash);
  const hashKeys = [...hashParams.keys()];
  if (hashKeys.length !== 1 || hashKeys[0] !== hashKey) {
    throw new Error(`${label} hash is invalid.`);
  }

  const capability = normalizeLeadValue(hashParams.get(hashKey));
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(capability)) {
    throw new Error(`${label} key is invalid.`);
  }

  return {
    href: parsed.toString(),
    host: parsed.hostname.toLowerCase(),
    path: normalizePathname(parsed.pathname)
  };
}

function validatePublishedAdvisorLink(value, publishedId) {
  return validatePublishedNotificationLink(value, publishedId, 'ak', 'Advisor reopen link');
}

function validateOptionalPublishedClientNotificationLink(value, publishedId) {
  const normalized = normalizeLeadValue(value);
  if (!normalized) {
    return null;
  }

  return validatePublishedNotificationLink(normalized, publishedId, 'ck', 'Client link');
}

function validatePublishedClientLink(value, publishedId) {
  const normalized = normalizeLeadValue(value);
  if (!normalized) {
    throw new Error('Client link is required to send this email.');
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_error) {
    throw new Error('Client link is invalid.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Client link must use HTTPS.');
  }

  if (!PUBLISHED_CLIENT_LINK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('Client link host is not allowed.');
  }

  const normalizedPath = normalizePathname(parsed.pathname);
  if (!PUBLISHED_CLIENT_LINK_PATHS.has(normalizedPath)) {
    throw new Error('Client link path is invalid.');
  }

  const searchKeys = [...parsed.searchParams.keys()];
  if (searchKeys.length !== 1 || searchKeys[0] !== 'pub') {
    throw new Error('Client link query is invalid.');
  }

  const publishedParam = normalizeLeadValue(parsed.searchParams.get('pub'));
  if (publishedParam !== publishedId) {
    throw new Error('Client link does not match this session.');
  }

  const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  const hashParams = new URLSearchParams(hash);
  const hashKeys = [...hashParams.keys()];
  if (hashKeys.length !== 1 || hashKeys[0] !== 'ck') {
    throw new Error('Client link hash is invalid.');
  }

  const clientSecret = normalizeLeadValue(hashParams.get('ck'));
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(clientSecret)) {
    throw new Error('Client link key is invalid.');
  }

  return {
    href: parsed.toString(),
    host: parsed.hostname.toLowerCase(),
    path: normalizedPath
  };
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

function buildPlaneirEmailCardHtml() {
  return `
        <div style="margin:28px 0 0;padding-top:20px;border-top:1px solid #d9e2ea;">
          <a href="${PLANEIR_SITE_URL}/" style="display:block;text-decoration:none;">
            <img
              src="${PLANEIR_EMAIL_CARD_URL}"
              alt="${PLANEIR_EMAIL_CARD_ALT}"
              width="560"
              height="294"
              style="display:block;width:100%;max-width:560px;height:auto;margin:0 auto;border:0;border-radius:16px;"
            />
          </a>
        </div>
  `;
}

function buildPlaneirEmailCardText() {
  return [
    '',
    'Planeir - Irish financial education calls',
    `${PLANEIR_SITE_URL}/`,
    'Educational only, not financial advice.'
  ].join('\n');
}

function buildLeadSummaryRows(lead, leadId) {
  return [
    ['Lead ID', leadId ? String(leadId) : 'Not available'],
    ['Full name', formatOptionalText(lead.fullName)],
    ['Email', formatOptionalText(lead.email)],
    ['Phone', formatOptionalText(lead.phone)],
    ['Planning stage', formatLeadSelection(lead.stage, LEAD_STAGE_LABELS)],
    ['Requested outcome', formatLeadSelection(lead.callOutcome, CALL_OUTCOME_LABELS)],
    ['Availability notes', formatOptionalText(lead.availabilityNotes)],
    ['Understands this is a free recorded call', formatLeadConsent(lead.understandsRecordedCall)],
    ['Understands Planeir uses their scenario for financial education only', formatLeadConsent(lead.understandsEducationalOnly)],
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
    formatOptionalText(lead.reason),
    buildPlaneirEmailCardText()
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
        ${buildPlaneirEmailCardHtml()}
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
    'Gerry has received your request for a free financial education call and will review it shortly.',
    'If the request looks like a good fit for the format, you will hear back.',
    'Planeir uses real scenarios for education and explanation only. It does not sell products or provide regulated financial advice, tax advice, legal advice, or product recommendations.',
    '',
    'Best,',
    'Planeir',
    buildPlaneirEmailCardText()
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
          Gerry has received your request for a free financial education call and will review it shortly.
        </p>
        <p style="margin:0 0 16px;">
          If the request looks like a good fit for the format, you will hear back.
        </p>
        <p style="margin:0 0 16px;">
          Planeir uses real scenarios for education and explanation only. It does not sell products or provide regulated financial advice, tax advice, legal advice, or product recommendations.
        </p>
        <p style="margin:0;">Best,<br />Planeir</p>
        ${buildPlaneirEmailCardHtml()}
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
  const advisorCopyRecipients = splitEmailList(env.LEAD_ADVISOR_COPY_TO);
  const confirmationEnabled = isTruthyEnvValue(env.LEAD_CONFIRMATION_EMAIL_ENABLED);

  return {
    apiKey,
    from,
    notificationRecipients,
    advisorCopyRecipients: advisorCopyRecipients.length > 0 ? advisorCopyRecipients : notificationRecipients,
    replyTo,
    publicReplyTo: replyTo || extractEmailAddress(from),
    confirmationEnabled
  };
}

function getZoomConfig(env) {
  const accountId = normalizeEnvValue(env.ZOOM_ACCOUNT_ID);
  const clientId = normalizeEnvValue(env.ZOOM_CLIENT_ID);
  const clientSecret = normalizeEnvValue(env.ZOOM_CLIENT_SECRET);
  const userId = normalizeEnvValue(env.ZOOM_USER_ID);

  return {
    accountId,
    clientId,
    clientSecret,
    userId,
    enabled: Boolean(accountId && clientId && clientSecret && userId)
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

async function fetchZoomAccessToken(config) {
  const tokenUrl = new URL(ZOOM_OAUTH_TOKEN_URL);
  tokenUrl.searchParams.set('grant_type', 'account_credentials');
  tokenUrl.searchParams.set('account_id', config.accountId);
  const authorization = toBase64(new TextEncoder().encode(`${config.clientId}:${config.clientSecret}`));
  const response = await fetch(tokenUrl.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authorization}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  const responseText = await response.text();
  let data = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch (_error) {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.reason || data?.message || data?.error || `Zoom token request failed with status ${response.status}.`);
  }

  const accessToken = normalizeEnvValue(data?.access_token);
  if (!accessToken) {
    throw new Error('Zoom token response did not include an access token.');
  }

  return accessToken;
}

function getLeadScheduleDurationMinutes(schedule) {
  const startMs = Date.parse(schedule.scheduledStartAt);
  const endMs = Date.parse(schedule.scheduledEndAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return DEFAULT_LEAD_SCHEDULE_DURATION_MINUTES;
  }

  return Math.max(1, Math.round((endMs - startMs) / 60000));
}

async function createZoomMeeting(env, lead, schedule) {
  const config = getZoomConfig(env);
  if (!config.enabled) {
    throw new Error('Zoom meeting creation is not configured. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, and ZOOM_USER_ID.');
  }

  const accessToken = await fetchZoomAccessToken(config);
  const userId = encodeURIComponent(config.userId);
  const response = await fetch(`${ZOOM_API_BASE_URL}/users/${userId}/meetings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      topic: 'Planeir education call with Gerry',
      type: 2,
      start_time: schedule.scheduledStartAt,
      duration: getLeadScheduleDurationMinutes(schedule),
      timezone: schedule.scheduledTimezone || DEFAULT_LEAD_SCHEDULE_TIMEZONE,
      agenda: `Free Planeir education call with ${lead.fullName || 'client'}. Educational only, not financial advice.`,
      settings: {
        join_before_host: false,
        waiting_room: true,
        mute_upon_entry: true,
        approval_type: 2,
        audio: 'voip',
        auto_recording: 'none'
      }
    })
  });

  const responseText = await response.text();
  let data = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch (_error) {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.message || data?.reason || data?.error || `Zoom meeting creation failed with status ${response.status}.`);
  }

  const joinUrl = normalizeEnvValue(data?.join_url);
  if (!joinUrl) {
    throw new Error('Zoom created the meeting but did not return a join URL.');
  }

  return {
    zoomMeetingId: data?.id ? String(data.id) : '',
    zoomJoinUrl: joinUrl,
    zoomMeetingPassword: normalizeEnvValue(data?.password),
    zoomCreatedAt: nowIso()
  };
}

async function sendLeadEmails(env, lead, leadId) {
  const config = getLeadEmailConfig(env);

  if (!config.apiKey || !config.from) {
    console.warn('Lead email sending skipped because provider credentials are not configured.');
    return;
  }

  if (config.notificationRecipients.length > 0) {
    try {
      const notificationResult = await sendEmailWithResend(config, {
        from: config.from,
        to: config.notificationRecipients,
        subject: `New Planeir call request: ${lead.fullName}`,
        html: buildLeadNotificationHtml(lead, leadId),
        text: buildLeadNotificationText(lead, leadId),
        reply_to: lead.email
      }, buildEmailIdempotencyKey(leadId, lead.createdAt, 'internal'));
      console.log('Lead internal notification email accepted', {
        leadId,
        resendEmailId: notificationResult?.id || null,
        recipients: config.notificationRecipients
      });
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
    const confirmationResult = await sendEmailWithResend(config, {
      from: config.from,
      to: [lead.email],
      subject: 'We received your Planeir call request',
      html: buildLeadConfirmationHtml(lead),
      text: buildLeadConfirmationText(lead),
      reply_to: config.replyTo || undefined
    }, buildEmailIdempotencyKey(leadId, lead.createdAt, 'confirmation'));
    console.log('Lead confirmation email accepted', {
      leadId,
      email: lead.email,
      resendEmailId: confirmationResult?.id || null
    });
  } catch (error) {
    console.error('Lead confirmation email failed', {
      leadId,
      email: lead.email,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function formatLeadStatus(status) {
  return LEAD_STATUS_LABELS[status] || LEAD_STATUS_LABELS.new;
}

function normalizeLeadRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || row.created_at || '',
    fullName: row.full_name || '',
    email: row.email || '',
    phone: row.phone || '',
    reason: row.help_reason || '',
    stage: row.stage || '',
    callOutcome: row.call_outcome || '',
    availabilityNotes: row.availability_notes || '',
    status: normalizeLeadStatus(row.status, 'new'),
    advisorNotes: row.advisor_notes || '',
    scheduledStartAt: row.scheduled_start_at || '',
    scheduledEndAt: row.scheduled_end_at || '',
    scheduledTimezone: row.scheduled_timezone || DEFAULT_LEAD_SCHEDULE_TIMEZONE,
    scheduledLocation: row.scheduled_location || '',
    scheduledMessage: row.scheduled_message || '',
    scheduleInviteUid: row.schedule_invite_uid || '',
    scheduleResponseToken: row.schedule_response_token || '',
    scheduleResponseStatus: normalizeScheduleResponseStatus(row.schedule_response_status),
    scheduleResponseAt: row.schedule_response_at || '',
    scheduleResponseExpiresAt: row.schedule_response_expires_at || '',
    zoomMeetingId: row.zoom_meeting_id || '',
    zoomJoinUrl: row.zoom_join_url || '',
    zoomMeetingPassword: row.zoom_meeting_password || '',
    zoomCreatedAt: row.zoom_created_at || '',
    lastScheduleEmailSentAt: row.last_schedule_email_sent_at || '',
    scheduleEmailSendCount: Number(row.schedule_email_send_count || 0),
    understandsRecordedCall: Boolean(Number(row.consent_free_call || 0)),
    understandsEducationalOnly: Boolean(Number(row.consent_education_only || 0)),
    understandsEducationalContent: Boolean(Number(row.consent_recording || 0)),
    source: row.source || 'landing-page'
  };
}

function buildLeadManagerSummary(lead) {
  return {
    id: lead.id,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
    fullName: lead.fullName,
    email: lead.email,
    phone: lead.phone,
    reasonPreview: lead.reason.length > 180 ? `${lead.reason.slice(0, 177)}...` : lead.reason,
    stage: lead.stage,
    stageLabel: formatLeadSelection(lead.stage, LEAD_STAGE_LABELS),
    callOutcome: lead.callOutcome,
    callOutcomeLabel: formatLeadSelection(lead.callOutcome, CALL_OUTCOME_LABELS),
    availabilityNotes: lead.availabilityNotes,
    status: lead.status,
    statusLabel: formatLeadStatus(lead.status),
    scheduledStartAt: lead.scheduledStartAt,
    scheduledEndAt: lead.scheduledEndAt,
    scheduledTimezone: lead.scheduledTimezone,
    scheduledLocation: lead.scheduledLocation,
    scheduleResponseStatus: lead.scheduleResponseStatus,
    scheduleResponseAt: lead.scheduleResponseAt,
    scheduleResponseExpiresAt: lead.scheduleResponseExpiresAt,
    zoomMeetingId: lead.zoomMeetingId,
    zoomJoinUrl: lead.zoomJoinUrl,
    zoomMeetingPassword: lead.zoomMeetingPassword,
    zoomCreatedAt: lead.zoomCreatedAt,
    lastScheduleEmailSentAt: lead.lastScheduleEmailSentAt,
    scheduleEmailSendCount: lead.scheduleEmailSendCount
  };
}

function buildLeadManagerDetail(lead, events = []) {
  return {
    ...buildLeadManagerSummary(lead),
    reason: lead.reason,
    advisorNotes: lead.advisorNotes,
    scheduledMessage: lead.scheduledMessage,
    scheduleInviteUid: lead.scheduleInviteUid,
    understandsRecordedCall: lead.understandsRecordedCall,
    understandsEducationalOnly: lead.understandsEducationalOnly,
    understandsEducationalContent: lead.understandsEducationalContent,
    source: lead.source,
    events
  };
}

function validateLeadId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function validateLeadStatus(value) {
  const normalized = normalizeLeadValue(value).toLowerCase();
  if (!ALLOWED_LEAD_STATUSES.has(normalized)) {
    throw new Error('Lead status is invalid.');
  }

  return normalized;
}

function validateLeadScheduleValues(payload, currentLead = {}, options = {}) {
  const { requireSchedule = false } = options;
  const scheduledStartAt = hasOwn(payload, 'scheduledStartAt')
    ? normalizeOptionalIsoDate(payload.scheduledStartAt, 'Scheduled start')
    : (currentLead.scheduledStartAt || '');
  const scheduledEndAt = hasOwn(payload, 'scheduledEndAt')
    ? normalizeOptionalIsoDate(payload.scheduledEndAt, 'Scheduled end')
    : (currentLead.scheduledEndAt || '');

  if (requireSchedule && !scheduledStartAt) {
    throw new Error('Choose a call date and time before sending.');
  }

  if ((scheduledStartAt && !scheduledEndAt) || (!scheduledStartAt && scheduledEndAt)) {
    throw new Error('Scheduled start and end are both required.');
  }

  if (scheduledStartAt && Date.parse(scheduledEndAt) <= Date.parse(scheduledStartAt)) {
    throw new Error('Scheduled end must be after the scheduled start.');
  }

  const scheduledTimezone = hasOwn(payload, 'scheduledTimezone')
    ? (normalizeLeadValue(payload.scheduledTimezone) || DEFAULT_LEAD_SCHEDULE_TIMEZONE)
    : (currentLead.scheduledTimezone || DEFAULT_LEAD_SCHEDULE_TIMEZONE);
  if (scheduledTimezone !== DEFAULT_LEAD_SCHEDULE_TIMEZONE) {
    throw new Error('Only Europe/Dublin scheduling is supported right now.');
  }

  const scheduledLocation = hasOwn(payload, 'scheduledLocation')
    ? normalizeLongText(payload.scheduledLocation)
    : (currentLead.scheduledLocation || '');
  if (scheduledLocation.length > MAX_LEAD_SCHEDULE_LOCATION_LENGTH) {
    throw new Error('Meeting location is too long.');
  }

  const scheduledMessage = hasOwn(payload, 'scheduledMessage')
    ? normalizeLongText(payload.scheduledMessage)
    : (currentLead.scheduledMessage || '');
  if (scheduledMessage.length > MAX_LEAD_SCHEDULE_MESSAGE_LENGTH) {
    throw new Error('Schedule message is too long.');
  }

  return {
    scheduledStartAt,
    scheduledEndAt,
    scheduledTimezone,
    scheduledLocation,
    scheduledMessage
  };
}

function validateAdvisorLeadUpdatePayload(payload, currentLead) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be a JSON object.');
  }

  const status = hasOwn(payload, 'status')
    ? validateLeadStatus(payload.status)
    : currentLead.status;
  const advisorNotes = hasOwn(payload, 'advisorNotes')
    ? normalizeLongText(payload.advisorNotes)
    : currentLead.advisorNotes;
  const availabilityNotes = hasOwn(payload, 'availabilityNotes')
    ? normalizeLongText(payload.availabilityNotes)
    : currentLead.availabilityNotes;

  if (advisorNotes.length > MAX_LEAD_ADVISOR_NOTES_LENGTH) {
    throw new Error('Advisor notes are too long.');
  }

  if (availabilityNotes.length > MAX_LEAD_AVAILABILITY_LENGTH) {
    throw new Error('Availability notes are too long.');
  }

  return {
    status,
    advisorNotes,
    availabilityNotes,
    ...validateLeadScheduleValues(payload, currentLead)
  };
}

function buildDefaultLeadScheduleMessage(lead, schedule) {
  const firstName = normalizeLeadValue(lead.fullName).split(/\s+/)[0] || 'there';
  return [
    `Hi ${firstName},`,
    '',
    'Thanks again for your Planeir request.',
    '',
    'I can offer the following time for the free education call:',
    '',
    formatLeadScheduleRange(schedule),
    '',
    'The calendar invite is attached and includes the Zoom link. Please use the accept link in this email within 48 hours so I know the slot is confirmed. If it does not suit, use the other link and I will suggest another option.',
    '',
    'Planeir uses real scenarios for education and explanation only. It does not sell products or provide regulated financial advice, tax advice, legal advice, or product recommendations.',
    '',
    'Best,',
    'Gerry',
    'Planeir'
  ].join('\n');
}

function formatLeadScheduleRange(schedule) {
  const start = new Date(schedule.scheduledStartAt);
  const end = new Date(schedule.scheduledEndAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 'Time to be confirmed';
  }

  const dateText = start.toLocaleDateString('en-IE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: schedule.scheduledTimezone || DEFAULT_LEAD_SCHEDULE_TIMEZONE
  });
  const timeFormatter = new Intl.DateTimeFormat('en-IE', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: schedule.scheduledTimezone || DEFAULT_LEAD_SCHEDULE_TIMEZONE
  });

  return `${dateText}, ${timeFormatter.format(start)}-${timeFormatter.format(end)} (${schedule.scheduledTimezone || DEFAULT_LEAD_SCHEDULE_TIMEZONE})`;
}

function getLeadScheduleLocation(schedule) {
  return schedule.zoomJoinUrl || schedule.scheduledLocation || DEFAULT_LEAD_SCHEDULE_LOCATION;
}

function getLeadScheduleZoomTextLines(schedule) {
  const lines = [];
  if (schedule.zoomJoinUrl) {
    lines.push(`Zoom link: ${schedule.zoomJoinUrl}`);
  }
  if (schedule.zoomMeetingId) {
    lines.push(`Meeting ID: ${schedule.zoomMeetingId}`);
  }
  if (schedule.zoomMeetingPassword) {
    lines.push(`Passcode: ${schedule.zoomMeetingPassword}`);
  }
  return lines;
}

function buildLeadScheduleZoomHtmlRows(schedule) {
  const rows = [];
  if (schedule.zoomJoinUrl) {
    rows.push(['Zoom link', `<a href="${escapeHtml(schedule.zoomJoinUrl)}" style="color:#0b66c3;">${escapeHtml(schedule.zoomJoinUrl)}</a>`]);
  }
  if (schedule.zoomMeetingId) {
    rows.push(['Meeting ID', escapeHtml(schedule.zoomMeetingId)]);
  }
  if (schedule.zoomMeetingPassword) {
    rows.push(['Passcode', escapeHtml(schedule.zoomMeetingPassword)]);
  }

  return rows.map(([label, value]) => `
          <tr>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;background:#f7fafc;font-weight:600;vertical-align:top;">${label}</td>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;vertical-align:top;">${value}</td>
          </tr>`).join('');
}

function formatLeadScheduleExpiry(schedule) {
  if (!schedule.scheduleResponseExpiresAt) {
    return '48 hours';
  }

  const parsed = new Date(schedule.scheduleResponseExpiresAt);
  if (Number.isNaN(parsed.getTime())) {
    return '48 hours';
  }

  return parsed.toLocaleString('en-IE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: schedule.scheduledTimezone || DEFAULT_LEAD_SCHEDULE_TIMEZONE
  });
}

function getLeadScheduleResponseTextLines(schedule) {
  if (!schedule.acceptUrl || !schedule.declineUrl) {
    return [];
  }

  return [
    'Please confirm whether this time works within 48 hours. If it is not accepted within 48 hours, the proposed slot will be released and will not be treated as booked.',
    `Accept this time: ${schedule.acceptUrl}`,
    `Does not suit: ${schedule.declineUrl}`,
    `Response deadline: ${formatLeadScheduleExpiry(schedule)}`
  ];
}

function buildLeadScheduleResponseHtml(schedule) {
  if (!schedule.acceptUrl || !schedule.declineUrl) {
    return '';
  }

  return `
        <div style="margin:24px 0;padding:18px;border:1px solid #d9e2ea;border-radius:14px;background:#f7fafc;">
          <p style="margin:0 0 14px;font-weight:700;">Please confirm this proposed time within 48 hours.</p>
          <p style="margin:0 0 16px;color:#52606d;">If it is not accepted within 48 hours, the proposed slot will be released and will not be treated as booked.</p>
          <p style="margin:0 0 10px;">
            <a href="${escapeHtml(schedule.acceptUrl)}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#0f2233;color:#ffffff;text-decoration:none;font-weight:700;">Accept proposed time</a>
          </p>
          <p style="margin:0;">
            <a href="${escapeHtml(schedule.declineUrl)}" style="display:inline-block;padding:10px 16px;border-radius:999px;border:1px solid #bcccdc;color:#102a43;text-decoration:none;font-weight:700;">This does not suit</a>
          </p>
          <p style="margin:14px 0 0;color:#52606d;font-size:13px;">Response deadline: ${escapeHtml(formatLeadScheduleExpiry(schedule))}</p>
        </div>`;
}

function buildLeadScheduleEmailText(lead, schedule) {
  const zoomLines = getLeadScheduleZoomTextLines(schedule);
  const responseLines = getLeadScheduleResponseTextLines(schedule);
  return [
    schedule.scheduledMessage,
    '',
    'Call details:',
    `Time: ${formatLeadScheduleRange(schedule)}`,
    `Location: ${getLeadScheduleLocation(schedule)}`,
    ...zoomLines,
    ...(responseLines.length > 0 ? ['', ...responseLines] : []),
    '',
    'Educational only, not financial advice.',
    buildPlaneirEmailCardText()
  ].join('\n');
}

function buildLeadScheduleEmailHtml(lead, schedule) {
  const paragraphs = normalizeLongText(schedule.scheduledMessage)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.split('\n').map(escapeHtml).join('<br />'))
    .map((paragraph) => `<p style="margin:0 0 16px;">${paragraph}</p>`)
    .join('');

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f1f5f9;color:#102a43;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #d9e2ea;border-radius:16px;overflow:hidden;">
      <div style="padding:24px;background:#0f2233;color:#ffffff;">
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.82;">Planeir education call</p>
        <h1 style="margin:0;font-size:24px;line-height:1.25;">Proposed call time with Gerry</h1>
      </div>
      <div style="padding:24px;font-size:15px;line-height:1.7;">
        ${paragraphs}
        <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;line-height:1.5;">
          <tr>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;background:#f7fafc;font-weight:600;vertical-align:top;">Time</td>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;vertical-align:top;">${escapeHtml(formatLeadScheduleRange(schedule))}</td>
          </tr>
          <tr>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;background:#f7fafc;font-weight:600;vertical-align:top;">Location</td>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;vertical-align:top;">${escapeHtml(getLeadScheduleLocation(schedule))}</td>
          </tr>
          ${buildLeadScheduleZoomHtmlRows(schedule)}
        </table>
        ${buildLeadScheduleResponseHtml(schedule)}
        <p style="margin:0;color:#52606d;">A calendar invite is attached to this email.</p>
        ${buildPlaneirEmailCardHtml()}
      </div>
    </div>
  </body>
</html>`;
}

function buildLeadScheduleAdvisorCopyText(lead, schedule) {
  return [
    `Schedule email sent to ${lead.fullName}`,
    '',
    `Client email: ${lead.email}`,
    `Time: ${formatLeadScheduleRange(schedule)}`,
    `Location: ${getLeadScheduleLocation(schedule)}`,
    ...getLeadScheduleZoomTextLines(schedule),
    '',
    'Message sent:',
    schedule.scheduledMessage
  ].join('\n');
}

function buildLeadScheduleAdvisorCopyHtml(lead, schedule) {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f1f5f9;color:#102a43;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #d9e2ea;border-radius:16px;overflow:hidden;">
      <div style="padding:24px;background:#0f2233;color:#ffffff;">
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.82;">Planeir advisor copy</p>
        <h1 style="margin:0;font-size:24px;line-height:1.25;">Schedule email sent to ${escapeHtml(lead.fullName)}</h1>
      </div>
      <div style="padding:24px;font-size:15px;line-height:1.7;">
        <p style="margin:0 0 12px;"><strong>Client:</strong> ${escapeHtml(lead.fullName)} &lt;${escapeHtml(lead.email)}&gt;</p>
        <p style="margin:0 0 12px;"><strong>Time:</strong> ${escapeHtml(formatLeadScheduleRange(schedule))}</p>
        <p style="margin:0 0 18px;"><strong>Location:</strong> ${escapeHtml(getLeadScheduleLocation(schedule))}</p>
        ${schedule.zoomJoinUrl ? `<p style="margin:0 0 12px;"><strong>Zoom link:</strong> <a href="${escapeHtml(schedule.zoomJoinUrl)}" style="color:#0b66c3;">${escapeHtml(schedule.zoomJoinUrl)}</a></p>` : ''}
        ${schedule.zoomMeetingId ? `<p style="margin:0 0 12px;"><strong>Meeting ID:</strong> ${escapeHtml(schedule.zoomMeetingId)}</p>` : ''}
        ${schedule.zoomMeetingPassword ? `<p style="margin:0 0 18px;"><strong>Passcode:</strong> ${escapeHtml(schedule.zoomMeetingPassword)}</p>` : ''}
        <h2 style="margin:0 0 10px;font-size:18px;">Message sent</h2>
        <div style="padding:16px;border:1px solid #d9e2ea;border-radius:12px;background:#f7fafc;white-space:pre-wrap;">${escapeHtml(schedule.scheduledMessage)}</div>
      </div>
    </div>
  </body>
</html>`;
}

function formatIcsDate(value) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcsText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function foldIcsLine(line) {
  const value = String(line);
  const chunks = [];
  for (let index = 0; index < value.length; index += 73) {
    chunks.push(`${index === 0 ? '' : ' '}${value.slice(index, index + 73)}`);
  }
  return chunks.join('\r\n');
}

function buildLeadScheduleIcs(lead, schedule, config) {
  const organizerEmail = config.publicReplyTo || extractEmailAddress(config.from) || 'hello@planeir.ie';
  const zoomTextLines = getLeadScheduleZoomTextLines(schedule);
  const description = [
    schedule.scheduledMessage,
    '',
    ...zoomTextLines,
    ...(zoomTextLines.length > 0 ? [''] : []),
    'Planeir uses real scenarios for education and explanation only. It does not sell products or provide regulated financial advice, tax advice, legal advice, or product recommendations.'
  ].join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Planeir//Lead Scheduling//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${schedule.scheduleInviteUid}`,
    `DTSTAMP:${formatIcsDate(nowIso())}`,
    `DTSTART:${formatIcsDate(schedule.scheduledStartAt)}`,
    `DTEND:${formatIcsDate(schedule.scheduledEndAt)}`,
    'SUMMARY:Planeir education call with Gerry',
    `DESCRIPTION:${escapeIcsText(description)}`,
    `LOCATION:${escapeIcsText(getLeadScheduleLocation(schedule))}`,
    ...(schedule.zoomJoinUrl ? [`URL:${escapeIcsText(schedule.zoomJoinUrl)}`] : []),
    `ORGANIZER;CN=Planeir:mailto:${organizerEmail}`,
    `ATTENDEE;CN=${escapeIcsText(lead.fullName)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${lead.email}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ];

  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

function buildLeadScheduleIdempotencyKey(leadId, schedule, kind) {
  const base = [
    'lead',
    leadId,
    'schedule',
    kind,
    schedule.scheduledStartAt,
    schedule.scheduledEndAt,
    schedule.scheduleResponseToken || schedule.scheduleInviteUid || ''
  ].join('-');
  return base.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 240);
}

async function sendLeadScheduleEmails(env, lead, schedule) {
  const config = getLeadEmailConfig(env);
  if (!config.apiKey || !config.from) {
    throw new Error('Lead schedule email delivery is not configured.');
  }

  const icsContent = buildLeadScheduleIcs(lead, schedule, config);
  const calendarAttachment = {
    filename: 'planeir-call.ics',
    content: toBase64(new TextEncoder().encode(icsContent))
  };
  const clientResult = await sendEmailWithResend(config, {
    from: config.from,
    to: [lead.email],
    subject: 'Your Planeir education call time',
    html: buildLeadScheduleEmailHtml(lead, schedule),
    text: buildLeadScheduleEmailText(lead, schedule),
    reply_to: config.publicReplyTo || undefined,
    attachments: [calendarAttachment]
  }, buildLeadScheduleIdempotencyKey(lead.id, schedule, 'client'));

  let advisorCopyResult = null;
  let advisorCopyError = '';
  if (config.advisorCopyRecipients.length > 0) {
    try {
      advisorCopyResult = await sendEmailWithResend(config, {
        from: config.from,
        to: config.advisorCopyRecipients,
        subject: `Advisor copy: Planeir call time sent to ${lead.fullName}`,
        html: buildLeadScheduleAdvisorCopyHtml(lead, schedule),
        text: buildLeadScheduleAdvisorCopyText(lead, schedule),
        reply_to: config.publicReplyTo || undefined,
        attachments: [calendarAttachment]
      }, buildLeadScheduleIdempotencyKey(lead.id, schedule, 'advisor'));
    } catch (error) {
      advisorCopyError = error instanceof Error ? error.message : String(error);
      console.error('Lead schedule advisor copy email failed', {
        leadId: lead.id,
        error: advisorCopyError
      });
    }
  }

  return {
    clientResendEmailId: clientResult?.id || null,
    advisorCopyResendEmailId: advisorCopyResult?.id || null,
    advisorCopySent: Boolean(advisorCopyResult?.id),
    advisorCopyError
  };
}

function getPublishedSessionsDb(env) {
  if (!env.LEADS_DB) {
    throw new Error('Published session database is not configured.');
  }

  return env.LEADS_DB;
}

async function getLeadRow(env, leadId) {
  const db = getPublishedSessionsDb(env);
  const row = await db.prepare(`
    SELECT
      id,
      created_at,
      full_name,
      email,
      phone,
      help_reason,
      stage,
      call_outcome,
      consent_free_call,
      consent_education_only,
      consent_recording,
      source,
      status,
      advisor_notes,
      availability_notes,
      scheduled_start_at,
      scheduled_end_at,
      scheduled_timezone,
      scheduled_location,
      scheduled_message,
      schedule_invite_uid,
      schedule_response_token,
      schedule_response_status,
      schedule_response_at,
      schedule_response_expires_at,
      zoom_meeting_id,
      zoom_join_url,
      zoom_meeting_password,
      zoom_created_at,
      last_schedule_email_sent_at,
      schedule_email_send_count,
      updated_at
    FROM leads
    WHERE id = ?
    LIMIT 1
  `).bind(leadId).first();

  return normalizeLeadRow(row);
}

async function listLeadRows(env, options = {}) {
  const db = getPublishedSessionsDb(env);
  const query = normalizeLeadValue(options.query).toLowerCase();
  const status = normalizeLeadValue(options.status).toLowerCase();
  const limit = Math.min(Math.max(Number(options.limit) || 60, 1), 120);
  const bindings = [];
  const where = [];

  if (query) {
    const likeValue = `%${query}%`;
    where.push(`(
      LOWER(full_name) LIKE ?
      OR LOWER(email) LIKE ?
      OR LOWER(COALESCE(phone, '')) LIKE ?
      OR LOWER(help_reason) LIKE ?
      OR LOWER(COALESCE(availability_notes, '')) LIKE ?
    )`);
    bindings.push(likeValue, likeValue, likeValue, likeValue, likeValue);
  }

  if (status && status !== 'all') {
    if (!ALLOWED_LEAD_STATUSES.has(status)) {
      throw new Error('Lead status filter is invalid.');
    }
    where.push('status = ?');
    bindings.push(status);
  }

  const sql = `
    SELECT
      id,
      created_at,
      full_name,
      email,
      phone,
      help_reason,
      stage,
      call_outcome,
      consent_free_call,
      consent_education_only,
      consent_recording,
      source,
      status,
      advisor_notes,
      availability_notes,
      scheduled_start_at,
      scheduled_end_at,
      scheduled_timezone,
      scheduled_location,
      scheduled_message,
      schedule_invite_uid,
      schedule_response_token,
      schedule_response_status,
      schedule_response_at,
      schedule_response_expires_at,
      zoom_meeting_id,
      zoom_join_url,
      zoom_meeting_password,
      zoom_created_at,
      last_schedule_email_sent_at,
      schedule_email_send_count,
      updated_at
    FROM leads
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY
      CASE status
        WHEN 'new' THEN 0
        WHEN 'reviewing' THEN 1
        WHEN 'awaiting-client' THEN 2
        WHEN 'booked' THEN 3
        WHEN 'declined' THEN 4
        WHEN 'archived' THEN 5
        ELSE 6
      END,
      COALESCE(updated_at, created_at) DESC,
      id DESC
    LIMIT ?
  `;

  bindings.push(limit);
  const result = await db.prepare(sql).bind(...bindings).all();
  return (Array.isArray(result?.results) ? result.results : []).map(normalizeLeadRow);
}

async function listLeadEvents(env, leadId) {
  const db = getPublishedSessionsDb(env);
  const result = await db.prepare(`
    SELECT id, lead_id, actor_type, event_type, created_at, metadata_json
    FROM lead_events
    WHERE lead_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 40
  `).bind(leadId).all();

  return (Array.isArray(result?.results) ? result.results : []).map((row) => {
    let metadata = null;
    try {
      metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null;
    } catch (_error) {
      metadata = null;
    }

    return {
      id: Number(row.id),
      leadId: Number(row.lead_id),
      actorType: row.actor_type,
      eventType: row.event_type,
      createdAt: row.created_at,
      metadata
    };
  });
}

async function insertLeadEvent(env, leadId, actorType, eventType, metadata) {
  const db = getPublishedSessionsDb(env);
  await db.prepare(`
    INSERT INTO lead_events (
      lead_id,
      actor_type,
      event_type,
      created_at,
      metadata_json
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    leadId,
    actorType,
    eventType,
    nowIso(),
    metadata ? JSON.stringify(metadata) : null
  ).run();
}

function createLeadScheduleResponseToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function getLeadScheduleResponseExpiresAt() {
  return new Date(Date.now() + LEAD_SCHEDULE_RESPONSE_TTL_MS).toISOString();
}

function buildLeadScheduleResponseUrl(baseUrl, leadId, token, response) {
  const url = new URL('/api/leads/schedule-response', baseUrl);
  url.searchParams.set('lead', String(leadId));
  url.searchParams.set('token', token);
  url.searchParams.set('response', response);
  return url.toString();
}

async function updateLeadWorkflow(env, leadId, values, eventMetadata = null) {
  const db = getPublishedSessionsDb(env);
  const updatedAt = nowIso();
  await db.prepare(`
    UPDATE leads
    SET
      status = ?,
      advisor_notes = ?,
      availability_notes = ?,
      scheduled_start_at = ?,
      scheduled_end_at = ?,
      scheduled_timezone = ?,
      scheduled_location = ?,
      scheduled_message = ?,
      updated_at = ?
    WHERE id = ?
  `).bind(
    values.status,
    values.advisorNotes || null,
    values.availabilityNotes || null,
    values.scheduledStartAt || null,
    values.scheduledEndAt || null,
    values.scheduledTimezone || DEFAULT_LEAD_SCHEDULE_TIMEZONE,
    values.scheduledLocation || null,
    values.scheduledMessage || null,
    updatedAt,
    leadId
  ).run();

  if (eventMetadata) {
    await insertLeadEvent(env, leadId, 'advisor', 'lead-updated', {
      ...eventMetadata,
      status: values.status,
      updatedAt
    }).catch((error) => {
      console.error('Failed to record lead update event', {
        leadId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
}

async function recordLeadScheduleEmailSent(env, leadId, values) {
  const db = getPublishedSessionsDb(env);
  await db.prepare(`
    UPDATE leads
    SET
      status = 'awaiting-client',
      advisor_notes = ?,
      availability_notes = ?,
      scheduled_start_at = ?,
      scheduled_end_at = ?,
      scheduled_timezone = ?,
      scheduled_location = ?,
      scheduled_message = ?,
      schedule_invite_uid = ?,
      schedule_response_token = ?,
      schedule_response_status = 'pending',
      schedule_response_at = NULL,
      schedule_response_expires_at = ?,
      zoom_meeting_id = ?,
      zoom_join_url = ?,
      zoom_meeting_password = ?,
      zoom_created_at = ?,
      last_schedule_email_sent_at = ?,
      schedule_email_send_count = schedule_email_send_count + 1,
      updated_at = ?
    WHERE id = ?
  `).bind(
    values.advisorNotes || null,
    values.availabilityNotes || null,
    values.scheduledStartAt,
    values.scheduledEndAt,
    values.scheduledTimezone,
    values.scheduledLocation || null,
    values.scheduledMessage,
    values.scheduleInviteUid,
    values.scheduleResponseToken,
    values.scheduleResponseExpiresAt,
    values.zoomMeetingId || null,
    values.zoomJoinUrl || null,
    values.zoomMeetingPassword || null,
    values.zoomCreatedAt || null,
    values.lastScheduleEmailSentAt,
    values.lastScheduleEmailSentAt,
    leadId
  ).run();
}

async function recordLeadScheduleResponse(env, leadId, token, responseStatus) {
  const db = getPublishedSessionsDb(env);
  const status = responseStatus === 'accepted'
    ? 'booked'
    : (responseStatus === 'declined' ? 'declined' : 'awaiting-client');
  const respondedAt = nowIso();
  await db.prepare(`
    UPDATE leads
    SET
      status = ?,
      schedule_response_status = ?,
      schedule_response_at = ?,
      updated_at = ?
    WHERE id = ?
      AND schedule_response_token = ?
  `).bind(
    status,
    responseStatus,
    respondedAt,
    respondedAt,
    leadId,
    token
  ).run();

  return respondedAt;
}

function buildLeadScheduleResponsePage(options = {}) {
  const {
    heading = 'Planeir call response',
    message = 'Thanks. Your response has been recorded.',
    lead = null,
    statusCode = 200
  } = options;
  const scheduleText = lead?.scheduledStartAt && lead?.scheduledEndAt
    ? formatLeadScheduleRange(lead)
    : '';
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(heading)}</title>
  </head>
  <body style="margin:0;padding:28px;background:#f1f5f9;color:#102a43;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <main style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #d9e2ea;border-radius:16px;overflow:hidden;">
      <div style="padding:24px;background:#0f2233;color:#ffffff;">
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.82;">Planeir education call</p>
        <h1 style="margin:0;font-size:26px;line-height:1.25;">${escapeHtml(heading)}</h1>
      </div>
      <div style="padding:24px;font-size:16px;line-height:1.7;">
        <p style="margin:0 0 16px;">${escapeHtml(message)}</p>
        ${scheduleText ? `<p style="margin:0 0 16px;"><strong>Proposed time:</strong> ${escapeHtml(scheduleText)}</p>` : ''}
        <p style="margin:0;color:#52606d;">You can close this page now.</p>
      </div>
    </main>
  </body>
</html>`;
  return assetResponse(html, statusCode, 'text/html; charset=utf-8', noStoreHeaders());
}

async function checkPersistentRateLimit(env, scope, bucketKey, windowMs, maxRequests) {
  const db = getPublishedSessionsDb(env);
  const normalizedScope = normalizeLeadValue(scope);
  const normalizedBucketKey = normalizeLeadValue(bucketKey) || 'unknown';
  const now = Date.now();
  const windowStartedAt = Math.floor(now / windowMs) * windowMs;
  const updatedAt = nowIso();

  const existing = await db.prepare(`
    SELECT scope, bucket_key, window_started_at, count
    FROM security_rate_limits
    WHERE scope = ? AND bucket_key = ?
    LIMIT 1
  `).bind(normalizedScope, normalizedBucketKey).first();

  if (!existing) {
    await db.prepare(`
      INSERT INTO security_rate_limits (
        scope,
        bucket_key,
        window_started_at,
        count,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(normalizedScope, normalizedBucketKey, windowStartedAt, 1, updatedAt).run();
    return true;
  }

  if (Number(existing.window_started_at) !== windowStartedAt) {
    await db.prepare(`
      UPDATE security_rate_limits
      SET window_started_at = ?, count = 1, updated_at = ?
      WHERE scope = ? AND bucket_key = ?
    `).bind(windowStartedAt, updatedAt, normalizedScope, normalizedBucketKey).run();
    return true;
  }

  if (Number(existing.count || 0) >= maxRequests) {
    return false;
  }

  await db.prepare(`
    UPDATE security_rate_limits
    SET count = count + 1, updated_at = ?
    WHERE scope = ? AND bucket_key = ?
  `).bind(updatedAt, normalizedScope, normalizedBucketKey).run();
  return true;
}

function getPublishedClientKey(publishedId) {
  return `${PUBLISHED_CLIENT_KEY_PREFIX}${publishedId}${SESSION_KEY_SUFFIX}`;
}

function getPublishedAdvisorKey(publishedId) {
  return `${PUBLISHED_ADVISOR_KEY_PREFIX}${publishedId}${SESSION_KEY_SUFFIX}`;
}

function getPublishedQrAssetKey(publishedId, token) {
  return `${PUBLISHED_EMAIL_ASSET_KEY_PREFIX}${publishedId}/qr-${token}`;
}

function normalizePublishedEmail(value) {
  const normalized = normalizeLeadValue(value).toLowerCase();
  if (!normalized) {
    return '';
  }

  if (normalized.length > MAX_CLIENT_EMAIL_LENGTH) {
    throw new Error('Client email is too long.');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Client email address is invalid.');
  }

  return normalized;
}

function normalizeOptionalEmailRecipients(value) {
  return splitEmailList(value).reduce((recipients, email) => {
    try {
      const normalized = normalizePublishedEmail(email);
      if (normalized) {
        recipients.push(normalized);
      }
    } catch (_error) {
      // Optional third-party hooks should not block normal email delivery.
    }

    return recipients;
  }, []);
}

function normalizePublishedClientName(value) {
  const normalized = normalizeLeadValue(value);
  if (!normalized) {
    return 'Client';
  }

  if (normalized.length > MAX_CLIENT_NAME_LENGTH) {
    throw new Error('Client name is too long.');
  }

  return normalized;
}

function normalizePublishedExpiryDays(value) {
  const days = Number(value);
  if (!PUBLISHED_ALLOWED_EXPIRY_DAYS.has(days)) {
    return 30;
  }

  return days;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePublishedStatus(status, expiresAt, revokedAt) {
  if (revokedAt) {
    return 'revoked';
  }

  if (Date.parse(expiresAt) <= Date.now()) {
    return 'expired';
  }

  return status === 'active' ? 'active' : 'active';
}

function buildPublishedSessionEmailText(payload) {
  const lines = [
    `Hi ${payload.clientName},`,
    '',
    'Thanks again for taking the call today.',
    'You can reopen your Planeir session here:',
    payload.clientLink,
    '',
    `This secure link expires on ${payload.expiresAtDisplay}.`
  ];

  if (payload.clientCreatesPinOnFirstOpen) {
    lines.push('The first time you open this link, you will be asked to create your own 6-digit PIN.');
  } else if (payload.includePinInEmail && payload.pin) {
    lines.push(`Your 6-digit access code is: ${payload.pin}`);
  } else if (payload.pin) {
    lines.push('A separate 6-digit access code will be shared with you separately.');
  }

  lines.push(
    '',
    'If the button or QR code does not open, copy and paste the link above into your browser.',
    '',
    'Best,',
    'Gerry',
    buildPlaneirEmailCardText()
  );

  return lines.join('\n');
}

function buildPublishedSessionEmailHtml(payload) {
  const qrSection = payload.qrImageUrl
    ? `
      <div style="margin:24px 0 0;padding:20px;border:1px solid #d9e2ea;border-radius:16px;background:#f7fafc;text-align:center;">
        <p style="margin:0 0 12px;font-size:13px;letter-spacing:0.05em;text-transform:uppercase;color:#486581;">Mobile access</p>
        <img
          src="${escapeHtml(payload.qrImageUrl)}"
          alt="QR code for your secure Planeir session link"
          width="180"
          height="180"
          style="display:block;margin:0 auto 12px;width:180px;height:180px;border:0;"
        />
        <p style="margin:0;color:#52606d;font-size:14px;line-height:1.6;">Scan this QR code to open the same secure link on your phone.</p>
      </div>
    `
    : '';

  const pinSection = payload.clientCreatesPinOnFirstOpen
    ? `
        <p style="margin:18px 0 0;font-size:14px;line-height:1.7;color:#52606d;">
          The first time you open this secure link, you will be asked to create your own 6-digit PIN.
        </p>
      `
    : payload.pin
      ? (payload.includePinInEmail
      ? `
        <div style="margin:24px 0 0;padding:18px;border:1px solid #d9e2ea;border-radius:16px;background:#fff7ed;text-align:center;">
          <p style="margin:0 0 8px;font-size:13px;letter-spacing:0.05em;text-transform:uppercase;color:#9a3412;">Access code</p>
          <div style="font-family:'SFMono-Regular',Consolas,monospace;font-size:28px;font-weight:700;letter-spacing:0.14em;color:#7c2d12;">${escapeHtml(payload.pin)}</div>
        </div>
      `
      : `
        <p style="margin:18px 0 0;font-size:14px;line-height:1.7;color:#52606d;">
          A separate 6-digit access code will be shared with you separately.
        </p>
      `)
      : '';

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f1f5f9;color:#102a43;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #d9e2ea;border-radius:18px;overflow:hidden;">
      <div style="padding:28px 28px 18px;background:#0f2233;color:#ffffff;">
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.82;">Planeir session</p>
        <h1 style="margin:0;font-size:28px;line-height:1.2;">Your planning session is ready</h1>
      </div>
      <div style="padding:28px;font-size:15px;line-height:1.75;">
        <p style="margin:0 0 16px;">Hi ${escapeHtml(payload.clientName)},</p>
        <p style="margin:0 0 18px;">Thanks again for taking the call today. Your secure Planeir session is ready to revisit.</p>
        <div style="margin:0 0 22px;text-align:center;">
          <a
            href="${escapeHtml(payload.clientLink)}"
            style="display:inline-block;padding:14px 22px;border-radius:999px;background:#0f2233;color:#ffffff;text-decoration:none;font-weight:600;"
          >Open your secure session</a>
        </div>
        <p style="margin:0 0 12px;color:#52606d;">If the button does not open, use this secure link:</p>
        <p style="margin:0;padding:14px 16px;border-radius:14px;border:1px solid #d9e2ea;background:#f7fafc;overflow-wrap:anywhere;">
          <a href="${escapeHtml(payload.clientLink)}" style="color:#0f4c81;text-decoration:none;">${escapeHtml(payload.clientLink)}</a>
        </p>
        <p style="margin:18px 0 0;color:#52606d;">This secure link expires on <strong>${escapeHtml(payload.expiresAtDisplay)}</strong>.</p>
        ${pinSection}
        ${qrSection}
        ${buildPlaneirEmailCardHtml()}
      </div>
    </div>
  </body>
</html>`;
}

function getPublishedEmailConfig(env) {
  const apiKey = normalizeEnvValue(env.RESEND_API_KEY);
  const from = normalizeEnvValue(env.SESSION_EMAIL_FROM) || normalizeEnvValue(env.LEAD_EMAIL_FROM);
  const replyTo = normalizeEnvValue(env.SESSION_EMAIL_REPLY_TO) || splitEmailList(env.LEAD_REPLY_TO)[0] || '';
  const advisorNotificationRecipients = splitEmailList(env.SESSION_ADVISOR_NOTIFICATION_TO);
  const trustpilotAfsRecipients = normalizeOptionalEmailRecipients(env.TRUSTPILOT_AFS_EMAIL);

  return {
    apiKey,
    from,
    replyTo,
    trustpilotAfsRecipients,
    advisorNotificationRecipients: advisorNotificationRecipients.length > 0
      ? advisorNotificationRecipients
      : DEFAULT_SESSION_ADVISOR_NOTIFICATION_TO
  };
}

function formatPublishedDateTimeForEmail(value) {
  if (!value) {
    return 'Not available';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return parsed.toLocaleString('en-IE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Dublin'
  });
}

function buildAdvisorNotificationSubject(clientName) {
  return `Planeir session published - ${normalizePublishedClientName(clientName)}`;
}

function buildPublishedAdvisorNotificationText(payload) {
  const lines = [
    `Planeir session published for ${payload.clientName}`,
    '',
    `Client: ${payload.clientName}`,
    `Published: ${payload.publishedAtDisplay}`,
    `Expires: ${payload.expiresAtDisplay}`,
    `Published ID: ${payload.publishedId}`,
    `Client PIN flow: ${payload.clientPinSummary}`,
    '',
    'Advisor reopen link:',
    payload.advisorLink,
    ''
  ];

  if (payload.clientLink) {
    lines.push(
      'Client link:',
      payload.clientLink,
      ''
    );
  }

  if (payload.clientEmail) {
    lines.push(`Client email: ${payload.clientEmail}`, '');
  }

  lines.push('This internal notification was created automatically after publish succeeded.', buildPlaneirEmailCardText());

  return lines.join('\n');
}

function buildPublishedAdvisorNotificationHtml(payload) {
  const clientEmailSection = payload.clientEmail
    ? `
        <tr>
          <td style="padding:10px 12px;border:1px solid #d9e2ea;background:#f7fafc;font-weight:600;vertical-align:top;">Client email</td>
          <td style="padding:10px 12px;border:1px solid #d9e2ea;vertical-align:top;">${escapeHtml(payload.clientEmail)}</td>
        </tr>
      `
    : '';
  const clientLinkSection = payload.clientLink
    ? `
        <div style="margin:18px 0 0;">
          <p style="margin:0 0 8px;font-size:13px;letter-spacing:0.05em;text-transform:uppercase;color:#486581;">Client link</p>
          <p style="margin:0;padding:14px 16px;border-radius:14px;border:1px solid #d9e2ea;background:#f7fafc;overflow-wrap:anywhere;">
            <a href="${escapeHtml(payload.clientLink)}" style="color:#0f4c81;text-decoration:none;">${escapeHtml(payload.clientLink)}</a>
          </p>
        </div>
      `
    : '';

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f1f5f9;color:#102a43;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #d9e2ea;border-radius:18px;overflow:hidden;">
      <div style="padding:28px 28px 18px;background:#0f2233;color:#ffffff;">
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.82;">Planeir advisor notification</p>
        <h1 style="margin:0;font-size:26px;line-height:1.2;">Session published for ${escapeHtml(payload.clientName)}</h1>
      </div>
      <div style="padding:28px;font-size:15px;line-height:1.75;">
        <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.5;">
          <tr>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;background:#f7fafc;font-weight:600;vertical-align:top;">Client</td>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;vertical-align:top;">${escapeHtml(payload.clientName)}</td>
          </tr>
          <tr>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;background:#f7fafc;font-weight:600;vertical-align:top;">Published</td>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;vertical-align:top;">${escapeHtml(payload.publishedAtDisplay)}</td>
          </tr>
          <tr>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;background:#f7fafc;font-weight:600;vertical-align:top;">Expires</td>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;vertical-align:top;">${escapeHtml(payload.expiresAtDisplay)}</td>
          </tr>
          <tr>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;background:#f7fafc;font-weight:600;vertical-align:top;">Published ID</td>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;vertical-align:top;">${escapeHtml(payload.publishedId)}</td>
          </tr>
          <tr>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;background:#f7fafc;font-weight:600;vertical-align:top;">Client PIN flow</td>
            <td style="padding:10px 12px;border:1px solid #d9e2ea;vertical-align:top;">${escapeHtml(payload.clientPinSummary)}</td>
          </tr>
          ${clientEmailSection}
        </table>
        <div style="margin:24px 0 0;">
          <p style="margin:0 0 8px;font-size:13px;letter-spacing:0.05em;text-transform:uppercase;color:#486581;">Advisor reopen link</p>
          <p style="margin:0;padding:14px 16px;border-radius:14px;border:1px solid #d9e2ea;background:#f7fafc;overflow-wrap:anywhere;">
            <a href="${escapeHtml(payload.advisorLink)}" style="color:#0f4c81;text-decoration:none;">${escapeHtml(payload.advisorLink)}</a>
          </p>
        </div>
        ${clientLinkSection}
        <p style="margin:18px 0 0;color:#52606d;">This internal notification was created automatically after publish succeeded.</p>
        ${buildPlaneirEmailCardHtml()}
      </div>
    </div>
  </body>
</html>`;
}

function describePublishedClientPinFlow(row) {
  if (Number(row?.version) >= PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    return row?.clientPinState === 'active'
      ? 'Client already created their own PIN'
      : 'Client creates their own PIN on first open';
  }

  if (row?.pinRequired) {
    return 'Advisor-managed 6-digit PIN required';
  }

  return 'No PIN required';
}

function isSafeSessionId(rawId) {
  return typeof rawId === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(rawId);
}

function getSessionKey(sessionId) {
  return `${SESSION_KEY_PREFIX}${sessionId}${SESSION_KEY_SUFFIX}`;
}

function getPublishedSessionKey(publishedId) {
  return `${PUBLISHED_SESSION_KEY_PREFIX}${publishedId}${SESSION_KEY_SUFFIX}`;
}

function isBase64UrlValue(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function toBase64Url(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunkSize = 0x8000;

  for (let index = 0; index < view.length; index += chunkSize) {
    const chunk = view.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function toBase64(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunkSize = 0x8000;

  for (let index = 0; index < view.length; index += chunkSize) {
    const chunk = view.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function fromBase64Url(base64Url) {
  if (!isBase64UrlValue(base64Url, MAX_CAPABILITY_TOKEN_B64U_LENGTH)) {
    throw new Error('Capability is malformed.');
  }

  const normalized = base64Url
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function sha256Base64Url(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toBase64Url(new Uint8Array(digest));
}

function validateEncryptedEnvelope(payload, options = {}) {
  const {
    allowBase64 = false,
    maxCiphertextLength = MAX_CT_B64_LENGTH,
    ivField = allowBase64 ? 'ivB64' : 'ivB64u',
    ctField = allowBase64 ? 'ctB64' : 'ctB64u'
  } = options;

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Encrypted payload is missing.');
  }

  const algorithm = allowBase64 ? 'AES-GCM-256' : payload.alg;
  if (!allowBase64 && algorithm !== 'AES-GCM-256') {
    throw new Error('Encrypted payload algorithm is invalid.');
  }

  const ivValue = payload[ivField];
  const ctValue = payload[ctField];
  const isValidEncodedValue = allowBase64
    ? (value, maxLength) => typeof value === 'string' && value.length > 0 && value.length <= maxLength
    : isBase64UrlValue;

  if (!isValidEncodedValue(ivValue, MAX_IV_B64_LENGTH)) {
    throw new Error(`Invalid ${ivField}.`);
  }

  if (!isValidEncodedValue(ctValue, maxCiphertextLength)) {
    throw new Error(`Invalid ${ctField}.`);
  }

  return allowBase64
    ? {
      ivB64: ivValue,
      ctB64: ctValue
    }
    : {
      alg: 'AES-GCM-256',
      ivB64u: ivValue,
      ctB64u: ctValue
    };
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

function validatePublishedSessionPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be a JSON object.');
  }

  if (Number(payload.v) !== PUBLISHED_PAYLOAD_VERSION) {
    throw new Error('Unsupported payload version.');
  }

  if (!payload.clientAccess || typeof payload.clientAccess !== 'object' || Array.isArray(payload.clientAccess)) {
    throw new Error('Client access bundle is required.');
  }

  if (!payload.advisorAccess || typeof payload.advisorAccess !== 'object' || Array.isArray(payload.advisorAccess)) {
    throw new Error('Advisor access bundle is required.');
  }

  if (!isBase64UrlValue(payload.clientAccess.authHashB64u, MAX_AUTH_HASH_B64U_LENGTH)) {
    throw new Error('Client access auth hash is invalid.');
  }

  if (!isBase64UrlValue(payload.advisorAccess.authHashB64u, MAX_AUTH_HASH_B64U_LENGTH)) {
    throw new Error('Advisor access auth hash is invalid.');
  }

  if (typeof payload.clientAccess.pinRequired !== 'boolean') {
    throw new Error('Client access pinRequired must be a boolean.');
  }

  return {
    v: PUBLISHED_PAYLOAD_VERSION,
    payload: validateEncryptedEnvelope(payload.payload, {
      allowBase64: false,
      maxCiphertextLength: MAX_CT_B64_LENGTH
    }),
    clientAccess: {
      authHashB64u: payload.clientAccess.authHashB64u,
      pinRequired: payload.clientAccess.pinRequired,
      wrap: validateEncryptedEnvelope(payload.clientAccess.wrap, {
        allowBase64: false,
        maxCiphertextLength: MAX_WRAP_CT_B64U_LENGTH
      })
    },
    advisorAccess: {
      authHashB64u: payload.advisorAccess.authHashB64u,
      wrap: validateEncryptedEnvelope(payload.advisorAccess.wrap, {
        allowBase64: false,
        maxCiphertextLength: MAX_WRAP_CT_B64U_LENGTH
      })
    }
  };
}

function validateStoredPublishedManifest(payload) {
  const validated = validatePublishedSessionPayload(payload);

  if (payload.kind !== PUBLISHED_SESSION_KIND) {
    throw new Error('Published session manifest kind is invalid.');
  }

  if (!isSafeSessionId(payload.publishedId)) {
    throw new Error('Published session manifest id is invalid.');
  }

  if (typeof payload.createdAt !== 'string' || Number.isNaN(Date.parse(payload.createdAt))) {
    throw new Error('Published session createdAt is invalid.');
  }

  if (typeof payload.expiresAt !== 'string' || Number.isNaN(Date.parse(payload.expiresAt))) {
    throw new Error('Published session expiresAt is invalid.');
  }

  const revokedAt = typeof payload.revokedAt === 'string' && payload.revokedAt
    ? payload.revokedAt
    : null;
  if (revokedAt && Number.isNaN(Date.parse(revokedAt))) {
    throw new Error('Published session revokedAt is invalid.');
  }

  return {
    ...validated,
    kind: PUBLISHED_SESSION_KIND,
    publishedId: payload.publishedId,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
    revokedAt
  };
}

function validatePublishedBundlePayload(payload, expectedKind, accessKey) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Bundle payload must be a JSON object.');
  }

  const version = Number(payload.v);
  if (version !== PUBLISHED_SPLIT_PAYLOAD_VERSION && version !== PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    throw new Error('Unsupported bundle version.');
  }

  if (payload.kind !== expectedKind) {
    throw new Error('Bundle kind is invalid.');
  }

  const access = payload[accessKey];
  if (!access || typeof access !== 'object' || Array.isArray(access)) {
    throw new Error('Bundle access payload is required.');
  }

  const validated = {
    v: version,
    kind: expectedKind,
    payload: validateEncryptedEnvelope(payload.payload, {
      allowBase64: false,
      maxCiphertextLength: MAX_CT_B64_LENGTH
    })
  };

  if (accessKey === 'clientAccess') {
    if (version === PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
      const revision = Number(access.revision);
      if (access.mode !== 'client-first-pin') {
        throw new Error('Client access mode is invalid.');
      }

      if (access.pinState !== 'pending' && access.pinState !== 'active') {
        throw new Error('Client access pinState is invalid.');
      }

      if (!Number.isInteger(revision) || revision < 1) {
        throw new Error('Client access revision is invalid.');
      }

      validated.clientAccess = {
        mode: access.mode,
        pinState: access.pinState,
        revision,
        wrap: validateEncryptedEnvelope(access.wrap, {
          allowBase64: false,
          maxCiphertextLength: MAX_WRAP_CT_B64U_LENGTH
        })
      };
    } else {
      if (typeof access.pinRequired !== 'boolean') {
        throw new Error('Client pinRequired must be a boolean.');
      }

      validated.clientAccess = {
        pinRequired: access.pinRequired,
        wrap: validateEncryptedEnvelope(access.wrap, {
          allowBase64: false,
          maxCiphertextLength: MAX_WRAP_CT_B64U_LENGTH
        })
      };
    }
  } else {
    validated.advisorAccess = {
      wrap: validateEncryptedEnvelope(access.wrap, {
        allowBase64: false,
        maxCiphertextLength: MAX_WRAP_CT_B64U_LENGTH
      })
    };
  }

  return validated;
}

function validatePublishedSessionCreatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be a JSON object.');
  }

  if (Number(payload.v) === PUBLISHED_PAYLOAD_VERSION) {
    return {
      kind: 'v2',
      data: validatePublishedSessionPayload(payload)
    };
  }

  const version = Number(payload.v);
  if (version !== PUBLISHED_SPLIT_PAYLOAD_VERSION && version !== PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    throw new Error('Unsupported payload version.');
  }

  const meta = payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
    ? payload.meta
    : {};
  const auth = payload.auth && typeof payload.auth === 'object' && !Array.isArray(payload.auth)
    ? payload.auth
    : {};

  if (!isBase64UrlValue(auth.clientAuthHashB64u, MAX_AUTH_HASH_B64U_LENGTH)) {
    throw new Error('Client access auth hash is invalid.');
  }

  if (!isBase64UrlValue(auth.advisorAuthHashB64u, MAX_AUTH_HASH_B64U_LENGTH)) {
    throw new Error('Advisor access auth hash is invalid.');
  }

  const clientBundle = validatePublishedBundlePayload(payload.clientBundle, PUBLISHED_CLIENT_KIND, 'clientAccess');
  const advisorBundle = validatePublishedBundlePayload(payload.advisorBundle, PUBLISHED_ADVISOR_KIND, 'advisorAccess');
  if (version === PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    if (clientBundle.clientAccess.pinState !== 'pending') {
      throw new Error('New v4 client access must start pending.');
    }

    if (clientBundle.clientAccess.revision !== 1) {
      throw new Error('New v4 client access must start at revision 1.');
    }
  }

  return {
    kind: version === PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION ? 'v4' : 'v3',
    data: {
      v: version,
      meta: {
        clientName: normalizePublishedClientName(meta.clientName),
        clientEmail: meta.clientEmail ? normalizePublishedEmail(meta.clientEmail) : '',
        expiresInDays: normalizePublishedExpiryDays(meta.expiresInDays)
      },
      auth: {
        clientAuthHashB64u: auth.clientAuthHashB64u,
        advisorAuthHashB64u: auth.advisorAuthHashB64u
      },
      clientBundle,
      advisorBundle
    }
  };
}

function normalizePublishedClientPinState(value, options = {}) {
  const { allowNull = false } = options;
  if (allowNull && (value === null || typeof value === 'undefined' || value === '')) {
    return null;
  }

  return value === 'active' ? 'active' : 'pending';
}

function normalizePublishedAccessRevision(value, label = 'Client access revision') {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error(`${label} is invalid.`);
  }

  return normalized;
}

function validatePublishedClientPinSetupPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be a JSON object.');
  }

  const expectedRevision = normalizePublishedAccessRevision(payload.expectedRevision, 'Expected client access revision');
  const clientBundle = validatePublishedBundlePayload(payload.clientBundle, PUBLISHED_CLIENT_KIND, 'clientAccess');
  if (clientBundle.v !== PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    throw new Error('Client PIN setup only supports v4 published sessions.');
  }

  if (clientBundle.clientAccess.mode !== 'client-first-pin' || clientBundle.clientAccess.pinState !== 'active') {
    throw new Error('Client PIN setup bundle must be an active v4 client access bundle.');
  }

  if (clientBundle.clientAccess.revision <= expectedRevision) {
    throw new Error('Client PIN setup bundle revision must advance the current revision.');
  }

  return {
    expectedRevision,
    clientBundle
  };
}

function validatePublishedClientAccessResetPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be a JSON object.');
  }

  const expectedRevision = normalizePublishedAccessRevision(payload.expectedRevision, 'Expected client access revision');
  if (!isBase64UrlValue(payload.clientAuthHashB64u, MAX_AUTH_HASH_B64U_LENGTH)) {
    throw new Error('Client access auth hash is invalid.');
  }
  const clientSecretB64u = normalizeLeadValue(payload.clientSecretB64u);
  if (clientSecretB64u && !isBase64UrlValue(clientSecretB64u, MAX_PUBLISHED_RECOVERY_SECRET_B64U_LENGTH)) {
    throw new Error('Client access recovery secret is invalid.');
  }

  const clientBundle = validatePublishedBundlePayload(payload.clientBundle, PUBLISHED_CLIENT_KIND, 'clientAccess');
  const advisorBundle = validatePublishedBundlePayload(payload.advisorBundle, PUBLISHED_ADVISOR_KIND, 'advisorAccess');
  if (clientBundle.v !== PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION || advisorBundle.v !== PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    throw new Error('Client access reset only supports v4 published sessions.');
  }

  if (clientBundle.clientAccess.mode !== 'client-first-pin' || clientBundle.clientAccess.pinState !== 'pending') {
    throw new Error('Reset bundle must create a pending v4 client access link.');
  }

  if (clientBundle.clientAccess.revision <= expectedRevision) {
    throw new Error('Reset bundle revision must advance the current revision.');
  }

  return {
    expectedRevision,
    clientAuthHashB64u: payload.clientAuthHashB64u,
    clientSecretB64u,
    clientBundle,
    advisorBundle
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
  const availabilityNotes = normalizeLongText(payload.availabilityNotes);
  const understandsRecordedCall = normalizeLeadConsent(
    payload.understandsRecordedCall ?? payload.understandsEarlyAccess
  );
  const understandsEducationalOnly = normalizeLeadConsent(payload.understandsEducationalOnly);
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

  if (availabilityNotes.length > MAX_LEAD_AVAILABILITY_LENGTH) {
    throw new Error('Availability notes are too long.');
  }

  if (!understandsRecordedCall) {
    throw new Error('Recorded-call acknowledgement is required.');
  }

  if (!understandsEducationalOnly) {
    throw new Error('Financial-education-only acknowledgement is required.');
  }

  if (!understandsEducationalContent) {
    throw new Error('Educational-content consent is required for this free call.');
  }

  return {
    fullName,
    email,
    phone,
    reason,
    availabilityNotes,
    stage,
    callOutcome,
    understandsRecordedCall,
    understandsEducationalOnly,
    understandsEducationalContent,
    source: 'landing-page'
  };
}

function normalizePublishedSessionRow(row) {
  if (!row) {
    return null;
  }

  const version = Number(row.version);

  return {
    id: row.id,
    version,
    status: normalizePublishedStatus(row.status, row.expires_at, row.revoked_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at || null,
    clientName: row.client_name,
    clientEmail: row.client_email || '',
    pinRequired: Boolean(Number(row.pin_required || 0)),
    clientAuthHashB64u: row.client_auth_hash_b64u,
    advisorAuthHashB64u: row.advisor_auth_hash_b64u,
    clientR2Key: row.client_r2_key,
    advisorR2Key: row.advisor_r2_key,
    clientOpenCount: Number(row.client_open_count || 0),
    advisorOpenCount: Number(row.advisor_open_count || 0),
    lastClientOpenedAt: row.last_client_opened_at || null,
    lastAdvisorOpenedAt: row.last_advisor_opened_at || null,
    clientUnlockCount: Number(row.client_unlock_count || 0),
    advisorUnlockCount: Number(row.advisor_unlock_count || 0),
    lastClientUnlockedAt: row.last_client_unlocked_at || null,
    lastAdvisorUnlockedAt: row.last_advisor_unlocked_at || null,
    lastEmailSentAt: row.last_email_sent_at || null,
    emailSendCount: Number(row.email_send_count || 0),
    qrAssetToken: row.qr_asset_token || '',
    qrAssetR2Key: row.qr_asset_r2_key || '',
    qrAssetContentType: row.qr_asset_content_type || '',
    recoveryPayloadB64u: row.recovery_payload_b64u || '',
    recoveryIvB64u: row.recovery_iv_b64u || '',
    recoveryAvailable: Boolean(row.recovery_payload_b64u && row.recovery_iv_b64u),
    clientPinState: version === PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION
      ? (row.client_pin_state === 'active' ? 'active' : 'pending')
      : null,
    clientPinInitializedAt: version === PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION
      ? (row.client_pin_initialized_at || null)
      : null,
    clientAccessRevision: version === PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION
      ? Number(row.client_access_revision || 1)
      : 0
  };
}

async function getPublishedSessionRow(env, publishedId) {
  const db = getPublishedSessionsDb(env);
  const row = await db.prepare(`
    SELECT
      id,
      version,
      status,
      created_at,
      updated_at,
      expires_at,
      revoked_at,
      client_name,
      client_email,
      pin_required,
      client_auth_hash_b64u,
      advisor_auth_hash_b64u,
      client_r2_key,
      advisor_r2_key,
      client_open_count,
      advisor_open_count,
      last_client_opened_at,
      last_advisor_opened_at,
      client_unlock_count,
      advisor_unlock_count,
      last_client_unlocked_at,
      last_advisor_unlocked_at,
      last_email_sent_at,
      email_send_count,
      qr_asset_token,
      qr_asset_r2_key,
      qr_asset_content_type,
      recovery_payload_b64u,
      recovery_iv_b64u,
      client_pin_state,
      client_pin_initialized_at,
      client_access_revision
    FROM published_sessions
    WHERE id = ?
    LIMIT 1
  `).bind(publishedId).first();

  return normalizePublishedSessionRow(row);
}

async function insertPublishedSessionEvent(env, publishedId, actorType, eventType, metadata) {
  const db = getPublishedSessionsDb(env);
  await db.prepare(`
    INSERT INTO published_session_events (
      published_session_id,
      actor_type,
      event_type,
      created_at,
      metadata_json
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    publishedId,
    actorType,
    eventType,
    nowIso(),
    metadata ? JSON.stringify(metadata) : null
  ).run();
}

async function insertPublishedSessionRow(env, record) {
  const db = getPublishedSessionsDb(env);
  const result = await db.prepare(`
    INSERT INTO published_sessions (
      id,
      version,
      status,
      created_at,
      updated_at,
      expires_at,
      revoked_at,
      client_name,
      client_email,
      pin_required,
      client_auth_hash_b64u,
      advisor_auth_hash_b64u,
      client_r2_key,
      advisor_r2_key,
      client_open_count,
      advisor_open_count,
      last_client_opened_at,
      last_advisor_opened_at,
      client_unlock_count,
      advisor_unlock_count,
      last_client_unlocked_at,
      last_advisor_unlocked_at,
      last_email_sent_at,
      email_send_count,
      qr_asset_token,
      qr_asset_r2_key,
      qr_asset_content_type,
      recovery_payload_b64u,
      recovery_iv_b64u,
      client_pin_state,
      client_pin_initialized_at,
      client_access_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    record.id,
    record.version,
    record.status,
    record.createdAt,
    record.updatedAt,
    record.expiresAt,
    record.revokedAt,
    record.clientName,
    record.clientEmail || null,
    record.pinRequired ? 1 : 0,
    record.clientAuthHashB64u,
    record.advisorAuthHashB64u,
    record.clientR2Key,
    record.advisorR2Key,
    0,
    0,
    null,
    null,
    0,
    0,
    null,
    null,
    null,
    0,
    null,
    null,
    null,
    record.recoveryPayloadB64u || null,
    record.recoveryIvB64u || null,
    record.clientPinState || null,
    record.clientPinInitializedAt || null,
    Number(record.clientAccessRevision || 1)
  ).run();

  if (!result.success) {
    throw new Error('Failed to insert published session metadata.');
  }
}

function buildPublishedSessionManagerSummary(row) {
  if (!row) {
    return null;
  }

  return {
    publishedId: row.id,
    version: row.version,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    clientName: row.clientName,
    clientEmail: row.clientEmail,
    clientPinState: row.clientPinState,
    clientPinInitializedAt: row.clientPinInitializedAt,
    clientAccessRevision: row.clientAccessRevision,
    emailSendCount: row.emailSendCount,
    lastEmailSentAt: row.lastEmailSentAt,
    recoveryAvailable: row.recoveryAvailable,
    canEmail: row.status === 'active' && row.version >= PUBLISHED_SPLIT_PAYLOAD_VERSION,
    canExtend: row.status !== 'revoked' && row.version >= PUBLISHED_SPLIT_PAYLOAD_VERSION,
    canResetClientAccess: row.status === 'active' && row.version >= PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION,
    canRevoke: row.status === 'active'
  };
}

async function listPublishedSessionRows(env, options = {}) {
  const db = getPublishedSessionsDb(env);
  const query = normalizeLeadValue(options.query).toLowerCase();
  const limit = Math.min(Math.max(Number(options.limit) || 40, 1), 100);
  const bindings = [];
  const where = [];

  if (query) {
    const likeValue = `%${query}%`;
    where.push(`(
      LOWER(id) LIKE ?
      OR LOWER(client_name) LIKE ?
      OR LOWER(COALESCE(client_email, '')) LIKE ?
    )`);
    bindings.push(likeValue, likeValue, likeValue);
  }

  const sql = `
    SELECT
      id,
      version,
      status,
      created_at,
      updated_at,
      expires_at,
      revoked_at,
      client_name,
      client_email,
      pin_required,
      client_auth_hash_b64u,
      advisor_auth_hash_b64u,
      client_r2_key,
      advisor_r2_key,
      client_open_count,
      advisor_open_count,
      last_client_opened_at,
      last_advisor_opened_at,
      client_unlock_count,
      advisor_unlock_count,
      last_client_unlocked_at,
      last_advisor_unlocked_at,
      last_email_sent_at,
      email_send_count,
      qr_asset_token,
      qr_asset_r2_key,
      qr_asset_content_type,
      recovery_payload_b64u,
      recovery_iv_b64u,
      client_pin_state,
      client_pin_initialized_at,
      client_access_revision
    FROM published_sessions
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC
    LIMIT ?
  `;

  bindings.push(limit);
  const result = await db.prepare(sql).bind(...bindings).all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const sessions = [];
  for (const row of rows) {
    sessions.push(await markPublishedExpiredIfNeeded(env, normalizePublishedSessionRow(row)));
  }
  return sessions;
}

async function updatePublishedStatus(env, publishedId, status, revokedAt = null) {
  const db = getPublishedSessionsDb(env);
  await db.prepare(`
    UPDATE published_sessions
    SET status = ?, revoked_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(status, revokedAt, nowIso(), publishedId).run();
}

async function updatePublishedExpiry(env, publishedId, expiresAt) {
  const db = getPublishedSessionsDb(env);
  await db.prepare(`
    UPDATE published_sessions
    SET expires_at = ?, status = 'active', updated_at = ?
    WHERE id = ?
  `).bind(expiresAt, nowIso(), publishedId).run();
}

async function recordPublishedOpen(env, publishedId, role) {
  const db = getPublishedSessionsDb(env);
  const timestamp = nowIso();
  const countColumn = role === 'advisor' ? 'advisor_open_count' : 'client_open_count';
  const lastOpenedColumn = role === 'advisor' ? 'last_advisor_opened_at' : 'last_client_opened_at';
  await db.prepare(`
    UPDATE published_sessions
    SET updated_at = ?, ${countColumn} = ${countColumn} + 1, ${lastOpenedColumn} = ?
    WHERE id = ?
  `).bind(timestamp, timestamp, publishedId).run();
}

async function recordPublishedUnlock(env, publishedId, role) {
  const db = getPublishedSessionsDb(env);
  const timestamp = nowIso();
  const countColumn = role === 'advisor' ? 'advisor_unlock_count' : 'client_unlock_count';
  const lastUnlockedColumn = role === 'advisor' ? 'last_advisor_unlocked_at' : 'last_client_unlocked_at';
  await db.prepare(`
    UPDATE published_sessions
    SET updated_at = ?, ${countColumn} = ${countColumn} + 1, ${lastUnlockedColumn} = ?
    WHERE id = ?
  `).bind(timestamp, timestamp, publishedId).run();
}

async function updatePublishedEmailMetadata(env, publishedId, values) {
  const db = getPublishedSessionsDb(env);
  await db.prepare(`
    UPDATE published_sessions
    SET
      client_email = ?,
      last_email_sent_at = ?,
      email_send_count = email_send_count + 1,
      qr_asset_token = ?,
      qr_asset_r2_key = ?,
      qr_asset_content_type = ?,
      updated_at = ?
    WHERE id = ?
  `).bind(
    values.clientEmail || null,
    values.lastEmailSentAt,
    values.qrAssetToken || null,
    values.qrAssetR2Key || null,
    values.qrAssetContentType || null,
    nowIso(),
    publishedId
  ).run();
}

async function updatePublishedClientPinSetupMetadata(env, publishedId, values) {
  const db = getPublishedSessionsDb(env);
  await db.prepare(`
    UPDATE published_sessions
    SET
      pin_required = 1,
      client_pin_state = ?,
      client_pin_initialized_at = ?,
      client_access_revision = ?,
      updated_at = ?
    WHERE id = ?
  `).bind(
    values.clientPinState,
    values.clientPinInitializedAt || null,
    values.clientAccessRevision,
    nowIso(),
    publishedId
  ).run();
}

async function resetPublishedClientAccessMetadata(env, publishedId, values) {
  const db = getPublishedSessionsDb(env);
  await db.prepare(`
    UPDATE published_sessions
    SET
      status = 'active',
      revoked_at = NULL,
      pin_required = 1,
      client_auth_hash_b64u = ?,
      client_pin_state = ?,
      client_pin_initialized_at = NULL,
      client_access_revision = ?,
      last_email_sent_at = NULL,
      email_send_count = 0,
      qr_asset_token = NULL,
      qr_asset_r2_key = NULL,
      qr_asset_content_type = NULL,
      recovery_payload_b64u = ?,
      recovery_iv_b64u = ?,
      updated_at = ?
    WHERE id = ?
  `).bind(
    values.clientAuthHashB64u,
    values.clientPinState,
    values.clientAccessRevision,
    values.recoveryPayloadB64u || null,
    values.recoveryIvB64u || null,
    nowIso(),
    publishedId
  ).run();
}

async function clearPublishedQrAssetMetadata(env, publishedId) {
  const db = getPublishedSessionsDb(env);
  await db.prepare(`
    UPDATE published_sessions
    SET
      qr_asset_token = NULL,
      qr_asset_r2_key = NULL,
      qr_asset_content_type = NULL,
      updated_at = ?
    WHERE id = ?
  `).bind(nowIso(), publishedId).run();
}

async function deletePublishedQrAsset(env, objectKey) {
  if (!objectKey) {
    return;
  }

  await env.SESSIONS_BUCKET.delete(objectKey);
}

function isPublishedSessionExpired(row) {
  return Date.parse(row.expiresAt) <= Date.now();
}

async function markPublishedExpiredIfNeeded(env, row) {
  if (!row || row.status !== 'active' || !isPublishedSessionExpired(row)) {
    return row;
  }

  await updatePublishedStatus(env, row.id, 'expired', null);
  if (row.qrAssetR2Key) {
    await deletePublishedQrAsset(env, row.qrAssetR2Key).catch((error) => {
      console.error('Failed to delete QR asset on expiry', {
        publishedId: row.id,
        qrAssetR2Key: row.qrAssetR2Key,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    await clearPublishedQrAssetMetadata(env, row.id).catch((error) => {
      console.error('Failed to clear QR metadata on expiry', {
        publishedId: row.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  return {
    ...row,
    status: 'expired',
    qrAssetToken: '',
    qrAssetR2Key: '',
    qrAssetContentType: ''
  };
}

async function sendPublishedAdvisorNotificationEmail(env, row, links) {
  const emailConfig = getPublishedEmailConfig(env);
  const recipients = emailConfig.advisorNotificationRecipients;
  const metadataBase = {
    publishedId: row.id,
    clientName: row.clientName,
    clientEmail: row.clientEmail || '',
    recipients,
    advisorLinkHost: links.advisorLink.host,
    advisorLinkPath: links.advisorLink.path,
    clientLinkHost: links.clientLink?.host || '',
    clientLinkPath: links.clientLink?.path || '',
    clientPinFlow: describePublishedClientPinFlow(row)
  };

  if (!emailConfig.apiKey || !emailConfig.from) {
    console.warn('Published advisor notification email skipped because session email delivery is not configured.', metadataBase);
    await insertPublishedSessionEvent(env, row.id, 'system', 'advisor-notification-skipped', {
      ...metadataBase,
      reason: 'email-config-missing'
    }).catch((error) => {
      console.error('Failed to record advisor notification skip event', {
        publishedId: row.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return;
  }

  const payload = {
    clientName: row.clientName,
    clientEmail: row.clientEmail || '',
    publishedId: row.id,
    publishedAtDisplay: formatPublishedDateTimeForEmail(row.createdAt),
    expiresAtDisplay: formatPublishedDateTimeForEmail(row.expiresAt),
    clientPinSummary: describePublishedClientPinFlow(row),
    advisorLink: links.advisorLink.href,
    clientLink: links.clientLink?.href || ''
  };

  try {
    const result = await sendEmailWithResend(emailConfig, {
      from: emailConfig.from,
      to: recipients,
      subject: buildAdvisorNotificationSubject(row.clientName),
      html: buildPublishedAdvisorNotificationHtml(payload),
      text: buildPublishedAdvisorNotificationText(payload),
      reply_to: emailConfig.replyTo || undefined
    }, `published-session-${row.id}-advisor-notification`);

    console.log('Published advisor notification email accepted', {
      ...metadataBase,
      resendEmailId: result?.id || null
    });
    await insertPublishedSessionEvent(env, row.id, 'system', 'advisor-notification-sent', {
      ...metadataBase,
      resendEmailId: result?.id || null
    }).catch((error) => {
      console.error('Failed to record advisor notification sent event', {
        publishedId: row.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  } catch (error) {
    console.error('Published advisor notification email failed', {
      ...metadataBase,
      error: error instanceof Error ? error.message : String(error)
    });
    await insertPublishedSessionEvent(env, row.id, 'system', 'advisor-notification-failed', {
      ...metadataBase,
      error: error instanceof Error ? error.message : String(error)
    }).catch((eventError) => {
      console.error('Failed to record advisor notification failure event', {
        publishedId: row.id,
        error: eventError instanceof Error ? eventError.message : String(eventError)
      });
    });
  }
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

function advisorAuthExtraHeaders(session) {
  if (session?.authEnabled && !session?.authenticated) {
    return {
      'Set-Cookie': buildExpiredAdvisorSessionCookie()
    };
  }

  return null;
}

async function requireAdvisorSession(request, env, origin, methods, options = {}) {
  const { requireCsrf = false, rateScope = 'advisor-admin', rateWindowMs = ADVISOR_ADMIN_RATE_LIMIT_WINDOW_MS, rateLimitMax = ADVISOR_ADMIN_RATE_LIMIT_MAX } = options;
  const config = getAdvisorAuthConfig(env);
  const clientIp = getClientIp(request);
  const originError = requireTrustedOrigin(origin, methods);
  if (originError) {
    return {
      response: originError
    };
  }

  if (!checkRateLimit(clientIp)) {
    return {
      response: jsonResponse({ error: 'Too many requests. Please try again later.' }, 429, origin, methods)
    };
  }

  const persistentAllowed = await checkPersistentRateLimit(env, rateScope, clientIp, rateWindowMs, rateLimitMax);
  if (!persistentAllowed) {
    return {
      response: jsonResponse({ error: 'Too many requests. Please try again later.' }, 429, origin, methods, null, noStoreHeaders())
    };
  }

  if (!config.enabled) {
    return {
      session: {
        authEnabled: false,
        authenticated: false,
        csrfToken: '',
        expiresAt: null
      },
      clientIp
    };
  }

  const session = await readAdvisorSession(request, env);
  if (!session.authenticated) {
    return {
      response: jsonResponse({ error: 'Advisor login required.' }, 401, origin, methods, null, {
        ...noStoreHeaders(),
        ...advisorAuthExtraHeaders(session)
      })
    };
  }

  if (requireCsrf && request.headers.get('X-Advisor-CSRF') !== session.csrfToken) {
    return {
      response: jsonResponse({ error: 'Advisor session is invalid. Refresh and sign in again.' }, 403, origin, methods, null, noStoreHeaders())
    };
  }

  return {
    session,
    clientIp
  };
}

function parseQrImageDataUrl(dataUrl) {
  const value = normalizeLeadValue(dataUrl);
  if (!value) {
    return null;
  }

  if (value.length > MAX_QR_IMAGE_DATA_URL_LENGTH) {
    throw new Error('QR image is too large.');
  }

  const match = /^data:(image\/png);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) {
    throw new Error('QR image must be a PNG data URL.');
  }

  return {
    contentType: match[1],
    bytes: Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0))
  };
}

async function handleAdvisorSession(request, env, origin) {
  const session = await readAdvisorSession(request, env);
  return jsonResponse({
    authEnabled: session.authEnabled,
    authenticated: session.authenticated,
    csrfToken: session.authenticated ? session.csrfToken : '',
    expiresAt: session.authenticated ? session.expiresAt : null
  }, 200, origin, 'GET,OPTIONS', null, {
    ...noStoreHeaders(),
    ...advisorAuthExtraHeaders(session)
  });
}

async function handleAdvisorLogin(request, env, origin) {
  const originError = requireTrustedOrigin(origin, 'POST,OPTIONS');
  if (originError) {
    return originError;
  }

  const config = getAdvisorAuthConfig(env);
  if (!config.enabled) {
    return jsonResponse({ error: 'Advisor authentication is not configured.' }, 500, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  const clientIp = getClientIp(request);
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: 'Too many requests. Please try again later.' }, 429, origin, 'POST,OPTIONS');
  }

  const persistentAllowed = await checkPersistentRateLimit(env, 'advisor-login', clientIp, ADVISOR_LOGIN_RATE_LIMIT_WINDOW_MS, ADVISOR_LOGIN_RATE_LIMIT_MAX);
  if (!persistentAllowed) {
    return jsonResponse({ error: 'Too many login attempts. Please try again later.' }, 429, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400, origin, 'POST,OPTIONS');
  }

  const password = typeof body?.password === 'string' ? body.password : '';
  const validPassword = await verifyAdvisorPassword(password, config);
  if (!validPassword) {
    return jsonResponse({ error: 'Password is incorrect.' }, 401, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  const token = await createAdvisorSessionToken(config);
  return jsonResponse({
    ok: true,
    authEnabled: true,
    authenticated: true,
    csrfToken: token.csrfToken,
    expiresAt: token.expiresAt
  }, 200, origin, 'POST,OPTIONS', null, {
    ...noStoreHeaders(),
    'Set-Cookie': buildAdvisorSessionCookie(token.token)
  });
}

async function handleAdvisorLogout(request, env, origin) {
  const session = await readAdvisorSession(request, env);
  const originError = requireTrustedOrigin(origin, 'POST,OPTIONS');
  if (originError) {
    return originError;
  }

  if (session.authEnabled && session.authenticated && request.headers.get('X-Advisor-CSRF') !== session.csrfToken) {
    return jsonResponse({ error: 'Advisor session is invalid. Refresh and sign in again.' }, 403, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  return jsonResponse({
    ok: true,
    authEnabled: session.authEnabled,
    authenticated: false,
    csrfToken: '',
    expiresAt: null
  }, 200, origin, 'POST,OPTIONS', null, {
    ...noStoreHeaders(),
    'Set-Cookie': buildExpiredAdvisorSessionCookie()
  });
}

async function handleAdvisorPublishedSessionsList(request, env, origin) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, 'GET,OPTIONS');
  if (advisorAccess.response) {
    return advisorAccess.response;
  }

  const url = new URL(request.url);
  const query = normalizeLeadValue(url.searchParams.get('q'));
  const limit = Number(url.searchParams.get('limit') || 40);
  const rows = await listPublishedSessionRows(env, { query, limit });
  return jsonResponse({
    ok: true,
    sessions: rows.map(buildPublishedSessionManagerSummary)
  }, 200, origin, 'GET,OPTIONS', null, noStoreHeaders());
}

async function handleAdvisorPublishedSessionDetail(request, env, origin, publishedId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, 'GET,OPTIONS');
  if (advisorAccess.response) {
    return advisorAccess.response;
  }

  let row = await getPublishedSessionRow(env, publishedId);
  if (!row) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'GET,OPTIONS', null, noStoreHeaders());
  }

  row = await markPublishedExpiredIfNeeded(env, row);
  const summary = buildPublishedSessionManagerSummary(row);
  let clientSecretB64u = '';
  let advisorSecretB64u = '';
  let recoveryAvailable = row.recoveryAvailable;

  if (row.recoveryAvailable) {
    try {
      const recovery = await decryptPublishedRecoveryPayload(env, row);
      clientSecretB64u = recovery.clientSecretB64u;
      advisorSecretB64u = recovery.advisorSecretB64u;
    } catch (error) {
      recoveryAvailable = false;
      console.error('Failed to recover published session links for advisor manager', {
        publishedId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return jsonResponse({
    ok: true,
    session: {
      ...summary,
      recoveryAvailable,
      clientSecretB64u,
      advisorSecretB64u
    }
  }, 200, origin, 'GET,OPTIONS', null, noStoreHeaders());
}

async function handleAdvisorLeadsList(request, env, origin) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, 'GET,OPTIONS');
  if (advisorAccess.response) {
    return advisorAccess.response;
  }

  const url = new URL(request.url);
  const query = normalizeLeadValue(url.searchParams.get('q'));
  const status = normalizeLeadValue(url.searchParams.get('status')) || 'all';
  const limit = Number(url.searchParams.get('limit') || 60);

  try {
    const rows = await listLeadRows(env, { query, status, limit });
    return jsonResponse({
      ok: true,
      leads: rows.map(buildLeadManagerSummary)
    }, 200, origin, 'GET,OPTIONS', null, noStoreHeaders());
  } catch (error) {
    return jsonResponse({ error: error.message || 'Could not load leads.' }, 400, origin, 'GET,OPTIONS', null, noStoreHeaders());
  }
}

async function handleAdvisorLeadDetail(request, env, origin, leadId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, 'GET,OPTIONS');
  if (advisorAccess.response) {
    return advisorAccess.response;
  }

  const lead = await getLeadRow(env, leadId);
  if (!lead) {
    return jsonResponse({ error: 'Lead not found.' }, 404, origin, 'GET,OPTIONS', null, noStoreHeaders());
  }

  const events = await listLeadEvents(env, leadId).catch((error) => {
    console.error('Failed to load lead events', {
      leadId,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  });

  return jsonResponse({
    ok: true,
    lead: buildLeadManagerDetail(lead, events)
  }, 200, origin, 'GET,OPTIONS', null, noStoreHeaders());
}

async function handleAdvisorLeadUpdate(request, env, origin, leadId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, 'PATCH,OPTIONS', {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }

  const currentLead = await getLeadRow(env, leadId);
  if (!currentLead) {
    return jsonResponse({ error: 'Lead not found.' }, 404, origin, 'PATCH,OPTIONS', null, noStoreHeaders());
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400, origin, 'PATCH,OPTIONS');
  }

  let validated;
  try {
    validated = validateAdvisorLeadUpdatePayload(body, currentLead);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Invalid payload.' }, 400, origin, 'PATCH,OPTIONS', null, noStoreHeaders());
  }

  await updateLeadWorkflow(env, leadId, validated, {
    previousStatus: currentLead.status,
    nextStatus: validated.status
  });
  const updatedLead = await getLeadRow(env, leadId);
  const events = await listLeadEvents(env, leadId).catch(() => []);

  return jsonResponse({
    ok: true,
    lead: buildLeadManagerDetail(updatedLead, events)
  }, 200, origin, 'PATCH,OPTIONS', null, noStoreHeaders());
}

async function handleLeadScheduleResponse(request, env) {
  const url = new URL(request.url);
  const leadId = validateLeadId(url.searchParams.get('lead'));
  const token = normalizeLeadValue(url.searchParams.get('token'));
  const response = normalizeLeadValue(url.searchParams.get('response')).toLowerCase();
  const responseStatus = response === 'accept'
    ? 'accepted'
    : (response === 'decline' || response === 'does-not-suit' ? 'declined' : '');

  if (!leadId || !/^[A-Za-z0-9_-]{32,128}$/.test(token) || !responseStatus) {
    return buildLeadScheduleResponsePage({
      heading: 'This response link is invalid',
      message: 'Please reply to the email from Planeir and Gerry will help arrange another time.',
      statusCode: 400
    });
  }

  const lead = await getLeadRow(env, leadId);
  if (!lead || !lead.scheduleResponseToken || lead.scheduleResponseToken !== token) {
    return buildLeadScheduleResponsePage({
      heading: 'This response link is no longer valid',
      message: 'Please reply to the email from Planeir and Gerry will help arrange the call.',
      statusCode: 404
    });
  }

  if (lead.scheduleResponseStatus === 'accepted') {
    return buildLeadScheduleResponsePage({
      heading: 'Your call time is already confirmed',
      message: 'Gerry can see that you accepted this proposed time.',
      lead
    });
  }

  if (lead.scheduleResponseStatus === 'declined') {
    return buildLeadScheduleResponsePage({
      heading: 'Your response is already recorded',
      message: 'Gerry can see that this proposed time does not suit and will follow up with alternatives.',
      lead
    });
  }

  if (lead.scheduleResponseExpiresAt && Date.parse(lead.scheduleResponseExpiresAt) <= Date.now()) {
    if (lead.scheduleResponseStatus !== 'expired') {
      await recordLeadScheduleResponse(env, leadId, token, 'expired');
      await insertLeadEvent(env, leadId, 'client', 'schedule-response-expired', {
        scheduledStartAt: lead.scheduledStartAt,
        scheduledEndAt: lead.scheduledEndAt,
        scheduleResponseExpiresAt: lead.scheduleResponseExpiresAt
      }).catch(() => {});
    }

    return buildLeadScheduleResponsePage({
      heading: 'This proposed slot has expired',
      message: 'Please reply to the email from Planeir and Gerry will suggest another option.',
      lead,
      statusCode: 410
    });
  }

  const respondedAt = await recordLeadScheduleResponse(env, leadId, token, responseStatus);
  await insertLeadEvent(env, leadId, 'client', responseStatus === 'accepted' ? 'schedule-accepted' : 'schedule-declined', {
    scheduledStartAt: lead.scheduledStartAt,
    scheduledEndAt: lead.scheduledEndAt,
    respondedAt
  }).catch(() => {});

  return buildLeadScheduleResponsePage({
    heading: responseStatus === 'accepted' ? 'Your call time is confirmed' : 'Thanks, Gerry will follow up',
    message: responseStatus === 'accepted'
      ? 'Thanks. Gerry can see that you accepted this time, so the Zoom call is now treated as confirmed.'
      : 'Thanks. Gerry can see that this time does not suit and will email you with alternative options.',
    lead
  });
}

async function handleSendLeadScheduleEmail(request, env, origin, leadId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, 'POST,OPTIONS', {
    requireCsrf: true,
    rateScope: 'advisor-lead-schedule-email',
    rateLimitMax: 30
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }

  const currentLead = await getLeadRow(env, leadId);
  if (!currentLead) {
    return jsonResponse({ error: 'Lead not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400, origin, 'POST,OPTIONS');
  }

  let validated;
  try {
    validated = validateAdvisorLeadUpdatePayload(body, currentLead);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Invalid payload.' }, 400, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  let schedule;
  try {
    schedule = validateLeadScheduleValues(body, currentLead, { requireSchedule: true });
  } catch (error) {
    return jsonResponse({ error: error.message || 'Schedule details are invalid.' }, 400, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  schedule.scheduledLocation = schedule.scheduledLocation || DEFAULT_LEAD_SCHEDULE_LOCATION;
  schedule.scheduledMessage = schedule.scheduledMessage || buildDefaultLeadScheduleMessage(currentLead, schedule);
  schedule.scheduleInviteUid = currentLead.scheduleInviteUid
    || `planeir-lead-${leadId}-${Date.parse(schedule.scheduledStartAt)}@planeir.ie`;
  schedule.scheduleResponseToken = createLeadScheduleResponseToken();
  schedule.scheduleResponseExpiresAt = getLeadScheduleResponseExpiresAt();
  const responseBaseUrl = normalizeEnvValue(env.LEAD_SCHEDULE_RESPONSE_BASE_URL) || new URL(request.url).origin;
  schedule.acceptUrl = buildLeadScheduleResponseUrl(responseBaseUrl, leadId, schedule.scheduleResponseToken, 'accept');
  schedule.declineUrl = buildLeadScheduleResponseUrl(responseBaseUrl, leadId, schedule.scheduleResponseToken, 'decline');

  const reusableZoomMeeting = currentLead.zoomJoinUrl
    && currentLead.scheduledStartAt === schedule.scheduledStartAt
    && currentLead.scheduledEndAt === schedule.scheduledEndAt
    ? {
      zoomMeetingId: currentLead.zoomMeetingId,
      zoomJoinUrl: currentLead.zoomJoinUrl,
      zoomMeetingPassword: currentLead.zoomMeetingPassword,
      zoomCreatedAt: currentLead.zoomCreatedAt
    }
    : null;

  try {
    const zoomMeeting = reusableZoomMeeting || (await createZoomMeeting(env, currentLead, schedule));
    schedule = {
      ...schedule,
      ...zoomMeeting,
      scheduledLocation: zoomMeeting.zoomJoinUrl
    };
  } catch (error) {
    console.error('Lead schedule Zoom meeting creation failed', {
      leadId,
      error: error instanceof Error ? error.message : String(error)
    });
    await insertLeadEvent(env, leadId, 'system', 'schedule-zoom-failed', {
      error: error instanceof Error ? error.message : String(error),
      scheduledStartAt: schedule.scheduledStartAt,
      scheduledEndAt: schedule.scheduledEndAt
    }).catch(() => {});
    return jsonResponse({ error: error.message || 'Could not create Zoom meeting.' }, 502, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  let emailResult;
  try {
    emailResult = await sendLeadScheduleEmails(env, currentLead, schedule);
  } catch (error) {
    console.error('Lead schedule email failed', {
      leadId,
      error: error instanceof Error ? error.message : String(error)
    });
    await insertLeadEvent(env, leadId, 'system', 'schedule-email-failed', {
      error: error instanceof Error ? error.message : String(error),
      scheduledStartAt: schedule.scheduledStartAt,
      scheduledEndAt: schedule.scheduledEndAt,
      zoomMeetingId: schedule.zoomMeetingId || null
    }).catch(() => {});
    return jsonResponse({ error: error.message || 'Could not send schedule email.' }, 502, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  const lastScheduleEmailSentAt = nowIso();
  await recordLeadScheduleEmailSent(env, leadId, {
    ...validated,
    ...schedule,
    status: 'awaiting-client',
    lastScheduleEmailSentAt
  });
  await insertLeadEvent(env, leadId, 'advisor', 'schedule-email-sent', {
    clientResendEmailId: emailResult.clientResendEmailId,
    advisorCopyResendEmailId: emailResult.advisorCopyResendEmailId,
    advisorCopySent: emailResult.advisorCopySent,
    advisorCopyError: emailResult.advisorCopyError || null,
    scheduledStartAt: schedule.scheduledStartAt,
    scheduledEndAt: schedule.scheduledEndAt,
    scheduledTimezone: schedule.scheduledTimezone,
    scheduledLocation: schedule.scheduledLocation,
    scheduleInviteUid: schedule.scheduleInviteUid,
    scheduleResponseExpiresAt: schedule.scheduleResponseExpiresAt,
    zoomMeetingId: schedule.zoomMeetingId || null,
    zoomJoinUrl: schedule.zoomJoinUrl || null,
    zoomCreatedAt: schedule.zoomCreatedAt || null
  }).catch((error) => {
    console.error('Failed to record lead schedule email event', {
      leadId,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  const updatedLead = await getLeadRow(env, leadId);
  const events = await listLeadEvents(env, leadId).catch(() => []);
  return jsonResponse({
    ok: true,
    lead: buildLeadManagerDetail(updatedLead, events),
    advisorCopySent: emailResult.advisorCopySent,
    advisorCopyError: emailResult.advisorCopyError || ''
  }, 200, origin, 'POST,OPTIONS', null, noStoreHeaders());
}

async function handlePublish(request, env, origin) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, 'POST,OPTIONS', {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }

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

function buildPublishedManifest(validatedPayload, publishedId) {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PUBLISHED_DEFAULT_TTL_MS).toISOString();

  return {
    v: PUBLISHED_PAYLOAD_VERSION,
    kind: PUBLISHED_SESSION_KIND,
    publishedId,
    createdAt,
    expiresAt,
    revokedAt: null,
    payload: validatedPayload.payload,
    clientAccess: validatedPayload.clientAccess,
    advisorAccess: validatedPayload.advisorAccess
  };
}

async function persistPublishedManifest(env, manifest) {
  const objectKey = getPublishedSessionKey(manifest.publishedId);
  await env.SESSIONS_BUCKET.put(objectKey, JSON.stringify(manifest), {
    httpMetadata: {
      contentType: 'application/json'
    }
  });
}

async function loadPublishedManifest(env, publishedId) {
  const objectKey = getPublishedSessionKey(publishedId);
  const object = await env.SESSIONS_BUCKET.get(objectKey);
  if (!object) {
    return null;
  }

  const text = await object.text();
  return validateStoredPublishedManifest(JSON.parse(text));
}

async function handleCreatePublishedSession(request, env, origin) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, 'POST,OPTIONS', {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400, origin, 'POST,OPTIONS');
  }

  let validated;
  try {
    validated = validatePublishedSessionCreatePayload(body);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Invalid payload.' }, 400, origin, 'POST,OPTIONS');
  }

  let recovery;
  try {
    recovery = await validatePublishedRecoveryPayload(body?.recovery, validated.data.auth);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Recovery payload is invalid.' }, 400, origin, 'POST,OPTIONS');
  }

  if (validated.kind === 'v2') {
    const publishedId = crypto.randomUUID();
    const manifest = buildPublishedManifest(validated.data, publishedId);

    try {
      await persistPublishedManifest(env, manifest);
    } catch (error) {
      console.error('Failed to store v2 published session', {
        publishedId,
        error: error instanceof Error ? error.message : String(error)
      });
      return jsonResponse({ error: 'Could not publish this session right now.' }, 500, origin, 'POST,OPTIONS');
    }

    return jsonResponse({
      ok: true,
      publishedId,
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt
    }, 201, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  const publishedId = crypto.randomUUID();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + validated.data.meta.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const clientR2Key = getPublishedClientKey(publishedId);
  const advisorR2Key = getPublishedAdvisorKey(publishedId);
  const isV4 = validated.kind === 'v4';
  const clientPinState = isV4 ? validated.data.clientBundle.clientAccess.pinState : null;
  const clientAccessRevision = isV4 ? validated.data.clientBundle.clientAccess.revision : 1;
  const encryptedRecovery = await encryptPublishedRecoveryPayload(env, recovery);

  try {
    await env.SESSIONS_BUCKET.put(clientR2Key, JSON.stringify(validated.data.clientBundle), {
      httpMetadata: { contentType: 'application/json' }
    });
    await env.SESSIONS_BUCKET.put(advisorR2Key, JSON.stringify(validated.data.advisorBundle), {
      httpMetadata: { contentType: 'application/json' }
    });
    await insertPublishedSessionRow(env, {
      id: publishedId,
      version: validated.data.v,
      status: 'active',
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      revokedAt: null,
      clientName: validated.data.meta.clientName,
      clientEmail: validated.data.meta.clientEmail,
      pinRequired: isV4 ? true : validated.data.clientBundle.clientAccess.pinRequired,
      clientAuthHashB64u: validated.data.auth.clientAuthHashB64u,
      advisorAuthHashB64u: validated.data.auth.advisorAuthHashB64u,
      clientR2Key,
      advisorR2Key,
      recoveryPayloadB64u: encryptedRecovery?.recoveryPayloadB64u || null,
      recoveryIvB64u: encryptedRecovery?.recoveryIvB64u || null,
      clientPinState,
      clientPinInitializedAt: null,
      clientAccessRevision
    });
    await insertPublishedSessionEvent(env, publishedId, 'advisor', 'published', {
      version: validated.data.v,
      pinRequired: isV4 ? true : validated.data.clientBundle.clientAccess.pinRequired,
      clientPinState,
      clientAccessRevision,
      recoveryAvailable: Boolean(encryptedRecovery),
      expiresAt
    });
  } catch (error) {
    console.error('Failed to store split published session', {
      publishedId,
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: 'Could not publish this session right now.' }, 500, origin, 'POST,OPTIONS');
  }

  return jsonResponse({
    ok: true,
    publishedId,
    createdAt,
    expiresAt,
    status: 'active',
    clientEmail: validated.data.meta.clientEmail || '',
    clientPinState: clientPinState || null,
    clientAccessRevision,
    emailSendCount: 0,
    lastEmailSentAt: null
  }, 201, origin, 'POST,OPTIONS', null, noStoreHeaders());
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
  const availabilityNotes = normalizeOptionalLeadValue(validated.availabilityNotes);

  try {
    const result = await env.LEADS_DB.prepare(`
      INSERT INTO leads (
        created_at,
        updated_at,
        full_name,
        email,
        phone,
        help_reason,
        stage,
        call_outcome,
        availability_notes,
        status,
        consent_free_call,
        consent_education_only,
        consent_recording,
        source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      createdAt,
      createdAt,
      validated.fullName,
      validated.email,
      phone,
      validated.reason,
      stage,
      callOutcome,
      availabilityNotes,
      'new',
      validated.understandsRecordedCall ? 1 : 0,
      validated.understandsEducationalOnly ? 1 : 0,
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
      availabilityNotes,
      createdAt
    };
    if (leadId) {
      await insertLeadEvent(env, leadId, 'client', 'lead-submitted', {
        source: validated.source
      }).catch((error) => {
        console.error('Failed to record lead submitted event', {
          leadId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
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
      ...corsHeaders(origin, 'GET,OPTIONS'),
      ...securityHeaders(noStoreHeaders())
    }
  });
}

async function handleRevoke(request, env, origin, sessionId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, 'POST,OPTIONS', {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }

  const objectKey = getSessionKey(sessionId);
  await env.SESSIONS_BUCKET.delete(objectKey);
  return jsonResponse({ ok: true }, 200, origin, 'POST,OPTIONS');
}

async function verifyPublishedCapability(request, source, role) {
  const rawCapability = request.headers.get('X-Published-Capability');
  if (!rawCapability) {
    return false;
  }

  const expectedHash = role === 'advisor'
    ? (source?.advisorAuthHashB64u || source?.advisorAccess?.authHashB64u)
    : (source?.clientAuthHashB64u || source?.clientAccess?.authHashB64u);
  if (!expectedHash) {
    return false;
  }

  try {
    const capabilityBytes = fromBase64Url(rawCapability.trim());
    const actualHash = await sha256Base64Url(capabilityBytes);
    return actualHash === expectedHash;
  } catch (_error) {
    return false;
  }
}

function isPublishedManifestExpired(manifest) {
  return Date.parse(manifest.expiresAt) <= Date.now();
}

function buildPublishedSessionResponse(manifest, role) {
  const response = {
    v: PUBLISHED_PAYLOAD_VERSION,
    role,
    publishedId: manifest.publishedId,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    payload: manifest.payload
  };

  response[role === 'advisor' ? 'advisorAccess' : 'clientAccess'] = role === 'advisor'
    ? { wrap: manifest.advisorAccess.wrap }
    : {
      pinRequired: manifest.clientAccess.pinRequired,
      wrap: manifest.clientAccess.wrap
    };

  return response;
}

function buildPublishedSessionResponseV3(row, bundle, role) {
  const response = {
    v: row.version,
    role,
    publishedId: row.id,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: row.status,
    payload: bundle.payload
  };

  if (role === 'advisor') {
    response.advisorAccess = bundle.advisorAccess;
    response.meta = {
      clientName: row.clientName,
      clientEmail: row.clientEmail,
      pinRequired: row.pinRequired,
      clientPinState: row.clientPinState,
      clientPinInitializedAt: row.clientPinInitializedAt,
      clientAccessRevision: row.clientAccessRevision,
      lastEmailSentAt: row.lastEmailSentAt,
      emailSendCount: row.emailSendCount,
      lastAdvisorOpenedAt: row.lastAdvisorOpenedAt,
      advisorOpenCount: row.advisorOpenCount,
      lastAdvisorUnlockedAt: row.lastAdvisorUnlockedAt,
      advisorUnlockCount: row.advisorUnlockCount
    };
  } else {
    response.clientAccess = bundle.clientAccess;
  }

  return response;
}

async function loadPublishedSessionBundle(env, objectKey) {
  const object = await env.SESSIONS_BUCKET.get(objectKey);
  if (!object) {
    return null;
  }

  return JSON.parse(await object.text());
}

async function handleGetPublishedSessionV2(request, env, origin, publishedId, role) {
  let manifest;
  try {
    manifest = await loadPublishedManifest(env, publishedId);
  } catch (error) {
    console.error('Failed to read published session manifest', {
      publishedId,
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: 'Could not load this session right now.' }, 500, origin, 'GET,OPTIONS');
  }

  if (!manifest) {
    return null;
  }

  const authorized = await verifyPublishedCapability(request, manifest, role);
  if (!authorized) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'GET,OPTIONS', null, noStoreHeaders());
  }

  if (manifest.revokedAt || isPublishedManifestExpired(manifest)) {
    return jsonResponse({ error: 'This secure session is no longer available.' }, 410, origin, 'GET,OPTIONS', null, noStoreHeaders());
  }

  return jsonResponse(
    buildPublishedSessionResponse(manifest, role),
    200,
    origin,
    'GET,OPTIONS',
    null,
    noStoreHeaders()
  );
}

async function handleGetPublishedSessionV3(request, env, origin, publishedId, role) {
  let row = await getPublishedSessionRow(env, publishedId);
  if (!row) {
    return null;
  }

  row = await markPublishedExpiredIfNeeded(env, row);
  if (role === 'advisor') {
    const advisorAccess = await requireAdvisorSession(request, env, origin, 'GET,OPTIONS', {
      requireCsrf: false
    });
    if (advisorAccess.response) {
      return advisorAccess.response;
    }
  }
  const authorized = await verifyPublishedCapability(request, row, role);
  if (!authorized) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'GET,OPTIONS', null, noStoreHeaders());
  }

  if (row.status === 'revoked' || row.status === 'expired') {
    return jsonResponse({ error: 'This secure session is no longer available.' }, 410, origin, 'GET,OPTIONS', null, noStoreHeaders());
  }

  const objectKey = role === 'advisor' ? row.advisorR2Key : row.clientR2Key;
  let bundle = await loadPublishedSessionBundle(env, objectKey);
  if (!bundle) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'GET,OPTIONS', null, noStoreHeaders());
  }
  bundle = validatePublishedBundlePayload(
    bundle,
    role === 'advisor' ? PUBLISHED_ADVISOR_KIND : PUBLISHED_CLIENT_KIND,
    role === 'advisor' ? 'advisorAccess' : 'clientAccess'
  );

  await recordPublishedOpen(env, publishedId, role);
  await insertPublishedSessionEvent(env, publishedId, role, 'bundle-fetched', {
    version: row.version
  });

  const refreshedRow = await getPublishedSessionRow(env, publishedId);
  return jsonResponse(
    buildPublishedSessionResponseV3(refreshedRow || row, bundle, role),
    200,
    origin,
    'GET,OPTIONS',
    null,
    noStoreHeaders()
  );
}

async function handleGetPublishedSession(request, env, origin, publishedId, role) {
  const clientIp = getClientIp(request);
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: 'Too many requests. Please try again later.' }, 429, origin, 'GET,OPTIONS');
  }

  try {
    const v3Response = await handleGetPublishedSessionV3(request, env, origin, publishedId, role);
    if (v3Response) {
      return v3Response;
    }

    const v2Response = await handleGetPublishedSessionV2(request, env, origin, publishedId, role);
    if (v2Response) {
      return v2Response;
    }
  } catch (error) {
    console.error('Failed to load published session', {
      publishedId,
      role,
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: 'Could not load this session right now.' }, 500, origin, 'GET,OPTIONS');
  }

  return jsonResponse({ error: 'Not found.' }, 404, origin, 'GET,OPTIONS', null, noStoreHeaders());
}

async function handleRevokePublishedSession(request, env, origin, publishedId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, 'POST,OPTIONS', {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }

  const row = await getPublishedSessionRow(env, publishedId);
  if (row) {
    const authorized = await verifyPublishedCapability(request, row, 'advisor');
    if (!authorized) {
      return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
    }

    const revokedAt = nowIso();
    await updatePublishedStatus(env, publishedId, 'revoked', revokedAt);
    await deletePublishedQrAsset(env, row.qrAssetR2Key).catch((error) => {
      console.error('Failed to delete QR asset on revoke', {
        publishedId,
        qrAssetR2Key: row.qrAssetR2Key,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    await clearPublishedQrAssetMetadata(env, publishedId);
    await insertPublishedSessionEvent(env, publishedId, 'advisor', 'revoked', null);
    return jsonResponse({ ok: true, status: 'revoked', revokedAt }, 200, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  let manifest;
  try {
    manifest = await loadPublishedManifest(env, publishedId);
  } catch (error) {
    console.error('Failed to read published session for revoke', {
      publishedId,
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: 'Could not revoke this session right now.' }, 500, origin, 'POST,OPTIONS');
  }

  if (!manifest) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  const authorized = await verifyPublishedCapability(request, manifest, 'advisor');
  if (!authorized) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  if (manifest.revokedAt || isPublishedManifestExpired(manifest)) {
    return jsonResponse({ ok: true, status: manifest.revokedAt ? 'revoked' : 'expired' }, 200, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  if (!manifest.revokedAt) {
    manifest.revokedAt = new Date().toISOString();

    try {
      await persistPublishedManifest(env, manifest);
    } catch (error) {
      console.error('Failed to persist published revoke', {
        publishedId,
        error: error instanceof Error ? error.message : String(error)
      });
      return jsonResponse({ error: 'Could not revoke this session right now.' }, 500, origin, 'POST,OPTIONS');
    }
  }

  return jsonResponse({ ok: true }, 200, origin, 'POST,OPTIONS', null, noStoreHeaders());
}

async function handleExtendPublishedSession(request, env, origin, publishedId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, 'POST,OPTIONS', {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }

  const row = await getPublishedSessionRow(env, publishedId);
  if (!row) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  const authorized = await verifyPublishedCapability(request, row, 'advisor');
  if (!authorized) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  if (row.status === 'revoked') {
    return jsonResponse({ error: 'Revoked sessions cannot be extended.' }, 410, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400, origin, 'POST,OPTIONS');
  }

  const expiresInDays = normalizePublishedExpiryDays(body?.expiresInDays);
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  await updatePublishedExpiry(env, publishedId, expiresAt);
  await insertPublishedSessionEvent(env, publishedId, 'advisor', 'extended', {
    expiresAt,
    expiresInDays
  });

  return jsonResponse({
    ok: true,
    status: 'active',
    expiresAt
  }, 200, origin, 'POST,OPTIONS', null, noStoreHeaders());
}

async function handlePublishedClientPinSetup(request, env, origin, publishedId) {
  const originError = requireTrustedOrigin(origin, 'POST,OPTIONS');
  if (originError) {
    return originError;
  }

  const clientIp = getClientIp(request);
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: 'Too many requests. Please try again later.' }, 429, origin, 'POST,OPTIONS');
  }

  let row = await getPublishedSessionRow(env, publishedId);
  if (!row) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  row = await markPublishedExpiredIfNeeded(env, row);
  const authorized = await verifyPublishedCapability(request, row, 'client');
  if (!authorized) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  if (row.status !== 'active') {
    return jsonResponse({ error: 'This secure session is no longer active.' }, 410, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  if (row.version !== PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    return jsonResponse({ error: 'This secure session does not support first-open PIN setup.' }, 400, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400, origin, 'POST,OPTIONS');
  }

  let validated;
  try {
    validated = validatePublishedClientPinSetupPayload(body);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Invalid payload.' }, 400, origin, 'POST,OPTIONS');
  }

  if (row.clientPinState !== 'pending' || row.clientAccessRevision !== validated.expectedRevision) {
    return jsonResponse({
      error: 'This secure link has already been claimed.',
      clientPinState: row.clientPinState,
      clientAccessRevision: row.clientAccessRevision
    }, 409, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  const clientPinInitializedAt = nowIso();
  await env.SESSIONS_BUCKET.put(row.clientR2Key, JSON.stringify(validated.clientBundle), {
    httpMetadata: { contentType: 'application/json' }
  });
  await updatePublishedClientPinSetupMetadata(env, publishedId, {
    clientPinState: 'active',
    clientPinInitializedAt,
    clientAccessRevision: validated.clientBundle.clientAccess.revision
  });
  await insertPublishedSessionEvent(env, publishedId, 'client', 'client-pin-created', {
    previousClientAccessRevision: row.clientAccessRevision,
    clientAccessRevision: validated.clientBundle.clientAccess.revision,
    requestIp: clientIp,
    userAgent: normalizeUserAgent(request.headers.get('User-Agent'))
  });

  return jsonResponse({
    ok: true,
    clientPinState: 'active',
    clientPinInitializedAt,
    clientAccessRevision: validated.clientBundle.clientAccess.revision
  }, 200, origin, 'POST,OPTIONS', null, noStoreHeaders());
}

async function handleResetPublishedClientAccess(request, env, origin, publishedId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, 'POST,OPTIONS', {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }

  let row = await getPublishedSessionRow(env, publishedId);
  if (!row) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  row = await markPublishedExpiredIfNeeded(env, row);
  const authorized = await verifyPublishedCapability(request, row, 'advisor');
  if (!authorized) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  if (row.status !== 'active') {
    return jsonResponse({ error: 'This secure session is no longer active.' }, 410, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  if (row.version !== PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    return jsonResponse({ error: 'Client access reset is only supported for v4 published sessions.' }, 400, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400, origin, 'POST,OPTIONS');
  }

  let validated;
  try {
    validated = validatePublishedClientAccessResetPayload(body);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Invalid payload.' }, 400, origin, 'POST,OPTIONS');
  }

  if (row.clientAccessRevision !== validated.expectedRevision) {
    return jsonResponse({
      error: 'This published session was already updated. Refresh the published access details and try again.',
      clientPinState: row.clientPinState,
      clientAccessRevision: row.clientAccessRevision
    }, 409, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  const previousQrAssetR2Key = row.qrAssetR2Key || '';
  await env.SESSIONS_BUCKET.put(row.clientR2Key, JSON.stringify(validated.clientBundle), {
    httpMetadata: { contentType: 'application/json' }
  });
  await env.SESSIONS_BUCKET.put(row.advisorR2Key, JSON.stringify(validated.advisorBundle), {
    httpMetadata: { contentType: 'application/json' }
  });
  let updatedRecovery = null;
  if (row.recoveryAvailable && validated.clientSecretB64u) {
    const existingRecovery = await decryptPublishedRecoveryPayload(env, row).catch(() => null);
    if (existingRecovery?.advisorSecretB64u) {
      updatedRecovery = await encryptPublishedRecoveryPayload(env, {
        clientSecretB64u: validated.clientSecretB64u,
        advisorSecretB64u: existingRecovery.advisorSecretB64u
      });
    }
  }
  await resetPublishedClientAccessMetadata(env, publishedId, {
    clientAuthHashB64u: validated.clientAuthHashB64u,
    clientPinState: 'pending',
    clientAccessRevision: validated.clientBundle.clientAccess.revision,
    recoveryPayloadB64u: updatedRecovery?.recoveryPayloadB64u || row.recoveryPayloadB64u || null,
    recoveryIvB64u: updatedRecovery?.recoveryIvB64u || row.recoveryIvB64u || null
  });
  await insertPublishedSessionEvent(env, publishedId, 'advisor', 'client-access-reset', {
    previousClientAccessRevision: row.clientAccessRevision,
    clientAccessRevision: validated.clientBundle.clientAccess.revision,
    previousClientPinState: row.clientPinState,
    clientPinState: 'pending',
    requestIp: advisorAccess.clientIp,
    userAgent: normalizeUserAgent(request.headers.get('User-Agent'))
  });

  if (previousQrAssetR2Key) {
    await deletePublishedQrAsset(env, previousQrAssetR2Key).catch((error) => {
      console.error('Failed to delete superseded QR asset on client access reset', {
        publishedId,
        previousQrAssetR2Key,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  const updatedRow = await getPublishedSessionRow(env, publishedId);
  return jsonResponse({
    ok: true,
    status: 'active',
    clientPinState: 'pending',
    clientAccessRevision: validated.clientBundle.clientAccess.revision,
    clientEmail: updatedRow?.clientEmail || row.clientEmail,
    lastEmailSentAt: null,
    emailSendCount: 0
  }, 200, origin, 'POST,OPTIONS', null, noStoreHeaders());
}

async function handlePublishedSessionUnlocked(request, env, origin, publishedId) {
  const originError = requireTrustedOrigin(origin, 'POST,OPTIONS');
  if (originError) {
    return originError;
  }

  const clientIp = getClientIp(request);
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: 'Too many requests. Please try again later.' }, 429, origin, 'POST,OPTIONS');
  }

  let body = null;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    body = null;
  }

  const role = body?.role === 'advisor' ? 'advisor' : 'client';
  const source = normalizeLeadValue(body?.source || '') || (role === 'advisor' ? 'advisor-reopen' : 'viewer');
  if (role === 'advisor') {
    const advisorAccess = await requireAdvisorSession(request, env, origin, 'POST,OPTIONS', {
      requireCsrf: false
    });
    if (advisorAccess.response) {
      return advisorAccess.response;
    }
  }

  let row = await getPublishedSessionRow(env, publishedId);
  if (row) {
    row = await markPublishedExpiredIfNeeded(env, row);
    const authorized = await verifyPublishedCapability(request, row, role);
    if (!authorized) {
      return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
    }

    if (row.status !== 'active') {
      return jsonResponse({ error: 'This secure session is no longer active.' }, 410, origin, 'POST,OPTIONS', null, noStoreHeaders());
    }

    await recordPublishedUnlock(env, publishedId, role);
    await insertPublishedSessionEvent(env, publishedId, role, 'unlocked', {
      version: row.version,
      source,
      requestIp: clientIp,
      userAgent: normalizeUserAgent(request.headers.get('User-Agent'))
    });

    return jsonResponse({ ok: true }, 200, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  let manifest;
  try {
    manifest = await loadPublishedManifest(env, publishedId);
  } catch (error) {
    console.error('Failed to read published session manifest for unlock telemetry', {
      publishedId,
      role,
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: 'Could not verify this secure session right now.' }, 500, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  if (!manifest) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  const authorized = await verifyPublishedCapability(request, manifest, role);
  if (!authorized) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  if (manifest.revokedAt || isPublishedManifestExpired(manifest)) {
    return jsonResponse({ error: 'This secure session is no longer active.' }, 410, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  return jsonResponse({ ok: true }, 200, origin, 'POST,OPTIONS', null, noStoreHeaders());
}

async function handleSendPublishedAdvisorNotification(request, env, origin, ctx, publishedId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, 'POST,OPTIONS', {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }

  let row = await getPublishedSessionRow(env, publishedId);
  if (!row) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  row = await markPublishedExpiredIfNeeded(env, row);
  const authorized = await verifyPublishedCapability(request, row, 'advisor');
  if (!authorized) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  if (row.status !== 'active') {
    return jsonResponse({ error: 'This secure session is no longer active.' }, 410, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400, origin, 'POST,OPTIONS');
  }

  let advisorLink;
  let clientLink = null;
  try {
    advisorLink = validatePublishedAdvisorLink(body?.advisorLink, publishedId);
    clientLink = validateOptionalPublishedClientNotificationLink(body?.clientLink, publishedId);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Published links are invalid.' }, 400, origin, 'POST,OPTIONS');
  }

  const emailTask = sendPublishedAdvisorNotificationEmail(env, row, {
    advisorLink,
    clientLink
  });
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(emailTask);
  } else {
    void emailTask;
  }

  return jsonResponse({
    ok: true,
    queued: true
  }, 202, origin, 'POST,OPTIONS', null, noStoreHeaders());
}

async function handleSendPublishedSessionEmail(request, env, origin, publishedId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, 'POST,OPTIONS', {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }

  const clientIp = advisorAccess.clientIp;

  const row = await getPublishedSessionRow(env, publishedId);
  if (!row) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  const authorized = await verifyPublishedCapability(request, row, 'advisor');
  if (!authorized) {
    return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  if (row.status !== 'active') {
    return jsonResponse({ error: 'This secure session is no longer active.' }, 410, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400, origin, 'POST,OPTIONS');
  }

  let clientEmail;
  let clientName;
  try {
    clientEmail = normalizePublishedEmail(body?.clientEmail || row.clientEmail);
    clientName = normalizePublishedClientName(body?.clientName || row.clientName);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Invalid email payload.' }, 400, origin, 'POST,OPTIONS');
  }

  let validatedClientLink;
  try {
    validatedClientLink = validatePublishedClientLink(body?.clientLink, publishedId);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Client link is invalid.' }, 400, origin, 'POST,OPTIONS');
  }

  const pin = row.version >= PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION ? '' : normalizeLeadValue(body?.pin);
  const includePinInEmail = row.version < PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION
    && body?.includePinInEmail === true
    && row.pinRequired;
  const acknowledgedInlinePinRisk = body?.acknowledgeInlinePinRisk === true;
  if (includePinInEmail && !/^\d{6}$/.test(pin)) {
    return jsonResponse({ error: 'PIN must be a 6-digit number to include it in the email.' }, 400, origin, 'POST,OPTIONS');
  }
  if (includePinInEmail && !acknowledgedInlinePinRisk) {
    return jsonResponse({ error: 'Confirm inline PIN delivery before sending the final email.' }, 400, origin, 'POST,OPTIONS');
  }

  let qrImage = null;
  try {
    qrImage = parseQrImageDataUrl(body?.qrImageDataUrl);
  } catch (error) {
    return jsonResponse({ error: error.message || 'QR image is invalid.' }, 400, origin, 'POST,OPTIONS');
  }
  if (!qrImage) {
    return jsonResponse({ error: 'QR image is required to send the final email.' }, 400, origin, 'POST,OPTIONS');
  }

  const emailConfig = getPublishedEmailConfig(env);
  if (!emailConfig.apiKey || !emailConfig.from) {
    return jsonResponse({ error: 'Session email delivery is not configured right now.' }, 500, origin, 'POST,OPTIONS');
  }

  const previousQrAssetR2Key = row.qrAssetR2Key || '';
  let qrAssetToken = row.qrAssetToken || '';
  let qrAssetR2Key = row.qrAssetR2Key || '';
  let qrAssetContentType = row.qrAssetContentType || '';
  let shouldDeletePreviousQrAsset = false;
  if (qrImage) {
    qrAssetToken = crypto.randomUUID().replace(/-/g, '');
    qrAssetR2Key = getPublishedQrAssetKey(publishedId, qrAssetToken);
    qrAssetContentType = qrImage.contentType;
    await env.SESSIONS_BUCKET.put(qrAssetR2Key, qrImage.bytes, {
      httpMetadata: {
        contentType: qrImage.contentType
      }
    });
    shouldDeletePreviousQrAsset = Boolean(previousQrAssetR2Key && previousQrAssetR2Key !== qrAssetR2Key);
  }

  const requestUrl = new URL(request.url);
  const qrImageUrl = qrAssetToken
    ? `${requestUrl.origin}/email-assets/qr/${encodeURIComponent(publishedId)}/${encodeURIComponent(qrAssetToken)}`
    : '';
  const expiresAtDisplay = new Date(row.expiresAt).toLocaleString('en-IE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Dublin'
  });

  try {
    await sendEmailWithResend(emailConfig, {
      from: emailConfig.from,
      to: [clientEmail],
      subject: `Your Planeir session with Gerry`,
      html: buildPublishedSessionEmailHtml({
        clientName,
        clientLink: validatedClientLink.href,
        expiresAtDisplay,
        pin,
        includePinInEmail,
        clientCreatesPinOnFirstOpen: row.version >= PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION,
        qrImageUrl
      }),
      text: buildPublishedSessionEmailText({
        clientName,
        clientLink: validatedClientLink.href,
        expiresAtDisplay,
        pin,
        includePinInEmail,
        clientCreatesPinOnFirstOpen: row.version >= PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION
      }),
      bcc: emailConfig.trustpilotAfsRecipients.length > 0
        ? emailConfig.trustpilotAfsRecipients
        : undefined,
      reply_to: emailConfig.replyTo || undefined
    }, `published-session-${publishedId}-email-${row.emailSendCount + 1}`);
  } catch (error) {
    if (qrImage && qrAssetR2Key && qrAssetR2Key !== previousQrAssetR2Key) {
      await deletePublishedQrAsset(env, qrAssetR2Key).catch((cleanupError) => {
        console.error('Failed to clean up unsent QR asset', {
          publishedId,
          qrAssetR2Key,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        });
      });
    }
    console.error('Failed to send published session email', {
      publishedId,
      clientEmail,
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: error instanceof Error ? error.message : 'Could not send the final email right now.' }, 502, origin, 'POST,OPTIONS', null, noStoreHeaders());
  }

  const lastEmailSentAt = nowIso();
  await updatePublishedEmailMetadata(env, publishedId, {
    clientEmail,
    lastEmailSentAt,
    qrAssetToken,
    qrAssetR2Key,
    qrAssetContentType
  });
  await insertPublishedSessionEvent(env, publishedId, 'advisor', 'email-sent', {
    clientEmail,
    clientEmailChanged: Boolean(row.clientEmail && row.clientEmail !== clientEmail),
    includePinInEmail,
    acknowledgedInlinePinRisk,
    clientCreatesPinOnFirstOpen: row.version >= PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION,
    trustpilotAfsTriggered: emailConfig.trustpilotAfsRecipients.length > 0,
    hasQrImage: Boolean(qrImage),
    rotatedQrToken: qrAssetToken !== (row.qrAssetToken || ''),
    requestIp: clientIp,
    userAgent: normalizeUserAgent(request.headers.get('User-Agent')),
    clientLinkHost: validatedClientLink.host,
    clientLinkPath: validatedClientLink.path,
    clientLinkPubMatches: true
  });

  if (shouldDeletePreviousQrAsset) {
    await deletePublishedQrAsset(env, previousQrAssetR2Key).catch((cleanupError) => {
      console.error('Failed to delete superseded QR asset', {
        publishedId,
        previousQrAssetR2Key,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      });
    });
  }

  const updatedRow = await getPublishedSessionRow(env, publishedId);
  return jsonResponse({
    ok: true,
    clientEmail,
    lastEmailSentAt,
    emailSendCount: updatedRow?.emailSendCount || row.emailSendCount + 1
  }, 200, origin, 'POST,OPTIONS', null, noStoreHeaders());
}

async function handlePublishedQrAsset(env, publishedId, token) {
  let row = await getPublishedSessionRow(env, publishedId);
  if (!row) {
    return new Response('Not found.', { status: 404 });
  }

  row = await markPublishedExpiredIfNeeded(env, row);
  if (row.status !== 'active' || !row.qrAssetToken || row.qrAssetToken !== token || !row.qrAssetR2Key) {
    return new Response('Not found.', { status: 404 });
  }

  const object = await env.SESSIONS_BUCKET.get(row.qrAssetR2Key);
  if (!object) {
    return new Response('Not found.', { status: 404 });
  }

  const bytes = await object.arrayBuffer();
  return assetResponse(bytes, 200, row.qrAssetContentType || 'image/png', {
    ...noStoreHeaders()
  });
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

    if (request.method === 'GET' && pathname === '/api/leads/schedule-response') {
      return handleLeadScheduleResponse(request, env);
    }

    if (request.method === 'POST' && pathname === '/api/publish') {
      return handlePublish(request, env, origin);
    }

    if (request.method === 'POST' && pathname === '/api/published-sessions') {
      return handleCreatePublishedSession(request, env, origin);
    }

    if (request.method === 'GET' && pathname === '/api/advisor/published-sessions') {
      return handleAdvisorPublishedSessionsList(request, env, origin);
    }

    if (request.method === 'GET' && pathname === '/api/advisor/leads') {
      return handleAdvisorLeadsList(request, env, origin);
    }

    if (request.method === 'GET' && pathname === '/api/auth/session') {
      return handleAdvisorSession(request, env, origin);
    }

    if (request.method === 'POST' && pathname === '/api/auth/login') {
      return handleAdvisorLogin(request, env, origin);
    }

    if (request.method === 'POST' && pathname === '/api/auth/logout') {
      return handleAdvisorLogout(request, env, origin);
    }

    const getMatch = /^\/api\/session\/([^/]+)$/.exec(pathname);
    if (request.method === 'GET' && getMatch) {
      const sessionId = getMatch[1];
      if (!isSafeSessionId(sessionId)) {
        return jsonResponse({ error: 'Invalid session id.' }, 400, origin, 'GET,OPTIONS');
      }

      return handleGetSession(request, env, origin, sessionId);
    }

    const getPublishedMatch = /^\/api\/published-sessions\/([^/]+)\/(client|advisor)$/.exec(pathname);
    if (request.method === 'GET' && getPublishedMatch) {
      const publishedId = getPublishedMatch[1];
      const role = getPublishedMatch[2];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: 'Not found.' }, 404, origin, 'GET,OPTIONS', requestHeaders, noStoreHeaders());
      }

      return handleGetPublishedSession(request, env, origin, publishedId, role);
    }

    const getAdvisorPublishedMatch = /^\/api\/advisor\/published-sessions\/([^/]+)$/.exec(pathname);
    if (request.method === 'GET' && getAdvisorPublishedMatch) {
      const publishedId = getAdvisorPublishedMatch[1];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: 'Not found.' }, 404, origin, 'GET,OPTIONS', requestHeaders, noStoreHeaders());
      }

      return handleAdvisorPublishedSessionDetail(request, env, origin, publishedId);
    }

    const sendLeadScheduleEmailMatch = /^\/api\/advisor\/leads\/(\d+)\/send-schedule-email$/.exec(pathname);
    if (request.method === 'POST' && sendLeadScheduleEmailMatch) {
      const leadId = validateLeadId(sendLeadScheduleEmailMatch[1]);
      if (!leadId) {
        return jsonResponse({ error: 'Lead not found.' }, 404, origin, 'POST,OPTIONS', requestHeaders, noStoreHeaders());
      }

      return handleSendLeadScheduleEmail(request, env, origin, leadId);
    }

    const advisorLeadMatch = /^\/api\/advisor\/leads\/(\d+)$/.exec(pathname);
    if ((request.method === 'GET' || request.method === 'PATCH') && advisorLeadMatch) {
      const leadId = validateLeadId(advisorLeadMatch[1]);
      if (!leadId) {
        return jsonResponse({ error: 'Lead not found.' }, 404, origin, `${request.method},OPTIONS`, requestHeaders, noStoreHeaders());
      }

      if (request.method === 'GET') {
        return handleAdvisorLeadDetail(request, env, origin, leadId);
      }

      return handleAdvisorLeadUpdate(request, env, origin, leadId);
    }

    const revokeMatch = /^\/api\/revoke\/([^/]+)$/.exec(pathname);
    if (request.method === 'POST' && revokeMatch) {
      const sessionId = revokeMatch[1];
      if (!isSafeSessionId(sessionId)) {
        return jsonResponse({ error: 'Invalid session id.' }, 400, origin, 'POST,OPTIONS');
      }

      return handleRevoke(request, env, origin, sessionId);
    }

    const revokePublishedMatch = /^\/api\/published-sessions\/([^/]+)\/revoke$/.exec(pathname);
    if (request.method === 'POST' && revokePublishedMatch) {
      const publishedId = revokePublishedMatch[1];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', requestHeaders, noStoreHeaders());
      }

      return handleRevokePublishedSession(request, env, origin, publishedId);
    }

    const extendPublishedMatch = /^\/api\/published-sessions\/([^/]+)\/extend$/.exec(pathname);
    if (request.method === 'POST' && extendPublishedMatch) {
      const publishedId = extendPublishedMatch[1];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', requestHeaders, noStoreHeaders());
      }

      return handleExtendPublishedSession(request, env, origin, publishedId);
    }

    const sendEmailPublishedMatch = /^\/api\/published-sessions\/([^/]+)\/send-email$/.exec(pathname);
    if (request.method === 'POST' && sendEmailPublishedMatch) {
      const publishedId = sendEmailPublishedMatch[1];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', requestHeaders, noStoreHeaders());
      }

      return handleSendPublishedSessionEmail(request, env, origin, publishedId);
    }

    const sendAdvisorNotificationPublishedMatch = /^\/api\/published-sessions\/([^/]+)\/send-advisor-notification$/.exec(pathname);
    if (request.method === 'POST' && sendAdvisorNotificationPublishedMatch) {
      const publishedId = sendAdvisorNotificationPublishedMatch[1];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', requestHeaders, noStoreHeaders());
      }

      return handleSendPublishedAdvisorNotification(request, env, origin, ctx, publishedId);
    }

    const clientPinSetupMatch = /^\/api\/published-sessions\/([^/]+)\/client-pin\/setup$/.exec(pathname);
    if (request.method === 'POST' && clientPinSetupMatch) {
      const publishedId = clientPinSetupMatch[1];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', requestHeaders, noStoreHeaders());
      }

      return handlePublishedClientPinSetup(request, env, origin, publishedId);
    }

    const resetClientAccessMatch = /^\/api\/published-sessions\/([^/]+)\/client-access\/reset$/.exec(pathname);
    if (request.method === 'POST' && resetClientAccessMatch) {
      const publishedId = resetClientAccessMatch[1];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', requestHeaders, noStoreHeaders());
      }

      return handleResetPublishedClientAccess(request, env, origin, publishedId);
    }

    const unlockedPublishedMatch = /^\/api\/published-sessions\/([^/]+)\/unlocked$/.exec(pathname);
    if (request.method === 'POST' && unlockedPublishedMatch) {
      const publishedId = unlockedPublishedMatch[1];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: 'Not found.' }, 404, origin, 'POST,OPTIONS', requestHeaders, noStoreHeaders());
      }

      return handlePublishedSessionUnlocked(request, env, origin, publishedId);
    }

    const qrAssetMatch = /^\/email-assets\/qr\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (request.method === 'GET' && qrAssetMatch) {
      const publishedId = qrAssetMatch[1];
      const token = qrAssetMatch[2];
      if (!isSafeSessionId(publishedId) || !/^[a-zA-Z0-9_-]{16,80}$/.test(token)) {
        return new Response('Not found.', { status: 404 });
      }

      return handlePublishedQrAsset(env, publishedId, token);
    }

    return jsonResponse({ error: 'Not found.' }, 404, origin, routeConfig?.methods, requestHeaders);
  }
};
