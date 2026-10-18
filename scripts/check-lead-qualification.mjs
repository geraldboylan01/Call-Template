import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  evaluateLeadQualification, normalizeQualificationAssessment, priceLeadIntroduction,
  prefillQualificationAssets, isPriorityQualification, rankLeadQualifications
} from '../js/planning/lead_qualification.js';
import { handleQualificationRequest } from '../worker/src/advisor/qualification.js';

const NOW = '2026-10-17T10:00:00.000Z';
const euros = (value) => value * 100;
const asset = (overrides = {}) => ({
  holdingId: 'cash-1', sourceRefs: [{ collection: 'assets', id: 'cash-1' }],
  label: 'Joint savings', type: 'cash', ownerIds: ['primary', 'partner'], currency: 'EUR',
  valueCents: euros(200_000), valueConfirmed: true, identityConfirmed: true,
  ownershipShareBps: 10000, ownershipConfirmed: true,
  availableAmountCents: euros(150_000), availabilityConfirmed: true,
  availableWithin12Months: true, eligibilityConfirmed: true, manageableByAdviser: true,
  alreadyManagedByRecipient: false,
  deductions: [{ deductionId: 'reserve-1', kind: 'emergency_reserve', amountCents: euros(25_000), confirmed: true }],
  evidence: ['Consumer reviewed savings and availability on 17 October 2026.'], ...overrides
});
const assessment = (overrides = {}) => ({
  schemaVersion: 1, assessedAt: NOW, participatingOwnerIds: ['primary', 'partner'],
  consumerConfirmedAt: NOW, assetReviewComplete: true,
  adviser: { id: 'firm-one', name: 'Test Adviser', serviceFitConfirmed: true, minimumPfumCents: euros(50_000) },
  assets: [asset()], readiness: {
    introductionRequested: true, willingToMeet: true, meeting: { kind: 'adviser', status: 'confirmed' },
    decisionWithinSixMonths: true, specificDecisionConfirmed: true, contactVerified: true,
    profileReviewedAt: NOW
  },
  consent: { granted: true, purpose: 'adviser_introduction', sharedDataCategories: ['contact', 'asset_availability', 'qualification'], recipientId: 'firm-one', policyVersion: 'pilot-sharing-v1', capturedAt: NOW },
  ...overrides
});

{
  const result = evaluateLeadQualification(assessment());
  assert.equal(result.pfumCents, euros(150_000), 'availability caps the amount after reserves');
  assert.equal(result.positions[0].netAvailableCents, euros(175_000));
  assert.equal(result.readinessScore, 100);
  assert.equal(result.classification, 'priority');
  assert.equal(result.quote.feeCents, euros(305));
  assert.equal(result.probabilityOfConversion, null);
  assert.equal(result.billingEnabled, false);
  assert.deepEqual(result, evaluateLeadQualification(assessment()), 'identical evidence produces identical results');
  assert.equal(evaluateLeadQualification(assessment({ assets: [asset({ ownershipShareBps: 5000 })] })).pfumCents, euros(75_000), 'confirmed participating share, then owner-basis reserve');
  assert.equal(evaluateLeadQualification(assessment({ assets: [asset({ ownershipShareBps: 3333, valueCents: 101, deductions: [], availableAmountCents: 100 })] })).pfumCents, 33, 'fractional cents round down');
  assert.equal(evaluateLeadQualification(assessment({ assets: [asset({ deductions: [{ deductionId: 'all', kind: 'committed_spending', amountCents: euros(300_000), confirmed: true }] })] })).pfumCents, 0, 'oversized ring fence floors at zero');
  console.log('PASS: owned assets, reserves, available cap, joint holdings once, integer cents.');
}

{
  const rows = [[50_000,165,215],[100_000,235,305],[250_000,350,455],[500_000,500,650],[1_000_000,750,975]];
  assert.equal(priceLeadIntroduction(euros(50_000) - 1), null);
  for (const [index, [minimum, standard, priority]] of rows.entries()) {
    assert.equal(priceLeadIntroduction(euros(minimum)).feeCents, euros(standard));
    assert.equal(priceLeadIntroduction(euros(minimum), true).feeCents, euros(priority));
    if (index > 0) assert.equal(priceLeadIntroduction(euros(minimum) - 1).feeCents, euros(rows[index - 1][1]));
  }
  assert.throws(() => priceLeadIntroduction(NaN));
  assert.throws(() => priceLeadIntroduction(1.1));
  assert.throws(() => priceLeadIntroduction(-1));
  const allGates = Object.fromEntries(['introduction_requested', 'willing_to_meet', 'adviser_meeting_confirmed', 'contact_verified', 'asset_data_confirmed', 'adviser_service_fit', 'adviser_minimum_met', 'profile_current'].map((id) => [id, true]));
  assert.equal(isPriorityQualification(79, allGates), false);
  assert.equal(isPriorityQualification(80, allGates), true);
  for (const key of Object.keys(allGates)) assert.equal(isPriorityQualification(100, { ...allGates, [key]: false }), false, key);
  const boundary = assessment();
  boundary.readiness.specificDecisionConfirmed = false;
  boundary.readiness.profileReviewedAt = null;
  boundary.readiness.contactVerified = false;
  assert.equal(evaluateLeadQualification(boundary).readinessScore, 80);
  assert.equal(evaluateLeadQualification(boundary).classification, 'standard', 'missing mandatory contact cannot buy Priority');
  boundary.readiness.contactVerified = true;
  boundary.readiness.decisionWithinSixMonths = false;
  boundary.readiness.specificDecisionConfirmed = true;
  assert.equal(evaluateLeadQualification(boundary).readinessScore, 80);
  assert.equal(evaluateLeadQualification(boundary).classification, 'standard', 'an old or unreviewed profile cannot be Priority');
  boundary.readiness.profileReviewedAt = NOW;
  assert.equal(evaluateLeadQualification(boundary).readinessScore, 85);
  assert.equal(evaluateLeadQualification(boundary).classification, 'priority');
  console.log('PASS: all price-band edges, EUR 5 rounding, 79/80 threshold and mandatory Priority gates.');
}

{
  for (const changed of [
    { valueCents: null }, { valueConfirmed: false }, { identityConfirmed: false }, { currency: 'USD' },
    { ownershipShareBps: null }, { ownershipConfirmed: false }, { ownerIds: [] },
    { availableAmountCents: null }, { availabilityConfirmed: false }, { availableWithin12Months: null },
    { eligibilityConfirmed: false }, { manageableByAdviser: null }, { alreadyManagedByRecipient: null }, { evidence: [] },
    { deductions: [{ deductionId: 'unknown-reserve', kind: 'emergency_reserve', amountCents: null, confirmed: false }] },
    { type: 'other' }
  ]) {
    const result = evaluateLeadQualification(assessment({ assets: [asset(changed)] }));
    assert.equal(result.positions[0].status, 'unassessed', JSON.stringify(changed));
    assert.equal(result.quote, null);
    assert.equal(result.distributionEligible, false);
  }
  const second = asset({ holdingId: 'unknown', sourceRefs: [{ collection: 'assets', id: 'unknown' }], deductions: [], valueCents: null });
  const partial = evaluateLeadQualification(assessment({ assets: [asset(), second] }));
  assert.equal(partial.pfumCents, euros(150_000), 'show known subtotal without presenting it as complete');
  assert.equal(partial.quote, null, 'unassessed asset prevents even an apparently known band');
  for (const type of ['defined_benefit','state_pension','annuity_income','home','property','business','farm','future_inheritance','crypto','personal_possession','future_income','borrowing_capacity']) {
    const result = evaluateLeadQualification(assessment({ assets: [asset({ type })] }));
    assert.equal(result.pfumCents, 0, type);
    assert.equal(result.positions[0].status, 'excluded');
  }
  for (const type of ['prsa','personal_pension','buyout_bond','occupational_dc','investment','money_market','inheritance_received']) assert.equal(evaluateLeadQualification(assessment({ assets: [asset({ type })] })).pfumCents, euros(150_000));
  for (const patch of [{ alreadyManagedByRecipient: true }, { availableWithin12Months: false }, { manageableByAdviser: false }]) assert.equal(evaluateLeadQualification(assessment({ assets: [asset(patch)] })).positions[0].status, 'excluded');
  for (const patch of [{ alreadyManagedByRecipient: true, eligibilityConfirmed: false }, { availableWithin12Months: false, availabilityConfirmed: false }, { manageableByAdviser: false, evidence: [] }, { exclusionReason: 'Awaiting review', eligibilityConfirmed: false }]) assert.equal(evaluateLeadQualification(assessment({ assets: [asset(patch)] })).positions[0].status, 'unassessed', 'an unevidenced negative is not a reviewed exclusion');
  assert.equal(evaluateLeadQualification(assessment({ consumerConfirmedAt: '2026-10-18T10:00:00.000Z' })).quote, null);
  assert.equal(evaluateLeadQualification(assessment({ assetReviewComplete: false })).quote, null);
  console.log('PASS: unknowns remain unassessed and block prices; asset eligibility and future money exclusions.');
}

{
  assert.throws(() => evaluateLeadQualification(assessment({ assets: [asset(), asset()] })), /holding.*once/);
  assert.throws(() => evaluateLeadQualification(assessment({ assets: [asset(), asset({ holdingId: 'alias', deductions: [] })] })), /source holding/);
  assert.throws(() => evaluateLeadQualification(assessment({ assets: [asset(), asset({ holdingId: 'second', sourceRefs: [{ collection: 'assets', id: 'second' }] })] })), /deducted twice/);
  assert.throws(() => evaluateLeadQualification(assessment({ assets: [asset({ ownershipShareBps: 10001 })] })));
  assert.throws(() => evaluateLeadQualification(assessment({ assets: [asset({ valueCents: Infinity })] })));
  assert.throws(() => evaluateLeadQualification(assessment({ assets: [asset({ valueCents: -1 })] })));
  const proceeds = asset({ holdingId: 'sale', sourceRefs: [{ collection: 'manual', id: 'sale' }], type: 'property_proceeds', representsProceedsOf: { collection: 'properties', id: 'rental' }, deductions: [] });
  const property = asset({ holdingId: 'rental', sourceRefs: [{ collection: 'properties', id: 'rental' }], type: 'property', deductions: [] });
  assert.throws(() => evaluateLeadQualification(assessment({ assets: [property, proceeds] })), /original holding/);
  assert.throws(() => evaluateLeadQualification(assessment({ assets: [proceeds, { ...proceeds, holdingId: 'sale-2', sourceRefs: [{ collection: 'manual', id: 'sale-2' }] }] })), /proceeds.*twice/);
  assert.equal(evaluateLeadQualification(assessment({ assets: [proceeds] })).pfumCents, euros(150_000));
  console.log('PASS: holding, alias, proceeds and reserve duplicate protection, numeric validation.');
}

{
  const input = assessment();
  input.readiness.meeting.kind = 'education';
  assert.equal(evaluateLeadQualification(input).classification, 'standard');
  assert.equal(evaluateLeadQualification(input).components.find((entry) => entry.id === 'adviser_meeting_confirmed').points, 0);
  input.readiness.meeting = { kind: 'adviser', status: 'cancelled' };
  assert.equal(evaluateLeadQualification(input).classification, 'standard');
  input.distress = 'very worried'; input.retirementShortfall = 5_000_000; input.paidForEducationCall = true;
  assert.equal(evaluateLeadQualification(input).readinessScore, 90, 'worries, computed needs and paid calls are ignored');
  for (const consent of [{ granted: false }, { ...assessment().consent, recipientId: 'other' }, { ...assessment().consent, withdrawnAt: NOW }, { ...assessment().consent, purpose: 'education_call' }, { ...assessment().consent, sharedDataCategories: ['contact'] }]) {
    const result = evaluateLeadQualification(assessment({ consent }));
    assert.equal(result.quote, null);
    assert.equal(result.distributionEligible, false);
  }
  const unknownFit = assessment(); unknownFit.adviser.minimumPfumCents = null;
  assert.equal(evaluateLeadQualification(unknownFit).quote, null);
  const stale = assessment(); stale.readiness.profileReviewedAt = '2026-09-16T10:00:00.000Z';
  assert.equal(evaluateLeadQualification(stale).readinessScore, 95);
  assert.equal(evaluateLeadQualification(stale).classification, 'standard');
  const prefill = prefillQualificationAssets({ profile: { assets: [{ assetId: 'cash-1', type: 'cash', label: 'Savings', currentValue: { amount: 200_000, currency: 'EUR' }, ownerIds: ['primary'] }] }, nativeModuleInputs: { personal_balance_sheet: { currency: 'EUR', assetPositions: [{ source: 'assets', id: 'cash-1', bucket: 'spendable_reserves', amount: 200_000 }] } } });
  assert.equal(prefill.assets.length, 1, 'same canonical source appears once across sources');
  assert.equal(prefill.assets[0].availabilityConfirmed, false);
  assert.equal(prefill.requiresConsumerAvailabilityReview, true);
  const conflict = prefillQualificationAssets({ profile: { assets: [{ assetId: 'same', type: 'cash', label: 'Savings', currentValue: { amount: 20_000, currency: 'EUR' }, ownerIds: ['primary'] }], fieldMetadata: { '/assets/0/currentValue': { confirmedByUser: true } } }, nativeModuleInputs: { personal_balance_sheet: { assetPositions: [{ source: 'assets', id: 'same', amount: 30_000 }] } } });
  assert.equal(conflict.assets[0].valueCents, null, 'conflicting source values require fresh review');
  assert.equal(conflict.assets[0].valueConfirmed, false);
  assert.equal(conflict.warnings.length, 1);
  console.log('PASS: separate education and adviser intent, named-recipient consent, freshness and cautious prefill.');
}

{
  const priority = evaluateLeadQualification(assessment());
  const standard = { ...priority, classification: 'standard' };
  const ranked = rankLeadQualifications([
    { leadId: 5, requestedAt: '2026-10-12T10:00:00.000Z', result: standard },
    { leadId: 3, requestedAt: '2026-10-16T10:00:00.000Z', result: priority },
    { leadId: 2, requestedAt: '2026-10-15T10:00:00.000Z', result: priority },
    { leadId: 1, requestedAt: '2026-10-11T10:00:00.000Z', result: { ...priority, readinessScore: 85 } },
    { leadId: 4, requestedAt: '2026-10-10T10:00:00.000Z', result: { ...priority, distributionEligible: false } }
  ]);
  assert.deepEqual(ranked.map((entry) => entry.leadId), [2, 3, 1, 5]);
  assert.deepEqual(ranked.map((entry) => entry.rank), [1, 2, 3, 4]);
  console.log('PASS: eligible-only ranking, Priority first, readiness descending, oldest request first.');
}

// Real SQLite + the actual encrypted repository boundary, without calling a provider.
const sql = new DatabaseSync(':memory:');
sql.exec("PRAGMA foreign_keys = ON; CREATE TABLE leads (id INTEGER PRIMARY KEY, full_name TEXT, created_at TEXT); INSERT INTO leads VALUES (1, 'First Lead', '2026-10-15T10:00:00.000Z'); INSERT INTO leads VALUES (2, 'Second Lead', '2026-10-16T10:00:00.000Z');");
sql.exec(readFileSync(new URL('../worker/migrations/0022_lead_qualification.sql', import.meta.url), 'utf8'));
class Statement {
  constructor(query, bindings = []) { this.query = query; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.query, bindings); }
  async first() { return sql.prepare(this.query).get(...this.bindings) || null; }
  async all() { return { results: sql.prepare(this.query).all(...this.bindings) }; }
  async run() { return sql.prepare(this.query).run(...this.bindings); }
}
const env = { LEADS_DB: { prepare: (query) => new Statement(query) }, APPLICATION_DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64url') };
const hooks = { requireAdmin: async (csrf) => ({ session: { authEnabled: true, authenticated: true }, csrf }), now: () => NOW };
const call = async (path, body, overrides = {}) => {
  const response = await handleQualificationRequest(new Request(`https://example.com${path}`, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) }), env, { ...hooks, ...overrides });
  return { status: response?.status, body: response ? await response.json() : null };
};
try {
  assert.equal((await call('/not-the-route')).status, undefined);
  assert.equal((await call('/api/advisor/leads/1/qualification', undefined, { requireAdmin: undefined })).status, 401);
  assert.equal((await call('/api/advisor/leads/1/qualification', undefined, { requireAdmin: async () => ({ session: { authEnabled: false, authenticated: false } }) })).status, 401);
  assert.equal((await call('/api/advisor/leads/1/qualification', {}, { requireAdmin: async () => ({ response: new Response('{"error":"CSRF"}', { status: 403 }) }) })).status, 403);
  assert.equal((await call('/api/advisor/leads/99/qualification')).status, 404);
  assert.equal((await call('/api/advisor/leads/1/qualification')).body.assessment, null);
  let csrfRequired = false;
  const body = { assessmentId: 'assessment_test_0001', assessment: assessment() };
  body.assessment.assessedAt = '2099-01-01T00:00:00.000Z';
  body.assessment.pfumCents = euros(10_000_000); body.assessment.readinessScore = 1;
  const saved = await call('/api/advisor/leads/1/qualification', body, { requireAdmin: async (csrf) => { csrfRequired = csrf; return { session: { authEnabled: true, authenticated: true } }; } });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(csrfRequired, true);
  assert.equal(saved.body.assessment.input.assessedAt, NOW, 'server owns the clock');
  assert.equal(saved.body.assessment.result.pfumCents, euros(150_000));
  assert.equal(saved.body.assessment.result.readinessScore, 100, 'client-supplied score ignored');
  const stored = sql.prepare('SELECT * FROM lead_qualification_assessments').get();
  assert.doesNotMatch(stored.payload_encrypted, /Joint savings|15000000|firm-one/);
  assert.equal((await call('/api/advisor/leads/1/qualification', body)).status, 200, 'retry is idempotent');
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM lead_qualification_assessments').get().n, 1);
  const changed = structuredClone(body); changed.assessment.assets[0].valueCents += 1;
  assert.equal((await call('/api/advisor/leads/1/qualification', changed)).status, 409);
  assert.equal((await call('/api/advisor/leads/2/qualification', body)).status, 409, 'cannot replay an id under another lead');
  const outcome = { eventId: 'outcome_test_0001', assessmentId: body.assessmentId, event: 'funds_transferred', occurredAt: NOW, amountCents: euros(100_000), notes: 'Pilot outcome fixture' };
  assert.equal((await call('/api/advisor/leads/1/qualification/outcomes', outcome)).status, 201);
  assert.equal((await call('/api/advisor/leads/1/qualification/outcomes', outcome)).status, 200);
  assert.equal((await call('/api/advisor/leads/2/qualification/outcomes', outcome)).status, 404);
  assert.equal((await call('/api/advisor/leads/1/qualification/outcomes', { ...outcome, eventId: 'bad_event_0001', amountCents: -1 })).status, 400);
  assert.equal((await call('/api/advisor/leads/1/qualification/outcomes', { ...outcome, eventId: 'bad_event_0002', occurredAt: '2030-01-01T00:00:00.000Z' })).status, 400);
  const loaded = await call('/api/advisor/leads/1/qualification');
  assert.equal(loaded.body.assessment.result.quote.feeCents, euros(305));
  assert.equal(loaded.body.outcomes[0].amountCents, euros(100_000));
  assert.doesNotMatch(sql.prepare('SELECT payload_encrypted FROM lead_qualification_outcomes').get().payload_encrypted, /Pilot outcome fixture/);
  const unavailable = await handleQualificationRequest(new Request('https://example.com/api/advisor/leads/2/qualification', { method: 'POST', body: JSON.stringify({ assessment: assessment() }) }), { LEADS_DB: env.LEADS_DB }, hooks);
  assert.equal(unavailable.status, 503, 'missing encryption never falls back to plaintext');
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM lead_qualification_assessments').get().n, 1);
  assert.equal((await call('/api/advisor/qualification/ranking', undefined, { requireAdmin: undefined })).status, 401);
  const ranked = await call('/api/advisor/qualification/ranking');
  assert.equal(ranked.status, 200, JSON.stringify(ranked.body));
  assert.equal(ranked.body.ranked[0].leadId, 1);
  assert.equal(ranked.body.ranked[0].classification, 'priority');
  assert.equal(ranked.body.ranked[0].rank, 1);
  assert.equal(Object.hasOwn(ranked.body.ranked[0], 'input'), false, 'the ranking response does not disclose the full asset ledger');
  const laterRanking = await call('/api/advisor/qualification/ranking', undefined, { now: () => '2026-11-17T10:00:00.000Z' });
  assert.equal(laterRanking.body.ranked[0].classification, 'standard', 'current ranking re-evaluates old snapshots');
  assert.equal(laterRanking.body.ranked[0].quote.feeCents, euros(235));
  const incomplete = assessment({ assetReviewComplete: false });
  assert.equal((await call('/api/advisor/leads/2/qualification', { assessment: incomplete })).status, 201);
  const filteredRanking = await call('/api/advisor/qualification/ranking');
  assert.deepEqual(filteredRanking.body.counts, { assessed: 2, eligible: 1, needsReview: 1 });
  assert.equal(filteredRanking.body.ranked.length, 1);
  const withdrawn = assessment(); withdrawn.consent.granted = false;
  assert.equal((await call('/api/advisor/leads/1/qualification', { assessmentId: 'a_latest_0001', assessment: withdrawn })).status, 201);
  const latestOnly = await call('/api/advisor/qualification/ranking');
  assert.deepEqual(latestOnly.body.counts, { assessed: 2, eligible: 0, needsReview: 2 }, 'only the newest saved snapshot counts, even within the same clock millisecond');
  assert.equal((await call('/api/advisor/leads/1/qualification')).body.assessment.id, 'a_latest_0001');
  sql.prepare('INSERT INTO leads (id,full_name,created_at) VALUES (?,?,?)').run(3, 'Earlier introduction', '2026-10-16T10:00:00.000Z');
  sql.prepare('INSERT INTO leads (id,full_name,created_at) VALUES (?,?,?)').run(4, 'Old education call, new introduction', '2026-10-01T10:00:00.000Z');
  const earlierIntroduction = assessment(); earlierIntroduction.consent.capturedAt = '2026-10-16T10:00:00.000Z';
  assert.equal((await call('/api/advisor/leads/3/qualification', { assessment: earlierIntroduction })).status, 201);
  assert.equal((await call('/api/advisor/leads/4/qualification', { assessment: assessment() })).status, 201);
  const actualRequestOrder = await call('/api/advisor/qualification/ranking');
  assert.deepEqual(actualRequestOrder.body.ranked.map((entry) => entry.leadId), [3, 4], 'an older educational call does not advance a recent adviser-introduction request');
  assert.equal(actualRequestOrder.body.ranked[1].requestedAt, NOW);
  assert.equal(actualRequestOrder.body.ranked[1].leadCreatedAt, '2026-10-01T10:00:00.000Z');
  sql.prepare('DELETE FROM leads WHERE id=1').run();
  sql.prepare('DELETE FROM leads WHERE id=2').run();
  sql.prepare('DELETE FROM leads WHERE id=3').run();
  sql.prepare('DELETE FROM leads WHERE id=4').run();
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM lead_qualification_assessments').get().n, 0);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM lead_qualification_outcomes').get().n, 0);
  console.log('PASS: protected API, CSRF delegation, immutable encrypted snapshots, retries, outcome tracking and deletion cascade.');
} finally { sql.close(); }
console.log('All lead qualification checks passed.');
