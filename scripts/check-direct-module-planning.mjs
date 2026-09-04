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
import {
  normalizePlanningModuleInput,
  runPlanningModuleWithInput
} from '../js/planning/module_registry.js';
import { PLANNING_PLAYBOOK_GUIDANCE } from '../js/planning/playbook_manifest.generated.js';
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
  plannerFacingSnapshot,
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

const PBS_NONE_TRANSCRIPT = 'The house is worth 450,000, we have 50,000 saved and a pension of 180,000, and we have no debts at all. We spend about 2,500 a month.';
const PBS_EVIDENCE_PROFILE = { profileId: 'p', revision: 1, primaryPerson: { personId: 'primary', displayName: 'Client' }, partner: null, preferences: { baseCurrency: 'EUR' }, assumptions: { calculationDateIso: TODAY } };
const PBS_ASSET_EVIDENCE = [
  { path: '/currency', source: 'conversation', turnId: 'turn-none', quote: '450,000', profilePath: '' },
  { path: '/assetPositions/0', source: 'conversation', turnId: 'turn-none', quote: 'The house is worth 450,000', profilePath: '' },
  { path: '/assetPositions/1', source: 'conversation', turnId: 'turn-none', quote: 'we have 50,000 saved', profilePath: '' },
  { path: '/assetPositions/2', source: 'conversation', turnId: 'turn-none', quote: 'a pension of 180,000', profilePath: '' },
  { path: '/monthlyExpenditure', source: 'conversation', turnId: 'turn-none', quote: 'We spend about 2,500 a month', profilePath: '' },
  { path: '/reconciliationWarnings', source: 'conversation', turnId: 'turn-none', quote: 'we have no debts at all', profilePath: '' },
  { path: '/currencyWarnings', source: 'conversation', turnId: 'turn-none', quote: 'we have no debts at all', profilePath: '' }
];

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
  // evidence and cite an unreachable path instead: the figure is now
  // unsupported, so the module leaves this pass NOT ready -- and the path it
  // could not support becomes something to ask about. The snapshot itself
  // survives: one module's unsupported value is not a reason to discard the
  // other six and the state Realtime steers on.
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
  const downgraded = normalizeDirectSnapshot({
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
  });
  const unsupportedRow = downgraded.modules.find((item) => item.moduleId === 'mortgage_analysis');
  assert.notEqual(unsupportedRow.status, 'ready');
  assert.equal(unsupportedRow.authoredInput, undefined);
  assert.ok(
    unsupportedRow.missing.some((need) => need.path === '/currentBalance'),
    'the value nothing supports must become an open item, not a silent default'
  );
  assert.equal(downgraded.modules.length, DIRECT_MODULE_IDS.length);

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
  const undisclosed = normalizeDirectSnapshot({
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
  });
  const undisclosedRow = undisclosed.modules.find((item) => item.moduleId === 'mortgage_analysis');
  assert.notEqual(undisclosedRow.status, 'ready');
  assert.ok(undisclosedRow.missing.some((need) => need.path === '/annualOverpayment'));

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

/* ---------- an empty collection is a claim, and it needs saying out loud ---- */

// FOUND WITH THE REAL MODEL. Asked whether they could cope if they lost their
// job, the planner also produced a balance sheet and marked it ready with an
// empty liabilityPositions -- asserting the client has no debts in a
// conversation where debts were never raised. That is exactly the hidden
// default that must never become a financial fact, and provenance caught it.
// Pinned here so the rule cannot be relaxed by a later tolerance: "none" is
// something the client says, not something a silent empty array may imply.
{
  const debtFreeInput = { ...inputs.personal_balance_sheet, liabilityPositions: [] };
  const rowsFor = (evidence) => DIRECT_MODULE_IDS.map((id) => ({
    moduleId: id,
    outputKey: DIRECT_MODULE_CONTRACTS[id].outputKey,
    status: id === 'personal_balance_sheet' ? 'ready' : 'not_relevant',
    inputJson: id === 'personal_balance_sheet' ? JSON.stringify(debtFreeInput) : '',
    steeringSummary: '', missing: [], ambiguities: [], assumptions: [],
    evidence: id === 'personal_balance_sheet' ? evidence : []
  }));
  const run = (evidence) => normalizeDirectSnapshot({
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: 0,
    throughTurnId: 'turn-none',
    modules: rowsFor(evidence),
    generalAmbiguities: [],
    confirmationPrompt: CONFIRMATION_PROMPT
  }, {
    turns: [{ id: 'turn-none', role: 'user', transcript: PBS_NONE_TRANSCRIPT }],
    throughTurnId: 'turn-none', previousRevision: 0,
    policyEnvelope: POLICY, currentProfileContext: PBS_EVIDENCE_PROFILE,
    allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
  });

  const unspoken = run(PBS_ASSET_EVIDENCE);
  const unspokenRow = unspoken.modules.find((item) => item.moduleId === 'personal_balance_sheet');
  assert.notEqual(unspokenRow.status, 'ready',
    'an empty liability list nobody spoke about must not be ready');
  assert.ok(unspokenRow.missing.some((need) => need.path === '/liabilityPositions'),
    'and the unspoken claim must become the thing the conversation asks about');

  // The same input IS allowed once the client actually said it.
  const spoken = run([
    ...PBS_ASSET_EVIDENCE,
    { path: '/liabilityPositions', source: 'conversation', turnId: 'turn-none', quote: 'we have no debts at all', profilePath: '' }
  ]);
  assert.equal(
    spoken.modules.find((item) => item.moduleId === 'personal_balance_sheet').status,
    'ready',
    'a categorical none the client actually stated must be accepted as evidence'
  );
}
pass('an empty collection is ready only when the client said there are none');

// Selecting college funding supplies no child facts. Even an inconsistent
// model label of ready cannot overrule its explicit missing-input list.
for (const status of ['collecting', 'needs_clarification', 'ready']) {
  const selected = normalizeDirectSnapshot({
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: 0,
    throughTurnId: 'college-goal-only',
    modules: DIRECT_MODULE_IDS.map((moduleId) => ({
      moduleId,
      outputKey: DIRECT_MODULE_CONTRACTS[moduleId].outputKey,
      status: moduleId === 'college_funding' ? status : 'not_relevant',
      inputJson: moduleId === 'college_funding' ? JSON.stringify({
        currentYear: Number(TODAY.slice(0, 4)),
        inflationRate: PLANEIR_ASSUMPTIONS.inflation.educationRate,
        scenarios: approvedCollegeScenarios()
      }) : '',
      steeringSummary: moduleId === 'college_funding' ? 'College funding selected; children and ages are unknown.' : '',
      missing: moduleId === 'college_funding' ? [{
        path: '/children',
        reason: 'The children and their current ages are not established.',
        question: 'Which children would you like to plan for, and how old are they now?'
      }] : [],
      ambiguities: [], assumptions: [], evidence: []
    })),
    generalAmbiguities: [], confirmationPrompt: ''
  }, {
    turns: [{ id: 'college-goal-only', role: 'user', transcript: 'Planning for future college costs.' }],
    throughTurnId: 'college-goal-only', previousRevision: 0,
    policyEnvelope: POLICY, currentProfileContext: PBS_EVIDENCE_PROFILE,
    allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
  });
  const college = selected.modules.find((item) => item.moduleId === 'college_funding');
  assert.notEqual(college.status, 'ready');
  assert.equal(college.missing[0].path, '/children');
  assert.equal(college.input.children, undefined);
  assert.equal(college.input.childrenCount, undefined);
  assert.equal(college.input.fundingYears, undefined);
  assert.equal(selected.confirmationPrompt, '');
  assert.equal(selected.modules.length, 7);
}
pass('college selection without child facts stays incomplete and preserves the next intake question');

/* ------- the first real production call, 2026-09-03, meeting rt_KUTY_… ------ */

// WHAT HAPPENED. A client said "I'm after having a new baby and I'm 30 years
// old", chose college funding, and the meeting then died. The planner marked
// college_funding ready -- correctly: this module's only client-owned input is
// each child's age, because every cost, the education inflation rate, the start
// age and the course length are centrally approved Planéir assumptions. The
// snapshot stored the input the ENGINE derives from that (childrenCount,
// fundingYears, firstCollegeYear, …) and handed it straight back to the planner
// next turn as "preserve this". No quote can ever support an engine-derived
// field, so provenance refused the pass -- and refused it again on every
// following turn, because each retry was fed the same poisoned previous input.
// Seven consecutive passes failed, no snapshot advanced, no confirmation could
// ever be offered, and Planéir ended up telling the client to wait.
//
// The rule this pins: the planner is shown only input a planner could author.
{
  const COLLEGE_TURN = 'Um, it is mostly just a usual, I guess it is a check-up. I am after having a new baby and I am 30 years old and I just want to make sure I am in a good financial position to get this baby, you know, into college in the future and I am OK.';
  const babyInput = {
    currentYear: Number(TODAY.slice(0, 4)),
    inflationRate: PLANEIR_ASSUMPTIONS.inflation.educationRate,
    children: [{
      id: 'child-1',
      title: 'New baby',
      currentAge: 0,
      collegeStartAge: PLANEIR_ASSUMPTIONS.collegeFunding.startAge,
      collegeDurationYears: PLANEIR_ASSUMPTIONS.collegeFunding.durationYears
    }],
    scenarios: approvedCollegeScenarios()
  };
  const COLLEGE_PROMPT = 'I will run the college funding projection for one child, currently a newborn, starting college at 18 for four years, against the approved living-at-home and living-away cost scenarios. Would you like me to run exactly that plan now?';
  const collegeRows = (input, evidence, { baseRevision = 0 } = {}) => DIRECT_MODULE_IDS.map((id) => ({
    moduleId: id,
    outputKey: DIRECT_MODULE_CONTRACTS[id].outputKey,
    status: id === 'college_funding' ? 'ready' : 'not_relevant',
    inputJson: id === 'college_funding' ? JSON.stringify(input) : '',
    steeringSummary: id === 'college_funding' ? 'One child, a newborn, with college timing on the approved Planéir assumptions.' : '',
    missing: [],
    ambiguities: [],
    assumptions: id === 'college_funding' ? [
      { path: '/children/0/collegeStartAge', valueJson: String(PLANEIR_ASSUMPTIONS.collegeFunding.startAge), source: 'contract_default' },
      { path: '/children/0/collegeDurationYears', valueJson: String(PLANEIR_ASSUMPTIONS.collegeFunding.durationYears), source: 'contract_default' }
    ] : [],
    evidence: id === 'college_funding' ? evidence : [],
    baseRevision
  })).map(({ baseRevision: _unused, ...row }) => row);
  const collegeTurns = [{ id: 'turn-college', role: 'user', transcript: COLLEGE_TURN }];
  const runCollege = (input, evidence, { previousRevision = 0, throughTurnId = 'turn-college' } = {}) => normalizeDirectSnapshot({
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: previousRevision,
    throughTurnId,
    modules: collegeRows(input, evidence),
    generalAmbiguities: [],
    confirmationPrompt: COLLEGE_PROMPT
  }, {
    turns: throughTurnId === 'turn-college'
      ? collegeTurns
      : [...collegeTurns, { id: throughTurnId, role: 'user', transcript: 'Planning for future college costs.' }],
    throughTurnId,
    previousRevision,
    policyEnvelope: POLICY,
    currentProfileContext: PBS_EVIDENCE_PROFILE,
    allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
  });

  const babyEvidence = [
    { path: '/children/0', source: 'conversation', turnId: 'turn-college', quote: 'I am after having a new baby', profilePath: '' }
  ];
  const first = runCollege(babyInput, babyEvidence);
  const firstCollege = first.modules.find((item) => item.moduleId === 'college_funding');
  assert.equal(firstCollege.status, 'ready',
    'college funding needs only the child, so one stated newborn genuinely completes it');
  assert.equal(firstCollege.input.childrenCount, 1);
  assert.ok(Array.isArray(firstCollege.input.fundingYears) && firstCollege.input.fundingYears.length > 0,
    'the stored input is what the engine will run, derived fields included');

  // THE POISON, EXACTLY AS PRODUCTION FED IT BACK. What the planner is shown
  // next turn must be the input a planner could have written.
  const shown = plannerFacingSnapshot(first);
  const shownCollege = shown.modules.find((item) => item.moduleId === 'college_funding');
  assert.deepEqual(Object.keys(shownCollege.input).sort(), Object.keys(babyInput).sort(),
    'the planner is shown its own authored input, never the engine\'s derived expansion');
  assert.equal(shownCollege.authoredInput, undefined);
  for (const derived of ['childrenCount', 'timingMode', 'fundingYears', 'firstCollegeYear', 'currencySymbol']) {
    assert.equal(shownCollege.input[derived], undefined,
      `${derived} is the engine's, and no quote can ever support it`);
  }

  // The production second pass: preserve the previous input verbatim, as the
  // extractor prompt instructs. This is the pass that failed seven times.
  const second = runCollege(shownCollege.input, babyEvidence, {
    previousRevision: first.snapshotRevision,
    throughTurnId: 'turn-goal'
  });
  assert.equal(second.snapshotRevision, first.snapshotRevision + 1,
    'preserving the previous input must advance the snapshot, not freeze the meeting');
  assert.equal(second.modules.find((item) => item.moduleId === 'college_funding').status, 'ready');

  // AND SELECTING A MODULE IS STILL NOT THE SAME AS COMPLETING IT. Strip the
  // quote that establishes the child: the client-owned values become
  // unsupported, so the module leaves the pass NOT ready and the conversation
  // gets something to ask about instead of a silent default.
  const unevidenced = runCollege(babyInput, [
    { path: '/children/0/title', source: 'conversation', turnId: 'turn-college', quote: 'a new baby', profilePath: '' }
  ]);
  const unevidencedCollege = unevidenced.modules.find((item) => item.moduleId === 'college_funding');
  assert.notEqual(unevidencedCollege.status, 'ready');
  assert.ok(unevidencedCollege.missing.some((need) => need.path === '/children/0/currentAge'),
    'a child age nobody stated must be asked for, never defaulted into a projection');
  assert.equal(unevidencedCollege.input.childrenCount, undefined,
    'a module that is not ready holds only what the planner wrote');
}
pass('the first production call: an engine-derived input never returns to the planner as its own');

/* ---- more goals than one plan can hold is a question, not a lost snapshot -- */

// Seen replaying the production transcript against the real model: the client
// named college, the mortgage, retirement and living comfortably, and the
// planner marked four modules relevant. The cap is real -- a consumer plan
// holds three analyses -- but enforcing it by discarding the pass threw away
// the whole conversation's state over a prioritisation the CLIENT is the only
// one who can make.
{
  const overCapacityRows = DIRECT_MODULE_IDS.map((id) => ({
    moduleId: id,
    outputKey: DIRECT_MODULE_CONTRACTS[id].outputKey,
    status: ['mortgage_analysis', 'college_funding', 'pension_projection', 'liquidity_analysis'].includes(id)
      ? (id === 'mortgage_analysis' ? 'ready' : 'collecting')
      : 'not_relevant',
    inputJson: id === 'mortgage_analysis' ? JSON.stringify(inputs.mortgage_analysis) : '',
    steeringSummary: '',
    missing: [], ambiguities: [],
    assumptions: id === 'mortgage_analysis' ? [
      { path: '/endDateIso', valueJson: 'null', source: 'contract_default' },
      { path: '/fixedPaymentAmount', valueJson: 'null', source: 'contract_default' },
      { path: '/oneOffOverpayment', valueJson: '0', source: 'contract_default' },
      { path: '/annualOverpayment', valueJson: '0', source: 'contract_default' }
    ] : [],
    evidence: id === 'mortgage_analysis' ? [
      { path: '/currentBalance', source: 'conversation', turnId: 'turn-1', quote: 'two hundred and forty grand', profilePath: '' },
      { path: '/annualInterestRate', source: 'profile', turnId: '', quote: '', profilePath: '/knownMortgageRate' },
      { path: '/remainingTermYears', source: 'profile', turnId: '', quote: '', profilePath: '/knownMortgageTermYears' }
    ] : []
  }));
  const overCapacity = normalizeDirectSnapshot({
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: 0,
    throughTurnId: 'turn-1',
    modules: overCapacityRows,
    generalAmbiguities: [],
    confirmationPrompt: CONFIRMATION_PROMPT
  }, {
    turns: [{ id: 'turn-1', role: 'user', transcript }],
    throughTurnId: 'turn-1', previousRevision: 0,
    policyEnvelope: POLICY, currentProfileContext: EVIDENCE_PROFILE,
    allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
  });
  assert.equal(overCapacity.modules.length, DIRECT_MODULE_IDS.length);
  assert.equal(overCapacity.modules.some((item) => item.status === 'ready'), false,
    'nothing may execute while the plan holds more analyses than it is allowed to run');
  assert.equal(overCapacity.confirmationPrompt, '');
  const capacityQuestion = overCapacity.generalAmbiguities.find((item) => item.id === 'plan_capacity');
  assert.ok(capacityQuestion, 'the client is asked which analyses to work through first');
  assert.equal(capacityQuestion.relatedModuleIds.length, 4);
}
pass('more goals than one plan can hold becomes a client question, not a discarded snapshot');

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
// The turn the balance was quoted from is no longer in the window, so the
// citation resolves to nothing. It is dropped -- and the value it was the only
// support for is then unsupported, so the module cannot stay ready. What must
// never happen is that the figure survives without its transcript.
const lostProvenance = normalizeDirectSnapshot({
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
});
const lostRow = lostProvenance.modules.find((item) => item.moduleId === 'mortgage_analysis');
assert.notEqual(lostRow.status, 'ready');
assert.ok(lostRow.missing.some((need) => need.path === '/currentBalance'));
assert.equal(lostRow.evidence.some((item) => item.path === '/currentBalance'), false,
  'a citation whose transcript span is gone must not be recorded as provenance');
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
  modulePlannerPromptVersion: 'direct-module-planner-v6',
  moduleVerifierPromptVersion: 'direct-module-verifier-v3'
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
let lastExtractorEnvelope = null;
let lastVerifierEnvelope = null;
globalThis.fetch = async (_url, request) => {
  providerCalls += 1;
  const body = JSON.parse(request.body);
  assert.equal(body.text.format.type, 'json_schema');
  const envelope = JSON.parse(body.input[1].content);
  const value = body.text.format.name === 'module_planning_snapshot_v1'
    ? ((lastExtractorEnvelope = envelope), extractionValue)
    : (() => {
        lastVerifierEnvelope = envelope;
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

  /* ------------- the planner is told what each module can actually do ------ */

  // WHY THIS IS PINNED. The whole architecture rests on the AI making semantic
  // judgments about a SPECIFIC Planéir calculation -- what it needs, what it
  // assumes, what it cannot do -- rather than about financial planning in
  // general. That only holds while the Master Prompt Pack actually reaches the
  // model. Nothing else in this suite would notice if the playbook wiring were
  // dropped: every structural rule would still pass, and the planner would
  // quietly fall back to generic knowledge and invent plausible fields.
  const sentContracts = lastExtractorEnvelope?.contracts || [];
  assert.deepEqual(
    sentContracts.map((item) => item.moduleId).sort(),
    [...APPROVED_CONSUMER_MODULE_IDS].sort(),
    'every approved module is described to the planner, so non-selection is a judgment and not an absence'
  );
  for (const contract of sentContracts) {
    assert.equal(
      contract.masterPromptPackPlaybook,
      PLANNING_PLAYBOOK_GUIDANCE[contract.moduleId],
      `${contract.moduleId} must carry its real Master Prompt Pack playbook, not a summary of one`
    );
    assert.ok(
      String(contract.masterPromptPackPlaybook || '').length > 1_000,
      `${contract.moduleId} playbook must be substantial enough to describe the module's capabilities`
    );
    assert.equal(contract.outputKey, DIRECT_MODULE_CONTRACTS[contract.moduleId].outputKey);
    assert.ok(Array.isArray(contract.serverInputPolicy),
      `${contract.moduleId} must be told which values the server owns, or it will ask the client for them`);
  }
  // Capability grounding is not just "a document was attached": the playbook has
  // to name the fields the engine will actually receive. Mortgage overpayments
  // are the case that prompted this -- an engine-owned default of zero that
  // genuinely changes the amortisation, and that the module's own assumptions
  // table shows the client.
  const mortgagePlaybook = PLANNING_PLAYBOOK_GUIDANCE.mortgage_analysis;
  for (const field of ['currentBalance', 'annualInterestRate', 'oneOffOverpayment', 'annualOverpayment']) {
    assert.ok(mortgagePlaybook.includes(field),
      `the mortgage playbook must describe ${field}, which the engine reads`);
  }
  assert.deepEqual(
    (lastExtractorEnvelope?.serverPolicy?.modules?.mortgage_analysis || [])
      .filter((entry) => ['/oneOffOverpayment', '/annualOverpayment'].includes(entry.path))
      .map((entry) => `${entry.path}=${JSON.stringify(entry.value)}:${entry.mode}`)
      .sort(),
    ['/annualOverpayment=0:default', '/oneOffOverpayment=0:default'],
    'a zero overpayment is an engine-owned default the planner may disclose, never a client fact it must invent'
  );
  assert.deepEqual(
    (lastVerifierEnvelope?.contracts || []).map((item) => item.moduleId).sort(),
    [...APPROVED_CONSUMER_MODULE_IDS].sort(),
    'the verifier audits against the same capability contracts the planner was given'
  );
  pass('the planner and verifier are grounded in the real module capability contracts');

  /* --------- a capability the module does not have cannot be invented ------ */

  // The category that has no field, no default and no policy path. An invented
  // input must not reach the maths, must not become provenance, and must not be
  // able to hold a module ready -- whatever the planner writes about it.
  {
    const invented = {
      ...inputs.mortgage_analysis,
      interestOnlyPeriodYears: 5,
      paymentHolidayMonths: 3
    };
    const canonical = normalizePlanningModuleInput('mortgage_analysis', structuredClone(invented));
    assert.equal(canonical.interestOnlyPeriodYears, undefined);
    assert.equal(canonical.paymentHolidayMonths, undefined,
      'the native contract is the capability boundary: a field the engine has no use for never reaches it');
    assert.equal(
      directModulePolicyEntries('mortgage_analysis', invented, POLICY)
        .some((entry) => entry.path === '/interestOnlyPeriodYears'),
      false,
      'an invented field can never become a server-owned assumption'
    );
    const inventedRows = moduleRows.map((item) => (
      item.moduleId === 'mortgage_analysis'
        ? {
            ...item,
            inputJson: JSON.stringify(invented),
            assumptions: [
              ...item.assumptions,
              // The planner claiming Planéir models something it does not.
              { path: '/interestOnlyPeriodYears', valueJson: '5', source: 'planning_policy' }
            ]
          }
        : item
    ));
    const contained = normalizeDirectSnapshot({
      schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
      baseSnapshotRevision: 0,
      throughTurnId: 'turn-1',
      modules: inventedRows,
      generalAmbiguities: [],
      confirmationPrompt: CONFIRMATION_PROMPT
    }, {
      turns: [{ id: 'turn-1', role: 'user', transcript }],
      throughTurnId: 'turn-1', previousRevision: 0,
      policyEnvelope: POLICY, currentProfileContext: EVIDENCE_PROFILE,
      allowedModuleIds: APPROVED_CONSUMER_MODULE_IDS
    });
    const containedRow = contained.modules.find((item) => item.moduleId === 'mortgage_analysis');
    assert.equal(containedRow.input.interestOnlyPeriodYears, undefined,
      'nothing the module cannot calculate reaches the input that will run');
    assert.equal(
      containedRow.assumptions.some((item) => item.path === '/interestOnlyPeriodYears'),
      false,
      'and an invented capability is never recorded as a disclosed assumption'
    );
    assert.ok(containedRow.assumptions.some((item) => item.path === '/annualOverpayment'),
      'while a real engine-owned default is still disclosed alongside it');
  }
  pass('an unsupported capability cannot reach the maths, the provenance record or the certificate');
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
      modulePlannerPromptVersion: 'direct-module-planner-v6',
      moduleVerifierPromptVersion: 'direct-module-verifier-v3'
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
