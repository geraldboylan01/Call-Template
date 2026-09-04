#!/usr/bin/env node

/**
 * Paid real-model probe for the behaviours the first live call depends on.
 *
 * The scripted harness proves the plumbing; this proves the only part the
 * harness mocks. Every item here is one of the acceptance behaviours for the
 * first Planéir call: a spoken quantity, two owners, several figures in one
 * answer, a categorical "no others", and a spoken correction. Each is meaning,
 * so each belongs to the model -- none of them may become a parser.
 */

import { APPROVED_CONSUMER_MODULE_IDS } from '../worker/src/consumer/config.js';
import { interpretDirectModuleConversation } from '../worker/src/consumer/direct_module_planner.js';

if (!String(process.env.OPENAI_API_KEY || '').trim()) {
  console.error('OPENAI_API_KEY is required for this paid semantic probe.');
  process.exit(2);
}

const env = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url')
};
const config = {
  allowedModules: APPROVED_CONSUMER_MODULE_IDS,
  modulePlannerModel: process.env.CONSUMER_MODULE_PLANNER_MODEL || 'gpt-5.6-luna',
  modulePlannerReasoningEffort: 'low',
  modulePlannerTimeoutMs: 90_000,
  modulePlannerPromptVersion: 'direct-module-planner-v6',
  moduleVerifierPromptVersion: 'direct-module-verifier-v3'
};
const profile = {
  profileId: 'acceptance-probe', revision: 1,
  primaryPerson: { personId: 'primary', displayName: 'Client' },
  partner: { personId: 'partner', displayName: 'Partner' },
  preferences: { baseCurrency: 'EUR' },
  assumptions: { calculationDateIso: '2026-09-03' }
};

const turns = [
  { id: 'a1', role: 'assistant', transcript: 'What would you like to look at today?', answersTurnId: null },
  { id: 'c1', role: 'user', transcript: 'My wife and I want to know if our pensions are on track for retiring at sixty.', answersTurnId: 'a1' },
  { id: 'a2', role: 'assistant', transcript: 'Can you tell me your ages and what each of you has in your pensions?', answersTurnId: null },
  // Several figures and two owners in one answer.
  { id: 'c2', role: 'user', transcript: 'I am forty two and she is forty, mine is worth about three hundred and ten thousand and hers is one hundred and eighty five thousand.', answersTurnId: 'a2' },
  { id: 'a3', role: 'assistant', transcript: 'And what are you each putting in at the moment?', answersTurnId: null },
  // A spoken quantity in words.
  { id: 'c3', role: 'user', transcript: 'Between us about two and a half thousand a month, split evenly.', answersTurnId: 'a3' },
  { id: 'a4', role: 'assistant', transcript: 'Do either of you have any other pensions from previous jobs?', answersTurnId: null },
  // Categorical none after the collection has been discussed.
  { id: 'c4', role: 'user', transcript: 'No others, that is everything.', answersTurnId: 'a4' },
  { id: 'a5', role: 'assistant', transcript: 'What annual income would you like in retirement?', answersTurnId: null },
  { id: 'c5', role: 'user', transcript: 'Say sixty thousand a year. Actually, make that seventy thousand.', answersTurnId: 'a5' }
];

const result = await interpretDirectModuleConversation({
  env, config, turns, throughTurnId: 'c5', currentProfileContext: profile
});

const relevant = result.snapshot.modules.filter((m) => m.status !== 'not_relevant');
console.info(JSON.stringify({
  relevantModules: relevant.map((m) => ({
    moduleId: m.moduleId,
    status: m.status,
    missing: (m.missing || []).map((x) => x.path || x.label || x),
    ambiguities: (m.ambiguities || []).map((x) => x.question || x.label || x),
    steeringSummary: m.steeringSummary
  })),
  readyToConfirm: relevant.length > 0 && relevant.every((m) => m.status === 'ready'),
  verificationVerdict: result.verification?.verdict || null,
  confirmationPrompt: result.snapshot.confirmationPrompt || null,
  pensionInput: relevant.find((m) => m.moduleId === 'pension_projection')?.input ?? null
}, null, 1));
