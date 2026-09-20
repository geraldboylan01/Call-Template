import { MAX_MODULE_SCENARIO_CASES } from './scenario_cap.js';

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

/**
 * WHEN A DEBT IS SETTLED.
 *
 * Money is measured to the cent, so a balance of 0.00000000012 is not an
 * outstanding mortgage -- it is the residue of adding three hundred floats
 * together. Payoff detection required the balance to reach exactly zero, which
 * float arithmetic reaches only by luck: across 250,000 borrowed over 25 years
 * at rates from 1% to 6%, half of the runs came out non-zero and every one of
 * those told the client, in prose, that the mortgage would NOT be repaid --
 * on the same screen as "Remaining balance at term end: 0.00".
 *
 * Half a cent is the threshold because nothing smaller can be owed.
 */
const SETTLEMENT_EPSILON = 0.005;

/**
 * WHO KEEPS THE BENEFIT OF A CAPITAL REDUCTION.
 *
 * An Irish lender asks the borrower which they want, and the two answers are
 * worth very different amounts of money:
 *
 *   shorterTerm  -- the repayment stays at the contractual figure and the loan
 *                   finishes early. More interest saved.
 *   lowerPayment -- the term stays and the repayment is re-amortised down.
 *                   Cash-flow relief now, far less interest saved.
 *
 * This is DEFAULTED, NOT INFERRED. The engine used to derive the payment from
 * the balance after the lump sum, which silently chose `lowerPayment` for every
 * lump sum ever modelled -- so a lump sum showed no time saved at all and sat
 * on screen beside a regular overpayment that did shorten the term. The two
 * were measured on different bases and could not be compared.
 */
const OVERPAYMENT_BENEFITS = Object.freeze(['shorterTerm', 'lowerPayment']);
const DEFAULT_OVERPAYMENT_BENEFIT = 'shorterTerm';

/** Keys a case may restate. Everything else it inherits from the loan itself. */
const SCENARIO_OVERRIDE_KEYS = Object.freeze([
  'oneOffOverpayment',
  'oneOffOverpaymentMonth',
  'annualOverpayment',
  'fixedPaymentAmount',
  'annualInterestRate',
  'overpaymentBenefit'
]);

/** `2026-01-01` + 24 -> `2028-01-01`. Month arithmetic on an ISO month start. */
function addMonthsToIso(iso, months) {
  return formatIsoDateUtc(addUtcMonths(toMonthStartUtc(parseIsoDateStrict(iso, 'startMonthIso')), months));
}

function formatEuro(amount) {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(isFiniteNumber(amount) ? amount : 0);
}

/** Money for a headline, where cents are noise. */
function formatEuroWhole(amount) {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(isFiniteNumber(amount) ? amount : 0);
}

function formatPercent(decimal) {
  return `${(decimal * 100).toFixed(2)}%`;
}

const MONTH_NAMES = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
]);

/** `2049-05-01` -> `May 2049`. A payoff date is read, not parsed. */
export function formatMonthYear(isoDate) {
  if (typeof isoDate !== 'string') {
    return '';
  }

  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(isoDate.trim());
  if (!match) {
    return '';
  }

  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    return '';
  }

  return `${MONTH_NAMES[monthIndex]} ${match[1]}`;
}

/** `43` -> `3 yrs 7 mths`. Clients hear years, not months. */
export function formatMonthsDuration(months) {
  if (!isFiniteNumber(months) || Math.round(months) <= 0) {
    return 'None';
  }

  const total = Math.round(months);
  const years = Math.floor(total / 12);
  const remainder = total % 12;
  const parts = [];

  if (years > 0) {
    parts.push(`${years} ${years === 1 ? 'yr' : 'yrs'}`);
  }
  if (remainder > 0) {
    parts.push(`${remainder} ${remainder === 1 ? 'mth' : 'mths'}`);
  }

  return parts.join(' ');
}

/**
 * `98` -> `8 years 2 months`. The same duration, spelled out.
 *
 * Abbreviations belong in a table column, where the header carries the meaning
 * and the width is scarce. In a sentence a client reads aloud -- "8 years 2
 * months sooner than December 2052" -- "8 yrs 2 mths" is a form to be decoded
 * rather than a length of time to be felt.
 */
export function formatMonthsDurationLong(months) {
  if (!isFiniteNumber(months) || Math.round(months) <= 0) {
    return 'None';
  }

  const total = Math.round(months);
  const years = Math.floor(total / 12);
  const remainder = total % 12;
  const parts = [];

  if (years > 0) {
    parts.push(`${years} ${years === 1 ? 'year' : 'years'}`);
  }
  if (remainder > 0) {
    parts.push(`${remainder} ${remainder === 1 ? 'month' : 'months'}`);
  }

  return parts.join(' ');
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

function normalizeOverpaymentBenefit(value, fallback, fieldName) {
  if (typeof value === 'undefined' || value === null || String(value).trim() === '') {
    return fallback;
  }

  const normalized = String(value).trim();
  if (!OVERPAYMENT_BENEFITS.includes(normalized)) {
    throw new Error(
      `generated.mortgageInputs.${fieldName} must be "shorterTerm" or "lowerPayment" when provided.`
    );
  }

  return normalized;
}

/**
 * WHEN THE LUMP SUM LANDS, counted in whole months from the start of the schedule.
 *
 * 0 means it is already paid, so it comes off the opening balance and the
 * schedule never charges interest on it. Anything higher is a lump sum the
 * client has not paid yet: the loan runs at its contractual repayment until
 * that month, and only then does the balance drop. The difference is the whole
 * point of the timing control -- the same euro removes less interest the
 * longer it waits, because it has fewer months and a smaller balance to work
 * against.
 */
function normalizeOverpaymentMonth(value, fieldName) {
  const months = optionalFiniteNumber(value, 0, fieldName);
  if (months < 0) {
    throw new Error(`generated.mortgageInputs.${fieldName} must be greater than or equal to 0.`);
  }
  if (!Number.isInteger(months)) {
    throw new Error(`generated.mortgageInputs.${fieldName} must be a whole number of months.`);
  }

  return months;
}

function normalizeScenarioId(value, fallback, fieldName) {
  if (typeof value === 'undefined' || value === null || String(value).trim() === '') {
    if (fallback === null) {
      throw new Error(`generated.mortgageInputs.${fieldName} must be a non-empty string.`);
    }
    return fallback;
  }

  return String(value).trim();
}

function has(raw, key) {
  return Object.prototype.hasOwnProperty.call(raw, key)
    && typeof raw[key] !== 'undefined';
}

/**
 * One comparison case.
 *
 * A case carries ONLY what it restates. Everything absent is inherited at
 * resolution time, so a case that changes nothing but the annual overpayment
 * says exactly that, and a later change to the loan's rate reaches every case
 * that did not override it.
 */
function normalizeMortgageScenario(rawCase, index) {
  const label = `scenarios[${index}]`;
  if (!rawCase || typeof rawCase !== 'object' || Array.isArray(rawCase)) {
    throw new Error(`generated.mortgageInputs.${label} must be an object.`);
  }

  const id = normalizeScenarioId(rawCase.id, `case-${index + 1}`, `${label}.id`);
  const title = typeof rawCase.title === 'string' && rawCase.title.trim()
    ? rawCase.title.trim()
    : `Case ${index + 1}`;
  const description = typeof rawCase.description === 'string' && rawCase.description.trim()
    ? rawCase.description.trim()
    : (typeof rawCase.interpretation === 'string' ? rawCase.interpretation.trim() : '');

  // THIS NORMALISER MUST BE IDEMPOTENT.
  //
  // An authored case states its changes flat -- `{ id, annualOverpayment }` --
  // but this function returns them nested under `overrides`, and the app stores
  // what this function returned. Every later render, and every session reload,
  // normalises that stored shape again. Reading only the flat keys would find
  // none the second time round and quietly return a case that changes nothing:
  // four buttons, four identical answers, and no error anywhere.
  const rawScenario = rawCase.overrides && typeof rawCase.overrides === 'object'
    && !Array.isArray(rawCase.overrides)
    ? rawCase.overrides
    : rawCase;

  const overrides = {};

  if (has(rawScenario, 'oneOffOverpayment')) {
    const amount = optionalFiniteNumber(rawScenario.oneOffOverpayment, 0, `${label}.oneOffOverpayment`);
    if (amount < 0) {
      throw new Error(`generated.mortgageInputs.${label}.oneOffOverpayment must be greater than or equal to 0.`);
    }
    overrides.oneOffOverpayment = amount;
  }

  if (has(rawScenario, 'oneOffOverpaymentMonth')) {
    overrides.oneOffOverpaymentMonth = normalizeOverpaymentMonth(
      rawScenario.oneOffOverpaymentMonth,
      `${label}.oneOffOverpaymentMonth`
    );
  }

  if (has(rawScenario, 'annualOverpayment')) {
    const amount = optionalFiniteNumber(rawScenario.annualOverpayment, 0, `${label}.annualOverpayment`);
    if (amount < 0) {
      throw new Error(`generated.mortgageInputs.${label}.annualOverpayment must be greater than or equal to 0.`);
    }
    overrides.annualOverpayment = amount;
  }

  if (has(rawScenario, 'fixedPaymentAmount')) {
    if (rawScenario.fixedPaymentAmount === null) {
      overrides.fixedPaymentAmount = null;
    } else {
      const amount = requireFiniteNumber(rawScenario.fixedPaymentAmount, `${label}.fixedPaymentAmount`);
      if (amount <= 0) {
        throw new Error(`generated.mortgageInputs.${label}.fixedPaymentAmount must be greater than 0 when provided.`);
      }
      overrides.fixedPaymentAmount = amount;
    }
  }

  if (has(rawScenario, 'annualInterestRate')) {
    const rate = requireFiniteNumber(rawScenario.annualInterestRate, `${label}.annualInterestRate`);
    if (rate < 0) {
      throw new Error(`generated.mortgageInputs.${label}.annualInterestRate must be greater than or equal to 0.`);
    }
    overrides.annualInterestRate = rate;
  }

  if (has(rawScenario, 'overpaymentBenefit')) {
    overrides.overpaymentBenefit = normalizeOverpaymentBenefit(
      rawScenario.overpaymentBenefit,
      DEFAULT_OVERPAYMENT_BENEFIT,
      `${label}.overpaymentBenefit`
    );
  }

  // The term is one fact expressed two ways, so a case restates it as a PAIR.
  // Overriding only `endDateIso` while the loan carries `remainingTermYears`
  // would leave both set, and the engine would silently prefer the end date.
  const hasEndDate = has(rawScenario, 'endDateIso') && rawScenario.endDateIso !== null;
  const hasRemainingTerm = has(rawScenario, 'remainingTermYears') && rawScenario.remainingTermYears !== null;

  if (hasEndDate && hasRemainingTerm) {
    throw new Error(
      `generated.mortgageInputs.${label} must provide at most one of endDateIso or remainingTermYears.`
    );
  }

  if (hasEndDate) {
    const endMonthDate = toMonthStartUtc(parseIsoDateStrict(rawScenario.endDateIso, `${label}.endDateIso`));
    overrides.endDateIso = formatIsoDateUtc(endMonthDate);
    overrides.remainingTermYears = null;
  }

  if (hasRemainingTerm) {
    const years = requireFiniteNumber(rawScenario.remainingTermYears, `${label}.remainingTermYears`);
    if (years <= 0) {
      throw new Error(`generated.mortgageInputs.${label}.remainingTermYears must be greater than 0.`);
    }
    overrides.remainingTermYears = years;
    overrides.endDateIso = null;
  }

  return { id, title, description, overrides };
}

function normalizeMortgageScenarios(rawScenarios) {
  if (typeof rawScenarios === 'undefined' || rawScenarios === null) {
    return null;
  }

  if (!Array.isArray(rawScenarios)) {
    throw new Error('generated.mortgageInputs.scenarios must be an array when provided.');
  }

  if (rawScenarios.length === 0) {
    return null;
  }

  if (rawScenarios.length > MAX_MODULE_SCENARIO_CASES) {
    throw new Error(
      `generated.mortgageInputs.scenarios supports at most ${MAX_MODULE_SCENARIO_CASES} cases; `
      + `received ${rawScenarios.length}.`
    );
  }

  const usedIds = new Set();
  return rawScenarios.map((rawScenario, index) => {
    const scenario = normalizeMortgageScenario(rawScenario, index);
    if (usedIds.has(scenario.id)) {
      throw new Error(`generated.mortgageInputs.scenarios[${index}].id must be unique.`);
    }
    usedIds.add(scenario.id);
    return scenario;
  });
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

  const oneOffOverpaymentMonth = normalizeOverpaymentMonth(
    raw.oneOffOverpaymentMonth,
    'oneOffOverpaymentMonth'
  );

  const annualOverpayment = optionalFiniteNumber(raw.annualOverpayment, 0, 'annualOverpayment');
  if (annualOverpayment < 0) {
    throw new Error('generated.mortgageInputs.annualOverpayment must be greater than or equal to 0.');
  }

  const overpaymentBenefit = normalizeOverpaymentBenefit(
    raw.overpaymentBenefit,
    DEFAULT_OVERPAYMENT_BENEFIT,
    'overpaymentBenefit'
  );

  const loanKind = normalizeLoanKind(raw.loanKind, defaultLoanKind);
  const scenarios = normalizeMortgageScenarios(raw.scenarios);

  let baseScenarioId = null;
  if (scenarios) {
    const requested = typeof raw.baseScenarioId === 'string' ? raw.baseScenarioId.trim() : '';
    if (requested && !scenarios.some((scenario) => scenario.id === requested)) {
      throw new Error('generated.mortgageInputs.baseScenarioId must match a scenario id.');
    }
    baseScenarioId = requested || scenarios[0].id;
  }

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
    oneOffOverpaymentMonth,
    annualOverpayment,
    overpaymentBenefit,
    baseScenarioId,
    scenarios
  };
}

/** The loan as one case sees it: inherited facts, with that case's changes applied. */
function resolveScenarioInputs(inputs, scenario) {
  const resolved = {
    loanKind: inputs.loanKind,
    currentBalance: inputs.currentBalance,
    annualInterestRate: inputs.annualInterestRate,
    startDateIso: inputs.startDateIso,
    endDateIso: inputs.endDateIso,
    remainingTermYears: inputs.remainingTermYears,
    repaymentType: inputs.repaymentType,
    fixedPaymentAmount: inputs.fixedPaymentAmount,
    oneOffOverpayment: inputs.oneOffOverpayment,
    oneOffOverpaymentMonth: inputs.oneOffOverpaymentMonth,
    annualOverpayment: inputs.annualOverpayment,
    overpaymentBenefit: inputs.overpaymentBenefit
  };

  if (scenario) {
    Object.assign(resolved, scenario.overrides);
  }

  return resolved;
}

/** Every case this payload describes, in payload order. A bare loan is one case. */
function getScenarioList(inputs) {
  if (Array.isArray(inputs.scenarios) && inputs.scenarios.length > 0) {
    return inputs.scenarios;
  }

  return [{
    id: 'base',
    title: getLoanWording(inputs.loanKind).titleCase === 'Loan' ? 'Current loan' : 'Current mortgage',
    description: '',
    overrides: {}
  }];
}

function resolveBaseScenario(inputs, scenarios) {
  if (inputs.baseScenarioId) {
    const match = scenarios.find((scenario) => scenario.id === inputs.baseScenarioId);
    if (match) {
      return match;
    }
  }

  return scenarios[0];
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
  const { scenarioId, ...normalizeOptions } = options;
  const normalized = normalizeMortgageInputs(rawInputs, normalizeOptions);
  const scenarios = getScenarioList(normalized);
  const selected = scenarios.find((scenario) => scenario.id === scenarioId)
    || resolveBaseScenario(normalized, scenarios);
  const inputs = resolveScenarioInputs(normalized, selected);
  const term = resolveTermMonths(inputs);
  const monthlyRate = inputs.annualInterestRate / 12;

  // A lump sum that is already paid comes off before the first month's
  // interest is charged. One that is still to be paid does not: the loan runs
  // at its contractual repayment until the month it lands, which is why the
  // opening balance below is untouched when `oneOffOverpaymentMonth` is set.
  const lumpSumMonth = Math.min(inputs.oneOffOverpaymentMonth, term.monthCount);
  const lumpSumPaidUpfront = lumpSumMonth === 0;
  const upfrontLumpSum = lumpSumPaidUpfront
    ? Math.min(inputs.oneOffOverpayment, inputs.currentBalance)
    : 0;
  const openingBalance = Math.max(0, inputs.currentBalance - upfrontLumpSum);

  // The contractual payment is the one the loan agreement already sets: it is
  // derived from the balance BEFORE any overpayment, because a lump sum the
  // client has not paid yet cannot be what their repayment was calculated on.
  const contractualPayment = inputs.fixedPaymentAmount === null
    ? computeMonthlyPayment(inputs.currentBalance, inputs.annualInterestRate, term.monthCount)
    : inputs.fixedPaymentAmount;

  const takesLowerPayment = inputs.fixedPaymentAmount === null
    && inputs.overpaymentBenefit === 'lowerPayment';
  const openingPayment = takesLowerPayment && lumpSumPaidUpfront
    ? computeMonthlyPayment(openingBalance, inputs.annualInterestRate, term.monthCount)
    : contractualPayment;

  const monthlySchedule = [];
  let balance = openingBalance;
  // Re-amortising at a deferred lump sum changes the payment part-way through,
  // so the payment is a running value rather than one figure for the schedule.
  let payment = openingPayment;
  let paymentOverpaymentTotal = 0;
  let annualOverpaymentTotal = 0;
  let lumpSumApplied = upfrontLumpSum;

  for (let monthIndex = 0; monthIndex < term.monthCount && balance > SETTLEMENT_EPSILON; monthIndex += 1) {
    const periodDate = addUtcMonths(term.startMonthDate, monthIndex);
    const year = periodDate.getUTCFullYear();

    const balanceStart = balance;
    const interestPaid = balanceStart * monthlyRate;
    let principalPaid = payment - interestPaid;

    if (principalPaid <= 0) {
      throw new Error('Negative amortisation: payment is too low to cover monthly interest.');
    }

    principalPaid = Math.min(principalPaid, balanceStart);
    let totalPaid = interestPaid + principalPaid;
    balance = balanceStart - principalPaid;

    // What the client put in above the contractual repayment this month. The
    // final month is clipped to the balance, so this is measured from what was
    // actually paid rather than from the headline payment.
    //
    // Thresholded for the same reason a balance is: subtracting two floats that
    // should be equal leaves a residue, and three hundred of those residues
    // added up is enough to report a client who overpaid nothing as having
    // "paid in" a sum, and to divide their interest saved by it.
    const paymentDifference = totalPaid - contractualPayment;
    const paymentOverpayment = paymentDifference > SETTLEMENT_EPSILON ? paymentDifference : 0;
    paymentOverpaymentTotal += paymentOverpayment;

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
      annualOverpaymentTotal += annualOverpaymentApplied;
    }

    // The deferred lump sum lands here, after this month's repayment, in the
    // month the client said they would pay it.
    let lumpSumAppliedThisMonth = 0;
    if (!lumpSumPaidUpfront && monthIndex + 1 === lumpSumMonth && balance > 0) {
      lumpSumAppliedThisMonth = Math.min(inputs.oneOffOverpayment, balance);
      principalPaid += lumpSumAppliedThisMonth;
      totalPaid += lumpSumAppliedThisMonth;
      balance -= lumpSumAppliedThisMonth;
      lumpSumApplied += lumpSumAppliedThisMonth;

      // Keeping the term means re-amortising what is left over the months that
      // remain. Without this the lower-payment case would go on paying the
      // contractual figure and clear early, which is the other case entirely.
      if (takesLowerPayment && balance > SETTLEMENT_EPSILON) {
        const monthsLeft = term.monthCount - lumpSumMonth;
        if (monthsLeft > 0) {
          payment = computeMonthlyPayment(balance, inputs.annualInterestRate, monthsLeft);
        }
      }
    }

    monthlySchedule.push({
      monthIndex,
      dateIso: formatIsoDateUtc(periodDate),
      year,
      balanceStart,
      interestPaid,
      principalPaid,
      totalPaid,
      paymentOverpayment,
      annualOverpaymentApplied,
      lumpSumApplied: lumpSumAppliedThisMonth,
      paymentThisMonth: payment,
      balanceEnd: balance
    });
  }

  const totalInterestLifetime = monthlySchedule.reduce((sum, month) => sum + month.interestPaid, 0);
  const totalPrincipalLifetime = monthlySchedule.reduce((sum, month) => sum + month.principalPaid, 0);
  const totalPaidLifetime = monthlySchedule.reduce((sum, month) => sum + month.totalPaid, 0);

  // Settled is settled: report nothing outstanding rather than a fraction of a
  // cent that the display rounds to zero while the prose calls it a debt.
  if (balance <= SETTLEMENT_EPSILON) balance = 0;

  // A DEBT CLEARED OUTRIGHT IS CLEARED, NOT UNREPAID.
  //
  // A lump sum big enough to settle the whole balance leaves the loop with
  // nothing to do, so the schedule is empty -- and payoff detection used to
  // read an empty schedule as "never repaid". The client who just cleared
  // their mortgage was told, in the same table row, that it saved them nine
  // years and that it was "not within the mortgage term". Settling on day one
  // is settling in the first month of the schedule.
  const settled = balance <= 0;
  const payoffDateIso = !settled
    ? null
    : (monthlySchedule.length > 0
      ? monthlySchedule[monthlySchedule.length - 1].dateIso
      : formatIsoDateUtc(term.startMonthDate));
  const payoffYear = payoffDateIso
    ? Number(payoffDateIso.slice(0, 4))
    : null;

  return {
    inputs,
    scenarioId: selected.id,
    scenarioTitle: selected.title,
    scenarioDescription: selected.description,
    startMonthIso: formatIsoDateUtc(term.startMonthDate),
    endMonthIso: formatIsoDateUtc(term.endMonthDate),
    termMonthsPlanned: term.monthCount,
    monthlyRate,
    contractualPayment,
    // What leaves the account each month. A deferred re-amortisation changes
    // it part-way through, so this reports the figure the client ends up on.
    monthlyPaymentUsed: payment,
    openingPayment,
    overpaymentBenefit: inputs.overpaymentBenefit,
    openingBalance,
    lumpSumApplied,
    lumpSumMonth,
    annualOverpaymentTotal,
    paymentOverpaymentTotal,
    totalOverpaid: lumpSumApplied + annualOverpaymentTotal + paymentOverpaymentTotal,
    balanceRemaining: balance,
    monthsSimulated: monthlySchedule.length,
    payoffDateIso,
    payoffYear,
    totalInterestLifetime,
    totalPrincipalLifetime,
    totalPaidLifetime,
    monthlySchedule,
    annualSchedule: aggregateAnnualSchedule(monthlySchedule)
  };
}

/**
 * What each case is worth, measured against the base.
 *
 * The base is whichever case the payload nominates -- usually "no overpayment",
 * but a household that already overpays should see the next step measured from
 * where they actually stand, not from a position they left years ago.
 */
export function computeMortgageComparison(rawInputs, options = {}) {
  const { scenarioId: _ignored, oneOffOverpaymentMonth, ...normalizeOptions } = options;
  // MOVING THE LUMP SUM MOVES IT IN EVERY CASE AT ONCE.
  //
  // The timing control asks one question -- when would you pay it -- and the
  // answer has to apply to the whole case set, or two cases on the same screen
  // would be answering it differently.
  const timedInputs = Number.isFinite(oneOffOverpaymentMonth)
    ? withLumpSumMonth(rawInputs, oneOffOverpaymentMonth)
    : rawInputs;
  const normalized = normalizeMortgageInputs(timedInputs, normalizeOptions);
  const scenarios = getScenarioList(normalized);
  const baseScenario = resolveBaseScenario(normalized, scenarios);

  const projections = new Map(scenarios.map((scenario) => [
    scenario.id,
    computeAmortizationMonthlySchedule(timedInputs, { ...normalizeOptions, scenarioId: scenario.id })
  ]));

  const baseProjection = projections.get(baseScenario.id);

  const cases = scenarios.map((scenario) => {
    const projection = projections.get(scenario.id);
    const isBase = scenario.id === baseScenario.id;
    const interestSaved = baseProjection.totalInterestLifetime - projection.totalInterestLifetime;
    const monthsSaved = baseProjection.monthsSimulated - projection.monthsSimulated;
    const totalOverpaid = projection.totalOverpaid;

    return {
      id: scenario.id,
      title: scenario.title,
      description: scenario.description,
      isBase,
      projection,
      monthlyPaymentUsed: projection.monthlyPaymentUsed,
      paymentDelta: projection.monthlyPaymentUsed - baseProjection.monthlyPaymentUsed,
      payoffDateIso: projection.payoffDateIso,
      payoffYear: projection.payoffYear,
      monthsSimulated: projection.monthsSimulated,
      balanceRemaining: projection.balanceRemaining,
      totalInterestLifetime: projection.totalInterestLifetime,
      totalPaidLifetime: projection.totalPaidLifetime,
      totalOverpaid,
      interestSaved: isBase ? 0 : interestSaved,
      monthsSaved: isBase ? 0 : monthsSaved,
      // A case that saves interest without overpaying -- a rate switch, a
      // re-term -- has no euro to divide by, and inventing one would dress a
      // different decision up as a return on the client's cash.
      savedPerEuroOverpaid: !isBase && totalOverpaid > SETTLEMENT_EPSILON
        ? interestSaved / totalOverpaid
        : null
    };
  });

  const hasScenarios = Array.isArray(normalized.scenarios) && normalized.scenarios.length > 1;
  const comparison = {
    baseScenarioId: baseScenario.id,
    baseCase: cases.find((item) => item.isBase) || cases[0],
    cases,
    hasScenarios,
    termMonths: resolveTermMonths(resolveScenarioInputs(normalized, baseScenario)).monthCount,
    startDateIso: normalized.startDateIso,
    loanKind: normalized.loanKind,
    lumpSumMonth: baseProjection.lumpSumMonth,
    contractualPayment: baseProjection.contractualPayment
  };

  // The other thing a lump sum can do. Derived rather than authored, because
  // it is the same money answering a different question, and a client who is
  // told what overpaying buys them will ask it.
  comparison.repaymentReduction = buildRepaymentReductionVariant(
    timedInputs,
    normalizeOptions,
    comparison
  );

  // Built here rather than by the caller so the side-by-side table and the
  // per-case figures can never disagree about what a case is worth.
  comparison.comparisonTable = hasScenarios
    ? buildComparisonTable(comparison, getLoanWording(normalized.loanKind))
    : null;

  return comparison;
}

/** The same payload with every lump sum moved to one month. */
function withLumpSumMonth(rawInputs, month) {
  const next = { ...rawInputs, oneOffOverpaymentMonth: month };
  if (Array.isArray(rawInputs?.scenarios)) {
    next.scenarios = rawInputs.scenarios.map((scenario) => {
      // Idempotent normalisation means a stored case nests its changes under
      // `overrides`, and an authored one states them flat. Both have to move.
      if (scenario?.overrides && typeof scenario.overrides === 'object' && !Array.isArray(scenario.overrides)) {
        return { ...scenario, overrides: { ...scenario.overrides, oneOffOverpaymentMonth: month } };
      }
      return { ...scenario, oneOffOverpaymentMonth: month };
    });
  }

  return next;
}

/**
 * KEEP THE TERM AND LOWER THE REPAYMENT: the same lump sum, spent differently.
 *
 * Modelled from whichever case puts in the largest lump sum, because that is
 * the one the client is weighing. It is null when no case has a lump sum --
 * a yearly amount cannot be re-amortised into a lower repayment, and offering
 * the comparison anyway would invent a decision nobody is facing.
 */
function buildRepaymentReductionVariant(rawInputs, normalizeOptions, comparison) {
  // Largest lump sum first, and where two cases put in the same lump, the one
  // that puts in nothing else. This section's whole claim is "the same money,
  // spent the other way", so the case it is measured against has to differ
  // from it in exactly one respect: what the lender did with the lump sum.
  const shorterTermCase = comparison.cases
    .filter((item) => !item.isBase && item.projection.lumpSumApplied > SETTLEMENT_EPSILON)
    .sort((left, right) => (
      (right.projection.lumpSumApplied - left.projection.lumpSumApplied)
      || ((left.totalOverpaid - left.projection.lumpSumApplied)
        - (right.totalOverpaid - right.projection.lumpSumApplied))
    ))[0];

  if (!shorterTermCase) {
    return null;
  }

  const lumpSum = shorterTermCase.projection.lumpSumApplied;
  const lumpSumMonth = shorterTermCase.projection.lumpSumMonth;
  const baseProjection = comparison.baseCase.projection;

  // Same lump, same month, but the annual amount is dropped: this section is
  // about one decision, and carrying a yearly overpayment into it would make
  // the repayment it reports one the client never agreed to.
  const projection = computeAmortizationMonthlySchedule({
    ...rawInputs,
    scenarios: null,
    baseScenarioId: null,
    oneOffOverpayment: lumpSum,
    oneOffOverpaymentMonth: lumpSumMonth,
    annualOverpayment: 0,
    overpaymentBenefit: 'lowerPayment'
  }, normalizeOptions);

  const contractualPayment = projection.contractualPayment;
  const newPayment = projection.monthlyPaymentUsed;
  const monthlyReduction = contractualPayment - newPayment;
  const monthsAtNewPayment = Math.max(0, projection.termMonthsPlanned - lumpSumMonth);

  return {
    lumpSum,
    lumpSumMonth,
    projection,
    contractualPayment,
    newPayment,
    monthlyReduction,
    monthsAtNewPayment,
    freedOverRemainingTerm: monthlyReduction * monthsAtNewPayment,
    payoffDateIso: projection.payoffDateIso,
    totalInterestLifetime: projection.totalInterestLifetime,
    interestSavedVsBase: baseProjection.totalInterestLifetime - projection.totalInterestLifetime,
    // The honest cost of choosing cash flow over term: interest this case pays
    // that the shorter-term case with the identical lump sum does not.
    extraInterestVsShorterTerm: projection.totalInterestLifetime
      - shorterTermCase.projection.totalInterestLifetime,
    shorterTermCaseId: shorterTermCase.id,
    shorterTermCaseTitle: shorterTermCase.title,
    shorterTermPayoffDateIso: shorterTermCase.payoffDateIso
  };
}

/** The case list a switcher renders, each with the outcome it leads to. */
export function getMortgageScenarioCases(rawInputs, options = {}) {
  const comparison = computeMortgageComparison(rawInputs, options);

  return comparison.cases.map((item) => ({
    id: item.id,
    title: item.title,
    detail: buildScenarioCaseDetail(item)
  }));
}

export function getDefaultMortgageScenarioId(rawInputs, options = {}) {
  const { scenarioId: _ignored, ...normalizeOptions } = options;
  const normalized = normalizeMortgageInputs(rawInputs, normalizeOptions);
  return resolveBaseScenario(normalized, getScenarioList(normalized)).id;
}

/** The one line a case button shows, so the answer is readable before the click. */
function buildScenarioCaseDetail(item) {
  if (item.isBase) {
    const finishes = item.payoffDateIso
      ? `Finishes ${formatMonthYear(item.payoffDateIso)}`
      : 'Not repaid within the term';
    return `${finishes} · ${formatEuroWhole(item.totalInterestLifetime)} interest`;
  }

  const parts = [`Saves ${formatEuroWhole(item.interestSaved)}`];
  if (item.monthsSaved > 0) {
    parts.push(`${formatMonthsDuration(item.monthsSaved)} earlier`);
  } else if (item.paymentDelta < -0.005) {
    parts.push(`${formatEuroWhole(Math.abs(item.paymentDelta))} a month lower`);
  }

  return parts.join(' · ');
}

/**
 * ONE ROW PER CASE, because a case is what the client is choosing between.
 *
 * The measures used to be the rows and the cases the columns, which reads as a
 * spec sheet: four things compared on eight axes. Turning it back puts the
 * cases in the same order and the same direction as the buttons above it, so
 * the row the client just selected is the row that lights up.
 */
function buildComparisonTable(comparison, wording) {
  const columns = [
    'Case',
    'Cleared',
    'Time saved',
    'Total interest',
    'Interest saved',
    'Paid in',
    // Not "saved per EUR1" -- the short label reads like a return, and this
    // column is not one.
    'Interest saved per \u20ac1 in'
  ];

  const rows = comparison.cases.map((item) => [
    item.title,
    item.payoffDateIso ? formatMonthYear(item.payoffDateIso) : `Not within the ${wording.noun} term`,
    item.isBase || item.monthsSaved <= 0 ? '\u2014' : formatMonthsDuration(item.monthsSaved),
    formatEuroWhole(item.totalInterestLifetime),
    item.isBase || item.interestSaved <= 0 ? '\u2014' : formatEuroWhole(item.interestSaved),
    item.totalOverpaid > SETTLEMENT_EPSILON ? formatEuroWhole(item.totalOverpaid) : '\u2014',
    item.savedPerEuroOverpaid === null ? '\u2014' : formatEuro(item.savedPerEuroOverpaid)
  ]);

  return { columns, rows };
}

function buildSummarySentences(projection, comparison, selectedCase, wording) {
  const sentences = [
    `Monthly repayments are modelled from an opening ${wording.noun} balance of ${formatEuro(projection.openingBalance)} at ${formatPercent(projection.inputs.annualInterestRate)} interest.`,
    `The payment used is ${formatEuro(projection.monthlyPaymentUsed)} per month, with annual overpayments of ${formatEuro(projection.inputs.annualOverpayment)} applied at each year-end.`,
    projection.payoffYear
      ? `On this path the ${wording.noun} is projected to be fully repaid in ${projection.payoffYear}.`
      : `On this path the ${wording.noun} is not fully repaid by ${projection.endMonthIso}, leaving ${formatEuro(projection.balanceRemaining)} outstanding.`,
    `Total lifetime interest is ${formatEuro(projection.totalInterestLifetime)} and total paid is ${formatEuro(projection.totalPaidLifetime)}.`
  ];

  if (comparison.hasScenarios && !selectedCase.isBase) {
    const parts = [`Against ${comparison.baseCase.title}, this case saves ${formatEuro(selectedCase.interestSaved)} of interest`];
    if (selectedCase.monthsSaved > 0) {
      parts.push(`and clears the ${wording.noun} ${formatMonthsDuration(selectedCase.monthsSaved)} earlier`);
    }
    if (selectedCase.savedPerEuroOverpaid !== null) {
      parts.push(`— ${formatEuro(selectedCase.savedPerEuroOverpaid)} saved for every €1 paid in`);
    }
    sentences.push(`${parts.join(' ')}.`);
  }

  return sentences;
}

export function computeMortgageProjection(rawInputs, options = {}) {
  const { scenarioId, ...normalizeOptions } = options;
  const comparison = computeMortgageComparison(rawInputs, normalizeOptions);
  const selectedCase = comparison.cases.find((item) => item.id === scenarioId) || comparison.baseCase;
  const projection = selectedCase.projection;
  const annualSchedule = projection.annualSchedule;
  const wording = getLoanWording(projection.inputs.loanKind);
  const currentBalanceLabel = wording.noun === 'loan' ? 'Current loan balance' : 'Current balance';
  const termLabel = `${wording.titleCase} term`;
  const termEndLabel = wording.noun === 'loan'
    ? 'Remaining loan balance at term end'
    : 'Remaining balance at term end';

  const assumptionsTable = {
    columns: ['Assumption', 'Value', 'Notes'],
    rows: [
      [currentBalanceLabel, formatEuro(projection.inputs.currentBalance), 'Balance before any overpayment'],
      [
        'One-off overpayment',
        formatEuro(projection.inputs.oneOffOverpayment),
        projection.lumpSumMonth > 0
          ? `Paid in ${formatMonthYear(addMonthsToIso(projection.startMonthIso, projection.lumpSumMonth - 1))}`
          : 'Applied immediately at start'
      ],
      ['Opening balance used', formatEuro(projection.openingBalance), 'Starting balance for amortisation maths'],
      ['Annual interest rate', formatPercent(projection.inputs.annualInterestRate), 'Monthly compounding used internally'],
      [termLabel, `${projection.termMonthsPlanned} months`, `${projection.startMonthIso} to ${projection.endMonthIso}`],
      ['Repayment type', projection.inputs.repaymentType, 'V1 supports amortising repayment only'],
      ['Annual overpayment', formatEuro(projection.inputs.annualOverpayment), 'Applied at each calendar year-end'],
      ['Overpayment benefit', projection.overpaymentBenefit === 'lowerPayment' ? 'Lower repayment' : 'Shorter term', projection.overpaymentBenefit === 'lowerPayment' ? 'Repayment recalculated, term unchanged' : 'Repayment held, term shortens'],
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

  if (comparison.hasScenarios && !selectedCase.isBase) {
    outputsTable.rows.push(
      ['Interest saved', formatEuro(selectedCase.interestSaved), `Against ${comparison.baseCase.title}`],
      ['Time saved', formatMonthsDuration(selectedCase.monthsSaved), `Against ${comparison.baseCase.title}`],
      ['Total overpaid', formatEuro(selectedCase.totalOverpaid), 'Lump sum, regular overpayments and payment round-up']
    );
    if (selectedCase.savedPerEuroOverpaid !== null) {
      outputsTable.rows.push(['Saved per €1 overpaid', formatEuro(selectedCase.savedPerEuroOverpaid), 'Interest saved divided by the amount paid in']);
    }
  }

  // ONE CHART, AND THE MODULE SCREEN DOES NOT SHOW IT.
  //
  // The repayment-case module draws its own balance curve and its own
  // year-by-year interest columns, in SVG, on the same clock as the rail and
  // the cut line above them, so the focused pane renders no charts card at
  // all. The two comparison charts that used to be emitted here -- balance
  // against the base case, and cumulative interest against the base case --
  // are gone for good: they restated the shaded gap of the module's own
  // balance chart in a second unit, and on a first viewing two falling lines
  // of similar shape read as one fact shown twice.
  //
  // This one survives for the surfaces that have no module to draw it for
  // them: the video summary, and anything else rendering from the payload
  // alone. It follows the selected case like every other derived figure.
  const fallbackYear = parseIsoDateStrict(projection.inputs.startDateIso, 'startDateIso').getUTCFullYear();
  const labels = annualSchedule.length > 0
    ? annualSchedule.map((row) => String(row.year))
    : [String(fallbackYear)];
  const series = (key) => (annualSchedule.length > 0 ? annualSchedule.map((row) => row[key]) : [0]);

  const charts = [
    {
      id: 'mortgage-mixed-annual',
      title: `${wording.titleCase} Balance and Annual Repayment Split`,
      type: 'bar',
      labels,
      datasets: [
        { label: 'Remaining balance', data: series('balanceEndRaw') },
        { label: 'Principal repaid (annual)', data: series('principalPaidRaw') },
        { label: 'Interest paid (annual)', data: series('interestPaidRaw') }
      ]
    }
  ];

  const summarySentences = buildSummarySentences(projection, comparison, selectedCase, wording);

  return {
    assumptionsTable,
    outputsTable,
    comparisonTable: comparison.comparisonTable,
    charts,
    summaryHtml: `<p>${summarySentences.join(' ')}</p>`,
    scenarioId: selectedCase.id,
    debug: {
      monthsPlanned: projection.termMonthsPlanned,
      monthsSimulated: projection.monthsSimulated,
      paymentUsedMonthly: projection.monthlyPaymentUsed,
      contractualPayment: projection.contractualPayment,
      overpaymentBenefit: projection.overpaymentBenefit,
      openingBalance: projection.openingBalance,
      payoffYear: projection.payoffYear,
      payoffDateIso: projection.payoffDateIso,
      totalInterestLifetime: projection.totalInterestLifetime,
      totalPaidLifetime: projection.totalPaidLifetime,
      totalOverpaid: projection.totalOverpaid,
      scenarioId: selectedCase.id,
      baseScenarioId: comparison.baseScenarioId,
      interestSaved: selectedCase.interestSaved,
      monthsSaved: selectedCase.monthsSaved,
      savedPerEuroOverpaid: selectedCase.savedPerEuroOverpaid,
      cases: comparison.cases.map((item) => ({
        id: item.id,
        title: item.title,
        isBase: item.isBase,
        monthlyPaymentUsed: item.monthlyPaymentUsed,
        payoffDateIso: item.payoffDateIso,
        monthsSimulated: item.monthsSimulated,
        totalInterestLifetime: item.totalInterestLifetime,
        totalPaidLifetime: item.totalPaidLifetime,
        totalOverpaid: item.totalOverpaid,
        interestSaved: item.interestSaved,
        monthsSaved: item.monthsSaved,
        savedPerEuroOverpaid: item.savedPerEuroOverpaid
      })),
      annualSchedule
    }
  };
}
