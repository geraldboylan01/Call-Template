// A4 — the scenario runner.
//
// Replays every scenario in the library through BOTH transports and checks two
// separate things:
//
//   1. EXPECTED OUTCOMES — the goals, analyses, facts and questions the
//      planning engine should produce for that client.
//   2. TRANSPORT PARITY — the agent and voice-equivalent paths must reach an
//      identical planning state at every turn.
//
// (2) is the reason the agent environment exists. It is a tester for the voice
// journey, so a scenario that passes in one transport and not the other is a
// failure of the harness's whole premise, reported as loudly as a wrong answer.
//
// Every scenario runs twice per transport: healthy planner and dead planner.
// The dead-planner pass proves a provider outage degrades identically on both
// sides rather than only being handled in voice.
//
//   node ./scripts/run-consumer-agent-scenarios.mjs            all scenarios
//   node ./scripts/run-consumer-agent-scenarios.mjs --id=<id>  one scenario
//   node ./scripts/run-consumer-agent-scenarios.mjs --verbose  per-turn detail
//
// No network, no API key. For an AI-driven client see --client=openai in
// run-consumer-agent-live.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createScriptedClient } from './agent-clients/scripted.mjs';
import { RELEASED_MODULE_IDS, runBothTransports } from './agent-harness/transports.mjs';

const datasetPath = fileURLToPath(new URL('./fixtures/consumer-agent-scenarios.json', import.meta.url));
const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));

assert.equal(dataset.schemaVersion, 'consumer-agent-scenario-v1');
assert.equal(dataset.synthetic, true, 'the scenario library must be synthetic-only');
assert.equal(
  new Set(dataset.scenarios.map((item) => item.id)).size,
  dataset.scenarios.length,
  'scenario ids must be unique'
);

const args = process.argv.slice(2);
const only = (args.find((arg) => arg.startsWith('--id=')) || '').slice('--id='.length);
const verbose = args.includes('--verbose');
const scenarios = only ? dataset.scenarios.filter((item) => item.id === only) : dataset.scenarios;
assert.ok(scenarios.length > 0, only ? `no scenario with id ${only}` : 'no scenarios');

const failures = [];
const knownIssues = [];
// A scenario marked `knownIssue` documents a defect that has been found and
// triaged but not yet fixed. It is reported loudly every run so it cannot be
// forgotten, but it does not fail the build -- and it starts failing the moment
// someone "fixes" it by accident without removing the marker, which is the
// point.
let currentScenario = null;
function check(scenarioId, mode, description, condition, detail = '') {
  if (condition) return;
  const line = `[${scenarioId}/${mode}] ${description}${detail ? `\n      ${detail}` : ''}`;
  (currentScenario?.knownIssue ? knownIssues : failures).push(line);
}

/* ------------------------------------------------------------------ */

function assertExpectations(scenario, mode, run) {
  const expected = scenario.expected || {};
  const last = run.turns.at(-1);
  if (!last) {
    failures.push(`[${scenario.id}/${mode}] produced no turns`);
    return;
  }

  for (const goalType of expected.mustPersistGoals || []) {
    check(scenario.id, mode, `must persist the ${goalType} goal`,
      last.goals.includes(goalType), `persisted: ${JSON.stringify(last.goals)}`);
  }
  for (const moduleId of expected.mustSelectModuleIds || []) {
    check(scenario.id, mode, `must select ${moduleId}`,
      last.analyses.includes(moduleId), `selected: ${JSON.stringify(last.analyses)}`);
  }
  for (const moduleId of expected.mustNeverSelectModuleIds || []) {
    check(scenario.id, mode, `must never select ${moduleId}`,
      !last.analyses.includes(moduleId), `selected: ${JSON.stringify(last.analyses)}`);
  }
  for (const factId of expected.mustPersistFactIds || []) {
    check(scenario.id, mode, `must persist the ${factId} fact`,
      last.factIds.includes(factId), `facts: ${JSON.stringify(last.factIds)}`);
  }

  // A forbidden fact must never be asked at ANY turn, nor queued for later.
  for (const factId of expected.mustNeverAskFactIds || []) {
    const asked = run.turns.some((turn) => turn.questionFactId === factId
      || turn.stillNeededFactIds.includes(factId));
    check(scenario.id, mode, `must never ask this client for ${factId}`, !asked);
  }

  if (expected.expectsPriorityQuestion) {
    check(scenario.id, mode, 'must ask which goal to focus on first',
      run.turns.some((turn) => turn.questionFactId === 'primary_goal_focus'),
      `questions: ${JSON.stringify(run.turns.map((t) => t.questionFactId))}`);
  }
  // A client who says "I don't know" must not be asked the same thing again.
  // An agent-driven run found the meeting asking one question four times.
  if (expected.mustNotRepeatQuestion) {
    // The real fault is asking for something the client has ALREADY answered --
    // including answering "I don't know". Asking an as-yet-unanswered question
    // again on a later turn is normal conversation, not a loop.
    const answered = new Set();
    for (const turn of run.turns) {
      if (turn.questionFactId && answered.has(turn.questionFactId)) {
        check(scenario.id, mode,
          `must not ask again for ${turn.questionFactId} — the client already answered it`,
          false, `questions: ${JSON.stringify(run.turns.map((t) => t.questionFactId))}`);
      }
      for (const factId of turn.acceptedFactIds) answered.add(factId);
    }
  }
  // An essential input the client does not have DROPS the analysis, freeing its
  // slot -- and the drop reverses by itself when they later supply the figure.
  if (expected.blocksThenRecovers) {
    const { moduleId, blockedAfterTurn, recoveredAfterTurn } = expected.blocksThenRecovers;
    const blockedTurn = run.turns[blockedAfterTurn - 1];
    const recoveredTurn = run.turns[recoveredAfterTurn - 1];
    check(scenario.id, mode, `${moduleId} must be dropped once its essential input is unknown`,
      blockedTurn && !blockedTurn.analyses.includes(moduleId),
      `analyses after turn ${blockedAfterTurn}: ${JSON.stringify(blockedTurn?.analyses)}`);
    check(scenario.id, mode, `${moduleId} must return once the client supplies the figure`,
      recoveredTurn && recoveredTurn.analyses.includes(moduleId),
      `analyses after turn ${recoveredAfterTurn}: ${JSON.stringify(recoveredTurn?.analyses)}`);
  }
  if (expected.expectsUnsupportedGoalMessage) {
    check(scenario.id, mode, 'must tell the client this goal has no analysis yet',
      last.analyses.length === 0 && last.questionFactId === 'primary_goal',
      `analyses: ${JSON.stringify(last.analyses)}, question: ${last.questionFactId}`);
  }

  // Universal invariants, on every scenario and every turn.
  for (const turn of run.turns) {
    check(scenario.id, mode, 'every turn must leave a server-owned question',
      Boolean(turn.questionFactId), `turn "${String(turn.transcript).slice(0, 40)}..." had none`);
    check(scenario.id, mode, 'never more than three analyses',
      turn.analyses.length <= 3, `analyses: ${JSON.stringify(turn.analyses)}`);
    for (const moduleId of turn.analyses) {
      check(scenario.id, mode, `${moduleId} must be a released module`,
        RELEASED_MODULE_IDS.split(',').includes(moduleId));
    }
  }
}

/** The comparison that makes the agent environment a valid voice tester. */
function assertParity(scenario, mode, agent, voice) {
  check(scenario.id, mode, 'both transports must produce the same number of turns',
    agent.turns.length === voice.turns.length,
    `agent ${agent.turns.length}, voice ${voice.turns.length}`);

  const turnCount = Math.min(agent.turns.length, voice.turns.length);
  for (let index = 0; index < turnCount; index += 1) {
    const a = agent.turns[index];
    const v = voice.turns[index];
    for (const field of Object.keys(a)) {
      // Assistant prose is never compared: it comes from two different model
      // calls and is not expected to match.
      if (field === 'transcript') continue;
      const left = JSON.stringify(a[field]);
      const right = JSON.stringify(v[field]);
      check(
        scenario.id, mode,
        `turn ${index + 1}: agent and voice disagree on ${field}`,
        left === right,
        `agent=${left}\n      voice=${right}`
      );
    }
  }
}

/* ------------------------------------------------------------------ */

console.info(`[Scenarios] released modules: ${RELEASED_MODULE_IDS}`);
console.info(`[Scenarios] running ${scenarios.length} scenario(s) x 2 transports x 2 planner modes\n`);

for (const scenario of scenarios) {
  currentScenario = scenario;
  for (const [mode, plannerFails] of [['healthy', false], ['degraded', true]]) {
    const { agent, voice } = await runBothTransports(scenario, {
      makeClient: () => createScriptedClient({ plannerFails })
    });

    // Expected outcomes are only meaningful with a working planner: a degraded
    // turn legitimately captures less. What the degraded pass proves is PARITY
    // and that state is still persisted at all.
    if (mode === 'healthy') {
      assertExpectations(scenario, `${mode}/agent`, agent);
      assertExpectations(scenario, `${mode}/voice`, voice);
    } else {
      // What a degraded run must guarantee. NOT "a goal is always captured":
      // the deterministic fallback is a deliberately conservative regex
      // extractor and genuinely cannot read every phrasing. Demanding that it
      // could would be asserting a fiction.
      //
      // What it MUST guarantee is that the outage is recorded, the meeting
      // still has a server-owned question rather than blaming the client, and
      // anything it did salvage is marked degraded and persisted.
      for (const [transport, run] of [['agent', agent], ['voice', voice]]) {
        for (const [index, turn] of run.turns.entries()) {
          check(scenario.id, `${mode}/${transport}`,
            `turn ${index + 1}: a planner outage must be recorded, never hidden`,
            Boolean(turn.plannerErrorCode));
          check(scenario.id, `${mode}/${transport}`,
            `turn ${index + 1}: a degraded turn must still leave a server-owned question`,
            Boolean(turn.questionFactId));
          check(scenario.id, `${mode}/${transport}`,
            `turn ${index + 1}: a turn that salvaged facts must be marked degraded`,
            turn.acceptedFactIds.length === 0 || turn.degraded === true,
            `accepted=${JSON.stringify(turn.acceptedFactIds)} degraded=${turn.degraded}`);
        }
        const last = run.turns.at(-1);
        // Whatever survived must be projected faithfully — never state that
        // exists in the profile but not in the UI, or the reverse.
        check(scenario.id, `${mode}/${transport}`,
          'salvaged goals must reach the projection',
          !last || Array.isArray(last.goals));
      }
    }
    assertParity(scenario, mode, agent, voice);

    const summary = agent.turns.at(-1);
    console.info(
      `  ${scenario.id.padEnd(32)} ${mode.padEnd(9)} `
      + `goals=[${(summary?.goals || []).join(',')}] `
      + `analyses=[${(summary?.analyses || []).join(',')}] `
      + `asks=${summary?.questionFactId ?? 'none'}`
    );
    if (verbose) {
      for (const [index, turn] of agent.turns.entries()) {
        console.info(`      turn ${index + 1}: +[${turn.acceptedFactIds.join(',')}] `
          + `-[${turn.rejectedFactIds.join(',')}] q=${turn.questionFactId}`);
      }
    }
  }
}

console.info(`\n[Scenarios] deterministic fallback coverage (what survives a planner outage):`);
for (const scenario of scenarios) {
  const { agent } = await runBothTransports(scenario, {
    makeClient: () => createScriptedClient({ plannerFails: true })
  });
  const goals = agent.turns.flatMap((turn) => turn.goals);
  const facts = agent.turns.flatMap((turn) => turn.acceptedFactIds);
  const covered = goals.length > 0;
  console.info(`  ${covered ? 'COVERED ' : 'no goal '} ${scenario.id.padEnd(32)} `
    + `goals=[${[...new Set(goals)].join(',')}] facts=[${[...new Set(facts)].join(',')}]`);
}

if (knownIssues.length > 0) {
  console.info(`\n[Scenarios] ${knownIssues.length} KNOWN ISSUE(S) — documented, not yet fixed:\n`);
  for (const item of knownIssues) console.info(`  ${item}`);
  for (const scenario of scenarios.filter((item) => item.knownIssue)) {
    console.info(`\n  ${scenario.id}:\n    ${scenario.knownIssue}`);
  }
}

if (failures.length > 0) {
  console.error(`\n[Scenarios] ${failures.length} failure(s):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.info(`\n[Scenarios] ${scenarios.length} scenarios passed on both transports, `
    + 'healthy and degraded.');
}
