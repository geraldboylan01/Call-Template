import {
  CURRENCY_CODES,
  EMPLOYMENT_STATUSES,
  GOAL_PRIORITIES,
  GOAL_STATUSES,
  GOAL_TYPES,
  HOUSEHOLD_PROFILE_SCHEMA_VERSION,
  PERSON_ROLES,
  PROFILE_PATCH_ROOTS,
  PROFILE_SOURCES,
  PROVENANCE_CONFIDENCE,
  PROVENANCE_SOURCES,
  VALUE_CERTAINTIES
} from './contracts.js';
import {
  assertIsoDate,
  assertIsoDateTime,
  assertJsonCompatible,
  cloneJson,
  createOpaqueId,
  decodeJsonPointer,
  encodeJsonPointer,
  enumValue,
  escapeJsonPointerToken,
  finiteNumber,
  isPlainObject,
  nonEmptyString,
  readJsonPointer
} from './utils.js';

const ASSET_TYPES = Object.freeze(['cash', 'investment', 'property', 'pension', 'business', 'agricultural', 'other']);
const LIABILITY_TYPES = Object.freeze(['mortgage', 'loan', 'credit_card', 'other']);
const INCOME_TYPES = Object.freeze(['employment', 'self_employment', 'rental', 'pension', 'state_pension', 'other']);
// A buyout bond (personal retirement bond) holds benefits transferred out of a
// scheme the person has left. It is PRESERVED: nobody contributes to it, by
// anyone, ever. Without a way to say so, a client with one was asked what they
// and their employer pay into it -- a question with no correct answer, which
// the meeting then repeated because no answer could be accepted.
const PENSION_TYPES = Object.freeze([
  'occupational', 'prsa', 'personal', 'defined_benefit', 'buyout_bond', 'other'
]);

/** Pension types that cannot receive contributions, so are never asked about them. */
export const NON_CONTRIBUTORY_PENSION_TYPES = Object.freeze(['buyout_bond']);
const PROPERTY_USES = Object.freeze(['home', 'rental', 'farm', 'business', 'other']);
const CONSENT_PURPOSES = Object.freeze(['analysis', 'ai_processing', 'save_profile', 'adviser_handoff', 'marketing']);
const CONTACT_METHODS = Object.freeze(['email', 'phone']);
const PATCH_OPERATIONS = Object.freeze(['add', 'replace', 'remove']);
const ARRAY_INDEX = /^\d+$/;

function optionalString(value, fieldName) {
  if (value === null || typeof value === 'undefined' || value === '') return undefined;
  return nonEmptyString(value, fieldName);
}

function optionalDate(value, fieldName) {
  return assertIsoDate(value, fieldName, { nullable: true });
}

function optionalNumber(value, fieldName, options = {}) {
  return finiteNumber(value, fieldName, { ...options, optional: true, fallback: undefined });
}

function normalizeMoney(value, fieldName, { optional = false } = {}) {
  if ((value === null || typeof value === 'undefined') && optional) return undefined;
  if (!isPlainObject(value)) throw new Error(`${fieldName} must be a money object.`);
  return {
    amount: finiteNumber(value.amount, `${fieldName}.amount`, { min: 0 }),
    currency: enumValue(value.currency, CURRENCY_CODES, `${fieldName}.currency`)
  };
}

function normalizeStringIds(value, fieldName, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array.`);
  const normalized = value.map((entry, index) => nonEmptyString(entry, `${fieldName}[${index}]`));
  if (!allowEmpty && normalized.length === 0) throw new Error(`${fieldName} must not be empty.`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${fieldName} must not contain duplicate ids.`);
  return normalized;
}

function assertUniqueIds(items, fieldName, idKey) {
  const ids = items.map((item) => item[idKey]);
  if (new Set(ids).size !== ids.length) throw new Error(`${fieldName} must contain unique ${idKey} values.`);
  return items;
}

function normalizePerson(value, fieldName, requiredRole) {
  if (!isPlainObject(value)) throw new Error(`${fieldName} must be an object.`);
  const role = enumValue(value.role ?? requiredRole, PERSON_ROLES, `${fieldName}.role`);
  if (role !== requiredRole) throw new Error(`${fieldName}.role must be ${requiredRole}.`);
  const person = {
    personId: nonEmptyString(value.personId, `${fieldName}.personId`),
    role
  };
  const displayName = optionalString(value.displayName, `${fieldName}.displayName`);
  const dateOfBirth = optionalDate(value.dateOfBirth, `${fieldName}.dateOfBirth`);
  const age = optionalNumber(value.age, `${fieldName}.age`, { min: 0, max: 120, integer: true });
  const employmentStatus = value.employmentStatus === null || typeof value.employmentStatus === 'undefined'
    ? undefined
    : enumValue(value.employmentStatus, EMPLOYMENT_STATUSES, `${fieldName}.employmentStatus`);
  const intendedRetirementAge = optionalNumber(
    value.intendedRetirementAge,
    `${fieldName}.intendedRetirementAge`,
    { min: 18, max: 100, integer: true }
  );
  if (typeof age === 'number' && typeof intendedRetirementAge === 'number' && intendedRetirementAge < age) {
    throw new Error(`${fieldName}.intendedRetirementAge must not be below the current age.`);
  }
  if (displayName) person.displayName = displayName;
  if (dateOfBirth) person.dateOfBirth = dateOfBirth;
  if (typeof age === 'number') person.age = age;
  if (employmentStatus) person.employmentStatus = employmentStatus;
  if (typeof intendedRetirementAge === 'number') person.intendedRetirementAge = intendedRetirementAge;
  return person;
}

function normalizeDependant(value, index) {
  const fieldName = `dependants[${index}]`;
  if (!isPlainObject(value)) throw new Error(`${fieldName} must be an object.`);
  const dependant = { dependantId: nonEmptyString(value.dependantId, `${fieldName}.dependantId`) };
  const displayName = optionalString(value.displayName, `${fieldName}.displayName`);
  const currentAge = optionalNumber(value.currentAge, `${fieldName}.currentAge`, { min: 0, max: 100, integer: true });
  const dependencyEnd = optionalNumber(
    value.expectedDependencyEndAge,
    `${fieldName}.expectedDependencyEndAge`,
    { min: 0, max: 100, integer: true }
  );
  if (typeof currentAge === 'number' && typeof dependencyEnd === 'number' && dependencyEnd < currentAge) {
    throw new Error(`${fieldName}.expectedDependencyEndAge must not be below currentAge.`);
  }
  if (displayName) dependant.displayName = displayName;
  if (typeof currentAge === 'number') dependant.currentAge = currentAge;
  if (typeof dependencyEnd === 'number') dependant.expectedDependencyEndAge = dependencyEnd;
  return dependant;
}

function normalizeAsset(value, index) {
  const fieldName = `assets[${index}]`;
  if (!isPlainObject(value)) throw new Error(`${fieldName} must be an object.`);
  const asset = {
    assetId: nonEmptyString(value.assetId, `${fieldName}.assetId`),
    ownerIds: normalizeStringIds(value.ownerIds ?? [], `${fieldName}.ownerIds`),
    type: enumValue(value.type, ASSET_TYPES, `${fieldName}.type`),
    label: nonEmptyString(value.label, `${fieldName}.label`)
  };
  const currentValue = normalizeMoney(value.currentValue, `${fieldName}.currentValue`, { optional: true });
  const country = optionalString(value.country, `${fieldName}.country`);
  if (country && country.length > 80) throw new Error(`${fieldName}.country must be 80 characters or fewer.`);
  if (currentValue) asset.currentValue = currentValue;
  if (country) asset.country = country;
  if (typeof value.liquid !== 'undefined') {
    if (typeof value.liquid !== 'boolean') throw new Error(`${fieldName}.liquid must be a boolean when provided.`);
    asset.liquid = value.liquid;
  }
  return asset;
}

function normalizeLiability(value, index) {
  const fieldName = `liabilities[${index}]`;
  if (!isPlainObject(value)) throw new Error(`${fieldName} must be an object.`);
  const liability = {
    liabilityId: nonEmptyString(value.liabilityId, `${fieldName}.liabilityId`),
    ownerIds: normalizeStringIds(value.ownerIds ?? [], `${fieldName}.ownerIds`),
    type: enumValue(value.type, LIABILITY_TYPES, `${fieldName}.type`),
    label: nonEmptyString(value.label, `${fieldName}.label`)
  };
  const currentBalance = normalizeMoney(value.currentBalance, `${fieldName}.currentBalance`, { optional: true });
  const annualInterestRate = optionalNumber(value.annualInterestRate, `${fieldName}.annualInterestRate`, { min: 0, max: 1 });
  const monthlyPayment = normalizeMoney(value.monthlyPayment, `${fieldName}.monthlyPayment`, { optional: true });
  const remainingTermMonths = optionalNumber(
    value.remainingTermMonths,
    `${fieldName}.remainingTermMonths`,
    { min: 1, max: 1200, integer: true }
  );
  if (currentBalance) liability.currentBalance = currentBalance;
  if (typeof annualInterestRate === 'number') liability.annualInterestRate = annualInterestRate;
  if (monthlyPayment) liability.monthlyPayment = monthlyPayment;
  if (typeof remainingTermMonths === 'number') liability.remainingTermMonths = remainingTermMonths;
  return liability;
}

function normalizeIncome(value, index) {
  const fieldName = `incomeSources[${index}]`;
  if (!isPlainObject(value)) throw new Error(`${fieldName} must be an object.`);
  const income = {
    incomeId: nonEmptyString(value.incomeId, `${fieldName}.incomeId`),
    ownerId: nonEmptyString(value.ownerId, `${fieldName}.ownerId`),
    type: enumValue(value.type, INCOME_TYPES, `${fieldName}.type`),
    label: nonEmptyString(value.label, `${fieldName}.label`)
  };
  const grossAnnual = normalizeMoney(value.grossAnnual, `${fieldName}.grossAnnual`, { optional: true });
  const netAnnual = normalizeMoney(value.netAnnual, `${fieldName}.netAnnual`, { optional: true });
  const startAge = optionalNumber(value.startAge, `${fieldName}.startAge`, { min: 0, max: 120, integer: true });
  const endAge = optionalNumber(value.endAge, `${fieldName}.endAge`, { min: 0, max: 120, integer: true });
  if (typeof startAge === 'number' && typeof endAge === 'number' && endAge < startAge) {
    throw new Error(`${fieldName}.endAge must not be below startAge.`);
  }
  if (grossAnnual) income.grossAnnual = grossAnnual;
  if (netAnnual) income.netAnnual = netAnnual;
  if (typeof startAge === 'number') income.startAge = startAge;
  if (typeof endAge === 'number') income.endAge = endAge;
  if (typeof value.inflationIndexed !== 'undefined') {
    if (typeof value.inflationIndexed !== 'boolean') throw new Error(`${fieldName}.inflationIndexed must be a boolean.`);
    income.inflationIndexed = value.inflationIndexed;
  }
  return income;
}

function normalizeExpenses(value) {
  if (!isPlainObject(value)) throw new Error('expenses must be an object.');
  const result = {};
  for (const key of ['annualTotal', 'monthlyEssential', 'monthlyDiscretionary', 'currentMonthlyRent']) {
    const money = normalizeMoney(value[key], `expenses.${key}`, { optional: true });
    if (money) result[key] = money;
  }
  return result;
}

function normalizePension(value, index) {
  const fieldName = `pensions[${index}]`;
  if (!isPlainObject(value)) throw new Error(`${fieldName} must be an object.`);
  const pension = {
    pensionId: nonEmptyString(value.pensionId, `${fieldName}.pensionId`),
    ownerId: nonEmptyString(value.ownerId, `${fieldName}.ownerId`),
    type: enumValue(value.type, PENSION_TYPES, `${fieldName}.type`)
  };
  const currentValue = normalizeMoney(value.currentValue, `${fieldName}.currentValue`, { optional: true });
  const employeeRate = optionalNumber(
    value.employeeContributionRate,
    `${fieldName}.employeeContributionRate`,
    { min: 0, max: 1 }
  );
  const employerRate = optionalNumber(
    value.employerContributionRate,
    `${fieldName}.employerContributionRate`,
    { min: 0, max: 1 }
  );
  const projectedIncome = normalizeMoney(value.projectedAnnualIncome, `${fieldName}.projectedAnnualIncome`, { optional: true });
  if (currentValue) pension.currentValue = currentValue;
  if (typeof employeeRate === 'number') pension.employeeContributionRate = employeeRate;
  if (typeof employerRate === 'number') pension.employerContributionRate = employerRate;
  if (projectedIncome) pension.projectedAnnualIncome = projectedIncome;
  return pension;
}

function normalizeProperty(value, index) {
  const fieldName = `properties[${index}]`;
  if (!isPlainObject(value)) throw new Error(`${fieldName} must be an object.`);
  const property = {
    propertyId: nonEmptyString(value.propertyId, `${fieldName}.propertyId`),
    ownerIds: normalizeStringIds(value.ownerIds ?? [], `${fieldName}.ownerIds`),
    use: enumValue(value.use, PROPERTY_USES, `${fieldName}.use`),
    associatedLiabilityIds: normalizeStringIds(value.associatedLiabilityIds ?? [], `${fieldName}.associatedLiabilityIds`)
  };
  const currentValue = normalizeMoney(value.currentValue, `${fieldName}.currentValue`, { optional: true });
  if (currentValue) property.currentValue = currentValue;
  return property;
}

function normalizeBusiness(value, index) {
  const fieldName = `businesses[${index}]`;
  if (!isPlainObject(value)) throw new Error(`${fieldName} must be an object.`);
  if (typeof value.agricultural !== 'boolean') throw new Error(`${fieldName}.agricultural must be a boolean.`);
  const business = {
    businessId: nonEmptyString(value.businessId, `${fieldName}.businessId`),
    ownerIds: normalizeStringIds(value.ownerIds ?? [], `${fieldName}.ownerIds`),
    label: nonEmptyString(value.label, `${fieldName}.label`),
    agricultural: value.agricultural
  };
  const estimatedValue = normalizeMoney(value.estimatedValue, `${fieldName}.estimatedValue`, { optional: true });
  if (estimatedValue) business.estimatedValue = estimatedValue;
  return business;
}

function normalizeGoal(value, index) {
  const fieldName = `goals[${index}]`;
  if (!isPlainObject(value)) throw new Error(`${fieldName} must be an object.`);
  const goal = {
    goalId: nonEmptyString(value.goalId, `${fieldName}.goalId`),
    type: enumValue(value.type, GOAL_TYPES, `${fieldName}.type`),
    title: nonEmptyString(value.title, `${fieldName}.title`),
    priority: enumValue(value.priority, GOAL_PRIORITIES, `${fieldName}.priority`),
    status: enumValue(value.status, GOAL_STATUSES, `${fieldName}.status`)
  };
  const targetDate = optionalDate(value.targetDate, `${fieldName}.targetDate`);
  const targetAmount = normalizeMoney(value.targetAmount, `${fieldName}.targetAmount`, { optional: true });
  if (targetDate) goal.targetDate = targetDate;
  if (targetAmount) goal.targetAmount = targetAmount;
  return goal;
}

function normalizePreferences(value) {
  if (!isPlainObject(value)) throw new Error('preferences must be an object.');
  if (typeof value.riskDiscussionCompleted !== 'boolean') {
    throw new Error('preferences.riskDiscussionCompleted must be a boolean.');
  }
  const preferences = {
    baseCurrency: enumValue(value.baseCurrency, CURRENCY_CODES, 'preferences.baseCurrency'),
    riskDiscussionCompleted: value.riskDiscussionCompleted
  };
  if (typeof value.preferredContactMethod !== 'undefined') {
    preferences.preferredContactMethod = enumValue(
      value.preferredContactMethod,
      CONTACT_METHODS,
      'preferences.preferredContactMethod'
    );
  }
  return preferences;
}

function normalizeAssumptions(value) {
  if (!isPlainObject(value)) throw new Error('assumptions must be an object.');
  const assumptionValues = isPlainObject(value.values) ? cloneJson(value.values) : {};
  if (typeof assumptionValues.persona === 'undefined') assumptionValues.persona = {};
  if (!isPlainObject(assumptionValues.persona)) throw new Error('assumptions.values.persona must be an object.');
  // Planning decisions (the client's stated primary goal, and their accepted,
  // declined, deferred, replaced and confirmed analyses) are guaranteed to
  // exist for the same reason persona is: a JSON-pointer patch can only write
  // to a path whose parent exists. Without this, a scalar write such as
  // /assumptions/values/planning/primaryGoalType failed on every fresh profile,
  // so a client's explicitly stated primary goal was silently discarded.
  // An empty object is indistinguishable from absent to every reader —
  // planningValues() in goal_plan.js already defaults to {}.
  if (typeof assumptionValues.planning === 'undefined') assumptionValues.planning = {};
  if (!isPlainObject(assumptionValues.planning)) throw new Error('assumptions.values.planning must be an object.');
  assertJsonCompatible(assumptionValues, 'assumptions.values');
  const assumptions = {
    calculationDateIso: assertIsoDate(value.calculationDateIso, 'assumptions.calculationDateIso'),
    values: cloneJson(assumptionValues)
  };
  const inflation = optionalNumber(value.inflationRate, 'assumptions.inflationRate', { min: -0.99, max: 1 });
  const growth = optionalNumber(value.investmentGrowthRate, 'assumptions.investmentGrowthRate', { min: -0.99, max: 2 });
  if (typeof inflation === 'number') assumptions.inflationRate = inflation;
  if (typeof growth === 'number') assumptions.investmentGrowthRate = growth;
  return assumptions;
}

export function normalizeFieldProvenance(value, fieldName = 'provenance', defaults = {}) {
  const source = value?.source ?? defaults.source ?? 'user_statement';
  const confidence = value?.confidence ?? defaults.confidence ?? 'medium';
  const certainty = value?.certainty ?? defaults.certainty ?? 'exact';
  const capturedAt = value?.capturedAt ?? defaults.capturedAt;
  const provenance = {
    source: enumValue(source, PROVENANCE_SOURCES, `${fieldName}.source`),
    confidence: enumValue(confidence, PROVENANCE_CONFIDENCE, `${fieldName}.confidence`),
    certainty: enumValue(certainty, VALUE_CERTAINTIES, `${fieldName}.certainty`),
    capturedAt: assertIsoDateTime(capturedAt, `${fieldName}.capturedAt`),
    confirmedByUser: typeof value?.confirmedByUser === 'boolean'
      ? value.confirmedByUser
      : Boolean(defaults.confirmedByUser)
  };
  const conversationTurnId = optionalString(value?.conversationTurnId ?? defaults.conversationTurnId, `${fieldName}.conversationTurnId`);
  const note = optionalString(value?.note ?? defaults.note, `${fieldName}.note`);
  if (conversationTurnId) provenance.conversationTurnId = conversationTurnId;
  if (note) provenance.note = note;
  const range = value?.range ?? defaults.range;
  if (typeof range !== 'undefined') {
    if (!isPlainObject(range)) throw new Error(`${fieldName}.range must be an object.`);
    const min = finiteNumber(range.min, `${fieldName}.range.min`);
    const max = finiteNumber(range.max, `${fieldName}.range.max`);
    if (max < min) throw new Error(`${fieldName}.range.max must not be below min.`);
    provenance.range = { min, max };
  }
  if (provenance.certainty === 'range' && !provenance.range) {
    throw new Error(`${fieldName}.range is required when certainty is range.`);
  }
  return provenance;
}

function normalizeFieldMetadata(value) {
  if (!isPlainObject(value)) throw new Error('fieldMetadata must be an object.');
  return Object.fromEntries(Object.entries(value).map(([path, provenance]) => {
    decodeJsonPointer(path);
    return [path, normalizeFieldProvenance(provenance, `fieldMetadata[${path}]`)];
  }));
}

function normalizeMissingInformation(value) {
  if (!Array.isArray(value)) throw new Error('missingInformation must be an array.');
  return value.map((item, index) => {
    const fieldName = `missingInformation[${index}]`;
    if (!isPlainObject(item)) throw new Error(`${fieldName} must be an object.`);
    decodeJsonPointer(item.fieldPath);
    return {
      fieldPath: item.fieldPath,
      reason: nonEmptyString(item.reason, `${fieldName}.reason`),
      blockingModuleIds: normalizeStringIds(item.blockingModuleIds ?? [], `${fieldName}.blockingModuleIds`),
      importance: enumValue(item.importance, ['required', 'recommended', 'optional'], `${fieldName}.importance`)
    };
  });
}

function normalizeConsent(value) {
  if (!Array.isArray(value)) throw new Error('consent must be an array.');
  return assertUniqueIds(value.map((record, index) => {
    const fieldName = `consent[${index}]`;
    if (!isPlainObject(record)) throw new Error(`${fieldName} must be an object.`);
    if (typeof record.granted !== 'boolean') throw new Error(`${fieldName}.granted must be a boolean.`);
    const normalized = {
      consentId: nonEmptyString(record.consentId, `${fieldName}.consentId`),
      purpose: enumValue(record.purpose, CONSENT_PURPOSES, `${fieldName}.purpose`),
      granted: record.granted,
      policyVersion: nonEmptyString(record.policyVersion, `${fieldName}.policyVersion`),
      capturedAt: assertIsoDateTime(record.capturedAt, `${fieldName}.capturedAt`)
    };
    if (record.withdrawnAt) normalized.withdrawnAt = assertIsoDateTime(record.withdrawnAt, `${fieldName}.withdrawnAt`);
    return normalized;
  }), 'consent', 'consentId');
}

/**
 * Build a canonical, empty HouseholdProfile v1. The injected timestamps and id
 * make deterministic tests possible without changing production callers.
 */
export function createHouseholdProfile({
  profileId = createOpaqueId('profile'),
  source = 'consumer',
  primaryPersonId = 'primary',
  nowIso = new Date().toISOString(),
  calculationDateIso = nowIso.slice(0, 10),
  baseCurrency = 'EUR'
} = {}) {
  return normalizeHouseholdProfile({
    profileId,
    schemaVersion: HOUSEHOLD_PROFILE_SCHEMA_VERSION,
    revision: 0,
    source,
    primaryPerson: { personId: primaryPersonId, role: 'primary', employmentStatus: 'unknown' },
    dependants: [],
    assets: [],
    liabilities: [],
    incomeSources: [],
    expenses: {},
    pensions: [],
    properties: [],
    businesses: [],
    goals: [],
    preferences: { baseCurrency, riskDiscussionCompleted: false },
    assumptions: { calculationDateIso, values: {} },
    fieldMetadata: {},
    missingInformation: [],
    consent: [],
    createdAt: nowIso,
    updatedAt: nowIso
  });
}

/** Validate and canonicalise HouseholdProfile v1 without mutating the input. */
export function normalizeHouseholdProfile(raw) {
  if (!isPlainObject(raw)) throw new Error('HouseholdProfile must be an object.');
  const schemaVersion = finiteNumber(raw.schemaVersion, 'schemaVersion', { min: 1, integer: true });
  if (schemaVersion !== HOUSEHOLD_PROFILE_SCHEMA_VERSION) {
    throw new Error(`Unsupported HouseholdProfile schemaVersion ${schemaVersion}.`);
  }
  const profile = {
    profileId: nonEmptyString(raw.profileId, 'profileId'),
    schemaVersion,
    revision: finiteNumber(raw.revision, 'revision', { min: 0, integer: true }),
    source: enumValue(raw.source, PROFILE_SOURCES, 'source'),
    primaryPerson: normalizePerson(raw.primaryPerson, 'primaryPerson', 'primary'),
    dependants: assertUniqueIds((raw.dependants ?? []).map(normalizeDependant), 'dependants', 'dependantId'),
    assets: assertUniqueIds((raw.assets ?? []).map(normalizeAsset), 'assets', 'assetId'),
    liabilities: assertUniqueIds((raw.liabilities ?? []).map(normalizeLiability), 'liabilities', 'liabilityId'),
    incomeSources: assertUniqueIds((raw.incomeSources ?? []).map(normalizeIncome), 'incomeSources', 'incomeId'),
    expenses: normalizeExpenses(raw.expenses ?? {}),
    pensions: assertUniqueIds((raw.pensions ?? []).map(normalizePension), 'pensions', 'pensionId'),
    properties: assertUniqueIds((raw.properties ?? []).map(normalizeProperty), 'properties', 'propertyId'),
    businesses: assertUniqueIds((raw.businesses ?? []).map(normalizeBusiness), 'businesses', 'businessId'),
    goals: assertUniqueIds((raw.goals ?? []).map(normalizeGoal), 'goals', 'goalId'),
    preferences: normalizePreferences(raw.preferences),
    assumptions: normalizeAssumptions(raw.assumptions),
    fieldMetadata: normalizeFieldMetadata(raw.fieldMetadata ?? {}),
    missingInformation: normalizeMissingInformation(raw.missingInformation ?? []),
    consent: normalizeConsent(raw.consent ?? []),
    createdAt: assertIsoDateTime(raw.createdAt, 'createdAt'),
    updatedAt: assertIsoDateTime(raw.updatedAt, 'updatedAt')
  };
  if (raw.partner !== null && typeof raw.partner !== 'undefined') {
    profile.partner = normalizePerson(raw.partner, 'partner', 'partner');
    if (profile.partner.personId === profile.primaryPerson.personId) {
      throw new Error('primaryPerson and partner must use different personId values.');
    }
  }
  if (raw.confirmedAt) profile.confirmedAt = assertIsoDateTime(raw.confirmedAt, 'confirmedAt');
  const personIds = new Set([profile.primaryPerson.personId, profile.partner?.personId].filter(Boolean));
  const assertOwners = (items, fieldName, ownerKey = 'ownerIds') => items.forEach((item, index) => {
    const ownerIds = ownerKey === 'ownerId' ? [item[ownerKey]] : item[ownerKey];
    ownerIds.forEach((ownerId) => {
      if (ownerId !== 'household' && !personIds.has(ownerId)) {
        throw new Error(`${fieldName}[${index}].${ownerKey} contains an unknown household person id.`);
      }
    });
  });
  assertOwners(profile.assets, 'assets');
  assertOwners(profile.liabilities, 'liabilities');
  assertOwners(profile.incomeSources, 'incomeSources', 'ownerId');
  assertOwners(profile.pensions, 'pensions', 'ownerId');
  assertOwners(profile.properties, 'properties');
  assertOwners(profile.businesses, 'businesses');
  const liabilityIds = new Set(profile.liabilities.map((liability) => liability.liabilityId));
  profile.properties.forEach((property, index) => property.associatedLiabilityIds.forEach((liabilityId) => {
    if (!liabilityIds.has(liabilityId)) {
      throw new Error(`properties[${index}].associatedLiabilityIds contains an unknown liability id.`);
    }
  }));
  return profile;
}

function validatePatchPath(path) {
  const tokens = decodeJsonPointer(path);
  if (!PROFILE_PATCH_ROOTS.includes(tokens[0])) {
    throw new Error(`Profile patch path ${path} is not allowlisted.`);
  }
  if (path === '/assumptions/calculationDateIso') {
    throw new Error('Profile patch cannot change the code-owned calculation date.');
  }
  return tokens;
}

/** Create and validate an allowlisted ProfilePatch v1. */
export function createProfilePatch(operations, options = {}) {
  return normalizeProfilePatch({ operations, ...options });
}

export function normalizeProfilePatch(raw, {
  capturedAt = new Date().toISOString(),
  defaultProvenance = {}
} = {}) {
  const source = Array.isArray(raw) ? { operations: raw } : raw;
  if (!isPlainObject(source) || !Array.isArray(source.operations)) {
    throw new Error('ProfilePatch must include an operations array.');
  }
  const patchId = optionalString(source.patchId, 'patchId') ?? createOpaqueId('patch');
  const defaults = {
    ...defaultProvenance,
    ...(isPlainObject(source.provenance) ? source.provenance : {}),
    capturedAt: source.provenance?.capturedAt ?? defaultProvenance.capturedAt ?? capturedAt
  };
  const operations = source.operations.map((operation, index) => {
    const fieldName = `operations[${index}]`;
    if (!isPlainObject(operation)) throw new Error(`${fieldName} must be an object.`);
    const op = enumValue(operation.op, PATCH_OPERATIONS, `${fieldName}.op`);
    const path = nonEmptyString(operation.path, `${fieldName}.path`);
    validatePatchPath(path);
    if (op !== 'remove' && !Object.hasOwn(operation, 'value')) {
      throw new Error(`${fieldName}.value is required for ${op}.`);
    }
    if (op !== 'remove' && typeof operation.value === 'undefined') {
      throw new Error(`${fieldName}.value cannot be undefined.`);
    }
    const normalized = {
      op,
      path,
      provenance: normalizeFieldProvenance(operation.provenance, `${fieldName}.provenance`, defaults)
    };
    if (op !== 'remove') normalized.value = cloneJson(operation.value);
    return normalized;
  });
  return { schemaVersion: 1, patchId, operations };
}

function metadataMatchesPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function deleteMetadataSubtree(metadata, prefix) {
  Object.keys(metadata).forEach((path) => {
    if (metadataMatchesPrefix(path, prefix)) delete metadata[path];
  });
}

function shiftArrayMetadata(metadata, arrayPath, fromIndex, delta, { dropIndex = false } = {}) {
  const updated = {};
  Object.entries(metadata).forEach(([path, provenance]) => {
    if (!path.startsWith(`${arrayPath}/`)) {
      updated[path] = provenance;
      return;
    }
    const remainder = path.slice(arrayPath.length + 1);
    const [indexToken, ...tail] = remainder.split('/');
    if (!ARRAY_INDEX.test(indexToken)) {
      updated[path] = provenance;
      return;
    }
    const index = Number(indexToken);
    if (dropIndex && index === fromIndex) return;
    const shouldShift = delta > 0 ? index >= fromIndex : index > fromIndex;
    const shifted = shouldShift ? index + delta : index;
    updated[`${arrayPath}/${shifted}${tail.length ? `/${tail.join('/')}` : ''}`] = provenance;
  });
  Object.keys(metadata).forEach((path) => delete metadata[path]);
  Object.assign(metadata, updated);
}

function metadataLeafPaths(value, basePath) {
  if (Array.isArray(value)) {
    if (value.length === 0) return [basePath];
    return value.flatMap((entry, index) => metadataLeafPaths(entry, `${basePath}/${index}`));
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [basePath];
    return entries.flatMap(([key, entry]) => metadataLeafPaths(entry, `${basePath}/${escapeJsonPointerToken(key)}`));
  }
  return [basePath];
}

function resolveParent(root, tokens) {
  let cursor = root;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (Array.isArray(cursor)) {
      if (!ARRAY_INDEX.test(token) || Number(token) >= cursor.length) {
        throw new Error(`Profile patch path ${encodeJsonPointer(tokens)} does not exist.`);
      }
      cursor = cursor[Number(token)];
    } else if (isPlainObject(cursor) && Object.hasOwn(cursor, token)) {
      cursor = cursor[token];
    } else {
      throw new Error(`Profile patch path ${encodeJsonPointer(tokens)} does not exist.`);
    }
  }
  return { parent: cursor, token: tokens[tokens.length - 1] };
}

function applyOperation(root, metadata, operation) {
  const tokens = validatePatchPath(operation.path);
  const { parent, token } = resolveParent(root, tokens);
  let actualTokens = tokens;

  if (Array.isArray(parent)) {
    const arrayPath = encodeJsonPointer(tokens.slice(0, -1));
    if (operation.op === 'add') {
      const index = token === '-' ? parent.length : Number(token);
      if ((token !== '-' && !ARRAY_INDEX.test(token)) || index < 0 || index > parent.length) {
        throw new Error(`Profile patch add index ${operation.path} is invalid.`);
      }
      if (index < parent.length) shiftArrayMetadata(metadata, arrayPath, index, 1);
      parent.splice(index, 0, cloneJson(operation.value));
      actualTokens = [...tokens.slice(0, -1), String(index)];
    } else {
      if (!ARRAY_INDEX.test(token) || Number(token) >= parent.length) {
        throw new Error(`Profile patch path ${operation.path} does not exist.`);
      }
      const index = Number(token);
      if (operation.op === 'replace') parent[index] = cloneJson(operation.value);
      if (operation.op === 'remove') {
        shiftArrayMetadata(metadata, arrayPath, index, -1, { dropIndex: true });
        parent.splice(index, 1);
      }
    }
  } else if (isPlainObject(parent)) {
    const exists = Object.hasOwn(parent, token);
    if (operation.op === 'replace' && !exists) throw new Error(`Profile patch path ${operation.path} does not exist.`);
    if (operation.op === 'remove' && !exists) throw new Error(`Profile patch path ${operation.path} does not exist.`);
    if (operation.op === 'add' || operation.op === 'replace') parent[token] = cloneJson(operation.value);
    if (operation.op === 'remove') delete parent[token];
  } else {
    throw new Error(`Profile patch parent for ${operation.path} is not a container.`);
  }

  const actualPath = encodeJsonPointer(actualTokens);
  if (!Array.isArray(parent) || operation.op !== 'remove') deleteMetadataSubtree(metadata, actualPath);
  if (operation.op !== 'remove') {
    metadataLeafPaths(operation.value, actualPath).forEach((path) => {
      metadata[path] = cloneJson(operation.provenance);
    });
  }
  return actualPath;
}

/**
 * Apply a ProfilePatch atomically. The returned profile is a new canonical
 * revision; the input profile is never mutated.
 *
 * @returns {{profile:Object, changedPaths:string[], appliedOperations:Object[]}}
 */
export function applyProfilePatch(rawProfile, rawPatch, options = {}) {
  const profile = normalizeHouseholdProfile(rawProfile);
  const patch = normalizeProfilePatch(rawPatch, options);
  if (patch.operations.length === 0) {
    return { profile, changedPaths: [], appliedOperations: [] };
  }
  const next = cloneJson(profile);
  const changedPaths = patch.operations.map((operation) => applyOperation(next, next.fieldMetadata, operation));
  const nowIso = options.nowIso ?? new Date().toISOString();
  next.revision = profile.revision + 1;
  next.updatedAt = assertIsoDateTime(nowIso, 'nowIso');
  delete next.confirmedAt;
  next.missingInformation = [];
  return {
    profile: normalizeHouseholdProfile(next),
    changedPaths,
    appliedOperations: patch.operations
  };
}

export const applyHouseholdProfilePatch = applyProfilePatch;

export function confirmHouseholdProfile(rawProfile, { confirmedAt = new Date().toISOString() } = {}) {
  const profile = normalizeHouseholdProfile(rawProfile);
  profile.confirmedAt = assertIsoDateTime(confirmedAt, 'confirmedAt');
  profile.updatedAt = profile.confirmedAt;
  Object.keys(profile.fieldMetadata).forEach((path) => {
    if (readJsonPointer(profile, path) !== undefined) {
      profile.fieldMetadata[path] = {
        ...profile.fieldMetadata[path],
        source: 'user_confirmation',
        confidence: 'high',
        confirmedByUser: true,
        capturedAt: profile.confirmedAt
      };
    }
  });
  return normalizeHouseholdProfile(profile);
}
