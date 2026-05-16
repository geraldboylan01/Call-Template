const DEFAULT_INFLATION_RATE = 0.025;
const DEFAULT_WAGE_GROWTH_RATE = 0.025;
const DEFAULT_HORIZON_END_AGE = 100;
const DEFAULT_INCOME_MODE = 'target';
const DEFAULT_AFFORDABLE_END_AGES = Object.freeze([100]);

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

function requireNonNegativeNumber(value, fieldName) {
  const normalized = requireFiniteNumber(value, fieldName);
  if (normalized < 0) {
    throw new Error(`generated.pensionInputs.${fieldName} must be greater than or equal to 0.`);
  }
  return normalized;
}

function optionalNonNegativeNumber(value, fallback, fieldName) {
  const normalized = optionalFiniteNumber(value, fallback, fieldName);
  if (normalized < 0) {
    throw new Error(`generated.pensionInputs.${fieldName} must be greater than or equal to 0.`);
  }
  return normalized;
}

function normalizeIncomeMode(value) {
  if (typeof value === 'undefined') {
    return DEFAULT_INCOME_MODE;
  }

  if (typeof value !== 'string') {
    throw new Error('generated.pensionInputs.incomeMode must be "target" or "affordable".');
  }

  const normalized = value.trim().toLowerCase();
  if (normalized !== 'target' && normalized !== 'affordable') {
    throw new Error('generated.pensionInputs.incomeMode must be "target" or "affordable".');
  }

  return normalized;
}

function normalizeScenarioId(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw || fallback;
}

function normalizeRentalIncomeScenarios(rawValue) {
  if (typeof rawValue === 'undefined') {
    return [];
  }

  if (!Array.isArray(rawValue)) {
    throw new Error('generated.pensionInputs.rentalIncomeScenarios must be an array when provided.');
  }

  const usedIds = new Set();
  return rawValue
    .map((scenario, index) => {
      if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
        throw new Error(`generated.pensionInputs.rentalIncomeScenarios[${index}] must be an object.`);
      }

      if (typeof scenario.rentalIncomeToday === 'undefined') {
        throw new Error(`generated.pensionInputs.rentalIncomeScenarios[${index}].rentalIncomeToday must be provided.`);
      }

      const fallbackId = `rental-income-${index + 1}`;
      const id = normalizeScenarioId(scenario.id, fallbackId);
      if (usedIds.has(id)) {
        throw new Error(`generated.pensionInputs.rentalIncomeScenarios[${index}].id must be unique.`);
      }
      usedIds.add(id);

      return {
        id,
        title: typeof scenario.title === 'string' && scenario.title.trim()
          ? scenario.title.trim()
          : `Rental income case ${index + 1}`,
        rentalIncomeToday: requireNonNegativeNumber(
          scenario.rentalIncomeToday,
          `rentalIncomeScenarios[${index}].rentalIncomeToday`
        )
      };
    });
}

function normalizeAffordableEndAges(rawValue, retirementAge) {
  const source = typeof rawValue === 'undefined'
    ? DEFAULT_AFFORDABLE_END_AGES
    : rawValue;

  if (!Array.isArray(source)) {
    throw new Error('generated.pensionInputs.affordableEndAges must be an array of integers.');
  }

  if (source.length === 0) {
    throw new Error('generated.pensionInputs.affordableEndAges must include at least one age.');
  }

  const minimumEndAge = retirementAge + 1;
  const unique = new Set();

  source.forEach((value, index) => {
    if (!isFiniteNumber(value) || !Number.isInteger(value)) {
      throw new Error(`generated.pensionInputs.affordableEndAges[${index}] must be an integer.`);
    }

    if (value < minimumEndAge || value > 110) {
      throw new Error(
        `generated.pensionInputs.affordableEndAges[${index}] must be between ${minimumEndAge} and 110.`
      );
    }

    unique.add(value);
  });

  return [...unique].sort((left, right) => left - right);
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

function floorSeriesToZero(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((value) => (Math.abs(value) < 1e-6 ? 0 : clampToZero(value)));
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

function maxRelievablePersonalContribution(age, salaryAtAge) {
  return ageBandPct(age) * Math.min(salaryAtAge, 115000);
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

function targetIncomeNominalAtAge(inputs, age) {
  const yearsFromToday = Math.max(0, age - inputs.currentAge);
  const nominal = inputs.targetIncomeToday * Math.pow(1 + inputs.inflationRate, yearsFromToday);
  return Number.isFinite(nominal) ? nominal : 0;
}

function rentalIncomeNominalAtAge(inputs, age) {
  const yearsFromToday = Math.max(0, age - inputs.currentAge);
  const nominal = inputs.rentalIncomeToday * Math.pow(1 + inputs.inflationRate, yearsFromToday);
  return Number.isFinite(nominal) ? nominal : 0;
}

function pensionWithdrawalNominalAtAge(inputs, age) {
  return clampToZero(targetIncomeNominalAtAge(inputs, age) - rentalIncomeNominalAtAge(inputs, age));
}

function simulateAccumulation(inputs, personalContributionFn) {
  const labels = [inputs.currentAge];
  const balances = [inputs.currentPot];
  const personalEurSeries = [];
  const employerEurSeries = [];
  const contribEurSeries = [];
  const growthEurSeries = [];
  let balance = inputs.currentPot;

  for (let age = inputs.currentAge; age < inputs.retirementAge; age += 1) {
    const startBalance = balance;
    const salaryAtAge = inputs.currentSalary * Math.pow(1 + inputs.wageGrowthRate, age - inputs.currentAge);
    const personalEurRaw = personalContributionFn(age, salaryAtAge);
    const personalEur = Number.isFinite(personalEurRaw) ? personalEurRaw : 0;
    const employerEurRaw = inputs.employerPct * salaryAtAge;
    const employerEur = Number.isFinite(employerEurRaw) ? employerEurRaw : 0;
    const contribEur = personalEur + employerEur;
    const preGrowth = startBalance + contribEur;
    const endBalance = preGrowth * (1 + inputs.growthRate);
    const growthEurRaw = endBalance - preGrowth;
    const growthEur = Number.isFinite(growthEurRaw) ? growthEurRaw : 0;

    balance = Number.isFinite(endBalance) ? endBalance : preGrowth;
    personalEurSeries.push(personalEur);
    employerEurSeries.push(employerEur);
    contribEurSeries.push(contribEur);
    growthEurSeries.push(growthEur);

    labels.push(age + 1);
    balances.push(balance);
  }

  while (personalEurSeries.length < labels.length) {
    personalEurSeries.push(0);
  }

  while (employerEurSeries.length < labels.length) {
    employerEurSeries.push(0);
  }

  while (contribEurSeries.length < labels.length) {
    contribEurSeries.push(0);
  }

  while (growthEurSeries.length < labels.length) {
    growthEurSeries.push(0);
  }

  return {
    labels,
    balances,
    personalEurSeries,
    employerEurSeries,
    contribEurSeries,
    growthEurSeries,
    retirementPot: balances[balances.length - 1]
  };
}

function computeRequiredPotAtRetirement(inputs) {
  let requiredBalance = 0;

  for (let age = inputs.horizonEndAge - 1; age >= inputs.retirementAge; age -= 1) {
    const withdrawalAtAge = pensionWithdrawalNominalAtAge(inputs, age);
    requiredBalance = withdrawalAtAge + (requiredBalance / (1 + inputs.growthRate));
  }

  return clampToZero(requiredBalance);
}

function computeRequiredPotForIncomeToday(inputs, incomeToday, horizonEndAge, {
  includeRentalOffset = true
} = {}) {
  const cloned = {
    ...inputs,
    targetIncomeToday: clampToZero(Number.isFinite(incomeToday) ? incomeToday : 0),
    horizonEndAge,
    rentalIncomeToday: includeRentalOffset ? inputs.rentalIncomeToday : 0
  };

  return computeRequiredPotAtRetirement(cloned);
}

function goalSeekAffordableIncomeToday(inputs, retirementPot, horizonEndAge) {
  const safeRetirementPot = clampToZero(Number.isFinite(retirementPot) ? retirementPot : 0);
  const tolerance = Math.max(50, 0.00005 * safeRetirementPot);

  let low = 0;
  let high = clampToZero(inputs.currentSalary);
  if (high <= 0) {
    high = 1;
  }

  let requiredAtHigh = computeRequiredPotForIncomeToday(inputs, high, horizonEndAge, {
    includeRentalOffset: false
  });
  while (requiredAtHigh <= safeRetirementPot && high < 5000000) {
    high *= 1.5;
    requiredAtHigh = computeRequiredPotForIncomeToday(inputs, high, horizonEndAge, {
      includeRentalOffset: false
    });
  }

  let incomeTodayBest = 0;
  let requiredPotAtRetirementBest = computeRequiredPotForIncomeToday(inputs, 0, horizonEndAge, {
    includeRentalOffset: false
  });
  let gap = requiredPotAtRetirementBest - safeRetirementPot;

  if (Math.abs(gap) <= tolerance) {
    return {
      incomeTodayBest,
      requiredPotAtRetirementBest,
      gap
    };
  }

  for (let iteration = 0; iteration < 50; iteration += 1) {
    const mid = (low + high) / 2;
    const requiredAtMid = computeRequiredPotForIncomeToday(inputs, mid, horizonEndAge, {
      includeRentalOffset: false
    });
    const nextGap = requiredAtMid - safeRetirementPot;

    const currentBestDistance = Math.abs(gap);
    const candidateDistance = Math.abs(nextGap);
    if (candidateDistance <= currentBestDistance) {
      incomeTodayBest = mid;
      requiredPotAtRetirementBest = requiredAtMid;
      gap = nextGap;
    }

    if (Math.abs(nextGap) <= tolerance) {
      break;
    }

    if (requiredAtMid <= safeRetirementPot) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return {
    incomeTodayBest: clampToZero(Number.isFinite(incomeTodayBest) ? incomeTodayBest : 0),
    requiredPotAtRetirementBest: clampToZero(
      Number.isFinite(requiredPotAtRetirementBest) ? requiredPotAtRetirementBest : 0
    ),
    gap: Number.isFinite(gap) ? gap : 0
  };
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
      ? pensionWithdrawalNominalAtAge(inputs, age)
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
    const targetIncome = pensionWithdrawalNominalAtAge(inputs, age);

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

function buildAffordableDrawdownSeries(inputs, startBalance, incomeToday, horizonEndAge) {
  const cloned = {
    ...inputs,
    targetIncomeToday: clampToZero(Number.isFinite(incomeToday) ? incomeToday : 0),
    horizonEndAge,
    minDrawdownMode: false,
    rentalIncomeToday: 0
  };

  const result = simulateRetirementBalances(cloned, startBalance);
  return {
    labels: result.labels,
    balances: result.balances,
    withdrawals: result.withdrawals,
    endingBalanceAfterHorizon: result.endingBalanceAfterHorizon
  };
}

function buildAffordableIncomeResult(inputs, retirementPot, endAge, fullLabels) {
  const goalSeek = goalSeekAffordableIncomeToday(inputs, retirementPot, endAge);
  const drawdown = buildAffordableDrawdownSeries(
    inputs,
    retirementPot,
    goalSeek.incomeTodayBest,
    endAge
  );
  const flooredBalances = floorSeriesToZero(drawdown.balances);
  const paddedBalances = [...flooredBalances];

  while (paddedBalances.length < fullLabels.length) {
    paddedBalances.push(null);
  }
  if (paddedBalances.length > fullLabels.length) {
    paddedBalances.length = fullLabels.length;
  }

  const goalSeekInputs = {
    ...inputs,
    targetIncomeToday: goalSeek.incomeTodayBest,
    horizonEndAge: endAge,
    rentalIncomeToday: 0
  };
  const incomeNominalAtRetirement = targetIncomeNominalAtAge(goalSeekInputs, inputs.retirementAge);
  const rentalIncomeNominalAtRetirement = rentalIncomeNominalAtAge(inputs, inputs.retirementAge);

  return {
    endAge,
    incomeToday: goalSeek.incomeTodayBest,
    incomeNominalAtRetirement,
    totalIncomeToday: goalSeek.incomeTodayBest + inputs.rentalIncomeToday,
    totalIncomeNominalAtRetirement: incomeNominalAtRetirement + rentalIncomeNominalAtRetirement,
    requiredPotAtRetirement: goalSeek.requiredPotAtRetirementBest,
    gap: goalSeek.gap,
    endingBalanceAfterHorizon: drawdown.endingBalanceAfterHorizon,
    balancesPadded: paddedBalances
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
      : requireFiniteInteger(raw.currentYear, 'currentYear'),
    incomeMode: normalizeIncomeMode(raw.incomeMode),
    rentalIncomeToday: optionalNonNegativeNumber(raw.rentalIncomeToday, 0, 'rentalIncomeToday')
  };

  const rentalIncomeScenarios = normalizeRentalIncomeScenarios(raw.rentalIncomeScenarios);
  if (rentalIncomeScenarios.length > 0) {
    normalized.rentalIncomeScenarios = rentalIncomeScenarios;
    const candidateBaseScenarioId = typeof raw.baseScenarioId === 'string'
      ? raw.baseScenarioId.trim()
      : '';
    normalized.baseScenarioId = rentalIncomeScenarios.some((scenario) => scenario.id === candidateBaseScenarioId)
      ? candidateBaseScenarioId
      : rentalIncomeScenarios[0].id;
  } else if (typeof raw.baseScenarioId === 'string' && raw.baseScenarioId.trim()) {
    normalized.baseScenarioId = raw.baseScenarioId.trim();
  }

  if (typeof raw.minDrawdownMode === 'undefined') {
    normalized.minDrawdownMode = false;
  } else if (typeof raw.minDrawdownMode !== 'boolean') {
    throw new Error('generated.pensionInputs.minDrawdownMode must be a boolean when provided.');
  } else {
    normalized.minDrawdownMode = raw.minDrawdownMode;
  }

  const hasTargetIncomeToday = typeof raw.targetIncomeToday !== 'undefined';
  const hasTargetIncomePct = typeof raw.targetIncomePctOfSalary !== 'undefined';
  const effectiveIncomeMode = normalized.minDrawdownMode ? 'target' : normalized.incomeMode;

  if (effectiveIncomeMode === 'target') {
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

    normalized.affordableEndAges = [];
  } else {
    normalized.targetIncomeToday = 0;
    normalized.affordableEndAges = normalizeAffordableEndAges(raw.affordableEndAges, normalized.retirementAge);
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

function resolvePensionScenario(inputs, scenarioId = '') {
  const scenarios = Array.isArray(inputs.rentalIncomeScenarios)
    ? inputs.rentalIncomeScenarios
    : [];

  if (scenarios.length === 0) {
    return {
      id: 'base',
      title: inputs.rentalIncomeToday > 0 ? 'With rental income' : 'Current position',
      rentalIncomeToday: inputs.rentalIncomeToday
    };
  }

  const requestedId = typeof scenarioId === 'string' ? scenarioId.trim() : '';
  const fallbackId = typeof inputs.baseScenarioId === 'string' && inputs.baseScenarioId.trim()
    ? inputs.baseScenarioId.trim()
    : scenarios[0].id;

  return scenarios.find((scenario) => scenario.id === requestedId)
    || scenarios.find((scenario) => scenario.id === fallbackId)
    || scenarios[0];
}

export function getPensionScenarioCases(rawInputs) {
  const inputs = normalizePensionInputs(rawInputs);
  const scenarios = Array.isArray(inputs.rentalIncomeScenarios)
    ? inputs.rentalIncomeScenarios
    : [];

  if (scenarios.length === 0) {
    return [{
      id: 'base',
      title: inputs.rentalIncomeToday > 0 ? 'With rental income' : 'Current position',
      rentalIncomeToday: inputs.rentalIncomeToday
    }];
  }

  return scenarios.map((scenario) => ({ ...scenario }));
}

export function getDefaultPensionScenarioId(rawInputs) {
  const inputs = normalizePensionInputs(rawInputs);
  return resolvePensionScenario(inputs, '').id;
}

export function computePensionProjection(rawInputs, { scenarioId = '' } = {}) {
  const normalizedInputs = normalizePensionInputs(rawInputs);
  const selectedScenario = resolvePensionScenario(normalizedInputs, scenarioId);
  const inputs = {
    ...normalizedInputs,
    rentalIncomeToday: selectedScenario.rentalIncomeToday,
    selectedScenarioId: selectedScenario.id,
    selectedScenarioTitle: selectedScenario.title
  };
  const isAffordableMode = inputs.incomeMode === 'affordable' && !inputs.minDrawdownMode;
  const hasRentalContext = inputs.rentalIncomeToday > 0
    || (Array.isArray(inputs.rentalIncomeScenarios) && inputs.rentalIncomeScenarios.length > 0);

  const currentContributionCapStats = {
    wasCapped: false,
    firstCappedAge: null,
    maxRelievableAtFirstCap: null
  };

  const currentScenario = simulateAccumulation(
    inputs,
    (age, salaryAtAge) => {
      const desired = inputs.personalPct * salaryAtAge;
      const cap = maxRelievablePersonalContribution(age, salaryAtAge);
      if (desired > cap && !currentContributionCapStats.wasCapped) {
        currentContributionCapStats.wasCapped = true;
        currentContributionCapStats.firstCappedAge = age;
        currentContributionCapStats.maxRelievableAtFirstCap = cap;
      }
      return Math.min(desired, cap);
    }
  );

  const maxScenario = simulateAccumulation(
    inputs,
    (age, salaryAtAge) => maxRelievablePersonalContribution(age, salaryAtAge)
  );

  const monotonicIssues = [];
  for (let index = 1; index < maxScenario.balances.length; index += 1) {
    const previous = maxScenario.balances[index - 1];
    const current = maxScenario.balances[index];

    if (previous > 0 && current < previous * 0.99) {
      monotonicIssues.push({
        age: maxScenario.labels[index],
        previous,
        current,
        dropPct: ((previous - current) / previous) * 100
      });
    }
  }

  const retirementSimulationProjectedCurrent = simulateRetirementBalances(inputs, currentScenario.retirementPot);
  const retirementSimulationProjectedMax = simulateRetirementBalances(inputs, maxScenario.retirementPot);
  const minDrawdownSimulation = simulateMinimumDrawdown(inputs, currentScenario.retirementPot);
  const sustainabilityCurrentFloored = floorSeriesToZero(retirementSimulationProjectedCurrent.balances);
  const sustainabilityMaxFloored = floorSeriesToZero(retirementSimulationProjectedMax.balances);
  const baseSustainabilityLabels = retirementSimulationProjectedCurrent.labels;
  const withdrawalsSeries = baseSustainabilityLabels.map((_label, index) => {
    const rawValue = retirementSimulationProjectedCurrent.withdrawals?.[index];
    return clampToZero(Number.isFinite(rawValue) ? rawValue : 0);
  });

  const requiredPot = isAffordableMode ? null : computeRequiredPotAtRetirement(inputs);
  const retirementSimulationRequired = isAffordableMode ? null : simulateRetirementBalances(inputs, requiredPot);
  const requiredReferenceFloored = isAffordableMode
    ? []
    : floorSeriesToZero(retirementSimulationRequired.balances);
  let sustainabilityLabels = baseSustainabilityLabels;
  let affordableChartDatasets = [];
  let affordableCurrentResults = [];
  let affordableMaxResults = [];

  const depletionAgeProjected = retirementSimulationProjectedCurrent.labels[
    sustainabilityCurrentFloored.findIndex((value) => value === 0)
  ] ?? null;
  const depletionAgeRequired = retirementSimulationRequired
    ? retirementSimulationRequired.labels[requiredReferenceFloored.findIndex((value) => value === 0)] ?? null
    : null;

  if (!inputs.minDrawdownMode && isAffordableMode) {
    const affordableEndAges = inputs.affordableEndAges;
    const maxAffordableEndAge = affordableEndAges[affordableEndAges.length - 1];
    sustainabilityLabels = buildAgeRange(inputs.retirementAge, maxAffordableEndAge);

    affordableCurrentResults = affordableEndAges.map((endAge) => (
      buildAffordableIncomeResult(inputs, currentScenario.retirementPot, endAge, sustainabilityLabels)
    ));
    affordableMaxResults = affordableEndAges.map((endAge) => (
      buildAffordableIncomeResult(inputs, maxScenario.retirementPot, endAge, sustainabilityLabels)
    ));

    affordableChartDatasets = [
      ...affordableCurrentResults.map((entry) => ({
        label: `Affordable income (current) - deplete by age ${entry.endAge}`,
        data: entry.balancesPadded
      })),
      ...affordableMaxResults.map((entry) => ({
        label: `Affordable income (max) - deplete by age ${entry.endAge}`,
        data: entry.balancesPadded
      }))
    ];
  }

  const retirementYear = inputs.currentYear + (inputs.retirementAge - inputs.currentAge);
  const sftMeta = computeSft(retirementYear);

  const projectedPotCurrent = currentScenario.retirementPot;
  const projectedPotMaxPersonal = maxScenario.retirementPot;
  const sftBreaches = isAffordableMode
    ? {
      current: projectedPotCurrent > sftMeta.sftValue,
      max: projectedPotMaxPersonal > sftMeta.sftValue,
      required: false,
      any: projectedPotCurrent > sftMeta.sftValue || projectedPotMaxPersonal > sftMeta.sftValue
    }
    : computeSftBreaches({
      projectedPotCurrent,
      projectedPotMaxPersonal,
      requiredPot,
      sftValue: sftMeta.sftValue
    });
  const sftSentence = buildSftSummarySentence(sftBreaches, sftMeta);

  const targetIncomeNominalAtRetirement = targetIncomeNominalAtAge(inputs, inputs.retirementAge);
  const rentalIncomeNominalAtRetirement = rentalIncomeNominalAtAge(inputs, inputs.retirementAge);
  const pensionWithdrawalNominalAtRetirement = pensionWithdrawalNominalAtAge(inputs, inputs.retirementAge);
  const expectedFactor = Math.pow(1 + inputs.inflationRate, inputs.retirementAge - inputs.currentAge);
  const expectedNominal = inputs.targetIncomeToday * expectedFactor;
  const nominalDiff = Math.abs(targetIncomeNominalAtRetirement - expectedNominal);
  const nominalTolerance = 1e-6 * Math.max(1, Math.abs(expectedNominal));
  if (Number.isFinite(expectedNominal) && nominalDiff > nominalTolerance) {
    console.warn('[Pension] target income nominal-at-retirement consistency mismatch', {
      currentAge: inputs.currentAge,
      retirementAge: inputs.retirementAge,
      inflationRate: inputs.inflationRate,
      nominalAtRetirement: targetIncomeNominalAtRetirement,
      expectedNominal
    });
  }
  const modeLabel = inputs.minDrawdownMode ? 'Minimum drawdowns' : 'Target withdrawals';
  const currentPersonalWasCapped = currentContributionCapStats.wasCapped;
  const firstCappedAge = currentContributionCapStats.firstCappedAge;
  const maxRelievableAtFirstCap = currentContributionCapStats.maxRelievableAtFirstCap;
  const currentPersonalCapSentence = currentPersonalWasCapped && Number.isInteger(firstCappedAge)
    ? `Your current personal contribution rate reaches the Irish max tax-relievable limit from age ${firstCappedAge}, so personal contributions are capped from that point.`
    : '';

  const assumptionsTable = {
    columns: ['Assumption', 'Value'],
    rows: [
      ['Current age', String(inputs.currentAge)],
      ['Retirement age', String(inputs.retirementAge)],
      ['Current salary', toEuroText(inputs.currentSalary)],
      ['Current pension value', toEuroText(inputs.currentPot)],
      ['Personal contribution', toPercentText(inputs.personalPct)],
      ['Employer contribution', toPercentText(inputs.employerPct)],
      ['Growth rate', toPercentText(inputs.growthRate)],
      ['Wage growth', toPercentText(inputs.wageGrowthRate)],
      ['Inflation', toPercentText(inputs.inflationRate)],
      ...(hasRentalContext
        ? [
          ['Rental income case', inputs.selectedScenarioTitle],
          ['Gross rental income today', toEuroText(inputs.rentalIncomeToday)],
          ['Gross rental income at retirement', toEuroText(rentalIncomeNominalAtRetirement)]
        ]
        : []),
      isAffordableMode
        ? ['Affordable income mode', 'Goal-seek (see outputs)']
        : ['Target retirement income', toEuroText(inputs.targetIncomeToday)],
      ['Earnings cap for max-relief maths', toEuroText(Math.min(inputs.currentSalary, 115000))],
      ['Max personal age band %', `${toPercentText(ageBandPct(inputs.currentAge))} (steps with age)`],
      ...(currentPersonalWasCapped && Number.isInteger(firstCappedAge)
        ? [[
          'Current personal contributions capped?',
          `Yes (from age ${firstCappedAge})`
        ]]
        : []),
      ['Mode', modeLabel],
      [
        'Horizon end age',
        isAffordableMode ? inputs.affordableEndAges.join(', ') : String(inputs.horizonEndAge)
      ]
    ]
  };

  const outputsRows = [
    ['Projected pot at retirement (current)', toEuroText(projectedPotCurrent)],
    ['Projected pot at retirement (max personal)', toEuroText(projectedPotMaxPersonal)]
  ];

  if (isAffordableMode && !inputs.minDrawdownMode) {
    affordableCurrentResults.forEach((entry) => {
      if (hasRentalContext) {
        outputsRows.push([
          `Pension-funded affordable income (current, deplete by ${entry.endAge})`,
          `${toEuroText(entry.incomeToday)} p.a.`
        ]);
      }
      outputsRows.push([
        `Affordable income (current, deplete by ${entry.endAge})`,
        `${toEuroText(hasRentalContext ? entry.totalIncomeToday : entry.incomeToday)} p.a.`
      ]);
    });
    affordableMaxResults.forEach((entry) => {
      if (hasRentalContext) {
        outputsRows.push([
          `Pension-funded affordable income (max, deplete by ${entry.endAge})`,
          `${toEuroText(entry.incomeToday)} p.a.`
        ]);
      }
      outputsRows.push([
        `Affordable income (max, deplete by ${entry.endAge})`,
        `${toEuroText(hasRentalContext ? entry.totalIncomeToday : entry.incomeToday)} p.a.`
      ]);
    });
  } else {
    outputsRows.push(['Required pot at retirement (Mode 1)', toEuroText(requiredPot)]);
    outputsRows.push(['Gap vs required (required - projected current)', toEuroText(requiredPot - projectedPotCurrent)]);
    outputsRows.push(['Target income (today\'s money)', toEuroText(inputs.targetIncomeToday)]);
    outputsRows.push(['Target income (nominal at retirement)', toEuroText(targetIncomeNominalAtRetirement)]);
    if (hasRentalContext) {
      outputsRows.push(['Gross rental income at retirement', toEuroText(rentalIncomeNominalAtRetirement)]);
      outputsRows.push([
        'Pension-funded target after rent (nominal at retirement)',
        toEuroText(pensionWithdrawalNominalAtRetirement)
      ]);
    }
  }

  outputsRows.push([
    'SFT threshold used',
    `${formatCurrencyEUR(sftMeta.sftValue)}${sftMeta.heldConstantBeyond2029 ? ' (held beyond 2029)' : ''}`
  ]);
  outputsRows.push([
    'SFT breach?',
    sftBreaches.any
      ? `Yes (${[
        sftBreaches.current ? 'Current' : '',
        sftBreaches.max ? 'Max' : '',
        sftBreaches.required ? 'Required' : ''
      ].filter(Boolean).join(', ')})`
      : 'No'
  ]);

  if (inputs.minDrawdownMode) {
    outputsRows.push(['First-year min drawdown amount', toEuroText(minDrawdownSimulation.firstYearMinimumDrawdown)]);
    outputsRows.push([
      hasRentalContext
        ? 'First-year min drawdown >= pension-funded target after rent'
        : 'First-year min drawdown >= target_nominal_at_retirement',
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
      type: 'bar',
      labels: currentScenario.labels,
      datasets: [
        {
          label: 'Pot (current)',
          data: currentScenario.balances
        },
        {
          label: 'Pot (max)',
          data: maxScenario.balances
        },
        {
          label: 'Personal (current)',
          data: currentScenario.personalEurSeries
        },
        {
          label: 'Employer (current)',
          data: currentScenario.employerEurSeries
        },
        {
          label: 'Growth (current)',
          data: currentScenario.growthEurSeries
        },
        {
          label: 'Personal (max)',
          data: maxScenario.personalEurSeries
        },
        {
          label: 'Employer (max)',
          data: maxScenario.employerEurSeries
        },
        {
          label: 'Growth (max)',
          data: maxScenario.growthEurSeries
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
          label: hasRentalContext ? 'Pension-funded target after rent' : 'Target income',
          data: minDrawdownSimulation.targets
        }
      ]
    });
  } else {
    if (isAffordableMode) {
      charts.push({
        title: 'Retirement Sustainability (Affordable Income)',
        type: 'line',
        labels: sustainabilityLabels,
        datasets: affordableChartDatasets
      });
    } else {
      charts.push({
        title: 'Retirement Sustainability (Target Income)',
        type: 'line',
        labels: sustainabilityLabels,
        datasets: [
          {
            label: 'Balance (current)',
            data: sustainabilityCurrentFloored
          },
          {
            label: 'Balance (max)',
            data: sustainabilityMaxFloored
          },
          {
            label: 'Required pot path',
            data: requiredReferenceFloored,
            borderColor: '#B48CFF',
            backgroundColor: 'rgba(180, 140, 255, 0.20)',
            pointBackgroundColor: '#B48CFF',
            pointBorderColor: '#B48CFF'
          },
          {
            label: 'Withdrawals',
            data: withdrawalsSeries
          }
        ]
      });
    }
  }

  charts.forEach((chart) => {
    const labelsCount = Array.isArray(chart?.labels) ? chart.labels.length : 0;
    if (!Array.isArray(chart?.datasets)) {
      return;
    }

    chart.datasets.forEach((dataset) => {
      const dataCount = Array.isArray(dataset?.data) ? dataset.data.length : 0;
      if (dataCount !== labelsCount) {
        console.warn('[Pension] dataset length mismatch', {
          chart: chart.title,
          label: dataset?.label || '',
          labels: labelsCount,
          data: dataCount
        });
      }
    });
  });

  return {
    assumptionsTable,
    outputsTable,
    charts,
    debug: {
      inputs,
      projectedPotCurrent,
      projectedPotMaxPersonal,
      requiredPot,
      rentalIncomeToday: inputs.rentalIncomeToday,
      rentalIncomeNominalAtRetirement,
      pensionWithdrawalNominalAtRetirement,
      selectedScenarioId: inputs.selectedScenarioId,
      selectedScenarioTitle: inputs.selectedScenarioTitle,
      retirementYear,
      sftValue: sftMeta.sftValue,
      sftYearUsed: sftMeta.sftYearUsed,
      sftHeldConstantBeyond2029: sftMeta.heldConstantBeyond2029,
      sftBreaches,
      sftSentence,
      currentPersonalWasCapped,
      firstCappedAge,
      maxRelievableAtFirstCap,
      currentPersonalCapSentence,
      currentScenario: {
        personalEurSeries: currentScenario.personalEurSeries,
        employerEurSeries: currentScenario.employerEurSeries,
        contribEurSeries: currentScenario.contribEurSeries,
        growthEurSeries: currentScenario.growthEurSeries
      },
      depletionAgeProjected,
      depletionAgeRequired,
      maxSeriesMonotonicIssues: monotonicIssues,
      retirementEndingBalanceFromProjected: retirementSimulationProjectedCurrent.endingBalanceAfterHorizon,
      retirementEndingBalanceFromProjectedMax: retirementSimulationProjectedMax.endingBalanceAfterHorizon,
      retirementEndingBalanceFromRequired: retirementSimulationRequired?.endingBalanceAfterHorizon ?? null,
      affordableIncome: isAffordableMode
        ? {
          current: affordableCurrentResults.map((entry) => ({
            endAge: entry.endAge,
            incomeToday: entry.incomeToday,
            incomeNominalAtRetirement: entry.incomeNominalAtRetirement,
            totalIncomeToday: entry.totalIncomeToday,
            totalIncomeNominalAtRetirement: entry.totalIncomeNominalAtRetirement,
            requiredPotAtRetirement: entry.requiredPotAtRetirement,
            gap: entry.gap,
            endingBalanceAfterHorizon: entry.endingBalanceAfterHorizon
          })),
          max: affordableMaxResults.map((entry) => ({
            endAge: entry.endAge,
            incomeToday: entry.incomeToday,
            incomeNominalAtRetirement: entry.incomeNominalAtRetirement,
            totalIncomeToday: entry.totalIncomeToday,
            totalIncomeNominalAtRetirement: entry.totalIncomeNominalAtRetirement,
            requiredPotAtRetirement: entry.requiredPotAtRetirement,
            gap: entry.gap,
            endingBalanceAfterHorizon: entry.endingBalanceAfterHorizon
          }))
        }
        : null
    }
  };
}
