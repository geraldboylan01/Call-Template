import { APPLICATION_SCHEMA, SECTIONS } from '../../case_application/schema.js';

const fields = SECTIONS.flatMap(section => [
  ...(section.fields ?? []),
  ...(section.repeater?.fields ?? []).map(field => ({ ...field, path: section.repeater.path + '.*.' + field.key }))
]);
const copyField = (field, path) => Object.fromEntries(['label', 'type', 'options', 'unit', 'unitKey', 'units', 'min', 'max', 'maxLength', 'hint', 'when']
  .filter(key => field[key] !== undefined).map(key => [key, field[key]])
  .concat([['path', path], ['proposed', false], ['validation', { schema: APPLICATION_SCHEMA, path }]]));
const explicitPaths = {
  household_structure: 'household.partner', married_or_civil_partners: 'household.married',
  dependants_presence: 'household.children', loans_presence: 'none', credit_card_status: 'creditCard.clears',
  target_retirement_income: 'retirement.income', cash_savings: 'savings.cash'
};

function existingQuestion(fact, profile) {
  let path = fact.fieldPath.replace(/^\/household\/(?=primaryPerson|partner|expenses|assets|liabilities|pensions|dependants|incomeSources|assumptions|goals)/, '/');
  const explicit = explicitPaths[fact.factId];
  if (explicit && explicit !== 'none') return copyField(fields.find(field => field.path === explicit), explicit);
  // The original spending question asks all spending, so it cannot establish
  // essential-only spending. Nor does a yes/partly answer give a numeric pension fraction.
  if (['essential_spending', 'essential_spending_basis', 'state_pension_fraction'].includes(fact.factId)) return null;
  const candidates = fields.filter(field => field.profilePath && new RegExp('^' + field.profilePath.replaceAll('*', '[^/]+') + '$').test(path));
  if (candidates.length !== 1) return null;
  const field = candidates[0];
  if (!field.path.includes('*')) return copyField(field, field.path);
  // A profile index need not equal a repeater index: use the mapping's actual
  // application provenance, and never ask the question for the wrong record.
  const parent = path.split('/').slice(0, 3).join('/');
  const sourcePaths = Object.entries(profile.fieldMetadata).filter(([key]) => key === path || key.startsWith(parent + '/'))
    .flatMap(([, metadata]) => metadata.application?.paths ?? []);
  const pattern = new RegExp('^' + field.path.replaceAll('.', '\\.').replaceAll('*', '\\d+') + '$');
  const matching = [...new Set(sourcePaths.filter(source => pattern.test(source)))];
  if (matching.length === 1) return copyField(field, matching[0]);
  const repeaterPattern = new RegExp('^' + field.path.split('*')[0].replaceAll('.', '\\.') + '(\\d+)\\.');
  const indexes = [...new Set(sourcePaths.map(source => source.match(repeaterPattern)?.[1]).filter(Boolean))];
  return indexes.length === 1 ? copyField(field, field.path.replace('*', indexes[0])) : null;
}

const questionLabels = {
  essential_spending: 'How much do you spend each month on essentials?',
  essential_spending_basis: 'How much of your monthly spending is essential spending, including rent or mortgage?',
  state_pension_fraction: 'What percentage of the full State Pension do you expect?',
  person_current_age: 'What is your current age?', employment_tax_basis: 'Are you employed, self-employed or retired?',
  person_gross_income: 'What is your annual income before tax?', intended_retirement_age: 'At what age do you expect to retire?',
  pension_positions: 'What pensions do you have, or do you have none?', total_spending: 'What is your total spending, including rent or mortgage?',
  single_or_widowed: 'Are you single, married or civil partners, or widowed?', dependants: 'What are your children’s ages?',
  dependant_current_age: 'What is your child’s current age?', college_plan: 'Would your child live at home or away during college?',
  income_tax_basis: 'What kind of income do you receive?', pension_type: 'What type of pension do you have?',
  pension_projectedAnnualIncome: 'What annual income does your pension promise?', pension_retirementLumpSum: 'What lump sum will your pension pay at retirement?',
  pension_benefitStartAge: 'At what age will your pension start paying?', pension_current_value: 'What is your pension pot worth today?',
  pension_contribution_status: 'Do you still pay into this pension?', pension_employee_contribution_rate: 'What percentage of pay do you put into this pension?',
  pension_employer_contribution_rate: 'What percentage of pay does your employer put into this pension?',
  debt_currentBalance: 'How much do you still owe?', debt_annualInterestRate: 'What interest rate do you pay on this debt?',
  debt_remainingTermMonths: 'How many months remain on this debt?', debt_monthlyPayment: 'How much do you repay each month?',
  mortgage_clear_by: 'At what age or date would you like your mortgage cleared?', mortgage_cleared_on_death: 'Would this mortgage be repaid if an owner died?',
  goal_flexibility: 'How much could the date or amount of this goal change?', other_dated_costs: 'Are there other future costs, such as care or school fees? When and how much?',
  loans_presence: 'Do you have any loans, or do you have none?',
  pension_owner: 'Whose pension is this?', retirement_timeline: 'At what future age do you expect to retire?'
};
const fieldLabels = {
  netAnnual: 'How much will this income pay each year after tax, and when does it start and end?',
  grossAnnual: 'How much is this income each year before tax?',
  leftOverEachYear: 'How much money do you have left each year after regular spending?',
  liabilityId: 'Which loan or mortgage does this goal relate to?',
  chapterGoals: 'Which goal would you like this calculation to explain?',
  currentValue: 'What is this property, pension or investment worth today?', currentBalance: 'How much do you still owe?',
  annualInterestRate: 'What annual interest rate do you pay?', remainingTermMonths: 'How many months remain on this loan or mortgage?',
  annualTotal: 'How much do you spend each year, including rent or mortgage?', assets: 'How much cash do you have available?',
  retirementStatus: 'Are you working or retired?',
  householdTaxStatus: questionLabels.single_or_widowed, takeHomeBasis: 'Is your take-home pay after your pension contributions?',
  spendingBasis: 'Does your spending include debt repayments and exclude tax and pension deductions?', spendingLabel: 'How would you describe this spending?',
  goalBindings: 'Which savings, debt or pension belongs to this goal?', goalFundingFacts: 'How is this goal funded today, and when are payments due?',
  assetAssignments: 'Which savings or investments are already set aside for a goal?', cashAssetId: 'Which savings account would fund this route?',
  openingTaxState: 'What investment gains, losses or tax allowances have you already used this year?', taxDue: 'Is there any tax still to pay?',
  personalPensionContributions: 'How much do you pay into your pension?', goalSavingBasis: 'Are savings for goals separate from your regular spending?',
  retirementIncomeBasis: 'Is your retirement income target before or after tax?', protectionCases: 'What income would continue if you could not work or an owner died?'
};
function plainQuestionLabel(fact, profile) {
  const label = questionLabels[fact.factId] ?? fact.fieldPath.split('/').reverse().map(key => fieldLabels[key]).find(Boolean)
    ?? 'What details can you confirm about ' + (fact.blockingModuleIds[0]?.replaceAll('_', ' ') ?? 'this goal') + '?';
  const goal = profile.goals.find(goal => fact.fieldPath === '/goalFlexibility/' + goal.goalId);
  if (goal) return 'For “' + goal.title + '”: ' + label;
  const match = fact.fieldPath.match(/\/(incomeSources|pensions|liabilities|properties)\/(\d+)(?:\/|$)/);
  const record = match && profile[match[1]]?.[Number(match[2])];
  const ownerId = record?.ownerId ?? (record?.ownerIds?.length === 1 ? record.ownerIds[0] : null);
  const owner = [profile.primaryPerson, profile.partner].filter(Boolean).find(person =>
    fact.fieldPath.includes('/' + (person === profile.partner ? 'partner' : 'primaryPerson') + '/')
      || fact.reason.includes('for ' + person.personId) || fact.reason.includes(person.personId + "'s") || person.personId === ownerId);
  return owner ? (owner === profile.partner ? 'For your partner: ' : 'For you: ') + label : label;
}

function proposedQuestion(fact, profile) {
  let type = 'longtext', unit, options, min;
  const path = fact.fieldPath;
  if (/essential_spending/.test(fact.factId)) { type = 'money'; unit = 'month'; min = 0; }
  else if (/state_pension_fraction/.test(fact.factId)) { type = 'percent'; min = 0; }
  else if (/single_or_widowed/.test(fact.factId) || path === '/planningInputs/householdTaxStatus') {
    type = 'choice'; options = [
      { value: 'single', label: 'Single' }, { value: 'married_or_civil_partners', label: 'Married or civil partners' },
      { value: 'widowed_or_surviving_civil_partner', label: 'Widowed or surviving civil partner' }
    ];
  }
  return { proposed: true, path: 'analystFollowup.' + fact.factId.replace(/[^A-Za-z0-9_]/g, '_') + '_'
      + path.replace(/[^A-Za-z0-9]/g, '_'),
    label: plainQuestionLabel(fact, profile), type, ...(unit ? { unit } : {}), ...(options ? { options } : {}),
    ...(min !== undefined ? { min, ...(type === 'percent' ? { max: 100 } : {}) } : {}),
    writesTo: 'confirmed_form_revision_only' };
}

export function missingFactQuestions(caseFile) {
  const questions = [], unavailable = [];
  for (const [index, fact] of caseFile.pinned.missingFacts.entries()) {
    if (!['household_fact', 'plan_pack_fact'].includes(fact.kind)) { unavailable.push(fact); continue; }
    const question = existingQuestion(fact, caseFile.pinned.profile) ?? proposedQuestion(fact, caseFile.pinned.profile);
    // Distinct owner-specific gaps can share a profile path. Proposed questions
    // must not overwrite each other when the follow-up form eventually exists.
    if (question.proposed) question.path += '_' + index;
    questions.push({ ...question, factId: fact.factId, fieldPath: fact.fieldPath,
      affects: fact.blockingModuleIds.length ? fact.blockingModuleIds : ['plan'], reason: fact.reason, technicalReason: fact.reason, importance: fact.importance });
  }
  return { questions, unavailable };
}
