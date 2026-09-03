#!/usr/bin/env node

import assert from 'node:assert/strict';

import { createDefaultHousePurchaseInputs } from '../js/house_purchase/index.js';
import { LIQUIDITY_RESERVE_POLICY } from '../js/liquidity_reserve.js';
import { approvedCollegeScenarios, PLANEIR_ASSUMPTIONS } from '../js/planning/planeir_assumptions.js';
import { MODULE_MANIFEST } from '../js/planning/module_manifest.generated.js';
import {
  buildDirectModulePolicyEnvelope,
  directModulePolicyEntries
} from '../js/planning/direct_module_policy.js';
import { runPlanningModuleWithInput } from '../js/planning/module_registry.js';
import {
  APPROVED_CONSUMER_MODULE_IDS,
  getConsumerConfig,
  publicConsumerConfig
} from '../worker/src/consumer/config.js';
import { buildLiveSessionConfig } from '../worker/src/consumer/live/live_provider.js';
import {
  DIRECT_MODULE_CONTRACTS,
  DIRECT_MODULE_IDS,
  interpretDirectModuleConversation,
  MODULE_PLANNING_SNAPSHOT_V1,
  normalizeDirectSnapshot,
  verifyDirectModuleCertificate
} from '../worker/src/consumer/direct_module_planner.js';

const NOW = '2026-09-02T10:00:00.000Z';
const TODAY = '2026-09-02';
const CONFIRMATION_PROMPT = 'I will run the existing mortgage analysis using a €240,000 balance, 4.1% interest and 22 years remaining, with no overpayment. Would you like me to run exactly that plan now?';
const pass = (message) => console.info(`[DirectModulePlanning] PASS: ${message}`);
const PROFILE = Object.freeze({
  revision: 0,
  assumptions: { calculationDateIso: TODAY },
  preferences: { baseCurrency: 'EUR' }
});
const POLICY = buildDirectModulePolicyEnvelope({ calculationDateIso: TODAY, baseCurrency: 'EUR' });

assert.deepEqual([...DIRECT_MODULE_IDS].sort(), [...APPROVED_CONSUMER_MODULE_IDS].sort());
assert.equal(Object.keys(DIRECT_MODULE_CONTRACTS).length, 7);
pass('the direct contract registry is exactly the seven approved consumer modules');
assert.equal(getConsumerConfig({}).modulePlannerMode, 'off');
assert.equal(getConsumerConfig({ CONSUMER_MODULE_PLANNER_MODE: 'shadow' }).modulePlannerMode, 'shadow');
assert.equal(getConsumerConfig({ CONSUMER_MODULE_PLANNER_MODE: 'apply' }).modulePlannerMode, 'apply');
assert.equal(getConsumerConfig({ CONSUMER_MODULE_PLANNER_MODE: 'typo' }).modulePlannerMode, 'off');
pass('direct mode is off by default and invalid deployment values fail closed');
const directProviderConfig = buildLiveSessionConfig(getConsumerConfig({
  CONSUMER_MODULE_PLANNER_MODE: 'apply'
}));
assert.deepEqual(directProviderConfig.tools.map((tool) => tool.name), ['get_state', 'confirm_and_run']);
assert.doesNotMatch(directProviderConfig.instructions, /\bsave_facts\b/);
assert.doesNotMatch(directProviderConfig.instructions, /save primary_goal_focus/i);
assert.doesNotMatch(directProviderConfig.instructions, /^Needs:/m);
assert.match(directProviderConfig.instructions, /Before the client has spoken, open once/i);
assert.match(directProviderConfig.instructions, /background planner owns the structured goal and module interpretation/i);
assert.match(directProviderConfig.instructions, /call get_state before naming what you will examine/i);
const directPromptModules = MODULE_MANIFEST.filter((module) => (
  module?.availability?.consumer === true
  && module?.implementation?.hasRunnableEngine === true
));
assert.equal(directPromptModules.length, 7);
for (const module of directPromptModules) {
  assert.match(directProviderConfig.instructions, new RegExp(`### ${module.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  for (const goal of module.routing?.goals || []) {
    assert.match(directProviderConfig.instructions, new RegExp(`\\b${goal.type}\\b`));
  }
}
assert.deepEqual(
  directProviderConfig.tools.find((tool) => tool.name === 'confirm_and_run')?.parameters?.required,
  ['confirmationToken']
);
assert.match(
  publicConsumerConfig({
    ...getConsumerConfig({ CONSUMER_MODULE_PLANNER_MODE: 'apply' }),
    liveVoiceEnabled: true
  }).realtimeVoice.aiGeneratedDisclosure,
  /background AI reads the conversation and prepares the structured inputs/i
);
pass('direct Realtime opens warmly, routes all seven modules by goal, and follows AI-authored state without legacy fact-writing instructions');

const house = createDefaultHousePurchaseInputs(TODAY);
Object.assign(house, {
  lendingCategory: 'first_time_buyer',
  applicants: [{
    ...house.applicants[0],
    id: 'primary',
    label: 'Aoife',
    age: 34,
    employmentStatus: 'employee',
    grossAnnualIncome: 68000,
    incomeReliability: 'stable',
    schemeBuyerStatus: 'first_time_buyer'
  }],
  cashSavingsContributions: [{ ownerId: 'primary', amount: 70000 }],
  currentCashSavings: 70000,
  monthlyNetHouseholdIncome: 4200,
  monthlyEssentialExpensesExcludingHousingDebtAndRent: 2200,
  currentMonthlyRent: 1700,
  currentMonthlySavings: 1000,
  plannedMonthlySavings: 1000,
  targetPropertyPrice: 400000,
  targetPurchaseDate: '2028-06-30',
  localAuthorityCode: 'unknown'
});

const inputs = {
  personal_balance_sheet: {
    currency: 'EUR',
    assetPositions: [
      { id: 'home', label: 'Home', bucket: 'lifestyle_assets', amount: 450000, source: 'properties' },
      { id: 'cash', label: 'Savings', bucket: 'spendable_reserves', amount: 50000, source: 'assets' },
      { id: 'pension', label: 'Pension', bucket: 'retirement_funding', amount: 180000, source: 'pensions' }
    ],
    liabilityPositions: [{ id: 'mortgage', label: 'Mortgage', amount: 240000, source: 'liabilities' }],
    monthlyExpenditure: 2500,
    reconciliationWarnings: [],
    currencyWarnings: []
  },
  pension_projection: {
    currentYear: 2026,
    inflationRate: 0.02,
    growthRate: 0.05,
    wageGrowthRate: 0.02,
    incomeMode: 'target',
    targetIncomeToday: 70000,
    targetStartYear: 2052,
    horizonEndAge: 95,
    pensions: [
      { id: 'primary', title: 'John', currentAge: 42, retirementAge: 67, currentSalary: 85000, currentPot: 180000, personalPct: 0.08, employerPct: 0.06, includeStatePension: true, statePensionFraction: 1, statePensionStartAge: 66, statePensionEscalationRate: 0.02 },
      { id: 'partner', title: 'Mary', currentAge: 40, retirementAge: 66, currentSalary: 70000, currentPot: 120000, personalPct: 0.07, employerPct: 0.05, includeStatePension: true, statePensionFraction: 1, statePensionStartAge: 66, statePensionEscalationRate: 0.02 }
    ],
    otherIncomeSources: []
  },
  liquidity_analysis: {
    currentCash: 90000,
    monthlyExpenditure: 5000,
    annualExpenditure: 60000,
    clientStatus: 'not-retired',
    policyVersion: LIQUIDITY_RESERVE_POLICY.policyVersion,
    minimumBufferMonths: 3,
    targetBufferMonths: 6
  },
  mortgage_analysis: {
    loanKind: 'mortgage', currentBalance: 240000, annualInterestRate: 0.041,
    startDateIso: TODAY, endDateIso: null, remainingTermYears: 22, repaymentType: 'repayment',
    fixedPaymentAmount: null, oneOffOverpayment: 0, annualOverpayment: 0
  },
  loan_analysis: {
    loanKind: 'loan', currentBalance: 18000, annualInterestRate: 0.085,
    startDateIso: TODAY, endDateIso: null, remainingTermYears: 4, repaymentType: 'repayment',
    fixedPaymentAmount: null, oneOffOverpayment: 0, annualOverpayment: 500
  },
  college_funding: {
    currentYear: 2026,
    inflationRate: PLANEIR_ASSUMPTIONS.inflation.educationRate,
    children: [{ id: 'child-1', title: 'Child', currentAge: 8, collegeStartAge: 18, collegeDurationYears: 4 }],
    scenarios: approvedCollegeScenarios()
  },
  house_purchase: house
};

for (const [moduleId, input] of Object.entries(inputs)) {
  const result = await runPlanningModuleWithInput(moduleId, input, {
    calculationDateIso: TODAY,
    calculationVersion: 'direct-module-test-v1',
    calculatedAt: NOW,
    baseCurrency: 'EUR'
  });
  assert.equal(result.moduleId, moduleId);
  assert.ok(result.inputSnapshotHash);
}
pass('all seven native validators and deterministic engines accept direct inputs');
const { targetIncomeToday: _targetIncomeToday, ...pensionWithoutTarget } = inputs.pension_projection;
const affordablePension = {
  ...pensionWithoutTarget,
  incomeMode: 'affordable',
  horizonEndAge: 100,
  affordableEndAges: [85, 90, 95, 100]
};
await runPlanningModuleWithInput('pension_projection', affordablePension, {
  calculationDateIso: TODAY,
  calculationVersion: 'direct-module-test-v1',
  calculatedAt: NOW,
  baseCurrency: 'EUR'
});
const customCollegeTiming = {
  ...inputs.college_funding,
  children: [{ ...inputs.college_funding.children[0], collegeStartAge: 19, collegeDurationYears: 3 }]
};
await runPlanningModuleWithInput('college_funding', customCollegeTiming, {
  calculationDateIso: TODAY,
  calculationVersion: 'direct-module-test-v1',
  calculatedAt: NOW,
  baseCurrency: 'EUR'
});
assert.equal(directModulePolicyEntries('pension_projection', affordablePension, POLICY)
  .find((entry) => entry.path === '/incomeMode')?.mode, 'default');
assert.equal(directModulePolicyEntries('college_funding', customCollegeTiming, POLICY)
  .find((entry) => entry.path === '/children/0/collegeStartAge')?.mode, 'default');
pass('pension mode and child-specific college timing remain AI-authored semantics, with defaults only when unstated');
await assert.rejects(
  runPlanningModuleWithInput('mortgage_analysis', { ...inputs.mortgage_analysis, loanKind: 'loan' }),
  /loanKind must be "mortgage"/
);
await assert.rejects(
  runPlanningModuleWithInput('loan_analysis', { ...inputs.loan_analysis, loanKind: 'mortgage' }),
  /loanKind must be "loan"/
);
await assert.rejects(
  runPlanningModuleWithInput('personal_balance_sheet', {}),
  /explicitly include assetPositions and liabilityPositions/
);
await assert.rejects(
  runPlanningModuleWithInput('personal_balance_sheet', {
    ...inputs.personal_balance_sheet,
    assetPositions: [{ bucket: 'spendable_reserves', amount: 1000 }]
  }),
  /must explicitly include id, label, bucket, amount and source/
);
await assert.rejects(
  runPlanningModuleWithInput('personal_balance_sheet', {
    ...inputs.personal_balance_sheet,
    assetPositions: [{ ...inputs.personal_balance_sheet.assetPositions[0], id: null }]
  }),
  /invalid structural field/
);
const { monthlyExpenditure: _monthlyExpenditure, ...pbsWithoutSpending } = inputs.personal_balance_sheet;
await assert.rejects(
  runPlanningModuleWithInput('personal_balance_sheet', pbsWithoutSpending),
  /monthlyExpenditure must be an explicit/
);
await assert.rejects(
  runPlanningModuleWithInput('college_funding', {
    ...inputs.college_funding,
    children: [{ ...inputs.college_funding.children[0], id: 1 }]
  }),
  /name each child exactly once/
);
await assert.rejects(
  runPlanningModuleWithInput('mortgage_analysis', {
    ...inputs.mortgage_analysis,
    endDateIso: '2048-09-01'
  }),
  /exactly one of endDateIso or remainingTermYears/
);
await assert.rejects(
  runPlanningModuleWithInput('liquidity_analysis', {
    ...inputs.liquidity_analysis,
    annualExpenditure: 12
  }),
  /must describe the same spending/
);
await assert.rejects(
  runPlanningModuleWithInput('pension_projection', {
    ...inputs.pension_projection,
    pensions: [{
      ...inputs.pension_projection.pensions[0],
      includeStatePension: null,
      statePensionFraction: null
    }]
  }),
  /includeStatePension must be a boolean/
);
await assert.rejects(
  runPlanningModuleWithInput('house_purchase', {
    ...inputs.house_purchase,
    currentMonthlySavings: null
  }),
  /currentMonthlySavings must be a finite number/
);
await assert.rejects(
  runPlanningModuleWithInput('house_purchase', {
    ...inputs.house_purchase,
    lenderCapacity: { ...inputs.house_purchase.lenderCapacity, status: 'not_started' }
  }),
  /must use a canonical module enum value/
);
pass('structural discriminators, cross-field conflicts, and semantic null/default boundaries fail closed');

const policyTamperCases = [
  ['pension_projection', { ...inputs.pension_projection, growthRate: 0.04 }],
  ['liquidity_analysis', { ...inputs.liquidity_analysis, targetBufferMonths: 12 }],
  ['college_funding', { ...inputs.college_funding, inflationRate: 0.02 }],
  ['house_purchase', { ...inputs.house_purchase, mortgageIllustrationRate: 0.09 }]
];
for (const [moduleId, tamperedInput] of policyTamperCases) {
  const rows = DIRECT_MODULE_IDS.map((id) => ({
    moduleId: id,
    outputKey: DIRECT_MODULE_CONTRACTS[id].outputKey,
    status: id === moduleId ? 'ready' : 'not_relevant',
    inputJson: id === moduleId ? JSON.stringify(tamperedInput) : '',
    steeringSummary: '', missing: [], ambiguities: [], assumptions: [], evidence: []
  }));
  assert.throws(() => normalizeDirectSnapshot({
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: 0,
    throughTurnId: 'turn-policy',
    modules: rows,
    generalAmbiguities: [],
    confirmationPrompt: CONFIRMATION_PROMPT
  }, {
    turns: [{ id: 'turn-policy', role: 'user', transcript: 'Use the standard Planéir policy.' }],
    throughTurnId: 'turn-policy', previousRevision: 0,
    policyEnvelope: POLICY,
    currentProfileContext: PROFILE,
    allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
  }), /server-owned value/);
}
pass('AI-authored inputs cannot override pension, liquidity, college, or house-purchase engine policy');

const transcript = 'About two and a half thousand a month, and the mortgage is two hundred and forty grand.';
const moduleRows = DIRECT_MODULE_IDS.map((moduleId) => ({
  moduleId,
  outputKey: DIRECT_MODULE_CONTRACTS[moduleId].outputKey,
  status: moduleId === 'mortgage_analysis' ? 'ready' : 'not_relevant',
  inputJson: moduleId === 'mortgage_analysis' ? JSON.stringify(inputs[moduleId]) : '',
  steeringSummary: moduleId === 'mortgage_analysis'
    ? 'Existing repayment mortgage: €240,000 balance, 4.1% rate and 22 years remaining.'
    : '',
  missing: [], ambiguities: [], assumptions: moduleId === 'mortgage_analysis' ? [
    { path: '/endDateIso', valueJson: 'null', source: 'contract_default' },
    { path: '/fixedPaymentAmount', valueJson: 'null', source: 'contract_default' },
    { path: '/oneOffOverpayment', valueJson: '0', source: 'contract_default' },
    { path: '/annualOverpayment', valueJson: '0', source: 'contract_default' }
  ] : [],
  evidence: moduleId === 'mortgage_analysis'
    ? [
        { path: '/currentBalance', source: 'conversation', turnId: 'turn-1', quote: 'two hundred and forty grand', profilePath: '' },
        { path: '/annualInterestRate', source: 'profile', turnId: '', quote: '', profilePath: '/knownMortgageRate' },
        { path: '/remainingTermYears', source: 'profile', turnId: '', quote: '', profilePath: '/knownMortgageTermYears' }
      ]
    : []
}));
const EVIDENCE_PROFILE = {
  ...PROFILE,
  knownMortgageRate: 0.041,
  knownMortgageTermYears: 22
};
const snapshot = normalizeDirectSnapshot({
  schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
  baseSnapshotRevision: 0,
  throughTurnId: 'turn-1',
  modules: moduleRows,
  generalAmbiguities: [],
  confirmationPrompt: CONFIRMATION_PROMPT
}, {
  turns: [{ id: 'turn-1', role: 'user', transcript }],
  throughTurnId: 'turn-1',
  previousRevision: 0,
  policyEnvelope: POLICY,
  currentProfileContext: EVIDENCE_PROFILE,
  allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
});
assert.equal(snapshot.modules.find((item) => item.moduleId === 'mortgage_analysis').input.currentBalance, 240000);
assert.equal(snapshot.snapshotRevision, 1);
pass('spoken-word evidence supports the AI-authored native number without deterministic parsing');

/* ------- tolerated bookkeeping never becomes a tolerated financial value --- */

// Three kinds of planner bookkeeping are now dropped rather than fatal: an
// evidence note pointing at a path the input does not have, a malformed
// assumption, and an omitted module row. Each was destroying an otherwise
// correct snapshot -- and with it every other module and the state Realtime
// steers on -- over a line that carries no client meaning. Dropping is only
// safe if it stays the STRICT direction, so this pins that: what the dropped
// line would have supported must still be refused.
{
  const withStrayEvidence = moduleRows.map((item) => (
    item.moduleId === 'mortgage_analysis'
      ? {
          ...item,
          evidence: [
            ...item.evidence,
            // The client said something real that this engine has no field for.
            { path: '/monthlyRepayment', source: 'conversation', turnId: 'turn-1', quote: 'About two and a half thousand a month', profilePath: '' }
          ]
        }
      : item
  ));
  const tolerated = normalizeDirectSnapshot({
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: 0,
    throughTurnId: 'turn-1',
    modules: withStrayEvidence,
    generalAmbiguities: [],
    confirmationPrompt: CONFIRMATION_PROMPT
  }, {
    turns: [{ id: 'turn-1', role: 'user', transcript }],
    throughTurnId: 'turn-1', previousRevision: 0,
    policyEnvelope: POLICY, currentProfileContext: EVIDENCE_PROFILE,
    allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
  });
  const kept = tolerated.modules.find((item) => item.moduleId === 'mortgage_analysis');
  assert.equal(kept.status, 'ready');
  assert.equal(
    kept.evidence.some((item) => item.path === '/monthlyRepayment'), false,
    'a note that supports no input value must be dropped, not recorded as provenance'
  );

  // The same tolerance must NOT rescue a value. Drop the balance's real
  // evidence and cite an unreachable path instead: the figure is now unsupported
  // and the ready module has to fail.
  const strayInsteadOfReal = moduleRows.map((item) => (
    item.moduleId === 'mortgage_analysis'
      ? {
          ...item,
          evidence: [
            { path: '/monthlyRepayment', source: 'conversation', turnId: 'turn-1', quote: 'two hundred and forty grand', profilePath: '' },
            ...item.evidence.filter((entry) => entry.path !== '/currentBalance')
          ]
        }
      : item
  ));
  assert.throws(() => normalizeDirectSnapshot({
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: 0,
    throughTurnId: 'turn-1',
    modules: strayInsteadOfReal,
    generalAmbiguities: [],
    confirmationPrompt: CONFIRMATION_PROMPT
  }, {
    turns: [{ id: 'turn-1', role: 'user', transcript }],
    throughTurnId: 'turn-1', previousRevision: 0,
    policyEnvelope: POLICY, currentProfileContext: EVIDENCE_PROFILE,
    allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
  }), /neither evidenced nor supplied by server policy/);

  // A malformed assumption is dropped -- and the default it would have
  // disclosed is then undisclosed, which still fails closed.
  const malformedAssumption = moduleRows.map((item) => (
    item.moduleId === 'mortgage_analysis'
      ? {
          ...item,
          assumptions: item.assumptions.map((assumption) => (
            assumption.path === '/annualOverpayment'
              ? { ...assumption, valueJson: '{not json' }
              : assumption
          ))
        }
      : item
  ));
  assert.throws(() => normalizeDirectSnapshot({
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: 0,
    throughTurnId: 'turn-1',
    modules: malformedAssumption,
    generalAmbiguities: [],
    confirmationPrompt: CONFIRMATION_PROMPT
  }, {
    turns: [{ id: 'turn-1', role: 'user', transcript }],
    throughTurnId: 'turn-1', previousRevision: 0,
    policyEnvelope: POLICY, currentProfileContext: EVIDENCE_PROFILE,
    allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
  }), /neither evidenced nor supplied by server policy/);

  // An omitted row is completed as not_relevant: absence is non-selection, and
  // a completed row can never carry an input, so nothing can execute from one.
  const omitted = moduleRows.filter((item) => item.moduleId !== 'college_funding');
  const completed = normalizeDirectSnapshot({
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: 0,
    throughTurnId: 'turn-1',
    modules: omitted,
    generalAmbiguities: [],
    confirmationPrompt: CONFIRMATION_PROMPT
  }, {
    turns: [{ id: 'turn-1', role: 'user', transcript }],
    throughTurnId: 'turn-1', previousRevision: 0,
    policyEnvelope: POLICY, currentProfileContext: EVIDENCE_PROFILE,
    allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
  });
  const filled = completed.modules.find((item) => item.moduleId === 'college_funding');
  assert.equal(filled.status, 'not_relevant');
  assert.equal(filled.input, null);
  assert.deepEqual(filled.evidence, []);
  assert.equal(completed.modules.length, APPROVED_CONSUMER_MODULE_IDS.length);
}
pass('dropped planner bookkeeping never rescues an unsupported value or an undisclosed default');

const mortgageWithoutAnnualOverpayment = {
  ...inputs.mortgage_analysis
};
delete mortgageWithoutAnnualOverpayment.annualOverpayment;
const undisclosedDefaultRows = moduleRows.map((item) => (
  item.moduleId === 'mortgage_analysis'
    ? {
        ...item,
        inputJson: JSON.stringify(mortgageWithoutAnnualOverpayment),
        assumptions: item.assumptions.filter((assumption) => assumption.path !== '/annualOverpayment')
      }
    : item
));
assert.throws(() => normalizeDirectSnapshot({
  schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
  baseSnapshotRevision: 0,
  throughTurnId: 'turn-1',
  modules: undisclosedDefaultRows,
  generalAmbiguities: [],
  confirmationPrompt: CONFIRMATION_PROMPT
}, {
  turns: [{ id: 'turn-1', role: 'user', transcript }],
  throughTurnId: 'turn-1',
  previousRevision: 0,
  policyEnvelope: POLICY,
  currentProfileContext: EVIDENCE_PROFILE,
  allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
}), /undisclosed server default/);
pass('native normalisation cannot silently introduce an undisclosed financial default');

const carriedSnapshot = normalizeDirectSnapshot({
  schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
  baseSnapshotRevision: 1,
  throughTurnId: 'turn-2',
  modules: moduleRows,
  generalAmbiguities: [],
  confirmationPrompt: CONFIRMATION_PROMPT
}, {
  turns: [
    { id: 'turn-1', role: 'user', transcript },
    { id: 'turn-2', role: 'user', transcript: 'Yes, that is still correct.' }
  ],
  throughTurnId: 'turn-2',
  previousRevision: 1,
  policyEnvelope: POLICY,
  currentProfileContext: EVIDENCE_PROFILE,
  allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
});
assert.equal(carriedSnapshot.modules.find((item) => item.moduleId === 'mortgage_analysis').input.currentBalance, 240000);
assert.throws(() => normalizeDirectSnapshot({
  schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
  baseSnapshotRevision: 1,
  throughTurnId: 'turn-2',
    modules: moduleRows,
    generalAmbiguities: [],
    confirmationPrompt: CONFIRMATION_PROMPT
}, {
  turns: [{ id: 'turn-2', role: 'user', transcript: 'Yes, that is still correct.' }],
  throughTurnId: 'turn-2',
  previousRevision: 1,
  policyEnvelope: POLICY,
  currentProfileContext: EVIDENCE_PROFILE,
  allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
}), /exact transcript span/);
pass('ready snapshots require their original transcript or revision-bound profile provenance');

assert.throws(() => normalizeDirectSnapshot({
  schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
  baseSnapshotRevision: 0,
  throughTurnId: 'turn-1',
  modules: [{ ...moduleRows.find((item) => item.moduleId === 'mortgage_analysis'), inputJson: JSON.stringify({ ...inputs.mortgage_analysis, currentBalance: -1 }) }],
  generalAmbiguities: [],
  confirmationPrompt: CONFIRMATION_PROMPT
}, {
  turns: [{ id: 'turn-1', role: 'user', transcript }],
  throughTurnId: 'turn-1', previousRevision: 0,
  policyEnvelope: POLICY,
  currentProfileContext: EVIDENCE_PROFILE,
  allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
}), /native input contract/);
pass('ready inputs still fail closed at the native structural validator');

const originalFetch = globalThis.fetch;
const certificateEnv = {
  OPENAI_API_KEY: 'test-key',
  CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url')
};
const certificateConfig = {
  allowedModules: APPROVED_CONSUMER_MODULE_IDS,
  modulePlannerModel: 'gpt-5.6-luna',
  modulePlannerReasoningEffort: 'low',
  modulePlannerTimeoutMs: 5000,
  modulePlannerPromptVersion: 'direct-module-planner-v2',
  moduleVerifierPromptVersion: 'direct-module-verifier-v2'
};
let providerCalls = 0;
let verifierCalls = 0;
let verifierValue = {
  schemaVersion: 'ModuleInputVerificationV1',
  verdict: 'pass',
  unsupportedPaths: [],
  omittedSupportedInformation: [],
  unresolvedAmbiguities: [],
  clarifications: [],
  confirmationPromptApproved: true,
  explanation: 'The exact mortgage input and confirmation prompt are supported by the cited turn.'
};
let extractionValue = {
  schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
  baseSnapshotRevision: 0,
  throughTurnId: 'turn-1',
  modules: moduleRows,
  generalAmbiguities: [],
  confirmationPrompt: CONFIRMATION_PROMPT
};
globalThis.fetch = async (_url, request) => {
  providerCalls += 1;
  const body = JSON.parse(request.body);
  assert.equal(body.text.format.type, 'json_schema');
  const value = body.text.format.name === 'module_planning_snapshot_v1'
    ? extractionValue
    : (() => {
        verifierCalls += 1;
        return verifierValue;
      })();
  return {
    ok: true,
    json: async () => ({ status: 'completed', output_text: JSON.stringify(value), usage: { input_tokens: 10, output_tokens: 5 } })
  };
};
try {
  const interpreted = await interpretDirectModuleConversation({
    env: certificateEnv,
    config: certificateConfig,
    turns: [{ id: 'turn-1', role: 'user', transcript }],
    throughTurnId: 'turn-1',
    currentProfileContext: EVIDENCE_PROFILE
  });
  assert.equal(providerCalls, 2, 'extraction and verification are independent calls');
  assert.equal(verifierCalls, 1);
  assert.equal(interpreted.brief.readyToConfirm, true);
  assert.equal(await verifyDirectModuleCertificate(
    certificateEnv,
    interpreted.certificate,
    interpreted.snapshot,
    null,
    {
      config: certificateConfig,
      calculationDateIso: TODAY,
      baseCurrency: 'EUR',
      currentProfileContext: EVIDENCE_PROFILE
    }
  ), true);
  const changed = structuredClone(interpreted.snapshot);
  changed.modules.find((item) => item.moduleId === 'mortgage_analysis').input.currentBalance = 2;
  assert.equal(await verifyDirectModuleCertificate(
    certificateEnv,
    interpreted.certificate,
    changed,
    null,
    {
      config: certificateConfig,
      calculationDateIso: TODAY,
      baseCurrency: 'EUR',
      currentProfileContext: EVIDENCE_PROFILE
    }
  ), false);
  const certifiedInputs = Object.fromEntries(
    interpreted.snapshot.modules
      .filter((item) => item.status === 'ready')
      .map((item) => [item.moduleId, item.input])
  );
  const certificateOptions = {
    config: certificateConfig,
    calculationDateIso: TODAY,
    baseCurrency: 'EUR',
    currentProfileContext: EVIDENCE_PROFILE
  };
  assert.equal(await verifyDirectModuleCertificate(
    certificateEnv,
    interpreted.certificate,
    interpreted.snapshot,
    certifiedInputs,
    certificateOptions
  ), true);
  assert.equal(await verifyDirectModuleCertificate(
    certificateEnv,
    interpreted.certificate,
    interpreted.snapshot,
    {},
    certificateOptions
  ), false);
  assert.equal(await verifyDirectModuleCertificate(
    certificateEnv,
    interpreted.certificate,
    interpreted.snapshot,
    certifiedInputs,
    { ...certificateOptions, config: { ...certificateConfig, moduleVerifierPromptVersion: 'changed' } }
  ), false);
  assert.equal(await verifyDirectModuleCertificate(
    certificateEnv,
    interpreted.certificate,
    interpreted.snapshot,
    certifiedInputs,
    { ...certificateOptions, currentProfileContext: { ...EVIDENCE_PROFILE, knownMortgageRate: 0.05 } }
  ), false);
  assert.equal(await verifyDirectModuleCertificate(
    certificateEnv,
    interpreted.certificate,
    interpreted.snapshot,
    certifiedInputs,
    { ...certificateOptions, calculationDateIso: '2026-09-03' }
  ), false);
  const changedReadBack = structuredClone(interpreted.snapshot);
  changedReadBack.confirmationPrompt = 'Shall I run something now?';
  assert.equal(await verifyDirectModuleCertificate(
    certificateEnv,
    interpreted.certificate,
    changedReadBack,
    certifiedInputs,
    certificateOptions
  ), false);
  pass('certificate binds exact canonical inputs, prompt/model policy, and every cited profile value');

  verifierValue = {
    schemaVersion: 'ModuleInputVerificationV1',
    verdict: 'needs_clarification',
    unsupportedPaths: [],
    omittedSupportedInformation: ['The mortgage owner has not been established.'],
    unresolvedAmbiguities: ['The client may mean their own or a joint mortgage.'],
    clarifications: [{
      id: 'mortgage-owner',
      question: 'Is that mortgage yours alone or jointly held?',
      relatedModuleIds: ['mortgage_analysis'],
      relatedPaths: ['/currentBalance']
    }],
    confirmationPromptApproved: false,
    explanation: 'Ownership must be clarified before confirmation.'
  };
  const blockedByVerifier = await interpretDirectModuleConversation({
    env: certificateEnv,
    config: certificateConfig,
    turns: [{ id: 'turn-1', role: 'user', transcript }],
    throughTurnId: 'turn-1',
    currentProfileContext: EVIDENCE_PROFILE
  });
  assert.equal(blockedByVerifier.certificate, null);
  assert.equal(blockedByVerifier.brief.readyToConfirm, false);
  assert.equal(blockedByVerifier.brief.ambiguities.at(-1)?.question,
    'Is that mortgage yours alone or jointly held?');
  pass('a verifier objection blocks execution and supplies an AI-authored next question');
  verifierValue = {
    schemaVersion: 'ModuleInputVerificationV1',
    verdict: 'pass',
    unsupportedPaths: [],
    omittedSupportedInformation: [],
    unresolvedAmbiguities: [],
    clarifications: [],
    confirmationPromptApproved: true,
    explanation: 'The exact mortgage input and confirmation prompt are supported by the cited turn.'
  };

  extractionValue = {
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: 0,
    throughTurnId: 'turn-2',
    modules: moduleRows.map((item) => item.moduleId === 'mortgage_analysis' ? {
      ...item,
      status: 'collecting',
      inputJson: JSON.stringify({ loanKind: 'mortgage', currentBalance: 240000 }),
      steeringSummary: 'Existing mortgage balance: €240,000.',
      missing: [{ path: '/annualInterestRate', reason: 'Required by the module', question: 'Roughly what interest rate are you paying?' }],
      assumptions: [],
      evidence: []
    } : item),
    generalAmbiguities: [],
    confirmationPrompt: ''
  };
  const callsBeforeCollecting = providerCalls;
  const collecting = await interpretDirectModuleConversation({
    env: {
      OPENAI_API_KEY: 'test-key',
      CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url')
    },
    config: {
      allowedModules: APPROVED_CONSUMER_MODULE_IDS,
      modulePlannerModel: 'gpt-5.6-luna',
      modulePlannerReasoningEffort: 'low',
      modulePlannerTimeoutMs: 5000,
      modulePlannerPromptVersion: 'direct-module-planner-v2',
      moduleVerifierPromptVersion: 'direct-module-verifier-v2'
    },
    turns: [{ id: 'turn-2', role: 'user', transcript: 'The balance is all I know right now.' }],
    throughTurnId: 'turn-2',
    currentProfileContext: { ...EVIDENCE_PROFILE, revision: 1 }
  });
  assert.equal(providerCalls - callsBeforeCollecting, 1);
  assert.equal(collecting.verification, null);
  assert.equal(collecting.brief.readyToConfirm, false);
  pass('incomplete intake uses one background interpretation; verification waits for the ready boundary');
} finally {
  globalThis.fetch = originalFetch;
}

console.info('[DirectModulePlanning] All direct module-planning checks passed.');
