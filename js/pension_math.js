import {
  IRELAND_RULES_CATALOGUE_VERSION,
  IRISH_ARF_MINIMUM_DRAWDOWN,
  IRISH_STATE_PENSION_CONTRIBUTORY,
  irishArfMinimumRate,
  normalizeStatePensionFraction
} from './planning/ireland_rules.js';
import { MAX_MODULE_SCENARIO_CASES } from './scenario_cap.js';

const DEFAULT_INFLATION_RATE = 0.02;
const DEFAULT_WAGE_GROWTH_RATE = 0.02;
const DEFAULT_GROWTH_RATE = 0.05;
const DEFAULT_HORIZON_END_AGE = 100;
const DEFAULT_INCOME_MODE = 'target';
const DEFAULT_AFFORDABLE_END_AGES = Object.freeze([100]);
const STATE_PENSION_ANNUAL_TODAY = IRISH_STATE_PENSION_CONTRIBUTORY.annualMaximumEur;
const STATE_PENSION_START_AGE = IRISH_STATE_PENSION_CONTRIBUTORY.defaultStartAge;
const REQUIRED_POT_TOLERANCE_EUR = 25;
const HOUSEHOLD_OWNER_IDS = new Set(['household', 'joint', 'family']);

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

  if (rawValue.length > MAX_MODULE_SCENARIO_CASES) {
    throw new Error(
      `generated.pensionInputs.rentalIncomeScenarios supports at most ${MAX_MODULE_SCENARIO_CASES} cases; received ${rawValue.length}.`
    );
  }

  const usedIds = new Set();
  return rawValue.map((scenario, index) => {
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
        : `Retirement income case ${index + 1}`,
      rentalIncomeToday: requireNonNegativeNumber(
        scenario.rentalIncomeToday,
        `rentalIncomeScenarios[${index}].rentalIncomeToday`
      )
    };
  });
}

function normalizeAffordableEndAges(rawValue, minimumAge) {
  const source = typeof rawValue === 'undefined'
    ? DEFAULT_AFFORDABLE_END_AGES
    : rawValue;

  if (!Array.isArray(source)) {
    throw new Error('generated.pensionInputs.affordableEndAges must be an array of integers.');
  }

  if (source.length === 0) {
    throw new Error('generated.pensionInputs.affordableEndAges must include at least one age.');
  }

  const minimumEndAge = minimumAge + 1;
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

function sum(values) {
  return Array.isArray(values)
    ? values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0)
    : 0;
}

/**
 * The Revenue age-related limits on personal pension contributions that qualify
 * for tax relief, and the earnings cap they apply to.
 *
 * These are the numbers behind "I pay the max". A client who says that has
 * given a complete answer -- it is this table applied to their age -- and the
 * meeting used to treat it as no answer at all and ask again. The bands are
 * exported so the conversation can state them accurately and the fact mapper
 * can resolve "the maximum" into a rate, rather than either of them carrying a
 * second copy of a rule that changes by statute.
 */
const PENSION_AGE_BANDS = Object.freeze([
  Object.freeze({ maxAge: 29, rate: 0.15 }),
  Object.freeze({ maxAge: 39, rate: 0.20 }),
  Object.freeze({ maxAge: 49, rate: 0.25 }),
  Object.freeze({ maxAge: 54, rate: 0.30 }),
  Object.freeze({ maxAge: 59, rate: 0.35 }),
  Object.freeze({ maxAge: Infinity, rate: 0.40 })
]);

/** Earnings above this do not attract relief, whatever the age band allows. */
const PENSION_EARNINGS_CAP = 115_000;

/**
 * The maximum relievable personal contribution rate for an age, as a
 * PERCENTAGE (25, not 0.25) to match how a contribution rate is recorded.
 */
export function maxRelievableContributionRatePercent(age) {
  const years = Number(age);
  if (!Number.isFinite(years) || years < 0) return null;
  const band = PENSION_AGE_BANDS.find((entry) => years <= entry.maxAge);
  return band ? Math.round(band.rate * 100) : null;
}

/**
 * What the meeting may say about contribution limits, and what it must still ask.
 *
 * "I pay the max" is a complete answer, not a missing one: it is the age band
 * applied to their age. The meeting used to treat it as no answer and ask the
 * same question again -- observed nine times in one call, after which the
 * analysis could not run at all. It is stated here so the conversation can use
 * the rule accurately rather than approximating it, and so the ONE thing the
 * rule does not settle is asked instead: the employer side, which is a separate
 * arrangement and does not exist for the self-employed.
 */
export function pensionConversationGuidance() {
  const bands = PENSION_AGE_BANDS.map((band, index) => {
    const from = index === 0 ? 'under 30' : `${PENSION_AGE_BANDS[index - 1].maxAge + 1}`;
    const label = index === 0
      ? 'under 30'
      : (band.maxAge === Infinity ? `${from} and over` : `${from} to ${band.maxAge}`);
    return `${label}: ${Math.round(band.rate * 100)}%`;
  }).join(', ');
  return Object.freeze([
    `Revenue limits the PERSONAL contribution that gets tax relief by age: ${bands}. `
      + `It applies to earnings up to a cap of EUR ${PENSION_EARNINGS_CAP.toLocaleString('en-IE')}.`,
    'So when a client says they pay "the maximum", "the max for tax relief" or "the full amount", '
      + 'that IS their answer. Treat it as given, do not ask for a percentage again, and do not '
      + 'state the resulting figure yourself -- deterministic code derives it from their age.',
    'An employer contribution is a separate arrangement that these limits do not cover, so it is '
      + 'the one thing still worth asking after "the maximum". Ask it only where an employer could '
      + 'exist: never for a self-employed client, a personal pension or PRSA in their own name, or '
      + 'a buyout bond, which nobody contributes to.'
  ]);
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
  return ageBandPct(age) * Math.min(salaryAtAge, PENSION_EARNINGS_CAP);
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
    baseSentence = `Based on your current contribution path, a projected fund at retirement may exceed the Standard Fund Threshold (SFT) of ${sftText} for ${yearText}${suffix}`;
  } else if (!flags.current && flags.max && !flags.required) {
    baseSentence = `If personal contributions are maximised within Irish limits, a projected fund at retirement may exceed the Standard Fund Threshold (SFT) of ${sftText} for ${yearText}${suffix}`;
  } else if (flags.current && flags.max && !flags.required) {
    baseSentence = `Both the current and maximised contribution projections suggest a fund at retirement may exceed the Standard Fund Threshold (SFT) of ${sftText} for ${yearText}${suffix}`;
  } else if (!flags.current && !flags.max && flags.required) {
    baseSentence = `To fund the target retirement income on these assumptions, a required starting fund may exceed the Standard Fund Threshold (SFT) of ${sftText} for ${yearText}${suffix}`;
  } else if (flags.current && !flags.max && flags.required) {
    baseSentence = `The current projection and required starting fund may exceed the Standard Fund Threshold (SFT) of ${sftText} for ${yearText}${suffix}`;
  } else if (!flags.current && flags.max && flags.required) {
    baseSentence = `The maximised projection and required starting fund may exceed the Standard Fund Threshold (SFT) of ${sftText} for ${yearText}${suffix}`;
  } else if (flags.current && flags.max && flags.required) {
    baseSentence = `Across the contribution projections and required starting fund, a fund may exceed the Standard Fund Threshold (SFT) of ${sftText} for ${yearText}${suffix}`;
  }

  if (!baseSentence) {
    return '';
  }

  if (!sftMeta.heldConstantBeyond2029) {
    return baseSentence;
  }

  return `${baseSentence} Future SFT increases may apply but aren’t predictable, so we’ve held the threshold constant beyond 2029.`;
}

function buildPensionReadiness({
  isAffordableMode,
  requiredPot,
  projectedPotCurrent,
  projectedPotMaxPersonal
}) {
  if (isAffordableMode || !Number.isFinite(requiredPot)) {
    return {
      requiredPotIsApplicable: true,
      readinessStatus: 'not-classified',
      readinessSentence: '',
      currentSurplusVsRequired: 0,
      currentGapVsRequired: 0,
      maxSurplusVsRequired: 0,
      maxGapVsRequired: 0
    };
  }

  const requiredPotIsApplicable = requiredPot > REQUIRED_POT_TOLERANCE_EUR;
  const currentDifference = projectedPotCurrent - requiredPot;
  const maxDifference = projectedPotMaxPersonal - requiredPot;
  const currentSurplusVsRequired = currentDifference > REQUIRED_POT_TOLERANCE_EUR ? currentDifference : 0;
  const currentGapVsRequired = currentDifference < -REQUIRED_POT_TOLERANCE_EUR ? Math.abs(currentDifference) : 0;
  const maxSurplusVsRequired = maxDifference > REQUIRED_POT_TOLERANCE_EUR ? maxDifference : 0;
  const maxGapVsRequired = maxDifference < -REQUIRED_POT_TOLERANCE_EUR ? Math.abs(maxDifference) : 0;

  if (!requiredPotIsApplicable) {
    return {
      requiredPotIsApplicable: false,
      readinessStatus: 'externalIncomeCoversTarget',
      readinessSentence: 'On these assumptions, other retirement income sources cover the target spending need, so a separate required pension pot is not shown for this scenario.',
      currentSurplusVsRequired,
      currentGapVsRequired: 0,
      maxSurplusVsRequired,
      maxGapVsRequired: 0
    };
  }

  if (currentGapVsRequired === 0) {
    const readinessSentence = currentSurplusVsRequired > 0
      ? 'This is a strong position: on these assumptions, the current trajectory is projected to meet the target retirement income and leave a surplus against the required pension pot.'
      : 'On these assumptions, the current trajectory is projected to meet the target retirement income within the required-pot tolerance.';
    return {
      requiredPotIsApplicable: true,
      readinessStatus: 'currentOnTrack',
      readinessSentence,
      currentSurplusVsRequired,
      currentGapVsRequired: 0,
      maxSurplusVsRequired,
      maxGapVsRequired: 0
    };
  }

  if (maxGapVsRequired === 0) {
    return {
      requiredPotIsApplicable: true,
      readinessStatus: 'maxContributionsCloseGap',
      readinessSentence: 'The current path is below the required pension pot, but increasing toward maximum relievable personal contributions is projected to close the gap under these assumptions.',
      currentSurplusVsRequired: 0,
      currentGapVsRequired,
      maxSurplusVsRequired,
      maxGapVsRequired: 0
    };
  }

  return {
    requiredPotIsApplicable: true,
    readinessStatus: 'shortfallAfterMax',
    readinessSentence: 'Even with maximum personal contributions, the projection remains below the required pot. The planning levers are increasing income to support higher contributions, adding income-generating assets such as rental property, reducing retirement expenditure, or revisiting timing and assumptions.',
    currentSurplusVsRequired: 0,
    currentGapVsRequired,
    maxSurplusVsRequired: 0,
    maxGapVsRequired
  };
}

function ageAtYear(person, year, currentYear) {
  return person.currentAge + (year - currentYear);
}

function yearForAge(person, age, currentYear) {
  return currentYear + (age - person.currentAge);
}

function normalizePensionMember(rawMember, index, defaults, prefix) {
  if (!rawMember || typeof rawMember !== 'object' || Array.isArray(rawMember)) {
    throw new Error(`generated.pensionInputs.${prefix} must be an object.`);
  }

  const legacyIncluded = rawMember.includeStatePension === false ? false : true;
  const statePensionFraction = legacyIncluded
    ? normalizeStatePensionFraction(rawMember.statePensionFraction, 1)
    : 0;
  const statePensionStartAge = typeof rawMember.statePensionStartAge === 'undefined'
    ? STATE_PENSION_START_AGE
    : requireFiniteInteger(rawMember.statePensionStartAge, `${prefix}.statePensionStartAge`);
  const member = {
    id: normalizeScenarioId(rawMember.id, index === 0 ? 'primary' : `pension-${index + 1}`),
    title: typeof rawMember.title === 'string' && rawMember.title.trim()
      ? rawMember.title.trim()
      : (index === 0 ? 'Pension' : `Pension ${index + 1}`),
    currentAge: requireFiniteInteger(rawMember.currentAge, `${prefix}.currentAge`),
    retirementAge: requireFiniteInteger(rawMember.retirementAge, `${prefix}.retirementAge`),
    currentSalary: requireFiniteNumber(rawMember.currentSalary, `${prefix}.currentSalary`),
    currentPot: requireFiniteNumber(rawMember.currentPot, `${prefix}.currentPot`),
    personalPct: requireFiniteNumber(rawMember.personalPct, `${prefix}.personalPct`),
    employerPct: requireFiniteNumber(rawMember.employerPct, `${prefix}.employerPct`),
    growthRate: optionalFiniteNumber(rawMember.growthRate, defaults.growthRate, `${prefix}.growthRate`),
    wageGrowthRate: optionalFiniteNumber(rawMember.wageGrowthRate, defaults.wageGrowthRate, `${prefix}.wageGrowthRate`),
    includeStatePension: statePensionFraction > 0,
    statePensionFraction,
    statePensionStartAge,
    statePensionEscalationRate: optionalFiniteNumber(
      rawMember.statePensionEscalationRate,
      IRISH_STATE_PENSION_CONTRIBUTORY.defaultEscalationRate,
      `${prefix}.statePensionEscalationRate`
    )
  };

  if (member.retirementAge < member.currentAge) {
    throw new Error(`generated.pensionInputs.${prefix}.retirementAge must be greater than or equal to currentAge.`);
  }
  if (member.growthRate <= -1) {
    throw new Error(`generated.pensionInputs.${prefix}.growthRate must be greater than -1.`);
  }
  if (member.wageGrowthRate <= -1) {
    throw new Error(`generated.pensionInputs.${prefix}.wageGrowthRate must be greater than -1.`);
  }
  if (member.statePensionStartAge < STATE_PENSION_START_AGE || member.statePensionStartAge > 70) {
    throw new Error(`generated.pensionInputs.${prefix}.statePensionStartAge must be between 66 and 70.`);
  }
  if (member.statePensionEscalationRate <= -1) {
    throw new Error(`generated.pensionInputs.${prefix}.statePensionEscalationRate must be greater than -1.`);
  }

  member.retirementYear = yearForAge(member, member.retirementAge, defaults.currentYear);
  return member;
}

function normalizePensionMembers(raw, defaults) {
  if (typeof raw.pensions !== 'undefined') {
    if (!Array.isArray(raw.pensions) || raw.pensions.length === 0) {
      throw new Error('generated.pensionInputs.pensions must be a non-empty array when provided.');
    }

    const usedIds = new Set();
    return raw.pensions.map((member, index) => {
      const normalized = normalizePensionMember(member, index, defaults, `pensions[${index}]`);
      if (usedIds.has(normalized.id)) {
        throw new Error(`generated.pensionInputs.pensions[${index}].id must be unique.`);
      }
      usedIds.add(normalized.id);
      return normalized;
    });
  }

  const member = normalizePensionMember({
    id: raw.id,
    title: raw.title || 'Pension',
    currentAge: raw.currentAge,
    retirementAge: raw.retirementAge,
    currentSalary: raw.currentSalary,
    currentPot: raw.currentPot,
    personalPct: raw.personalPct,
    employerPct: raw.employerPct,
    growthRate: raw.growthRate,
    wageGrowthRate: raw.wageGrowthRate,
    includeStatePension: raw.includeStatePension,
    statePensionFraction: raw.statePensionFraction,
    statePensionStartAge: raw.statePensionStartAge,
    statePensionEscalationRate: raw.statePensionEscalationRate
  }, 0, defaults, 'legacy');

  return [member];
}

function resolveTargetStartYear(raw, pensions, currentYear) {
  if (typeof raw.incomeStartYear !== 'undefined') {
    return requireFiniteInteger(raw.incomeStartYear, 'incomeStartYear');
  }

  if (typeof raw.targetStartYear !== 'undefined') {
    return requireFiniteInteger(raw.targetStartYear, 'targetStartYear');
  }

  const primary = pensions[0];
  if (typeof raw.targetStartAge !== 'undefined') {
    return yearForAge(primary, requireFiniteInteger(raw.targetStartAge, 'targetStartAge'), currentYear);
  }

  if (pensions.length > 1) {
    return Math.min(...pensions.map((member) => member.retirementYear));
  }

  return primary.retirementYear;
}

function resolveRequiredPotReferenceYear(raw, pensions, incomeStartYear) {
  if (typeof raw.requiredPotReferenceYear !== 'undefined') {
    return requireFiniteInteger(raw.requiredPotReferenceYear, 'requiredPotReferenceYear');
  }

  if (pensions.length > 1) {
    return Math.max(...pensions.map((member) => member.retirementYear));
  }

  return incomeStartYear;
}

function hasStaggeredRetirementYears(pensions) {
  if (!Array.isArray(pensions) || pensions.length <= 1) {
    return false;
  }

  return new Set(pensions.map((member) => member.retirementYear)).size > 1;
}

function resolveIncludeEmploymentIncomeDuringBridge(raw, pensions) {
  if (typeof raw.includeEmploymentIncomeDuringBridge !== 'undefined') {
    if (typeof raw.includeEmploymentIncomeDuringBridge !== 'boolean') {
      throw new Error('generated.pensionInputs.includeEmploymentIncomeDuringBridge must be a boolean when provided.');
    }
    return raw.includeEmploymentIncomeDuringBridge;
  }

  return hasStaggeredRetirementYears(pensions);
}

function resolveYearFromAgeSource(source, pensions, currentYear, ageKey, yearKey, fieldName, { required = true } = {}) {
  if (typeof source[yearKey] !== 'undefined') {
    return requireFiniteInteger(source[yearKey], `${fieldName}.${yearKey}`);
  }

  if (typeof source[ageKey] === 'undefined') {
    if (required) {
      throw new Error(`generated.pensionInputs.${fieldName} must include ${yearKey} or ${ageKey}.`);
    }
    return null;
  }

  const ownerId = typeof source.ownerId === 'string' ? source.ownerId.trim() : '';
  const ownerToken = ownerId.toLowerCase();
  let owner = ownerId && !HOUSEHOLD_OWNER_IDS.has(ownerToken)
    ? pensions.find((member) => member.id === ownerId)
    : null;
  if (!owner && HOUSEHOLD_OWNER_IDS.has(ownerToken)) {
    owner = pensions[0];
  }
  if (!owner && pensions.length === 1) {
    owner = pensions[0];
  }
  if (!owner) {
    throw new Error(`generated.pensionInputs.${fieldName}.ownerId must match a pension id, or use "household", when ${ageKey} is used.`);
  }

  return yearForAge(owner, requireFiniteInteger(source[ageKey], `${fieldName}.${ageKey}`), currentYear);
}

function normalizeOtherIncomeSources(rawValue, pensions, currentYear) {
  if (typeof rawValue === 'undefined') {
    return [];
  }

  if (!Array.isArray(rawValue)) {
    throw new Error('generated.pensionInputs.otherIncomeSources must be an array when provided.');
  }

  const usedIds = new Set();
  return rawValue.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error(`generated.pensionInputs.otherIncomeSources[${index}] must be an object.`);
    }
    if (typeof source.inflationIndexed !== 'boolean') {
      throw new Error(`generated.pensionInputs.otherIncomeSources[${index}].inflationIndexed must be true or false.`);
    }

    const id = normalizeScenarioId(source.id, `other-income-${index + 1}`);
    if (usedIds.has(id)) {
      throw new Error(`generated.pensionInputs.otherIncomeSources[${index}].id must be unique.`);
    }
    usedIds.add(id);

    const fieldName = `otherIncomeSources[${index}]`;
    const startYear = resolveYearFromAgeSource(source, pensions, currentYear, 'startAge', 'startYear', fieldName);
    const endYear = resolveYearFromAgeSource(source, pensions, currentYear, 'endAge', 'endYear', fieldName, {
      required: false
    });
    if (endYear !== null && endYear < startYear) {
      throw new Error(`generated.pensionInputs.otherIncomeSources[${index}].endYear must be after startYear.`);
    }

    const normalizedSource = {
      id,
      title: typeof source.title === 'string' && source.title.trim()
        ? source.title.trim()
        : `Other income ${index + 1}`,
      type: typeof source.type === 'string' && source.type.trim()
        ? source.type.trim().toLowerCase()
        : 'other',
      ownerId: typeof source.ownerId === 'string' ? source.ownerId.trim() : '',
      annualAmountToday: requireNonNegativeNumber(source.annualAmountToday, `${fieldName}.annualAmountToday`),
      startYear,
      inflationIndexed: source.inflationIndexed
    };

    if (typeof source.inflationRate !== 'undefined') {
      normalizedSource.inflationRate = optionalFiniteNumber(source.inflationRate, null, `${fieldName}.inflationRate`);
      if (normalizedSource.inflationRate <= -1) {
        throw new Error(`generated.pensionInputs.${fieldName}.inflationRate must be greater than -1.`);
      }
    }

    if (endYear !== null) {
      normalizedSource.endYear = endYear;
    }

    return normalizedSource;
  });
}

function resolveHorizonEndYear(raw, pensions, currentYear, targetStartYear) {
  const primary = pensions[0];
  if (typeof raw.horizonEndYear !== 'undefined') {
    return requireFiniteInteger(raw.horizonEndYear, 'horizonEndYear');
  }

  if (typeof raw.horizonEndAge === 'undefined' && pensions.length > 1) {
    const householdEndYear = Math.max(
      ...pensions.map((member) => yearForAge(member, DEFAULT_HORIZON_END_AGE, currentYear))
    );
    if (householdEndYear < targetStartYear) {
      throw new Error('generated.pensionInputs.horizonEndAge must be greater than or equal to targetStartAge.');
    }
    return householdEndYear;
  }

  const horizonEndAge = typeof raw.horizonEndAge === 'undefined'
    ? DEFAULT_HORIZON_END_AGE
    : requireFiniteInteger(raw.horizonEndAge, 'horizonEndAge');
  const horizonEndYear = yearForAge(primary, horizonEndAge, currentYear);
  if (horizonEndYear < targetStartYear) {
    throw new Error('generated.pensionInputs.horizonEndAge must be greater than or equal to targetStartAge.');
  }
  return horizonEndYear;
}

function inflationFactorForYear(inputs, year) {
  return Math.pow(1 + inputs.inflationRate, year - inputs.currentYear);
}

function incomeSourceAmountAtYear(inputs, source, year) {
  if (year < source.startYear || (source.endYear !== null && year > source.endYear)) {
    return 0;
  }

  const incomeInflationRate = Number.isFinite(source.inflationRate)
    ? source.inflationRate
    : inputs.inflationRate;
  const amount = source.inflationIndexed
    ? source.annualAmountToday * Math.pow(1 + incomeInflationRate, year - inputs.currentYear)
    : source.annualAmountToday;
  return Number.isFinite(amount) ? amount : 0;
}

function targetIncomeNominalAtYear(inputs, year, targetIncomeToday = inputs.targetIncomeToday) {
  const nominal = targetIncomeToday * inflationFactorForYear(inputs, year);
  return Number.isFinite(nominal) ? nominal : 0;
}

function axisPersonLabel(member) {
  const rawTitle = typeof member?.title === 'string' ? member.title.trim() : '';
  const withoutPension = rawTitle.replace(/\s+pension$/i, '').trim();
  return withoutPension || 'User';
}

function ageLabelForYear(inputs, year) {
  return String(ageAtYear(inputs.primaryPension, year, inputs.currentYear));
}

function ageSummaryForYear(inputs, year) {
  return inputs.pensions
    .map((member) => `${member.title} age ${ageAtYear(member, year, inputs.currentYear)}`)
    .join(', ');
}

function buildYearRange(startYear, endYear) {
  const years = [];
  for (let year = startYear; year <= endYear; year += 1) {
    years.push(year);
  }
  return years;
}

function buildIncomeBreakdownAtYear(inputs, year) {
  const employmentIncome = inputs.includeEmploymentIncomeDuringBridge
    ? inputs.pensions.reduce((total, member) => {
      if (year < inputs.incomeStartYear || year >= member.retirementYear) {
        return total;
      }
      const salary = member.currentSalary * Math.pow(1 + member.wageGrowthRate, year - inputs.currentYear);
      return total + (Number.isFinite(salary) ? salary : 0);
    }, 0)
    : 0;

  const statePension = inputs.pensions.reduce((total, member) => {
    const age = ageAtYear(member, year, inputs.currentYear);
    if (!member.includeStatePension || age < member.statePensionStartAge) {
      return total;
    }
    return total + (
      STATE_PENSION_ANNUAL_TODAY
      * member.statePensionFraction
      * Math.pow(1 + member.statePensionEscalationRate, year - inputs.currentYear)
    );
  }, 0);

  const rentalIncome = year >= inputs.incomeStartYear
    ? inputs.rentalIncomeToday * inflationFactorForYear(inputs, year)
    : 0;

  const otherIncome = inputs.otherIncomeSources.reduce((total, source) => {
    return total + incomeSourceAmountAtYear(inputs, source, year);
  }, 0);

  return {
    employmentIncome: Number.isFinite(employmentIncome) ? employmentIncome : 0,
    statePension: Number.isFinite(statePension) ? statePension : 0,
    rentalIncome: Number.isFinite(rentalIncome) ? rentalIncome : 0,
    otherIncome: Number.isFinite(otherIncome) ? otherIncome : 0,
    total: employmentIncome + statePension + rentalIncome + otherIncome
  };
}

// The dated Irish rule lives in the rules catalogue; this only supplies the
// member's age for the year being simulated.
function arfMinimumRate(member, year, currentYear, openingBalance) {
  return irishArfMinimumRate(ageAtYear(member, year, currentYear), openingBalance);
}

function withdrawProRata(balances, desiredAmount, eligibleIndexes) {
  let remaining = clampToZero(desiredAmount);
  const withdrawn = balances.map(() => 0);

  for (let pass = 0; pass < 8 && remaining > 0.01; pass += 1) {
    const availableIndexes = eligibleIndexes.filter((index) => balances[index] > 0.01);
    const availableTotal = availableIndexes.reduce((total, index) => total + balances[index], 0);
    if (availableTotal <= 0) {
      break;
    }

    availableIndexes.forEach((index) => {
      if (remaining <= 0.01) {
        return;
      }
      const share = balances[index] / availableTotal;
      const amount = Math.min(balances[index], remaining * share);
      balances[index] -= amount;
      withdrawn[index] += amount;
    });

    remaining = clampToZero(desiredAmount - sum(withdrawn));
  }

  return {
    withdrawn,
    total: sum(withdrawn),
    unmet: remaining
  };
}

function contributionForMemberAtYear(member, inputs, year, mode) {
  if (year >= member.retirementYear) {
    return {
      personal: 0,
      employer: 0,
      total: 0,
      growthBase: 0
    };
  }

  const age = ageAtYear(member, year, inputs.currentYear);
  const salaryAtYear = member.currentSalary * Math.pow(1 + member.wageGrowthRate, year - inputs.currentYear);
  const uncappedPersonal = mode === 'max'
    ? maxRelievablePersonalContribution(age, salaryAtYear)
    : member.personalPct * salaryAtYear;
  const personal = Math.min(uncappedPersonal, maxRelievablePersonalContribution(age, salaryAtYear));
  const employer = member.employerPct * salaryAtYear;

  return {
    personal: Number.isFinite(personal) ? personal : 0,
    employer: Number.isFinite(employer) ? employer : 0,
    total: (Number.isFinite(personal) ? personal : 0) + (Number.isFinite(employer) ? employer : 0),
    growthBase: salaryAtYear
  };
}

function simulateMemberAccumulation(inputs, member, mode) {
  const years = [inputs.currentYear];
  const labels = [String(member.currentAge)];
  const balances = [member.currentPot];
  const personalEurSeries = [0];
  const employerEurSeries = [0];
  const contribEurSeries = [0];
  const growthEurSeries = [0];
  let balance = member.currentPot;

  for (let year = inputs.currentYear; year < member.retirementYear; year += 1) {
    const contribution = contributionForMemberAtYear(member, inputs, year, mode);
    const preGrowth = balance + contribution.total;
    const endBalance = preGrowth * (1 + member.growthRate);
    const growthEur = endBalance - preGrowth;

    balance = Number.isFinite(endBalance) ? endBalance : preGrowth;
    years.push(year + 1);
    labels.push(String(ageAtYear(member, year + 1, inputs.currentYear)));
    balances.push(balance);
    personalEurSeries.push(contribution.personal);
    employerEurSeries.push(contribution.employer);
    contribEurSeries.push(contribution.total);
    growthEurSeries.push(Number.isFinite(growthEur) ? growthEur : 0);
  }

  return {
    member,
    mode,
    years,
    labels,
    balances,
    personalEurSeries,
    employerEurSeries,
    contribEurSeries,
    growthEurSeries,
    retirementPot: balances[balances.length - 1] || 0
  };
}

function balanceFromMemberScenarioAtYear(scenario, year) {
  const index = Array.isArray(scenario?.years)
    ? scenario.years.findIndex((entry) => entry === year)
    : -1;
  if (index >= 0 && Number.isFinite(scenario.balances[index])) {
    return scenario.balances[index];
  }

  return Number.isFinite(scenario?.retirementPot) ? scenario.retirementPot : 0;
}

function simulateHouseholdRetirement(inputs, startingBalances, {
  targetIncomeToday = inputs.targetIncomeToday,
  horizonEndYear = inputs.horizonEndYear,
  contributionMode = 'current',
  startYear = inputs.incomeStartYear
} = {}) {
  const years = buildYearRange(startYear, horizonEndYear);
  const labels = years.map((year) => ageLabelForYear(inputs, year));
  const balances = startingBalances.map((value) => clampToZero(value));
  const combinedBalances = [];
  const closingCombinedBalances = [];
  const totalPensionBalances = [];
  const totalClosingPensionBalances = [];
  const requiredIncome = [];
  const employmentIncome = [];
  const statePensionIncome = [];
  const rentalIncome = [];
  const otherIncome = [];
  const mandatoryWithdrawals = [];
  const electedWithdrawals = [];
  const shortfalls = [];
  const surpluses = [];
  const totalIncome = [];
  const perPensionOpeningBalances = inputs.pensions.map(() => []);
  const perPensionClosingBalances = inputs.pensions.map(() => []);
  const perPensionMandatory = inputs.pensions.map(() => []);
  const perPensionElected = inputs.pensions.map(() => []);

  years.forEach((year) => {
    const openingBalances = balances.map((value) => clampToZero(value));
    const availableIndexes = inputs.pensions
      .map((member, index) => (year >= member.retirementYear ? index : null))
      .filter((index) => index !== null);

    inputs.pensions.forEach((_member, index) => {
      perPensionOpeningBalances[index].push(openingBalances[index] || 0);
    });
    combinedBalances.push(sum(availableIndexes.map((index) => openingBalances[index] || 0)));
    totalPensionBalances.push(sum(openingBalances));

    const target = targetIncomeNominalAtYear(inputs, year, targetIncomeToday);
    const external = buildIncomeBreakdownAtYear(inputs, year);

    const mandatoryByPension = inputs.pensions.map((member, index) => {
      if (!availableIndexes.includes(index)) {
        return 0;
      }
      const openingBalance = clampToZero(balances[index]);
      const rate = arfMinimumRate(member, year, inputs.currentYear, openingBalance);
      return Math.min(openingBalance, openingBalance * rate);
    });

    mandatoryByPension.forEach((amount, index) => {
      balances[index] = clampToZero(balances[index] - amount);
      perPensionMandatory[index].push(amount);
    });

    const mandatoryTotal = sum(mandatoryByPension);
    const desiredElectedWithdrawal = clampToZero(target - external.total - mandatoryTotal);
    const elected = withdrawProRata(balances, desiredElectedWithdrawal, availableIndexes);
    elected.withdrawn.forEach((amount, index) => {
      perPensionElected[index].push(amount);
    });

    const incomeBeforeShortfall = external.total + mandatoryTotal + elected.total;
    const shortfall = clampToZero(target - incomeBeforeShortfall);
    const surplus = clampToZero(incomeBeforeShortfall - target);

    requiredIncome.push(target);
    employmentIncome.push(external.employmentIncome);
    statePensionIncome.push(external.statePension);
    rentalIncome.push(external.rentalIncome);
    otherIncome.push(external.otherIncome);
    mandatoryWithdrawals.push(mandatoryTotal);
    electedWithdrawals.push(elected.total);
    shortfalls.push(shortfall);
    surpluses.push(surplus);
    totalIncome.push(incomeBeforeShortfall);

    inputs.pensions.forEach((member, index) => {
      const contribution = contributionForMemberAtYear(member, inputs, year, contributionMode);
      const preGrowth = balances[index] + contribution.total;
      balances[index] = clampToZero(preGrowth * (1 + member.growthRate));
    });

    const closingBalances = balances.map((value) => clampToZero(value));
    const closingAvailableIndexes = inputs.pensions
      .map((member, index) => (year >= member.retirementYear ? index : null))
      .filter((index) => index !== null);
    inputs.pensions.forEach((_member, index) => {
      perPensionClosingBalances[index].push(closingBalances[index] || 0);
    });
    closingCombinedBalances.push(sum(closingAvailableIndexes.map((index) => closingBalances[index] || 0)));
    totalClosingPensionBalances.push(sum(closingBalances));
  });

  return {
    years,
    labels,
    combinedBalances: floorSeriesToZero(combinedBalances),
    closingCombinedBalances: floorSeriesToZero(closingCombinedBalances),
    totalPensionBalances: floorSeriesToZero(totalPensionBalances),
    totalClosingPensionBalances: floorSeriesToZero(totalClosingPensionBalances),
    endingBalances: balances.map((value) => clampToZero(value)),
    endingBalanceAfterHorizon: sum(balances),
    requiredIncome,
    employmentIncome,
    statePensionIncome,
    rentalIncome,
    otherIncome,
    mandatoryWithdrawals,
    electedWithdrawals,
    shortfalls,
    surpluses,
    totalIncome,
    perPensionOpeningBalances,
    perPensionClosingBalances,
    perPensionMandatory,
    perPensionElected,
    totalShortfall: sum(shortfalls),
    maxShortfall: Math.max(0, ...shortfalls),
    totalSurplus: sum(surpluses),
    firstYearMandatoryWithdrawal: mandatoryWithdrawals[0] || 0,
    firstYearElectedWithdrawal: electedWithdrawals[0] || 0
  };
}

function splitTotalByShares(total, shares) {
  return shares.map((share) => clampToZero(total * share));
}

function findRequiredStartingBalances(inputs, referenceBalances) {
  const referenceTotal = sum(referenceBalances);
  const shares = referenceTotal > 0
    ? referenceBalances.map((value) => clampToZero(value) / referenceTotal)
    : inputs.pensions.map(() => 1 / inputs.pensions.length);
  const isSustainable = (total) => {
    const simulation = simulateHouseholdRetirement(inputs, splitTotalByShares(total, shares), {
      contributionMode: 'current',
      startYear: inputs.requiredPotReferenceYear
    });
    return simulation.maxShortfall <= REQUIRED_POT_TOLERANCE_EUR;
  };

  let high = Math.max(referenceTotal, inputs.targetIncomeToday * 8, 1000);
  while (!isSustainable(high) && high < 25000000) {
    high *= 1.6;
  }

  const breakpoints = shares
    .map((share) => (share > 0 ? IRISH_ARF_MINIMUM_DRAWDOWN.highValueThresholdEur / share : null))
    .filter((value) => Number.isFinite(value) && value > 0 && value < high)
    .flatMap((value) => [value * 0.999, value, value * 1.001]);
  const intervalEnds = [...new Set([0, ...breakpoints, high])]
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);

  let low = 0;
  let upper = high;
  for (const candidateUpper of intervalEnds) {
    if (candidateUpper <= low) {
      continue;
    }
    if (isSustainable(candidateUpper)) {
      upper = candidateUpper;
      break;
    }
    low = candidateUpper;
  }

  for (let iteration = 0; iteration < 70; iteration += 1) {
    const mid = (low + upper) / 2;
    if (isSustainable(mid)) {
      upper = mid;
    } else {
      low = mid;
    }
  }

  const requiredBalances = splitTotalByShares(upper, shares);
  const simulation = simulateHouseholdRetirement(inputs, requiredBalances, {
    contributionMode: 'current',
    startYear: inputs.requiredPotReferenceYear
  });
  const depletionResidual = simulation.endingBalanceAfterHorizon;

  return {
    requiredPot: sum(requiredBalances),
    requiredBalances,
    shares,
    simulation,
    depletionResidual,
    depletionTolerance: REQUIRED_POT_TOLERANCE_EUR,
    arfThresholdBreakpoints: breakpoints
  };
}

function goalSeekAffordableHouseholdIncomeToday(inputs, startBalances, horizonEndYear, contributionMode) {
  const isSustainable = (targetIncomeToday) => {
    const simulation = simulateHouseholdRetirement(inputs, startBalances, {
      targetIncomeToday,
      horizonEndYear,
      contributionMode
    });
    return simulation.maxShortfall <= REQUIRED_POT_TOLERANCE_EUR;
  };

  let low = 0;
  let high = Math.max(sum(inputs.pensions.map((member) => member.currentSalary)), STATE_PENSION_ANNUAL_TODAY, 1000);
  while (isSustainable(high) && high < 5000000) {
    low = high;
    high *= 1.5;
  }

  for (let iteration = 0; iteration < 64; iteration += 1) {
    const mid = (low + high) / 2;
    if (isSustainable(mid)) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const simulation = simulateHouseholdRetirement(inputs, startBalances, {
    targetIncomeToday: low,
    horizonEndYear,
    contributionMode
  });
  const firstYearFactor = inflationFactorForYear(inputs, inputs.incomeStartYear);
  const pensionFundedAtStart = (simulation.mandatoryWithdrawals[0] || 0) + (simulation.electedWithdrawals[0] || 0);

  return {
    incomeTodayBest: clampToZero(pensionFundedAtStart / Math.max(firstYearFactor, 0.000001)),
    totalIncomeToday: clampToZero(low),
    incomeNominalAtRetirement: pensionFundedAtStart,
    totalIncomeNominalAtRetirement: targetIncomeNominalAtYear(inputs, inputs.incomeStartYear, low),
    requiredPotAtRetirementBest: sum(startBalances),
    gap: simulation.maxShortfall,
    simulation
  };
}

function normalizePensionInputsInternal(raw, { validateCases = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('generated.pensionInputs must be an object.');
  }

  const nowYear = new Date().getFullYear();
  const currentYear = typeof raw.currentYear === 'undefined'
    ? nowYear
    : requireFiniteInteger(raw.currentYear, 'currentYear');
  const hasPensionsArray = Array.isArray(raw.pensions);
  const householdGrowthRate = hasPensionsArray
    ? optionalFiniteNumber(raw.growthRate, DEFAULT_GROWTH_RATE, 'growthRate')
    : requireFiniteNumber(raw.growthRate, 'growthRate');
  const inflationRate = optionalFiniteNumber(raw.inflationRate, DEFAULT_INFLATION_RATE, 'inflationRate');
  const householdWageGrowthRate = optionalFiniteNumber(raw.wageGrowthRate, DEFAULT_WAGE_GROWTH_RATE, 'wageGrowthRate');

  if (householdGrowthRate <= -1) {
    throw new Error('generated.pensionInputs.growthRate must be greater than -1.');
  }
  if (inflationRate <= -1) {
    throw new Error('generated.pensionInputs.inflationRate must be greater than -1.');
  }
  if (householdWageGrowthRate <= -1) {
    throw new Error('generated.pensionInputs.wageGrowthRate must be greater than -1.');
  }

  const pensions = normalizePensionMembers(raw, {
    currentYear,
    growthRate: householdGrowthRate,
    wageGrowthRate: householdWageGrowthRate
  });
  const primary = pensions[0];
  const incomeStartYear = resolveTargetStartYear(raw, pensions, currentYear);
  const targetStartYear = incomeStartYear;
  const targetStartAge = ageAtYear(primary, incomeStartYear, currentYear);
  const requiredPotReferenceYear = resolveRequiredPotReferenceYear(raw, pensions, incomeStartYear);
  if (requiredPotReferenceYear < incomeStartYear) {
    throw new Error('generated.pensionInputs.requiredPotReferenceYear must be greater than or equal to incomeStartYear.');
  }
  const horizonEndYear = resolveHorizonEndYear(raw, pensions, currentYear, incomeStartYear);
  if (horizonEndYear < requiredPotReferenceYear) {
    throw new Error('generated.pensionInputs.horizonEndAge must be greater than or equal to the required pot reference year.');
  }
  const horizonEndAge = ageAtYear(primary, horizonEndYear, currentYear);
  const horizonEndAges = pensions.map((member) => ({
    id: member.id,
    title: member.title,
    age: ageAtYear(member, horizonEndYear, currentYear)
  }));
  const incomeMode = normalizeIncomeMode(raw.incomeMode);
  const includeEmploymentIncomeDuringBridge = resolveIncludeEmploymentIncomeDuringBridge(raw, pensions);

  const normalized = {
    currentAge: primary.currentAge,
    retirementAge: primary.retirementAge,
    currentSalary: sum(pensions.map((member) => member.currentSalary)),
    currentPot: sum(pensions.map((member) => member.currentPot)),
    personalPct: primary.personalPct,
    employerPct: primary.employerPct,
    growthRate: householdGrowthRate,
    inflationRate,
    wageGrowthRate: householdWageGrowthRate,
    horizonEndAge,
    horizonEndAges,
    horizonEndYear,
    currentYear,
    targetStartYear,
    incomeStartYear,
    targetStartAge,
    requiredPotReferenceYear,
    requiredPotReferenceAge: ageAtYear(primary, requiredPotReferenceYear, currentYear),
    includeEmploymentIncomeDuringBridge,
    incomeMode,
    rentalIncomeToday: optionalNonNegativeNumber(raw.rentalIncomeToday, 0, 'rentalIncomeToday'),
    pensions,
    primaryPension: primary,
    isHousehold: pensions.length > 1
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
    normalized.affordableEndAges = normalizeAffordableEndAges(raw.affordableEndAges, targetStartAge);
  }

  normalized.otherIncomeSources = normalizeOtherIncomeSources(raw.otherIncomeSources, pensions, currentYear);

  const cases = normalizePensionCases(
    raw,
    pensions.map((member) => member.id),
    normalized.otherIncomeSources.map((source) => source.id)
  );
  if (cases) {
    normalized.scenarios = cases;
    const requestedBaseId = typeof raw.baseScenarioId === 'string' ? raw.baseScenarioId.trim() : '';
    if (requestedBaseId && !cases.some((entry) => entry.id === requestedBaseId)) {
      throw new Error('generated.pensionInputs.baseScenarioId must match a case id.');
    }
    normalized.baseScenarioId = requestedBaseId || cases[0].id;

    // Rule: every case has to stand on its own. Normalising each merged case
    // here means a payload that would fail on the third card is refused now,
    // rather than on the click that reaches it.
    if (validateCases) {
      cases.forEach((caseEntry, index) => {
        normalizePensionCaseInputs(raw, caseEntry, index, normalized);
      });
    }
  }

  return normalized;
}

export function normalizePensionInputs(raw) {
  return normalizePensionInputsInternal(raw);
}

/* ------------------------------------------------------------------ cases ---
 *
 * A Retirement case restates only what it changes -- an age, a contribution
 * rate, a pot, a piece of income -- and inherits everything else from the base
 * inputs. It is then merged back into a whole payload and normalised as if it
 * had been authored on its own, which is the only way "retire at 58" can be
 * trusted to mean the same thing on a case card as it would in a module of its
 * own. There is no second projection path: every case goes through the one
 * normaliser and the one engine.
 */

/** What a case may restate for the household. */
const PENSION_CASE_HOUSEHOLD_KEYS = Object.freeze([
  'rentalIncomeToday',
  'targetIncomeToday',
  'targetIncomePctOfSalary',
  'excludedIncomeSourceIds',
  'additionalIncomeSources'
]);

/** What a case may restate about one person's pension. */
const PENSION_CASE_MEMBER_KEYS = Object.freeze([
  'retirementAge',
  'personalPct',
  'employerPct',
  'currentPot',
  'includeStatePension'
]);

/**
 * Timing a case may restate -- and, once it moves a retirement age, timing the
 * base no longer gets to decide.
 *
 * An income start year written for retirement at 62 is not a fact about
 * retiring at 58; it is the old answer to the question the case is asking
 * again. A case that changes any retirement age therefore drops these and lets
 * them be derived from its own ages, exactly as a standalone payload would.
 */
const PENSION_CASE_TIMING_KEYS = Object.freeze([
  'incomeStartYear',
  'targetStartYear',
  'targetStartAge',
  'requiredPotReferenceYear',
  'includeEmploymentIncomeDuringBridge'
]);

/** The income start year is one fact written three ways; a case restates all three at once. */
const PENSION_CASE_START_KEYS = Object.freeze(['incomeStartYear', 'targetStartYear', 'targetStartAge']);

/** The target income is one fact written two ways, for the same reason. */
const PENSION_CASE_TARGET_KEYS = Object.freeze(['targetIncomeToday', 'targetIncomePctOfSalary']);

const PENSION_CASE_OVERRIDE_KEYS = new Set([
  ...PENSION_CASE_HOUSEHOLD_KEYS,
  ...PENSION_CASE_MEMBER_KEYS,
  ...PENSION_CASE_TIMING_KEYS,
  'pensionOverrides'
]);

/** Keys that name a case rather than change it. */
const PENSION_CASE_IDENTITY_KEYS = new Set(['id', 'title', 'description', 'interpretation', 'overrides']);

function hasValue(source, key) {
  return Boolean(source)
    && Object.prototype.hasOwnProperty.call(source, key)
    && typeof source[key] !== 'undefined';
}

/** How an error names the case it came from, so a rejection is actionable. */
function pensionCaseLabel(index, title) {
  return `generated.pensionInputs.scenarios[${index}] (${title})`;
}

function normalizePensionCaseMemberFields(source, label, { skipKeys = null } = {}) {
  const fields = {};

  Object.keys(source).forEach((key) => {
    if (skipKeys && skipKeys.has(key)) {
      return;
    }
    if (!hasValue(source, key)) {
      return;
    }
    if (!PENSION_CASE_MEMBER_KEYS.includes(key)) {
      throw new Error(`${label}: ${key} is not a case override.`);
    }
    fields[key] = source[key];
  });

  return fields;
}

/**
 * One case, read the same way whether it was just authored or read back off a
 * saved session.
 *
 * THIS NORMALISER MUST BE IDEMPOTENT. An authored case states its changes flat
 * -- `{ id, title, retirementAge: 58 }` -- and this returns them nested under
 * `overrides`, which is the shape the app then stores and normalises again.
 * Reading only the flat keys the second time round would find none, and quietly
 * return a case that changes nothing: four buttons, four identical answers, and
 * no error anywhere.
 */
function normalizePensionCase(rawCase, index, memberIds, incomeSourceIds) {
  if (!rawCase || typeof rawCase !== 'object' || Array.isArray(rawCase)) {
    throw new Error(`generated.pensionInputs.scenarios[${index}] must be an object.`);
  }

  const id = normalizeScenarioId(rawCase.id, `case-${index + 1}`);
  const title = typeof rawCase.title === 'string' && rawCase.title.trim()
    ? rawCase.title.trim()
    : `Case ${index + 1}`;
  const description = typeof rawCase.description === 'string' && rawCase.description.trim()
    ? rawCase.description.trim()
    : (typeof rawCase.interpretation === 'string' ? rawCase.interpretation.trim() : '');
  const label = pensionCaseLabel(index, title);

  const source = rawCase.overrides && typeof rawCase.overrides === 'object' && !Array.isArray(rawCase.overrides)
    ? rawCase.overrides
    : rawCase;

  const overrides = {};
  Object.keys(source).forEach((key) => {
    if (PENSION_CASE_IDENTITY_KEYS.has(key) || !hasValue(source, key)) {
      return;
    }
    if (!PENSION_CASE_OVERRIDE_KEYS.has(key)) {
      throw new Error(`${label}: ${key} is not a case override.`);
    }
    if (PENSION_CASE_MEMBER_KEYS.includes(key) && memberIds.length > 1) {
      throw new Error(
        `${label}: ${key} must be set through pensionOverrides when the payload has more than one pension.`
      );
    }
    overrides[key] = source[key];
  });

  if (hasValue(overrides, 'pensionOverrides')) {
    if (!Array.isArray(overrides.pensionOverrides)) {
      throw new Error(`${label}: pensionOverrides must be an array when provided.`);
    }

    overrides.pensionOverrides = overrides.pensionOverrides.map((entry, entryIndex) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`${label}: pensionOverrides[${entryIndex}] must be an object.`);
      }

      const memberId = normalizeScenarioId(entry.id, '');
      if (!memberIds.includes(memberId)) {
        throw new Error(`${label}: pensionOverrides[${entryIndex}].id must match a pension id.`);
      }

      return {
        id: memberId,
        ...normalizePensionCaseMemberFields(entry, `${label}: pensionOverrides[${entryIndex}]`, {
          skipKeys: new Set(['id'])
        })
      };
    });
  }

  if (hasValue(overrides, 'excludedIncomeSourceIds')) {
    if (!Array.isArray(overrides.excludedIncomeSourceIds)) {
      throw new Error(`${label}: excludedIncomeSourceIds must be an array when provided.`);
    }
    // A case that names income the base does not have would silently leave
    // that income in place: the card says "without the DB pension" and the
    // figures behind it still count it.
    overrides.excludedIncomeSourceIds.forEach((sourceId) => {
      if (!incomeSourceIds.includes(normalizeScenarioId(sourceId, ''))) {
        throw new Error(`${label}: excludedIncomeSourceIds must match an other income source id.`);
      }
    });
  }

  if (hasValue(overrides, 'additionalIncomeSources') && !Array.isArray(overrides.additionalIncomeSources)) {
    throw new Error(`${label}: additionalIncomeSources must be an array when provided.`);
  }

  return { id, title, description, overrides };
}

/** Rent-only cases, expressed as cases so there is one case path and not two. */
function pensionCasesFromRentalScenarios(rentalScenarios) {
  return rentalScenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    description: '',
    overrides: { rentalIncomeToday: scenario.rentalIncomeToday }
  }));
}

function normalizePensionCases(raw, memberIds, incomeSourceIds) {
  const hasCases = Array.isArray(raw.scenarios) && raw.scenarios.length > 0;
  const hasRentalCases = Array.isArray(raw.rentalIncomeScenarios) && raw.rentalIncomeScenarios.length > 0;

  if (hasCases && hasRentalCases) {
    throw new Error(
      'generated.pensionInputs must use scenarios or rentalIncomeScenarios, not both.'
    );
  }

  if (typeof raw.scenarios !== 'undefined' && raw.scenarios !== null && !Array.isArray(raw.scenarios)) {
    throw new Error('generated.pensionInputs.scenarios must be an array when provided.');
  }

  if (!hasCases) {
    return null;
  }

  if (raw.scenarios.length > MAX_MODULE_SCENARIO_CASES) {
    throw new Error(
      `generated.pensionInputs.scenarios supports at most ${MAX_MODULE_SCENARIO_CASES} cases; `
      + `received ${raw.scenarios.length}.`
    );
  }

  const usedIds = new Set();
  return raw.scenarios.map((rawCase, index) => {
    const normalized = normalizePensionCase(rawCase, index, memberIds, incomeSourceIds);
    if (usedIds.has(normalized.id)) {
      throw new Error(`generated.pensionInputs.scenarios[${index}].id must be unique.`);
    }
    usedIds.add(normalized.id);
    return normalized;
  });
}

/**
 * The payload this case would have been, had it been authored on its own.
 *
 * Everything the case does not restate is inherited untouched, so a later
 * change to the household's growth rate or salary reaches every case at once.
 */
function buildPensionCaseRawInputs(raw, caseEntry, base) {
  const overrides = caseEntry?.overrides || {};
  const merged = { ...raw };
  delete merged.scenarios;
  delete merged.rentalIncomeScenarios;
  delete merged.baseScenarioId;

  const memberIds = base.pensions.map((member) => member.id);
  const memberChanges = new Map();
  const flatMemberFields = {};
  PENSION_CASE_MEMBER_KEYS.forEach((key) => {
    if (hasValue(overrides, key)) {
      flatMemberFields[key] = overrides[key];
    }
  });
  if (Object.keys(flatMemberFields).length > 0) {
    memberChanges.set(memberIds[0], { ...flatMemberFields });
  }
  (Array.isArray(overrides.pensionOverrides) ? overrides.pensionOverrides : []).forEach((entry) => {
    const { id, ...fields } = entry;
    memberChanges.set(id, { ...(memberChanges.get(id) || {}), ...fields });
  });

  if (Array.isArray(raw.pensions)) {
    merged.pensions = raw.pensions.map((member, index) => {
      const change = memberChanges.get(memberIds[index]);
      return change ? { ...member, ...change } : member;
    });
  } else {
    Object.assign(merged, memberChanges.get(memberIds[0]) || {});
  }

  if (hasValue(overrides, 'rentalIncomeToday')) {
    merged.rentalIncomeToday = overrides.rentalIncomeToday;
  }

  if (PENSION_CASE_TARGET_KEYS.some((key) => hasValue(overrides, key))) {
    PENSION_CASE_TARGET_KEYS.forEach((key) => {
      delete merged[key];
      if (hasValue(overrides, key)) {
        merged[key] = overrides[key];
      }
    });
  }

  const excludedIds = Array.isArray(overrides.excludedIncomeSourceIds)
    ? overrides.excludedIncomeSourceIds.map((id) => String(id ?? '').trim()).filter(Boolean)
    : [];
  const additionalSources = Array.isArray(overrides.additionalIncomeSources)
    ? overrides.additionalIncomeSources
    : [];

  if (excludedIds.length > 0 || additionalSources.length > 0) {
    const rawSources = Array.isArray(raw.otherIncomeSources) ? raw.otherIncomeSources : [];
    // Matched by position against the normalised base, because a source that
    // was authored without an id still has one by the time the case names it.
    const kept = rawSources.filter((_source, index) => (
      !excludedIds.includes(base.otherIncomeSources[index]?.id)
    ));
    merged.otherIncomeSources = [...kept, ...additionalSources];
  }

  const changesRetirementAge = [...memberChanges.values()]
    .some((change) => hasValue(change, 'retirementAge'));
  if (changesRetirementAge) {
    PENSION_CASE_TIMING_KEYS.forEach((key) => {
      delete merged[key];
    });
  }

  if (PENSION_CASE_START_KEYS.some((key) => hasValue(overrides, key))) {
    PENSION_CASE_START_KEYS.forEach((key) => {
      delete merged[key];
    });
  }

  PENSION_CASE_TIMING_KEYS.forEach((key) => {
    if (hasValue(overrides, key)) {
      merged[key] = overrides[key];
    }
  });

  return merged;
}

/** A case's own inputs, with any failure reported against the case that caused it. */
function normalizePensionCaseInputs(raw, caseEntry, index, base) {
  const merged = buildPensionCaseRawInputs(raw, caseEntry, base);

  try {
    return normalizePensionInputsInternal(merged);
  } catch (error) {
    const message = String(error?.message || error);
    // `legacy.` is the internal name for the one member a single-person
    // payload describes, and it means nothing to whoever wrote the case.
    const field = message
      .replace(/^generated\.pensionInputs\./, '')
      .replace(/^legacy\./, '');
    throw new Error(`${pensionCaseLabel(index, caseEntry.title)}: ${field}`);
  }
}

/** The case a bare payload is: one case, covering everything the payload says. */
function defaultPensionCase(base) {
  return {
    id: 'base',
    title: base.rentalIncomeToday > 0 ? 'With rental income' : 'Current position',
    description: '',
    overrides: {}
  };
}

/**
 * Every case this payload describes, each normalised as its own standalone
 * payload, plus which one opens the module.
 */
function buildPensionCaseSet(rawInputs) {
  const base = normalizePensionInputsInternal(rawInputs, { validateCases: false });
  const authored = Array.isArray(base.scenarios) && base.scenarios.length > 0
    ? base.scenarios
    : (Array.isArray(base.rentalIncomeScenarios) && base.rentalIncomeScenarios.length > 0
      ? pensionCasesFromRentalScenarios(base.rentalIncomeScenarios)
      : null);
  const entries = authored || [defaultPensionCase(base)];
  const cases = entries.map((caseEntry, index) => ({
    ...caseEntry,
    inputs: authored
      ? normalizePensionCaseInputs(rawInputs, caseEntry, index, base)
      : base
  }));
  const baseCaseId = cases.some((entry) => entry.id === base.baseScenarioId)
    ? base.baseScenarioId
    : cases[0].id;

  return {
    base,
    cases: cases.map((entry) => ({ ...entry, isBase: entry.id === baseCaseId })),
    baseCaseId,
    hasAuthoredCases: Boolean(authored)
  };
}

function resolvePensionCase(caseSet, scenarioId = '') {
  const requestedId = typeof scenarioId === 'string' ? scenarioId.trim() : '';
  return caseSet.cases.find((entry) => entry.id === requestedId)
    || caseSet.cases.find((entry) => entry.id === caseSet.baseCaseId)
    || caseSet.cases[0];
}

/**
 * What a case card says this case changes, in the words the client used.
 *
 * Built here rather than in the renderer because the video brief has to say
 * the same thing about the same case, and two descriptions of one decision is
 * one description too many.
 */
function buildPensionCaseSummary(caseEntry, caseInputs, base) {
  const overrides = caseEntry?.overrides || {};
  const parts = [];
  const isSingle = base.pensions.length === 1;
  const memberById = new Map(base.pensions.map((member) => [member.id, member]));
  const caseMemberById = new Map(caseInputs.pensions.map((member) => [member.id, member]));

  caseInputs.pensions.forEach((member) => {
    const baseMember = memberById.get(member.id);
    if (!baseMember || member.retirementAge === baseMember.retirementAge) {
      return;
    }
    parts.push(isSingle
      ? `Retires at ${member.retirementAge}`
      : `${member.title} retires at ${member.retirementAge}`);
  });

  if (caseInputs.incomeStartYear !== base.incomeStartYear) {
    parts.push(`income from ${caseInputs.incomeStartYear}`);
  }

  caseInputs.pensions.forEach((member) => {
    const baseMember = memberById.get(member.id);
    if (!baseMember) {
      return;
    }
    const who = isSingle ? '' : `${member.title} `;
    if (member.personalPct !== baseMember.personalPct) {
      parts.push(`${who}personal contributions ${toPercentText(member.personalPct)}`);
    }
    if (member.employerPct !== baseMember.employerPct) {
      parts.push(`${who}employer contributions ${toPercentText(member.employerPct)}`);
    }
    if (member.currentPot !== baseMember.currentPot) {
      parts.push(`${who}pension value ${toEuroText(member.currentPot)}`);
    }
    if (member.includeStatePension !== baseMember.includeStatePension) {
      parts.push(member.includeStatePension
        ? `${who}State Pension included`
        : `${who}State Pension excluded`);
    }
  });

  if (hasValue(overrides, 'rentalIncomeToday') && caseInputs.rentalIncomeToday !== base.rentalIncomeToday) {
    parts.push(caseInputs.rentalIncomeToday > 0
      ? `${toEuroText(caseInputs.rentalIncomeToday)} gross rent today`
      : 'rental income removed');
  }

  if (caseInputs.targetIncomeToday !== base.targetIncomeToday) {
    parts.push(`${toEuroText(caseInputs.targetIncomeToday)} target income`);
  }

  const baseSourceIds = new Set(base.otherIncomeSources.map((source) => source.id));
  const caseSourceIds = new Set(caseInputs.otherIncomeSources.map((source) => source.id));
  base.otherIncomeSources
    .filter((source) => !caseSourceIds.has(source.id))
    .forEach((source) => parts.push(`${source.title} removed`));
  caseInputs.otherIncomeSources
    .filter((source) => !baseSourceIds.has(source.id))
    .forEach((source) => parts.push(
      `${source.title} ${toEuroText(source.annualAmountToday)} p.a. from ${source.startYear}`
      + (source.endYear ? ` to ${source.endYear}` : '')
    ));

  if (parts.length === 0) {
    return '';
  }

  const [first, ...rest] = parts;
  const sentence = [first, ...rest.map((part) => part.charAt(0).toLowerCase() + part.slice(1))].join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * The chart axis every case shares: the union of the years the cases cover.
 *
 * Switching case should move the retirement point and the balance line. If the
 * axis rescaled with the case, the client would be reading two differently
 * stretched pictures and comparing them by eye.
 */
function buildPensionCaseAxis(caseSet) {
  const ranges = caseSet.cases.map((entry) => {
    const inputs = entry.inputs;
    const isAffordable = inputs.incomeMode === 'affordable' && !inputs.minDrawdownMode;
    const endYear = isAffordable && inputs.affordableEndAges.length > 0
      ? yearForAge(
        inputs.primaryPension,
        inputs.affordableEndAges[inputs.affordableEndAges.length - 1],
        inputs.currentYear
      )
      : inputs.horizonEndYear;
    return { startYear: inputs.incomeStartYear, endYear };
  });

  const startYear = Math.min(...ranges.map((range) => range.startYear));
  const endYear = Math.max(...ranges.map((range) => range.endYear));
  const retirementAgeById = new Map();
  caseSet.cases.forEach((entry) => {
    entry.inputs.pensions.forEach((member) => {
      retirementAgeById.set(
        member.id,
        Math.max(retirementAgeById.get(member.id) ?? member.retirementAge, member.retirementAge)
      );
    });
  });

  return {
    years: buildYearRange(startYear, endYear),
    endYear,
    accumulationEndAgeById: retirementAgeById
  };
}

/** A simulation's series, read onto the shared axis; a year it does not cover is a gap. */
function alignSeriesToYears(simulation, values, years) {
  return years.map((year) => {
    const index = simulationIndexForYear(simulation, year);
    const value = index >= 0 && Array.isArray(values) ? values[index] : null;
    return Number.isFinite(value) ? value : null;
  });
}

export function getPensionScenarioCases(rawInputs) {
  const caseSet = buildPensionCaseSet(rawInputs);
  return caseSet.cases.map((entry) => {
    const summary = caseSet.hasAuthoredCases
      ? buildPensionCaseSummary(entry, entry.inputs, caseSet.base)
      : '';
    return {
      id: entry.id,
      title: entry.title,
      description: entry.description,
      isBase: entry.isBase,
      summary,
      overrides: { ...entry.overrides },
      ...(hasValue(entry.overrides, 'rentalIncomeToday')
        ? { rentalIncomeToday: entry.overrides.rentalIncomeToday }
        : {})
    };
  });
}

export function getDefaultPensionScenarioId(rawInputs) {
  return buildPensionCaseSet(rawInputs).baseCaseId;
}

function aggregateScenario(memberScenarios) {
  const maxLength = Math.max(0, ...memberScenarios.map((scenario) => scenario.contribEurSeries.length));
  const aggregate = {
    personalEurSeries: [],
    employerEurSeries: [],
    contribEurSeries: [],
    growthEurSeries: []
  };

  for (let index = 0; index < maxLength; index += 1) {
    aggregate.personalEurSeries.push(sum(memberScenarios.map((scenario) => scenario.personalEurSeries[index] || 0)));
    aggregate.employerEurSeries.push(sum(memberScenarios.map((scenario) => scenario.employerEurSeries[index] || 0)));
    aggregate.contribEurSeries.push(sum(memberScenarios.map((scenario) => scenario.contribEurSeries[index] || 0)));
    aggregate.growthEurSeries.push(sum(memberScenarios.map((scenario) => scenario.growthEurSeries[index] || 0)));
  }

  return aggregate;
}

function buildAccumulationChart(member, currentScenario, maxScenario, axisEndAge = null) {
  const titleAlreadyIncludesPension = /pension/i.test(member.title);
  const titlePrefix = titleAlreadyIncludesPension ? member.title : `${member.title} Pension`;
  const titleSuffix = titleAlreadyIncludesPension
    ? ' pot at retirement (before withdrawals)'
    : ' Pot at Retirement (Before Withdrawals)';
  // A case that retires earlier stops earlier; the axis still runs to the
  // latest retirement age on offer, so the shorter run-up reads as a shorter
  // bar rather than as a differently drawn chart.
  const endAge = Number.isFinite(axisEndAge)
    ? Math.max(axisEndAge, member.retirementAge)
    : member.retirementAge;
  const labels = [];
  for (let age = member.currentAge; age <= endAge; age += 1) {
    labels.push(String(age));
  }
  const onAxis = (values) => padSeries(values, labels.length);

  return {
    title: `${titlePrefix}${titleSuffix}`,
    type: 'bar',
    labels,
    datasets: [
      {
        label: 'Pot (current)',
        data: onAxis(currentScenario.balances)
      },
      {
        label: 'Pot (max)',
        data: onAxis(maxScenario.balances)
      },
      {
        label: 'Personal (current)',
        data: onAxis(currentScenario.personalEurSeries)
      },
      {
        label: 'Employer (current)',
        data: onAxis(currentScenario.employerEurSeries)
      },
      {
        label: 'Growth (current)',
        data: onAxis(currentScenario.growthEurSeries)
      },
      {
        label: 'Personal (max)',
        data: onAxis(maxScenario.personalEurSeries)
      },
      {
        label: 'Employer (max)',
        data: onAxis(maxScenario.employerEurSeries)
      },
      {
        label: 'Growth (max)',
        data: onAxis(maxScenario.growthEurSeries)
      }
    ]
  };
}

function memberHasPrivatePensionPosition(member) {
  if (!member) {
    return false;
  }

  return (Number(member.currentPot) || 0) > 0
    || (Number(member.personalPct) || 0) > 0
    || (Number(member.employerPct) || 0) > 0;
}

function buildIncomeSurplusDataset(simulation, suffix, hidden = false, onAxis = (values) => values) {
  return {
    label: `Surplus (${suffix})`,
    data: onAxis(simulation.surpluses),
    hidden
  };
}

function buildIncomeStackDatasets(simulation, suffix, hidden = false, {
  includeSurplus = false,
  onAxis = (values) => values
} = {}) {
  const datasets = [
    {
      label: `Employment income (${suffix})`,
      data: onAxis(simulation.employmentIncome),
      hidden
    },
    {
      label: `State Pension (${suffix})`,
      data: onAxis(simulation.statePensionIncome),
      hidden
    },
    {
      label: `Rental income (${suffix})`,
      data: onAxis(simulation.rentalIncome),
      hidden
    },
    {
      label: `Other income (${suffix})`,
      data: onAxis(simulation.otherIncome),
      hidden
    },
    {
      label: `Mandatory pension withdrawals (${suffix})`,
      data: onAxis(simulation.mandatoryWithdrawals),
      hidden
    },
    {
      label: `Elected pension withdrawals (${suffix})`,
      data: onAxis(simulation.electedWithdrawals),
      hidden
    },
    {
      label: `Shortfall (${suffix})`,
      data: onAxis(simulation.shortfalls),
      hidden
    }
  ];

  if (includeSurplus) {
    datasets.push(buildIncomeSurplusDataset(simulation, suffix, hidden, onAxis));
  }

  return datasets;
}

function buildTerminalBalanceLabel(inputs, axisEndYear) {
  return `End ${axisPersonLabel(inputs.primaryPension)} age ${ageAtYear(inputs.primaryPension, axisEndYear, inputs.currentYear)}`;
}

function appendTerminalValue(values, simulation) {
  return [
    ...(Array.isArray(values) ? values : []),
    Number.isFinite(simulation?.endingBalanceAfterHorizon) ? simulation.endingBalanceAfterHorizon : 0
  ];
}

function buildRequiredPotPathData(requiredSimulation, axisYears, includeTerminalPoint = false) {
  if (!requiredSimulation) {
    return [];
  }

  const values = alignSeriesToYears(requiredSimulation, requiredSimulation.combinedBalances, axisYears);

  if (includeTerminalPoint) {
    values.push(requiredSimulation.endingBalanceAfterHorizon);
  }

  return values;
}

function buildHouseholdIncomeChart(inputs, currentSimulation, maxSimulation, requiredSimulation = null, axis) {
  const axisYears = axis.years;
  const axisLabels = axisYears.map((year) => ageLabelForYear(inputs, year));
  const axisAgeLabels = axisYears.map((year) => ageSummaryForYear(inputs, year));
  const onAxis = (simulation) => (values) => alignSeriesToYears(simulation, values, axisYears);
  const onCurrentAxis = onAxis(currentSimulation);
  const onMaxAxis = onAxis(maxSimulation);
  const terminalAgeLabel = inputs.isHousehold
    ? ageSummaryForYear(inputs, axis.endYear)
    : `${inputs.primaryPension.title} age ${ageAtYear(inputs.primaryPension, axis.endYear, inputs.currentYear)}`;
  const balanceLabels = [...axisLabels, buildTerminalBalanceLabel(inputs, axis.endYear)];
  const xAxisTitle = `${axisPersonLabel(inputs.primaryPension)} age`;
  const balanceDatasets = [
    {
      label: 'Combined pension balance (current)',
      data: appendTerminalValue(onCurrentAxis(currentSimulation.combinedBalances), currentSimulation)
    },
    {
      label: 'Combined pension balance (max)',
      data: appendTerminalValue(onMaxAxis(maxSimulation.combinedBalances), maxSimulation),
      hidden: true
    },
    ...(requiredSimulation
      ? [{
        label: 'Required pension pot path',
        data: buildRequiredPotPathData(requiredSimulation, axisYears, true)
      }]
      : [])
  ];
  const incomeDatasets = [
    {
      label: 'Required income',
      data: onCurrentAxis(currentSimulation.requiredIncome),
      borderColor: '#ffffff',
      backgroundColor: 'rgba(255, 255, 255, 0.16)',
      pointBackgroundColor: '#ffffff',
      pointBorderColor: '#ffffff'
    },
    ...buildIncomeStackDatasets(currentSimulation, 'current', false, { onAxis: onCurrentAxis }),
    ...buildIncomeStackDatasets(maxSimulation, 'max', true, { onAxis: onMaxAxis })
  ].map((dataset) => ({ ...dataset, forceYAxisID: 'y' }));
  const incomeCsvDatasets = [
    {
      label: 'Required income',
      data: onCurrentAxis(currentSimulation.requiredIncome),
      borderColor: '#ffffff',
      backgroundColor: 'rgba(255, 255, 255, 0.16)',
      pointBackgroundColor: '#ffffff',
      pointBorderColor: '#ffffff'
    },
    ...buildIncomeStackDatasets(currentSimulation, 'current', false, { includeSurplus: true, onAxis: onCurrentAxis }),
    ...buildIncomeStackDatasets(maxSimulation, 'max', true, { includeSurplus: true, onAxis: onMaxAxis })
  ].map((dataset) => ({ ...dataset, forceYAxisID: 'y' }));

  return {
    title: 'Retirement Income Stack and Pension Balance',
    type: 'bar',
    labels: axisLabels,
    subtitle: inputs.isHousehold
      ? `${xAxisTitle} shown; hover a point to see each person\u2019s age.`
      : '',
    meta: {
      kind: 'pensionDrawdownComposite',
      ageLabels: axisAgeLabels,
      balanceAgeLabels: [...axisAgeLabels, terminalAgeLabel]
    },
    display: {
      variant: 'pension-drawdown-composite',
      stacked: true,
      valueFormat: 'currency',
      xAxisTitle,
      yAxisTitle: 'Pension balance'
    },
    datasets: [
      {
        label: 'Combined pension balance (current)',
        data: onCurrentAxis(currentSimulation.combinedBalances)
      },
      {
        label: 'Combined pension balance (max)',
        data: onMaxAxis(maxSimulation.combinedBalances),
        hidden: true
      },
      ...(requiredSimulation
        ? [{
          label: 'Required pension pot path',
          data: buildRequiredPotPathData(requiredSimulation, axisYears)
        }]
        : []),
      ...incomeDatasets
    ],
    panels: {
      balance: {
        title: 'Pension balance',
        type: 'line',
        labels: balanceLabels,
        datasets: balanceDatasets,
        display: {
          valueFormat: 'currency',
          xAxisTitle,
          yAxisTitle: 'Pension balance',
          showLegend: false
        },
        meta: {
          ageLabels: [...axisAgeLabels, terminalAgeLabel]
        }
      },
      income: {
        title: 'Income sources',
        type: 'bar',
        labels: axisLabels,
        datasets: incomeDatasets,
        csvDatasets: incomeCsvDatasets,
        display: {
          stacked: true,
          valueFormat: 'currency',
          xAxisTitle,
          yAxisTitle: 'Annual income',
          showLegend: false
        },
        meta: {
          ageLabels: axisAgeLabels
        }
      }
    }
  };
}

function padSeries(values, targetLength) {
  const padded = Array.isArray(values) ? [...values] : [];
  while (padded.length < targetLength) {
    padded.push(null);
  }
  if (padded.length > targetLength) {
    padded.length = targetLength;
  }
  return padded;
}

function simulationIndexForYear(simulation, year) {
  return Array.isArray(simulation?.years)
    ? simulation.years.findIndex((entry) => entry === year)
    : -1;
}

function simulationSeriesValueAtYear(simulation, values, year, fallback = 0) {
  const index = simulationIndexForYear(simulation, year);
  if (index < 0) {
    return fallback;
  }
  const value = Array.isArray(values) ? values[index] : null;
  return Number.isFinite(value) ? value : fallback;
}

function simulationPensionBalancesAtYear(simulation, year, fallbackBalances = []) {
  const index = simulationIndexForYear(simulation, year);
  if (index < 0 || !Array.isArray(simulation?.perPensionOpeningBalances)) {
    return fallbackBalances.map((value) => clampToZero(value));
  }

  return simulation.perPensionOpeningBalances.map((series, pensionIndex) => {
    const value = Array.isArray(series) ? series[index] : null;
    return Number.isFinite(value) ? clampToZero(value) : clampToZero(fallbackBalances[pensionIndex] || 0);
  });
}

function buildAffordableIncomeResult(inputs, startBalances, endAge, axisYears, contributionMode) {
  const horizonEndYear = yearForAge(inputs.primaryPension, endAge, inputs.currentYear);
  const goalSeek = goalSeekAffordableHouseholdIncomeToday(inputs, startBalances, horizonEndYear, contributionMode);
  const balancesPadded = alignSeriesToYears(
    goalSeek.simulation,
    floorSeriesToZero(goalSeek.simulation.combinedBalances),
    axisYears
  );

  return {
    endAge,
    incomeToday: goalSeek.incomeTodayBest,
    incomeNominalAtRetirement: goalSeek.incomeNominalAtRetirement,
    totalIncomeToday: goalSeek.totalIncomeToday,
    totalIncomeNominalAtRetirement: goalSeek.totalIncomeNominalAtRetirement,
    requiredPotAtRetirement: goalSeek.requiredPotAtRetirementBest,
    gap: goalSeek.gap,
    endingBalanceAfterHorizon: goalSeek.simulation.endingBalanceAfterHorizon,
    balancesPadded
  };
}

function pensionFundedTargetAtStart(inputs) {
  const targetAtStart = targetIncomeNominalAtYear(inputs, inputs.incomeStartYear);
  const externalAtStart = buildIncomeBreakdownAtYear(inputs, inputs.incomeStartYear);
  return clampToZero(targetAtStart - externalAtStart.total);
}

export function computePensionProjection(rawInputs, { scenarioId = '' } = {}) {
  // Every case is projected as the standalone payload it describes, so the
  // figures on a case card are the figures that case would show in a module of
  // its own -- ages, timing, SFT year and all.
  const caseSet = buildPensionCaseSet(rawInputs);
  const selectedCase = resolvePensionCase(caseSet, scenarioId);
  const caseAxis = buildPensionCaseAxis(caseSet);
  const inputs = {
    ...selectedCase.inputs,
    ...(caseSet.base.rentalIncomeScenarios
      ? { rentalIncomeScenarios: caseSet.base.rentalIncomeScenarios }
      : {}),
    ...(caseSet.base.scenarios ? { scenarios: caseSet.base.scenarios } : {}),
    ...(caseSet.base.baseScenarioId ? { baseScenarioId: caseSet.base.baseScenarioId } : {}),
    selectedScenarioId: selectedCase.id,
    selectedScenarioTitle: selectedCase.title,
    selectedScenarioDescription: selectedCase.description,
    selectedScenarioSummary: caseSet.hasAuthoredCases
      ? buildPensionCaseSummary(selectedCase, selectedCase.inputs, caseSet.base)
      : ''
  };
  const isAffordableMode = inputs.incomeMode === 'affordable' && !inputs.minDrawdownMode;
  const hasRentalContext = inputs.rentalIncomeToday > 0
    || (Array.isArray(inputs.rentalIncomeScenarios) && inputs.rentalIncomeScenarios.length > 0)
    || caseSet.cases.some((entry) => hasValue(entry.overrides, 'rentalIncomeToday'));
  const hasOtherIncomeContext = inputs.otherIncomeSources.length > 0;
  const hasStatePensionContext = inputs.pensions.some((member) => member.includeStatePension);

  const currentContributionCapStats = {
    wasCapped: false,
    firstCappedAge: null,
    maxRelievableAtFirstCap: null
  };

  const currentMemberScenarios = inputs.pensions.map((member) => {
    const scenario = simulateMemberAccumulation(inputs, member, 'current');
    const cappedIndex = scenario.personalEurSeries.findIndex((personal, index) => {
      if (index === 0) {
        return false;
      }
      const year = inputs.currentYear + index - 1;
      const age = ageAtYear(member, year, inputs.currentYear);
      const salaryAtAge = member.currentSalary * Math.pow(1 + member.wageGrowthRate, year - inputs.currentYear);
      return member.personalPct * salaryAtAge > maxRelievablePersonalContribution(age, salaryAtAge);
    });
    if (cappedIndex > 0 && !currentContributionCapStats.wasCapped) {
      const year = inputs.currentYear + cappedIndex - 1;
      const age = ageAtYear(member, year, inputs.currentYear);
      const salaryAtAge = member.currentSalary * Math.pow(1 + member.wageGrowthRate, year - inputs.currentYear);
      currentContributionCapStats.wasCapped = true;
      currentContributionCapStats.firstCappedAge = age;
      currentContributionCapStats.maxRelievableAtFirstCap = maxRelievablePersonalContribution(age, salaryAtAge);
    }
    return scenario;
  });
  const maxMemberScenarios = inputs.pensions.map((member) => simulateMemberAccumulation(inputs, member, 'max'));

  const currentIncomeStartBalances = currentMemberScenarios.map((scenario) => (
    balanceFromMemberScenarioAtYear(scenario, inputs.incomeStartYear)
  ));
  const maxIncomeStartBalances = maxMemberScenarios.map((scenario) => (
    balanceFromMemberScenarioAtYear(scenario, inputs.incomeStartYear)
  ));
  const projectedTotalPotAtIncomeStartCurrent = sum(currentIncomeStartBalances);
  const projectedTotalPotAtIncomeStartMaxPersonal = sum(maxIncomeStartBalances);
  const currentScenario = aggregateScenario(currentMemberScenarios);
  const maxScenario = aggregateScenario(maxMemberScenarios);

  const retirementSimulationProjectedCurrent = simulateHouseholdRetirement(inputs, currentIncomeStartBalances, {
    contributionMode: 'current'
  });
  const retirementSimulationProjectedMax = simulateHouseholdRetirement(inputs, maxIncomeStartBalances, {
    contributionMode: 'max'
  });
  const projectedAvailablePotAtIncomeStartCurrent = simulationSeriesValueAtYear(
    retirementSimulationProjectedCurrent,
    retirementSimulationProjectedCurrent.combinedBalances,
    inputs.incomeStartYear
  );
  const projectedAvailablePotAtIncomeStartMaxPersonal = simulationSeriesValueAtYear(
    retirementSimulationProjectedMax,
    retirementSimulationProjectedMax.combinedBalances,
    inputs.incomeStartYear
  );

  const currentReferenceBalances = simulationPensionBalancesAtYear(
    retirementSimulationProjectedCurrent,
    inputs.requiredPotReferenceYear,
    currentIncomeStartBalances
  );
  const maxReferenceBalances = simulationPensionBalancesAtYear(
    retirementSimulationProjectedMax,
    inputs.requiredPotReferenceYear,
    maxIncomeStartBalances
  );
  const projectedPotCurrent = sum(currentReferenceBalances);
  const projectedPotMaxPersonal = sum(maxReferenceBalances);

  const requiredResult = isAffordableMode ? null : findRequiredStartingBalances(inputs, currentReferenceBalances);
  const requiredPot = requiredResult?.requiredPot ?? null;
  const readiness = buildPensionReadiness({
    isAffordableMode,
    requiredPot,
    projectedPotCurrent,
    projectedPotMaxPersonal
  });

  let sustainabilityLabels = retirementSimulationProjectedCurrent.labels;
  let affordableChartDatasets = [];
  let affordableCurrentResults = [];
  let affordableMaxResults = [];

  const depletionAgeProjected = retirementSimulationProjectedCurrent.labels[
    retirementSimulationProjectedCurrent.combinedBalances.findIndex((value) => value === 0)
  ] ?? null;
  const depletionAgeRequired = requiredResult?.simulation
    ? requiredResult.simulation.labels[requiredResult.simulation.combinedBalances.findIndex((value) => value === 0)] ?? null
    : null;

  if (isAffordableMode) {
    const affordableEndAges = inputs.affordableEndAges;
    sustainabilityLabels = caseAxis.years.map((year) => ageLabelForYear(inputs, year));

    affordableCurrentResults = affordableEndAges.map((endAge) => (
      buildAffordableIncomeResult(inputs, currentIncomeStartBalances, endAge, caseAxis.years, 'current')
    ));
    affordableMaxResults = affordableEndAges.map((endAge) => (
      buildAffordableIncomeResult(inputs, maxIncomeStartBalances, endAge, caseAxis.years, 'max')
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

  const retirementYear = inputs.incomeStartYear;
  const sftMeta = computeSft(inputs.requiredPotReferenceYear);
  const sftBreaches = isAffordableMode
    ? {
      current: currentReferenceBalances.some((value) => value > sftMeta.sftValue),
      max: maxReferenceBalances.some((value) => value > sftMeta.sftValue),
      required: false,
      any: currentReferenceBalances.some((value) => value > sftMeta.sftValue)
        || maxReferenceBalances.some((value) => value > sftMeta.sftValue)
    }
    : {
      current: currentReferenceBalances.some((value) => value > sftMeta.sftValue),
      max: maxReferenceBalances.some((value) => value > sftMeta.sftValue),
      required: (requiredResult?.requiredBalances || []).some((value) => value > sftMeta.sftValue),
      any: currentReferenceBalances.some((value) => value > sftMeta.sftValue)
        || maxReferenceBalances.some((value) => value > sftMeta.sftValue)
        || (requiredResult?.requiredBalances || []).some((value) => value > sftMeta.sftValue)
    };
  const sftSentence = buildSftSummarySentence(sftBreaches, sftMeta);

  const targetIncomeNominalAtRetirement = targetIncomeNominalAtYear(inputs, inputs.incomeStartYear);
  const externalAtTargetStart = buildIncomeBreakdownAtYear(inputs, inputs.incomeStartYear);
  const rentalIncomeNominalAtRetirement = externalAtTargetStart.rentalIncome;
  const statePensionNominalAtRetirement = externalAtTargetStart.statePension;
  const otherIncomeNominalAtRetirement = externalAtTargetStart.otherIncome;
  const employmentIncomeNominalAtRetirement = externalAtTargetStart.employmentIncome;
  const pensionWithdrawalNominalAtRetirement = pensionFundedTargetAtStart(inputs);
  const expectedFactor = inflationFactorForYear(inputs, inputs.incomeStartYear);
  const expectedNominal = inputs.targetIncomeToday * expectedFactor;
  const nominalDiff = Math.abs(targetIncomeNominalAtRetirement - expectedNominal);
  const nominalTolerance = 1e-6 * Math.max(1, Math.abs(expectedNominal));
  if (!isAffordableMode && Number.isFinite(expectedNominal) && nominalDiff > nominalTolerance) {
    console.warn('[Pension] target income nominal-at-retirement consistency mismatch', {
      currentYear: inputs.currentYear,
      targetStartYear: inputs.incomeStartYear,
      inflationRate: inputs.inflationRate,
      nominalAtRetirement: targetIncomeNominalAtRetirement,
      expectedNominal
    });
  }

  const modeLabel = inputs.minDrawdownMode ? 'Mandatory withdrawals' : (isAffordableMode ? 'Affordable income' : 'Target withdrawals');
  const currentPersonalWasCapped = currentContributionCapStats.wasCapped;
  const firstCappedAge = currentContributionCapStats.firstCappedAge;
  const maxRelievableAtFirstCap = currentContributionCapStats.maxRelievableAtFirstCap;
  const currentPersonalCapSentence = currentPersonalWasCapped && Number.isInteger(firstCappedAge)
    ? `A current personal contribution rate reaches the Irish max tax-relievable limit from age ${firstCappedAge}, so personal contributions are capped from that point.`
    : '';

  const assumptionsRows = inputs.isHousehold
    ? [
      ['Household members', inputs.pensions.map((member) => member.title).join(', ')],
      ['Household income start year', String(inputs.incomeStartYear)],
      ['Household income start ages', ageSummaryForYear(inputs, inputs.incomeStartYear)],
      ['Required pension pot reference year', String(inputs.requiredPotReferenceYear)],
      ['Required pension pot reference ages', ageSummaryForYear(inputs, inputs.requiredPotReferenceYear)],
      ['Bridge employment income', inputs.includeEmploymentIncomeDuringBridge ? 'Included before each member retires' : 'Excluded'],
      ...inputs.pensions.flatMap((member) => ([
        [`${member.title} current age`, String(member.currentAge)],
        [`${member.title} retirement age`, String(member.retirementAge)],
        [`${member.title} current salary`, toEuroText(member.currentSalary)],
        [`${member.title} current pension value`, toEuroText(member.currentPot)],
        [`${member.title} personal contribution`, toPercentText(member.personalPct)],
        [`${member.title} employer contribution`, toPercentText(member.employerPct)],
        [`${member.title} State Pension`, member.includeStatePension
          ? `${toPercentText(member.statePensionFraction, 0)} of maximum from age ${member.statePensionStartAge}`
          : 'Excluded']
      ]))
    ]
    : [
      ['Current age', String(inputs.currentAge)],
      ['Retirement age', String(inputs.retirementAge)],
      ['Current salary', toEuroText(inputs.primaryPension.currentSalary)],
      ['Current pension value', toEuroText(inputs.primaryPension.currentPot)],
      ['Personal contribution', toPercentText(inputs.primaryPension.personalPct)],
      ['Employer contribution', toPercentText(inputs.primaryPension.employerPct)],
      ['State Pension', inputs.primaryPension.includeStatePension
        ? `${toPercentText(inputs.primaryPension.statePensionFraction, 0)} of maximum from age ${inputs.primaryPension.statePensionStartAge}`
        : 'Excluded']
    ];

  const assumptionsTable = {
    columns: ['Assumption', 'Value'],
    rows: [
      ...assumptionsRows,
      ['Growth rate', toPercentText(inputs.growthRate)],
      ['Wage growth', toPercentText(inputs.wageGrowthRate)],
      ['Inflation', toPercentText(inputs.inflationRate)],
      ['Maximum Irish State Pension (gross)', `${toEuroText(STATE_PENSION_ANNUAL_TODAY, 2)} a year (€299.30 a week)`],
      ['State Pension rule', `${IRELAND_RULES_CATALOGUE_VERSION}; effective January 2026; default start age 66`],
      ['State Pension escalation', toPercentText(IRISH_STATE_PENSION_CONTRIBUTORY.defaultEscalationRate)],
      ['State Pension entitlement', IRISH_STATE_PENSION_CONTRIBUTORY.entitlementNotice],
      ['State Pension guidance source', IRISH_STATE_PENSION_CONTRIBUTORY.source.url],
      ['State Pension rate source', IRISH_STATE_PENSION_CONTRIBUTORY.source.ratesUrl],
      ...(inputs.includeEmploymentIncomeDuringBridge
        ? [['Gross employment income at income start', toEuroText(employmentIncomeNominalAtRetirement)]]
        : []),
      ...(hasRentalContext
        ? [
          ['Retirement income case', inputs.selectedScenarioTitle],
          ['Gross rental income today', toEuroText(inputs.rentalIncomeToday)],
          ['Gross rental income at target start', toEuroText(rentalIncomeNominalAtRetirement)]
        ]
        : []),
      ...(hasOtherIncomeContext
        ? inputs.otherIncomeSources.map((source) => [
          source.title,
          `${toEuroText(source.annualAmountToday)} p.a. from ${source.startYear}${source.endYear ? ` to ${source.endYear}` : ''}${source.inflationIndexed ? ' (indexed)' : ' (flat nominal)'}`
        ])
        : []),
      isAffordableMode
        ? ['Affordable income mode', 'Goal-seek (see outputs)']
        : ['Target retirement income', toEuroText(inputs.targetIncomeToday)],
      ['Earnings cap for max-relief maths', toEuroText(115000)],
      ['ARF minimum withdrawals', '4% under 70, 5% from 70, 6% where an individual fund exceeds €2m'],
      ...(currentPersonalWasCapped && Number.isInteger(firstCappedAge)
        ? [[
          'Current personal contributions capped?',
          `Yes (from age ${firstCappedAge})`
        ]]
        : []),
      ['Mode', modeLabel],
      [
        'Horizon',
        isAffordableMode
          ? inputs.affordableEndAges.join(', ')
          : `${inputs.horizonEndYear} (${ageSummaryForYear(inputs, inputs.horizonEndYear)})`
      ]
    ]
  };

  const outputsRows = inputs.isHousehold
    ? [
      ['Projected available pension pot at income start (current)', toEuroText(projectedAvailablePotAtIncomeStartCurrent)],
      ['Projected available pension pot at income start (max personal)', toEuroText(projectedAvailablePotAtIncomeStartMaxPersonal)],
      ['Projected combined pot at required reference (current)', toEuroText(projectedPotCurrent)],
      ['Projected combined pot at required reference (max personal)', toEuroText(projectedPotMaxPersonal)]
    ]
    : [
      ['Projected pot at target start (current)', toEuroText(projectedPotCurrent)],
      ['Projected pot at target start (max personal)', toEuroText(projectedPotMaxPersonal)]
    ];

  if (isAffordableMode) {
    affordableCurrentResults.forEach((entry) => {
      outputsRows.push([
        `Pension-funded affordable income (current, deplete by ${entry.endAge})`,
        `${toEuroText(entry.incomeToday)} p.a.`
      ]);
      outputsRows.push([
        `Affordable income (current, deplete by ${entry.endAge})`,
        `${toEuroText(entry.totalIncomeToday)} p.a.`
      ]);
    });
    affordableMaxResults.forEach((entry) => {
      outputsRows.push([
        `Pension-funded affordable income (max, deplete by ${entry.endAge})`,
        `${toEuroText(entry.incomeToday)} p.a.`
      ]);
      outputsRows.push([
        `Affordable income (max, deplete by ${entry.endAge})`,
        `${toEuroText(entry.totalIncomeToday)} p.a.`
      ]);
    });
  } else {
    outputsRows.push(['Retirement income position', readiness.readinessSentence]);
    if (readiness.requiredPotIsApplicable) {
      outputsRows.push([
        inputs.isHousehold
          ? `Required pension pot at reference year, depleting by ${inputs.horizonEndYear}`
          : `Required pension pot at target start, depleting by age ${inputs.horizonEndAge}`,
        toEuroText(requiredPot)
      ]);
      if (readiness.currentGapVsRequired > 0) {
        outputsRows.push([
          inputs.isHousehold ? 'Current gap vs required at reference year' : 'Current gap vs required',
          toEuroText(readiness.currentGapVsRequired)
        ]);
      } else if (readiness.currentSurplusVsRequired > 0) {
        outputsRows.push([
          inputs.isHousehold ? 'Current surplus vs required at reference year' : 'Current surplus vs required',
          toEuroText(readiness.currentSurplusVsRequired)
        ]);
      } else {
        outputsRows.push([
          inputs.isHousehold ? 'Current position vs required at reference year' : 'Current position vs required',
          'On track within tolerance'
        ]);
      }
      if (readiness.maxGapVsRequired > 0) {
        outputsRows.push(['Max-contribution gap vs required', toEuroText(readiness.maxGapVsRequired)]);
      } else if (readiness.maxSurplusVsRequired > 0) {
        outputsRows.push(['Max-contribution surplus vs required', toEuroText(readiness.maxSurplusVsRequired)]);
      }
    }
    outputsRows.push(['Target income (today\'s money)', toEuroText(inputs.targetIncomeToday)]);
    outputsRows.push(['Target income (nominal at target start)', toEuroText(targetIncomeNominalAtRetirement)]);
    if (inputs.includeEmploymentIncomeDuringBridge) {
      outputsRows.push(['Gross employment income at target start', toEuroText(employmentIncomeNominalAtRetirement)]);
    }
    if (hasStatePensionContext) {
      outputsRows.push(['State Pension at target start', toEuroText(statePensionNominalAtRetirement)]);
    }
    if (hasRentalContext) {
      outputsRows.push(['Gross rental income at target start', toEuroText(rentalIncomeNominalAtRetirement)]);
    }
    if (hasOtherIncomeContext) {
      inputs.otherIncomeSources.forEach((source) => {
        outputsRows.push([
          `${source.title} at target start`,
          toEuroText(incomeSourceAmountAtYear(inputs, source, inputs.incomeStartYear))
        ]);
      });
      if (inputs.otherIncomeSources.length > 1) {
        outputsRows.push(['Other income at target start', toEuroText(otherIncomeNominalAtRetirement)]);
      }
    }
    outputsRows.push([
      'Pension-funded target after other income (nominal at target start)',
      toEuroText(pensionWithdrawalNominalAtRetirement)
    ]);
    outputsRows.push(['First-year mandatory pension withdrawals', toEuroText(retirementSimulationProjectedCurrent.firstYearMandatoryWithdrawal)]);
    outputsRows.push(['First-year elected pension withdrawals', toEuroText(retirementSimulationProjectedCurrent.firstYearElectedWithdrawal)]);
    outputsRows.push(['First-year surplus over target', toEuroText(retirementSimulationProjectedCurrent.surpluses[0] || 0)]);
    if (readiness.requiredPotIsApplicable) {
      outputsRows.push(['Required path ending balance', toEuroText(requiredResult?.depletionResidual ?? 0)]);
    }
    outputsRows.push(['Depletion horizon year and ages', `${inputs.horizonEndYear} (${ageSummaryForYear(inputs, inputs.horizonEndYear)})`]);
    outputsRows.push(['Total shortfall on current path', toEuroText(retirementSimulationProjectedCurrent.totalShortfall)]);
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

  const outputsTable = {
    columns: ['Output', 'Value'],
    rows: outputsRows
  };

  const charts = inputs.pensions
    .map((member, index) => {
      if (!memberHasPrivatePensionPosition(member)) {
        return null;
      }

      return buildAccumulationChart(
        member,
        currentMemberScenarios[index],
        maxMemberScenarios[index],
        caseAxis.accumulationEndAgeById.get(member.id)
      );
    })
    .filter(Boolean);

  if (isAffordableMode) {
    charts.push({
      title: 'Retirement Sustainability (Affordable Income)',
      type: 'line',
      labels: sustainabilityLabels,
      datasets: affordableChartDatasets
    });
  } else {
    charts.push(buildHouseholdIncomeChart(
      inputs,
      retirementSimulationProjectedCurrent,
      retirementSimulationProjectedMax,
      readiness.requiredPotIsApplicable ? requiredResult?.simulation ?? null : null,
      caseAxis
    ));
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
      pensions: inputs.pensions,
      projectedPotCurrent,
      projectedPotMaxPersonal,
      projectedAvailablePotAtIncomeStartCurrent,
      projectedAvailablePotAtIncomeStartMaxPersonal,
      projectedTotalPotAtIncomeStartCurrent,
      projectedTotalPotAtIncomeStartMaxPersonal,
      currentIncomeStartBalances,
      maxIncomeStartBalances,
      currentReferenceBalances,
      maxReferenceBalances,
      requiredPot,
      requiredPotDepletionResidual: requiredResult?.depletionResidual ?? null,
      requiredPotDepletionTolerance: requiredResult?.depletionTolerance ?? REQUIRED_POT_TOLERANCE_EUR,
      requiredPotIsApplicable: readiness.requiredPotIsApplicable,
      readinessStatus: readiness.readinessStatus,
      readinessSentence: readiness.readinessSentence,
      currentSurplusVsRequired: readiness.currentSurplusVsRequired,
      currentGapVsRequired: readiness.currentGapVsRequired,
      maxSurplusVsRequired: readiness.maxSurplusVsRequired,
      maxGapVsRequired: readiness.maxGapVsRequired,
      requiredBalances: requiredResult?.requiredBalances ?? [],
      rentalIncomeToday: inputs.rentalIncomeToday,
      hasRentalContext,
      rentalIncomeNominalAtRetirement,
      employmentIncomeNominalAtRetirement,
      statePensionNominalAtRetirement,
      otherIncomeNominalAtRetirement,
      pensionWithdrawalNominalAtRetirement,
      selectedScenarioId: inputs.selectedScenarioId,
      selectedScenarioTitle: inputs.selectedScenarioTitle,
      selectedScenarioDescription: inputs.selectedScenarioDescription,
      selectedScenarioSummary: inputs.selectedScenarioSummary,
      selectedScenarioIsBase: selectedCase.isBase,
      selectedScenarioOverrides: { ...selectedCase.overrides },
      baseScenarioId: caseSet.baseCaseId,
      chartAxisYears: caseAxis.years,
      retirementYear,
      targetStartYear: inputs.targetStartYear,
      incomeStartYear: inputs.incomeStartYear,
      requiredPotReferenceYear: inputs.requiredPotReferenceYear,
      horizonEndYear: inputs.horizonEndYear,
      sftValue: sftMeta.sftValue,
      sftYearUsed: sftMeta.sftYearUsed,
      sftHeldConstantBeyond2029: sftMeta.heldConstantBeyond2029,
      sftBreaches,
      sftSentence,
      currentPersonalWasCapped,
      firstCappedAge,
      maxRelievableAtFirstCap,
      currentPersonalCapSentence,
      currentScenario,
      maxScenario,
      memberScenarios: {
        current: currentMemberScenarios,
        max: maxMemberScenarios
      },
      retirementSimulationProjectedCurrent,
      retirementSimulationProjectedMax,
      retirementSimulationRequired: requiredResult?.simulation ?? null,
      depletionAgeProjected,
      depletionAgeRequired,
      maxSeriesMonotonicIssues: [],
      retirementEndingBalanceFromProjected: retirementSimulationProjectedCurrent.endingBalanceAfterHorizon,
      retirementEndingBalanceFromProjectedMax: retirementSimulationProjectedMax.endingBalanceAfterHorizon,
      retirementEndingBalanceFromRequired: requiredResult?.simulation?.endingBalanceAfterHorizon ?? null,
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
