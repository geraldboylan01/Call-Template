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

function requireNonNegativeInteger(value, fieldName) {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`generated.collegeFundingInputs.${fieldName} must be an integer greater than or equal to 0.`);
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

function optionalNonNegativeInteger(value, fallback, fieldName) {
  if (typeof value === 'undefined') {
    return fallback;
  }
  return requireNonNegativeInteger(value, fieldName);
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

function allChildrenShare(children, fieldName) {
  if (!Array.isArray(children) || children.length === 0) {
    return false;
  }
  return children.every((child) => child[fieldName] === children[0][fieldName]);
}

function sharedChildValue(children, fieldName) {
  return allChildrenShare(children, fieldName) ? children[0][fieldName] : undefined;
}

function normalizeChild(rawChild, index) {
  if (!rawChild || typeof rawChild !== 'object' || Array.isArray(rawChild)) {
    throw new Error(`generated.collegeFundingInputs.children[${index}] must be an object.`);
  }

  const child = {
    id: normalizeId(rawChild.id, `child-${index + 1}`),
    title: typeof rawChild.title === 'string' && rawChild.title.trim()
      ? rawChild.title.trim()
      : `Child ${index + 1}`,
    currentAge: requireNonNegativeInteger(rawChild.currentAge, `children[${index}].currentAge`),
    collegeStartAge: requireNonNegativeInteger(rawChild.collegeStartAge, `children[${index}].collegeStartAge`),
    collegeDurationYears: requirePositiveInteger(
      rawChild.collegeDurationYears,
      `children[${index}].collegeDurationYears`
    )
  };

  if (child.collegeStartAge <= child.currentAge) {
    throw new Error(`generated.collegeFundingInputs.children[${index}].collegeStartAge must be greater than currentAge.`);
  }

  return child;
}

function normalizeChildren(raw) {
  // AN EMPTY LIST IS AN ANSWER, NOT A MISSING QUESTION.
  //
  // `children` being absent means the caller is using the older
  // `childrenCount`/`childCurrentAge` shape, and falling through to that legacy
  // path is correct. `children: []` says something different -- there are no
  // children -- and it used to fall through to the very same path, which then
  // invented one child aged thirteen and produced a 20,000 college plan for a
  // dependant nobody had. A household with no children is not a household with
  // a default child.
  if (Array.isArray(raw.children) && raw.children.length === 0) {
    throw new Error('generated.collegeFundingInputs.children must name at least one child when provided.');
  }
  if (!Array.isArray(raw.children)) {
    return null;
  }

  const usedIds = new Set();
  const children = raw.children.map((rawChild, index) => {
    const child = normalizeChild(rawChild, index);
    if (usedIds.has(child.id)) {
      throw new Error(`generated.collegeFundingInputs.children[${index}].id must be unique.`);
    }
    usedIds.add(child.id);
    return child;
  });

  return children.length > 0 ? children : null;
}

function buildLegacyChildren(childrenCount, childCurrentAge, collegeStartAge, collegeDurationYears) {
  return Array.from({ length: childrenCount }, (_value, index) => ({
    id: childrenCount === 1 ? 'child' : `child-${index + 1}`,
    title: childrenCount === 1 ? 'Child' : `Child ${index + 1}`,
    currentAge: childCurrentAge,
    collegeStartAge,
    collegeDurationYears
  }));
}

function attachChildTiming(children, currentYear) {
  return children.map((child) => {
    const yearsUntilCollege = child.collegeStartAge - child.currentAge;
    const firstCollegeYear = currentYear + yearsUntilCollege;
    return {
      ...child,
      yearsUntilCollege,
      firstCollegeYear,
      finalCollegeYear: firstCollegeYear + child.collegeDurationYears - 1
    };
  });
}

function buildFundingYears(firstCollegeYear, finalCollegeYear) {
  const years = [];
  for (let year = firstCollegeYear; year <= finalCollegeYear; year += 1) {
    years.push(year);
  }
  return years;
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
    const durationText = Number.isFinite(shared.collegeDurationYears)
      ? `${shared.collegeDurationYears} college years`
      : `${shared.fundingPeriodYears} family funding years`;
    normalized.interpretation = `Planning target based on ${shared.childrenCount} ${shared.childrenCount === 1 ? 'child' : 'children'} and ${durationText}.`;
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
  const inflationRate = optionalNonNegativeNumber(raw.inflationRate, DEFAULT_INFLATION_RATE, 'inflationRate');
  const normalizedChildren = normalizeChildren(raw);

  let timingMode = 'legacy-shared-age';
  let children;
  let childrenCount;
  let childCurrentAge;
  let collegeStartAge;
  let collegeDurationYears;

  if (normalizedChildren) {
    timingMode = 'child-level';
    children = attachChildTiming(normalizedChildren, currentYear);
    childrenCount = children.length;
    childCurrentAge = sharedChildValue(children, 'currentAge');
    collegeStartAge = sharedChildValue(children, 'collegeStartAge');
    collegeDurationYears = sharedChildValue(children, 'collegeDurationYears');
  } else {
    childrenCount = requirePositiveInteger(
      firstDefinedNumber(raw, ['childrenCount', 'numberOfChildren']) ?? DEFAULT_CHILDREN_COUNT,
      'childrenCount'
    );
    childCurrentAge = optionalNonNegativeInteger(
      firstDefinedNumber(raw, ['childCurrentAge', 'childrenCurrentAge', 'currentAge']),
      DEFAULT_CHILD_CURRENT_AGE,
      'childCurrentAge'
    );
    collegeStartAge = optionalNonNegativeInteger(
      firstDefinedNumber(raw, ['collegeStartAge', 'startAge']),
      DEFAULT_COLLEGE_START_AGE,
      'collegeStartAge'
    );
    collegeDurationYears = requirePositiveInteger(
      firstDefinedNumber(raw, ['collegeDurationYears', 'durationYears']) ?? DEFAULT_COLLEGE_DURATION_YEARS,
      'collegeDurationYears'
    );

    if (collegeStartAge <= childCurrentAge) {
      throw new Error('generated.collegeFundingInputs.collegeStartAge must be greater than childCurrentAge.');
    }

    children = attachChildTiming(
      buildLegacyChildren(childrenCount, childCurrentAge, collegeStartAge, collegeDurationYears),
      currentYear
    );
  }

  const firstCollegeYear = Math.min(...children.map((child) => child.firstCollegeYear));
  const finalCollegeYear = Math.max(...children.map((child) => child.finalCollegeYear));
  const fundingPeriodYears = finalCollegeYear - firstCollegeYear + 1;
  const fundingYears = buildFundingYears(firstCollegeYear, finalCollegeYear);
  const shared = {
    currentYear,
    inflationRate,
    childrenCount,
    children,
    timingMode,
    firstCollegeYear,
    finalCollegeYear,
    fundingPeriodYears,
    fundingYears
  };

  if (typeof childCurrentAge !== 'undefined') {
    shared.childCurrentAge = childCurrentAge;
  }
  if (typeof collegeStartAge !== 'undefined') {
    shared.collegeStartAge = collegeStartAge;
  }
  if (typeof collegeDurationYears !== 'undefined') {
    shared.collegeDurationYears = collegeDurationYears;
  }

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

function isChildActiveInYear(child, year) {
  return year >= child.firstCollegeYear && year <= child.finalCollegeYear;
}

function computeScenario(inputs, scenario) {
  const years = inputs.fundingYears;
  const labels = years.map((year) => `${year}`);
  const annualTodaySeries = [];
  const oneOffTodaySeries = [];
  const totalTodaySeries = [];
  const annualNominalSeries = [];
  const oneOffNominalSeries = [];
  const totalNominalSeries = [];
  const childrenAttendingSeries = [];
  const childSeries = inputs.children.map((child) => ({
    id: child.id,
    title: child.title,
    data: [],
    annualNominalSeries: [],
    oneOffNominalSeries: [],
    todaySeries: []
  }));

  years.forEach((year) => {
    const yearOffset = year - inputs.currentYear;
    const factor = inflationFactor(inputs, yearOffset);
    let annualToday = 0;
    let oneOffToday = 0;
    let annualNominal = 0;
    let oneOffNominal = 0;
    let childrenAttending = 0;

    inputs.children.forEach((child, childIndex) => {
      const active = isChildActiveInYear(child, year);
      const childAnnualToday = active ? scenario.annualCostTodayPerChild : 0;
      const childOneOffToday = year === child.firstCollegeYear ? scenario.oneOffCostTodayPerChild : 0;
      const childAnnualNominal = childAnnualToday * factor;
      const childOneOffNominal = childOneOffToday * factor;
      const childNominal = childAnnualNominal + childOneOffNominal;

      if (active) {
        childrenAttending += 1;
      }

      annualToday += childAnnualToday;
      oneOffToday += childOneOffToday;
      annualNominal += childAnnualNominal;
      oneOffNominal += childOneOffNominal;
      childSeries[childIndex].data.push(childNominal);
      childSeries[childIndex].annualNominalSeries.push(childAnnualNominal);
      childSeries[childIndex].oneOffNominalSeries.push(childOneOffNominal);
      childSeries[childIndex].todaySeries.push(childAnnualToday + childOneOffToday);
    });

    annualTodaySeries.push(annualToday);
    oneOffTodaySeries.push(oneOffToday);
    totalTodaySeries.push(annualToday + oneOffToday);
    annualNominalSeries.push(annualNominal);
    oneOffNominalSeries.push(oneOffNominal);
    totalNominalSeries.push(annualNominal + oneOffNominal);
    childrenAttendingSeries.push(childrenAttending);
  });

  const costToday = totalTodaySeries.reduce((total, value) => total + value, 0);
  const nominalCost = totalNominalSeries.reduce((total, value) => total + value, 0);
  const peakAnnualCost = Math.max(...totalNominalSeries);
  const peakAnnualTodayCost = Math.max(...totalTodaySeries);
  const peakChildrenAttending = Math.max(...childrenAttendingSeries);

  return {
    ...scenario,
    years,
    labels,
    annualTodayTotal: Math.max(...annualTodaySeries),
    oneOffTodayTotal: oneOffTodaySeries.reduce((total, value) => total + value, 0),
    annualTodaySeries,
    oneOffTodaySeries,
    totalTodaySeries,
    annualNominalSeries,
    oneOffNominalSeries,
    totalNominalSeries,
    childrenAttendingSeries,
    childSeries,
    costToday,
    nominalCost,
    inflationImpact: nominalCost - costToday,
    firstCollegeYear: inputs.firstCollegeYear,
    finalCollegeYear: inputs.finalCollegeYear,
    fundingPeriodYears: inputs.fundingPeriodYears,
    peakAnnualCost,
    peakAnnualTodayCost,
    peakChildrenAttending,
    yearRows: years.map((year, index) => ({
      year,
      label: labels[index],
      children: childSeries.map((child) => ({
        id: child.id,
        title: child.title,
        cost: child.data[index],
        annualCost: child.annualNominalSeries[index],
        oneOffCost: child.oneOffNominalSeries[index],
        todayCost: child.todaySeries[index]
      })),
      childrenAttending: childrenAttendingSeries[index],
      annualFamilyCost: totalNominalSeries[index],
      annualFamilyCostToday: totalTodaySeries[index]
    }))
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

function buildAnnualFundingProfileChart(inputs, scenarios) {
  return {
    title: 'Annual Funding Profile by Child',
    subtitle: 'Stacked nominal annual cashflow by child. Separate scenario stacks show when each child starts, overlaps, and finishes college.',
    type: 'bar',
    labels: inputs.fundingYears.map((year) => `${year}`),
    datasets: scenarios.flatMap((scenario) => scenario.childSeries.map((child) => ({
      label: scenarios.length > 1 ? `${scenario.title} - ${child.title}` : child.title,
      data: child.data,
      stack: scenario.id
    }))),
    display: {
      variant: 'wide',
      stacked: true,
      valueFormat: 'currency',
      xAxisTitle: 'Calendar year',
      yAxisTitle: 'Annual family education cost'
    },
    insights: [
      {
        label: 'Funding period',
        value: `${inputs.firstCollegeYear}-${inputs.finalCollegeYear}`,
        detail: `${inputs.fundingPeriodYears} annual funding ${inputs.fundingPeriodYears === 1 ? 'point' : 'points'} from first start to final finish.`
      },
      {
        label: 'Peak overlap',
        value: String(Math.max(...scenarios.map((scenario) => scenario.peakChildrenAttending))),
        detail: 'Shows the maximum number of children attending college in the same year.'
      }
    ]
  };
}

function buildCharts(inputs, scenarios, stressScenario) {
  const charts = [
    buildAnnualFundingProfileChart(inputs, scenarios),
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
    }
  ];

  const supportChart = buildCarSupportChart(scenarios);
  if (supportChart) {
    charts.push(supportChart);
  }

  return charts;
}

function buildAnnualFundingTables(inputs, scenarios) {
  return scenarios.map((scenario) => ({
    title: `${scenario.title} Annual Funding Profile`,
    columns: [
      'Year',
      ...inputs.children.map((child) => child.title),
      'Children attending',
      'Annual family cost'
    ],
    rows: scenario.yearRows.map((row) => [
      row.year,
      ...row.children.map((child) => (child.cost > 0 ? Math.round(child.cost) : '-')),
      row.childrenAttending,
      Math.round(row.annualFamilyCost)
    ])
  }));
}

export function computeCollegeFundingProjection(rawInputs) {
  const inputs = normalizeCollegeFundingInputs(rawInputs);
  const yearsUntilCollege = Math.min(...inputs.children.map((child) => child.yearsUntilCollege));
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
      ...(inputs.timingMode === 'child-level'
        ? [
          ['Timing model', 'Individual child-level ages, start ages, and durations'],
          ...inputs.children.map((child) => [
            `${child.title} timing`,
            `Age ${child.currentAge}; starts at ${child.collegeStartAge} in ${child.firstCollegeYear}; ${child.collegeDurationYears} college years`
          ])
        ]
        : [
          ['Children’s current age', String(inputs.childCurrentAge)],
          ['Assumed college start age', String(inputs.collegeStartAge)],
          ['Years until college starts', String(yearsUntilCollege)],
          ['Assumed college duration', `${inputs.collegeDurationYears} years`]
        ]),
      ['First college year', String(inputs.firstCollegeYear)],
      ['Final college year', String(inputs.finalCollegeYear)],
      ['Overall family funding period', `${inputs.fundingPeriodYears} years`],
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
      'First College Year',
      'Final College Year',
      'Family Funding Period',
      'Peak Annual Cost (€)',
      'Peak Children Attending',
      'Planning Interpretation'
    ],
    rows: scenarios.map((scenario) => [
      scenario.title,
      Math.round(scenario.costToday),
      Math.round(scenario.nominalCost),
      Math.round(scenario.inflationImpact),
      scenario.firstCollegeYear,
      scenario.finalCollegeYear,
      `${scenario.fundingPeriodYears} years`,
      Math.round(scenario.peakAnnualCost),
      scenario.peakChildrenAttending,
      scenario.interpretation
    ])
  };

  const charts = buildCharts(inputs, scenarios, stressScenario);
  const tables = buildAnnualFundingTables(inputs, scenarios);

  return {
    assumptionsTable,
    outputsTable,
    tables,
    charts,
    debug: {
      inputs,
      scenarios,
      yearsUntilCollege,
      yearsUntilFirstCollege: yearsUntilCollege,
      collegeStartYear: inputs.firstCollegeYear,
      collegeEndYear: inputs.finalCollegeYear,
      fundingPeriodYears: inputs.fundingPeriodYears,
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
      },
      peakAnnualCostRange: {
        low: Math.min(...scenarios.map((scenario) => scenario.peakAnnualCost)),
        high: Math.max(...scenarios.map((scenario) => scenario.peakAnnualCost))
      }
    }
  };
}
