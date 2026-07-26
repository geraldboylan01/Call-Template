import assert from 'node:assert/strict';

import {
  FACT_CONFIRMATION_POLICIES,
  FACT_SENSITIVITIES,
  FACT_VALUE_TYPES,
  MAX_SPEAKABLE_TEXT_CHARACTERS,
  SEMANTIC_FACT_CATALOGUE,
  applyProfilePatch,
  buildQuestionPlan,
  createHouseholdProfile,
  getSemanticFactDefinition,
  resolveSemanticFact,
  runConsumerAnalysis,
  summarizeAnalysisResults
} from '../js/planning/index.js';

const NOW = '2026-07-14T09:00:00.000Z';
const CALCULATION_DATE = '2026-07-14';
const cases = [];

async function runCase(name, fn) {
  try {
    await fn();
    cases.push({ name, passed: true });
    console.info(`[ConsumerQuestionPlan] PASS: ${name}`);
  } catch (error) {
    cases.push({ name, passed: false, error: error?.stack || String(error) });
    console.error(`[ConsumerQuestionPlan] FAIL: ${name}\n${error?.stack || error}`);
  }
}

function emptyProfile(profileId) {
  return createHouseholdProfile({
    profileId,
    nowIso: NOW,
    calculationDateIso: CALCULATION_DATE
  });
}

function apply(profile, operations) {
  return applyProfilePatch(profile, {
    patchId: `question-plan-${profile.revision + 1}`,
    operations: operations.map((operation) => ({
      ...operation,
      provenance: {
        source: 'user_statement',
        confidence: 'high',
        certainty: 'exact',
        capturedAt: NOW,
        confirmedByUser: false
      }
    }))
  }, { nowIso: NOW }).profile;
}

function missing(fieldPath, moduleId, importance = 'required', reason = `Missing ${fieldPath}`) {
  return { fieldPath, reason, blockingModuleIds: [moduleId], importance };
}

function source(moduleId, required, requiredMissing) {
  return {
    moduleId,
    required,
    readiness: { status: 'missing_information', requiredMissing, assumptionsUsed: [], warnings: [] }
  };
}

function incompleteHomeProfile() {
  return apply(emptyProfile('profile-question-plan-incomplete'), [{
    op: 'add',
    path: '/goals/-',
    value: {
      goalId: 'goal-home',
      type: 'buy_home',
      title: 'Buy a home',
      priority: 'high',
      status: 'active'
    }
  }]);
}

function completeHomeProfile() {
  let profile = emptyProfile('profile-question-plan-complete');
  const personId = profile.primaryPerson.personId;
  profile = apply(profile, [
    {
      op: 'add',
      path: '/goals/-',
      value: {
        goalId: 'goal-home',
        type: 'buy_home',
        title: 'Buy a home',
        priority: 'high',
        status: 'active',
        targetAmount: { amount: 350000, currency: 'EUR' }
      }
    },
    {
      op: 'add',
      path: '/incomeSources/-',
      value: {
        incomeId: 'income-primary',
        ownerId: personId,
        type: 'employment',
        label: 'Employment income',
        grossAnnual: { amount: 65000, currency: 'EUR' }
      }
    },
    {
      op: 'add',
      path: '/assets/-',
      value: {
        assetId: 'cash-primary',
        ownerIds: [personId],
        type: 'cash',
        label: 'Cash savings',
        currentValue: { amount: 50000, currency: 'EUR' },
        liquid: true
      }
    },
    { op: 'add', path: '/expenses/monthlyEssential', value: { amount: 2500, currency: 'EUR' } },
    { op: 'add', path: '/expenses/currentMonthlyRent', value: { amount: 0, currency: 'EUR' } },
    {
      op: 'add',
      path: '/assumptions/values/housePurchase',
      value: { lendingCategory: 'first_time_buyer', schemeBuyerStatus: 'first_time_buyer' }
    }
  ]);
  return profile;
}

await runCase('exports the canonical FactDefinition contract and stable aliases', () => {
  const confirmationPolicies = new Set(['final_review', 'read_back', 'visual_and_final']);
  const factIds = new Set();
  for (const definition of SEMANTIC_FACT_CATALOGUE) {
    assert.equal(typeof definition.factId, 'string');
    assert.ok(!factIds.has(definition.factId), `duplicate fact id ${definition.factId}`);
    factIds.add(definition.factId);
    assert.ok(FACT_VALUE_TYPES.includes(definition.valueType));
    assert.match(definition.profilePathTemplate, /^\//);
    assert.ok(Array.isArray(definition.moduleIds));
    assert.ok(FACT_SENSITIVITIES.includes(definition.sensitivity));
    assert.ok(confirmationPolicies.has(definition.confirmationPolicy));
    assert.ok(Object.isFrozen(definition));
  }
  assert.equal(getSemanticFactDefinition('gross_household_income').profilePathTemplate, '/incomeSources');
  assert.deepEqual(
    {
      factId: getSemanticFactDefinition('primary_goal').factId,
      valueType: getSemanticFactDefinition('primary_goal').valueType,
      profilePathTemplate: getSemanticFactDefinition('primary_goal').profilePathTemplate,
      sensitivity: getSemanticFactDefinition('primary_goal').sensitivity,
      confirmationPolicy: getSemanticFactDefinition('primary_goal').confirmationPolicy
    },
    {
      factId: 'primary_goal',
      valueType: 'entity',
      profilePathTemplate: '/goals',
      sensitivity: 'normal',
      confirmationPolicy: 'final_review'
    }
  );
  assert.equal(getSemanticFactDefinition('fact.goal.primary').factId, 'primary_goal');
  assert.equal(getSemanticFactDefinition('cash_savings').valueType, 'money');
  assert.equal(getSemanticFactDefinition('monthly_spending').profilePathTemplate, '/expenses/monthlyEssential');
  assert.equal(getSemanticFactDefinition('target_home_price').factId, 'target_home_price');
  assert.equal(getSemanticFactDefinition('intended_retirement_age').valueType, 'number');
  assert.equal(getSemanticFactDefinition('household.cash_available').factId, 'cash_savings');
  assert.equal(getSemanticFactDefinition('cash_savings').confirmationPolicy, FACT_CONFIRMATION_POLICIES.READ_BACK);
  assert.equal(getSemanticFactDefinition('lending_category').confirmationPolicy, FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL);
});

await runCase('maps shared current-engine paths without conflating retirement spending', () => {
  const cash = resolveSemanticFact('/assets', { moduleId: 'house_purchase' });
  const liquiditySpending = resolveSemanticFact('/expenses/annualTotal', { moduleId: 'liquidity_analysis' });
  const houseSpending = resolveSemanticFact('/expenses/monthlyEssential', { moduleId: 'house_purchase' });
  const retirementSpending = resolveSemanticFact('/expenses/annualTotal', { moduleId: 'net_retirement_cashflow' });
  assert.equal(cash.factId, 'cash_savings');
  assert.equal(liquiditySpending.factId, 'monthly_spending');
  assert.equal(houseSpending.factId, 'monthly_spending');
  assert.equal(liquiditySpending.preferredProfilePath, '/expenses/monthlyEssential');
  assert.equal(retirementSpending.factId, 'annual_net_spending');
});

await runCase('deduplicates shared facts while retaining one writable target and all blockers', () => {
  const readiness = [
    source('house_purchase', true, [
      missing('/assets', 'house_purchase'),
      missing('/expenses/monthlyEssential', 'house_purchase')
    ]),
    source('liquidity_analysis', false, [
      missing('/assets', 'liquidity_analysis'),
      missing('/expenses/annualTotal', 'liquidity_analysis')
    ])
  ];
  const before = JSON.stringify(readiness);
  const questions = buildQuestionPlan(readiness);
  assert.equal(JSON.stringify(readiness), before, 'buildQuestionPlan mutated its readiness input');
  assert.equal(questions.length, 2);
  const cash = questions.find((question) => question.factId === 'cash_savings');
  const spending = questions.find((question) => question.factId === 'monthly_spending');
  assert.deepEqual(cash.blockingModuleIds, ['house_purchase', 'liquidity_analysis']);
  assert.deepEqual(spending.blockingModuleIds, ['house_purchase', 'liquidity_analysis']);
  assert.deepEqual(spending.fieldPaths, ['/expenses/monthlyEssential']);
  assert.deepEqual(spending.relatedFieldPaths, ['/expenses/annualTotal', '/expenses/monthlyEssential']);
  assert.equal(spending.priority.sharedModuleCount, 2);
  assert.equal(spending.priority.requiredModuleBlocker, true);
});

await runCase('uses stable entity ids instead of mutable array indexes', () => {
  const atIndexZero = { goals: [{ goalId: 'goal-home' }] };
  const atIndexOne = { goals: [{ goalId: 'goal-other' }, { goalId: 'goal-home' }] };
  const first = buildQuestionPlan([
    source('house_purchase', true, [missing('/goals/0/targetAmount', 'house_purchase')])
  ], { profile: atIndexZero })[0];
  const second = buildQuestionPlan([
    source('house_purchase', true, [missing('/goals/1/targetAmount', 'house_purchase')])
  ], { profile: atIndexOne })[0];
  assert.equal(first.factInstanceId, 'target_home_price:goal-home');
  assert.equal(first.factInstanceId, second.factInstanceId);
  assert.equal(first.questionId, second.questionId);
  assert.equal(first.identityStability, 'profile_entity_id');
});

await runCase('keeps specialist reconciliation questions distinct by category and record id', () => {
  const fieldPaths = [
    '/assumptions/values/completionFacts/specialistAssetReconciliation/property/shared-record',
    '/assumptions/values/completionFacts/specialistAssetReconciliation/pension/shared-record',
    '/assumptions/values/completionFacts/specialistAssetReconciliation/pension/second-record'
  ];
  const resolutions = fieldPaths.map((fieldPath) => resolveSemanticFact(fieldPath, {
    moduleId: 'personal_balance_sheet'
  }));
  assert.deepEqual(
    resolutions.map((resolution) => resolution.entityId),
    ['property:shared-record', 'pension:shared-record', 'pension:second-record']
  );
  assert.ok(resolutions.every((resolution) => resolution.identityStability === 'path_entity_id'));
  assert.equal(new Set(resolutions.map((resolution) => resolution.factInstanceId)).size, 3);

  const questions = buildQuestionPlan([
    source('personal_balance_sheet', true, fieldPaths.map((fieldPath) => (
      missing(fieldPath, 'personal_balance_sheet')
    )))
  ]);
  assert.equal(questions.length, 3, 'record-level reconciliation questions must not merge into one singleton');
  assert.deepEqual(
    questions.map((question) => question.factInstanceId).sort(),
    [
      'specialist_asset_reconciliation:pension:second-record',
      'specialist_asset_reconciliation:pension:shared-record',
      'specialist_asset_reconciliation:property:shared-record'
    ]
  );
  assert.equal(new Set(questions.map((question) => question.questionId)).size, 3);
});

await runCase('orders required-module, shared, material, ambiguous and lower-effort questions exactly', () => {
  const requiredModuleFirst = buildQuestionPlan([
    source('liquidity_analysis', false, [missing('/assets', 'liquidity_analysis')]),
    source('house_purchase', false, [missing('/assets', 'house_purchase')]),
    source('house_purchase', true, [missing('/expenses/currentMonthlyRent', 'house_purchase')])
  ]);
  assert.equal(requiredModuleFirst[0].factId, 'current_monthly_rent');

  const sharedFirst = buildQuestionPlan([
    source('house_purchase', true, [
      missing('/assumptions/values/housePurchase/lendingCategory', 'house_purchase'),
      missing('/assets', 'house_purchase')
    ]),
    source('liquidity_analysis', true, [missing('/assets', 'liquidity_analysis')])
  ]);
  assert.equal(sharedFirst[0].factId, 'cash_savings');

  const materialFirst = buildQuestionPlan([
    source('house_purchase', true, [
      missing('/expenses/currentMonthlyRent', 'house_purchase'),
      missing('/assumptions/values/housePurchase/lendingCategory', 'house_purchase')
    ])
  ]);
  assert.equal(materialFirst[0].factId, 'lending_category');

  const ambiguityFirst = buildQuestionPlan([
    source('house_purchase', true, [
      missing('/assets', 'house_purchase'),
      missing('/expenses/monthlyEssential', 'house_purchase')
    ])
  ]);
  assert.equal(ambiguityFirst[0].factId, 'monthly_spending');

  const effortProfile = {
    goals: [{ goalId: 'goal-home' }],
    pensions: [{ pensionId: 'pension-one' }]
  };
  const lowerEffortFirst = buildQuestionPlan([
    source('house_purchase', true, [missing('/goals/0/targetAmount', 'house_purchase')]),
    source('pension_projection', true, [missing('/pensions/0/currentValue', 'pension_projection')])
  ], { profile: effortProfile });
  assert.equal(lowerEffortFirst[0].factId, 'target_home_price');
});

await runCase('current House Purchase and Liquidity produce a stable deduplicated question plan', async () => {
  const profile = incompleteHomeProfile();
  const options = {
    profile,
    allowedModuleIds: ['house_purchase', 'liquidity_analysis'],
    calculatedAt: NOW
  };
  const first = await runConsumerAnalysis(options);
  const second = await runConsumerAnalysis(options);
  const questions = first.analysisPlan.requiredQuestions;
  assert.equal(first.analysisPlan.status, 'needs_review');
  assert.deepEqual(first.results, []);
  assert.equal(questions.length, 6);
  assert.equal(new Set(questions.map((question) => question.questionId)).size, questions.length);
  assert.ok(questions.every((question) => question.fieldPaths.length === 1));
  assert.deepEqual(
    questions.map((question) => question.questionId),
    second.analysisPlan.requiredQuestions.map((question) => question.questionId)
  );
  const cash = questions.find((question) => question.factId === 'cash_savings');
  const spending = questions.find((question) => question.factId === 'monthly_spending');
  assert.deepEqual(cash.blockingModuleIds, ['house_purchase', 'liquidity_analysis']);
  assert.deepEqual(spending.blockingModuleIds, ['house_purchase', 'liquidity_analysis']);
  assert.deepEqual(spending.fieldPaths, ['/expenses/monthlyEssential']);
  assert.deepEqual(new Set(questions.slice(0, 2).map((question) => question.factId)), new Set([
    'cash_savings', 'monthly_spending'
  ]));
});

await runCase('preserves deterministic highlight messages exactly in bounded speakable text', () => {
  const summary = summarizeAnalysisResults({
    results: [
      {
        moduleId: 'liquidity_analysis',
        warnings: [],
        semanticResult: {
          currency: 'EUR',
          currentCash: 12000,
          monthsCovered: 4,
          targetCash: 18000,
          shortfallCash: 6000,
          surplusCash: 0
        }
      },
      {
        moduleId: 'house_purchase',
        warnings: [],
        semanticResult: {
          currency: 'EUR',
          targetPropertyPrice: 350000,
          currentSupportablePrice: 310000,
          standardMortgageCapacity: 260000,
          currentCashGap: 40000,
          readyDateIso: '2028-06-30',
          monthlySavingNeeded: 1500
        }
      }
    ],
    analysisPlan: { requiredQuestions: [] }
  });
  assert.equal(summary.generatedBy, 'deterministic_rules');
  assert.equal(summary.speakableText, summary.highlights.map((highlight) => highlight.message).join(' '));
  assert.ok(summary.highlights.every((highlight) => summary.speakableText.includes(highlight.message)));
  assert.ok(summary.speakableText.length <= MAX_SPEAKABLE_TEXT_CHARACTERS);

  const collegeSummary = summarizeAnalysisResults({
    results: [{
      moduleId: 'college_funding',
      warnings: [],
      semanticResult: {
        currency: 'EUR',
        nominalCostRange: { low: 20_000, high: 60_000 },
        firstCollegeYear: 2042
      }
    }],
    analysisPlan: { requiredQuestions: [] }
  });
  assert.equal(collegeSummary.headline, 'Future college-cost range');
  assert.doesNotMatch(
    [collegeSummary.headline, collegeSummary.speakableText, ...collegeSummary.nextSteps].join(' '),
    /college funding|college_funding/i
  );

  const oversized = summarizeAnalysisResults({
    results: [{
      moduleId: 'pension_projection',
      warnings: [],
      semanticResult: { readinessSentence: 'x'.repeat(MAX_SPEAKABLE_TEXT_CHARACTERS + 1) }
    }]
  });
  assert.equal(oversized.speakableText, '');
});

await runCase('complete current House Purchase and Liquidity still run in dependency order', async () => {
  const result = await runConsumerAnalysis({
    profile: completeHomeProfile(),
    moduleIds: ['house_purchase'],
    allowedModuleIds: ['house_purchase', 'liquidity_analysis'],
    calculatedAt: NOW
  });
  assert.equal(result.analysisPlan.status, 'complete');
  assert.deepEqual(result.analysisPlan.requiredQuestions, []);
  assert.deepEqual(result.results.map((entry) => entry.moduleId), ['liquidity_analysis', 'house_purchase']);
  assert.deepEqual(result.errors, []);
});

const failed = cases.filter((entry) => !entry.passed);
if (failed.length > 0) {
  console.error(`[ConsumerQuestionPlan] ${failed.length}/${cases.length} checks failed.`);
  process.exitCode = 1;
} else {
  console.info(`[ConsumerQuestionPlan] ${cases.length}/${cases.length} checks passed.`);
}
