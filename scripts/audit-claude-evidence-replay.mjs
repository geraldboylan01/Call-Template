// Independent, offline audit of the final three recorded synthetic eval runs.
// Replays responses; NEVER makes a network request. Writes synthetic evidence only.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { interpretDirectModuleConversation, normalizeDirectSnapshot } from '../worker/src/consumer/direct_module_planner.js';
import { buildDirectModulePolicyEnvelope, directModuleMaterialAssumptions } from '../js/planning/direct_module_policy.js';
import { FIRST20_SEMANTIC_CORPUS, FIRST20_EVAL_DATE } from './first20-semantic-corpus.mjs';

const batches = ['paid-v10c-r1', 'paid-v10c-r2b', 'paid-v10c-r3b'];
const out = resolve('diagnostics/claude-review/evidence-replay');
await mkdir(out, { recursive: true });
const originalFetch = globalThis.fetch;
const report = [];
const envelope = buildDirectModulePolicyEnvelope({ calculationDateIso: FIRST20_EVAL_DATE, baseCurrency: 'EUR' });
// Controlled ablation of ONE predicate in an in-memory audit module. This is
// not a production edit: it lets us compare the same recorded model proposal
// with server-owned citation filtering enabled and disabled, without sampling.
const plannerPath = resolve('worker/src/consumer/direct_module_planner.js');
const filterPredicate = '&& !fixedPolicyPaths.some((fixedPath) => pathCovers(fixedPath, normalized.path))';
const source = await readFile(plannerPath, 'utf8');
assert.equal(source.split(filterPredicate).length, 2, 'Audit ablation must remove exactly one predicate');
const ablatedSource = source.replace(filterPredicate, '')
  .replace(/from '([^']+)'/g, (_match, target) => `from '${pathToFileURL(resolve(dirname(plannerPath), target)).href}'`);
const { normalizeDirectSnapshot: normalizeWithoutFixedCitationDrop } = await import(
  `data:text/javascript;base64,${Buffer.from(ablatedSource).toString('base64')}`);
const citationAblations = [];
for (const batch of batches) {
  const summary = JSON.parse(await readFile(`diagnostics/first20/${batch}/summary.json`, 'utf8'));
  for (const test of FIRST20_SEMANTIC_CORPUS) {
    const record = JSON.parse(await readFile(`diagnostics/first20/${batch}/${test.id}.json`, 'utf8'));
    const profile = { profileId: 'first20-synthetic', revision: 1,
      primaryPerson: { personId: 'primary', displayName: 'Aoife' },
      partner: test.partner ? { personId: 'partner', displayName: 'Ben' } : null,
      preferences: { baseCurrency: 'EUR' }, assumptions: { calculationDateIso: FIRST20_EVAL_DATE } };
    const extractionProposals = [];
    for (const call of record.providerCalls) {
      const text = call.response.output?.flatMap((output) => output.content || [])
        .find((content) => content.type === 'output_text')?.text;
      const raw = JSON.parse(text);
      if (raw.schemaVersion !== 'ModulePlanningSnapshotV1') continue;
      const options = { turns: record.turns, throughTurnId: record.turns.at(-1).id,
        previousRevision: 0, policyEnvelope: envelope, currentProfileContext: profile,
        allowedModuleIds: summary.config.allowedModules, acknowledgedUnknown: record.acknowledgedUnknown || [] };
      const a = normalizeDirectSnapshot(structuredClone(raw), options);
      const b = normalizeWithoutFixedCitationDrop(structuredClone(raw), options);
      const rawModule = raw.modules.find((module) => module.moduleId === test.moduleId);
      const normalizedModule = a.modules.find((module) => module.moduleId === test.moduleId);
      extractionProposals.push({ call: call.index, rawStatus: rawModule.status,
        normalizedStatus: normalizedModule.status, evidenceBefore: rawModule.evidence.length,
        evidenceAfter: normalizedModule.evidence.length,
        rawConfirmationPrompt: raw.confirmationPrompt,
        normalizedConfirmationPrompt: a.confirmationPrompt,
        inputSupportIssues: normalizedModule.inputSupportIssues || [],
        droppedCitations: normalizedModule.droppedCitations || [] });
      const removed = a.modules.flatMap((module, i) => b.modules[i].evidence.filter((entry) =>
        !module.evidence.some((kept) => JSON.stringify(kept) === JSON.stringify(entry)))
        .map((entry) => ({ moduleId: module.moduleId, ...entry })));
      const withoutEvidence = (snapshot) => ({ ...snapshot, modules: snapshot.modules.map(({ evidence: _e, ...rest }) => rest) });
      assert.deepEqual(withoutEvidence(a), withoutEvidence(b),
        'Server-owned citation ablation must not change native inputs, status, policy or read-back');
      if (removed.length) citationAblations.push({ batch, id: test.id, call: call.index, removed });
    }
    const requests = [];
    let index = 0;
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init.body);
      const response = record.providerCalls[index++];
      assert.ok(response, 'Replay requested a provider response not present in the archive');
      requests.push({ stage: request.text.format.name,
        body: JSON.parse(request.input.find((item) => item.role === 'user').content) });
      return new Response(JSON.stringify(response.response), { status: response.httpStatus });
    };
    let result;
    try {
      result = await interpretDirectModuleConversation({
        env: { OPENAI_API_KEY: 'offline-no-network', CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url') },
        config: summary.config, turns: record.turns, throughTurnId: record.turns.at(-1).id,
        currentProfileContext: profile,
        acknowledgedUnknown: record.acknowledgedUnknown || []
      });
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(index, record.providerCalls.length, 'Replay must consume the archived call graph');
    assert.deepEqual(result.verification, record.result.verification, 'Replay must preserve the returned audit verdict');
    const verifierRequests = requests.filter((item) => item.stage === 'module_input_verification_v1');
    for (const request of requests) {
      assert.deepEqual(request.body.conversation, record.turns.map((turn) => ({
        turnId: turn.id, role: turn.role === 'user' ? 'client' : 'assistant',
        text: turn.transcript, answersTurnId: turn.answersTurnId || null
      })), 'Every call must retain the full recorded conversation');
    }
    const audits = verifierRequests.map(({ body }) => {
      const module = body.proposedSnapshot.modules.find((item) => item.moduleId === test.moduleId);
      const expectedFloor = directModuleMaterialAssumptions(test.moduleId, module.input, envelope)
        .filter((assumption) => !module.evidence.some((entry) => entry.source === 'conversation'
          && (entry.path === assumption.path || assumption.path.startsWith(`${entry.path}/`))));
      const actualFloor = body.materialAssumptions.find((item) => item.moduleId === test.moduleId)?.assumptions || [];
      return { expectedFloor, actualFloor, floorMatches: JSON.stringify(expectedFloor) === JSON.stringify(actualFloor),
        evidence: module.evidence, input: module.input, confirmationPrompt: body.proposedSnapshot.confirmationPrompt };
    });
    const item = { batch, id: test.id, pass: record.pass, callCount: index, elapsedMs: record.elapsedMs,
      returnedVerification: result.verification, audits, extractionProposals };
    report.push(item);
    await writeFile(resolve(out, `${batch}--${test.id}.json`), JSON.stringify(item, null, 2) + '\n');
  }
}
const floorMismatches = report.flatMap((item) => item.audits.flatMap((audit, index) => audit.floorMatches ? [] : [{
  batch: item.batch, id: item.id, audit: index + 1,
  missingPaths: audit.expectedFloor.filter((entry) => !audit.actualFloor.some((actual) => actual.path === entry.path)).map((entry) => entry.path)
}]));
await writeFile(resolve(out, 'summary.json'), JSON.stringify({
  scope: 'Deterministic recorded-response replay; no new model evidence; no timing simulation',
  runs: batches.map((batch) => ({ batch, passed: report.filter((item) => item.batch === batch && item.pass).length,
    total: report.filter((item) => item.batch === batch).length })),
  replayedCases: report.length, fullConversationRetained: true, floorMismatches, citationAblations
}, null, 2) + '\n');
console.info(JSON.stringify({ replayedCases: report.length, fullConversationRetained: true,
  floorMismatches, proposalsWithDroppedServerCitations: citationAblations.length,
  evidenceDirectory: out }, null, 2));
