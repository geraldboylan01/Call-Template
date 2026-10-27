import { readJsonPointer } from './utils.js';
import { NON_CONTRIBUTORY_PENSION_TYPES, hasOwnerConfirmedNone, ownerConfirmedNonePath } from './profile.js';
import { getSemanticFactDefinition } from './semantic_facts.js';

const known = value => value !== undefined && value !== null;
const semanticPath = id => getSemanticFactDefinition(id).profilePathTemplate;

/**
 * Section 6's full-plan inventory, not a module-routing or form-question policy.
 * `kind` distinguishes household facts from plan-pack facts, implementation
 * contracts and deferred property work. In particular, hypothetical Illness
 * Benefit is an implementation gap, never a question about client entitlement.
 * No defaults here turn an unanswered fact into zero, "none" or an entitlement.
 */
export function planFactsMissing(profile) {
  const result = [];
  const values = profile.assumptions?.values ?? {};
  const application = values.application;
  const none = values.completionFacts?.confirmedNonePaths ?? {};
  const add = (factId, fieldPath, reason, kind = 'household_fact', importance = 'required', blockingModuleIds = []) => {
    result.push({ factId, fieldPath, reason, kind, importance, blockingModuleIds });
  };
  const requireValue = (factId, path, reason) => {
    if (!known(readJsonPointer(profile, path))) add(factId, path, reason);
  };
  if (application && !application.snapshotBound) add('confirmed_snapshot', '/assumptions/values/application',
    'Bind the saved confirmed revision and timestamp before calculation; the unbound conversion has no real capture or calculation date.', 'snapshot_binding');
  if (application && !known(profile.household?.planningWithPartner)) add('household_structure', '/household/planningWithPartner',
    'Establish whether a partner is included so income, pensions and assessment use the right people.');
  if (profile.partner) requireValue('married_or_civil_partners', '/household/married',
    'Marriage or civil partnership decides joint assessment for the couple.');
  else if (!values.planPack?.planningInputs?.householdTaxStatus) add('single_or_widowed', '/planningInputs/householdTaxStatus',
    'With no partner included, establish whether the person is single or widowed/a surviving civil partner; the tax credit differs. Planning alone does not answer this.');
  const people = [['primaryPerson', profile.primaryPerson], ['partner', profile.partner]].filter(([, person]) => person);
  for (const [key, person] of people) {
    requireValue('person_current_age', `/${key}/age`, 'Current age sets pension, mortgage and dependant timelines.');
    if (!person.employmentStatus || ['unknown', 'other'].includes(person.employmentStatus)) add('employment_tax_basis', `/${key}/employmentStatus`,
      'The work/tax basis must distinguish employment, self-employment and retirement; director/not working cannot safely be treated as an employee.');
    const incomes = (profile.incomeSources ?? []).filter(income => income.ownerIds.includes(person.personId));
    const earned = ['employee', 'self_employed', 'contractor'].includes(person.employmentStatus)
      ? incomes.filter(income => ['employment', 'self_employment'].includes(income.type)) : incomes;
    if (!earned.some(income => known(income.grossAnnual?.amount))) add('person_gross_income', '/incomeSources',
      `Gross annual income for ${person.personId} is needed for tax and pension relief, including an explicit zero where appropriate.`);
    if (person.employmentStatus !== 'retired') requireValue('intended_retirement_age', `/${key}/intendedRetirementAge`,
      'The intended retirement age sets the saving horizon and the point employment income stops.');
    if (!hasOwnerConfirmedNone(profile, '/pensions', person.personId)) {
      if (!profile.pensions.some(pension => pension.ownerId === person.personId) && none['/pensions'] !== true) add('pension_positions', ownerConfirmedNonePath('/pensions', person.personId),
        `Pension holdings for ${person.personId} or an explicit confirmation of none are needed; an empty section does not establish that there are no pensions.`);
    }
    if (person.employmentStatus !== 'retired' || profile.pensions.some(pension => pension.ownerId === person.personId)) {
      requireValue('state_pension_fraction', semanticPath('state_pension_fraction').replace('*', person.personId),
        `A numeric State Pension fraction for ${person.personId} is needed. Partly/not sure, or the other person’s expectation, cannot establish it.`);
    }
  }
  requireValue('total_spending', semanticPath('annual_net_spending'),
    'Total spending including rent or mortgage is needed for left over each year. Both non-housing spending and the applicable housing payment must be known.');
  requireValue('essential_spending', '/expenses/monthlyEssential', 'Essential spending sets the protected emergency cash reserve.');
  if (application && known(profile.expenses?.monthlyEssential)) add('essential_spending_basis', '/expenses/monthlyEssential',
    'The v1 profilePath labels this as essential spending, but the form asks all spending excluding rent/mortgage. Confirm the essential-only basis before sizing a reserve.', 'household_fact', 'recommended');
  if (!(profile.assets ?? []).some(asset => asset.type === 'cash' && known(asset.currentValue?.amount))) add('cash_savings', '/assets',
    'Cash available, including an explicit zero, sets the emergency reserve and the money available once it is protected.');
  if (application && !known(profile.household?.hasChildren)) add('dependants_presence', '/household/hasChildren',
    'Confirm whether there are children before treating an empty dependant list as none.');
  if (profile.household?.hasChildren === true && profile.dependants.length === 0) add('dependants', '/dependants',
    'Add each child: a yes answer alone cannot set the number or timing of college costs.');
  const education = profile.goals.some(goal => goal.type === 'fund_education' || goal.type === 'understand_position')
    || known(values.collegeFunding?.scenarioByChild);
  profile.dependants.forEach((child, index) => {
    requireValue('dependant_current_age', `/dependants/${index}/currentAge`, 'Each child’s current age sets when college costs begin.');
    if (education && !known(values.collegeFunding?.scenarioByChild?.[child.dependantId])) add('college_plan', `/assumptions/values/collegeFunding/scenarioByChild/${child.dependantId}`,
      'Living at home or away selects the college cost basis; not sure must stay unresolved.');
  });
  const retiring = people.some(([, person]) => person.employmentStatus !== 'retired') || profile.pensions.length > 0;
  if (retiring) requireValue('target_retirement_income', semanticPath('target_retirement_income'),
    'The household target annual retirement income in today’s money sets the retirement goal; current spending is not a stated target.');
  if (application) profile.incomeSources.forEach((income, index) => {
    if (income.type === 'other') add('income_tax_basis', `/incomeSources/${index}/type`,
      'The gross-pay answer has no established income type for tax. Retirement or missing work details cannot turn it into a salary or pension by inference.');
  });
  profile.pensions.forEach((pension, index) => {
    const path = `/pensions/${index}`;
    if (pension.type === 'other') add('pension_type', `${path}/type`, 'Pension type determines whether to grow a pot or use promised benefits.');
    if (pension.type === 'defined_benefit') {
      for (const [key, reason] of [
        ['projectedAnnualIncome', 'Promised annual pension is needed for retirement income.'],
        ['retirementLumpSum', 'The defined-benefit lump sum, including zero, sets retirement resources.'],
        ['benefitStartAge', 'The benefit start age determines when the promised income is available.']
      ]) requireValue(`pension_${key}`, `${path}/${key}`, reason);
    } else requireValue('pension_current_value', `${path}/currentValue`, 'The current pension pot is needed to project retirement resources.');
    if (!NON_CONTRIBUTORY_PENSION_TYPES.includes(pension.type)) {
      requireValue('pension_contribution_status', `${path}/contributionStatus`, 'Establish whether the pension still receives contributions.');
      if (pension.contributionStatus !== 'paid_up') {
        requireValue('pension_employee_contribution_rate', `${path}/employeeContributionRate`, 'Personal contributions, including zero, affect pension growth, tax relief and current cash flow.');
        if (['occupational', 'prsa', 'other'].includes(pension.type)) requireValue('pension_employer_contribution_rate', `${path}/employerContributionRate`, 'Employer contributions, including zero, affect pension growth.');
      }
    }
  });
  const loanNone = none['/liabilities'] === true || none['/liabilities/loan'] === true;
  if (!loanNone && !profile.liabilities.some(debt => debt.type === 'loan')) add('loans_presence', '/liabilities',
    'Loan records or explicit no loans are needed; an unanswered section cannot be treated as debt-free.');
  if (application && none['/liabilities/credit_card'] !== true && !profile.liabilities.some(debt => debt.type === 'credit_card')) add('credit_card_status', '/liabilities',
    'Confirm whether a credit card is cleared monthly or has a carried balance; no loans says nothing about cards.');
  profile.liabilities.forEach((debt, index) => {
    const path = `/liabilities/${index}`;
    for (const [key, reason] of [
      ['currentBalance', 'Debt balance sets the money required to clear it.'],
      ['annualInterestRate', 'The debt rate determines its cost and whether a route removes an expensive inefficiency.'],
      ['remainingTermMonths', 'The remaining term sets the repayment horizon.'],
      ['monthlyPayment', 'The current repayment is needed for cash flow and the nothing-changes position.']
    ]) {
      if (key !== 'currentBalance' && debt.currentBalance?.amount === 0) continue;
      requireValue(`debt_${key}`, `${path}/${key}`, reason);
    }
    if (debt.type === 'mortgage' && profile.properties.some(property => property.use === 'home' && property.associatedLiabilityIds.includes(debt.liabilityId))) {
      const goalIndex = profile.goals.findIndex(goal => goal.type === 'optimise_mortgage');
      const goal = profile.goals[goalIndex];
      if (!goal?.targetDate) add('mortgage_clear_by', goal ? `/goals/${goalIndex}/targetDate` : '/goals',
        'The mortgage goal needs a chosen payoff age/date. The contractual term is not the household’s desired clearance date.');
      add('mortgage_cleared_on_death', `${path}/clearedOnDeath`,
        'Whether this mortgage clears on death changes the survivor’s spending need. Having life cover alone does not establish this.', 'household_fact');
    }
  });
  for (const goal of profile.goals.filter(goal => !['understand_position', 'maintain_liquidity'].includes(goal.type))) {
    add('goal_flexibility', `/goalFlexibility/${goal.goalId}`,
      'Routes may move a goal only within the household’s stated age, amount or date bounds. These bounds belong in the plan pack and are not collected yet.', 'plan_pack_fact');
  }
  add('other_dated_costs', '/goals',
    'Review whether care, school fees or other dated costs exist. Each needs a start, duration and yearly amount; the profile has no duration field yet.', 'household_fact', 'recommended');
  const employees = people.filter(([, person]) => person.employmentStatus === 'employee');
  if (employees.length) add('illness_scenario_contract', '/assumptions/values/protection/illnessScenario',
    'Section 6 requires the central sourced, dated Illness Benefit assumption, versioned scenario tax and a bounded duration/savings-runway contract. This later B2 work is not a question about predicted entitlement.', 'implementation');
  if (people.some(([, person]) => ['self_employed', 'contractor', 'other', 'unknown'].includes(person.employmentStatus))) add('illness_scenario_scope', '/assumptions/values/protection/illnessScenario',
    'The employee Illness Benefit assumption cannot silently apply to self-employment, unknown work or retirement; the later scenario contract must resolve its scope.', 'implementation');
  if (profile.partner || profile.dependants.length) add('survivor_payment', '/assumptions/values/protection/survivorPayment',
    'A death scenario retains the separate stated survivor-payment contract, including an explicit zero. The illness assumption cannot supply it.', 'plan_pack_fact');
  profile.properties.filter(property => property.use !== 'home').forEach(property => add('property_plan_facts', `/properties/${profile.properties.indexOf(property)}`,
    'Later property chapters need named ownership, use, rent, running costs, purchase date/price, acquisition basis and home history. HouseholdProfile v1 does not represent all of them.', 'deferred', 'optional'));
  for (const entry of application?.unmappedFields ?? []) {
    if (entry.reason.startsWith('The pension owner is missing')) add('pension_owner', '/pensions', entry.reason);
    if (entry.reason.includes('below the current age')) add('retirement_timeline', entry.path === 'retirement.partnerAge' ? '/partner/intendedRetirementAge' : '/primaryPerson/intendedRetirementAge', entry.reason);
  }
  return result.filter((item, index) => result.findIndex(candidate => candidate.factId === item.factId && candidate.fieldPath === item.fieldPath && candidate.reason === item.reason) === index);
}
