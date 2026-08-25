/**
 * Reconciler evals for the cases no validator can grade.
 *
 * WHY THESE ARE NOT IN A check: SCRIPT
 *
 * check-consumer-live-numeric-transcription pins what the deterministic layer
 * may still refuse. It is fast, free and exact — and it is blind to everything
 * that depends on the conversation. "400" is a car repayment only because of
 * the question before it. "About three or four" is worth a clarification, not
 * a value. Both are decided by reading, so both are graded by running the real
 * reconciliation prompt against the real model.
 *
 * This drives the production RECONCILIATION_SYSTEM_PROMPT and the production
 * input builder, then puts the returned plan through the production
 * applyReconciliationPlan with the reviewed-turn scope switched on — the same
 * two gates a live meeting uses. Nothing about the grading path is a mock.
 *
 * Paid: one model call per case. No D1, no WebRTC, no deployment.
 *
 *   OPENAI_API_KEY=sk-... node --env-file-if-exists=.env.local \
 *     scripts/run-reconciliation-transcription-evals.mjs
 *   ... --case terse_childcare_900     run one case
 *   ... --repeat 3                     run each case 3x and report stability
 *   ... --verbose                      print the operations returned
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MODULE_IDS } from '../js/planning/contracts.js';
import { applyReconciliationPlan } from '../js/planning/reconciliation.js';
import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';
import { describeConversationState } from '../worker/src/consumer/conversation.js';
import { buildPlanningContext } from '../worker/src/consumer/planning_context.js';
import {
  buildPlannerReconciliationContext,
  requestPlannerReconciliation
} from '../worker/src/consumer/planner_reconciliation.js';

const dataset = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/reconciliation-transcription-evals.json', import.meta.url)),
  'utf8'
));

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1];
};
const VERBOSE = args.includes('--verbose');
const REPEAT = Math.max(1, Number(flag('repeat') || 1));
const ONLY = flag('case');

const KEY = String(process.env.OPENAI_API_KEY || '').trim();
if (!KEY) {
  console.error('OPENAI_API_KEY is not set. Run with --env-file-if-exists=.env.local from the repo root.');
  process.exit(2);
}

const NOW = '2026-08-09T10:00:00.000Z';

// Routing has to be on. A fact only reaches the reviewer when some selected
// analysis is waiting on it, so a config without these flags produces zero
// module slots, zero fact contracts, and a reviewer correctly told there is
// nothing it is allowed to write.
const CONFIG = Object.freeze({
  realtimePlannerModel: process.env.RECONCILIATION_MODEL || 'gpt-5.6-luna',
  plannerReconciliationTimeoutMs: 60_000,
  plannerReconciliationMaxOutputTokens: 4_000,
  plannerReconciliationPromptVersion: 'planning-reconciliation-v3',
  plannerReconciliationMode: 'apply',
  goalRoutingEnabled: true,
  moduleRoutingEnabled: true,
  allowedModules: Object.values(MODULE_IDS),
  moduleOffersEnabled: true,
  realtimeSpokenCompletionEnabled: false
});

function freshContext(goalType, withPartner = false) {
  const seed = createHouseholdProfile({
    profileId: 'profile_reconciliation_eval',
    primaryPersonId: 'primary',
    nowIso: NOW,
    calculationDateIso: '2026-08-09'
  });
  seed.goals = [{
    goalId: 'goal_eval',
    type: goalType,
    title: 'The goal this meeting agreed',
    status: 'active',
    priority: 'high'
  }];
  // "hers is ninety" can only bind to somebody. A case about two owners needs
  // two owners on the profile, or the reviewer is right to refuse it.
  if (withPartner) {
    seed.partner = {
      personId: 'partner',
      role: 'partner',
      displayName: 'Aoife',
      employmentStatus: 'employee'
    };
  }
  const profile = normalizeHouseholdProfile(seed);
  const sessionRow = {
    id: 'cs_reconciliation_eval',
    current_profile_revision: profile.revision,
    confirmed_profile_revision: null
  };
  const planning = buildPlanningContext({
    config: CONFIG, sessionRow, profile, channel: 'live'
  });
  return {
    ...planning,
    profile,
    sessionRow,
    state: planning.state || describeConversationState(profile, CONFIG)
  };
}

/** The assistant question and the client answer, as the reviewer receives them. */
function turnsFor(testCase) {
  return [
    {
      id: 'turn_assistant',
      role: 'assistant',
      finalized: true,
      sequence: 1,
      transcript: testCase.assistantQuestion
    },
    {
      id: 'turn_client',
      role: 'user',
      finalized: true,
      sequence: 2,
      transcript: testCase.clientTurn
    }
  ];
}

// Bookkeeping fields carry numbers that are not the client's figures. Counting
// a need's `schemaVersion: 2` as a recovered value made a clarification look
// like it had produced the forbidden 2.
const NON_VALUE_KEYS = new Set([
  'schemaVersion', 'revision', 'priority', 'sequence', 'version', 'ordinal'
]);

/** Figures an operation actually WRITES. A clarification writes none. */
function amountsIn(operations) {
  const found = [];
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    for (const [key, item] of Object.entries(value)) {
      if (NON_VALUE_KEYS.has(key)) continue;
      if (typeof item === 'number' && Number.isFinite(item)) found.push({ key, value: item });
      else walk(item);
    }
  };
  operations
    .filter((operation) => operation.op !== 'request_clarification')
    .forEach((operation) => walk(operation.value));
  return found;
}

async function runCase(testCase) {
  const context = freshContext(testCase.goalType, testCase.partner === true);
  const input = buildPlannerReconciliationContext({
    context,
    turns: turnsFor(testCase),
    notes: [],
    throughTurnId: 'turn_client',
    reviewTurnIds: ['turn_client']
  });

  const requested = await requestPlannerReconciliation({
    env: { OPENAI_API_KEY: KEY }, config: CONFIG, input
  });
  const operations = (requested.plan?.operationGroups || []).flatMap((group) => group.operations);

  // The plan still has to survive the deterministic gate, with the reviewed
  // scope on. An eval that graded the raw model output would pass cases
  // production would reject.
  const validation = await applyReconciliationPlan({
    profile: context.profile,
    notes: [],
    plan: requested.plan,
    transcriptTurns: input.transcriptTurns,
    sessionId: context.sessionRow.id,
    transcriptWatermark: 'turn_client',
    baseProfileRevision: context.profile.revision,
    owners: input.owners,
    entities: input.entities,
    reviewedTurnIds: ['turn_client'],
    nowIso: NOW
  });

  const acceptedOps = operations.filter((operation) => (
    validation.acceptedOperationIds.includes(operation.operationId)
  ));
  const values = amountsIn(acceptedOps);
  // What the reviewer READ, before anything downstream judged it. These evals
  // are about reading; separating the two makes it visible when a figure was
  // transcribed correctly and then refused by an identity or projection rule
  // that has nothing to do with numbers.
  const proposed = amountsIn(operations);
  const clarifications = acceptedOps.filter((operation) => operation.op === 'request_clarification');
  const expect = testCase.expect;
  const problems = [];

  const forbidden = expect.forbiddenAmounts || [];
  for (const bad of forbidden) {
    if (values.some((item) => Math.abs(item.value - bad) < 1e-6)) {
      problems.push(`produced the forbidden figure ${bad}`);
    }
  }

  if (expect.outcome === 'clarification') {
    if (clarifications.length === 0) problems.push('did not ask for clarification');
  } else {
    const wanted = expect.outcome === 'multiple_values' ? expect.amounts : [expect.amount];
    for (const amount of wanted) {
      if (values.some((item) => Math.abs(item.value - amount) < 1e-6)) continue;
      problems.push(proposed.some((item) => Math.abs(item.value - amount) < 1e-6)
        ? `read ${amount} correctly, but the write was refused downstream`
        : `did not recover ${amount}`);
    }
  }

  return {
    id: testCase.id,
    family: testCase.family,
    ok: problems.length === 0,
    problems,
    rejected: validation.rejectedGroups?.map((group) => group.code) || [],
    values: values.map((item) => `${item.key}=${item.value}`),
    proposed: proposed.map((item) => `${item.key}=${item.value}`),
    clarifications: clarifications.length
  };
}

const selected = dataset.cases.filter((testCase) => !ONLY || testCase.id === ONLY);
if (selected.length === 0) {
  console.error(`No case matches --case ${ONLY}.`);
  process.exit(2);
}

console.log(`Reconciler transcription evals — ${selected.length} case(s) x ${REPEAT}`);
console.log(`model: ${CONFIG.realtimePlannerModel}\n`);

const tally = new Map();
for (const testCase of selected) {
  for (let attempt = 1; attempt <= REPEAT; attempt += 1) {
    let outcome;
    try {
      outcome = await runCase(testCase);
    } catch (error) {
      outcome = {
        id: testCase.id,
        family: testCase.family,
        ok: false,
        problems: [`threw: ${error?.message || error}`],
        rejected: [],
        values: [],
        proposed: [],
        clarifications: 0
      };
    }
    const record = tally.get(testCase.id) || { passes: 0, runs: 0, last: null };
    record.runs += 1;
    if (outcome.ok) record.passes += 1;
    record.last = outcome;
    tally.set(testCase.id, record);
    const mark = outcome.ok ? 'PASS' : 'FAIL';
    const suffix = REPEAT > 1 ? ` (run ${attempt}/${REPEAT})` : '';
    console.log(`  ${mark}  [${outcome.family}] ${outcome.id}${suffix}`);
    if (!outcome.ok) {
      for (const problem of outcome.problems) console.log(`         ${problem}`);
      if (outcome.rejected.length > 0) {
        console.log(`         deterministic gate refused: ${outcome.rejected.join(', ')}`);
      }
    }
    if (VERBOSE) {
      console.log(`         proposed: ${outcome.proposed?.join(', ') || 'none'}`);
      console.log(`         values: ${outcome.values.join(', ') || 'none'}`);
      console.log(`         clarifications: ${outcome.clarifications}`);
    }
  }
}

const failing = [...tally.entries()].filter(([, record]) => record.passes < record.runs);
console.log(`\n${tally.size} case(s): `
  + `${tally.size - failing.length} fully passing, ${failing.length} with at least one failure.`);
if (failing.length > 0) {
  for (const [id, record] of failing) {
    console.log(`  ${id}: ${record.passes}/${record.runs}`);
  }
  process.exit(1);
}
