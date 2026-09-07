import assert from 'node:assert/strict';
import { interpretDirectModuleConversation } from '../worker/src/consumer/direct_module_planner.js';
import { sanitizeRealtimeEventPayload } from '../worker/src/consumer/realtime_event_schema.js';

const originalFetch = globalThis.fetch;
const config = { allowedModules: ['mortgage_analysis'], modulePlannerModel: 'synthetic-model',
  modulePlannerReasoningEffort: 'low', modulePlannerTimeoutMs: 15,
  modulePlannerPromptVersion: 'synthetic-extractor', moduleVerifierPromptVersion: 'synthetic-verifier' };
const run = () => interpretDirectModuleConversation({
  env: { OPENAI_API_KEY: 'synthetic-credential-never-log' }, config,
  turns: [{ id: 'c1', role: 'user', transcript: 'Invented private financial details must not enter diagnostics.' }],
  throughTurnId: 'c1', currentProfileContext: { revision: 1, preferences: { baseCurrency: 'EUR' },
    assumptions: { calculationDateIso: '2026-09-05' } }
});
let checks = 0;
async function fails(code, status) {
  await assert.rejects(run(), (error) => {
    assert.equal(error.code, code);
    const d = error.plannerDiagnostics;
    assert.equal(d.plannerStage, 'extractor');
    assert.equal(d.promptVersion, 'synthetic-extractor');
    assert.equal(d.providerStatus, status);
    assert.match(d.clientRequestId, /^[0-9a-f-]{36}$/);
    assert.ok(d.latencyMs >= 0);
    const record = sanitizeRealtimeEventPayload('live.modules.planning_failed', {
      ...d, code, transcript: 'private', providerErrorMessage: 'private', apiKey: 'private'
    });
    assert.equal(record.plannerStage, 'extractor');
    assert.equal(record.providerStatus, status);
    assert.ok(!JSON.stringify(record).includes('private'));
    assert.ok(!JSON.stringify(error).includes('synthetic-credential-never-log'));
    return true;
  });
  checks += 1;
}
try {
  for (const status of [401, 429, 500]) {
    globalThis.fetch = async () => new Response('Sensitive provider body is never copied', {
      status, headers: { 'x-request-id': `req_synthetic_${status}` }
    });
    await fails('module_planner_request_failed', status);
  }
  globalThis.fetch = async () => { throw new Error('private network error'); };
  await fails('module_planner_unavailable', null);
  globalThis.fetch = async () => new Response('not JSON', { status: 200 });
  await fails('module_planner_response_invalid', 200);
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'incomplete' }), { status: 200 });
  await fails('module_planner_incomplete', 200);
  globalThis.fetch = async (_url, { signal }) => ({
    ok: true, status: 200,
    json: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ status: 'incomplete' }), 200);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('synthetic aborted body', 'AbortError'));
      }, { once: true });
    })
  });
  await fails('module_planner_timeout', 200);
  console.info(`[First20PlannerDiagnostics] ${checks} provider-boundary and privacy checks passed; no provider calls.`);
} finally { globalThis.fetch = originalFetch; }
