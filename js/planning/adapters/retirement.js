import { PLANEIR_ASSUMPTIONS, assumptionRecord } from '../planeir_assumptions.js';
import { computePensionProjection, normalizePensionInputs } from '../../pension_math.js';
import { computeNetRetirementProjection } from '../../net_retirement_math.js';
import {
  IRELAND_RULES_CATALOGUE_VERSION,
  IRISH_STATE_PENSION_CONTRIBUTORY,
  normalizeStatePensionFraction
} from '../ireland_rules.js';
import { NON_CONTRIBUTORY_PENSION_TYPES, hasOwnerConfirmedNone } from '../profile.js';
import {
  annualExpenses,
  availableInvestmentAmount,
  baseCurrency,
  createModuleRunResult,
  crossCurrencyWarnings,
  findGoal,
  getAssumption,
  grossEmploymentIncome,
  missing,
  moneyAmount,
  personForId,
  readinessFromMissing,
  sumKnown
} from './common.js';

export const PENSION_ADAPTER_VERSION = '1.1.0';
export const NET_RETIREMENT_ADAPTER_VERSION = '1.0.0';

const RETIREMENT_GOALS = ['improve_pension', 'retire', 'retire_early'];

function retirementTarget(profile) {
  const explicit = getAssumption(profile, 'retirement.targetIncomeToday');
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const goal = findGoal(profile, RETIREMENT_GOALS);
  const goalTarget = moneyAmount(goal?.targetAmount, baseCurrency(profile));
  return goalTarget ?? annualExpenses(profile);
}

function groupPensionsByOwner(profile) {
  const grouped = new Map();
  (profile.pensions || []).forEach((pension) => {
    if (!grouped.has(pension.ownerId)) grouped.set(pension.ownerId, []);
    grouped.get(pension.ownerId).push(pension);
  });
  return grouped;
}

function ownerLabel(profile, ownerId) {
  if (ownerId === profile.primaryPerson?.personId) return 'you';
  if (ownerId === profile.partner?.personId) return profile.partner.displayName || 'your partner';
  return 'this person';
}

function ownerNeed(profile, ownerId, fieldPath, reason, moduleIds, extras = {}) {
  return {
    ...missing(fieldPath, reason, moduleIds),
    entityId: extras.entityId || ownerId,
    ownerId,
    entityLabel: extras.entityLabel || ownerLabel(profile, ownerId),
    reasonCode: extras.reasonCode || 'required_input_missing',
    answerPolicy: extras.answerPolicy || 'unknown_allowed',
    ...(extras.prompt ? { prompt: extras.prompt } : {})
  };
}

function pensionNeed(profile, pension, index, field, reason, moduleIds, extras = {}) {
  const owner = pension.ownerId === profile.primaryPerson?.personId
    ? 'your'
    : profile.partner?.displayName
      ? `your partner ${profile.partner.displayName}'s`
      : "your partner's";
  const label = pension.label || `${owner} ${pension.type.replaceAll('_', ' ')} pension`;
  return ownerNeed(
    profile,
    pension.ownerId,
    `/pensions/${index}/${field}`,
    reason,
    moduleIds,
    {
      ...extras,
      entityId: pension.pensionId,
      entityLabel: label
    }
  );
}

function effectiveContributionStatus(pension) {
  if (NON_CONTRIBUTORY_PENSION_TYPES.includes(pension.type)) return 'not_applicable';
  if (pension.contributionStatus) return pension.contributionStatus;
  // Existing profiles predate contributionStatus. Explicitly recorded current
  // rates are sufficient legacy evidence that this is an active arrangement;
  // otherwise the status is genuinely unknown and is asked before percentages.
  if (typeof pension.employeeContributionRate === 'number'
    || typeof pension.employerContributionRate === 'number') return 'active';
  return 'unknown';
}

export function getPensionProjectionReadiness(profile) {
  const relevant = Boolean(findGoal(profile, RETIREMENT_GOALS));
  if (!relevant) return readinessFromMissing([], { relevant: false });
  const moduleIds = ['pension_projection'];
  const requiredMissing = [];
  const grouped = groupPensionsByOwner(profile);
  // BOTH PEOPLE RETIRE, SO BOTH PENSIONS COUNT.
  //
  // This function used to iterate only the owners of pensions that already
  // exist, so a partner with nothing recorded was never in the loop: nothing
  // was required, nothing was asked, and the projection quietly answered "can
  // we afford to retire" using one person's fund. A real call lost a 500,000
  // pension that way.
  //
  // Asked ONLY once the client has confirmed a partner exists -- an unasked
  // question about a person who may not be there is worse than the gap -- and
  // silenced permanently once they say that partner has none.
  const householdNone = profile.assumptions?.values?.completionFacts?.confirmedNonePaths?.['/pensions'] === true;
  const expectedOwners = [profile.primaryPerson, profile.partner].filter((person) => person?.personId);
  expectedOwners.forEach((person) => {
    const ownerId = person.personId;
    if (grouped.has(ownerId) || householdNone || hasOwnerConfirmedNone(profile, '/pensions', ownerId)) return;
    const label = ownerId === profile.primaryPerson.personId
      ? 'your'
      : `${person.displayName || 'your partner'}'s`;
    const prompt = ownerId === profile.primaryPerson.personId
      ? 'Do you have an occupational pension, PRSA, personal pension, buyout bond or defined-benefit pension to include?'
      : `Does ${person.displayName || 'your partner'} have an occupational pension, PRSA, personal pension, buyout bond or defined-benefit pension to include?`;
    requiredMissing.push(ownerNeed(
      profile,
      ownerId,
      '/pensions',
      `Add ${label} pension, or confirm there is none.`,
      moduleIds,
      {
        entityLabel: `${label} pensions`,
        reasonCode: 'owner_pension_position_missing',
        answerPolicy: 'value_or_none',
        prompt
      }
    ));
  });
  grouped.forEach((pensions, ownerId) => {
    const person = personForId(profile, ownerId);
    const personPath = profile.partner?.personId === ownerId ? '/partner' : '/primaryPerson';
    if (!person) {
      requiredMissing.push(ownerNeed(
        profile,
        ownerId,
        '/pensions',
        `Pension owner ${ownerId} does not match a household person.`,
        moduleIds,
        { reasonCode: 'pension_owner_invalid', answerPolicy: 'value' }
      ));
      return;
    }
    if (typeof person.age !== 'number') {
      requiredMissing.push(ownerNeed(profile, ownerId, `${personPath}/age`, 'Add the current age.', moduleIds));
    }
    if (typeof person.intendedRetirementAge !== 'number') {
      requiredMissing.push(ownerNeed(
        profile,
        ownerId,
        `${personPath}/intendedRetirementAge`,
        'Add the intended retirement age.',
        moduleIds
      ));
    }
    if (grossEmploymentIncome(profile, ownerId) <= 0 && person.employmentStatus !== 'retired') {
      requiredMissing.push(ownerNeed(
        profile,
        ownerId,
        '/incomeSources',
        `Add current gross income for ${person.displayName || person.role}.`,
        moduleIds,
        { reasonCode: 'owner_income_missing' }
      ));
    }
    pensions.forEach((pension) => {
      const index = profile.pensions.indexOf(pension);
      if (pension.type === 'defined_benefit') {
        if (!pension.projectedAnnualIncome) {
          requiredMissing.push(pensionNeed(
            profile,
            pension,
            index,
            'projectedAnnualIncome',
            'Add the gross annual defined-benefit pension income.',
            moduleIds,
            { reasonCode: 'defined_benefit_income_missing' }
          ));
        }
        if (typeof pension.benefitStartAge !== 'number') {
          requiredMissing.push(pensionNeed(
            profile,
            pension,
            index,
            'benefitStartAge',
            'Add the age when the defined-benefit pension starts.',
            moduleIds,
            { reasonCode: 'defined_benefit_start_age_missing' }
          ));
        }
        return;
      }
      if (!pension.currentValue) {
        requiredMissing.push(pensionNeed(
          profile,
          pension,
          index,
          'currentValue',
          'Add the current pension value.',
          moduleIds,
          { reasonCode: 'pension_value_missing' }
        ));
      }
      // A PRESERVED POLICY CANNOT BE CONTRIBUTED TO. Asking a client what they
      // and their employer pay into a buyout bond is a question with no correct
      // answer, and the meeting repeated it because no answer could be
      // accepted. Its value still counts towards the projection; only the
      // contribution questions are dropped.
      if (NON_CONTRIBUTORY_PENSION_TYPES.includes(pension.type)) return;
      const contributionStatus = effectiveContributionStatus(pension);
      if (contributionStatus === 'unknown') {
        requiredMissing.push(pensionNeed(
          profile,
          pension,
          index,
          'contributionStatus',
          'Confirm whether contributions are currently being paid into this pension.',
          moduleIds,
          {
            reasonCode: 'pension_contribution_status_unknown',
            answerPolicy: 'value',
            prompt: `Are contributions currently being paid into ${pension.label || 'this pension'}, or is it paid up?`
          }
        ));
        return;
      }
      if (['paid_up', 'not_applicable'].includes(contributionStatus)) return;
      if (typeof pension.employeeContributionRate !== 'number') {
        requiredMissing.push(pensionNeed(
          profile,
          pension,
          index,
          'employeeContributionRate',
          'Add the personal pension contribution rate.',
          moduleIds,
          { reasonCode: 'pension_personal_contribution_missing' }
        ));
      }
      if (pension.type === 'occupational' && typeof pension.employerContributionRate !== 'number') {
        requiredMissing.push(pensionNeed(
          profile,
          pension,
          index,
          'employerContributionRate',
          'Add the employer pension contribution rate, including zero.',
          moduleIds,
          { reasonCode: 'pension_employer_contribution_missing' }
        ));
      }
    });
  });
  if (retirementTarget(profile) === null) {
    requiredMissing.push(missing('/assumptions/values/retirement/targetIncomeToday', 'Add target annual retirement income or current annual spending.', moduleIds));
  }
  // Centrally approved Planéir assumptions. Named and versioned so every
  // projected figure can state the basis it rests on.
  const assumptionsUsed = [
    assumptionRecord('investmentGrowth'),
    assumptionRecord('generalInflation')
  ];
  assumptionsUsed.push({
    key: 'statePensionContributory',
    value: IRISH_STATE_PENSION_CONTRIBUTORY.annualMaximumEur,
    reason: `${IRELAND_RULES_CATALOGUE_VERSION}, effective January 2026. Maximum gross rate only; actual entitlement depends on each person’s PRSI record.`
  });
  const warnings = [
    'Pension balances and projected withdrawals are shown before tax. Tax and wider retirement-income needs require separate adviser review.',
    ...(profile.pensions.some((pension) => pension.type === 'defined_benefit')
      ? ['Defined-benefit income is included at its stated annual amount without inventing an escalation rate.']
      : []),
    ...crossCurrencyWarnings(profile, [
      ['Pension values', profile.pensions.map((pension) => pension.currentValue)],
      ['Income values', profile.incomeSources.map((income) => income.grossAnnual)]
    ])
  ];
  return readinessFromMissing(requiredMissing, { assumptionsUsed, warnings });
}

/**
 * WHOSE CLOCK AN INCOME'S TIMELINE IS MEASURED AGAINST.
 *
 * A jointly owned rent has two owners with two retirement ages. It starts at
 * the EARLIEST of them: the rent does not pause because the later retiree is
 * still working, and assuming the later age would drop real income out of the
 * early years of the projection.
 *
 * The PERSON is returned, not just the age, because an age is only a calendar
 * year relative to somebody's current age. Handing the engine a bare age let it
 * pick the reference person out of its own pension members, and an income can
 * belong to somebody who holds no pension at all. A couple who both held
 * pensions got no projection whatsoever; a household where only one did got the
 * rent measured against the wrong person's clock, and that one did not fail --
 * it moved the income seven years earlier and said nothing.
 */
function earliestRetiringOwner(profile, ownerIds) {
  const owners = (ownerIds || [])
    .map((ownerId) => personForId(profile, ownerId))
    .filter(Boolean);
  const stated = owners.filter((person) => typeof person.intendedRetirementAge === 'number');
  if (stated.length === 0) return owners[0] ?? null;
  return stated.reduce((earliest, person) => (
    person.intendedRetirementAge < earliest.intendedRetirementAge ? person : earliest
  ));
}

export function buildPensionProjectionInput(profile) {
  const currency = baseCurrency(profile);
  const grouped = groupPensionsByOwner(profile);
  const settings = getAssumption(profile, 'retirement', {});
  const pensions = Array.from(grouped.entries()).map(([ownerId, ownerPensions], index) => {
    const person = personForId(profile, ownerId);
    const legacyIncludeSetting = settings.includeStatePension;
    const includeStatePension = typeof legacyIncludeSetting === 'boolean'
      ? legacyIncludeSetting
      : getAssumption(profile, `retirement.includeStatePension.${ownerId}`, true);
    const rawFraction = getAssumption(profile, `retirement.statePensionFraction.${ownerId}`);
    const statePensionFraction = includeStatePension === false
      ? 0
      : normalizeStatePensionFraction(rawFraction, 1);
    const activePensions = ownerPensions.filter((pension) => effectiveContributionStatus(pension) === 'active');
    const fundedPensions = ownerPensions.filter((pension) => pension.type !== 'defined_benefit');
    return {
      id: ownerId,
      title: person?.displayName ? `${person.displayName} pension` : `Pension ${index + 1}`,
      currentAge: person.age,
      retirementAge: person.intendedRetirementAge,
      currentSalary: grossEmploymentIncome(profile, ownerId),
      currentPot: sumKnown(fundedPensions.map((pension) => moneyAmount(pension.currentValue, currency))),
      personalPct: Math.min(1, sumKnown(activePensions.map((pension) => pension.employeeContributionRate))),
      employerPct: Math.min(1, sumKnown(activePensions.map((pension) => pension.employerContributionRate))),
      includeStatePension: statePensionFraction > 0,
      statePensionFraction,
      statePensionStartAge: getAssumption(
        profile,
        `retirement.statePensionStartAge.${ownerId}`,
        IRISH_STATE_PENSION_CONTRIBUTORY.defaultStartAge
      ),
      statePensionEscalationRate: IRISH_STATE_PENSION_CONTRIBUTORY.defaultEscalationRate
    };
  });
  const definedBenefitIncome = profile.pensions
    .filter((pension) => pension.type === 'defined_benefit')
    .map((pension) => ({
      id: `defined-benefit-${pension.pensionId}`,
      title: pension.label || 'Defined-benefit pension',
      type: 'pension',
      ownerId: pension.ownerId,
      annualAmountToday: moneyAmount(pension.projectedAnnualIncome, currency) ?? 0,
      startAge: pension.benefitStartAge,
      inflationIndexed: false
    }))
    .filter((income) => income.annualAmountToday > 0 && typeof income.startAge === 'number');
  const projectionYear = Number(profile.assumptions.calculationDateIso.slice(0, 4));
  const otherIncomeSources = profile.incomeSources
    .filter((income) => !['employment', 'self_employment', 'state_pension'].includes(income.type))
    .map((income) => {
      // THE TIMELINE IS RESOLVED HERE, NOT IN THE ENGINE. The engine knows only
      // its pension members, and this income can belong to somebody who holds
      // no pension; this adapter holds the whole profile and can read the right
      // person's age. The amount is counted once, not once per owner.
      const reference = earliestRetiringOwner(profile, income.ownerIds);
      const fallbackMember = pensions[0];
      const referenceAge = reference?.age ?? fallbackMember?.currentAge;
      const startAge = income.startAge
        ?? reference?.intendedRetirementAge
        ?? fallbackMember?.retirementAge;
      const yearFor = (age) => (typeof age === 'number' && typeof referenceAge === 'number'
        ? projectionYear + (age - referenceAge)
        : null);
      const startYear = yearFor(startAge);
      const endYear = typeof income.endAge === 'number' ? yearFor(income.endAge) : null;
      return {
        id: income.incomeId,
        title: income.label,
        type: income.type,
        // The engine's contract for an income is a single owner, because one
        // income is one timeline. Where the income is genuinely joint, that is
        // the owner whose retirement age set the timeline.
        ownerId: reference?.personId ?? fallbackMember?.id,
        annualAmountToday: moneyAmount(income.netAnnual, currency) ?? moneyAmount(income.grossAnnual, currency) ?? 0,
        // Omitted rather than sent as null when it cannot be resolved, so the
        // engine's own "must include startYear or startAge" contract still
        // fires instead of this inventing a year.
        ...(Number.isFinite(startYear) ? { startYear } : {}),
        ...(Number.isFinite(endYear) ? { endYear } : {}),
        inflationIndexed: income.inflationIndexed !== false
      };
    })
    .filter((income) => income.annualAmountToday > 0)
    .concat(definedBenefitIncome);
  return {
    currentYear: Number(profile.assumptions.calculationDateIso.slice(0, 4)),
    // Centrally controlled: neither a consumer nor an adviser can override
    // these, so the engine reads the approved values directly rather than a
    // per-profile copy that could silently drift.
    growthRate: PLANEIR_ASSUMPTIONS.investment.nominalGrowthRate,
    inflationRate: PLANEIR_ASSUMPTIONS.inflation.generalRate,
    wageGrowthRate: Number.isFinite(settings.wageGrowthRate)
      ? settings.wageGrowthRate
      : PLANEIR_ASSUMPTIONS.inflation.generalRate,
    incomeMode: 'target',
    targetIncomeToday: retirementTarget(profile),
    horizonEndAge: Number.isInteger(settings.horizonEndAge) ? settings.horizonEndAge : 100,
    pensions,
    otherIncomeSources,
    statePensionRule: {
      catalogueVersion: IRELAND_RULES_CATALOGUE_VERSION,
      effectiveFrom: IRISH_STATE_PENSION_CONTRIBUTORY.effectiveFrom,
      source: IRISH_STATE_PENSION_CONTRIBUTORY.source.url
    }
  };
}

/**
 * The pension module's own input contract.
 *
 * The engine validates most of its own fields, but it is deliberately
 * forgiving about the two things this adapter is responsible for getting
 * right: what belongs in a pot, and who owns it. Those are checked here,
 * before the engine sees the payload, so a mapping defect reports as an
 * invalid input rather than as an engine crash or -- worse -- as a projection
 * that ran on a wrong number.
 */
export function validatePensionProjectionInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('generated.pensionInputs must be an object.');
  }
  const requiredHouseholdFields = [
    'currentYear', 'growthRate', 'inflationRate', 'wageGrowthRate', 'incomeMode',
    'horizonEndAge', 'pensions', 'otherIncomeSources'
  ];
  const missingHouseholdFields = requiredHouseholdFields
    .filter((field) => !Object.hasOwn(input, field));
  if (missingHouseholdFields.length > 0) {
    throw new Error(`generated.pensionInputs must explicitly include: ${missingHouseholdFields.join(', ')}.`);
  }
  if (!Array.isArray(input.pensions) || input.pensions.length === 0) {
    throw new Error('generated.pensionInputs.pensions must name at least one household member.');
  }
  if (!Array.isArray(input.otherIncomeSources)) {
    throw new Error('generated.pensionInputs.otherIncomeSources must be an explicit array.');
  }
  if (!['target', 'affordable'].includes(input.incomeMode)) {
    throw new Error('generated.pensionInputs.incomeMode must be exactly "target" or "affordable".');
  }
  if (input.incomeMode === 'target') {
    const hasTargetAmount = Object.hasOwn(input, 'targetIncomeToday');
    const hasTargetRate = Object.hasOwn(input, 'targetIncomePctOfSalary');
    if (!hasTargetAmount && !hasTargetRate) {
      throw new Error('target pension input must include targetIncomeToday or targetIncomePctOfSalary.');
    }
  } else {
    if (!Array.isArray(input.affordableEndAges) || input.affordableEndAges.length === 0) {
      throw new Error('affordable pension input must explicitly include affordableEndAges.');
    }
  }
  const seen = new Set();
  for (const member of input.pensions) {
    // A member IS a person here. Two members with one id would double a
    // household's retirement resources without any position being duplicated.
    if (!member?.id || seen.has(member.id)) {
      throw new Error('generated.pensionInputs.pensions must name each household member exactly once.');
    }
    const requiredMemberFields = [
      'id', 'title', 'currentAge', 'retirementAge', 'currentSalary', 'currentPot',
      'personalPct', 'employerPct', 'includeStatePension', 'statePensionFraction',
      'statePensionStartAge', 'statePensionEscalationRate'
    ];
    const missingMemberFields = requiredMemberFields
      .filter((field) => !Object.hasOwn(member, field));
    if (missingMemberFields.length > 0) {
      throw new Error(
        `generated.pensionInputs.pensions[${member.id}].must explicitly include: ${missingMemberFields.join(', ')}.`
      );
    }
    if (typeof member.id !== 'string' || !member.id.trim()
      || typeof member.title !== 'string' || !member.title.trim()) {
      throw new Error('generated.pensionInputs.pensions must give every household member a non-empty id and title.');
    }
    if (typeof member.includeStatePension !== 'boolean') {
      throw new Error(`generated.pensionInputs.pensions[${member.id}].includeStatePension must be a boolean.`);
    }
    if (typeof member.statePensionFraction !== 'number' || !Number.isFinite(member.statePensionFraction)) {
      throw new Error(`generated.pensionInputs.pensions[${member.id}].statePensionFraction must be a finite number.`);
    }
    if ((member.includeStatePension && member.statePensionFraction <= 0)
      || (!member.includeStatePension && member.statePensionFraction !== 0)) {
      throw new Error(`generated.pensionInputs.pensions[${member.id}] has inconsistent State Pension inclusion fields.`);
    }
    seen.add(member.id);
    for (const [field, value] of [
      ['currentPot', member.currentPot],
      ['currentSalary', member.currentSalary],
      ['personalPct', member.personalPct],
      ['employerPct', member.employerPct]
    ]) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`generated.pensionInputs.pensions[${member.id}].${field} must be a finite number.`);
      }
      if (value < 0) {
        throw new Error(`generated.pensionInputs.pensions[${member.id}].${field} must not be negative.`);
      }
    }
    // A contribution rate is a fraction of salary. Anything above 1 is a
    // percentage that was never divided down, and would silently project a
    // pension many times the client's pay.
    for (const field of ['personalPct', 'employerPct']) {
      if (member[field] > 1) {
        throw new Error(`generated.pensionInputs.pensions[${member.id}].${field} must be a fraction of salary, not a percentage.`);
      }
    }
    for (const field of ['currentAge', 'retirementAge']) {
      const age = member[field];
      if (!Number.isInteger(age) || age < 0 || age > 120) {
        throw new Error(`generated.pensionInputs.pensions[${member.id}].${field} must be an age between 0 and 120.`);
      }
    }
    if (member.retirementAge < member.currentAge) {
      throw new Error(`generated.pensionInputs.pensions[${member.id}].retirementAge must not be before currentAge.`);
    }
  }
  for (const [index, source] of input.otherIncomeSources.entries()) {
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || typeof source.id !== 'string' || !source.id.trim()
      || typeof source.title !== 'string' || !source.title.trim()
      || typeof source.ownerId !== 'string' || !source.ownerId.trim()) {
      throw new Error(`generated.pensionInputs.otherIncomeSources[${index}] must explicitly identify the income and its owner.`);
    }
    const ownerId = source.ownerId.trim();
    if (ownerId !== 'household' && !seen.has(ownerId)) {
      throw new Error(`generated.pensionInputs.otherIncomeSources[${index}].ownerId must match a pension member or be "household".`);
    }
  }
  if (typeof input.growthRate !== 'number' || !Number.isFinite(input.growthRate) || input.growthRate <= -1) {
    throw new Error('generated.pensionInputs.growthRate must be a finite rate greater than -1.');
  }
  computePensionProjection(input);
}

/** Canonical input the pension engine will actually consume. */
export function normalizePensionProjectionInput(input) {
  validatePensionProjectionInput(input);
  return normalizePensionInputs(input);
}

export async function runPensionProjection(input, context) {
  const projection = computePensionProjection(input, { scenarioId: context.scenarioOverrides?.scenarioId || '' });
  return createModuleRunResult({
    moduleId: 'pension_projection',
    moduleVersion: context.moduleVersion,
    input,
    context,
    projection,
    semanticResult: {
      currency: context.baseCurrency || 'EUR',
      projectedPotAtRetirement: projection.debug.projectedPotCurrent,
      projectedPotAtIncomeStart: projection.debug.projectedAvailablePotAtIncomeStartCurrent,
      requiredPot: projection.debug.requiredPot,
      gapVsRequired: projection.debug.currentGapVsRequired,
      surplusVsRequired: projection.debug.currentSurplusVsRequired,
      readinessStatus: projection.debug.readinessStatus,
      readinessSentence: projection.debug.readinessSentence,
      retirementYear: projection.debug.retirementYear,
      depletionAgeProjected: projection.debug.depletionAgeProjected
    }
  });
}

export function getNetRetirementReadiness(profile) {
  const relevant = Boolean(findGoal(profile, ['retire', 'retire_early']));
  if (!relevant) return readinessFromMissing([], { relevant: false });
  const moduleIds = ['net_retirement_cashflow'];
  const requiredMissing = [];
  if (typeof profile.primaryPerson.age !== 'number') {
    requiredMissing.push(missing('/primaryPerson/age', 'Add the current age for the retirement cash-flow timeline.', moduleIds));
  }
  if (annualExpenses(profile) === null) {
    requiredMissing.push(missing('/expenses/annualTotal', 'Add annual net household spending.', moduleIds));
  }
  const assumptionsUsed = [];
  if (typeof profile.assumptions.inflationRate !== 'number') {
    assumptionsUsed.push(assumptionRecord('generalInflation'));
  }
  if (!Number.isFinite(getAssumption(profile, 'retirement.presentValueRate'))) {
    assumptionsUsed.push({ key: 'presentValueRate', value: 0.04, reason: 'Existing net retirement engine default.' });
  }
  const grossOnly = profile.incomeSources.filter((income) => income.grossAnnual && !income.netAnnual);
  const warnings = [
    'This adapter uses only after-tax income values; gross-only income is excluded from net cash-flow.',
    ...(grossOnly.length > 0 ? [`${grossOnly.length} gross-only income source(s) will be excluded.`] : []),
    ...crossCurrencyWarnings(profile, [
      ['Expenses', Object.values(profile.expenses || {})],
      ['Income values', profile.incomeSources.map((income) => income.netAnnual)],
      ['Liquid investments', profile.assets.map((asset) => asset.currentValue)]
    ])
  ];
  return readinessFromMissing(requiredMissing, { assumptionsUsed, warnings });
}

export function buildNetRetirementInput(profile) {
  const currency = baseCurrency(profile);
  const settings = getAssumption(profile, 'retirement', {});
  const currentAge = profile.primaryPerson.age;
  const incomeSources = profile.incomeSources
    .filter((income) => moneyAmount(income.netAnnual, currency) !== null)
    .map((income) => ({
      id: income.incomeId,
      title: income.label,
      type: income.type,
      annualAmountToday: moneyAmount(income.netAnnual, currency),
      startAge: income.startAge ?? currentAge,
      ...(typeof income.endAge === 'number' ? { endAge: income.endAge } : {}),
      inflationIndexed: income.inflationIndexed !== false
    }));
  return {
    currentYear: Number(profile.assumptions.calculationDateIso.slice(0, 4)),
    currentAge,
    horizonEndAge: Number.isInteger(settings.horizonEndAge) ? settings.horizonEndAge : 100,
    annualExpenditureToday: annualExpenses(profile),
    expenditureInflationRate: PLANEIR_ASSUMPTIONS.inflation.generalRate,
    presentValueRate: Number.isFinite(settings.presentValueRate) ? settings.presentValueRate : 0.04,
    availableInvestmentFundToday: availableInvestmentAmount(profile),
    incomeSources,
    scenarios: [{ id: 'base', title: 'Current position' }]
  };
}

/**
 * The net cash-flow module's input contract.
 *
 * THE ONE THING THIS MODULE MUST NEVER DO IS MIX GROSS WITH NET. Every figure
 * it takes is after tax: the spending need, each income source, and the
 * discount rate. A gross pension balance or a gross DB payment arriving here
 * would understate the funding requirement by exactly the tax that was never
 * deducted, and the output would still look entirely reasonable.
 *
 * `availableInvestmentFundToday` may be null, deliberately: an unknown fund
 * withholds the comparison rather than asserting a surplus or a gap.
 */
export function validateNetRetirementInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('generated.netRetirementInputs must be an object.');
  }
  const finite = (value, field, { nullable = false } = {}) => {
    if (nullable && (value === null || typeof value === 'undefined')) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`generated.netRetirementInputs.${field} must be a finite number.`);
    }
    if (value < 0) throw new Error(`generated.netRetirementInputs.${field} must not be negative.`);
  };
  // Spending is the whole basis of the requirement. An unknown one must never
  // become zero, which would report a household as needing nothing.
  finite(input.annualExpenditureToday, 'annualExpenditureToday');
  finite(input.availableInvestmentFundToday, 'availableInvestmentFundToday', { nullable: true });
  for (const source of Array.isArray(input.incomeSources) ? input.incomeSources : []) {
    finite(source?.annualAmountToday, `incomeSources[${source?.id}].annualAmountToday`);
  }
  computeNetRetirementProjection(input);
}

export async function runNetRetirementCashflow(input, context) {
  const projection = computeNetRetirementProjection(input, { scenarioId: context.scenarioOverrides?.scenarioId || '' });
  return createModuleRunResult({
    moduleId: 'net_retirement_cashflow',
    moduleVersion: context.moduleVersion,
    input,
    context,
    projection,
    semanticResult: {
      currency: context.baseCurrency || 'EUR',
      requiredNetFundToday: projection.debug.requiredFundToday,
      firstYearShortfall: projection.debug.firstYearShortfall,
      surplusVsRequired: projection.debug.surplusVsRequired,
      gapVsRequired: projection.debug.gapVsRequired,
      scenarioId: projection.debug.scenarioId
    }
  });
}
