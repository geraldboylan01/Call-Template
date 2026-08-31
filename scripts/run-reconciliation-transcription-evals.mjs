/**
 * Reconciler evals for the cases no validator can grade.
 *
 * WHY THESE ARE NOT IN A check: SCRIPT
 *
 * check-consumer-turn-reading pins what the agreement gate
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
  mapReconciledFactValue,
  requestPlannerReconciliation
} from '../worker/src/consumer/planner_reconciliation.js';
import { readClientTurnFigures } from '../worker/src/consumer/turn_reading.js';

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
  plannerReconciliationPromptVersion: 'planning-reconciliation-v2',
  plannerReconciliationMode: 'apply',
  turnReadingMode: process.env.TURN_READING_MODE || 'apply',
  turnReadingModel: process.env.RECONCILIATION_MODEL || 'gpt-5.6-luna',
  turnReadingTimeoutMs: 30_000,
  turnReadingMaxOutputTokens: 800,
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

/** Read a slash path out of a profile. */
function atPath(profile, path) {
  return String(path || '').split('/').filter(Boolean)
    .reduce((node, key) => (node === null || node === undefined ? node : node[key]), profile);
}

/** Every money value in the resulting profile, with where it landed. */
function canonicalMoney(profile, node = profile, trail = [], found = []) {
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    node.forEach((item, index) => canonicalMoney(profile, item, [...trail, String(index)], found));
    return found;
  }
  if (typeof node.amount === 'number' && typeof node.currency === 'string') {
    found.push({ trail: trail.join('/'), amount: node.amount, currency: node.currency });
    return found;
  }
  for (const [key, item] of Object.entries(node)) {
    canonicalMoney(profile, item, [...trail, key], found);
  }
  return found;
}

/**
 * Does the resulting canonical state say what this case expects?
 *
 * FIGURE AGREEMENT IS NOT SEMANTIC AGREEMENT. Two readers can both say 90,000
 * and the write can still attach it to the wrong person's pension, put a
 * monthly figure in an annual field, or store it as a summary that no module
 * reads. Those are correct numbers in the wrong life, and grading numbers
 * cannot tell them apart from the right answer. So this grades the STATE:
 * value, field, owner, entity and representation.
 */
function canonicalProblems(profile, expectations, forbidden) {
  const problems = [];
  const money = canonicalMoney(profile);
  const has = (want) => {
    if (want.path !== undefined) {
      const node = atPath(profile, want.path);
      return Boolean(node)
        && Math.abs(Number(node.amount) - want.amount) < 1e-6
        && (!want.currency || node.currency === want.currency);
    }
    if (want.collection !== undefined) {
      const records = profile?.[want.collection] || [];
      return records.some((record) => {
        if (want.ownerId !== undefined) {
          const owners = record.ownerId !== undefined
            ? [record.ownerId]
            : (record.ownerIds || []);
          if (!owners.includes(want.ownerId)) return false;
        }
        const field = want.field ? record[want.field] : null;
        if (!field) return false;
        return Math.abs(Number(field.amount) - want.amount) < 1e-6
          && (!want.currency || field.currency === want.currency);
      });
    }
    return money.some((item) => Math.abs(item.amount - want.anyMoney) < 1e-6
      && (!want.currency || item.currency === want.currency));
  };

  for (const want of expectations) {
    if (!has(want)) {
      problems.push(`canonical state is missing ${JSON.stringify(want)}`);
    }
  }
  for (const want of forbidden) {
    if (has(want)) {
      problems.push(`canonical state contains the FORBIDDEN binding ${JSON.stringify(want)}`);
    }
  }
  // ANYTHING WRITTEN THAT NO EXPECTATION ACCOUNTS FOR — counted per landing
  // place, not per amount. Matching by amount alone meant a correct EUR 2,500
  // in the right field plus a second EUR 2,500 on the wrong owner scored clean,
  // because the number was "expected". Each expectation accounts for exactly
  // one write.
  const budget = expectations
    .map((want) => (want.amount !== undefined ? want.amount : want.anyMoney))
    .filter((value) => value !== undefined);
  for (const item of money) {
    const index = budget.findIndex((value) => Math.abs(item.amount - value) < 1e-6);
    if (index !== -1) {
      budget.splice(index, 1);
      continue;
    }
    problems.push(`canonical state contains an unexpected ${item.currency} ${item.amount} at ${item.trail}`);
  }
  return problems;
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

  // Two readers, asked independently. The reading request carries only the
  // turn and the question; it never sees the reconciler's plan, and the
  // reconciler never sees the reading.
  const [requested, reading] = await Promise.all([
    requestPlannerReconciliation({ env: { OPENAI_API_KEY: KEY }, config: CONFIG, input }),
    readClientTurnFigures({
      env: { OPENAI_API_KEY: KEY },
      config: CONFIG,
      turnId: 'turn_client',
      transcript: testCase.clientTurn,
      assistantQuestion: testCase.assistantQuestion
    })
  ]);
  const operations = (requested.plan?.operationGroups || []).flatMap((group) => group.operations);

  // The plan still has to survive the deterministic gate. An eval that graded
  // the raw model output would pass cases production would reject. The
  // reviewed-turn scope was removed with the unsafe grant, so these currently
  // measure the reviewer against the OLD gate — which is the baseline the
  // corrected Phase 3 design has to beat.
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
    turnReadings: CONFIG.turnReadingMode === 'apply' && reading ? [reading] : [],
    // The production mapper, so what is graded is the canonical state a real
    // meeting would end up with — not an intermediate the projector never saw.
    mapFactValue: mapReconciledFactValue,
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

  // FALSE AGREEMENT IS THE FAILURE THIS DESIGN CANNOT OTHERWISE SEE. Agreement
  // is what buys a write, so two readers landing on the same WRONG figure is
  // worse than either of them being obviously wrong. Graded against the
  // fixture's labelled expectation, which is the only thing that can tell them
  // apart.
  const readFigures = (reading?.figures || []).filter((item) => !item.ambiguous);
  const wanted = expect.outcome === 'multiple_values'
    ? expect.amounts
    : expect.outcome === 'value' ? [expect.amount] : [];
  const forbiddenRead = (expect.forbiddenAmounts || [])
    .filter((bad) => readFigures.some((item) => Math.abs(item.digits - bad) < 1e-6));
  const falseAgreement = forbiddenRead.filter((bad) => (
    values.some((item) => Math.abs(item.value - bad) < 1e-6)
  ));
  if (falseAgreement.length > 0) {
    problems.push(`FALSE AGREEMENT: both readers produced ${falseAgreement.join(', ')}`);
  }

  // The state a real meeting would be left with, graded as state.
  problems.push(...canonicalProblems(
    validation.profile || context.profile,
    expect.canonical || [],
    expect.forbidCanonical || []
  ));

  return {
    id: testCase.id,
    family: testCase.family,
    readFigures: readFigures.map((item) => item.digits),
    readMissedWanted: wanted.filter((amount) => (
      !readFigures.some((item) => Math.abs(item.digits - amount) < 1e-6)
    )),
    forbiddenRead,
    falseAgreement,
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
    const record = tally.get(testCase.id)
      || { passes: 0, runs: 0, last: null, falseAgreements: [], readMisses: 0 };
    record.runs += 1;
    if (outcome.ok) record.passes += 1;
    // EVERY REPETITION COUNTS, not just the last one. A false agreement in run
    // one that does not recur in run three is still a false agreement, and
    // reporting only the final attempt hides exactly the intermittent failures
    // repetition exists to find.
    if (outcome.falseAgreement?.length > 0) {
      record.falseAgreements.push(...outcome.falseAgreement);
    }
    if (outcome.readMissedWanted?.length > 0) record.readMisses += 1;
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
    if (outcome.forbiddenRead?.length > 0 && outcome.falseAgreement?.length === 0) {
      console.log(`         (reader alone produced a forbidden figure: `
        + `${outcome.forbiddenRead.join(', ')} — caught by disagreement)`);
    }
    if (VERBOSE) {
      console.log(`         read:     ${outcome.readFigures?.join(', ') || 'none'}`);
      console.log(`         proposed: ${outcome.proposed?.join(', ') || 'none'}`);
      console.log(`         values: ${outcome.values.join(', ') || 'none'}`);
      console.log(`         clarifications: ${outcome.clarifications}`);
    }
  }
}

const failing = [...tally.entries()].filter(([, record]) => record.passes < record.runs);
const falseAgreements = [...tally.values()].filter((record) => record.falseAgreements.length > 0);
const readMisses = [...tally.values()].filter((record) => record.readMisses > 0);
const totalRuns = [...tally.values()].reduce((sum, record) => sum + record.runs, 0);
const totalPasses = [...tally.values()].reduce((sum, record) => sum + record.passes, 0);
console.log(`\n${tally.size} case(s): `
  + `${tally.size - failing.length} fully passing, ${failing.length} with at least one failure.`);
console.log(`Across ${totalRuns} run(s): ${totalPasses} passed, `
  + `${totalRuns - totalPasses} failed (${((totalPasses / totalRuns) * 100).toFixed(0)}%).`);
console.log(`Independent reader: missed the expected figure in ${readMisses.length} case(s), `
  + `agreed with the reconciler on a FORBIDDEN figure in ${falseAgreements.length}.`);
if (REPEAT > 1) {
  const unstable = [...tally.entries()]
    .filter(([, record]) => record.passes > 0 && record.passes < record.runs);
  console.log(`Unstable (passed some runs, failed others): ${unstable.length}`);
  for (const [id, record] of unstable) console.log(`  ${id}: ${record.passes}/${record.runs}`);
}
if (falseAgreements.length > 0) {
  console.error('\nFALSE AGREEMENT OBSERVED. Agreement is what this design treats as '
    + 'permission to write, so this is the result that says it must not ship in apply:');
  for (const record of falseAgreements) {
    console.error(`  ${record.last.id}: both readers produced ${[...new Set(record.falseAgreements)].join(', ')}`);
  }
}
if (failing.length > 0) {
  for (const [id, record] of failing) {
    console.log(`  ${id}: ${record.passes}/${record.runs}`);
  }
  process.exit(1);
}
