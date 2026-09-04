#!/usr/bin/env node

/**
 * PROPOSING A CHECK, WITHOUT PROPOSING A FINANCIAL ACTION.
 *
 * WHY THIS EXISTS. A compliance trip on a live response sends `response.cancel`
 * to the provider: the assistant is cut off mid-sentence, corrected, and made
 * to start again. That is the right behaviour for a real recommendation and a
 * bad experience for anything else, so which sentences trip matters to the
 * conversation as much as to the regulator.
 *
 * The detector keys on a recommendation VERB sharing a clause with a financial
 * OBJECT. "I'd suggest a mortgage review" therefore trips while the equivalent
 * "I could run a mortgage check for you" does not -- the discriminator is the
 * verb, not the meaning. Rather than widen the filter to admit more phrasings,
 * the prompt teaches the shapes that already pass. This file pins both halves:
 * the taught shapes must stay speakable, and action recommendations must stay
 * blocked. Neither may drift without the other being reconsidered.
 *
 * A DEFECT FOUND WHILE WRITING IT. Several FINANCIAL_OBJECT entries were bare
 * stems inside a word-boundary alternation, so `consolidat` and `contribut`
 * could never match any real English word. "I recommend consolidating your
 * loans" was a recommendation verb with no detectable object and passed as
 * ordinary speech. The stems are inflected now, and the cases below are the
 * regression.
 */
import assert from 'node:assert/strict';

import { createSourcedFigureSet, scanAssistantSpeech } from '../worker/src/consumer/live/compliance.js';
import { buildLiveCataloguePrompt } from '../worker/src/consumer/live/catalogue_prompt.js';

let checks = 0;
const figures = createSourcedFigureSet();
const speakable = (text) => !scanAssistantSpeech(text, figures).tripped;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}

/* ------------------------------------- the shapes the prompt actually teaches */

// Every proposal the model is told to use must survive the detector unchanged.
// If one stops passing, the prompt is teaching a sentence that gets cancelled
// mid-word, and the fix belongs here rather than in a looser filter.
const TAUGHT_PROPOSALS = [
  'I could run a mortgage check for you, if that would help.',
  'I think a cash-reserve check would show how long your savings would last.',
  'It might be useful to look at your pension position.',
  'Would it help if I looked at your mortgage alongside that?',
  'Shall I include a pension projection as well?'
];
const prompt = buildLiveCataloguePrompt({ directModulePlanning: true });
for (const proposal of TAUGHT_PROPOSALS) {
  ok(speakable(proposal), `a taught proposal must be speakable: ${proposal}`);
  ok(prompt.includes(proposal), `the prompt must actually teach: ${proposal}`);
}
console.info(`[LiveProposalSpeech] PASS: ${TAUGHT_PROPOSALS.length} taught proposals are speakable and present in the prompt.`);

// Wider natural phrasings the model may reach for on its own.
for (const proposal of [
  'One thing I could look at is how your savings compare with your spending.',
  'There is a mortgage comparison I can run, if you want to see it.',
  'I can also map out what your college costs would look like.',
  'Another useful view would be your overall balance sheet.',
  'That would be worth looking at, if you would like.',
  'I cannot tell you whether to overpay, but I can show you both paths.',
  'What is your mortgage balance?'
]) {
  ok(speakable(proposal), `ordinary offer must stay speakable: ${proposal}`);
}
console.info('[LiveProposalSpeech] PASS: ordinary offers to look at something are not recommendations.');

/* ------------------------------------------- what must still be cut off mid-word */

// Proposing an ACTION with the client's money. Each of these must trip, and the
// first four are the inflection defect: before the fix they passed silently.
const PROHIBITED = [
  'I recommend consolidating your loans.',
  'You should be contributing more to your pension.',
  "I'd suggest switching providers.",
  'You should consider overpaying your mortgage.',
  'I would recommend topping up your AVCs.',
  'You need to consolidate those loans.',
  "I'd suggest you overpay your mortgage.",
  'You should switch your pension fund.',
  'Your best option is to invest the lump sum.',
  'I would recommend the second pension product.'
];
for (const speech of PROHIBITED) {
  const verdict = scanAssistantSpeech(speech, figures);
  ok(verdict.tripped, `an action recommendation must still be refused: ${speech}`);
  ok(verdict.actId === 'recommendation', `${speech} must be refused AS a recommendation`);
}
console.info(`[LiveProposalSpeech] PASS: ${PROHIBITED.length} action recommendations remain blocked, including the inflected stems.`);

// The prompt must not teach the two lead-ins that read as action recommendations.
ok(/Do NOT open a proposal with "I'd suggest" or "I'd recommend"/.test(prompt),
  'the prompt must warn off the lead-ins that trip the detector');
ok(/Proposing to LOOK at something is always allowed; proposing that/.test(prompt),
  'the prompt must state the object test, not merely list phrasings');
console.info('[LiveProposalSpeech] PASS: the prompt teaches the rule, not only the examples.');

console.info(`[LiveProposalSpeech] ${checks} checks passed.`);
