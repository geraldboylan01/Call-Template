const DEFAULT_CURRENT_YEAR = new Date().getFullYear();
const DEFAULT_INFLATION_RATE = 0.02;
const DEFAULT_CHILDREN_COUNT = 1;
const DEFAULT_CHILD_CURRENT_AGE = 13;
const DEFAULT_COLLEGE_START_AGE = 18;
const DEFAULT_COLLEGE_DURATION_YEARS = 4;

const EURO_FORMATTER = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireFiniteNumber(value, fieldName) {
  if (!isFiniteNumber(value)) {
    throw new Error(`generated.collegeFundingInputs.${fieldName} must be a finite number.`);
  }
  return value;
}

function optionalFiniteNumber(value, fallback, fieldName) {
  if (typeof value === 'undefined') {
    return fallback;
  }
  if (!isFiniteNumber(value)) {
    throw new Error(`generated.collegeFundingInputs.${fieldName} must be a finite number when provided.`);
  }
  return value;
}

function requireNonNegativeNumber(value, fieldName) {
  const normalized = requireFiniteNumber(value, fieldName);
  if (normalized < 0) {
    throw new Error(`generated.collegeFundingInputs.${fieldName} must be greater than or equal to 0.`);
  }
  return normalized;
}

function optionalNonNegativeNumber(value, fallback, fieldName) {
  const normalized = optionalFiniteNumber(value, fallback, fieldName);
  if (normalized < 0) {
    throw new Error(`generated.collegeFundingInputs.${fieldName} must be greater than or equal to 0.`);
  }
  return normalized;
}

function requirePositiveInteger(value, fieldName) {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`generated.collegeFundingInputs.${fieldName} must be a positive integer.`);
  }
  return value;
}

function optionalInteger(value, fallback, fieldName) {
  if (typeof value === 'undefined') {
    return fallback;
  }
  if (!isFiniteNumber(value) || !Number.isInteger(value)) {
    throw new Error(`generated.collegeFundingInputs.${fieldName} must be an integer when provided.`);
  }
  return value;
}

function toPercentText(decimal, digits = 1) {
  return `${(decimal * 100).toFixed(digits)}%`;
}

function toEuroText(amount) {
  return EURO_FORMATTER.format(Number.isFinite(amount) ? amount : 0);
}

function normalizeId(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw || fallback;
}

function firstDefinedNumber(source, keys) {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  for (const key of keys) {
    if (typeof source[key] !== 'undefined') {
      return source[key];
    }
  }

  return undefined;
}

function normalizeScenario(rawScenario, index, shared) {
  if (!rawScenario || typeof rawScenario !== 'object' || Array.isArray(rawScenario)) {
    throw new Error(`generated.collegeFundingInputs.scenarios[${index}] must be an object.`);
  }

  const annualCostTodayPerChild = firstDefinedNumber(rawScenario, [
    'annualCostTodayPerChild',
    'annualCostPerChildToday',
    'annualCostToday',
    'annualCost'
  ]);
  const oneOffCostTodayPerChild = firstDefinedNumber(rawScenario, [
    'oneOffCostTodayPerChild',
    'upfrontCostTodayPerChild',
    'carSupportTodayPerChild',
    'carSupportToday',
    'oneOffCostToday'
  ]);
  const category = typeof rawScenario.category === 'string' && rawScenario.category.trim()
    ? rawScenario.category.trim()
    : '';

  const normalized = {
    id: normalizeId(rawScenario.id, `college-scenario-${index + 1}`),
    title: typeof rawScenario.title === 'string' && rawScenario.title.trim()
      ? rawScenario.title.trim()
      : `Scenario ${index + 1}`,
    category,
    annualCostTodayPerChild: optionalNonNegativeNumber(
      annualCostTodayPerChild,
      0,
      `scenarios[${index}].annualCostTodayPerChild`
    ),
    oneOffCostTodayPerChild: optionalNonNegativeNumber(
      oneOffCostTodayPerChild,
      0,
      `scenarios[${index}].oneOffCostTodayPerChild`
    ),
    interpretation: typeof rawScenario.interpretation === 'string' && rawScenario.interpretation.trim()
      ? rawScenario.interpretation.trim()
      : (typeof rawScenario.detail === 'string' && rawScenario.detail.trim()
        ? rawScenario.detail.trim()
        : ''),
    tone: typeof rawScenario.tone === 'string' ? rawScenario.tone.trim().toLowerCase() : ''
  };

  if (normalized.annualCostTodayPerChild === 0 && normalized.oneOffCostTodayPerChild === 0) {
    throw new Error(`generated.collegeFundingInputs.scenarios[${index}] must include an annual or one-off cost.`);
  }

  if (!normalized.category) {
    normalized.category = normalized.title
      .replace(/\b(with|without|no)\b.*$/i, '')
      .replace(/[,/-]\s*$/g, '')
      .trim();
  }

  if (!normalized.interpretation) {
    normalized.interpretation = `Planning target based on ${shared.childrenCount} ${shared.childrenCount === 1 ? 'child' : 'children'} and ${shared.collegeDurationYears} college years.`;
  }

  return normalized;
}

function buildDefaultScenarios(raw) {
  const scenarios = [];
  const atHomeAnnual = firstDefinedNumber(raw, ['atHomeAnnualCostTodayPerChild', 'atHomeAnnualCostToday']);
  const awayAnnual = firstDefinedNumber(raw, ['awayAnnualCostTodayPerChild', 'awayAnnualCostToday']);
  const carSupport = firstDefinedNumber(raw, ['carSupportTodayPerChild', 'carSupportToday']);

  if (isFiniteNumber(atHomeAnnual)) {
    scenarios.push({
      id: 'at-home-no-car',
      title: 'At home, no car support',
      category: 'At home',
      annualCostTodayPerChild: atHomeAnnual,
      oneOffCostTodayPerChild: 0,
      interpretation: 'Lower funding target if children live at home during college.'
    });
    if (isFiniteNumber(carSupport) && carSupport > 0) {
      scenarios.push({
        id: 'at-home-with-car',
        title: 'At home, with car support',
        category: 'At home',
        annualCostTodayPerChild: atHomeAnnual,
        oneOffCostTodayPerChild: carSupport,
        interpretation: 'Adds one-off car support to the at-home college scenario.'
      });
    }
  }

  if (isFiniteNumber(awayAnnual)) {
    scenarios.push({
      id: 'away-no-car',
      title: 'Away from home, no car support',
      category: 'Away from home',
      annualCostTodayPerChild: awayAnnual,
      oneOffCostTodayPerChild: 0,
      interpretation: 'Higher funding target reflecting accommodation and wider living costs.'
    });
    if (isFiniteNumber(carSupport) && carSupport > 0) {
      scenarios.push({
        id: 'away-with-car',
        title: 'Away from home, with car support',
        category: 'Away from home',
        annualCostTodayPerChild: awayAnnual,
        oneOffCostTodayPerChild: carSupport,
        interpretation: 'Stress-test scenario including away-from-home college costs and car support.',
        tone: 'warning'
      });
    }
  }

  return scenarios;
}

export function normalizeCollegeFundingInputs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('generated.collegeFundingInputs must be an object.');
  }

  const currentYear = optionalInteger(raw.currentYear, DEFAULT_CURRENT_YEAR, 'currentYear');
  const inflationRate = optionalFiniteNumber(raw.inflationRate, DEFAULT_INFLATION_RATE, 'inflationRate');
  if (inflationRate <= -1) {
    throw new Error('generated.collegeFundingInputs.inflationRate must be greater than -1.');
  }

  const childrenCount = requirePositiveInteger(
    firstDefinedNumber(raw, ['childrenCount', 'numberOfChildren']) ?? DEFAULT_CHILDREN_COUNT,
    'childrenCount'
  );
  const childCurrentAge = optionalInteger(
    firstDefinedNumber(raw, ['childCurrentAge', 'childrenCurrentAge', 'currentAge']),
    DEFAULT_CHILD_CURRENT_AGE,
    'childCurrentAge'
  );
  const collegeStartAge = optionalInteger(
    firstDefinedNumber(raw, ['collegeStartAge', 'startAge']),
    DEFAULT_COLLEGE_START_AGE,
    'collegeStartAge'
  );
  const collegeDurationYears = requirePositiveInteger(
    firstDefinedNumber(raw, ['collegeDurationYears', 'durationYears']) ?? DEFAULT_COLLEGE_DURATION_YEARS,
    'collegeDurationYears'
  );

  if (collegeStartAge < childCurrentAge) {
    throw new Error('generated.collegeFundingInputs.collegeStartAge must be greater than or equal to childCurrentAge.');
  }

  const shared = {
    currentYear,
    inflationRate,
    childrenCount,
    childCurrentAge,
    collegeStartAge,
    collegeDurationYears
  };
  const rawScenarios = Array.isArray(raw.scenarios) && raw.scenarios.length > 0
    ? raw.scenarios
    : buildDefaultScenarios(raw);

  if (!Array.isArray(rawScenarios) || rawScenarios.length === 0) {
    throw new Error('generated.collegeFundingInputs.scenarios must include at least one scenario.');
  }

  const usedIds = new Set();
  const scenarios = rawScenarios.map((scenario, index) => {
    const normalized = normalizeScenario(scenario, index, shared);
    if (usedIds.has(normalized.id)) {
      throw new Error(`generated.collegeFundingInputs.scenarios[${index}].id must be unique.`);
    }
    usedIds.add(normalized.id);
    return normalized;
  });

  return {
    ...shared,
    currencySymbol: typeof raw.currencySymbol === 'string' && raw.currencySymbol.trim()
      ? raw.currencySymbol.trim()
      : '€',
    planningNote: typeof raw.planningNote === 'string' ? raw.planningNote.trim() : '',
    scenarios
  };
}

function inflationFactor(inputs, yearOffset) {
  return Math.pow(1 + inputs.inflationRate, yearOffset);
}

function computeScenario(inputs, scenario) {
  const yearsUntilCollege = inputs.collegeStartAge - inputs.childCurrentAge;
  const annualTodayTotal = scenario.annualCostTodayPerChild * inputs.childrenCount;
  const oneOffTodayTotal = scenario.oneOffCostTodayPerChild * inputs.childrenCount;
  const annualTodaySeries = [];
  const oneOffTodaySeries = [];
  const annualNominalSeries = [];
  const oneOffNominalSeries = [];
  const years = [];
  const labels = [];

  for (let index = 0; index < inputs.collegeDurationYears; index += 1) {
    const yearOffset = yearsUntilCollege + index;
    const year = inputs.currentYear + yearOffset;
    const oneOffToday = index === 0 ? oneOffTodayTotal : 0;
    const oneOffNominal = index === 0 ? oneOffTodayTotal * inflationFactor(inputs, yearOffset) : 0;

    years.push(year);
    labels.push(`${year}`);
    annualTodaySeries.push(annualTodayTotal);
    oneOffTodaySeries.push(oneOffToday);
    annualNominalSeries.push(annualTodayTotal * inflationFactor(inputs, yearOffset));
    oneOffNominalSeries.push(oneOffNominal);
  }

  const costToday = (annualTodayTotal * inputs.collegeDurationYears) + oneOffTodayTotal;
  const nominalCost = annualNominalSeries.reduce((total, value) => total + value, 0)
    + oneOffNominalSeries.reduce((total, value) => total + value, 0);

  return {
    ...scenario,
    years,
    labels,
    annualTodayTotal,
    oneOffTodayTotal,
    annualTodaySeries,
    oneOffTodaySeries,
    annualNominalSeries,
    oneOffNominalSeries,
    costToday,
    nominalCost,
    inflationImpact: nominalCost - costToday
  };
}

function pickStressScenario(scenarios) {
  const toneStress = scenarios.find((scenario) => scenario.tone === 'warning' || scenario.tone === 'risk');
  if (toneStress) {
    return toneStress;
  }

  return scenarios.reduce((largest, scenario) => (
    scenario.costToday > largest.costToday ? scenario : largest
  ), scenarios[0]);
}

function buildCarSupportChart(scenarios) {
  const groups = new Map();
  scenarios.forEach((scenario) => {
    const key = scenario.category || `Annual cost ${scenario.annualCostTodayPerChild}`;
    const group = groups.get(key) || {
      label: key,
      without: null,
      with: null
    };

    if (scenario.oneOffCostTodayPerChild > 0) {
      if (!group.with || scenario.costToday > group.with.costToday) {
        group.with = scenario;
      }
    } else if (!group.without || scenario.costToday > group.without.costToday) {
      group.without = scenario;
    }

    groups.set(key, group);
  });

  const paired = [...groups.values()].filter((group) => group.with && group.without);
  if (paired.length === 0) {
    return null;
  }

  return {
    title: 'Impact of One-Off Support',
    subtitle: 'Shows the additional funding requirement from car or other one-off support.',
    type: 'bar',
    labels: paired.map((group) => group.label),
    datasets: [
      {
        label: 'Without one-off support',
        data: paired.map((group) => group.without.costToday)
      },
      {
        label: 'With one-off support',
        data: paired.map((group) => group.with.costToday)
      }
    ],
    display: {
      valueFormat: 'currency',
      yAxisTitle: 'Cost in today’s terms'
    },
    insights: [
      {
        label: 'One-off add-on',
        detail: 'This can be treated as a separate reserve from core annual college costs.'
      }
    ]
  };
}

function buildCharts(inputs, scenarios, stressScenario) {
  const charts = [
    {
      title: 'College Funding Scenarios',
      subtitle: 'Compares the estimated cost of each scenario in today’s terms and future nominal terms.',
      type: 'bar',
      labels: scenarios.map((scenario) => scenario.title),
      datasets: [
        {
          label: 'Today’s terms',
          data: scenarios.map((scenario) => scenario.costToday)
        },
        {
          label: 'Future nominal cost',
          data: scenarios.map((scenario) => scenario.nominalCost)
        }
      ],
      display: {
        variant: 'wide',
        valueFormat: 'currency',
        yAxisTitle: 'Total funding target'
      },
      insights: [
        {
          label: 'Lowest target',
          value: toEuroText(Math.min(...scenarios.map((scenario) => scenario.costToday))),
          detail: 'Lower-cost scenarios can be used as the minimum ring-fence target.'
        },
        {
          label: 'Stress-test target',
          value: toEuroText(stressScenario.costToday),
          detail: `${stressScenario.title} is the highest today’s-money scenario in this projection.`
        }
      ]
    },
    {
      title: `Funding Timeline - ${stressScenario.title}`,
      subtitle: 'Nominal annual cashflow for the highest-cost scenario, including any one-off support in the first year.',
      type: 'bar',
      labels: stressScenario.labels,
      datasets: [
        {
          label: 'Annual college costs',
          data: stressScenario.annualNominalSeries
        },
        {
          label: 'One-off support',
          data: stressScenario.oneOffNominalSeries
        }
      ],
      display: {
        stacked: true,
        valueFormat: 'currency',
        xAxisTitle: 'College year',
        yAxisTitle: 'Nominal cashflow'
      },
      insights: [
        {
          label: 'Timing window',
          detail: `Costs begin in ${inputs.currentYear + (inputs.collegeStartAge - inputs.childCurrentAge)} and run for ${inputs.collegeDurationYears} years.`
        }
      ]
    }
  ];

  const supportChart = buildCarSupportChart(scenarios);
  if (supportChart) {
    charts.push(supportChart);
  }

  return charts;
}

export function computeCollegeFundingProjection(rawInputs) {
  const inputs = normalizeCollegeFundingInputs(rawInputs);
  const yearsUntilCollege = inputs.collegeStartAge - inputs.childCurrentAge;
  const scenarios = inputs.scenarios.map((scenario) => computeScenario(inputs, scenario));
  const stressScenario = pickStressScenario(scenarios);
  const lowScenario = scenarios.reduce((lowest, scenario) => (
    scenario.costToday < lowest.costToday ? scenario : lowest
  ), scenarios[0]);
  const highScenario = scenarios.reduce((highest, scenario) => (
    scenario.costToday > highest.costToday ? scenario : highest
  ), scenarios[0]);

  const assumptionsTable = {
    columns: ['Assumption', 'Input Used'],
    rows: [
      ['Number of children', String(inputs.childrenCount)],
      ['Children’s current age', String(inputs.childCurrentAge)],
      ['Assumed college start age', String(inputs.collegeStartAge)],
      ['Years until college starts', String(yearsUntilCollege)],
      ['Assumed college duration', `${inputs.collegeDurationYears} years`],
      ['Inflation assumption', `${toPercentText(inputs.inflationRate)} per annum`],
      ...inputs.scenarios.flatMap((scenario) => ([
        [`${scenario.title} annual cost`, `${toEuroText(scenario.annualCostTodayPerChild)} per child per year in today’s terms`],
        ...(scenario.oneOffCostTodayPerChild > 0
          ? [[`${scenario.title} one-off support`, `${toEuroText(scenario.oneOffCostTodayPerChild)} per child in today’s terms`]]
          : [])
      ])),
      ...(inputs.planningNote ? [['Planning note', inputs.planningNote]] : [])
    ]
  };

  const outputsTable = {
    columns: [
      'Scenario',
      'Cost in Today’s Terms (€)',
      'Estimated Future Nominal Cost (€)',
      'Inflation Impact (€)',
      'Planning Interpretation'
    ],
    rows: scenarios.map((scenario) => [
      scenario.title,
      Math.round(scenario.costToday),
      Math.round(scenario.nominalCost),
      Math.round(scenario.inflationImpact),
      scenario.interpretation
    ])
  };

  const charts = buildCharts(inputs, scenarios, stressScenario);

  return {
    assumptionsTable,
    outputsTable,
    charts,
    debug: {
      inputs,
      scenarios,
      yearsUntilCollege,
      collegeStartYear: inputs.currentYear + yearsUntilCollege,
      collegeEndYear: inputs.currentYear + yearsUntilCollege + inputs.collegeDurationYears - 1,
      lowScenario,
      highScenario,
      stressScenario,
      todayRange: {
        low: lowScenario.costToday,
        high: highScenario.costToday
      },
      nominalRange: {
        low: Math.min(...scenarios.map((scenario) => scenario.nominalCost)),
        high: Math.max(...scenarios.map((scenario) => scenario.nominalCost))
      }
    }
  };
}
