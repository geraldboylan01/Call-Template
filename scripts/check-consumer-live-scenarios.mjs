#!/usr/bin/env node

/**
 * PHASE 4 SCENARIOS — the product loop under the conditions that break it.
 *
 * These are not unit tests of the reconciler. Every one of them drives the real
 * Durable Object over real local D1 through the real provider event order, and
 * asserts something about the LOOP that no component test can see:
 *
 *   E  a correction survives the client talking over the planner
 *   G  the module's arithmetic is right, checked against an independent model
 *   C  a spoken total does not become a fourth pension
 *   D  the partner's money does not become the client's
 *
 * Only the two MODELS are scripted. What the assistant says and which tools it
 * calls stand in for the live model; what the planner concludes stands in for
 * the reconciler's model. Everything those decisions flow into is production
 * code, including every rule being asserted here.
 */

import assert from 'node:assert/strict';

import { attachLiveSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { LiveProviderSimulator } from './live-harness/provider.mjs';
import { scriptedPlanner } from './live-harness/scripted-planner.mjs';
import { loadLiveContext, liveStateProjection } from './live-harness/../../worker/src/consumer/live/live_tools.js';
import { getCurrentProfile, getLatestAnalysis, getSessionRow } from '../worker/src/consumer/repository.js';

const pass = (message) => console.info(`[ConsumerLiveScenarios] PASS: ${message}`);

async function rig(label, { mode = 'apply', planFor = () => null, plannerLatencyMs = 0 } = {}) {
  const meeting = await newLiveMeeting(label, { CONSUMER_PLANNER_RECONCILIATION_MODE: mode });
  const { session, durable, provider } = await attachLiveSession(meeting);
  const simulator = new LiveProviderSimulator({ session, durable, provider });
  const planner = scriptedPlanner(planFor, { latencyMs: plannerLatencyMs });

  // The reconciler's own verdicts, captured at the seam the Durable Object
  // already calls. `rebasedFromRevisions` is the only place a rebase is
  // observable: D1 records the outcome, never the fact that it was reached a
  // second time against newer state.
  const outcomes = [];
  const realExecute = session.executePlannerReconciliation.bind(session);
  session.executePlannerReconciliation = async (config, context, job) => {
    const result = await realExecute(config, context, job);
    outcomes.push({
      trigger: job.trigger,
      status: result?.status,
      baseRevision: context.profile.revision,
      appliedProfileRevision: result?.appliedProfileRevision ?? null,
      rebasedFromRevisions: result?.rebasedFromRevisions || [],
      accepted: result?.validation?.acceptedOperationIds || [],
      unprojected: result?.validation?.unprojectedFactOperationIds || []
    });
    return result;
  };

  const say = async (clientText, facts = null, { wait = true } = {}) => {
    const turn = await simulator.turn({
      clientText,
      act: async ({ callTool }) => {
        const calls = [];
        if (facts) calls.push(await callTool('save_facts', { facts }));
        return { speech: 'Noted.', calls };
      }
    });
    if (wait) await settle(durable, session);
    return turn;
  };

  const confirmAndRun = async () => {
    let result = null;
    for (let attempt = 1; attempt <= 3 && !result?.ok; attempt += 1) {
      await simulator.turn({
        clientText: attempt === 1 ? 'Yes, go ahead and run it.' : 'Yes, please go ahead.',
        act: async ({ callTool }) => {
          result = (await callTool('confirm_and_run', {})).result;
          return { speech: 'One moment.' };
        }
      });
      await settle(durable, session);
    }
    return result;
  };

  const profile = async () => getCurrentProfile(
    meeting.env, await getSessionRow(meeting.env, meeting.sessionId)
  );
  const projection = async () => liveStateProjection(await loadLiveContext({
    env: meeting.env, config: meeting.config, sessionId: meeting.sessionId
  }));

  /** What the analyses are still waiting for, for a failure message worth reading. */
  const outstanding = async () => (await projection()).analyses
    .flatMap((analysis) => (analysis.stillNeeded || [])
      .map((need) => `${need.instanceId || need.factId} (${need.why || ''})`))
    .join('; ') || '(nothing)';

  return {
    meeting, session, durable, provider, simulator, planner, outcomes,
    say, confirmAndRun, profile, projection, outstanding,
    settle: () => settle(durable, session)
  };
}

/** One pension holding, in the shape the live tool accepts. */
const holding = (entityId, type, amount, owner = 'primary', label = '') => ({
  factId: 'pension_positions',
  value: {
    operation: 'upsert', entityId, type, owner,
    // The name the client gave it. Two occupational pensions are only two
    // holdings if something says so, and "the old one" versus "my current one"
    // is exactly what says so — see resolvePositionIdentity.
    ...(label ? { label } : {}),
    currentValue: { amount, currency: 'EUR' }
  },
  certainty: 'exact'
});

/**
 * The person, before any pension is named.
 *
 * ORDER MATTERS AND IS NOT COSMETIC. A contribution rate and a contribution
 * status belong TO a pension, so saving them before any pension exists leaves
 * them with nothing to attach to and the analysis still asking for both. That
 * is also the order a real conversation takes: you hear about the pension, then
 * you ask what goes into it.
 */
async function personGroundwork(r) {
  await r.say("I'm 57 and I want to get my pension sorted out before I retire.", [
    { factId: 'primary_goal', value: { type: 'improve_pension' }, certainty: 'exact' },
    { factId: 'person_current_age', value: 57, certainty: 'exact' }
  ]);
  await r.say("I'd like to retire at 62 if the numbers work.", [
    { factId: 'intended_retirement_age', value: 62, certainty: 'exact' }
  ]);
  await r.say('I earn 95,000 gross a year from my job.', [
    {
      factId: 'income_sources',
      value: {
        operation: 'upsert', entityId: 'job1', type: 'employment', owner: 'primary',
        grossAnnual: { amount: 95000, currency: 'EUR' }
      },
      certainty: 'exact'
    }
  ]);
  await r.say("I'd want about 45,000 a year.", [
    { factId: 'target_retirement_income', value: { amount: 45000, currency: 'EUR' }, certainty: 'approximate' }
  ]);
}

/** What goes into the pension, once there is a pension for it to go into. */
async function contributionDetails(r) {
  await r.say('I put in 6 percent and the company puts in 8 percent.', [
    { factId: 'pension_employee_contribution_rate', value: 6, certainty: 'exact' },
    { factId: 'pension_employer_contribution_rate', value: 8, certainty: 'exact' }
  ]);
  await r.say("Yes, it's still being paid into every month.", [
    { factId: 'pension_contribution_status', value: 'active', certainty: 'exact' }
  ]);
}

/* ============================================================== SCENARIO E */
/**
 * THE RACE IS THE COMMON CASE, NOT THE EDGE CASE.
 *
 * The planner starts from revision N. The client keeps talking. A live
 * save_facts advances the profile to N+1. The planner finishes holding a
 * correction prepared against state that no longer exists. Discarding it there
 * loses a repair the client already gave — at conversational cadence, on most
 * turns. The bounded rebase re-runs the SAME plan through deterministic
 * validation against the newer state instead, with no second model call.
 */
{
  const plannerLatencyMs = 3_000;
  let plans = 0;
  const r = await rig('scenario-e-race', {
    plannerLatencyMs,
    planFor: () => {
      plans += 1;
      // Only the first pass proposes anything: the repair whose survival is
      // the entire question. Later passes are clean, so nothing else can
      // account for the age arriving.
      return plans === 1
        ? {
          repairs: [{
            groupId: 'primary_age',
            operationId: 'primary_age',
            factId: 'person_current_age',
            factInstanceId: 'person_current_age:primary',
            entityId: 'primary',
            ownerId: 'primary',
            value: { age: 57 },
            quote: "I'm 57"
          }]
        }
        : null;
    }
  });

  // Turn 1 is material, so it schedules a reconciliation that will sit in the
  // planner for three seconds. The age is deliberately NOT saved by the live
  // lane — that omission is what the planner is repairing.
  await r.say("I'm 57 and I want to get my pension sorted out before I retire.", [
    { factId: 'primary_goal', value: { type: 'improve_pension' }, certainty: 'exact' }
  ], { wait: false });

  // The client carries straight on. This write lands while the planner is still
  // thinking, which is what makes the prepared plan stale.
  const interrupting = await r.say("I'd like to retire at 62 if the numbers work.", [
    { factId: 'intended_retirement_age', value: 62, certainty: 'exact' }
  ], { wait: false });

  assert.ok(interrupting.replyLatencyMs < plannerLatencyMs,
    `the reply must not wait for the planner: ${interrupting.replyLatencyMs}ms vs a ${plannerLatencyMs}ms planner`);

  await r.settle();

  const rebased = r.outcomes.filter((outcome) => outcome.rebasedFromRevisions.length > 0);
  assert.ok(rebased.length > 0,
    'the fixture must actually produce a stale reconciliation, or it proves nothing');
  assert.equal(r.planner.modelCalls(), r.outcomes.length,
    'a rebase must reuse the plan it already has — one model call per reconciliation, never two');

  const after = await r.profile();
  assert.equal(after.primaryPerson.age, 57,
    'the correction prepared against stale state must survive the rebase');
  assert.equal(Number(after.primaryPerson.intendedRetirementAge), 62,
    'and the newer live write it raced must not be overwritten by it');

  const stillNeeded = (await r.projection()).analyses
    .flatMap((analysis) => analysis.stillNeeded || [])
    .map((need) => need.factId);
  assert.ok(!stillNeeded.includes('person_current_age'),
    'refreshed readiness must reflect the rebased repair, not the state it was prepared against');

  r.planner.restore();
  pass('E — a correction survives the client talking over the planner, with no second model call');
}

/* ============================================================== SCENARIO G */
/**
 * THE ARITHMETIC, CHECKED AGAINST SOMETHING OTHER THAN ITSELF.
 *
 * `module_completed` is not a result. The expectations below are computed here
 * from the stated inputs and the module's own published assumptions, so a
 * change to the engine that alters a figure has to be justified rather than
 * absorbed. The age-band step is the part worth guarding: Irish age-related
 * relief goes 35% -> 40% at age 60, and this client crosses that line mid
 * projection.
 */
{
  const r = await rig('scenario-g-numbers', { mode: 'apply' });
  await personGroundwork(r);
  await r.say('The occupational pension is worth about 319,000 right now.',
    [holding('occ1', 'occupational', 319_000)]);
  await contributionDetails(r);
  await r.say('I have no partner, it is just me.', [
    { factId: 'partner_person', value: { operation: 'confirm_none' }, certainty: 'exact' }
  ]);

  const result = await r.confirmAndRun();
  assert.equal(result?.ok, true, `the analyses must run: ${result?.code || result?.status}`);

  const analysis = await getLatestAnalysis(r.meeting.env, r.meeting.sessionId, null);
  const pension = (analysis?.results || []).find((item) => item.moduleId === 'pension_projection');
  assert.ok(pension, 'pension_projection must be among the completed analyses');

  const chart = pension.charts.find((item) => Array.isArray(item.datasets)
    && item.datasets.some((set) => set.label === 'Pot (current)'));
  const series = (label) => chart.datasets.find((set) => set.label === label).data;
  const round = (value) => Math.round(value * 100) / 100;

  // An independent model of the same five years, from the module's own stated
  // assumptions: 5% growth on the opening pot plus that year's contributions,
  // 2% wage growth, relief capped at 35% of earnings to 59 and 40% from 60.
  const GROWTH = 0.05;
  const WAGE_GROWTH = 0.02;
  const expected = { pot: [319_000], potMax: [319_000], personal: [0], employer: [0], personalMax: [0] };
  let salary = 95_000;
  for (let year = 1; year <= 5; year += 1) {
    const age = 56 + year;
    const personal = salary * 0.06;
    const employer = salary * 0.08;
    const reliefBand = age >= 60 ? 0.40 : 0.35;
    const personalMax = salary * reliefBand;
    expected.personal.push(personal);
    expected.employer.push(employer);
    expected.personalMax.push(personalMax);
    expected.pot.push((expected.pot.at(-1) + personal + employer) * (1 + GROWTH));
    expected.potMax.push((expected.potMax.at(-1) + personalMax + employer) * (1 + GROWTH));
    salary *= 1 + WAGE_GROWTH;
  }

  for (const [label, model] of [
    ['Pot (current)', expected.pot],
    ['Pot (max)', expected.potMax],
    ['Personal (current)', expected.personal],
    ['Employer (current)', expected.employer],
    ['Personal (max)', expected.personalMax]
  ]) {
    assert.deepEqual(series(label).map(round), model.map(round),
      `${label} must match the independent model to the cent`);
  }

  // The band step, stated as its own claim so a silent flattening of the bands
  // fails here by name rather than as one row in a long array comparison.
  const personalMax = series('Personal (max)');
  assert.equal(round(personalMax[3] / series('Personal (current)')[3] * 0.06), 0.35,
    'relief must still be the 35% band at age 59');
  assert.equal(round(personalMax[4] / series('Personal (current)')[4] * 0.06), 0.40,
    'and must step to the 40% band at age 60');

  assert.ok(String(result.speakableText || '').length > 0,
    'the client must be given the deterministic spoken result, not silence');
  r.planner.restore();
  pass('G — the module arithmetic matches an independent model, including the age-60 relief step');
}

/* ============================================================== SCENARIO C */
/**
 * A SPOKEN TOTAL IS NOT A HOLDING.
 *
 * Three named pensions and then "about 640,000 altogether" must leave three
 * positions, not four. The failure this guards is the worst shape a defect can
 * take here: correct arithmetic over a canonical input that is wrong, so the
 * module confidently returns a number for a client who does not have that money.
 */
{
  /**
   * The planner does what a planner is for: it sees three named holdings and a
   * rounded total covering the same money, and takes the total back out of the
   * holdings.
   *
   * TWO THINGS HAVE TO BE RIGHT HERE AND BOTH ARE EASY TO GET WRONG.
   *
   * The note must be the POSITION note. One entity carries several — a
   * `pension_current_value` scalar sits beside the holding — and an operation
   * against the wrong one is accepted, applied, and changes nothing at all.
   *
   * And the reason code must be `incorrect_classification`, not
   * `aggregate_summary`. `aggregate_summary` asserts the note IS a summary, so
   * the validator refuses it on a position (`aggregate_not_a_position`) — the
   * guard doing its job. The claim being made here is narrower and true: this
   * was classified as a holding and should not have been.
   */
  let aggregateSeen = false;
  const r = await rig('scenario-c-aggregate', {
    mode: 'apply',
    planFor: ({ notes }) => {
      const phantom = notes.find((note) => note.factId === 'pension_positions'
        && note.noteKind === 'position'
        && note.source === 'realtime_note'
        && String(note.entityId || '').includes('total1'));
      if (!phantom || aggregateSeen) return null;
      aggregateSeen = true;
      return {
        repairs: [{
          groupId: 'aggregate',
          operationId: 'aggregate',
          op: 'retract_note',
          targetNoteId: phantom.noteId,
          factId: 'pension_positions',
          factInstanceId: `pension_positions:${phantom.entityId}`,
          entityId: phantom.entityId,
          ownerId: 'primary',
          noteKind: 'position',
          certainty: 'exact',
          reasonCode: 'incorrect_classification',
          value: {},
          quote: 'about 640,000'
        }]
      };
    }
  });
  await personGroundwork(r);
  await r.say('I have no partner, it is just me.', [
    { factId: 'partner_person', value: { operation: 'confirm_none' }, certainty: 'exact' }
  ]);

  // One pension per turn. Three figures in one breath, two of them the same
  // kind, is more than the live numeric guard will bind — it fails closed and
  // the reconciler is the repair path for that. What is under test HERE is the
  // aggregate rule, so the capture is kept unambiguous on purpose.
  // Each pension's contributions are stated while that pension is the one being
  // discussed. Three holdings means three sets of contribution facts, and a
  // rate stated in the abstract has no holding to attach to.
  const dormant = [
    { factId: 'pension_employee_contribution_rate', value: 0, certainty: 'exact' },
    { factId: 'pension_employer_contribution_rate', value: 0, certainty: 'exact' },
    { factId: 'pension_contribution_status', value: 'paid_up', certainty: 'exact' }
  ];
  await r.say('I have an old occupational pension worth 240,000.',
    [holding('old1', 'occupational', 240_000, 'primary', 'Old occupational pension')]);
  await r.say('That one is paid up — 0 percent from me and 0 percent from the employer.', dormant);
  await r.say('I also have a PRSA worth 85,000.',
    [holding('prsa1', 'prsa', 85_000)]);
  await r.say('The PRSA is paid up too — 0 percent from me and 0 percent from the employer.', dormant);
  await r.say('My current occupational pension is worth 319,000.',
    [holding('occ1', 'occupational', 319_000, 'primary', 'Current occupational pension')]);
  await contributionDetails(r);

  const threeHoldings = await r.profile();
  assert.equal(threeHoldings.pensions.length, 3, 'three named pensions must be three holdings');

  // The client restates the same money as a rounded total and the model saves
  // it as another position — the mistake this scenario exists for.
  //
  // THE FAST LANE DOES NOT STOP IT, AND IS NOT MEANT TO. `save_facts` is
  // permissive by design; the only hard gate in the lane is confirm_and_run.
  // So a phantom holding genuinely does appear in canonical state for a moment,
  // and the defence is that it cannot reach a module run: the turn is material,
  // so the confirmation barrier holds it until the auditor has reviewed it, and
  // the auditor reclassifies it as the summary it always was. Asserting the
  // phantom's existence here is deliberate — if the fast lane ever starts
  // refusing this, that is a behaviour change worth noticing, not a silent win.
  await r.say('Altogether it is about 640,000 across the pensions.',
    [holding('total1', 'other', 640_000)], { wait: false });
  const beforeReview = await r.profile();
  assert.equal(beforeReview.pensions.length, 4,
    'the permissive fast lane is expected to admit the total before review');

  await r.settle();

  const after = await r.profile();
  assert.equal(after.pensions.length, 3,
    `the auditor must retire the phantom holding — found ${after.pensions.length}`);
  assert.ok(aggregateSeen, 'the reclassification must actually have been proposed');
  const total = after.pensions.reduce((sum, item) => sum + Number(item.currentValue?.amount || 0), 0);
  assert.equal(total, 644_000,
    `the module must see the three real holdings only — got ${total}`);
  assert.ok(!after.pensions.some((item) => Number(item.currentValue?.amount) === 640_000),
    'and the aggregate figure itself must never appear as a position');

  const result = await r.confirmAndRun();
  assert.equal(result?.ok, true,
    `the analyses must still run: ${result?.code || result?.status}; outstanding: ${await r.outstanding()}`);
  const analysis = await getLatestAnalysis(r.meeting.env, r.meeting.sessionId, null);
  const pension = (analysis?.results || []).find((item) => item.moduleId === 'pension_projection');
  const openingPot = pension.charts
    .find((item) => Array.isArray(item.datasets)
      && item.datasets.some((set) => set.label === 'Pot (current)'))
    .datasets.find((set) => set.label === 'Pot (current)').data[0];
  assert.equal(openingPot, 644_000,
    `the projection must open from the real holdings, not the spoken total — got ${openingPot}`);

  r.planner.restore();
  pass('C — three holdings plus a spoken total stay three holdings, and the module sums them');
}

/* ============================================================== SCENARIO D */
/**
 * WHOSE MONEY IS IT.
 *
 * Facts for both people, interleaved. The partner's pension must not become the
 * client's, the client's age must not become the partner's, and each module
 * input must resolve to the person who actually holds it.
 */
{
  const r = await rig('scenario-d-owners', { mode: 'apply' });
  await personGroundwork(r);
  await r.say('My partner is 59.', [
    { factId: 'partner_person', value: { operation: 'upsert', entityId: 'partner', age: 59 }, certainty: 'exact' }
  ]);
  await r.say('My own occupational pension is worth 319,000.',
    [holding('occ1', 'occupational', 319_000)]);
  await r.say('My partner has a PRSA worth 120,000.',
    [holding('prsaP', 'prsa', 120_000, 'partner')]);

  const after = await r.profile();
  assert.equal(after.primaryPerson.age, 57, "the client's own age must stay the client's");
  assert.equal(Number(after.partner?.age), 59, "and the partner's age must stay the partner's");

  const byOwner = new Map(after.pensions.map((item) => [item.ownerId, item]));
  const held = after.pensions
    .map((item) => `${item.pensionId}:${item.ownerId}=${item.currentValue?.amount}`).join(', ');
  assert.equal(byOwner.size, 2, `two people with pensions must be two owners — got ${held}`);
  const primaryId = after.primaryPerson.personId;
  const partnerId = after.partner.personId;
  assert.equal(Number(byOwner.get(primaryId)?.currentValue?.amount), 319_000,
    "the client's pension must be the client's figure");
  assert.equal(Number(byOwner.get(partnerId)?.currentValue?.amount), 120_000,
    "and the partner's pension must be the partner's figure");
  assert.notEqual(byOwner.get(primaryId)?.pensionId, byOwner.get(partnerId)?.pensionId,
    'the two holdings must keep separate identities');

  // Income was stated for the client only, so it must not have acquired a
  // partner owner along the way.
  assert.ok((after.incomeSources || []).every((item) => (
    item.ownerIds.length === 1 && item.ownerIds[0] === primaryId
  )), 'income stated by the client must not be reassigned to, or shared with, the partner');

  r.planner.restore();
  pass('D — primary and partner facts keep their owners through the whole call');
}

console.info('\n[ConsumerLiveScenarios] PASS: the Phase 4 scenarios hold end to end');
