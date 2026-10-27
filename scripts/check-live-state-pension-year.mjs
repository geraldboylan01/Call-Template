#!/usr/bin/env node

/**
 * THE STATE PENSION THE LIVE LANE STATES IS THE ONE FOR THE PLAN'S OWN YEAR.
 *
 * WHY THIS EXISTS. Budget 2027 raised the State Pension (Contributory), and the
 * retirement engine already uses the rate for the plan's own year. The Worker did
 * not: its public rule returned the 2026 rate whatever the date, and its spoken
 * confirmation, reviewed explanation, prompts and compliance check each said and
 * validated that rate. From 1 January 2027 a plan would have shown the new rate
 * while the meeting said, and checked itself against, the old one.
 *
 * The rate, its effective date and the Budget that announced it now come from the
 * register's `statePensionRuleForYear`, and the year is the PLAN's, handed in as a
 * year or a date.
 *
 * NOTHING HERE READS THE CLOCK, and the section that builds every piece of wording
 * runs with the clock made to throw, so this suite cannot go red on 1 January and
 * a builder cannot start reading the day without being caught. The amounts are
 * typed in this file on purpose: it is the independent statement of what a 2026
 * plan and a 2027 plan must hear, which the register is checked against.
 */
import assert from 'node:assert/strict';

import { planYearOf, publicIrishStatePensionRule, statePensionRuleForYear } from '../js/planning/ireland_rules.js';
import { getConsumerConfig } from '../worker/src/consumer/config.js';
import { buildLiveCataloguePrompt } from '../worker/src/consumer/live/catalogue_prompt.js';
import {
  createEmptySourcedFigureSet,
  createSourcedFigureSet,
  scanAssistantSpeech,
  sourceStatePensionRule
} from '../worker/src/consumer/live/compliance.js';
import { buildLiveSessionConfig } from '../worker/src/consumer/live/live_provider.js';
import { ConsumerLiveSession } from '../worker/src/consumer/live/live_session.js';
import { getCurrentProfile, getSessionRow } from '../worker/src/consumer/repository.js';
import { buildVoiceConfirmationSummary } from '../worker/src/consumer/realtime_completion.js';
import { composeMeetingBrief, intakeExplanation } from '../worker/src/consumer/realtime_planner.js';
import { buildRealtimeConversationV2Instructions } from '../worker/src/consumer/realtime_provider.js';
import { fakeDurableState, newLiveMeeting } from './live-harness/session.mjs';

// Two plans, a year apart. The dates are fixed here and nothing derives them.
const PLAN_2026 = '2026-12-31';
const PLAN_2027 = '2027-01-01';

const HEARS = Object.freeze({
  2026: Object.freeze({
    weekly: '€299.30', annual: '€15,563.60', weeklyAmount: '299.30', annualAmount: '15,563.60',
    effective: 'effective January 2026'
  }),
  2027: Object.freeze({
    weekly: '€309.30', annual: '€16,083.60', weeklyAmount: '309.30', annualAmount: '16,083.60',
    effective: 'effective January 2027, announced in Budget 2027'
  })
});
const other = (year) => HEARS[year === 2026 ? 2027 : 2026];
const stateRuleLine = (instructions) => String(instructions).split('\n')
  .find((entry) => entry.includes('server-owned Irish State Pension rule'));

let checks = 0;
function pass(message) {
  checks += 1;
  console.info(`[LiveStatePensionYear] PASS: ${message}`);
}

/** Run with the clock made to throw: any wording that reads the day fails here. */
function withoutAClock(callback) {
  const RealDate = Date;
  globalThis.Date = class NoClock extends RealDate {
    constructor(...args) {
      if (args.length === 0) throw new Error('the wording read the clock');
      super(...args);
    }
    static now() { throw new Error('the wording read the clock'); }
  };
  try {
    return callback();
  } finally {
    globalThis.Date = RealDate;
  }
}

/* ------------------------------------------------------------------ the rule */

{
  const now = publicIrishStatePensionRule(2026);
  assert.equal(now.weeklyMaximumEur, 299.30);
  assert.equal(now.annualMaximumEur, 15_563.60);
  assert.equal(now.effectiveFrom, '2026-01-01');
  assert.equal(now.status, 'in_force');
  assert.equal(now.announcedBy, null);

  const next = publicIrishStatePensionRule(2027);
  assert.equal(next.weeklyMaximumEur, 309.30);
  assert.equal(next.annualMaximumEur, 16_083.60);
  assert.equal(next.effectiveFrom, '2027-01-01');
  assert.equal(next.status, 'announced');
  assert.equal(next.announcedBy, 'Budget 2027');
  assert.match(next.source.ratesUrl, /budget-2027/, 'the 2027 rate cites the Budget that set it, not the year before');
  assert.match(now.source.ratesUrl, /budget-2026/);
  pass('the public rule is the rate for the plan\'s year: 299.30 in force for 2026, 309.30 announced by Budget 2027 for 2027');

  for (const year of [2026, 2027]) {
    const register = statePensionRuleForYear(year);
    const rule = publicIrishStatePensionRule(year);
    assert.equal(rule.weeklyMaximumEur, register.weeklyMaximumEur);
    assert.equal(rule.annualMaximumEur, register.annualMaximumEur);
    assert.equal(rule.effectiveFrom, register.effectiveFrom);
    assert.equal(rule.status, register.status);
    assert.equal(rule.weeklyMaximumEur, Number(HEARS[year].weeklyAmount), `${year}: this suite and the register agree`);
    assert.equal(rule.annualMaximumEur, Number(HEARS[year].annualAmount.replace(',', '')), `${year}: this suite and the register agree`);
  }
  pass('it is the register\'s rate, which this suite states independently');

  assert.equal(publicIrishStatePensionRule(PLAN_2026).weeklyMaximumEur, 299.30, 'the last day of 2026');
  assert.equal(publicIrishStatePensionRule(PLAN_2027).weeklyMaximumEur, 309.30, 'the first day of 2027');
  assert.equal(publicIrishStatePensionRule('2027-03-14T09:30:00.000Z').weeklyMaximumEur, 309.30, 'a full timestamp');
  assert.equal(planYearOf('2027'), 2027);
  pass('a plan date, a timestamp or a year all name the year, and the year changes on 1 January');

  for (const missing of [undefined, null, '', 'tomorrow', '27-01-01', Number.NaN, 20_27.5]) {
    assert.throws(() => publicIrishStatePensionRule(missing), /plan year or an ISO date is required/, `no default for ${String(missing)}`);
  }
  pass('a plan year is required: there is no default, so the rule never falls back to the day it is asked on');
}

/* -------------------------------------------------------- what the models are told */

const config = getConsumerConfig({});
for (const year of [2026, 2027]) {
  const planDateIso = year === 2026 ? PLAN_2026 : PLAN_2027;
  const mine = HEARS[year];
  const theirs = other(year);
  for (const directModulePlanning of [false, true]) {
    for (const channel of ['voice', 'text']) {
      const prompt = withoutAClock(() => buildLiveCataloguePrompt({ directModulePlanning, channel, planDateIso }));
      assert.ok(
        prompt.includes(`State Pension (Contributory), maximum rate ${mine.effective}: EUR ${mine.weeklyAmount} a week, EUR ${mine.annualAmount} gross a year, normally from age 66, escalating 2% a year.`),
        `${year} ${channel}${directModulePlanning ? ' direct' : ''}: the prompt states the rate for ${year}`
      );
      assert.ok(!prompt.includes(theirs.weeklyAmount) && !prompt.includes(theirs.annualAmount), `${year}: the prompt carries no amount from the other year`);
      assert.equal(prompt.includes('Budget 2027'), year === 2027, `${year}: the Budget is named exactly while the rate is announced`);
      assert.equal(prompt, buildLiveCataloguePrompt({ directModulePlanning, channel, planDateIso }), 'byte-stable for the provider cache');
    }
  }
  const session = withoutAClock(() => buildLiveSessionConfig(config, { planDateIso }));
  assert.equal(session.instructions, buildLiveCataloguePrompt({ planDateIso }), 'the voice session is opened with that prompt');
}
assert.notEqual(
  buildLiveCataloguePrompt({ planDateIso: PLAN_2026 }),
  buildLiveCataloguePrompt({ planDateIso: PLAN_2027 }),
  'two plan years are two prompts, each cached on its own'
);
assert.throws(() => buildLiveCataloguePrompt(), /plan year or an ISO date is required/);
assert.throws(() => buildLiveSessionConfig(config), /plan year or an ISO date is required/);
pass('a 2026 plan\'s prompt says 299.30 and never 309.30; a 2027 plan\'s says 309.30, names Budget 2027, and never says 299.30; none builds without a plan date');

for (const year of [2026, 2027]) {
  const rule = publicIrishStatePensionRule(year);
  const instructions = withoutAClock(() => buildRealtimeConversationV2Instructions({ meetingBrief: { statePensionRule: rule } }));
  const line = stateRuleLine(instructions);
  assert.ok(line.includes(`maximum ${HEARS[year].weekly} a week or ${HEARS[year].annual} gross a year ${HEARS[year].effective}, default age 66, escalated 2% annually`), `${year}: the v2 instructions follow the brief's rule`);
  assert.ok(!line.includes(other(year).weekly), `${year}: nothing from the other year`);
}
{
  const bare = buildRealtimeConversationV2Instructions({});
  const line = stateRuleLine(bare);
  assert.ok(!/€\d/.test(line), 'a brief with no rule gives the model no amount to state');
  assert.match(line, /state no State Pension amount without it/);
}
pass('the v2 voice instructions state the rule in the signed brief, and no amount when the brief has none');

/* ---------------------------------------------------------- what the client hears */

for (const year of [2026, 2027]) {
  const rule = publicIrishStatePensionRule(year);
  const summary = withoutAClock(() => buildVoiceConfirmationSummary({
    analyses: [{ moduleId: 'pension_projection' }],
    statePensionRule: rule
  }));
  assert.ok(
    summary.includes(`the editable maximum-rate assumption of ${HEARS[year].annual} gross a year, ${HEARS[year].effective}, with a default start age of 66.`),
    `${year}: the spoken confirmation states the rate for ${year}`
  );
  assert.ok(summary.includes('before escalating it by 2% a year'));
  assert.ok(!summary.includes(other(year).annual), `${year}: nothing from the other year`);
  assert.equal(summary.includes('Budget 2027'), year === 2027);

  const explanation = withoutAClock(() => intakeExplanation('state_pension', null, { planDateIso: year === 2026 ? PLAN_2026 : PLAN_2027 }));
  assert.ok(
    explanation.includes(`the maximum Irish State Pension (Contributory) rate is ${HEARS[year].weekly} a week, or ${HEARS[year].annual} gross a year (${HEARS[year].effective}), normally from age 66. The editable assumption escalates by 2% a year.`),
    `${year}: the reviewed explanation states the rate for ${year}`
  );
  assert.ok(!explanation.includes(other(year).weekly) && !explanation.includes(other(year).annual));
  assert.ok(!/you should/i.test(`${summary} ${explanation}`), 'no "you should"');
}
{
  const withoutAmounts = buildVoiceConfirmationSummary({
    analyses: [{ moduleId: 'pension_projection' }],
    statePensionRule: { perPersonAssumptions: [{ label: 'You', fraction: 1, startAge: 66 }] }
  });
  assert.ok(!/€\d/.test(withoutAmounts), 'a rule without its amounts says none, rather than one from somewhere else');
  assert.throws(() => intakeExplanation('state_pension', null), /plan year or an ISO date is required/);
  assert.match(intakeExplanation('net_worth'), /what you own minus what you owe/, 'other explanations need no plan date');
}
pass('a 2026 plan hears 299.30 (€15,563.60 a year) and a 2027 plan hears 309.30 (€16,083.60 a year) with Budget 2027 named, in the confirmation and the explanation');

/* ----------------------------------------------- the brief carries the plan's rule */

{
  const env = { CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url') };
  const briefFor = (calculationDateIso) => composeMeetingBrief({
    env,
    sourceTurnId: 'item_state_pension_year',
    extraction: {
      narrativeSummary: { summary: 'A person planning retirement.', evidence: ['planning retirement'] },
      clientQuestion: { present: false, intent: 'none', topic: '', questionText: '' },
      ambiguities: []
    },
    context: {
      sessionRow: { current_profile_revision: 1 },
      profile: { assumptions: { calculationDateIso } },
      state: {
        profileRevision: 1,
        goalAssessment: { activeGoalTypes: ['retire'], deferredGoalTypes: [] },
        moduleSlots: [{ moduleId: 'pension_projection', availability: 'needs_facts', intakeStatus: 'missing_information' }],
        recommendations: [{
          moduleId: 'pension_projection',
          requiredMissing: [{ factId: 'person_current_age', reason: 'Age is required.' }]
        }],
        facts: []
      }
    }
  });
  const brief2026 = await briefFor(PLAN_2026);
  const brief2027 = await briefFor(PLAN_2027);
  assert.equal(brief2026.statePensionRule.weeklyMaximumEur, 299.30);
  assert.equal(brief2027.statePensionRule.weeklyMaximumEur, 309.30);
  assert.equal(brief2027.statePensionRule.announcedBy, 'Budget 2027');
  // What the planning turn then says, built from the brief exactly as it does.
  const confirmation = (brief) => buildVoiceConfirmationSummary({
    narrativeSummary: brief.narrativeSummary,
    analyses: brief.analyses,
    statePensionRule: brief.statePensionRule,
    understood: brief.understood
  });
  assert.ok(confirmation(brief2026).includes(`${HEARS[2026].annual} gross a year, ${HEARS[2026].effective}, with`), 'the 2026 brief\'s confirmation');
  assert.ok(confirmation(brief2027).includes(`${HEARS[2027].annual} gross a year, ${HEARS[2027].effective}, with`), 'the 2027 brief\'s confirmation');
  assert.ok(!confirmation(brief2027).includes('15,563.60'));
  await assert.rejects(() => briefFor(undefined), /plan year or an ISO date is required/);
}
pass('the signed brief carries the rule for the profile\'s own date, so the plan and the meeting agree on 1 January');

/* ---------------------------------------------------------------- compliance */

for (const year of [2026, 2027]) {
  const sourced = createSourcedFigureSet(year === 2026 ? PLAN_2026 : PLAN_2027);
  const mine = HEARS[year];
  const theirs = other(year);
  assert.ok(!scanAssistantSpeech(`The maximum is ${mine.weekly} a week, or ${mine.annual} a year.`, sourced).tripped, `${year}: its own rate is sourced`);
  assert.ok(!scanAssistantSpeech(`That is ${mine.weekly} a week.`, sourced).tripped);
  assert.ok(scanAssistantSpeech(`The maximum is ${theirs.weekly} a week.`, sourced).tripped, `${year}: the other year's weekly rate is not sourced`);
  assert.ok(scanAssistantSpeech(`That is ${theirs.annual} a year.`, sourced).tripped, `${year}: the other year's annual rate is not sourced`);
}
{
  const empty = createEmptySourcedFigureSet();
  assert.deepEqual(empty.values, []);
  assert.ok(scanAssistantSpeech('The maximum is €299.30 a week.', empty).tripped, 'nothing is sourced until the plan is known');
  const set = sourceStatePensionRule(empty, PLAN_2027);
  const once = [...set.values];
  sourceStatePensionRule(set, PLAN_2027);
  assert.deepEqual(set.values, once, 'adding the rule twice leaves the set as it was');
  assert.ok(once.includes(309.30) && once.includes(16_083.60) && !once.includes(299.30));
  assert.throws(() => createSourcedFigureSet(), /plan year or an ISO date is required/);
  assert.throws(() => sourceStatePensionRule(createEmptySourcedFigureSet()), /plan year or an ISO date is required/);
}
pass('the compliance check sources the rule in force for the plan\'s year and no other: 2026 plan 299.30, 2027 plan 309.30');

/* ---------------------------------------------------- the meeting that holds it */

{
  const meeting = await newLiveMeeting('state-pension-year');
  const meta = { sessionId: meeting.sessionId, leaseId: meeting.meetingId, channel: 'voice', hardExpiresAt: '2035-01-01T00:00:00.000Z', idleExpiresAt: '2035-01-01T00:00:00.000Z' };

  // A lease that keeps the plan date: the object rebuilds with the rule for it,
  // even when the stored figures lost it, and never reads the profile or the clock.
  for (const [planDateIso, year] of [[PLAN_2026, 2026], [PLAN_2027, 2027]]) {
    const durable = fakeDurableState({ lease: { ...meta, planDateIso }, sourcedFigures: [] });
    const session = new ConsumerLiveSession(durable.state, { ...meeting.env, CONSUMER_DB: null });
    await durable.initialized();
    assert.equal(await session.planDateIso(), planDateIso);
    assert.ok(session.sourcedFigures.values.includes(Number(HEARS[year].weeklyAmount)), `${year}: rebuilt with the rate for ${year}`);
    assert.ok(!session.sourcedFigures.values.includes(Number(other(year).weeklyAmount)), `${year}: and not the other year's`);
    assert.ok(session.currentResponseSourcedFigures.values.includes(Number(HEARS[year].weeklyAmount)));
    const context = session.createResponseContext({ responseId: `resp_${year}`, rootResponseId: `resp_${year}`, causeItemId: null });
    assert.ok(context.sourcedFigures.values.includes(Number(HEARS[year].annualAmount.replace(',', ''))), `${year}: a response starts with the plan's rate`);
  }

  // A meeting that began before the lease kept the date reads it from the plan
  // once, keeps it, and sources the rule for that year.
  const sessionRow = await getSessionRow(meeting.env, meeting.sessionId);
  const profile = await getCurrentProfile(meeting.env, sessionRow);
  const planDateIso = profile.assumptions.calculationDateIso;
  const rule = publicIrishStatePensionRule(planDateIso);
  const durable = fakeDurableState({ lease: meta });
  const session = new ConsumerLiveSession(durable.state, meeting.env);
  await durable.initialized();
  assert.ok(!session.sourcedFigures.values.includes(rule.weeklyMaximumEur), 'nothing is sourced before the plan is known');
  assert.equal(await session.planDateIso(), planDateIso, 'the plan\'s own date, from the profile');
  assert.equal(durable.values.get('lease').planDateIso, planDateIso, 'kept on the lease');
  assert.ok(session.sourcedFigures.values.includes(rule.weeklyMaximumEur), 'and the plan\'s rate is now sourced');
}
pass('the live meeting holds the plan\'s date on its lease and sources that year\'s rate on activation and on every rebuild');

console.info(`[LiveStatePensionYear] ${checks} checks passed.`);
