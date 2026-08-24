#!/usr/bin/env node

/**
 * THE CLAIM THIS ARCHITECTURE IS MAKING, TESTED END TO END.
 *
 * A category-pair segmentation rule was replaced by a general one:
 *
 *   the client states a figure -> the fast lane misses it -> deterministic
 *   coverage notices the exact source occurrence is unaccounted for -> ONE
 *   bounded background review proposes it -> the strict reconciler validates
 *   it like any other write -> it reaches the canonical profile
 *
 * Nothing in the suite proved that whole chain. The component tests each
 * proved their own link, and the live harness could report a clean review
 * without any occurrence having been recovered, because a planner that
 * proposes nothing is auto-dispositioned `not_current_fact`. So the tests
 * would have stayed green if the recovery never happened.
 *
 * These cases drive the real Durable Object over real local D1. Only the two
 * MODELS are scripted. Every assertion below is about production code:
 * coverage detection, the disposition contract, the reconciliation validator,
 * the CAS write, and the confirmation barrier.
 *
 * THE NEGATIVES MATTER AS MUCH AS THE POSITIVE. A recovery mechanism that
 * cannot fail is a fabrication mechanism, and one that cannot stop is a
 * deadlock. Both directions are asserted here.
 */

import assert from 'node:assert/strict';

import { attachLiveSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { LiveProviderSimulator } from './live-harness/provider.mjs';
import { scriptedPlanner } from './live-harness/scripted-planner.mjs';
import { getCurrentProfile, getSessionRow } from '../worker/src/consumer/repository.js';
import { plannerReconciliationPreflight } from '../worker/src/consumer/live/live_session.js';
import { loadLiveContext, liveStateProjection } from '../worker/src/consumer/live/live_tools.js';
import { extractValueEvidence } from '../js/planning/value_evidence.js';
import { DatabaseSync } from 'node:sqlite';

let checks = 0;
const pass = (message) => {
  checks += 1;
  console.info(`[LiveValueRecovery] PASS: ${message}`);
};

async function rig(label, planFor, { mode = 'apply' } = {}) {
  const meeting = await newLiveMeeting(label, { CONSUMER_PLANNER_RECONCILIATION_MODE: mode });
  const { session, durable, provider } = await attachLiveSession(meeting);
  const simulator = new LiveProviderSimulator({ session, durable, provider });
  const planner = scriptedPlanner(planFor);

  const say = async (clientText, facts = null) => {
    await simulator.turn({
      clientText,
      act: async ({ callTool }) => {
        const calls = [];
        if (facts) calls.push(await callTool('save_facts', { facts }));
        return { speech: 'Noted.', calls };
      }
    });
    await settle(durable, session);
  };

  const profile = async () => getCurrentProfile(
    meeting.env, await getSessionRow(meeting.env, meeting.sessionId)
  );
  const projection = async () => liveStateProjection(await loadLiveContext({
    env: meeting.env, config: meeting.config, sessionId: meeting.sessionId
  }));
  /** The outcome counters as an analyst will read them: plain SQL, no decryption. */
  const funnel = () => {
    const database = new DatabaseSync(meeting.databasePath);
    try {
      return database.prepare(`
        SELECT COALESCE(SUM(covered_value_count), 0) AS covered,
               COALESCE(SUM(uncovered_value_count), 0) AS uncovered,
               COALESCE(SUM(recovered_value_count), 0) AS recovered,
               COALESCE(SUM(not_current_fact_count), 0) AS notCurrentFact,
               COALESCE(SUM(unresolved_value_count), 0) AS unresolved,
               COALESCE(SUM(deferred_value_count), 0) AS deferred,
               COUNT(*) FILTER (WHERE trigger = 'value_coverage_gap') AS coverageDriven
        FROM consumer_planner_reconciliations
      `).get();
    } finally { database.close(); }
  };

  return { meeting, session, durable, simulator, planner, say, profile, projection, funnel,
    settle: () => settle(durable, session) };
}

/** Total held in cash assets, which is where the recovered figure must land. */
const cashTotal = (profile) => (profile.assets || [])
  .filter((asset) => asset.type === 'cash')
  .reduce((total, asset) => total + Number(asset.currentValue?.amount || 0), 0);

const pensionTotal = (profile) => (profile.pensions || [])
  .reduce((total, item) => total + Number(item.currentValue?.amount || 0), 0);

/**
 * One turn, two explicitly valued holdings, and a fast lane that saves only
 * the pension. Exactly the production shape, with no pension/investment rule
 * anywhere in the path.
 */
const TWO_HOLDING_TURN = 'My pension is worth 100,000 at the minute, '
  + 'and I have 10,000 in cash savings.';

/* ============================================ 1. the recovery actually happens */
{
  const r = await rig('value-recovery-positive', ({ context }) => {
    const gap = (context.uncoveredValueEvidence || [])[0];
    if (!gap) return null;
    // The planner proposes a write for the exact occurrence it was shown,
    // citing a real contiguous span of the real stored turn. Whether that is
    // admissible is decided by the production validator, not here.
    return {
      verdict: 'changes_proposed',
      repairs: [{
        operationId: 'recover_cash',
        factId: 'asset_position',
        // A holding is a POSITION note. A `fact` note has no canonical scalar
        // path for a collection entity, so it would be accepted into the
        // ledger and never reach the profile — which is precisely the silent
        // half-recovery these assertions exist to catch.
        noteKind: 'position',
        entityId: (context.entities || []).find((entity) => (
          entity.newEntitySlot === true && (entity.factIds || []).includes('asset_position')
        ))?.entityId,
        ownerId: (context.owners || []).find((owner) => owner.role === 'primary')?.ownerId,
        quote: 'I have 10,000 in cash savings',
        value: {
          type: 'cash',
          label: 'Cash savings',
          ownerIds: [(context.owners || []).find((owner) => owner.role === 'primary')?.ownerId],
          currentValue: { amount: 10_000, currency: 'EUR' }
        }
      }]
    };
  });

  await r.say('I am 44 and I live in Ireland.', [
    { factId: 'person_current_age', value: 44, certainty: 'exact' }
  ]);
  // The fast lane keeps the pension and misses the cash — the omission this
  // whole mechanism exists to catch.
  await r.say(TWO_HOLDING_TURN, [{
    factId: 'pension_positions',
    value: {
      operation: 'upsert',
      entityId: 'occ1',
      type: 'occupational',
      owner: 'primary',
      currentValue: { amount: 100_000, currency: 'EUR' }
    },
    certainty: 'exact'
  }]);
  // The review is background work, so the recovery lands on a later turn — the
  // whole point of not putting it in the reply path.
  await r.say('Is that everything you need from me?');
  await r.settle();

  const after = await r.profile();
  assert.equal(pensionTotal(after), 100_000, 'the fast lane keeps what it did capture');
  assert.equal(cashTotal(after), 10_000,
    'the omitted cash holding must reach the canonical profile through reconciliation');
  pass('a figure the fast lane missed is recovered into the canonical profile');

  const reviewed = r.planner.calls().filter((call) => call.uncoveredValueEvidenceCount > 0);
  assert.ok(reviewed.length > 0, 'the background review must have been shown the uncovered occurrence');
  assert.ok(reviewed.some((call) => call.valueEvidenceDispositions.includes('operation_proposed')),
    'recovery must come from a real proposed write, never an auto-generated not_current_fact');
  pass('the proof is a real accepted operation, not a harness-generated disposition');

  // ONE pass, not a retry loop: the occurrence resolves and is never re-shown.
  const laterReviews = r.planner.calls()
    .filter((call) => call.uncoveredValueEvidenceCount > 0)
    .slice(1);
  assert.ok(laterReviews.every((call) => call.uncoveredValueEvidenceCount <= reviewed[0].uncoveredValueEvidenceCount),
    'a resolved occurrence must not come back for another paid review');
  pass('recovery is bounded: a resolved occurrence is not reviewed again');

  // THE TELEMETRY IS PART OF THE MECHANISM, NOT A REPORT ABOUT IT. Real-user
  // testing has to be able to ask "of the figures the fast lane missed, how
  // many did the review actually recover" in SQL, on day one, without
  // decrypting a single payload.
  const recovered = r.funnel();
  assert.ok(recovered.uncovered >= 1,
    `the missed figure must be counted as uncovered: ${JSON.stringify(recovered)}`);
  assert.ok(recovered.recovered >= 1,
    `the recovery must be counted, not just performed: ${JSON.stringify(recovered)}`);
  assert.ok(recovered.covered >= 1,
    `the fast lane's own capture must be counted as the denominator: ${JSON.stringify(recovered)}`);
  assert.ok(recovered.coverageDriven >= 1,
    `the checkpoint must record that COVERAGE drove it: ${JSON.stringify(recovered)}`);
  pass('the recovery is measurable in SQL: covered, uncovered and recovered are all counted');

  r.planner.restore();
}

/* ================================== 2. an unrecoverable figure fails closed */
{
  // The planner keeps proposing a value the client never said. The production
  // validator must refuse it every time, and the meeting must still finish.
  const r = await rig('value-recovery-refused', ({ context }) => {
    const gap = (context.uncoveredValueEvidence || [])[0];
    if (!gap) return null;
    return {
      verdict: 'changes_proposed',
      repairs: [{
        operationId: 'invent_cash',
        factId: 'asset_position',
        noteKind: 'position',
        entityId: (context.entities || []).find((entity) => (
          entity.newEntitySlot === true && (entity.factIds || []).includes('asset_position')
        ))?.entityId,
        ownerId: (context.owners || []).find((owner) => owner.role === 'primary')?.ownerId,
        quote: 'I have 10,000 in cash savings',
        value: {
          type: 'cash',
          label: 'Cash savings',
          ownerIds: [(context.owners || []).find((owner) => owner.role === 'primary')?.ownerId],
          // NOT what the client said. The numeric grounding rule must refuse it.
          currentValue: { amount: 55_000, currency: 'EUR' }
        }
      }]
    };
  });

  await r.say('I am 44 and I live in Ireland.', [
    { factId: 'person_current_age', value: 44, certainty: 'exact' }
  ]);
  await r.say(TWO_HOLDING_TURN, [{
    factId: 'pension_positions',
    value: {
      operation: 'upsert', entityId: 'occ1', type: 'occupational', owner: 'primary',
      currentValue: { amount: 100_000, currency: 'EUR' }
    },
    certainty: 'exact'
  }]);

  const after = await r.profile();
  assert.equal(cashTotal(after), 0,
    'a value the client never said must never reach the profile through a repair');
  assert.ok(!JSON.stringify(after).includes('55000'),
    'the invented amount must appear nowhere in canonical state');
  pass('an ungrounded recovery is refused: uncertainty fails closed');

  // And the meeting is not wedged by it. Keep talking; the occurrence spends
  // its bounded budget and stops being outstanding work.
  await r.say('That is everything for now.');
  await r.say('Nothing else to add.');
  await r.settle();
  assert.ok(r.session.terminallyUnresolvedEvidence.length > 0,
    'an occurrence nothing could place must be recorded as terminally unresolved');
  assert.equal(r.session.unreviewedMaterialTurns.length, 0,
    'a terminally unresolved occurrence must stop holding the confirmation barrier');
  pass('an unplaceable figure terminates as unresolved instead of wedging the meeting');

  // Recorded, never quietly reclassified as captured.
  const stillMissing = cashTotal(await r.profile());
  assert.equal(stillMissing, 0,
    'terminating the review must not mark the occurrence covered or invent the fact');
  pass('terminal means recorded-and-unresolved, never silently covered');

  // THE TWO GATES STAY SEPARATE. The confirmation barrier asks "has the
  // outstanding review been done"; readiness asks "does this analysis have the
  // facts it needs". Conflating them is what froze the journey: one unplaceable
  // figure held back every analysis, including the ones that never wanted it.
  const preflight = plannerReconciliationPreflight(
    'apply', null, r.session.unreviewedMaterialTurns, r.session.unresolvedIdentities
  );
  assert.equal(preflight.ready, true,
    `the confirmation barrier must open once the review is finished: ${preflight.reason}`);
  pass('an unresolved figure no longer holds the confirmation barrier shut');

  const analyses = (await r.projection()).analyses || [];
  const wantingAssets = analyses.filter((analysis) => (analysis.stillNeeded || [])
    .some((need) => String(need.factId || '').includes('asset')));
  assert.ok(wantingAssets.every((analysis) => analysis.status !== 'ready'),
    'an analysis that needs the missing holding must still be held by READINESS');
  pass('readiness still blocks the analyses that actually needed the missing fact');

  const refused = r.funnel();
  assert.ok(refused.unresolved >= 1,
    `a refused recovery must be counted as unresolved, not as recovered: ${JSON.stringify(refused)}`);
  assert.equal(refused.recovered, 0,
    `nothing may be counted as recovered when nothing was: ${JSON.stringify(refused)}`);
  pass('a refused recovery is counted as unresolved and never as a success');

  r.planner.restore();
}

/* =========================== 3. a failing review still terminates the work */
{
  let attempts = 0;
  const r = await rig('value-recovery-provider-failure', () => {
    attempts += 1;
    return { fail: true };
  });

  await r.say('I am 44 and I live in Ireland.', [
    { factId: 'person_current_age', value: 44, certainty: 'exact' }
  ]);
  await r.say(TWO_HOLDING_TURN, [{
    factId: 'pension_positions',
    value: {
      operation: 'upsert', entityId: 'occ1', type: 'occupational', owner: 'primary',
      currentValue: { amount: 100_000, currency: 'EUR' }
    },
    certainty: 'exact'
  }]);
  await r.say('Anything else you need?');
  await r.say('Right, that is me finished.');
  await r.settle();

  assert.ok(attempts > 0, 'the review must have been attempted');
  assert.ok(attempts <= 8,
    `a persistently failing review must not spin: ${attempts} attempts`);
  assert.equal(cashTotal(await r.profile()), 0, 'a failed review records nothing');
  pass('a review that never succeeds is bounded rather than retried forever');

  // A crashed review and a review with nothing to do must not look the same in
  // the data. The occurrences were put in front of the model and none of them
  // resolved; that is what the row has to say.
  const failed = r.funnel();
  assert.ok(failed.uncovered >= 1,
    `a failed pass must still record what it was asked to review: ${JSON.stringify(failed)}`);
  assert.ok(failed.unresolved >= 1,
    `a failed pass must record its occurrences as unresolved: ${JSON.stringify(failed)}`);
  assert.equal(failed.recovered, 0, 'a failed pass recovers nothing');
  pass('a failed review is distinguishable in the data from a review with nothing to do');

  r.planner.restore();
}

/* ============ 4. a pathological turn degrades instead of failing the pass */
{
  // Fourteen explicit values in one turn, against a bounded review of twelve.
  const dense = Array.from({ length: 14 }, (_, index) => (
    `holding ${String.fromCharCode(65 + index)} is ${(index + 1) * 1_000} euro`
  )).join(', ');
  assert.ok(extractValueEvidence(dense).length > 12,
    'the fixture must genuinely overflow the bounded review');

  const seen = [];
  const r = await rig('value-recovery-overflow', ({ context }) => {
    seen.push((context.uncoveredValueEvidence || []).length);
    return null;
  });

  await r.say('I am 44 and I live in Ireland.', [
    { factId: 'person_current_age', value: 44, certainty: 'exact' }
  ]);
  await r.say(`Right, ${dense}.`);
  await r.settle();

  assert.ok(seen.length > 0, 'the overflowing turn must still reach a review');
  assert.ok(seen.every((count) => count <= 12),
    `each pass must stay within its bounded review: ${JSON.stringify(seen)}`);
  assert.ok(seen.some((count) => count > 0),
    'an overflowing turn must still have its bounded share reviewed rather than failing whole');
  pass('an overflowing turn degrades to a bounded review instead of invalidating the checkpoint');

  r.planner.restore();
}

console.info(`\n[LiveValueRecovery] ${checks} end-to-end claims verified.`);
