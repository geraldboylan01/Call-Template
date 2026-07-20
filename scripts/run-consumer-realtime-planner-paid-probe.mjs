import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRealtimePlannerTurn } from '../worker/src/consumer/realtime_planner.js';

const devVarsPath = fileURLToPath(new URL('../worker/.dev.vars', import.meta.url));

function localOpenAiKey() {
  const line = readFileSync(devVarsPath, 'utf8')
    .split(/\r?\n/)
    .find((item) => item.startsWith('OPENAI_API_KEY='));
  const raw = String(line || '').slice('OPENAI_API_KEY='.length).trim();
  const value = raw.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, double, single) => double ?? single ?? '');
  assert.match(value, /^sk-[A-Za-z0-9_-]{20,}$/, 'worker/.dev.vars does not contain a usable OPENAI_API_KEY.');
  return value;
}

function amountFor(extractions, kind) {
  const candidate = extractions.flatMap((item) => item.positions).find((item) => item.kind === kind);
  return Number(candidate?.amount?.amount);
}

// These sentences are synthetic API-test data, not a consumer transcript.
// They intentionally cover the same parser shapes as the protected local
// regression without exporting that conversation from the workspace.
const turns = [
  { say: 'Synthetic test person: I am 32 and I just had a baby. I want a broad financial health check and future education funding.' },
  { say: 'The synthetic household has exactly ten thousand euro in cash.' },
  { say: 'It also has a pension worth exactly one hundred thousand euro and an investment account worth exactly ten thousand euro.' },
  { say: 'Its home is worth exactly five hundred thousand euro and has a linked mortgage balance of exactly three hundred and fifty thousand euro.' },
  { say: 'In this synthetic test, what does net worth mean and why is the mortgage balance needed?' },
  { say: 'That is everything for the synthetic household assets.' }
];
const expectedPositions = {
  cash: 10_000,
  investment: 10_000,
  pension: 100_000,
  property: 500_000,
  mortgage: 350_000
};
const key = localOpenAiKey();
const config = {
  realtimeConversationV2Enabled: true,
  realtimePlannerTimeoutMs: 2_500,
  realtimePlannerMaxOutputTokens: 1_800,
  defaultModel: String(process.env.CONSUMER_AI_DEFAULT_MODEL || 'gpt-5.6-luna'),
  complexModel: String(process.env.CONSUMER_AI_COMPLEX_MODEL || 'gpt-5.6-terra')
};
const env = { OPENAI_API_KEY: key };
const recentTurns = [];
const extractions = [];
const latencies = [];

for (const [index, turn] of turns.entries()) {
  const result = await extractRealtimePlannerTurn({
    env,
    config,
    context: {
      sessionRow: { current_profile_revision: 1 },
      state: {
        profileRevision: 1,
        facts: [],
        moduleSlots: [],
        recommendations: [],
        reasoningEscalation: { requested: false }
      }
    },
    sourceTurnId: `paid_probe_turn_${index + 1}`,
    transcript: turn.say,
    recentTurns,
    timeoutMs: 15_000
  });
  extractions.push(result.extraction);
  latencies.push(result.metadata.latencyMs);
  recentTurns.push({ role: 'user', transcript: turn.say });
}

const facts = extractions.flatMap((item) => item.semanticFacts);
const failedChecks = [];
if (!facts.some((item) => item.factId === 'self_description' && item.value === 'new_parent')) {
  failedChecks.push('new_parent_classification');
}
for (const [kind, expected] of Object.entries(expectedPositions)) {
  if (amountFor(extractions, kind) !== expected) failedChecks.push(`${kind}_exact_value`);
}
const property = extractions.flatMap((item) => item.positions).find((item) => item.kind === 'property');
const mortgage = extractions.flatMap((item) => item.positions).find((item) => item.kind === 'mortgage');
if (!property?.linkedEntityId || property.linkedEntityId !== mortgage?.linkedEntityId) {
  failedChecks.push('property_mortgage_link');
}
if (!extractions.flatMap((item) => item.sectionCompletions)
  .some((item) => item.section === 'assets' && item.signal === 'complete_section')) {
  failedChecks.push('populated_section_completion');
}
if (!extractions.some((item) => item.clientQuestion.present && /net worth/i.test(item.clientQuestion.questionText))) {
  failedChecks.push('client_question_intent');
}

console.log(JSON.stringify({
  ok: failedChecks.length === 0,
  model: config.defaultModel,
  turns: turns.length,
  exactPositionValues: Object.keys(expectedPositions).length,
  maximumPlannerLatencyMs: Math.max(...latencies),
  failedChecks
}));
assert.deepEqual(failedChecks, [], `Synthetic paid planner checks failed: ${failedChecks.join(', ')}`);
