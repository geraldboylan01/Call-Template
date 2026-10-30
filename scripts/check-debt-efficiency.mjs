import assert from 'node:assert/strict';
import { majorHouseholds } from './fixtures/major-levers.households.mjs';
import { profileToPlanPack } from '../js/planning/profile_to_plan_pack.js';
import { suggestRoutes, priceRoute, goalWays, balancingMoves } from '../js/planning/plan_pack/ledger_walk.js';
import { walkSession } from '../js/planning/plan_pack/walk_session.js';
import { inefficiencyFirst, clearance } from '../js/planning/plan_pack/debt_efficiency.js';
import { checkStory, getStoryRequirements } from '../js/planning/plan_pack/story_checker.js';
import { minimalAnalystStory } from './fixtures/minimal-analyst-story.mjs';
import { toolReply } from '../js/planning/analyst/replies.js';
import { readFileSync } from 'node:fs';

const info = console.info; console.info = () => {};
const eur = amount => ({ amount, currency: 'EUR' });
const empty = { id: 'debt_test', changes: [] };
const assembly = await profileToPlanPack(majorHouseholds().tradeDown, { confirmedRevision: 7, clientLabel: 'Invented debt efficiency test', routes: [] });
assert.ok(assembly.planPack, JSON.stringify(assembly.missingFacts));
const pack = assembly.planPack;
const car = pack.household.liabilities.find(debt => debt.type === 'loan');
const clear = clearance(pack, car);
try {
  const suggestions = await suggestRoutes(assembly);
  assert.equal(suggestions.status, 'priced');
  for (const suggestion of suggestions.suggestions) {
    assert.deepEqual(suggestion.route.changes[0], clear, suggestion.families.join(', '));
    assert.ok(!suggestion.route.changes.some(change => change.type === 'clearOutgoing' && change.outgoingId !== clear.outgoingId));
  }
  const major = suggestions.suggestions.find(row => row.families.includes('smallest_major_move'));
  assert.ok(major?.allGoalsOnTime);
  const ways = await goalWays(assembly, empty, 'fictional_dated_cost');
  assert.ok(ways.ways.filter(way => way.route).every(way => way.route.changes[0].outgoingId === clear.outgoingId));
  const moves = await balancingMoves(await priceRoute(assembly, empty));
  assert.ok(moves.moves.every(move => move.route.changes[0].outgoingId === clear.outgoingId));

  // Same transaction as the former route: clearing the car and assigning the
  // remaining savings preserves both goals and releases yearly spending.
  const old = structuredClone(major.route);
  old.changes = old.changes.filter(change => change.type !== 'clearOutgoing');
  old.changes.find(change => change.type === 'useCash').amount = 69000;
  old.changes.find(change => change.type === 'tradeDownHome').newHomePrice = 472988.11;
  const before = await priceRoute(assembly, old);
  const corrected = structuredClone(old);
  corrected.changes.unshift(clear);
  corrected.changes.find(change => change.type === 'useCash').amount = 'remaining';
  const after = await priceRoute(assembly, corrected);
  assert.ok(before.meetsAllGoals && after.meetsAllGoals);
  for (const year of [2026, 2027]) assert.ok(after.ledger.years.find(row => row.year === year).remaining > before.ledger.years.find(row => row.year === year).remaining + 370,
    JSON.stringify({ year, before: before.ledger.years.find(row => row.year === year).remaining, after: after.ledger.years.find(row => row.year === year).remaining }));
  const notes = before.notes;
  assert.ok(notes.some(note => note.path === '/household/liabilities/0' && note.reasonCode === 'not_cleared'));
  assert.equal(notes[0].yearlyCost, 150);
  const requirements = getStoryRequirements(before.compilation, before.routeDraft.id);
  const reasonKey = 'inefficiencies.' + car.liabilityId + '.reason';
  assert.ok(requirements.required.some(row => row.section === 'inefficiencies' && row.key === reasonKey));
  const story = minimalAnalystStory(before.compilation, before.routeDraft.id);
  assert.equal(checkStory(before.compilation, story).ok, true);
  story.sections[3].parts.gives = story.sections[3].parts.gives.replace('{' + reasonKey + '}', '');
  assert.ok(checkStory(before.compilation, story).refusals.some(row => row.code === 'required_fact'));
  assert.deepEqual(toolReply('price_route', { ok: true, data: { route: before.routeDraft, ledger: before.ledger, notes } }).data.notes, notes);
  assert.match(getStoryRequirements(after.compilation, after.routeDraft.id).facts['moves.change_2.loanRepaid'].value, /sale repays Invented home loan: €60,000.00/);
  const fixtureStory = JSON.parse(readFileSync(new URL('./fixtures/analyst-trade-down-story.json', import.meta.url)));
  fixtureStory.routeId = after.routeDraft.id;
  assert.equal(checkStory(after.compilation, fixtureStory).ok, true, JSON.stringify(checkStory(after.compilation, fixtureStory).refusals));

  const restricted = structuredClone(pack);
  restricted.household.liabilities[0].earlyRepaymentAllowed = false;
  const noClear = await inefficiencyFirst(walkSession({ planPack: restricted }), empty);
  assert.equal(noClear.draft.changes.length, 0);
  const restrictedPrice = await priceRoute({ planPack: restricted }, old);
  assert.equal(restrictedPrice.notes[0].reasonCode, 'recorded_terms_prevent_clearance');
  assert.ok((await priceRoute({ planPack: restricted }, corrected)).refusals.some(row => row.message.includes('terms')));

  // Multiple debts clear in rate order even when input bindings are reversed.
  const multiple = structuredClone(pack);
  multiple.household.liabilities.push({ ...structuredClone(car), liabilityId: 'expensive_card', type: 'credit_card', label: 'Invented card', annualInterestRate: 0.2, currentBalance: eur(1000) });
  multiple.planningInputs.outgoingBindings.push({ ...multiple.planningInputs.outgoingBindings[0], id: 'card', liabilityId: 'expensive_card' });
  const ordered = await inefficiencyFirst(walkSession({ planPack: multiple }), empty);
  assert.deepEqual(ordered.draft.changes.map(change => change.outgoingId), ['card', clear.outgoingId]);
  const reserveOnly = structuredClone(pack);
  const reserveSession = walkSession({ planPack: reserveOnly });
  const reserveOpening = await reserveSession.fast(empty);
  reserveOnly.household.assets.find(asset => asset.assetId === reserveOnly.planningInputs.cashAssetId).currentValue = eur(reserveOpening.ledger.reserve.protectedAmount + 1000);
  const protectedReserve = await inefficiencyFirst(walkSession({ planPack: reserveOnly }), empty);
  assert.ok(!protectedReserve.draft.changes.length);
  const cheap = structuredClone(pack);
  cheap.household.liabilities[0].annualInterestRate = 0.001;
  assert.equal((await inefficiencyFirst(walkSession({ planPack: cheap }), empty)).draft.changes.length, 0);
  const pensionCash = structuredClone(pack);
  pensionCash.household.assets.find(asset => asset.assetId === pensionCash.planningInputs.cashAssetId).currentValue = eur(reserveOpening.ledger.reserve.protectedAmount + 5000);
  const pensionDraft = { ...empty, changes: [{ type: 'pensionContribution', personId: 'primary', oneOffAmount: 4000, sources: {
    personId: { kind: 'fact', path: '/household/primaryPerson/personId' }, oneOffAmount: { kind: 'bounded',
      reason: 'Invented retirement contribution (/household/pensions).', factPaths: ['/household/pensions'] }
  } }] };
  const pensionWalk = await inefficiencyFirst(walkSession({ planPack: pensionCash }), pensionDraft);
  assert.equal(pensionWalk.draft.changes[0].outgoingId, clear.outgoingId);
  assert.equal(pensionWalk.draft.changes.find(change => change.type === 'pensionContribution').oneOffAmount, 2000);
  assert.ok((await priceRoute({ planPack: pensionCash }, pensionWalk.draft)).ledger?.reserveProtected);
  const releasedCash = structuredClone(pack);
  releasedCash.household.assets.find(asset => asset.assetId === releasedCash.planningInputs.cashAssetId).currentValue = eur(reserveOpening.ledger.reserve.protectedAmount);
  const releasedPrice = await priceRoute({ planPack: releasedCash }, old);
  assert.ok(releasedPrice.notes.some(note => note.reasonCode === 'not_cleared'), 'New sale cash must also flag retained dear debt');
  const releasedWalk = await inefficiencyFirst(walkSession({ planPack: releasedCash }), old);
  assert.equal(releasedWalk.draft.changes[0].outgoingId, clear.outgoingId);
  delete cheap.household.liabilities[0].annualInterestRate;
  assert.equal((await inefficiencyFirst(walkSession({ planPack: cheap }), empty)).draft.changes.length, 0);

  // A lump sum that just meets a near-term cost takes priority over a clearance
  // that would make that same goal short, with a machine-derived reason.
  const tight = structuredClone(pack);
  tight.household.goals = tight.household.goals.filter(goal => goal.goalId === 'fictional_dated_cost');
  tight.household.goals[0].targetAmount = eur(20000);
  tight.household.goals[0].targetDate = '2027-10-20';
  for (const income of tight.household.incomeSources) income.netAnnual = eur(40000);
  tight.planningInputs.leftOverEachYear = 0;
  tight.chapters = ['personal_balance_sheet', 'liquidity_analysis'];
  tight.planningInputs.goalBindings = tight.planningInputs.goalBindings.filter(binding => binding.goalId === 'fictional_dated_cost');
  tight.planningInputs.chapterGoals = {};
  tight.planningInputs.goalFundingFacts = tight.planningInputs.goalFundingFacts.filter(binding => binding.goalId === 'fictional_dated_cost');
  tight.goalFlexibility = {};
  const tightSession = walkSession({ planPack: tight });
  const opening = await tightSession.fast(empty);
  assert.ok(opening.ledger, JSON.stringify(opening.refusals));
  tight.household.assets.find(asset => asset.assetId === tight.planningInputs.cashAssetId).currentValue = eur(opening.ledger.reserve.protectedAmount + opening.ledger.goalFunding[0].wholeCash + 100);
  const funded = { ...empty, changes: [{ type: 'useCash', goalId: 'fictional_dated_cost', amount: 'whole', sources: {
    goalId: { kind: 'fact', path: '/household/goals/0/goalId' }, amount: { kind: 'bounded', reason: 'Meet the stated dated cost (/household/goals/0).', factPaths: ['/household/goals/0'] }
  } }] };
  const tightPrice = await priceRoute({ planPack: tight }, funded);
  assert.ok(tightPrice.meetsAllGoals, JSON.stringify(tightPrice.refusals));
  const protectedWalk = await inefficiencyFirst(walkSession({ planPack: tight }), funded);
  assert.ok(!protectedWalk.draft.changes.some(change => change.type === 'clearOutgoing'));
  assert.equal(tightPrice.ledger.debtDecisions[0].code, 'protects_on_time_goal');
  console.log('Debt efficiency passed: all walk families, dearest first, reserve/goal/terms exceptions, retained notes, required story reasons and sale repayment facts.');
} finally { console.info = info; }
