import {
  APPLICATION_SCHEMA, APPLICATION_SCHEMA_VERSION, TOPICS, getPath,
  includeAnsweredSections, listVisibleFields, normalizeApplication, pruneToVisible
} from '../case_application/schema.js';
import { createHouseholdProfile, normalizeHouseholdProfile, NON_CONTRIBUTORY_PENSION_TYPES } from './profile.js';
import { getSemanticFactDefinition } from './semantic_facts.js';
import { getGoalTitle } from './goal_catalogue.js';
import { planFactsMissing } from './plan_facts_missing.js';

export const APPLICATION_PROFILE_MAPPING_VERSION = '1.0.0';
// An unbound conversion is inspectable without inventing a capture/calculation
// date. planFactsMissing reports the missing snapshot binding. Production callers
// must pass the confirmed revision and timestamp from the saved snapshot.
const UNBOUND_DATE = '1970-01-01T00:00:00.000Z';
const present = value => value !== undefined && value !== null && value !== '';
const money = amount => ({ amount, currency: 'EUR' });
const semanticPath = id => getSemanticFactDefinition(id).profilePathTemplate;

/**
 * Pure, DOM/Worker-free conversion of planeir.application.v1 answers.
 *
 * applicationToProfile(information) gives a deterministic, unbound profile for
 * inspection. Bind a saved confirmation with the optional second argument:
 * { revision: confirmedRevision, confirmedAt, profileId?, calculationDateIso? }.
 * Never pass the latest editable payload in place of confirmed_payload_encrypted.
 * No contact details, clock, random ids, benefits or tax estimates are read here.
 * Unrepresented answers are listed in assumptions.values.application.unmappedFields.
 */
export function applicationToProfile(information, options = {}) {
  if (information?.schema && information.schema !== APPLICATION_SCHEMA) {
    throw new Error(`Unsupported application schema ${information.schema}.`);
  }
  const bound = options.revision !== undefined || options.confirmedAt !== undefined;
  if (bound && (!Number.isInteger(options.revision) || options.revision < 1 || !options.confirmedAt)) {
    throw new Error('A snapshot binding needs both a positive confirmed revision and confirmedAt.');
  }
  const timestamp = bound ? options.confirmedAt : UNBOUND_DATE;
  const app = pruneToVisible(includeAnsweredSections(normalizeApplication(information)));
  const profile = createHouseholdProfile({
    profileId: options.profileId ?? 'profile_application', nowIso: timestamp,
    calculationDateIso: options.calculationDateIso ?? timestamp.slice(0, 10)
  });
  profile.revision = options.revision ?? 0;
  if (bound) profile.confirmedAt = timestamp;
  const application = {
    schema: APPLICATION_SCHEMA, version: APPLICATION_SCHEMA_VERSION,
    mappingVersion: APPLICATION_PROFILE_MAPPING_VERSION, snapshotBound: bound,
    ...(bound ? { revision: options.revision } : {}),
    unsurePaths: [...app.unsure], unmappedFields: []
  };
  profile.assumptions.values.application = application;
  const consumed = new Set();
  const skipped = new Map();
  const records = new Map();
  const instances = listVisibleFields(app);

  function put(path, value, paths, derivation, consume = true) {
    if (!present(value)) return;
    const tokens = path.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
    let target = profile;
    for (const token of tokens.slice(0, -1)) target = target[token] ??= {};
    target[tokens.at(-1)] = value;
    profile.fieldMetadata[path] = {
      source: derivation ? 'calculated' : 'imported', confidence: 'high',
      certainty: derivation ? 'inferred' : 'exact', capturedAt: timestamp,
      confirmedByUser: bound && !derivation,
      application: {
        schema: application.schema, version: application.version,
        mappingVersion: application.mappingVersion,
        ...(bound ? { revision: options.revision } : {}),
        paths: [...new Set(paths)], ...(derivation ? { derivation } : {})
      }
    };
    if (consume) paths.forEach(path => consumed.add(path));
  }
  function record(collection, key, seed, paths) {
    const identity = `${collection}:${key}`;
    if (!records.has(identity)) {
      const index = profile[collection].length;
      profile[collection].push(seed);
      records.set(identity, index);
      put(`/${collection}/${index}`, seed, paths, 'Stable record identity and profile vocabulary derived from this form record; unspecified ownership stays empty.', false);
    }
    return records.get(identity);
  }
  function goal(type, paths) {
    return record('goals', type, {
      goalId: `goal_application_${type}`, type, title: getGoalTitle(type),
      priority: 'medium', status: 'active'
    }, paths);
  }
  // A couple's asset/debt ownership was not asked. Empty ownerIds does not
  // assert that they own it jointly. A sole applicant is the only named owner.
  const owners = app.household?.partner === 'no' ? ['primary'] : [];
  if (app.household?.partner === 'yes') {
    put('/partner', { personId: 'partner', role: 'partner' }, ['household.partner'], 'The form explicitly includes a separate partner.');
  }
  for (const [formKey, profileKey] of [['partner', 'planningWithPartner'], ['children', 'hasChildren'], ['married', 'married']]) {
    const path = `household.${formKey}`;
    if (['yes', 'no'].includes(getPath(app, path))) put(`/household/${profileKey}`, getPath(app, path) === 'yes', [path]);
  }
  for (const topic of app.topics) {
    const type = TOPICS.find(item => item.id === topic)?.goalTypes[0];
    const sourceIndex = information.topics.indexOf(topic);
    if (type) goal(type, [`topics.${sourceIndex}`]);
  }
  const none = (collection, paths) => put(
    `/assumptions/values/completionFacts/confirmedNonePaths/${collection.replaceAll('/', '~1')}`,
    true, paths
  );
  if (app.household?.children === 'no') none('/dependants', ['household.children']);
  app.none.forEach(id => {
    // "No loans" covers the loan repeater, not a mortgage or a credit card.
    none(id === 'loans' ? '/liabilities/loan' : `/${id}`, [`none.${information.none.indexOf(id)}`]);
  });

  function concretePath(instance) {
    const { path, field, index, item, section } = instance;
    const template = field.profilePath;
    if (!template.includes('*')) return template;
    const collection = template.split('/')[1];
    let key, seed, sources = [path];
    if (collection === 'dependants') {
      key = index; seed = { dependantId: `child_application_${index}` };
    } else if (collection === 'incomeSources') {
      const partner = path === 'income.partnerGross';
      key = partner ? 'partner' : 'primary';
      const workPath = partner ? 'income.partnerWork' : 'income.work';
      const work = getPath(app, workPath);
      const type = work === 'self_employed' ? 'self_employment'
        : ['employee', 'director'].includes(work) ? 'employment' : 'other';
      seed = { incomeId: `income_application_${key}`, ownerIds: [key], type, label: `${partner ? 'Partner' : 'Applicant'} gross pay` };
      if (present(work)) sources.push(workPath);
    } else if (collection === 'assets') {
      key = path.split('.')[1];
      seed = { assetId: `asset_application_${key}`, ownerIds: [...owners], type: key === 'cash' ? 'cash' : 'investment', label: field.short };
    } else if (collection === 'properties') {
      key = path === 'home.value' ? 'home' : index;
      seed = { propertyId: `property_application_${key}`, ownerIds: [...owners], use: key === 'home' ? 'home' : 'other', associatedLiabilityIds: [] };
      if (key === 'home') sources.push('home.status');
    } else if (collection === 'liabilities') {
      key = section.id === 'mortgage' ? 'home_mortgage' : `loan_${index}`;
      seed = { liabilityId: `liability_application_${key}`, ownerIds: [...owners], type: section.id === 'mortgage' ? 'mortgage' : 'loan', label: section.id === 'mortgage' ? 'Home mortgage' : `Loan ${index + 1}` };
    } else if (collection === 'pensions') {
      key = index;
      if (app.household?.partner === 'yes' && !item.owner) {
        skipped.set(path, 'The pension owner is missing; a pension must belong to one named person.');
        return null;
      }
      const type = { company: 'occupational', public: 'defined_benefit', prsa: 'prsa', personal: 'personal', bond: 'buyout_bond', unsure: 'other' }[item.type] ?? 'other';
      seed = { pensionId: `pension_application_${index}`, ownerId: item.owner === 'partner' ? 'partner' : 'primary', type };
      sources = [...(item.owner ? [`pensions.${index}.owner`] : app.household?.partner ? ['household.partner'] : []), ...(item.type ? [`pensions.${index}.type`] : []), path];
    } else {
      throw new Error(`No collection resolver for ${template}.`);
    }
    if (['assets', 'liabilities', 'properties'].includes(collection) && app.household?.partner) sources.push('household.partner');
    const position = record(collection, key, seed, sources);
    if (collection === 'pensions' && item.owner) consumed.add(`pensions.${index}.owner`);
    return template.replace('*', position);
  }

  // Keep partially answered records: a college plan without an age and a loan
  // type without a balance still describe a real child/loan with missing facts.
  const initialized = new Set();
  for (const instance of instances) {
    if (!instance.section.repeater) continue;
    const identity = `${instance.section.id}:${instance.index}`;
    if (initialized.has(identity)) continue;
    const prefix = `${instance.section.repeater.path}.${instance.index}.`;
    const evidence = instances.find(candidate => candidate.path.startsWith(prefix) && present(getPath(app, candidate.path)));
    const uncertain = app.unsure.find(path => path.startsWith(prefix));
    if (!evidence && !uncertain) continue;
    const marked = instance.section.repeater.fields.find(field => field.profilePath);
    concretePath({ ...(evidence ?? instance), path: evidence?.path ?? uncertain, field: { ...marked } });
    initialized.add(identity);
  }
  if (['mortgage', 'owned'].includes(app.home?.status)) {
    record('properties', 'home', { propertyId: 'property_application_home', ownerIds: [...owners], use: 'home', associatedLiabilityIds: [] }, ['home.status', ...(app.household?.partner ? ['household.partner'] : [])]);
    consumed.add('home.status');
  }
  if (app.home?.status === 'mortgage') {
    record('liabilities', 'home_mortgage', { liabilityId: 'liability_application_home_mortgage', ownerIds: [...owners], type: 'mortgage', label: 'Home mortgage' }, ['home.status', ...(app.household?.partner ? ['household.partner'] : [])]);
  }

  for (const instance of instances) {
    const { path, field, item } = instance;
    const raw = getPath(app, path);
    if (!field.profilePath || !present(raw)) continue;
    const destination = concretePath(instance);
    if (!destination) continue;
    let value = raw, derivation, sources = [path];
    if (field.type === 'money') value = money(raw);
    if (field.type === 'percent') { value = raw / 100; derivation = 'Form percentage / 100; even rates below 1 are percentages.'; }
    if (field.type === 'years') {
      value = Math.round(raw * 12); derivation = 'Remaining years × 12, rounded to the nearest whole month.';
      if (value < 1) { skipped.set(path, 'A zero remaining term cannot be represented as an active profile debt term.'); continue; }
    }
    if (destination.endsWith('/employmentStatus')) {
      value = { director: 'other', not_working: 'other' }[raw] ?? raw;
      if (value !== raw) derivation = `${raw} uses the profile employment status other; no employee or self-employment status is assumed.`;
    }
    if (destination.endsWith('/intendedRetirementAge')) {
      const age = destination.startsWith('/partner/') ? app.household?.partnerAge : app.household?.age;
      if (typeof age === 'number' && raw < age) { skipped.set(path, 'The stated retirement age is below the current age; review the timeline.'); continue; }
    }
    if (field.type === 'contribution') {
      const unitPath = path.replace(/[^.]+$/, field.unitKey);
      const salaryPath = item.owner === 'partner' ? 'income.partnerGross' : 'income.gross';
      if (present(getPath(information, unitPath))) sources.push(unitPath);
      if (item[field.unitKey] === 'eur') {
        const salary = getPath(app, salaryPath);
        if (!(salary > 0) || raw * 12 > salary) {
          skipped.set(path, 'Monthly euro contributions need the owner’s positive annual salary and a derived rate no greater than 100%.');
          continue;
        }
        value = raw * 12 / salary;
        sources.push(salaryPath);
        derivation = 'Monthly contribution × 12 / this pension owner’s gross annual pay.';
      } else { value = raw / 100; derivation = 'Explicit percentage contribution / 100.'; }
    }
    if (field.key === 'type' && instance.section.id === 'pensions') {
      value = profile.pensions[Number(destination.split('/')[2])].type;
      derivation = `Form pension type ${raw} mapped to canonical type ${value}.`;
    }
    if (field.key === 'contributing') value = raw === 'yes' ? 'active' : 'paid_up';
    put(destination, value, sources, derivation);
  }

  const extra = (formPath, profilePath, transform = value => value, derivation) => {
    const value = getPath(app, formPath);
    if (present(value)) put(profilePath, transform(value), [formPath], derivation);
  };
  extra('income.takeHome', '/householdIncome/netAnnual', value => money(value * 12), 'Household monthly take-home × 12. It is never split into invented individual salaries.');
  extra('retirement.income', semanticPath('target_retirement_income'));
  // The question says "you". It does not establish the partner’s entitlement.
  if (app.retirement?.statePension === 'yes') {
    put(semanticPath('state_pension_fraction').replace('*', 'primary'), 1, ['retirement.statePension'], 'The applicant expects the full State Pension: fraction 1. This says nothing about the partner.');
  }
  if (present(app.buying?.price)) extra('buying.price', `/goals/${goal('buy_home', ['buying.price'])}/targetAmount`, money);
  if (app.buying?.firstTime === 'yes') extra('buying.firstTime', semanticPath('lending_category'), () => 'first_time_buyer');
  extra('spending.saved', '/assumptions/values/housePurchase/currentMonthlySavings');
  if (present(app.mortgage?.repayment)) extra('mortgage.repayment', '/assumptions/values/mortgage/fixedPaymentAmount');
  if (app.mortgage?.overpaying === 'no') put('/assumptions/values/mortgage/annualOverpayment', 0, ['mortgage.overpaying']);
  if (app.mortgage?.overpaying === 'yes' && present(app.mortgage.overpayment)) put('/assumptions/values/mortgage/annualOverpayment', app.mortgage.overpayment * 12, ['mortgage.overpaying', 'mortgage.overpayment'], 'Stated monthly extra mortgage payment × 12.');

  profile.dependants.forEach((child) => {
    const index = Number(child.dependantId.split('_').at(-1));
    const path = `children.${index}.collegePlan`;
    const scenario = { home: 'living_at_home', away: 'living_away' }[getPath(app, path)];
    if (scenario) put(`/assumptions/values/collegeFunding/scenarioByChild/${child.dependantId}`, scenario, [path]);
  });
  profile.pensions.forEach((pension, index) => {
    if (NON_CONTRIBUTORY_PENSION_TYPES.includes(pension.type)) {
      const sourceIndex = pension.pensionId.split('_').at(-1);
      put(`/pensions/${index}/contributionStatus`, 'not_applicable', [`pensions.${sourceIndex}.type`], 'The existing pension contract excludes contributions to defined-benefit pensions and buy-out bonds.');
    }
  });
  profile.liabilities.forEach((liability, index) => {
    if (liability.type !== 'loan') return;
    const sourceIndex = liability.liabilityId.split('_').at(-1);
    const path = `loans.${sourceIndex}.type`;
    const type = getPath(app, path);
    if (type) put(`/liabilities/${index}/label`, `${type.replaceAll('_', ' ')} loan`, [path]);
  });
  const home = profile.properties.find(property => property.use === 'home');
  const homeDebt = profile.liabilities.find(liability => liability.liabilityId === 'liability_application_home_mortgage');
  if (home && homeDebt) put(`/properties/${profile.properties.indexOf(home)}/associatedLiabilityIds`, [homeDebt.liabilityId], ['home.status'], 'The mortgage section describes this home’s mortgage.');

  // Other-property debts have a place even though the form did not mark them.
  (app.properties || []).forEach((property, sourceIndex) => {
    const prefix = `properties.${sourceIndex}`;
    if (property.mortgage > 0) {
      const index = record('liabilities', `property_${sourceIndex}`, { liabilityId: `liability_application_property_${sourceIndex}`, ownerIds: [...owners], type: 'mortgage', label: `Other property ${sourceIndex + 1} mortgage` }, [`${prefix}.mortgage`, ...(app.household?.partner ? ['household.partner'] : [])]);
      put(`/liabilities/${index}/currentBalance`, money(property.mortgage), [`${prefix}.mortgage`]);
      if (present(property.rate)) put(`/liabilities/${index}/annualInterestRate`, property.rate / 100, [`${prefix}.rate`], 'Form percentage / 100.');
      const position = profile.properties.findIndex(item => item.propertyId === `property_application_${sourceIndex}`);
      if (position >= 0) put(`/properties/${position}/associatedLiabilityIds`, [profile.liabilities[index].liabilityId], [`${prefix}.mortgage`]);
    } else if (property.mortgage === 0) {
      const position = profile.properties.findIndex(item => item.propertyId === `property_application_${sourceIndex}`);
      if (position >= 0) put(`/properties/${position}/associatedLiabilityIds`, [], [`${prefix}.mortgage`], 'Explicit zero mortgage: no associated property debt.');
    }
    // A rental income needs actual owners. Do not invent a joint income for a
    // couple, nor turn gross rent minus costs into tax-engine rental profit.
    if (present(property.rent) && owners.length === 1) {
      const index = record('incomeSources', `property_${sourceIndex}`, { incomeId: `income_application_property_${sourceIndex}`, ownerIds: [...owners], type: 'rental', label: `Other property ${sourceIndex + 1} gross rent` }, [`${prefix}.rent`, 'household.partner']);
      put(`/incomeSources/${index}/grossAnnual`, money(property.rent), [`${prefix}.rent`]);
    }
  });
  if (app.creditCard?.clears === 'no') {
    const index = record('liabilities', 'credit_card', { liabilityId: 'liability_application_credit_card', ownerIds: [...owners], type: 'credit_card', label: 'Uncleared credit card' }, ['creditCard.clears', ...(app.household?.partner ? ['household.partner'] : [])]);
    extra('creditCard.balance', `/liabilities/${index}/currentBalance`, money);
  } else if (['yes', 'none'].includes(app.creditCard?.clears)) none('/liabilities/credit_card', ['creditCard.clears']);

  const spending = app.spending?.spend;
  const housingPath = { rent: 'home.rent', mortgage: 'mortgage.repayment' }[app.home?.status];
  const housing = housingPath ? getPath(app, housingPath) : ['owned', 'family'].includes(app.home?.status) ? 0 : undefined;
  const extraPayment = app.mortgage?.overpaying === 'yes' ? app.mortgage.overpayment : 0;
  if (present(spending) && present(housing) && present(extraPayment)) {
    put(semanticPath('annual_net_spending'), money(Math.round((spending + housing + extraPayment) * 1200) / 100),
      ['spending.spend', 'home.status', ...(housingPath ? [housingPath] : []), ...(app.mortgage?.overpaying === 'yes' ? ['mortgage.overpayment'] : [])],
      '(Spending excluding rent/mortgage + stated rent or scheduled mortgage repayment + any stated extra mortgage payment) × 12. Owned outright/living with family adds no housing debt payment. Other loan/card payments are already within the stated spending question and are not added again.');
  }

  // Only mark an answer consumed when its own destination was written. Record
  // creation also cites identity inputs; those may still need explicit review.
  const noDestination = {
    question: 'Free text needs the later analyst; it is not parsed into facts.', upcoming: 'No structured dated-cost timeline is collected.',
    goodOutcome: 'Free text does not establish numerical goal flexibility.', worries: 'No structured profile field for this free text.',
    'children.*.saved': 'No profile earmarking field; this may already be included in total cash, so it is not added again.',
    'children.*.collegePlan': 'Not sure does not select living at home or away; no scenario is chosen.',
    'properties.*.costs': 'No property running-cost field in HouseholdProfile v1.',
    'properties.*.rent': 'Rental ownership is missing; the profile requires named income owners.',
    'retirement.statePension': 'Partly/not sure does not specify a numeric State Pension fraction.',
    'buying.deposit': 'May overlap total cash; no separate deposit earmarking field.',
    'buying.when': 'A relative time range is not an exact goal target date.',
    'mortgage.rateType': 'No mortgage rate-type field in HouseholdProfile v1.',
    'mortgage.fixedEnds': 'No fixed-rate expiry field in HouseholdProfile v1.',
    'mortgage.trackerMargin': 'No tracker-margin field in HouseholdProfile v1.',
    'mortgage.lender': 'No lender field in the planning profile.',
    'cover.life': 'Cover presence does not establish whether this mortgage clears on death.',
    'cover.incomeProtection': 'Cover presence does not specify an insured benefit.'
  };
  for (const { path } of instances) {
    if (!present(getPath(app, path))) continue;
    const reason = skipped.get(path);
    if (reason || !consumed.has(path)) {
      application.unmappedFields.push({
        path, reason: reason || noDestination[path.replace(/\.\d+\./g, '.*.')] || noDestination[path] || 'No unambiguous canonical profile field for this answer.',
        schema: application.schema, version: application.version,
        ...(bound ? { revision: options.revision } : {})
      });
    }
  }
  const normalized = normalizeHouseholdProfile(profile);
  normalized.missingInformation = planFactsMissing(normalized).map(({ fieldPath, reason, blockingModuleIds, importance }) => ({ fieldPath, reason, blockingModuleIds, importance }));
  return normalized;
}

export { planFactsMissing } from './plan_facts_missing.js';
