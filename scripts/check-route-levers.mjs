import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { majorHouseholds } from './fixtures/major-levers.households.mjs';
import { profileToPlanPack } from '../js/planning/profile_to_plan_pack.js';
import { compilePlanPack } from '../js/planning/plan_pack/compiler.js';
import { sizeMajorMove } from '../js/planning/plan_pack/major_move_search.js';
import { getLeverCatalogue } from '../js/planning/plan_pack/lever_catalogue.js';
import { PLANEIR_ASSUMPTIONS as assumptions } from '../js/planning/planeir_assumptions.js';
import { getFigures } from '../js/planning/figures/get_figures.js';

const clone = structuredClone, eur = amount => ({ amount, currency: 'EUR' });
const close = (a, b, tolerance = 0.011) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const examplesUrl = new URL('./fixtures/route-levers.expected.json', import.meta.url);
const info = console.info; console.info = () => {};
const assemble = profile => profileToPlanPack(profile, { confirmedRevision: 7, clientLabel: 'Entirely invented property examples', routes: [] });
const bound = path => ({ kind: 'bounded', reason: 'Invented bounded illustration citing ' + path, factPaths: [path] });
const trade = (price, year = 2026) => ({ type: 'tradeDownHome', newHomePrice: price, year,
  sources: { newHomePrice: bound('/household/properties/0/currentValue'), year: bound('/household/properties/0/currentValue') } });
const sell = (year = 2026) => ({ type: 'sellProperty', propertyId: 'fictional_rental', year,
  sources: { propertyId: { kind: 'fact', path: '/household/properties/1/propertyId' }, year: bound('/household/properties/1/currentValue') } });
const run = (pack, changes, id = 'alternative') => compilePlanPack({ ...clone(pack), routes: [{ id: 'current' }, { id, changes }] }, { resourceLedger: true });
const ledger = (result, id = 'alternative') => result.resourceLedger?.routes.find(row => row.routeId === id);
const financialLedger = ({ pricing, ...financial }) => financial;
const rows = [];
try {
  const profiles = majorHouseholds(), before = JSON.stringify(profiles);
  const packs = {};
  for (const [id, profile] of Object.entries(profiles)) {
    const assembled = await assemble(profile);
    assert.equal(assembled.compilation.status, 'compiled', JSON.stringify(assembled.routeRefusals));
    packs[id] = assembled.planPack;
  }
  const catalog = getLeverCatalogue();
  for (const type of ['tradeDownHome', 'sellProperty']) assert.equal(catalog.levers.find(row => row.type === type).scale.kind, 'major');
  for (const id of ['property_agent_fee', 'property_sale_legal']) {
    const figure = getFigures({ ids: ['planeir.assumption.' + id] })[0];
    assert.equal(figure.status, 'proposed'); assert.ok(figure.sources.some(source => source.url?.startsWith('https://')));
  }
  const sized = await sizeMajorMove(packs.tradeDown, { id: 'alternative', changes: [] }, { type: 'tradeDownHome' });
  assert.equal(sized.status, 'sized', JSON.stringify(sized));
  const selected = sized.route.changes.at(-1), l = sized.ledger;
  assert.ok(l.balanced && l.goalsCovered && l.reserveProtected);
  assert.equal(l.propertyMove.tax, 0);
  close(l.propertyMove.debts[0].balance, 60000, 1e-8, 'No current-month repayment is applied before a sale today');
  close(l.baselineLeftOver, 49178.31 + 7200);
  const current = ledger(sized.compilation, 'current');
  assert.equal(current.propertyMove, undefined);
  // Independent reference: direct algebra, no property/goal engine or sizing
  // code. Two start-of-year savings instalments meet one inflated bill; solve
  // the all-in cash purchase price, then inspect adjacent cents exhaustively.
  const r = assumptions.cash.instantAccessGrossRate * (1 - 0.33);
  const saving = 400000 * 1.02 ** 2 / (1 + r) ** 2 / (1 + 1 / (1 + r));
  const capitalNeeded = 2 * (saving - (49178.31 + 7200));
  const ceiling = (800000 - 60000 - (800000 * 0.01845 + 2500) - 11500 - capitalNeeded) / 1.01;
  let reference = Math.floor(ceiling * 100) / 100;
  // The ledger admits sub-cent floating residue only to half a cent. Explicitly
  // test the discrete boundary rather than mirroring its binary search.
  const nearby = [];
  for (let cents = Math.round(reference * 100) - 2; cents <= Math.round(reference * 100) + 2; cents++) {
    const price = cents / 100;
    const exactCash = 800000 - 60000 - 17260 - 11500 - Math.round(price * 0.01 * 100) / 100 - price;
    if (exactCash + 0.005 >= capitalNeeded) nearby.push(price);
  }
  reference = Math.max(...nearby);
  close(selected.newHomePrice, reference, 1e-8);
  assert.equal((await run(packs.tradeDown, [trade(selected.newHomePrice + 0.01)])).status, 'invalid');
  assert.equal((await run(packs.tradeDown, [trade(400000, 2027)])).status, 'invalid', 'Future proceeds cannot fill year-zero gaps');
  const expensiveHome = clone(packs.tradeDown); expensiveHome.household.properties[0].currentValue.amount = 3000000;
  const higherBands = await run(expensiveHome, [trade(2000000)]);
  assert.equal(higherBands.status, 'compiled');
  assert.equal(ledger(higherBands).propertyMove.buyingCosts.stampDuty, 50000, 'Stamp duty uses the progressive House Purchase bands');
  const impossible = clone(packs.tradeDown); impossible.household.goals.find(g => g.goalId === 'fictional_dated_cost').targetAmount.amount = 1000000;
  assert.equal((await sizeMajorMove(impossible, { id: 'alternative', changes: [] }, { type: 'tradeDownHome' })).status, 'none');
  // Even all existing spare cash and sold investments plus the maximum stated
  // spending cut leave this invented goal short without the home move.
  const ordinary = [
    { type: 'sellAsset', assetId: packs.tradeDown.household.assets[1].assetId, sources: { assetId: { kind: 'fact', path: '/household/assets/1/assetId' } } },
    { type: 'useCash', goalId: 'fictional_dated_cost', amount: 'remaining', sources: { goalId: { kind: 'fact', path: '/household/goals/2/goalId' }, amount: { kind: 'default', path: '/routes/defaultCashAmount', version: assumptions.version } } },
    { type: 'spendLess', annualAmount: 6000, sources: { annualAmount: bound('/household/expenses/annualTotal') } }
  ];
  assert.equal((await run(packs.tradeDown, ordinary)).status, 'invalid');
  rows.push({ id: 'only_trade_down_funds_the_goal', input: profiles.tradeDown, referencePrice: reference,
    selectedRoute: sized.route, differences: sized.compilation.routes.find(row => row.id === 'alternative').differencesFromCurrent, ledger: financialLedger(l) });
  const allocated = await run(packs.tradeDown, [selected, ordinary[1]]);
  assert.equal(allocated.status, 'compiled', JSON.stringify(allocated.diagnostics));
  close(ledger(allocated).propertyCapitalCommitted, 0, 1e-8);
  close(ledger(allocated).cashRemaining, l.reserve.protectedAmount);

  const saleResult = await run(packs.rental, [sell()]);
  assert.equal(saleResult.status, 'compiled', JSON.stringify(saleResult.diagnostics));
  const sold = ledger(saleResult), move = sold.propertyMove;
  const saleCosts = 300000 * 0.01845 + 2500;
  // The repository's dated catalogue uses the announced 31% rate for this
  // October 2026 disposal; this reference is deliberately date-specific.
  const taxReference = (300000 - saleCosts - 150000 - 1270) * 0.31;
  close(move.tax, taxReference);
  close(move.cashReleased, 300000 - saleCosts - taxReference - 50000);
  close(sold.baselineLeftOver - ledger(saleResult, 'current').baselineLeftOver, -12000 + 2500 + 4800);
  close(move.native.cases.find(c => c.id === 'keep').result, 4700);
  const batchResult = await run(packs.rental, [sell(), ordinary[0]]);
  assert.equal(batchResult.status, 'compiled', JSON.stringify(batchResult.diagnostics));
  const batch = ledger(batchResult);
  close(batch.investmentSales.combinedCapitalTax, ((300000 - saleCosts - 150000) + 20000 - 1270) * 0.31);
  assert.equal(batch.investmentSales.input.events.length, 2, 'One batch gets one annual exemption');
  const losses = clone(packs.rental); losses.household.assets[1].baseCost.amount = 100000;
  const carried = await run(losses, [sell(2027), ordinary[0]]);
  assert.equal(carried.status, 'compiled', JSON.stringify(carried.diagnostics));
  close(ledger(carried).propertyMove.tax, (300000 - saleCosts - 150000 - 50000 - 1270) * 0.31);
  const noRent = clone(packs.rental);
  Object.assign(noRent.household.properties[1], { rentAnnual: eur(0), taxOnRentalProfitAnnual: eur(0), rentalIncomeSourceIds: [] });
  noRent.household.incomeSources = noRent.household.incomeSources.filter(i => i.incomeId !== 'fictional_rent');
  assert.equal((await run(noRent, [sell()])).status, 'compiled', 'An unlet second property can be sold with explicit zero rent');

  const later = clone(profiles.rental);
  later.primaryPerson.age = 40; later.partner.age = 38;
  const rentalDebt = later.liabilities.find(d => d.liabilityId === 'fictional_rental_loan');
  rentalDebt.currentBalance.amount = 290000; rentalDebt.monthlyPayment.amount = 2000;
  later.expenses.annualTotal.amount += 19200;
  const goal = later.goals.find(g => g.goalId === 'fictional_dated_cost');
  goal.targetAmount.amount = 50000; goal.targetDate = '2031-10-20';
  later.assumptions.values.planPack.planningInputs.goalFundingFacts[0].funding = 'each_year';
  const laterAssembly = await assemble(later), laterPack = laterAssembly.planPack;
  const saleSearch = await sizeMajorMove(laterPack, { id: 'alternative', changes: [] }, { type: 'sellProperty', propertyId: 'fictional_rental' });
  assert.equal(saleSearch.status, 'sized', JSON.stringify(saleSearch.refusals ?? saleSearch.probes));
  // Independent monthly recurrence and yearly cash-budget enumeration. No
  // amortisation, tax, rental, ledger or search engine is called here.
  const bill = 50000 * 1.02 ** 5, netBeforeLoans = 300000 - saleCosts - taxReference;
  let earliest = null;
  for (let year = 2026; year <= 2031; year++) {
    const months = year === 2026 ? 0 : 3 + 12 * (year - 2027);
    let balance = 290000;
    for (let month = 0; month < months; month++) balance = balance * (1 + 0.04 / 12) - 2000;
    const capital = netBeforeLoans - balance;
    if (capital >= 0 && capital + 49800 + 0.005 >= bill) { earliest = year; break; }
  }
  assert.equal(saleSearch.route.changes[0].year, earliest);
  for (const row of saleSearch.ledger.years.filter(row => row.year < earliest)) assert.equal(row.propertyCapitalReceived, 0);
  assert.ok(saleSearch.ledger.years.find(row => row.year === earliest).propertyCapitalReceived > 0);
  const globalTrade = await sizeMajorMove(laterPack, { id: 'alternative', changes: [] }, { type: 'tradeDownHome' });
  assert.equal(globalTrade.status, 'sized', JSON.stringify(globalTrade.refusals));
  // No money is required before the 2031 bill. A later home settlement has a
  // smaller mortgage balance; independently enumerate dates, then solve price
  // algebraically. Unused annual surplus is not accumulated by B1.
  let bestPrice = -1, bestYear = null;
  for (let year = 2026; year <= 2031; year++) {
    let balance = 60000;
    for (let month = 0; month < (year === 2026 ? 0 : 3 + 12 * (year - 2027)); month++) balance = balance * (1 + 0.04 / 12) - 600;
    const capitalNeed = bill - 42500;
    const continuous = (800000 - balance - 17260 - 11500 - capitalNeed) / 1.01;
    let price = Math.floor(continuous * 100) / 100;
    for (let cents = Math.round(price * 100) - 2; cents <= Math.round(continuous * 100) + 2; cents++) {
      const candidate = cents / 100;
      if (800000 - balance - 17260 - 11500 - Math.round(candidate * 100 * 0.01) / 100 - candidate + 0.005 >= capitalNeed) price = candidate;
    }
    if (price > bestPrice) { bestPrice = price; bestYear = year; }
  }
  assert.equal(globalTrade.route.changes[0].year, bestYear);
  close(globalTrade.route.changes[0].newHomePrice, bestPrice, 1e-8);
  const futureDecline = await run(packs.rental, [sell(2027)]);
  assert.equal(futureDecline.status, 'compiled');
  close(ledger(futureDecline).years[1].leftOver - ledger(futureDecline, 'current').years[1].leftOver, -4700);
  rows.push({ id: 'second_property', input: profiles.rental, ledger: financialLedger(sold), batchTax: batch.investmentSales.combinedCapitalTax,
    delayedSale: financialLedger(ledger(futureDecline)), earliestReference: earliest, selectedRoute: saleSearch.route, earliestSaleLedger: financialLedger(saleSearch.ledger),
    globalTradeReference: { price: bestPrice, year: bestYear }, globalTradeRoute: globalTrade.route });

  const refusals = [];
  async function refuses(label, pack, change, path) {
    const result = await run(pack, [change]);
    assert.notEqual(result.status, 'compiled', label);
    assert.ok(result.diagnostics.some(row => row.path.includes(path)), label + ': ' + JSON.stringify(result.diagnostics));
    refusals.push({ label, diagnostics: result.diagnostics });
  }
  for (const field of ['baseCost', 'acquisitionDate', 'acquiredBy', 'homeUse', 'rentalIncomeSourceIds', 'runningCostsAnnual', 'taxOnRentalProfitAnnual']) {
    const missing = clone(packs.rental); delete missing.household.properties[1][field];
    await refuses('missing ' + field, missing, sell(), '/household/properties/1/' + field);
  }
  const ppr = clone(packs.tradeDown); delete ppr.household.properties[0].homeUse;
  await refuses('unconfirmed PPR', ppr, trade(400000), '/household/properties/0/homeUse');
  await refuses('price outside central share', packs.tradeDown, trade(399999), '/newHomePrice');
  await refuses('fractional cent', packs.tradeDown, trade(400000.001), '/newHomePrice');
  await refuses('unfunded replacement purchase', packs.tradeDown, trade(760000), '/newHomePrice');
  await refuses('year outside central horizon', packs.rental, sell(2047), '/year');
  const noSource = sell(); delete noSource.sources;
  await refuses('unsupported source', packs.rental, noSource, '/sources');
  const conflict = await run(packs.rental, [sell(), trade(400000)]);
  assert.ok(conflict.diagnostics.some(row => row.message.includes('one major')));
  const missing = clone(packs.rental); delete missing.household.properties[1].baseCost;
  // Make the goal short so the search must inspect the missing property fact.
  missing.household.goals.find(g => g.goalId === 'fictional_dated_cost').targetAmount.amount = 200000;
  assert.equal((await sizeMajorMove(missing, { id: 'alternative', changes: [] }, { type: 'sellProperty', propertyId: 'fictional_rental' })).status, 'refused');
  assert.equal((await sizeMajorMove(null, { id: 'alternative', changes: [] }, { type: 'tradeDownHome' })).status, 'refused');
  const unchanged = await run(packs.rental, [sell()]);
  assert.deepEqual(unchanged, saleResult, 'Trade/sale A-B-A shares no tax history or mutable engine state');
  const reversedBatch = await run(packs.rental, [ordinary[0], sell()]);
  assert.deepEqual(ledger(reversedBatch).years, batch.years);
  close(ledger(reversedBatch).propertyMove.cashReleased, batch.propertyMove.cashReleased);
  const realDate = globalThis.Date;
  globalThis.Date = class extends realDate { constructor(...args) { super(...(args.length ? args : ['2050-01-01'])); } static now() { return realDate.parse('2050-01-01'); } };
  try { assert.deepEqual(await run(packs.rental, [sell()]), saleResult); } finally { globalThis.Date = realDate; }
  assert.equal(JSON.stringify(profiles), before, 'Confirmed source examples remain unchanged');
  rows.push({ refusals });
  if (process.argv.includes('--write-examples')) writeFileSync(examplesUrl, JSON.stringify(rows, null, 2) + '\n');
  assert.deepEqual(rows, JSON.parse(readFileSync(examplesUrl)), 'The committed report contains the fictional profiles, priced ledgers, differences and refusals');
  if (!process.argv.includes('--quiet')) for (const row of rows) console.log(JSON.stringify(row, null, 2));
  console.log('[RouteLevers] Major moves, full B1 timing, independent sizing references, native tax batches, refusals and order independence passed.');
} finally { console.info = info; }
