const DEFAULT_CURRENT_YEAR = new Date().getFullYear();
const DEFAULT_CURRENT_AGE = 60;
const DEFAULT_HORIZON_END_AGE = 100;
const DEFAULT_EXPENDITURE_INFLATION_RATE = 0.02;
const DEFAULT_PRESENT_VALUE_RATE = 0.04;
const NET_INCOME_STACK_COLORS = [
  '#74936f',
  '#67899e',
  '#9b8462',
  '#6f8f7a',
  '#88708f',
  '#7f8ea3',
  '#d4a64f',
  '#6aa7c8'
];

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
    throw new Error(`generated.netRetirementInputs.${fieldName} must be a finite number.`);
  }
  return value;
}

function optionalFiniteNumber(value, fallback, fieldName) {
  if (typeof value === 'undefined') {
    return fallback;
  }
  if (!isFiniteNumber(value)) {
    throw new Error(`generated.netRetirementInputs.${fieldName} must be a finite number when provided.`);
  }
  return value;
}

function requireInteger(value, fieldName) {
  if (!isFiniteNumber(value) || !Number.isInteger(value)) {
    throw new Error(`generated.netRetirementInputs.${fieldName} must be an integer.`);
  }
  return value;
}

function optionalInteger(value, fallback, fieldName) {
  if (typeof value === 'undefined') {
    return fallback;
  }
  return requireInteger(value, fieldName);
}

function requireNonNegativeNumber(value, fieldName) {
  const normalized = requireFiniteNumber(value, fieldName);
  if (normalized < 0) {
    throw new Error(`generated.netRetirementInputs.${fieldName} must be greater than or equal to 0.`);
  }
  return normalized;
}

function optionalNonNegativeNumber(value, fallback, fieldName) {
  const normalized = optionalFiniteNumber(value, fallback, fieldName);
  if (normalized < 0) {
    throw new Error(`generated.netRetirementInputs.${fieldName} must be greater than or equal to 0.`);
  }
  return normalized;
}

function firstDefined(source, keys) {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  return keys.find((key) => typeof source[key] !== 'undefined' && source[key] !== null);
}

function firstDefinedValue(source, keys) {
  const key = firstDefined(source, keys);
  return key ? source[key] : undefined;
}

function normalizeId(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw || fallback;
}

function normalizeText(value, fallback = '') {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw || fallback;
}

function toPercentText(decimal, digits = 1) {
  return `${(decimal * 100).toFixed(digits)}%`;
}

function toEuroText(amount) {
  return EURO_FORMATTER.format(Number.isFinite(amount) ? amount : 0);
}

function resolveYearFromAge(raw, inputs, {
  yearKey,
  ageKey,
  fallbackYear,
  fieldName
}) {
  if (typeof raw[yearKey] !== 'undefined' && raw[yearKey] !== null) {
    return requireInteger(raw[yearKey], `${fieldName}.${yearKey}`);
  }
  if (typeof raw[ageKey] !== 'undefined' && raw[ageKey] !== null) {
    return inputs.currentYear + (requireInteger(raw[ageKey], `${fieldName}.${ageKey}`) - inputs.currentAge);
  }
  return fallbackYear;
}

function normalizeIncomeSource(rawSource, index, inputs, prefix = `incomeSources[${index}]`) {
  if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) {
    throw new Error(`generated.netRetirementInputs.${prefix} must be an object.`);
  }

  const startYear = resolveYearFromAge(rawSource, inputs, {
    yearKey: 'startYear',
    ageKey: 'startAge',
    fallbackYear: inputs.currentYear,
    fieldName: prefix
  });
  const endYear = resolveYearFromAge(rawSource, inputs, {
    yearKey: 'endYear',
    ageKey: 'endAge',
    fallbackYear: null,
    fieldName: prefix
  });
  if (endYear !== null && endYear < startYear) {
    throw new Error(`generated.netRetirementInputs.${prefix}.endYear must be after startYear.`);
  }

  const annualAmountToday = firstDefinedValue(rawSource, [
    'annualAmountToday',
    'amountToday',
    'netAnnualAmountToday',
    'annualNetAmountToday'
  ]);

  const inflationIndexed = typeof rawSource.inflationIndexed === 'boolean'
    ? rawSource.inflationIndexed
    : true;
  const inflationRate = optionalFiniteNumber(
    rawSource.inflationRate,
    inputs.expenditureInflationRate,
    `${prefix}.inflationRate`
  );
  if (inflationRate <= -1) {
    throw new Error(`generated.netRetirementInputs.${prefix}.inflationRate must be greater than -1.`);
  }

  return {
    id: normalizeId(rawSource.id, `income-${index + 1}`),
    title: normalizeText(rawSource.title, `Income ${index + 1}`),
    type: normalizeText(rawSource.type, 'income').toLowerCase(),
    annualAmountToday: requireNonNegativeNumber(annualAmountToday, `${prefix}.annualAmountToday`),
    startYear,
    endYear,
    inflationIndexed,
    inflationRate,
    includeInBase: rawSource.includeInBase === false ? false : true
  };
}

function normalizeIncomeSources(rawSources, inputs) {
  if (typeof rawSources === 'undefined') {
    return [];
  }
  if (!Array.isArray(rawSources)) {
    throw new Error('generated.netRetirementInputs.incomeSources must be an array when provided.');
  }

  const usedIds = new Set();
  return rawSources.map((source, index) => {
    const normalized = normalizeIncomeSource(source, index, inputs);
    if (usedIds.has(normalized.id)) {
      throw new Error(`generated.netRetirementInputs.incomeSources[${index}].id must be unique.`);
    }
    usedIds.add(normalized.id);
    return normalized;
  });
}

function normalizeScenarioIncomeOverride(rawOverride, index, inputs, usedSourceIds) {
  if (!rawOverride || typeof rawOverride !== 'object' || Array.isArray(rawOverride)) {
    throw new Error(`generated.netRetirementInputs.scenarios[].incomeSourceOverrides[${index}] must be an object.`);
  }
  const sourceId = normalizeText(rawOverride.sourceId || rawOverride.id);
  if (!sourceId) {
    throw new Error(`generated.netRetirementInputs.scenarios[].incomeSourceOverrides[${index}].sourceId must be provided.`);
  }
  if (!usedSourceIds.has(sourceId)) {
    throw new Error(`generated.netRetirementInputs.scenarios[].incomeSourceOverrides[${index}].sourceId must match an income source id.`);
  }

  const annualAmountKey = firstDefined(rawOverride, [
    'annualAmountToday',
    'amountToday',
    'netAnnualAmountToday',
    'annualNetAmountToday'
  ]);
  const override = { sourceId };

  if (annualAmountKey) {
    override.annualAmountToday = requireNonNegativeNumber(
      rawOverride[annualAmountKey],
      `scenarios[].incomeSourceOverrides[${index}].annualAmountToday`
    );
  }
  if (typeof rawOverride.excluded === 'boolean') {
    override.excluded = rawOverride.excluded;
  }
  if (typeof rawOverride.title === 'string' && rawOverride.title.trim()) {
    override.title = rawOverride.title.trim();
  }
  if (typeof rawOverride.inflationIndexed === 'boolean') {
    override.inflationIndexed = rawOverride.inflationIndexed;
  }
  if (typeof rawOverride.inflationRate !== 'undefined') {
    override.inflationRate = optionalFiniteNumber(
      rawOverride.inflationRate,
      inputs.expenditureInflationRate,
      `scenarios[].incomeSourceOverrides[${index}].inflationRate`
    );
    if (override.inflationRate <= -1) {
      throw new Error(`generated.netRetirementInputs.scenarios[].incomeSourceOverrides[${index}].inflationRate must be greater than -1.`);
    }
  }

  const startYear = resolveYearFromAge(rawOverride, inputs, {
    yearKey: 'startYear',
    ageKey: 'startAge',
    fallbackYear: undefined,
    fieldName: `scenarios[].incomeSourceOverrides[${index}]`
  });
  if (typeof startYear !== 'undefined') {
    override.startYear = startYear;
  }
  const endYear = resolveYearFromAge(rawOverride, inputs, {
    yearKey: 'endYear',
    ageKey: 'endAge',
    fallbackYear: undefined,
    fieldName: `scenarios[].incomeSourceOverrides[${index}]`
  });
  if (typeof endYear !== 'undefined') {
    override.endYear = endYear;
  }

  return override;
}

function normalizeScenario(rawScenario, index, inputs, usedSourceIds) {
  if (!rawScenario || typeof rawScenario !== 'object' || Array.isArray(rawScenario)) {
    throw new Error(`generated.netRetirementInputs.scenarios[${index}] must be an object.`);
  }

  const excludedIncomeSourceIds = Array.isArray(rawScenario.excludedIncomeSourceIds)
    ? rawScenario.excludedIncomeSourceIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  excludedIncomeSourceIds.forEach((id) => {
    if (!usedSourceIds.has(id)) {
      throw new Error(`generated.netRetirementInputs.scenarios[${index}].excludedIncomeSourceIds must match income source ids.`);
    }
  });

  const incomeSourceOverrides = Array.isArray(rawScenario.incomeSourceOverrides)
    ? rawScenario.incomeSourceOverrides.map((override, overrideIndex) => (
      normalizeScenarioIncomeOverride(override, overrideIndex, inputs, usedSourceIds)
    ))
    : [];
  const additionalIncomeSources = Array.isArray(rawScenario.additionalIncomeSources)
    ? rawScenario.additionalIncomeSources.map((source, sourceIndex) => (
      normalizeIncomeSource(source, sourceIndex, inputs, `scenarios[${index}].additionalIncomeSources[${sourceIndex}]`)
    ))
    : [];

  const availableFundKey = firstDefined(rawScenario, [
    'availableInvestmentFundToday',
    'investmentFundToday',
    'availableFundToday'
  ]);
  const expenditureKey = firstDefined(rawScenario, [
    'annualExpenditureToday',
    'netExpenditureToday',
    'annualNetExpenditureToday'
  ]);

  return {
    id: normalizeId(rawScenario.id, `scenario-${index + 1}`),
    title: normalizeText(rawScenario.title, `Scenario ${index + 1}`),
    description: normalizeText(rawScenario.description || rawScenario.interpretation),
    annualExpenditureToday: expenditureKey
      ? requireNonNegativeNumber(rawScenario[expenditureKey], `scenarios[${index}].annualExpenditureToday`)
      : null,
    availableInvestmentFundToday: availableFundKey
      ? optionalNonNegativeNumber(rawScenario[availableFundKey], null, `scenarios[${index}].availableInvestmentFundToday`)
      : null,
    excludedIncomeSourceIds,
    incomeSourceOverrides,
    additionalIncomeSources
  };
}

function normalizeScenarios(rawScenarios, inputs, incomeSources) {
  const usedSourceIds = new Set(incomeSources.map((source) => source.id));
  const sourceScenarios = Array.isArray(rawScenarios) && rawScenarios.length > 0
    ? rawScenarios
    : [{ id: 'base', title: 'Base case' }];

  const usedIds = new Set();
  return sourceScenarios.map((scenario, index) => {
    const normalized = normalizeScenario(scenario, index, inputs, usedSourceIds);
    if (usedIds.has(normalized.id)) {
      throw new Error(`generated.netRetirementInputs.scenarios[${index}].id must be unique.`);
    }
    usedIds.add(normalized.id);
    return normalized;
  });
}

export function normalizeNetRetirementInputs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('generated.netRetirementInputs must be an object.');
  }

  const currentYear = optionalInteger(raw.currentYear, DEFAULT_CURRENT_YEAR, 'currentYear');
  const currentAge = optionalInteger(raw.currentAge, DEFAULT_CURRENT_AGE, 'currentAge');
  const horizonEndAge = optionalInteger(
    firstDefinedValue(raw, ['horizonEndAge', 'endAge', 'projectionEndAge']),
    DEFAULT_HORIZON_END_AGE,
    'horizonEndAge'
  );
  if (horizonEndAge < currentAge) {
    throw new Error('generated.netRetirementInputs.horizonEndAge must be greater than or equal to currentAge.');
  }

  const expenditureInflationRate = optionalFiniteNumber(
    firstDefinedValue(raw, ['expenditureInflationRate', 'inflationRate']),
    DEFAULT_EXPENDITURE_INFLATION_RATE,
    'expenditureInflationRate'
  );
  if (expenditureInflationRate <= -1) {
    throw new Error('generated.netRetirementInputs.expenditureInflationRate must be greater than -1.');
  }

  const presentValueRate = optionalFiniteNumber(
    firstDefinedValue(raw, ['presentValueRate', 'presentValueGrowthRate', 'netGrowthRate', 'discountRate', 'growthRate']),
    DEFAULT_PRESENT_VALUE_RATE,
    'presentValueRate'
  );
  if (presentValueRate <= -1) {
    throw new Error('generated.netRetirementInputs.presentValueRate must be greater than -1.');
  }

  const expenditure = firstDefinedValue(raw, [
    'annualExpenditureToday',
    'netExpenditureToday',
    'annualNetExpenditureToday',
    'targetNetIncomeToday'
  ]);

  const inputs = {
    currentYear,
    currentAge,
    horizonEndAge,
    horizonEndYear: currentYear + (horizonEndAge - currentAge),
    annualExpenditureToday: requireNonNegativeNumber(expenditure, 'annualExpenditureToday'),
    expenditureInflationRate,
    presentValueRate,
    availableInvestmentFundToday: optionalNonNegativeNumber(
      firstDefinedValue(raw, ['availableInvestmentFundToday', 'investmentFundToday', 'availableFundToday']),
      null,
      'availableInvestmentFundToday'
    ),
    currencySymbol: typeof raw.currencySymbol === 'string' && raw.currencySymbol.trim()
      ? raw.currencySymbol.trim()
      : '€',
    planningNote: typeof raw.planningNote === 'string' ? raw.planningNote.trim() : '',
    taxCompatibilityNote: typeof raw.taxCompatibilityNote === 'string' && raw.taxCompatibilityNote.trim()
      ? raw.taxCompatibilityNote.trim()
      : 'This is an after-tax net cash-flow projection. Pension balances and pension withdrawals are usually pre-tax, so they are not directly comparable with the required net investment fund unless tax has been allowed for separately.'
  };

  const incomeSources = normalizeIncomeSources(raw.incomeSources, inputs);
  const scenarios = normalizeScenarios(raw.scenarios, inputs, incomeSources);
  const baseScenarioId = typeof raw.baseScenarioId === 'string' && raw.baseScenarioId.trim()
    && scenarios.some((scenario) => scenario.id === raw.baseScenarioId.trim())
    ? raw.baseScenarioId.trim()
    : scenarios[0].id;

  return {
    ...inputs,
    incomeSources,
    scenarios,
    baseScenarioId
  };
}

function factor(rate, yearOffset) {
  return Math.pow(1 + rate, yearOffset);
}

function amountAtYear(source, currentYear, year) {
  if (year < source.startYear || (source.endYear !== null && year > source.endYear)) {
    return 0;
  }
  if (!source.inflationIndexed) {
    return source.annualAmountToday;
  }
  return source.annualAmountToday * factor(source.inflationRate, year - currentYear);
}

function getScenarioIncomeSources(inputs, scenario) {
  const overrideBySourceId = new Map();
  scenario.incomeSourceOverrides.forEach((override) => {
    overrideBySourceId.set(override.sourceId, override);
  });

  const baseSources = inputs.incomeSources
    .filter((source) => source.includeInBase)
    .map((source) => {
      if (scenario.excludedIncomeSourceIds.includes(source.id)) {
        return {
          ...source,
          annualAmountToday: 0
        };
      }

      const override = overrideBySourceId.get(source.id);
      if (!override) {
        return { ...source };
      }
      if (override.excluded === true) {
        return {
          ...source,
          title: override.title || source.title,
          annualAmountToday: 0
        };
      }
      return {
        ...source,
        ...Object.fromEntries(Object.entries(override).filter(([key]) => key !== 'sourceId' && key !== 'excluded')),
        title: override.title || source.title
      };
    });

  return [...baseSources, ...scenario.additionalIncomeSources];
}

function computeAvailableFundPath({ availableFund, annualRows, presentValueRate }) {
  if (!Number.isFinite(availableFund)) {
    return [];
  }

  const path = [];
  let balance = availableFund;
  annualRows.forEach((row) => {
    const openingBalance = Math.max(balance, 0);
    path.push(openingBalance);

    if (openingBalance <= 0) {
      balance = 0;
      return;
    }

    balance = Math.max((openingBalance - row.netShortfall) * (1 + presentValueRate), 0);
  });
  return path;
}

function computeRequiredFundPathFromAnnualRows(annualRows, presentValueRate) {
  const required = new Array(annualRows.length).fill(0);
  let carry = 0;
  for (let index = annualRows.length - 1; index >= 0; index -= 1) {
    carry = annualRows[index].netShortfall + (carry / (1 + presentValueRate));
    required[index] = carry;
  }
  return required;
}

function computeScenario(inputs, scenario) {
  const annualExpenditureToday = Number.isFinite(scenario.annualExpenditureToday)
    ? scenario.annualExpenditureToday
    : inputs.annualExpenditureToday;
  const availableInvestmentFundToday = Number.isFinite(scenario.availableInvestmentFundToday)
    ? scenario.availableInvestmentFundToday
    : inputs.availableInvestmentFundToday;
  const sources = getScenarioIncomeSources(inputs, scenario);
  const annualRows = [];

  for (let year = inputs.currentYear; year <= inputs.horizonEndYear; year += 1) {
    const yearOffset = year - inputs.currentYear;
    const age = inputs.currentAge + yearOffset;
    const netExpenditure = annualExpenditureToday * factor(inputs.expenditureInflationRate, yearOffset);
    const incomeBreakdown = sources.map((source) => ({
      id: source.id,
      title: source.title,
      amount: amountAtYear(source, inputs.currentYear, year)
    }));
    const netIncome = incomeBreakdown.reduce((total, source) => total + source.amount, 0);
    const rawShortfall = netExpenditure - netIncome;
    const netShortfall = Math.max(rawShortfall, 0);
    const surplus = Math.max(-rawShortfall, 0);
    const presentValueShortfall = netShortfall / factor(inputs.presentValueRate, yearOffset);

    annualRows.push({
      year,
      age,
      netExpenditure,
      netIncome,
      netShortfall,
      surplus,
      presentValueShortfall,
      incomeBreakdown
    });
  }

  const requiredFundToday = annualRows.reduce((total, row) => total + row.presentValueShortfall, 0);
  const requiredFundPath = computeRequiredFundPathFromAnnualRows(annualRows, inputs.presentValueRate);
  const availableFundPath = computeAvailableFundPath({
    availableFund: availableInvestmentFundToday,
    annualRows,
    presentValueRate: inputs.presentValueRate
  });
  const firstYear = annualRows[0] || null;
  const surplusVsRequired = Number.isFinite(availableInvestmentFundToday)
    ? availableInvestmentFundToday - requiredFundToday
    : null;
  const gapVsRequired = Number.isFinite(surplusVsRequired)
    ? Math.max(-surplusVsRequired, 0)
    : null;
  const incomeLostToday = scenario.excludedIncomeSourceIds.reduce((total, id) => {
    const source = inputs.incomeSources.find((candidate) => candidate.id === id);
    return total + (source?.annualAmountToday || 0);
  }, 0) + scenario.incomeSourceOverrides.reduce((total, override) => {
    if (override.excluded === true) {
      const source = inputs.incomeSources.find((candidate) => candidate.id === override.sourceId);
      return total + (source?.annualAmountToday || 0);
    }
    return total;
  }, 0);

  return {
    ...scenario,
    annualExpenditureToday,
    availableInvestmentFundToday,
    incomeSources: sources,
    annualRows,
    labels: annualRows.map((row) => String(row.age)),
    requiredFundPath,
    availableFundPath,
    firstYear,
    requiredFundToday,
    surplusVsRequired,
    gapVsRequired,
    incomeLostToday,
    coverageRatio: Number.isFinite(availableInvestmentFundToday) && requiredFundToday > 0
      ? availableInvestmentFundToday / requiredFundToday
      : null
  };
}

function getScenarioCaseSummary(scenario) {
  const details = [];
  const firstShortfall = scenario.firstYear?.netShortfall;
  if (Number.isFinite(firstShortfall)) {
    details.push(`${toEuroText(firstShortfall)} first-year shortfall`);
  }
  details.push(`${toEuroText(scenario.requiredFundToday)} required net fund today`);
  if (Number.isFinite(scenario.availableInvestmentFundToday)) {
    const surplus = scenario.availableInvestmentFundToday - scenario.requiredFundToday;
    details.push(surplus >= 0
      ? `${toEuroText(surplus)} surplus vs required`
      : `${toEuroText(Math.abs(surplus))} gap vs required`);
  }
  return details.join(' - ');
}

function buildAssumptionsTable(inputs, scenario) {
  return {
    columns: ['Assumption', 'Value'],
    rows: [
      ['Selected scenario', scenario.title],
      ['Current year', String(inputs.currentYear)],
      ['Current age', String(inputs.currentAge)],
      ['Projection end age', String(inputs.horizonEndAge)],
      ['Annual net expenditure today', toEuroText(scenario.annualExpenditureToday)],
      ['Expenditure inflation', `${toPercentText(inputs.expenditureInflationRate)} per annum`],
      ['Present value net growth rate', `${toPercentText(inputs.presentValueRate)} per annum`],
      ['Available investment fund today', Number.isFinite(scenario.availableInvestmentFundToday) ? toEuroText(scenario.availableInvestmentFundToday) : 'Not provided'],
      ...scenario.incomeSources.map((source) => [
        source.title,
        `${toEuroText(source.annualAmountToday)} net p.a. from ${source.startYear}${source.endYear ? ` to ${source.endYear}` : ''}${source.inflationIndexed ? ' (indexed)' : ' (flat nominal)'}`
      ]),
      ['Tax compatibility note', inputs.taxCompatibilityNote],
      ...(inputs.planningNote ? [['Planning note', inputs.planningNote]] : [])
    ]
  };
}

function buildOutputsTable(inputs, scenario) {
  const firstYear = scenario.firstYear || {};
  const rows = [
    ['Scenario', scenario.title],
    ['First-year net expenditure', toEuroText(firstYear.netExpenditure)],
    ['First-year net income', toEuroText(firstYear.netIncome)],
    ['First-year net shortfall', toEuroText(firstYear.netShortfall)],
    ['Required net investment fund today', toEuroText(scenario.requiredFundToday)],
    ['Present value net growth rate used', `${toPercentText(inputs.presentValueRate)} per annum`]
  ];

  if (Number.isFinite(scenario.availableInvestmentFundToday)) {
    rows.push(['Available investment fund today', toEuroText(scenario.availableInvestmentFundToday)]);
    rows.push([
      scenario.surplusVsRequired >= 0 ? 'Surplus vs required fund' : 'Gap vs required fund',
      toEuroText(Math.abs(scenario.surplusVsRequired))
    ]);
  }

  if (scenario.incomeLostToday > 0) {
    rows.push(['Net income removed in this scenario', toEuroText(scenario.incomeLostToday)]);
  }

  rows.push(['Projection period', `${inputs.currentYear} to ${inputs.horizonEndYear}`]);

  return {
    columns: ['Output', 'Value'],
    rows
  };
}

function buildAnnualShortfallTable(scenario) {
  return {
    title: 'Annual Net Shortfall',
    columns: ['Year', 'Age', 'Net Expenditure (€)', 'Net Income (€)', 'Net Shortfall (€)', 'PV of Shortfall (€)'],
    rows: scenario.annualRows.map((row) => [
      String(row.year),
      String(row.age),
      Math.round(row.netExpenditure),
      Math.round(row.netIncome),
      Math.round(row.netShortfall),
      Math.round(row.presentValueShortfall)
    ])
  };
}

function buildIncomeStackDatasets(scenario) {
  return scenario.incomeSources
    .map((source, index) => ({
      label: source.title,
      type: 'bar',
      stack: 'net-income',
      data: scenario.annualRows.map((row) => (
        row.incomeBreakdown.find((entry) => entry.id === source.id)?.amount || 0
      )),
      borderColor: NET_INCOME_STACK_COLORS[index % NET_INCOME_STACK_COLORS.length],
      backgroundColor: NET_INCOME_STACK_COLORS[index % NET_INCOME_STACK_COLORS.length]
    }))
    .filter((dataset) => dataset.data.some((value) => value > 0));
}

function buildCharts(inputs, scenario) {
  const shortfallInsight = {
    label: 'First-year shortfall',
    value: toEuroText(scenario.firstYear?.netShortfall || 0),
    detail: 'Net expenditure less net income in the first modelled year.',
    featured: true
  };
  const requiredFundInsight = {
    label: 'Required net fund today',
    value: toEuroText(scenario.requiredFundToday),
    detail: `Present value of all annual net shortfalls using ${toPercentText(inputs.presentValueRate)} net growth.`
  };

  const fundingPathDatasets = [
    {
      label: 'Required fund balance',
      data: scenario.requiredFundPath
    }
  ];
  if (scenario.availableFundPath.length > 0) {
    fundingPathDatasets.push({
      label: 'Available fund path',
      data: scenario.availableFundPath
    });
  }

  return [
    {
      title: 'Net Income vs Expenditure',
      subtitle: 'Net annual shortfall is implied by the gap between the expenditure line and income bars.',
      type: 'line',
      labels: scenario.labels,
      datasets: [
        ...buildIncomeStackDatasets(scenario),
        {
          label: 'Net expenditure',
          type: 'line',
          borderColor: '#f8fafc',
          backgroundColor: 'rgba(248, 250, 252, 0.16)',
          pointBackgroundColor: '#f8fafc',
          pointBorderColor: '#f8fafc',
          data: scenario.annualRows.map((row) => row.netExpenditure)
        }
      ],
      display: {
        variant: 'wide',
        valueFormat: 'currency',
        xAxisTitle: 'Client age',
        yAxisTitle: 'Net annual cashflow',
        stacked: true
      },
      insights: [shortfallInsight, requiredFundInsight]
    },
    {
      title: 'Required Net Investment Fund',
      subtitle: 'Shows the fund balance needed at each year start to meet future net shortfalls at the selected net growth rate.',
      type: 'line',
      labels: scenario.labels,
      datasets: fundingPathDatasets,
      display: {
        variant: 'wide',
        valueFormat: 'currency',
        xAxisTitle: 'Client age',
        yAxisTitle: 'Fund balance',
        yMin: 0
      },
      insights: [
        requiredFundInsight,
        ...(Number.isFinite(scenario.surplusVsRequired)
          ? [{
            label: scenario.surplusVsRequired >= 0 ? 'Available surplus' : 'Available gap',
            value: toEuroText(Math.abs(scenario.surplusVsRequired)),
            detail: 'Compares the supplied investment fund with the required after-tax net fund.',
            tone: scenario.surplusVsRequired >= 0 ? 'positive' : 'risk'
          }]
          : [])
      ]
    }
  ];
}

export function getNetRetirementScenarioCases(rawInputs) {
  const inputs = normalizeNetRetirementInputs(rawInputs);
  return inputs.scenarios.map((scenario) => {
    const computed = computeScenario(inputs, scenario);
    return {
      id: scenario.id,
      title: scenario.title,
      detail: getScenarioCaseSummary(computed)
    };
  });
}

export function getDefaultNetRetirementScenarioId(rawInputs) {
  const inputs = normalizeNetRetirementInputs(rawInputs);
  return inputs.baseScenarioId;
}

export function computeNetRetirementProjection(rawInputs, { scenarioId = '' } = {}) {
  const inputs = normalizeNetRetirementInputs(rawInputs);
  const requestedId = typeof scenarioId === 'string' ? scenarioId.trim() : '';
  const selectedScenario = inputs.scenarios.find((scenario) => scenario.id === requestedId)
    || inputs.scenarios.find((scenario) => scenario.id === inputs.baseScenarioId)
    || inputs.scenarios[0];
  const scenario = computeScenario(inputs, selectedScenario);

  return {
    assumptionsTable: buildAssumptionsTable(inputs, scenario),
    outputsTable: buildOutputsTable(inputs, scenario),
    tables: [buildAnnualShortfallTable(scenario)],
    charts: buildCharts(inputs, scenario),
    debug: {
      inputs,
      scenario,
      scenarioId: scenario.id,
      requiredFundToday: scenario.requiredFundToday,
      firstYearShortfall: scenario.firstYear?.netShortfall || 0,
      surplusVsRequired: scenario.surplusVsRequired,
      gapVsRequired: scenario.gapVsRequired,
      annualRows: scenario.annualRows
    }
  };
}
