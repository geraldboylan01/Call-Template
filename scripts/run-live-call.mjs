#!/usr/bin/env node

/**
 * PHASE 4 — the whole product loop, end to end, in one process.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE DOES. Phases 1–3 each proved a component.
 * Two harnesses grew up around them and between them they cover everything —
 * but never at the same time. `run-live-persona-replay` drives the real live
 * prompt and the real three-tool surface, and has no reconciler and a fake
 * `confirm_and_run`. `runAgentScenario` has the real reconciler and runs the
 * real deterministic modules, through a text transport that is not the live
 * lane. `executeLiveTool` — the real dispatcher — had never been called by any
 * test at all; the only places it appeared, it was being replaced.
 *
 * So this joins them, on the real Durable Object:
 *
 *   client speech → real live tool dispatch → real save_facts → local D1
 *     → real reconciliation (and rebase) → refreshed readiness pushed at the
 *     model → real confirm_and_run → real deterministic module execution
 *
 * WHAT IS SCRIPTED, AND WHY THAT IS HONEST. In `--model=scripted` the two
 * MODELS are scripted: what the assistant says and which tools it calls, and
 * what the background planner concludes. Everything those decisions flow into
 * is production code. A scripted run therefore proves the machinery — capture,
 * canonicalisation, the race, readiness refresh, module arithmetic — and proves
 * nothing about the model's judgement. That is the paid run's job, and this
 * harness is built so it is the same harness.
 *
 *   node ./scripts/run-live-call.mjs --persona=pension_easy
 *   node ./scripts/run-live-call.mjs --persona=pension_easy --verbose
 *
 * FREE. No provider, no network, no deployment, no production writes. The
 * database is a disposable local SQLite file.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { attachLiveSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { LiveProviderSimulator } from './live-harness/provider.mjs';
import { scriptedPlanner } from './live-harness/scripted-planner.mjs';
import { loadLiveContext, liveStateProjection } from '../worker/src/consumer/live/live_tools.js';
import { LIVE_PROMPT_VERSION } from '../worker/src/consumer/live/catalogue_prompt.js';
import { LIVE_TOOLSET_VERSION } from '../worker/src/consumer/live/live_tools.js';
import { getCurrentProfile, getLatestAnalysis, getSessionRow } from '../worker/src/consumer/repository.js';
import { buildLiveCataloguePrompt } from '../worker/src/consumer/live/catalogue_prompt.js';
import { euroCostFor } from './agent-harness/cost.mjs';
import { createDiagnostics, newRunId } from './live-harness/diagnostics.mjs';
import {
  arithmeticVerdict,
  extraPositions,
  falsePositiveFigures,
  headlineFigure,
  ownershipVerdict,
  supersededFigures
} from './live-harness/metrics.mjs';
// ONE IMPLEMENTATION OF EACH PLAYER. These are the persona replay's own
// functions, driving the same real live prompt and the same real live tools; a
// second copy here would drift from the harness it is meant to agree with.
import {
  agentTurn,
  clientTurn,
  responseText,
  responseToolCalls
} from './run-live-persona-replay.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const VERBOSE = args.includes('--verbose');
const PERSONA_ID = flag('persona', 'pension_easy');
const MODEL_MODE = flag('model', 'scripted');
const PLANNER_LATENCY_MS = Number(flag('planner-latency', '0')) || 0;
const MAX_CONFIRM_ATTEMPTS = 3;

if (!['scripted', 'live'].includes(MODEL_MODE)) {
  console.error(`--model=${MODEL_MODE} is not a mode. Use "scripted" (free) or "live" (paid).`);
  process.exit(2);
}
if (MODEL_MODE === 'live' && !String(process.env.OPENAI_API_KEY || '').trim()) {
  console.error('--model=live makes real model calls and needs OPENAI_API_KEY.');
  console.error('  npm run probe:live-call -- --model=live --persona=pension_easy');
  process.exit(2);
}

const dataset = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/phase4-personas.json', import.meta.url)),
  'utf8'
));
const persona = dataset.personas.find((item) => item.id === PERSONA_ID);
if (!persona) {
  console.error(`No persona "${PERSONA_ID}". Available: ${dataset.personas.map((p) => p.id).join(', ')}`);
  process.exit(2);
}

/* ------------------------------------------------------------------ trace */

const trace = { turns: [], reconciliations: [], module: null, failures: [] };
const fail = (message) => { trace.failures.push(message); };

const line = (text = '') => console.info(text);
const heading = (text) => { line(); line(text); line('-'.repeat(text.length)); };

/* ------------------------------------------------------------- the meeting */

// `--reconciliation=legacy` runs the same call with the background planner off.
// It is a CONTROL, not a mode anyone should test in: it isolates whether a
// failure belongs to the reconciler or to everything downstream of it.
const RECONCILIATION_MODE = flag('reconciliation', 'apply');
const meeting = await newLiveMeeting(`phase4-${persona.id}`, {
  CONSUMER_PLANNER_RECONCILIATION_MODE: RECONCILIATION_MODE,
  // The RECONCILER needs its own key: it is a Worker-side model call, not part
  // of the harness's conversation. Without it every pass fails
  // `planner_reconciliation_request_failed` and the run looks like a planner
  // that had nothing to say.
  ...(MODEL_MODE === 'live' ? { OPENAI_API_KEY: String(process.env.OPENAI_API_KEY || '') } : {})
});
const { session, durable, provider } = await attachLiveSession(meeting);
const simulator = new LiveProviderSimulator({ session, durable, provider });

// EVERY RUN LEAVES EVIDENCE. `--run-id` lets a batch name its runs; otherwise
// one is minted. `--no-diagnostics` is for the offline suites, which assert on
// return values and do not need a directory each.
const diagnostics = createDiagnostics(
  flag('run-id', '') || newRunId(persona.id),
  { enabled: !args.includes('--no-diagnostics') }
);

const projection = async () => liveStateProjection(await loadLiveContext({
  env: meeting.env,
  config: meeting.config,
  sessionId: meeting.sessionId
}));

const stillNeeded = (view) => (view.analyses || [])
  .flatMap((analysis) => (analysis.stillNeeded || [])
    .map((need) => need.instanceId || need.factId));

const capturedFacts = (view) => [...(view.captured || [])];

const profileRevision = async () => Number(
  (await getSessionRow(meeting.env, meeting.sessionId))?.current_profile_revision ?? 0
);

/** The durable audit trail the reconciler writes, read straight from D1. */
const reconciliationRows = async () => (await meeting.env.CONSUMER_DB.prepare(`
  SELECT id, reconciliation_revision, base_profile_revision, applied_profile_revision,
         through_turn_id, trigger, mode, status, latency_ms, model,
         input_tokens, output_tokens, cached_input_tokens,
         operation_count, accepted_operation_count, rejected_operation_count
  FROM consumer_planner_reconciliations
  WHERE session_id = ?
  ORDER BY created_at ASC, id ASC
`).bind(meeting.sessionId).all()).results || [];

/* ---------------------------------------------------------- the two models */

// Which repair the scripted planner should propose, keyed by the turn that
// triggered it. Consumed in order, exactly as a real planner would be called.
const plannerQueue = [];
// In `live` the reconciler is the REAL model — stubbing it would leave the run
// with one scripted player and call itself an end-to-end test.
const planner = MODEL_MODE === 'scripted'
  ? scriptedPlanner(() => (plannerQueue.length ? plannerQueue.shift() : null),
    { latencyMs: PLANNER_LATENCY_MS })
  : { restore: () => {}, modelCalls: () => 0 };

/**
 * Why an operation was refused, which D1 does not keep.
 *
 * The reconciliation row stores accepted/rejected COUNTS. A count tells you
 * something was refused; it never tells you whether the refusal was the
 * validator working correctly or the harness citing evidence that does not
 * exist. So the outcome is observed in memory, at the seam the Durable Object
 * already calls, without changing what runs.
 */
const reconciliationOutcomes = [];
const realExecute = session.executePlannerReconciliation.bind(session);
session.executePlannerReconciliation = async (config, context, job) => {
  const startedAt = Date.now();
  try {
    const result = await realExecute(config, context, job);
    reconciliationOutcomes.push({
      trigger: job.trigger,
      status: result?.status,
      latencyMs: Date.now() - startedAt,
      baseRevision: context.profile.revision,
      appliedProfileRevision: result?.appliedProfileRevision ?? null,
      validationStatus: result?.validation?.status,
      accepted: result?.validation?.acceptedOperationIds || [],
      rejected: (result?.validation?.rejectedGroups || [])
        .map((group) => ({ groupId: group.groupId, code: group.code, detail: group.detail })),
      // ACCEPTED IS NOT THE SAME AS CANONICAL. An operation with no canonical
      // home is admitted to the ledger and reported here rather than blocking
      // the rest of the batch, so a run where readiness never moves despite
      // "accepted" operations has its explanation on this line.
      unprojected: result?.validation?.unprojectedFactOperationIds || [],
      clarifications: (result?.validation?.clarificationNeeds || [])
        .map((need) => need.factInstanceId)
    });
    diagnostics.record('reconciliation', {
      trigger: job.trigger,
      status: result?.status,
      latencyMs: Date.now() - startedAt,
      baseRevision: context.profile.revision,
      appliedProfileRevision: result?.appliedProfileRevision ?? null,
      rebasedFromRevisions: result?.rebasedFromRevisions || [],
      accepted: result?.validation?.acceptedOperationIds || [],
      rejected: (result?.validation?.rejectedGroups || [])
        .map((group) => ({ groupId: group.groupId, code: group.code, message: group.message })),
      unprojected: result?.validation?.unprojectedFactOperationIds || [],
      clarifications: (result?.validation?.clarificationNeeds || []).map((need) => need.factInstanceId),
      // The operations as the planner wrote them, so a refusal or a silent
      // non-projection can be read rather than inferred.
      operations: (result?.plan?.operationGroups || []).flatMap((group) => group.operations)
        .map((operation) => ({
          operationId: operation.operationId, op: operation.op, factId: operation.factId,
          targetNoteId: operation.targetNoteId || null, entityId: operation.entityId || null,
          ownerId: operation.ownerId || null, noteKind: operation.noteKind,
          reasonCode: operation.reasonCode, value: operation.value
        }))
    });
    return result;
  } catch (error) {
    reconciliationOutcomes.push({
      trigger: job.trigger,
      status: 'threw',
      latencyMs: Date.now() - startedAt,
      errorCode: String(error?.code || error?.message || error)
    });
    throw error;
  }
};

/** One scripted assistant turn: save what was heard, then speak. */
function scriptedAssistant(step) {
  return async ({ callTool }) => {
    const calls = [];
    if (Array.isArray(step.saveFacts) && step.saveFacts.length) {
      calls.push(await callTool('save_facts', { facts: step.saveFacts }));
    }
    if (step.getState) calls.push(await callTool('get_state', {}));
    return { speech: step.speech, calls };
  };
}

const MAX_TOOL_ROUNDS = 4;

/**
 * The assistant, played by the real model against the real live prompt and the
 * real live tool surface — and answered by the REAL Durable Object.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE PERSONA REPLAY, which shares these very
 * functions: there, tool results come from an in-memory approximation and the
 * refreshed state item is recomputed by the harness. Here every tool call goes
 * through `executeLiveTool` against local D1, and the state note handed back to
 * the model is the one the Durable Object ITSELF pushed onto the socket. If
 * production stops pushing it, this run stops seeing it.
 */
function liveAssistant(instructions, input) {
  return async ({ callTool }) => {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const payload = await agentTurn({ instructions, input });
      const calls = responseToolCalls(payload);
      const speech = responseText(payload);
      if (!calls.length) return { speech };
      for (const call of calls) {
        const sentBefore = provider.sent.length;
        const executed = await callTool(call.name, call.args);
        input.push({
          type: 'function_call',
          name: call.name,
          arguments: JSON.stringify(call.args),
          call_id: call.callId
        });
        input.push({
          type: 'function_call_output',
          call_id: call.callId,
          output: JSON.stringify(executed.result ?? {}).slice(0, 4_000)
        });
        // Whatever the DO pushed as a consequence — the refreshed state note
        // after a save, a compliance correction — reaches the model exactly as
        // the provider would have delivered it.
        for (const event of provider.sent.slice(sentBefore)) {
          if (event?.item?.role !== 'system' || event?.item?.type !== 'message') continue;
          input.push({ role: 'system', content: String(event.item.content?.[0]?.text || '') });
        }
      }
      if (speech) return { speech };
    }
    return { speech: '' };
  };
}

/* -------------------------------------------------------------- the call */

line(`PHASE 4 LIVE LOOP — persona "${persona.id}" (${persona.level})`);
line(`  prompt ${LIVE_PROMPT_VERSION} · toolset ${LIVE_TOOLSET_VERSION}`);
line(`  reconciliation mode ${meeting.config.plannerReconciliationMode} · target module ${persona.targetModule}`);
line(`  database ${meeting.databasePath}`);

/**
 * The turns, from whichever player is providing them.
 *
 * `scripted` replays the fixture's own turns. `live` lets the persona model
 * speak: it is handed the brief and the transcript so far and answers as that
 * person would, which is the only way to find out whether the assistant's
 * questions make sense to someone who did not read the script.
 */
const MAX_LIVE_TURNS = Number(flag('turns', '14')) || 14;
const liveInstructions = MODEL_MODE === 'live' ? buildLiveCataloguePrompt() : '';
const liveInput = [];
const liveTranscript = [];

async function* turnPlan() {
  if (MODEL_MODE === 'scripted') {
    for (const [index, step] of persona.turns.entries()) yield { index, step };
    return;
  }
  for (let index = 0; index < MAX_LIVE_TURNS; index += 1) {
    // The first turn is the persona's own opening line. A client model asked to
    // speak with an empty transcript has nothing to answer — and the Responses
    // API rejects the empty input outright.
    const clientText = index === 0
      ? String(persona.opening || '').trim()
      : await clientTurn(persona, liveTranscript);
    if (!clientText) {
      line(`  (the client had nothing further to say after turn ${index})`);
      return;
    }
    yield { index, step: { client: clientText, live: true } };
    // Stop once the analyses have run; the closing block handles confirmation.
    if ((await projection()).readyToConfirm === true) return;
  }
}

for await (const { index, step } of turnPlan()) {
  if (step.reconciliation) plannerQueue.push(step.reconciliation);
  const before = await projection();
  const beforeRevision = await profileRevision();
  const beforeReconciliations = (await reconciliationRows()).length;
  const beforeStateItems = provider.stateItems().length;

  if (step.live) liveInput.push({ role: 'user', content: step.client });
  diagnostics.record('client', { turn: index + 1, text: step.client });
  const turn = await simulator.turn({
    clientText: step.client,
    act: step.live ? liveAssistant(liveInstructions, liveInput) : scriptedAssistant(step)
  });
  diagnostics.record('assistant', {
    turn: index + 1, text: turn.speech, replyLatencyMs: turn.replyLatencyMs
  });
  for (const call of turn.toolCalls) {
    diagnostics.record('tool', {
      turn: index + 1,
      name: call.name,
      facts: (call.args?.facts || []).map((fact) => ({ factId: fact.factId, value: fact.value })),
      saved: call.result?.saved || [],
      // The exact refusal, code and message, which is the whole point of
      // keeping this: "rejected" without the reason is another dead end.
      rejected: (call.result?.rejected || []).map((item) => ({
        factId: item.factId, reason: item.reason, message: item.message || ''
      })),
      identityAmbiguities: call.result?.identityAmbiguities || []
    });
  }
  if (step.live) {
    liveTranscript.push({ role: 'client', text: step.client });
    if (turn.speech) {
      // `planeir`, not `assistant` — that is the role clientTurnDirective reads
      // to notice a pending confirmation. Naming it anything else silently
      // disables the persona's confirmation handling.
      liveTranscript.push({ role: 'planeir', text: turn.speech });
      liveInput.push({ role: 'assistant', content: turn.speech });
    }
  }

  // The reply is complete. Everything the planner does happens after this line,
  // and the latency above is what the client actually waited for.
  await settle(durable, session);

  const after = await projection();
  const settledProfile = await getCurrentProfile(
    meeting.env, await getSessionRow(meeting.env, meeting.sessionId)
  );
  diagnostics.record('canonical', {
    turn: index + 1,
    revision: settledProfile.revision,
    summary: JSON.stringify({
      primaryAge: settledProfile.primaryPerson?.age,
      partnerAge: settledProfile.partner?.age,
      pensions: (settledProfile.pensions || []).map((item) => ({
        id: item.pensionId, owner: item.ownerId, value: item.currentValue?.amount, label: item.label
      })),
      incomes: (settledProfile.incomeSources || []).map((item) => ({
        id: item.incomeId, owner: item.ownerId, gross: item.grossAnnual?.amount, net: item.netAnnual?.amount
      }))
    })
  });
  diagnostics.record('readiness', { turn: index + 1, stillNeeded: stillNeeded(after) });
  diagnostics.record('barrier', {
    turn: index + 1,
    unreviewedMaterialTurns: (session.unreviewedMaterialTurns || []).length,
    unresolvedIdentities: (session.unresolvedIdentities || []).length
  });
  const afterRows = await reconciliationRows();
  const record = {
    index: index + 1,
    client: step.client,
    speech: turn.speech,
    replyLatencyMs: turn.replyLatencyMs,
    tools: turn.toolCalls.map((call) => ({
      name: call.name,
      delivered: call.delivered,
      ok: call.result?.ok,
      saved: call.result?.saved,
      rejected: call.result?.rejected
    })),
    profileRevision: { before: beforeRevision, after: await profileRevision() },
    stillNeeded: { before: stillNeeded(before), after: stillNeeded(after) },
    reconciliationsStarted: afterRows.length - beforeReconciliations,
    stateItemsPushed: provider.stateItems().length - beforeStateItems,
    readyToConfirm: after.readyToConfirm === true
  };
  trace.turns.push(record);

  line();
  line(`TURN ${record.index}`);
  line(`  client   : ${step.client}`);
  line(`  assistant: ${turn.speech}`);
  line(`  reply latency        : ${record.replyLatencyMs}ms`);
  for (const call of record.tools) {
    line(`  tool ${call.name.padEnd(15)}: delivered=${call.delivered} ok=${call.ok}`
      + `${call.saved ? ` saved=[${call.saved.join(', ')}]` : ''}`
      + `${call.rejected?.length ? ` rejected=${JSON.stringify(call.rejected)}` : ''}`);
    if (!call.delivered) fail(`turn ${record.index}: ${call.name} result never reached the provider`);
  }
  line(`  profile revision     : ${record.profileRevision.before} -> ${record.profileRevision.after}`);
  line(`  reconciliations run  : ${record.reconciliationsStarted}`);
  line(`  state items pushed   : ${record.stateItemsPushed}`);
  line(`  still needed         : ${record.stillNeeded.after.length}`
    + ` (was ${record.stillNeeded.before.length})`);
  if (VERBOSE) {
    line(`  needs after          : ${record.stillNeeded.after.join(', ') || '(none)'}`);
    line(`  captured             : ${capturedFacts(after).join(' | ') || '(none)'}`);
  }
}

/* ------------------------------------------------------------- the closing */

heading('CLOSING — confirmation and module execution');

const beforeConfirm = await projection();
line(`readyToConfirm       : ${beforeConfirm.readyToConfirm === true}`);
line(`goalsAgreed          : ${beforeConfirm.goalsAgreed === true}`);
line(`analyses             : ${(beforeConfirm.analyses || []).map((a) => `${a.description}: ${a.status}`).join(' | ')}`);
line(`still needed         : ${stillNeeded(beforeConfirm).join(', ') || '(none)'}`);

let confirmResult = null;
if (beforeConfirm.readyToConfirm !== true) {
  fail(`the plan never became ready to confirm; still needed: ${stillNeeded(beforeConfirm).join(', ') || '(none)'}`);
  // A need that survives an APPLIED repair is the interesting case: the write
  // landed and the projection still disagrees. Print both sides rather than
  // guessing which one is wrong.
  const blocked = await getCurrentProfile(
    meeting.env,
    await getSessionRow(meeting.env, meeting.sessionId)
  );
  line();
  line('OUTSTANDING NEEDS, IN FULL');
  for (const analysis of beforeConfirm.analyses || []) {
    for (const need of analysis.stillNeeded || []) {
      line(`  ${need.instanceId || need.factId}: ${need.why || need.reason || '(no reason given)'}`);
    }
  }
  line();
  line('CANONICAL STATE AT THAT MOMENT');
  line(JSON.stringify({
    revision: blocked.revision,
    primaryPerson: blocked.primaryPerson,
    partner: blocked.partner,
    incomeSources: blocked.incomeSources,
    pensions: blocked.pensions
  }, null, 2).slice(0, 4_000));
} else {
  // THE TWO-STEP HANDSHAKE IS REAL, NOT A HARNESS QUIRK. With the reconciler
  // active, confirm_and_run refuses until the confirming turn has itself been
  // reviewed. The model is told to wait and ask again, so that is what happens
  // here — and a run that needed no second attempt would mean the preflight
  // never engaged.
  for (let attempt = 1; attempt <= MAX_CONFIRM_ATTEMPTS && !confirmResult?.ok; attempt += 1) {
    const turn = await simulator.turn({
      clientText: attempt === 1
        ? 'Yes, go ahead and run it.'
        : 'Yes, please go ahead.',
      act: async ({ callTool }) => {
        const call = await callTool('confirm_and_run', {});
        confirmResult = call.result;
        return {
          speech: call.result?.ok
            ? String(call.result.speakableText || '')
            : 'Just finishing one last check on my notes — bear with me a moment.'
        };
      }
    });
    await settle(durable, session);
    const lease = await meeting.env.CONSUMER_DB.prepare(`
      SELECT planner_reconciliation_status, planner_reconciled_through_turn_id,
             planner_pending_through_turn_id, latest_profile_revision,
             planner_reconciliation_revision
      FROM consumer_realtime_sessions WHERE id = ? AND session_id = ?
    `).bind(meeting.meetingId, meeting.sessionId).first();
    diagnostics.record('confirmation', {
      attempt, ok: confirmResult?.ok === true, code: confirmResult?.code || null,
      status: confirmResult?.status || null
    });
    line(`confirm attempt ${attempt}   : ok=${confirmResult?.ok} code=${confirmResult?.code || '-'}`
      + ` status=${confirmResult?.status || '-'} (reply ${turn.replyLatencyMs}ms)`);
    line(`  causal turn        : ${turn.itemId}`);
    line(`  lease reconciled   : status=${lease?.planner_reconciliation_status || '-'}`
      + ` through=${lease?.planner_reconciled_through_turn_id || '-'}`
      + ` pending=${lease?.planner_pending_through_turn_id || '-'}`
      + ` latestRev=${lease?.latest_profile_revision} reconRev=${lease?.planner_reconciliation_revision}`);
  }
  if (!confirmResult?.ok) {
    fail(`confirm_and_run never succeeded: ${confirmResult?.code || 'unknown'}`);
  }
}

/* --------------------------------------------------------------- the module */

const finalProfile = await getCurrentProfile(
  meeting.env,
  await getSessionRow(meeting.env, meeting.sessionId)
);
const analysis = await getLatestAnalysis(meeting.env, meeting.sessionId, null);

heading('MODULE EXECUTION');
if (!analysis) {
  fail('no analysis row was written, so no deterministic module ran');
  line('no analysis run recorded');
} else {
  trace.module = {
    runId: analysis.id,
    results: (analysis.results || []).map((result) => ({
      moduleId: result.moduleId,
      status: result.status ?? 'complete',
      calculationVersion: result.calculationVersion,
      output: result
    }))
  };
  line(`analysis run         : ${analysis.id}`);
  for (const result of trace.module.results) {
    line(`  module ${result.moduleId} — status ${result.status}`
      + ` (calc ${result.calculationVersion || 'n/a'})`);
  }
  line();
  line('CANONICAL INPUTS THE MODULE CONSUMED');
  line(JSON.stringify({
    revision: finalProfile.revision,
    primaryPerson: finalProfile.primaryPerson,
    partner: finalProfile.partner,
    pensions: finalProfile.pensions ?? finalProfile.pensionPositions,
    incomes: finalProfile.incomeSources ?? finalProfile.incomes,
    targets: finalProfile.targets
  }, null, 2));
  line();
  line('MODULE OUTPUT');
  line(JSON.stringify(trace.module.results.map((r) => r.output), null, 2).slice(0, 6_000));
  line();
  line(`CLIENT-FACING TEXT: ${confirmResult?.speakableText || '(none)'}`);
}

/* -------------------------------------------------------------- the report */

const rows = await reconciliationRows();
trace.reconciliations = rows;

heading('BACKGROUND PLANNER');
line(`planner model calls  : ${planner.modelCalls()}`);
line(`reconciliation rows  : ${rows.length}`);
for (const row of rows) {
  line(`  trigger=${row.trigger} status=${row.status}`
    + ` base=${row.base_profile_revision} applied=${row.applied_profile_revision ?? '-'}`
    + ` ops=${row.operation_count} accepted=${row.accepted_operation_count}`
    + ` rejected=${row.rejected_operation_count} ${row.latency_ms}ms`);
}
line();
line('outcomes, by reason:');
for (const outcome of reconciliationOutcomes) {
  line(`  ${outcome.trigger} -> ${outcome.status}`
    + ` (validation ${outcome.validationStatus || '-'})`
    + ` base=${outcome.baseRevision} applied=${outcome.appliedProfileRevision ?? '-'}`
    + ` accepted=[${(outcome.accepted || []).join(', ')}]`);
  for (const operationId of outcome.unprojected || []) {
    line(`      ACCEPTED BUT NOT CANONICAL: ${operationId}`);
  }
  for (const rejection of outcome.rejected || []) {
    line(`      REJECTED ${rejection.groupId}: ${rejection.code}`
      + `${rejection.detail ? ` — ${rejection.detail}` : ''}`);
  }
  for (const clarification of outcome.clarifications || []) {
    line(`      CLARIFICATION ${clarification}`);
  }
  if (outcome.errorCode) line(`      THREW ${outcome.errorCode}`);
}

heading('LIVE PATH');
const latencies = trace.turns.map((turn) => turn.replyLatencyMs);
line(`turns                : ${trace.turns.length}`);
line(`max reply latency    : ${Math.max(0, ...latencies)}ms`);
line(`state items pushed   : ${provider.stateItems().length}`);
line(`tool calls dispatched: ${trace.turns.reduce((total, turn) => total + turn.tools.length, 0)}`);

planner.restore();

/**
 * THE MEASURED RUN, as facts about what happened rather than printed prose.
 *
 * The batch aggregates these into k/N. They are computed from canonical state
 * and the reconciler's own rows, never parsed back out of the console, so a
 * change to the printing cannot quietly change a result.
 */
const truth = persona.groundTruth || {};
const finalNeeds = stillNeeded(await projection());
const primaryId = finalProfile.primaryPerson?.personId;
const partnerId = finalProfile.partner?.personId;

// A canonical figure the persona never had, or a position beyond what they
// hold. Both counted per collection from the persona's declared counts.
const falsePositiveFacts = falsePositiveFigures(finalProfile, truth);

// An aggregate that became a holding shows up as an extra position, which is
// exactly the failure the classification rules exist to stop.
const aggregateAsPosition = extraPositions(finalProfile, truth);

const ownershipCorrect = ownershipVerdict(finalProfile, truth);

// A correction that never superseded leaves the WRONG figure canonical. Checked
// against the truth, so a persona that corrects itself must end up correct.
// Every figure the persona corrects, named rather than counted, so a failing
// run says WHICH correction was lost. See scripts/live-harness/metrics.mjs.
// The client's own words, so a figure they never said is not scored as a
// correction they lost.
const clientTranscript = trace.turns.map((turn) => turn.client || '').join('\n');
const supersededNames = supersededFigures(finalProfile, truth, clientTranscript);
const supersessionFailures = supersededNames.length;

const reconciliationSummary = {
  total: reconciliationOutcomes.length,
  applied: reconciliationOutcomes.filter((item) => item.status === 'applied').length,
  conflicted: reconciliationOutcomes.filter((item) => item.status === 'conflicted').length,
  timedOut: reconciliationOutcomes.filter((item) => (
    String(item.errorCode || '').includes('timeout')
  )).length,
  rebased: reconciliationOutcomes.filter((item) => (item.rebasedFromRevisions || []).length > 0).length,
  latencies: reconciliationOutcomes.map((item) => item.latencyMs).filter(Number.isFinite)
};

// Priced by the shared rate table, not by numbers written out here: a second
// copy of the price list is how a cost report quietly goes stale.
const plannerRows = await reconciliationRows();
const plannerTokens = plannerRows.reduce((totals, row) => ({
  input: totals.input + Number(row.input_tokens || 0),
  cached: totals.cached + Number(row.cached_input_tokens || 0),
  output: totals.output + Number(row.output_tokens || 0)
}), { input: 0, cached: 0, output: 0 });
const plannerSpendEur = plannerRows.reduce((total, row) => total + euroCostFor({
  model: row.model,
  inputTokens: Number(row.input_tokens || 0),
  outputTokens: Number(row.output_tokens || 0),
  cachedInputTokens: Number(row.cached_input_tokens || 0)
}), 0);

// THE PERSONA'S MODULE, NOT A HARD-CODED ONE. A successful mortgage run scored
// moduleCompleted=false here because the harness asked whether
// `pension_projection` was in the results, and every criterion downstream of
// that failed with it.
const TARGET_MODULE = persona.targetModule || 'pension_projection';
const targetResult = (analysis?.results || []).find((item) => item.moduleId === TARGET_MODULE);
// NULL WHEN NOTHING RAN. `false` used to mean both "calculated the wrong
// number" and "calculated nothing", so a batch reporting arithmetic 2/5
// could not say whether any client had been given a wrong figure. Those are
// different severities and must not share a value.
// The headline the PERSONA names, so a new module needs a fixture entry rather
// than a branch here. No declared headline means no arithmetic score.
const openingPot = headlineFigure(targetResult, truth.headline);
const moduleArithmeticCorrect = arithmeticVerdict(openingPot, truth.headline?.expected);

// THE EXACT STATE THE MODULE WAS GIVEN, and what the client actually said it
// should be. This is the pair that answers "did a wrong number reach a client".
diagnostics.record('module_input', {
  revision: finalProfile.revision,
  canonical: {
    primaryAge: finalProfile.primaryPerson?.age,
    partnerAge: finalProfile.partner?.age,
    intendedRetirementAge: finalProfile.primaryPerson?.intendedRetirementAge,
    pensions: (finalProfile.pensions || []).map((item) => ({
      id: item.pensionId, owner: item.ownerId, type: item.type,
      value: item.currentValue?.amount, label: item.label,
      employeeRate: item.employeeContributionRate, employerRate: item.employerContributionRate,
      status: item.contributionStatus
    })),
    incomeSources: (finalProfile.incomeSources || []).map((item) => ({
      id: item.incomeId, owner: item.ownerId,
      gross: item.grossAnnual?.amount, net: item.netAnnual?.amount
    })),
    targetRetirementIncome: finalProfile.assumptions?.values?.retirement?.targetIncomeToday
  },
  // The module's own view of its inputs, which is the closest thing to the
  // adapter's output that survives into the stored analysis.
  moduleAssumptions: (analysis?.results || [])
    .find((item) => item.moduleId === 'pension_projection')?.assumptions?.rows || []
});

const measured = {
  persona: persona.id,
  level: persona.level,
  reconciliationMode: RECONCILIATION_MODE,
  modelMode: MODEL_MODE,
  promptVersion: LIVE_PROMPT_VERSION,
  toolsetVersion: LIVE_TOOLSET_VERSION,
  readiness: { before: trace.turns[0]?.stillNeeded?.before || [], after: finalNeeds },
  falsePositiveFacts,
  redundantQuestions: trace.redundantQuestions || 0,
  ownership: { correct: ownershipCorrect, primaryId, partnerId },
  aggregateAsPosition,
  supersessionFailures,
  supersededFigures: supersededNames,
  reconciliation: reconciliationSummary,
  confirmed: confirmResult?.ok === true,
  moduleCompleted: Boolean(targetResult),
  targetModule: TARGET_MODULE,
  moduleArithmeticCorrect,
  spendEur: plannerSpendEur,
  plannerTokens,
  ...trace,
  reconciliationOutcomes,
  canonicalProfile: finalProfile
};

heading('MEASURED');
line(`  readiness after      : ${measured.readiness.after.join(', ') || '(none)'}`);
line(`  ownership correct    : ${measured.ownership.correct === null
  ? 'n/a — the conversation never established a partner'
  : measured.ownership.correct}`);
line(`  false-positive facts : ${measured.falsePositiveFacts}`);
line(`  aggregate-as-position: ${measured.aggregateAsPosition}`);
line(`  supersession failures: ${measured.supersessionFailures}`);
line(`  reconciliations      : ${reconciliationSummary.total} total, `
  + `${reconciliationSummary.applied} applied, ${reconciliationSummary.rebased} rebased, `
  + `${reconciliationSummary.conflicted} conflicted, ${reconciliationSummary.timedOut} timed out`);
line(`  module completed     : ${measured.moduleCompleted} (arithmetic ${measured.moduleArithmeticCorrect})`);
line(`  planner tokens       : ${plannerTokens.input} in (${plannerTokens.cached} cached), ${plannerTokens.output} out`);
line(`  planner spend        : €${plannerSpendEur.toFixed(4)}`);

diagnostics.record('module_output', {
  moduleId: targetResult?.moduleId || null,
  openingPot,
  expectedOpeningPot: truth.headline?.expected ?? null,
  correct: moduleArithmeticCorrect
});

const criteriaFailed = [
  ...(measured.readiness.after.length ? ['module_critical_capture'] : []),
  ...(measured.falsePositiveFacts ? ['no_false_positive_facts'] : []),
  // null means the conversation never established the facts to judge — already
  // reported by module_critical_capture. Listing it here too would tell a
  // reader a holding was in the wrong name.
  ...(measured.ownership.correct === false ? ['ownership_correct'] : []),
  ...(measured.aggregateAsPosition ? ['aggregate_not_position'] : []),
  ...(measured.supersessionFailures ? ['correction_superseded'] : []),
  ...(measured.confirmed ? [] : ['confirmation_succeeded']),
  ...(measured.moduleCompleted ? [] : ['module_executed']),
  // null means no module ran — already reported by module_executed. Listing it
  // here as well would tell a reader a wrong number reached the client.
  ...(measured.moduleArithmeticCorrect === false ? ['module_arithmetic_correct'] : [])
];
const diagnosticsDir = diagnostics.finish({
  ...measured,
  criteriaFailed,
  groundTruth: truth,
  liveLatencies: trace.turns.map((item) => item.replyLatencyMs),
  plannerLatencies: reconciliationSummary.latencies
});
if (diagnosticsDir) line(`\ndiagnostics: ${diagnosticsDir}`);

const tracePath = flag('trace', '');
if (tracePath) {
  writeFileSync(tracePath, JSON.stringify(measured, null, 2));
  line(`\ntrace written to ${tracePath}`);
}

heading(trace.failures.length ? 'FAILURES' : 'RESULT');
if (trace.failures.length) {
  for (const failure of trace.failures) line(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  line('  the full loop completed');
}
