import { ConsumerError } from './errors.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ENCRYPTION_KEY_BYTES = 32;
const CREDENTIAL_SECRET_BYTES = 32;
const MAX_ENCRYPTED_JSON_PLAINTEXT_BYTES = 750_000;

export function toBase64Url(bytes) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromBase64Url(value, maxLength = 4096) {
  if (typeof value !== 'string' || !value || value.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Malformed base64url value.');
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomId(prefix) {
  return `${prefix}_${toBase64Url(crypto.getRandomValues(new Uint8Array(18)))}`;
}

export async function sha256Base64Url(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toBase64Url(new Uint8Array(digest));
}

export async function hmacSha256Base64Url(keyMaterial, value) {
  let keyBytes;
  try {
    keyBytes = fromBase64Url(typeof keyMaterial === 'string' ? keyMaterial.trim() : '', 128);
  } catch (_error) {
    throw new ConsumerError(503, 'consumer_rate_limit_unavailable', 'This planning journey is not available right now.');
  }
  if (keyBytes.length !== 32) {
    throw new ConsumerError(503, 'consumer_rate_limit_unavailable', 'This planning journey is not available right now.');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(String(value)));
  return toBase64Url(new Uint8Array(signature));
}

export function constantTimeEqual(left, right) {
  const leftBytes = typeof left === 'string' ? encoder.encode(left) : new Uint8Array(left);
  const rightBytes = typeof right === 'string' ? encoder.encode(right) : new Uint8Array(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index % Math.max(1, leftBytes.length)] || 0)
      ^ (rightBytes[index % Math.max(1, rightBytes.length)] || 0);
  }
  return difference === 0;
}

export async function createConsumerCredential(proposedCredential = '') {
  const proposed = typeof proposedCredential === 'string' ? proposedCredential.trim() : '';
  const parsed = proposed ? parseConsumerCredential(proposed) : null;
  if (proposed && !parsed) {
    throw new ConsumerError(400, 'consumer_credential_invalid', 'Private session setup could not be validated.');
  }
  const id = parsed?.id || randomId('cs');
  const secret = parsed?.secret || toBase64Url(crypto.getRandomValues(new Uint8Array(CREDENTIAL_SECRET_BYTES)));
  return {
    id,
    secret,
    credential: `${id}.${secret}`,
    credentialHashB64u: await sha256Base64Url(secret)
  };
}

export function parseConsumerCredential(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const match = /^(cs_[A-Za-z0-9_-]{20,80})\.([A-Za-z0-9_-]{40,80})$/.exec(value.trim());
  return match ? { id: match[1], secret: match[2] } : null;
}

function currentKeyId(env) {
  const value = typeof env.CONSUMER_DATA_ENCRYPTION_KEY_ID === 'string'
    ? env.CONSUMER_DATA_ENCRYPTION_KEY_ID.trim()
    : '';
  return value && /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? value : 'consumer-v1';
}

export function getCurrentEncryptionKeyId(env) {
  return currentKeyId(env);
}

export function getEncryptedPayloadKeyId(encrypted) {
  try {
    const envelope = JSON.parse(encrypted);
    return envelope?.v === 1
      && typeof envelope.kid === 'string'
      && /^[A-Za-z0-9._:-]{1,80}$/.test(envelope.kid)
      ? envelope.kid
      : '';
  } catch (_error) {
    return '';
  }
}

function previousKeyMaterial(env, requestedKeyId) {
  const raw = typeof env.CONSUMER_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON === 'string'
    ? env.CONSUMER_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON.trim()
    : '';
  if (!raw || raw.length > 4_096) return '';
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > 3) return '';
    const value = parsed[requestedKeyId];
    return typeof value === 'string' ? value.trim() : '';
  } catch (_error) {
    return '';
  }
}

async function importEncryptionKey(env, requestedKeyId = currentKeyId(env)) {
  const currentId = currentKeyId(env);
  const configured = requestedKeyId === currentId
    ? (typeof env.CONSUMER_DATA_ENCRYPTION_KEY === 'string' ? env.CONSUMER_DATA_ENCRYPTION_KEY.trim() : '')
    : previousKeyMaterial(env, requestedKeyId);
  if (!configured) {
    throw new ConsumerError(503, 'consumer_encryption_unavailable', 'This planning journey is not available right now.');
  }

  let bytes;
  try {
    bytes = fromBase64Url(configured, 128);
  } catch (_error) {
    throw new ConsumerError(503, 'consumer_encryption_unavailable', 'This planning journey is not available right now.');
  }
  if (bytes.length !== ENCRYPTION_KEY_BYTES) {
    throw new ConsumerError(503, 'consumer_encryption_unavailable', 'This planning journey is not available right now.');
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptJson(env, value, aad) {
  const keyId = currentKeyId(env);
  const key = await importEncryptionKey(env, keyId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = encoder.encode(JSON.stringify(value));
  if (plaintextBytes.length > MAX_ENCRYPTED_JSON_PLAINTEXT_BYTES) {
    throw new ConsumerError(413, 'consumer_payload_too_large', 'Planning data is too large to save.');
  }
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    key,
    plaintextBytes
  );
  return JSON.stringify({
    v: 1,
    kid: keyId,
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(ciphertext))
  });
}

export async function decryptJson(env, encrypted, aad) {
  let envelope;
  try {
    envelope = JSON.parse(encrypted);
    if (envelope?.v !== 1) throw new Error('Unsupported encrypted payload version.');
    if (typeof envelope.kid !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(envelope.kid)) {
      throw new Error('Encrypted payload key id is invalid.');
    }
    const key = await importEncryptionKey(env, envelope.kid);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(envelope.iv, 64),
        additionalData: encoder.encode(aad)
      },
      key,
      fromBase64Url(envelope.ct, 2_000_000)
    );
    return JSON.parse(decoder.decode(plaintext));
  } catch (error) {
    if (error instanceof ConsumerError) throw error;
    throw new ConsumerError(500, 'consumer_payload_unreadable', 'Saved planning data could not be read.');
  }
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
