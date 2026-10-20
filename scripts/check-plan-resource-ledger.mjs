#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compilePlanPack } from '../js/planning/plan_pack/compiler.js';
import { normalizePlanPack } from '../js/planning/plan_pack/schema.js';
import { priceInvestmentSales } from '../js/planning/plan_pack/investment_sales.js';
import { computeTaxYear } from '../js/planning/tax/engine.js';
import { resolveTaxRules } from '../js/planning/tax/resolve.js';
import { computeHouseholdCashFlowProjection } from '../js/household_cash_flow_math.js';
import { computeAmortizationMonthlySchedule } from '../js/mortgage_math.js';
import { computeFutureCostFundProjection } from '../js/future_cost_fund_math.js';
import { computePensionProjection, computePersonalContributionCosts } from '../js/pension_math.js';
import { checkCasePack } from '../js/module_pipeline.js';
import { SEMANTIC_FACT_CATALOGUE } from '../js/planning/semantic_facts.js';

const fixture = 'scripts/fixtures/plan-packs/valid-b1.json';
const base = () => JSON.parse(readFileSync(fixture, 'utf8'));
const compile = p => compilePlanPack(p, { resourceLedger: true });
const ledger = (r, id='current') => r.resourceLedger.routes.find(row => row.routeId === id);
const entry = (r, chapter, id='current') => r.chapters.find(c => c.id === chapter).cases.find(c => c.id === r.routes.find(row => row.id === id).chapterCases[chapter]);
const close = (a,b) => assert(Math.abs(a-b)<0.01, `${a} != ${b}`);
const valid = r => assert.equal(r.status, 'compiled', JSON.stringify(r.diagnostics));
const eur = amount => ({ amount, currency:'EUR' });
function lean(ids=[]) {
  const p = base(); p.routes=[{id:'current'}]; p.narration={};
  p.chapters=['household_cash_flow','liquidity_analysis','personal_balance_sheet'];
  p.household.goals=p.household.goals.filter(g=>ids.includes(g.goalId));
  for (const key of ['goalBindings','goalFundingFacts']) p.planningInputs[key]=p.planningInputs[key].filter(g=>ids.includes(g.goalId));
  p.goalFlexibility=Object.fromEntries(Object.entries(p.goalFlexibility).filter(([id])=>ids.includes(id)));
  return p;
}
function investment(p, id, value, extra={}) {
  p.household.assets.push({assetId:id,type:'investment',label:id,ownerIds:['niamh'],currentValue:eur(value),investmentTaxTreatment:'ordinary_cgt',...extra});
}
function dated(p, id, start, cost=10000, saving=0) {
  p.household.goals.push({goalId:id,type:'assess_decision',title:id,priority:'low',status:'active',targetDate:`${2026+start}-11-01`,targetAmount:eur(cost)});
  p.planningInputs.goalFundingFacts.push({goalId:id,kind:'dated_cost',costKind:'general',durationYears:1,currentAnnualSaving:saving});
}
let total=0,failures=0;
const info=console.info; console.info=()=>{};
async function test(name, fn) { total++; try { await fn(); console.log('PASS '+name); } catch(error) { failures++; console.error('FAIL '+name+': '+error.stack); } }
async function refuses(p, code) { const r=await compile(p); assert.notEqual(r.status,'compiled'); assert.equal(r.casePacks,null); if(code) assert(r.diagnostics.some(d=>d.code===code), JSON.stringify(r.diagnostics)); return r; }

await test('B1 joins native chapters, checks every alternative and preserves the source facts',async()=>{
  const p=base(),before=structuredClone(p),r=await compile(p); valid(r);
  assert.deepEqual(p,before);assert.deepEqual(r.source.normalizedPlanPack,normalizePlanPack(p));
  assert.equal(r.resourceLedger.status,'priced');assert.match(r.scope,/B1/);
  assert(r.resourceLedger.routes.every(row=>row.balanced));
  for (const l of r.resourceLedger.routes) close(l.years[0].remaining,entry(r,'household_cash_flow',l.routeId).metrics.leftOver);
  for(const row of r.casePacks) assert(checkCasePack(row.casePack).ok);
});
await test('Current retains actual saving, debt payments and pension deductions',async()=>{
  const p=base(),r=await compile(p);valid(r);const l=ledger(r);
  assert(l.currentPositionUnchanged);assert.equal(l.cashAllocated,0);assert.equal(l.cashRemaining,90000);
  assert.equal(l.years[0].planned,1000);close(entry(r,'household_cash_flow').metrics.leftOver,10000);
  assert.equal(entry(r,'mortgage_analysis').input.fixedPaymentAmount,1700);
  assert.equal(entry(r,'pension_projection').input.pensions[0].personalPct,0.05);
  assert.equal(l.goals.find(g=>g.goalId==='goal_mortgage').state,'partly');
});
await test('The reserve remains at the opening policy amount when a loan is cleared',async()=>{
  const r=await compile(base());valid(r);const a=ledger(r),b=ledger(r,'clear_car');
  assert.equal(a.reserve.protectedAmount,42000);assert.equal(b.reserve.protectedAmount,a.reserve.protectedAmount);
  assert.equal(b.cashAllocated,15000);assert.equal(b.cashRemaining,75000);assert.equal(b.baselineLeftOver,17000);
});
await test('An overspend of the reserve refuses an alternative atomically and retains its ledger',async()=>{
  const p=lean(['goal_mortgage']);p.routes.push({id:'overspend',changes:[{type:'useCash',goalId:'goal_mortgage',amount:49000}]});
  const r=await refuses(p,'unbalanced_route');assert.equal(ledger(r,'overspend').reserveProtected,false);assert.deepEqual(r.chapters,[]);
});
await test('A short current household remains a diagnostic picture; the same alternative is refused',async()=>{
  const p=lean();p.household.expenses.annualTotal.amount=100000;
  let r=await compile(p);valid(r);assert.equal(ledger(r).years[0].available,-5000);assert.equal(ledger(r).balanced,false);
  assert.equal(ledger(r).years[0].cashflowDeficit,5000);assert.equal(ledger(r).years[0].goals.length,0);
  p.routes.push({id:'unchanged'});r=await refuses(p,'unbalanced_route');assert.equal(ledger(r,'unchanged').years[0].remaining,-5000);
});
await test('An annual shortfall reports the unfunded goal and the first calendar year',async()=>{
  const p=lean(['college']);p.household.expenses.annualTotal.amount=94000;p.routes.push({id:'fund'});
  const r=await refuses(p,'unbalanced_route'),l=ledger(r,'fund');assert(l.years[0].shortfall>0);assert.equal(l.goals[0].firstShortYear,0);
  assert(r.diagnostics.some(d=>d.message.includes('2026')));
});
await test('Dated costs use the native fund engine, and later years release only their own transfers',async()=>{
  const p=lean();dated(p,'later',8);dated(p,'sooner',3);p.routes.push({id:'fund'});
  const r=await compile(p);valid(r);const l=ledger(r,'fund');assert.deepEqual(l.goalOrder,['sooner','later']);
  for(const q of l.pricing) close(q.priced.cases[0].yearlyAmount,computeFutureCostFundProjection(q.input,{calculationYear:2026}).debug.cases[0].yearlyAmount);
  close(l.years[3].planned,l.pricing.find(q=>q.goalId==='later').priced.cases[0].yearlyAmount);
  assert.equal(l.years[0].available,l.years[7].available);
});
await test('Whole resolves a native cash need; remaining uses only resources left after explicit commitments',async()=>{
  const p=lean(['college','goal_mortgage']);p.routes.push({id:'use_cash',changes:[{type:'useCash',goalId:'goal_mortgage',amount:'remaining'},{type:'useCash',goalId:'college',amount:'whole'}]});
  const r=await compile(p);valid(r);const l=ledger(r,'use_cash');
  close(l.cashAllocated,l.cashAvailableAfterReserve);close(l.cashRemaining,l.reserve.protectedAmount);
  const college=l.pricing.find(g=>g.goalId==='college');close(college.priced.cases[0].lumpSumToday,college.priced.requiredToday);
});
await test('Whole debt funding is the native lump sum that retains today’s repayment',async()=>{
  const p=lean(['goal_mortgage']);p.household.assets[0].currentValue.amount=150000;p.routes.push({id:'whole',changes:[{type:'useCash',goalId:'goal_mortgage',amount:'whole'}]});
  const r=await compile(p);valid(r);const q=ledger(r,'whole').pricing[0];close(q.priced.monthlyPayment,1700);
  close(q.priced.monthlyPayment,computeAmortizationMonthlySchedule(q.input,{scenarioId:'clear-by-age'}).monthlyPaymentUsed);
});
await test('A lump sum on an already-covered loan keeps its payment and shortens its existing schedule',async()=>{
  const p=lean(['goal_loan']);p.chapters.push('loan_analysis');p.routes.push({id:'part',changes:[{type:'useCash',goalId:'goal_loan',amount:5000}]});
  const r=await compile(p);valid(r);const q=ledger(r,'part').pricing[0],native=computeAmortizationMonthlySchedule(q.input,{scenarioId:'clear-by-age'});
  assert.equal(q.priced.lumpSum,5000);assert.equal(q.priced.monthlyPayment,500);assert.equal(native.openingBalance,10000);
  close(entry(r,'loan_analysis','part').metrics.totalInterest,native.totalInterestLifetime);
  assert.equal(ledger(r,'part').years[0].planned,0);
});
await test('Earmarked cash remains on the balance sheet and cannot also protect the reserve',async()=>{
  const p=lean(['college']);p.household.assets.push({assetId:'college_cash',type:'cash',label:'College cash',ownerIds:['niamh'],currentValue:eur(10000)});
  p.planningInputs.assetAssignments=[{assetId:'college_cash',goalId:'college'}];p.chapters.push('protection_gap');
  const r=await compile(p);valid(r);const l=ledger(r);
  assert.equal(l.openingCash,90000);assert.equal(entry(r,'liquidity_analysis').input.currentCash,90000);
  assert.equal(entry(r,'protection_gap').input.savings,90000);
  assert.equal(entry(r,'personal_balance_sheet').metrics.grossAssets,480000);
  close(l.pricing[0].priced.cases[0].lumpSumToday,10000);
});
await test('New reserved cost capital stays an asset and is removed from protection cash exactly once',async()=>{
  const p=lean(['college']);p.chapters.push('protection_gap');p.routes.push({id:'reserve_cost',changes:[{type:'useCash',goalId:'college',amount:10000}]});
  const r=await compile(p);valid(r);assert.equal(ledger(r,'reserve_cost').cashRemaining,80000);
  assert.equal(entry(r,'personal_balance_sheet','reserve_cost').metrics.grossAssets,470000);
  assert.equal(entry(r,'protection_gap','reserve_cost').input.savings,80000);
});
await test('Assignments, duplicate child/debt goals and unknown funding kinds cannot silently consume resources twice',async()=>{
  let p=lean(['college']);p.planningInputs.assetAssignments=[{assetId:'cash',goalId:'college'},{assetId:'cash',goalId:'college'}];await refuses(p);
  p=lean(['college']);p.household.goals.push({...p.household.goals[0],goalId:'second'});p.planningInputs.goalFundingFacts.push({goalId:'second',dependantId:'aoife',currentAnnualSaving:0});await refuses(p);
  p=lean(['goal_mortgage']);p.household.goals.push({...p.household.goals[0],goalId:'second'});p.planningInputs.goalBindings.push({goalId:'second',liabilityId:'home_loan',personId:'niamh'});await refuses(p);
  p=lean(['college']);p.planningInputs.goalFundingFacts[0].kind='debt';await refuses(p);
});
await test('Missing saving and basis facts are refused, including missing zero',async()=>{
  for(const mutate of [p=>delete p.planningInputs.goalFundingFacts[0].currentAnnualSaving,p=>delete p.planningInputs.goalSavingBasis,p=>{p.planningInputs.goalFundingFacts[0].durationYears=4;}]) {
    const p=lean(['college']);mutate(p);await refuses(p);
  }
});
await test('A moved dated goal uses its bounded date and amount in each route independently',async()=>{
  const p=lean();dated(p,'cost',4);p.goalFlexibility.cost={targetDate:['2030-11-01','2034-11-01'],targetAmount:[5000,15000]};
  p.routes.push({id:'move',changes:[{type:'moveGoal',goalId:'cost',targetDate:'2034-11-01',targetAmount:5000}]});
  const r=await compile(p);valid(r);assert.equal(ledger(r).pricing[0].input.startsInYears,4);assert.equal(ledger(r,'move').pricing[0].input.startsInYears,8);
  assert.equal(ledger(r,'move').pricing[0].input.annualCostToday,5000);
});
await test('Retirement uses native net-income pricing with each person’s age and contribution costs',async()=>{
  const p=lean(['goal_retirement']);p.chapters.push('pension_projection');p.household.incomeSources[0].grossAnnual.amount=100000;p.household.incomeSources[0].netAnnual.amount=70000;
  p.household.incomeSources[1].grossAnnual.amount=50000;p.household.incomeSources[1].netAnnual.amount=36000;p.household.expenses.annualTotal.amount=40000;
  p.household.partner.intendedRetirementAge=65;p.household.goals[0].targetAmount.amount=80000;p.routes.push({id:'fund'});
  const r=await compile(p);valid(r);const l=ledger(r,'fund');
  const q=l.pricing[0],priced=q.priced;assert(priced.extraPoints>0);
  assert.equal(priced.plannedInput.pensions[0].retirementAge,67);assert.equal(priced.plannedInput.pensions[1].retirementAge,65);
  const direct=computePensionProjection(priced.plannedInput).debug;close(entry(r,'pension_projection','fund').metrics.projectedPot,direct.projectedPotCurrent);
  const costs=computePersonalContributionCosts(priced.plannedInput);assert.deepEqual(costs,priced.costsWithExtra);
  if(r.status==='compiled') {const cf=entry(r,'household_cash_flow','fund');assert.equal(cf.input.scenarios[1].changes.length,2);assert.notEqual(cf.input.scenarios[1].changes[0].amount,cf.input.scenarios[1].changes[1].amount);close(l.years[0].remaining,cf.metrics.leftOver);}
});
await test('Relief-capped retirement can balance contributions while clearly retaining an unmet goal',async()=>{
  const p=lean(['goal_retirement']);p.household.goals[0].targetAmount.amount=200000;p.household.expenses.annualTotal.amount=30000;p.routes.push({id:'fund'});
  const r=await compile(p);valid(r);const l=ledger(r,'fund');assert(l.balanced);assert(!l.goalsCovered);assert(l.goals[0].unreachable);assert.equal(l.goals[0].state,'partly');assert(l.pricing[0].priced.disclosures.length>0);
});
await test('Multiple retirement goals and unsupported goals name the later adapter they need',async()=>{
  let p=lean(['goal_retirement']);p.household.goals.push({...p.household.goals[0],goalId:'other'});await refuses(p,'requires_combined_retirement_goal');
  p=lean();p.household.goals.push({goalId:'home',type:'buy_home',title:'Home',status:'active',priority:'medium'});await refuses(p,'requires_goal_funding_adapter');
});
await test('Tax engine supports an ordinary investment sale without property-only relief',()=>{
  const p=lean();investment(p,'shares',20000,{baseCost:eur(10000),acquisitionDate:'2012-01-01'});
  const result=priceInvestmentSales(p.household,['shares'],'2026-11-01','married_or_civil_partners');
  assert.equal(result.result.disposals[0].homeExempt,false);assert.equal(result.result.disposals[0].section604A.applies,false);
  const direct=computeTaxYear({input:result.input});close(result.tax,direct.result.capitalGains.total);assert(result.tax>0);
});
await test('Missing base cost means disclosed zero; a stated zero is distinguished and the field stays optional',()=>{
  const p=lean();investment(p,'unknown',10000);investment(p,'zero',10000,{baseCost:eur(0)});
  const a=priceInvestmentSales(p.household,['unknown'],'2026-11-01','married_or_civil_partners');
  const b=priceInvestmentSales(p.household,['zero'],'2026-11-01','married_or_civil_partners');close(a.tax,b.tax);
  assert.equal(a.sales[0].baseCostBasis,'assumed_zero');assert.equal(b.sales[0].baseCostBasis,'stated');
  assert(a.disclosures.some(d=>d.code==='CGT_BASE_COST_ASSUMED_ZERO'&&d.text.includes('€0')));
  assert(!b.disclosures.some(d=>d.code==='CGT_BASE_COST_ASSUMED_ZERO'));assert(!('baseCost' in normalizePlanPack(p).household.assets[1]));
});
await test('Known costs, costs of sale, losses, joint ownership and one annual exemption use one native batch',()=>{
  const p=lean();investment(p,'gain',20000,{baseCost:eur(5000),sellingCosts:eur(1000)});investment(p,'loss',2000,{baseCost:eur(6000)});
  const a=priceInvestmentSales(p.household,['gain','loss'],'2026-11-01','married_or_civil_partners');
  assert.equal(a.result.byPerson[0].annualExemptionUsed,1270);assert.equal(a.result.byPerson[0].currentYearLossesUsed,4000);
  close(a.tax,(14000-4000-1270)*a.result.disposals[0].rate);close(a.netProceeds,21000-a.tax);
  p.household.assets[1].ownerIds=['niamh','dara'];const joint=priceInvestmentSales(p.household,['gain'],'2026-11-01','married_or_civil_partners');
  assert.equal(joint.result.byPerson.filter(row=>row.annualExemptionUsed===1270).length,2);
});
await test('Indexation uses a supplied acquisition date and never invents an unknown date',()=>{
  const p=lean();investment(p,'old',20000,{baseCost:eur(5000),acquisitionDate:'1990-01-01'});
  const a=priceInvestmentSales(p.household,['old'],'2026-11-01','married_or_civil_partners');assert(a.result.disposals[0].indexation.multiplier>1);
  delete p.household.assets[1].acquisitionDate;const b=priceInvestmentSales(p.household,['old'],'2026-11-01','married_or_civil_partners');
  assert.equal(b.result.disposals[0].indexation.multiplier,1);assert(b.disclosures.some(d=>d.code==='CGT_ACQUISITION_DATE_UNKNOWN'));assert(b.tax>a.tax);
});
await test('Dated rates and opening tax losses are reused from the central engine without mutating history',()=>{
  const p=lean();investment(p,'shares',10000);const state={people:{niamh:{cgtLossesCarriedForward:2000}}},before=structuredClone(state);
  const a=priceInvestmentSales(p.household,['shares'],'2026-10-06','married_or_civil_partners',state);
  const b=priceInvestmentSales(p.household,['shares'],'2026-10-07','married_or_civil_partners',state);
  assert.deepEqual(state,before);assert(a.tax>b.tax);assert.equal(b.result.byPerson[0].lossesBroughtForwardUsed,2000);
  const rules=resolveTaxRules(2026);assert(rules.capitalGainsTax);assert.equal(b.result.disposals[0].rateStatus,'announced');
});
await test('Holdings and hypothetical net sale proceeds are shown separately from spendable cash',async()=>{
  const p=lean();investment(p,'shares',10000);investment(p,'fund',5000,{investmentTaxTreatment:'fund_exit_tax'});
  const r=await compile(p);valid(r);const l=ledger(r);assert.equal(l.cashRemaining,90000);assert.equal(l.openingCash,90000);
  assert.equal(l.investments.countedAsCash,false);assert.equal(l.investments.holdings.length,2);assert(l.investments.potentialSale.netProceeds<10000);
  assert.equal(l.investments.holdings[1].valuationStatus,'requires_sale_facts_or_adapter');
});
await test('An explicit sale adds only net proceeds and removes the original holding from the balance sheet',async()=>{
  const p=lean();investment(p,'shares',10000);p.routes.push({id:'sell',changes:[{type:'sellAsset',assetId:'shares'}]});
  const r=await compile(p);valid(r);const l=ledger(r,'sell');close(l.cashRemaining,90000+l.investmentSales.netProceeds);
  close(entry(r,'personal_balance_sheet','sell').metrics.grossAssets,l.cashRemaining+380000);assert(l.investments.holdings[0].soldInRoute);
  assert(l.investmentSales.disclosures.some(d=>d.code==='CGT_BASE_COST_ASSUMED_ZERO'));
});
await test('A sale batch never duplicates the exemption, and unknown/fund treatment never masquerades as CGT',async()=>{
  const p=lean();investment(p,'a',10000);investment(p,'b',10000);p.routes.push({id:'sell',changes:[{type:'sellAsset',assetId:'a'},{type:'sellAsset',assetId:'b'}]});
  const r=await compile(p);valid(r);close(ledger(r,'sell').investmentSales.tax,(20000-1270)*0.31);
  for(const treatment of ['fund_exit_tax','unknown']){p.household.assets[1].investmentTaxTreatment=treatment;await refuses(p,'requires_sale_tax_adapter');}
});
await test('A–B–A and B–A–B sale routes start from the same tax history and retain exact input hashes',async()=>{
  const p=lean();investment(p,'a',10000);investment(p,'b',20000,{baseCost:eur(7000)});p.planningInputs.openingTaxState={people:{niamh:{cgtLossesCarriedForward:3000}}};
  const route=(id,assetId)=>({id,changes:[{type:'sellAsset',assetId}]});p.routes.push(route('a','a'),route('b','b'),route('again','a'));
  const before=structuredClone(p),a=await compile(p);valid(a);assert.deepEqual(p,before);
  assert.deepEqual(ledger(a,'a').investmentSales,ledger(a,'again').investmentSales);
  const q=structuredClone(p);q.routes=[{id:'current'},route('b','b'),route('a','a'),route('again','b')];const b=await compile(q);valid(b);
  assert.deepEqual(ledger(a,'b').investmentSales,ledger(b,'again').investmentSales);assert.equal(entry(a,'personal_balance_sheet','a').id,entry(b,'personal_balance_sheet','a').id);
});
await test('Duplicate sales, unsupported asset assignments and unknown sale fields are refused',async()=>{
  let p=lean();investment(p,'a',10000);p.routes.push({id:'twice',changes:[{type:'sellAsset',assetId:'a'},{type:'sellAsset',assetId:'a'}]});await refuses(p);
  p=lean(['college']);investment(p,'a',10000);p.planningInputs.assetAssignments=[{assetId:'a',goalId:'college'}];await refuses(p,'requires_goal_asset_adapter');
  assert.throws(()=>computeTaxYear({input:{year:2026,status:'single',people:[{id:'a',age:40}],items:[],events:[{type:'investmentDisposal',personId:'a',disposalDate:'2026-11-01',proceeds:10000,acquisitionCost:0,homeUse:'throughout'}]}}),/homeUse/);
  p=lean();investment(p,'a',10000,{baseCost:{amount:5000,currency:'USD'}});await refuses(p);
  assert.throws(()=>priceInvestmentSales(p.household,['a'],'2026-11-01','married_or_civil_partners'),/EUR/);
});
await test('B0 remains compilation-only; B1 narration can reference only its own calculated ledger',async()=>{
  const p=lean();let r=await compilePlanPack(p);valid(r);assert.equal(r.resourceLedger.status,'not_computed');
  p.narration.current='Reserve: {ledger.reserve}. {ledger.balanceStatus}.';r=await compile(p);valid(r);assert.equal(r.routes[0].narration.text,'Reserve: €42,000.00. Balances.');
  p.narration.current='This is balanced.';await refuses(p);
});
await test('The CLI discloses assumed zero cost, returns JSON, and does not overwrite a file',()=>{
  const p=lean();investment(p,'shares',10000);const dir=mkdtempSync(join(tmpdir(),'b1-plan-'));
  const cli=args=>spawnSync(process.execPath,['scripts/check-plan-pack.mjs',...args],{encoding:'utf8',maxBuffer:20*1024*1024});
  try {const file=join(dir,'plan.json'),out=join(dir,'result.json');writeFileSync(file,JSON.stringify(p));
    let r=cli([file,'--ledger']);assert.equal(r.status,0,r.stderr);assert(r.stdout.includes('€0 base cost'));assert(r.stdout.includes('not added to cash'));
    r=cli([file,'--ledger','--json','--output',out]);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).resourceLedger.status,'priced');
    assert.equal(cli([file,'--ledger','--output',out]).status,1);assert.equal(JSON.parse(readFileSync(out)).status,'compiled');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
await test('Loan requirements take yearly money before dated costs and mortgages',async()=>{
  const p=lean(['goal_loan','goal_mortgage']);p.household.goals.find(g=>g.goalId==='goal_loan').targetDate='2027-11-01';
  p.planningInputs.goalFundingFacts=[];dated(p,'cost',3);p.household.expenses.annualTotal.amount=90000;p.routes.push({id:'fund'});
  const r=await refuses(p,'unbalanced_route'),l=ledger(r,'fund');assert.deepEqual(l.goalOrder,['goal_loan','cost','goal_mortgage']);
  close(l.years[0].goals[0].allocated,5000);assert.equal(l.years[0].goals[1].allocated,0);
});
await test('Route order follows cash committed rather than outcomes or author priority',async()=>{
  const p=lean(['goal_mortgage']);p.routes.push(...[20000,10000,30000].map((amount,i)=>({id:'route_'+i,changes:[{type:'useCash',goalId:'goal_mortgage',amount}]})));
  const r=await compile(p);valid(r);assert.deepEqual(r.routes.map(row=>row.id),['current','route_1','route_0','route_2']);
});
await test('Two named pension changes retain ownership, add their actual amounts, and refuse overlapping joint changes',()=>{
  const input={calculationYear:2026,householdTaxStatus:'married_or_civil_partners',people:[{id:'a',age:45,label:'Niamh'},{id:'b',age:45,label:'Dara'}],
    income:[{personId:'a',type:'employment',amount:100000},{personId:'b',type:'employment',amount:50000}],outgoings:[{id:'living',label:'Living costs',amount:20000}],
    scenarios:[{id:'today'},{id:'extra',changes:[{type:'extraPension',personId:'a',amount:2000},{type:'extraPension',personId:'b',amount:1000}]}]};
  const result=computeHouseholdCashFlowProjection(input);assert.equal(result.summary.cases[1].pensionContributions.gross,3000);
  const changes=input.scenarios[1].changes;
  changes[1].personId='a';assert.throws(()=>computeHouseholdCashFlowProjection(input),/only one extraPension for each person/);
  delete changes[1].personId;assert.throws(()=>computeHouseholdCashFlowProjection(input),/only one extraPension for each person/);
});
await test('The asset-intake question asks for base cost conditionally and keeps it optional',()=>{
  const question=SEMANTIC_FACT_CATALOGUE.find(f=>f.factId==='asset_position').questionPrompt;
  assert.match(question,/If you want to explore selling/);assert.match(question,/optional/);assert.match(question,/assumes €0/);
});
await test('A stated-left-over pack can price the ledger but cannot show stale protection bank pay after a pension change',async()=>{
  const p=lean(['goal_retirement']);p.chapters=['liquidity_analysis'];p.planningInputs.leftOverEachYear=100000;
  p.household.goals[0].targetAmount.amount=100000;p.routes.push({id:'fund'});let r=await compile(p);valid(r);
  assert(ledger(r,'fund').pricing[0].priced.extraPoints>0);
  p.chapters.push('protection_gap');r=await refuses(p,'missing_information');assert(r.diagnostics.some(d=>d.message.includes('household_cash_flow')));
});
await test('A priced ledger does not pretend incomplete screen adapters are route-exact',async()=>{
  for (const chapter of ['college_funding','net_retirement_cashflow','goals_and_resources','future_cost_fund']) {
    const p=base();p.routes=[{id:'current'}];p.narration={};p.chapters=['household_cash_flow',chapter];
    const r=await refuses(p,'requires_profile_adapter');assert.equal(r.status,'requires_later_stage');assert.equal(ledger(r).status,'priced');
  }
});
await test('Unpriced goal amounts and dates cannot be silently ignored',async()=>{
  let p=lean(['goal_mortgage']);p.goalFlexibility.goal_mortgage.targetAmount=[10000,50000];
  p.routes.push({id:'partial',changes:[{type:'moveGoal',goalId:'goal_mortgage',targetAmount:20000}]});await refuses(p,'requires_goal_funding_adapter');
  p=lean(['goal_retirement']);p.household.goals[0].targetDate='2048-11-01';await refuses(p,'requires_goal_funding_adapter');
  p=lean();p.household.goals.push({goalId:'buffer',type:'maintain_liquidity',title:'Emergency fund',priority:'medium',status:'active',targetAmount:eur(100000)});await refuses(p,'requires_goal_funding_adapter');
  delete p.household.goals[0].targetAmount;p.goalFlexibility.buffer={targetAmount:[10000,100000]};p.routes.push({id:'change_buffer',changes:[{type:'moveGoal',goalId:'buffer',targetAmount:80000}]});await refuses(p,'requires_goal_funding_adapter');
});
console.info=info;console.log(`Resource-ledger checks: ${total-failures}/${total} passed.`);process.exitCode=failures?1:0;
