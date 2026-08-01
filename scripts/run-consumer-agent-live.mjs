// A5 — the agent-driven scenario runner.
//
// An external AI model plays the client, saying whatever a person in that
// situation would plausibly say, and the REAL production planner extracts from
// it. Nothing is scripted below the transcript, so this exercises the genuine
// pipeline: unrehearsed human-like speech in, real PlannerExtractionV3 out,
// real routing and persistence, real next question.
//
// This is the tool for "point it at the app and find out what breaks".
//
//   OPENAI_API_KEY=... node ./scripts/run-consumer-agent-live.mjs --id=<scenario>
//   OPENAI_API_KEY=... node ./scripts/run-consumer-agent-live.mjs --all --turns=6
//
// PAID. Never run by CI. Each turn costs one client call plus one planner call.
//
// Role separation is strict: the simulated client sees only the client-visible
// conversation, never the scenario's expected outcomes, module ids, goal codes
// or any planning state. It is playing the consumer; giving it any of that
// would invalidate the result.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createOpenAiClient } from './agent-clients/openai.mjs';
import { RELEASED_MODULE_IDS, runAgentScenario, runVoiceScenario } from './agent-harness/transports.mjs';

const datasetPath = fileURLToPath(new URL('./fixtures/consumer-agent-scenarios.json', import.meta.url));
const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));

const args = process.argv.slice(2);
const only = (args.find((arg) => arg.startsWith('--id=')) || '').slice('--id='.length);
const runAll = args.includes('--all');
const maxTurns = Number((args.find((arg) => arg.startsWith('--turns=')) || '').slice('--turns='.length)) || 6;
const bothTransports = args.includes('--both');
const apiKey = String(process.env.OPENAI_API_KEY || '').trim();

if (!apiKey) {
  console.error('OPENAI_API_KEY is required. This runner makes paid model calls.');
  console.error('  OPENAI_API_KEY=... node ./scripts/run-consumer-agent-live.mjs --id=young_renter_first_home');
  process.exit(1);
}

const scenarios = runAll
  ? dataset.scenarios
  : dataset.scenarios.filter((item) => item.id === only);
if (scenarios.length === 0) {
  console.error(only ? `No scenario with id "${only}".` : 'Pass --id=<scenario> or --all.');
  console.error(`Available: ${dataset.scenarios.map((item) => item.id).join(', ')}`);
  process.exit(1);
}

console.info(`[Live] released modules: ${RELEASED_MODULE_IDS}`);
console.info(`[Live] ${scenarios.length} scenario(s), up to ${maxTurns} turns each, `
  + `${bothTransports ? 'both transports' : 'agent transport'}\n`);

const observations = [];

for (const scenario of scenarios) {
  console.info(`\n${'='.repeat(72)}\n${scenario.id}  —  ${scenario.client?.identity ?? ''}\n${'='.repeat(72)}`);

  // The client only ever needs `turns.length` to bound itself; give it room to
  // run to maxTurns by padding the scenario's turn list.
  const runnable = { ...scenario, turns: Array.from({ length: maxTurns }, () => ({})) };
  const client = createOpenAiClient({ apiKey, maxTurns });

  let run;
  try {
    run = await runAgentScenario(runnable, { client });
  } catch (error) {
    console.error(`  *** RUN FAILED: ${error?.code || error?.message}`);
    observations.push({ scenario: scenario.id, issue: `run failed: ${error?.code || error?.message}` });
    continue;
  }

  for (const [index, entry] of run.transcript.entries()) {
    const who = entry.role === 'client' ? 'CLIENT ' : 'PLANÉIR';
    console.info(`  ${who} ${entry.text}`);
    if (entry.role === 'assistant' && index < run.transcript.length - 1) console.info('');
  }

  const last = run.turns.at(-1);
  console.info(`\n  --- final planning state ---`);
  console.info(`  goals      : [${(last?.goals || []).join(', ')}]`);
  console.info(`  primary    : ${last?.primaryGoal ?? 'none'}`);
  console.info(`  facts      : [${(last?.factIds || []).join(', ')}]`);
  console.info(`  analyses   : [${(last?.analyses || []).join(', ')}]`);
  console.info(`  next asks  : ${last?.questionFactId ?? 'none'}`);
  console.info(`  offer      : ${last?.offerModuleId ?? 'none'}`);
  console.info(`  model calls: ${client.usage.clientCalls} client, ${client.usage.plannerCalls} planner`);

  // Automatic observations. These are the things worth a human's attention;
  // they are reported, not asserted, because a live run is exploratory.
  const expected = scenario.expected || {};
  for (const goalType of expected.mustPersistGoals || []) {
    if (!(last?.goals || []).includes(goalType)) {
      observations.push({
        scenario: scenario.id,
        issue: `expected the ${goalType} goal, got [${(last?.goals || []).join(', ')}]`
      });
    }
  }
  for (const moduleId of expected.mustSelectModuleIds || []) {
    if (!(last?.analyses || []).includes(moduleId)) {
      observations.push({
        scenario: scenario.id,
        issue: `expected the ${moduleId} analysis, got [${(last?.analyses || []).join(', ')}]`
      });
    }
  }
  for (const factId of expected.mustNeverAskFactIds || []) {
    if (run.turns.some((turn) => turn.questionFactId === factId)) {
      observations.push({ scenario: scenario.id, issue: `asked for ${factId}, which is irrelevant to this client` });
    }
  }
  const repeated = run.turns.map((turn) => turn.questionFactId).filter(Boolean);
  for (const factId of new Set(repeated)) {
    const count = repeated.filter((item) => item === factId).length;
    if (count >= 3) {
      observations.push({ scenario: scenario.id, issue: `asked for ${factId} ${count} times — possible loop` });
    }
  }
  if ((last?.goals || []).length === 0) {
    observations.push({ scenario: scenario.id, issue: 'the conversation ended with no goal captured at all' });
  }
  for (const turn of run.turns) {
    if (turn.plannerErrorCode) {
      observations.push({ scenario: scenario.id, issue: `planner error: ${turn.plannerErrorCode}` });
    }
    if (!turn.questionFactId) {
      observations.push({ scenario: scenario.id, issue: 'a turn produced no server-owned question' });
    }
  }

  if (bothTransports) {
    // Replay the SAME transcript through the voice-equivalent path. The client
    // is replaced by a replay of what it actually said, so both transports see
    // an identical conversation and any difference is the engine's.
    const said = run.transcript.filter((entry) => entry.role === 'client').map((entry) => entry.text);
    let cursor = 0;
    const replayClient = {
      id: 'replay',
      async nextMessage() { return said[cursor++] ?? null; },
      extractionFor: client.extractionFor.bind(client)
    };
    const voice = await runVoiceScenario(
      { ...scenario, turns: said.map(() => ({})) },
      { client: replayClient }
    );
    const agentGoals = JSON.stringify(last?.goals || []);
    const voiceGoals = JSON.stringify(voice.turns.at(-1)?.goals || []);
    console.info(`  voice replay goals: ${voiceGoals}`);
    if (agentGoals !== voiceGoals) {
      observations.push({
        scenario: scenario.id,
        issue: `TRANSPORT DIVERGENCE: agent ${agentGoals} vs voice ${voiceGoals}`
      });
    }
  }
}

console.info(`\n${'='.repeat(72)}`);
if (observations.length === 0) {
  console.info('[Live] no issues observed.');
} else {
  console.info(`[Live] ${observations.length} observation(s) for review:\n`);
  for (const item of observations) console.info(`  [${item.scenario}] ${item.issue}`);
  console.info('\nThese are observations from an exploratory run, not test failures.');
  console.info('Reproduce any of them deterministically by adding the transcript to');
  console.info('scripts/fixtures/consumer-agent-scenarios.json with its expected outcome.');
}
