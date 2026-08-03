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
 * Real utterances from real calls, spanning the range that matters: the ones
 * that used to fail, and the ones that always worked. A method that fixes dense
 * turns by breaking simple ones is not an improvement.
 */
const UTTERANCES = Object.freeze([
  { label: 'opening (goal + 2 ages)', text: "Hi, I'm Dermot. I'm 53 and hoping to retire at 56. My wife Aoife is 48." },
  { label: 'single figure', text: 'I earn 114,000 a year plus a 10,000 bonus.' },
  { label: '2 pensions + 2 rates', text: 'I have a buyout bond with Aviva worth about 380,000 and my current scheme has about 360,000. The company puts in 10% and I put in 30%.' },
  { label: '5 income figures', text: 'I earn 114,000 plus a 10,000 bonus. Aoife earns 150,000 plus a 30,000 bonus. Together we take home about 8,500 a month after our pension contributions come out. We also get 2,250 a month rent from an investment property.' },
  { label: '3 funds', text: "Jointly we have 80,000 in Zurich Prisma 4 and 12,000 in Prisma 5. There's also 3,000 in a Prisma 5 for the kids." },
  { label: '5 cash holdings', text: 'I have 20,000 in cash, a 50,000 State Savings bond and 12,000 in prize bonds. Aoife has 200,000 in cash and 20,000 in regular savings.' },
  { label: 'partner pension + max', text: 'Aoife has about 500,000 in an Aon lifestyle fund. Her company pays 10% and she pays the max.' }
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

/** What one extraction actually yielded. */
function score(extraction) {
  return {
    facts: (extraction?.semanticFacts || []).length,
    positions: (extraction?.positions || []).length,
    goals: (extraction?.goalCandidates || []).length,
    refused: (extraction?.invalidCandidates || []).length
  };
}

const blank = () => ({ facts: 0, positions: 0, goals: 0, refused: 0, empty: 0, failed: 0, ms: 0 });
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
  const line = [];
  for (const [method, extract] of METHODS) {
    const seen = blank();
    for (let run = 0; run < runs; run += 1) {
      const startedAt = Date.now();
      try {
        const planned = await extract({
          env, config, context, sourceTurnId: `measure-${method}-${run}`, transcript: item.text, recentTurns: []
        });
        const result = score(planned.extraction);
        seen.facts += result.facts;
        seen.positions += result.positions;
        seen.goals += result.goals;
        seen.refused += result.refused;
        // NOTHING AT ALL is the failure that matters most: the client answered
        // and the engine came away with nothing to show for it.
        if (result.facts + result.positions + result.goals === 0) seen.empty += 1;
      } catch (_error) {
        seen.failed += 1;
      }
      seen.ms += Date.now() - startedAt;
    }
    for (const key of Object.keys(seen)) totals[method][key] += seen[key];
    line.push(`${method}: ${(seen.facts / runs).toFixed(1)}f ${(seen.positions / runs).toFixed(1)}p `
      + `${(seen.goals / runs).toFixed(1)}g refused ${(seen.refused / runs).toFixed(1)} `
      + `empty ${seen.empty}/${runs} failed ${seen.failed}/${runs} ${Math.round(seen.ms / runs)}ms`);
  }
  console.info(`\n${item.label}  (${clauseCount} clause${clauseCount === 1 ? '' : 's'})`);
  for (const entry of line) console.info(`  ${entry}`);
}

console.info(`\n=== totals: ${UTTERANCES.length} utterances x ${runs} runs, ${contextName} context ===`);
for (const [method, sum] of Object.entries(totals)) {
  const attempts = UTTERANCES.length * runs;
  console.info(`  ${method.padEnd(8)} facts ${String(sum.facts).padStart(4)}  positions ${String(sum.positions).padStart(3)}  `
    + `goals ${String(sum.goals).padStart(3)}  refused ${String(sum.refused).padStart(3)}  `
    + `empty ${sum.empty}/${attempts}  failed ${sum.failed}/${attempts}  mean ${Math.round(sum.ms / attempts)}ms`);
}
