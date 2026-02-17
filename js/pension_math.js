const DEFAULT_INFLATION_RATE = 0.025;
const DEFAULT_WAGE_GROWTH_RATE = 0.025;
const DEFAULT_HORIZON_END_AGE = 100;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireFiniteNumber(value, fieldName) {
  if (!isFiniteNumber(value)) {
    throw new Error(`generated.pensionInputs.${fieldName} must be a finite number.`);
  }
  return value;
}

function requireFiniteInteger(value, fieldName) {
  if (!isFiniteNumber(value) || !Number.isInteger(value)) {
    throw new Error(`generated.pensionInputs.${fieldName} must be an integer.`);
  }
  return value;
}

function optionalFiniteNumber(value, fallback, fieldName) {
  if (typeof value === 'undefined') {
    return fallback;
  }
  if (!isFiniteNumber(value)) {
    throw new Error(`generated.pensionInputs.${fieldName} must be a finite number when provided.`);
  }
  return value;
}

function toPercentText(decimal, digits = 1) {
  return `${(decimal * 100).toFixed(digits)}%`;
}

function toEuroText(amount, digits = 0) {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatCurrencyEUR(amount) {
  if (!Number.isFinite(amount)) {
    return '€0';
  }

  const absolute = Math.abs(amount);
  if (absolute >= 1000000) {
    return `€${(amount / 1000000).toFixed(1)}m`;
  }

  return `€${Math.round(amount).toLocaleString('en-IE')}`;
}

function clampToZero(value) {
  return value > 0 ? value : 0;
}

function ageBandPct(age) {
  if (age < 30) {
    return 0.15;
  }
  if (age <= 39) {
    return 0.20;
  }
  if (age <= 49) {
    return 0.25;
  }
  if (age <= 54) {
    return 0.30;
  }
  if (age <= 59) {
    return 0.35;
  }
  return 0.40;
}

export function computeSft(retirementYear) {
  if (retirementYear <= 2026) {
    return {
      sftValue: 2200000,
      sftYearUsed: 2026,
      heldConstantBeyond2029: false
    };
  }

  if (retirementYear === 2027) {
    return {
      sftValue: 2400000,
      sftYearUsed: 2027,
      heldConstantBeyond2029: false
    };
  }

  if (retirementYear === 2028) {
    return {
      sftValue: 2600000,
      sftYearUsed: 2028,
      heldConstantBeyond2029: false
    };
  }

  return {
    sftValue: 2800000,
    sftYearUsed: 2029,
    heldConstantBeyond2029: retirementYear > 2029
  };
}

export function computeSftBreaches({
  projectedPotCurrent,
  projectedPotMaxPersonal,
  requiredPot,
  sftValue
}) {
  const current = projectedPotCurrent > sftValue;
  const max = projectedPotMaxPersonal > sftValue;
  const required = requiredPot > sftValue;

  return {
    current,
    max,
    required,
    any: current || max || required
  };
}

export function buildSftSummarySentence(flags, sftMeta) {
  if (!flags?.any) {
    return '';
  }

  const sftText = formatCurrencyEUR(sftMeta.sftValue);
  const yearText = sftMeta.sftYearUsed;
  const suffix = sftMeta.heldConstantBeyond2029
    ? ' (held at the 2029 level; future indexation isn’t modelled).'
    : '.';

  let baseSentence = '';

  if (flags.current && !flags.max && !flags.required) {
    baseSentence = `Based on your current contribution path, the projected fund at retirement may exceed the Standard Fund Threshold (SFT) of ${sftText} for ${yearText}${suffix}`;
  } else if (!flags.current && flags.max && !flags.required) {
    baseSentence = `If you maximise personal contributions within Irish limits, the projected fund at retirement may exceed the Standard Fund Threshold (SFT) of ${sftText} for ${yearText}${suffix}`;
  } else if (flags.current && flags.max && !flags.required) {
    baseSentence = `Both the current and maximised contribution projections suggest the fund at retirement may exceed the Standard Fund Threshold (SFT) of ${sftText} for ${yearText}${suffix}`;
  } else if (!flags.current && !flags.max && flags.required) {
    baseSentence = `To fund the target retirement income on these assumptions, the required pot at retirement may exceed the Standard Fund Threshold (SFT) of ${sftText} for ${yearText}${suffix}`;
  } else if (flags.current && !flags.max && flags.required) {
    baseSentence = `Your current projection and the pot required to meet the target income may exceed the Standard Fund Threshold (SFT) of ${sftText} for ${yearText}${suffix}`;
  } else if (!flags.current && flags.max && flags.required) {
    baseSentence = `The maximised projection and the pot required to meet the target income may exceed the Standard Fund Threshold (SFT) of ${sftText} for ${yearText}${suffix}`;
  } else if (flags.current && flags.max && flags.required) {
    baseSentence = `Across both projections and the pot required to meet the target income, the fund at retirement may exceed the Standard Fund Threshold (SFT) of ${sftText} for ${yearText}${suffix}`;
  }

  if (!baseSentence) {
    return '';
  }

  if (!sftMeta.heldConstantBeyond2029) {
    return baseSentence;
  }

  return `${baseSentence} Future SFT increases may apply but aren’t predictable, so we’ve held the threshold constant beyond 2029.`;
}

function buildAgeRange(startAge, endAge) {
  const labels = [];
  for (let age = startAge; age <= endAge; age += 1) {
    labels.push(age);
  }
  return labels;
}

function simulateAccumulation(inputs, personalContributionFn) {
  const labels = [inputs.currentAge];
  const balances = [inputs.currentPot];
  let balance = inputs.currentPot;

  for (let age = inputs.currentAge; age < inputs.retirementAge; age += 1) {
    const salaryAtAge = inputs.currentSalary * Math.pow(1 + inputs.wageGrowthRate, age - inputs.currentAge);
    const personal = personalContributionFn(age, salaryAtAge);
    const employer = inputs.employerPct * salaryAtAge;

    balance = (balance + personal + employer) * (1 + inputs.growthRate);

    labels.push(age + 1);
    balances.push(balance);
  }

  return {
    labels,
    balances,
    retirementPot: balances[balances.length - 1]
  };
}

function computeRequiredPotAtRetirement(inputs) {
  let requiredBalance = 0;

  for (let age = inputs.horizonEndAge - 1; age >= inputs.retirementAge; age -= 1) {
    const withdrawalAtAge = inputs.targetIncomeToday * Math.pow(1 + inputs.inflationRate, age - inputs.retirementAge);
    requiredBalance = withdrawalAtAge + (requiredBalance / (1 + inputs.growthRate));
  }

  return clampToZero(requiredBalance);
}

function simulateRetirementBalances(inputs, startBalance) {
  const labels = buildAgeRange(inputs.retirementAge, inputs.horizonEndAge);
  const balances = [];
  const withdrawals = [];
  let balance = clampToZero(startBalance);

  labels.forEach((age) => {
    const currentBalance = clampToZero(balance);
    balances.push(currentBalance);

    const withdrawalAtAge = age <= (inputs.horizonEndAge - 1)
      ? inputs.targetIncomeToday * Math.pow(1 + inputs.inflationRate, age - inputs.retirementAge)
      : 0;
    withdrawals.push(withdrawalAtAge);

    const postWithdrawal = currentBalance - withdrawalAtAge;
    if (postWithdrawal <= 0) {
      balance = 0;
      return;
    }

    balance = clampToZero(postWithdrawal * (1 + inputs.growthRate));
  });

  return {
    labels,
    balances,
    withdrawals,
    endingBalanceAfterHorizon: clampToZero(balance)
  };
}

function simulateMinimumDrawdown(inputs, startBalance) {
  const labels = buildAgeRange(inputs.retirementAge, inputs.horizonEndAge);
  const minDrawdowns = [];
  const targets = [];
  let balance = clampToZero(startBalance);

  labels.forEach((age) => {
    const currentBalance = clampToZero(balance);
    const drawdownRate = age < 70 ? 0.04 : 0.05;
    const minimumDrawdown = drawdownRate * currentBalance;
    const targetIncome = inputs.targetIncomeToday * Math.pow(1 + inputs.inflationRate, age - inputs.retirementAge);

    minDrawdowns.push(minimumDrawdown);
    targets.push(targetIncome);

    if (currentBalance <= 0) {
      balance = 0;
      return;
    }

    if (minimumDrawdown >= currentBalance) {
      balance = 0;
      return;
    }

    balance = (currentBalance - minimumDrawdown) * (1 + inputs.growthRate);
    balance = clampToZero(balance);
  });

  return {
    labels,
    minDrawdowns,
    targets,
    firstYearMinimumDrawdown: minDrawdowns[0] || 0,
    firstYearTargetIncome: targets[0] || 0,
    endingBalanceAfterHorizon: clampToZero(balance)
  };
}

export function normalizePensionInputs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('generated.pensionInputs must be an object.');
  }

  const nowYear = new Date().getFullYear();

  const normalized = {
    currentAge: requireFiniteInteger(raw.currentAge, 'currentAge'),
    retirementAge: requireFiniteInteger(raw.retirementAge, 'retirementAge'),
    currentSalary: requireFiniteNumber(raw.currentSalary, 'currentSalary'),
    currentPot: requireFiniteNumber(raw.currentPot, 'currentPot'),
    personalPct: requireFiniteNumber(raw.personalPct, 'personalPct'),
    employerPct: requireFiniteNumber(raw.employerPct, 'employerPct'),
    growthRate: requireFiniteNumber(raw.growthRate, 'growthRate'),
    inflationRate: optionalFiniteNumber(raw.inflationRate, DEFAULT_INFLATION_RATE, 'inflationRate'),
    wageGrowthRate: optionalFiniteNumber(raw.wageGrowthRate, DEFAULT_WAGE_GROWTH_RATE, 'wageGrowthRate'),
    horizonEndAge: typeof raw.horizonEndAge === 'undefined'
      ? DEFAULT_HORIZON_END_AGE
      : requireFiniteInteger(raw.horizonEndAge, 'horizonEndAge'),
    currentYear: typeof raw.currentYear === 'undefined'
      ? nowYear
      : requireFiniteInteger(raw.currentYear, 'currentYear')
  };

  if (typeof raw.minDrawdownMode === 'undefined') {
    normalized.minDrawdownMode = false;
  } else if (typeof raw.minDrawdownMode !== 'boolean') {
    throw new Error('generated.pensionInputs.minDrawdownMode must be a boolean when provided.');
  } else {
    normalized.minDrawdownMode = raw.minDrawdownMode;
  }

  const hasTargetIncomeToday = typeof raw.targetIncomeToday !== 'undefined';
  const hasTargetIncomePct = typeof raw.targetIncomePctOfSalary !== 'undefined';

  if (!hasTargetIncomeToday && !hasTargetIncomePct) {
    throw new Error('generated.pensionInputs must include targetIncomeToday or targetIncomePctOfSalary.');
  }

  if (hasTargetIncomeToday) {
    normalized.targetIncomeToday = requireFiniteNumber(raw.targetIncomeToday, 'targetIncomeToday');
  }

  if (hasTargetIncomePct) {
    normalized.targetIncomePctOfSalary = requireFiniteNumber(raw.targetIncomePctOfSalary, 'targetIncomePctOfSalary');
  }

  if (!hasTargetIncomeToday && hasTargetIncomePct) {
    normalized.targetIncomeToday = normalized.targetIncomePctOfSalary * normalized.currentSalary;
  }

  if (normalized.retirementAge < normalized.currentAge) {
    throw new Error('generated.pensionInputs.retirementAge must be greater than or equal to currentAge.');
  }

  if (normalized.horizonEndAge < normalized.retirementAge) {
    throw new Error('generated.pensionInputs.horizonEndAge must be greater than or equal to retirementAge.');
  }

  if (normalized.growthRate <= -1) {
    throw new Error('generated.pensionInputs.growthRate must be greater than -1.');
  }

  if (normalized.inflationRate <= -1) {
    throw new Error('generated.pensionInputs.inflationRate must be greater than -1.');
  }

  if (normalized.wageGrowthRate <= -1) {
    throw new Error('generated.pensionInputs.wageGrowthRate must be greater than -1.');
  }

  return normalized;
}

export function computePensionProjection(rawInputs) {
  const inputs = normalizePensionInputs(rawInputs);

  const currentScenario = simulateAccumulation(
    inputs,
    (_age, salaryAtAge) => inputs.personalPct * salaryAtAge
  );

  const maxPersonalScenario = simulateAccumulation(
    inputs,
    (age, salaryAtAge) => ageBandPct(age) * Math.min(salaryAtAge, 115000)
  );

  const monotonicIssues = [];
  for (let index = 1; index < maxPersonalScenario.balances.length; index += 1) {
    const previous = maxPersonalScenario.balances[index - 1];
    const current = maxPersonalScenario.balances[index];

    if (previous > 0 && current < previous * 0.99) {
      monotonicIssues.push({
        age: maxPersonalScenario.labels[index],
        previous,
        current,
        dropPct: ((previous - current) / previous) * 100
      });
    }
  }

  const requiredPot = computeRequiredPotAtRetirement(inputs);
  const retirementSimulationProjected = simulateRetirementBalances(inputs, currentScenario.retirementPot);
  const retirementSimulationRequired = simulateRetirementBalances(inputs, requiredPot);
  const minDrawdownSimulation = simulateMinimumDrawdown(inputs, currentScenario.retirementPot);
  const projectedBalanceSeriesForChart = retirementSimulationProjected.balances;
  const requiredBalanceSeriesForChart = retirementSimulationRequired.balances
    .map((value) => (Math.abs(value) < 1e-6 ? 0 : clampToZero(value)));

  const depletionAgeProjected = retirementSimulationProjected.labels[
    retirementSimulationProjected.balances.findIndex((value) => value === 0)
  ] ?? null;
  const depletionAgeRequired = retirementSimulationRequired.labels[
    requiredBalanceSeriesForChart.findIndex((value) => value === 0)
  ] ?? null;

  const retirementYear = inputs.currentYear + (inputs.retirementAge - inputs.currentAge);
  const sftMeta = computeSft(retirementYear);

  const projectedPotCurrent = currentScenario.retirementPot;
  const projectedPotMaxPersonal = maxPersonalScenario.retirementPot;
  const sftBreaches = computeSftBreaches({
    projectedPotCurrent,
    projectedPotMaxPersonal,
    requiredPot,
    sftValue: sftMeta.sftValue
  });
  const sftSentence = buildSftSummarySentence(sftBreaches, sftMeta);

  const targetIncomeNominalAtRetirement = inputs.targetIncomeToday;
  const modeLabel = inputs.minDrawdownMode ? 'Minimum drawdowns' : 'Target withdrawals';

  const assumptionsTable = {
    columns: ['Assumption', 'Value'],
    rows: [
      ['Current age', String(inputs.currentAge)],
      ['Retirement age', String(inputs.retirementAge)],
      ['Growth rate', toPercentText(inputs.growthRate)],
      ['Wage growth', toPercentText(inputs.wageGrowthRate)],
      ['Inflation', toPercentText(inputs.inflationRate)],
      ['Salary used for cap', toEuroText(Math.min(inputs.currentSalary, 115000))],
      ['Current personal % and employer %', `${toPercentText(inputs.personalPct)} / ${toPercentText(inputs.employerPct)}`],
      ['Max personal age-band % at current age', `${toPercentText(ageBandPct(inputs.currentAge))} (steps with age)`],
      ['Mode', modeLabel],
      ['Horizon end age', String(inputs.horizonEndAge)]
    ]
  };

  const outputsRows = [
    ['Projected pot at retirement (current)', toEuroText(projectedPotCurrent)],
    ['Projected pot at retirement (max personal)', toEuroText(projectedPotMaxPersonal)],
    ['Required pot at retirement (Mode 1)', toEuroText(requiredPot)],
    ['Gap vs required (required - projected current)', toEuroText(requiredPot - projectedPotCurrent)],
    ['Target income (today\'s money)', toEuroText(inputs.targetIncomeToday)],
    ['Target income (nominal at retirement)', toEuroText(targetIncomeNominalAtRetirement)],
    [
      'SFT threshold used',
      `${formatCurrencyEUR(sftMeta.sftValue)}${sftMeta.heldConstantBeyond2029 ? ' (held beyond 2029)' : ''}`
    ],
    [
      'SFT breach?',
      sftBreaches.any
        ? `Yes (${[
          sftBreaches.current ? 'Current' : '',
          sftBreaches.max ? 'Max' : '',
          sftBreaches.required ? 'Required' : ''
        ].filter(Boolean).join(', ')})`
        : 'No'
    ]
  ];

  if (inputs.minDrawdownMode) {
    outputsRows.push(['First-year min drawdown amount', toEuroText(minDrawdownSimulation.firstYearMinimumDrawdown)]);
    outputsRows.push([
      'First-year min drawdown >= target_nominal_at_retirement',
      minDrawdownSimulation.firstYearMinimumDrawdown >= minDrawdownSimulation.firstYearTargetIncome ? 'Yes' : 'No'
    ]);
  }

  const outputsTable = {
    columns: ['Output', 'Value'],
    rows: outputsRows
  };

  const charts = [
    {
      title: 'Pension Pot at Retirement (Before Withdrawals)',
      type: 'line',
      labels: currentScenario.labels,
      datasets: [
        {
          label: 'Current contribution path',
          data: currentScenario.balances
        },
        {
          label: 'Max personal contribution path',
          data: maxPersonalScenario.balances
        }
      ]
    }
  ];

  if (inputs.minDrawdownMode) {
    charts.push({
      title: 'Minimum Drawdown vs Target Income',
      type: 'bar',
      labels: minDrawdownSimulation.labels,
      datasets: [
        {
          label: 'Minimum drawdown',
          data: minDrawdownSimulation.minDrawdowns
        },
        {
          label: 'Target income',
          data: minDrawdownSimulation.targets
        }
      ]
    });
  } else {
    charts.push({
      title: 'Retirement Sustainability (Target Income)',
      type: 'line',
      labels: retirementSimulationProjected.labels,
      datasets: [
        {
          label: 'Balance with target income (starts from projected pot)',
          data: projectedBalanceSeriesForChart
        },
        {
          label: 'Required-balance reference (starts from required pot)',
          data: requiredBalanceSeriesForChart,
          borderColor: '#B48CFF',
          backgroundColor: 'rgba(180, 140, 255, 0.20)',
          pointBackgroundColor: '#B48CFF',
          pointBorderColor: '#B48CFF'
        }
      ]
    });
  }

  return {
    assumptionsTable,
    outputsTable,
    charts,
    debug: {
      inputs,
      projectedPotCurrent,
      projectedPotMaxPersonal,
      requiredPot,
      retirementYear,
      sftValue: sftMeta.sftValue,
      sftYearUsed: sftMeta.sftYearUsed,
      sftHeldConstantBeyond2029: sftMeta.heldConstantBeyond2029,
      sftBreaches,
      sftSentence,
      depletionAgeProjected,
      depletionAgeRequired,
      maxSeriesMonotonicIssues: monotonicIssues,
      retirementEndingBalanceFromProjected: retirementSimulationProjected.endingBalanceAfterHorizon,
      retirementEndingBalanceFromRequired: retirementSimulationRequired.endingBalanceAfterHorizon
    }
  };
}
