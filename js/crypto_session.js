const PBKDF2_ITERATIONS = 150000;
const PUBLISHED_PIN_PBKDF2_ITERATIONS = 300000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const PAYLOAD_VERSION = 1;
const PUBLISHED_PAYLOAD_VERSION = 2;
const PUBLISHED_KEY_LENGTH = 32;
const HKDF_SALT = new Uint8Array(32);
const PUBLISHED_INFO = Object.freeze({
  clientWrap: 'planeir/publish/client-wrap/v1',
  clientAuth: 'planeir/publish/client-auth/v1',
  advisorWrap: 'planeir/publish/advisor-wrap/v1',
  advisorAuth: 'planeir/publish/advisor-auth/v1'
});

function getCrypto() {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('Web Crypto API is unavailable in this browser.');
  }

  return window.crypto;
}

export function randomBytes(length) {
  const byteLength = Number(length);
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error('randomBytes length must be a positive integer.');
  }

  const buffer = new Uint8Array(byteLength);
  getCrypto().getRandomValues(buffer);
  return buffer;
}

export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < view.length; index += chunkSize) {
    const chunk = view.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export function base64ToBytes(base64) {
  if (typeof base64 !== 'string' || !base64) {
    throw new Error('Invalid base64 input.');
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function base64UrlToBytes(base64Url) {
  if (typeof base64Url !== 'string' || !base64Url) {
    throw new Error('Invalid base64url input.');
  }

  const normalized = base64Url
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return base64ToBytes(padded);
}

function normalizeRequiredLegacyPin(pin) {
  const normalizedPin = String(pin ?? '').trim();
  if (!/^\d{6}$/.test(normalizedPin)) {
    throw new Error('PIN must be a 6-digit number.');
  }

  return normalizedPin;
}

function normalizeOptionalPublishedPin(pin) {
  const normalizedPin = String(pin ?? '').replace(/\s+/g, '').trim();
  if (!normalizedPin) {
    return '';
  }

  if (!/^\d{6}$/.test(normalizedPin)) {
    throw new Error('PIN must be exactly 6 digits.');
  }

  return normalizedPin;
}

async function derivePasswordKey(secret, saltBytes, options = {}) {
  const {
    iterations = PBKDF2_ITERATIONS,
    normalizeSecret = (value) => String(value ?? ''),
    invalidMessage = 'Secret is invalid.'
  } = options;
  const normalizedSecret = normalizeSecret(secret);
  if (!normalizedSecret) {
    throw new Error(invalidMessage);
  }

  const salt = saltBytes instanceof Uint8Array ? saltBytes : new Uint8Array(saltBytes);
  if (salt.length === 0) {
    throw new Error('Salt is required for key derivation.');
  }

  const encoder = new TextEncoder();
  const pinMaterial = await getCrypto().subtle.importKey(
    'raw',
    encoder.encode(normalizedSecret),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return getCrypto().subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256'
    },
    pinMaterial,
    {
      name: 'AES-GCM',
      length: 256
    },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function deriveKeyFromPin(pin, saltBytes) {
  return derivePasswordKey(pin, saltBytes, {
    iterations: PBKDF2_ITERATIONS,
    normalizeSecret: normalizeRequiredLegacyPin,
    invalidMessage: 'PIN must be a 6-digit number.'
  });
}

async function derivePublishedPinKey(pin, saltBytes) {
  return derivePasswordKey(pin, saltBytes, {
    iterations: PUBLISHED_PIN_PBKDF2_ITERATIONS,
    normalizeSecret: normalizeRequiredLegacyPin,
    invalidMessage: 'PIN must be a 6-digit number.'
  });
}

async function importHkdfSecret(secretBytes) {
  const secret = secretBytes instanceof Uint8Array ? secretBytes : new Uint8Array(secretBytes);
  if (secret.length === 0) {
    throw new Error('Secret material is required.');
  }

  return getCrypto().subtle.importKey(
    'raw',
    secret,
    'HKDF',
    false,
    ['deriveBits', 'deriveKey']
  );
}

async function deriveHkdfBytes(secretBytes, info, length) {
  const keyMaterial = await importHkdfSecret(secretBytes);
  const derivedBits = await getCrypto().subtle.deriveBits(
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

async function deriveHkdfAesKey(secretBytes, info) {
  const keyMaterial = await importHkdfSecret(secretBytes);
  return getCrypto().subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: HKDF_SALT,
      info: new TextEncoder().encode(info)
    },
    keyMaterial,
    {
      name: 'AES-GCM',
      length: 256
    },
    false,
    ['encrypt', 'decrypt']
  );
}

async function importAesKey(rawBytes) {
  const keyBytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  if (keyBytes.length !== PUBLISHED_KEY_LENGTH) {
    throw new Error('Invalid encryption key length.');
  }

  return getCrypto().subtle.importKey(
    'raw',
    keyBytes,
    {
      name: 'AES-GCM',
      length: 256
    },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptBytesWithKey(key, plaintextBytes, ivBytes) {
  return getCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes
    },
    key,
    plaintextBytes
  );
}

async function decryptBytesWithKey(key, ciphertextBytes, ivBytes, invalidMessage) {
  try {
    return await getCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes
      },
      key,
      ciphertextBytes
    );
  } catch (error) {
    if (error instanceof DOMException) {
      throw new Error(invalidMessage);
    }

    throw error;
  }
}

async function sha256Bytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await getCrypto().subtle.digest('SHA-256', view);
  return new Uint8Array(digest);
}

function toCipherEnvelope(ivBytes, ciphertextBuffer) {
  return {
    alg: 'AES-GCM-256',
    ivB64u: bytesToBase64Url(ivBytes),
    ctB64u: bytesToBase64Url(new Uint8Array(ciphertextBuffer))
  };
}

function assertCipherEnvelope(payload, label) {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`${label} is missing.`);
  }

  if (payload.alg !== 'AES-GCM-256') {
    throw new Error(`${label} uses an unsupported algorithm.`);
  }

  if (typeof payload.ivB64u !== 'string' || typeof payload.ctB64u !== 'string') {
    throw new Error(`${label} is malformed.`);
  }
}

function assertPublishedEnvelope(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Published session payload is missing.');
  }

  if (Number(payload.v) !== PUBLISHED_PAYLOAD_VERSION) {
    throw new Error(`Unsupported published session version: ${payload?.v}`);
  }

  assertCipherEnvelope(payload.payload, 'Encrypted session payload');
  return payload;
}

function assertPinBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('Secure PIN bundle is malformed.');
  }

  if (Number(bundle.v) !== 1 || bundle.kind !== 'pin-wrapped-dek') {
    throw new Error('Secure PIN bundle is unsupported.');
  }

  if (!bundle.kdf || bundle.kdf.alg !== 'PBKDF2-SHA-256') {
    throw new Error('Secure PIN bundle is malformed.');
  }

  assertCipherEnvelope(bundle.wrap, 'Secure PIN bundle');
  return bundle;
}

function assertAdvisorBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('Advisor access bundle is malformed.');
  }

  if (Number(bundle.v) !== 1 || bundle.kind !== 'advisor-access') {
    throw new Error('Advisor access bundle is unsupported.');
  }

  if (typeof bundle.dekB64u !== 'string' || typeof bundle.clientSecretB64u !== 'string') {
    throw new Error('Advisor access bundle is malformed.');
  }

  return bundle;
}

export async function encryptSessionJson(pin, sessionJsonString) {
  if (typeof sessionJsonString !== 'string') {
    throw new Error('Session payload must be a JSON string.');
  }

  const saltBytes = randomBytes(SALT_LENGTH);
  const ivBytes = randomBytes(IV_LENGTH);
  const key = await deriveKeyFromPin(pin, saltBytes);
  const plaintextBytes = new TextEncoder().encode(sessionJsonString);

  const ciphertextBuffer = await getCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes
    },
    key,
    plaintextBytes
  );

  return {
    v: PAYLOAD_VERSION,
    saltB64: bytesToBase64(saltBytes),
    ivB64: bytesToBase64(ivBytes),
    ctB64: bytesToBase64(new Uint8Array(ciphertextBuffer))
  };
}

export async function decryptSessionJson(pin, payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Encrypted payload is missing.');
  }

  if (Number(payload.v) !== PAYLOAD_VERSION) {
    throw new Error(`Unsupported payload version: ${payload.v}`);
  }

  const saltBytes = base64ToBytes(payload.saltB64);
  const ivBytes = base64ToBytes(payload.ivB64);
  const ctBytes = base64ToBytes(payload.ctB64);

  const key = await deriveKeyFromPin(pin, saltBytes);

  try {
    const plaintextBuffer = await getCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes
      },
      key,
      ctBytes
    );

    return new TextDecoder().decode(plaintextBuffer);
  } catch (error) {
    if (error instanceof DOMException) {
      throw new Error('Invalid PIN');
    }

    throw error;
  }
}

export async function buildPublishedCapabilityToken(secretB64u, role) {
  const info = role === 'advisor' ? PUBLISHED_INFO.advisorAuth : PUBLISHED_INFO.clientAuth;
  const secretBytes = base64UrlToBytes(secretB64u);
  const tokenBytes = await deriveHkdfBytes(secretBytes, info, PUBLISHED_KEY_LENGTH);
  return bytesToBase64Url(tokenBytes);
}

export async function encryptPublishedSessionV2(sessionJsonString, options = {}) {
  if (typeof sessionJsonString !== 'string') {
    throw new Error('Published session payload must be a JSON string.');
  }

  const encoder = new TextEncoder();
  const pin = normalizeOptionalPublishedPin(options.pin);
  const plaintextBytes = encoder.encode(sessionJsonString);
  const dekBytes = randomBytes(PUBLISHED_KEY_LENGTH);
  const payloadIvBytes = randomBytes(IV_LENGTH);
  const payloadKey = await importAesKey(dekBytes);
  const payloadCiphertext = await encryptBytesWithKey(payloadKey, plaintextBytes, payloadIvBytes);

  const clientSecretBytes = randomBytes(PUBLISHED_KEY_LENGTH);
  const advisorSecretBytes = randomBytes(PUBLISHED_KEY_LENGTH);
  const clientWrapKey = await deriveHkdfAesKey(clientSecretBytes, PUBLISHED_INFO.clientWrap);
  const advisorWrapKey = await deriveHkdfAesKey(advisorSecretBytes, PUBLISHED_INFO.advisorWrap);
  const clientAuthTokenBytes = await deriveHkdfBytes(clientSecretBytes, PUBLISHED_INFO.clientAuth, PUBLISHED_KEY_LENGTH);
  const advisorAuthTokenBytes = await deriveHkdfBytes(advisorSecretBytes, PUBLISHED_INFO.advisorAuth, PUBLISHED_KEY_LENGTH);
  const clientAuthHashBytes = await sha256Bytes(clientAuthTokenBytes);
  const advisorAuthHashBytes = await sha256Bytes(advisorAuthTokenBytes);

  let clientWrapPlaintextBytes = dekBytes;
  if (pin) {
    const pinSaltBytes = randomBytes(SALT_LENGTH);
    const pinWrapIvBytes = randomBytes(IV_LENGTH);
    const pinKey = await derivePublishedPinKey(pin, pinSaltBytes);
    const pinWrapCiphertext = await encryptBytesWithKey(pinKey, dekBytes, pinWrapIvBytes);
    const pinBundle = {
      v: 1,
      kind: 'pin-wrapped-dek',
      kdf: {
        alg: 'PBKDF2-SHA-256',
        iterations: PUBLISHED_PIN_PBKDF2_ITERATIONS,
        saltB64u: bytesToBase64Url(pinSaltBytes)
      },
      wrap: toCipherEnvelope(pinWrapIvBytes, pinWrapCiphertext)
    };
    clientWrapPlaintextBytes = encoder.encode(JSON.stringify(pinBundle));
  }

  const clientWrapIvBytes = randomBytes(IV_LENGTH);
  const clientWrapCiphertext = await encryptBytesWithKey(clientWrapKey, clientWrapPlaintextBytes, clientWrapIvBytes);
  const advisorBundle = {
    v: 1,
    kind: 'advisor-access',
    dekB64u: bytesToBase64Url(dekBytes),
    clientSecretB64u: bytesToBase64Url(clientSecretBytes),
    clientPin: pin || null
  };
  const advisorWrapIvBytes = randomBytes(IV_LENGTH);
  const advisorWrapCiphertext = await encryptBytesWithKey(
    advisorWrapKey,
    encoder.encode(JSON.stringify(advisorBundle)),
    advisorWrapIvBytes
  );

  return {
    clientSecretB64u: bytesToBase64Url(clientSecretBytes),
    advisorSecretB64u: bytesToBase64Url(advisorSecretBytes),
    clientPin: pin || '',
    requestBody: {
      v: PUBLISHED_PAYLOAD_VERSION,
      payload: toCipherEnvelope(payloadIvBytes, payloadCiphertext),
      clientAccess: {
        authHashB64u: bytesToBase64Url(clientAuthHashBytes),
        pinRequired: Boolean(pin),
        wrap: toCipherEnvelope(clientWrapIvBytes, clientWrapCiphertext)
      },
      advisorAccess: {
        authHashB64u: bytesToBase64Url(advisorAuthHashBytes),
        wrap: toCipherEnvelope(advisorWrapIvBytes, advisorWrapCiphertext)
      }
    }
  };
}

async function decryptPublishedPayloadWithDek(dekBytes, encryptedPayload, invalidMessage) {
  assertCipherEnvelope(encryptedPayload, 'Encrypted session payload');
  const payloadKey = await importAesKey(dekBytes);
  const plaintextBuffer = await decryptBytesWithKey(
    payloadKey,
    base64UrlToBytes(encryptedPayload.ctB64u),
    base64UrlToBytes(encryptedPayload.ivB64u),
    invalidMessage
  );
  return new TextDecoder().decode(plaintextBuffer);
}

async function unwrapClientDek(clientSecretB64u, payload, pin) {
  const envelope = assertPublishedEnvelope(payload);
  if (!envelope.clientAccess || typeof envelope.clientAccess !== 'object') {
    throw new Error('Client access bundle is missing.');
  }

  assertCipherEnvelope(envelope.clientAccess.wrap, 'Client access bundle');
  const clientSecretBytes = base64UrlToBytes(clientSecretB64u);
  const clientWrapKey = await deriveHkdfAesKey(clientSecretBytes, PUBLISHED_INFO.clientWrap);
  const wrappedBytesBuffer = await decryptBytesWithKey(
    clientWrapKey,
    base64UrlToBytes(envelope.clientAccess.wrap.ctB64u),
    base64UrlToBytes(envelope.clientAccess.wrap.ivB64u),
    'This secure link is invalid or incomplete.'
  );
  const wrappedBytes = new Uint8Array(wrappedBytesBuffer);

  if (!envelope.clientAccess.pinRequired) {
    if (wrappedBytes.length !== PUBLISHED_KEY_LENGTH) {
      throw new Error('Published session key is malformed.');
    }
    return wrappedBytes;
  }

  const normalizedPin = normalizeRequiredLegacyPin(pin);
  const pinBundle = assertPinBundle(JSON.parse(new TextDecoder().decode(wrappedBytesBuffer)));
  const pinKey = await derivePasswordKey(normalizedPin, base64UrlToBytes(pinBundle.kdf.saltB64u), {
    iterations: Number(pinBundle.kdf.iterations) || PUBLISHED_PIN_PBKDF2_ITERATIONS,
    normalizeSecret: normalizeRequiredLegacyPin,
    invalidMessage: 'PIN must be a 6-digit number.'
  });
  const dekBuffer = await decryptBytesWithKey(
    pinKey,
    base64UrlToBytes(pinBundle.wrap.ctB64u),
    base64UrlToBytes(pinBundle.wrap.ivB64u),
    'Invalid PIN'
  );
  const dekBytes = new Uint8Array(dekBuffer);
  if (dekBytes.length !== PUBLISHED_KEY_LENGTH) {
    throw new Error('Published session key is malformed.');
  }
  return dekBytes;
}

export async function decryptPublishedSessionV2ForClient(clientSecretB64u, payload, options = {}) {
  const dekBytes = await unwrapClientDek(clientSecretB64u, payload, options.pin);
  return decryptPublishedPayloadWithDek(dekBytes, payload.payload, 'This secure link is invalid or incomplete.');
}

export async function decryptPublishedSessionV2ForAdvisor(advisorSecretB64u, payload) {
  const envelope = assertPublishedEnvelope(payload);
  if (!envelope.advisorAccess || typeof envelope.advisorAccess !== 'object') {
    throw new Error('Advisor access bundle is missing.');
  }

  assertCipherEnvelope(envelope.advisorAccess.wrap, 'Advisor access bundle');
  const advisorSecretBytes = base64UrlToBytes(advisorSecretB64u);
  const advisorWrapKey = await deriveHkdfAesKey(advisorSecretBytes, PUBLISHED_INFO.advisorWrap);
  const advisorBundleBuffer = await decryptBytesWithKey(
    advisorWrapKey,
    base64UrlToBytes(envelope.advisorAccess.wrap.ctB64u),
    base64UrlToBytes(envelope.advisorAccess.wrap.ivB64u),
    'This advisor link is invalid or incomplete.'
  );
  const advisorBundle = assertAdvisorBundle(JSON.parse(new TextDecoder().decode(advisorBundleBuffer)));
  const plaintext = await decryptPublishedPayloadWithDek(
    base64UrlToBytes(advisorBundle.dekB64u),
    envelope.payload,
    'This advisor link is invalid or incomplete.'
  );

  return {
    plaintext,
    clientSecretB64u: advisorBundle.clientSecretB64u,
    clientPin: typeof advisorBundle.clientPin === 'string' ? advisorBundle.clientPin : ''
  };
}
