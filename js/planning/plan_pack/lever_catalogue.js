import { PLANEIR_ASSUMPTIONS, PLANEIR_ASSUMPTIONS_VERSION } from '../planeir_assumptions.js';
import { cloneJson, readJsonPointer } from '../utils.js';
import { NON_CONTRIBUTORY_PENSION_TYPES } from '../profile.js';

export const GOAL_MOVE_FIELDS = Object.freeze(['retirementAge', 'targetIncomeToday', 'clearByAge', 'targetDate', 'targetAmount']);
const id = { type: 'string', source: 'fact', bounds: 'existing matching record ID' };
const positive = { type: 'number', exclusiveMinimum: 0 };
const definitions = {
  useCash: { parameters: { goalId: id, amount: { type: ['number', 'string'], minimum: 1, integer: true, choices: ['whole', 'remaining'], defaultPath: '/routes/defaultCashAmount', bounds: 'spare cash after the protected reserve, capped by this goal’s engine-priced need' } },
    requiredFacts: ['/household/assets/*/currentValue', '/planningInputs/cashAssetId', '/household/expenses/annualTotal', '/household/goals/*', '/planningInputs/goalFundingFacts/*'], engine: 'resource_ledger and the goal engine', scale: { kind: 'ordinary' } },
  clearOutgoing: { parameters: { outgoingId: id, paidFrom: { type: 'string', choices: ['savings'], defaultPath: '/routes/clearOutgoingPaidFrom' } },
    requiredFacts: ['/planningInputs/outgoingBindings/*', '/household/liabilities/*/currentBalance', '/household/liabilities/*/monthlyPayment', '/household/assets/*/currentValue', '/household/expenses/annualTotal'], engine: 'resource_ledger', scale: { kind: 'ordinary' } },
  sellAsset: { parameters: { assetId: id }, requiredFacts: ['/household/assets/*/currentValue', '/household/assets/*/ownerIds', '/household/assets/*/baseCost', '/household/assets/*/sellingCosts', '/household/assets/*/investmentTaxTreatment'],
    engine: 'shared tax engine, ordinary CGT only', scale: { kind: 'ordinary' } },
  moveGoal: { parameters: { goalId: id, ...Object.fromEntries(GOAL_MOVE_FIELDS.map(field => [field, {
    type: field === 'targetDate' ? 'string' : 'number', optional: true,
    ...(field === 'targetDate' ? { format: 'date', earliest: 'calculationDate' }
      : { minimum: ['retirementAge', 'clearByAge'].includes(field) ? 18 : 0, integer: ['retirementAge', 'clearByAge'].includes(field) }),
    bounds: `/goalFlexibility/{goalId}/${field}`
  }])) }, requiredFacts: ['/goalFlexibility/{goalId}/*', '/planningInputs/goalBindings/*', '/household/goals/*'], engine: 'the goal engine',
    scale: { kind: 'conditional', ordinaryThroughAdditionalWorkingYears: PLANEIR_ASSUMPTIONS.routes.majorWorkingLongerYears, basis: PLANEIR_ASSUMPTIONS.routes.workingLongerBasis } },
  pensionContribution: { parameters: { personId: id, annualAmount: { ...positive, bounds: 'current personal relief headroom from the pension engine; today’s gross annual extra, converted to a salary rate' } },
    requiredFacts: ['/household/pensions/*', '/household/incomeSources/*/grossAnnual', '/household/{primaryPerson|partner}/age', '/household/{primaryPerson|partner}/intendedRetirementAge',
      '/household/goals/*/targetAmount', '/planningInputs/retirementIncomeBasis', '/planningInputs/householdTaxStatus', '/planningInputs/personalPensionContributions'], engine: 'pension engine and goals-and-resources relief search', scale: { kind: 'ordinary' } },
  tradeDownHome: { parameters: { newHomePrice: { ...positive, multipleOf: 0.01, bounds: 'central minimumReplacementShare through maximumReplacementShare times current home value, and sufficient equity for a cash purchase' }, year: { type: 'number', integer: true, bounds: 'calculation year through central maximumYearsAhead' } },
    policy: PLANEIR_ASSUMPTIONS.routes.propertyMoves,
    requiredChapters: ['household_cash_flow'],
    requiredFacts: ['/household/properties/*/currentValue', '/household/properties/*/ownerIds', '/household/properties/*/homeUse', '/household/properties/*/associatedLiabilityIds', '/household/liabilities/*', '/planningInputs/cashAssetId'],
    engine: 'home_trade_down cash-purchase equity, native amortisation and House Purchase costs/stamp duty', scale: { kind: 'major' } },
  sellProperty: { parameters: { propertyId: id, year: { type: 'number', integer: true, bounds: 'calculation year through central maximumYearsAhead' } },
    policy: PLANEIR_ASSUMPTIONS.routes.propertyMoves,
    requiredChapters: ['household_cash_flow'],
    conditionalFacts: [{ when: 'two property owners', paths: ['/household/properties/*/jointEqualOwnership'] }],
    requiredFacts: ['/household/properties/*/currentValue', '/household/properties/*/ownerIds', '/household/properties/*/associatedLiabilityIds', '/household/liabilities/*', '/household/properties/*/baseCost', '/household/properties/*/acquisitionDate', '/household/properties/*/acquiredBy', '/household/properties/*/homeUse', '/household/properties/*/rentalIncomeSourceIds', '/household/properties/*/rentAnnual', '/household/properties/*/runningCostsAnnual', '/household/properties/*/taxOnRentalProfitAnnual', '/planningInputs/householdTaxStatus', '/planningInputs/cashAssetId'],
    engine: 'rental_keep_or_sell and shared property CGT', scale: { kind: 'major' } },
  spendLess: { parameters: { annualAmount: { ...positive, bounds: 'annualTotal minus twelve times stated monthlyEssential; checked again after debt clearances' } },
    requiredFacts: ['/household/expenses/annualTotal', '/household/expenses/monthlyEssential'], engine: 'resource_ledger and household_cash_flow',
    scale: { kind: 'conditional', ordinaryFractionOfAnnualSpending: PLANEIR_ASSUMPTIONS.routes.spendLess.ordinaryFractionOfAnnualSpending,
      approvalStatus: PLANEIR_ASSUMPTIONS.routes.spendLess.approvalStatus, basis: PLANEIR_ASSUMPTIONS.routes.spendLess.basis } }
};

/** One serialisable catalogue for schemas, validation and the later analyst tools. */
export function getLeverCatalogue() {
  return { version: 'route-levers-1.1.0', assumptionsVersion: PLANEIR_ASSUMPTIONS_VERSION,
    sourceKinds: ['fact', 'default', 'bounded'], levers: Object.entries(definitions).map(([type, definition]) => ({ type, ...cloneJson(definition),
      parameters: Object.fromEntries(Object.entries(definition.parameters).map(([key, parameter]) => [key, {
        ...cloneJson(parameter), ...(parameter.defaultPath ? { default: readJsonPointer(PLANEIR_ASSUMPTIONS, parameter.defaultPath) } : {})
      }])) })) };
}
export function getLeverDefinition(type) { return typeof type === 'string' && Object.hasOwn(definitions, type) ? cloneJson(definitions[type]) : null; }

function refuse(path, message, code = 'invalid_input') {
  throw Object.assign(new Error(message), { path, code });
}
function fact(pack, path, here) {
  if (typeof path !== 'string' || !/^\/(household|planningInputs|goalFlexibility)\//.test(path)) refuse(here, 'Cite a household, planning-input or flexibility fact path.', 'unsupported_parameter_source');
  let value;
  try { value = readJsonPointer(pack, path); }
  catch { refuse(here, 'Cite a valid JSON Pointer to a household fact.', 'unsupported_parameter_source'); }
  if (value === undefined || value === null) refuse(here, 'The cited fact is missing at ' + path + '.', 'missing_information');
  return value;
}

/** The form’s all-non-housing answer is not an established essential floor. */
export function statedEssentialAnnual(profile) {
  const path = '/household/expenses/monthlyEssential';
  const money = profile.expenses?.monthlyEssential;
  const source = profile.fieldMetadata?.['/expenses/monthlyEssential']?.application;
  if (!money || money.currency !== 'EUR' || !Number.isFinite(money.amount)
    || source?.paths?.includes('spending.spend')) refuse(path,
    'Establish stated essential spending. The v1 form’s all-non-housing spending annotation cannot establish this floor.', 'missing_information');
  return money.amount * 12;
}

/** Validate the origin of every supplied setting, independently of tool/model. */
export function validateLeverSources(pack, change, path, { required = true } = {}) {
  const definition = definitions[change.type];
  if (!definition) refuse(path + '/type', 'Unsupported lever.');
  if (!required && change.sources === undefined) return;
  if (!change.sources || typeof change.sources !== 'object' || Array.isArray(change.sources)) refuse(path + '/sources', 'Every lever setting needs a fact, a versioned central default, or a reasoned bounded value.', 'unsupported_parameter_source');
  for (const key of Object.keys(change.sources)) if (!definition.parameters[key] || change[key] === undefined) refuse(path + '/sources/' + key, 'Source does not correspond to a supplied lever setting.', 'unsupported_parameter_source');
  for (const key of Object.keys(change).filter(key => !['type', 'sources'].includes(key))) {
    const source = change.sources[key], here = path + '/sources/' + key;
    if (!source || typeof source !== 'object' || Array.isArray(source)) refuse(here, 'Supply the setting’s source.', 'unsupported_parameter_source');
    const allowed = { fact: ['kind', 'path'], default: ['kind', 'path', 'version'], bounded: ['kind', 'reason', 'factPaths'] }[source.kind];
    if (!allowed || Object.keys(source).some(field => !allowed.includes(field))) refuse(here, 'Source must use the fact, default or bounded contract.', 'unsupported_parameter_source');
    if (source.kind === 'fact') {
      if (JSON.stringify(fact(pack, source.path, here + '/path')) !== JSON.stringify(change[key])) refuse(here, 'The setting does not equal the cited fact.', 'unsupported_parameter_source');
    } else if (source.kind === 'default') {
      if (typeof source.path !== 'string' || !definition.parameters[key]?.defaultPath
        || source.version !== PLANEIR_ASSUMPTIONS_VERSION || source.path !== definition.parameters[key]?.defaultPath
        || readJsonPointer(PLANEIR_ASSUMPTIONS, source.path) !== change[key]) refuse(here, 'The setting is not this parameter’s current central default.', 'unsupported_parameter_source');
    } else {
      if (definition.parameters[key]?.source === 'fact') refuse(here, 'Record identifiers must cite their actual fact path.', 'unsupported_parameter_source');
      if (typeof source.reason !== 'string' || !source.reason.trim() || /[\r\n]/.test(source.reason)
        || !Array.isArray(source.factPaths) || !source.factPaths.length) refuse(here, 'A bounded setting needs a one-line reason citing a fact path.', 'unsupported_parameter_source');
      source.factPaths.forEach(pointer => fact(pack, pointer, here + '/factPaths'));
      if (!source.factPaths.some(pointer => source.reason.includes(pointer))) refuse(here + '/reason', 'The reason must cite at least one of the supplied fact paths.', 'unsupported_parameter_source');
    }
  }
}

/** Extra analyst constraints; legacy hand-authored B1 packs retain their API. */
export function validateLeverFacts(pack, change, path) {
  if (change.type === 'spendLess') {
    const essential = statedEssentialAnnual(pack.household);
    const annual = pack.household.expenses.annualTotal;
    if (!annual || annual.currency !== 'EUR') refuse('/household/expenses/annualTotal', 'State total annual spending before reducing it.', 'missing_information');
    if (annual.amount - change.annualAmount < essential - 0.005) refuse(path + '/annualAmount', 'The reduction would take spending below stated essentials.');
  }
  if (change.type === 'pensionContribution') {
    const person = [pack.household.primaryPerson, pack.household.partner].find(person => person?.personId === change.personId);
    if (!person || !Number.isInteger(person.age) || !Number.isInteger(person.intendedRetirementAge)) refuse('/household', 'Establish the named person’s age and retirement age.', 'missing_information');
    if (person.age >= person.intendedRetirementAge) refuse(path + '/personId', 'Extra pre-retirement contributions need a person who is still working.');
    if (!pack.household.pensions.some(pension => pension.ownerId === change.personId && pension.contributionStatus === 'active' && !NON_CONTRIBUTORY_PENSION_TYPES.includes(pension.type))) refuse('/household/pensions', 'An active contributory pension for this person must be established.', 'missing_information');
    if (!pack.household.goals.some(goal => ['retire', 'retire_early', 'improve_pension'].includes(goal.type) && !['paused', 'completed'].includes(goal.status))) refuse('/household/goals', 'Establish the combined retirement goal before pricing its contribution lever.', 'missing_information');
  }
  if (change.type === 'sellAsset') {
    const index = pack.household.assets.findIndex(asset => asset.assetId === change.assetId), asset = pack.household.assets[index];
    for (const field of ['currentValue', 'baseCost', 'sellingCosts']) if (!asset?.[field]) refuse(`/household/assets/${index}/${field}`, 'Establish the sale value, base cost and costs, including explicit zero where appropriate; an analyst sale cannot assume a missing fact is zero.', 'missing_information');
  }
}

export function classifyLever(pack, change) {
  if (['tradeDownHome', 'sellProperty'].includes(change.type)) return { scale: 'major', illustration: true,
    classification: { ...cloneJson(PLANEIR_ASSUMPTIONS.routes.propertyMoves), assumptionsVersion: PLANEIR_ASSUMPTIONS_VERSION } };
  if (change.type === 'spendLess') return { scale: change.annualAmount > pack.household.expenses.annualTotal.amount * PLANEIR_ASSUMPTIONS.routes.spendLess.ordinaryFractionOfAnnualSpending ? 'major' : 'ordinary',
    classification: { ...cloneJson(PLANEIR_ASSUMPTIONS.routes.spendLess), assumptionsVersion: PLANEIR_ASSUMPTIONS_VERSION } };
  if (change.type === 'moveGoal' && change.retirementAge !== undefined) {
    const binding = pack.planningInputs.goalBindings.find(binding => binding.goalId === change.goalId);
    const people = [pack.household.primaryPerson, pack.household.partner].filter(Boolean);
    const person = people.find(person => person.personId === binding?.personId) ?? (people.length === 1 ? people[0] : null);
    return { scale: person && change.retirementAge - person.intendedRetirementAge > PLANEIR_ASSUMPTIONS.routes.majorWorkingLongerYears ? 'major' : 'ordinary' };
  }
  return { scale: 'ordinary' };
}
