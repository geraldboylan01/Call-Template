import { badRequest } from './errors.js';
import {
  applyProfilePatch as applyCanonicalProfilePatch,
  normalizeHouseholdProfile
} from '../../../js/planning/profile.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Identifiers that have no business in a postal address.
 *
 * Drawn from `redactSensitiveIdentifiers` but WITHOUT its address-phrase
 * patterns, which exist to catch an address hiding in narrative text and would
 * reject legitimate input here. An Irish Eircode ("D02 AF30") matches none of
 * these: the IBAN-style pattern needs two leading letters before its digits.
 */
const ADDRESS_PROHIBITED_PATTERNS = Object.freeze([
  // PPS number.
  /\b\d{7}[A-Z]{1,2}\b/i,
  // IBAN-style account identifier.
  /\b[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]{4}){2,7}(?:[\s-]?[A-Z0-9]{1,3})?\b/i,
  // A labelled account or card number.
  /\b(?:account|card)\s*(?:number|no\.?|is|:)?\s*(?:\d[\s-]*){6,24}\b/i,
  // A credential the client should never be typing into a form like this.
  /\b(?:password|passcode|pin|credential)\s*(?:is|:)?\s*[A-Za-z0-9_-]{6,80}\b/i,
  // A bare card-length digit run.
  /\b(?:\d[\s-]*?){13,19}\b/
]);
const ID_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;
const ROOT_PATHS = new Set([
  'primaryPerson', 'partner', 'dependants', 'assets', 'liabilities', 'incomeSources',
  'expenses', 'pensions', 'properties', 'businesses', 'goals', 'preferences', 'assumptions'
]);
const PROHIBITED_SEGMENT = /(?:pps|password|passcode|credential|accountnumber|iban|swift|document|passport|drivinglicen[cs]e|exactaddress)/i;

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, label, maxLength, required = true) {
  const result = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
  if (required && !result) throw badRequest(`${label} is required.`);
  if (result.length > maxLength) throw badRequest(`${label} is too long.`);
  return result;
}

export function validateCreateSessionBody(body, expectedManifest) {
  if (!plainObject(body) || !plainObject(body.consent)) throw badRequest('Consent is required to start.');
  const consent = body.consent;
  const manifest = typeof expectedManifest === 'string'
    ? { policyVersion: expectedManifest }
    : (plainObject(expectedManifest) ? expectedManifest : {});
  const policyVersion = cleanText(consent.policyVersion, 'Consent policy version', 80);
  const manifestId = cleanText(consent.manifestId, 'Consent manifest id', 120);
  const analysisNoticeId = cleanText(consent.analysisNoticeId, 'Analysis notice id', 120);
  const aiNoticeId = cleanText(consent.aiNoticeId, 'AI notice id', 120);
  const privacyNoticeUrl = cleanText(consent.privacyNoticeUrl, 'Privacy notice URL', 500);
  if (manifestId !== manifest.manifestId
    || policyVersion !== manifest.policyVersion
    || analysisNoticeId !== manifest.analysisNoticeId
    || aiNoticeId !== manifest.aiNoticeId
    || privacyNoticeUrl !== manifest.privacyNoticeUrl) {
    throw badRequest('The planning disclosure is no longer current. Reload before starting.', 'consent_policy_outdated');
  }
  if (consent.analysis !== true) throw badRequest('Analysis consent is required.', 'analysis_consent_required');
  if (consent.adultConfirmed !== true) throw badRequest('You must confirm that you are 18 or older.', 'adult_confirmation_required');
  if (consent.educationOnlyAcknowledged !== true) {
    throw badRequest('You must acknowledge that this is financial education, not financial advice.', 'education_only_acknowledgement_required');
  }
  if (typeof consent.aiProcessing !== 'boolean') throw badRequest('AI processing preference must be confirmed.');
  return {
    analysis: true,
    aiProcessing: consent.aiProcessing,
    adultConfirmed: true,
    educationOnlyAcknowledged: true,
    policyVersion,
    manifestId,
    analysisNoticeId,
    aiNoticeId,
    privacyNoticeUrl
  };
}

export function validateTurnBody(body, maxMessageLength) {
  if (!plainObject(body)) throw badRequest('Request body must be an object.');
  const message = redactSensitiveIdentifiers(cleanText(body.message, 'Message', maxMessageLength));
  const idempotencyKey = cleanText(body.idempotencyKey, 'Idempotency key', 120);
  if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) throw badRequest('Idempotency key is invalid.');
  return { message, idempotencyKey };
}

function decodePointerSegment(segment) {
  if (/~(?:[^01]|$)/.test(segment)) throw badRequest('Profile path is invalid.');
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function validateProfilePath(path) {
  if (typeof path !== 'string' || path.length > 240 || !path.startsWith('/')) throw badRequest('Profile path is invalid.');
  const segments = path.slice(1).split('/').map(decodePointerSegment);
  if (!segments.length || segments.length > 8 || !ROOT_PATHS.has(segments[0])) throw badRequest(`Profile path is not allowed: ${path}`);
  for (const segment of segments) {
    if (!segment || segment === '__proto__' || segment === 'prototype' || segment === 'constructor' || PROHIBITED_SEGMENT.test(segment)) {
      throw badRequest(`Profile path is not allowed: ${path}`);
    }
  }
  return segments;
}

export function validateProfilePatchValue(value, depth = 0) {
  if (depth > 6) throw badRequest('Profile value is too deeply nested.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) throw badRequest('Profile number is outside the allowed range.');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 2_000) throw badRequest('Profile text is too long.');
    if (redactSensitiveIdentifiers(value) !== value) throw badRequest('Profile text contains a prohibited sensitive identifier.');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw badRequest('Profile list is too long.');
    value.forEach((item) => validateProfilePatchValue(item, depth + 1));
    return;
  }
  if (plainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > 100) throw badRequest('Profile object has too many fields.');
    for (const [key, item] of entries) {
      if (!key || key.length > 80 || key === '__proto__' || key === 'prototype' || key === 'constructor' || PROHIBITED_SEGMENT.test(key)) {
        throw badRequest('Profile object contains a prohibited field.');
      }
      validateProfilePatchValue(item, depth + 1);
    }
    return;
  }
  throw badRequest('Profile value type is not supported.');
}

export function redactSensitiveIdentifiers(value) {
  return String(value || '')
    .replace(/\b(?:i\s+live\s+at|i\s+reside\s+at|my\s+(?:home\s+)?address\s*(?:is|:))\s+[^,;\n]{5,160}(?=$|[,;\n])/gi, '[redacted identifier]')
    .replace(/\b(?:home\s+|exact\s+)?address\s*(?:is|:)\s*[^,;\n]{5,160}(?=$|[,;\n])/gi, 'address [redacted identifier]')
    .replace(/\b[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]{4}){2,7}(?:[\s-]?[A-Z0-9]{1,3})?\b/gi, '[redacted identifier]')
    .replace(/\b\d{7}[A-Z]{1,2}\b/gi, '[redacted identifier]')
    .replace(/\b(account|card)\s*(?:number|no\.?|is|:)?\s*(?:\d[\s-]*){6,24}\b/gi, '$1 [redacted identifier]')
    .replace(/\b(password|passcode|pin|credential)\s*(?:is|:)?\s*[A-Za-z0-9_-]{6,80}\b/gi, '$1 [redacted identifier]')
    .replace(/\b(?:\d[\s-]*?){13,19}\b/g, '[redacted identifier]')
    .slice(0, 12_000);
}

export function validateProfilePatchBody(body) {
  if (!plainObject(body)) throw badRequest('Profile patch must be an object.');
  const rawPatch = body.patch === undefined ? {} : body.patch;
  if (!plainObject(rawPatch)) throw badRequest('Profile patch must be an object.');
  const entries = Object.entries(rawPatch);
  const removePaths = validateRemovePaths(body.removePaths || []);
  if (entries.length + removePaths.length < 1 || entries.length + removePaths.length > 50) {
    throw badRequest('Profile update must contain between 1 and 50 changes.');
  }
  const patch = {};
  for (const [path, value] of entries) {
    validateProfilePath(path);
    validateProfilePatchValue(value);
    patch[path] = value;
  }
  const confirmedPaths = validateConfirmedPaths(body.confirmedPaths || []);
  return { patch, removePaths, confirmedPaths, expectedRevision: validateExpectedRevision(body.expectedRevision) };
}

function validateExpectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw badRequest('Expected profile revision is required.', 'profile_revision_required');
  }
  return value;
}

function validateRemovePaths(value) {
  if (!Array.isArray(value) || value.length > 50) throw badRequest('Remove paths must be a list.');
  const collectionRoots = new Set([
    'dependants', 'assets', 'liabilities', 'incomeSources', 'pensions',
    'properties', 'businesses', 'goals'
  ]);
  return value.map((path) => {
    const segments = validateProfilePath(path);
    const removableCollectionItem = segments.length === 2
      && collectionRoots.has(segments[0])
      && /^\d+$/.test(segments[1]);
    const removablePartner = segments.length === 1 && segments[0] === 'partner';
    if (!removableCollectionItem && !removablePartner) {
      throw badRequest(`Profile item cannot be removed: ${path}`, 'profile_remove_not_allowed');
    }
    return path;
  }).filter((path, index, paths) => paths.indexOf(path) === index);
}

export function validateConfirmedPaths(value) {
  if (!Array.isArray(value) || value.length > 100) throw badRequest('Confirmed paths must be a list.');
  return value.map((path) => {
    validateProfilePath(path);
    return path;
  }).filter((path, index, paths) => paths.indexOf(path) === index);
}

export function validateConfirmBody(body) {
  if (!plainObject(body)) throw badRequest('Confirmation body must be an object.');
  return {
    confirmedPaths: validateConfirmedPaths(body.confirmedPaths || []),
    expectedRevision: validateExpectedRevision(body.expectedRevision)
  };
}

export function validateConsentBody(body) {
  if (!plainObject(body) || body.aiProcessing !== false) {
    throw badRequest('AI processing can only be withdrawn for the current session.', 'invalid_consent_update');
  }
  return { aiProcessing: false };
}

export function validateVoiceConsentBody(body, expected) {
  if (!plainObject(body) || typeof body.granted !== 'boolean') {
    throw badRequest('Voice consent must be explicitly granted or withdrawn.', 'invalid_voice_consent');
  }
  const noticeId = cleanText(body.noticeId, 'Voice notice id', 120);
  const policyVersion = cleanText(body.policyVersion, 'Voice policy version', 120);
  const privacyNoticeUrl = cleanText(body.privacyNoticeUrl, 'Voice privacy notice URL', 500);
  if (body.granted && (noticeId !== expected.noticeId
    || policyVersion !== expected.policyVersion
    || privacyNoticeUrl !== expected.privacyNoticeUrl)) {
    throw badRequest('The voice disclosure is no longer current. Reload before continuing.', 'voice_policy_outdated');
  }
  return { granted: body.granted, noticeId, policyVersion, privacyNoticeUrl };
}

export function validateRealtimeConsentBody(body, expected) {
  if (!plainObject(body) || typeof body.granted !== 'boolean') {
    throw badRequest('Live voice consent must be explicitly granted or withdrawn.', 'invalid_realtime_consent');
  }
  const noticeId = cleanText(body.noticeId, 'Live voice notice id', 120);
  const policyVersion = cleanText(body.policyVersion, 'Live voice policy version', 120);
  const privacyNoticeUrl = cleanText(body.privacyNoticeUrl, 'Live voice privacy notice URL', 500);
  if (body.granted && (noticeId !== expected.noticeId
    || policyVersion !== expected.policyVersion
    || privacyNoticeUrl !== expected.privacyNoticeUrl)) {
    throw badRequest('The live voice disclosure is no longer current. Reload before continuing.', 'realtime_policy_outdated');
  }
  return { granted: body.granted, noticeId, policyVersion, privacyNoticeUrl };
}

export function validateVoiceSpeechBody(body) {
  if (!plainObject(body)) throw badRequest('Voice speech request must be an object.');
  const idempotencyKey = cleanText(body.idempotencyKey, 'Voice request id', 120);
  if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw badRequest('Voice request id is invalid.', 'voice_idempotency_key_invalid');
  }
  if (Object.keys(body).some((key) => key !== 'idempotencyKey')) {
    throw badRequest('The spoken question is selected by the planning service.', 'voice_speech_text_not_allowed');
  }
  return { idempotencyKey };
}

export function validateAnalysisBody(body, allowedModules) {
  const value = body === undefined || body === null ? {} : body;
  if (!plainObject(value)) throw badRequest('Analysis body must be an object.');
  const requested = value.moduleIds === undefined ? undefined : value.moduleIds;
  if (requested !== undefined && (!Array.isArray(requested) || requested.length > 3)) throw badRequest('Module ids must contain no more than three entries.');
  const moduleIds = requested?.map((item) => cleanText(item, 'Module id', 80)) || undefined;
  if (moduleIds?.some((id) => !ID_PATTERN.test(id) || !allowedModules.includes(id))) {
    throw badRequest('One or more requested modules are not available.', 'module_not_available');
  }
  const scenarioOverrides = value.scenarioOverrides === undefined ? {} : value.scenarioOverrides;
  validateProfilePatchValue(scenarioOverrides);
  return { moduleIds, scenarioOverrides };
}

export function validateRealtimeAnalysisPlanBody(body, allowedModules) {
  if (!plainObject(body)) throw badRequest('Analysis plan body must be an object.');
  const idempotencyKey = cleanText(body.idempotencyKey, 'Analysis plan request id', 120);
  if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw badRequest('Analysis plan request id is invalid.', 'analysis_plan_idempotency_key_invalid');
  }
  const expectedRevision = validateExpectedRevision(body.expectedRevision);
  const action = body.action === undefined ? 'prepare' : cleanText(body.action, 'Analysis plan action', 40);
  if (!['prepare', 'confirm_and_run'].includes(action)) {
    throw badRequest('Analysis plan action is invalid.', 'analysis_plan_action_invalid');
  }
  if (action === 'confirm_and_run' && body.confirmation !== true) {
    throw badRequest('Explicit confirmation is required before running the analysis plan.', 'analysis_plan_confirmation_required');
  }
  const analysis = action === 'prepare'
    ? validateAnalysisBody({
        scenarioOverrides: body.scenarioOverrides
      }, allowedModules)
    : { moduleIds: undefined, scenarioOverrides: {} };
  const leaseId = body.leaseId === undefined || body.leaseId === null
    ? null
    : cleanText(body.leaseId, 'Realtime lease id', 100);
  if (leaseId && !/^rt_[A-Za-z0-9_-]{20,80}$/.test(leaseId)) {
    throw badRequest('Realtime lease id is invalid.', 'realtime_lease_invalid');
  }
  const planId = action === 'confirm_and_run'
    ? cleanText(body.planId, 'Analysis plan id', 100)
    : null;
  const planNonce = action === 'confirm_and_run'
    ? cleanText(body.planNonce, 'Analysis confirmation nonce', 160)
    : null;
  if (planId && !/^realtime_plan_[A-Za-z0-9_-]{20,80}$/.test(planId)) {
    throw badRequest('Analysis plan id is invalid.', 'analysis_plan_id_invalid');
  }
  if (planNonce && !/^plan_nonce_[A-Za-z0-9_-]{40,100}$/.test(planNonce)) {
    throw badRequest('Analysis confirmation nonce is invalid.', 'analysis_plan_nonce_invalid');
  }
  return {
    idempotencyKey,
    expectedRevision,
    action,
    confirmed: action === 'confirm_and_run',
    confirmation: body.confirmation === true,
    planId,
    planNonce,
    leaseId,
    ...analysis
  };
}

/**
 * The sign-up a client completes to open their own finished analysis.
 *
 * WHY THERE IS NO CONSENT GATE HERE, unlike `validateHandoffBody`.
 *
 * This first demanded `consent: true` plus a policy version and URL matching
 * `config.handoffPolicyVersion` / `handoffPolicyUrl`. That was wrong twice over.
 *
 * It was a bug: those values come from CONSUMER_HANDOFF_POLICY_VERSION and
 * _URL, which are only set when handoff is configured. Wherever handoff is not
 * configured they are empty, the match fails for everyone, and NOBODY can open
 * their analysis — the feature is dead on arrival.
 *
 * And it was disproportionate. A handoff SENDS the client's analysis to the
 * adviser, which is why it demands an explicit, versioned act. This form is the
 * client asking for their own results; the pipeline entry is a side effect of
 * details they are deliberately typing in. Saying plainly in the form what
 * happens to them is the honest and sufficient answer, and the form does that.
 *
 * `clients.full_name` is NOT NULL and the lead insert throws without an email,
 * so those two are required. The publish bundle is not validated here: it is
 * already-encrypted ciphertext the Worker cannot read, and the publish handler
 * owns its schema.
 */
export function validatePublishedAnalysisSignupBody(body) {
  if (!plainObject(body)) throw badRequest('Sign-up body must be an object.');

  const firstName = cleanText(body.firstName, 'First name', 80);
  const lastName = cleanText(body.lastName, 'Last name', 80);
  const email = cleanText(body.email, 'Email', 160).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw badRequest('Email is invalid.');
  const address = cleanText(body.address, 'Address', 400);

  // NOT `redactSensitiveIdentifiers` here, deliberately.
  //
  // That helper exists to stop an address leaking through a NARRATIVE field —
  // several of its patterns match "I live at ...", "address is: ..." and similar.
  // Running it over a field whose entire purpose is the address would reject
  // ordinary input, and its intent does not apply: this address is collected
  // deliberately, with explicit consent, to create the client record.
  //
  // What must still never appear is an identifier that has nothing to do with a
  // postal address, so those patterns are checked directly. Rejected rather than
  // silently stripped, so the client can see and correct what they typed.
  if (ADDRESS_PROHIBITED_PATTERNS.some((pattern) => pattern.test(address))) {
    throw badRequest('Address must not contain a PPS number, card or account number, or password. Remove it before continuing.', 'published_analysis_sensitive_data_prohibited');
  }

  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    email,
    address
  };
}

export function validateHandoffBody(body, expectedPolicy) {
  if (!plainObject(body)) throw badRequest('Handoff body must be an object.');
  if (body.consent !== true) throw badRequest('Explicit adviser handoff consent is required.', 'handoff_consent_required');
  const expectedPolicyVersion = typeof expectedPolicy === 'string'
    ? expectedPolicy
    : cleanText(expectedPolicy?.version, 'Configured handoff policy version', 80, false);
  const expectedPolicyUrl = typeof expectedPolicy === 'string'
    ? ''
    : cleanText(expectedPolicy?.url, 'Configured handoff policy URL', 500, false);
  const policyVersion = cleanText(body.policyVersion, 'Handoff policy version', 80);
  const policyUrl = cleanText(body.policyUrl, 'Handoff policy URL', 500);
  if (!expectedPolicyVersion || !expectedPolicyUrl
    || policyVersion !== expectedPolicyVersion
    || policyUrl !== expectedPolicyUrl) {
    throw badRequest('The adviser handoff disclosure is no longer current.', 'handoff_policy_outdated');
  }
  const expectedRevision = validateExpectedRevision(body.expectedRevision);
  if (body.retry === true) {
    return { consent: true, policyVersion, policyUrl, expectedRevision, retry: true };
  }
  const fullName = cleanText(body.fullName, 'Full name', 160);
  const email = cleanText(body.email, 'Email', 160).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw badRequest('Email is invalid.');
  const phone = cleanText(body.phone, 'Phone', 40, false);
  const rawRequestedHelp = cleanText(body.requestedHelp, 'Requested help', 2_000);
  const requestedHelp = redactSensitiveIdentifiers(rawRequestedHelp);
  if (requestedHelp !== rawRequestedHelp) {
    throw badRequest('Requested help contains a prohibited sensitive identifier. Remove it before sharing with an adviser.', 'handoff_sensitive_data_prohibited');
  }
  return { fullName, email, phone, requestedHelp, consent: true, policyVersion, policyUrl, expectedRevision };
}

export function applyProfilePatch(profile, patch, confirmedPaths, source = 'consumer_edit', removePaths = []) {
  const timestamp = new Date().toISOString();
  const canonical = normalizeHouseholdProfile(profile);
  const operations = Object.entries(patch).map(([path, value]) => {
    const segments = validateProfilePath(path);
    let cursor = canonical;
    let exists = true;
    for (const segment of segments) {
      if (Array.isArray(cursor)) {
        if (!/^\d+$/.test(segment) || Number(segment) >= cursor.length) {
          exists = false;
          break;
        }
        cursor = cursor[Number(segment)];
      } else if (cursor && typeof cursor === 'object' && Object.hasOwn(cursor, segment)) {
        cursor = cursor[segment];
      } else {
        exists = false;
        break;
      }
    }
    const confirmed = confirmedPaths.includes(path);
    return {
      op: exists ? 'replace' : 'add',
      path,
      value,
      provenance: {
        source: confirmed ? 'user_confirmation' : 'user_statement',
        confidence: confirmed ? 'high' : (source === 'ai_extraction' ? 'low' : 'high'),
        certainty: source === 'ai_extraction' ? 'inferred' : 'exact',
        capturedAt: timestamp,
        confirmedByUser: confirmed
      }
    };
  });
  for (const path of removePaths) {
    validateRemovePaths([path]);
    operations.push({
      op: 'remove',
      path,
      provenance: {
        source: 'user_confirmation',
        confidence: 'high',
        certainty: 'exact',
        capturedAt: timestamp,
        confirmedByUser: true
      }
    });
  }
  let next;
  try {
    next = applyCanonicalProfilePatch(canonical, { operations }, { nowIso: timestamp }).profile;
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'Profile patch is invalid.', 'invalid_profile_patch');
  }
  for (const path of confirmedPaths) {
    if (!next.fieldMetadata[path]) continue;
    next.fieldMetadata[path] = {
      ...next.fieldMetadata[path],
      source: 'user_confirmation',
      confidence: 'high',
      confirmedByUser: true,
      capturedAt: timestamp
    };
  }
  return normalizeHouseholdProfile(next);
}
