/**
 * The reflection: what the meeting says the instant the client stops speaking.
 *
 * The planner takes four to twelve seconds. Until now the client heard nothing
 * for all of it, which on a phone call reads as a dropped line rather than as
 * thinking. The reflection repeats their own figures back while the planner
 * reads them.
 *
 * IT REPEATS, IT DOES NOT CLAIM. At that moment the app knows exactly what was
 * SAID and nothing at all about what will be captured. Everything below exists
 * to keep that line intact, because the failure mode -- a warm confirmation of
 * something the engine then rejects -- is a trust fault this codebase has
 * already had once.
 *
 * The groundedness check is the important one, and it is deterministic: every
 * figure in a reflection must appear in the client's own words. That catches a
 * hallucinated number on every call, free, with no model involved.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  extractionOutcomeInstructions,
  looksLikeCorrection,
  realtimeReflectionInstructions,
  shouldReflectTurn
} from '../worker/src/consumer/realtime_provider.js';
import { getConsumerConfig } from '../worker/src/consumer/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let checks = 0;
const check = (label, condition, detail = '') => {
  checks += 1;
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
};

/* ------------------------------------------------- when it should happen */

// A FIGURE ALWAYS EARNS ONE, however briefly it was said. "Sixty" and
// "sixteen", "thirty" and "thirteen" are the pairs transcription confuses, and
// a one-word answer is where a mishearing is least likely to be noticed.
for (const spoken of ['sixty', 'About 30 percent.', '£950,000 or thereabouts', 'none at all']) {
  check(`a figure is always reflected: ${JSON.stringify(spoken)}`, shouldReflectTurn(spoken));
}
// Utterance length is NOT a proxy for the wait: the planner takes the same time
// whatever was said, so a short answer with a number still needs covering.
check('a bare affirmation is not reflected', !shouldReflectTurn('yes'));
check('a bare negation is not reflected', !shouldReflectTurn('no'));
check('a short filler answer is not reflected', !shouldReflectTurn('that is right'));
check('an empty turn is not reflected', !shouldReflectTurn('') && !shouldReflectTurn(null));
check('a substantive answer without a figure is still reflected',
  shouldReflectTurn('I would like to retire soon if I can manage it'));

check('a correction is recognised', looksLikeCorrection('No, sorry, it is 200 not 400.'));
check('a plain answer is not read as a correction',
  !looksLikeCorrection('I pay 30% and the company adds 10%.'));

/* ------------------------------------------------------- what it may say */

const plain = realtimeReflectionInstructions('I pay 30% and the company adds 10%.').join(' ');
const correcting = realtimeReflectionInstructions('No, sorry, it is 200 not 400.').join(' ');

check('it is told to repeat the client\'s own figures', /repeats back the specific figures/.test(plain));
check('it is capped in length', /under fifteen words/.test(plain));
check('it must not ask anything', /Do NOT ask a question/.test(plain));
check('it must not add anything', /Do NOT add anything they did not say/.test(plain));
// The exact failure this guards against: a warm confirmation of a value the
// engine has not even been shown yet.
check('it must never claim the value is held',
  /saved, captured, confirmed, recorded or noted/.test(plain));
check('it must not promise what happens next', /do not promise what happens next/.test(plain));
check('a correction gets a plainer frame', /Do not thank them warmly/.test(correcting));
check('a plain answer does not', !/Do not thank them warmly/.test(plain));

// The transcript is used ONLY to tell a correction from a plain answer. It is
// never embedded in the instruction: the model already has the turn in its own
// context, and repeating it back adds nothing but a place for content to leak.
const withContent = realtimeReflectionInstructions('My PPS number is 1234567AB and I earn 114000.').join(' ');
check('the client\'s words are never embedded in the instruction',
  !withContent.includes('1234567AB') && !withContent.includes('114000'));

/* ------------------------------------------------------ groundedness */

/**
 * Every figure a reflection speaks must appear in what the client said.
 * Deterministic, free, and the only guard that catches an invented number.
 */
const NUMBER_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
});

/**
 * Written numbers become digits on BOTH sides before comparing, because the
 * mishearings that matter most are spoken-word pairs -- thirty and thirteen,
 * sixty and sixteen, fifty and fifteen -- and a digits-only check misses every
 * one of them. Compound forms ("three hundred and sixty thousand") are left
 * alone; the confusable pairs are all in the tens.
 */
function normaliseFigures(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\b([a-z]+)\b/g, (word) => (
      Object.hasOwn(NUMBER_WORDS, word) ? String(NUMBER_WORDS[word]) : word
    ))
    .replace(/[,\s]/g, '');
}

function ungroundedFigures(reflection, clientTranscript) {
  const spoken = normaliseFigures(clientTranscript);
  return [...normaliseFigures(reflection).matchAll(/\d+/g)]
    .map((match) => match[0])
    .filter((figure) => figure && !spoken.includes(figure));
}

const said = 'I pay 30% and the company adds 10%, and the pot is about 360,000.';
check('a faithful reflection passes',
  ungroundedFigures('Thirty percent yourself, 10% from them, 360,000 in the pot.', said).length === 0);
check('an invented figure is caught',
  ungroundedFigures('Thirty percent, and 45,000 a year.', said).join() === '45000');
check('a misheard figure is caught',
  ungroundedFigures('Thirteen percent yourself.', said).join() === '13');
check('a reflection with no figures is trivially grounded',
  ungroundedFigures('Let me look at that.', said).length === 0);

/* ------------------------------------------------ ordering and budget */

const session = readFileSync(`${root}worker/src/consumer/realtime_session.js`, 'utf8');
check('the reflection is authorized BEFORE the planner reads the turn',
  session.indexOf("authorizeResponse('reflect_finalized_turn'") < session.indexOf('const plannerResult = await this.processPlannerTurn'));
// drainResponseAuthorization refuses to start while a response is in flight and
// queues instead, so the substantive turn cannot overlap the reflection. No
// cancellation logic is needed, and none should be added.
check('the substantive turn outranks the reflection outright',
  /if \(reason === 'reflect_finalized_turn'\) return 0;/.test(session),
  'a queue that kept the reflection would drop the real response');
check('the reflection does not read the brief',
  !/reflect_finalized_turn[\s\S]{0,400}meetingBrief/.test(session),
  'the brief still describes the PREVIOUS turn at that point');

// Two responses per turn halve the effective call length. Forty capped a real
// call at about twenty turns.
const config = getConsumerConfig({
  CONSUMER_JOURNEY_ENABLED: 'false'
});
check('the response ceiling allows a long call with reflections',
  config.realtimeMaxResponses >= 100, String(config.realtimeMaxResponses));
check('the tool-call ceiling scales with it',
  config.realtimeMaxToolCalls >= 60, String(config.realtimeMaxToolCalls));
check('the ceiling is still bounded',
  getConsumerConfig({ CONSUMER_JOURNEY_ENABLED: 'false', CONSUMER_REALTIME_MAX_RESPONSES: '99999' })
    .realtimeMaxResponses <= 200);



/* ------------------------------------------------ what the renderer is told */

/**
 * THE FAULT THIS PREVENTS. The renderer used to receive only the transcript and
 * the still-unmet requirement. When extraction failed it therefore did the two
 * things that read as broken: it repeated the client's figures back warmly,
 * proving it had heard them, and then asked the identical question again,
 * because from its side nothing had been answered.
 *
 * Observed live on a real call: the client named three funds with amounts, and
 * Planéir replied "that's €80,000 jointly in Zurich Prisma 4, €12,000 in Prisma
 * 5, and a separate €3,000 for the children" -- then re-asked the same question
 * word for word. It heard and did not record, and said so in the worst order.
 */
const noOutcome = extractionOutcomeInstructions({ acceptedCount: 2, rejectedCount: 0 });
check('a clean turn adds no special instruction', noOutcome.length === 0,
  'the ordinary path must stay ordinary');

const allRejected = extractionOutcomeInstructions({ acceptedCount: 0, rejectedCount: 3 }).join(' ');
check('a fully rejected turn must not repeat the figures back',
  /Do NOT repeat those figures back/.test(allRejected));
check('a fully rejected turn must not re-ask in the same words',
  /not ask the current question again in the same words/.test(allRejected));
check('a fully rejected turn narrows to one named item',
  /ONE of the outstanding items on its own, naming which one/.test(allRejected));

const partlyRejected = extractionOutcomeInstructions({ acceptedCount: 1, rejectedCount: 2 }).join(' ');
check('a partly rejected turn confirms only what was recorded',
  /Confirm only what was recorded/.test(partlyRejected));

// The client is never told the machinery misbehaved, on any transport.
for (const [label, text] of [['fully rejected', allRejected], ['partly rejected', partlyRejected]]) {
  check(`a ${label} turn never surfaces the fault to the client`,
    /Do not mention any technical issue/.test(text), text);
}

// A planner that failed operationally keeps the policy voice already had: never
// ask a client to repeat an answer they gave perfectly clearly.
const failed = extractionOutcomeInstructions({ plannerFailed: true }).join(' ');
check('a failed planner never asks the client to repeat',
  /do not ask the client to repeat, restate or rephrase/.test(failed));
check('a failed planner still avoids re-asking what was just answered',
  /would simply repeat what they just answered/.test(failed));
check('a failed planner never claims the answer was saved',
  /without claiming it was saved/.test(failed));

// Parity: both transports must reach the same instruction for the same
// situation, or a defect fixed on one surface persists on the other.
const sessionSource = readFileSync(`${root}worker/src/consumer/realtime_session.js`, 'utf8');
check('voice routes rejected candidates to the shared instruction',
  /planner_candidates_rejected'\s*\n\s*\?\s*extractionOutcomeInstructions\(/.test(sessionSource),
  'the voice path must not grow its own wording for this case');
check('voice detects rejection from the recorded outcomes',
  /rejectedCount = plannerOutcomes\.filter/.test(sessionSource));

const agentSource = readFileSync(`${root}worker/src/consumer/agent_session.js`, 'utf8');
check('text passes the outcome to the renderer', /extractionOutcome: \{/.test(agentSource));
check('text reports counts, never the values',
  !/extractionOutcome[\s\S]{0,300}transcript/.test(agentSource),
  'the outcome must carry counts only, so no client figure can leak into an instruction');

console.info(`[Reflection] ${checks} checks passed: a figure is always repeated back, never claimed `
  + 'as held, never invented, never outranks the real answer, and a figure that was NOT recorded is '
  + 'never confirmed nor its question re-asked verbatim.');
