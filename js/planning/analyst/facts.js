import { PLAN_PACK_METRIC_TYPES } from '../plan_pack/compiler.js';

const euro = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const number = new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 });
const copy = value => JSON.parse(JSON.stringify(value));

// Register existing compiler metrics only. The B1.5 story-facts layer will add
// differences, issue scans and running totals; the analyst never computes them.
export function compiledFacts(compiled, routeId) {
  const route = compiled.routes.find(row => row.id === routeId);
  const ledger = compiled.resourceLedger.routes.find(row => row.routeId === routeId);
  const registry = {};
  const add = (id, value, unit, source) => {
    if (value === null || value === undefined) return;
    const text = unit === 'EUR' ? euro.format(value) : unit === 'year' ? String(value) : typeof value === 'number' ? number.format(value) : String(value);
    registry[id] = { id, value, unit, text, source: { ...source, routeId, versions: copy(compiled.versions) } };
  };
  const chapters = [];
  for (const [chapter, caseId] of Object.entries(route?.chapterCases ?? {})) {
    const entry = compiled.chapters.find(row => row.id === chapter)?.cases.find(row => row.id === caseId);
    if (!entry) continue;
    chapters.push({ chapter, caseId, nativeCaseId: entry.nativeCaseId, metrics: copy(entry.metrics) });
    for (const [key, value] of Object.entries(entry.metrics)) {
      const type = chapter === 'protection_gap' ? (key.endsWith('.months') ? 'number' : 'money') : PLAN_PACK_METRIC_TYPES[chapter]?.[key];
      if (type) add(chapter + '.' + key, value, type === 'money' ? 'EUR' : type,
        { chapter, caseId, nativeCaseId: entry.nativeCaseId, metric: key });
    }
  }
  const summary = ledger ? Object.fromEntries([
    'status', 'goalFundingStatus', 'openingCash', 'recordedCash', 'cashAvailableAfterReserve',
    'cashAllocated', 'cashRemaining', 'reserveProtected', 'baselineLeftOver', 'balanced', 'goalsCovered'
  ].filter(key => Object.hasOwn(ledger, key)).map(key => [key, ledger[key]])) : null;
  if (summary) {
    summary.reserve = ledger.reserve?.protectedAmount ?? null;
    for (const [key, value] of Object.entries(summary)) {
      if (typeof value === 'number') add('ledger.' + key, value, 'EUR', { panel: 'ledger', ledgerPath: key === 'reserve' ? '/reserve/protectedAmount' : '/' + key });
    }
  }
  return { registry, chapters, ledgerSummary: summary };
}
