import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { applicationToProfile } from '../js/planning/application_to_profile.js';
import { profileToPlanPack } from '../js/planning/profile_to_plan_pack.js';
import { compilePlanPack } from '../js/planning/plan_pack/compiler.js';
import { goalWays, balancingMoves, suggestRoutes, priceRoute } from '../js/planning/plan_pack/ledger_walk.js';
import { bounded, fact } from '../js/planning/plan_pack/walk_session.js';
import { getLeverCatalogue } from '../js/planning/plan_pack/lever_catalogue.js';
import { computePensionProjection, computePersonalContributionCosts } from '../js/pension_math.js';
import { computeHouseholdCashFlowProjection } from '../js/household_cash_flow_math.js';
import { reviewedRouteExample } from './fixtures/form-to-plan-reviewed.mjs';
import { majorHouseholds } from './fixtures/major-levers.households.mjs';

const examples = JSON.parse(readFileSync(new URL('./fixtures/form-to-profile.households.json', import.meta.url)));
const expectedUrl = new URL('./fixtures/ledger-walk.expected.json', import.meta.url);
const empty = { id: 'walk', changes: [] }, eur = amount => ({ amount, currency: 'EUR' });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const close = (a, b, tolerance = 0.011) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const info = console.info; console.info = () => {};
const assemble = profile => profileToPlanPack(profile, { confirmedRevision: 7, clientLabel: 'Entirely invented ledger-walk household', routes: [] });
const once = (gross, annual = 0) => ({ type: 'pensionContribution', personId: 'primary', oneOffAmount: gross,
  ...(annual ? { annualAmount: annual } : {}), sources: { personId: fact('/household/primaryPerson/personId'),
    oneOffAmount: bounded('/household/incomeSources/0/grossAnnual', 'Invented one-off contribution within current relief room'),
    ...(annual ? { annualAmount: bounded('/household/incomeSources/0/grossAnnual', 'Invented recurring contribution within current relief room') } : {}) } });
const compactPrice = priced => ({ status: priced.status, allGoalsOnTime: priced.meetsAllGoals, refusals: priced.refusals,
  chapters: priced.compilation?.chapters.map(row => row.id) ?? [],
  ledger: priced.ledger ? Object.fromEntries(Object.entries(priced.ledger).filter(([key]) => key !== 'pricing')) : null });
const compactWays = result => ({ ...result, ways: result.ways.map(way => ({ ...way, pricing: way.pricing ? compactPrice(way.pricing) : null })),
  levers: result.levers.map(move => ({ ...move, pricedRoute: compactPrice(move.pricedRoute) })) });
const compactSuggestions = result => ({ ...result, suggestions: result.suggestions.map(row => ({ ...row, pricing: compactPrice(row.pricing) })) });
let parityCount = 0;
async function parity(compiled, priced) {
  const direct = await compilePlanPack({ ...structuredClone(compiled.source.normalizedPlanPack), narration: {},
    routes: [{ id: 'current' }, structuredClone(priced.routeDraft)] }, { resourceLedger: true });
  assert.deepEqual(priced.compilation, direct, 'Every returned figure, chapter case, native input, ledger and refusal equals price_route for the same choice');
  assert.deepEqual(priced, await priceRoute(compiled, priced.routeDraft));
  parityCount++;
}
async function checkWays(compiled, draft, id) {
  const result = await goalWays(compiled, draft, id);
  for (const way of result.ways) {
    if (way.pricing) await parity(compiled, way.pricing);
    else assert.ok(way.refusals.length && way.refusals.every(row => row.path && row.message));
  }
  for (const move of result.levers) await parity(compiled, move.pricedRoute);
  return result;
}

try {
  const reports = [];
  // All five original invented households pass through the real form bridge.
  // Incomplete facts remain incomplete; a route walk never repairs intake by guessing.
  for (const fixture of examples) {
    const profile = applicationToProfile(freeze(fixture.information), { revision: 7, confirmedAt: '2026-10-20T12:00:00.000Z', profileId: 'walk_' + fixture.id });
    const before = JSON.stringify(profile), assembled = await assemble(freeze(profile));
    const compiled = assembled.compilation ?? { planPack: assembled.planPack };
    const suggestions = await suggestRoutes(compiled);
    if (suggestions.status === 'refused') assert.ok(suggestions.refusals.every(row => row.path && row.message));
    reports.push({ id: fixture.id, facts: assembled.missingFacts, suggestions: compactSuggestions(suggestions) });
    assert.equal(JSON.stringify(profile), before);
  }
  console.log('[LedgerWalk] Original fictional forms and their refusal paths passed.');
  const reviewed = reviewedRouteExample(examples[2]), complete = await assemble(reviewed.profile);
  assert.equal(complete.compilation.status, 'compiled');
  const before = JSON.stringify(complete);
  const costWays = await checkWays(complete.compilation, empty, reviewed.costId);
  assert.deepEqual(costWays.ways.map(way => way.kind), ['surplus', 'lump_sum', 'mix']);
  assert.ok(costWays.ways.every(way => way.meetsGoalOnTime));
  const kept = costWays.ways[0], cash = costWays.ways[1], mix = costWays.ways[2];
  close(cash.pricing.ledger.cashAllocated, costWays.ways[0].funding.wholeCash);
  assert.ok(cash.funding.needsByYear.every(row => row.amount < 0.005));
  assert.ok(mix.pricing.ledger.cashAllocated > 0 && mix.pricing.ledger.cashAllocated < cash.pricing.ledger.cashAllocated);
  assert.ok(kept.pricing.ledger.years[0].planned > mix.pricing.ledger.years[0].planned);
  const retireWays = await checkWays(complete.compilation, cash.route, reviewed.retirementGoalId);
  assert.ok(retireWays.available.earlierGoalIds.includes(reviewed.costId));
  assert.equal(retireWays.ways[0].funding.startsInYears, null);
  assert.equal(retireWays.ways[0].funding.timingBasis, 'per_person_retirement_ages_in_contributionBenchmark');
  close(retireWays.available.spareCash, cash.pricing.ledger.spareCashRemaining);
  const suggestions = await suggestRoutes(complete.compilation);
  assert.ok(suggestions.suggestions.length <= 5);
  for (const row of suggestions.suggestions) { await parity(complete.compilation, row.pricing); assert.ok(row.what && row.why); assert.equal(row.rank, undefined); }
  assert.ok(suggestions.suggestions.flatMap(row => row.families).includes('lump_sum_first'));
  assert.ok(suggestions.suggestions.flatMap(row => row.families).includes('cash_kept'));
  assert.ok(suggestions.suggestions.flatMap(row => row.families).includes('smallest_ordinary_moves'));
  reports.push({ id: 'reviewed_dated_cost_and_retirement', ways: compactWays(costWays), retirement: compactWays(retireWays), suggestions: compactSuggestions(suggestions) });
  assert.equal(JSON.stringify(complete), before);

  // Explicit loan and mortgage targets exercise the method's order, native
  // lump sums, higher repayments, term-to-age and commitments already made.
  const debtProfile = majorHouseholds().tradeDown;
  debtProfile.goals.find(g => g.goalId === reviewed.costId).targetAmount = eur(10000);
  const car = debtProfile.liabilities.find(debt => debt.type !== 'mortgage');
  assert.ok(car);
  debtProfile.goals.push({ goalId: 'invented_loan_goal', type: 'manage_loan', title: 'Invented loan clearance', status: 'active', priority: 'high', targetDate: '2027-10-20' },
    { goalId: 'invented_mortgage_goal', type: 'optimise_mortgage', title: 'Invented mortgage clearance', status: 'active', priority: 'medium', targetDate: '2030-10-20' });
  const settings = debtProfile.assumptions.values.planPack;
  settings.planningInputs.goalBindings.push({ goalId: 'invented_loan_goal', liabilityId: car.liabilityId, personId: 'primary' },
    { goalId: 'invented_mortgage_goal', liabilityId: 'fictional_home_loan', personId: 'primary' });
  settings.goalFlexibility.invented_mortgage_goal = { clearByAge: [65, 68] };
  const debts = await assemble(debtProfile), loanWays = await checkWays(debts.compilation, empty, 'invented_loan_goal');
  const loanCash = loanWays.ways.find(way => way.kind === 'lump_sum');
  const debtCost = await checkWays(debts.compilation, loanCash.route, reviewed.costId);
  const mortgageWays = await checkWays(debts.compilation, debtCost.ways[1].route, 'invented_mortgage_goal');
  assert.deepEqual(mortgageWays.goalOrder, ['invented_loan_goal', reviewed.costId, 'invented_mortgage_goal', reviewed.retirementGoalId]);
  assert.deepEqual(mortgageWays.available.earlierGoalIds, ['invented_loan_goal', reviewed.costId]);
  assert.ok(mortgageWays.available.years.every(row => row.surplus <= mortgageWays.ways[0].pricing.ledger.years.find(y => y.year === row.year).available + 0.005));
  assert.equal(mortgageWays.ways.find(way => way.kind === 'term_to_goal_age').equivalentTo, 'surplus');
  assert.deepEqual(mortgageWays.ways[0].pricing.ledger, mortgageWays.ways.at(-1).pricing.ledger);
  const walkedDebts = await suggestRoutes(debts.compilation);
  const first = walkedDebts.suggestions.find(row => row.families.includes('lump_sum_first'));
  assert.deepEqual(first.route.changes.filter(row => row.type === 'useCash').map(row => row.goalId), ['invented_loan_goal', reviewed.costId, 'invented_mortgage_goal']);
  const lessCash = structuredClone(debts.compilation.source.normalizedPlanPack);
  lessCash.household.assets.find(asset => asset.assetId === lessCash.planningInputs.cashAssetId).currentValue = eur(25000);
  const refusedCash = await checkWays({ source: { normalizedPlanPack: lessCash } }, loanCash.route, 'invented_mortgage_goal');
  const unaffordable = refusedCash.ways.find(way => way.kind === 'lump_sum');
  assert.equal(unaffordable.pricing.ledger, null);
  assert.deepEqual(unaffordable.pricing.fundingReference.removedInstructions.map(change => change.goalId), ['invented_mortgage_goal']);
  close(unaffordable.pricing.fundingReference.spareCash, refusedCash.available.spareCash);
  close(unaffordable.shortfall.cash, unaffordable.funding.wholeCash - refusedCash.available.spareCash);
  reports.push({ id: 'loan_then_dated_cost_then_mortgage', loan: compactWays(loanWays), mortgage: compactWays(mortgageWays), suggestions: compactSuggestions(walkedDebts) });
  console.log('[LedgerWalk] Dated-cost and debt ways match price_route, in method order.');

  // A target just above today's projected pot needs actual new contributions.
  const pensionProfile = structuredClone(reviewed.profile);
  pensionProfile.goals.find(g => g.goalId === reviewed.retirementGoalId).targetAmount = eur(58000);
  pensionProfile.assumptions.values.planPack.goalFlexibility[reviewed.retirementGoalId].targetIncomeToday = [30000, 58000];
  const pension = await assemble(pensionProfile), pensionWays = await checkWays(pension.compilation, empty, reviewed.retirementGoalId);
  const moneyNow = pensionWays.ways.find(way => way.kind === 'money_now');
  assert.ok(moneyNow.requiredOneOffGross > 0 && moneyNow.route.changes.some(row => row.oneOffAmount > 0));
  assert.ok(moneyNow.meetsGoalOnTime, JSON.stringify(moneyNow.refusals));
  const lessPensionCash = structuredClone(moneyNow.route);
  lessPensionCash.changes.find(row => row.oneOffAmount > 0).oneOffAmount -= 0.01;
  assert.equal((await priceRoute(pension.compilation, lessPensionCash)).meetsAllGoals, false, 'The adjacent smaller one-off contribution leaves the native pension target short');
  const baseline = await priceRoute(pension.compilation, empty);
  const onceRoute = await priceRoute(pension.compilation, { id: 'once', changes: [once(10000)] });
  await parity(pension.compilation, onceRoute);
  close(baseline.ledger.cashRemaining - onceRoute.ledger.cashRemaining, 10000);
  const native = onceRoute.ledger.pricing.find(row => row.kind === 'retirement');
  const costsBefore = computePersonalContributionCosts(native.input), costsAfter = computePersonalContributionCosts(native.priced.plannedInput);
  close(costsAfter.years[0].gross - costsBefore.years[0].gross, 10000);
  for (let i = 1; i < costsBefore.years.length; i++) close(costsAfter.years[i].gross, costsBefore.years[i].gross);
  close(native.priced.projectedPotWithExtra, computePensionProjection(native.priced.plannedInput).debug.projectedPotCurrent, 1e-8);
  close(onceRoute.ledger.years[0].available - baseline.ledger.years[0].available, 4000);
  for (let i = 1; i < baseline.ledger.years.length; i++) close(onceRoute.ledger.years[i].available, baseline.ledger.years[i].available);
  const pbs = result => result.compilation.chapters.find(row => row.id === 'personal_balance_sheet').cases.at(-1).metrics;
  close(pbs(onceRoute).netWorth, pbs(baseline).netWorth);
  const flow = onceRoute.compilation.chapters.find(row => row.id === 'household_cash_flow').cases.at(-1);
  assert.equal(flow.input.scenarios.at(-1).changes.find(row => row.type === 'extraPension').cashAmount, 10000);
  const lowTaxInput = structuredClone(flow.input);
  for (const person of lowTaxInput.people) {
    const gross = lowTaxInput.income.filter(row => row.personId === person.id).reduce((sum, row) => sum + row.amount, 0);
    person.statedTakeHome = gross - Math.max(1, person.personalPensionContribution ?? 0);
  }
  const lowTax = computeHouseholdCashFlowProjection(lowTaxInput, { year: 2026 }).summary;
  close(lowTax.cases[0].leftOver.amount, lowTax.cases.at(-1).leftOver.amount);
  assert.equal(lowTax.cases.at(-1).pensionContributions.paidFromCash, 10000);
  const combinedPension = await priceRoute(pension.compilation, { id: 'once_and_recurring', changes: [once(5000, 1000)] });
  assert.ok(combinedPension.ledger); await parity(pension.compilation, combinedPension);
  const overCap = await priceRoute(pension.compilation, { id: 'over_cap', changes: [once(11000, 11000)] });
  assert.ok(overCap.refusals.some(row => row.path.endsWith('/oneOffAmount')));
  reports.push({ id: 'one_off_pension_is_paid_today_only', ways: compactWays(pensionWays), oneOff: compactPrice(onceRoute), mixedContribution: compactPrice(combinedPension), overCap: overCap.refusals });
  console.log('[LedgerWalk] Native one-off pension, relief, balance sheet and contribution limits passed.');

  const properties = majorHouseholds(), trade = await assemble(properties.tradeDown);
  const tradeWays = await checkWays(trade.compilation, empty, reviewed.costId);
  assert.ok(tradeWays.ways.every(way => !way.meetsGoalOnTime));
  assert.ok(tradeWays.levers.some(move => move.kind.startsWith('tradeDownHome') && move.pricedRoute.meetsAllGoals));
  const balancing = await balancingMoves(await priceRoute(trade.compilation, empty));
  for (const move of balancing.moves) await parity(trade.compilation, move.pricedRoute);
  const tradeSuggestions = await suggestRoutes(trade.compilation);
  assert.ok(tradeSuggestions.suggestions.some(row => row.families.includes('smallest_major_move') && row.allGoalsOnTime));
  for (const row of tradeSuggestions.suggestions) { await parity(trade.compilation, row.pricing); assert.ok(row.pricing.ledger?.levers.filter(lever => lever.scale === 'major').length <= 1 || !row.pricing.ledger); }
  reports.push({ id: 'only_trade_down_balances', ways: compactWays(tradeWays), balancing: { ...balancing, moves: balancing.moves.map(move => ({ ...move, pricedRoute: compactPrice(move.pricedRoute) })) }, suggestions: compactSuggestions(tradeSuggestions) });

  // Independent penny-neighbour test of an ordinary minimum, rather than a
  // test that merely reimplements binary search.
  const ordinaryProfile = structuredClone(reviewed.profile);
  ordinaryProfile.assets.forEach(asset => asset.currentValue.amount = asset.type === 'cash' ? 21000 : 0);
  ordinaryProfile.goals.find(g => g.goalId === reviewed.costId).targetAmount = eur(100000);
  const ordinary = await assemble(ordinaryProfile), ordinaryMoves = await balancingMoves(await priceRoute(ordinary.compilation, empty));
  const cut = ordinaryMoves.moves.find(move => move.kind === 'spendLess');
  assert.ok(cut && cut.scale === 'ordinary', JSON.stringify(ordinaryMoves.refusals));
  const smaller = structuredClone(cut.route); smaller.changes.find(row => row.type === 'spendLess').annualAmount -= 0.01;
  assert.equal((await priceRoute(ordinary.compilation, smaller)).meetsAllGoals, false);
  const combinationProfile = structuredClone(ordinaryProfile);
  combinationProfile.assets.find(asset => asset.type === 'investment').currentValue = eur(50000);
  combinationProfile.goals.find(g => g.goalId === reviewed.costId).targetAmount = eur(140000);
  const combination = await assemble(combinationProfile), composed = await suggestRoutes(combination.compilation);
  const ordinaryWalk = composed.suggestions.find(row => row.families.includes('smallest_ordinary_moves'));
  assert.ok(ordinaryWalk?.allGoalsOnTime && ordinaryWalk.route.changes.some(row => row.type === 'spendLess')
    && ordinaryWalk.route.changes.some(row => row.type === 'sellAsset'), 'Compose cash and ordinary changes where no single move is enough');
  await parity(combination.compilation, ordinaryWalk.pricing);
  for (let index = 0; index < ordinaryWalk.route.changes.length; index++) {
    const reduced = structuredClone(ordinaryWalk.route); reduced.changes.splice(index, 1);
    assert.equal((await priceRoute(combination.compilation, reduced)).meetsAllGoals, false, 'No redundant change in the ordinary combination');
  }
  const noFlex = structuredClone(ordinary.compilation.source.normalizedPlanPack); noFlex.goalFlexibility = {};
  const noEssential = structuredClone(noFlex); delete noEssential.household.expenses.monthlyEssential;
  const gaps = await balancingMoves(await priceRoute({ planPack: noEssential }, empty));
  assert.ok(gaps.refusals.some(row => row.path === '/household/expenses/monthlyEssential'));
  assert.ok(gaps.refusals.some(row => row.path === '/goalFlexibility/' + reviewed.costId));
  const missingTarget = structuredClone(noFlex); delete missingTarget.household.goals[0].targetAmount;
  assert.ok((await goalWays({ planPack: missingTarget }, empty, reviewed.retirementGoalId)).refusals.some(row => row.path.includes('targetAmount')));
  assert.ok((await goalWays(complete.compilation, empty, 'absent')).refusals.some(row => row.path === '/goalId'));
  reports.push({ id: 'ordinary_penny_minimum_and_refusal_paths', moves: ordinaryMoves.moves.map(move => ({ ...move, pricedRoute: compactPrice(move.pricedRoute) })), refusals: gaps.refusals });
  reports.push({ id: 'ordinary_combination_after_single_moves_fail', suggestions: compactSuggestions(composed) });
  console.log('[LedgerWalk] Trade-down and ordinary minima passed.');

  // A second major is admitted only after the compiler independently prices
  // and records the supported single-major counterfactuals on this same draft.
  const pairProfile = majorHouseholds().tradeDown;
  pairProfile.assets.forEach(asset => asset.currentValue.amount = asset.type === 'cash' ? 21000 : 0);
  pairProfile.expenses.monthlyEssential.amount = 2000;
  pairProfile.goals.find(g => g.goalId === reviewed.costId).targetAmount = eur(414000);
  const pair = await assemble(pairProfile), pairSuggestions = await suggestRoutes(pair.compilation);
  const two = pairSuggestions.suggestions.find(row => row.families.includes('major_combination_after_single_moves_fail'));
  assert.ok(two?.allGoalsOnTime, JSON.stringify(pairSuggestions.refusals));
  assert.equal(two.pricing.ledger.levers.filter(row => row.scale === 'major').length, 2);
  assert.ok(two.pricing.ledger.majorException.trials.every(row => !row.balanced || !row.goalsCovered));
  await parity(pair.compilation, two.pricing);
  const unneededPair = await priceRoute(complete.compilation, { id: 'unneeded_pair', changes: [
    { type: 'spendLess', annualAmount: 5000, sources: { annualAmount: bounded('/household/expenses/annualTotal', 'Invented cut') } },
    { type: 'moveGoal', goalId: reviewed.retirementGoalId, retirementAge: 68, sources: { goalId: fact('/household/goals/0/goalId'), retirementAge: bounded('/goalFlexibility/' + reviewed.retirementGoalId + '/retirementAge', 'Invented delay') } }
  ] });
  assert.ok(unneededPair.refusals.some(row => row.message.includes('one major')));
  const missingProof = structuredClone(pair.compilation.source.normalizedPlanPack); delete missingProof.household.expenses.monthlyEssential;
  const independentlySourced = structuredClone(two.route);
  independentlySourced.changes.find(row => row.type === 'spendLess').sources.annualAmount = bounded('/household/expenses/annualTotal', 'Test the compiler proof with an independently valid source');
  assert.ok((await priceRoute({ planPack: missingProof }, independentlySourced)).refusals.some(row => row.code === 'missing_information' && row.path === '/household/expenses/monthlyEssential'));
  const unknownHomeUse = structuredClone(pair.compilation.source.normalizedPlanPack); delete unknownHomeUse.household.properties[0].homeUse;
  assert.ok((await priceRoute({ planPack: unknownHomeUse }, two.route)).refusals.some(row => row.code === 'requires_single_major_proof'));
  const forged = { ...structuredClone(two.route), majorException: true };
  assert.equal((await priceRoute(pair.compilation, forged)).status, 'invalid');
  reports.push({ id: 'two_major_moves_only_after_single_moves_fail', suggestions: compactSuggestions(pairSuggestions), unnecessaryPair: unneededPair.refusals });
  console.log('[LedgerWalk] Compiler-proved major exception and forged/missing-fact refusals passed.');

  // A/B/A and B/A/B across pension, property and a different confirmation
  // date: no clock, mutable current tax state, input mutation or shared cache.
  const earlierPension = await goalWays(pension.compilation, empty, reviewed.retirementGoalId);
  await goalWays(trade.compilation, empty, reviewed.costId);
  assert.deepEqual(await goalWays(pension.compilation, empty, reviewed.retirementGoalId), earlierPension);
  const rental = await assemble(properties.rental), rentalBefore = await suggestRoutes(rental.compilation);
  await suggestRoutes(complete.compilation);
  assert.deepEqual(await suggestRoutes(rental.compilation), rentalBefore);
  const otherDate = structuredClone(complete.compilation.source.normalizedPlanPack);
  otherDate.calculationDate = '2027-01-04'; otherDate.household.assumptions.calculationDateIso = otherDate.calculationDate;
  const realNow = Date.now; Date.now = () => { throw new Error('A pure walk must not consult the clock'); };
  try { assert.equal((await priceRoute({ planPack: otherDate }, empty)).planPack.calculationDate, '2027-01-04'); }
  finally { Date.now = realNow; }
  assert.equal(JSON.stringify(complete), before);
  assert.ok(getLeverCatalogue().levers.find(row => row.type === 'pensionContribution').parameters.oneOffAmount);
  const report = { fictionalOnly: true, methodOrder: costWays.methodOrder, reports };
  if (process.argv.includes('--write-examples')) writeFileSync(expectedUrl, JSON.stringify(report, null, 2) + '\n');
  else assert.deepEqual(report, JSON.parse(readFileSync(expectedUrl)), 'Reviewed fictional report changed: inspect it before --write-examples');
  if (!process.argv.includes('--quiet')) console.log(JSON.stringify(report, null, 2));
  console.log(`Ledger walk passed: ${parityCount} exact price_route replays, five original forms, native one-off pension/relief, method order, conditional minima, major proof and order-independence.`);
} finally { console.info = info; }
