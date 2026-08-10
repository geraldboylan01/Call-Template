// Drive a Planéir call ONE TURN AT A TIME, from a shell.
//
// This is the tool for when YOU are the client. An agent in Claude Code (or a
// person at a terminal) plays someone ringing in, says one thing, reads the
// reply, and decides what to say next — exactly as a real caller would, with no
// script and no second model pretending on your behalf.
//
//   node ./scripts/agent-call.mjs start --caller=callers/mary.md
//   node ./scripts/agent-call.mjs say "I'm 52 and I'd like to retire at 60"
//   node ./scripts/agent-call.mjs finish
//
// The call survives between commands: each one is a separate process, so the
// session lives in a real SQLite database under agent-calls/ and the current
// call id in agent-calls/current.json. Everything is local and disposable.
//
// WHAT IS REAL HERE. The planning engine, the persistence, the routing, the
// module execution and the assistant's actual words — all of it is the shipped
// code, driven exactly as the voice meeting drives it. The only thing standing
// in for a person is you.
//
// OPENAI_API_KEY is required, because the APP needs it: the planner extracts
// facts from what you say and the renderer writes the reply. It is not used to
// simulate a client — that is your job.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectBlockers, detectExecutionBlockers } from './agent-harness/blockers.mjs';
import {
  deterministicFallbackExtraction, mapPlannerExtractionToCandidates
} from '../worker/src/consumer/planning_facts.js';
import { extractSegmentedPlannerTurn } from '../worker/src/consumer/realtime_planner.js';
import { runPlannerReconciliation } from '../worker/src/consumer/planner_reconciliation.js';
import { loadCallerFixture } from './agent-harness/caller.mjs';
import { exportRun, traceIdForCall } from './agent-harness/langfuse-export.mjs';
import {
  archiveCandidates, cloneForArchive, observedCanonicalFacts, observedNeeds, observedQuestion
} from './agent-harness/observability.mjs';
import { AGENT_RUN_ARCHIVE_VERSION, firstGoalTurn } from './agent-harness/runlog.mjs';
import {
  makeConfig, makeEnv, newSession, openCallDatabase, RELEASED_MODULE_IDS
} from './agent-harness/transports.mjs';
import {
  confirmAgentPlan, loadAgentContext, processAgentTurn, toAgentDiagnosticView
} from '../worker/src/consumer/agent_session.js';
import { getLatestAnalysis, getSessionRow } from '../worker/src/consumer/repository.js';
import { listRealtimeFinalTurns } from '../worker/src/consumer/realtime_repository.js';

const CALL_DIR = 'agent-calls';
const POINTER = join(CALL_DIR, 'current.json');

const args = process.argv.slice(2);
const command = args[0];
const flag = (name, fallback = '') => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const positional = args.slice(1).filter((arg) => !arg.startsWith('--'));

const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
// --offline swaps the two paid calls (planner extraction, assistant rendering)
// for the deterministic fallbacks the engine already ships. It exists to check
// the PLUMBING without spending anything. It is NOT the real conversation: the
// regex fallback captures far less than the planner, and the "reply" is the raw
// server-owned question rather than spoken words. Never judge a call from it.
const offline = args.includes('--offline');
// The background planner runs in an agent call exactly as it does in a live
// meeting. Defaults to the same fail-closed legacy the Worker uses, so the
// harness only exercises it when a test deliberately asks it to.
const reconciliationMode = flag('reconciliation', process.env.CONSUMER_PLANNER_RECONCILIATION_MODE || 'legacy');
const langfuseConfigured = Boolean(
  String(process.env.LANGFUSE_PUBLIC_KEY || '').trim()
  && String(process.env.LANGFUSE_SECRET_KEY || '').trim()
);
const langfuseHost = String(process.env.LANGFUSE_HOST || '').trim() || 'https://cloud.langfuse.com';

function usage(message = '') {
  if (message) console.error(`${message}\n`);
  console.error(`Drive a Planéir call one turn at a time.

  start [--caller=<file>] [--id=<name>]   begin a call, print the opening question
  say "<what you said>" [--call=<id>]     one turn; prints the reply and what it captured
  state                                   where the call currently stands
  transcript                              the whole conversation so far
  finish                                  confirm the plan and RUN the analyses
  list                                    calls on this machine

The caller file is optional context for you, not for the app: it is echoed back
so you can stay in character. The app never sees it.`);
  process.exit(message ? 1 : 0);
}

/**
 * Which call a command applies to.
 *
 * `--call=<id>` targets one explicitly, so several calls can run at once --
 * necessary when comparing how the same person fares as an easy, a medium and
 * a difficult caller, where running them one after another would let a fix or
 * a fluke in one bleed into the reading of the next. Without it, the most
 * recently started call is used.
 */
function readPointer() {
  const named = flag('call');
  if (named) {
    const path = join(CALL_DIR, `${named}-pointer.json`);
    if (!existsSync(path)) usage(`No call named "${named}". Start it first.`);
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  if (!existsSync(POINTER)) usage('No call in progress. Run "start" first.');
  return JSON.parse(readFileSync(POINTER, 'utf8'));
}

function openCall(pointer) {
  const env = makeEnv(openCallDatabase(pointer.databasePath), {
    OPENAI_API_KEY: apiKey,
    CONSUMER_PLANNER_RECONCILIATION_MODE: reconciliationMode
  });
  return { env, config: makeConfig(env) };
}

function appendTranscript(pointer, entry) {
  const path = join(CALL_DIR, `${pointer.callId}-transcript.json`);
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  existing.push(entry);
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
  return existing;
}

function readTranscript(pointer) {
  const path = join(CALL_DIR, `${pointer.callId}-transcript.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
}

/** The turn records so far, rebuilt from what we stored, for blocker detection. */
function readTurns(pointer) {
  const path = join(CALL_DIR, `${pointer.callId}-turns.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
}

function writeTurns(pointer, turns) {
  writeFileSync(join(CALL_DIR, `${pointer.callId}-turns.json`), `${JSON.stringify(turns, null, 2)}\n`);
}

function printState(diagnostics, label = 'where the call stands') {
  console.info(`\n--- ${label} ---`);
  console.info(`goals      : [${(diagnostics.goals?.active || []).join(', ')}]`);
  console.info(`primary    : ${diagnostics.goals?.primary ?? 'none'}`);
  console.info(`analyses   : [${(diagnostics.analyses || []).map((item) => item.moduleId).join(', ')}]`);
  console.info(`facts held : ${(diagnostics.facts || []).length}`);
  console.info(`next asks  : ${diagnostics.pendingQuestion?.factId ?? 'nothing'}`);
  if ((diagnostics.stillNeeded || []).length) {
    console.info(`still needs: ${diagnostics.stillNeeded.map((item) => item.factId).join(', ')}`);
  }
}

function printBlockers(findings, label = 'blockers') {
  if (!findings.length) return;
  console.info(`\n--- ${label} ---`);
  for (const finding of findings) {
    console.info(`[${finding.severity}] turn ${finding.turn}: ${finding.detail}`);
  }
}

function aggregatePlannerUsage(turns) {
  const rows = turns
    .map((turn) => turn?.observation?.extraction?.metadata)
    .filter(Boolean);
  const latenciesMs = rows.map((row) => Number(row.latencyMs)).filter(Number.isFinite);
  return {
    model: [...rows].reverse().find((row) => row.model)?.model || null,
    calls: rows.filter((row) => row.model && row.model !== 'deterministic_fallback').length,
    inputTokens: rows.reduce((sum, row) => sum + Number(row.inputTokens || 0), 0),
    outputTokens: rows.reduce((sum, row) => sum + Number(row.outputTokens || 0), 0),
    cachedInputTokens: rows.reduce((sum, row) => sum + Number(row.cachedInputTokens || 0), 0),
    latenciesMs,
    latencyMs: latenciesMs.reduce((sum, value) => sum + value, 0)
  };
}

if (!command || ['-h', '--help', 'help'].includes(command)) usage();
// Only SAY costs money: it is the one command that calls the planner and the
// renderer. Starting a call, reading state, printing the transcript and running
// the analyses are all local and deterministic, and demanding a key for them
// just gets in the way.
if (!apiKey && !offline && command === 'say') {
  usage('OPENAI_API_KEY is required to speak — the app needs it to plan and to reply.\n'
    + 'Add --offline to check the plumbing without it (deterministic, not a real conversation).');
}

/* ---------------------------------------------------------------- start */

if (command === 'start') {
  mkdirSync(CALL_DIR, { recursive: true });
  const callId = flag('id') || `call-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '')}`;
  const callerPath = flag('caller');
  let caller = null;
  let fixture = null;
  if (callerPath) {
    try {
      ({ caller, fixture } = loadCallerFixture(callerPath));
    } catch (error) {
      usage(`Could not read ${callerPath}: ${error.message}`);
    }
  }

  const databasePath = join(CALL_DIR, `${callId}.sqlite`);
  const env = makeEnv(openCallDatabase(databasePath), {
    OPENAI_API_KEY: apiKey,
    CONSUMER_PLANNER_RECONCILIATION_MODE: reconciliationMode
  });
  const config = makeConfig(env);
  const { sessionId, meetingId } = await newSession(env, config);

  const pointer = {
    callId, databasePath, sessionId, meetingId, callerPath: callerPath || null, fixture
  };
  writeFileSync(POINTER, `${JSON.stringify(pointer, null, 2)}\n`);
  writeFileSync(join(CALL_DIR, `${callId}-pointer.json`), `${JSON.stringify(pointer, null, 2)}\n`);
  writeFileSync(join(CALL_DIR, `${callId}-transcript.json`), '[]\n');
  writeTurns(pointer, []);

  console.info(`Call ${callId} started.`);
  console.info(`Released analyses: ${RELEASED_MODULE_IDS}`);
  if (caller) {
    // Echoed for YOUR benefit. The app is told none of this — it has to find
    // it out by asking, which is the whole point of the exercise.
    console.info(`\n--- you are playing (the app cannot see this) ---\n${caller.client.brief}`);
    if (caller.client.questions?.length) {
      console.info(`\nthings you want to ask:\n${caller.client.questions.map((q) => `  - ${q}`).join('\n')}`);
    }
    if (caller.client.behaviours?.length) {
      console.info(`\nhow you behave:\n${caller.client.behaviours.map((b) => `  - ${b}`).join('\n')}`);
    }
  }
  console.info('\nThe meeting is waiting for you to speak first.');
  console.info(`Next: node ./scripts/agent-call.mjs say "..."`);
}

/* ------------------------------------------------------------------ say */

if (command === 'say') {
  const message = positional.join(' ').trim();
  if (!message) usage('Say something: agent-call.mjs say "I am 52 and hoping to retire at 60"');
  const pointer = readPointer();
  const { env, config } = openCall(pointer);
  const beforeContext = await loadAgentContext(env, config, pointer.sessionId, pointer.meetingId);
  let rawExtraction = null;
  let plannerMetadata = null;

  const observedExtractTurn = async (options) => {
    if (offline) {
      rawExtraction = deterministicFallbackExtraction({
        transcript: options.transcript,
        profile: options.context.profile,
        sourceTurnId: options.sourceTurnId
      });
      plannerMetadata = { model: 'deterministic_fallback', latencyMs: 0 };
      return { extraction: rawExtraction, metadata: { ...plannerMetadata, costMicroEur: 0 } };
    }
    const planned = await extractSegmentedPlannerTurn(options);
    rawExtraction = planned.extraction;
    plannerMetadata = planned.metadata || null;
    return planned;
  };

  let result;
  try {
    result = await processAgentTurn(env, config, {
      sessionId: pointer.sessionId,
      meetingId: pointer.meetingId,
      message,
      deps: {
        extractTurn: observedExtractTurn,
        ...(offline ? {
        renderText: async ({ context }) => ({
          text: context.state.meetingBrief?.questionBatch?.prompt || '(no question)',
          fallback: false, decisions: [], usageMicroEur: 0, context
        })
        } : {})
      }
    });
  } catch (error) {
    console.error(`\nThe turn failed: ${error?.code || error?.message}`);
    console.error('This is itself a finding — a real caller would have hit the same wall.');
    process.exit(1);
  }

  let afterContext = await loadAgentContext(env, config, pointer.sessionId, pointer.meetingId);
  const storedTurns = await listRealtimeFinalTurns(env, pointer.sessionId, pointer.meetingId, 200);
  const clientRowIndex = storedTurns.findIndex((item) => item.id === result.consumer.turnId);
  const assistantRow = storedTurns.slice(Math.max(0, clientRowIndex + 1))
    .find((item) => item.role === 'assistant');
  const clientTranscript = {
    id: result.consumer.turnId,
    role: 'client',
    text: message,
    createdAt: storedTurns[clientRowIndex]?.createdAt || null
  };
  const assistantTranscript = {
    id: assistantRow?.id || null,
    role: 'assistant',
    text: result.consumer.assistantMessage,
    createdAt: assistantRow?.createdAt || null
  };
  appendTranscript(pointer, clientTranscript);
  appendTranscript(pointer, assistantTranscript);

  const diagnostics = result.diagnostics;
  const turns = readTurns(pointer);
  let mappedCandidates = [];
  if (rawExtraction) {
    try {
      mappedCandidates = mapPlannerExtractionToCandidates(rawExtraction);
    } catch (_error) {
      // The raw extraction and deterministic rejection still remain visible.
    }
  }
  // THE BACKGROUND PLANNER RUNS HERE TOO, OR THIS HARNESS TESTS THE OLD SYSTEM.
  //
  // In a live meeting the reconciler is fired from the Durable Object after the
  // turn settles. Nothing fired it here, so an agent call exercised T1 and the
  // shared planning core and stopped — which meant the architecture actually
  // under development could not be tested through the workflow used to test it.
  // The cadence mirrors live_session: a turn that wrote or rejected a note, and
  // a periodic checkpoint, rather than every turn.
  let reconciliation = null;
  if (config.plannerReconciliationMode !== 'legacy') {
    const noteActivity = (diagnostics.candidateOutcomes || []).length > 0;
    const periodic = turns.length > 0 && (turns.length + 1) % 3 === 0;
    if (noteActivity || periodic) {
      const startedAt = Date.now();
      try {
        const outcome = await runPlannerReconciliation({
          env,
          config,
          context: await loadAgentContext(env, config, pointer.sessionId, pointer.meetingId),
          leaseId: pointer.meetingId,
          throughTurnId: clientTranscript.id,
          trigger: noteActivity ? 'material_turn' : 'periodic_checkpoint'
        });
        reconciliation = {
          status: outcome.status,
          appliedProfileRevision: outcome.appliedProfileRevision ?? null,
          acceptedOperationIds: outcome.validation?.acceptedOperationIds || [],
          rejectedGroups: (outcome.validation?.rejectedGroups || [])
            .map((group) => ({ groupId: group.groupId, code: group.code })),
          operationOutcomes: outcome.validation?.operationOutcomes || [],
          clarificationNeeds: (outcome.validation?.clarificationNeeds || [])
            .map((need) => ({ factInstanceId: need.factInstanceId, prompt: need.prompt })),
          insertedNoteCount: outcome.insertedNoteCount ?? 0,
          transitionedNoteCount: outcome.transitionedNoteCount ?? 0,
          usage: outcome.metadata || null,
          latencyMs: Date.now() - startedAt
        };
      } catch (error) {
        // A reconciler failure is a finding, never a dead call: the live lane
        // treats it the same way and the meeting carries on.
        reconciliation = {
          status: 'failed',
          errorCode: String(error?.code || 'planner_reconciliation_failed'),
          errorDetail: String(error?.message || '').slice(0, 400),
          latencyMs: Date.now() - startedAt
        };
      }
      // The corrections change what is still outstanding, so everything the
      // archive records below must be read after them, exactly as the live
      // meeting re-reads its state before the next question.
      afterContext = await loadAgentContext(env, config, pointer.sessionId, pointer.meetingId);
    }
  }
  const candidateObservations = archiveCandidates({
    candidates: mappedCandidates,
    invalidCandidates: rawExtraction?.invalidCandidates || [],
    outcomes: diagnostics.candidateOutcomes || [],
    profile: afterContext.profile,
    askedQuestion: observedQuestion(beforeContext)
  });
  const question = observedQuestion(afterContext);
  const previousSpend = Number(turns.at(-1)?.observation?.spendMicroEur?.cumulative || 0);
  const cumulativeSpend = Number(result.usage?.spendMicroEur || 0);
  turns.push({
    transcript: message,
    clientTurnId: clientTranscript.id,
    assistantTurnId: assistantTranscript.id,
    plannerErrorCode: diagnostics.plannerErrorCode ?? null,
    degraded: diagnostics.degraded === true,
    acceptedFactIds: (diagnostics.candidateOutcomes || []).filter((o) => o.accepted).map((o) => o.factId),
    rejectedFactIds: (diagnostics.candidateOutcomes || []).filter((o) => !o.accepted).map((o) => o.factId),
    acceptedFactInstanceIds: candidateObservations
      .filter((item) => item.accepted && item.factInstanceId)
      .map((item) => item.factInstanceId),
    rejectedFactInstances: candidateObservations
      .filter((item) => item.accepted === false)
      .map((item) => ({
        factId: item.factId,
        factInstanceId: item.factInstanceId,
        entityId: item.entityId,
        ownerId: item.ownerId,
        rejectionCode: item.rejectionCode
      })),
    goals: [...(diagnostics.goals?.active || [])],
    analyses: (diagnostics.analyses || []).map((item) => item.moduleId),
    // A blocked analysis stays selected and visible rather than disappearing,
    // so "is it still on the plan" and "can it actually run" are now two
    // different questions and the scorecard has to be able to tell them apart.
    analysisAvailability: Object.fromEntries((diagnostics.analyses || [])
      .filter((item) => item.moduleId)
      .map((item) => [item.moduleId, item.availability ?? item.intakeStatus ?? null])),
    factIds: (diagnostics.facts || []).map((item) => item.factId),
    questionFactId: diagnostics.pendingQuestion?.factId ?? null,
    questionFactInstanceId: question?.factInstanceId || null,
    observation: {
      schemaVersion: 'consumer-agent-turn-observation-v1',
      transcript: { client: clientTranscript, assistant: assistantTranscript },
      profiles: {
        beforeRevision: Number(beforeContext.sessionRow.current_profile_revision),
        before: cloneForArchive(beforeContext.profile),
        afterRevision: Number(afterContext.sessionRow.current_profile_revision),
        after: cloneForArchive(afterContext.profile)
      },
      extraction: {
        raw: cloneForArchive(rawExtraction),
        candidates: candidateObservations,
        metadata: cloneForArchive(plannerMetadata),
        plannerErrorCode: diagnostics.plannerErrorCode || null,
        degraded: diagnostics.degraded === true,
        repairedCount: Number(diagnostics.repairedCount || 0),
        repairAttemptFailed: diagnostics.repairAttemptFailed === true,
        segmentsFailed: Number(diagnostics.segmentsFailed || 0)
      },
      question,
      // What the background planner did with this turn, so a failure can be
      // traced to the layer that caused it rather than inferred from the reply.
      reconciliation,
      needsAfter: observedNeeds(afterContext),
      canonicalFactsAfter: observedCanonicalFacts(afterContext),
      spendMicroEur: {
        turn: Math.max(0, cumulativeSpend - previousSpend),
        cumulative: cumulativeSpend
      }
    }
  });
  writeTurns(pointer, turns);

  if (offline) console.info('\n[offline: deterministic fallback, not the real conversation]');
  console.info(`\nPLANÉIR: ${result.consumer.assistantMessage}`);

  const captured = turns.at(-1).acceptedFactIds;
  const rejected = turns.at(-1).rejectedFactIds;
  if (captured.length) console.info(`\ncaptured  : ${captured.join(', ')}`);
  if (rejected.length) {
    // WHY it was rejected is the whole finding. "NOT saved: pension_current_value"
    // tells you nothing you can act on; the error code tells you where to look.
    console.info('NOT saved :');
    for (const outcome of (diagnostics.candidateOutcomes || []).filter((item) => !item.accepted)) {
      console.info(`  ${outcome.factId || '(no factId)'} — ${outcome.errorCode || outcome.reason || 'no reason given'}`);
    }
  }
  if (diagnostics.plannerErrorCode) console.info(`planner   : ${diagnostics.plannerErrorCode}`);
  printState(diagnostics);
  // Only findings that are new this turn, so the same loop is not re-reported
  // every turn once it starts.
  const before = detectBlockers(turns.slice(0, -1)).map((item) => `${item.id}:${item.detail}`);
  printBlockers(
    detectBlockers(turns).filter((item) => !before.includes(`${item.id}:${item.detail}`)),
    'new this turn'
  );
}

/* -------------------------------------------------------- state/transcript */

if (command === 'state') {
  const pointer = readPointer();
  const { env, config } = openCall(pointer);
  const context = await loadAgentContext(env, config, pointer.sessionId, pointer.meetingId);
  printState(toAgentDiagnosticView(context), `call ${pointer.callId}`);
  printBlockers(detectBlockers(readTurns(pointer)), 'everything found so far');
}

if (command === 'transcript') {
  const pointer = readPointer();
  for (const entry of readTranscript(pointer)) {
    console.info(`${entry.role === 'client' ? 'YOU     ' : 'PLANÉIR '} ${entry.text}`);
  }
}

if (command === 'list') {
  if (!existsSync(CALL_DIR)) {
    console.info('No calls yet.');
  } else {
    const current = existsSync(POINTER) ? JSON.parse(readFileSync(POINTER, 'utf8')).callId : null;
    for (const name of readdirSync(CALL_DIR)) {
      if (!name.endsWith('.sqlite')) continue;
      const id = name.replace(/\.sqlite$/, '');
      console.info(`${id === current ? '* ' : '  '}${id}`);
    }
  }
}

/* --------------------------------------------------------------- finish */

if (command === 'finish') {
  const pointer = readPointer();
  const { env, config } = openCall(pointer);

  console.info('Confirming the plan and running the analyses...\n');
  let confirmed;
  try {
    confirmed = await confirmAgentPlan(env, config, {
      sessionId: pointer.sessionId,
      meetingId: pointer.meetingId
    });
  } catch (error) {
    const code = error?.code || String(error?.message || error);
    console.info(`The plan would not run: ${code}`);
    if (code === 'goal_priority_required') {
      console.info('The meeting still needs to know which goal matters most. Answer that, then finish again.');
    } else if (code === 'analysis_plan_empty') {
      console.info('No released analysis matches this caller\'s goals. That is a routing finding.');
    }
    process.exit(1);
  }

  const execution = confirmed.execution;
  console.info(`status   : ${execution.status}`);
  console.info(`selected : ${execution.moduleIds.join(', ') || 'none'}`);
  console.info(`completed: ${execution.completedModuleIds.join(', ') || 'none'}`);
  if (execution.gatedModuleIds.length) console.info(`gated    : ${execution.gatedModuleIds.join(', ')}`);

  if (execution.requiredQuestions?.length) {
    console.info('\n--- what the analyses were still short of ---');
    for (const missing of execution.requiredQuestions) {
      console.info(`${missing.moduleIds.join(', ') || 'an analysis'} needed `
        + `${missing.factId || missing.fieldPath}${missing.reason ? ` — ${missing.reason}` : ''}`);
    }
    console.info('\nThe final blocker report distinguishes never asked, unanswered, unknown, rejected and unused inputs.');
  }

  const sessionRow = await getSessionRow(env, pointer.sessionId);
  const stored = await getLatestAnalysis(env, pointer.sessionId, null);
  const results = stored?.results || [];
  if (results.length) {
    console.info('\n--- what the analyses produced ---');
    for (const item of results) {
      console.info(`\n## ${item.moduleId}`);
      console.info(JSON.stringify(item, null, 2).slice(0, 4_000));
    }
  }

  const outPath = join(CALL_DIR, `${pointer.callId}-result.json`);
  const turns = readTurns(pointer);
  const transcript = readTranscript(pointer);
  const blockers = [
    ...detectBlockers(turns),
    ...detectExecutionBlockers(
      { ...execution, missingForModules: execution.requiredQuestions || [], results },
      turns.length,
      turns
    )
  ];
  const traceId = traceIdForCall(pointer.callId, pointer.callId);
  const traceUrl = langfuseConfigured
    ? `${langfuseHost.replace(/\/$/, '')}/trace/${traceId}`
    : null;
  const resultRecord = {
    schemaVersion: 'consumer-agent-call-result-v2',
    callId: pointer.callId,
    callerPath: pointer.callerPath,
    fixture: pointer.fixture || null,
    synthetic: true,
    contentPolicy: 'synthetic_test_content',
    firstGoalTurn: firstGoalTurn(turns),
    profileRevision: Number(sessionRow?.current_profile_revision ?? 0),
    execution,
    results,
    transcript,
    turnRecords: turns,
    usage: { planner: aggregatePlannerUsage(turns) },
    langfuse: { traceId, traceUrl },
    blockers
  };
  writeFileSync(outPath, `${JSON.stringify(resultRecord, null, 2)}\n`);

  // The file above is authoritative and already complete before this optional
  // network export begins. Telemetry failure never changes the result or exit.
  const langfuseExport = await exportRun({
    schemaVersion: AGENT_RUN_ARCHIVE_VERSION,
    runId: pointer.callId,
    runKey: `interactive-agent-call planner=${config.realtimePlannerModel || 'none'}`,
    generatedAt: new Date().toISOString(),
    calls: [{
      ...resultRecord,
      caller: pointer.callId,
      turns: turns.length,
      goals: turns.at(-1)?.goals || [],
      analyses: turns.at(-1)?.analyses || [],
      factIds: turns.at(-1)?.factIds || [],
      execution: {
        ...execution,
        missingForModules: execution.requiredQuestions || [],
        results
      },
      error: null
    }]
  }).catch(() => ({ enabled: langfuseConfigured, delivered: 0, failures: 1 }));
  console.info(`\nWritten to ${outPath} — this is the file to grade.`);
  if (langfuseExport.enabled) {
    console.info(`Langfuse: ${langfuseExport.delivered} delivered, ${langfuseExport.failures} failed`);
    console.info(`Trace: ${traceUrl}`);
  }
}

if (!['start', 'say', 'state', 'transcript', 'finish', 'list'].includes(command)) {
  usage(`Unknown command "${command}".`);
}
