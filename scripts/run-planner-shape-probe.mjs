#!/usr/bin/env node

/**
 * PAID — one probe, one question: can the real planner model produce operations
 * the deterministic validator will accept AND that actually become canonical?
 *
 * WHY THIS RUNS BEFORE THE FULL BATCH. Every reconciliation plan in Phase 4 so
 * far was hand-written by the harness, and getting them right took three
 * corrections that a model has no reason to get right by luck: target the
 * POSITION note rather than the scalar sitting beside it; use a catalogue slot
 * id for a new entity; and pick a reason code whose claim matches the note kind
 * (`aggregate_summary` asserts the note IS a summary and is refused on a
 * position). A model that gets these wrong does not fail loudly — its
 * operations are ACCEPTED and land nowhere, which reads as a healthy
 * reconciliation row and shows up only as readiness that never moves.
 *
 * So this spends a few cents to answer that before spending on conversations.
 *
 * WHAT IS REAL: the planner model, the reconciler, the validator, the projector,
 * the Durable Object, local D1. What is scripted: the live side, deterministically,
 * so the only variable in the run is the model under test.
 *
 * WHAT IT NEVER TOUCHES: production. Local SQLite in a temp directory, no
 * deployment, no production configuration, no writes outside this process.
 *
 *   node --env-file-if-exists=.env.local ./scripts/run-planner-shape-probe.mjs
 */

import { attachLiveSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { LiveProviderSimulator } from './live-harness/provider.mjs';
import { loadLiveContext, liveStateProjection } from '../worker/src/consumer/live/live_tools.js';
import { getCurrentProfile, getSessionRow } from '../worker/src/consumer/repository.js';
import { euroCostFor } from './agent-harness/cost.mjs';
import { plannerFactContracts } from '../worker/src/consumer/planner_reconciliation.js';

/**
 * WHICH FACTS CAN ACTUALLY REACH CANONICAL STATE.
 *
 * Derived from the same contract the planner is sent, never a hand-kept list.
 * An operation on a fact with NO canonical target — `gross_household_income` is
 * derived from incomeSources and was never independently writable — is meant to
 * stay an evidenced note. Counting that as "accepted but not canonical" made the
 * probe fail for the system behaving exactly as designed.
 */
const CANONICALLY_WRITABLE = new Set(
  plannerFactContracts(
    (await import('../js/planning/semantic_facts.js'))
      .listSemanticFactDefinitions().map((definition) => definition.factId)
  ).map((contract) => contract.factId)
);

const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
if (!apiKey) {
  console.error('OPENAI_API_KEY is required. This probe makes real planner model calls.');
  console.error('  node --env-file-if-exists=.env.local ./scripts/run-planner-shape-probe.mjs');
  process.exit(2);
}

const line = (text = '') => console.info(text);
const failures = [];
const fail = (message) => failures.push(message);

const meeting = await newLiveMeeting('planner-shape-probe', {
  CONSUMER_PLANNER_RECONCILIATION_MODE: 'apply',
  OPENAI_API_KEY: apiKey
});
const { session, durable, provider } = await attachLiveSession(meeting);
const simulator = new LiveProviderSimulator({ session, durable, provider });

/** Every verdict the reconciler reached, and the shape detail D1 does not keep. */
const outcomes = [];
const realExecute = session.executePlannerReconciliation.bind(session);
session.executePlannerReconciliation = async (config, context, job) => {
  const startedAt = Date.now();
  try {
    const result = await realExecute(config, context, job);
    outcomes.push({
      trigger: job.trigger,
      status: result?.status,
      latencyMs: Date.now() - startedAt,
      accepted: result?.validation?.acceptedOperationIds || [],
      rejected: (result?.validation?.rejectedGroups || [])
        // `message` is the field the validator actually sets; `detail` never
        // existed, so every rejection printed its code and nothing else — which
        // is why two `operation_invalid` failures went undiagnosed for a run.
        .map((group) => ({ groupId: group.groupId, code: group.code, message: group.message })),
      // THE QUIET FAILURE. An operation with no canonical home is admitted to
      // the ledger and reported here rather than blocking the batch, so a plan
      // that looks accepted and changes nothing is visible only on this line.
      unprojected: result?.validation?.unprojectedFactOperationIds || [],
      unprojectable: (result?.validation?.unprojectableNotes || [])
        .map((note) => ({ factId: note.factId, code: note.code })),
      // Operations the server could not even parse into the wire contract.
      dropped: (result?.droppedOperations || []).map((item) => item.operationId || 'unnamed'),
      // THE OPERATION AS THE MODEL WROTE IT. Without this, an "accepted but not
      // canonical" outcome says only that something landed nowhere — never
      // which field was wrong, which is the only thing that can be acted on.
      operations: (result?.plan?.operationGroups || []).flatMap((group) => group.operations)
        .map((operation) => ({
          operationId: operation.operationId,
          op: operation.op,
          // The full identity, because a correct_note/reclassify_note/retract_note
          // is defined by what it TARGETS, and an operation printed without its
          // target cannot be diagnosed at all.
          targetNoteId: operation.targetNoteId || '(none)',
          factId: operation.factId,
          factInstanceId: operation.factInstanceId,
          entityId: operation.entityId,
          ownerId: operation.ownerId,
          noteKind: operation.noteKind,
          reasonCode: operation.reasonCode,
          value: operation.value
        }))
    });
    return result;
  } catch (error) {
    outcomes.push({
      trigger: job.trigger,
      status: 'threw',
      latencyMs: Date.now() - startedAt,
      errorCode: String(error?.code || error?.message || error)
    });
    throw error;
  }
};

const say = async (clientText, facts = null) => {
  const turn = await simulator.turn({
    clientText,
    act: async ({ callTool }) => {
      const calls = [];
      if (facts) calls.push(await callTool('save_facts', { facts }));
      return { speech: 'Thanks — let me take that down.', calls };
    }
  });
  await settle(durable, session);
  return turn;
};

const projection = async () => liveStateProjection(await loadLiveContext({
  env: meeting.env, config: meeting.config, sessionId: meeting.sessionId
}));
const stillNeeded = (view) => (view.analyses || [])
  .flatMap((analysis) => (analysis.stillNeeded || []).map((need) => need.factId));

line('PLANNER SHAPE PROBE — real planner model, scripted live side');
line(`  model                : ${meeting.config.realtimePlannerModel}`);
line(`  reconciliation mode  : ${meeting.config.plannerReconciliationMode}`);
line(`  timeout              : ${meeting.config.plannerReconciliationTimeoutMs}ms`);
line(`  database             : ${meeting.databasePath}`);
line();

/**
 * THE TWO GAPS THE PLANNER MUST CLOSE, AND WHY THEY ARE THE RIGHT TWO.
 *
 * The age is a SCALAR the client states plainly and the live lane simply does
 * not save — the exact production defect Phase 3 was built for. The income is an
 * ENTITY the live lane actively REJECTS, because three numbers share the turn
 * and the numeric guard fails closed. Between them they cover both operation
 * families: a scalar correction into a person, and a new entity that must take a
 * catalogue slot id and carry a canonical record.
 */
await say("I'm 57 and I'm married. My partner is 59. I'd like to get my pension sorted out before I retire.", [
  { factId: 'primary_goal', value: { type: 'improve_pension' }, certainty: 'exact' }
]);
await say("I'd like to retire at 62 if the numbers work.", [
  { factId: 'intended_retirement_age', value: 62, certainty: 'exact' }
]);
await say('The occupational pension is worth about 319,000 right now.', [
  {
    factId: 'pension_positions',
    value: {
      operation: 'upsert', entityId: 'occ1', type: 'occupational', owner: 'primary',
      currentValue: { amount: 319000, currency: 'EUR' }
    },
    certainty: 'approximate'
  }
]);

const beforeRepair = await projection();
line(`needs before the income turn : ${stillNeeded(beforeRepair).join(', ') || '(none)'}`);

// Three figures in one turn: the live guard refuses the income and the rates
// land. The refusal is the point — it is what the auditor has to repair.
const incomeTurn = await say("I'm on 95,000 a year. I put in 6 percent and the company puts in 8 percent.", [
  { factId: 'gross_household_income', value: { amount: 95000, currency: 'EUR' }, certainty: 'exact' },
  {
    factId: 'income_sources',
    value: {
      operation: 'upsert', entityId: 'job1', type: 'employment', owner: 'primary',
      grossAnnual: { amount: 95000, currency: 'EUR' }
    },
    certainty: 'exact'
  },
  { factId: 'pension_employee_contribution_rate', value: 6, certainty: 'exact' },
  { factId: 'pension_employer_contribution_rate', value: 8, certainty: 'exact' }
]);
const rejectedLive = incomeTurn.toolCalls
  .flatMap((call) => call.result?.rejected || [])
  .map((item) => item.factId);
line(`live lane rejected           : ${rejectedLive.join(', ') || '(none)'}`);

await say('Yes, it is still being paid into every month.', [
  { factId: 'pension_contribution_status', value: 'active', certainty: 'exact' }
]);

const afterRepair = await projection();
const profile = await getCurrentProfile(meeting.env, await getSessionRow(meeting.env, meeting.sessionId));

/* ------------------------------------------------------------------ report */

line();
line('RECONCILIATIONS');
for (const outcome of outcomes) {
  line(`  ${String(outcome.trigger).padEnd(22)} ${String(outcome.status).padEnd(10)} ${outcome.latencyMs}ms`
    + ` accepted=[${(outcome.accepted || []).join(', ')}]`);
  for (const rejection of outcome.rejected || []) {
    line(`      REJECTED ${rejection.groupId}: ${rejection.code}`
      + `${rejection.message ? ` — ${rejection.message}` : ''}`);
  }
  // EVERY OPERATION, ACCEPTED OR NOT. Printing only refusals meant an ACCEPTED
  // operation that produced an unexpected record could not be read at all — an
  // income source landed with no money in it and the output could not say
  // whether the model omitted the amount or a later pass was meant to add it.
  for (const operation of outcome.operations || []) {
    const verdict = (outcome.accepted || []).includes(operation.operationId)
      ? 'accepted' : 'refused';
    line(`        ${verdict}: ${JSON.stringify(operation)}`);
  }
  for (const operationId of outcome.unprojected || []) {
    const operation = (outcome.operations || []).find((item) => item.operationId === operationId);
    const writable = operation ? CANONICALLY_WRITABLE.has(operation.factId) : true;
    line(`      ${writable ? 'ACCEPTED BUT NOT CANONICAL' : 'kept as evidence (no canonical target)'}: ${operationId}`);
    if (operation) line(`        as written: ${JSON.stringify(operation)}`);
  }
  for (const note of outcome.unprojectable || []) {
    line(`      UNPROJECTABLE NOTE ${note.factId}: ${note.code}`);
  }
  for (const operationId of outcome.dropped || []) {
    line(`      DROPPED (unparseable): ${operationId}`);
  }
  if (outcome.errorCode) line(`      THREW ${outcome.errorCode}`);
}

const usage = (await meeting.env.CONSUMER_DB.prepare(`
  SELECT model, status, latency_ms, input_tokens, output_tokens, cached_input_tokens,
         operation_count, accepted_operation_count, rejected_operation_count
  FROM consumer_planner_reconciliations WHERE session_id = ? ORDER BY created_at ASC
`).bind(meeting.sessionId).all()).results || [];
const sum = (key) => usage.reduce((total, row) => total + Number(row[key] || 0), 0);

line();
line('OPERATION SEQUENCE (what was proposed, in order, and what became of it)');
for (const [index, outcome] of outcomes.entries()) {
  const terminal = outcome.status === 'threw'
    ? `THREW ${outcome.errorCode}` : outcome.status;
  for (const operation of outcome.operations || []) {
    const verdict = (outcome.accepted || []).includes(operation.operationId)
      ? 'accepted'
      : (outcome.unprojected || []).includes(operation.operationId)
        ? 'accepted-not-canonical' : 'refused';
    line(`  pass ${index + 1} [${terminal}] ${operation.op} ${operation.factId}`
      + ` -> ${verdict}`);
  }
  // A pass that threw carries NO operations, and that absence is the point: a
  // two-step create/amend whose second step was lost to a timeout looks
  // identical to a model that never sent one unless the pass is named here.
  if (!(outcome.operations || []).length) {
    line(`  pass ${index + 1} [${terminal}] — no operations recorded`
      + `${outcome.status === 'threw' ? ' (anything this pass would have sent was lost)' : ''}`);
  }
}

line();
line('ACTUAL MODEL USAGE');
line(`  planner calls        : ${usage.length}`);
line(`  input tokens         : ${sum('input_tokens')} (cached ${sum('cached_input_tokens')})`);
line(`  output tokens        : ${sum('output_tokens')}`);
line(`  total operations     : ${sum('operation_count')}`
  + ` (accepted ${sum('accepted_operation_count')}, rejected ${sum('rejected_operation_count')})`);
const latencies = usage.map((row) => Number(row.latency_ms || 0)).sort((a, b) => a - b);
line(`  latency median / max : ${latencies[Math.floor(latencies.length / 2)] ?? 0}ms / ${latencies.at(-1) ?? 0}ms`);
const spend = usage.reduce((total, row) => total + euroCostFor({
  model: row.model,
  inputTokens: Number(row.input_tokens || 0),
  outputTokens: Number(row.output_tokens || 0),
  cachedInputTokens: Number(row.cached_input_tokens || 0)
}), 0);
line(`  spend                : €${spend.toFixed(4)}`);

line();
line('STATE');
line(`  primaryPerson.age    : ${profile.primaryPerson.age ?? '(missing)'}`);
line(`  partner.age          : ${profile.partner?.age ?? '(none)'}`);
line(`  incomeSources        : ${JSON.stringify((profile.incomeSources || [])
  .map((item) => ({ owner: item.ownerId, gross: item.grossAnnual?.amount })))}`);
line(`  pensions             : ${(profile.pensions || [])
  .map((item) => `${item.ownerId}=${item.currentValue?.amount}`).join(', ') || '(none)'}`);
line(`  needs before         : ${stillNeeded(beforeRepair).join(', ') || '(none)'}`);
line(`  needs after          : ${stillNeeded(afterRepair).join(', ') || '(none)'}`);

/* ------------------------------------------------------------- pass / fail */

if (usage.length === 0) fail('the planner never ran, so nothing about its output was tested');
if (outcomes.some((outcome) => outcome.status === 'threw')) {
  fail('a reconciliation threw rather than returning a verdict');
}
for (const outcome of outcomes) {
  const writableUnprojected = (outcome.unprojected || []).filter((operationId) => {
    const operation = (outcome.operations || []).find((item) => item.operationId === operationId);
    return operation ? CANONICALLY_WRITABLE.has(operation.factId) : true;
  });
  if (writableUnprojected.length > 0) {
    fail(`accepted but not canonical: ${writableUnprojected.join(', ')} — the operation landed nowhere`);
  }
  if ((outcome.dropped || []).length > 0) {
    fail(`the model emitted operations the wire contract could not parse: ${outcome.dropped.join(', ')}`);
  }
  for (const rejection of outcome.rejected || []) {
    // Shape errors are the probe's subject. A refusal on the CONTENT of a claim
    // (no evidence for it, a stale target) is the validator working correctly
    // and is reported without failing the probe.
    const shapeCodes = [
      'aggregate_not_a_position', 'entity_unknown', 'position_entity_mismatch',
      'position_owner_mismatch', 'position_value_invalid', 'target_note_unknown',
      'scalar_value_unprojectable', 'planner_reconciliation_output_invalid'
    ];
    if (shapeCodes.includes(rejection.code)) {
      fail(`bad operation shape from the model: ${rejection.groupId} — ${rejection.code}`);
    }
  }
}

const needsBefore = new Set(stillNeeded(beforeRepair));
const needsAfter = new Set(stillNeeded(afterRepair));
if (profile.primaryPerson.age !== 57) {
  fail(`the planner did not canonicalise the age the client stated plainly (got ${profile.primaryPerson.age ?? 'nothing'})`);
}
if (needsAfter.size >= needsBefore.size && needsAfter.has('person_current_age')) {
  fail('readiness did not move after the repair');
}

line();
if (failures.length) {
  line('RESULT: FAIL');
  for (const failure of failures) line(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  line('RESULT: PASS — the real planner produced valid, canonical-reaching operations');
}
