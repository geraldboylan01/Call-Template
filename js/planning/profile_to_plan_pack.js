import { APPLICATION_SCHEMA, SECTIONS } from '../case_application/schema.js';
import { normalizeHouseholdProfile, hasOwnerConfirmedNone, NON_CONTRIBUTORY_PENSION_TYPES } from './profile.js';
import { planFactsMissing } from './plan_facts_missing.js';
import { assertIsoDate, cloneJson } from './utils.js';
import { normalizePlanPack } from './plan_pack/schema.js';
import { compilePlanPack } from './plan_pack/compiler.js';
import { getPlanningModuleDefinition } from './module_registry.js';

const CHAPTERS = [
  'personal_balance_sheet', 'liquidity_analysis', 'household_cash_flow',
  'mortgage_analysis', 'loan_analysis', 'pension_projection',
  'net_retirement_cashflow', 'college_funding', 'goals_and_resources',
  'protection_gap', 'future_cost_fund'
];
const RETIREMENT = ['retire', 'retire_early', 'improve_pension'];
const ready = result => ['ready', 'ready_with_assumptions'].includes(result.status);

/**
 * Pure asynchronous assembly/preflight; no clock, I/O, analyst or route changes.
 * Returns {planPack, compileOptions, missingFacts, omittedChapters, provenance}.
 * planPack alone is the strict v1 wire object. It is null when confirmation/date
 * is invalid or no chapter can run. Compile with the returned compileOptions.
 *
 * Optional reviewed transition facts live at assumptions.values.planPack:
 * {planningInputs, goalFlexibility}. They use the existing strict pack contract;
 * this function never manufactures those facts from prose or account labels.
 */
export async function profileToPlanPack(rawProfile, { confirmedRevision, calculationDate, clientLabel } = {}) {
  const household = normalizeHouseholdProfile(rawProfile);
  const application = household.assumptions.values.application;
  const fromForm = application?.schema === APPLICATION_SCHEMA && application.snapshotBound === true;
  const missingFacts = cloneJson(planFactsMissing(household)).map(item => ({
    ...item,
    fieldPath: Object.hasOwn(household, item.fieldPath.split('/')[1]) ? '/household' + item.fieldPath : item.fieldPath
  }));
  const omittedChapters = [];
  const provenance = {};
  const compileOptions = { resourceLedger: true, currentPositionOnly: true };
  const gap = (fieldPath, reason, chapter, code = 'missing_information', kind = 'household_fact') => {
    if (reason.startsWith(fieldPath + ': ')) reason = reason.slice(fieldPath.length + 2);
    const item = { factId: code, fieldPath, reason, kind, importance: 'required', blockingModuleIds: chapter ? [chapter] : [] };
    const existing = missingFacts.find(row => row.fieldPath === fieldPath
      && (row.reason === reason || fieldPath === '/planningInputs/householdTaxStatus'));
    if (!existing) missingFacts.push(item);
    else if (chapter && !existing.blockingModuleIds.includes(chapter)) existing.blockingModuleIds.push(chapter);
    return { fieldPath, reason, code };
  };
  const stop = (reason, path, code = 'invalid_input') => {
    gap(path, reason, null, code, code === 'confirmation_binding' ? 'snapshot_binding' : 'plan_pack_fact');
    return { planPack: null, compileOptions, missingFacts, omittedChapters: CHAPTERS.map(chapter => ({ chapter, reasons: [{ fieldPath: path, reason, code }] })), provenance };
  };
  if (!Number.isInteger(confirmedRevision) || confirmedRevision < 1 || !household.confirmedAt
    || (fromForm ? application.revision !== confirmedRevision : household.revision !== confirmedRevision)
    || (application && !fromForm)) {
    return stop('Use the confirmed profile and its matching saved revision; an edited, unbound or mismatched snapshot cannot become a plan.', '/confirmedRevision', 'confirmation_binding');
  }
  let date;
  try { date = assertIsoDate(calculationDate ?? household.confirmedAt.slice(0, 10), 'calculationDate'); }
  catch { return stop('Supply a valid calculation date or a dated confirmation; no system date is substituted.', '/calculationDate'); }
  if (typeof clientLabel !== 'string' || !clientLabel.trim()) return stop('Supply the display label for this plan.', '/clientName', 'missing_information');
  household.assumptions.calculationDateIso = date;
  provenance['/calculationDate'] = { profilePaths: [calculationDate === undefined ? '/confirmedAt' : 'caller.calculationDate'], confirmedRevision };
  // #97 stores the separately asked CURRENT extra under the older mortgage
  // adapter's proposed-overpayment key. Move its meaning, keep both components,
  // and give every downstream builder the actual current monthly payment.
  const mortgageSettings = household.assumptions.values.mortgage;
  const extraPath = '/assumptions/values/mortgage/annualOverpayment';
  const extraSource = household.fieldMetadata[extraPath];
  const homeDebt = household.liabilities.find(debt => debt.liabilityId === 'liability_application_home_mortgage');
  const paymentPath = homeDebt ? `/liabilities/${household.liabilities.indexOf(homeDebt)}/monthlyPayment` : null;
  const paymentSource = household.fieldMetadata[paymentPath];
  if (fromForm && extraSource?.application?.revision === confirmedRevision
    && extraSource.application.paths.includes('mortgage.overpayment') && mortgageSettings?.annualOverpayment > 0
    && homeDebt?.monthlyPayment && paymentSource?.application?.revision === confirmedRevision
    && paymentSource.application.paths.includes('mortgage.repayment')) {
    const scheduled = homeDebt.monthlyPayment.amount;
    const annualExtra = mortgageSettings.annualOverpayment;
    mortgageSettings.scheduledMonthlyPayment = scheduled;
    mortgageSettings.currentAnnualOverpayment = annualExtra;
    homeDebt.monthlyPayment.amount = Math.round((scheduled + annualExtra / 12) * 100) / 100;
    household.fieldMetadata['/assumptions/values/mortgage/scheduledMonthlyPayment'] = cloneJson(household.fieldMetadata[paymentPath]);
    household.fieldMetadata['/assumptions/values/mortgage/currentAnnualOverpayment'] = cloneJson(extraSource);
    household.fieldMetadata[paymentPath] = {
      ...cloneJson(extraSource), source: 'calculated', certainty: 'inferred', confirmedByUser: false,
      application: { ...cloneJson(extraSource.application), mappingVersion: 'profile-to-plan-1.0.0',
        paths: [...new Set([...(household.fieldMetadata[paymentPath]?.application?.paths ?? []), ...extraSource.application.paths])],
        derivation: 'Current monthly payment = scheduled monthly repayment + separately stated current annual extra / 12; rounded to cents.' }
    };
    mortgageSettings.fixedPaymentAmount = homeDebt.monthlyPayment.amount;
    household.fieldMetadata['/assumptions/values/mortgage/fixedPaymentAmount'] = cloneJson(household.fieldMetadata[paymentPath]);
    delete mortgageSettings.annualOverpayment;
    delete household.fieldMetadata[extraPath];
    provenance['/household' + paymentPath] = { profilePaths: [paymentPath, extraPath], confirmedRevision, basis: 'scheduled_plus_explicit_current_extra_once' };
  }
  const authored = household.assumptions.values.planPack ?? {};
  const planningInputs = cloneJson(authored.planningInputs ?? {});
  for (const key of Object.keys(planningInputs)) provenance[`/planningInputs/${key}`] = {
    profilePaths: [`/assumptions/values/planPack/planningInputs/${key}`], confirmedRevision, basis: 'reviewed_transition_fact'
  };
  const set = (key, value, paths, basis) => {
    if (planningInputs[key] !== undefined) return;
    planningInputs[key] = value;
    provenance[`/planningInputs/${key}`] = {
      profilePaths: paths, confirmedRevision, basis,
      applicationSources: paths.flatMap(path => household.fieldMetadata[path]?.application ? [cloneJson(household.fieldMetadata[path].application)] : [])
    };
  };
  const people = [household.primaryPerson, household.partner].filter(Boolean);
  const none = household.assumptions.values.completionFacts?.confirmedNonePaths ?? {};
  if (household.partner && typeof household.household?.married === 'boolean') {
    const status = household.household.married ? 'married_or_civil_partners' : 'single';
    if (planningInputs.householdTaxStatus && planningInputs.householdTaxStatus !== status) return stop('The supplied tax status conflicts with household.married.', '/planningInputs/householdTaxStatus');
    set('householdTaxStatus', status, ['/household/married'], 'explicit_marriage_or_civil_partnership_choice');
  }
  if (!planningInputs.householdTaxStatus) gap('/planningInputs/householdTaxStatus', household.partner
    ? 'Establish whether the couple are married or civil partners before calculating tax.'
    : 'Establish single or widowed/surviving civil partner status; planning without a partner does not identify the tax credit.', 'household_cash_flow');
  const totalSource = household.fieldMetadata['/expenses/annualTotal']?.application;
  const formSpending = fromForm && totalSource?.revision === confirmedRevision && totalSource.paths.includes('spending.spend');
  if (formSpending) {
    set('spendingBasis', 'regular_costs_including_debt_excluding_tax_and_pensions', ['/expenses/annualTotal'], 'form_regular_spending_plus_housing; savings_transfers_not_inferred');
    // Copy an existing authored heading verbatim. This is not label rewriting
    // or an attempt to classify the unitemised remainder into new categories.
    set('spendingLabel', SECTIONS.find(section => section.id === 'spending').title, ['/expenses/annualTotal'], 'verbatim_form_section_heading');
  }
  // Complete gross records can use the native tax estimate after the recorded
  // personal deduction. A household net total is never split into bank pay.
  const estimatedPay = household.incomeSources.length > 0 && household.incomeSources.every(income => !income.netAnnual && income.grossAnnual);
  if (estimatedPay) set('takeHomeBasis', 'after_personal_pension', ['/incomeSources', '/pensions'], 'native_engine_estimate_after_current_personal_contributions; household_net_total_not_allocated');
  for (const [key, reason] of [
    ['takeHomeBasis', 'Confirm that individual stated bank pay is after current personal pension deductions, or provide gross inputs for the native estimate.'],
    ['spendingBasis', 'Establish regular spending including debts and excluding tax/pension deductions; essential spending alone cannot supply it.'],
    ['spendingLabel', 'Supply the authored spending label; no text is shortened or rewritten to fit.']
  ]) if (planningInputs[key] === undefined) gap(`/planningInputs/${key}`, reason, 'household_cash_flow');

  // The form has role labels, not names. Preserve the original profile
  // and identify these copied display aliases in the plan's source metadata.
  if (fromForm) {
    const ownerField = SECTIONS.find(section => section.id === 'pensions').repeater.fields.find(field => field.key === 'owner');
    people.forEach(person => {
      if (person.displayName) return;
      const key = person === household.partner ? 'partner' : 'primaryPerson';
      person.displayName = ownerField.options.find(option => option.value === (key === 'partner' ? 'partner' : 'you')).label;
      household.fieldMetadata[`/${key}/displayName`] = {
        source: 'calculated', confidence: 'high', certainty: 'inferred', capturedAt: household.confirmedAt, confirmedByUser: false,
        note: 'Verbatim form role label for display; this is not a stated personal name.',
        application: { schema: application.schema, version: application.version, revision: confirmedRevision,
          mappingVersion: 'profile-to-plan-1.0.0', paths: ['schema'], derivation: 'Copy the v1 form owner-role label for display without supplying a personal name.' }
      };
    });
  }
  const cash = household.assets.filter(asset => asset.type === 'cash' && asset.currentValue);
  if (cash.length === 1) set('cashAssetId', cash[0].assetId, [`/assets/${household.assets.indexOf(cash[0])}/assetId`], 'sole_recorded_cash_account');
  else if (!planningInputs.cashAssetId) gap('/planningInputs/cashAssetId', cash.length ? 'Identify the cash account; multiple accounts cannot be selected by order.' : 'Record cash, including an explicit zero, before identifying a funding account.', 'liquidity_analysis');
  if (planningInputs.outgoingBindings === undefined) set('outgoingBindings', household.liabilities.filter(debt => debt.monthlyPayment).map(debt => ({
    id: `debt_${household.liabilities.indexOf(debt)}`, liabilityId: debt.liabilityId, label: debt.label
  })), ['/liabilities'], 'bind_stated_payments_to_their_own_liability; labels_copied_verbatim');
  const contributions = [];
  for (const person of people) {
    const holdings = household.pensions.filter(pension => pension.ownerId === person.personId);
    if (holdings.some(pension => typeof pension.employeeContributionRate === 'number')) continue;
    if ((holdings.length && holdings.every(pension => NON_CONTRIBUTORY_PENSION_TYPES.includes(pension.type) || ['paid_up', 'not_applicable'].includes(pension.contributionStatus)))
      || none['/pensions'] === true || hasOwnerConfirmedNone(household, '/pensions', person.personId)) {
      contributions.push({ personId: person.personId, annualAmount: 0 });
    } else if (!planningInputs.personalPensionContributions?.some(item => item.personId === person.personId)) gap('/planningInputs/personalPensionContributions',
      `Establish ${person.personId}'s current personal pension contribution, including explicit zero.`, 'household_cash_flow');
  }
  set('personalPensionContributions', contributions, ['/pensions', '/assumptions/values/completionFacts/confirmedNonePaths'], 'zero_only_from_recorded_non_contributory_status_or_confirmed_none; rates_stay_on_pensions');
  const goals = household.goals.filter(goal => !['paused', 'completed'].includes(goal.status));
  if (planningInputs.goalBindings === undefined) set('goalBindings', goals.flatMap(goal => {
    const type = { optimise_mortgage: 'mortgage', manage_loan: 'loan' }[goal.type];
    const candidates = type ? household.liabilities.filter(debt => debt.type === type) : [];
    if (candidates.length === 1) return [{ goalId: goal.goalId, liabilityId: candidates[0].liabilityId,
      ...(candidates[0].ownerIds.length === 1 ? { personId: candidates[0].ownerIds[0] } : {}) }];
    if (type) gap('/planningInputs/goalBindings', `Identify the liability for ${goal.goalId}; there is no unique ${type} record.`, type === 'loan' ? 'loan_analysis' : 'mortgage_analysis');
    if (RETIREMENT.includes(goal.type) && people.length === 1) return [{ goalId: goal.goalId, personId: people[0].personId }];
    return [];
  }), ['/goals', '/liabilities'], 'unique_matching_debt_or_only_household_person; no_joint_person_selection');
  planningInputs.chapterGoals ??= {};
  for (const chapter of ['pension_projection', 'net_retirement_cashflow', 'college_funding']) {
    const matching = goals.filter(goal => (chapter === 'college_funding' ? ['fund_education'] : RETIREMENT).includes(goal.type));
    if (matching.length === 1 && !planningInputs.chapterGoals[chapter]) planningInputs.chapterGoals[chapter] = matching[0].goalId;
  }
  provenance['/planningInputs/chapterGoals'] ??= { profilePaths: ['/goals'], confirmedRevision, basis: 'unique_relevant_goal_only' };
  // An owned-out-right/rented home, no other property, no loans and no carried
  // card together establish no debt in the v1 form. No one answer alone does.
  if (fromForm && formSpending && !household.liabilities.length && none['/properties'] === true
    && none['/liabilities/loan'] === true && none['/liabilities/credit_card'] === true) {
    none['/liabilities'] = true;
    household.fieldMetadata['/assumptions/values/completionFacts/confirmedNonePaths/~1liabilities'] = {
      source: 'calculated', confidence: 'high', certainty: 'inferred', capturedAt: household.confirmedAt, confirmedByUser: false,
      note: 'Derived from all v1 debt scopes: no home mortgage record, no other properties, no loans, and no carried card balance.',
      application: { schema: application.schema, version: application.version, revision: confirmedRevision,
        mappingVersion: 'profile-to-plan-1.0.0', paths: [...new Set([
          ...totalSource.paths,
          ...['~1properties', '~1liabilities~1loan', '~1liabilities~1credit_card'].flatMap(key =>
            household.fieldMetadata[`/assumptions/values/completionFacts/confirmedNonePaths/${key}`]?.application?.paths ?? [])
        ])], derivation: 'All v1 debt scopes explicitly resolved with no liabilities recorded; no blank scope becomes none.' }
    };
  }
  const pack = {
    planPackVersion: 1, clientName: clientLabel.trim(), calculationDate: date, household,
    planningInputs, goalFlexibility: cloneJson(authored.goalFlexibility ?? {}),
    routes: [{ id: 'current' }], chapters: [], narration: {}
  };
  const omit = (chapter, reasons) => omittedChapters.push({ chapter, reasons });
  for (const chapter of CHAPTERS) {
    if (['future_cost_fund', 'goals_and_resources'].includes(chapter)) {
      const reason = chapter === 'future_cost_fund'
        ? 'The later fund step needs an explicit dated-cost contract and a builder passing the pack date into the payload pipeline.'
        : 'B1/B1.1 price goal funding, but the native goals screen derives funding alternatives and has no exact unchanged-current case. Its route-to-screen adapter is still missing; B1 availability does not supply that adapter.';
      omit(chapter, [gap(`/chapters/${chapter}`, reason, chapter, 'requires_profile_adapter', 'implementation')]);
      continue;
    }
    if (['pension_projection', 'net_retirement_cashflow', 'college_funding'].includes(chapter)
      && !planningInputs.chapterGoals[chapter]) {
      const relevantRecords = chapter === 'college_funding' ? household.dependants.length : household.pensions.length;
      omit(chapter, relevantRecords ? [gap(`/planningInputs/chapterGoals/${chapter}`,
        'Record or select one relevant goal; holdings or children alone cannot establish the goal this chapter answers.', chapter)]
        : [{ fieldPath: `/chapters/${chapter}`, reason: 'There is no relevant goal or position for this chapter.', code: 'not_relevant' }]);
      continue;
    }
    if (chapter === 'net_retirement_cashflow') {
      const grossOnly = household.incomeSources.filter(income => income.grossAnnual && !income.netAnnual);
      if (grossOnly.length) {
        omit(chapter, grossOnly.map(income => gap(`/household/incomeSources/${household.incomeSources.indexOf(income)}/netAnnual`,
          'Net retirement needs after-tax income and its timeline. A gross salary or household take-home total cannot stand in for each future net stream.', chapter)));
        continue;
      }
    }
    if (chapter === 'pension_projection' && !household.pensions.length && none['/pensions'] === true) {
      omit(chapter, [gap('/chapters/pension_projection',
        'No pensions were confirmed. The existing pension builder needs a pension member; a State-Pension-only member adapter is not implemented.', chapter, 'requires_profile_adapter', 'implementation')]);
      continue;
    }
    const definition = getPlanningModuleDefinition(chapter);
    if (definition?.canRun) {
      const readiness = definition.canRun(household);
      if (!ready(readiness)) {
        const reasons = (readiness.requiredMissing ?? []).filter(item => (item.importance ?? 'required') === 'required')
          .map(item => gap('/household' + item.fieldPath, item.reason, chapter));
        omit(chapter, reasons.length ? reasons : [{ fieldPath: `/chapters/${chapter}`, reason: 'This chapter is not relevant to the recorded household facts.', code: 'not_relevant' }]);
        continue;
      }
    }
    const trial = await compilePlanPack({ ...pack, chapters: [chapter] }, compileOptions);
    if (trial.status === 'compiled') pack.chapters.push(chapter);
    else omit(chapter, trial.diagnostics.map(item => gap(item.path, item.message, chapter, item.code,
      item.code.startsWith('requires_') ? 'implementation' : 'household_fact')));
  }
  if (!pack.chapters.includes('household_cash_flow') && planningInputs.leftOverEachYear === undefined) gap('/planningInputs/leftOverEachYear',
    'Current annual left over needs a compilable cash-flow chapter or an explicitly stated annual amount.', null);
  let planPack = null;
  if (pack.chapters.length) planPack = normalizePlanPack(pack);
  return { planPack, compileOptions, missingFacts, omittedChapters, provenance };
}
