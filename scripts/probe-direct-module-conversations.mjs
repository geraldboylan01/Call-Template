#!/usr/bin/env node

/**
 * Paid real-model probe: realistic conversations through the background planner.
 *
 * NOTHING HERE NAMES A MODULE. Each scenario is a person describing a goal in
 * ordinary language, and module selection is the planner's to get right. The
 * conversations deliberately carry the things a transcript actually contains:
 * facts volunteered out of order, several numbers in one breath, spoken
 * quantities like "70 grand", ownership, a correction, a categorical "none",
 * and current facts sitting beside hypothetical ones.
 *
 * Usage: node scripts/probe-direct-module-conversations.mjs [scenarioId ...]
 */

import { APPROVED_CONSUMER_MODULE_IDS } from '../worker/src/consumer/config.js';
import { interpretDirectModuleConversation } from '../worker/src/consumer/direct_module_planner.js';

if (!String(process.env.OPENAI_API_KEY || '').trim()) {
  console.error('OPENAI_API_KEY is required for this paid semantic probe.');
  process.exit(2);
}

const TODAY = '2026-09-03';

const baseEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url')
};
const baseConfig = {
  allowedModules: APPROVED_CONSUMER_MODULE_IDS,
  modulePlannerModel: process.env.CONSUMER_MODULE_PLANNER_MODEL || 'gpt-5.6-luna',
  modulePlannerReasoningEffort: 'low',
  modulePlannerTimeoutMs: 120_000,
  modulePlannerPromptVersion: 'direct-module-planner-v6',
  moduleVerifierPromptVersion: 'direct-module-verifier-v3'
};

function profile({ partner = false } = {}) {
  return {
    profileId: 'conversation-probe',
    revision: 1,
    primaryPerson: { personId: 'primary', displayName: 'Client' },
    partner: partner ? { personId: 'partner', displayName: 'Partner' } : null,
    preferences: { baseCurrency: 'EUR' },
    assumptions: { calculationDateIso: TODAY }
  };
}

/** Alternating adviser/client script -> planner turn rows. */
function script(lines) {
  return lines.map((text, index) => ({
    id: (index % 2 === 0 ? 'a' : 'c') + String(Math.floor(index / 2) + 1),
    role: index % 2 === 0 ? 'assistant' : 'user',
    transcript: text,
    answersTurnId: index % 2 === 1 ? 'a' + String(Math.floor(index / 2) + 1) : null
  }));
}

const SCENARIOS = [
  {
    id: 'pbs',
    expect: 'personal_balance_sheet',
    note: 'overall position; two owners; a correction; "no other debts"',
    partner: true,
    turns: script([
      'What would you like to work through today?',
      // Goal stated as an outcome, never as a module.
      'Honestly we just want to see where we actually stand. We have never added it all up in one place.',
      'That is a good place to start. What do you own between you?',
      // Several numbers and two owners in one breath, out of order.
      'The house is worth about six hundred and fifty thousand, we owe three hundred and ten on it. I have around forty grand in savings and my husband has twelve thousand in his credit union.',
      'And anything else on the asset side?',
      // Ownership + a pension mentioned late.
      'My pension is about ninety thousand. His is smaller, maybe thirty five.',
      'Any other borrowings apart from the mortgage?',
      // Categorical none.
      'No others, that is the only debt we have.',
      'Roughly what do you spend in a month?',
      // A correction inside the same turn.
      'About four and a half thousand. Actually no, closer to five thousand once you count the childcare.'
    ])
  },
  {
    id: 'liquidity',
    expect: 'liquidity_analysis',
    note: 'cash-only boundary; property and pension mentioned but must be excluded',
    partner: false,
    turns: script([
      'What is on your mind at the moment?',
      // Goal implies a buffer question without naming one.
      'I keep worrying about what would happen if I lost my job. I want to know if I could cope for a while.',
      'That makes sense. How much do you have available if you needed it quickly?',
      // Cash split across accounts, plus non-cash the module must exclude.
      'I have twenty two thousand in a deposit account and about three grand in the current account. There is my apartment too, that is worth around three hundred thousand, and a pension of sixty odd thousand.',
      'And what do your outgoings come to each month?',
      'Roughly two and a half thousand a month.',
      'Are you working at the moment?',
      'Yes, full time.'
    ])
  },
  {
    id: 'loan',
    expect: 'loan_analysis',
    note: 'two loans exist; the client names which one to look at; mortgage must not be selected',
    partner: false,
    turns: script([
      'What would you like to look at?',
      // Two debts named, only one is the subject.
      'I have a car loan that is really annoying me and I want to know if paying extra off it is worth it. I also have a mortgage but I am not worried about that one.',
      'Tell me about the car loan.',
      // Several figures in one answer, spoken naturally.
      'There is about eighteen grand left on it, the rate is eight and a half percent, and I think there are four years to run.',
      'Were you thinking of overpaying it?',
      // Hypothetical sitting beside current facts.
      'Yes, I was thinking maybe five hundred a year extra, just to see what difference it makes.',
      'And the mortgage, just so I have the picture?',
      'That is two hundred and forty thousand at four point one, twenty two years left. But leave that alone for now.'
    ])
  },
  {
    id: 'college',
    expect: 'college_funding',
    note: 'three children, ages in one answer; costs are server policy and must not be asked',
    partner: true,
    turns: script([
      'What brought you in today?',
      'We have three kids and college is starting to feel very close. I want to know what we are facing.',
      'How old are they?',
      // Three ages in one breath, out of order, one by name only.
      'Sarah is sixteen, Conor is thirteen and the youngest, Ellie, is nine.',
      'Will they be living at home or away, do you think?',
      // Mixed, and explicitly uncertain for one.
      'Sarah will almost certainly be away, she wants Galway. Conor would be at home. We honestly do not know about Ellie yet.',
      'Is there anything set aside for it already?',
      'Not really, no.'
    ])
  },
  {
    id: 'house',
    expect: 'house_purchase',
    note: 'first home affordability; must not be read as an existing mortgage; "70 grand"',
    partner: true,
    turns: script([
      'What would you like to figure out?',
      // The user's own example: affordability of a first home.
      'We want to know if we can afford to buy our first place. We are renting at the moment.',
      'What have you managed to put together so far?',
      // Spoken quantity, two salaries, several numbers at once.
      'We have about 70 grand saved between us. I earn seventy two thousand and my partner earns fifty eight.',
      'Do you have a price in mind?',
      // Hypothetical target, not a current holding.
      'We have been looking at places around four hundred and twenty thousand, second hand, in Dublin.',
      'Have either of you owned a home before?',
      'No, neither of us. This would be our first.',
      'And is any of that saving spoken for?',
      // A carve-out that must not become part of the deposit.
      'We want to keep ten thousand of it back as a rainy day fund, so it is not all available for the deposit.'
    ])
  }
];

const wanted = process.argv.slice(2);
const selected = wanted.length
  ? SCENARIOS.filter((item) => wanted.includes(item.id))
  : SCENARIOS;
if (!selected.length || wanted.some((id) => !SCENARIOS.some((item) => item.id === id))) {
  throw new Error('Choose an existing conversation scenario.');
}

const results = [];
for (const scenario of selected) {
  const started = Date.now();
  let outcome;
  try {
    const result = await interpretDirectModuleConversation({
      env: baseEnv,
      config: baseConfig,
      turns: scenario.turns,
      throughTurnId: scenario.turns.at(-1).id,
      currentProfileContext: profile({ partner: scenario.partner })
    });
    const relevant = result.snapshot.modules.filter((item) => item.status !== 'not_relevant');
    outcome = {
      ok: true,
      selected: relevant.map((item) => item.moduleId),
      statuses: Object.fromEntries(relevant.map((item) => [item.moduleId, item.status])),
      missing: Object.fromEntries(relevant.map((item) => [
        item.moduleId, (item.missing || []).map((x) => x.path || x.label || JSON.stringify(x))
      ])),
      ambiguities: Object.fromEntries(relevant.map((item) => [
        item.moduleId, (item.ambiguities || []).map((x) => x.question || x.label || JSON.stringify(x))
      ])),
      generalAmbiguities: (result.snapshot.generalAmbiguities || []).map((x) => x.question || JSON.stringify(x)),
      steering: Object.fromEntries(relevant.map((item) => [item.moduleId, item.steeringSummary])),
      inputs: Object.fromEntries(relevant.map((item) => [item.moduleId, item.input])),
      verification: result.verification
        ? { verdict: result.verification.verdict, explanation: result.verification.explanation }
        : null,
      certificate: Boolean(result.certificate?.signature),
      confirmationPrompt: result.snapshot.confirmationPrompt || null
    };
  } catch (error) {
    outcome = {
      ok: false,
      code: error?.code || 'unknown',
      message: error?.message || String(error),
      details: error?.details ?? null
    };
  }
  outcome.elapsedMs = Date.now() - started;
  results.push({ id: scenario.id, expect: scenario.expect, note: scenario.note, outcome });
  console.log(JSON.stringify({ scenario: scenario.id, expect: scenario.expect, ...outcome }, null, 1));
  console.log('\n' + '='.repeat(78) + '\n');
}

console.log('SUMMARY');
for (const row of results) {
  const o = row.outcome;
  const sel = o.ok ? o.selected.join('+') || '(none)' : 'ERROR ' + o.code;
  const hit = o.ok && o.selected.includes(row.expect) ? 'selected' : 'MISSED';
  console.log(`  ${row.id.padEnd(10)} expect=${row.expect.padEnd(24)} got=${sel.padEnd(34)} ${hit}`);
}
if (results.some(({ expect, outcome }) => !outcome.ok || !outcome.selected.includes(expect))) {
  process.exitCode = 1;
}
