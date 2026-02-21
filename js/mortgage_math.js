function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireFiniteNumber(value, fieldName) {
  if (!isFiniteNumber(value)) {
    throw new Error(`generated.mortgageInputs.${fieldName} must be a finite number.`);
  }

  return value;
}

function optionalFiniteNumber(value, fallback, fieldName) {
  if (typeof value === 'undefined' || value === null) {
    return fallback;
  }

  if (!isFiniteNumber(value)) {
    throw new Error(`generated.mortgageInputs.${fieldName} must be a finite number when provided.`);
  }

  return value;
}

function parseIsoDateStrict(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(`generated.mortgageInputs.${fieldName} must be a YYYY-MM-DD string.`);
  }

  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    throw new Error(`generated.mortgageInputs.${fieldName} must be a YYYY-MM-DD string.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`generated.mortgageInputs.${fieldName} is not a valid calendar date.`);
  }

  return date;
}

function toMonthStartUtc(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addUtcMonths(date, months) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function formatIsoDateUtc(date) {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getInclusiveMonthCount(startMonthDate, endMonthDate) {
  const deltaMonths = ((endMonthDate.getUTCFullYear() - startMonthDate.getUTCFullYear()) * 12)
    + (endMonthDate.getUTCMonth() - startMonthDate.getUTCMonth());
  const monthCount = deltaMonths + 1;

  if (!Number.isInteger(monthCount) || monthCount <= 0) {
    throw new Error('generated.mortgageInputs.endDateIso must be in or after startDateIso.');
  }

  return monthCount;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function formatEuro(amount) {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(isFiniteNumber(amount) ? amount : 0);
}

function formatPercent(decimal) {
  return `${(decimal * 100).toFixed(2)}%`;
}

function normalizeLoanKind(rawLoanKind, defaultLoanKind = 'mortgage') {
  const fallback = String(defaultLoanKind || 'mortgage').trim().toLowerCase() || 'mortgage';
  if (fallback !== 'mortgage' && fallback !== 'loan') {
    throw new Error('defaultLoanKind must be "mortgage" or "loan".');
  }

  if (typeof rawLoanKind === 'undefined' || rawLoanKind === null || String(rawLoanKind).trim() === '') {
    return fallback;
  }

  const normalized = String(rawLoanKind).trim().toLowerCase();
  if (normalized !== 'mortgage' && normalized !== 'loan') {
    throw new Error('generated.loanInputs.loanKind must be "mortgage" or "loan" when provided.');
  }

  return normalized;
}

function getLoanWording(loanKind) {
  const normalized = loanKind === 'loan' ? 'loan' : 'mortgage';
  return {
    noun: normalized,
    titleCase: normalized === 'loan' ? 'Loan' : 'Mortgage'
  };
}

export function normalizeMortgageInputs(raw, { defaultLoanKind = 'mortgage' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('generated.mortgageInputs must be an object.');
  }

  const currentBalance = requireFiniteNumber(raw.currentBalance, 'currentBalance');
  if (currentBalance <= 0) {
    throw new Error('generated.mortgageInputs.currentBalance must be greater than 0.');
  }

  const annualInterestRate = requireFiniteNumber(raw.annualInterestRate, 'annualInterestRate');
  if (annualInterestRate < 0) {
    throw new Error('generated.mortgageInputs.annualInterestRate must be greater than or equal to 0.');
  }

  const startDate = parseIsoDateStrict(raw.startDateIso, 'startDateIso');
  const startMonthDate = toMonthStartUtc(startDate);

  const hasEndDate = typeof raw.endDateIso === 'string' && raw.endDateIso.trim().length > 0;
  const hasRemainingTerm = typeof raw.remainingTermYears !== 'undefined' && raw.remainingTermYears !== null;

  if (!hasEndDate && !hasRemainingTerm) {
    throw new Error('generated.mortgageInputs must include endDateIso or remainingTermYears.');
  }

  let endMonthDate = null;
  let remainingTermYears = null;

  if (hasEndDate) {
    endMonthDate = toMonthStartUtc(parseIsoDateStrict(raw.endDateIso, 'endDateIso'));
    if (endMonthDate.getTime() < startMonthDate.getTime()) {
      throw new Error('generated.mortgageInputs.endDateIso must be in or after startDateIso.');
    }
  }

  if (hasRemainingTerm) {
    remainingTermYears = requireFiniteNumber(raw.remainingTermYears, 'remainingTermYears');
    if (remainingTermYears <= 0) {
      throw new Error('generated.mortgageInputs.remainingTermYears must be greater than 0.');
    }
  }

  const repaymentType = String(raw.repaymentType || '').trim();
  if (repaymentType !== 'repayment' && repaymentType !== 'interestOnly') {
    throw new Error('generated.mortgageInputs.repaymentType must be "repayment" or "interestOnly".');
  }

  if (repaymentType === 'interestOnly') {
    throw new Error('Interest-only mortgages are not supported in v1.');
  }

  let fixedPaymentAmount = null;
  if (raw.fixedPaymentAmount !== null && typeof raw.fixedPaymentAmount !== 'undefined') {
    fixedPaymentAmount = requireFiniteNumber(raw.fixedPaymentAmount, 'fixedPaymentAmount');
    if (fixedPaymentAmount <= 0) {
      throw new Error('generated.mortgageInputs.fixedPaymentAmount must be greater than 0 when provided.');
    }
  }

  const oneOffOverpayment = optionalFiniteNumber(raw.oneOffOverpayment, 0, 'oneOffOverpayment');
  if (oneOffOverpayment < 0) {
    throw new Error('generated.mortgageInputs.oneOffOverpayment must be greater than or equal to 0.');
  }

  const annualOverpayment = optionalFiniteNumber(raw.annualOverpayment, 0, 'annualOverpayment');
  if (annualOverpayment < 0) {
    throw new Error('generated.mortgageInputs.annualOverpayment must be greater than or equal to 0.');
  }

  const loanKind = normalizeLoanKind(raw.loanKind, defaultLoanKind);

  return {
    loanKind,
    currentBalance,
    annualInterestRate,
    startDateIso: formatIsoDateUtc(startDate),
    endDateIso: endMonthDate ? formatIsoDateUtc(endMonthDate) : null,
    remainingTermYears,
    repaymentType,
    fixedPaymentAmount,
    oneOffOverpayment,
    annualOverpayment
  };
}

function resolveTermMonths(inputs) {
  const startMonthDate = toMonthStartUtc(parseIsoDateStrict(inputs.startDateIso, 'startDateIso'));

  if (inputs.endDateIso) {
    const endMonthDate = toMonthStartUtc(parseIsoDateStrict(inputs.endDateIso, 'endDateIso'));
    return {
      monthCount: getInclusiveMonthCount(startMonthDate, endMonthDate),
      startMonthDate,
      endMonthDate
    };
  }

  const rawMonths = inputs.remainingTermYears * 12;
  const monthCount = Math.max(1, Math.round(rawMonths));
  return {
    monthCount,
    startMonthDate,
    endMonthDate: addUtcMonths(startMonthDate, monthCount - 1)
  };
}

export function computeMonthlyPayment(principal, annualInterestRate, monthCount) {
  if (!isFiniteNumber(principal) || principal < 0) {
    throw new Error('principal must be a finite number greater than or equal to 0.');
  }

  if (!isFiniteNumber(annualInterestRate) || annualInterestRate < 0) {
    throw new Error('annualInterestRate must be a finite number greater than or equal to 0.');
  }

  if (!Number.isInteger(monthCount) || monthCount <= 0) {
    throw new Error('monthCount must be a positive integer.');
  }

  if (principal === 0) {
    return 0;
  }

  const monthlyRate = annualInterestRate / 12;
  if (monthlyRate === 0) {
    return principal / monthCount;
  }

  return principal * monthlyRate / (1 - Math.pow(1 + monthlyRate, -monthCount));
}

function aggregateAnnualSchedule(monthlySchedule) {
  if (!Array.isArray(monthlySchedule) || monthlySchedule.length === 0) {
    return [];
  }

  const annual = [];
  let currentYear = null;
  let bucket = null;

  monthlySchedule.forEach((month) => {
    if (month.year !== currentYear) {
      if (bucket) {
        annual.push(bucket);
      }

      currentYear = month.year;
      bucket = {
        year: month.year,
        balanceStartRaw: month.balanceStart,
        principalPaidRaw: 0,
        interestPaidRaw: 0,
        totalPaidRaw: 0,
        balanceEndRaw: month.balanceEnd
      };
    }

    bucket.principalPaidRaw += month.principalPaid;
    bucket.interestPaidRaw += month.interestPaid;
    bucket.totalPaidRaw += month.totalPaid;
    bucket.balanceEndRaw = month.balanceEnd;
  });

  if (bucket) {
    annual.push(bucket);
  }

  return annual.map((row) => {
    const principalPaid = round2(row.principalPaidRaw);
    const interestPaid = round2(row.interestPaidRaw);

    return {
      ...row,
      balanceStart: round2(row.balanceStartRaw),
      principalPaid,
      interestPaid,
      totalPaid: round2(principalPaid + interestPaid),
      balanceEnd: round2(row.balanceEndRaw)
    };
  });
}

export function computeAmortizationMonthlySchedule(rawInputs, options = {}) {
  const inputs = normalizeMortgageInputs(rawInputs, options);
  const term = resolveTermMonths(inputs);
  const monthlyRate = inputs.annualInterestRate / 12;

  const openingBalance = Math.max(0, inputs.currentBalance - inputs.oneOffOverpayment);
  const monthlyPaymentUsed = inputs.fixedPaymentAmount === null
    ? computeMonthlyPayment(openingBalance, inputs.annualInterestRate, term.monthCount)
    : inputs.fixedPaymentAmount;

  const monthlySchedule = [];
  let balance = openingBalance;

  for (let monthIndex = 0; monthIndex < term.monthCount && balance > 0; monthIndex += 1) {
    const periodDate = addUtcMonths(term.startMonthDate, monthIndex);
    const year = periodDate.getUTCFullYear();

    const balanceStart = balance;
    const interestPaid = balanceStart * monthlyRate;
    let principalPaid = monthlyPaymentUsed - interestPaid;

    if (principalPaid <= 0) {
      throw new Error('Negative amortisation: payment is too low to cover monthly interest.');
    }

    principalPaid = Math.min(principalPaid, balanceStart);
    let totalPaid = interestPaid + principalPaid;
    balance = balanceStart - principalPaid;

    const nextDate = monthIndex + 1 < term.monthCount
      ? addUtcMonths(term.startMonthDate, monthIndex + 1)
      : null;
    const isYearEnd = !nextDate || nextDate.getUTCFullYear() !== year;

    let annualOverpaymentApplied = 0;
    if (isYearEnd && inputs.annualOverpayment > 0 && balance > 0) {
      annualOverpaymentApplied = Math.min(inputs.annualOverpayment, balance);
      principalPaid += annualOverpaymentApplied;
      totalPaid += annualOverpaymentApplied;
      balance -= annualOverpaymentApplied;
    }

    monthlySchedule.push({
      monthIndex,
      dateIso: formatIsoDateUtc(periodDate),
      year,
      balanceStart,
      interestPaid,
      principalPaid,
      totalPaid,
      annualOverpaymentApplied,
      balanceEnd: balance
    });
  }

  const totalInterestLifetime = monthlySchedule.reduce((sum, month) => sum + month.interestPaid, 0);
  const totalPrincipalLifetime = monthlySchedule.reduce((sum, month) => sum + month.principalPaid, 0);
  const totalPaidLifetime = monthlySchedule.reduce((sum, month) => sum + month.totalPaid, 0);

  const payoffMonth = balance <= 0 && monthlySchedule.length > 0
    ? monthlySchedule[monthlySchedule.length - 1]
    : null;

  return {
    inputs,
    startMonthIso: formatIsoDateUtc(term.startMonthDate),
    endMonthIso: formatIsoDateUtc(term.endMonthDate),
    termMonthsPlanned: term.monthCount,
    monthlyRate,
    monthlyPaymentUsed,
    openingBalance,
    balanceRemaining: balance,
    monthsSimulated: monthlySchedule.length,
    payoffDateIso: payoffMonth ? payoffMonth.dateIso : null,
    payoffYear: payoffMonth ? payoffMonth.year : null,
    totalInterestLifetime,
    totalPrincipalLifetime,
    totalPaidLifetime,
    monthlySchedule,
    annualSchedule: aggregateAnnualSchedule(monthlySchedule)
  };
}

export function computeMortgageProjection(rawInputs, options = {}) {
  const projection = computeAmortizationMonthlySchedule(rawInputs, options);
  const annualSchedule = projection.annualSchedule;
  const wording = getLoanWording(projection.inputs.loanKind);
  const currentBalanceLabel = wording.noun === 'loan' ? 'Current loan balance' : 'Current balance';
  const termLabel = `${wording.titleCase} term`;
  const termEndLabel = wording.noun === 'loan'
    ? 'Remaining loan balance at term end'
    : 'Remaining balance at term end';

  const fallbackYear = parseIsoDateStrict(projection.inputs.startDateIso, 'startDateIso').getUTCFullYear();
  const labels = annualSchedule.length > 0
    ? annualSchedule.map((row) => String(row.year))
    : [String(fallbackYear)];

  const balanceSeries = annualSchedule.length > 0
    ? annualSchedule.map((row) => row.balanceEndRaw)
    : [0];
  const principalSeries = annualSchedule.length > 0
    ? annualSchedule.map((row) => row.principalPaidRaw)
    : [0];
  const interestSeries = annualSchedule.length > 0
    ? annualSchedule.map((row) => row.interestPaidRaw)
    : [0];

  const assumptionsTable = {
    columns: ['Assumption', 'Value', 'Notes'],
    rows: [
      [currentBalanceLabel, formatEuro(projection.inputs.currentBalance), 'Balance before any overpayment'],
      ['One-off overpayment', formatEuro(projection.inputs.oneOffOverpayment), 'Applied immediately at start'],
      ['Opening balance used', formatEuro(projection.openingBalance), 'Starting balance for amortisation maths'],
      ['Annual interest rate', formatPercent(projection.inputs.annualInterestRate), 'Monthly compounding used internally'],
      [termLabel, `${projection.termMonthsPlanned} months`, `${projection.startMonthIso} to ${projection.endMonthIso}`],
      ['Repayment type', projection.inputs.repaymentType, 'V1 supports amortising repayment only'],
      ['Annual overpayment', formatEuro(projection.inputs.annualOverpayment), 'Applied at each calendar year-end'],
      ['Monthly payment source', projection.inputs.fixedPaymentAmount === null ? 'Calculated' : 'Fixed input', 'Payment frequency fixed to monthly']
    ]
  };

  const payoffLabel = projection.payoffYear ? String(projection.payoffYear) : 'Not paid off within modelled term';
  const outputsTable = {
    columns: ['Metric', 'Value', 'Notes'],
    rows: [
      ['Monthly payment used', formatEuro(projection.monthlyPaymentUsed), projection.inputs.fixedPaymentAmount === null ? 'Derived from amortisation formula' : 'Provided via fixedPaymentAmount'],
      ['Payoff year', payoffLabel, projection.payoffYear ? 'Based on modelled schedule' : 'Balance remains after final modelled month'],
      ['Total interest (lifetime)', formatEuro(projection.totalInterestLifetime), `${projection.monthsSimulated} simulated months`],
      ['Total paid (lifetime)', formatEuro(projection.totalPaidLifetime), 'Principal + interest + annual overpayments'],
      [termEndLabel, formatEuro(projection.balanceRemaining), projection.balanceRemaining > 0 ? 'Outstanding after modelled term' : `${wording.titleCase} fully repaid`]
    ]
  };

  const charts = [
    {
      id: 'mortgage-mixed-annual',
      title: `${wording.titleCase} Balance and Annual Repayment Split`,
      type: 'bar',
      labels,
      datasets: [
        {
          label: 'Remaining balance',
          data: balanceSeries
        },
        {
          label: 'Principal repaid (annual)',
          data: principalSeries
        },
        {
          label: 'Interest paid (annual)',
          data: interestSeries
        }
      ]
    }
  ];

  const summarySentences = [
    `Monthly repayments are modelled from an opening ${wording.noun} balance of ${formatEuro(projection.openingBalance)} at ${formatPercent(projection.inputs.annualInterestRate)} interest.`,
    `The payment used is ${formatEuro(projection.monthlyPaymentUsed)} per month, with annual overpayments of ${formatEuro(projection.inputs.annualOverpayment)} applied at each year-end.`,
    projection.payoffYear
      ? `On this path the ${wording.noun} is projected to be fully repaid in ${projection.payoffYear}.`
      : `On this path the ${wording.noun} is not fully repaid by ${projection.endMonthIso}, leaving ${formatEuro(projection.balanceRemaining)} outstanding.`,
    `Total lifetime interest is ${formatEuro(projection.totalInterestLifetime)} and total paid is ${formatEuro(projection.totalPaidLifetime)}.`
  ];

  return {
    assumptionsTable,
    outputsTable,
    charts,
    summaryHtml: `<p>${summarySentences.join(' ')}</p>`,
    debug: {
      monthsPlanned: projection.termMonthsPlanned,
      monthsSimulated: projection.monthsSimulated,
      paymentUsedMonthly: projection.monthlyPaymentUsed,
      openingBalance: projection.openingBalance,
      payoffYear: projection.payoffYear,
      totalInterestLifetime: projection.totalInterestLifetime,
      totalPaidLifetime: projection.totalPaidLifetime,
      annualSchedule
    }
  };
}
