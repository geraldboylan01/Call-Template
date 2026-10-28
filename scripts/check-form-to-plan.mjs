import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { applicationToProfile } from '../js/planning/application_to_profile.js';
import { profileToPlanPack } from '../js/planning/profile_to_plan_pack.js';
import { compilePlanPack } from '../js/planning/plan_pack/compiler.js';
import { normalizePlanPack } from '../js/planning/plan_pack/schema.js';
import { checkCasePack } from '../js/module_pipeline.js';
import { computeHouseholdCashFlowProjection } from '../js/household_cash_flow_math.js';
import { getPersonalBalanceSheetReadiness } from '../js/planning/adapters/personal_balance_sheet.js';
import { checkFormToPlanRoutes } from './check-form-to-plan-routes.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/form-to-profile.households.json', import.meta.url), 'utf8'));
const expectedUrl = new URL('./fixtures/form-to-plan.expected.json', import.meta.url);
const confirmedAt = '2026-10-20T12:00:00.000Z';
const bind = { revision: 7, confirmedAt, calculationDateIso: '2040-01-01' };
const options = { confirmedRevision: 7, clientLabel: 'Invented example' };
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} != ${b}`);
const originalInfo = console.info;
console.info = () => {}; // Native render diagnostics do not belong in the JSON report.
const assembled = [], compiled = [], profiles = [], reports = [];
const entry = (result, chapter) => result.chapters.find(row => row.id === chapter)?.cases[0];
for (const fixture of fixtures) {
  const information = freeze(fixture.information);
  const profile = freeze(applicationToProfile(information, { ...bind, profileId: `profile_${fixture.id}` }));
  const before = JSON.stringify(profile);
  const result = await profileToPlanPack(profile, { ...options, clientLabel: fixture.id });
  assert.equal(JSON.stringify(profile), before, 'Assembly leaves the confirmed source untouched');
  assert.deepEqual(result, await profileToPlanPack(profile, { ...options, clientLabel: fixture.id }));
  assert.equal(result.omittedChapters.length + (result.planPack?.chapters.length ?? 0), 11);
  assert.ok(result.omittedChapters.every(row => row.reasons.length && row.reasons.every(reason => reason.fieldPath && reason.reason)));
  assert.ok(result.missingFacts.every(fact => fact.fieldPath && fact.reason));
  for (const chapter of ['goals_and_resources']) {
    assert.ok(result.omittedChapters.some(row => row.chapter === chapter && row.reasons.some(reason => reason.code === 'requires_profile_adapter')));
  }
  // Protection is built from the profile now (the Illness Benefit default): it is either in the plan or left out for a missing fact, never for a missing adapter.
  assert.ok(result.planPack?.chapters.includes('protection_gap')
    || result.omittedChapters.some(row => row.chapter === 'protection_gap' && row.reasons.every(reason => reason.code !== 'requires_profile_adapter')));
  let current = null;
  if (result.planPack) {
    assert.deepEqual(result.planPack, normalizePlanPack(result.planPack));
    assert.equal(result.planPack.calculationDate, '2026-10-20', 'Confirmation date wins over the old profile calculation date');
    assert.equal(result.planPack.household.assumptions.calculationDateIso, result.planPack.calculationDate);
    assert.deepEqual(result.planPack.routes, [{ id: 'current', changes: [] }]);
    assert.deepEqual(result.planPack.goalFlexibility, {}, 'No invented movement bounds');
    assert.equal(result.planPack.planningInputs.leftOverEachYear, undefined, 'No guessed annual surplus');
    current = await compilePlanPack(freeze(result.planPack), result.compileOptions);
    assert.equal(current.status, 'compiled', JSON.stringify(current.diagnostics));
    assert.deepEqual(current.chapters.map(row => row.id), result.planPack.chapters);
    assert.equal(current.routes.length, 1);
    assert.equal(current.casePacks.length, 1);
    assert.ok(checkCasePack(current.casePacks[0].casePack).ok);
    const ledger = current.resourceLedger.routes[0];
    assert.equal(ledger.currentPositionUnchanged, true);
    assert.equal(ledger.cashAllocated, 0);
    assert.equal(ledger.cashRemaining, ledger.openingCash);
    assert.equal(ledger.goalFundingStatus, 'not_priced');
    assert.equal(ledger.balanced, undefined, 'A current-resource summary cannot claim an affordable plan');
    assert.equal(ledger.goalsCovered, undefined);
    assert.ok(ledger.goals.every(goal => goal.status === 'not_priced'));
    if (result.planPack.chapters.includes('household_cash_flow')) close(ledger.baselineLeftOver, entry(current, 'household_cash_flow').metrics.leftOver);
    for (const diagnostic of ledger.diagnostics) assert.ok(result.missingFacts.some(fact => fact.fieldPath === diagnostic.path));
  }
  reports.push({
    id: fixture.id, description: fixture.description,
    calculationDate: result.planPack?.calculationDate ?? null,
    chaptersCompiled: current?.chapters.map(row => row.id) ?? [],
    chaptersLeftOut: result.omittedChapters,
    currentPosition: current ? { status: current.status, scope: current.scope, ledger: current.resourceLedger.routes[0] } : {
      status: 'missing_information', scope: 'No chapter has enough facts to compile.', ledger: null
    },
    missingFacts: result.missingFacts,
    planningInputs: result.planPack?.planningInputs ?? null,
    planningInputSources: result.provenance,
    chapterAssumptions: current?.chapters.map(row => ({ chapter: row.id, assumptions: row.cases[0].assumptionsUsed, warnings: row.cases[0].warnings })) ?? []
  });
  profiles.push(profile); assembled.push(result); compiled.push(current);
}
const core = ['household_cash_flow', 'personal_balance_sheet', 'liquidity_analysis', 'pension_projection'];
for (const index of [1, 2]) for (const chapter of core) assert.ok(assembled[index].planPack.chapters.includes(chapter), `${fixtures[index].id} needs ${chapter}`);
assert.equal(assembled[1].planPack.planningInputs.householdTaxStatus, 'married_or_civil_partners');
assert.equal(assembled[2].planPack.planningInputs.householdTaxStatus, 'single');
assert.ok(assembled[0].missingFacts.some(fact => fact.factId === 'single_or_widowed'));
assert.equal(assembled[0].planPack.planningInputs.householdTaxStatus, undefined);
assert.equal(assembled[4].planPack, null);
assert.equal(compiled[0].resourceLedger.routes[0].baselineLeftOver, null);
assert.equal(compiled[3].resourceLedger.routes[0].openingCash, 0, 'Known zero cash is not missing');
assert.ok(assembled[3].omittedChapters.find(row => row.chapter === 'loan_analysis').reasons.some(reason => /loan\/liabilityId/.test(reason.fieldPath)));

// Today's scheduled repayment and separately stated extra are paid once.
const mortgage = entry(compiled[1], 'mortgage_analysis');
assert.equal(mortgage.input.fixedPaymentAmount, 1800);
assert.equal(mortgage.input.oneOffOverpayment, 0);
assert.equal(mortgage.input.annualOverpayment, 0);
assert.equal(profiles[1].liabilities[0].monthlyPayment.amount, 1600, 'Preserve the confirmed input profile');
assert.equal(assembled[1].planPack.household.liabilities[0].monthlyPayment.amount, 1800);
assert.equal(assembled[1].planPack.household.assumptions.values.mortgage.scheduledMonthlyPayment, 1600);
assert.equal(assembled[1].planPack.household.assumptions.values.mortgage.currentAnnualOverpayment, 2400);
assert.equal(assembled[1].planPack.household.assumptions.values.mortgage.annualOverpayment, undefined, 'Current money cannot remain in a proposed-change setting');
const flow = entry(compiled[1], 'household_cash_flow');
assert.equal(flow.input.outgoings.find(row => row.id === 'debt_0').amount, 21600);
assert.equal(flow.input.outgoings.find(row => row.id === 'living').amount, 46800);
assert.equal(flow.input.outgoings.find(row => row.id === 'living').label, 'Spending and saving', 'Copy the form heading verbatim');
close(flow.input.people[0].personalPensionContribution, 6560);
close(flow.input.people[1].personalPensionContribution, 2400);
assert.ok(flow.input.people.every(person => person.statedTakeHome === undefined), 'Do not split a household net total into individual pay');
assert.equal(flow.basis, 'includes_estimated_bank_pay');
const nativeFlow = computeHouseholdCashFlowProjection(flow.input, { calculationYear: 2026 });
close(nativeFlow.summary.cases[0].outgoings.statedTotal, 68400);
close(nativeFlow.summary.cases[0].leftOver.amount, compiled[1].resourceLedger.routes[0].baselineLeftOver);
assert.equal(entry(compiled[1], 'pension_projection').input.householdTaxStatus, 'married_or_civil_partners');
assert.equal(entry(compiled[1], 'pension_projection').input.targetIncomeBasis, 'gross', 'The form explicitly asks before-tax retirement income');
assert.deepEqual(entry(compiled[1], 'college_funding').input.children.map(child => child.scenarioId), ['living_away', 'living_at_home']);
const dbId = profiles[2].pensions.find(pension => pension.type === 'defined_benefit').pensionId;
const balance = entry(compiled[2], 'personal_balance_sheet');
assert.ok(!balance.input.assetPositions.some(asset => asset.id === dbId), 'A DB promise without a capital value is not a zero-valued pot');
assert.ok(balance.warnings.some(warning => warning.includes('not capitalised')));
assert.ok(entry(compiled[2], 'pension_projection').warnings.some(warning => warning.includes('not a confirmed entitlement')));
assert.equal(profiles[2].pensions.find(pension => pension.type === 'defined_benefit').currentValue, undefined);
const dbOnly = structuredClone(profiles[2]);
dbOnly.assets = []; dbOnly.properties = []; dbOnly.pensions = dbOnly.pensions.filter(pension => pension.type === 'defined_benefit');
assert.ok(getPersonalBalanceSheetReadiness(dbOnly).requiredMissing.some(fact => fact.fieldPath === '/assets'), 'A DB entitlement alone cannot establish zero capital assets');

// Later explicit answers can resolve single/widowed and builder selections.
async function withTax(status) {
  const profile = structuredClone(profiles[0]);
  profile.assumptions.values.planPack = { planningInputs: { householdTaxStatus: status } };
  const assembly = await profileToPlanPack(profile, options);
  return { assembly, result: await compilePlanPack(assembly.planPack, assembly.compileOptions) };
}
const single = await withTax('single'), widowed = await withTax('widowed_or_surviving_civil_partner');
assert.ok(single.assembly.planPack.chapters.includes('household_cash_flow'));
assert.ok(widowed.result.resourceLedger.routes[0].baselineLeftOver > single.result.resourceLedger.routes[0].baselineLeftOver, 'The surviving-partner credit must reach the shared tax engine');
const selectedLoan = structuredClone(profiles[3]);
selectedLoan.assumptions.values.loan = { liabilityId: selectedLoan.liabilities[0].liabilityId };
const selected = await profileToPlanPack(selectedLoan, options);
assert.ok(selected.planPack.chapters.includes('loan_analysis'));
const unknownInvestmentOwner = structuredClone(profiles[1]);
const investment = unknownInvestmentOwner.assets.find(asset => asset.type === 'investment');
investment.investmentTaxTreatment = 'ordinary_cgt';
assert.equal(investment.ownerIds.length, 0);
const withHolding = await profileToPlanPack(unknownInvestmentOwner, options);
const holdingResult = await compilePlanPack(withHolding.planPack, withHolding.compileOptions);
assert.equal(holdingResult.status, 'compiled', 'Current holdings must not require hypothetical sale ownership/tax facts');
assert.equal(holdingResult.resourceLedger.routes[0].investments.potentialSale, null);
assert.equal(holdingResult.resourceLedger.routes[0].investments.potentialSaleStatus, 'not_priced_in_current_position_mode');
const earmarked = structuredClone(profiles[1]);
earmarked.assumptions.values.planPack = { planningInputs: { assetAssignments: [{
  assetId: earmarked.assets.find(asset => asset.type === 'cash').assetId,
  goalId: earmarked.goals.find(goal => goal.type === 'fund_education').goalId
}] } };
const earmarkAssembly = await profileToPlanPack(earmarked, options);
const earmarkResult = await compilePlanPack(earmarkAssembly.planPack, earmarkAssembly.compileOptions);
assert.equal(earmarkResult.status, 'compiled');
const earmarkLedger = earmarkResult.resourceLedger.routes[0];
assert.equal(earmarkLedger.recordedCash, 50000);
assert.equal(earmarkLedger.openingCash, 0);
assert.equal(earmarkLedger.cashAvailableAfterReserve, 0, 'Existing goal earmarks cannot also fund the reserve or another goal');
assert.equal(entry(earmarkResult, 'liquidity_analysis').input.currentCash, 0);
assert.equal(entry(earmarkResult, 'personal_balance_sheet').input.assetPositions.find(asset => asset.source === 'plan_goal_funding').amount, 50000);
const net = structuredClone(profiles[0]);
net.incomeSources[0].netAnnual = { amount: 37000, currency: 'EUR' };
net.incomeSources[0].startAge = 31; net.incomeSources[0].endAge = 67;
net.assumptions.values.planPack = { planningInputs: { householdTaxStatus: 'single', takeHomeBasis: 'after_personal_pension' } };
const netAssembly = await profileToPlanPack(net, options);
assert.ok(netAssembly.planPack.chapters.includes('net_retirement_cashflow'));
const netResult = await compilePlanPack(netAssembly.planPack, netAssembly.compileOptions);
assert.equal(netResult.status, 'compiled');
assert.equal(entry(netResult, 'net_retirement_cashflow').input.incomeSources[0].annualAmountToday, 37000);
const changedDate = await profileToPlanPack(profiles[1], { ...options, calculationDate: '2027-02-01' });
assert.equal(changedDate.planPack.calculationDate, '2027-02-01');
const dated = await compilePlanPack(changedDate.planPack, changedDate.compileOptions);
assert.equal(entry(dated, 'mortgage_analysis').input.startDateIso, '2027-02-01');
assert.equal(entry(dated, 'college_funding').input.currentYear, 2027);
assert.equal((await profileToPlanPack(profiles[1], { ...options, confirmedRevision: 8 })).planPack, null);
assert.equal((await profileToPlanPack(profiles[1], { ...options, calculationDate: '2026-02-30' })).planPack, null);
const unbound = applicationToProfile(fixtures[1].information);
assert.equal((await profileToPlanPack(unbound, options)).planPack, null);
const conflict = structuredClone(profiles[1]);
conflict.assumptions.values.planPack = { planningInputs: { householdTaxStatus: 'single' } };
assert.equal((await profileToPlanPack(conflict, options)).planPack, null);
const alternative = structuredClone(assembled[1].planPack);
alternative.routes.push({ id: 'alternative' });
assert.equal((await compilePlanPack(alternative, assembled[1].compileOptions)).status, 'invalid', 'Current-resource mode cannot validate alternatives');
assert.equal((await compilePlanPack(assembled[1].planPack, { currentPositionOnly: true })).status, 'invalid');
const noLabel = structuredClone(net);
delete noLabel.assumptions.values.application;
delete noLabel.assumptions.values.planPack.planningInputs.spendingLabel;
const missingLabel = await profileToPlanPack(noLabel, options);
assert.ok(missingLabel.omittedChapters.some(row => row.chapter === 'household_cash_flow'));
assert.ok(missingLabel.missingFacts.some(fact => fact.fieldPath === '/planningInputs/spendingLabel'));
const repeated = await compilePlanPack(assembled[1].planPack, assembled[1].compileOptions);
assert.deepEqual(repeated, compiled[1], 'A-B-A compilation leaves both the source and the common engine state unchanged');

// A complete B1 pack proves why the goals screen is still unavailable: not a
// missing ledger, but the missing exact screen adapter after the ledger runs.
const b1 = JSON.parse(readFileSync(new URL('./fixtures/plan-packs/valid-b1.json', import.meta.url), 'utf8'));
b1.routes = [{ id: 'current' }]; b1.narration = {}; b1.chapters.push('goals_and_resources');
const goalsScreen = await compilePlanPack(b1, { resourceLedger: true });
assert.equal(goalsScreen.resourceLedger.status, 'priced');
assert.ok(goalsScreen.diagnostics.some(row => row.chapter === 'goals_and_resources' && row.code === 'requires_profile_adapter' && row.message.includes('unchanged-current')));

// Different host clocks must not change dates, cases or money.
const RealDate = globalThis.Date;
async function onClock(instant) {
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return RealDate.parse(instant); }
  };
  try { return await profileToPlanPack(profiles[1], options); } finally { globalThis.Date = RealDate; }
}
assert.deepEqual(await onClock('2035-01-01T00:00:00Z'), await onClock('2055-12-31T00:00:00Z'));
if (process.argv.includes('--write-examples')) writeFileSync(expectedUrl, `${JSON.stringify(reports, null, 2)}\n`);
assert.deepEqual(reports, JSON.parse(readFileSync(expectedUrl, 'utf8')), 'The committed current-position report must match');
console.info = originalInfo;
if (!process.argv.includes('--quiet')) for (const report of reports) console.log(JSON.stringify(report, null, 2));
console.log('[FormToPlan] Five invented households passed; confirmation, source preservation, tax status, available chapters and current-resource summaries verified.');
await checkFormToPlanRoutes();
