import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { applicationToProfile, planFactsMissing, APPLICATION_PROFILE_MAPPING_VERSION } from '../js/planning/application_to_profile.js';
import { applyProfilePatch, createProfilePatch, normalizeHouseholdProfile } from '../js/planning/profile.js';
import { getSemanticFactDefinition } from '../js/planning/semantic_facts.js';
import { mapRealtimeFact } from '../worker/src/consumer/realtime_fact_mapper.js';
import { buildCollegeFundingInput } from '../js/planning/adapters/college_funding.js';
import { buildPensionProjectionInput } from '../js/planning/adapters/retirement.js';
import { buildMortgageInput } from '../js/planning/adapters/mortgage.js';
import { readJsonPointer } from '../js/planning/utils.js';

const fixtureUrl = new URL('./fixtures/form-to-profile.households.json', import.meta.url);
const outputUrl = new URL('./fixtures/form-to-profile.expected.json', import.meta.url);
const households = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
const binding = { revision: 7, confirmedAt: '2026-10-20T12:00:00.000Z', calculationDateIso: '2026-10-27' };
const convert = information => applicationToProfile(information, binding);
const hasGap = (profile, factId) => planFactsMissing(profile).some(item => item.factId === factId);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const examples = households.map(({ id, description, information }) => {
  const before = JSON.stringify(information);
  freeze(information);
  const profile = applicationToProfile(information, { ...binding, profileId: `profile_${id}` });
  const missingFacts = planFactsMissing(freeze(profile));
  assert.equal(JSON.stringify(information), before, `${id}: conversion must not mutate answers`);
  assert.deepEqual(profile, normalizeHouseholdProfile(profile), `${id}: output must survive canonical normalization`);
  assert.deepEqual(profile, applicationToProfile(information, { ...binding, profileId: `profile_${id}` }), `${id}: deterministic conversion`);
  assert.deepEqual(profile.missingInformation, missingFacts.map(({ fieldPath, reason, blockingModuleIds, importance }) => ({ fieldPath, reason, blockingModuleIds, importance })));
  for (const [path, metadata] of Object.entries(profile.fieldMetadata)) {
    assert.notEqual(readJsonPointer(profile, path), undefined, `${id}: metadata points to a surviving profile value`);
    assert.equal(metadata.application.schema, 'planeir.application.v1');
    assert.equal(metadata.application.version, 1);
    assert.equal(metadata.application.revision, 7);
    assert.equal(metadata.application.mappingVersion, APPLICATION_PROFILE_MAPPING_VERSION);
    assert.ok(metadata.application.paths.length);
    for (const formPath of metadata.application.paths) {
      assert.notEqual(formPath.split('.').reduce((value, key) => value?.[key], information), undefined,
        `${id}: source ${formPath} actually exists in the confirmed information`);
    }
    if (path.startsWith('/assumptions/values/completionFacts/confirmedNonePaths/')) {
      const formPath = metadata.application.paths[0];
      const raw = formPath.split('.').reduce((value, key) => value?.[key], information);
      if (formPath.startsWith('none.')) assert.ok(path.endsWith(`~1${raw === 'loans' ? 'liabilities~1loan' : raw}`), `${id}: none provenance identifies the actual section in the original saved array`);
    }
  }
  assert.ok(missingFacts.every(item => item.reason && item.factId && item.kind));
  assert.ok(!hasGap(profile, 'confirmed_snapshot'));
  return { id, description, profile, missingFacts };
});
const [renter, family, nearRetirement, borrower, sparse] = examples.map(example => example.profile);
assert.equal(renter.expenses.annualTotal.amount, 33600);
assert.equal(renter.householdIncome.netAnnual.amount, 38400);
assert.equal(renter.incomeSources.length, 1);
assert.deepEqual(renter.incomeSources[0].ownerIds, ['primary']);
assert.ok(!renter.incomeSources[0].netAnnual, 'Household take-home is not an individual salary');
assert.equal(renter.household.married, undefined);
assert.ok(hasGap(renter, 'married_or_civil_partners'), 'Planning without a partner is not a legal marital-status declaration');
assert.ok(!hasGap(renter, 'pension_positions'), 'Explicit no pensions stays distinct from unanswered');
assert.ok(!hasGap(renter, 'loans_presence'));
assert.equal(family.household.married, true);
assert.equal(nearRetirement.household.married, false);
assert.equal(family.expenses.annualTotal.amount, 68400, 'Housing and separately stated overpayment included once');
assert.equal(family.householdIncome.netAnnual.amount, 88800);
assert.deepEqual(family.incomeSources.map(income => income.ownerIds), [['primary'], ['partner']]);
assert.equal(family.liabilities[0].remainingTermMonths, 228);
assert.equal(family.liabilities[0].annualInterestRate, 0.036000000000000004);
assert.equal(family.pensions[0].employeeContributionRate, 0.08);
assert.equal(family.pensions[1].employeeContributionRate, 0.05, 'Euro contribution uses the partner salary');
assert.equal(family.assumptions.values.mortgage.annualOverpayment, 2400);
assert.equal(buildMortgageInput(family).fixedPaymentAmount, 1600);
assert.deepEqual(buildCollegeFundingInput(family).children.map(child => child.scenarioId), ['living_away', 'living_at_home']);
assert.equal(buildPensionProjectionInput(family).pensions[1].personalPct, 0.05);
assert.equal(family.assets.find(asset => asset.type === 'cash').currentValue.amount, 50000, 'Children’s earmarked savings are not added to all-account cash');
assert.ok(hasGap(family, 'mortgage_clear_by'));
assert.ok(hasGap(family, 'mortgage_cleared_on_death'));
assert.ok(hasGap(family, 'goal_flexibility'));
assert.ok(hasGap(family, 'survivor_payment'));
assert.equal(family.assumptions.values.retirement.statePensionFraction.primary, 1);
assert.equal(family.assumptions.values.retirement.statePensionFraction.partner, undefined, 'A singular answer cannot establish the partner’s State Pension');
assert.ok(planFactsMissing(family).some(item => item.factId === 'state_pension_fraction' && item.fieldPath.endsWith('/partner')));
assert.equal(nearRetirement.pensions[1].type, 'defined_benefit');
assert.equal(nearRetirement.pensions[1].projectedAnnualIncome.amount, 22000);
assert.equal(nearRetirement.pensions[1].retirementLumpSum.amount, 66000);
assert.equal(nearRetirement.pensions[2].type, 'buyout_bond');
assert.equal(nearRetirement.pensions[2].contributionStatus, 'not_applicable');
assert.ok(!planFactsMissing(nearRetirement).some(item => item.fieldPath.startsWith('/pensions/2')));
assert.equal(borrower.expenses.annualTotal.amount, 27000, 'Loan/card repayments are already within non-housing spending');
assert.equal(borrower.liabilities[1].annualInterestRate, 0.005, '0.5% must never become 50%');
assert.equal(borrower.liabilities[0].remainingTermMonths, 42);
assert.equal(borrower.liabilities[2].type, 'credit_card');
assert.equal(borrower.liabilities[2].currentBalance.amount, 3200);
assert.ok(!hasGap(borrower, 'cash_savings'), 'An explicit zero is a known value');
assert.ok(hasGap(borrower, 'debt_monthlyPayment'), 'Carried card payment is not asked by the form');
assert.equal(sparse.expenses.annualTotal, undefined);
assert.equal(sparse.household.married, undefined);
assert.equal(sparse.primaryPerson.age, undefined);
assert.equal(sparse.pensions[0].employeeContributionRate, undefined);
assert.equal(sparse.dependants.length, 1, 'Child without age is retained for missing-fact reporting');
assert.ok(hasGap(sparse, 'married_or_civil_partners'));
assert.ok(hasGap(sparse, 'debt_currentBalance'));
assert.ok(hasGap(sparse, 'pension_employee_contribution_rate'));
assert.ok(hasGap(sparse, 'dependant_current_age'));
assert.ok(sparse.assumptions.values.application.unmappedFields.some(item => item.path === 'pensions.0.youPay' && item.reason.includes('salary')));
assert.ok(sparse.assumptions.values.application.unmappedFields.some(item => item.path === 'children.0.collegePlan'));
assert.ok(planFactsMissing(sparse).some(item => item.factId === 'pension_positions' && item.fieldPath.endsWith('/primary')), 'One person’s holding cannot establish that the other has none');

// Reuse the retired lane's semantic identities and canonical values, without
// importing Worker conversation policies into the adapter's browser-safe code.
const annualFact = mapRealtimeFact(renter, { factId: 'annual_net_spending', value: renter.expenses.annualTotal.amount });
assert.equal(annualFact.fieldPath, getSemanticFactDefinition('annual_net_spending').profilePathTemplate);
assert.deepEqual(annualFact.canonicalValue, renter.expenses.annualTotal);
const stateFact = mapRealtimeFact(renter, { factId: 'state_pension_fraction', value: 1 });
assert.equal(stateFact.canonicalValue.statePensionFraction.primary, renter.assumptions.values.retirement.statePensionFraction.primary);
const targetFact = mapRealtimeFact(renter, { factId: 'target_retirement_income', value: 30000 });
assert.equal(targetFact.canonicalValue.targetIncomeToday, renter.assumptions.values.retirement.targetIncomeToday);

// The profile extension and form-source metadata survive the existing patch path.
const patched = applyProfilePatch(family, createProfilePatch([{ op: 'replace', path: '/primaryPerson/age', value: 45,
  provenance: family.fieldMetadata['/primaryPerson/age'] }]), { nowIso: binding.confirmedAt }).profile;
assert.equal(patched.household.married, true);
assert.deepEqual(patched.fieldMetadata['/household/married'].application, family.fieldMetadata['/household/married'].application);
assert.deepEqual(patched.fieldMetadata['/primaryPerson/age'].application, family.fieldMetadata['/primaryPerson/age'].application);
assert.throws(() => normalizeHouseholdProfile({ ...family, household: { married: 'yes' } }), /boolean/);
const nextVersion = applicationToProfile(households[0].information, { ...binding, revision: 8 });
assert.ok(Object.values(nextVersion.fieldMetadata).every(metadata => metadata.application.revision === 8));
assert.equal(renter.fieldMetadata['/expenses/annualTotal'].application.revision, 7, 'Rebinding a later revision cannot change a previous result');
const unbound = applicationToProfile(households[0].information);
assert.deepEqual(unbound, applicationToProfile(households[0].information));
assert.ok(hasGap(unbound, 'confirmed_snapshot'));
assert.equal(unbound.confirmedAt, undefined);
assert.throws(() => applicationToProfile({ schema: 'planeir.application.v2' }), /Unsupported/);
assert.throws(() => applicationToProfile({}, { revision: 1 }), /both/);
assert.throws(() => applicationToProfile({}, { ...binding, revision: 0 }), /both/);

const base = { schema: 'planeir.application.v1', household: { age: 40, partner: 'no', children: 'no' }, income: { gross: 60000, work: 'employee' }, spending: { spend: 0 }, home: { status: 'family' } };
assert.equal(convert(base).expenses.annualTotal.amount, 0);
assert.equal(convert({ ...base, home: { status: 'rent' } }).expenses.annualTotal, undefined, 'Missing rent cannot be zero');
assert.equal(convert({ ...base, home: { status: 'mortgage' }, mortgage: { repayment: 1000, overpaying: 'yes' } }).expenses.annualTotal, undefined, 'An explicitly present but unknown extra repayment prevents a complete total');
const incomplete = convert({ ...base, topics: ['education', 'loans'], household: { age: 40, partner: 'yes', children: 'yes' }, children: [{ collegePlan: 'away' }], loans: [{ type: 'car' }], pensions: [{ type: 'company', value: 20000 }] });
assert.equal(incomplete.dependants.length, 1);
assert.equal(incomplete.liabilities.length, 1);
assert.equal(incomplete.pensions.length, 0, 'Unknown pension owner is never invented');
assert.ok(hasGap(incomplete, 'pension_owner'));
assert.ok(incomplete.assumptions.values.application.unmappedFields.some(item => item.path === 'pensions.0.value'));
const property = convert({ ...base, topics: ['whole'], properties: [{ value: 210000, mortgage: 60000, rent: 12000, costs: 1600, rate: 4.5 }] });
assert.equal(property.properties[0].use, 'other', 'Rental versus holiday use was not asked');
assert.equal(property.incomeSources[1].grossAnnual.amount, 12000);
assert.equal(property.liabilities[0].annualInterestRate, 0.045);
assert.deepEqual(property.properties[0].associatedLiabilityIds, [property.liabilities[0].liabilityId]);
assert.ok(hasGap(property, 'property_plan_facts'));
const coupleProperty = convert({ ...base, topics: ['whole'], household: { partner: 'yes' }, properties: [{ value: 210000, rent: 12000 }] });
assert.ok(coupleProperty.assumptions.values.application.unmappedFields.some(item => item.path === 'properties.0.rent'));
assert.equal(coupleProperty.incomeSources.length, 1, 'No invented rental owner for a couple');
const costsOnly = convert({ ...base, topics: ['whole'], properties: [{ costs: 1000 }], children: [] });
assert.ok(costsOnly.assumptions.values.application.unmappedFields.some(item => item.path === 'properties.0.costs'), 'A value cited for record identity is still unmapped if no value field can hold it');
const zeroPropertyDebt = convert({ ...base, topics: ['whole'], properties: [{ mortgage: 0 }] });
assert.equal(zeroPropertyDebt.liabilities.length, 0);
assert.ok(Object.values(zeroPropertyDebt.fieldMetadata).some(metadata => metadata.application.paths.includes('properties.0.mortgage')));
const reorderedChoices = convert({ ...base, topics: ['discard_me', 'loans'], none: ['loans', 'pensions'] });
assert.deepEqual(reorderedChoices.fieldMetadata['/goals/0'].application.paths, ['topics.1']);
assert.deepEqual(reorderedChoices.fieldMetadata['/assumptions/values/completionFacts/confirmedNonePaths/~1pensions'].application.paths, ['none.1']);
const buying = convert({ ...base, topics: ['buying'], buying: { price: 300000, firstTime: 'yes', deposit: 30000, when: '12m' }, savings: { cash: 30000 } });
assert.equal(buying.goals[0].targetAmount.amount, 300000);
assert.equal(buying.assumptions.values.housePurchase.lendingCategory, 'first_time_buyer');
assert.equal(buying.assets.length, 1, 'Deposit and all-account cash must not be counted twice');
assert.equal(convert({ ...base, income: { work: 'director' } }).primaryPerson.employmentStatus, 'other');
const tinyRate = convert({ ...base, pensions: [{ type: 'company', value: 0, youPay: 0.5, youPayUnit: 'pct', employerPays: 0, contributing: 'yes' }] });
assert.equal(tinyRate.pensions[0].employeeContributionRate, 0.005);
assert.equal(tinyRate.pensions[0].employerContributionRate, 0);
assert.ok(!hasGap(tinyRate, 'pension_current_value'));
const invalidTimeline = convert({ ...base, household: { ...base.household, age: 60 }, retirement: { age: 50 } });
assert.ok(hasGap(invalidTimeline, 'retirement_timeline'));
assert.equal(invalidTimeline.primaryPerson.intendedRetirementAge, undefined);

// A visible yes/no-none choice must retain its narrow scope.
const noLoansWithCard = convert({ ...base, topics: ['loans'], none: ['loans'], creditCard: { clears: 'no', balance: 900 } });
assert.equal(noLoansWithCard.liabilities.length, 1);
assert.equal(noLoansWithCard.liabilities[0].type, 'credit_card');
assert.ok(!hasGap(noLoansWithCard, 'loans_presence'));
const hidden = convert({ ...base, home: { status: 'owned' }, mortgage: { balance: 999999, repayment: 9000 }, household: { partner: 'no', children: 'no', married: 'yes', partnerAge: 44 }, pensions: [{ type: 'bond', value: 10000, youPay: 900, youPayUnit: 'eur' }] });
assert.equal(hidden.liabilities.length, 0, 'Hidden stale mortgage answers must not become facts');
assert.equal(hidden.household.married, undefined);
assert.equal(hidden.pensions[0].employeeContributionRate, undefined);

if (process.argv.includes('--write-examples')) writeFileSync(outputUrl, `${JSON.stringify(examples, null, 2)}\n`);
assert.deepEqual(examples, JSON.parse(readFileSync(outputUrl, 'utf8')), 'The committed full profiles and missing-facts examples must match');
if (process.argv.includes('--show')) console.log(JSON.stringify(examples, null, 2));
console.log(`[FormToProfile] ${examples.length} invented households; profiles, provenance, missing facts, legacy parity and edge cases passed.`);
