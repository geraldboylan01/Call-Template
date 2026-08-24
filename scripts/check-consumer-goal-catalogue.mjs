#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { GOAL_TYPES as CONTRACT_GOAL_TYPES } from '../js/planning/contracts.js';
import {
  GOAL_CATALOGUE,
  GOAL_TYPES,
  classifyGoalPriorityHint,
  detectCatalogueGoalCandidates,
  getGoalClientPhrase,
  getGoalTitle,
  goalClassificationPrompt,
  goalEvidenceMatches,
  goalProfilePriority,
  normalizeGoalCandidatePriorities
} from '../js/planning/goal_catalogue.js';
import { MODULE_MANIFEST } from '../js/planning/module_manifest.generated.js';
import { createHouseholdProfile } from '../js/planning/profile.js';
import { detectRulesOnlyGoalCandidates } from '../js/planning/rules_only_extraction.js';
import { mapPlannerExtractionToCandidates } from '../worker/src/consumer/planning_facts.js';
import { mapRealtimeFact } from '../worker/src/consumer/realtime_fact_mapper.js';
import { mergeSegmentExtractions } from '../worker/src/consumer/turn_segments.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let checks = 0;
const check = (label, condition, detail = '') => {
  checks += 1;
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
};

check('the public contract is catalogue-derived', CONTRACT_GOAL_TYPES === GOAL_TYPES);
check('goal ids are unique', new Set(GOAL_TYPES).size === GOAL_TYPES.length);
check('every goal has one title and client phrase', GOAL_CATALOGUE.every((item) => (
  getGoalTitle(item.type) === item.recordTitle
  && getGoalClientPhrase(item.type) === item.clientPhrase
)));
for (const module of MODULE_MANIFEST) {
  for (const route of module.routing?.goals || []) {
    check(`manifest route ${module.moduleId}/${route.type} names a catalogue goal`,
      GOAL_TYPES.includes(route.type));
  }
}

const cases = [
  {
    text: 'Today I need to clear the car loan; retirement can wait until next year.',
    expected: [['manage_loan', 'primary'], ['retire', 'secondary']]
  },
  {
    text: 'Compare putting extra into the workplace pension with paying down the home loan.',
    expected: [['optimise_mortgage', 'unspecified'], ['improve_pension', 'unspecified']]
  },
  {
    text: 'First show me our overall position, then let’s look at university costs.',
    expected: [['understand_position', 'primary'], ['fund_education', 'secondary']]
  },
  {
    text: 'I have a financial choice to make, but I do not yet know what it concerns.',
    expected: [['assess_decision', 'unspecified']]
  },
  {
    text: 'Longer term I want to grow investments, but right now I need an emergency buffer.',
    expected: [['maintain_liquidity', 'primary'], ['build_wealth', 'secondary']]
  },
  {
    text: 'Leave education funding for later; focus on clearing the mortgage now.',
    expected: [['optimise_mortgage', 'primary'], ['fund_education', 'secondary']]
  },
  {
    text: 'I want to plan farm succession and structure the transfer of the family business.',
    expectedTypes: ['agricultural_planning', 'business_planning']
  },
  {
    text: 'We need estate planning before gifting assets to the children.',
    expectedTypes: ['transfer_wealth']
  },
  {
    text: 'My main goal is to clear the mortgage, and later I want to fund college.',
    expected: [['optimise_mortgage', 'primary'], ['fund_education', 'secondary']]
  },
  {
    text: 'Eventually I want to fund college, and right now my main priority is to clear the mortgage.',
    expected: [['optimise_mortgage', 'primary'], ['fund_education', 'secondary']]
  },
  {
    text: 'I want to plan early retirement.',
    expected: [['retire_early', 'unspecified']]
  },
  {
    text: 'Our primary goal is repaying the mortgage, and the next priority is saving for university.',
    expected: [['optimise_mortgage', 'primary'], ['fund_education', 'secondary']]
  },
  {
    text: 'Retirement is a lower priority, while our immediate focus is building a cash buffer.',
    expected: [['maintain_liquidity', 'primary'], ['retire', 'secondary']]
  }
];

for (const fixture of cases) {
  const actual = detectCatalogueGoalCandidates(fixture.text);
  if (fixture.expected) {
    check(`classification and priority: ${fixture.text}`,
      JSON.stringify(actual.map((item) => [item.type, item.priorityHint])) === JSON.stringify(fixture.expected),
      JSON.stringify(actual));
  } else {
    check(`classification set: ${fixture.text}`,
      fixture.expectedTypes.every((type) => actual.some((item) => item.type === type)),
      JSON.stringify(actual));
  }
  check('rules-only fallback uses the same classifier',
    JSON.stringify(detectRulesOnlyGoalCandidates(fixture.text)) === JSON.stringify(actual));
  check('concrete multi-goal language never adds a vague decision',
    actual.length <= 1 || !actual.some((item) => item.type === 'assess_decision'));
}

// Backward compatibility belongs in tests, not as an incident-shaped prompt
// instruction. This exact opener must retain its semantics while the prompt is
// driven by general catalogue definitions.
const productionOpener = 'So I am 32 and I just had a baby. I really want a financial health check — '
  + 'where I stand, making sure I can look after the little one, get my mortgage paid off, '
  + 'and eventually get the baby into college.';
check('the paid-proof opener keeps all three distinct outcomes without fixture prompt text',
  JSON.stringify(detectCatalogueGoalCandidates(productionOpener).map((item) => [item.type, item.priorityHint]))
    === JSON.stringify([
      ['optimise_mortgage', 'unspecified'],
      ['understand_position', 'unspecified'],
      ['fund_education', 'secondary']
    ]),
  JSON.stringify(detectCatalogueGoalCandidates(productionOpener)));

for (const [text, expectedType] of [
  ['I am planning retirement.', 'retire'],
  ['We are building an emergency fund.', 'maintain_liquidity'],
  ['I am saving for university.', 'fund_education'],
  ['I am growing my investment portfolio.', 'build_wealth'],
  ['We are paying down the car loan.', 'manage_loan'],
  ['We need to consolidate our credit cards.', 'manage_loan'],
  ['I am contributing more to my pension.', 'improve_pension'],
  ['I would like to make extra contributions to my pension.', 'improve_pension'],
  ['I’d like help with retirement options.', 'retire'],
  ['I am hoping to move house next year.', 'buy_home'],
  ['Could you show me where our household stands?', 'understand_position'],
  ['Can we get a sense of where our household stands?', 'understand_position'],
  ['I never got round to starting a pension.', 'improve_pension'],
  ['Can we see whether the mortgage deal is too expensive?', 'optimise_mortgage'],
  ['I want to know whether our savings will last.', 'understand_position'],
  ['The loan is my biggest concern.', 'manage_loan'],
  ['We want to ensure we can afford to send our child to college.', 'fund_education']
]) {
  check(`ordinary morphology remains classifiable: ${text}`,
    detectCatalogueGoalCandidates(text).some((item) => item.type === expectedType),
    JSON.stringify(detectCatalogueGoalCandidates(text)));
}

check('early retirement suppresses the overlapping ordinary-retirement goal',
  JSON.stringify(detectCatalogueGoalCandidates('We want to plan early retirement and save for university.').map((item) => item.type))
    === JSON.stringify(['retire_early', 'fund_education']));

check('cross-goal exclusions are part of the strict grounding rule, not fallback-only cleanup',
  !goalEvidenceMatches('retire', 'We are planning early retirement.')
    && !goalEvidenceMatches('manage_loan', 'We want to pay down the home loan.')
    && !goalEvidenceMatches('assess_decision', 'We have a financial choice and want to buy a home.')
    && goalEvidenceMatches('manage_loan', 'We want to pay down the car loan.'));

check('ordinary desire is a goal but does not invent relative priority',
  JSON.stringify(detectCatalogueGoalCandidates('I want to retire and build wealth.').map((item) => [item.type, item.priorityHint]))
    === JSON.stringify([['retire', 'unspecified'], ['build_wealth', 'unspecified']]));
check('a general real-focus correction establishes priority without a fixture sentence',
  classifyGoalPriorityHint(
    'manage_loan',
    'Forget the other topic for now — the real focus is dealing with this expensive loan.'
  ) === 'primary');

check('several model primaries fail closed instead of becoming last-write-wins',
  normalizeGoalCandidatePriorities([
    { goalType: 'buy_home', priorityHint: 'primary' },
    { goalType: 'retire', priorityHint: 'primary' }
  ]).every((item) => item.priorityHint === 'unspecified'));

const mergedPrimaries = mergeSegmentExtractions([1, 2].map((index) => ({
  schemaVersion: 'PlannerExtractionV3',
  goalCandidates: [{
    candidateId: `goal-${index}`,
    goalType: index === 1 ? 'buy_home' : 'retire',
    confidence: 'high',
    priorityHint: 'primary',
    evidenceText: index === 1 ? 'buy a home' : 'retire'
  }],
  semanticFacts: [], positions: [], sectionCompletions: [], invalidCandidates: []
})), 'segmented-turn');
check('independent segment reads cannot each persist a primary focus',
  mergedPrimaries.goalCandidates.every((item) => item.priorityHint === 'unspecified'));

const refinedSegmentGoal = mergeSegmentExtractions([
  {
    schemaVersion: 'PlannerExtractionV3',
    goalCandidates: [{
      candidateId: 'goal-1', goalType: 'retire', confidence: 'high',
      priorityHint: 'unspecified', evidenceText: 'plan retirement'
    }],
    semanticFacts: [], positions: [], sectionCompletions: [], invalidCandidates: []
  },
  {
    schemaVersion: 'PlannerExtractionV3',
    goalCandidates: [{
      candidateId: 'goal-1', goalType: 'retire', confidence: 'high',
      priorityHint: 'secondary', evidenceText: 'retirement can wait'
    }],
    semanticFacts: [], positions: [], sectionCompletions: [], invalidCandidates: []
  }
], 'refined-goal-turn');
check('a later explicit rank refines an earlier neutral segment reading of the same goal',
  refinedSegmentGoal.goalCandidates.length === 1
    && refinedSegmentGoal.goalCandidates[0].priorityHint === 'secondary'
    && refinedSegmentGoal.goalCandidates[0].evidenceText === 'retirement can wait');

check('profile priority maps explicit order instead of catalogue match score',
  goalProfilePriority('primary') === 'high'
    && goalProfilePriority('secondary') === 'low'
    && goalProfilePriority('unspecified') === 'medium');

const secondaryExtraction = {
  goalCandidates: [{
    candidateId: 'goal-1', goalType: 'fund_education', confidence: 'high',
    priorityHint: 'secondary', evidenceText: 'eventually fund college', correctionTarget: ''
  }],
  semanticFacts: [], positions: [], sectionCompletions: []
};
const secondaryFact = mapPlannerExtractionToCandidates(secondaryExtraction)
  .find((candidate) => candidate.factId === 'primary_goal');
check('planner mapping carries the explicit secondary cue into the strict fact mapper',
  secondaryFact.value.priorityHint === 'secondary');
const emptyProfile = createHouseholdProfile({
  profileId: 'goal-priority-test',
  nowIso: '2026-08-23T00:00:00.000Z',
  calculationDateIso: '2026-08-23'
});
check('the strict mapper persists an explicit secondary as a lower-ranked active goal',
  mapRealtimeFact(emptyProfile, secondaryFact).canonicalValue.priority === 'low');
check('client evidence overrides an unsupported model primary hint',
  mapRealtimeFact(emptyProfile, {
    factId: 'primary_goal',
    value: { type: 'buy_home', priorityHint: 'primary' },
    certainty: 'exact',
    evidenceText: 'I would like to buy a home.'
  }).canonicalValue.priority === 'medium');

const conflictingModelFacts = mapPlannerExtractionToCandidates({
  goalCandidates: [
    { candidateId: 'goal-1', goalType: 'buy_home', confidence: 'high', priorityHint: 'primary', evidenceText: 'main home goal' },
    { candidateId: 'goal-2', goalType: 'retire', confidence: 'high', priorityHint: 'primary', evidenceText: 'main retirement goal' }
  ],
  semanticFacts: [], positions: [], sectionCompletions: []
});
check('candidate mapping independently enforces at most one model-derived primary focus',
  !conflictingModelFacts.some((candidate) => candidate.factId === 'primary_goal_focus')
    && conflictingModelFacts.filter((candidate) => candidate.factId === 'primary_goal')
      .every((candidate) => candidate.value.priorityHint === 'unspecified'));

for (const negative of [
  'I have a pension worth €100k and a mortgage balance of €350k.',
  'My daughter is already in university.',
  'I have a car loan balance of €12k.',
  'I have a company shareholding worth €80k.',
  'I own farmland worth €600k.',
  'The baby is asleep and our house is worth €400k.',
  'We are paying the mortgage arrangement fees this month.'
]) {
  check(`value/context is not silently promoted to a goal: ${negative}`,
    detectCatalogueGoalCandidates(negative).length === 0,
    JSON.stringify(detectCatalogueGoalCandidates(negative)));
}

const vocabulary = goalClassificationPrompt();
for (const definition of GOAL_CATALOGUE) {
  check(`prompt vocabulary includes ${definition.type}`,
    vocabulary.includes(`- ${definition.type}:`) && vocabulary.includes(definition.exclude));
}

const planner = readFileSync(`${root}/worker/src/consumer/realtime_planner.js`, 'utf8');
const live = readFileSync(`${root}/worker/src/consumer/live/catalogue_prompt.js`, 'utf8');
check('both prompts render the central vocabulary',
  /goalClassificationPrompt\(\)/.test(planner) && /goalClassificationPrompt\(\)/.test(live));
for (const fixtureFragment of [
  'pension worth €100,000 and stocks and shares worth €10,000',
  'get my baby into college',
  'understand_position, optimise_mortgage and fund_education'
]) {
  check(`incident-shaped prompt fragment is gone: ${fixtureFragment}`,
    !planner.includes(fixtureFragment) && !live.includes(fixtureFragment));
}

console.info(`[GoalCatalogue] ${checks} checks passed: one vocabulary drives classification, labels and prompts.`);
