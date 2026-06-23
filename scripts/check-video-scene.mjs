import { buildVideoSceneManifest, VIDEO_SCENE_MANIFEST_VERSION } from '../js/video_scene.js';

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

const cases = [
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
