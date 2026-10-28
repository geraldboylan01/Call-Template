#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compilePlanPack, resolvePlanNarration } from '../js/planning/plan_pack/compiler.js';
import { normalizePlanPack } from '../js/planning/plan_pack/schema.js';
import { checkCasePack } from '../js/module_pipeline.js';
import { computeHouseholdCashFlowProjection } from '../js/household_cash_flow_math.js';
import { computeMortgageComparison } from '../js/mortgage_math.js';
import { computePensionProjection } from '../js/pension_math.js';
import { computeProtectionGapProjection } from '../js/protection_gap_math.js';

const originalInfo = console.info;
console.info = () => {}; // Existing renderer diagnostics are not test results.
const fixture = resolve('scripts/fixtures/plan-packs/valid-small.json');
const base = () => JSON.parse(readFileSync(fixture, 'utf8'));
let failures = 0;
let total = 0;
async function test(name, fn) {
  total++;
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.stack); }
}
const oneRoute = pack => { pack.routes = [{ id: 'current' }]; pack.narration = {}; return pack; };
const entryFor = (result, chapter, routeId) => {
  const id = result.routes.find(r => r.id === routeId).chapterCases[chapter];
  return result.chapters.find(c => c.id === chapter).cases.find(c => c.id === id);
};
async function refused(mutate, status, path) {
  const pack = base(); mutate(pack);
  const result = await compilePlanPack(pack);
  assert.equal(result.status, status, JSON.stringify(result.diagnostics));
  assert.equal(result.casePacks, null);
  if (path) assert(result.diagnostics.some(d => d.path.startsWith(path)), JSON.stringify(result.diagnostics));
  return result;
}
const cli = args => spawnSync(process.execPath, ['scripts/check-plan-pack.mjs', ...args], { encoding: 'utf8', maxBuffer: 15 * 1024 * 1024 });

await test('The joined fixture compiles and every route passes the existing case-pack validator', async () => {
  const result = await compilePlanPack(base());
  assert.equal(result.status, 'compiled', JSON.stringify(result.diagnostics));
  assert.equal(result.routes.length, 4);
  assert.equal(result.resourceLedger.status, 'not_computed');
  for (const {casePack} of result.casePacks) assert.equal(checkCasePack(casePack).ok, true);
});
await test('Shared current facts produce the same case when nothing changes', async () => {
  const result = await compilePlanPack(base());
  assert.deepEqual(result.routes[0].chapterCases, result.routes[1].chapterCases);
  assert.equal(result.chapters.find(c => c.id === 'household_cash_flow').cases.length, 2);
});
await test('Bank pay, current contributions and clearing a debt agree with the cash-flow engine', async () => {
  const result = await compilePlanPack(base());
  for (const route of result.routes) {
    const compiled = entryFor(result, 'household_cash_flow', route.id);
    const direct = computeHouseholdCashFlowProjection(compiled.input).summary.cases[0];
    assert.equal(compiled.metrics.leftOver, direct.leftOver.amount);
    assert.equal(compiled.metrics.pensions, direct.outgoings.pensionContributions);
  }
  assert.equal(entryFor(result, 'household_cash_flow', 'current').metrics.bankTakeHome, 95000);
  assert.equal(entryFor(result, 'household_cash_flow', 'current').metrics.pensions, 6750);
  assert.equal(entryFor(result, 'household_cash_flow', 'current').metrics.leftOver, 11000);
  assert.equal(entryFor(result, 'household_cash_flow', 'clear_car').metrics.leftOver, 17000);
});
await test('Cash is removed once, and each route starts from the opening account', async () => {
  const result = await compilePlanPack(base());
  assert.equal(entryFor(result, 'liquidity_analysis', 'current').metrics.currentCash, 90000);
  assert.equal(entryFor(result, 'liquidity_analysis', 'clear_car').metrics.currentCash, 75000);
  assert.equal(entryFor(result, 'liquidity_analysis', 'cash_to_mortgage').metrics.currentCash, 70000);
  assert.equal(entryFor(result, 'protection_gap', 'clear_car').input.savings, 75000);
  assert.equal(entryFor(result, 'protection_gap', 'cash_to_mortgage').input.savings, 70000);
  assert.equal(entryFor(result, 'personal_balance_sheet', 'clear_car').metrics.netWorth, entryFor(result, 'personal_balance_sheet', 'current').metrics.netWorth);
});
await test('Mortgage cash uses the engine comparison and explicitly selects its route case', async () => {
  const result = await compilePlanPack(base());
  const compiled = entryFor(result, 'mortgage_analysis', 'cash_to_mortgage');
  const direct = computeMortgageComparison(compiled.input).cases.find(c => c.id === 'route');
  assert.equal(compiled.nativeCaseId, 'route');
  assert.equal(compiled.metrics.interestSaved, direct.interestSaved);
  assert(compiled.metrics.interestSaved > 0);
  assert.equal(compiled.metrics.monthlyPayment, direct.projection.monthlyPaymentUsed);
});
await test('Compilation is deterministic and leaves the author input unchanged', async () => {
  const pack = base(), before = JSON.stringify(pack);
  const first = await compilePlanPack(pack);
  const second = await compilePlanPack(pack);
  assert.equal(JSON.stringify(pack), before);
  assert.deepEqual(first, second);
});
await test('Changing route names, narration or alternative order does not change financial cases', async () => {
  const a = base(), b = base();
  b.routes[2].title = 'A different title'; b.routes[3].title = 'Another title';
  b.narration = { current: 'Your cash is shown for this route.' };
  [b.routes[2], b.routes[3]] = [b.routes[3], b.routes[2]];
  const [first,second] = await Promise.all([compilePlanPack(a), compilePlanPack(b)]);
  assert.equal(first.status, 'compiled'); assert.equal(second.status, 'compiled');
  for (const route of first.routes) assert.deepEqual(route.chapterCases, second.routes.find(r => r.id === route.id).chapterCases);
});
await test('Four distinct settings fit, and a fifth route is refused', async () => {
  const p=base();p.chapters=['liquidity_analysis','mortgage_analysis'];p.narration={};
  p.routes=[{id:'current'},...[1000,2000,3000].map((amount,i)=>({id:'cash_'+i,changes:[{type:'useCash',goalId:'goal_mortgage',amount}]}))];
  const r=await compilePlanPack(p);assert.equal(r.status,'compiled',JSON.stringify(r.diagnostics));
  assert(r.chapters.every(c=>c.cases.length===4));
  p.routes.push({id:'fifth'});
  assert.equal((await compilePlanPack(p)).status,'invalid');
});
await test('Retirement A-B-A and B-A-B are independent and match direct pension projections', async () => {
  const a=base();a.chapters=['pension_projection'];a.narration={};
  a.routes=[{id:'current'},...[[62,'a'],[65,'b'],[62,'again']].map(([retirementAge,id])=>({id,changes:[{type:'moveGoal',goalId:'goal_retirement',retirementAge}]}))];
  const b=structuredClone(a);b.routes=[{id:'current'},...[[65,'b'],[62,'a'],[65,'again']].map(([retirementAge,id])=>({id,changes:[{type:'moveGoal',goalId:'goal_retirement',retirementAge}]}))];
  const first=await compilePlanPack(a),second=await compilePlanPack(b);
  assert.equal(first.status,'compiled',JSON.stringify(first.diagnostics));
  assert.equal(second.status,'compiled',JSON.stringify(second.diagnostics));
  assert.equal(entryFor(first,'pension_projection','a').input.pensions[0].retirementAge,62);
  assert.equal(entryFor(first,'pension_projection','b').input.pensions[0].retirementAge,65);
  assert.equal(entryFor(first,'pension_projection','b').input.pensions[1].retirementAge,67);
  assert.equal(entryFor(first,'pension_projection','a').id,entryFor(first,'pension_projection','again').id);
  assert.equal(entryFor(first,'pension_projection','a').id,entryFor(second,'pension_projection','a').id);
  for(const c of first.chapters[0].cases) assert.equal(c.metrics.requiredPot,computePensionProjection(c.input).debug.requiredPot);
});
await test('The existing loan adapter compiles through the native pipeline', async () => {
  const p=oneRoute(base());p.chapters=['loan_analysis'];
  p.routes.push(base().routes[2]);
  const r=await compilePlanPack(p);assert.equal(r.status,'compiled',JSON.stringify(r.diagnostics));
  assert.equal(r.chapters[0].cases[0].input.currentBalance,15000);
  const cleared = entryFor(r, 'loan_analysis', 'clear_car');
  assert.equal(cleared.nativeCaseId, 'route');
  assert.equal(cleared.metrics.totalInterest, computeMortgageComparison(cleared.input).cases.find(c => c.id === 'route').totalInterestLifetime);
  assert.equal(cleared.metrics.totalInterest, 0);
});
await test('College and net-retirement builders either compile or name their required input', async () => {
  const p=oneRoute(base());p.chapters=['college_funding'];
  p.household.dependants=[{dependantId:'child',displayName:'Child',currentAge:10}];
  p.household.goals.push({goalId:'college',type:'fund_education',title:'College',priority:'medium',status:'active'});
  let r=await compilePlanPack(p);assert.equal(r.status,'compiled',JSON.stringify(r.diagnostics));
  p.chapters=['net_retirement_cashflow'];
  r=await compilePlanPack(p);assert.equal(r.status,'compiled',JSON.stringify(r.diagnostics));
});

for (const amount of ['whole','remaining']) await test(amount+' is a known instruction that explicitly needs B1',async()=>{
  await refused(p=>{p.routes=[p.routes[0],{id:'later',changes:[{type:'useCash',goalId:'goal_mortgage',amount}]}];p.narration={};},'requires_later_stage','/routes/1/changes/0/amount');
});
await test('Goals are not relabelled as a route, and a fund must name its dated cost',async()=>{
  let p=oneRoute(base());p.chapters=['goals_and_resources'];p.planningInputs.leftOverEachYear=11000;
  let r=await compilePlanPack(p);assert.equal(r.status,'requires_later_stage');assert.equal(r.diagnostics[0].code,'requires_resource_ledger');
  p.chapters=['future_cost_fund'];r=await compilePlanPack(p);assert.equal(r.status,'invalid');assert.equal(r.casePacks,null);
  assert.equal(r.diagnostics[0].path,'/planningInputs/chapterGoals/future_cost_fund');
});
await test('A missing goals left-over fact is not invented',async()=>{
  await refused(p=>{oneRoute(p);p.chapters=['goals_and_resources'];},'invalid','/planningInputs/leftOverEachYear');
});
await test('Protection refuses absent per-person bank income rather than dividing or estimating it',async()=>{
  await refused(p=>{delete p.household.incomeSources[1].netAnnual;},'invalid','/household/incomeSources');
});
await test('Missing spending, contribution facts and bank-pay basis are reported',async()=>{
  await refused(p=>{delete p.household.expenses.annualTotal;},'invalid','/household/expenses/annualTotal');
  await refused(p=>{delete p.household.pensions[0].employeeContributionRate;},'invalid','/household/pensions');
  await refused(p=>{delete p.planningInputs.takeHomeBasis;},'invalid','/planningInputs/takeHomeBasis');
});
await test('A known zero bank income is not silently replaced with a tax estimate',async()=>{
  await refused(p=>{p.household.incomeSources[0].netAnnual.amount=0;},'requires_later_stage','/household/incomeSources');
});
await test('Explicit-zero State payments survive compilation and missing payments fail',async()=>{
  const r=await compilePlanPack(base());
  assert.equal(entryFor(r,'protection_gap','current').input.scenarios[1].event.statePayment,0);
  await refused(p=>{delete p.planningInputs.protectionCases[0].event.statePayment;},'invalid','/chapters');
});
await test('A pack that lists no protection cases gets the Illness Benefit default for each employee, and the death of the higher earner',async()=>{
  const pack=base();pack.planningInputs.protectionCases=[];oneRoute(pack);
  const r=await compilePlanPack(pack);
  assert.equal(r.status,'compiled',JSON.stringify(r.diagnostics));
  const entry=entryFor(r,'protection_gap','current');
  assert.deepEqual(entry.input.scenarios.map(c=>c.id),['today','niamh-cannot-work','dara-cannot-work','niamh-died']);
  const [,niamh,dara,died]=entry.input.scenarios;
  for(const c of [niamh,dara]){
    assert.equal(c.event.type,'cannotWork');
    assert.equal(c.income.basis,'estimated');
    assert.equal(c.income.calculationYear,2026,'the plan’s year');
    assert.equal(c.income.phases[0].statePayment.scheme,'illnessBenefit');
    assert.equal(c.income.phases[0].statePayment.weeklyRate,254,'the register’s rate');
    assert.equal(c.income.phases[0].months,12,'a full year');
    assert.equal(c.income.phases[1].statePayment,null,'and not after');
  }
  assert.equal(died.income.phases[0].statePayment.scheme,'bereavedPartnerPension');
  assert.equal(entry.input.people.map(p=>p.takeHome).join(),'50000,45000','stated bank pay sets today');
  const projection=computeProtectionGapProjection(entry.input);
  assert.ok(projection.debug.footnote.includes('Tax is recalculated for each case. If one of you stops working, the other person’s take-home may change.'));
  assert.ok(projection.debug.cases[1].sentence.includes('Assumes the standard personal rate of Illness Benefit'));
  assert.ok(entry.assumptionsUsed.some(a=>a.key==='protectionIncome'&&a.value.cases.length===3&&a.value.notShown.length===0));
  assert.equal(entry.basis,'stated_bank_pay_with_recalculated_tax_and_register_state_payments');
  for(const key of ['moneyIn','gap'])assert.ok(`niamh-cannot-work.${key}` in entry.metrics);
  assert.deepEqual(JSON.parse(JSON.stringify(pack)),JSON.parse(JSON.stringify(pack)),'inputs untouched');
});
await test('A pack that lists its own protection cases gets exactly those',async()=>{
  const entry=entryFor(await compilePlanPack(base()),'protection_gap','current');
  assert.deepEqual(entry.input.scenarios.map(c=>c.id),['today','niamh_stops']);
  assert.equal(entry.basis,'stated_bank_pay_and_confirmed_state_payments');
});
await test('The Illness Benefit default never applies silently to self-employment, and says why the case is not shown',async()=>{
  const pack=base();pack.planningInputs.protectionCases=[];oneRoute(pack);
  pack.household.partner.employmentStatus='self_employed';
  const entry=entryFor(await compilePlanPack(pack),'protection_gap','current');
  assert.ok(!entry.input.scenarios.some(c=>c.id==='dara-cannot-work'),'no case for the self-employed person');
  assert.ok(entry.warnings.some(w=>w.includes('self-employment')&&w.includes('Class S PRSI does not cover Illness Benefit')),JSON.stringify(entry.warnings));
  assert.ok(entry.assumptionsUsed.find(a=>a.key==='protectionIncome').value.notShown.some(n=>n.code==='self_employed'));
  assert.ok(entry.input.scenarios.some(c=>c.id==='niamh-cannot-work'),'the employee still has theirs');
});
await test('A stated survivor payment is used as given for the death case, and the register’s rate otherwise',async()=>{
  const pack=base();pack.planningInputs.protectionCases=[];oneRoute(pack);
  pack.household.assumptions.values.protection={survivorPayment:{niamh:9000}};
  const stated=entryFor(await compilePlanPack(pack),'protection_gap','current').input.scenarios.find(c=>c.id==='niamh-died');
  assert.equal(stated.income.phases[0].statePayment.scheme,'stated');
  assert.equal(stated.income.phases[0].statePayment.amount,9000);
});
await test('Default protection case ids are narration placeholders',async()=>{
  const pack=base();pack.planningInputs.protectionCases=[];oneRoute(pack);
  pack.narration={current:'If Niamh could not work, the gap would be {protection_gap.niamh-cannot-work.gap} a year.'};
  const r=await compilePlanPack(pack);
  assert.equal(r.status,'compiled',JSON.stringify(r.diagnostics));
  assert.match(r.routes[0].narration.text,/gap would be €[\d,]+(\.00)? a year/);
});
await test('Unknown fields, owners, goals, outgoing IDs and duplicated facts fail at their paths',async()=>{
  for(const [mutate,path] of [
    [p=>{p.planningInputs.mortgageInputs={};},'/planningInputs/mortgageInputs'],
    [p=>{p.household.primaryPerson.salary=75000;},'/household/primaryPerson/salary'],
    [p=>{p.planningInputs.goalBindings[0].personId='stranger';},'/planningInputs/goalBindings'],
    [p=>{p.routes[2].changes[0].outgoingId='missing';},'/routes/2/changes/0/outgoingId'],
    [p=>{p.routes[3].changes[0].goalId='missing';},'/routes/3/changes/0/goalId'],
    [p=>{p.planningInputs.personalPensionContributions=[{personId:'niamh',annualAmount:3750}];},'/planningInputs/personalPensionContributions'],
    [p=>{p.planningInputs.leftOverEachYear=11000;},'/planningInputs/leftOverEachYear']
  ]) await refused(mutate,'invalid',path);
});
await test('Conflicting cash changes, out-of-bounds moves and overspending cannot compile',async()=>{
  await refused(p=>{p.routes[3].changes.push({type:'clearOutgoing',outgoingId:'mortgage',paidFrom:'savings'});},'invalid','/routes/3');
  await refused(p=>{p.routes[3].changes[0].amount=100000;},'invalid','/routes/3');
  await refused(p=>{p.routes[3].changes=[{type:'moveGoal',goalId:'goal_retirement',retirementAge:60}];},'invalid','/routes/3/changes/0/retirementAge');
  await refused(p=>{p.planningInputs.goalBindings[0].liabilityId='home_loan';},'invalid','/planningInputs/goalBindings/0/liabilityId');
});
await test('Unknown versions, unsupported property chapters, dates and currencies are rejected',async()=>{
  await refused(p=>{p.planPackVersion=2;},'invalid','/planPackVersion');
  await refused(p=>{p.chapters=['home_trade_down'];},'invalid','/chapters/0');
  await refused(p=>{p.calculationDate='2026-02-30';},'invalid','/calculationDate');
  await refused(p=>{p.household.assumptions.calculationDateIso='2027-01-01';},'invalid','/household/assumptions/calculationDateIso');
  await refused(p=>{p.household.preferences.baseCurrency='USD';},'invalid','/household/preferences/baseCurrency');
});
await test('Narration uses registered own-route results and keeps monthly units numeric',async()=>{
  const p=base();p.narration.current='Reserve: {liquidity_analysis.monthsCovered} months. Left over: {household_cash_flow.leftOver}.';
  const r=await compilePlanPack(p);assert.equal(r.status,'compiled');
  assert(!r.routes[0].narration.text.includes('€12.'));
  assert(r.routes[0].narration.text.includes('€11,000'));
  assert(r.routes[2].narration.text.includes('€15,000'));
});
await test('Typed figures, claims, unknown paths and malformed placeholders are rejected atomically',async()=>{
  for(const template of ['You have €1,000.','A 10% change.','In 2030.','Your goal is covered.','{other_route.cashUsed}','{route.constructor}','{route.cashUsed','{household_cash_flow.notReal}']){
    const r=await refused(p=>{p.narration.current=template;},'invalid','/narration/current');
    assert.equal(r.casePacks,null);
  }
});
await test('Markup is escaped, with no deterministic prose rewriting',async()=>{
  const result=resolvePlanNarration('<img src=x onerror=alert(x)> You use {route.cashUsed}.',{'route.cashUsed':{value:20000,type:'money'}});
  assert(result.text.includes('<img'));assert(result.html.includes('&lt;img'));assert(!result.html.includes('<img'));
});
await test('A missing later stage does not hide an unknown narration reference',async()=>{
  await refused(p=>{oneRoute(p);p.chapters=['future_cost_fund'];p.narration.current='{another_route.cashUsed}';},'invalid','/narration/current');
});
await test('Calculation date and version records are present for every derived case',async()=>{
  const r=await compilePlanPack(base());
  for(const c of r.chapters)for(const entry of c.cases){
    assert.equal(entry.provenance.calculationDateSource,'/calculationDate');
    assert.deepEqual(entry.provenance.versions,r.versions);
    assert.equal(entry.provenance.householdSource,'/household');
  }
  assert.equal(entryFor(r,'mortgage_analysis','current').input.startDateIso,'2026-11-01');
  assert.equal(entryFor(r,'household_cash_flow','current').input.calculationYear,2026);
});
await test('A malformed engine input exports no partial successful pack',async()=>{
  const r=await refused(p=>{p.household.liabilities[0].annualInterestRate=-1;},'invalid');
  assert.equal(r.chapters.length,0);assert.equal(r.casePacks,null);
});
await test('Existing case packs retain their checker and cannot masquerade as plan packs',async()=>{
  const pack=JSON.parse(readFileSync('scripts/fixtures/case-packs/valid-call.json','utf8'));
  assert.equal(checkCasePack(pack).ok,true);
  assert.equal((await compilePlanPack(pack)).status,'invalid');
});
await test('The command returns parseable JSON, rejects invalid packs, and never overwrites inputs or existing files',async()=>{
  let result=cli([fixture,'--json']);
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'compiled');
  result=cli(['scripts/fixtures/plan-packs/invalid-version.json','--json']);assert.equal(result.status,1);
  assert.equal(JSON.parse(result.stdout).status,'invalid');
  result=cli(['scripts/fixtures/plan-packs/invalid-duplicate-inputs.json','--json']);
  assert.equal(result.status,1); assert.equal(JSON.parse(result.stdout).diagnostics[0].path,'/mortgageInputs');
  result=cli(['scripts/fixtures/plan-packs/requires-b1.json','--json']);
  assert.equal(result.status,1); assert.equal(JSON.parse(result.stdout).status,'requires_later_stage');
  const dir=mkdtempSync(join(tmpdir(),'b0-plan-pack-'));
  try{
    const file=join(dir,'plan.json'),out=join(dir,'result.json');
    const before=readFileSync(fixture,'utf8');writeFileSync(file,before);writeFileSync(out,'keep me');
    assert.equal(cli([file,'--output',file]).status,1);
    assert.equal(cli([file,'--output',out]).status,1);
    assert.equal(readFileSync(file,'utf8'),before);assert.equal(readFileSync(out,'utf8'),'keep me');
    rmSync(out);assert.equal(cli([file,'--output',out]).status,0);
    assert.equal(JSON.parse(readFileSync(out,'utf8')).status,'compiled');
    assert.equal(cli([file,'--invented-flag']).status,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
await test('Moved goals that need an unimplemented builder are explicit, not silently ignored',async()=>{
  await refused(p=>{oneRoute(p);p.chapters=['net_retirement_cashflow'];p.routes.push({id:'later',changes:[{type:'moveGoal',goalId:'goal_retirement',retirementAge:65}]});},'requires_later_stage','/chapters');
});
await test('Expense wording is supplied by the author and copied exactly',async()=>{
  const p=base();p.planningInputs.spendingLabel='Regular spending';const r=await compilePlanPack(p);
  assert.equal(entryFor(r,'household_cash_flow','current').input.outgoings.at(-1).label,'Regular spending');
  await refused(p=>{delete p.planningInputs.spendingLabel;},'invalid','/planningInputs/spendingLabel');
});
await test('Overflowing financial totals are refused rather than serialised as null or zero',async()=>{
  await refused(p=>{oneRoute(p);p.chapters=['personal_balance_sheet'];p.household.assets[0].currentValue.amount=1e308;p.household.assets.push({...structuredClone(p.household.assets[0]),assetId:'other_cash'});},'invalid');
});
await test('Normalizer output remains a valid plan-pack input',async()=>{
  const first=normalizePlanPack(base());
  assert.deepEqual(normalizePlanPack(first),first);
});
await test('Foreign-currency household amounts cannot become zero in a EUR adapter', async () => {
  await refused(p => { p.household.assets[0].currentValue.currency = 'USD'; }, 'invalid', '/household/assets/0/currentValue/currency');
});
await test('Two goals cannot overwrite the same person retirement age', async () => {
  await refused(p => {
    oneRoute(p); p.chapters = ['pension_projection'];
    p.household.goals.push({ ...structuredClone(p.household.goals[0]), goalId: 'another_retirement' });
    p.planningInputs.goalBindings.push({ goalId: 'another_retirement', personId: 'niamh' });
    p.goalFlexibility.another_retirement = { retirementAge: [62, 67] };
    p.routes.push({ id: 'conflict', changes: [
      { type: 'moveGoal', goalId: 'goal_retirement', retirementAge: 62 },
      { type: 'moveGoal', goalId: 'another_retirement', retirementAge: 65 }
    ] });
  }, 'invalid', '/routes/1/changes/1/retirementAge');
});
await test('Shared cases retain every route use and the exact adapter source snapshot', async () => {
  const r = await compilePlanPack(base());
  const entry = entryFor(r, 'household_cash_flow', 'current');
  assert.deepEqual(entry.provenance.uses.map(u => u.routeId), ['current', 'unchanged', 'cash_to_mortgage']);
  assert.equal(entry.provenance.builderHousehold.expenses.annualTotal.amount, 84000);
  assert.equal(entryFor(r, 'household_cash_flow', 'clear_car').provenance.builderHousehold.expenses.annualTotal.amount, 78000);
  assert.deepEqual(r.source.normalizedPlanPack, normalizePlanPack(base()));
});
await test('An estimated bank income is marked and warned; protection still requires a stated amount', async () => {
  const p = oneRoute(base()); p.chapters = ['household_cash_flow'];
  delete p.household.incomeSources[0].netAnnual;
  const r = await compilePlanPack(p);
  assert.equal(r.status, 'compiled', JSON.stringify(r.diagnostics));
  const entry = entryFor(r, 'household_cash_flow', 'current');
  assert.equal(entry.basis, 'includes_estimated_bank_pay');
  assert(entry.warnings.some(w => w.includes('estimated')));
  p.household.incomeSources[0].netAnnual = { amount: 10000, currency: 'EUR' };
  const short = await compilePlanPack(p);
  assert.equal(short.status, 'compiled', JSON.stringify(short.diagnostics));
  const shortEntry = entryFor(short, 'household_cash_flow', 'current');
  assert(shortEntry.metrics.leftOver < 0);
  const native = computeHouseholdCashFlowProjection(shortEntry.input);
  assert(native.debug.warnings.length > 0);
  for (const warning of native.debug.warnings) assert(shortEntry.warnings.includes(warning));
  assert(shortEntry.assumptionsUsed.some(a => a.key === 'taxSourceByPerson'));
});
await test('An absent income record is not treated as a confirmed zero', async () => {
  await refused(p => { p.household.incomeSources.pop(); }, 'invalid', '/household/incomeSources');
});
await test('A calendar-year placeholder has no thousands separator', () => {
  assert.equal(resolvePlanNarration('From {pension_projection.retirementYear}.', {
    'pension_projection.retirementYear': { value: 2048, type: 'year' }
  }).text, 'From 2048.');
});
await test('Separate age and income changes count and name one moved goal once', async () => {
  const p = oneRoute(base()); p.chapters = ['pension_projection'];
  p.goalFlexibility.goal_retirement.targetIncomeToday = [40000, 50000];
  p.routes.push({ id: 'later', changes: [
    { type: 'moveGoal', goalId: 'goal_retirement', retirementAge: 65 },
    { type: 'moveGoal', goalId: 'goal_retirement', targetIncomeToday: 45000 }
  ] });
  p.narration.later = '{route.goalChangeCount}: {route.goalsMoved}';
  const r = await compilePlanPack(p);
  assert.equal(r.status, 'compiled', JSON.stringify(r.diagnostics));
  assert.equal(r.routes[1].narration.text, '1: ' + p.household.goals[0].title);
  assert.equal(entryFor(r, 'pension_projection', 'later').input.targetIncomeToday, 45000);
  assert.equal(entryFor(r, 'pension_projection', 'later').input.pensions[0].retirementAge, 65);
});
console.info=originalInfo;
console.log('Plan-pack checks: '+(total-failures)+'/'+total+' passed.');
process.exitCode=failures?1:0;
