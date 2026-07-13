import { ConsumerError } from './errors.js';
import { fromBase64Url, toBase64Url } from './crypto.js';

const TOKEN_PREFIX = 'ci1';
const TOKEN_AUDIENCE = 'planeir-consumer';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function validInviteSigningKey(value) {
  try {
    return fromBase64Url(cleanText(value), 128).length === 32;
  } catch (_error) {
    return false;
  }
}

async function importSigningKey(value, keyUsages = ['verify']) {
  if (!validInviteSigningKey(value)) {
    throw new ConsumerError(503, 'consumer_audience_unavailable', 'This planning journey is not accepting new sessions right now.');
  }
  return crypto.subtle.importKey(
    'raw',
    fromBase64Url(cleanText(value), 128),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    keyUsages
  );
}

export async function createConsumerInvite(env, config, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const nowSeconds = Math.floor(now / 1_000);
  const maximumTtlHours = Number(config?.inviteMaxTtlHours);
  const ttlHours = options.ttlHours === undefined
    ? Math.min(4, maximumTtlHours)
    : Number(options.ttlHours);
  const maxUses = options.maxUses === undefined ? 1 : Number(options.maxUses);
  const cohort = cleanText(config?.cohort);

  if (!Number.isSafeInteger(nowSeconds)
    || !Number.isSafeInteger(maximumTtlHours)
    || maximumTtlHours < 1
    || maximumTtlHours > 720
    || !Number.isSafeInteger(ttlHours)
    || ttlHours < 1
    || ttlHours > maximumTtlHours
    || !Number.isSafeInteger(maxUses)
    || maxUses < 1
    || maxUses > 50
    || !/^[A-Za-z0-9._:-]{1,80}$/.test(cohort)) {
    throw new ConsumerError(503, 'consumer_audience_unavailable', 'This planning journey is not accepting new sessions right now.');
  }

  const issuedAt = nowSeconds;
  const expiresAt = issuedAt + ttlHours * 60 * 60;
  const payload = {
    v: 1,
    aud: TOKEN_AUDIENCE,
    jti: toBase64Url(crypto.getRandomValues(new Uint8Array(18))),
    cohort,
    iat: issuedAt,
    exp: expiresAt,
    maxUses
  };
  const payloadPart = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signedValue = `${TOKEN_PREFIX}.${payloadPart}`;
  const key = await importSigningKey(env?.CONSUMER_INVITE_SIGNING_KEY, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signedValue));

  return Object.freeze({
    token: `${signedValue}.${toBase64Url(new Uint8Array(signature))}`,
    jti: payload.jti,
    cohort,
    maxUses,
    issuedAt: new Date(issuedAt * 1_000).toISOString(),
    expiresAt: new Date(expiresAt * 1_000).toISOString()
  });
}

function parsePayload(payloadPart) {
  let payload;
  try {
    payload = JSON.parse(decoder.decode(fromBase64Url(payloadPart, 2_048)));
  } catch (_error) {
    throw new ConsumerError(403, 'consumer_invite_required', 'A valid planning invitation is required.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ConsumerError(403, 'consumer_invite_required', 'A valid planning invitation is required.');
  }
  return payload;
}

function assertClaims(payload, config, nowSeconds) {
  const validJti = typeof payload.jti === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(payload.jti);
  const validCohort = typeof payload.cohort === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(payload.cohort);
  const validTimes = Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.exp)
    && payload.iat <= nowSeconds + 300
    && payload.exp > nowSeconds
    && payload.exp > payload.iat
    && payload.exp - payload.iat <= config.inviteMaxTtlHours * 60 * 60;
  const validUses = Number.isSafeInteger(payload.maxUses) && payload.maxUses >= 1 && payload.maxUses <= 50;
  if (payload.v !== 1
    || payload.aud !== TOKEN_AUDIENCE
    || !validJti
    || !validCohort
    || !validTimes
    || !validUses
    || payload.cohort !== config.cohort) {
    throw new ConsumerError(403, 'consumer_invite_required', 'A valid planning invitation is required.');
  }
}

export async function verifyConsumerInvite(token, env, config, now = Date.now()) {
  const value = cleanText(token);
  if (!value || value.length > 1_024) {
    throw new ConsumerError(403, 'consumer_invite_required', 'A valid planning invitation is required.');
  }
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    throw new ConsumerError(403, 'consumer_invite_required', 'A valid planning invitation is required.');
  }
  const [, payloadPart, signaturePart] = parts;
  let signature;
  try {
    signature = fromBase64Url(signaturePart, 128);
  } catch (_error) {
    throw new ConsumerError(403, 'consumer_invite_required', 'A valid planning invitation is required.');
  }
  const key = await importSigningKey(env.CONSUMER_INVITE_SIGNING_KEY);
  const verified = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    encoder.encode(`${TOKEN_PREFIX}.${payloadPart}`)
  );
  if (!verified) {
    throw new ConsumerError(403, 'consumer_invite_required', 'A valid planning invitation is required.');
  }
  const payload = parsePayload(payloadPart);
  assertClaims(payload, config, Math.floor(now / 1_000));
  return Object.freeze({
    jti: payload.jti,
    cohort: payload.cohort,
    maxUses: payload.maxUses,
    issuedAt: new Date(payload.iat * 1_000).toISOString(),
    expiresAt: new Date(payload.exp * 1_000).toISOString()
  });
}
