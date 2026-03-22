var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var PAYLOAD_VERSION = 1;
var SESSION_KEY_PREFIX = "sessions/";
var SESSION_KEY_SUFFIX = ".json";
var PUBLISHED_PAYLOAD_VERSION = 2;
var PUBLISHED_SPLIT_PAYLOAD_VERSION = 3;
var PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION = 4;
var PUBLISHED_SESSION_KEY_PREFIX = "published/v2/";
var PUBLISHED_CLIENT_KEY_PREFIX = "published/client/";
var PUBLISHED_ADVISOR_KEY_PREFIX = "published/advisor/";
var PUBLISHED_EMAIL_ASSET_KEY_PREFIX = "published/email-assets/";
var PUBLISHED_SESSION_KIND = "published-session";
var PUBLISHED_CLIENT_KIND = "published-client-session";
var PUBLISHED_ADVISOR_KIND = "published-advisor-session";
var MAX_CT_B64_LENGTH = 28e5;
var MAX_IV_B64_LENGTH = 64;
var MAX_SALT_B64_LENGTH = 128;
var MAX_WRAP_CT_B64U_LENGTH = 12e3;
var MAX_AUTH_HASH_B64U_LENGTH = 128;
var MAX_CAPABILITY_TOKEN_B64U_LENGTH = 128;
var MAX_QR_IMAGE_DATA_URL_LENGTH = 15e5;
var RATE_LIMIT_WINDOW_MS = 6e4;
var RATE_LIMIT_MAX_REQUESTS = 80;
var PUBLISHED_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var PUBLISHED_ALLOWED_EXPIRY_DAYS = /* @__PURE__ */ new Set([7, 30, 90]);
var PUBLISHED_CLIENT_LINK_HOSTS = /* @__PURE__ */ new Set(["planeir.ie", "www.planeir.ie"]);
var PUBLISHED_CLIENT_LINK_PATH = "/app/session.html";
var ADVISOR_SESSION_COOKIE = "planeir_advisor_session";
var ADVISOR_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var ADVISOR_AUTH_PBKDF2_ITERATIONS = 1e5;
var ADVISOR_LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1e3;
var ADVISOR_LOGIN_RATE_LIMIT_MAX = 10;
var ADVISOR_ADMIN_RATE_LIMIT_WINDOW_MS = 60 * 1e3;
var ADVISOR_ADMIN_RATE_LIMIT_MAX = 60;
var MAX_ADVISOR_PASSWORD_LENGTH = 256;
var MAX_LEAD_NAME_LENGTH = 120;
var MAX_LEAD_EMAIL_LENGTH = 160;
var MAX_LEAD_PHONE_LENGTH = 40;
var MAX_LEAD_REASON_LENGTH = 2e3;
var MAX_CLIENT_NAME_LENGTH = 160;
var MAX_CLIENT_EMAIL_LENGTH = 160;
var MAX_USER_AGENT_LENGTH = 512;
var MAX_ADVISOR_SESSION_TOKEN_LENGTH = 4096;
var PREFLIGHT_MAX_AGE_SECONDS = 86400;
var DEFAULT_ALLOWED_REQUEST_HEADERS = "Content-Type";
var RESEND_EMAILS_API_URL = "https://api.resend.com/emails";
var LEAD_SOURCE_LABEL = "Planeir landing page";
var DEFAULT_ALLOWED_ORIGINS = /* @__PURE__ */ new Set([
  "https://planeir.ie",
  "https://www.planeir.ie",
  "https://geraldboylan01.github.io"
]);
var TRUEISH_ENV_VALUES = /* @__PURE__ */ new Set(["1", "true", "yes", "on"]);
var ALLOWED_LEAD_STAGES = /* @__PURE__ */ new Set([
  "buying-a-home",
  "building-wealth",
  "retirement-planning",
  "financial-education",
  "other"
]);
var ALLOWED_CALL_OUTCOMES = /* @__PURE__ */ new Set([
  "clearer-understanding",
  "reassurance",
  "decision-support",
  "comparing-options",
  "sense-check-on-a-plan",
  "other"
]);
var LEAD_STAGE_LABELS = {
  "buying-a-home": "Buying a home",
  "building-wealth": "Building wealth",
  "retirement-planning": "Retirement planning",
  "financial-education": "Financial education",
  other: "Other"
};
var CALL_OUTCOME_LABELS = {
  "clearer-understanding": "Clearer understanding",
  reassurance: "Reassurance",
  "decision-support": "Decision support",
  "comparing-options": "Comparing options",
  "sense-check-on-a-plan": "Sense-check on a plan",
  other: "Other"
};
var requestBuckets = /* @__PURE__ */ new Map();
function getAllowedOrigins(env) {
  const raw = String(env.ALLOWED_ORIGINS || "");
  const configuredOrigins = raw.split(",").map((value) => value.trim()).filter(Boolean);
  return /* @__PURE__ */ new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...configuredOrigins
  ]);
}
__name(getAllowedOrigins, "getAllowedOrigins");
function normalizePathname(pathname) {
  if (pathname.length <= 1) {
    return pathname;
  }
  return pathname.replace(/\/+$/, "");
}
__name(normalizePathname, "normalizePathname");
function getRouteConfig(pathname) {
  if (pathname === "/api/leads") {
    return {
      methods: "POST,OPTIONS"
    };
  }
  if (pathname === "/api/publish") {
    return {
      methods: "POST,OPTIONS"
    };
  }
  if (pathname === "/api/published-sessions") {
    return {
      methods: "POST,OPTIONS"
    };
  }
  if (pathname === "/api/auth/session") {
    return {
      methods: "GET,OPTIONS"
    };
  }
  if (pathname === "/api/auth/login") {
    return {
      methods: "POST,OPTIONS"
    };
  }
  if (pathname === "/api/auth/logout") {
    return {
      methods: "POST,OPTIONS"
    };
  }
  if (/^\/api\/session\/[^/]+$/.test(pathname)) {
    return {
      methods: "GET,OPTIONS"
    };
  }
  if (/^\/api\/published-sessions\/[^/]+\/(?:client|advisor)$/.test(pathname)) {
    return {
      methods: "GET,OPTIONS"
    };
  }
  if (/^\/api\/revoke\/[^/]+$/.test(pathname)) {
    return {
      methods: "POST,OPTIONS"
    };
  }
  if (/^\/api\/published-sessions\/[^/]+\/revoke$/.test(pathname)) {
    return {
      methods: "POST,OPTIONS"
    };
  }
  if (/^\/api\/published-sessions\/[^/]+\/extend$/.test(pathname)) {
    return {
      methods: "POST,OPTIONS"
    };
  }
  if (/^\/api\/published-sessions\/[^/]+\/send-email$/.test(pathname)) {
    return {
      methods: "POST,OPTIONS"
    };
  }
  if (/^\/api\/published-sessions\/[^/]+\/client-pin\/setup$/.test(pathname)) {
    return {
      methods: "POST,OPTIONS"
    };
  }
  if (/^\/api\/published-sessions\/[^/]+\/client-access\/reset$/.test(pathname)) {
    return {
      methods: "POST,OPTIONS"
    };
  }
  if (/^\/api\/published-sessions\/[^/]+\/unlocked$/.test(pathname)) {
    return {
      methods: "POST,OPTIONS"
    };
  }
  if (/^\/email-assets\/qr\/[^/]+\/[^/]+$/.test(pathname)) {
    return {
      methods: "GET,OPTIONS"
    };
  }
  return null;
}
__name(getRouteConfig, "getRouteConfig");
function getAllowedRequestHeaders(request) {
  const requestedHeaders = request.headers.get("Access-Control-Request-Headers");
  return requestedHeaders || DEFAULT_ALLOWED_REQUEST_HEADERS;
}
__name(getAllowedRequestHeaders, "getAllowedRequestHeaders");
function getCorsOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return null;
  }
  const allowedOrigins = getAllowedOrigins(env);
  if (allowedOrigins.has(origin)) {
    return origin;
  }
  try {
    const parsed = new URL(origin);
    const isLocalDev = parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
    if (isLocalDev) {
      return origin;
    }
  } catch (_error) {
    return false;
  }
  return false;
}
__name(getCorsOrigin, "getCorsOrigin");
function corsHeaders(origin, methods, requestHeaders) {
  const headers = {
    "Access-Control-Allow-Methods": methods || "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders || DEFAULT_ALLOWED_REQUEST_HEADERS,
    "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE_SECONDS),
    Vary: requestHeaders ? "Origin, Access-Control-Request-Headers" : "Origin"
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}
__name(corsHeaders, "corsHeaders");
function noStoreHeaders() {
  return {
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0"
  };
}
__name(noStoreHeaders, "noStoreHeaders");
function securityHeaders(extraHeaders = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extraHeaders
  };
}
__name(securityHeaders, "securityHeaders");
function jsonResponse(data, status, origin, methods, requestHeaders, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin, methods, requestHeaders),
      ...securityHeaders(extraHeaders)
    }
  });
}
__name(jsonResponse, "jsonResponse");
function assetResponse(body, status, contentType, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      ...securityHeaders(extraHeaders)
    }
  });
}
__name(assetResponse, "assetResponse");
function optionsResponse(request, origin, methods) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin, methods, getAllowedRequestHeaders(request))
    }
  });
}
__name(optionsResponse, "optionsResponse");
function parseJsonBody(request) {
  return request.json();
}
__name(parseJsonBody, "parseJsonBody");
function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown";
}
__name(getClientIp, "getClientIp");
function requireTrustedOrigin(origin, methods) {
  if (origin) {
    return null;
  }
  return jsonResponse({ error: "Origin not allowed." }, 403, null, methods || "POST,OPTIONS");
}
__name(requireTrustedOrigin, "requireTrustedOrigin");
function normalizeLeadValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
__name(normalizeLeadValue, "normalizeLeadValue");
function normalizeLeadConsent(value) {
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "on";
  }
  return false;
}
__name(normalizeLeadConsent, "normalizeLeadConsent");
function normalizeOptionalLeadValue(value) {
  const normalized = normalizeLeadValue(value);
  return normalized ? normalized : null;
}
__name(normalizeOptionalLeadValue, "normalizeOptionalLeadValue");
function normalizeEnvValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
__name(normalizeEnvValue, "normalizeEnvValue");
function normalizeUserAgent(value) {
  const normalized = normalizeEnvValue(value);
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, MAX_USER_AGENT_LENGTH);
}
__name(normalizeUserAgent, "normalizeUserAgent");
function parseCookies(request) {
  const header = request.headers.get("Cookie");
  if (!header) {
    return /* @__PURE__ */ new Map();
  }
  return new Map(
    header.split(";").map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex < 0) {
        return [normalizeEnvValue(entry), ""];
      }
      return [
        normalizeEnvValue(entry.slice(0, separatorIndex)),
        entry.slice(separatorIndex + 1).trim()
      ];
    }).filter(([key]) => key)
  );
}
__name(parseCookies, "parseCookies");
function fromBase64UrlBytes(base64Url, maxLength = MAX_ADVISOR_SESSION_TOKEN_LENGTH) {
  if (typeof base64Url !== "string" || !base64Url || base64Url.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(base64Url)) {
    throw new Error("Base64url value is malformed.");
  }
  const normalized = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
__name(fromBase64UrlBytes, "fromBase64UrlBytes");
function getAdvisorAuthConfig(env) {
  const sessionSecret = normalizeEnvValue(env.ADVISOR_SESSION_SECRET);
  const password = normalizeEnvValue(env.ADVISOR_PASSWORD);
  const passwordHashB64u = normalizeEnvValue(env.ADVISOR_PASSWORD_HASH_B64U);
  const passwordSaltB64u = normalizeEnvValue(env.ADVISOR_PASSWORD_SALT_B64U);
  const enabled = Boolean(
    sessionSecret && (password || passwordHashB64u && passwordSaltB64u)
  );
  return {
    enabled,
    sessionSecret,
    password,
    passwordHashB64u,
    passwordSaltB64u
  };
}
__name(getAdvisorAuthConfig, "getAdvisorAuthConfig");
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
__name(constantTimeEquals, "constantTimeEquals");
async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign", "verify"]
  );
}
__name(importHmacKey, "importHmacKey");
async function signAdvisorSessionPayload(sessionSecret, payloadBytes) {
  const key = await importHmacKey(sessionSecret);
  const signature = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return toBase64Url(new Uint8Array(signature));
}
__name(signAdvisorSessionPayload, "signAdvisorSessionPayload");
async function createAdvisorSessionToken(config) {
  const csrfToken = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ADVISOR_SESSION_TTL_MS;
  const payload = {
    sub: "advisor",
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
__name(createAdvisorSessionToken, "createAdvisorSessionToken");
async function readAdvisorSession(request, env) {
  const config = getAdvisorAuthConfig(env);
  if (!config.enabled) {
    return {
      authEnabled: false,
      authenticated: false,
      csrfToken: "",
      expiresAt: null
    };
  }
  const cookies = parseCookies(request);
  const token = normalizeEnvValue(cookies.get(ADVISOR_SESSION_COOKIE));
  if (!token) {
    return {
      authEnabled: true,
      authenticated: false,
      csrfToken: "",
      expiresAt: null
    };
  }
  const tokenParts = token.split(".");
  if (tokenParts.length !== 2) {
    return {
      authEnabled: true,
      authenticated: false,
      csrfToken: "",
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
        csrfToken: "",
        expiresAt: null
      };
    }
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!payload || payload.sub !== "advisor" || !payload.csrf || Number(payload.exp) <= Date.now()) {
      return {
        authEnabled: true,
        authenticated: false,
        csrfToken: "",
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
      csrfToken: "",
      expiresAt: null
    };
  }
}
__name(readAdvisorSession, "readAdvisorSession");
function buildAdvisorSessionCookie(token, maxAgeSeconds = Math.floor(ADVISOR_SESSION_TTL_MS / 1e3)) {
  return `${ADVISOR_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${Math.max(0, maxAgeSeconds)}`;
}
__name(buildAdvisorSessionCookie, "buildAdvisorSessionCookie");
function buildExpiredAdvisorSessionCookie() {
  return `${ADVISOR_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
}
__name(buildExpiredAdvisorSessionCookie, "buildExpiredAdvisorSessionCookie");
async function deriveAdvisorPasswordHash(password, saltBytes) {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBytes,
      iterations: ADVISOR_AUTH_PBKDF2_ITERATIONS
    },
    passwordKey,
    256
  );
  return new Uint8Array(derivedBits);
}
__name(deriveAdvisorPasswordHash, "deriveAdvisorPasswordHash");
async function verifyAdvisorPassword(password, config) {
  const normalizedPassword = typeof password === "string" ? password : "";
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
__name(verifyAdvisorPassword, "verifyAdvisorPassword");
function isTruthyEnvValue(value) {
  if (value === true) {
    return true;
  }
  const normalized = normalizeEnvValue(value).toLowerCase();
  return TRUEISH_ENV_VALUES.has(normalized);
}
__name(isTruthyEnvValue, "isTruthyEnvValue");
function splitEmailList(value) {
  return normalizeEnvValue(value).split(",").map((item) => item.trim()).filter(Boolean);
}
__name(splitEmailList, "splitEmailList");
function validatePublishedClientLink(value, publishedId) {
  const normalized = normalizeLeadValue(value);
  if (!normalized) {
    throw new Error("Client link is required to send this email.");
  }
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_error) {
    throw new Error("Client link is invalid.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Client link must use HTTPS.");
  }
  if (!PUBLISHED_CLIENT_LINK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("Client link host is not allowed.");
  }
  const normalizedPath = normalizePathname(parsed.pathname);
  if (normalizedPath !== PUBLISHED_CLIENT_LINK_PATH) {
    throw new Error("Client link path is invalid.");
  }
  const searchKeys = [...parsed.searchParams.keys()];
  if (searchKeys.length !== 1 || searchKeys[0] !== "pub") {
    throw new Error("Client link query is invalid.");
  }
  const publishedParam = normalizeLeadValue(parsed.searchParams.get("pub"));
  if (publishedParam !== publishedId) {
    throw new Error("Client link does not match this session.");
  }
  const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  const hashParams = new URLSearchParams(hash);
  const hashKeys = [...hashParams.keys()];
  if (hashKeys.length !== 1 || hashKeys[0] !== "ck") {
    throw new Error("Client link hash is invalid.");
  }
  const clientSecret = normalizeLeadValue(hashParams.get("ck"));
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(clientSecret)) {
    throw new Error("Client link key is invalid.");
  }
  return {
    href: parsed.toString(),
    host: parsed.hostname.toLowerCase(),
    path: normalizedPath
  };
}
__name(validatePublishedClientLink, "validatePublishedClientLink");
function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
__name(escapeHtml, "escapeHtml");
function formatOptionalText(value) {
  const normalized = normalizeLeadValue(value);
  return normalized || "Not provided";
}
__name(formatOptionalText, "formatOptionalText");
function formatLeadSelection(value, labels) {
  const normalized = normalizeLeadValue(value);
  if (!normalized) {
    return "Not provided";
  }
  return labels[normalized] || normalized;
}
__name(formatLeadSelection, "formatLeadSelection");
function formatLeadConsent(value) {
  return value ? "Yes" : "No";
}
__name(formatLeadConsent, "formatLeadConsent");
function buildLeadSummaryRows(lead, leadId) {
  return [
    ["Lead ID", leadId ? String(leadId) : "Not available"],
    ["Full name", formatOptionalText(lead.fullName)],
    ["Email", formatOptionalText(lead.email)],
    ["Phone", formatOptionalText(lead.phone)],
    ["Planning stage", formatLeadSelection(lead.stage, LEAD_STAGE_LABELS)],
    ["Requested outcome", formatLeadSelection(lead.callOutcome, CALL_OUTCOME_LABELS)],
    ["Understands this is a free recorded call", formatLeadConsent(lead.understandsRecordedCall)],
    ["Understands recording may be used as educational content", formatLeadConsent(lead.understandsEducationalContent)],
    ["Submitted at", formatOptionalText(lead.createdAt)],
    ["Source", LEAD_SOURCE_LABEL]
  ];
}
__name(buildLeadSummaryRows, "buildLeadSummaryRows");
function buildLeadNotificationText(lead, leadId) {
  const summary = buildLeadSummaryRows(lead, leadId).map(([label, value]) => `${label}: ${value}`).join("\n");
  return [
    "New Planeir request-a-call submission",
    "",
    summary,
    "",
    "Main question / concern:",
    formatOptionalText(lead.reason)
  ].join("\n");
}
__name(buildLeadNotificationText, "buildLeadNotificationText");
function buildLeadNotificationHtml(lead, leadId) {
  const rows = buildLeadSummaryRows(lead, leadId).map(([label, value]) => `
      <tr>
        <td style="padding:10px 12px;border:1px solid #d9e2ea;background:#f7fafc;font-weight:600;vertical-align:top;">${escapeHtml(label)}</td>
        <td style="padding:10px 12px;border:1px solid #d9e2ea;vertical-align:top;">${escapeHtml(value)}</td>
      </tr>
    `).join("");
  const reasonHtml = escapeHtml(formatOptionalText(lead.reason)).replace(/\n/g, "<br />");
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
__name(buildLeadNotificationHtml, "buildLeadNotificationHtml");
function buildLeadConfirmationText(lead) {
  return [
    `Hi ${lead.fullName},`,
    "",
    "Thanks for getting in touch with Planeir.",
    "Gerry has received your request for a free call and will review it shortly.",
    "If the request looks like a good fit for the format, you will hear back.",
    "",
    "Best,",
    "Planeir"
  ].join("\n");
}
__name(buildLeadConfirmationText, "buildLeadConfirmationText");
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
__name(buildLeadConfirmationHtml, "buildLeadConfirmationHtml");
function getLeadEmailConfig(env) {
  const apiKey = normalizeEnvValue(env.RESEND_API_KEY);
  const from = normalizeEnvValue(env.LEAD_EMAIL_FROM);
  const notificationRecipients = splitEmailList(env.LEAD_NOTIFICATION_TO);
  const replyTo = splitEmailList(env.LEAD_REPLY_TO)[0] || "";
  const confirmationEnabled = isTruthyEnvValue(env.LEAD_CONFIRMATION_EMAIL_ENABLED);
  return {
    apiKey,
    from,
    notificationRecipients,
    replyTo,
    confirmationEnabled
  };
}
__name(getLeadEmailConfig, "getLeadEmailConfig");
function buildEmailIdempotencyKey(leadId, createdAt, kind) {
  const base = String(leadId || createdAt || kind).replace(/[^a-zA-Z0-9_-]/g, "-");
  return `lead-${base}-${kind}`;
}
__name(buildEmailIdempotencyKey, "buildEmailIdempotencyKey");
async function sendEmailWithResend(config, payload, idempotencyKey) {
  const response = await fetch(RESEND_EMAILS_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
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
__name(sendEmailWithResend, "sendEmailWithResend");
async function sendLeadEmails(env, lead, leadId) {
  const config = getLeadEmailConfig(env);
  if (!config.apiKey || !config.from) {
    console.warn("Lead email sending skipped because provider credentials are not configured.");
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
      }, buildEmailIdempotencyKey(leadId, lead.createdAt, "internal"));
      console.log("Lead internal notification email accepted", {
        leadId,
        resendEmailId: notificationResult?.id || null,
        recipients: config.notificationRecipients
      });
    } catch (error) {
      console.error("Lead internal notification email failed", {
        leadId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  } else {
    console.warn("Lead notification email skipped because LEAD_NOTIFICATION_TO is not configured.");
  }
  if (!config.confirmationEnabled) {
    return;
  }
  try {
    const confirmationResult = await sendEmailWithResend(config, {
      from: config.from,
      to: [lead.email],
      subject: "We received your Planeir call request",
      html: buildLeadConfirmationHtml(lead),
      text: buildLeadConfirmationText(lead),
      reply_to: config.replyTo || void 0
    }, buildEmailIdempotencyKey(leadId, lead.createdAt, "confirmation"));
    console.log("Lead confirmation email accepted", {
      leadId,
      email: lead.email,
      resendEmailId: confirmationResult?.id || null
    });
  } catch (error) {
    console.error("Lead confirmation email failed", {
      leadId,
      email: lead.email,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
__name(sendLeadEmails, "sendLeadEmails");
function getPublishedSessionsDb(env) {
  if (!env.LEADS_DB) {
    throw new Error("Published session database is not configured.");
  }
  return env.LEADS_DB;
}
__name(getPublishedSessionsDb, "getPublishedSessionsDb");
async function checkPersistentRateLimit(env, scope, bucketKey, windowMs, maxRequests) {
  const db = getPublishedSessionsDb(env);
  const normalizedScope = normalizeLeadValue(scope);
  const normalizedBucketKey = normalizeLeadValue(bucketKey) || "unknown";
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
__name(checkPersistentRateLimit, "checkPersistentRateLimit");
function getPublishedClientKey(publishedId) {
  return `${PUBLISHED_CLIENT_KEY_PREFIX}${publishedId}${SESSION_KEY_SUFFIX}`;
}
__name(getPublishedClientKey, "getPublishedClientKey");
function getPublishedAdvisorKey(publishedId) {
  return `${PUBLISHED_ADVISOR_KEY_PREFIX}${publishedId}${SESSION_KEY_SUFFIX}`;
}
__name(getPublishedAdvisorKey, "getPublishedAdvisorKey");
function getPublishedQrAssetKey(publishedId, token) {
  return `${PUBLISHED_EMAIL_ASSET_KEY_PREFIX}${publishedId}/qr-${token}`;
}
__name(getPublishedQrAssetKey, "getPublishedQrAssetKey");
function normalizePublishedEmail(value) {
  const normalized = normalizeLeadValue(value).toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized.length > MAX_CLIENT_EMAIL_LENGTH) {
    throw new Error("Client email is too long.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Client email address is invalid.");
  }
  return normalized;
}
__name(normalizePublishedEmail, "normalizePublishedEmail");
function normalizePublishedClientName(value) {
  const normalized = normalizeLeadValue(value);
  if (!normalized) {
    return "Client";
  }
  if (normalized.length > MAX_CLIENT_NAME_LENGTH) {
    throw new Error("Client name is too long.");
  }
  return normalized;
}
__name(normalizePublishedClientName, "normalizePublishedClientName");
function normalizePublishedExpiryDays(value) {
  const days = Number(value);
  if (!PUBLISHED_ALLOWED_EXPIRY_DAYS.has(days)) {
    return 30;
  }
  return days;
}
__name(normalizePublishedExpiryDays, "normalizePublishedExpiryDays");
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
__name(nowIso, "nowIso");
function normalizePublishedStatus(status, expiresAt, revokedAt) {
  if (revokedAt) {
    return "revoked";
  }
  if (Date.parse(expiresAt) <= Date.now()) {
    return "expired";
  }
  return status === "active" ? "active" : "active";
}
__name(normalizePublishedStatus, "normalizePublishedStatus");
function buildPublishedSessionEmailText(payload) {
  const lines = [
    `Hi ${payload.clientName},`,
    "",
    "Thanks again for taking the call today.",
    "You can reopen your Planeir session here:",
    payload.clientLink,
    "",
    `This secure link expires on ${payload.expiresAtDisplay}.`
  ];
  if (payload.clientCreatesPinOnFirstOpen) {
    lines.push("The first time you open this link, you will be asked to create your own 6-digit PIN.");
  } else if (payload.includePinInEmail && payload.pin) {
    lines.push(`Your 6-digit access code is: ${payload.pin}`);
  } else if (payload.pin) {
    lines.push("A separate 6-digit access code will be shared with you separately.");
  }
  lines.push(
    "",
    "If the button or QR code does not open, copy and paste the link above into your browser.",
    "",
    "Best,",
    "Gerry"
  );
  return lines.join("\n");
}
__name(buildPublishedSessionEmailText, "buildPublishedSessionEmailText");
function buildPublishedSessionEmailHtml(payload) {
  const qrSection = payload.qrImageUrl ? `
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
    ` : "";
  const pinSection = payload.clientCreatesPinOnFirstOpen ? `
        <p style="margin:18px 0 0;font-size:14px;line-height:1.7;color:#52606d;">
          The first time you open this secure link, you will be asked to create your own 6-digit PIN.
        </p>
      ` : payload.pin ? payload.includePinInEmail ? `
        <div style="margin:24px 0 0;padding:18px;border:1px solid #d9e2ea;border-radius:16px;background:#fff7ed;text-align:center;">
          <p style="margin:0 0 8px;font-size:13px;letter-spacing:0.05em;text-transform:uppercase;color:#9a3412;">Access code</p>
          <div style="font-family:'SFMono-Regular',Consolas,monospace;font-size:28px;font-weight:700;letter-spacing:0.14em;color:#7c2d12;">${escapeHtml(payload.pin)}</div>
        </div>
      ` : `
        <p style="margin:18px 0 0;font-size:14px;line-height:1.7;color:#52606d;">
          A separate 6-digit access code will be shared with you separately.
        </p>
      ` : "";
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
      </div>
    </div>
  </body>
</html>`;
}
__name(buildPublishedSessionEmailHtml, "buildPublishedSessionEmailHtml");
function getPublishedEmailConfig(env) {
  const apiKey = normalizeEnvValue(env.RESEND_API_KEY);
  const from = normalizeEnvValue(env.SESSION_EMAIL_FROM) || normalizeEnvValue(env.LEAD_EMAIL_FROM);
  const replyTo = normalizeEnvValue(env.SESSION_EMAIL_REPLY_TO) || splitEmailList(env.LEAD_REPLY_TO)[0] || "";
  return {
    apiKey,
    from,
    replyTo
  };
}
__name(getPublishedEmailConfig, "getPublishedEmailConfig");
function isSafeSessionId(rawId) {
  return typeof rawId === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(rawId);
}
__name(isSafeSessionId, "isSafeSessionId");
function getSessionKey(sessionId) {
  return `${SESSION_KEY_PREFIX}${sessionId}${SESSION_KEY_SUFFIX}`;
}
__name(getSessionKey, "getSessionKey");
function getPublishedSessionKey(publishedId) {
  return `${PUBLISHED_SESSION_KEY_PREFIX}${publishedId}${SESSION_KEY_SUFFIX}`;
}
__name(getPublishedSessionKey, "getPublishedSessionKey");
function isBase64UrlValue(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(value);
}
__name(isBase64UrlValue, "isBase64UrlValue");
function toBase64Url(bytes) {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunkSize = 32768;
  for (let index = 0; index < view.length; index += chunkSize) {
    const chunk = view.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(toBase64Url, "toBase64Url");
function fromBase64Url(base64Url) {
  if (!isBase64UrlValue(base64Url, MAX_CAPABILITY_TOKEN_B64U_LENGTH)) {
    throw new Error("Capability is malformed.");
  }
  const normalized = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
__name(fromBase64Url, "fromBase64Url");
async function sha256Base64Url(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(new Uint8Array(digest));
}
__name(sha256Base64Url, "sha256Base64Url");
function validateEncryptedEnvelope(payload, options = {}) {
  const {
    allowBase64 = false,
    maxCiphertextLength = MAX_CT_B64_LENGTH,
    ivField = allowBase64 ? "ivB64" : "ivB64u",
    ctField = allowBase64 ? "ctB64" : "ctB64u"
  } = options;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Encrypted payload is missing.");
  }
  const algorithm = allowBase64 ? "AES-GCM-256" : payload.alg;
  if (!allowBase64 && algorithm !== "AES-GCM-256") {
    throw new Error("Encrypted payload algorithm is invalid.");
  }
  const ivValue = payload[ivField];
  const ctValue = payload[ctField];
  const isValidEncodedValue = allowBase64 ? (value, maxLength) => typeof value === "string" && value.length > 0 && value.length <= maxLength : isBase64UrlValue;
  if (!isValidEncodedValue(ivValue, MAX_IV_B64_LENGTH)) {
    throw new Error(`Invalid ${ivField}.`);
  }
  if (!isValidEncodedValue(ctValue, maxCiphertextLength)) {
    throw new Error(`Invalid ${ctField}.`);
  }
  return allowBase64 ? {
    ivB64: ivValue,
    ctB64: ctValue
  } : {
    alg: "AES-GCM-256",
    ivB64u: ivValue,
    ctB64u: ctValue
  };
}
__name(validateEncryptedEnvelope, "validateEncryptedEnvelope");
function validatePublishPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload must be a JSON object.");
  }
  if (Number(payload.v) !== PAYLOAD_VERSION) {
    throw new Error("Unsupported payload version.");
  }
  if (typeof payload.saltB64 !== "string" || payload.saltB64.length === 0 || payload.saltB64.length > MAX_SALT_B64_LENGTH) {
    throw new Error("Invalid saltB64.");
  }
  if (typeof payload.ivB64 !== "string" || payload.ivB64.length === 0 || payload.ivB64.length > MAX_IV_B64_LENGTH) {
    throw new Error("Invalid ivB64.");
  }
  if (typeof payload.ctB64 !== "string" || payload.ctB64.length === 0 || payload.ctB64.length > MAX_CT_B64_LENGTH) {
    throw new Error("Invalid ctB64.");
  }
  return {
    v: PAYLOAD_VERSION,
    saltB64: payload.saltB64,
    ivB64: payload.ivB64,
    ctB64: payload.ctB64
  };
}
__name(validatePublishPayload, "validatePublishPayload");
function validatePublishedSessionPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload must be a JSON object.");
  }
  if (Number(payload.v) !== PUBLISHED_PAYLOAD_VERSION) {
    throw new Error("Unsupported payload version.");
  }
  if (!payload.clientAccess || typeof payload.clientAccess !== "object" || Array.isArray(payload.clientAccess)) {
    throw new Error("Client access bundle is required.");
  }
  if (!payload.advisorAccess || typeof payload.advisorAccess !== "object" || Array.isArray(payload.advisorAccess)) {
    throw new Error("Advisor access bundle is required.");
  }
  if (!isBase64UrlValue(payload.clientAccess.authHashB64u, MAX_AUTH_HASH_B64U_LENGTH)) {
    throw new Error("Client access auth hash is invalid.");
  }
  if (!isBase64UrlValue(payload.advisorAccess.authHashB64u, MAX_AUTH_HASH_B64U_LENGTH)) {
    throw new Error("Advisor access auth hash is invalid.");
  }
  if (typeof payload.clientAccess.pinRequired !== "boolean") {
    throw new Error("Client access pinRequired must be a boolean.");
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
__name(validatePublishedSessionPayload, "validatePublishedSessionPayload");
function validateStoredPublishedManifest(payload) {
  const validated = validatePublishedSessionPayload(payload);
  if (payload.kind !== PUBLISHED_SESSION_KIND) {
    throw new Error("Published session manifest kind is invalid.");
  }
  if (!isSafeSessionId(payload.publishedId)) {
    throw new Error("Published session manifest id is invalid.");
  }
  if (typeof payload.createdAt !== "string" || Number.isNaN(Date.parse(payload.createdAt))) {
    throw new Error("Published session createdAt is invalid.");
  }
  if (typeof payload.expiresAt !== "string" || Number.isNaN(Date.parse(payload.expiresAt))) {
    throw new Error("Published session expiresAt is invalid.");
  }
  const revokedAt = typeof payload.revokedAt === "string" && payload.revokedAt ? payload.revokedAt : null;
  if (revokedAt && Number.isNaN(Date.parse(revokedAt))) {
    throw new Error("Published session revokedAt is invalid.");
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
__name(validateStoredPublishedManifest, "validateStoredPublishedManifest");
function validatePublishedBundlePayload(payload, expectedKind, accessKey) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Bundle payload must be a JSON object.");
  }
  const version = Number(payload.v);
  if (version !== PUBLISHED_SPLIT_PAYLOAD_VERSION && version !== PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    throw new Error("Unsupported bundle version.");
  }
  if (payload.kind !== expectedKind) {
    throw new Error("Bundle kind is invalid.");
  }
  const access = payload[accessKey];
  if (!access || typeof access !== "object" || Array.isArray(access)) {
    throw new Error("Bundle access payload is required.");
  }
  const validated = {
    v: version,
    kind: expectedKind,
    payload: validateEncryptedEnvelope(payload.payload, {
      allowBase64: false,
      maxCiphertextLength: MAX_CT_B64_LENGTH
    })
  };
  if (accessKey === "clientAccess") {
    if (version === PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
      const revision = Number(access.revision);
      if (access.mode !== "client-first-pin") {
        throw new Error("Client access mode is invalid.");
      }
      if (access.pinState !== "pending" && access.pinState !== "active") {
        throw new Error("Client access pinState is invalid.");
      }
      if (!Number.isInteger(revision) || revision < 1) {
        throw new Error("Client access revision is invalid.");
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
      if (typeof access.pinRequired !== "boolean") {
        throw new Error("Client pinRequired must be a boolean.");
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
__name(validatePublishedBundlePayload, "validatePublishedBundlePayload");
function validatePublishedSessionCreatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload must be a JSON object.");
  }
  if (Number(payload.v) === PUBLISHED_PAYLOAD_VERSION) {
    return {
      kind: "v2",
      data: validatePublishedSessionPayload(payload)
    };
  }
  const version = Number(payload.v);
  if (version !== PUBLISHED_SPLIT_PAYLOAD_VERSION && version !== PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    throw new Error("Unsupported payload version.");
  }
  const meta = payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta) ? payload.meta : {};
  const auth = payload.auth && typeof payload.auth === "object" && !Array.isArray(payload.auth) ? payload.auth : {};
  if (!isBase64UrlValue(auth.clientAuthHashB64u, MAX_AUTH_HASH_B64U_LENGTH)) {
    throw new Error("Client access auth hash is invalid.");
  }
  if (!isBase64UrlValue(auth.advisorAuthHashB64u, MAX_AUTH_HASH_B64U_LENGTH)) {
    throw new Error("Advisor access auth hash is invalid.");
  }
  const clientBundle = validatePublishedBundlePayload(payload.clientBundle, PUBLISHED_CLIENT_KIND, "clientAccess");
  const advisorBundle = validatePublishedBundlePayload(payload.advisorBundle, PUBLISHED_ADVISOR_KIND, "advisorAccess");
  if (version === PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    if (clientBundle.clientAccess.pinState !== "pending") {
      throw new Error("New v4 client access must start pending.");
    }
    if (clientBundle.clientAccess.revision !== 1) {
      throw new Error("New v4 client access must start at revision 1.");
    }
  }
  return {
    kind: version === PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION ? "v4" : "v3",
    data: {
      v: version,
      meta: {
        clientName: normalizePublishedClientName(meta.clientName),
        clientEmail: meta.clientEmail ? normalizePublishedEmail(meta.clientEmail) : "",
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
__name(validatePublishedSessionCreatePayload, "validatePublishedSessionCreatePayload");
function normalizePublishedAccessRevision(value, label = "Client access revision") {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
__name(normalizePublishedAccessRevision, "normalizePublishedAccessRevision");
function validatePublishedClientPinSetupPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload must be a JSON object.");
  }
  const expectedRevision = normalizePublishedAccessRevision(payload.expectedRevision, "Expected client access revision");
  const clientBundle = validatePublishedBundlePayload(payload.clientBundle, PUBLISHED_CLIENT_KIND, "clientAccess");
  if (clientBundle.v !== PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    throw new Error("Client PIN setup only supports v4 published sessions.");
  }
  if (clientBundle.clientAccess.mode !== "client-first-pin" || clientBundle.clientAccess.pinState !== "active") {
    throw new Error("Client PIN setup bundle must be an active v4 client access bundle.");
  }
  if (clientBundle.clientAccess.revision <= expectedRevision) {
    throw new Error("Client PIN setup bundle revision must advance the current revision.");
  }
  return {
    expectedRevision,
    clientBundle
  };
}
__name(validatePublishedClientPinSetupPayload, "validatePublishedClientPinSetupPayload");
function validatePublishedClientAccessResetPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload must be a JSON object.");
  }
  const expectedRevision = normalizePublishedAccessRevision(payload.expectedRevision, "Expected client access revision");
  if (!isBase64UrlValue(payload.clientAuthHashB64u, MAX_AUTH_HASH_B64U_LENGTH)) {
    throw new Error("Client access auth hash is invalid.");
  }
  const clientBundle = validatePublishedBundlePayload(payload.clientBundle, PUBLISHED_CLIENT_KIND, "clientAccess");
  const advisorBundle = validatePublishedBundlePayload(payload.advisorBundle, PUBLISHED_ADVISOR_KIND, "advisorAccess");
  if (clientBundle.v !== PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION || advisorBundle.v !== PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    throw new Error("Client access reset only supports v4 published sessions.");
  }
  if (clientBundle.clientAccess.mode !== "client-first-pin" || clientBundle.clientAccess.pinState !== "pending") {
    throw new Error("Reset bundle must create a pending v4 client access link.");
  }
  if (clientBundle.clientAccess.revision <= expectedRevision) {
    throw new Error("Reset bundle revision must advance the current revision.");
  }
  return {
    expectedRevision,
    clientAuthHashB64u: payload.clientAuthHashB64u,
    clientBundle,
    advisorBundle
  };
}
__name(validatePublishedClientAccessResetPayload, "validatePublishedClientAccessResetPayload");
function validateLeadPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload must be a JSON object.");
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
    throw new Error("Full name is required.");
  }
  if (fullName.length > MAX_LEAD_NAME_LENGTH) {
    throw new Error("Full name is too long.");
  }
  if (!email) {
    throw new Error("Email is required.");
  }
  if (email.length > MAX_LEAD_EMAIL_LENGTH) {
    throw new Error("Email is too long.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Email address is invalid.");
  }
  if (phone.length > MAX_LEAD_PHONE_LENGTH) {
    throw new Error("Phone number is too long.");
  }
  if (stage && !ALLOWED_LEAD_STAGES.has(stage)) {
    throw new Error("Planning stage is invalid.");
  }
  if (callOutcome && !ALLOWED_CALL_OUTCOMES.has(callOutcome)) {
    throw new Error("Requested call outcome is invalid.");
  }
  if (!reason) {
    throw new Error("Help request is required.");
  }
  if (reason.length > MAX_LEAD_REASON_LENGTH) {
    throw new Error("Help request is too long.");
  }
  if (!understandsRecordedCall) {
    throw new Error("Recorded-call acknowledgement is required.");
  }
  if (!understandsEducationalContent) {
    throw new Error("Educational-content consent is required for this free call.");
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
    source: "landing-page"
  };
}
__name(validateLeadPayload, "validateLeadPayload");
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
    clientEmail: row.client_email || "",
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
    qrAssetToken: row.qr_asset_token || "",
    qrAssetR2Key: row.qr_asset_r2_key || "",
    qrAssetContentType: row.qr_asset_content_type || "",
    clientPinState: version === PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION ? row.client_pin_state === "active" ? "active" : "pending" : null,
    clientPinInitializedAt: version === PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION ? row.client_pin_initialized_at || null : null,
    clientAccessRevision: version === PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION ? Number(row.client_access_revision || 1) : 0
  };
}
__name(normalizePublishedSessionRow, "normalizePublishedSessionRow");
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
      client_pin_state,
      client_pin_initialized_at,
      client_access_revision
    FROM published_sessions
    WHERE id = ?
    LIMIT 1
  `).bind(publishedId).first();
  return normalizePublishedSessionRow(row);
}
__name(getPublishedSessionRow, "getPublishedSessionRow");
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
__name(insertPublishedSessionEvent, "insertPublishedSessionEvent");
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
      client_pin_state,
      client_pin_initialized_at,
      client_access_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    record.clientPinState || null,
    record.clientPinInitializedAt || null,
    Number(record.clientAccessRevision || 1)
  ).run();
  if (!result.success) {
    throw new Error("Failed to insert published session metadata.");
  }
}
__name(insertPublishedSessionRow, "insertPublishedSessionRow");
async function updatePublishedStatus(env, publishedId, status, revokedAt = null) {
  const db = getPublishedSessionsDb(env);
  await db.prepare(`
    UPDATE published_sessions
    SET status = ?, revoked_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(status, revokedAt, nowIso(), publishedId).run();
}
__name(updatePublishedStatus, "updatePublishedStatus");
async function updatePublishedExpiry(env, publishedId, expiresAt) {
  const db = getPublishedSessionsDb(env);
  await db.prepare(`
    UPDATE published_sessions
    SET expires_at = ?, status = 'active', updated_at = ?
    WHERE id = ?
  `).bind(expiresAt, nowIso(), publishedId).run();
}
__name(updatePublishedExpiry, "updatePublishedExpiry");
async function recordPublishedOpen(env, publishedId, role) {
  const db = getPublishedSessionsDb(env);
  const timestamp = nowIso();
  const countColumn = role === "advisor" ? "advisor_open_count" : "client_open_count";
  const lastOpenedColumn = role === "advisor" ? "last_advisor_opened_at" : "last_client_opened_at";
  await db.prepare(`
    UPDATE published_sessions
    SET updated_at = ?, ${countColumn} = ${countColumn} + 1, ${lastOpenedColumn} = ?
    WHERE id = ?
  `).bind(timestamp, timestamp, publishedId).run();
}
__name(recordPublishedOpen, "recordPublishedOpen");
async function recordPublishedUnlock(env, publishedId, role) {
  const db = getPublishedSessionsDb(env);
  const timestamp = nowIso();
  const countColumn = role === "advisor" ? "advisor_unlock_count" : "client_unlock_count";
  const lastUnlockedColumn = role === "advisor" ? "last_advisor_unlocked_at" : "last_client_unlocked_at";
  await db.prepare(`
    UPDATE published_sessions
    SET updated_at = ?, ${countColumn} = ${countColumn} + 1, ${lastUnlockedColumn} = ?
    WHERE id = ?
  `).bind(timestamp, timestamp, publishedId).run();
}
__name(recordPublishedUnlock, "recordPublishedUnlock");
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
__name(updatePublishedEmailMetadata, "updatePublishedEmailMetadata");
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
__name(updatePublishedClientPinSetupMetadata, "updatePublishedClientPinSetupMetadata");
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
      updated_at = ?
    WHERE id = ?
  `).bind(
    values.clientAuthHashB64u,
    values.clientPinState,
    values.clientAccessRevision,
    nowIso(),
    publishedId
  ).run();
}
__name(resetPublishedClientAccessMetadata, "resetPublishedClientAccessMetadata");
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
__name(clearPublishedQrAssetMetadata, "clearPublishedQrAssetMetadata");
async function deletePublishedQrAsset(env, objectKey) {
  if (!objectKey) {
    return;
  }
  await env.SESSIONS_BUCKET.delete(objectKey);
}
__name(deletePublishedQrAsset, "deletePublishedQrAsset");
function isPublishedSessionExpired(row) {
  return Date.parse(row.expiresAt) <= Date.now();
}
__name(isPublishedSessionExpired, "isPublishedSessionExpired");
async function markPublishedExpiredIfNeeded(env, row) {
  if (!row || row.status !== "active" || !isPublishedSessionExpired(row)) {
    return row;
  }
  await updatePublishedStatus(env, row.id, "expired", null);
  if (row.qrAssetR2Key) {
    await deletePublishedQrAsset(env, row.qrAssetR2Key).catch((error) => {
      console.error("Failed to delete QR asset on expiry", {
        publishedId: row.id,
        qrAssetR2Key: row.qrAssetR2Key,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    await clearPublishedQrAssetMetadata(env, row.id).catch((error) => {
      console.error("Failed to clear QR metadata on expiry", {
        publishedId: row.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  return {
    ...row,
    status: "expired",
    qrAssetToken: "",
    qrAssetR2Key: "",
    qrAssetContentType: ""
  };
}
__name(markPublishedExpiredIfNeeded, "markPublishedExpiredIfNeeded");
function checkRateLimit(clientIp) {
  const now = Date.now();
  const key = clientIp || "unknown";
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
  if (requestBuckets.size > 5e3) {
    const cutoff = now - RATE_LIMIT_WINDOW_MS * 3;
    for (const [mapKey, value] of requestBuckets.entries()) {
      if (value.windowStart < cutoff) {
        requestBuckets.delete(mapKey);
      }
    }
  }
  return true;
}
__name(checkRateLimit, "checkRateLimit");
function advisorAuthExtraHeaders(session) {
  if (session?.authEnabled && !session?.authenticated) {
    return {
      "Set-Cookie": buildExpiredAdvisorSessionCookie()
    };
  }
  return null;
}
__name(advisorAuthExtraHeaders, "advisorAuthExtraHeaders");
async function requireAdvisorSession(request, env, origin, methods, options = {}) {
  const { requireCsrf = false, rateScope = "advisor-admin", rateWindowMs = ADVISOR_ADMIN_RATE_LIMIT_WINDOW_MS, rateLimitMax = ADVISOR_ADMIN_RATE_LIMIT_MAX } = options;
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
      response: jsonResponse({ error: "Too many requests. Please try again later." }, 429, origin, methods)
    };
  }
  const persistentAllowed = await checkPersistentRateLimit(env, rateScope, clientIp, rateWindowMs, rateLimitMax);
  if (!persistentAllowed) {
    return {
      response: jsonResponse({ error: "Too many requests. Please try again later." }, 429, origin, methods, null, noStoreHeaders())
    };
  }
  if (!config.enabled) {
    return {
      session: {
        authEnabled: false,
        authenticated: false,
        csrfToken: "",
        expiresAt: null
      },
      clientIp
    };
  }
  const session = await readAdvisorSession(request, env);
  if (!session.authenticated) {
    return {
      response: jsonResponse({ error: "Advisor login required." }, 401, origin, methods, null, {
        ...noStoreHeaders(),
        ...advisorAuthExtraHeaders(session)
      })
    };
  }
  if (requireCsrf && request.headers.get("X-Advisor-CSRF") !== session.csrfToken) {
    return {
      response: jsonResponse({ error: "Advisor session is invalid. Refresh and sign in again." }, 403, origin, methods, null, noStoreHeaders())
    };
  }
  return {
    session,
    clientIp
  };
}
__name(requireAdvisorSession, "requireAdvisorSession");
function parseQrImageDataUrl(dataUrl) {
  const value = normalizeLeadValue(dataUrl);
  if (!value) {
    return null;
  }
  if (value.length > MAX_QR_IMAGE_DATA_URL_LENGTH) {
    throw new Error("QR image is too large.");
  }
  const match = /^data:(image\/png);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) {
    throw new Error("QR image must be a PNG data URL.");
  }
  return {
    contentType: match[1],
    bytes: Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0))
  };
}
__name(parseQrImageDataUrl, "parseQrImageDataUrl");
async function handleAdvisorSession(request, env, origin) {
  const session = await readAdvisorSession(request, env);
  return jsonResponse({
    authEnabled: session.authEnabled,
    authenticated: session.authenticated,
    csrfToken: session.authenticated ? session.csrfToken : "",
    expiresAt: session.authenticated ? session.expiresAt : null
  }, 200, origin, "GET,OPTIONS", null, {
    ...noStoreHeaders(),
    ...advisorAuthExtraHeaders(session)
  });
}
__name(handleAdvisorSession, "handleAdvisorSession");
async function handleAdvisorLogin(request, env, origin) {
  const originError = requireTrustedOrigin(origin, "POST,OPTIONS");
  if (originError) {
    return originError;
  }
  const config = getAdvisorAuthConfig(env);
  if (!config.enabled) {
    return jsonResponse({ error: "Advisor authentication is not configured." }, 500, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  const clientIp = getClientIp(request);
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: "Too many requests. Please try again later." }, 429, origin, "POST,OPTIONS");
  }
  const persistentAllowed = await checkPersistentRateLimit(env, "advisor-login", clientIp, ADVISOR_LOGIN_RATE_LIMIT_WINDOW_MS, ADVISOR_LOGIN_RATE_LIMIT_MAX);
  if (!persistentAllowed) {
    return jsonResponse({ error: "Too many login attempts. Please try again later." }, 429, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: "Invalid JSON body." }, 400, origin, "POST,OPTIONS");
  }
  const password = typeof body?.password === "string" ? body.password : "";
  const validPassword = await verifyAdvisorPassword(password, config);
  if (!validPassword) {
    return jsonResponse({ error: "Password is incorrect." }, 401, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  const token = await createAdvisorSessionToken(config);
  return jsonResponse({
    ok: true,
    authEnabled: true,
    authenticated: true,
    csrfToken: token.csrfToken,
    expiresAt: token.expiresAt
  }, 200, origin, "POST,OPTIONS", null, {
    ...noStoreHeaders(),
    "Set-Cookie": buildAdvisorSessionCookie(token.token)
  });
}
__name(handleAdvisorLogin, "handleAdvisorLogin");
async function handleAdvisorLogout(request, env, origin) {
  const session = await readAdvisorSession(request, env);
  const originError = requireTrustedOrigin(origin, "POST,OPTIONS");
  if (originError) {
    return originError;
  }
  if (session.authEnabled && session.authenticated && request.headers.get("X-Advisor-CSRF") !== session.csrfToken) {
    return jsonResponse({ error: "Advisor session is invalid. Refresh and sign in again." }, 403, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  return jsonResponse({
    ok: true,
    authEnabled: session.authEnabled,
    authenticated: false,
    csrfToken: "",
    expiresAt: null
  }, 200, origin, "POST,OPTIONS", null, {
    ...noStoreHeaders(),
    "Set-Cookie": buildExpiredAdvisorSessionCookie()
  });
}
__name(handleAdvisorLogout, "handleAdvisorLogout");
async function handlePublish(request, env, origin) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, "POST,OPTIONS", {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }
  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: "Invalid JSON body." }, 400, origin, "POST,OPTIONS");
  }
  let validated;
  try {
    validated = validatePublishPayload(body);
  } catch (error) {
    return jsonResponse({ error: error.message || "Invalid payload." }, 400, origin, "POST,OPTIONS");
  }
  const sessionId = crypto.randomUUID();
  const objectKey = getSessionKey(sessionId);
  try {
    await env.SESSIONS_BUCKET.put(objectKey, JSON.stringify(validated), {
      httpMetadata: {
        contentType: "application/json"
      }
    });
  } catch (error) {
    console.error("Failed to store published session", {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: "Could not publish this session right now." }, 500, origin, "POST,OPTIONS");
  }
  return jsonResponse({ sessionId }, 200, origin, "POST,OPTIONS");
}
__name(handlePublish, "handlePublish");
function buildPublishedManifest(validatedPayload, publishedId) {
  const createdAt = (/* @__PURE__ */ new Date()).toISOString();
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
__name(buildPublishedManifest, "buildPublishedManifest");
async function persistPublishedManifest(env, manifest) {
  const objectKey = getPublishedSessionKey(manifest.publishedId);
  await env.SESSIONS_BUCKET.put(objectKey, JSON.stringify(manifest), {
    httpMetadata: {
      contentType: "application/json"
    }
  });
}
__name(persistPublishedManifest, "persistPublishedManifest");
async function loadPublishedManifest(env, publishedId) {
  const objectKey = getPublishedSessionKey(publishedId);
  const object = await env.SESSIONS_BUCKET.get(objectKey);
  if (!object) {
    return null;
  }
  const text = await object.text();
  return validateStoredPublishedManifest(JSON.parse(text));
}
__name(loadPublishedManifest, "loadPublishedManifest");
async function handleCreatePublishedSession(request, env, origin) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, "POST,OPTIONS", {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }
  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: "Invalid JSON body." }, 400, origin, "POST,OPTIONS");
  }
  let validated;
  try {
    validated = validatePublishedSessionCreatePayload(body);
  } catch (error) {
    return jsonResponse({ error: error.message || "Invalid payload." }, 400, origin, "POST,OPTIONS");
  }
  if (validated.kind === "v2") {
    const publishedId2 = crypto.randomUUID();
    const manifest = buildPublishedManifest(validated.data, publishedId2);
    try {
      await persistPublishedManifest(env, manifest);
    } catch (error) {
      console.error("Failed to store v2 published session", {
        publishedId: publishedId2,
        error: error instanceof Error ? error.message : String(error)
      });
      return jsonResponse({ error: "Could not publish this session right now." }, 500, origin, "POST,OPTIONS");
    }
    return jsonResponse({
      ok: true,
      publishedId: publishedId2,
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt
    }, 201, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  const publishedId = crypto.randomUUID();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + validated.data.meta.expiresInDays * 24 * 60 * 60 * 1e3).toISOString();
  const clientR2Key = getPublishedClientKey(publishedId);
  const advisorR2Key = getPublishedAdvisorKey(publishedId);
  const isV4 = validated.kind === "v4";
  const clientPinState = isV4 ? validated.data.clientBundle.clientAccess.pinState : null;
  const clientAccessRevision = isV4 ? validated.data.clientBundle.clientAccess.revision : 1;
  try {
    await env.SESSIONS_BUCKET.put(clientR2Key, JSON.stringify(validated.data.clientBundle), {
      httpMetadata: { contentType: "application/json" }
    });
    await env.SESSIONS_BUCKET.put(advisorR2Key, JSON.stringify(validated.data.advisorBundle), {
      httpMetadata: { contentType: "application/json" }
    });
    await insertPublishedSessionRow(env, {
      id: publishedId,
      version: validated.data.v,
      status: "active",
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
      clientPinState,
      clientPinInitializedAt: null,
      clientAccessRevision
    });
    await insertPublishedSessionEvent(env, publishedId, "advisor", "published", {
      version: validated.data.v,
      pinRequired: isV4 ? true : validated.data.clientBundle.clientAccess.pinRequired,
      clientPinState,
      clientAccessRevision,
      expiresAt
    });
  } catch (error) {
    console.error("Failed to store split published session", {
      publishedId,
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: "Could not publish this session right now." }, 500, origin, "POST,OPTIONS");
  }
  return jsonResponse({
    ok: true,
    publishedId,
    createdAt,
    expiresAt,
    status: "active",
    clientEmail: validated.data.meta.clientEmail || "",
    clientPinState: clientPinState || null,
    clientAccessRevision,
    emailSendCount: 0,
    lastEmailSentAt: null
  }, 201, origin, "POST,OPTIONS", null, noStoreHeaders());
}
__name(handleCreatePublishedSession, "handleCreatePublishedSession");
async function handleLeadSubmit(request, env, origin, ctx) {
  const clientIp = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown";
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: "Too many requests. Please try again later." }, 429, origin, "POST,OPTIONS");
  }
  if (!env.LEADS_DB) {
    console.error("LEADS_DB binding is missing for lead submission");
    return jsonResponse({ error: "Lead capture is not configured right now." }, 500, origin, "POST,OPTIONS");
  }
  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: "Invalid JSON body." }, 400, origin, "POST,OPTIONS");
  }
  let validated;
  try {
    validated = validateLeadPayload(body);
  } catch (error) {
    return jsonResponse({ error: error.message || "Invalid payload." }, 400, origin, "POST,OPTIONS");
  }
  const createdAt = (/* @__PURE__ */ new Date()).toISOString();
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
      throw new Error("Lead insert did not succeed.");
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
      console.error("Lead email notification failed", {
        leadId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(emailTask);
    } else {
      await emailTask;
    }
    return jsonResponse({
      ok: true,
      leadId
    }, 201, origin, "POST,OPTIONS");
  } catch (error) {
    console.error("Failed to store lead submission", {
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: "Could not save your request right now. Please try again shortly." }, 500, origin, "POST,OPTIONS");
  }
}
__name(handleLeadSubmit, "handleLeadSubmit");
async function handleGetSession(request, env, origin, sessionId) {
  const clientIp = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown";
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: "Too many requests. Please try again later." }, 429, origin, "GET,OPTIONS");
  }
  const objectKey = getSessionKey(sessionId);
  const object = await env.SESSIONS_BUCKET.get(objectKey);
  if (!object) {
    return jsonResponse({ error: "Session not found." }, 404, origin, "GET,OPTIONS");
  }
  const payload = await object.text();
  return new Response(payload, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin, "GET,OPTIONS"),
      ...securityHeaders(noStoreHeaders())
    }
  });
}
__name(handleGetSession, "handleGetSession");
async function handleRevoke(request, env, origin, sessionId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, "POST,OPTIONS", {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }
  const objectKey = getSessionKey(sessionId);
  await env.SESSIONS_BUCKET.delete(objectKey);
  return jsonResponse({ ok: true }, 200, origin, "POST,OPTIONS");
}
__name(handleRevoke, "handleRevoke");
async function verifyPublishedCapability(request, source, role) {
  const rawCapability = request.headers.get("X-Published-Capability");
  if (!rawCapability) {
    return false;
  }
  const expectedHash = role === "advisor" ? source?.advisorAuthHashB64u || source?.advisorAccess?.authHashB64u : source?.clientAuthHashB64u || source?.clientAccess?.authHashB64u;
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
__name(verifyPublishedCapability, "verifyPublishedCapability");
function isPublishedManifestExpired(manifest) {
  return Date.parse(manifest.expiresAt) <= Date.now();
}
__name(isPublishedManifestExpired, "isPublishedManifestExpired");
function buildPublishedSessionResponse(manifest, role) {
  const response = {
    v: PUBLISHED_PAYLOAD_VERSION,
    role,
    publishedId: manifest.publishedId,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    payload: manifest.payload
  };
  response[role === "advisor" ? "advisorAccess" : "clientAccess"] = role === "advisor" ? { wrap: manifest.advisorAccess.wrap } : {
    pinRequired: manifest.clientAccess.pinRequired,
    wrap: manifest.clientAccess.wrap
  };
  return response;
}
__name(buildPublishedSessionResponse, "buildPublishedSessionResponse");
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
  if (role === "advisor") {
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
__name(buildPublishedSessionResponseV3, "buildPublishedSessionResponseV3");
async function loadPublishedSessionBundle(env, objectKey) {
  const object = await env.SESSIONS_BUCKET.get(objectKey);
  if (!object) {
    return null;
  }
  return JSON.parse(await object.text());
}
__name(loadPublishedSessionBundle, "loadPublishedSessionBundle");
async function handleGetPublishedSessionV2(request, env, origin, publishedId, role) {
  let manifest;
  try {
    manifest = await loadPublishedManifest(env, publishedId);
  } catch (error) {
    console.error("Failed to read published session manifest", {
      publishedId,
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: "Could not load this session right now." }, 500, origin, "GET,OPTIONS");
  }
  if (!manifest) {
    return null;
  }
  const authorized = await verifyPublishedCapability(request, manifest, role);
  if (!authorized) {
    return jsonResponse({ error: "Not found." }, 404, origin, "GET,OPTIONS", null, noStoreHeaders());
  }
  if (manifest.revokedAt || isPublishedManifestExpired(manifest)) {
    return jsonResponse({ error: "This secure session is no longer available." }, 410, origin, "GET,OPTIONS", null, noStoreHeaders());
  }
  return jsonResponse(
    buildPublishedSessionResponse(manifest, role),
    200,
    origin,
    "GET,OPTIONS",
    null,
    noStoreHeaders()
  );
}
__name(handleGetPublishedSessionV2, "handleGetPublishedSessionV2");
async function handleGetPublishedSessionV3(request, env, origin, publishedId, role) {
  let row = await getPublishedSessionRow(env, publishedId);
  if (!row) {
    return null;
  }
  row = await markPublishedExpiredIfNeeded(env, row);
  if (role === "advisor") {
    const advisorAccess = await requireAdvisorSession(request, env, origin, "GET,OPTIONS", {
      requireCsrf: false
    });
    if (advisorAccess.response) {
      return advisorAccess.response;
    }
  }
  const authorized = await verifyPublishedCapability(request, row, role);
  if (!authorized) {
    return jsonResponse({ error: "Not found." }, 404, origin, "GET,OPTIONS", null, noStoreHeaders());
  }
  if (row.status === "revoked" || row.status === "expired") {
    return jsonResponse({ error: "This secure session is no longer available." }, 410, origin, "GET,OPTIONS", null, noStoreHeaders());
  }
  const objectKey = role === "advisor" ? row.advisorR2Key : row.clientR2Key;
  let bundle = await loadPublishedSessionBundle(env, objectKey);
  if (!bundle) {
    return jsonResponse({ error: "Not found." }, 404, origin, "GET,OPTIONS", null, noStoreHeaders());
  }
  bundle = validatePublishedBundlePayload(
    bundle,
    role === "advisor" ? PUBLISHED_ADVISOR_KIND : PUBLISHED_CLIENT_KIND,
    role === "advisor" ? "advisorAccess" : "clientAccess"
  );
  await recordPublishedOpen(env, publishedId, role);
  await insertPublishedSessionEvent(env, publishedId, role, "bundle-fetched", {
    version: row.version
  });
  const refreshedRow = await getPublishedSessionRow(env, publishedId);
  return jsonResponse(
    buildPublishedSessionResponseV3(refreshedRow || row, bundle, role),
    200,
    origin,
    "GET,OPTIONS",
    null,
    noStoreHeaders()
  );
}
__name(handleGetPublishedSessionV3, "handleGetPublishedSessionV3");
async function handleGetPublishedSession(request, env, origin, publishedId, role) {
  const clientIp = getClientIp(request);
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: "Too many requests. Please try again later." }, 429, origin, "GET,OPTIONS");
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
    console.error("Failed to load published session", {
      publishedId,
      role,
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: "Could not load this session right now." }, 500, origin, "GET,OPTIONS");
  }
  return jsonResponse({ error: "Not found." }, 404, origin, "GET,OPTIONS", null, noStoreHeaders());
}
__name(handleGetPublishedSession, "handleGetPublishedSession");
async function handleRevokePublishedSession(request, env, origin, publishedId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, "POST,OPTIONS", {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }
  const row = await getPublishedSessionRow(env, publishedId);
  if (row) {
    const authorized2 = await verifyPublishedCapability(request, row, "advisor");
    if (!authorized2) {
      return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", null, noStoreHeaders());
    }
    const revokedAt = nowIso();
    await updatePublishedStatus(env, publishedId, "revoked", revokedAt);
    await deletePublishedQrAsset(env, row.qrAssetR2Key).catch((error) => {
      console.error("Failed to delete QR asset on revoke", {
        publishedId,
        qrAssetR2Key: row.qrAssetR2Key,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    await clearPublishedQrAssetMetadata(env, publishedId);
    await insertPublishedSessionEvent(env, publishedId, "advisor", "revoked", null);
    return jsonResponse({ ok: true, status: "revoked", revokedAt }, 200, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  let manifest;
  try {
    manifest = await loadPublishedManifest(env, publishedId);
  } catch (error) {
    console.error("Failed to read published session for revoke", {
      publishedId,
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: "Could not revoke this session right now." }, 500, origin, "POST,OPTIONS");
  }
  if (!manifest) {
    return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  const authorized = await verifyPublishedCapability(request, manifest, "advisor");
  if (!authorized) {
    return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  if (manifest.revokedAt || isPublishedManifestExpired(manifest)) {
    return jsonResponse({ ok: true, status: manifest.revokedAt ? "revoked" : "expired" }, 200, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  if (!manifest.revokedAt) {
    manifest.revokedAt = (/* @__PURE__ */ new Date()).toISOString();
    try {
      await persistPublishedManifest(env, manifest);
    } catch (error) {
      console.error("Failed to persist published revoke", {
        publishedId,
        error: error instanceof Error ? error.message : String(error)
      });
      return jsonResponse({ error: "Could not revoke this session right now." }, 500, origin, "POST,OPTIONS");
    }
  }
  return jsonResponse({ ok: true }, 200, origin, "POST,OPTIONS", null, noStoreHeaders());
}
__name(handleRevokePublishedSession, "handleRevokePublishedSession");
async function handleExtendPublishedSession(request, env, origin, publishedId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, "POST,OPTIONS", {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }
  const row = await getPublishedSessionRow(env, publishedId);
  if (!row) {
    return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  const authorized = await verifyPublishedCapability(request, row, "advisor");
  if (!authorized) {
    return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  if (row.status === "revoked") {
    return jsonResponse({ error: "Revoked sessions cannot be extended." }, 410, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: "Invalid JSON body." }, 400, origin, "POST,OPTIONS");
  }
  const expiresInDays = normalizePublishedExpiryDays(body?.expiresInDays);
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1e3).toISOString();
  await updatePublishedExpiry(env, publishedId, expiresAt);
  await insertPublishedSessionEvent(env, publishedId, "advisor", "extended", {
    expiresAt,
    expiresInDays
  });
  return jsonResponse({
    ok: true,
    status: "active",
    expiresAt
  }, 200, origin, "POST,OPTIONS", null, noStoreHeaders());
}
__name(handleExtendPublishedSession, "handleExtendPublishedSession");
async function handlePublishedClientPinSetup(request, env, origin, publishedId) {
  const originError = requireTrustedOrigin(origin, "POST,OPTIONS");
  if (originError) {
    return originError;
  }
  const clientIp = getClientIp(request);
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: "Too many requests. Please try again later." }, 429, origin, "POST,OPTIONS");
  }
  let row = await getPublishedSessionRow(env, publishedId);
  if (!row) {
    return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  row = await markPublishedExpiredIfNeeded(env, row);
  const authorized = await verifyPublishedCapability(request, row, "client");
  if (!authorized) {
    return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  if (row.status !== "active") {
    return jsonResponse({ error: "This secure session is no longer active." }, 410, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  if (row.version !== PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    return jsonResponse({ error: "This secure session does not support first-open PIN setup." }, 400, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: "Invalid JSON body." }, 400, origin, "POST,OPTIONS");
  }
  let validated;
  try {
    validated = validatePublishedClientPinSetupPayload(body);
  } catch (error) {
    return jsonResponse({ error: error.message || "Invalid payload." }, 400, origin, "POST,OPTIONS");
  }
  if (row.clientPinState !== "pending" || row.clientAccessRevision !== validated.expectedRevision) {
    return jsonResponse({
      error: "This secure link has already been claimed.",
      clientPinState: row.clientPinState,
      clientAccessRevision: row.clientAccessRevision
    }, 409, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  const clientPinInitializedAt = nowIso();
  await env.SESSIONS_BUCKET.put(row.clientR2Key, JSON.stringify(validated.clientBundle), {
    httpMetadata: { contentType: "application/json" }
  });
  await updatePublishedClientPinSetupMetadata(env, publishedId, {
    clientPinState: "active",
    clientPinInitializedAt,
    clientAccessRevision: validated.clientBundle.clientAccess.revision
  });
  await insertPublishedSessionEvent(env, publishedId, "client", "client-pin-created", {
    previousClientAccessRevision: row.clientAccessRevision,
    clientAccessRevision: validated.clientBundle.clientAccess.revision,
    requestIp: clientIp,
    userAgent: normalizeUserAgent(request.headers.get("User-Agent"))
  });
  return jsonResponse({
    ok: true,
    clientPinState: "active",
    clientPinInitializedAt,
    clientAccessRevision: validated.clientBundle.clientAccess.revision
  }, 200, origin, "POST,OPTIONS", null, noStoreHeaders());
}
__name(handlePublishedClientPinSetup, "handlePublishedClientPinSetup");
async function handleResetPublishedClientAccess(request, env, origin, publishedId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, "POST,OPTIONS", {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }
  let row = await getPublishedSessionRow(env, publishedId);
  if (!row) {
    return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  row = await markPublishedExpiredIfNeeded(env, row);
  const authorized = await verifyPublishedCapability(request, row, "advisor");
  if (!authorized) {
    return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  if (row.status !== "active") {
    return jsonResponse({ error: "This secure session is no longer active." }, 410, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  if (row.version !== PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION) {
    return jsonResponse({ error: "Client access reset is only supported for v4 published sessions." }, 400, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: "Invalid JSON body." }, 400, origin, "POST,OPTIONS");
  }
  let validated;
  try {
    validated = validatePublishedClientAccessResetPayload(body);
  } catch (error) {
    return jsonResponse({ error: error.message || "Invalid payload." }, 400, origin, "POST,OPTIONS");
  }
  if (row.clientAccessRevision !== validated.expectedRevision) {
    return jsonResponse({
      error: "This published session was already updated. Refresh the published access details and try again.",
      clientPinState: row.clientPinState,
      clientAccessRevision: row.clientAccessRevision
    }, 409, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  const previousQrAssetR2Key = row.qrAssetR2Key || "";
  await env.SESSIONS_BUCKET.put(row.clientR2Key, JSON.stringify(validated.clientBundle), {
    httpMetadata: { contentType: "application/json" }
  });
  await env.SESSIONS_BUCKET.put(row.advisorR2Key, JSON.stringify(validated.advisorBundle), {
    httpMetadata: { contentType: "application/json" }
  });
  await resetPublishedClientAccessMetadata(env, publishedId, {
    clientAuthHashB64u: validated.clientAuthHashB64u,
    clientPinState: "pending",
    clientAccessRevision: validated.clientBundle.clientAccess.revision
  });
  await insertPublishedSessionEvent(env, publishedId, "advisor", "client-access-reset", {
    previousClientAccessRevision: row.clientAccessRevision,
    clientAccessRevision: validated.clientBundle.clientAccess.revision,
    previousClientPinState: row.clientPinState,
    clientPinState: "pending",
    requestIp: advisorAccess.clientIp,
    userAgent: normalizeUserAgent(request.headers.get("User-Agent"))
  });
  if (previousQrAssetR2Key) {
    await deletePublishedQrAsset(env, previousQrAssetR2Key).catch((error) => {
      console.error("Failed to delete superseded QR asset on client access reset", {
        publishedId,
        previousQrAssetR2Key,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  const updatedRow = await getPublishedSessionRow(env, publishedId);
  return jsonResponse({
    ok: true,
    status: "active",
    clientPinState: "pending",
    clientAccessRevision: validated.clientBundle.clientAccess.revision,
    clientEmail: updatedRow?.clientEmail || row.clientEmail,
    lastEmailSentAt: null,
    emailSendCount: 0
  }, 200, origin, "POST,OPTIONS", null, noStoreHeaders());
}
__name(handleResetPublishedClientAccess, "handleResetPublishedClientAccess");
async function handlePublishedSessionUnlocked(request, env, origin, publishedId) {
  const originError = requireTrustedOrigin(origin, "POST,OPTIONS");
  if (originError) {
    return originError;
  }
  const clientIp = getClientIp(request);
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: "Too many requests. Please try again later." }, 429, origin, "POST,OPTIONS");
  }
  let body = null;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    body = null;
  }
  const role = body?.role === "advisor" ? "advisor" : "client";
  const source = normalizeLeadValue(body?.source || "") || (role === "advisor" ? "advisor-reopen" : "viewer");
  if (role === "advisor") {
    const advisorAccess = await requireAdvisorSession(request, env, origin, "POST,OPTIONS", {
      requireCsrf: false
    });
    if (advisorAccess.response) {
      return advisorAccess.response;
    }
  }
  let row = await getPublishedSessionRow(env, publishedId);
  if (row) {
    row = await markPublishedExpiredIfNeeded(env, row);
    const authorized2 = await verifyPublishedCapability(request, row, role);
    if (!authorized2) {
      return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", null, noStoreHeaders());
    }
    if (row.status !== "active") {
      return jsonResponse({ error: "This secure session is no longer active." }, 410, origin, "POST,OPTIONS", null, noStoreHeaders());
    }
    await recordPublishedUnlock(env, publishedId, role);
    await insertPublishedSessionEvent(env, publishedId, role, "unlocked", {
      version: row.version,
      source,
      requestIp: clientIp,
      userAgent: normalizeUserAgent(request.headers.get("User-Agent"))
    });
    return jsonResponse({ ok: true }, 200, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  let manifest;
  try {
    manifest = await loadPublishedManifest(env, publishedId);
  } catch (error) {
    console.error("Failed to read published session manifest for unlock telemetry", {
      publishedId,
      role,
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: "Could not verify this secure session right now." }, 500, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  if (!manifest) {
    return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  const authorized = await verifyPublishedCapability(request, manifest, role);
  if (!authorized) {
    return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  if (manifest.revokedAt || isPublishedManifestExpired(manifest)) {
    return jsonResponse({ error: "This secure session is no longer active." }, 410, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  return jsonResponse({ ok: true }, 200, origin, "POST,OPTIONS", null, noStoreHeaders());
}
__name(handlePublishedSessionUnlocked, "handlePublishedSessionUnlocked");
async function handleSendPublishedSessionEmail(request, env, origin, publishedId) {
  const advisorAccess = await requireAdvisorSession(request, env, origin, "POST,OPTIONS", {
    requireCsrf: true
  });
  if (advisorAccess.response) {
    return advisorAccess.response;
  }
  const clientIp = advisorAccess.clientIp;
  const row = await getPublishedSessionRow(env, publishedId);
  if (!row) {
    return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  const authorized = await verifyPublishedCapability(request, row, "advisor");
  if (!authorized) {
    return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  if (row.status !== "active") {
    return jsonResponse({ error: "This secure session is no longer active." }, 410, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  let body;
  try {
    body = await parseJsonBody(request);
  } catch (_error) {
    return jsonResponse({ error: "Invalid JSON body." }, 400, origin, "POST,OPTIONS");
  }
  let clientEmail;
  let clientName;
  try {
    clientEmail = normalizePublishedEmail(body?.clientEmail || row.clientEmail);
    clientName = normalizePublishedClientName(body?.clientName || row.clientName);
  } catch (error) {
    return jsonResponse({ error: error.message || "Invalid email payload." }, 400, origin, "POST,OPTIONS");
  }
  let validatedClientLink;
  try {
    validatedClientLink = validatePublishedClientLink(body?.clientLink, publishedId);
  } catch (error) {
    return jsonResponse({ error: error.message || "Client link is invalid." }, 400, origin, "POST,OPTIONS");
  }
  const pin = row.version >= PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION ? "" : normalizeLeadValue(body?.pin);
  const includePinInEmail = row.version < PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION && body?.includePinInEmail === true && row.pinRequired;
  const acknowledgedInlinePinRisk = body?.acknowledgeInlinePinRisk === true;
  if (includePinInEmail && !/^\d{6}$/.test(pin)) {
    return jsonResponse({ error: "PIN must be a 6-digit number to include it in the email." }, 400, origin, "POST,OPTIONS");
  }
  if (includePinInEmail && !acknowledgedInlinePinRisk) {
    return jsonResponse({ error: "Confirm inline PIN delivery before sending the final email." }, 400, origin, "POST,OPTIONS");
  }
  let qrImage = null;
  try {
    qrImage = parseQrImageDataUrl(body?.qrImageDataUrl);
  } catch (error) {
    return jsonResponse({ error: error.message || "QR image is invalid." }, 400, origin, "POST,OPTIONS");
  }
  if (!qrImage) {
    return jsonResponse({ error: "QR image is required to send the final email." }, 400, origin, "POST,OPTIONS");
  }
  const emailConfig = getPublishedEmailConfig(env);
  if (!emailConfig.apiKey || !emailConfig.from) {
    return jsonResponse({ error: "Session email delivery is not configured right now." }, 500, origin, "POST,OPTIONS");
  }
  const previousQrAssetR2Key = row.qrAssetR2Key || "";
  let qrAssetToken = row.qrAssetToken || "";
  let qrAssetR2Key = row.qrAssetR2Key || "";
  let qrAssetContentType = row.qrAssetContentType || "";
  let shouldDeletePreviousQrAsset = false;
  if (qrImage) {
    qrAssetToken = crypto.randomUUID().replace(/-/g, "");
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
  const qrImageUrl = qrAssetToken ? `${requestUrl.origin}/email-assets/qr/${encodeURIComponent(publishedId)}/${encodeURIComponent(qrAssetToken)}` : "";
  const expiresAtDisplay = new Date(row.expiresAt).toLocaleString("en-IE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Dublin"
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
      reply_to: emailConfig.replyTo || void 0
    }, `published-session-${publishedId}-email-${row.emailSendCount + 1}`);
  } catch (error) {
    if (qrImage && qrAssetR2Key && qrAssetR2Key !== previousQrAssetR2Key) {
      await deletePublishedQrAsset(env, qrAssetR2Key).catch((cleanupError) => {
        console.error("Failed to clean up unsent QR asset", {
          publishedId,
          qrAssetR2Key,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        });
      });
    }
    console.error("Failed to send published session email", {
      publishedId,
      clientEmail,
      error: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: error instanceof Error ? error.message : "Could not send the final email right now." }, 502, origin, "POST,OPTIONS", null, noStoreHeaders());
  }
  const lastEmailSentAt = nowIso();
  await updatePublishedEmailMetadata(env, publishedId, {
    clientEmail,
    lastEmailSentAt,
    qrAssetToken,
    qrAssetR2Key,
    qrAssetContentType
  });
  await insertPublishedSessionEvent(env, publishedId, "advisor", "email-sent", {
    clientEmail,
    clientEmailChanged: Boolean(row.clientEmail && row.clientEmail !== clientEmail),
    includePinInEmail,
    acknowledgedInlinePinRisk,
    clientCreatesPinOnFirstOpen: row.version >= PUBLISHED_FIRST_OPEN_PAYLOAD_VERSION,
    hasQrImage: Boolean(qrImage),
    rotatedQrToken: qrAssetToken !== (row.qrAssetToken || ""),
    requestIp: clientIp,
    userAgent: normalizeUserAgent(request.headers.get("User-Agent")),
    clientLinkHost: validatedClientLink.host,
    clientLinkPath: validatedClientLink.path,
    clientLinkPubMatches: true
  });
  if (shouldDeletePreviousQrAsset) {
    await deletePublishedQrAsset(env, previousQrAssetR2Key).catch((cleanupError) => {
      console.error("Failed to delete superseded QR asset", {
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
  }, 200, origin, "POST,OPTIONS", null, noStoreHeaders());
}
__name(handleSendPublishedSessionEmail, "handleSendPublishedSessionEmail");
async function handlePublishedQrAsset(env, publishedId, token) {
  let row = await getPublishedSessionRow(env, publishedId);
  if (!row) {
    return new Response("Not found.", { status: 404 });
  }
  row = await markPublishedExpiredIfNeeded(env, row);
  if (row.status !== "active" || !row.qrAssetToken || row.qrAssetToken !== token || !row.qrAssetR2Key) {
    return new Response("Not found.", { status: 404 });
  }
  const object = await env.SESSIONS_BUCKET.get(row.qrAssetR2Key);
  if (!object) {
    return new Response("Not found.", { status: 404 });
  }
  const bytes = await object.arrayBuffer();
  return assetResponse(bytes, 200, row.qrAssetContentType || "image/png", {
    ...noStoreHeaders()
  });
}
__name(handlePublishedQrAsset, "handlePublishedQrAsset");
var src_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = normalizePathname(url.pathname);
    const routeConfig = getRouteConfig(pathname);
    const origin = getCorsOrigin(request, env);
    const requestHeaders = getAllowedRequestHeaders(request);
    if (origin === false) {
      return jsonResponse({ error: "Origin not allowed." }, 403, null, routeConfig?.methods, requestHeaders);
    }
    if (request.method === "OPTIONS") {
      if (!routeConfig) {
        return jsonResponse({ error: "Not found." }, 404, origin, "OPTIONS", requestHeaders);
      }
      return optionsResponse(request, origin, routeConfig.methods);
    }
    if (request.method === "POST" && pathname === "/api/leads") {
      return handleLeadSubmit(request, env, origin, ctx);
    }
    if (request.method === "POST" && pathname === "/api/publish") {
      return handlePublish(request, env, origin);
    }
    if (request.method === "POST" && pathname === "/api/published-sessions") {
      return handleCreatePublishedSession(request, env, origin);
    }
    if (request.method === "GET" && pathname === "/api/auth/session") {
      return handleAdvisorSession(request, env, origin);
    }
    if (request.method === "POST" && pathname === "/api/auth/login") {
      return handleAdvisorLogin(request, env, origin);
    }
    if (request.method === "POST" && pathname === "/api/auth/logout") {
      return handleAdvisorLogout(request, env, origin);
    }
    const getMatch = /^\/api\/session\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && getMatch) {
      const sessionId = getMatch[1];
      if (!isSafeSessionId(sessionId)) {
        return jsonResponse({ error: "Invalid session id." }, 400, origin, "GET,OPTIONS");
      }
      return handleGetSession(request, env, origin, sessionId);
    }
    const getPublishedMatch = /^\/api\/published-sessions\/([^/]+)\/(client|advisor)$/.exec(pathname);
    if (request.method === "GET" && getPublishedMatch) {
      const publishedId = getPublishedMatch[1];
      const role = getPublishedMatch[2];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: "Not found." }, 404, origin, "GET,OPTIONS", requestHeaders, noStoreHeaders());
      }
      return handleGetPublishedSession(request, env, origin, publishedId, role);
    }
    const revokeMatch = /^\/api\/revoke\/([^/]+)$/.exec(pathname);
    if (request.method === "POST" && revokeMatch) {
      const sessionId = revokeMatch[1];
      if (!isSafeSessionId(sessionId)) {
        return jsonResponse({ error: "Invalid session id." }, 400, origin, "POST,OPTIONS");
      }
      return handleRevoke(request, env, origin, sessionId);
    }
    const revokePublishedMatch = /^\/api\/published-sessions\/([^/]+)\/revoke$/.exec(pathname);
    if (request.method === "POST" && revokePublishedMatch) {
      const publishedId = revokePublishedMatch[1];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", requestHeaders, noStoreHeaders());
      }
      return handleRevokePublishedSession(request, env, origin, publishedId);
    }
    const extendPublishedMatch = /^\/api\/published-sessions\/([^/]+)\/extend$/.exec(pathname);
    if (request.method === "POST" && extendPublishedMatch) {
      const publishedId = extendPublishedMatch[1];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", requestHeaders, noStoreHeaders());
      }
      return handleExtendPublishedSession(request, env, origin, publishedId);
    }
    const sendEmailPublishedMatch = /^\/api\/published-sessions\/([^/]+)\/send-email$/.exec(pathname);
    if (request.method === "POST" && sendEmailPublishedMatch) {
      const publishedId = sendEmailPublishedMatch[1];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", requestHeaders, noStoreHeaders());
      }
      return handleSendPublishedSessionEmail(request, env, origin, publishedId);
    }
    const clientPinSetupMatch = /^\/api\/published-sessions\/([^/]+)\/client-pin\/setup$/.exec(pathname);
    if (request.method === "POST" && clientPinSetupMatch) {
      const publishedId = clientPinSetupMatch[1];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", requestHeaders, noStoreHeaders());
      }
      return handlePublishedClientPinSetup(request, env, origin, publishedId);
    }
    const resetClientAccessMatch = /^\/api\/published-sessions\/([^/]+)\/client-access\/reset$/.exec(pathname);
    if (request.method === "POST" && resetClientAccessMatch) {
      const publishedId = resetClientAccessMatch[1];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", requestHeaders, noStoreHeaders());
      }
      return handleResetPublishedClientAccess(request, env, origin, publishedId);
    }
    const unlockedPublishedMatch = /^\/api\/published-sessions\/([^/]+)\/unlocked$/.exec(pathname);
    if (request.method === "POST" && unlockedPublishedMatch) {
      const publishedId = unlockedPublishedMatch[1];
      if (!isSafeSessionId(publishedId)) {
        return jsonResponse({ error: "Not found." }, 404, origin, "POST,OPTIONS", requestHeaders, noStoreHeaders());
      }
      return handlePublishedSessionUnlocked(request, env, origin, publishedId);
    }
    const qrAssetMatch = /^\/email-assets\/qr\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && qrAssetMatch) {
      const publishedId = qrAssetMatch[1];
      const token = qrAssetMatch[2];
      if (!isSafeSessionId(publishedId) || !/^[a-zA-Z0-9_-]{16,80}$/.test(token)) {
        return new Response("Not found.", { status: 404 });
      }
      return handlePublishedQrAsset(env, publishedId, token);
    }
    return jsonResponse({ error: "Not found." }, 404, origin, routeConfig?.methods, requestHeaders);
  }
};

// ../../../../../../opt/homebrew/lib/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// .wrangler/tmp/bundle-30VSTc/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../../../opt/homebrew/lib/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-30VSTc/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
