#!/usr/bin/env node

/**
 * "YEAH, AROUND THAT" IS AN ANSWER. "I THINK SO" IS NOT.
 *
 * THE BEHAVIOUR THIS PROTECTS. A client who is read "your PRSA is about
 * €28,000 -- is that right?" and answers "yeah, around that" has told you the
 * figure. Making them repeat the number to be understood is the single most
 * irritating thing a listener can do, and it is what produced the repeated
 * questions in the call this work came from.
 *
 * WHERE IT IS DECIDED, AND WHERE IT IS NOT. Production runs the direct planner
 * lane, where `save_facts` is not even offered to the meeting -- see
 * `toolsForDirectModulePlanning`. Module inputs come from the background
 * semantic planner, which reads adviser and client turns alike. So this is a
 * question of what that planner is TOLD, not of a phrase list at a tool
 * boundary, and the deterministic evidence-affirmation component keeps the
 * behaviour Phase 1 froze.
 *
 * WHAT MAKES IT SAFE. The value is cited from the adviser turn that carries the
 * number, and that turn is only allowed to carry it because the L2
 * `unsourced_figure` tripwire stops the adviser speaking a figure the client
 * never gave. The cited quote must occur exactly once in the stored turn, so a
 * turn that never said those words supports nothing and the module falls back to
 * asking. A model cannot mint a figure by inventing what was read back.
 *
 * NOTE WHAT THE SERVER DOES *NOT* CHECK: that the quote contains the number.
 * It must not. The same provenance rule carries every inferred value in the
 * system -- "4.1 percent" supports 0.041, "twenty two years" supports 22 -- and
 * numeric containment would reject all of them. Whether the quoted words really
 * establish the value is semantic, and belongs to the independent verifier.
 *
 * WHAT IS PROVEN HERE is the server half: citation across turns resolves, a
 * false citation is refused, and both prompts carry the rule. Whether the model
 * distinguishes agreement from doubt is model quality, measured by the paid
 * planner eval.
 */
import assert from 'node:assert/strict';

import {
  DIRECT_MODULE_CONTRACTS,
  EXTRACTOR_PROMPT,
  MODULE_PLANNING_SNAPSHOT_V1,
  VERIFIER_PROMPT,
  normalizeDirectSnapshot
} from '../worker/src/consumer/direct_module_planner.js';
import { createSourcedFigureSet, addSourcedFiguresFromText, scanAssistantSpeech } from '../worker/src/consumer/live/compliance.js';
import { directModuleTestInputs } from './live-harness/direct-fixtures.mjs';

let checks = 0;
const pass = (message) => { checks += 1; console.info(`[LiveAnaphoricEvidence] PASS: ${message}`); };
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };

const TODAY = new Date().toISOString().slice(0, 10);
const INPUT = directModuleTestInputs(TODAY).mortgage_analysis;

// The exchange this file is about: the client gives the figure once, the adviser
// reads it back, and the client agrees without repeating the number.
const CLIENT_STATES = 'It is a repayment mortgage, 4.1 percent, 22 years left.';
const ADVISER_READS_BACK = 'So the balance is about 240000 euro on that repayment mortgage — is that right?';
const CLIENT_AGREES = 'Yeah, around that.';
const TURNS = [
  { id: 'turn-client-1', role: 'user', transcript: CLIENT_STATES },
  { id: 'turn-adviser-1', role: 'assistant', transcript: ADVISER_READS_BACK },
  { id: 'turn-client-2', role: 'user', transcript: CLIENT_AGREES }
];

function snapshot({ balanceEvidence }) {
  return normalizeDirectSnapshot({
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: 0,
    throughTurnId: 'turn-client-2',
    modules: [{
      moduleId: 'mortgage_analysis',
      outputKey: DIRECT_MODULE_CONTRACTS.mortgage_analysis.outputKey,
      status: 'ready',
      selection: { origin: 'client_requested', reason: 'you asked about your mortgage' },
      inputJson: JSON.stringify(INPUT),
      steeringSummary: 'your repayment mortgage',
      missing: [], ambiguities: [], assumptions: [],
      evidence: Object.keys(INPUT).map((key) => (key === 'currentBalance'
        ? balanceEvidence
        : { path: `/${key}`, source: 'conversation', turnId: 'turn-client-1', quote: CLIENT_STATES, profilePath: '' }))
    }],
    generalAmbiguities: [],
    confirmationPrompt: 'Shall I run that?'
  }, {
    turns: TURNS,
    throughTurnId: 'turn-client-2',
    previousRevision: 0,
    currentProfileContext: {
      revision: 1,
      assumptions: { calculationDateIso: TODAY, values: {} },
      preferences: { baseCurrency: 'EUR' }
    },
    allowedModuleIds: ['mortgage_analysis']
  });
}
const mortgageIn = (result) => result.modules.find((item) => item.moduleId === 'mortgage_analysis');

/* ----------------------------- the figure survives without being repeated */

const carried = mortgageIn(snapshot({
  balanceEvidence: {
    path: '/currentBalance', source: 'conversation',
    turnId: 'turn-adviser-1', quote: ADVISER_READS_BACK, profilePath: ''
  }
}));
assert.equal(carried.status, 'ready');
assert.equal(carried.input.currentBalance, 240000);
pass('a figure the client agreed to without repeating is carried by citing the adviser turn that stated it');

/* ------------------------- either honest citation is accepted, by design */

// Citing the client's agreement itself is equally acceptable. The server does
// NOT require the quote to contain the number, and must not: the same rule
// carries every inferred value in the system -- "4.1 percent" supports 0.041,
// "twenty two years" supports 22, a described status supports a category. A
// numeric-containment rule here would reject all of those. What the quote
// establishes semantically is the verifier's job, audited against the whole
// conversation; what the SERVER guarantees is that the cited words were really
// said, in the turn named, exactly once.
const citedAgreement = mortgageIn(snapshot({
  balanceEvidence: {
    path: '/currentBalance', source: 'conversation',
    turnId: 'turn-client-2', quote: CLIENT_AGREES, profilePath: ''
  }
}));
assert.equal(citedAgreement.status, 'ready');
assert.equal(citedAgreement.input.currentBalance, 240000);
pass('citing the agreement turn is equally valid: support is not numeric containment, or no inferred value could ever be supported');

/* ------------------------------------ a citation that is not true is refused */

// The claim that closes the loop. A quote the named turn does not contain
// resolves to nothing, the leaf becomes uncovered, and the module is downgraded
// to asking rather than running on an unsupported value.
const misquoted = mortgageIn(snapshot({
  balanceEvidence: {
    path: '/currentBalance', source: 'conversation',
    turnId: 'turn-adviser-1', quote: 'So the balance is about 250000 euro', profilePath: ''
  }
}));
ok(misquoted.status !== 'ready',
  'a quote the cited turn does not contain must not be runnable');
ok((misquoted.missing || []).some((item) => item.path === '/currentBalance'),
  'the unsupported figure becomes an open question rather than a silent default');
pass('a figure cannot be minted by claiming it was read back; the cited words must really be there');

const unknownTurn = mortgageIn(snapshot({
  balanceEvidence: {
    path: '/currentBalance', source: 'conversation',
    turnId: 'turn-that-never-happened', quote: ADVISER_READS_BACK, profilePath: ''
  }
}));
ok(unknownTurn.status !== 'ready', 'a citation to a turn outside the window supports nothing');
pass('an unresolvable turn reference is refused as firmly as a misquote');

/* ------------------------- the adviser could only say it because the client did */

// The loop is closed by the compliance tripwire, not by trust: an adviser turn
// may only carry a figure the client already sourced. Without that, citing
// adviser speech would let the lane launder an invented number.
const sourced = createSourcedFigureSet();
addSourcedFiguresFromText(sourced, 'My mortgage balance is 240000 euro.');
ok(!scanAssistantSpeech(ADVISER_READS_BACK, sourced).tripped,
  'the adviser may read back a figure the client sourced');
const unsourced = scanAssistantSpeech(ADVISER_READS_BACK, createSourcedFigureSet());
ok(unsourced.tripped && unsourced.actId === 'unsourced_figure',
  'the adviser may NOT state a figure the client never gave, so there is nothing to cite');
pass('adviser-turn citation is safe because unsourced adviser figures are cancelled before they are spoken');

/* --------------------------------------------- the contract the model is given */

ok(/AN ANSWER THAT POINTS BACK AT A FIGURE IS AN ANSWER/.test(EXTRACTOR_PROMPT),
  'the extractor is told that an anaphoric agreement establishes the figure');
for (const phrase of ['around that', 'roughly', "that's right"]) {
  ok(EXTRACTOR_PROMPT.includes(phrase), `the extractor is given the shape "${phrase}"`);
}
ok(/AN ANSWER THAT IS STILL UNSURE IS NOT AN ANSWER/.test(EXTRACTOR_PROMPT),
  'the extractor is told that doubt is not agreement');
for (const hedge of ['I think so', 'probably', "I'd have to check"]) {
  ok(EXTRACTOR_PROMPT.includes(hedge), `the extractor is given the hedge "${hedge}"`);
}
ok(/an approximate agreement is confident about a rounded number, while a hedged one is not confident that the number is right at all/.test(EXTRACTOR_PROMPT),
  'the extractor is told WHY the two differ, not only which words fall on each side');
ok(/the cited adviser turn must actually contain that figure, and the client's words must be agreement rather than doubt/.test(VERIFIER_PROMPT),
  'the verifier independently audits both halves of an anaphoric answer');
pass('both prompts carry the agreement-versus-doubt contract');

/* ------------------------- Phase 1 froze the other lane; it must stay frozen */

const { classifyEvidenceAffirmation } = await import('../worker/src/consumer/live/evidence_affirmation.js');
const { classifySpokenPlanConfirmation } = await import('../worker/src/consumer/realtime_completion.js');
for (const said of ['Yes', 'that sounds good', 'yeah, around that', 'I think so', 'roughly', 'No']) {
  assert.equal(classifyEvidenceAffirmation(said), classifySpokenPlanConfirmation(said),
    `evidence affirmation must still behave exactly as Phase 1 froze it for "${said}"`);
  checks += 1;
}
pass('the deterministic evidence-affirmation boundary is unchanged: meaning moved to the planner, not to a bigger phrase list');

console.info(`[LiveAnaphoricEvidence] ${checks} checks passed.`);
