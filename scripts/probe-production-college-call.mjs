#!/usr/bin/env node

/**
 * PAID REAL-MODEL PROBE: the first genuine Planéir production call, replayed.
 *
 * 2026-09-03, meeting rt_KUTY_… — the first live website call on the direct
 * semantic module architecture. It did not complete. A client with a new baby
 * asked to plan for college; the planner marked college_funding ready (rightly
 * — the module's only client-owned input is each child's age), stored the input
 * the ENGINE derives from that, and handed it back to the planner next turn as
 * "preserve this". No quote can support an engine-derived field, so provenance
 * refused the pass — and refused it again on every following turn, because each
 * retry was fed the same poisoned previous input. Seven of nine passes failed,
 * no snapshot advanced past the goal-choice turn, confirmation could therefore
 * never be offered, and Planéir ended up telling the client to wait.
 *
 * WHAT THIS REPLAYS. The real transcript, turn by turn, through the real
 * background planner — one pass per finalized client turn, each pass fed the
 * last SUCCESSFULLY SAVED snapshot, exactly as the Durable Object does. A
 * failed pass saves nothing, which is what made the production failure
 * self-reinforcing, and that is reproduced here rather than smoothed over.
 *
 * SANITISED. Only what the client actually said, with nothing identifying: no
 * name, no contact detail, no figure they did not speak. The one turn a
 * transcription mangled into Arabic script is kept as an empty-meaning turn,
 * because a call really does contain those and the planner has to survive one.
 *
 * WHAT GOOD LOOKS LIKE. Every pass succeeds, the snapshot revision advances on
 * every turn, and from the turn the client names their goal the plan is
 * certified and readyToConfirm. A failed pass, or a revision that stops moving,
 * is this regression returning.
 *
 * Usage: npm run probe:production-college-call [clientTurnId ...]
 * Costs two model calls per pass. Deterministic coverage of the same failure
 * lives in check-direct-module-planning.mjs and check-direct-module-live-path.mjs.
 */

import assert from 'node:assert/strict';
import { APPROVED_CONSUMER_MODULE_IDS } from '../worker/src/consumer/config.js';
import { interpretDirectModuleConversation } from '../worker/src/consumer/direct_module_planner.js';

if (!String(process.env.OPENAI_API_KEY || '').trim()) {
  console.error('OPENAI_API_KEY is required for this paid semantic probe.');
  process.exit(2);
}

const TODAY = process.env.PROBE_CALCULATION_DATE || '2026-09-03';
const env = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url')
};
const config = {
  allowedModules: APPROVED_CONSUMER_MODULE_IDS,
  modulePlannerModel: process.env.CONSUMER_MODULE_PLANNER_MODEL || 'gpt-5.6-luna',
  modulePlannerReasoningEffort: 'low',
  modulePlannerTimeoutMs: 180_000,
  modulePlannerPromptVersion: 'direct-module-planner-v5',
  moduleVerifierPromptVersion: 'direct-module-verifier-v3'
};
const currentProfileContext = {
  profileId: 'production-college-replay',
  revision: 1,
  primaryPerson: { personId: 'primary', displayName: 'Client' },
  partner: null,
  preferences: { baseCurrency: 'EUR' },
  assumptions: { calculationDateIso: TODAY }
};

/* The call as it happened. a* adviser, c* client. */
const LINES = [
  ['a1', 'assistant', 'Hi, I’m Planéir, an AI planning companion, and this is a conversation about what matters to you, not a form to fill in. What brought you here today — what’s the person, goal, or concern you want to talk through?'],
  ['c1', 'user', 'So what did you say?'],
  ['a2', 'assistant', 'I’m Planéir, an AI planning companion, and we’ll talk through what matters to you. What brought you here today — a goal, a decision, or a concern you’d like to unpack?'],
  ['c2', 'user', 'Um, it’s mostly just a usual, I guess it’s a check-up. I’m after having a new baby and I’m 30 years old and I just want to make sure I’m in a good financial position to get this baby, you know, into college in the future and I’m OK.'],
  ['a3', 'assistant', 'You’ve got a new baby on the way, and you want to feel “okay” about the future. That’s a big moment. When you picture being in a good place, what does that mean to you day to day, before we even get to the money side?'],
  ['c3', 'user', 'I guess it means, you know, I’m not struggling to pay back my mortgage, and it means that I’m still setting myself up for retirement in a decent way, and I can, yeah, still afford to live comfortably.'],
  ['a4', 'assistant', 'That paints a really clear picture: keeping the mortgage manageable, staying on track for retirement, and still living comfortably along the way. Which of those would you like to start with today — the mortgage, your retirement picture, or planning for future college costs?'],
  ['c4', 'user', 'Planning for future college costs.'],
  ['a5', 'assistant', 'Alright, we’ll keep this focused on the college planning side and move carefully from there.'],
  ['c5', 'user', 'Sounds good.'],
  ['a6', 'assistant', 'The college plan is ready to run on its own, but the mortgage and retirement parts still need details before they can be confirmed. Would you like to go ahead with just the college funding projection for now, and come back to the others later?'],
  ['c6', 'user', 'Yeah.'],
  ['a7', 'assistant', 'Great, I’ll line that up for you now.'],
  ['c7', 'user', 'OK.'],
  ['a8', 'assistant', 'It’s still running in the background. If you’re checking in, that’s normal — we’re just waiting for the plan to come back so we can confirm and run it properly.'],
  ['c8', 'user', 'Is it ready now?'],
  ['a9', 'assistant', 'Let me check where things stand so we don’t jump ahead.'],
  // Transcription produced Arabic script for an utterance that carried no
  // planning meaning. Kept verbatim: a pass must survive a turn like this.
  ['c9', 'user', 'وادنار']
];

const turns = LINES.map(([id, role, transcript], index) => ({
  id,
  role,
  transcript,
  answersTurnId: role === 'user' ? LINES[index - 1]?.[0] || null : null
}));

const requested = process.argv.slice(2);
const clientTurnIds = requested.length
  ? requested
  : turns.filter((turn) => turn.role === 'user').map((turn) => turn.id);
assert.ok(clientTurnIds.every((id) => turns.some((turn) => turn.id === id && turn.role === 'user')),
  'Every requested pass must name a client turn in the production transcript.');

// Selection alone supplies no child or age. Exercise this separately from the
// real newborn transcript, where the model can infer age zero from evidence.
const goalOnly = await interpretDirectModuleConversation({
  env, config, currentProfileContext,
  turns: [
    { id: 'goal-a', role: 'assistant', transcript: 'What would you like to start with?', answersTurnId: null },
    { id: 'goal-c', role: 'user', transcript: 'Planning for future college costs.', answersTurnId: 'goal-a' }
  ],
  throughTurnId: 'goal-c'
});
const collectingCollege = goalOnly.snapshot.modules.find((item) => item.moduleId === 'college_funding');
assert.ok(['collecting', 'needs_clarification'].includes(collectingCollege?.status));
assert.ok(collectingCollege.missing.length + collectingCollege.ambiguities.length > 0);
assert.equal(goalOnly.brief.readyToConfirm, false);
assert.equal(Boolean(goalOnly.certificate), false);
console.info(JSON.stringify({
  pass: 'goal_only', ok: true, status: collectingCollege.status,
  missing: collectingCollege.missing, ambiguities: collectingCollege.ambiguities,
  readyToConfirm: false, certified: false
}, null, 1));

let previousSnapshot = null;
let failures = 0;
let lastRevision = 0;
let frozen = 0;
let lastResult = null;
for (const throughTurnId of clientTurnIds) {
  const cut = turns.slice(0, turns.findIndex((turn) => turn.id === throughTurnId) + 1);
  const started = Date.now();
  try {
    const result = await interpretDirectModuleConversation({
      env, config, turns: cut, throughTurnId, previousSnapshot, currentProfileContext
    });
    const relevant = result.snapshot.modules.filter((item) => item.status !== 'not_relevant');
    console.info(JSON.stringify({
      pass: throughTurnId,
      ok: true,
      ms: Date.now() - started,
      snapshotRevision: result.snapshot.snapshotRevision,
      statuses: Object.fromEntries(relevant.map((item) => [item.moduleId, item.status])),
      stillNeeded: relevant.flatMap((item) => (item.missing || []).map((need) => `${item.moduleId}${need.path}`)),
      generalAmbiguities: (result.snapshot.generalAmbiguities || []).map((item) => item.question),
      verdict: result.verification?.verdict || 'not_run',
      certified: Boolean(result.certificate),
      readyToConfirm: result.brief.readyToConfirm,
      confirmationPrompt: result.brief.confirmationPrompt || null
    }, null, 1));
    if (result.snapshot.snapshotRevision <= lastRevision) frozen += 1;
    lastRevision = result.snapshot.snapshotRevision;
    previousSnapshot = result.snapshot;
    lastResult = result;
  } catch (error) {
    failures += 1;
    frozen += 1;
    console.info(JSON.stringify({
      pass: throughTurnId,
      ok: false,
      ms: Date.now() - started,
      code: error?.code || 'unknown',
      moduleId: error?.moduleId || null,
      message: error?.message || String(error),
      details: error?.details ?? null
    }, null, 1));
  }
}

console.info(`\n${clientTurnIds.length - failures}/${clientTurnIds.length} passes succeeded; final snapshot revision ${lastRevision}.`);
if (failures > 0 || frozen > 0) {
  console.error('\nThe production regression is back: a pass that fails saves nothing, so the next pass is');
  console.error('fed the same input and fails the same way. Realtime then steers on state older than the');
  console.error('conversation and confirmation can never be offered.');
  process.exit(1);
}
if (clientTurnIds.includes('c4') || clientTurnIds.some((id) => Number(id.slice(1)) > 4)) {
  assert.equal(lastResult?.brief.readyToConfirm, true, 'The selected college plan must reach actionable confirmation.');
  assert.equal(lastResult.verification?.verdict, 'pass');
  assert.ok(lastResult.certificate?.signature);
  assert.ok(lastResult.brief.confirmationPrompt);
  assert.deepEqual(lastResult.snapshot.modules.filter((item) => item.status !== 'not_relevant')
    .map((item) => item.moduleId), ['college_funding']);
  console.info('Every turn advanced; the selected college plan is verified, certified and ready for confirmation.');
} else {
  console.info('Every requested turn advanced; this partial replay ends before college selection.');
}
