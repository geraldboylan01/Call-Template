import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compilePlanPack } from '../js/planning/plan_pack/compiler.js';
import { normalizePlanPack } from '../js/planning/plan_pack/schema.js';
import { readPlanPosition } from '../js/planning/plan_pack/story_facts.js';
import { pointerValue } from '../js/planning/plan_pack/story_registry.js';
import { applicationToProfile } from '../js/planning/application_to_profile.js';
import { profileToPlanPack } from '../js/planning/profile_to_plan_pack.js';
import { buildPresentationCatalogue } from '../js/presenter_catalogue.js';
import { computeAmortizationMonthlySchedule } from '../js/mortgage_math.js';
import { priceInvestmentSales } from '../js/planning/plan_pack/investment_sales.js';
import { resolveTaxRules } from '../js/planning/tax/resolve.js';
import { PLANEIR_ASSUMPTIONS } from '../js/planning/planeir_assumptions.js';

const base = () => JSON.parse(readFileSync('scripts/fixtures/plan-packs/valid-b1.json', 'utf8'));
const compile = async p => {
  const c = await compilePlanPack(p, { resourceLedger: true });
  assert.equal(c.status, 'compiled', JSON.stringify(c.diagnostics)); return c;
};
const eur = amount => ({ amount, currency: 'EUR' });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const route = (s, id = 'current') => s.routes.find(row => row.routeId === id);
const ledger = (c, id = 'current') => c.resourceLedger.routes.find(row => row.routeId === id);
const entry = (c, chapter, id = 'current') => c.chapters.find(row => row.id === chapter)?.cases.find(row => row.id === c.routes.find(r => r.id === id).chapterCases[chapter]);
const fact = (s, key, id = 'current') => route(s, id).facts[key];
const value = (s, key, id = 'current') => fact(s, key, id)?.value;
const issue = (s, name, id = 'current') => route(s, id).issues.find(row => row.id === name);
const freeze = obj => { if (obj && typeof obj === 'object') { Object.values(obj).forEach(freeze); Object.freeze(obj); } return obj; };
let count = 0, failures = 0, sourceChecks = 0;
const originalInfo = console.info; console.info = () => {};
async function test(name, fn) {
  count++;
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.stack); }
}
// These assertions use the compiled cases, never module samples. This tests the
// registry's sources; the story/link checker is a separate, later component.
function checkSources(c, s) {
  for (const r of s.routes) for (const f of Object.values(r.facts)) {
    assert.equal(r.facts[f.key], f);
    assert.ok(f.display !== undefined && f.source.versions.storyFacts);
    assert.deepEqual(Object.fromEntries(Object.keys(c.versions).map(key => [key, f.source.versions[key]])), c.versions);
    if (f.status !== 'available') { assert.equal(f.value, null); assert.ok(f.reason.code && f.reason.message); continue; }
    assert.ok(f.unit);
    const source = f.source;
    if (source.path) { assert.deepEqual(f.value, pointerValue(c, source.path), f.key + ': compiled source value'); sourceChecks++; }
    if (source.kind === 'calculation') {
      assert.ok(source.calculation && Array.isArray(source.inputs)); assert.equal(source.panel, 'plan_facts');
      for (const input of source.inputs) if (typeof input === 'string' && input.startsWith('/')) assert.notEqual(pointerValue(c, input), undefined, f.key + ': calculation input ' + input);
    }
    if (source.chapter) {
      const native = entry(c, source.chapter, source.routeId);
      assert.equal(source.caseId, native.id, f.key + ': route-specific case');
      assert.ok(source.path.startsWith('/chapters/'));
      const catalogue = buildPresentationCatalogue({ modules: [{ id: native.id, title: native.payload.title,
        generated: { ...native.payload.generated, ...native.derived } }] });
      if (catalogue.modules[0].scenarios.length) assert.ok(catalogue.modules[0].scenarios.some(row => row.id === source.nativeCaseId));
      else assert.equal(source.nativeCaseId, null);
      if (source.focusTargetId) {
        const target = catalogue.targets.find(row => row.id === source.focusTargetId);
        assert.ok(target?.available);
        assert.ok(target.value === f.value || target.cells?.some(cell => cell === f.value), f.key + ': actual focused figure');
      }
    }
  }
}

const compiled = await compile(base()), stories = readPlanPosition(compiled);
await test('B1: every direct fact equals its compiled source in the correct route case', () => checkSources(compiled, stories));
await test('Facts are deterministic, JSON-safe, leave the compiled plan untouched, and work without samples', () => {
  const lean = structuredClone(compiled); delete lean.casePacks;
  const before = JSON.stringify(lean); freeze(lean);
  assert.deepEqual(readPlanPosition(lean), stories);
  assert.equal(JSON.stringify(lean), before);
  assert.deepEqual(JSON.parse(JSON.stringify(stories)), stories);
});
await test('B1: goal order, states, funding and event dates come from the route ledger', () => {
  for (const r of stories.routes) {
    const l = ledger(compiled, r.routeId);
    assert.deepEqual(r.goalWalk.map(g => g.goalId), l.goalOrder);
    for (const g of r.goalWalk) {
      const state = l.goals.find(row => row.goalId === g.goalId), row = l.years[0].goals.find(row => row.goalId === g.goalId);
      assert.equal(value(stories, `goals.${g.goalId}.state`, r.routeId), state.stateWord);
      assert.equal(g.yearly, row.planned);
      assert.equal(value(stories, `goals.${g.goalId}.yearlyNeeded`, r.routeId), row.required);
      if (state.firstShortYear !== null) assert.equal(value(stories, `goals.${g.goalId}.firstShortYear`, r.routeId), 2026 + state.firstShortYear);
    }
    assert.equal(value(stories, 'position.leftOver', r.routeId), l.baselineLeftOver);
  }
  assert.equal(value(stories, 'position.leftOver'), 11000);
  assert.equal(value(stories, 'leftOverAfterGoals.yearly'), 10000);
  assert.equal(route(stories, 'college_cash').goalWalk.find(g => g.goalId === 'college').way, 'cash');
});
await test('B1: running cash and surplus reconcile after each chosen step and finish at the ledger totals', () => {
  for (const r of stories.routes) {
    const l = ledger(compiled, r.routeId);
    let cash = l.cashAvailableAfterReserve;
    for (const step of r.steps) {
      if (step.id === 'clear_car_loan') cash -= 15000;
      const goal = r.goalWalk.find(g => g.goalId === step.id);
      if (goal) cash -= goal.cash;
      close(r.facts[step.cashAfter].value, cash);
    }
    close(r.facts[r.steps.at(-1).cashAfter].value, l.spareCashRemaining);
    close(r.facts[r.steps.at(-1).surplusAfter].value, l.years[0].remaining);
    close(value(stories, 'leftOverAfterGoals.monthly', r.routeId), l.years[0].remaining / 12);
  }
  close(value(stories, 'steps.clear_car_loan.surplusAfter', 'clear_car'), 17000);
});
await test('B1: freed cash, retirement stops and assigned assets are registered once with native dates', () => {
  for (const r of stories.routes) {
    const l = ledger(compiled, r.routeId);
    for (const event of l.freedCash) {
      const key = 'freed.' + (event.liabilityId ?? event.goalId);
      assert.equal(value(stories, key + '.amount', r.routeId), event.annualAmount);
      assert.equal(value(stories, key + '.fromYear', r.routeId), event.fromYear);
      if (event.payoffDateIso) assert.equal(value(stories, key + '.endDate', r.routeId), event.payoffDateIso);
    }
    for (const person of l.earners) assert.equal(value(stories, `retirement.${person.personId}.fromYear`, r.routeId), person.stopsFromYear);
    const assets = value(stories, 'ledger.crossedOff', r.routeId).map(row => row.assetId);
    assert.equal(assets.length, new Set(assets).size);
  }
  assert.equal(value(stories, 'freed.car_loan.endDate'), '2029-07-01');
});
await test('A card without a contractual end never becomes a freed-cash event', async () => {
  const p = base(); p.routes = [{ id: 'current' }]; p.narration = {};
  p.household.liabilities.push({ liabilityId: 'card', type: 'credit_card', label: 'Card', ownerIds: ['niamh'], currentBalance: eur(1000), annualInterestRate: 0.12, monthlyPayment: eur(25) });
  p.planningInputs.outgoingBindings.push({ id: 'card_outgoing', liabilityId: 'card', label: 'Card repayment' });
  const c = await compile(p), s = readPlanPosition(c);
  assert.equal(ledger(c).freedCash.find(row => row.liabilityId === 'card').fromYear, null);
  assert.equal(route(s).freedCash.includes('card'), false);
  assert.equal(fact(s, 'freed.card.amount'), undefined);
});
await test('Pension gross, relief and after-relief cost use the chapter’s existing per-person tax allocation', () => {
  for (const r of stories.routes) {
    const e = entry(compiled, 'household_cash_flow', r.routeId);
    const selected = e.calculationFacts.cases.find(row => row.id === e.nativeCaseId);
    for (const person of selected.takeHome.byPerson) {
      const prefix = 'pension.' + person.personId;
      assert.equal(value(stories, prefix + '.grossRoute', r.routeId), person.pensionGross);
      assert.equal(value(stories, prefix + '.costRoute', r.routeId), person.pensionCost);
      assert.equal(value(stories, prefix + '.relief', r.routeId), person.pensionRelief);
      close(person.pensionGross - person.pensionRelief, person.pensionCost);
      close(value(stories, prefix + '.extraCost', r.routeId), person.pensionCost - value(stories, prefix + '.costNow', r.routeId));
    }
  }
  assert.equal(value(stories, 'pension.niamh.costNow'), 2400);
  assert.equal(value(stories, 'pension.dara.costNow'), 1650);
});
await test('Current aliases preserve current sources; differences and direction words require no story arithmetic', () => {
  for (const r of stories.routes) {
    for (const [name, key] of [['yearlyRemaining', 'leftOverAfterGoals.yearly'], ['cashLeft', 'cashAfterGoals'], ['netWorth', 'position.netWorth']]) {
      const delta = value(stories, key, r.routeId) - value(stories, key);
      close(r.facts['vsCurrent.' + name].value, delta);
      assert.equal(r.facts['vsCurrent.' + name + 'Word'].value, delta > 0 ? 'more' : delta < 0 ? 'less' : 'unchanged');
    }
    assert.equal(r.facts['current.position.netWorth'].source.routeId, 'current');
    assert.equal(r.facts['current.position.netWorth'].source.caseId, entry(compiled, 'personal_balance_sheet').id);
    for (const [name, amount] of Object.entries(entry(compiled, 'protection_gap', r.routeId).metrics)) {
      assert.equal(r.facts['protection.' + name].value, amount);
      assert.equal(r.facts['protection.' + name].source.nativeCaseId, name.split('.')[0]);
      if (name.endsWith('.months') && typeof value(stories, 'protection.' + name) === 'number') {
        close(r.facts['vsCurrent.protection.' + name].value, amount - value(stories, 'protection.' + name));
      }
    }
  }
  assert.ok(fact(stories, 'position.netWorth').source.focusTargetId);
  assert.ok(fact(stories, 'position.grossAssets').source.focusTargetId);
  assert.ok(fact(stories, 'protection.niamh_stops.months').source.focusTargetId);
});
await test('Home share uses home equity; mortgage share uses bank take-home', async () => {
  const p = base(); p.household.properties.push({ propertyId: 'home', label: 'Home', use: 'home', ownerIds: ['niamh', 'dara'], currentValue: eur(450000), associatedLiabilityIds: ['home_loan'] });
  const c = await compile(p), s = readPlanPosition(c), balance = entry(c, 'personal_balance_sheet'), h = c.source.normalizedPlanPack.household;
  const home = h.properties.find(row => row.use === 'home');
  const homeValue = balance.input.assetPositions.find(row => row.id === home.propertyId).amount;
  const mortgage = h.liabilities.find(row => row.type === 'mortgage');
  close(value(s, 'position.homeShare'), (homeValue - mortgage.currentBalance.amount) / balance.metrics.netWorth);
  close(value(s, 'position.mortgageShare'), mortgage.monthlyPayment.amount * 12 / entry(c, 'household_cash_flow').metrics.bankTakeHome);
  const unknown = structuredClone(c);
  for (const r of unknown.routes) delete r.sourceHousehold.liabilities.find(row => row.type === 'mortgage').currentBalance;
  assert.equal(fact(readPlanPosition(unknown), 'position.homeShare').status, 'missing');
  const unbound = structuredClone(c);
  for (const r of unbound.routes) r.sourceHousehold.properties[0].associatedLiabilityIds = [];
  assert.equal(fact(readPlanPosition(unbound), 'position.homeShare').status, 'missing');
});
await test('Neutral debt list has no rate threshold, and cash comparisons use the central rate after DIRT', () => {
  const debts = issue(stories, 'debts_other_than_mortgage');
  assert.equal(debts.headline, 'Loans and cards other than the mortgage');
  assert.deepEqual(debts.items.map(row => row.id), ['car_loan']);
  assert.equal(value(stories, 'issues.debts_other_than_mortgage.car_loan.yearlyCost'), 900);
  const net = PLANEIR_ASSUMPTIONS.cash.instantAccessGrossRate * (1 - resolveTaxRules(2026).dirt.rate);
  close(value(stories, 'issues.idle_cash_vs_debt.car_loan.yearlyDifference'), 15000 * (0.06 - net));
  assert.equal(issue(stories, 'debts_other_than_mortgage', 'clear_car').state, 'not_present_in_route');
  assert.equal(issue(stories, 'debts_other_than_mortgage', 'clear_car').addressed, true);
});
await test('Mortgage issue dates are from native amortisation, with all available spare cash applied', () => {
  const debt = compiled.routes[0].sourceHousehold.liabilities.find(row => row.type === 'mortgage');
  const input = { loanKind: 'mortgage', currentBalance: debt.currentBalance.amount, annualInterestRate: debt.annualInterestRate,
    startDateIso: compiled.calculationDate, remainingTermYears: debt.remainingTermMonths / 12, repaymentType: 'repayment', fixedPaymentAmount: debt.monthlyPayment.amount };
  const before = computeAmortizationMonthlySchedule({ ...input, oneOffOverpayment: 0 });
  const after = computeAmortizationMonthlySchedule({ ...input, oneOffOverpayment: value(stories, 'position.spareCash') });
  assert.equal(value(stories, 'issues.mortgage_could_be_shorter.home_loan.endDate'), before.payoffDateIso);
  assert.equal(value(stories, 'issues.mortgage_could_be_shorter.home_loan.endDateWithCash'), after.payoffDateIso);
});

await test('Tax due is opt-in: labels do not establish tax; bindings validate dates, references, duplicates and fields', async () => {
  const p = base(); p.routes = [{ id: 'current' }]; p.narration = {};
  p.household.liabilities.push({ liabilityId: 'tax_bill', type: 'other', label: 'Tax due', currentBalance: eur(1400), monthlyPayment: eur(0), ownerIds: ['niamh'] });
  assert.equal(issue(readPlanPosition(await compile(p)), 'tax_due'), undefined);
  p.planningInputs.taxDue = [{ liabilityId: 'tax_bill', dueDate: '2026-11-30' }];
  const s = readPlanPosition(await compile(p));
  assert.equal(value(s, 'issues.tax_due.tax_bill.amount'), 1400);
  assert.equal(value(s, 'issues.tax_due.tax_bill.dueDate'), '2026-11-30');
  for (const rows of [[{ liabilityId: 'unknown', dueDate: '2026-11-30' }], [{ liabilityId: 'tax_bill', dueDate: '2026-02-30' }],
    [p.planningInputs.taxDue[0], p.planningInputs.taxDue[0]], [{ ...p.planningInputs.taxDue[0], guess: true }]]) {
    assert.throws(() => normalizePlanPack({ ...p, planningInputs: { ...p.planningInputs, taxDue: rows } }));
  }
});
await test('Losses use the native disposal result after selling costs, never unstated base cost or missing costs', async () => {
  const p = base(); p.routes = [{ id: 'current' }]; p.narration = {};
  const holding = (id, extra) => ({ assetId: id, type: 'investment', label: id, ownerIds: ['niamh'], currentValue: eur(100), investmentTaxTreatment: 'ordinary_cgt', ...extra });
  p.household.assets.push(holding('cost_loss', { baseCost: eur(95), sellingCosts: eur(10) }), holding('unknown_basis', { sellingCosts: eur(0) }), holding('unknown_costs', { baseCost: eur(200) }));
  const c = await compile(p), s = readPlanPosition(c);
  const direct = priceInvestmentSales(c.routes[0].sourceHousehold, ['cost_loss'], c.calculationDate, c.source.normalizedPlanPack.planningInputs.householdTaxStatus).result.disposals[0];
  assert.deepEqual(issue(s, 'investment_at_a_loss').items.map(row => row.id), ['cost_loss']);
  assert.equal(value(s, 'issues.investment_at_a_loss.cost_loss.loss'), direct.allowableLoss);
  assert.equal(direct.allowableLoss, 5);
  assert.ok(route(s).unavailableIssues.some(row => row.entityId === 'unknown_costs'));
});
await test('Compiled chapter edits, route cases and versions drive facts; reading never reuses a sample or another route', () => {
  const c = structuredClone(compiled), e = entry(c, 'personal_balance_sheet', 'clear_car');
  e.metrics.netWorth += 1234;
  const s = readPlanPosition(c); assert.equal(value(s, 'position.netWorth', 'clear_car'), e.metrics.netWorth);
  checkSources(c, s);
  const broken = structuredClone(c); broken.routes[1].chapterCases.personal_balance_sheet = 'not-a-case';
  assert.throws(() => readPlanPosition(broken), /matching case/);
  c.versions.taxRules = 'older-rules';
  const old = readPlanPosition(c);
  assert.equal(issue(old, 'idle_cash_vs_debt'), undefined);
  assert.ok(route(old).unavailableIssues.some(row => row.code === 'versions_unavailable'));
});
await test('A person retiring this year uses the ledger’s actual remaining earning share in every walk step', async () => {
  const p = base(); p.routes = [{ id: 'current' }]; p.narration = {}; p.household.primaryPerson.intendedRetirementAge = 45;
  const c = await compile(p), s = readPlanPosition(c), l = ledger(c), r = route(s);
  assert.ok(l.years[0].earningShare < 1);
  close(r.facts[r.steps.at(-1).surplusAfter].value, l.years[0].remaining);
});
await test('An extra-pension route uses its selected native cash-flow case and carries relief-limit disclosures', async () => {
  const p = base(); p.routes = [{ id: 'current' }, { id: 'fund' }]; p.narration = {};
  p.chapters = ['household_cash_flow', 'liquidity_analysis', 'personal_balance_sheet', 'pension_projection'];
  p.household.goals = p.household.goals.filter(row => row.goalId === 'goal_retirement');
  for (const key of ['goalBindings', 'goalFundingFacts']) p.planningInputs[key] = p.planningInputs[key].filter(row => row.goalId === 'goal_retirement');
  p.goalFlexibility = { goal_retirement: p.goalFlexibility.goal_retirement };
  p.household.incomeSources[0].grossAnnual.amount = 100000; p.household.incomeSources[0].netAnnual.amount = 70000;
  p.household.incomeSources[1].grossAnnual.amount = 50000; p.household.incomeSources[1].netAnnual.amount = 36000;
  p.household.expenses.annualTotal.amount = 40000; p.household.goals[0].targetAmount.amount = 80000;
  const c = await compile(p), s = readPlanPosition(c), r = route(s, 'fund'); checkSources(c, s);
  const e = entry(c, 'household_cash_flow', 'fund');
  assert.notEqual(e.nativeCaseId, 'today');
  assert.equal(fact(s, 'pension.niamh.grossRoute', 'fund').source.nativeCaseId, e.nativeCaseId);
  assert.ok(value(s, 'pension.niamh.extraGross', 'fund') > 0);
  close(r.facts[r.steps.at(-1).surplusAfter].value, ledger(c, 'fund').years[0].remaining);
  assert.deepEqual(value(s, 'pension.disclosures', 'fund'), ledger(c, 'fund').pricing[0].priced.disclosures);
});
await test('A deficit remains negative after the reserve and every goal step', async () => {
  const p = base(); p.routes = [{ id: 'current' }]; p.narration = {}; p.household.expenses.annualTotal.amount = 110000;
  const c = await compile(p), s = readPlanPosition(c), r = route(s);
  assert.equal(r.steps[0].id, 'deficit');
  assert.ok(value(s, 'steps.reserve.surplusAfter') < 0);
  close(r.facts[r.steps.at(-1).surplusAfter].value, ledger(c).years[0].remaining);
});
await test('B0 chapters without a resource ledger remain readable without claiming priced goal funding', async () => {
  const p = JSON.parse(readFileSync('scripts/fixtures/plan-packs/valid-small.json'));
  const c = await compilePlanPack(p); assert.equal(c.status, 'compiled', JSON.stringify(c.diagnostics));
  const s = readPlanPosition(c); checkSources(c, s);
  assert.equal(fact(s, 'leftOverAfterGoals.yearly').status, 'missing');
  assert.ok(route(s).goalWalk.every(row => row.status === 'not_priced'));
});

for (const fixture of JSON.parse(readFileSync('scripts/fixtures/form-to-profile.households.json', 'utf8'))) {
  await test('#102 household: ' + fixture.id + ' uses its freshly compiled current position', async () => {
    const profile = applicationToProfile(fixture.information, { revision: 7, confirmedAt: '2026-10-20T12:00:00.000Z', calculationDateIso: '2040-01-01', profileId: 'profile_' + fixture.id });
    const assembly = await profileToPlanPack(profile, { confirmedRevision: 7, clientLabel: fixture.id });
    if (!assembly.planPack) { assert.equal(fixture.id, 'fictional-mostly-blank'); assert.throws(() => readPlanPosition(null)); return; }
    const c = await compilePlanPack(assembly.planPack, assembly.compileOptions);
    assert.equal(c.status, 'compiled', JSON.stringify(c.diagnostics));
    const s = readPlanPosition(freeze(c)); checkSources(c, s);
    const r = route(s);
    assert.equal(s.calculationDate, '2026-10-20');
    assert.ok(r.goalWalk.every(row => row.status === 'not_priced'));
    assert.ok(r.goalWalk.every(row => r.facts['goals.' + row.goalId + '.state'].reason.code === 'goal_not_priced'));
    assert.equal(fact(s, 'leftOverAfterGoals.yearly').status, 'missing');
    assert.equal(r.issues.some(row => /dear|expensive|recommended/i.test(row.headline)), false);
    const balance = entry(c, 'personal_balance_sheet');
    assert.equal(value(s, 'position.netWorth'), balance.metrics.netWorth);
    const flow = entry(c, 'household_cash_flow');
    if (flow) assert.equal(value(s, 'position.leftOver'), flow.metrics.leftOver);
    else assert.equal(fact(s, 'position.leftOver').status, 'missing');
    if (fixture.id === 'fictional-borrower-with-card') {
      const debts = issue(s, 'debts_other_than_mortgage');
      assert.deepEqual(debts.items.map(row => row.id), ['liability_application_loan_0', 'liability_application_loan_1', 'liability_application_credit_card']);
      assert.equal(value(s, 'issues.debts_other_than_mortgage.liability_application_loan_1.rate'), 0.005);
      assert.equal(fact(s, 'issues.debts_other_than_mortgage.liability_application_credit_card.rate').status, 'missing');
      assert.equal(value(s, 'position.spareCash'), 0);
    }
    if (!profile.properties.some(row => row.use === 'home')) {
      assert.equal(fact(s, 'position.homeShare').status, 'not_applicable');
      assert.equal(typeof value(s, 'position.homeShare.notApplicable'), 'string');
    }
  });
}
console.info = originalInfo;
console.log(`${count - failures}/${count} story-facts checks passed; ${sourceChecks} direct compiled-source values checked.`);
if (failures) process.exitCode = 1;
