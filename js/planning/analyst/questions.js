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

function proposedQuestion(fact) {
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
    label: fact.reason, type, ...(unit ? { unit } : {}), ...(options ? { options } : {}),
    ...(min !== undefined ? { min, ...(type === 'percent' ? { max: 100 } : {}) } : {}),
    writesTo: 'confirmed_form_revision_only' };
}

export function missingFactQuestions(caseFile) {
  const questions = [], unavailable = [];
  for (const [index, fact] of caseFile.pinned.missingFacts.entries()) {
    if (!['household_fact', 'plan_pack_fact'].includes(fact.kind)) { unavailable.push(fact); continue; }
    const question = existingQuestion(fact, caseFile.pinned.profile) ?? proposedQuestion(fact);
    // Distinct owner-specific gaps can share a profile path. Proposed questions
    // must not overwrite each other when the follow-up form eventually exists.
    if (question.proposed) question.path += '_' + index;
    questions.push({ ...question, factId: fact.factId, fieldPath: fact.fieldPath,
      affects: fact.blockingModuleIds.length ? fact.blockingModuleIds : ['plan'], reason: fact.reason, importance: fact.importance });
  }
  return { questions, unavailable };
}
