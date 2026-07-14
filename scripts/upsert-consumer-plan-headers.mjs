import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const PHASE = 'http_response_headers_transform';
const RULE_REF = 'planeir_consumer_plan_security_headers_v1';

export function buildConsumerPlanHeaderRule(workerOrigin) {
  const parsedWorkerOrigin = new URL(String(workerOrigin || ''));
  assert.equal(parsedWorkerOrigin.protocol, 'https:', 'Worker origin must use HTTPS.');
  assert.equal(parsedWorkerOrigin.pathname, '/', 'Worker origin must not contain a path.');
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ${parsedWorkerOrigin.origin}`,
    "media-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; ');
  const set = (value) => ({ operation: 'set', value });
  return Object.freeze({
    action: 'rewrite',
    action_parameters: {
      headers: {
        'content-security-policy': set(csp),
        'x-frame-options': set('DENY'),
        'x-content-type-options': set('nosniff'),
        'referrer-policy': set('no-referrer'),
        'permissions-policy': set('camera=(), microphone=(self), geolocation=()'),
        'strict-transport-security': set('max-age=31556952')
      }
    },
    expression: '(http.request.uri.path eq "/plan" or starts_with(http.request.uri.path, "/plan/"))',
    description: 'Planéir consumer planning security headers',
    ref: RULE_REF,
    enabled: true
  });
}

export function selectPlaneirZone(zones, { accountId, zoneName = 'planeir.ie' } = {}) {
  const matches = Array.isArray(zones)
    ? zones.filter((zone) => (
      zone?.name === zoneName
      && zone?.account?.id === accountId
      && zone?.status === 'active'
    ))
    : [];
  assert.equal(matches.length, 1, `Expected one active ${zoneName} zone in the configured Cloudflare account.`);
  assert.match(String(matches[0].id || ''), /^[0-9a-f]{32}$/i, 'Cloudflare returned an invalid zone ID.');
  return matches[0];
}

export function chooseHeaderRuleMutation(ruleset, desiredRule) {
  if (!ruleset) {
    return {
      kind: 'create-entrypoint',
      method: 'PUT',
      body: { rules: [desiredRule] }
    };
  }
  assert.match(String(ruleset.id || ''), /^[0-9a-f]{32}$/i, 'Cloudflare returned an invalid ruleset ID.');
  const matches = Array.isArray(ruleset.rules)
    ? ruleset.rules.filter((rule) => rule?.ref === RULE_REF)
    : [];
  assert.ok(matches.length <= 1, `Multiple Cloudflare rules use the reserved ref ${RULE_REF}.`);
  if (!matches.length) {
    return {
      kind: 'append-rule',
      method: 'POST',
      rulesetId: ruleset.id,
      body: desiredRule
    };
  }
  assert.match(String(matches[0].id || ''), /^[0-9a-f]{32}$/i, 'Cloudflare returned an invalid rule ID.');
  return {
    kind: 'update-rule',
    method: 'PATCH',
    rulesetId: ruleset.id,
    ruleId: matches[0].id,
    body: desiredRule
  };
}

function comparableRule(rule) {
  const actionParameters = rule?.action_parameters && typeof rule.action_parameters === 'object'
    ? { ...rule.action_parameters }
    : rule?.action_parameters;
  if (actionParameters?.headers && typeof actionParameters.headers === 'object') {
    actionParameters.headers = Object.fromEntries(
      Object.entries(actionParameters.headers).map(([name, operation]) => [name.toLowerCase(), operation])
    );
  }
  return {
    action: rule?.action,
    action_parameters: actionParameters,
    expression: rule?.expression,
    description: rule?.description,
    ref: rule?.ref,
    enabled: rule?.enabled !== false
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

export function headerRuleMatches(rule, desiredRule) {
  return JSON.stringify(canonicalize(comparableRule(rule)))
    === JSON.stringify(canonicalize(comparableRule(desiredRule)));
}

async function cloudflareRequest(pathname, token, options = {}) {
  const { allowNotFound = false, ...requestOptions } = options;
  const response = await fetch(`${API_BASE_URL}${pathname}`, {
    ...requestOptions,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(requestOptions.body ? { 'Content-Type': 'application/json' } : {}),
      ...(requestOptions.headers || {})
    }
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    throw new Error(`Cloudflare ${requestOptions.method || 'GET'} ${pathname} returned invalid JSON.`);
  }
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok || payload?.success !== true) {
    const details = Array.isArray(payload?.errors)
      ? payload.errors.map((error) => `${error?.code || 'error'}: ${error?.message || 'Cloudflare request failed'}`).join('; ')
      : `HTTP ${response.status}`;
    throw new Error(`Cloudflare ${requestOptions.method || 'GET'} ${pathname} failed (${details}). Check API-token account and Zone Transform Rules permissions.`);
  }
  return payload.result;
}

async function main() {
  const token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const zoneName = String(process.env.CONSUMER_SITE_ZONE_NAME || 'planeir.ie').trim();
  const workerUrl = new URL(String(process.env.WORKER_BASE_URL || '').trim());
  assert.ok(token, 'CLOUDFLARE_API_TOKEN is required.');
  assert.match(accountId, /^[0-9a-f]{32}$/i, 'CLOUDFLARE_ACCOUNT_ID is invalid.');
  assert.equal(zoneName, 'planeir.ie', 'The consumer beta header rule may target only planeir.ie.');

  const zoneQuery = new URLSearchParams({
    name: zoneName,
    status: 'active',
    'account.id': accountId,
    per_page: '50'
  });
  const zones = await cloudflareRequest(`/zones?${zoneQuery}`, token);
  const zone = selectPlaneirZone(zones, { accountId, zoneName });
  const entrypointPath = `/zones/${zone.id}/rulesets/phases/${PHASE}/entrypoint`;
  let ruleset = await cloudflareRequest(entrypointPath, token, { allowNotFound: true });
  const desiredRule = buildConsumerPlanHeaderRule(workerUrl.origin);
  const mutation = chooseHeaderRuleMutation(ruleset, desiredRule);

  if (mutation.kind === 'update-rule') {
    const existingRule = ruleset.rules.find((rule) => rule?.ref === RULE_REF);
    if (!headerRuleMatches(existingRule, desiredRule)) {
      await cloudflareRequest(
        `/zones/${zone.id}/rulesets/${mutation.rulesetId}/rules/${mutation.ruleId}`,
        token,
        { method: mutation.method, body: JSON.stringify(mutation.body) }
      );
    }
  } else if (mutation.kind === 'append-rule') {
    await cloudflareRequest(`/zones/${zone.id}/rulesets/${mutation.rulesetId}/rules`, token, {
      method: mutation.method,
      body: JSON.stringify(mutation.body)
    });
  } else {
    await cloudflareRequest(entrypointPath, token, {
      method: mutation.method,
      body: JSON.stringify(mutation.body)
    });
  }

  ruleset = await cloudflareRequest(entrypointPath, token);
  const matchingRules = ruleset.rules?.filter((rule) => rule?.ref === RULE_REF) || [];
  assert.equal(matchingRules.length, 1, 'Cloudflare did not retain exactly one consumer header rule.');
  assert.ok(headerRuleMatches(matchingRules[0], desiredRule), 'Cloudflare consumer header rule does not match the approved contract.');
  console.log(`Verified Cloudflare response-header transform rule ${RULE_REF}; unrelated rules were not replaced.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
