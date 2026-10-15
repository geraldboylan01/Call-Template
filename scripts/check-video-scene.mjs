import { buildVideoSceneManifest, VIDEO_SCENE_MANIFEST_VERSION } from '../js/video_scene.js';
import { createDefaultHousePurchaseInputs } from '../js/house_purchase/engine.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function baseModule(id, title, generated) {
  return { id, title, generated };
}

const session = {
  sessionId: 'session-video-test',
  clientName: 'Video Test Client'
};

const pensionInputs = {
  currentAge: 42,
  retirementAge: 67,
  currentSalary: 85000,
  currentPot: 180000,
  personalPct: 0.08,
  employerPct: 0.06,
  growthRate: 0.05,
  inflationRate: 0.02,
  wageGrowthRate: 0.02,
  horizonEndAge: 92,
  currentYear: 2026,
  incomeMode: 'target',
  targetIncomeToday: 42000,
  rentalIncomeScenarios: [
    { id: 'keep-rent', title: 'Keep rent', rentalIncomeToday: 18000 },
    { id: 'sell-rent', title: 'Sell rent', rentalIncomeToday: 0 }
  ],
  baseScenarioId: 'keep-rent'
};

const retirementCaseInputs = {
  currentAge: 50,
  retirementAge: 62,
  currentSalary: 90000,
  currentPot: 400000,
  personalPct: 0.05,
  employerPct: 0.06,
  growthRate: 0.05,
  inflationRate: 0.02,
  wageGrowthRate: 0.02,
  horizonEndAge: 92,
  currentYear: 2026,
  incomeMode: 'target',
  targetIncomeToday: 45000,
  baseScenarioId: 'retire-62',
  scenarios: [
    { id: 'retire-62', title: 'Retire at 62' },
    { id: 'retire-58', title: 'Retire at 58', retirementAge: 58 }
  ]
};

const netRetirementInputs = {
  currentYear: 2026,
  currentAge: 60,
  horizonEndAge: 100,
  annualExpenditureToday: 90000,
  expenditureInflationRate: 0,
  presentValueRate: 0,
  availableInvestmentFundToday: 1027000,
  incomeSources: [
    { id: 'rent', title: 'Rental income', annualAmountToday: 10000, startAge: 60, inflationIndexed: false }
  ],
  baseScenarioId: 'keep-rent',
  scenarios: [
    { id: 'keep-rent', title: 'Keep rental property', availableInvestmentFundToday: 1027000 },
    { id: 'sell-rent', title: 'Sell rental property', availableInvestmentFundToday: 1477000, excludedIncomeSourceIds: ['rent'] }
  ]
};

const collegeFundingInputs = {
  currentYear: 2026,
  childrenCount: 2,
  childCurrentAge: 13,
  collegeStartAge: 18,
  collegeDurationYears: 4,
  inflationRate: 0.02,
  scenarios: [
    { id: 'at-home', title: 'At home', category: 'At home', annualCostTodayPerChild: 5000, oneOffCostTodayPerChild: 0 },
    { id: 'away', title: 'Away from home', category: 'Away from home', annualCostTodayPerChild: 15000, oneOffCostTodayPerChild: 10000 }
  ]
};

const futureCostFundInputs = {
  costTitle: 'College',
  costKind: 'education',
  startsInYears: 8,
  durationYears: 4,
  annualCostToday: 15000,
  baseScenarioId: 'lump-sum',
  scenarios: [
    { id: 'lump-sum', title: 'Lump sum today', lumpShare: 1 },
    { id: 'every-year', title: 'Save every year', lumpShare: 0 }
  ]
};

const householdCashFlowInputs = {
  householdTaxStatus: 'married_or_civil_partners',
  people: [
    { id: 'niamh', age: 45, label: 'Niamh' },
    { id: 'dara', age: 45, label: 'Dara' }
  ],
  income: [
    { personId: 'niamh', type: 'employment', amount: 75000 },
    { personId: 'dara', type: 'employment', amount: 75000 }
  ],
  outgoings: [
    { id: 'mortgage', label: 'Mortgage', amount: 30000 },
    { id: 'car', label: 'Car loan', amount: 6000 },
    { id: 'living', label: 'Living costs', amount: 48000 },
    { id: 'children', label: 'Children', amount: 9000 },
    { id: 'insurance', label: 'Insurance', amount: 3000 }
  ],
  scenarios: [
    { id: 'today' },
    { id: 'clear-car', changes: [{ type: 'clearOutgoing', outgoingId: 'car', paidFrom: 'savings' }] },
    { id: 'pension', changes: [{ type: 'extraPension', amount: 10000 }] }
  ]
};

const protectionGapInputs = {
  householdLabel: 'Niamh and Dara, both 45',
  people: [
    { id: 'niamh', label: 'Niamh', takeHome: 57000 },
    { id: 'dara', label: 'Dara', takeHome: 45000 }
  ],
  needed: 96000,
  savings: 60000,
  scenarios: [
    { id: 'today' },
    { id: 'niamh-cannot-work', event: { type: 'cannotWork', personId: 'niamh', statePayment: 13000 } },
    { id: 'dara-cannot-work', event: { type: 'cannotWork', personId: 'dara', statePayment: 13000 } },
    {
      id: 'niamh-died',
      event: {
        type: 'dies',
        personId: 'niamh',
        survivorsPension: 13500,
        neededAfter: 60000,
        neededBecause: ['mortgageCleared', 'livingCostsLower']
      }
    }
  ]
};

const rentalKeepOrSellInputs = {
  rentPerYear: 18000,
  loanRepaymentsPerYear: 13000,
  runningCostsPerYear: 2500,
  taxOnRentalProfitPerYear: 3700,
  salePrice: 320000,
  sellingCosts: 6000,
  loanBalance: 180000,
  taxOnGain: 21000
};

function makeHousePurchaseInputs() {
  return {
    ...createDefaultHousePurchaseInputs('2026-07-12'),
    lendingCategory: 'first_time_buyer',
    applicants: [{
      id: 'applicant-1',
      label: 'Applicant',
      age: 34,
      employmentStatus: 'employee',
      grossAnnualIncome: 90000,
      variableAnnualIncome: 5000,
      lenderRecognisedVariableAnnualIncome: 0,
      incomeReliability: 'stable',
      existingMonthlyDebtPayments: 0,
      schemeBuyerStatus: 'first_time_buyer',
      freshStartReason: '',
      previouslyOwnedPropertyAnywhere: false,
      retainedInterestInPreviousProperty: false,
      rightToResideInIreland: true
    }],
    currentCashSavings: 60000,
    cashSavingsContributions: [{ ownerId: 'applicant-1', amount: 60000 }],
    amountRingfencedForOtherGoals: 5000,
    emergencyReserveMode: 'custom',
    emergencyReserveTarget: 10000,
    currentMonthlySavings: 1000,
    plannedMonthlySavings: 1200,
    monthlyNetHouseholdIncome: 6000,
    monthlyEssentialExpensesExcludingHousingDebtAndRent: 2500,
    currentMonthlyRent: 1800,
    estimatedMonthlyOwnershipCosts: 350,
    targetPropertyPrice: 400000,
    targetPurchaseDate: '2029-07-01',
    acquisitionType: 'new_build',
    dwellingType: 'house',
    intendedUse: 'principal_private_residence',
    localAuthorityCode: 'dublin_city',
    lenderCapacity: {
      status: 'confirmed',
      amount: 360000,
      lenderId: 'bank_of_ireland',
      isMaximumAvailable: true,
      macroPrudentialException: false,
      htbQualifyingLender: true
    },
    helpToBuy: {
      taxCompliant: true,
      revenueApprovedDeveloperOrApprover: true,
      expectedIncomeTaxAndDirtPaidPriorFourYears: 30000,
      confirmedClaimAmount: 0
    }
  };
}

const cases = [
  {
    name: 'House purchase recomputes the active local what-if',
    module: baseModule('house-1', 'Route to home', {
      summaryHtml: '<p>House purchase plan.</p>',
      housePurchaseInputs: makeHousePurchaseInputs(),
      outputs: { columns: ['Metric', 'Value'], rows: [['MODEL-SUPPLIED', 999999999]] },
      outputsBucketed: { sections: [{ key: 'summary', rows: [['MODEL-SUPPLIED', 999999999]] }] },
      charts: [{ id: 'model-chart', title: 'MODEL-SUPPLIED', labels: ['Bad'], datasets: [{ label: 'Bad', data: [999] }] }]
    }),
    activeScenario: {
      housePurchaseScenarioOverrides: { targetPropertyPrice: 375000, supportCase: 'none' }
    },
    verify(manifest) {
      assert(manifest.source.moduleKind === 'house-purchase', 'Expected house-purchase module kind');
      assert(manifest.source.calculationStatus === 'resolved', 'Expected house-purchase projection to resolve');
      assert(manifest.source.activeScenario.id === 'what-if-none', 'Expected house-purchase what-if scenario');
      assert(manifest.source.activeScenario.housePurchaseScenarioOverrides.targetPropertyPrice === 375000, 'Expected local house-purchase overrides to survive scene resolution');
      assert(manifest.story.metrics.length > 0, 'Expected runtime house-purchase output metrics');
      assert(manifest.story.charts.length > 0, 'Expected runtime house-purchase chart');
      assert(!JSON.stringify(manifest.story).includes('MODEL-SUPPLIED'), 'Runtime house-purchase calculations must replace supplied outputs and charts');
    }
  },
  {
    name: 'Invalid house purchase inputs never fall back to supplied calculations',
    module: baseModule('house-invalid', 'Incomplete route to home', {
      summaryHtml: '<p>More information is required.</p>',
      housePurchaseInputs: createDefaultHousePurchaseInputs('2026-07-12'),
      outputs: { columns: ['Metric', 'Value'], rows: [['MODEL-SUPPLIED', 999999999]] },
      charts: [{ id: 'model-chart', title: 'MODEL-SUPPLIED', labels: ['Bad'], datasets: [{ label: 'Bad', data: [999] }] }]
    }),
    verify(manifest) {
      assert(manifest.source.moduleKind === 'house-purchase', 'Expected incomplete house-purchase module kind');
      assert(manifest.source.calculationStatus === 'source-fallback', 'Expected an explicit source fallback for incomplete inputs');
      assert(!JSON.stringify(manifest.story).includes('MODEL-SUPPLIED'), 'Incomplete inputs must not expose supplied house-purchase calculations');
    }
  },
  {
    name: 'PBS alternative uses selected structured scenario',
    module: baseModule('pbs-1', 'Balance sheet', {
      summaryHtml: '<p>Current position.</p>',
      outputsBucketed: {
        currencySymbol: '€',
        sections: [
          { key: 'summary', title: 'Summary', rows: [['Gross assets', 500000], ['Total liabilities', 200000], ['Net worth', 300000]] }
        ],
        scenarios: [
          {
            id: 'clear-debt',
            title: 'Clear debt scenario',
            summaryHtml: '<p>Clearing debt raises net worth.</p>',
            sections: [
              { key: 'summary', title: 'Summary', rows: [['Gross assets', 500000], ['Total liabilities', 0], ['Net worth', 500000]] }
            ],
            movements: [{ action: 'remove', rowLabel: 'Mortgage balance' }]
          }
        ],
        charts: []
      },
      charts: []
    }),
    activeScenario: { pbsScenarioId: 'clear-debt' },
    verify(manifest) {
      assert(manifest.source.moduleKind === 'balance-sheet', 'Expected PBS module kind');
      assert(manifest.source.activeScenario.id === 'clear-debt', 'Expected selected PBS scenario');
      assert(manifest.story.metrics[2]?.value === '€500,000', 'Expected selected PBS net worth');
      assert(manifest.story.flowNodes[0]?.title === 'Mortgage balance', 'Expected PBS movement as flow node');
    }
  },
  {
    name: 'Pension resolves active calculator scenario',
    module: baseModule('pension-1', 'Retirement projection', {
      summaryHtml: '<p>Retirement case.</p>',
      pensionInputs,
      charts: []
    }),
    activeScenario: { pensionScenarioId: 'sell-rent' },
    verify(manifest) {
      assert(manifest.source.moduleKind === 'pension', 'Expected pension module kind');
      assert(manifest.source.calculationStatus === 'resolved', 'Expected pension projection to resolve');
      assert(manifest.story.charts.length > 0, 'Expected pension charts');
      assert(manifest.source.activeScenario.id === 'sell-rent', 'Expected selected pension scenario');
    }
  },
  {
    // A video of "Retire at 58" has to be made of that case's ages and
    // figures. Resolving the case but narrating the base's retirement year
    // would be the same mistake, told out loud.
    name: 'Pension resolves a retirement-age case with its own ages and timing',
    module: baseModule('pension-2', 'Retirement projection', {
      summaryHtml: '<p>Retirement case.</p>',
      pensionInputs: retirementCaseInputs,
      charts: []
    }),
    activeScenario: { pensionScenarioId: 'retire-58' },
    verify(manifest) {
      assert(manifest.source.calculationStatus === 'resolved', 'Expected the retirement case to resolve');
      assert(manifest.source.activeScenario.id === 'retire-58', 'Expected the selected retirement case');
      assert(manifest.source.activeScenario.title === 'Retire at 58', 'Expected the case title');
      assert(
        manifest.source.activeScenario.description === 'Retires at 58, income from 2034',
        `Expected the case to say what it changes, got "${manifest.source.activeScenario.description}"`
      );
      // Retiring four years earlier is four fewer years of contributions and
      // growth, so the headline figure has to be the case's own.
      assert(
        manifest.story.metrics[0]?.value === '€696,941',
        `Expected the case's own projected pot, got ${manifest.story.metrics[0]?.value}`
      );
    }
  },
  {
    name: 'Net retirement resolves active calculator scenario',
    module: baseModule('net-1', 'Net retirement', {
      summaryHtml: '<p>Net cash-flow case.</p>',
      netRetirementInputs,
      charts: []
    }),
    activeScenario: { netRetirementScenarioId: 'sell-rent' },
    verify(manifest) {
      assert(manifest.source.moduleKind === 'net-retirement', 'Expected net retirement module kind');
      assert(manifest.source.calculationStatus === 'resolved', 'Expected net retirement projection to resolve');
      assert(manifest.story.charts.length > 0, 'Expected net retirement charts');
      assert(manifest.source.activeScenario.id === 'sell-rent', 'Expected selected net retirement scenario');
    }
  },
  {
    name: 'Mortgage resolves calculated chart and outputs',
    module: baseModule('mortgage-1', 'Mortgage overpayment', {
      summaryHtml: '',
      mortgageInputs: {
        loanKind: 'mortgage',
        currentBalance: 250000,
        annualInterestRate: 0.045,
        startDateIso: '2026-01-01',
        remainingTermYears: 30,
        repaymentType: 'repayment',
        annualOverpayment: 5000
      },
      charts: []
    }),
    verify(manifest) {
      assert(manifest.source.moduleKind === 'mortgage', 'Expected mortgage module kind');
      assert(manifest.source.calculationStatus === 'resolved', 'Expected mortgage projection to resolve');
      assert(manifest.story.charts.length > 0, 'Expected mortgage chart');
      assert(manifest.story.metrics.length > 0, 'Expected mortgage output metrics');
    }
  },
  {
    name: 'College funding resolves calculated chart and outputs',
    module: baseModule('college-1', 'College funding', {
      summaryHtml: '<p>College support options.</p>',
      collegeFundingInputs,
      charts: []
    }),
    verify(manifest) {
      assert(manifest.source.moduleKind === 'college-funding', 'Expected college funding module kind');
      assert(manifest.source.calculationStatus === 'resolved', 'Expected college funding projection to resolve');
      assert(manifest.story.charts.length > 0, 'Expected college funding chart');
    }
  },
  {
    name: 'Future cost fund shows the selected case, with its own figures and its own fund line',
    module: baseModule('fund-1', 'College', {
      summaryHtml: '<p>Ways to have the money ready.</p>',
      futureCostFundInputs,
      // A calculated module's stored tables are never trusted.
      outputs: { columns: ['Metric', 'Value'], rows: [['MODEL-SUPPLIED', 999999999]] },
      charts: []
    }),
    activeScenario: { futureCostFundScenarioId: 'every-year' },
    verify(manifest) {
      assert(manifest.source.moduleKind === 'future-cost-fund', 'Expected future cost fund module kind');
      assert(manifest.source.calculationStatus === 'resolved', 'Expected future cost fund projection to resolve');
      assert(manifest.source.activeScenario.id === 'every-year', 'Expected the selected future cost fund case');
      assert(manifest.story.charts.length > 0, 'Expected the fund chart');
      const labels = manifest.story.metrics.map((metric) => metric.label).join(' | ');
      assert(!labels.includes('MODEL-SUPPLIED'), 'Expected model-supplied outputs to be replaced');
      assert(/You pay in/.test(labels) && /Growth/.test(labels), `Expected the selected case's figures (${labels})`);
      assert(!/Lump sum today/.test(labels), 'A case with no lump sum must not show one');
      const pays = manifest.story.metrics.find((metric) => /You pay in/.test(metric.label));
      assert(pays.rawValue === 86500, `Expected the yearly case to pay in 86,500 (got ${pays.rawValue})`);
    }
  },
  {
    name: 'A future cost fund far in the future keeps its whole horizon in the video chart',
    module: baseModule('fund-2', 'College', {
      futureCostFundInputs: { ...futureCostFundInputs, startsInYears: 18 }
    }),
    activeScenario: { futureCostFundScenarioId: 'every-year' },
    verify(manifest) {
      const chart = manifest.story.charts[0];
      assert(chart, 'Expected the fund chart');
      assert(chart.labels.length <= 14, `Expected at most 14 points (got ${chart.labels.length})`);
      assert(chart.labels[0] === 'Today', `Expected the chart to start today (${chart.labels[0]})`);
      assert(chart.labels.includes('Year 18'), `Expected the year the cost starts (${chart.labels.join(', ')})`);
      assert(chart.labels[chart.labels.length - 1] === 'Year 21', `Expected the last cost year (${chart.labels.join(', ')})`);
      const data = chart.datasets[0].data;
      assert(data.length === chart.labels.length, 'Expected one value per point');
      const peak = Math.max(...data);
      assert(data[chart.labels.indexOf('Year 18')] === peak, 'Expected the fund to peak when the cost starts');
    }
  },
  {
    name: 'Household cash flow shows the selected case, with its own figures and its own bars',
    module: baseModule('cash-1', 'Household cash flow', {
      summaryHtml: '<p>What is left each year.</p>',
      householdCashFlowInputs,
      // A calculated module's stored tables are never trusted.
      outputs: { columns: ['Metric', 'Value'], rows: [['MODEL-SUPPLIED', 999999999]] },
      charts: []
    }),
    activeScenario: { householdCashFlowScenarioId: 'pension' },
    verify(manifest) {
      assert(manifest.source.moduleKind === 'household-cash-flow', 'Expected household cash flow module kind');
      assert(manifest.source.calculationStatus === 'resolved', 'Expected household cash flow projection to resolve');
      assert(manifest.source.activeScenario.id === 'pension', 'Expected the selected household cash flow case');
      assert(manifest.story.charts.length > 0, 'Expected the cash flow chart');
      const labels = manifest.story.metrics.map((metric) => metric.label).join(' | ');
      assert(!labels.includes('MODEL-SUPPLIED'), 'Expected model-supplied outputs to be replaced');
      assert(/Left over/.test(labels) && /Goes out/.test(labels), `Expected the case's figures (${labels})`);
      const left = manifest.story.metrics.find((metric) => /Left over/.test(metric.label));
      const today = manifest.story.metrics.find((metric) => /income before tax/i.test(metric.label));
      assert(today.rawValue === 150000, `Expected income of 150,000 (got ${today.rawValue})`);
      assert(left.rawValue > 0 && left.rawValue < 9200, `Expected the pension case to leave less than today (got ${left.rawValue})`);
    }
  },
  {
    name: 'Protection gap shows the selected case, with its own figures, its own answer and its own bars',
    module: baseModule('gap-1', 'Protection gap', {
      summaryHtml: '<p>MODEL-SUPPLIED summary.</p>',
      protectionGapInputs,
      // A calculated module's stored tables are never trusted.
      outputs: { columns: ['Metric', 'Value'], rows: [['MODEL-SUPPLIED', 999999999]] },
      charts: []
    }),
    activeScenario: { protectionGapScenarioId: 'niamh-cannot-work' },
    verify(manifest) {
      assert(manifest.source.moduleKind === 'protection-gap', 'Expected protection gap module kind');
      assert(manifest.source.calculationStatus === 'resolved', 'Expected protection gap projection to resolve');
      assert(manifest.source.activeScenario.id === 'niamh-cannot-work', 'Expected the selected protection gap case');
      assert(manifest.story.charts.length > 0, 'Expected the protection gap chart');
      const labels = manifest.story.metrics.map((metric) => metric.label).join(' | ');
      assert(!labels.includes('MODEL-SUPPLIED'), 'Expected model-supplied outputs to be replaced');
      assert(/What comes in/.test(labels) && /What you need/.test(labels) && /Gap/.test(labels), `Expected the case's figures (${labels})`);
      const comesIn = manifest.story.metrics.find((metric) => /What comes in/.test(metric.label));
      const gap = manifest.story.metrics.find((metric) => /Gap/.test(metric.label));
      assert(comesIn.rawValue === 58000, `Expected 58,000 to come in (got ${comesIn.rawValue})`);
      assert(gap.rawValue === 38000, `Expected a gap of 38,000 (got ${gap.rawValue})`);
      const text = JSON.stringify(manifest.story);
      assert(!text.includes('MODEL-SUPPLIED'), 'Expected the model-supplied summary to be replaced');
      assert(/You are €38,000 a year short/.test(text), 'Expected the engine\'s answer in the story');
      assert(!/\bcover\b|premium/i.test(text), 'The story must never mention cover or a premium');
    }
  },
  {
    name: 'Protection gap with a case that does not exist falls back to the base case',
    module: baseModule('gap-2', 'Protection gap', { protectionGapInputs, charts: [] }),
    activeScenario: { protectionGapScenarioId: 'no-such-case' },
    verify(manifest) {
      assert(manifest.source.activeScenario.id === 'today', 'Expected the base case');
      const left = manifest.story.metrics.find((metric) => /Left over/.test(metric.label));
      assert(left && left.rawValue === 6000, `Expected 6,000 left over today (got ${left && left.rawValue})`);
    }
  },
  {
    name: 'Rental keep or sell shows the selected case, with three figures that add up and its own sentence',
    module: baseModule('rental-1', 'Rental keep or sell', {
      summaryHtml: '<p>MODEL-SUPPLIED summary.</p>',
      rentalKeepOrSellInputs,
      // A calculated module's stored tables are never trusted.
      outputs: { columns: ['Metric', 'Value'], rows: [['MODEL-SUPPLIED', 999999999]] },
      charts: []
    }),
    activeScenario: { rentalKeepOrSellScenarioId: 'sell' },
    verify(manifest) {
      assert(manifest.source.moduleKind === 'rental-keep-or-sell', 'Expected rental keep or sell module kind');
      assert(manifest.source.calculationStatus === 'resolved', 'Expected rental keep or sell projection to resolve');
      assert(manifest.source.activeScenario.id === 'sell', 'Expected the selected rental case');
      assert(manifest.story.charts.length > 0, 'Expected the rental chart');
      const labels = manifest.story.metrics.map((metric) => metric.label).join(' | ');
      assert(!labels.includes('MODEL-SUPPLIED'), 'Expected model-supplied outputs to be replaced');
      assert(/Selling costs, the loan and tax/.test(labels), `Expected what comes off, named (${labels})`);
      const price = manifest.story.metrics.find((metric) => /^Sale price/.test(metric.label));
      const comesOff = manifest.story.metrics.find((metric) => /Selling costs, the loan and tax/.test(metric.label));
      const inHand = manifest.story.metrics.find((metric) => /^In hand/.test(metric.label));
      assert(price.rawValue === 320000, `Expected a sale price of 320,000 (got ${price.rawValue})`);
      assert(comesOff.rawValue === 207000, `Expected 207,000 to come off (got ${comesOff.rawValue})`);
      assert(inHand.rawValue === 113000, `Expected 113,000 in hand (got ${inHand.rawValue})`);
      assert(price.rawValue - comesOff.rawValue === inHand.rawValue, 'The three figures must add up');
      const text = JSON.stringify(manifest.story);
      assert(!text.includes('MODEL-SUPPLIED'), 'Expected the model-supplied summary to be replaced');
      assert(/is what you would have in hand/.test(text), 'Expected the module\'s own sentence in the story');
      assert(!/\bwe\b|\bour\b/i.test(text), 'The story must speak to "you"');
    }
  },
  {
    name: 'Rental keep or sell opens on Keep, with a shortfall as a negative figure that still adds up',
    module: baseModule('rental-2', 'Rental keep or sell', { rentalKeepOrSellInputs, charts: [] }),
    activeScenario: { rentalKeepOrSellScenarioId: 'no-such-case' },
    verify(manifest) {
      assert(manifest.source.activeScenario.id === 'keep', 'Expected the base case');
      const rent = manifest.story.metrics.find((metric) => /^Rent/.test(metric.label));
      const comesOff = manifest.story.metrics.find((metric) => /Loan repayments, running costs and tax/.test(metric.label));
      const net = manifest.story.metrics.find((metric) => /^Net each year/.test(metric.label));
      assert(rent && comesOff && net, 'Expected rent, what comes off and the net each year');
      assert(comesOff.rawValue === 19200, `Expected 19,200 to come off (got ${comesOff.rawValue})`);
      assert(net.rawValue === -1200, `Expected a net of minus 1,200 (got ${net.rawValue})`);
      assert(rent.rawValue - comesOff.rawValue === net.rawValue, 'The three figures must add up');
    }
  },
  {
    name: 'Education and report preserve structured story data',
    module: baseModule('education-1', 'Help to Buy', {
      summaryHtml: '<p>Understand eligibility before starting an application.</p>',
      education: {
        topic: 'Help to Buy',
        metrics: [{ label: 'Maximum relief', value: '€30,000' }],
        steps: [{ id: 'check', kicker: 'First', title: 'Check eligibility', bodyHtml: '<p>Confirm the buyer and property criteria.</p>' }],
        sections: []
      },
      charts: []
    }),
    verify(manifest) {
      assert(manifest.source.moduleKind === 'education', 'Expected education module kind');
      assert(manifest.story.metrics[0]?.value === '€30,000', 'Expected education metric');
      assert(manifest.story.flowNodes[0]?.title === 'Check eligibility', 'Expected education step');
    }
  },
  {
    name: 'Report preserves structured metric blocks',
    module: baseModule('report-1', 'Planning report', {
      summaryHtml: '<p>Focus on the next decision.</p>',
      report: {
        title: 'Planning report',
        blocks: [{ type: 'insightGrid', items: [{ label: 'Priority', value: 'Protect liquidity' }] }]
      },
      charts: []
    }),
    verify(manifest) {
      assert(manifest.source.moduleKind === 'report', 'Expected report module kind');
      assert(manifest.story.metrics[0]?.value === 'Protect liquidity', 'Expected report metric');
    }
  }
];

let passed = 0;
for (const testCase of cases) {
  const manifest = buildVideoSceneManifest({
    session,
    module: testCase.module,
    activeScenario: testCase.activeScenario
  });
  assert(manifest.version === VIDEO_SCENE_MANIFEST_VERSION, `${testCase.name}: manifest version mismatch`);
  assert(manifest.reviewRequired === true, `${testCase.name}: review gate missing`);
  assert(manifest.capture.presenterSafeZone === 'right', `${testCase.name}: presenter zone mismatch`);
  assert(manifest.review.visibleMetrics.length === manifest.story.metrics.length, `${testCase.name}: review metrics must match scene metrics`);
  testCase.verify(manifest);
  passed += 1;
  console.info(`[VideoSceneTests] PASS: ${testCase.name}`);
}

console.info(`[VideoSceneTests] ${passed}/${cases.length} manifest cases passed.`);
