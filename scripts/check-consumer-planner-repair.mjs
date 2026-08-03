/**
 * The narrow second pass over what the first could not record.
 *
 * WHY THIS EXISTS. Extraction fails on dense turns. A client who names two
 * pensions and both contribution rates in one breath has said something
 * perfectly clear that the engine cannot place, because "30%" does not say
 * which pension. Observed live: both rates were refused as ambiguous, and the
 * identical restatement one turn later was accepted -- by then the meeting had
 * asked about one pension, so the answer bound to it. The information was
 * always there; only the linkage was missing.
 *
 * The repair asks the planner once, narrowly, about exactly those items. The
 * rules below are all about what it must NOT do: never run on a clean turn,
 * never retry a settled refusal, never invent a value, and never cost the
 * client more than one extra wait.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildRepairRequest, mergeRepairOutcomes } from '../worker/src/consumer/planning_turn.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let checks = 0;
const check = (label, condition, detail = '') => {
  checks += 1;
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
};

/* ------------------------------------------------ when it must not run */

check('a clean turn asks for no repair',
  buildRepairRequest([{ candidateId: 'fact-1', factId: 'person_current_age', accepted: true }]) === null,
  'a turn that worked must cost nothing extra');
check('an empty turn asks for no repair', buildRepairRequest([]) === null);
check('a missing outcome list is handled', buildRepairRequest() === null);

// A refusal that reflects a settled rule is not a parsing problem. Retrying it
// spends a planner call and the client's patience to be told the same thing.
for (const errorCode of [
  'realtime_fact_not_supported',
  'realtime_profile_revision_conflict',
  'realtime_fact_confirmation_required',
  'consumer_module_not_released'
]) {
  check(`a settled refusal is not retried: ${errorCode}`,
    buildRepairRequest([{ candidateId: 'fact-1', accepted: false, errorCode }]) === null);
}

/* --------------------------------------------------- what it asks for */

const ambiguous = buildRepairRequest([
  { candidateId: 'fact-1', factId: 'pension_employee_contribution_rate', accepted: false, errorCode: 'realtime_pension_review_required' },
  { candidateId: 'fact-2', factId: 'pension_employer_contribution_rate', accepted: false, errorCode: 'realtime_pension_review_required' }
]);
check('an ambiguous pension rate is worth re-reading', ambiguous !== null);
check('both failed rates are named', ambiguous.failedItems.length === 2);
check('the reason is carried, not the value',
  ambiguous.failedItems.every((item) => item.reason === 'pension_ambiguous'));
check('the fact it was trying to write is named',
  ambiguous.failedItems[0].factId === 'pension_employee_contribution_rate');
check('it is told to emit nothing else',
  /ONLY these items/.test(ambiguous.instruction) && /Emit nothing else/.test(ambiguous.instruction));
check('it is forbidden from inventing a value',
  /Never invent a value the turn does not support/.test(ambiguous.instruction));

const money = buildRepairRequest([
  { candidateId: 'position-1', accepted: false, errorCode: 'realtime_planner_candidate_money_invalid' }
]);
check('an unparseable amount is worth re-reading', money.failedItems[0].reason === 'money_invalid');

// Mixed: only the repairable ones travel.
const mixed = buildRepairRequest([
  { candidateId: 'fact-1', accepted: true },
  { candidateId: 'fact-2', accepted: false, errorCode: 'realtime_planner_candidate_money_invalid' },
  { candidateId: 'fact-3', accepted: false, errorCode: 'realtime_fact_not_supported' }
]);
check('an accepted item is never re-requested', mixed.failedItems.length === 1);
check('only the repairable failure travels', mixed.failedItems[0].candidateId === 'fact-2');

// Bounded, so a pathological turn cannot inflate the second request.
const many = buildRepairRequest(Array.from({ length: 30 }, (_, index) => ({
  candidateId: `fact-${index}`, accepted: false, errorCode: 'realtime_planner_candidate_money_invalid'
})));
check('the repair request is bounded', many.failedItems.length <= 8, String(many.failedItems.length));

/* ------------------------------------------------------- merging back */

// A value recovered on the second pass must read as RECORDED. Otherwise the
// renderer apologises for something the client can see was understood.
const merged = mergeRepairOutcomes(
  [{ candidateId: 'fact-1', factId: 'pension_employee_contribution_rate', accepted: false, errorCode: 'realtime_pension_review_required' }],
  [{ candidateId: 'fact-1', factId: 'pension_employee_contribution_rate', accepted: true, profileRevision: 4 }]
);
check('a recovered fact is reported as recorded, not as a retried rejection',
  merged.length === 1 && merged[0].accepted === true);

const stillFailing = mergeRepairOutcomes(
  [{ candidateId: 'fact-1', factId: 'asset_position', accepted: false, errorCode: 'realtime_planner_candidate_money_invalid' }],
  []
);
check('a repair that recovered nothing leaves the rejection standing',
  stillFailing.length === 1 && stillFailing[0].accepted === false);

const partial = mergeRepairOutcomes(
  [
    { candidateId: 'fact-1', factId: 'a', accepted: false, errorCode: 'realtime_planner_candidate_money_invalid' },
    { candidateId: 'fact-2', factId: 'b', accepted: false, errorCode: 'realtime_planner_candidate_money_invalid' }
  ],
  [{ candidateId: 'fact-1', factId: 'a', accepted: true }]
);
check('an unrecovered sibling still reports as failed',
  partial.filter((item) => item.accepted !== true).map((item) => item.factId).join() === 'b');
check('the recovered sibling is not double-counted',
  partial.filter((item) => item.factId === 'a').length === 1);

/* --------------------------------------------- how it is wired, both ways */

const agent = readFileSync(`${root}scripts/../worker/src/consumer/agent_session.js`, 'utf8');
const voice = readFileSync(`${root}worker/src/consumer/realtime_session.js`, 'utf8');

for (const [transport, source] of [['text', agent], ['voice', voice]]) {
  check(`${transport} runs at most one repair pass`,
    (source.match(/buildRepairRequest\(/g) || []).length === 1,
    'a repair that can itself trigger a repair is an unbounded loop on a paid call');
  check(`${transport} bounds the repair wait below a first pass`,
    /timeoutMs: Math\.min\(8_000/.test(source),
    'the client is already waiting; a slow repair is worth less than moving on');
  check(`${transport} merges rather than replaces the outcomes`,
    /mergeRepairOutcomes\(/.test(source));
}
// A degraded turn used the deterministic extractor, which has no model to re-ask.
check('text never repairs a deterministic fallback turn',
  /degraded \? null : buildRepairRequest/.test(agent));
// The failure must stay silent: the first pass's outcomes already drive what
// the client hears, and that path is covered by check-consumer-reflection.
check('a failed repair never propagates to the client',
  /catch \(_error\) \{[\s\S]{0,400}repair_failed/.test(voice));

const planner = readFileSync(`${root}worker/src/consumer/realtime_planner.js`, 'utf8');
check('the repair request reaches the planner payload', /repairRequest: repair/.test(planner));
check('the planner is told what a repair pass is', /Repair pass:/.test(planner));
check('the planner is told never to invent a value for a repair',
  /Never invent a value to satisfy a repair/.test(planner));
check('the planner is told how to disambiguate a pension',
  /set entityId or linkedEntityId to the pension it belongs to/.test(planner));
check('a rate stated after naming a scheme binds to that scheme, not a buyout bond',
  /never to a buyout bond/.test(planner));

console.info(`[PlannerRepair] ${checks} checks passed: a failed item is re-read once, narrowly, and `
  + 'only when re-reading could plausibly help.');
