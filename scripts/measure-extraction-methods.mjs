/**
 * Whole-turn extraction versus clause-by-clause, on identical input.
 *
 * WHY MEASURE RATHER THAN ARGUE. Segmenting was adopted because dense turns
 * failed: five income figures timed the planner out and lost the answer
 * entirely. It clearly fixed that. But it also introduced a failure of its own
 * -- one clause can fail while the turn reports success -- and a live call was
 * observed losing the client's goal, age and retirement age that way. Which
 * method is actually better is a question about numbers, not about which story
 * is more persuasive, and the two run on the same planner so they can be put on
 * the same input and compared directly.
 *
 * Each utterance is run through BOTH paths the same number of times, because
 * the planner is not deterministic: a single run of each proves nothing. What
 * is reported per method is how many facts and positions were extracted, how
 * many candidates the engine refused, how often nothing at all came back, and
 * how long the client waited.
 *
 *   OPENAI_API_KEY=... node ./scripts/measure-extraction-methods.mjs [--runs=3]
 *
 * Without a key it prints the plan and exits, so the shape can be reviewed
 * without spending anything.
 */


import { getConsumerConfig } from '../worker/src/consumer/config.js';
import {
  extractRealtimePlannerTurn,
  extractSegmentedPlannerTurn
} from '../worker/src/consumer/realtime_planner.js';
import { segmentClientTurn } from '../worker/src/consumer/turn_segments.js';
import { buildPlanningContext } from '../worker/src/consumer/planning_context.js';
import { applyProfilePatch, createHouseholdProfile } from '../js/planning/profile.js';

const runs = Number((process.argv.find((arg) => arg.startsWith('--runs=')) || '--runs=3').split('=')[1]);

/**
 * Real utterances from real calls, each with what the caller actually holds.
 *
 * `amounts` is every figure the sentence states, so an extraction is judged on
 * the caller's own words rather than on what the engine found convenient.
 * `owners` names the person an amount belongs to where getting it wrong would
 * put one household member's money on another's balance sheet.
 */
const UTTERANCES = Object.freeze([
  { label: 'opening (goal + 2 ages)', text: "Hi, I'm Dermot. I'm 53 and hoping to retire at 56. My wife Aoife is 48.",
    amounts: [], facts: { person_current_age: 53, intended_retirement_age: 56 }, goals: ['retire_early', 'retire'] },
  { label: 'single figure', text: 'I earn 114,000 a year plus a 10,000 bonus.',
    amounts: [114_000, 10_000], facts: {}, goals: [] },
  { label: '2 pensions + 2 rates', text: 'I have a buyout bond with Aviva worth about 380,000 and my current scheme has about 360,000. The company puts in 10% and I put in 30%.',
    amounts: [380_000, 360_000], facts: { pension_employee_contribution_rate: 30, pension_employer_contribution_rate: 10 }, goals: [] },
  { label: '5 income figures', text: 'I earn 114,000 plus a 10,000 bonus. Aoife earns 150,000 plus a 30,000 bonus. Together we take home about 8,500 a month after our pension contributions come out. We also get 2,250 a month rent from an investment property.',
    amounts: [114_000, 10_000, 150_000, 30_000, 8_500, 2_250], owners: { 150_000: 'partner', 30_000: 'partner' }, facts: {}, goals: [] },
  { label: '3 funds', text: "Jointly we have 80,000 in Zurich Prisma 4 and 12,000 in Prisma 5. There's also 3,000 in a Prisma 5 for the kids.",
    amounts: [80_000, 12_000, 3_000], facts: {}, goals: [] },
  { label: '5 cash holdings', text: 'I have 20,000 in cash, a 50,000 State Savings bond and 12,000 in prize bonds. Aoife has 200,000 in cash and 20,000 in regular savings.',
    amounts: [20_000, 50_000, 12_000, 200_000, 20_000], owners: { 200_000: 'partner' }, facts: {}, goals: [] },
  { label: 'partner pension + max', text: 'Aoife has about 500,000 in an Aon lifestyle fund. Her company pays 10% and she pays the max.',
    amounts: [500_000], owners: { 500_000: 'partner' }, facts: { pension_employer_contribution_rate: 10 }, goals: [] }
]);

const env = {
  OPENAI_API_KEY: String(process.env.OPENAI_API_KEY || '').trim(),
  CONSUMER_JOURNEY_ENABLED: 'true',
  CONSUMER_REALTIME_CONVERSATION_V2_ENABLED: 'true'
};

if (!env.OPENAI_API_KEY) {
  console.info('No OPENAI_API_KEY. Plan only:\n');
  for (const item of UTTERANCES) {
    console.info(`  ${item.label.padEnd(26)} ${segmentClientTurn(item.text).length} clause(s)`);
  }
  console.info(`\n  ${UTTERANCES.length} utterances x ${runs} runs x 3 methods.`);
  process.exit(0);
}

const config = { ...getConsumerConfig(env), realtimeConversationV2Enabled: true };
const NOW = new Date().toISOString();
const empty = createHouseholdProfile({
  profileId: 'measure', nowIso: NOW, calculationDateIso: '2026-08-03'
});

/**
 * A profile part-way through a real call.
 *
 * THE VARIABLE THE FIRST RUN DID NOT CONTROL. The failures that motivated all
 * of this -- a timeout that lost five income figures, three fund amounts
 * refused together -- happened live, several turns in, with a full brief. The
 * first measurement ran against an empty profile and reproduced none of them,
 * which means utterance density may not be the thing that breaks extraction at
 * all: the context the planner is sent grows every turn, and that is the other
 * candidate. Measuring against a realistic profile is how the two are told
 * apart.
 */
const prov = { source: 'user_confirmation', confidence: 'high', certainty: 'exact', capturedAt: NOW, confirmedByUser: true };
const midCall = applyProfilePatch(empty, {
  patchId: 'mid-call',
  operations: [
    { op: 'add', path: '/primaryPerson/age', value: 53, provenance: prov },
    { op: 'add', path: '/partner', value: { personId: 'partner', age: 48 }, provenance: prov },
    { op: 'add', path: '/pensions/-', value: { pensionId: 'bond', ownerId: 'primary', label: 'Aviva buyout bond', type: 'buyout_bond', currentValue: { amount: 380_000, currency: 'EUR' } }, provenance: prov },
    { op: 'add', path: '/pensions/-', value: { pensionId: 'scheme', ownerId: 'primary', label: 'Current company scheme', type: 'occupational', currentValue: { amount: 360_000, currency: 'EUR' } }, provenance: prov },
    { op: 'add', path: '/properties/-', value: { propertyId: 'home', label: 'Family home', use: 'home', currentValue: { amount: 950_000, currency: 'EUR' } }, provenance: prov },
    { op: 'add', path: '/assets/-', value: { assetId: 'cash', label: 'Cash savings', type: 'cash', currentValue: { amount: 20_000, currency: 'EUR' }, liquid: true }, provenance: prov },
    { op: 'add', path: '/expenses/annualTotal', value: { amount: 42_000, currency: 'EUR' }, provenance: prov }
  ]
}, { nowIso: NOW }).profile;

const contextName = (process.argv.find((arg) => arg.startsWith('--context=')) || '--context=realistic').split('=')[1];
const profile = contextName === 'empty' ? empty : midCall;
const context = {
  profile,
  config,
  state: buildPlanningContext({ config, profile, sessionRow: { id: 'measure' } })
};

/**
 * How close one extraction came to what the caller actually said.
 *
 * Amounts are matched as a multiset: stating 20,000 twice means two rows, and
 * extracting it twice when it was said once is a duplicate holding, not a
 * bonus. Everything extracted that the caller did not state -- an invented
 * figure, a duplicate, money put on the wrong person -- lands in `wrong`.
 */
function scoreAgainstTruth(extraction, truth) {
  const outstanding = [...(truth.amounts || [])];
  let correct = 0;
  let wrong = 0;
  const wrongDetail = [];

  for (const position of extraction?.positions || []) {
    const amount = Number(position?.amount?.amount);
    if (!Number.isFinite(amount)) continue;
    const index = outstanding.indexOf(amount);
    if (index === -1) {
      wrong += 1;
      wrongDetail.push(`${amount} not stated, or stated once and extracted twice`);
      continue;
    }
    outstanding.splice(index, 1);
    // Money on the wrong person is wrong even though the figure is right: it
    // moves a holding from one household member's balance sheet to another's.
    const expectedOwner = (truth.owners || {})[amount];
    if (expectedOwner && position.owner && position.owner !== expectedOwner) {
      wrong += 1;
      wrongDetail.push(`${amount} attributed to ${position.owner}, not ${expectedOwner}`);
    } else {
      correct += 1;
    }
  }

  for (const [factId, expected] of Object.entries(truth.facts || {})) {
    const found = (extraction?.semanticFacts || []).find((fact) => fact.factId === factId);
    if (!found) { outstanding.push(factId); continue; }
    const value = found.value && typeof found.value === 'object'
      ? (found.value.rate ?? found.value.value ?? found.value.amount)
      : found.value;
    if (Number(value) === Number(expected)) correct += 1;
    else {
      wrong += 1;
      wrongDetail.push(`${factId} read as ${JSON.stringify(found.value)}, not ${expected}`);
    }
  }

  if ((truth.goals || []).length) {
    const goals = (extraction?.goalCandidates || []).map((goal) => goal.goalType);
    if (goals.some((goal) => truth.goals.includes(goal))) correct += 1;
    else outstanding.push('goal');
  }

  return { correct, missed: outstanding.length, wrong, wrongDetail };
}

const expectedTotal = (truth) => (truth.amounts || []).length
  + Object.keys(truth.facts || {}).length
  + ((truth.goals || []).length ? 1 : 0);

const blank = () => ({ correct: 0, missed: 0, wrong: 0, expected: 0, failed: 0, ms: 0 });
const wrongEverywhere = [];
const METHODS = [
  ['whole', (options) => extractRealtimePlannerTurn(options)],
  // Clause reading with the recovery read suppressed, so the recovery path can
  // be told apart from the clause reads themselves.
  ['clauses', (options) => extractSegmentedPlannerTurn({ ...options, includeWholeTurnRead: false })],
  ['recovery', (options) => extractSegmentedPlannerTurn(options)]
];
const totals = Object.fromEntries(METHODS.map(([name]) => [name, blank()]));

for (const item of UTTERANCES) {
  const clauseCount = segmentClientTurn(item.text).length;
  const expected = expectedTotal(item);
  console.info(`\n${item.label}  (${clauseCount} clause${clauseCount === 1 ? '' : 's'}, ${expected} things stated)`);
  for (const [method, extract] of METHODS) {
    const seen = blank();
    for (let run = 0; run < runs; run += 1) {
      const startedAt = Date.now();
      try {
        const planned = await extract({
          env, config, context, sourceTurnId: `measure-${method}-${run}`, transcript: item.text, recentTurns: []
        });
        const result = scoreAgainstTruth(planned.extraction, item);
        seen.correct += result.correct;
        seen.missed += result.missed;
        seen.wrong += result.wrong;
        for (const detail of result.wrongDetail) wrongEverywhere.push(`${method.padEnd(9)} ${item.label} -- ${detail}`);
      } catch (_error) {
        seen.failed += 1;
        seen.missed += expected;
      }
      seen.expected += expected;
      seen.ms += Date.now() - startedAt;
    }
    for (const key of Object.keys(seen)) totals[method][key] += seen[key];
    const accuracy = seen.expected ? Math.round((seen.correct / seen.expected) * 100) : 100;
    console.info(`  ${method.padEnd(9)} ${String(accuracy).padStart(3)}% right  missed ${String(seen.missed).padStart(2)}  `
      + `WRONG ${String(seen.wrong).padStart(2)}  failed ${seen.failed}/${runs}  ${Math.round(seen.ms / runs)}ms`);
  }
}

console.info(`\n=== totals: ${UTTERANCES.length} utterances x ${runs} runs, ${contextName} context ===`);
for (const [method, sum] of Object.entries(totals)) {
  const accuracy = sum.expected ? ((sum.correct / sum.expected) * 100).toFixed(1) : '100.0';
  console.info(`  ${method.padEnd(9)} ${String(accuracy).padStart(5)}% of what the caller said  `
    + `missed ${String(sum.missed).padStart(3)}  WRONG ${String(sum.wrong).padStart(3)}  `
    + `failed ${sum.failed}/${UTTERANCES.length * runs}  mean ${Math.round(sum.ms / (UTTERANCES.length * runs))}ms`);
}
if (wrongEverywhere.length) {
  console.info('\n--- what each method got WRONG (invented, duplicated, or misattributed) ---');
  for (const entry of [...new Set(wrongEverywhere)].slice(0, 30)) console.info(`  ${entry}`);
}
