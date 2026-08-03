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
  segmentClientTurn,
  shouldSegmentTurn
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
for (const source of [income, funds, rambling]) {
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

console.info(`[TurnSegments] ${checks} checks passed: a dense answer is read in clause-sized pieces, `
  + 'no figure is cut from what it describes, and a piece that fails loses one clause not the turn.');
