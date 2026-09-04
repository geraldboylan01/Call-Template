#!/usr/bin/env node

/**
 * WHOSE IDEA EACH ANALYSIS WAS.
 *
 * THE DEFECT THIS PINS. The extractor is told "a module is relevant because the
 * client asked for that outcome". That rule is what stops selection running
 * away, and it also taught the model to narrate every selection as a client
 * request -- so a caller who said only "I'd like a financial check-up" was read
 * back "the analyses you requested throughout this conversation". Nobody asked
 * for those analyses. Telling someone they said something they did not say is
 * worse than clumsy wording: it is a false account of their own conversation,
 * and it undermines the one thing a read-back exists to establish.
 *
 * THE FIX IS A FIELD, NOT A WORDING RULE. Attribution is now carried on each
 * selected module rather than inferred from relevance, so the relevance rule
 * keeps its full force while the read-back can say "I think this would help".
 *
 * These checks are free and deterministic. Whether the MODEL attributes
 * correctly is a separate question answered by the paid planner eval; what is
 * proven here is the contract it must satisfy and everything the server does
 * with the answer.
 */
import assert from 'node:assert/strict';

import {
  DIRECT_MODULE_CONTRACTS,
  MODULE_PLANNING_SNAPSHOT_V1,
  SELECTION_ORIGINS,
  normalizeDirectSnapshot,
  directModulePlanMeaningKey
} from '../worker/src/consumer/direct_module_planner.js';
import { directModuleCandidateMeaningKey } from '../worker/src/consumer/direct_module_identity.js';
import { liveDirectModuleStateItem } from '../worker/src/consumer/live/catalogue_prompt.js';
import { directModuleTestInputs } from './live-harness/direct-fixtures.mjs';

let checks = 0;
const pass = (message) => { checks += 1; console.info(`[LivePlanAttribution] PASS: ${message}`); };
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };

const TODAY = new Date().toISOString().slice(0, 10);
const TRANSCRIPT = 'My repayment mortgage balance is 240000 euro at 4.1 percent with 22 years left.';
const MORTGAGE_INPUT = directModuleTestInputs(TODAY).mortgage_analysis;

function snapshotWith(selection, { status = 'ready' } = {}) {
  return normalizeDirectSnapshot({
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: 0,
    throughTurnId: 'turn-1',
    modules: [{
      moduleId: 'mortgage_analysis',
      outputKey: DIRECT_MODULE_CONTRACTS.mortgage_analysis.outputKey,
      status,
      ...(selection === undefined ? {} : { selection }),
      inputJson: status === 'not_relevant' ? '' : JSON.stringify(MORTGAGE_INPUT),
      steeringSummary: 'your mortgage',
      missing: [], ambiguities: [], assumptions: [],
      evidence: status === 'not_relevant' ? [] : Object.keys(MORTGAGE_INPUT).map((key) => ({
        path: `/${key}`, source: 'conversation', turnId: 'turn-1', quote: TRANSCRIPT, profilePath: ''
      }))
    }],
    generalAmbiguities: [],
    confirmationPrompt: 'Shall I run that?'
  }, {
    turns: [{ id: 'turn-1', role: 'user', transcript: TRANSCRIPT }],
    throughTurnId: 'turn-1',
    previousRevision: 0,
    currentProfileContext: {
      revision: 1,
      assumptions: { calculationDateIso: TODAY, values: {} },
      preferences: { baseCurrency: 'EUR' }
    },
    allowedModuleIds: ['mortgage_analysis']
  });
}

const selectionOf = (snapshot) => snapshot.modules.find((item) => item.moduleId === 'mortgage_analysis').selection;

/* ------------------------------------------------- the attribution contract */

for (const origin of ['client_requested', 'planeir_suggested']) {
  assert.deepEqual(
    selectionOf(snapshotWith({ origin, reason: 'because it helps' })),
    { origin, reason: 'because it helps' }
  );
  checks += 1;
}
pass('an authored attribution is carried through normalization unchanged');

// THE HUMBLER CLAIM IS THE SAFE DEFAULT. A malformed or absent attribution must
// never cost the pass, and must never invent a client request: saying "I
// suggested this" when they did ask is a small inaccuracy, while saying "you
// asked for this" when they did not is the defect this whole file exists for.
for (const bad of [undefined, null, {}, { origin: 'not_selected', reason: 'x' },
  { origin: 'invented_origin', reason: 'x' }, { origin: 'client_requested' }]) {
  const selection = selectionOf(snapshotWith(bad));
  ok(SELECTION_ORIGINS.includes(selection.origin), `attribution ${JSON.stringify(bad)} normalizes to a known origin`);
  ok(selection.origin !== 'client_requested' || bad?.origin === 'client_requested',
    `attribution ${JSON.stringify(bad)} must never be upgraded into a client request`);
}
pass('missing or malformed attribution falls back to a suggestion, never to a client request');

assert.deepEqual(selectionOf(snapshotWith({ origin: 'client_requested', reason: 'x' }, { status: 'not_relevant' })),
  { origin: 'not_selected', reason: '' });
pass('a module that was not selected carries no attribution at all');

const longReason = selectionOf(snapshotWith({ origin: 'planeir_suggested', reason: 'r'.repeat(900) })).reason;
assert.equal(longReason.length, 400);
pass('an oversized reason is bounded rather than rejected');

/* ------------------------------- attribution is NOT part of what was approved */

const requested = snapshotWith({ origin: 'client_requested', reason: 'you asked about your mortgage' });
const suggested = snapshotWith({ origin: 'planeir_suggested', reason: 'it would show your options' });
assert.equal(
  directModuleCandidateMeaningKey(requested),
  directModuleCandidateMeaningKey(suggested)
);
pass('changing only attribution does not change plan identity, so a live offer survives it');

// The guard above is only meaningful if the key still moves on a real change.
const corrected = snapshotWith({ origin: 'client_requested', reason: 'you asked about your mortgage' });
corrected.modules[0].input = { ...corrected.modules[0].input, currentBalance: 238000 };
assert.notEqual(directModuleCandidateMeaningKey(corrected), directModuleCandidateMeaningKey(requested));
pass('a corrected figure still changes plan identity and still supersedes the offer');

const certificate = {
  version: 2, verdict: 'pass', profileRevision: 1, moduleContractVersions: {}, playbookVersion: 'p',
  policyVersion: 'v', policyHash: 'h', assumptionsVersion: 'a', irelandRulesVersion: 'i',
  calculationDateIso: TODAY, baseCurrency: 'EUR', extractorPromptVersion: 'e', verifierPromptVersion: 'v', model: 'm'
};
assert.equal(
  directModulePlanMeaningKey(requested, certificate),
  directModulePlanMeaningKey(suggested, certificate)
);
pass('the signed plan identity is likewise indifferent to attribution');

/* ----------------------------------------- what the meeting is actually told */

const volatile = liveDirectModuleStateItem({
  schemaVersion: 'MeetingBriefV3',
  snapshotRevision: 1,
  readyToConfirm: false,
  directModuleSnapshot: {
    modules: [
      { moduleId: 'mortgage_analysis', status: 'ready', steeringSummary: 'your mortgage',
        selection: { origin: 'client_requested', reason: 'you asked about your mortgage' },
        missing: [], ambiguities: [] },
      { moduleId: 'liquidity_analysis', status: 'ready', steeringSummary: 'your cash',
        selection: { origin: 'planeir_suggested', reason: 'it would show how long your savings last' },
        missing: [], ambiguities: [] }
    ],
    generalAmbiguities: []
  }
});
ok(volatile.includes('client_requested') && volatile.includes('planeir_suggested'),
  'both origins reach the meeting');
ok(volatile.includes('it would show how long your savings last'),
  'the reason a suggestion helps reaches the meeting, so it can be spoken');
ok(/Never tell the client they asked for, requested or wanted one of those/.test(volatile),
  'the meeting is told, in the same item, that a suggestion may not be spoken as a request');
pass('the live state item carries attribution and the rule for speaking it');

/* --------------------------- the model contract that produces all the above */

const planner = await import('../worker/src/consumer/direct_module_planner.js');
const source = planner.EXTRACTOR_PROMPT;
ok(/selection\.origin/.test(source) && /client_requested ONLY when/.test(source),
  'the extractor is told when a selection may be called a client request');
ok(/a general request is NOT a request for each specific analysis/.test(source),
  'the extractor is told that a broad check-up does not make each analysis client-requested');
ok(/Never say the client asked for, requested, or wanted an analysis whose selection\.origin is planeir_suggested/.test(source),
  'the extractor is told how the read-back must attribute a suggestion');
ok(/relevant because the client asked for that outcome/.test(source),
  'the relevance rule that bounds selection is retained, not traded away for wording');

const verifier = planner.VERIFIER_PROMPT;
ok(/broad review request does not make each analysis selected under it client_requested/.test(verifier),
  'the verifier independently audits the same attribution rule');
ok(/misattribution as a non-pass/.test(verifier),
  'misattribution blocks certification rather than being reported and ignored');
pass('the extractor and verifier both carry the attribution contract');


/* ---------------------------------- read-back brevity and readiness narration */

// A read-back is heard once, in one pass, with no way to scroll back. The
// contract asks for concision from cutting repetition and internal wording --
// never from dropping a figure the client is being asked to check, which would
// trade a verified behaviour for a nicer sentence.
ok(/roughly sixty to ninety spoken words/.test(source),
  'the extractor is given a spoken-length target for the read-back');
ok(/Never drop or blur a MATERIAL client-authored figure, owner or assumption to hit that/.test(source),
  'brevity may never be bought by omitting what the client must check');
ok(/no supplied fixed payment/.test(source),
  'the extractor is told to leave internal wording out of speech');

const livePrompt = (await import('../worker/src/consumer/live/catalogue_prompt.js'))
  .buildLiveCataloguePrompt({ directModulePlanning: true });
const stateItem = liveDirectModuleStateItem({
  schemaVersion: 'MeetingBriefV3', snapshotRevision: 1, readyToConfirm: false,
  directModuleSnapshot: { modules: [], generalAmbiguities: [] }
});
ok(/Do not narrate readiness before it exists/.test(stateItem),
  'the meeting is told not to announce readiness it does not have');
ok(/just one more detail/.test(stateItem),
  'the specific broken promise from the reviewed call is named');
ok(livePrompt.length > 0, 'the live prompt still builds with the added guidance');
pass('the read-back is asked to be short without losing anything the client must check');

console.info(`[LivePlanAttribution] ${checks} checks passed.`);
