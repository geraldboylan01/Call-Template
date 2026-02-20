const PBKDF2_ITERATIONS = 150000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const PAYLOAD_VERSION = 1;

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

export async function deriveKeyFromPin(pin, saltBytes) {
  const normalizedPin = String(pin ?? '').trim();
  if (!/^\d{6}$/.test(normalizedPin)) {
    throw new Error('PIN must be a 6-digit number.');
  }

  const salt = saltBytes instanceof Uint8Array ? saltBytes : new Uint8Array(saltBytes);
  if (salt.length === 0) {
    throw new Error('Salt is required for key derivation.');
  }

  const encoder = new TextEncoder();
  const pinMaterial = await getCrypto().subtle.importKey(
    'raw',
    encoder.encode(normalizedPin),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return getCrypto().subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
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
