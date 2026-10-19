import {
  evaluateLeadQualification,
  normalizeQualificationAssessment,
  rankLeadQualifications,
  LEAD_QUALIFICATION_VERSION
} from '../../../js/planning/lead_qualification.js';
import { encryptJson, decryptJson, randomId, sha256Base64Url, stableStringify } from '../consumer/crypto.js';

const MATCH = /^\/api\/advisor\/leads\/([1-9]\d*)\/qualification(?:\/(outcomes))?$/;
const RANKING_PATH = '/api/advisor/qualification/ranking';
const ID = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_BODY_BYTES = 180_000;
const OUTCOMES = new Set(['contacted', 'meeting_held', 'client_won', 'funds_transferred', 'closed_lost']);
const respondDefault = (body, status = 200, methods = 'GET,POST,OPTIONS') => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', Allow: methods.replace(',OPTIONS', '') }
});
const problem = (status, code, message) => Object.assign(new Error(message), { status, code });

function cryptoEnv(env) {
  const prefix = env.QUALIFICATION_DATA_ENCRYPTION_KEY ? 'QUALIFICATION' : 'APPLICATION';
  return {
    CONSUMER_DATA_ENCRYPTION_KEY: env[`${prefix}_DATA_ENCRYPTION_KEY`],
    CONSUMER_DATA_ENCRYPTION_KEY_ID: env[`${prefix}_DATA_ENCRYPTION_KEY_ID`] || `${prefix.toLowerCase()}-v1`,
    CONSUMER_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: env[`${prefix}_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON`]
  };
}
function aad(leadId, id, kind = 'assessment') { return `advisor/lead-qualification/${leadId}/${kind}/${id}`; }
function idFor(value, prefix) {
  if (value === undefined || value === null) return randomId(prefix);
  if (typeof value !== 'string' || !ID.test(value)) throw problem(400, 'invalid_qualification_id', 'Use an opaque identifier of 8 to 100 letters, digits, hyphens or underscores.');
  return value;
}
async function readBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw problem(413, 'qualification_too_large', 'The qualification request is too large.');
  if (!request.body) throw problem(400, 'invalid_json', 'A JSON body is required.');
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw problem(413, 'qualification_too_large', 'The qualification request is too large.'); }
    chunks.push(value);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(combined)); }
  catch { throw problem(400, 'invalid_json', 'The request body must be valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem(400, 'invalid_json', 'The request body must be a JSON object.');
  return body;
}
async function unpackAssessment(env, row) {
  if (!row) return null;
  const payload = await decryptJson(cryptoEnv(env), row.payload_encrypted, aad(row.lead_id, row.id));
  return { id: row.id, createdAt: row.created_at, ...payload };
}
async function detail(env, leadId) {
  const row = await env.LEADS_DB.prepare('SELECT * FROM lead_qualification_assessments WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').bind(leadId).first();
  const outcomes = await env.LEADS_DB.prepare('SELECT * FROM lead_qualification_outcomes WHERE lead_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').bind(leadId).all();
  return {
    assessment: await unpackAssessment(env, row),
    outcomes: await Promise.all((outcomes.results || []).map(async (outcome) => ({
      id: outcome.id, assessmentId: outcome.assessment_id, createdAt: outcome.created_at,
      ...await decryptJson(cryptoEnv(env), outcome.payload_encrypted, aad(leadId, outcome.id, 'outcome'))
    }))),
    billingEnabled: false
  };
}
async function ranking(env, timestamp) {
  const rows = await env.LEADS_DB.prepare(`SELECT a.*, l.full_name, l.created_at AS request_created_at
    FROM lead_qualification_assessments a JOIN leads l ON l.id = a.lead_id
    WHERE a.id = (SELECT latest.id FROM lead_qualification_assessments latest
      WHERE latest.lead_id = a.lead_id ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1)`).all();
  const entries = await Promise.all((rows.results || []).map(async (row) => {
    const saved = await unpackAssessment(env, row);
    // Snapshots remain immutable. Rank from facts re-evaluated at the current
    // time, so yesterday's fresh-profile/consent result is never replayed blindly.
    const result = evaluateLeadQualification({ ...saved.input, assessedAt: timestamp });
    return { leadId: Number(row.lead_id), fullName: row.full_name,
      requestedAt: saved.input.consent.capturedAt, leadCreatedAt: row.request_created_at,
      assessmentId: row.id, assessmentCreatedAt: row.created_at,
      adviser: { id: saved.input.adviser.id, name: saved.input.adviser.name }, result };
  }));
  const ranked = rankLeadQualifications(entries).map(({ result, ...entry }) => ({
    ...entry, pfumCents: result.pfumCents, readinessScore: result.readinessScore,
    classification: result.classification, quote: result.quote
  }));
  return { evaluatedAt: timestamp, rulesVersion: LEAD_QUALIFICATION_VERSION, ranked,
    counts: { assessed: entries.length, eligible: ranked.length, needsReview: entries.length - ranked.length },
    billingEnabled: false };
}
async function createAssessment(request, env, leadId, timestamp) {
  const body = await readBody(request);
  const id = idFor(body.assessmentId, 'qualification');
  if (!body.assessment || typeof body.assessment !== 'object' || Array.isArray(body.assessment)) throw problem(400, 'invalid_qualification', 'assessment must be an object.');
  // Server owns the assessment clock. Ignore submitted computed totals/scores.
  const input = normalizeQualificationAssessment({ ...body.assessment, assessedAt: timestamp });
  const { assessedAt: _clock, ...hashInput } = input;
  const hash = await sha256Base64Url(stableStringify(hashInput));
  const prior = await env.LEADS_DB.prepare('SELECT * FROM lead_qualification_assessments WHERE id = ?').bind(id).first();
  if (prior) {
    if (Number(prior.lead_id) !== leadId || prior.input_hash !== hash) throw problem(409, 'qualification_id_conflict', 'That assessment identifier already belongs to different input.');
    return { assessment: await unpackAssessment(env, prior), replayed: true, billingEnabled: false };
  }
  const result = evaluateLeadQualification(input);
  const encrypted = await encryptJson(cryptoEnv(env), { input, result }, aad(leadId, id));
  try {
    await env.LEADS_DB.prepare('INSERT INTO lead_qualification_assessments (id, lead_id, rules_version, input_hash, payload_encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, leadId, result.rulesVersion, hash, encrypted, timestamp).run();
  } catch (error) {
    const concurrent = await env.LEADS_DB.prepare('SELECT * FROM lead_qualification_assessments WHERE id = ?').bind(id).first();
    if (!concurrent) throw error;
    if (Number(concurrent.lead_id) !== leadId || concurrent.input_hash !== hash) throw problem(409, 'qualification_id_conflict', 'That assessment identifier already belongs to different input.');
    return { assessment: await unpackAssessment(env, concurrent), replayed: true, billingEnabled: false };
  }
  return { assessment: { id, createdAt: timestamp, input, result }, replayed: false, billingEnabled: false };
}
async function createOutcome(request, env, leadId, timestamp) {
  const body = await readBody(request);
  const id = idFor(body.eventId, 'qualification_outcome');
  if (typeof body.assessmentId !== 'string' || !ID.test(body.assessmentId)) throw problem(400, 'invalid_qualification_id', 'An assessment identifier is required.');
  const assessment = await env.LEADS_DB.prepare('SELECT id FROM lead_qualification_assessments WHERE id = ? AND lead_id = ?').bind(body.assessmentId, leadId).first();
  if (!assessment) throw problem(404, 'qualification_not_found', 'The assessment was not found for this lead.');
  if (!OUTCOMES.has(body.event)) throw problem(400, 'invalid_qualification_outcome', 'Outcome event is invalid.');
  if (typeof body.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(body.occurredAt) || !Number.isFinite(Date.parse(body.occurredAt)) || Date.parse(body.occurredAt) > Date.parse(timestamp)) throw problem(400, 'invalid_qualification_outcome', 'Use an observed outcome timestamp that is not in the future.');
  const amountCents = body.amountCents ?? null;
  if (body.event === 'funds_transferred' && (!Number.isSafeInteger(amountCents) || amountCents < 0 || amountCents > 1_000_000_000_000_000)) throw problem(400, 'invalid_qualification_outcome', 'Transferred funds require an integer EUR amount in cents.');
  if (body.event !== 'funds_transferred' && amountCents !== null) throw problem(400, 'invalid_qualification_outcome', 'Only a funds-transferred event has an amount.');
  if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 2000)) throw problem(400, 'invalid_qualification_outcome', 'Outcome notes must be at most 2000 characters.');
  const payload = { event: body.event, occurredAt: new Date(body.occurredAt).toISOString(), amountCents, currency: 'EUR', notes: body.notes || '' };
  const hash = await sha256Base64Url(stableStringify({ assessmentId: body.assessmentId, ...payload }));
  const prior = await env.LEADS_DB.prepare('SELECT * FROM lead_qualification_outcomes WHERE id = ?').bind(id).first();
  if (prior) {
    if (Number(prior.lead_id) !== leadId || prior.input_hash !== hash) throw problem(409, 'qualification_id_conflict', 'That outcome identifier already belongs to different input.');
    return { outcome: { id, assessmentId: prior.assessment_id, createdAt: prior.created_at, ...await decryptJson(cryptoEnv(env), prior.payload_encrypted, aad(leadId, id, 'outcome')) }, replayed: true };
  }
  const encrypted = await encryptJson(cryptoEnv(env), payload, aad(leadId, id, 'outcome'));
  try {
    await env.LEADS_DB.prepare('INSERT INTO lead_qualification_outcomes (id, lead_id, assessment_id, input_hash, payload_encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, leadId, body.assessmentId, hash, encrypted, timestamp).run();
  } catch (error) {
    const concurrent = await env.LEADS_DB.prepare('SELECT * FROM lead_qualification_outcomes WHERE id = ?').bind(id).first();
    if (!concurrent) throw error;
    if (Number(concurrent.lead_id) !== leadId || concurrent.input_hash !== hash) throw problem(409, 'qualification_id_conflict', 'That outcome identifier already belongs to different input.');
    return { outcome: { id, assessmentId: concurrent.assessment_id, createdAt: concurrent.created_at, ...await decryptJson(cryptoEnv(env), concurrent.payload_encrypted, aad(leadId, id, 'outcome')) }, replayed: true };
  }
  return { outcome: { id, assessmentId: body.assessmentId, createdAt: timestamp, ...payload }, replayed: false };
}

/** Internal admin API. Authentication/CSRF is delegated to the host's existing adviser guard. */
export async function handleQualificationRequest(request, env, { requireAdmin, respond = respondDefault, now = () => new Date().toISOString() } = {}) {
  const pathname = new URL(request.url).pathname;
  const match = MATCH.exec(pathname), isRanking = pathname === RANKING_PATH;
  if (!match && !isRanking) return null;
  const methods = isRanking ? 'GET,OPTIONS' : match[2] ? 'POST,OPTIONS' : 'GET,POST,OPTIONS';
  try {
    if (typeof requireAdmin !== 'function') return respond({ code: 'advisor_auth_required', error: 'Adviser authentication is required.' }, 401, methods);
    const auth = await requireAdmin(request.method !== 'GET');
    if (auth?.response) return auth.response;
    if (auth?.session?.authEnabled !== true || auth?.session?.authenticated !== true) return respond({ code: 'advisor_auth_required', error: 'Configured adviser authentication is required.' }, 401, methods);
    if (isRanking ? request.method !== 'GET' : !(request.method === 'POST' || (!match[2] && request.method === 'GET'))) return respond({ code: 'method_not_allowed', error: 'Method not allowed.' }, 405, methods);
    if (!env.LEADS_DB) return respond({ code: 'qualification_not_provisioned', error: 'Qualification storage is not configured.' }, 503, methods);
    if (isRanking) return respond(await ranking(env, now()), 200, methods);
    const leadId = Number(match[1]);
    if (!Number.isSafeInteger(leadId)) return respond({ code: 'lead_not_found', error: 'Lead not found.' }, 404, methods);
    const lead = await env.LEADS_DB.prepare('SELECT id FROM leads WHERE id = ?').bind(leadId).first();
    if (!lead) return respond({ code: 'lead_not_found', error: 'Lead not found.' }, 404, methods);
    if (request.method === 'GET') return respond(await detail(env, leadId), 200, methods);
    const timestamp = now();
    const saved = match[2] ? await createOutcome(request, env, leadId, timestamp) : await createAssessment(request, env, leadId, timestamp);
    return respond(saved, saved.replayed ? 200 : 201, methods);
  } catch (error) {
    if (/no such table/i.test(error?.message || '')) return respond({ code: 'qualification_not_provisioned', error: 'Deploy migration 0022_lead_qualification.sql to provision qualification storage.' }, 503, methods);
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) return respond({ code: error.code || 'invalid_qualification', error: error.message }, error.status, methods);
    return respond({ code: 'qualification_unavailable', error: 'Qualification could not be saved or read. Check storage and encryption configuration.' }, 503, methods);
  }
}
