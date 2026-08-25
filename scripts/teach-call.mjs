// Apprentice mode — YOU are the adviser, a model is the client, the app watches.
//
// The two runners that already exist both cast the APP as the adviser and grade
// it afterwards: agent-call.mjs has you play the client, and
// run-consumer-agent-call.mjs has a model play the client. Neither captures a
// BETTER trajectory to learn from. This one does.
//
//   node ./scripts/teach-call.mjs start --caller=callers/mary.md --id=mary1
//   node ./scripts/teach-call.mjs client "I'm 52 and I'd like to go part-time"
//   node ./scripts/teach-call.mjs say    "Before that — what's Tom's pension?"
//   node ./scripts/teach-call.mjs finish
//
// Two speakers, two commands. `client` buffers what the person said; `say`
// commits the turn with YOUR reply as the adviser. One turn, one transaction:
// the planner extracts from the client's words and your words are what the
// meeting recorded as the answer, so the profile advances on YOUR trajectory
// and the client responds to YOU. That is the whole point — the app is shown
// the right move in states a good adviser reaches, not just how to recover
// from its own mistakes.
//
// THE BASELINE IS NEVER PRINTED DURING THE CALL. What the app would have said
// is written to disk and shown only in the bundle, after `finish`. This is the
// same rule the grading sheet already follows for the judge's score
// (agent-harness/grading.mjs): a demonstration anchored to the baseline cannot
// be used to check the baseline.
//
// WHAT THIS COSTS. One planner extraction per client turn — the single metered
// call, and it stays because the baseline has to be the REAL system's decision;
// substituting for it would mean teaching against a stand-in. Your own turns
// cost nothing. --shadow=full adds one renderer call per turn, run against a
// throwaway clone of the database so its tool calls cannot mutate the meeting.
// --offline swaps the extraction for the deterministic fallback: good for
// checking the plumbing, never evidence of anything.
//
// NOTHING HERE INTERPRETS THE CALL. Divergences are mechanical. What they mean
// is decided later by Claude Code or Codex reading the bundle, and then by you.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectBlockers, detectExecutionBlockers } from './agent-harness/blockers.mjs';
import { deterministicFallbackExtraction } from '../worker/src/consumer/planning_facts.js';
import { extractSegmentedPlannerTurn } from '../worker/src/consumer/realtime_planner.js';
import { loadCallerFixture } from './agent-harness/caller.mjs';
import { observedCanonicalFacts } from './agent-harness/observability.mjs';
import {
  deterministicShadow, divergencesFor, rendererShadow, summariseDivergences
} from './agent-harness/shadow.mjs';
import { writeTeachingBundle } from './agent-harness/bundle.mjs';
import { sanitizeScenarioOverrides } from '../js/planning/scenario_levers.js';
import {
  cloneCallDatabaseForReconciliation, makeConfig, makeEnv, newSession, openCallDatabase,
  RELEASED_MODULE_IDS
} from './agent-harness/transports.mjs';
import {
  confirmAgentPlan, loadAgentContext, processAgentTurn
} from '../worker/src/consumer/agent_session.js';
import { renderAssistantText } from '../worker/src/consumer/agent_text_channel.js';
import { getLatestAnalysis, getSessionRow } from '../worker/src/consumer/repository.js';
import { resolveConfirmationCandidateModuleIds } from '../worker/src/consumer/planning_context.js';

const ROOT = 'teaching/pending';

const args = process.argv.slice(2);
const command = args[0];
const flag = (name, fallback = '') => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const positional = args.slice(1).filter((arg) => !arg.startsWith('--'));

const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
const offline = args.includes('--offline');
const shadowTier = flag('shadow', 'deterministic');
if (!['deterministic', 'full'].includes(shadowTier)) {
  console.error(`--shadow must be "deterministic" or "full", not "${shadowTier}"`);
  process.exit(1);
}
const reconciliationMode = flag(
  'reconciliation', process.env.CONSUMER_PLANNER_RECONCILIATION_MODE || 'legacy'
);

function usage(message = '') {
  if (message) console.error(`${message}\n`);
  console.error(`Teach Planéir by advising a call yourself.

  start [--caller=<file>] [--id=<name>]  begin a teaching case
  client "<what the person said>"        the client speaks (buffered)
  say "<what you said back>"             your reply — commits the turn
  state                                  where the call stands
  transcript                             the conversation so far
  finish                                 run the analyses and write the bundle
  list                                   teaching cases on this machine

Inside "say" you may lead with one of:
  /run <module> [lever=value ...]        run an analysis on these assumptions
  /note <why you did that>               the most valuable thing you can leave
  /fix <what the app got wrong>          correct what it heard

  --shadow=deterministic|full  (default deterministic; "full" adds a paid renderer call)
  --offline                    deterministic extraction — plumbing only, not evidence`);
  process.exit(message ? 1 : 0);
}

/* ------------------------------------------------------------- case files */

const casePath = (caseId, name) => join(ROOT, caseId, name);
const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function readCase() {
  const named = flag('case');
  if (named) {
    const path = casePath(named, 'case.json');
    if (!existsSync(path)) usage(`No teaching case named "${named}".`);
    return readJson(path, null);
  }
  const pointer = join(ROOT, 'current.json');
  if (!existsSync(pointer)) usage('No teaching case in progress. Run "start" first.');
  return readJson(join(ROOT, readJson(pointer, {}).caseId, 'case.json'), null);
}

function openCase(record) {
  const env = makeEnv(openCallDatabase(record.databasePath), {
    OPENAI_API_KEY: apiKey,
    CONSUMER_PLANNER_RECONCILIATION_MODE: reconciliationMode
  });
  return { env, config: makeConfig(env) };
}

/**
 * What the adviser typed, split into a spoken line and any commands.
 *
 * Commands lead the line rather than being flags, because a person mid-call
 * should not have to think about argument order. Everything that is not a
 * recognised command is speech, verbatim.
 */
export function parseAdviserTurn(raw) {
  const lines = String(raw ?? '').split('\n');
  const runs = [];
  const fixes = [];
  const notes = [];
  const spoken = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const run = trimmed.match(/^\/run\s+([a-z0-9_]+)\s*(.*)$/i);
    if (run) {
      const scenarioOverrides = {};
      for (const pair of run[2].split(/\s+/).filter(Boolean)) {
        const [key, ...rest] = pair.split('=');
        if (!key || rest.length === 0) continue;
        const value = rest.join('=');
        const numeric = Number(value);
        scenarioOverrides[key] = Number.isFinite(numeric) && value.trim() !== '' ? numeric : value;
      }
      runs.push({ moduleId: run[1].toLowerCase(), scenarioOverrides });
      continue;
    }
    const note = trimmed.match(/^\/note\s+(.+)$/i);
    if (note) { notes.push(note[1]); continue; }
    const fix = trimmed.match(/^\/fix\s+(.+)$/i);
    if (fix) { fixes.push(fix[1]); continue; }
    spoken.push(line);
  }
  return {
    said: spoken.join('\n').trim() || null,
    runs,
    fixes,
    note: notes.join(' ').trim() || null
  };
}

/* -------------------------------------------------------------- commands */

// Importable without running, so check-teaching-harness.mjs can assert
// parseAdviserTurn without the CLI firing on import.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('teach-call.mjs');
if (invokedDirectly) {

if (!command || ['-h', '--help', 'help'].includes(command)) usage();
if (!apiKey && !offline && command === 'say') {
  usage('OPENAI_API_KEY is required to commit a turn — the app needs it to extract facts.\n'
    + 'Add --offline to check the plumbing without it (not a real call).');
}

if (command === 'list') {
  if (!existsSync(ROOT)) { console.info('No teaching cases yet.'); process.exit(0); }
  for (const entry of readdirSync(ROOT, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const record = readJson(casePath(entry.name, 'case.json'), null);
    const turns = readJson(casePath(entry.name, 'turns.json'), []);
    if (record) console.info(`${entry.name}  ${turns.length} turn(s)  caller=${record.callerPath || 'none'}`);
  }
  process.exit(0);
}

if (command === 'start') {
  const caseId = flag('id') || `teach-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '')}`;
  mkdirSync(join(ROOT, caseId), { recursive: true });
  const callerPath = flag('caller');
  let caller = null;
  let fixture = null;
  if (callerPath) {
    try { ({ caller, fixture } = loadCallerFixture(callerPath)); }
    catch (error) { usage(`Could not read ${callerPath}: ${error.message}`); }
  }

  const databasePath = casePath(caseId, `${caseId}.sqlite`);
  const env = makeEnv(openCallDatabase(databasePath), {
    OPENAI_API_KEY: apiKey,
    CONSUMER_PLANNER_RECONCILIATION_MODE: reconciliationMode
  });
  const config = makeConfig(env);
  const { sessionId, meetingId } = await newSession(env, config);

  const record = {
    schemaVersion: 'planeir-teaching-case-v1',
    caseId,
    databasePath,
    sessionId,
    meetingId,
    callerPath: callerPath || null,
    fixture,
    shadowTier,
    offline,
    startedAt: new Date().toISOString()
  };
  writeJson(casePath(caseId, 'case.json'), record);
  writeJson(join(ROOT, 'current.json'), { caseId });
  writeJson(casePath(caseId, 'transcript.json'), []);
  writeJson(casePath(caseId, 'turns.json'), []);

  console.info(`Teaching case ${caseId} started.`);
  console.info(`Released analyses: ${RELEASED_MODULE_IDS}`);
  console.info(`Shadow tier: ${shadowTier}${offline ? ' · offline (plumbing only)' : ''}`);
  if (caller) {
    // For whoever is PLAYING THE CLIENT — a Claude Code subagent, or a person.
    // They get the brief and the client-visible conversation and nothing else:
    // no planning state, no module ids, no shadow. Same separation the existing
    // simulated client keeps (scripts/agent-clients/openai.mjs).
    console.info(`\n--- the person being played (the app cannot see this) ---\n${caller.client.brief}`);
    if (caller.client.questions?.length) {
      console.info(`\nthings they want to ask:\n${caller.client.questions.map((q) => `  - ${q}`).join('\n')}`);
    }
    if (caller.client.behaviours?.length) {
      console.info(`\nhow they behave:\n${caller.client.behaviours.map((b) => `  - ${b}`).join('\n')}`);
    }
  }
  console.info('\nThe client speaks first.');
  console.info(`Next: node ./scripts/teach-call.mjs client "..."`);
  process.exit(0);
}

if (command === 'client') {
  const said = positional.join(' ').trim();
  if (!said) usage('What did the client say? teach-call.mjs client "I am 52 and hoping to retire at 60"');
  const record = readCase();
  const pendingPath = casePath(record.caseId, 'pending-client.json');
  if (existsSync(pendingPath)) {
    usage('The client already spoke and is waiting for your reply. Use "say" first.');
  }
  writeJson(pendingPath, { said, at: new Date().toISOString() });
  console.info(`Client: ${said}`);
  console.info('\nYour move. What do you say back?');
  process.exit(0);
}

if (command === 'say') {
  const record = readCase();
  const pendingPath = casePath(record.caseId, 'pending-client.json');
  if (!existsSync(pendingPath)) {
    usage('Nobody has spoken yet. Run "client \\"...\\"" first — you are the adviser here.');
  }
  const pending = readJson(pendingPath, null);
  const adviser = parseAdviserTurn(positional.join(' '));
  if (!adviser.said && !adviser.runs.length && !adviser.fixes.length && !adviser.note) {
    usage('Say something, or use /run, /note or /fix.');
  }

  // Check the levers, but NEVER refuse the turn. An adviser reaching for an
  // assumption the engine cannot vary is not a typo to be corrected — it is the
  // most valuable thing this whole loop can catch, because it says the manifest
  // is missing a lever a real conversation needs. So it is recorded, reported,
  // and carried into the bundle as evidence.
  for (const run of adviser.runs) {
    try {
      run.acceptedOverrides = sanitizeScenarioOverrides(run.moduleId, run.scenarioOverrides);
      run.leverError = null;
    } catch (error) {
      run.acceptedOverrides = {};
      run.leverError = String(error?.message || error);
      console.info(`  note: ${run.leverError}`);
      console.info('        Recorded anyway — an assumption you need that the engine cannot');
      console.info('        vary is exactly what this is here to find.');
    }
  }

  const { env, config } = openCase(record);
  const beforeContext = await loadAgentContext(env, config, record.sessionId, record.meetingId);
  const factsBefore = observedCanonicalFacts(beforeContext);

  let shadow = null;
  let plannerMetadata = null;

  const extractTurn = async (options) => {
    if (offline) {
      plannerMetadata = { model: 'deterministic_fallback', latencyMs: 0 };
      return {
        extraction: deterministicFallbackExtraction({
          transcript: options.transcript,
          profile: options.context.profile,
          sourceTurnId: options.sourceTurnId
        }),
        metadata: { ...plannerMetadata, costMicroEur: 0 }
      };
    }
    const planned = await extractSegmentedPlannerTurn(options);
    plannerMetadata = planned.metadata || null;
    return planned;
  };

  // THE SEAM. processAgentTurn hands renderText the post-extraction context —
  // exactly the state the app would have spoken from. So the baseline is
  // snapshotted here, and then YOUR words are returned as the turn's reply.
  const renderText = async ({ context }) => {
    shadow = deterministicShadow(context, {
      confirmationCandidateModuleIds: (() => {
        try { return resolveConfirmationCandidateModuleIds(context.state, config); }
        catch (_error) { return []; }
      })()
    });
    if (shadowTier === 'full' && !offline) {
      // Against a THROWAWAY CLONE. The renderer dispatches tool calls, and a
      // baseline that saved facts or ran an analysis on the real meeting would
      // be changing the thing it is supposed to be observing.
      try {
        const clonePath = cloneCallDatabaseForReconciliation(record.databasePath, `shadow-${record.caseId}`);
        const cloneEnv = makeEnv(openCallDatabase(clonePath), { OPENAI_API_KEY: apiKey });
        const cloneConfig = makeConfig(cloneEnv);
        const cloneContext = await loadAgentContext(
          cloneEnv, cloneConfig, record.sessionId, record.meetingId
        );
        shadow.renderer = rendererShadow(await renderAssistantText({
          env: cloneEnv, config: cloneConfig, context: cloneContext, recentTurns: []
        }));
      } catch (error) {
        shadow.renderer = { tier: 'full', unavailable: String(error?.message || error).slice(0, 200) };
      }
    }
    return {
      text: adviser.said || '(the adviser acted without speaking)',
      fallback: false,
      decisions: [],
      usageMicroEur: 0,
      context
    };
  };

  let result;
  try {
    result = await processAgentTurn(env, config, {
      sessionId: record.sessionId,
      meetingId: record.meetingId,
      message: pending.said,
      deps: { extractTurn, renderText }
    });
  } catch (error) {
    console.error(`\nThe turn failed: ${error?.code || error?.message}`);
    console.error('That is itself a finding — a real caller would have hit the same wall.');
    process.exit(1);
  }

  const afterContext = await loadAgentContext(env, config, record.sessionId, record.meetingId);
  const factsAfter = observedCanonicalFacts(afterContext);

  const turns = readJson(casePath(record.caseId, 'turns.json'), []);
  const turnNumber = turns.length + 1;
  const expert = {
    ...adviser,
    extractionOutcomes: result.diagnostics?.candidateOutcomes || []
  };
  const divergences = divergencesFor({
    turn: turnNumber, shadow, expert, factsBefore, factsAfter
  });

  turns.push({
    turn: turnNumber,
    client: pending.said,
    expert,
    shadow,
    divergences,
    planner: plannerMetadata,
    factsLanded: factsAfter.length - factsBefore.length,
    at: new Date().toISOString()
  });
  writeJson(casePath(record.caseId, 'turns.json'), turns);

  const transcript = readJson(casePath(record.caseId, 'transcript.json'), []);
  transcript.push({ role: 'client', text: pending.said });
  transcript.push({ role: 'adviser', text: adviser.said, runs: adviser.runs, note: adviser.note });
  writeJson(casePath(record.caseId, 'transcript.json'), transcript);
  writeFileSync(pendingPath, '');
  if (existsSync(pendingPath)) {
    // Consumed. Removing rather than emptying keeps "has the client spoken?"
    // a single existence check with no special case for an empty file.
    const { unlinkSync } = await import('node:fs');
    unlinkSync(pendingPath);
  }

  // DELIBERATELY SILENT ABOUT THE BASELINE. See the note at the top of the file.
  console.info(`Turn ${turnNumber} recorded.`);
  if (adviser.runs.length) {
    console.info(`  analyses you asked for: ${adviser.runs.map((run) => (
      Object.keys(run.scenarioOverrides).length
        ? `${run.moduleId} (${Object.entries(run.scenarioOverrides).map(([k, v]) => `${k}=${v}`).join(', ')})`
        : run.moduleId
    )).join(', ')}`);
  }
  if (adviser.note) console.info(`  your note: ${adviser.note}`);
  console.info(`  facts on the record: ${factsAfter.length}`);
  console.info('\nNext: node ./scripts/teach-call.mjs client "..."');
  process.exit(0);
}

if (command === 'state') {
  const record = readCase();
  const { env, config } = openCase(record);
  const context = await loadAgentContext(env, config, record.sessionId, record.meetingId);
  const turns = readJson(casePath(record.caseId, 'turns.json'), []);
  console.info(`case       : ${record.caseId}`);
  console.info(`turns      : ${turns.length}`);
  console.info(`goals      : [${(context.state.goalAssessment?.activeGoalTypes || []).join(', ')}]`);
  console.info(`analyses   : [${(context.state.moduleSlots || []).map((s) => s.moduleId).join(', ')}]`);
  console.info(`facts held : ${observedCanonicalFacts(context).length}`);
  console.info(`divergences: ${summariseDivergences(turns.flatMap((t) => t.divergences || [])).total}`);
  console.info('\n(What the app would have said is recorded but not shown until you finish.)');
  process.exit(0);
}

if (command === 'transcript') {
  const record = readCase();
  for (const entry of readJson(casePath(record.caseId, 'transcript.json'), [])) {
    console.info(`${entry.role === 'client' ? 'CLIENT ' : 'YOU    '}: ${entry.text || '(acted without speaking)'}`);
    if (entry.note) console.info(`         note: ${entry.note}`);
  }
  process.exit(0);
}

if (command === 'finish') {
  const record = readCase();
  const { env, config } = openCase(record);
  const turns = readJson(casePath(record.caseId, 'turns.json'), []);
  const transcript = readJson(casePath(record.caseId, 'transcript.json'), []);

  console.info('Running the analyses...\n');
  let execution = null;
  let executionError = null;
  try {
    execution = (await confirmAgentPlan(env, config, {
      sessionId: record.sessionId, meetingId: record.meetingId
    })).execution;
    console.info(`status   : ${execution.status}`);
    console.info(`completed: ${execution.completedModuleIds.join(', ') || 'none'}`);
  } catch (error) {
    executionError = error?.code || String(error?.message || error);
    // Not a crash. An analysis that would not run is one of the most useful
    // things a teaching case can capture, and the bundle must carry it.
    console.info(`The plan would not run: ${executionError}`);
  }

  const stored = await getLatestAnalysis(env, record.sessionId, null);
  const sessionRow = await getSessionRow(env, record.sessionId);
  const blockers = [
    ...detectBlockers(turns.map((turn) => ({ ...turn, observation: {} }))),
    ...(execution
      ? detectExecutionBlockers(
          { ...execution, missingForModules: execution.requiredQuestions || [], results: stored?.results || [] },
          turns.length,
          turns
        )
      : [])
  ];

  const bundlePath = writeTeachingBundle({
    root: join(ROOT, record.caseId),
    record,
    turns,
    transcript,
    execution,
    executionError,
    results: stored?.results || [],
    profileRevision: Number(sessionRow?.current_profile_revision ?? 0),
    blockers
  });

  const divergences = turns.flatMap((turn) => turn.divergences || []);
  const summary = summariseDivergences(divergences);
  console.info(`\n--- ${summary.total} divergence(s) across ${turns.length} turn(s) ---`);
  for (const [kind, count] of Object.entries(summary.byKind)) console.info(`  ${kind}: ${count}`);
  console.info(`\nBundle written to ${bundlePath}`);
  console.info('\nNothing has changed about how the app behaves, and nothing will until you');
  console.info('approve a lesson. Hand the bundle to Claude Code or Codex next:');
  console.info(`  /teach ${record.caseId}`);
  process.exit(0);
}

usage(`Unknown command "${command}".`);

}
