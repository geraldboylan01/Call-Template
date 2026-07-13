const FORBIDDEN_POINTER_TOKENS = new Set(['__proto__', 'prototype', 'constructor']);

export function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function cloneJson(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export function assertJsonCompatible(value, fieldName = 'value', seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${fieldName} must not contain a non-finite number.`);
    return value;
  }
  if (typeof value !== 'object') throw new Error(`${fieldName} must contain JSON-compatible values only.`);
  if (seen.has(value)) throw new Error(`${fieldName} must not contain circular values.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonCompatible(entry, `${fieldName}[${index}]`, seen));
    seen.delete(value);
    return value;
  }
  if (!isPlainObject(value)) throw new Error(`${fieldName} must contain plain JSON objects only.`);
  Object.entries(value).forEach(([key, entry]) => {
    if (FORBIDDEN_POINTER_TOKENS.has(key)) throw new Error(`${fieldName} contains a forbidden object key.`);
    assertJsonCompatible(entry, `${fieldName}.${key}`, seen);
  });
  seen.delete(value);
  return value;
}

export function assertIsoDateTime(value, fieldName) {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${fieldName} must be a valid ISO date-time string.`);
  }
  return value.trim();
}

export function assertIsoDate(value, fieldName, { nullable = false } = {}) {
  if (nullable && (value === null || typeof value === 'undefined' || value === '')) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new Error(`${fieldName} must be a YYYY-MM-DD string${nullable ? ' when provided' : ''}.`);
  }
  const normalized = value.trim();
  const [year, month, day] = normalized.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${fieldName} must be a valid calendar date.`);
  }
  return normalized;
}

export function finiteNumber(value, fieldName, {
  min = -Infinity,
  max = Infinity,
  integer = false,
  optional = false,
  fallback
} = {}) {
  if ((value === null || typeof value === 'undefined' || value === '') && optional) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number${optional ? ' when provided' : ''}.`);
  }
  if (value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${fieldName} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  }
  return value;
}

export function enumValue(value, values, fieldName, { optional = false, fallback } = {}) {
  if ((value === null || typeof value === 'undefined' || value === '') && optional) return fallback;
  if (!values.includes(value)) {
    throw new Error(`${fieldName} must be one of: ${values.join(', ')}.`);
  }
  return value;
}

export function nonEmptyString(value, fieldName, { optional = false, fallback } = {}) {
  if ((value === null || typeof value === 'undefined' || value === '') && optional) return fallback;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string${optional ? ' when provided' : ''}.`);
  }
  return value.trim();
}

export function escapeJsonPointerToken(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

export function decodeJsonPointer(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/') {
    throw new Error('Profile patch paths must be non-root JSON Pointers.');
  }
  const rawTokens = path.slice(1).split('/');
  if (rawTokens.some((token) => /~(?![01])/u.test(token))) {
    throw new Error('Profile patch path contains an invalid JSON Pointer escape.');
  }
  const tokens = rawTokens.map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (tokens.some((token) => FORBIDDEN_POINTER_TOKENS.has(token))) {
    throw new Error('Profile patch path contains a forbidden token.');
  }
  return tokens;
}

export function encodeJsonPointer(tokens) {
  return `/${tokens.map(escapeJsonPointerToken).join('/')}`;
}

export function readJsonPointer(value, path) {
  const tokens = decodeJsonPointer(path);
  let cursor = value;
  for (const token of tokens) {
    if (Array.isArray(cursor)) {
      if (!/^\d+$/.test(token)) return undefined;
      cursor = cursor[Number(token)];
    } else if (isPlainObject(cursor) && Object.hasOwn(cursor, token)) {
      cursor = cursor[token];
    } else {
      return undefined;
    }
  }
  return cursor;
}

export function stableStringify(value) {
  const seen = new WeakSet();
  const normalize = (candidate) => {
    if (candidate === null || typeof candidate !== 'object') {
      if (typeof candidate === 'number' && !Number.isFinite(candidate)) {
        throw new Error('Cannot hash a non-finite number.');
      }
      return candidate;
    }
    if (seen.has(candidate)) throw new Error('Cannot hash a circular value.');
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.map(normalize);
    const result = {};
    Object.keys(candidate).sort().forEach((key) => {
      if (typeof candidate[key] !== 'undefined') result[key] = normalize(candidate[key]);
    });
    return result;
  };
  return JSON.stringify(normalize(value));
}

function fallbackFnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, '0');
}

export async function sha256Json(value) {
  const serialized = stableStringify(value);
  if (globalThis.crypto?.subtle && typeof TextEncoder === 'function') {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `sha256:${hex}`;
  }
  // Only for older JS test hosts. Supported browsers and Workers use SHA-256.
  return `fnv1a64:${fallbackFnv1a64(serialized)}`;
}

export function createOpaqueId(prefix = 'id') {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  const random = Math.random().toString(36).slice(2);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
