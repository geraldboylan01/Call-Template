// Independent offline replay at 30eab9e. Uses only archived synthetic responses.
// Advances an audit clock by recorded provider latency; no network or real sleeps.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { interpretDirectModuleConversation, normalizeDirectSnapshot } from '../worker/src/consumer/direct_module_planner.js';
import { buildDirectModulePolicyEnvelope } from '../js/planning/direct_module_policy.js';
import { FIRST20_SEMANTIC_CORPUS } from './first20-semantic-corpus.mjs';

const groups = {
  baseline: ['paid-v11-r1', 'paid-v11-r2', 'paid-v11-r3'],
  narrow: ['paid-v14-r1', 'paid-v14-r2', 'paid-v14-r3', 'paid-v15-r1'],
  option2: ['paid-v16-r1', 'paid-v16-r2', 'paid-v16-r3']
};
const out = resolve('diagnostics/option2-review/evidence');
await mkdir(out, { recursive: true });
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const totals = {};
for (const [name, batches] of Object.entries(groups)) {
  const cases = (await Promise.all(batches.map(async (batch) => {
    const summary = await read(`diagnostics/first20/${batch}/summary.json`);
    return summary.cases.map((item) => ({ batch, ...item }));
  }))).flat();
  totals[name] = { total: cases.length, semanticPass: cases.filter((item) => item.pass).length,
    passBelow45s: cases.filter((item) => item.pass && item.elapsedMs < 45000).length,
    atLeast45s: cases.filter((item) => item.elapsedMs >= 45000).map(({ batch, id, pass, elapsedMs }) => ({ batch, id, pass, elapsedMs })) };
}
const originalFetch = globalThis.fetch;
const realNow = Date.now;
const records = [];
for (const batch of groups.option2) {
  const summary = await read(`diagnostics/first20/${batch}/summary.json`);
  for (const test of FIRST20_SEMANTIC_CORPUS) {
    const record = await read(`diagnostics/first20/${batch}/${test.id}.json`);
    const profile = { profileId: 'first20-synthetic', revision: 1,
      primaryPerson: { personId: 'primary', displayName: 'Aoife' },
      partner: test.partner ? { personId: 'partner', displayName: 'Ben' } : null,
      preferences: { baseCurrency: 'EUR' }, assumptions: { calculationDateIso: summary.calculationDateIso } };
    const policyEnvelope = buildDirectModulePolicyEnvelope({ calculationDateIso: summary.calculationDateIso, baseCurrency: 'EUR' });
    const normalizeOptions = { currentProfileContext: profile, policyEnvelope, turns: record.turns,
      throughTurnId: record.turns.at(-1).id, previousRevision: 0,
      acknowledgedUnknown: record.acknowledgedUnknown || [], allowedModuleIds: summary.config.allowedModules };
    let clock = Date.parse(summary.startedAt);
    const startedAt = clock;
    const operation = { deadlineAt: clock + record.operation.turnBudgetMs,
      callsUsed: 0, callAllowance: record.operation.callAllowance, controller: new AbortController() };
    const calls = [];
    const settled = [];
    globalThis.fetch = async (_url, init) => {
      const archived = record.providerCalls[calls.length];
      assert.ok(archived, `${batch}/${test.id} attempted an unrecorded call`);
      const request = JSON.parse(init.body);
      const body = JSON.parse(request.input.find((item) => item.role === 'user').content);
      const stage = request.text.format.name;
      assert.deepEqual(body.conversation, record.turns.map((turn) => ({ turnId: turn.id,
        role: turn.role === 'user' ? 'client' : 'assistant', text: turn.transcript,
        answersTurnId: turn.answersTurnId || null })), 'All stages must retain the exact full conversation');
      const output = archived.response?.output?.flatMap((item) => item.content || [])
        .find((content) => content.type === 'output_text')?.text;
      const value = output ? JSON.parse(output) : null;
      const normalized = value?.schemaVersion === 'ModulePlanningSnapshotV1'
        ? normalizeDirectSnapshot(structuredClone(value), normalizeOptions) : null;
      const row = normalized?.modules.find((item) => item.moduleId === test.moduleId);
      calls.push({ stage, offsetMs: clock - startedAt, elapsedMs: archived.elapsedMs,
        requestBody: body, systemPromptHash: createHash('sha256').update(request.input[0].content).digest('hex'),
        responseValue: value, error: archived.error,
        normalized: row ? { status: row.status, inputSupportIssues: row.inputSupportIssues || [],
          droppedCitations: row.droppedCitations || [], evidence: row.evidence,
          confirmationPrompt: normalized.confirmationPrompt } : null });
      clock += archived.elapsedMs;
      if (archived.error) {
        const error = new Error(archived.error.message); error.name = archived.error.name; throw error;
      }
      return new Response(JSON.stringify(archived.response), { status: archived.httpStatus });
    };
    Date.now = () => clock;
    let result;
    try {
      result = await interpretDirectModuleConversation({ env: { OPENAI_API_KEY: 'offline-no-network',
        CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url') },
        config: summary.config, operation, turns: record.turns, throughTurnId: record.turns.at(-1).id,
        currentProfileContext: profile, acknowledgedUnknown: record.acknowledgedUnknown || [],
        onProviderResponse: (response) => settled.push(response) });
    } finally { globalThis.fetch = originalFetch; Date.now = realNow; }
    assert.equal(calls.length, record.providerCalls.length, `${batch}/${test.id} call count must reproduce`);
    assert.equal(operation.callsUsed, calls.length, 'Operation allowance must count every dispatch');
    assert.deepEqual(result.verification, record.result.verification, 'Returned audit must reproduce');
    const firstVerifier = calls.findIndex((item) => item.stage === 'module_input_verification_v1');
    const fallback = calls.map((item, index) => ({ ...item, index })).filter((item) =>
      item.index > firstVerifier && item.stage === 'module_planning_snapshot_v1'
      && calls.slice(firstVerifier + 1, item.index).some((prior) => /_(confirmation|evidence)_repair_/.test(prior.stage)));
    const item = { batch, id: test.id, pass: record.pass, elapsedMs: record.elapsedMs,
      operation: record.operation, fallbackCalls: fallback.map((item) => item.index + 1), calls, settled,
      returnedVerification: result.verification };
    records.push(item);
    await writeFile(resolve(out, `${batch}--${test.id}.json`), JSON.stringify(item, null, 2) + '\n');
  }
}
const summary = { totals, replayedCases: records.length,
  fullConversationRetained: true, exactReturnedVerdictsReproduced: true,
  fallbackCases: records.filter((item) => item.fallbackCalls.length).map(({ batch, id, pass, elapsedMs, fallbackCalls }) => ({ batch, id, pass, elapsedMs, fallbackCalls })),
  note: 'Requests reconstructed from final current code; original archives record responses, not request or git hashes. Replay advances by provider elapsedMs only, not original inter-call overhead.' };
await writeFile(resolve(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.info(JSON.stringify(summary, null, 2));
