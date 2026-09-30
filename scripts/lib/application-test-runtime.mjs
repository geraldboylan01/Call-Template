import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import worker from '../../worker/src/index.js';
import { VOICE_CONSENT_VERSION } from '../../js/case_application/voice_contract.js';

class Statement {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.db, this.sql, values.map(value => value === undefined ? null : value)); }
  async first() { return this.db.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.values) }; }
  execute() { const result = this.db.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
  async run() { return this.execute(); }
}

export function createTestRuntime(overrides = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  // Resolve from scripts/lib rather than process.cwd().
  const directory = new URL('../../worker/migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(name, directory), 'utf8'));
  const objects = new Map();
  const bucket = {
    writes: 0, failPut: false, failDelete: false, duringPut: null,
    async put(key, bytes) { this.writes++; objects.set(key, new Uint8Array(bytes)); if (this.duringPut) await this.duringPut(); if (this.failPut) throw new Error('Simulated uncertain put failure'); },
    async get(key) { return objects.has(key) ? { body: new Blob([objects.get(key)]).stream() } : null; },
    async delete(key) { if (this.failDelete) throw new Error('Simulated delete failure'); objects.delete(key); }
  };
  const db = { prepare: query => new Statement(sql, query), async batch(statements) {
    sql.exec('BEGIN');
    try { const result = statements.map(statement => statement.execute()); sql.exec('COMMIT'); return result; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } };
  const env = { LEADS_DB: db, APPLICATION_AUDIO_BUCKET: bucket, APPLICATION_AUDIO_ENABLED: 'true',
    APPLICATION_DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64url'), APPLICATION_AUDIO_QUOTA_BYTES: '1000000000',
    ADVISOR_PASSWORD: 'test-only-password', ADVISOR_SESSION_SECRET: randomBytes(32).toString('base64url'),
    RESEND_API_KEY: 're_test', LEAD_EMAIL_FROM: 'test@example.com', LEAD_NOTIFICATION_TO: 'advisor@example.com',
    ...overrides };
  const pending = [];
  const ctx = { waitUntil: promise => pending.push(promise) };
  let ip = 0;
  async function dispatch(request) { const response = await worker.fetch(request, env, ctx); await Promise.all(pending.splice(0)); return response; }
  async function call(path, body, options = {}) {
    const headers = { Origin: 'https://planeir.ie', 'CF-Connecting-IP': `198.51.${Math.floor(++ip / 250)}.${ip % 250}`, ...(options.headers || {}) };
    if (body !== undefined && !options.binary) headers['Content-Type'] = 'application/json';
    const response = await dispatch(new Request(`https://api.planeir.ie${path}`, { method: options.method || (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : options.binary ? body : JSON.stringify(body), ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }));
    const json = response.headers.get('content-type')?.includes('application/json') ? await response.clone().json() : null;
    return { status: response.status, json, response };
  }
  async function login() { const result = await call('/api/auth/login', { password: env.ADVISOR_PASSWORD }); return { Cookie: result.response.headers.get('set-cookie')?.split(';')[0], 'X-Advisor-CSRF': result.json?.csrfToken }; }
  return { sql, db, env, objects, bucket, call, login, dispatch, async cron() { await worker.scheduled({}, env, ctx); await Promise.all(pending.splice(0)); }, close() { sql.close(); } };
}

export function captureEmail() {
  const original = globalThis.fetch; const emails = [];
  globalThis.fetch = async (url, options) => {
    if (String(url) !== 'https://api.resend.com/emails') throw new Error(`Unexpected external request: ${url}`);
    emails.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: 'test-email' }), { headers: { 'Content-Type': 'application/json' } });
  };
  return { emails, restore() { globalThis.fetch = original; } };
}
export const writtenApplication = () => ({ fullName: 'Test Applicant', email: `test-${randomUUID()}@example.com`,
  consentVideo: true, consentEducation: true, submissionId: randomBytes(32).toString('base64url'), application: { question: 'Can I retire earlier?', topics: ['retirement'], goodOutcome: 'More time with family', worries: 'Running out of savings' } });
export function wavFixture(seconds = 0.25) {
  const sampleRate = 8000, samples = Math.ceil(sampleRate * seconds);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin(i / sampleRate * 440 * 2 * Math.PI) * 3000), 44 + i * 2);
  return buffer;
}
export function voicePayload(token, bytes = wavFixture()) { return { token, uploadId: randomUUID(), sha256: createHash('sha256').update(bytes).digest('base64url'), bytes: bytes.length, contentType: 'audio/wav', durationMs: 250, consentPublication: true, consentVersion: VOICE_CONSENT_VERSION }; }
export function uploadOptions(payload) { return { method: 'PUT', binary: true, headers: { 'Content-Type': payload.contentType, 'X-Application-Audio-Token': payload.token, 'X-Voice-Request-Id': payload.uploadId, 'X-Voice-Publication-Consent': VOICE_CONSENT_VERSION } }; }
