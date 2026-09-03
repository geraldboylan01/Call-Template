#!/usr/bin/env node

import assert from 'node:assert/strict';
import { APPROVED_CONSUMER_MODULE_IDS } from '../worker/src/consumer/config.js';
import { interpretDirectModuleConversation } from '../worker/src/consumer/direct_module_planner.js';

if (!String(process.env.OPENAI_API_KEY || '').trim()) {
  console.error('OPENAI_API_KEY is required for this paid semantic eval.');
  process.exit(2);
}

const turns = [
  { id: 'assistant-1', role: 'assistant', transcript: 'What would you like to work through today?', answersTurnId: null },
  { id: 'client-1', role: 'user', transcript: 'I want to review my existing mortgage.', answersTurnId: 'assistant-1' },
  { id: 'assistant-2', role: 'assistant', transcript: 'What is the balance, interest rate and remaining term?', answersTurnId: null },
  { id: 'client-2', role: 'user', transcript: 'About two hundred and forty grand, 4.5 percent, and twenty two years.', answersTurnId: 'assistant-2' },
  { id: 'assistant-3', role: 'assistant', transcript: 'So that is roughly 240,000 at 4.5 percent with 22 years left?', answersTurnId: null },
  { id: 'client-3', role: 'user', transcript: 'Actually I checked, the rate is 4.1 percent.', answersTurnId: 'assistant-3' }
];

const result = await interpretDirectModuleConversation({
  env: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url')
  },
  config: {
    allowedModules: APPROVED_CONSUMER_MODULE_IDS,
    modulePlannerModel: process.env.CONSUMER_MODULE_PLANNER_MODEL || 'gpt-5.6-luna',
    modulePlannerReasoningEffort: 'low',
    modulePlannerTimeoutMs: 60_000,
    modulePlannerPromptVersion: 'direct-module-planner-v2',
    moduleVerifierPromptVersion: 'direct-module-verifier-v2'
  },
  turns,
  throughTurnId: 'client-3',
  currentProfileContext: {
    profileId: 'paid-direct-eval', revision: 1,
    primaryPerson: { personId: 'primary', displayName: 'Client' },
    partner: null,
    preferences: { baseCurrency: 'EUR' },
    assumptions: { calculationDateIso: '2026-09-02' }
  }
});

const mortgage = result.snapshot.modules.find((item) => item.moduleId === 'mortgage_analysis');
assert.ok(mortgage, 'mortgage module was omitted');
assert.equal(mortgage.status, 'ready');
assert.equal(mortgage.input.currentBalance, 240000);
assert.equal(mortgage.input.annualInterestRate, 0.041);
assert.equal(mortgage.input.remainingTermYears, 22);
assert.notEqual(mortgage.input.currentBalance, 240);
assert.notEqual(mortgage.input.annualInterestRate, 0.045);
assert.equal(result.verification.verdict, 'pass');
assert.ok(result.certificate?.signature);

console.info(JSON.stringify({
  status: 'pass',
  moduleId: mortgage.moduleId,
  moduleStatus: mortgage.status,
  input: mortgage.input,
  verification: result.verification,
  extractionUsage: result.extractionUsage,
  verificationUsage: result.verificationUsage
}, null, 2));
