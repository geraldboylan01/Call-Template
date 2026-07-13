import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildSubscriptionAssistPrompt,
  isSubscriptionAssistCohort
} from '../js/plan/subscription_assist.js';

assert.equal(isSubscriptionAssistCohort('adviser_test'), true);
assert.equal(isSubscriptionAssistCohort('internal'), false);
assert.throws(() => buildSubscriptionAssistPrompt({ question: 'Goal?', draft: '  ' }), /draft answer/i);

const prompt = buildSubscriptionAssistPrompt({
  question: 'When would you like to buy?',
  draft: 'About three years; I have roughly €20,000 saved.'
});
assert.match(prompt, /When would you like to buy\?/);
assert.match(prompt, /roughly €20,000 saved/);
assert.match(prompt, /Do not infer, calculate, advise, recommend, or add figures/);
assert.doesNotMatch(prompt, /JSON response/i);

const credentialSafePrompt = buildSubscriptionAssistPrompt({
  question: 'What matters most?',
  draft: `My invite is ci1.${'a'.repeat(40)}.${'b'.repeat(43)} and session is cs_${'c'.repeat(24)}.${'d'.repeat(43)}.`
});
assert.doesNotMatch(credentialSafePrompt, /\bci1\./);
assert.doesNotMatch(credentialSafePrompt, /\bcs_/);
assert.match(credentialSafePrompt, /private Planéir invite removed/);
assert.match(credentialSafePrompt, /private Planéir session credential removed/);

const viewsSource = readFileSync(new URL('../js/plan/views.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../js/plan/app.js', import.meta.url), 'utf8');
assert.match(viewsSource, /isSubscriptionAssistCohort\(currentState\.bootstrap\?\.cohort\)/);
assert.match(viewsSource, /copy\.dataset\.action = 'copy-subscription-prompt'/);
assert.match(viewsSource, /href = 'https:\/\/chatgpt\.com\/'/);
assert.match(appSource, /buildSubscriptionAssistPrompt/);
assert.match(appSource, /navigator\.clipboard\.writeText/);

console.log('Consumer subscription-assist checks passed.');
