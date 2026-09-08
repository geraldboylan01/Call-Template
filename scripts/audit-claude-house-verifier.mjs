// Independent audit only. Offline capture by default; --paid sends synthetic
// verifier-only requests with the existing approved key. Never executes a module.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { interpretDirectModuleConversation } from '../worker/src/consumer/direct_module_planner.js';
import { FIRST20_EVAL_DATE } from './first20-semantic-corpus.mjs';

// Each invocation preserves earlier evidence, including paid responses.
const directory = process.env.HOUSE_AUDIT_OUTPUT_DIR || `diagnostics/claude-review/house-verifier-${process.argv.includes('--paid') ? 'paid' : 'offline'}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(directory, { recursive: true });
const record = JSON.parse(await readFile('diagnostics/first20/paid-v10c-r2b/house-joint-cash-ringfence-unknown-schemes.json', 'utf8'));
const { config } = JSON.parse(await readFile('diagnostics/first20/paid-v10c-r2b/summary.json', 'utf8'));
const networkFetch = globalThis.fetch;
const requests = [];
let index = 0;
globalThis.fetch = async (_url, init) => {
  requests.push(JSON.parse(init.body));
  const archived = record.providerCalls[index++];
  assert.ok(archived);
  return new Response(JSON.stringify(archived.response), { status: archived.httpStatus });
};
try {
  await interpretDirectModuleConversation({
    env: { OPENAI_API_KEY: 'offline-no-network', CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url') },
    config, turns: record.turns, throughTurnId: record.turns.at(-1).id,
    currentProfileContext: { profileId: 'first20-synthetic', revision: 1,
      primaryPerson: { personId: 'primary', displayName: 'Aoife' },
      partner: { personId: 'partner', displayName: 'Ben' },
      preferences: { baseCurrency: 'EUR' }, assumptions: { calculationDateIso: FIRST20_EVAL_DATE } },
    acknowledgedUnknown: record.acknowledgedUnknown || []
  });
} finally { globalThis.fetch = networkFetch; }
assert.equal(index, record.providerCalls.length);
const template = requests.filter(item => item.text.format.name === 'module_input_verification_v1').at(-1);
assert.ok(template);
const complete = 'Shall I run your joint first-home purchase plan for Aoife, 34, and Ben, 35, using respective gross incomes of €68,000 and €52,000 and separately owned savings of €40,000 and €30,000? I will protect €10,000 for your other goal plus a separate suggested emergency reserve, and use €1,800 monthly saving, €6,900 monthly take-home income, €2,700 essential spending excluding rent and debts, €2,100 rent and €200 ownership costs. The target is a €410,000 second-hand Dublin City main home in June 2028. You have no debts, other commitments, dependants or expected lump sums, no AIP or lender amount, no confirmed Help to Buy claim, and have not applied for the First Home Scheme or confirmed any equity; the stated Help to Buy eligibility facts remain unknown. I will assume 2% gross deposit interest, 33% DIRT and a 3.5% mortgage illustration over 35 years, with purchase-cost allowances of €3,200 legal and conveyancing, €200 valuation, €600 survey, €5,000 moving and furnishing, and €2,500 contingency; stamp duty follows the server rules. Shall I run exactly this plan?';
const variants = ['original', 'complete', 'missing_costs', 'stale_price'];
const metadata = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(), syntheticOnly: true,
  scope: 'Verifier-only controlled probe; no certificate, execution, production turn-budget test, or transport test',
  completeReadbackWords: complete.split(/\s+/).length,
  systemPromptHash: createHash('sha256').update(template.input[0].content).digest('hex'), cases: [] };
for (let repetition = 1; repetition <= 2; repetition++) {
  // Alternate order to avoid grouping each variant by time.
  for (const variant of repetition === 1 ? variants : [...variants].reverse()) {
    const request = structuredClone(template);
    const body = JSON.parse(request.input[1].content);
    if (variant !== 'original') body.proposedSnapshot.confirmationPrompt = complete;
    if (variant === 'missing_costs') body.proposedSnapshot.confirmationPrompt = complete.replace('€3,200 legal and conveyancing, €200 valuation, €600 survey, €5,000 moving and furnishing, and €2,500 contingency', 'the standard purchase costs');
    if (variant === 'stale_price') {
      body.proposedSnapshot.confirmationPrompt = complete.replace('€410,000', '€420,000');
      body.proposedSnapshot.modules.find(item => item.moduleId === 'house_purchase').input.targetPropertyPrice = 420000;
    }
    request.input[1].content = JSON.stringify(body);
    const id = `${variant}-${repetition}`;
    const output = { id, request, requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex') };
    if (process.argv.includes('--paid')) {
      assert.ok(process.env.OPENAI_API_KEY, 'Approved existing key required');
      const start = Date.now();
      try {
        const response = await networkFetch('https://api.openai.com/v1/responses', {
          method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(request), signal: AbortSignal.timeout(30000)
        });
        output.httpStatus = response.status;
        output.response = await response.json();
        const value = output.response.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
        output.verification = value ? JSON.parse(value) : null;
      } catch (error) { output.error = { name: error.name }; }
      output.elapsedMs = Date.now() - start;
    }
    await writeFile(`${directory}/${id}.json`, JSON.stringify(output, null, 2) + '\n');
    metadata.cases.push({ id, elapsedMs: output.elapsedMs, httpStatus: output.httpStatus,
      verdict: output.verification?.verdict, approved: output.verification?.confirmationPromptApproved,
      error: output.error, usage: output.response?.usage, explanation: output.verification?.explanation });
    await writeFile(`${directory}/summary.json`, JSON.stringify(metadata, null, 2) + '\n');
    console.log(JSON.stringify(metadata.cases.at(-1)));
  }
}
