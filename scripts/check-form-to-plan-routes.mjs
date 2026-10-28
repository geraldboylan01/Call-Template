import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { applicationToProfile } from '../js/planning/application_to_profile.js';
import { profileToPlanPack } from '../js/planning/profile_to_plan_pack.js';
import { compilePlanPack } from '../js/planning/plan_pack/compiler.js';
import { getLeverCatalogue } from '../js/planning/plan_pack/lever_catalogue.js';
import { PLANEIR_ASSUMPTIONS_VERSION } from '../js/planning/planeir_assumptions.js';
import { computePersonalContributionCosts, computePensionProjection, maxRelievablePersonalContribution } from '../js/pension_math.js';
import { reviewedRouteExample } from './fixtures/form-to-plan-reviewed.mjs';

const options = { confirmedRevision: 7, clientLabel: 'Invented route example' };
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/form-to-profile.households.json', import.meta.url), 'utf8'));
const expectedUrl = new URL('./fixtures/form-to-plan-routes.expected.json', import.meta.url);
const clone = structuredClone;
const fact = path => ({ kind: 'fact', path });
const bounded = path => ({ kind: 'bounded', reason: 'Invented trial within the available range established by ' + path, factPaths: [path] });
const central = path => ({ kind: 'default', path, version: PLANEIR_ASSUMPTIONS_VERSION });
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.011, `${a} != ${b}`);
const route = (id, ...changes) => ({ id, changes });
const spending = amount => ({ type: 'spendLess', annualAmount: amount, sources: { annualAmount: bounded('/household/expenses/annualTotal/amount') } });
const contribution = amount => ({ type: 'pensionContribution', personId: 'primary', annualAmount: amount,
  sources: { personId: fact('/household/primaryPerson/personId'), annualAmount: bounded('/household/incomeSources/0/grossAnnual/amount') } });
const ledger = (result, id) => result.compilation.resourceLedger.routes.find(row => row.routeId === id);
const assemble = (profile, routes) => profileToPlanPack(profile, { ...options, routes });
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function report(result, id) {
  return { id, compiledChapters: result.planPack?.chapters ?? [], omittedChapters: result.omittedChapters,
    status: result.compilation?.status ?? 'missing_information',
    routes: (result.compilation?.routes ?? []).map(row => ({ ...row,
      // Preserve the financial ledger. Native engine input/projection copies
      // are tested below, rather than duplicated in this readable report.
      ledger: (() => { const { pricing, ...financial } = ledger(result, row.id) ?? {}; return financial; })() })),
    refusals: result.routeRefusals ?? [], missingFacts: result.missingFacts };
}
function compiled(result) { assert.equal(result.compilation?.status, 'compiled', JSON.stringify(result.routeRefusals)); return result; }

export async function checkFormToPlanRoutes() {
  const info = console.info;
  console.info = () => {};
  try {
    const reports = [], originals = [];
    const catalogue = getLeverCatalogue();
    assert.deepEqual(catalogue.levers.map(row => row.type), ['useCash', 'clearOutgoing', 'sellAsset', 'moveGoal', 'pensionContribution', 'tradeDownHome', 'sellProperty', 'spendLess']);
    assert.equal(catalogue.levers.find(row => row.type === 'spendLess').scale.approvalStatus, 'proposed');
    catalogue.levers[0].parameters.amount.minimum = -1;
    assert.equal(getLeverCatalogue().levers[0].parameters.amount.minimum, 1, 'Catalogue callers cannot change shared settings');
    assert.equal(getLeverCatalogue().levers[0].parameters.amount.default, 'remaining');
    for (const fixture of fixtures) {
      const profile = freeze(applicationToProfile(fixture.information, { revision: 7, confirmedAt: '2026-10-20T12:00:00.000Z', profileId: `profile_${fixture.id}` }));
      originals.push(profile);
      const full = await assemble(profile, []);
      assert.deepEqual(full.compileOptions, { resourceLedger: true }, 'No current-only downgrade when routes are requested');
      const refusal = await assemble(profile, [route('cut_spending', spending(1000))]);
      assert.ok(refusal.missingFacts.some(row => row.fieldPath === '/household/expenses/monthlyEssential'), 'The v1 spending annotation does not establish essentials');
      reports.push({ ...report(full, fixture.id), spendingTrialRefusals: refusal.routeRefusals ?? refusal.missingFacts });
    }

    // All six priced lever demonstrations start with #97's near-retirement
    // form. The helper lists each explicitly invented supplemental review fact.
    const example = reviewedRouteExample(fixtures[2]);
    const profile = freeze(example.profile);
    const move = age => ({ type: 'moveGoal', goalId: example.retirementGoalId, retirementAge: age,
      sources: { goalId: fact('/household/goals/0/goalId'), retirementAge: bounded('/household/primaryPerson/intendedRetirementAge') } });
    const cash = { type: 'useCash', goalId: example.costId, amount: 1000,
      sources: { goalId: fact('/household/goals/2/goalId'), amount: bounded('/household/assets/0/currentValue/amount') } };
    const clear = { type: 'clearOutgoing', outgoingId: 'debt_0', paidFrom: 'savings',
      sources: { outgoingId: fact('/planningInputs/outgoingBindings/0/id'), paidFrom: central('/routes/clearOutgoingPaidFrom') } };
    const sale = { type: 'sellAsset', assetId: profile.assets[1].assetId, sources: { assetId: fact('/household/assets/1/assetId') } };
    const batches = [
      [route('use_cash', cash), route('clear_loan', clear), route('sell_investment', sale)],
      [route('extra_pension', contribution(1200)), route('spend_less', spending(3000)), route('retire_later', move(66))]
    ];
    const before = JSON.stringify(profile);
    const first = compiled(await assemble(profile, batches[0]));
    const second = compiled(await assemble(profile, batches[1]));
    assert.equal(JSON.stringify(profile), before, 'Routes cannot change the confirmed source');
    for (const result of [first, second]) {
      assert.ok(result.planPack.chapters.includes('future_cost_fund'), 'A supported dated cost reaches its existing chapter');
      assert.deepEqual(result.compilation.resourceLedger.routes.find(row => row.routeId === 'current'), ledger(first, 'current'), 'Every alternative uses the same full-B1 current position');
      for (const row of result.compilation.routes) {
        const l = ledger(result, row.id);
        assert.ok(l.balanced && l.reserveProtected);
        close(row.differencesFromCurrent.cashRemaining.difference, l.cashRemaining - ledger(result, 'current').cashRemaining);
        assert.ok(l.levers.every(lever => Object.keys(lever.parameterSources).length > 0));
      }
    }
    close(ledger(first, 'use_cash').cashAllocated, 1000);
    close(ledger(first, 'clear_loan').cashAllocated, 3000);
    close(ledger(first, 'clear_loan').baselineLeftOver - ledger(first, 'current').baselineLeftOver, 1800);
    assert.ok(ledger(first, 'sell_investment').investmentSales.netProceeds < 50000, 'Sale uses the tax engine rather than its market value as cash');
    close(ledger(second, 'spend_less').baselineLeftOver - ledger(second, 'current').baselineLeftOver, 3000);
    const neutral = compiled(await assemble(profile, [route('same_funding'), route('extra_pension', contribution(1200))]));
    const pension = ledger(neutral, 'extra_pension').pricing.find(row => row.kind === 'retirement');
    const today = pension.priced.currentInput, after = pension.priced.plannedInput;
    const costBefore = computePersonalContributionCosts(today), costAfter = computePersonalContributionCosts(after);
    const netCost = costAfter.years[0].cost - costBefore.years[0].cost;
    assert.ok(netCost > 0 && netCost < 1200, 'Relief lowers the cost of a gross personal contribution');
    close(ledger(neutral, 'same_funding').years[0].remaining - ledger(neutral, 'extra_pension').years[0].remaining, netCost);
    close(pension.priced.projectedPotWithExtra, computePensionProjection(after).debug.projectedPotCurrent);
    assert.ok(pension.priced.projectedPotWithExtra > computePensionProjection(today).debug.projectedPotCurrent);
    const pensionCase = neutral.compilation.chapters.find(row => row.id === 'pension_projection').cases
      .find(row => row.provenance.uses.some(use => use.routeId === 'extra_pension'));
    close(pensionCase.metrics.projectedPot, pension.priced.projectedPotWithExtra);
    close(ledger(neutral, 'extra_pension').annualFunding.pensionChanges[0].amount, 1200);
    const member = today.pensions.find(row => row.id === 'primary');
    const currentGross = costBefore.years[0].members.find(row => row.id === 'primary').gross;
    const cap = maxRelievablePersonalContribution(member.currentAge, member.currentSalary) - currentGross;
    compiled(await assemble(profile, [route('relief_limit', contribution(cap))]));
    const refused = [];
    async function refuses(label, p, changes, pathFragment, reasonFragment) {
      const result = await assemble(p, [route('refused', ...changes)]);
      const rows = result.routeRefusals ?? result.missingFacts.map(row => ({ path: row.fieldPath, message: row.reason }));
      assert.ok(rows.some(row => row.path.includes(pathFragment) && (!reasonFragment || row.message.includes(reasonFragment))), label + ': ' + JSON.stringify(rows));
      assert.notEqual(result.compilation?.status, 'compiled', label);
      refused.push({ label, refusals: rows });
      return result;
    }
    await refuses('relief cap', profile, [contribution(cap + 0.01)], '/annualAmount', 'relief headroom');
    const db = contribution(1200); db.personId = 'partner'; db.sources.personId = fact('/household/partner/personId');
    await refuses('DB promise is not a contributory pot', profile, [db], '/household/pensions', 'active contributory');
    const noEssential = clone(profile); delete noEssential.expenses.monthlyEssential;
    await refuses('unknown essentials', noEssential, [spending(1000)], '/household/expenses/monthlyEssential');
    await refuses('essential floor', profile, [spending(6000.01)], '/annualAmount', 'below stated essentials');
    for (const changes of [[clear, spending(5000)], [spending(5000), clear]]) await refuses('combined floor regardless of order', profile, changes, '/annualAmount', 'After debt clearances');
    const noFlex = clone(profile); noFlex.assumptions.values.planPack.goalFlexibility = {};
    await refuses('unstated flexibility', noFlex, [move(66)], '/retirementAge', '/goalFlexibility/');
    await refuses('outside flexibility', profile, [move(69)], '/retirementAge', 'outside');
    const noBase = clone(profile); delete noBase.assets[1].baseCost;
    await refuses('missing sale base cost', noBase, [sale], '/household/assets/1/baseCost');
    const unsold = compiled(await assemble(noBase, []));
    assert.equal(ledger(unsold, 'current').investments.potentialSale, null, 'An analyst inventory cannot assume zero base cost either');
    const noCosts = clone(profile); delete noCosts.assets[1].sellingCosts;
    await refuses('missing sale costs', noCosts, [sale], '/household/assets/1/sellingCosts');
    const noSource = contribution(1200); delete noSource.sources;
    await refuses('unexplained contribution', profile, [noSource], '/sources');
    const unequal = contribution(1200); unequal.sources.annualAmount = fact('/household/incomeSources/0/grossAnnual/amount');
    await refuses('fact equality', profile, [unequal], '/sources/annualAmount', 'does not equal');
    const stale = clone(clear); stale.sources.paidFrom.version = 'old';
    await refuses('stale default', profile, [stale], '/sources/paidFrom', 'current central default');
    const wrongDefault = contribution(1200); wrongDefault.sources.annualAmount = central('/routes/defaultCashAmount');
    await refuses('parameter-specific default', profile, [wrongDefault], '/sources/annualAmount');
    const inventedFact = spending(1000); inventedFact.sources.annualAmount = bounded('/household/missingFact');
    await refuses('nonexistent fact', profile, [inventedFact], '/factPaths', 'missing');
    const unreasoned = spending(1000); unreasoned.sources.annualAmount.reason = 'Seems feasible';
    await refuses('reason must cite a fact', profile, [unreasoned], '/reason');
    await refuses('duplicate spending cut', profile, [spending(1000), spending(1000)], '/changes/1', 'duplicates');
    await refuses('two major levers', profile, [spending(5000), move(68)], '/changes', 'one major');
    const major = compiled(await assemble(profile, [route('major_spending', spending(5000)), route('major_delay', move(68)), route('ordinary_boundary', spending(4200))]));
    assert.equal(ledger(major, 'major_spending').levers[0].scale, 'major');
    assert.equal(ledger(major, 'major_delay').levers[0].scale, 'major');
    assert.equal(ledger(major, 'ordinary_boundary').levers[0].scale, 'ordinary');
    assert.equal(ledger(major, 'major_spending').levers[0].classification.approvalStatus, 'proposed');
    const fullCash = clone(cash); fullCash.amount = 'remaining'; fullCash.sources.amount = central('/routes/defaultCashAmount');
    const cashResult = compiled(await assemble(profile, [route('remaining_cash', fullCash)]));
    assert.ok(ledger(cashResult, 'remaining_cash').cashAllocated > 1000);
    const tooMany = await assemble(profile, ['a', 'b', 'c', 'd'].map(id => route(id)));
    assert.equal(tooMany.planPack, null);
    assert.equal(tooMany.routeRefusals[0].path, '/routes');
    assert.equal((await assemble(profile, [route('current')])).planPack, null);
    const ambitious = clone(profile);
    ambitious.goals[0].targetAmount.amount = 100000;
    const short = compiled(await assemble(ambitious, [route('chosen_extra', contribution(1200))]));
    assert.equal(ledger(short, 'chosen_extra').goals.find(goal => goal.kind === 'retirement').state, 'partly',
      'An affordable chosen contribution is not automatically enough for its goal');
    // Another explicit fictional review variant: the DB member also has an
    // active PRSA. Named personal increases must retain both owners and costs.
    const both = clone(profile), prsa = clone(both.pensions[0]);
    Object.assign(prsa, { pensionId: 'fictional_partner_prsa', ownerId: 'partner', type: 'prsa',
      currentValue: { amount: 20000, currency: 'EUR' }, employeeContributionRate: 0.01, employerContributionRate: 0 });
    both.pensions.push(prsa);
    const partnerExtra = contribution(600);
    partnerExtra.personId = 'partner'; partnerExtra.sources.personId = fact('/household/partner/personId');
    partnerExtra.sources.annualAmount = bounded('/household/incomeSources/1/grossAnnual/amount');
    const twoPeople = compiled(await assemble(both, [route('both_contribute', contribution(1200), partnerExtra), route('same_funding')]));
    assert.deepEqual(ledger(twoPeople, 'both_contribute').annualFunding.pensionChanges.map(row => [row.personId, row.amount]), [['primary', 1200], ['partner', 600]]);
    const twoPrice = ledger(twoPeople, 'both_contribute').pricing.find(row => row.kind === 'retirement').priced;
    const twoCost = computePersonalContributionCosts(twoPrice.plannedInput).years[0].cost - computePersonalContributionCosts(twoPrice.currentInput).years[0].cost;
    close(ledger(twoPeople, 'same_funding').years[0].remaining - ledger(twoPeople, 'both_contribute').years[0].remaining, twoCost);

    // AB-A and BA-B test state leakage across runs. Also reverse the operations
    // in one route; record positions may change provenance, never the figures.
    assert.deepEqual(await assemble(profile, batches[0]), first);
    for (const p of [...originals].reverse()) await assemble(p, []);
    assert.deepEqual(await assemble(profile, batches[1]), second);
    const ab = compiled(await assemble(profile, [route('combined', spending(1000), contribution(1200))]));
    const ba = compiled(await assemble(profile, [route('combined', contribution(1200), spending(1000))]));
    close(ledger(ab, 'combined').years[0].remaining, ledger(ba, 'combined').years[0].remaining);
    assert.deepEqual(ledger(ab, 'combined').years, ledger(ba, 'combined').years);
    const reordered = compiled(await assemble(profile, [...batches[0]].reverse()));
    for (const r of batches[0]) {
      assert.deepEqual(ledger(reordered, r.id).years, ledger(first, r.id).years);
      assert.deepEqual(reordered.compilation.routes.find(row => row.id === r.id).differencesFromCurrent, first.compilation.routes.find(row => row.id === r.id).differencesFromCurrent);
    }
    const RealDate = globalThis.Date;
    globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2055-12-31T00:00:00Z'])); } static now() { return RealDate.parse('2055-12-31T00:00:00Z'); } };
    try { assert.deepEqual(await assemble(profile, batches[0]), first); } finally { globalThis.Date = RealDate; }
    const direct = await compilePlanPack(first.planPack, first.compileOptions);
    assert.deepEqual(direct, first.compilation, 'Caller and assembler compile with identical full-B1 options');
    reports.push({ supplementalFacts: 'Explicitly invented review facts in form-to-plan-reviewed.mjs; these are not inferred from v1 answers.',
      profile, batches: [report(first, 'existing_levers'), report(second, 'new_levers'), report(major, 'major_classification'), report(ab, 'combined')],
      pensionEngineParity: { grossExtra: 1200, afterReliefCost: netCost, reliefHeadroom: cap, projectedPot: pension.priced.projectedPotWithExtra,
        twoPersonVariant: { supplementalFact: prsa, grossExtras: { primary: 1200, partner: 600 }, afterReliefCost: twoCost } }, refused });
    if (process.argv.includes('--write-examples')) writeFileSync(expectedUrl, JSON.stringify(reports, null, 2) + '\n');
    assert.deepEqual(reports, JSON.parse(readFileSync(expectedUrl, 'utf8')), 'Committed fictional route report matches all financial ledgers and refusals');
    if (!process.argv.includes('--quiet')) for (const row of reports) console.log(JSON.stringify(row, null, 2));
    console.log('[FormToPlanRoutes] Six levers, full B1 ledgers, dated cost, relief parity, bounds, setting sources, refusals and order independence passed.');
  } finally { console.info = info; }
}
