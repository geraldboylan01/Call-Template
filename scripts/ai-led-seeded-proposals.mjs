// Offline fixture builder only. No network calls, production edits or deployment.
//
// PROVENANCE, NOT A REPRODUCTION STEP. The fixtures this writes are COMMITTED
// under scripts/fixtures/ai-led-seeded/, and the adversarial comparison reads
// them from there. You do not need to run this to reproduce anything.
//
// It is kept because it is the only record of how each seeded defect was
// derived, and it cannot run from a clean checkout: it mutates first proposals
// recorded in the paid `ai-led-comparison-main-v1` run, which lives under the
// gitignored diagnostics/ tree. Re-running it needs that run present.
// Keep test/expected/rubric/manifest OUT of provider envelopes. Inject ONLY
// seededProposal as the common first extractor response, then run the real auditor.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { FIRST20_SEMANTIC_CORPUS, FIRST20_EVAL_DATE } from './first20-semantic-corpus.mjs';
import { AI_LED_HOLDOUTS } from './ai-led-holdouts.mjs';
import { normalizeDirectSnapshot } from '../worker/src/consumer/direct_module_planner.js';
import { APPROVED_CONSUMER_MODULE_IDS } from '../worker/src/consumer/config.js';
import { buildDirectModulePolicyEnvelope } from '../js/planning/direct_module_policy.js';

const allCases = [...FIRST20_SEMANTIC_CORPUS, ...AI_LED_HOLDOUTS];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceRoot = 'diagnostics/ai-led-comparison-main-v1/r1';
const quote = (path, turnId, text) => ({ path, source: 'conversation', turnId, quote: text, profilePath: '' });

async function fromCase(caseId, seedId, mutate) {
  const test = structuredClone(allCases.find(x => x.id === caseId));
  assert.ok(test, caseId);
  const sourcePath = `${sourceRoot}/${caseId}/full_repair.json`;
  let sourceRecord;
  try {
    sourceRecord = JSON.parse(await readFile(sourcePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(
      `${sourcePath} is missing. This builder mutates first proposals recorded in the paid `
      + 'ai-led-comparison-main-v1 run, which lives under the gitignored diagnostics/ tree, so it '
      + 'cannot run from a clean checkout. The fixtures it produced are committed under '
      + 'scripts/fixtures/ai-led-seeded/ and are what the adversarial comparison reads: nothing '
      + 'needs this builder to reproduce a result.'
    );
  }
  const firstCall = sourceRecord.providerCalls[0];
  const rawText = firstCall.response.output.flatMap(x => x.content || []).find(x => x.type === 'output_text').text;
  const sourceProposal = JSON.parse(rawText);
  const seededProposal = structuredClone(sourceProposal);
  const module = seededProposal.modules.find(x => x.moduleId === test.moduleId);
  const input = JSON.parse(module.inputJson);
  const mutationDescription = mutate({ test, proposal: seededProposal, module, input });
  module.inputJson = JSON.stringify(input);
  const profile = { profileId: 'first20-synthetic', revision: 1,
    primaryPerson: { personId: 'primary', displayName: 'Aoife' },
    partner: test.partner ? { personId: 'partner', displayName: 'Ben' } : null,
    preferences: { baseCurrency: 'EUR' }, assumptions: { calculationDateIso: FIRST20_EVAL_DATE } };
  const normalized = normalizeDirectSnapshot(seededProposal, {
    acknowledgedUnknown: test.acknowledgedUnknown || [], turns: test.turns,
    throughTurnId: test.turns.at(-1).id, previousRevision: 0,
    policyEnvelope: buildDirectModulePolicyEnvelope({ calculationDateIso: FIRST20_EVAL_DATE, baseCurrency: 'EUR' }),
    currentProfileContext: profile, allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
  });
  const relevant = normalized.modules.filter(x => x.status !== 'not_relevant');
  assert.equal(relevant.length, 1);
  assert.equal(relevant[0].status, 'ready', `${seedId}: must reach the semantic verifier, not a structural repair`);
  assert.deepEqual(relevant[0].inputSupportIssues || [], []);
  assert.ok(normalized.confirmationPrompt);
  assert.notDeepEqual(sourceProposal, seededProposal);
  return {
    schemaVersion: 'AiLedSeededProposalProbeV1', id: seedId, originalCaseId: caseId,
    test, // Reuse original id for the original/holdout grader, seed id for output directories.
    seededProposal,
    manifest: { syntheticInjection: true, sourcePath, sourceRequestHash: firstCall.requestHash,
      sourceProposalHash: hash(sourceProposal), seededProposalHash: hash(seededProposal),
      sourceCallIndex: 1, sourceRepetition: 1, sourceArm: 'full_repair',
      changes: mutationDescription,
      normalizerOutcome: { status: relevant[0].status, inputSupportIssues: relevant[0].inputSupportIssues || [] },
      grading: 'The seeded first proposal is intentionally wrong. Its first independent audit must reject certification. A subsequent supported correction may certify; a genuine unresolved case must remain uncertified. Distinguish safe refusal from successful recovery. Do not pool this injected-proposal probe into the naturally sampled main corpus.',
      injection: 'All arms receive the identical seededProposal as extractor call 1. No model critique is injected. Use a zero-latency, zero-token synthetic response; mark it synthetic and keep it separate from paid/cached call totals. Then call the unchanged real verifier and recovery logic. Never place this manifest or the test expected/rubric in a provider request.' }
  };
}

async function buildAiLedSeededProposals() {
  return Promise.all([
    fromCase('mortgage-correction-hypothetical', 'seed-hypothetical-rate-promoted', ({ test, proposal, module, input }) => {
      input.annualInterestRate = 0.06;
      module.evidence = module.evidence.filter(x => x.path !== '/annualInterestRate');
      module.evidence.push(quote('/annualInterestRate', 'c2', test.turns.find(x => x.id === 'c2').transcript));
      module.steeringSummary = 'Review Aoife and Ben’s jointly held repayment mortgage using about €240,000, a 6% annual interest rate, 22 years remaining, €500 annual overpayment, no lump sum and no supplied fixed payment.';
      proposal.confirmationPrompt = 'I’ll review Aoife and Ben’s jointly held repayment mortgage using about €240,000 at 6%, with 22 years remaining, comparing €500 extra each year, with no lump sum and no fixed payment supplied. Shall I run exactly that plan?';
      return ['Promote the explicitly hypothetical 6% rate to current annualInterestRate, replacing the supported 4.1%.', 'Make steering and confirmation consistently claim the wrong 6%.', 'Replace rate evidence with a verbatim c2 turn containing the hypothetical and the instruction not to use it; no quotation is fabricated.'];
    }),
    fromCase('holdout-loan-changed-selected-borrower', 'seed-superseded-borrower-restored', ({ test, proposal, module, input }) => {
      Object.assign(input, { currentBalance: 18000, annualInterestRate: 0.085, remainingTermYears: 4, annualOverpayment: 500 });
      module.selection.reason = 'Aoife asked to review only her car loan.';
      module.steeringSummary = 'Review Aoife’s car loan only: €18,000 at 8.5%, four years remaining, €500 annual overpayment, no lump sum and no supplied fixed payment. Ben’s loan is excluded.';
      proposal.confirmationPrompt = 'I’ll review Aoife’s car loan only: €18,000 at 8.5% for four remaining years, with €500 extra each year, no lump sum and no fixed payment supplied. Ben’s loan is excluded. Shall I run exactly that plan?';
      module.evidence = ['/currentBalance', '/annualInterestRate', '/remainingTermYears', '/annualOverpayment', '/oneOffOverpayment', '/fixedPaymentAmount']
        .map(path => quote(path, 'c1', test.turns.find(x => x.id === 'c1').transcript));
      return ['Restore the abandoned Aoife loan and €500 annual overpayment after the explicit switch to Ben’s €9,000/7%/two-year/zero-overpayment loan.', 'Make selection reason, steering and confirmation consistently name the wrong selected borrower.', 'Use verbatim earlier c1 evidence only; the full later borrower-switch turn remains present in the conversation.'];
    }),
    fromCase('holdout-pbs-equal-balances-owner-swap', 'seed-equal-balances-stale-owners', ({ proposal, module, input }) => {
      const aib = input.assetPositions.find(x => x.label.includes('AIB'));
      const boi = input.assetPositions.find(x => x.label.includes('Bank of Ireland'));
      aib.id = 'aoife-aib-savings'; aib.label = "Aoife's AIB savings account";
      boi.id = 'ben-boi-savings'; boi.label = "Ben's Bank of Ireland savings account";
      module.evidence = module.evidence.filter(x => !(x.turnId === 'c3' && /\/assetPositions\/[01](?:\/|$)/.test(x.path)));
      module.steeringSummary = 'Household net worth includes Aoife’s separate AIB account of €25,000, Ben’s separate Bank of Ireland account of €25,000, a joint home of €400,000 and joint mortgage of €150,000. Monthly spending is €3,000; no other assets or debts.';
      proposal.confirmationPrompt = 'I’ll run household net worth using Aoife’s separate AIB savings of €25,000, Ben’s separate Bank of Ireland savings of €25,000, your jointly owned €400,000 home, joint mortgage of €150,000, and €3,000 monthly spending, with no other assets or debts. Shall I run exactly that plan?';
      return ['Restore the superseded account owners in IDs, labels, steering and confirmation: AIB→Aoife; Bank of Ireland→Ben.', 'Leave all balances, distinct-account cardinality, home/mortgage ownership and total net worth unchanged.', 'Remove c3 correction entries only for the two savings positions; retain verbatim old-owner/amount evidence and collection closure.'];
    }),
    fromCase('holdout-mortgage-fresh-uncertainty', 'seed-withdrawn-rate-forced-ready', ({ test, proposal, module, input }) => {
      input.annualInterestRate = 0.041;
      module.status = 'ready'; module.missing = []; module.ambiguities = [];
      proposal.generalAmbiguities = [];
      module.evidence = module.evidence.filter(x => x.path !== '/annualInterestRate');
      module.evidence.push(quote('/annualInterestRate', 'c1', test.turns.find(x => x.id === 'c1').transcript));
      module.steeringSummary = 'Review the existing repayment mortgage using the confirmed €240,000 balance, 4.1% interest rate, 22 years remaining, no overpayments and no supplied fixed payment.';
      proposal.confirmationPrompt = 'I’ll review your existing repayment mortgage using €240,000 at 4.1%, 22 years remaining, no annual or lump-sum overpayments and no fixed payment supplied. Shall I run exactly that plan?';
      return ['Restore the explicitly withdrawn old-letter rate 4.1% as a supported numeric input.', 'Force module ready and remove its missing-rate marker; make steering and confirmation state a definite rate.', 'Cite the verbatim earlier rate statement. Keep the later instruction not to use the old rate in the conversation; expected outcome remains unknown and uncertified.'];
    })
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve('scripts/fixtures/ai-led-seeded');
  await mkdir(output, { recursive: true });
  const fixtures = await buildAiLedSeededProposals();
  for (const fixture of fixtures) await writeFile(resolve(output, `${fixture.id}.json`), JSON.stringify(fixture, null, 2) + '\n');
  console.log(JSON.stringify({ output, count: fixtures.length, probes: fixtures.map(x => ({ id: x.id, originalCaseId: x.originalCaseId, normalizer: x.manifest.normalizerOutcome })) }, null, 2));
}
