import { createOpaqueId, isPlainObject, sha256Json } from '../utils.js';

export function baseCurrency(profile) {
  return profile?.preferences?.baseCurrency || 'EUR';
}

export function moneyAmount(money, currency = 'EUR') {
  if (!money || money.currency !== currency || typeof money.amount !== 'number' || !Number.isFinite(money.amount)) {
    return null;
  }
  return money.amount;
}

export function sumKnown(values) {
  return values.reduce((total, value) => total + (typeof value === 'number' && Number.isFinite(value) ? value : 0), 0);
}

export function cashAmount(profile) {
  const currency = baseCurrency(profile);
  return sumKnown((profile.assets || [])
    .filter((asset) => asset.type === 'cash')
    .map((asset) => moneyAmount(asset.currentValue, currency)));
}

export function availableInvestmentAmount(profile) {
  const currency = baseCurrency(profile);
  return sumKnown((profile.assets || [])
    .filter((asset) => asset.type === 'cash' || asset.type === 'investment')
    .filter((asset) => asset.type === 'cash' || asset.liquid === true)
    .map((asset) => moneyAmount(asset.currentValue, currency)));
}

export function annualExpenses(profile) {
  const currency = baseCurrency(profile);
  const explicit = moneyAmount(profile.expenses?.annualTotal, currency);
  if (explicit !== null) return explicit;
  const essential = moneyAmount(profile.expenses?.monthlyEssential, currency);
  const discretionary = moneyAmount(profile.expenses?.monthlyDiscretionary, currency);
  if (essential === null && discretionary === null) return null;
  return ((essential || 0) + (discretionary || 0)) * 12;
}

export function monthlyExpenses(profile) {
  const annual = annualExpenses(profile);
  return annual === null ? null : annual / 12;
}

export function findGoal(profile, types) {
  const typeSet = new Set(Array.isArray(types) ? types : [types]);
  const priority = { high: 3, medium: 2, low: 1 };
  return [...(profile.goals || [])]
    .filter((goal) => typeSet.has(goal.type) && !['completed', 'paused'].includes(goal.status))
    .sort((left, right) => (priority[right.priority] || 0) - (priority[left.priority] || 0))[0] || null;
}

export function personForId(profile, ownerId) {
  if (profile.primaryPerson?.personId === ownerId) return profile.primaryPerson;
  if (profile.partner?.personId === ownerId) return profile.partner;
  return null;
}

export function grossEmploymentIncome(profile, ownerId) {
  const currency = baseCurrency(profile);
  return sumKnown((profile.incomeSources || [])
    .filter((income) => income.ownerId === ownerId && ['employment', 'self_employment'].includes(income.type))
    .map((income) => moneyAmount(income.grossAnnual, currency)));
}

export function netHouseholdIncome(profile) {
  const currency = baseCurrency(profile);
  const values = (profile.incomeSources || []).map((income) => moneyAmount(income.netAnnual, currency));
  if (!values.some((value) => value !== null)) return null;
  return sumKnown(values);
}

export function getAssumption(profile, path, fallback) {
  const tokens = Array.isArray(path) ? path : String(path).split('.').filter(Boolean);
  let cursor = profile?.assumptions?.values;
  for (const token of tokens) {
    if (!isPlainObject(cursor) || !Object.hasOwn(cursor, token)) return fallback;
    cursor = cursor[token];
  }
  return typeof cursor === 'undefined' ? fallback : cursor;
}

export function confirmedNone(profile, path) {
  return getAssumption(profile, 'completionFacts.confirmedNonePaths', {})?.[path] === true;
}

export function missing(fieldPath, reason, blockingModuleIds, importance = 'required') {
  return { fieldPath, reason, blockingModuleIds: [...blockingModuleIds], importance };
}

export function readiness({
  status,
  requiredMissing = [],
  assumptionsUsed = [],
  warnings = []
}) {
  return { status, requiredMissing, assumptionsUsed, warnings };
}

export function readinessFromMissing(requiredMissing, {
  assumptionsUsed = [],
  warnings = [],
  relevant = true
} = {}) {
  if (!relevant) return readiness({ status: 'not_relevant', warnings });
  // ONLY A REQUIRED INPUT BLOCKS. An input marked 'assumed' is one the module
  // runs without but answers better with, so it belongs in the question queue
  // -- the meeting will ask for it -- without holding the analysis hostage when
  // the client does not know it. Goal routing already draws exactly this line
  // when deciding what may drop a module.
  if (requiredMissing.some((item) => (item?.importance ?? 'required') === 'required')) {
    return readiness({ status: 'missing_information', requiredMissing, assumptionsUsed, warnings });
  }
  if (requiredMissing.length > 0) {
    return readiness({
      status: assumptionsUsed.length > 0 ? 'ready_with_assumptions' : 'ready',
      requiredMissing,
      assumptionsUsed,
      warnings
    });
  }
  return readiness({
    status: assumptionsUsed.length > 0 ? 'ready_with_assumptions' : 'ready',
    assumptionsUsed,
    warnings
  });
}

export function projectionParts(projection) {
  return {
    assumptions: projection?.assumptionsTable ?? {},
    outputs: projection?.outputsTable ?? projection?.result ?? {},
    tables: Array.isArray(projection?.tables) ? projection.tables : [],
    charts: Array.isArray(projection?.charts) ? projection.charts : []
  };
}

export async function createModuleRunResult({
  moduleId,
  moduleVersion,
  input,
  context,
  projection,
  semanticResult,
  warnings = []
}) {
  const parts = projectionParts(projection);
  return {
    runId: createOpaqueId('run'),
    moduleId,
    moduleVersion,
    calculationVersion: context.calculationVersion,
    inputSnapshotHash: await sha256Json({
      input,
      scenarioOverrides: context.scenarioOverrides || {}
    }),
    assumptions: parts.assumptions,
    outputs: parts.outputs,
    tables: parts.tables,
    charts: parts.charts,
    semanticResult: semanticResult || {},
    warnings: [...new Set(warnings.filter(Boolean))],
    calculatedAt: context.calculatedAt || new Date().toISOString()
  };
}

export function crossCurrencyWarnings(profile, candidateCollections) {
  const currency = baseCurrency(profile);
  const warnings = [];
  for (const [label, collection] of candidateCollections) {
    if ((collection || []).some((entry) => entry?.currency && entry.currency !== currency)) {
      warnings.push(`${label} in a currency other than ${currency} were excluded; no implicit FX conversion was applied.`);
    }
  }
  return warnings;
}
