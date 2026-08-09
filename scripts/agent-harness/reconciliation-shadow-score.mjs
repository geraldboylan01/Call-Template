/**
 * Deterministic offline scoring for an archived reconciliation shadow plan.
 *
 * This module never calls a model and never reads a persona. Targeted recall
 * comes only from an optional, frozen, call-scoped expectation fixture, so a
 * fact absent from one transcript cannot become a target merely because it was
 * present in the underlying client brief.
 */

const FIELD_PREDICATE_KEYS = Object.freeze(['equals', 'in', 'prefix']);
const MATCHER_KEYS = new Set([
  'op', 'factId', 'factInstanceId', 'noteKind', 'reasonCode', 'value'
]);
const VALUE_PREDICATE_KEYS = new Set([
  'equals', 'in', 'containsText', 'containsNumber', 'path', 'anyOf'
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${fieldName} must be a non-empty string.`);
  return value.trim();
}

function uniqueStrings(value, fieldName) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${fieldName} must be a non-empty array.`);
  return [...new Set(value.map((item, index) => nonEmptyString(item, `${fieldName}[${index}]`)))];
}

function assertOnlyKeys(value, allowed, fieldName) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${fieldName}.${key} is not supported.`);
  }
}

function normalizeFieldPredicate(raw, fieldName) {
  if (!isPlainObject(raw)) throw new Error(`${fieldName} must be a predicate object.`);
  assertOnlyKeys(raw, new Set(FIELD_PREDICATE_KEYS), fieldName);
  const present = FIELD_PREDICATE_KEYS.filter((key) => Object.hasOwn(raw, key));
  if (present.length !== 1) throw new Error(`${fieldName} must contain exactly one predicate.`);
  if (Object.hasOwn(raw, 'equals')) return { equals: nonEmptyString(raw.equals, `${fieldName}.equals`) };
  if (Object.hasOwn(raw, 'prefix')) return { prefix: nonEmptyString(raw.prefix, `${fieldName}.prefix`) };
  return { in: uniqueStrings(raw.in, `${fieldName}.in`) };
}

function normalizeValuePredicate(raw, fieldName) {
  if (!isPlainObject(raw)) throw new Error(`${fieldName} must be a value predicate object.`);
  assertOnlyKeys(raw, VALUE_PREDICATE_KEYS, fieldName);
  const normalized = {};
  if (Object.hasOwn(raw, 'path')) normalized.path = nonEmptyString(raw.path, `${fieldName}.path`);
  if (Object.hasOwn(raw, 'equals')) normalized.equals = structuredClone(raw.equals);
  if (Object.hasOwn(raw, 'in')) {
    if (!Array.isArray(raw.in) || raw.in.length === 0) throw new Error(`${fieldName}.in must be non-empty.`);
    normalized.in = structuredClone(raw.in);
  }
  if (Object.hasOwn(raw, 'containsText')) {
    normalized.containsText = nonEmptyString(raw.containsText, `${fieldName}.containsText`);
  }
  if (Object.hasOwn(raw, 'containsNumber')) {
    const number = Number(raw.containsNumber);
    if (!Number.isFinite(number)) throw new Error(`${fieldName}.containsNumber must be finite.`);
    normalized.containsNumber = number;
  }
  if (Object.hasOwn(raw, 'anyOf')) {
    if (!Array.isArray(raw.anyOf) || raw.anyOf.length === 0) throw new Error(`${fieldName}.anyOf must be non-empty.`);
    normalized.anyOf = raw.anyOf.map((item, index) => (
      normalizeValuePredicate(item, `${fieldName}.anyOf[${index}]`)
    ));
  }
  const tests = ['equals', 'in', 'containsText', 'containsNumber', 'anyOf']
    .filter((key) => Object.hasOwn(normalized, key));
  if (tests.length !== 1) throw new Error(`${fieldName} must contain exactly one value test.`);
  return normalized;
}

function normalizeMatcher(raw, fieldName) {
  if (!isPlainObject(raw)) throw new Error(`${fieldName} must be an object.`);
  assertOnlyKeys(raw, MATCHER_KEYS, fieldName);
  if (Object.keys(raw).length === 0) throw new Error(`${fieldName} must contain at least one predicate.`);
  const matcher = {};
  for (const key of ['op', 'factId', 'factInstanceId', 'noteKind', 'reasonCode']) {
    if (Object.hasOwn(raw, key)) matcher[key] = normalizeFieldPredicate(raw[key], `${fieldName}.${key}`);
  }
  if (Object.hasOwn(raw, 'value')) matcher.value = normalizeValuePredicate(raw.value, `${fieldName}.value`);
  return matcher;
}

/** Validate and freeze the small ignored expectation schema. */
export function normalizeShadowExpectations(raw) {
  if (!isPlainObject(raw)) throw new Error('Shadow expectations must be an object.');
  assertOnlyKeys(raw, new Set(['schemaVersion', 'fixtureId', 'expectations']), 'ShadowExpectationsV1');
  if (raw.schemaVersion !== 1) throw new Error('ShadowExpectationsV1.schemaVersion must be 1.');
  if (!Array.isArray(raw.expectations)) throw new Error('ShadowExpectationsV1.expectations must be an array.');
  const ids = new Set();
  const expectations = raw.expectations.map((item, index) => {
    const fieldName = `ShadowExpectationsV1.expectations[${index}]`;
    if (!isPlainObject(item)) throw new Error(`${fieldName} must be an object.`);
    assertOnlyKeys(item, new Set(['expectationId', 'description', 'appliesTo', 'matchAny']), fieldName);
    const expectationId = nonEmptyString(item.expectationId, `${fieldName}.expectationId`);
    if (ids.has(expectationId)) throw new Error(`Duplicate shadow expectation ${expectationId}.`);
    ids.add(expectationId);
    if (!Array.isArray(item.matchAny) || item.matchAny.length === 0) {
      throw new Error(`${fieldName}.matchAny must be a non-empty array.`);
    }
    return Object.freeze({
      expectationId,
      description: nonEmptyString(item.description, `${fieldName}.description`),
      appliesTo: Object.freeze(uniqueStrings(item.appliesTo, `${fieldName}.appliesTo`)),
      matchAny: Object.freeze(item.matchAny.map((matcher, matcherIndex) => Object.freeze(
        normalizeMatcher(matcher, `${fieldName}.matchAny[${matcherIndex}]`)
      )))
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    fixtureId: nonEmptyString(raw.fixtureId, 'ShadowExpectationsV1.fixtureId'),
    expectations: Object.freeze(expectations)
  });
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function valueAtPath(value, path) {
  if (!path) return value;
  const tokens = path.startsWith('/')
    ? path.slice(1).split('/').map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'))
    : path.split('.');
  let current = value;
  for (const token of tokens) {
    if (current === null || current === undefined || !Object.hasOwn(Object(current), token)) return undefined;
    current = current[token];
  }
  return current;
}

function numericLeaves(value, found = []) {
  if (typeof value === 'number' && Number.isFinite(value)) found.push(value);
  else if (typeof value === 'string') {
    for (const match of value.matchAll(/-?\d+(?:[,.]\d+)*/g)) {
      const parsed = Number(match[0].replaceAll(',', ''));
      if (Number.isFinite(parsed)) found.push(parsed);
    }
  } else if (Array.isArray(value)) value.forEach((item) => numericLeaves(item, found));
  else if (isPlainObject(value)) Object.values(value).forEach((item) => numericLeaves(item, found));
  return found;
}

function matchesValuePredicate(value, predicate) {
  const selected = valueAtPath(value, predicate.path || '');
  if (predicate.anyOf) return predicate.anyOf.some((item) => matchesValuePredicate(selected, item));
  if (Object.hasOwn(predicate, 'equals')) return jsonEqual(selected, predicate.equals);
  if (predicate.in) return predicate.in.some((candidate) => jsonEqual(selected, candidate));
  if (predicate.containsText) {
    return JSON.stringify(selected ?? '').toLowerCase().includes(predicate.containsText.toLowerCase());
  }
  if (Object.hasOwn(predicate, 'containsNumber')) {
    return numericLeaves(selected).some((number) => Math.abs(number - predicate.containsNumber) < 1e-9);
  }
  return false;
}

function matchesField(value, predicate) {
  const text = typeof value === 'string' ? value : '';
  if (predicate.equals) return text === predicate.equals;
  if (predicate.in) return predicate.in.includes(text);
  if (predicate.prefix) return text.startsWith(predicate.prefix);
  return false;
}

function matchesOperation(operation, matcher) {
  for (const key of ['op', 'factId', 'factInstanceId', 'noteKind', 'reasonCode']) {
    if (matcher[key] && !matchesField(operation[key], matcher[key])) return false;
  }
  return !matcher.value || matchesValuePredicate(operation.value, matcher.value);
}

function flattenOperations(plan) {
  return (plan?.operationGroups || []).flatMap((group) => (
    (group.operations || []).map((operation) => ({ ...operation, groupId: group.groupId }))
  ));
}

function acceptedEvidenceIsValid(operation, context) {
  if (!Array.isArray(operation.evidence) || operation.evidence.length === 0) return false;
  const turns = new Map((context?.transcriptTurns || []).map((turn) => [turn.turnId, turn]));
  return operation.evidence.every((evidence) => {
    const turn = turns.get(evidence.turnId);
    return turn?.role === 'user'
      && turn.finalized !== false
      && typeof evidence.quote === 'string'
      && evidence.quote.length > 0
      && String(turn.text || '').includes(evidence.quote);
  });
}

/** Score one archived plan and deterministic validator result without I/O. */
export function scoreReconciliationShadow({
  callId,
  plan,
  validation,
  reconciliationContext,
  expectations = null
}) {
  const operations = flattenOperations(plan);
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  const outcomes = Array.isArray(validation?.operationOutcomes) ? validation.operationOutcomes : [];
  const outcomeById = new Map(outcomes.map((outcome) => [outcome.operationId, outcome]));
  const acceptedIds = new Set(validation?.acceptedOperationIds || []);
  const acceptedOperations = operations.filter((operation) => (
    outcomeById.get(operation.operationId)?.status === 'accepted'
  ));
  const acceptedValidatedOperations = acceptedOperations.filter((operation) => (
    acceptedIds.has(operation.operationId)
    && acceptedEvidenceIsValid(operation, reconciliationContext)
  ));
  const integrityViolations = [];
  for (const operation of acceptedOperations) {
    if (!acceptedIds.has(operation.operationId)) {
      integrityViolations.push({ operationId: operation.operationId, code: 'accepted_id_missing' });
    } else if (!acceptedEvidenceIsValid(operation, reconciliationContext)) {
      integrityViolations.push({ operationId: operation.operationId, code: 'accepted_evidence_invalid' });
    }
  }
  for (const operationId of acceptedIds) {
    if (!byId.has(operationId)) integrityViolations.push({ operationId, code: 'accepted_operation_missing' });
    else if (outcomeById.get(operationId)?.status !== 'accepted') {
      integrityViolations.push({ operationId, code: 'accepted_outcome_missing' });
    }
  }

  const applicable = expectations
    ? expectations.expectations.filter((expectation) => expectation.appliesTo.includes(callId))
    : [];
  const correctionRows = applicable.map((expectation) => {
    const matched = acceptedValidatedOperations.filter((operation) => (
      expectation.matchAny.some((matcher) => matchesOperation(operation, matcher))
    ));
    return {
      expectationId: expectation.expectationId,
      description: expectation.description,
      matched: matched.length > 0,
      matchedOperationIds: matched.map((operation) => operation.operationId)
    };
  });
  const matchedCorrections = correctionRows.filter((row) => row.matched).length;
  const proposedClarifications = operations.filter((operation) => operation.op === 'request_clarification');
  const acceptedClarifications = proposedClarifications.filter((operation) => (
    outcomeById.get(operation.operationId)?.status === 'accepted'
  ));
  const acceptedCount = acceptedOperations.length;
  return {
    schemaVersion: 1,
    callId,
    proposedOperationCount: operations.length,
    acceptedOperationCount: acceptedCount,
    rejectedOperationCount: operations.filter((operation) => (
      outcomeById.get(operation.operationId)?.status !== 'accepted'
    )).length,
    acceptedValidatedOperationCount: acceptedValidatedOperations.length,
    acceptedOperationPrecision: acceptedCount > 0
      ? acceptedValidatedOperations.length / acceptedCount
      : 1,
    acceptedOperationPrecisionDenominator: acceptedCount,
    integrityPass: integrityViolations.length === 0,
    integrityViolations,
    clarificationCount: proposedClarifications.length,
    acceptedClarificationCount: acceptedClarifications.length,
    targetedCorrectionRecall: expectations
      ? (correctionRows.length > 0 ? matchedCorrections / correctionRows.length : 1)
      : null,
    targetedCorrectionsMatched: matchedCorrections,
    targetedCorrectionsApplicable: correctionRows.length,
    correctionRows
  };
}

/** Aggregate a batch without averaging away calls with different op counts. */
export function summarizeReconciliationShadowScores(scores = []) {
  const rows = (scores || []).filter((score) => score?.schemaVersion === 1);
  const totals = rows.reduce((sum, score) => ({
    proposed: sum.proposed + score.proposedOperationCount,
    accepted: sum.accepted + score.acceptedOperationCount,
    rejected: sum.rejected + score.rejectedOperationCount,
    acceptedValidated: sum.acceptedValidated + score.acceptedValidatedOperationCount,
    clarifications: sum.clarifications + score.clarificationCount,
    correctionsMatched: sum.correctionsMatched + score.targetedCorrectionsMatched,
    correctionsApplicable: sum.correctionsApplicable + score.targetedCorrectionsApplicable
  }), {
    proposed: 0,
    accepted: 0,
    rejected: 0,
    acceptedValidated: 0,
    clarifications: 0,
    correctionsMatched: 0,
    correctionsApplicable: 0
  });
  return {
    schemaVersion: 1,
    calls: rows.length,
    proposedOperationCount: totals.proposed,
    acceptedOperationCount: totals.accepted,
    rejectedOperationCount: totals.rejected,
    acceptedValidatedOperationCount: totals.acceptedValidated,
    acceptedOperationPrecision: totals.accepted > 0
      ? totals.acceptedValidated / totals.accepted
      : 1,
    integrityPass: rows.every((score) => score.integrityPass),
    clarificationCount: totals.clarifications,
    targetedCorrectionRecall: totals.correctionsApplicable > 0
      ? totals.correctionsMatched / totals.correctionsApplicable
      : null,
    targetedCorrectionsMatched: totals.correctionsMatched,
    targetedCorrectionsApplicable: totals.correctionsApplicable
  };
}
