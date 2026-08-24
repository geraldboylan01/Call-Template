/**
 * Reading a client turn in clause-sized pieces.
 *
 * Measured on real calls before this existed: one figure per turn was captured
 * every time; two pension values plus both contribution rates lost the rates;
 * three fund amounts lost all three; five income figures timed the planner out
 * and lost the whole turn. A household with €300,000 in cash was given a
 * balance sheet stating its liquid reserves were zero, because the sentence
 * naming them was too dense to read.
 *
 * The checks below are mostly about what segmenting must NOT do. Cutting a
 * sentence is only safe while every piece still means what it meant inside the
 * whole, and the dangerous cut is the one that separates a number from the
 * thing it describes -- an amount without its holding is placed on the wrong
 * position, which is worse than not reading it at all.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  mergeSegmentExtractions,
  readableSegments,
  reconcileAgainstFinalTranscript,
  segmentClientTurn,
  shouldSegmentTurn,
  unionWithWholeTurnRead
} from '../worker/src/consumer/turn_segments.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let checks = 0;
const check = (label, condition, detail = '') => {
  checks += 1;
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
};

/* ------------------------------------------ a short turn is unchanged */

// ONE PATH, NOT TWO. A short answer must cost exactly what it cost before, or
// this is a second implementation wearing the first one's name.
for (const short of [
  'I earn 114,000 a year plus a 10,000 bonus.',
  'Yes.',
  'About 30 percent.',
  "We'd want about 90,000 a year in today's money."
]) {
  check(`a short answer is read whole: ${JSON.stringify(short.slice(0, 30))}`,
    segmentClientTurn(short).length === 1);
  check('a short answer is not worth segmenting', !shouldSegmentTurn(short));
}
check('an empty turn produces no segments', segmentClientTurn('').length === 0);
check('a null turn produces no segments', segmentClientTurn(null).length === 0);

/* ------------------------------------- the turns that actually failed */

// The five-figure income answer that timed out and lost everything.
const income = 'I earn 114,000 plus a 10,000 bonus. Aoife earns 150,000 plus a 30,000 bonus. '
  + 'Together we take home about 8,500 a month after our pension contributions come out. '
  + 'We also get 2,250 a month rent from an investment property.';
const incomeSegments = segmentClientTurn(income);
check('the income answer is read in pieces', incomeSegments.length > 1, String(incomeSegments.length));
check('every piece of the income answer is small enough to read',
  incomeSegments.every((segment) => segment.length <= 200), JSON.stringify(incomeSegments));
// The partner income was the figure silently lost on the live call.
check("the partner's income survives segmentation",
  incomeSegments.some((segment) => segment.includes('150,000')), JSON.stringify(incomeSegments));

// The three-fund answer where all three amounts were refused together.
const funds = 'Jointly we have 80,000 in Zurich Prisma 4 and 12,000 in Prisma 5. '
  + "There's also 3,000 in a Prisma 5 for the kids.";
const fundSegments = segmentClientTurn(funds);
check('the three-fund answer is read in pieces', fundSegments.length > 1);

const spokenLowValues = 'Rent is nine hundred and fifty each month and loan payments are four hundred and fifty '
  + 'and childcare is eight hundred.';
const spokenLowSegments = segmentClientTurn(spokenLowValues);
check('three contextual low values written in words trigger generic density segmentation',
  spokenLowSegments.length > 1, JSON.stringify(spokenLowSegments));
check('each low spoken value remains attached to its financial subject',
  spokenLowSegments.every((segment) => /(?:rent|loan|childcare)/i.test(segment))
    && spokenLowSegments.join(' ').includes('nine hundred fifty')
    && spokenLowSegments.join(' ').includes('four hundred fifty')
    && spokenLowSegments.join(' ').includes('eight hundred'),
  JSON.stringify(spokenLowSegments));

// Two values remain below the generic density threshold regardless of which
// categories they happen to name. Omission recovery is occurrence coverage,
// tested separately; segmenting must not accumulate category-pair exceptions.
const twoHoldings = 'The deposit is €31,000 and a separate fund is €12,000.';
check('two-value segmentation has no category-pair exception',
  segmentClientTurn(twoHoldings).length === 1,
  JSON.stringify(segmentClientTurn(twoHoldings)));

const linkedHomeAndMortgage = 'I also have a house worth €500,000, with a mortgage balance of €350,000.';
check('a coupled home and mortgage remain one read for entity linking',
  segmentClientTurn(linkedHomeAndMortgage).length === 1,
  JSON.stringify(segmentClientTurn(linkedHomeAndMortgage)));

/* --------------------------------- a number is never cut from its label */

// THE DANGEROUS CUT. "80,000 in Zurich Prisma 4" split into "80,000" and "in
// Zurich Prisma 4" places a real amount on the wrong holding. Every figure must
// stay in a piece that still names what it belongs to.
for (const [amount, label] of [
  ['80,000', 'Prisma 4'],
  ['12,000', 'Prisma 5'],
  ['150,000', 'Aoife'],
  ['2,250', 'rent']
]) {
  const source = [...incomeSegments, ...fundSegments];
  const carrying = source.find((segment) => segment.includes(amount));
  check(`${amount} is not separated from ${label}`,
    !carrying || carrying.toLowerCase().includes(label.toLowerCase()),
    carrying);
}
// A thousands comma must never be read as a clause boundary.
check('a comma inside a number is never a cut point',
  segmentClientTurn('The house is worth 1,250,000 and the mortgage is 430,000 over 22 years.')
    .every((segment) => !/^\d{3}\b/.test(segment.trim())));

/* --------------------------------------------- segmenting stays bounded */

const rambling = Array.from({ length: 30 }, (_, index) => (
  `Item number ${index + 1} is worth about ${index + 1}0,000 euro in total.`
)).join(' ');
const many = segmentClientTurn(rambling);
check('a very long answer still costs a bounded number of reads',
  many.length <= 6, String(many.length));
check('a bounded read still covers the whole answer',
  many.join(' ').includes('Item number 30'), 'no clause may be dropped to fit the ceiling');

// Nothing may be silently discarded: every word said must survive somewhere.
// Spoken-number joiners such as "nine hundred and fifty" are deliberately
// normalised by the clause splitter to "nine hundred fifty"; the focused
// assertion above verifies that the same numeric evidence and subject survive.
for (const source of [income, funds, twoHoldings, linkedHomeAndMortgage, rambling]) {
  const rejoined = segmentClientTurn(source).join(' ').replace(/\s+/g, ' ');
  const original = source.replace(/\s+/g, ' ');
  check('segmenting loses no words', rejoined.length >= original.length - 8,
    `${original.length} -> ${rejoined.length}`);
}

/* ------------------------------------------------------- merging back */

const segmentA = {
  schemaVersion: 'planner_extraction_v3',
  goalCandidates: [{ candidateId: 'goal-1', goalType: 'retire_early', priorityHint: 'primary' }],
  semanticFacts: [{ candidateId: 'fact-1', factId: 'person_current_age', value: 53 }],
  positions: [{ candidateId: 'position-1', kind: 'asset', label: 'Prisma 4', amount: { amount: 80_000, currency: 'EUR' } }],
  invalidCandidates: [{ candidateId: 'position-2', errorCode: 'realtime_planner_candidate_money_invalid' }],
  sectionCompletions: []
};
const segmentB = {
  schemaVersion: 'planner_extraction_v3',
  goalCandidates: [{ candidateId: 'goal-1', goalType: 'retire_early', priorityHint: 'secondary' }],
  semanticFacts: [{ candidateId: 'fact-1', factId: 'monthly_spending', value: 3_500 }],
  positions: [{ candidateId: 'position-1', kind: 'asset', label: 'Prisma 5', amount: { amount: 12_000, currency: 'EUR' } }],
  invalidCandidates: [{ candidateId: 'position-2', errorCode: 'realtime_planner_candidate_money_invalid' }],
  sectionCompletions: []
};
const merged = mergeSegmentExtractions([segmentA, segmentB], 'turn-1');

check('the merged turn keeps its own id', merged.sourceTurnId === 'turn-1');
// THREE FUNDS ARE THREE ROWS. Positions that differ must never collapse into
// one, or a balance sheet silently loses holdings.
check('different holdings both survive', merged.positions.length === 2,
  JSON.stringify(merged.positions.map((position) => position.label)));
check('facts from both pieces survive', merged.semanticFacts.length === 2);
check('a goal named twice is one goal', merged.goalCandidates.length === 1);
check('the first sighting of a goal sets its priority',
  merged.goalCandidates[0].priorityHint === 'primary',
  'the client states their own ordering; a later mention must not demote it');

// Candidate ids collide across pieces -- every piece numbers from one -- so
// without renumbering one of two positions would be lost on application.
check('candidate ids are unique across pieces',
  new Set(merged.positions.map((position) => position.candidateId)).size === merged.positions.length);
check('invalid candidate ids are unique across pieces',
  new Set(merged.invalidCandidates.map((item) => item.candidateId)).size === 2,
  JSON.stringify(merged.invalidCandidates.map((item) => item.candidateId)));

// A later piece revising the same slot is the client correcting themselves.
const corrected = mergeSegmentExtractions([
  { ...segmentA, semanticFacts: [{ candidateId: 'fact-1', factId: 'monthly_spending', value: 3_000 }] },
  { ...segmentB, semanticFacts: [{ candidateId: 'fact-1', factId: 'monthly_spending', value: 3_500 }] }
], 'turn-2');
check('a later piece revises the same fact',
  corrected.semanticFacts.length === 1 && corrected.semanticFacts[0].value === 3_500,
  '"about 3,000, sorry 3,500" must land on the last figure said');

check('nothing to merge yields nothing', mergeSegmentExtractions([], 'turn-3') === null);
check('failed pieces are skipped when merging',
  mergeSegmentExtractions([null, segmentA, undefined], 'turn-4').positions.length === 1);

/* ------------------------------------------- one path, on both transports */

const planner = readFileSync(`${root}worker/src/consumer/realtime_planner.js`, 'utf8');
check('a single-piece turn takes the ordinary path unchanged',
  /if \(segments\.length <= 1\) return extractRealtimePlannerTurn\(options\);/.test(planner),
  'a short turn must cost exactly what it cost before');
check('pieces are read concurrently', /Promise\.allSettled/.test(planner),
  'six clauses must not take six times as long as one');
// THE POINT OF THE WHOLE CHANGE: a dense sentence must degrade, not vanish.
check('a failed piece loses only that piece',
  /const succeeded = settled\.filter\(\(result\) => result\.status === 'fulfilled'\)/.test(planner));
check('a turn fails outright only when every piece fails',
  /if \(succeeded\.length === 0\)/.test(planner));
check('spend does not depend on how many pieces a sentence made',
  /inputTokens: sum\('inputTokens'\)/.test(planner));
check('the planner accounts for every explicit value without a fixture category pair',
  /account for every explicit value-bearing occurrence/.test(planner)
    && !/pension worth €100,000 and stocks and shares worth €10,000/.test(planner));
check('the planner uses catalogue-derived goals and general order cues',
  /Catalogue-derived goal meanings/.test(planner)
    && /Ordinary desire and mention order do not establish priority/.test(planner));
check('the segmenter contains no product-pair rollout rule',
  !/INDEPENDENT_PENSION_INVESTMENT_PAIR/.test(readFileSync(`${root}worker/src/consumer/turn_segments.js`, 'utf8')));

for (const [transport, file] of [
  ['text', 'worker/src/consumer/agent_session.js'],
  ['voice', 'worker/src/consumer/realtime_session.js']
]) {
  const source = readFileSync(`${root}${file}`, 'utf8');
  check(`${transport} reads turns in pieces`, /extractSegmentedPlannerTurn/.test(source),
    'a fix that lands on one transport and not the other is the divergence this repo keeps paying for');
  // The repair pass targets named items, not a whole utterance, so it stays a
  // single call. Segmenting it would re-read clauses that already succeeded.
  check(`${transport} does not segment the repair pass`,
    /repaired = await extractRealtimePlannerTurn\(/.test(source));
}



/* ============================ reading while the client still speaks ======== */

/**
 * The trailing fragment is never read. A streaming recogniser appends as it
 * goes and revises before it settles, so the clause the client is still saying
 * may not be the clause they end up having said.
 */
const speaking = 'I earn 114,000 plus a 10,000 bonus. Aoife earns 150,000 plus a 30,000 bonus. Together we';
const readable = readableSegments(speaking);
check('the clause still being spoken is never read early',
  !readable.some((segment) => segment.includes('Together we')), JSON.stringify(readable));
check('a settled clause is read early', readable.length >= 1, JSON.stringify(readable));
check('nothing is read early from a single unfinished clause',
  readableSegments('I earn about').length === 0,
  'there is no settled clause yet, so there is nothing safe to start on');
check('an empty in-progress turn reads nothing early', readableSegments('').length === 0);

/* ------------------------------- a partial read must prove itself */

// THE REVISION CASE, which is why partial reads are never trusted. The
// recogniser hears "sixteen thousand" and settles on "sixty thousand"; a value
// read from the first must not survive into the profile.
const readFromPartial = {
  schemaVersion: 'planner_extraction_v3',
  goalCandidates: [{ candidateId: 'goal-1', goalType: 'retire', evidenceText: 'I want to retire' }],
  semanticFacts: [
    { candidateId: 'fact-1', factId: 'cash_savings', value: 16_000, evidenceText: 'about sixteen thousand in savings' },
    { candidateId: 'fact-2', factId: 'monthly_spending', value: 3_500, evidenceText: 'we spend 3,500 a month' }
  ],
  positions: [
    { candidateId: 'position-1', kind: 'asset', label: 'Savings', evidenceText: 'sixteen thousand' }
  ],
  invalidCandidates: [],
  sectionCompletions: []
};
const settledText = 'I have about sixty thousand in savings and we spend 3,500 a month.';
const reconciled = reconcileAgainstFinalTranscript(readFromPartial, settledText);

check('a figure the client did not finally say is dropped',
  !reconciled.semanticFacts.some((fact) => fact.factId === 'cash_savings'),
  JSON.stringify(reconciled.semanticFacts.map((fact) => fact.factId)));
check('a figure the client did say survives',
  reconciled.semanticFacts.some((fact) => fact.factId === 'monthly_spending'));
check('a position built on a revised figure is dropped', reconciled.positions.length === 0);
check('what was dropped is reported, not silently discarded',
  reconciled.droppedByReconciliation.length === 2,
  JSON.stringify(reconciled.droppedByReconciliation));
// Goals carry no figures, so a revision cannot make them wrong.
check('a goal survives reconciliation', reconciled.goalCandidates.length === 1);

// A candidate that cannot be checked is not kept: the whole point is that a
// partial read proves itself against what was actually said.
const unprovable = reconcileAgainstFinalTranscript({
  ...readFromPartial,
  semanticFacts: [{ candidateId: 'fact-1', factId: 'cash_savings', value: 16_000, evidenceText: '' }],
  positions: []
}, settledText);
check('a candidate with no evidence cannot prove itself and is dropped',
  unprovable.semanticFacts.length === 0);

check('nothing to reconcile yields nothing',
  reconcileAgainstFinalTranscript(null, settledText) === null);

/* --------------------------------------------- how the head start is used */

const session = readFileSync(`${root}worker/src/consumer/realtime_session.js`, 'utf8');
check('partial transcripts start work while the client speaks',
  /await this\.prefetchSettledClauses\(event\)/.test(session));
check('the head start is bounded', /this\.segmentPrefetch\.size >= 5/.test(session),
  'a client who talks for two minutes must not spend without limit');
check('a failed early read is swallowed', /pending\.catch\(\(\) => \{\}\)/.test(session),
  'the turn simply reads that clause again');
// Scratch that outlives its turn would be matched against words from a
// different answer.
check('the head start is cleared once consumed',
  (session.match(/this\.clearTurnPrefetch\(itemId\)/g) || []).length === 2);
check('both finalized reads use the head start',
  (session.match(/prefetched: this\.segmentPrefetch/g) || []).length === 2);

const plannerSource = readFileSync(`${root}worker/src/consumer/realtime_planner.js`, 'utf8');
// THE KEY IS THE SAFETY. Work is stored under the exact words it was read
// from, so a revision misses the lookup instead of having to be detected.
check('early work is looked up by the exact words it was read from',
  /prefetched\?\.get\(segment\)/.test(plannerSource));
check('a prefetched turn is reconciled before anything is recorded',
  /reconcileAgainstFinalTranscript\(merged, options\.transcript\)/.test(plannerSource));
check('a turn with no head start is not reconciled against itself',
  /prefetched\s*\n?\s*\?\s*reconcileAgainstFinalTranscript/.test(plannerSource),
  'segments of a finalized turn are already substrings of it');

// The groundedness rule has one implementation, shared by the spoken
// reflection and by partial-read reconciliation.
const reflection = readFileSync(`${root}scripts/check-consumer-reflection.mjs`, 'utf8');
check('the groundedness rule is imported, never copied',
  /from '\.\.\/worker\/src\/consumer\/spoken_figures\.js'/.test(reflection)
    && !/function ungroundedFigures/.test(reflection),
  'a second copy is how the checks and the code drift apart');



/* ------------------------------- a lost clause is never reported as success */

// THE WEAKNESS SEGMENTING INTRODUCED. Promise.allSettled means one clause can
// fail while the turn still succeeds -- which is the point, since the rest of
// the answer survives. But observed live: the opening clause carrying the
// client's goal, age and retirement age failed, the turn reported clean
// success, and five turns later the call still had no goal. Losing a clause is
// acceptable; losing it silently is not.
const agentSource = readFileSync(`${root}worker/src/consumer/agent_session.js`, 'utf8');
check('a failed clause is counted against the turn',
  /rejectedCount: outcomes\.filter\(\(item\) => item\.accepted === false\)\.length \+ segmentsFailed/
    .test(agentSource),
  'the renderer must not confirm a turn whose clause was dropped');
check('the failed-clause count is read from the extraction',
  /segmentsFailed = Number\(planned\.metadata\?\.segmentsFailed \|\| 0\)/.test(agentSource));
check('the failed-clause count reaches diagnostics',
  /^\s+segmentsFailed,$/m.test(agentSource),
  'a silent loss cannot be graded after the call');
check('the planner reports how many clauses were lost',
  /segmentsFailed: clausesFailed/.test(plannerSource));
// The extra whole-turn read is a safety net, not a clause. If it alone fails
// the clauses still covered every word, and the turn must not look degraded.
// A whole-turn read on EVERY turn was measured and rejected: deduplicated
// against the clauses it found no more than they did, and cost about a second
// and an extra call on every dense turn. It earns its place only where the
// clause approach actually has a hole.
check('a whole-turn read runs only when a clause was lost',
  /if \(clausesFailed > 0 && options\.includeWholeTurnRead !== false\)/.test(plannerSource),
  'paying for it on every turn was measured and did not pay for itself');
check('the ordinary path reads clauses only',
  /const settled = await Promise\.allSettled\(clauseReads\);/.test(plannerSource));
check('a failed recovery read leaves the clauses standing',
  /\.catch\(\(\) => null\)/.test(plannerSource));



/* ---------------- the whole-turn read fills gaps, never invents a holding */

// THE FAULT THIS PREVENTS, measured. Reading the three-fund answer both ways
// produced FIVE positions for three funds: the clause read called one holding
// "Prisma 5" and the whole-turn read called the same holding "Zurich Prisma 5",
// so a label-keyed merge kept both. That is EUR 15,000 of money the client does
// not have, presented as fact on their balance sheet.
const clauseSide = {
  schemaVersion: 'planner_extraction_v3',
  goalCandidates: [{ candidateId: 'goal-1', goalType: 'retire' }],
  semanticFacts: [{ candidateId: 'fact-1', factId: 'monthly_spending', value: 3_500 }],
  positions: [
    { candidateId: 'position-1', kind: 'asset', label: 'Prisma 5', amount: { amount: 12_000, currency: 'EUR' } }
  ],
  invalidCandidates: [], sectionCompletions: []
};
const wholeSide = {
  schemaVersion: 'planner_extraction_v3',
  goalCandidates: [{ candidateId: 'goal-1', goalType: 'retire' }, { candidateId: 'goal-2', goalType: 'improve_pension' }],
  semanticFacts: [
    { candidateId: 'fact-1', factId: 'monthly_spending', value: 9_999 },
    { candidateId: 'fact-2', factId: 'person_current_age', value: 53 }
  ],
  positions: [
    // The same holding under a fuller name -- must NOT become a second row.
    { candidateId: 'position-1', kind: 'pension', label: 'Zurich Prisma 5', amount: { amount: 12_000, currency: 'EUR' } },
    // A holding the clause reads genuinely missed -- must be kept.
    { candidateId: 'position-2', kind: 'asset', label: 'Prize bonds', amount: { amount: 3_000, currency: 'EUR' } }
  ],
  invalidCandidates: [], sectionCompletions: []
};
const unioned = unionWithWholeTurnRead(clauseSide, wholeSide);

check('the same holding under two names stays one holding',
  unioned.positions.filter((position) => position.amount.amount === 12_000).length === 1,
  JSON.stringify(unioned.positions.map((position) => position.label)));
check('a holding the clauses missed is recovered',
  unioned.positions.some((position) => position.amount.amount === 3_000));
check('the union invents nothing', unioned.positions.length === 2);
// A clause is the more focused reading of the same words, so it wins conflicts.
check('a clause reading wins over the whole-turn reading',
  unioned.semanticFacts.find((fact) => fact.factId === 'monthly_spending').value === 3_500,
  'the whole-turn read must not overwrite what a clause read established');
check('a fact only the whole-turn read found is added',
  unioned.semanticFacts.some((fact) => fact.factId === 'person_current_age'));
check('a goal named by both is one goal',
  unioned.goalCandidates.filter((goal) => goal.goalType === 'retire').length === 1);
check('a goal only the whole-turn read found is added',
  unioned.goalCandidates.some((goal) => goal.goalType === 'improve_pension'));
check('candidate ids stay unique after the union',
  new Set(unioned.positions.map((position) => position.candidateId)).size === unioned.positions.length);

// A position with no amount carries nothing to reconcile against, so it is left
// to the clause reads rather than risked as a duplicate.
check('an amountless whole-turn position is not added',
  unionWithWholeTurnRead(clauseSide, {
    ...wholeSide, positions: [{ candidateId: 'position-1', kind: 'asset', label: 'Something' }]
  }).positions.length === 1);

check('a missing whole-turn read leaves the clauses untouched',
  unionWithWholeTurnRead(clauseSide, null) === clauseSide);

/* ------------------------- a clause never loses whose money it is */

// MONEY BELONGS TO WHOEVER MENTIONED IT UNLESS THEY SAY OTHERWISE, so a
// continuation clause that lost its subject silently moves a partner's holding
// onto the client's balance sheet. Measured before this: the partner's 200,000
// landed on the primary.
const partnerCash = segmentClientTurn(
  'Aoife has 200,000 in cash and 20,000 in regular savings and 15,000 in a credit union account.'
);
check('every clause still says whose money it is',
  partnerCash.every((piece) => /Aoife/.test(piece)), JSON.stringify(partnerCash));
check('the partner sentence is still split', partnerCash.length > 1);

// The speaker needs no carrying: unowned money is already taken to be theirs.
const ownCash = segmentClientTurn(
  'I have 20,000 in cash, a 50,000 State Savings bond and 12,000 in prize bonds.'
);
check('the speaker\'s own clauses are not padded with a subject',
  ownCash.every((piece) => !/^I have I have/.test(piece)), JSON.stringify(ownCash));

// A clause that already names its own subject must not be given a second one.
const mixed = segmentClientTurn(
  'Aoife has 300,000 in a pension and Dermot has 40,000 in savings and Sean has 12,000 in shares.'
);
check('no clause is given a subject it already has',
  mixed.every((piece) => !/^(\w+ has )\1/.test(piece) && !/has .* has .* has/.test(piece)),
  JSON.stringify(mixed));

check('a holding with no stated owner belongs to the speaker',
  /owner: candidate\.owner \|\| 'primary'/.test(plannerSource),
  'people say "Aoife has" precisely when a holding is not their own');

console.info(`[TurnSegments] ${checks} checks passed: a dense answer is read in clause-sized pieces, `
  + 'settled clauses are read while the client still speaks, nothing read early survives without '
  + 'appearing in what they finally said, and a lost clause is never reported as success.');
