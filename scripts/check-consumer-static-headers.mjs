import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Cloudflare ruleset updates can take longer than a normal HTTP cache refresh to
// reach every edge. Keep this gate patient enough for a first-time production
// rule rollout while still failing closed if the reviewed headers never arrive.
const MAX_ATTEMPTS = 25;
const RETRY_DELAY_MS = 5_000;

function headerValue(headers, name) {
  if (headers && typeof headers.get === 'function') {
    return String(headers.get(name) || '').trim();
  }
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return String(entry?.[1] || '').trim();
}

function parseCsp(value) {
  const directives = new Map();
  for (const segment of String(value || '').split(';')) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    directives.set(tokens[0].toLowerCase(), tokens.slice(1));
  }
  return directives;
}

function sorted(values) {
  return [...values].sort();
}

export function validatePlanSecurityHeaders(headers, { workerOrigin } = {}) {
  const parsedWorkerOrigin = new URL(String(workerOrigin || ''));
  assert.equal(parsedWorkerOrigin.protocol, 'https:', 'Worker origin must use HTTPS.');
  assert.equal(parsedWorkerOrigin.pathname, '/', 'Worker origin must not include a path.');

  const csp = parseCsp(headerValue(headers, 'content-security-policy'));
  const expectedDirectives = new Map([
    ['default-src', ["'self'"]],
    ['script-src', ["'self'"]],
    ['style-src', ["'self'"]],
    ['img-src', ["'self'", 'data:']],
    ['connect-src', ["'self'", parsedWorkerOrigin.origin]],
    ['font-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['form-action', ["'self'"]]
  ]);
  for (const [directive, expectedSources] of expectedDirectives) {
    assert.deepEqual(
      sorted(csp.get(directive) || []),
      sorted(expectedSources),
      `Unsafe or missing Content-Security-Policy directive: ${directive}`
    );
  }
  for (const prohibited of ["'unsafe-inline'", "'unsafe-eval'", '*', 'http:']) {
    assert.ok(
      ![...csp.values()].flat().includes(prohibited),
      `Content-Security-Policy contains prohibited source ${prohibited}.`
    );
  }

  assert.equal(headerValue(headers, 'x-frame-options').toUpperCase(), 'DENY', 'X-Frame-Options must be DENY.');
  assert.equal(headerValue(headers, 'x-content-type-options').toLowerCase(), 'nosniff', 'X-Content-Type-Options must be nosniff.');
  assert.equal(headerValue(headers, 'referrer-policy').toLowerCase(), 'no-referrer', 'Referrer-Policy must be no-referrer.');
  assert.match(headerValue(headers, 'strict-transport-security').toLowerCase(), /(?:^|;)\s*max-age=\d+/, 'Strict-Transport-Security must include max-age.');

  const permissions = headerValue(headers, 'permissions-policy')
    .toLowerCase()
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const deniedCapability of ['camera=()', 'geolocation=()']) {
    assert.ok(permissions.includes(deniedCapability), `Permissions-Policy must contain ${deniedCapability}.`);
  }
  assert.ok(
    permissions.includes('microphone=(self)'),
    'Permissions-Policy must allow microphone capture only from the Planéir /plan origin.'
  );
  assert.ok(!permissions.includes('microphone=()'), 'Permissions-Policy must not disable the reviewed /plan microphone flow.');
  return true;
}

async function main() {
  const siteOrigin = new URL(String(process.env.SMOKE_ORIGIN || '').trim());
  const workerUrl = new URL(String(process.env.WORKER_BASE_URL || '').trim());
  assert.equal(siteOrigin.protocol, 'https:', 'SMOKE_ORIGIN must use HTTPS.');
  assert.equal(siteOrigin.pathname, '/', 'SMOKE_ORIGIN must be an origin without a path.');
  assert.equal(workerUrl.protocol, 'https:', 'WORKER_BASE_URL must use HTTPS.');
  const paths = ['/plan/', '/plan/privacy.html'];

  for (const pathname of paths) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(new URL(pathname, siteOrigin), {
          headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
          redirect: 'follow'
        });
        assert.equal(response.status, 200, `${pathname} returned ${response.status}.`);
        validatePlanSecurityHeaders(response.headers, { workerOrigin: workerUrl.origin });
        await response.body?.cancel();
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }
    if (lastError) throw lastError;
  }
  console.log('Verified static security headers for /plan/ and /plan/privacy.html.');
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
