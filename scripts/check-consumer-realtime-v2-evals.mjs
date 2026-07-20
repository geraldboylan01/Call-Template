import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const datasetPath = fileURLToPath(new URL('./fixtures/consumer-realtime-conversations-v2.json', import.meta.url));
const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
assert.equal(dataset.schemaVersion, 'consumer-realtime-conversation-dataset-v2');
assert.ok(Array.isArray(dataset.cases) && dataset.cases.length >= 4);
assert.equal(new Set(dataset.cases.map((item) => item.id)).size, dataset.cases.length);
assert.ok(dataset.cases.some((item) => item.id === dataset.defaultCaseId));

const labels = new Set(dataset.cases.flatMap((testCase) => testCase.turns.map((turn) => turn.label)));
for (const required of [
  'open',
  'pension_and_shares',
  'home_and_mortgage',
  'concept_detour',
  'recommendation_boundary',
  'complete_assets',
  'multiple_positions',
  'correction',
  'state_pensions',
  'spoken_confirmation'
]) {
  assert.ok(labels.has(required), `The protected conversation dataset is missing ${required}.`);
}

const regression = dataset.cases.find((item) => item.id === 'new_parent_full_regression');
assert.deepEqual(regression.expected.positions, {
  cash: 10_000,
  investment: 10_000,
  pension: 100_000,
  property: 500_000,
  mortgage: 350_000
});
assert.equal(regression.expected.analysisCount, 3);
assert.ok(regression.expected.requiredAnalysisIds.includes('personal_balance_sheet'));
assert.ok(regression.expected.completedSections.includes('/assets'));

const completion = dataset.cases.find((item) => item.id === 'spoken_retirement_completion');
assert.equal(completion.expected.questionBatchMax, 1);
assert.equal(completion.expected.statePensionAnnualPrimary, 15_563.60);
assert.equal(completion.expected.statePensionAnnualPartner, 7_781.80);
assert.equal(completion.expected.statePensionStartAge, 66);
assert.equal(completion.expected.statePensionEscalationRate, 0.02);
assert.equal(completion.expected.confirmationDecision, 'affirmed');
assert.deepEqual(completion.expected.completionPhases, [
  'awaiting_voice_confirmation',
  'generating_modules',
  'closing',
  'completed'
]);
assert.equal(
  completion.expected.outro,
  'Thanks very much for your time today. Your modules are ready, and I’m taking you to them now.'
);
assert.equal(completion.expected.automaticHangup, true);
assert.equal(completion.expected.navigationTarget, 'results');
assert.equal(completion.expected.transcriptIncludesWelcomeAndOutro, true);
assert.deepEqual(completion.expected.forbiddenUnsolicitedTerms, ['IRA', 'Roth IRA', '401(k)', 'ISA']);

for (const testCase of dataset.cases) {
  assert.ok(Array.isArray(testCase.turns) && testCase.turns.length > 0);
  for (const turn of testCase.turns) {
    assert.equal(typeof turn.say, 'string');
    assert.ok(turn.say.trim().length > 0 && turn.say.length <= 1_500);
    if (turn.mustPattern) assert.doesNotThrow(() => new RegExp(turn.mustPattern, 'i'));
    if (turn.mustNotPattern) assert.doesNotThrow(() => new RegExp(turn.mustNotPattern, 'i'));
  }
}

console.log(`Consumer Realtime v2 eval dataset covers ${dataset.cases.length} protected conversations, including spoken module completion and the supplied five-position regression.`);
