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
import { deterministicFallbackExtraction } from '../worker/src/consumer/planning_facts.js';
import { loadCaller } from './agent-harness/caller.mjs';
import {
  makeConfig, makeEnv, newSession, openCallDatabase, RELEASED_MODULE_IDS
} from './agent-harness/transports.mjs';
import {
  confirmAgentPlan, loadAgentContext, processAgentTurn, toAgentDiagnosticView
} from '../worker/src/consumer/agent_session.js';
import { getLatestAnalysis, getSessionRow } from '../worker/src/consumer/repository.js';

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

function usage(message = '') {
  if (message) console.error(`${message}\n`);
  console.error(`Drive a Planéir call one turn at a time.

  start [--caller=<file>] [--id=<name>]   begin a call, print the opening question
  say "<what you said>"                   one turn; prints the reply and what it captured
  state                                   where the call currently stands
  transcript                              the whole conversation so far
  finish                                  confirm the plan and RUN the analyses
  list                                    calls on this machine

The caller file is optional context for you, not for the app: it is echoed back
so you can stay in character. The app never sees it.`);
  process.exit(message ? 1 : 0);
}

function readPointer() {
  if (!existsSync(POINTER)) usage('No call in progress. Run "start" first.');
  return JSON.parse(readFileSync(POINTER, 'utf8'));
}

function openCall(pointer) {
  const env = makeEnv(openCallDatabase(pointer.databasePath), { OPENAI_API_KEY: apiKey });
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
  if (callerPath) {
    try {
      caller = loadCaller(callerPath);
    } catch (error) {
      usage(`Could not read ${callerPath}: ${error.message}`);
    }
  }

  const databasePath = join(CALL_DIR, `${callId}.sqlite`);
  const env = makeEnv(openCallDatabase(databasePath), { OPENAI_API_KEY: apiKey });
  const config = makeConfig(env);
  const { sessionId, meetingId } = await newSession(env, config);

  const pointer = { callId, databasePath, sessionId, meetingId, callerPath: callerPath || null };
  writeFileSync(POINTER, `${JSON.stringify(pointer, null, 2)}\n`);
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

  let result;
  try {
    result = await processAgentTurn(env, config, {
      sessionId: pointer.sessionId,
      meetingId: pointer.meetingId,
      message,
      ...(offline ? { deps: {
        extractTurn: async ({ sourceTurnId, transcript: text, context }) => ({
          extraction: deterministicFallbackExtraction({
            transcript: text, profile: context.profile, sourceTurnId
          }),
          metadata: { costMicroEur: 0 }
        }),
        renderText: async ({ context }) => ({
          text: context.state.meetingBrief?.questionBatch?.prompt || '(no question)',
          fallback: false, decisions: [], usageMicroEur: 0, context
        })
      } } : {})
    });
  } catch (error) {
    console.error(`\nThe turn failed: ${error?.code || error?.message}`);
    console.error('This is itself a finding — a real caller would have hit the same wall.');
    process.exit(1);
  }

  appendTranscript(pointer, { role: 'client', text: message });
  appendTranscript(pointer, { role: 'assistant', text: result.consumer.assistantMessage });

  const diagnostics = result.diagnostics;
  const turns = readTurns(pointer);
  turns.push({
    transcript: message,
    plannerErrorCode: diagnostics.plannerErrorCode ?? null,
    degraded: diagnostics.degraded === true,
    acceptedFactIds: (diagnostics.candidateOutcomes || []).filter((o) => o.accepted).map((o) => o.factId),
    rejectedFactIds: (diagnostics.candidateOutcomes || []).filter((o) => !o.accepted).map((o) => o.factId),
    goals: [...(diagnostics.goals?.active || [])],
    analyses: (diagnostics.analyses || []).map((item) => item.moduleId),
    factIds: (diagnostics.facts || []).map((item) => item.factId),
    questionFactId: diagnostics.pendingQuestion?.factId ?? null
  });
  writeTurns(pointer, turns);

  if (offline) console.info('\n[offline: deterministic fallback, not the real conversation]');
  console.info(`\nPLANÉIR: ${result.consumer.assistantMessage}`);

  const captured = turns.at(-1).acceptedFactIds;
  const rejected = turns.at(-1).rejectedFactIds;
  if (captured.length) console.info(`\ncaptured  : ${captured.join(', ')}`);
  if (rejected.length) console.info(`NOT saved : ${rejected.join(', ')}   <-- worth a look`);
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
    console.info('\nThe call never asked for these. That is the finding.');
  }

  const sessionRow = await getSessionRow(env, pointer.sessionId);
  const stored = await getLatestAnalysis(env, pointer.sessionId, null);
  const results = stored?.payload?.results || [];
  if (results.length) {
    console.info('\n--- what the analyses produced ---');
    for (const item of results) {
      console.info(`\n## ${item.moduleId}`);
      console.info(JSON.stringify(item, null, 2).slice(0, 4_000));
    }
  }

  const outPath = join(CALL_DIR, `${pointer.callId}-result.json`);
  writeFileSync(outPath, `${JSON.stringify({
    callId: pointer.callId,
    callerPath: pointer.callerPath,
    profileRevision: Number(sessionRow?.current_profile_revision ?? 0),
    execution,
    results,
    transcript: readTranscript(pointer),
    blockers: [
      ...detectBlockers(readTurns(pointer)),
      ...detectExecutionBlockers(
        { ...execution, missingForModules: execution.requiredQuestions || [], results },
        readTurns(pointer).length
      )
    ]
  }, null, 2)}\n`);
  console.info(`\nWritten to ${outPath} — this is the file to grade.`);
}

if (!['start', 'say', 'state', 'transcript', 'finish', 'list'].includes(command)) {
  usage(`Unknown command "${command}".`);
}
