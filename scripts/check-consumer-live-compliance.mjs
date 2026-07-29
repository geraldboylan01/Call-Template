/**
 * §2.3 compliance layers as units.
 *
 * The false-positive cases are as important as the detections and are asserted
 * first-class. A tripwire that cancels good sentences in front of a customer is
 * worse than no tripwire at all — L4 is the net behind L2/L3, so these two are
 * allowed to miss but are NOT allowed to fire on ordinary speech.
 */

import assert from 'node:assert/strict';

import {
  PROHIBITED_ACTS,
  PROHIBITED_ACT_IDS,
  addSourcedFigures,
  addSourcedFiguresFromText,
  correctionInstruction,
  createSourcedFigureSet,
  extractFinancialFigures,
  prohibitedAct,
  reviewAssistantTurn,
  scanAssistantSpeech,
  supervisorVerdictIsActionable
} from '../worker/src/consumer/live/compliance.js';

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}

/* -------------------------------------------------------------- vocabulary */

ok(PROHIBITED_ACTS.length === 5, 'There must be exactly five prohibited acts.');
ok(new Set(PROHIBITED_ACT_IDS).size === 5, 'Prohibited act ids must be unique.');
for (const act of PROHIBITED_ACTS) {
  ok(act.id && act.label && act.correction, `${act.id} needs an id, a label and correction copy.`);
  ok(correctionInstruction(act.id).includes(act.correction), `${act.id} correction must be reachable.`);
  ok(prohibitedAct(act.id) === act, `${act.id} must be resolvable by id.`);
}
ok(correctionInstruction('not_an_act') === null, 'An unknown act id must not produce a correction.');

/* --------------------------------------------------- L2: figure extraction */

const figureCases = [
  // [text, expected figures]
  ['Your home is worth €420,000.', [420000]],
  ['That is 420,000 euro.', [420000]],
  ['EUR 299.30 a week.', [299.3]],
  ['A rate of 4.5%.', [4.5]],
  ['Around 3.5 per cent.', [3.5]],
  ['About €350k.', [350000]],
  ['Roughly 2 million.', [2000000]],
  ['€1,250 a month.', [1250]]
];
for (const [text, expected] of figureCases) {
  assert.deepEqual(extractFinancialFigures(text), expected, `Figure extraction failed for: ${text}`);
  checks += 1;
}

// ORDINARY NUMBERS MUST NOT BE TREATED AS FINANCIAL FIGURES.
// These are the sentences a natural conversation is made of. If any of them
// registers as a figure, L2 will cancel good speech.
const nonFinancial = [
  'I am 25 and renting at the moment.',
  'In about 10 years, all going well.',
  'We have two children, 4 and 7.',
  'I will line up one to three analyses for you.',
  'That was back in 2019 and we moved in 2021.',
  'It should take about 15 minutes.',
  'I have 3 things I still need from you.',
  'My retirement age is 66.',
  'Give me 2 seconds.',
  'We bought it 12 years ago.'
];
for (const text of nonFinancial) {
  assert.deepEqual(extractFinancialFigures(text), [], `Ordinary number wrongly read as a figure: ${text}`);
  checks += 1;
}

/* ------------------------------------------------- L2: sourced containment */

{
  const sourced = createSourcedFigureSet();

  // The State Pension rule ships in the set, so quoting it is always allowed.
  let verdict = scanAssistantSpeech('The maximum is €299.30 a week, or €15,563.60 a year.', sourced);
  ok(!verdict.tripped, 'Server-supplied State Pension figures must pass.');

  // Natural rounding of a sourced figure is a paraphrase, not an invention.
  verdict = scanAssistantSpeech('That is about €300 a week.', sourced);
  ok(!verdict.tripped, 'Rounding a sourced figure within tolerance must pass.');

  // An invented figure with nothing near it must trip.
  verdict = scanAssistantSpeech('You would be looking at roughly €420,000.', sourced);
  ok(verdict.tripped, 'An unsourced figure must trip.');
  ok(verdict.actId === 'unsourced_figure', 'An unsourced figure must map to the unsourced_figure act.');
  ok(verdict.layer === 'L2', 'Numeric containment is L2.');

  // THE CLIENT'S OWN FIGURES ARE SOURCED. Echoing back what was just heard is
  // the acknowledge-and-confirm shape the conversation design asks for.
  addSourcedFiguresFromText(sourced, 'We are looking at houses around €420,000.');
  verdict = scanAssistantSpeech('So you are looking at around €420,000 — got it.', sourced);
  ok(!verdict.tripped, 'A figure the client stated must be sourced.');

  // Server-side values arrive as structured data, not prose.
  const withModuleOutput = createSourcedFigureSet();
  addSourcedFigures(withModuleOutput, { monthlyRepayment: 1642.19, nested: [{ deposit: 84000 }] });
  ok(!scanAssistantSpeech('Your repayment came out at €1,642.19.', withModuleOutput).tripped,
    'A deterministic module output figure must be sourced.');
  ok(!scanAssistantSpeech('The deposit is €84,000.', withModuleOutput).tripped,
    'A nested module output figure must be sourced.');
  ok(scanAssistantSpeech('The deposit is €96,000.', withModuleOutput).tripped,
    'A figure near but not equal to a sourced one must still trip.');
}

/* ------------------------------------------------------ L3: lead-in tripwire */

{
  const sourced = createSourcedFigureSet();
  const trips = (text) => scanAssistantSpeech(text, sourced);

  const recommendations = [
    'My advice is to move the pension now.',
    'Honestly, I would recommend that you switch your mortgage.',
    'Your best option is the PRSA.',
    'The best product for you would be an ARF.',
    'I would recommend consolidating the loan.',
    'I’d recommend that you switch your mortgage.',
    'I’d suggest investing in that fund.',
    'You should invest that in an index fund.',
    'You’d be better off overpaying the mortgage.',
    'You would be better off overpaying the mortgage.',
    'What I would do is top up the AVC.',
    'You should see that on screen. You should invest in that fund.',
    'Whether you should invest is for an adviser; however, you should invest in that fund.',
    'I’d suggest we overpay the mortgage.',
    'I would suggest we invest in the pension.',
    'You should see about switching mortgage providers.',
    'If retirement is your priority you should invest in the pension.'
  ];
  for (const text of recommendations) {
    const verdict = trips(text);
    ok(verdict.tripped && verdict.actId === 'recommendation', `Recommendation not caught: ${text}`);
  }

  const eligibility = [
    'You would definitely qualify for that.',
    'You are eligible for the Help to Buy scheme.',
    'You’re eligible for the Help to Buy scheme.',
    'You will be approved for that amount.',
    'You are entitled to the full rate.',
    'That confirms you would be treated as a first-time buyer for the review.'
  ];
  for (const text of eligibility) {
    const verdict = trips(text);
    ok(verdict.tripped && verdict.actId === 'eligibility', `Eligibility claim not caught: ${text}`);
  }

  const premature = [
    'I have just run the numbers for you.',
    'The analysis shows you are on track.',
    'Based on my calculation you are fine.'
  ];
  for (const text of premature) {
    const verdict = trips(text);
    ok(verdict.tripped && verdict.actId === 'premature_result', `Premature result not caught: ${text}`);
  }

  // FALSE POSITIVES. Every one of these is ordinary, correct conversation and
  // must survive untouched.
  const mustNotTrip = [
    'You should be able to see that on screen now.',
    'You should see three analyses appear as we go.',
    'You need to know that nothing is saved without your say-so.',
    'You should tell me if I have any of this wrong.',
    'Please stop me whenever you like — you need to let me know if I go too fast.',
    'I would suggest we come back to the pension in a moment.',
    'I cannot recommend a specific product, but I can capture the details.',
    'I can’t tell you which one to choose or what I would do in your position. I can compare the trade-off clearly.',
    'I’d suggest we come back to the pension in a moment.',
    'I would recommend we park the mortgage for now.',
    'I cannot recommend a fund, but I would suggest taking this one question at a time.',
    'A pension is a long-term savings arrangement with tax relief on contributions.',
    'That is the kind of thing an adviser would look at with you.',
    'I am not able to tell you whether you would qualify — a lender decides that.',
    'The mortgage analysis looks at what your repayments would mean month to month.',
    'You have a mortgage and a loan, so those are both worth looking at.',
    'Once you confirm, I will run the analyses and the numbers will appear on screen.',
    'The best option for you is not something I can decide, but I can map the trade-offs.',
    'My advice is not something I can provide, but I can compare the analyses.',
    'It would be wrong for me to say you would qualify; a lender decides that.',
    'What I would do here is explain how the mortgage analysis works.'
  ];
  for (const text of mustNotTrip) {
    const verdict = trips(text);
    ok(!verdict.tripped, `FALSE POSITIVE — good speech was flagged as ${verdict.actId}: ${text}`);
  }

  ok(!trips('').tripped, 'Empty speech must not trip.');
  ok(!trips('   ').tripped, 'Whitespace must not trip.');

  // NEGATION MUST NOT BECOME A LAUNDERING ROUTE. A negation belongs to its own
  // clause; a recommendation in the NEXT clause is still a recommendation.
  const negationEvasion = [
    'You should not leave it sitting in cash, you should invest it.',
    'I cannot give advice. That said, my advice is to move the pension.',
    'It is not for me to say. You would qualify for the full rate.'
  ];
  for (const text of negationEvasion) {
    ok(trips(text).tripped, `Negation in a prior clause must not suppress a later claim: ${text}`);
  }

  // Declines stay clean even when they name the act they are declining.
  const declines = [
    'I am not able to tell you whether you would qualify — a lender decides that.',
    'I cannot recommend a fund, and I would not want to guess.',
    'I do not know if you are eligible for that scheme.',
    'Whether you would qualify is really a question for the lender.'
  ];
  for (const text of declines) {
    ok(!trips(text).tripped, `A decline must not be flagged: ${text}`);
  }

  const streamedSafeGuards = [
    'For the pension I’d suggest we come back to that in a moment.',
    'The best option for you is not something I can decide, but I can map the trade-offs.',
    'My advice is not something I can provide, but I can compare the analyses.',
    'It would be wrong for me to say you would qualify; a lender decides that.',
    'What I would do here is explain how the mortgage analysis works.'
  ];
  for (const streamedSafeGuard of streamedSafeGuards) {
    for (let index = 1; index <= streamedSafeGuard.length; index += 1) {
      const prefix = streamedSafeGuard.slice(0, index);
      ok(!trips(prefix).tripped, `A safe streaming prefix was flagged: ${prefix}`);
    }
  }
  ok(trips('For the pension I’d suggest investing in that fund.').tripped,
    'A suggestion that diverges from the safe streaming guard must trip.');
}

/* ---------------------------------------------------------- L4: supervisor */

{
  // Actionability gate: a low-confidence verdict is recorded but never acted on.
  ok(supervisorVerdictIsActionable({ violation: true, confidence: 'high' }), 'High confidence is actionable.');
  ok(supervisorVerdictIsActionable({ violation: true, confidence: 'medium' }), 'Medium confidence is actionable.');
  ok(!supervisorVerdictIsActionable({ violation: true, confidence: 'low' }), 'Low confidence must not be actionable.');
  ok(!supervisorVerdictIsActionable({ violation: false, confidence: 'high' }), 'No violation is never actionable.');
  ok(!supervisorVerdictIsActionable(null), 'A missing verdict must not be actionable.');

  // THE SUPERVISOR MUST NEVER BREAK A MEETING. Every failure mode resolves to
  // "no violation found" — a supervisor that can throw or stall would
  // reproduce the exact defect this lane exists to remove.
  const noKey = await reviewAssistantTurn({ env: {}, config: { liveSupervisorModel: 'x' }, assistantTranscript: 'hello' });
  ok(noKey.violation === false, 'A missing API key must resolve to no violation.');

  const noModel = await reviewAssistantTurn({ env: { OPENAI_API_KEY: 'k' }, config: {}, assistantTranscript: 'hello' });
  ok(noModel.violation === false, 'A missing supervisor model must resolve to no violation.');

  const noTranscript = await reviewAssistantTurn({
    env: { OPENAI_API_KEY: 'k' }, config: { liveSupervisorModel: 'm' }, assistantTranscript: '   '
  });
  ok(noTranscript.violation === false, 'An empty transcript must resolve to no violation.');

  // A provider outage must be swallowed, not thrown.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const outage = await reviewAssistantTurn({
      env: { OPENAI_API_KEY: 'k' }, config: { liveSupervisorModel: 'm' }, assistantTranscript: 'I recommend the PRSA.'
    });
    ok(outage.violation === false, 'A provider outage must resolve to no violation, not throw.');
  } finally {
    globalThis.fetch = realFetch;
  }

  // Malformed provider output must be swallowed too.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: 'not json' }] }] }) });
  try {
    const malformed = await reviewAssistantTurn({
      env: { OPENAI_API_KEY: 'k' }, config: { liveSupervisorModel: 'm' }, assistantTranscript: 'hello'
    });
    ok(malformed.violation === false, 'Malformed supervisor output must resolve to no violation.');
  } finally {
    globalThis.fetch = realFetch;
  }

  // A well-formed violation is passed through with its act and confidence.
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({
        violation: true, actId: 'recommendation', evidence: 'go with the PRSA', confidence: 'high'
      }) }] }],
      usage: { input_tokens: 120, output_tokens: 20 }
    })
  });
  try {
    const caught = await reviewAssistantTurn({
      env: { OPENAI_API_KEY: 'k' }, config: { liveSupervisorModel: 'm' }, assistantTranscript: 'Go with the PRSA.'
    });
    ok(caught.violation === true && caught.actId === 'recommendation', 'A well-formed violation must pass through.');
    ok(supervisorVerdictIsActionable(caught), 'A high-confidence violation must be actionable.');
    ok(caught.usage !== null, 'Supervisor usage must be returned so it can be metered.');
  } finally {
    globalThis.fetch = realFetch;
  }

  // An act id outside the vocabulary is not a violation.
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({
      violation: true, actId: 'made_up_act', evidence: '', confidence: 'high'
    }) }] }] })
  });
  try {
    const unknown = await reviewAssistantTurn({
      env: { OPENAI_API_KEY: 'k' }, config: { liveSupervisorModel: 'm' }, assistantTranscript: 'hello'
    });
    ok(unknown.violation === false, 'An act id outside the vocabulary must not count as a violation.');
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`check-consumer-live-compliance: ${checks} assertions passed.`);
