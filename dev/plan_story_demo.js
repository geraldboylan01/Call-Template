import { createBlankModule, normalizePayload, applyNormalizedPayloadToModule } from '../js/module_pipeline.js';
import { computePersonalBalanceSheet } from '../js/personal_balance_sheet.js';
import { newSession, importSession, drainSessionImportWarnings } from '../js/state.js';
import { buildSamplePlanStory } from '../js/tests_plan_story_sample.js';
import { buildPresentationCatalogue } from '../js/presenter_catalogue.js';

/**
 * A DEMO SESSION FOR THE REAL APP.
 *
 * The story's household (Niamh and Dara, both 45; Ella, 10) built into real
 * modules by the same pipeline the form uses, plus the sample story. Opening the
 * app on it shows the story first, the module grid below, and links that open
 * these modules on the route's case.
 *
 * It exists so the wiring can be seen and checked with real figures. In the
 * product the plan's code builds the modules and computes every fact in the
 * story; here the inputs are written down so each figure can be compared with
 * what its module prints.
 *
 *   ?go=1     write it and open the app on it
 *   (none)    write it and say what it wrote
 */

const build = (title, generated) => {
  const module = createBlankModule();
  applyNormalizedPayloadToModule(module, normalizePayload({ title, generated }), { resetEditorState: false });
  return module;
};

const protectionInputs = {
  householdLabel: 'Niamh and Dara, both 45',
  people: [{ id: 'niamh', label: 'Niamh', takeHome: 57000 }, { id: 'dara', label: 'Dara', takeHome: 45000 }],
  needed: 96000,
  savings: 75000,
  scenarios: [
    { id: 'today' },
    { id: 'niamh-cannot-work', event: { type: 'cannotWork', personId: 'niamh', statePayment: 13000 } },
    { id: 'dara-cannot-work', event: { type: 'cannotWork', personId: 'dara', statePayment: 13000 } }
  ]
};

const mortgageInputs = {
  currentBalance: 280000, annualInterestRate: 0.04, startDateIso: '2027-01-01', remainingTermYears: 20, fixedPaymentAmount: 1700,
  repaymentType: 'repayment', loanKind: 'mortgage', overpaymentBenefit: 'shorterTerm', baseScenarioId: 'today',
  scenarios: [{ id: 'today', title: 'Today' }, { id: 'extra', title: 'Pay €371 more a month', fixedPaymentAmount: 2071 }]
};

const carInputs = {
  currentBalance: 15000, annualInterestRate: 0.06, startDateIso: '2026-12-01', remainingTermYears: 2.75, fixedPaymentAmount: 500,
  repaymentType: 'repayment', loanKind: 'loan', overpaymentBenefit: 'shorterTerm', baseScenarioId: 'keep',
  scenarios: [{ id: 'keep', title: 'Keep paying' }, { id: 'clear', title: 'Clear it now', oneOffOverpayment: 15000 }]
};

const collegeInputs = {
  costTitle: 'College: Ella', costKind: 'education', startsInYears: 8, durationYears: 4, annualCostToday: 5000,
  scenarios: [{ id: 'lump', lumpShare: 1 }, { id: 'yearly', lumpShare: 0 }], baseScenarioId: 'yearly'
};

// Take-home is stated, so the figures come from the household and not from the tax engine.
const cashFlowInputs = {
  householdTaxStatus: 'married_or_civil_partners',
  people: [{ id: 'niamh', age: 45, label: 'Niamh', statedTakeHome: 57000 }, { id: 'dara', age: 45, label: 'Dara', statedTakeHome: 45000 }],
  income: [{ personId: 'niamh', type: 'employment', amount: 75000 }, { personId: 'dara', type: 'employment', amount: 75000 }],
  outgoings: [
    { id: 'mortgage', label: 'Mortgage', amount: 20400 },
    { id: 'car', label: 'Car loan', amount: 6000 },
    { id: 'living', label: 'Living costs', amount: 52600 },
    { id: 'children', label: 'Children', amount: 9000 },
    { id: 'insurance', label: 'Insurance', amount: 3000 }
  ],
  scenarios: [
    { id: 'today' },
    { id: 'clear-car', changes: [{ type: 'clearOutgoing', outgoingId: 'car', paidFrom: 'savings' }] }
  ],
  calculationYear: 2026
};

const reservePlan = { currencySymbol: '€', clientStatus: 'not-retired', annualExpenditure: 84000, currentCash: 90000, minimumBufferMonths: 3, targetBufferMonths: 6 };

const pensionInputs = {
  currentYear: 2026, currentAge: 45, retirementAge: 67, currentSalary: 100000, currentPot: 380000, personalPct: 0.05, employerPct: 0.05,
  growthRate: 0.05, inflationRate: 0.02, wageGrowthRate: 0.02, incomeMode: 'target', targetIncomeToday: 46000, horizonEndAge: 100
};

function balanceSheetModule() {
  const position = (id, label, bucket, amount) => ({ id, label, bucket, amount, source: 'story' });
  const home = position('home', 'Family home', 'lifestyle_assets', 450000);
  const pension = position('pension', 'Pension funds', 'retirement_funding', 380000);
  const cash = (amount) => position('cash', 'Cash savings', 'spendable_reserves', amount);
  const debt = (id, label, amount) => position(id, label, 'liabilities', amount);
  const cases = [
    { id: 'today', title: 'Today', assets: [home, cash(90000), pension], debts: [debt('mortgage', 'Home mortgage', 280000), debt('car', 'Car loan', 15000)], movements: [] },
    {
      id: 'route3', title: 'Route 3', assets: [home, cash(75000), pension], debts: [debt('mortgage', 'Home mortgage', 280000)],
      movements: [{ from: { sectionKey: 'liquidity', rowLabel: 'Cash savings', amount: 15000 }, to: [{ sectionKey: 'liabilities', rowLabel: 'Car loan', amount: 15000, action: 'reduce' }] }]
    }
  ];
  const buckets = [['lifestyle', 'Lifestyle', 'lifestyle_assets'], ['liquidity', 'Liquidity', 'spendable_reserves'], ['longevity', 'Longevity', 'retirement_funding'], ['legacy', 'Legacy', 'concentrated_assets']];
  const drawn = cases.map((entry) => {
    const result = computePersonalBalanceSheet({ assetPositions: entry.assets, liabilityPositions: entry.debts });
    const sections = buckets.map(([key, title, bucket]) => ({
      key, title, columns: ['Asset', 'Amount (€)'], rows: result.buckets[bucket].positions.map((item) => [item.label, item.amount]),
      subtotalLabel: `${title} total`, subtotalValue: result.buckets[bucket].total
    }));
    sections.push({ key: 'liabilities', title: 'Liabilities', columns: ['Liability', 'Amount (€)'], rows: result.liabilities.map((item) => [item.label, item.amount]), subtotalLabel: 'Total liabilities', subtotalValue: result.totalLiabilities });
    sections.push({ key: 'summary', title: 'Summary', columns: ['Metric', 'Amount (€)'], rows: [['Gross assets', result.grossAssets], ['Total liabilities', result.totalLiabilities], ['Net worth', result.netWorth]], subtotalLabel: 'Net worth', subtotalValue: result.netWorth });
    return { id: entry.id, title: entry.title, sections, movements: entry.movements };
  });
  return build('Balance sheet', {
    outputsBucketed: { currencySymbol: '€', sections: drawn[0].sections, scenarios: drawn.slice(1) },
    charts: []
  });
}

export function buildDemoSession() {
  const modules = {
    household_cash_flow: build('Household cash flow', { householdCashFlowInputs: cashFlowInputs }),
    liquidity_analysis: build('Cash reserve', { liquidityPlan: reservePlan }),
    protection_gap: build('Protection gap', { protectionGapInputs: protectionInputs }),
    loan_analysis: build('Car loan', { mortgageInputs: carInputs }),
    mortgage_analysis: build('Mortgage', { mortgageInputs: mortgageInputs }),
    future_cost_fund: build('College fund', { futureCostFundInputs: collegeInputs }),
    pension_projection: build('Pension', { pensionInputs }),
    personal_balance_sheet: balanceSheetModule()
  };
  const session = newSession('Niamh and Dara');
  session.modules = Object.values(modules);
  session.order = session.modules.map((module) => module.id);
  session.activeModuleId = session.order[0];
  session.planStory = buildSamplePlanStory(Object.fromEntries(Object.entries(modules).map(([chapter, module]) => [chapter, module.id])));
  const catalogue = buildPresentationCatalogue(session);
  const facts = session.planStory.registries['route-3'];
  for (const [key, metric] of [['position.savings', 'current-cash'], ['position.reserve', 'target-reserve']]) {
    const target = catalogue.targets.find((entry) => entry.ref.type === 'liquidity-metric' && entry.ref.key === metric);
    if (target) facts[key].source.focusTargetId = target.id;
  }
  return importSession(JSON.stringify(session));
}

const params = new URLSearchParams(location.search);
const status = document.getElementById('status');
try {
  const session = buildDemoSession();
  localStorage.setItem('call_canvas_session_current', JSON.stringify(session));
  const warnings = drainSessionImportWarnings();
  status.textContent = session.planStory
    ? `Wrote a demo session with ${session.modules.length} modules and a story for ${Object.keys(session.planStory.stories).length} route.${warnings.length ? ` Warnings: ${warnings.join(' ')}` : ''}`
    : `The story was left out. ${warnings.join(' ')}`;
  document.body.dataset.ready = 'true';
  if (params.get('go')) location.href = '../app/index.html?view=overview';
} catch (error) {
  status.textContent = `The demo session could not be built: ${error.message}`;
  document.body.dataset.ready = 'error';
}
