/**
 * Running the analysis the ADVISER asked for, on the assumptions they chose.
 *
 * WHY THIS EXISTS AT ALL. `/run` used to record the adviser's intent and stop
 * there, which quietly defeated the point: you cannot demonstrate WHICH lever
 * and which value are worth using if you never see what they produced, and a
 * bundle recording "they tried retiring at 60" with no number attached is thin
 * evidence of expertise. The interesting part of a demonstration is what the
 * adviser did AFTER seeing the figure.
 *
 * A WHAT-IF ALWAYS RUNS WITH ITS BASE CASE. Both, together, every time. A
 * scenario with nothing to compare against is not a scenario, and asking the
 * adviser to hold the base figures in their head between turns would make the
 * comparison a memory rather than a record.
 *
 * NOTHING HERE IS NEW CAPABILITY. It calls `runConsumerAnalysis`, the same
 * deterministic entrypoint the Worker's own `runStoredConsumerAnalysis` uses,
 * with overrides keyed by module id exactly as `scenarioFor()` expects. No
 * model call, no token spend, no new execution path, and nothing that reaches
 * the live lane.
 */

import { runConsumerAnalysis } from '../../js/planning/orchestrator.js';

const money = new Intl.NumberFormat('en-IE', {
  style: 'currency', currency: 'EUR', maximumFractionDigits: 0
});

/** Keys that describe the run rather than its outcome. */
const NOT_A_FIGURE = new Set(['currency', 'scenarioId', 'moduleId', 'moduleVersion']);

/**
 * The numbers worth reading out, taken from whatever the module returned.
 *
 * Deliberately generic. Hardcoding "show the pot and the gap" per module would
 * be a second place that has to be updated whenever an engine changes what it
 * reports, and it would silently omit a figure a new module added.
 */
export function headlineFigures(semanticResult = {}) {
  const figures = {};
  for (const [key, value] of Object.entries(semanticResult || {})) {
    if (NOT_A_FIGURE.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) figures[key] = value;
  }
  return figures;
}

/** Base vs scenario, with the movement, for the lines printed mid-call. */
export function compareFigures(base = {}, scenario = {}) {
  const keys = [...new Set([...Object.keys(base), ...Object.keys(scenario)])];
  return keys.map((key) => {
    const from = base[key];
    const to = scenario[key];
    return {
      key,
      base: from ?? null,
      scenario: to ?? null,
      delta: Number.isFinite(from) && Number.isFinite(to) ? to - from : null
    };
  });
}

/** A figure line a person can read: "requiredPot 780,000 → 905,000 (+125,000)". */
export function describeFigure(row) {
  const show = (value) => (Number.isFinite(value) ? money.format(value) : '—');
  if (row.scenario === null) return `${row.key}: ${show(row.base)}`;
  if (row.base === null) return `${row.key}: ${show(row.scenario)}`;
  const movement = Number.isFinite(row.delta)
    ? ` (${row.delta >= 0 ? '+' : '−'}${money.format(Math.abs(row.delta)).replace('€', '€')})`
    : '';
  return `${row.key}: ${show(row.base)} → ${show(row.scenario)}${movement}`;
}

async function runOne(profile, moduleId, scenarioOverrides) {
  // A module that cannot run is a FINDING, not a crash. runConsumerAnalysis
  // already collects per-module failures into `errors`; the outer catch is for
  // the profile-level failures that happen before any module is reached.
  try {
    const analysis = await runConsumerAnalysis({
      profile,
      moduleIds: [moduleId],
      ...(Object.keys(scenarioOverrides).length ? { scenarioOverrides: { [moduleId]: scenarioOverrides } } : {})
    });
    const result = (analysis.results || []).find((item) => item.moduleId === moduleId) || null;
    const failure = (analysis.errors || []).find((item) => item.moduleId === moduleId) || null;
    return {
      ran: Boolean(result),
      figures: result ? headlineFigures(result.semanticResult) : {},
      scenarioSnapshotHash: result?.scenarioSnapshotHash || null,
      error: failure ? { code: failure.code, message: failure.message } : null
    };
  } catch (error) {
    return {
      ran: false,
      figures: {},
      scenarioSnapshotHash: null,
      error: { code: error?.code || 'analysis_failed', message: String(error?.message || error) }
    };
  }
}

/**
 * Run each analysis the adviser asked for, base case alongside any what-if.
 *
 * @param {object} options
 * @param {object} options.profile the live profile from loadAgentContext
 * @param {object[]} options.runs parsed `/run` requests, already lever-checked
 * @returns {Promise<object[]>} one record per request, for printing and for the bundle
 */
export async function runAdviserAnalyses({ profile, runs = [] }) {
  const records = [];
  for (const run of runs) {
    const overrides = run.acceptedOverrides || {};
    const isScenario = Object.keys(overrides).length > 0;
    const base = await runOne(profile, run.moduleId, {});
    const scenario = isScenario ? await runOne(profile, run.moduleId, overrides) : null;
    records.push({
      moduleId: run.moduleId,
      requestedOverrides: run.scenarioOverrides || {},
      acceptedOverrides: overrides,
      leverError: run.leverError || null,
      isScenario,
      base,
      scenario,
      // THE FIGURES, NOT THE HASH. This was written against
      // `scenarioSnapshotHash` first, and that was wrong twice over: the hash
      // is not on a module result at all (it lives on the separate run
      // identity), and even where it is available it hashes the OVERRIDES —
      // so it changes whenever the adviser sets a lever, including when the
      // engine goes on to ignore that lever completely. Comparing what the
      // module actually computed is the only check that catches an override
      // reaching nothing, which is exactly the failure that matters: the
      // adviser reads base-case numbers believing they are a what-if.
      distinctFromBase: Boolean(
        scenario?.ran && base?.ran
        && JSON.stringify(base.figures) !== JSON.stringify(scenario.figures)
      ),
      comparison: scenario ? compareFigures(base.figures, scenario.figures) : []
    });
  }
  return records;
}

/** The lines shown to the adviser mid-call. Their own run, never the shadow. */
export function describeAdviserRun(record) {
  const lines = [];
  const levers = Object.entries(record.acceptedOverrides)
    .map(([key, value]) => `${key}=${value}`).join(', ');
  lines.push(`  ${record.moduleId}${levers ? ` — what-if: ${levers}` : ' — base case'}`);
  if (record.leverError) lines.push(`    ! ${record.leverError}`);
  if (!record.base.ran) {
    lines.push(`    could not run: ${record.base.error?.code || 'unknown'}`
      + `${record.base.error?.message ? ` — ${record.base.error.message}` : ''}`);
    return lines;
  }
  if (!record.isScenario) {
    for (const [key, value] of Object.entries(record.base.figures)) {
      lines.push(`    ${describeFigure({ key, base: value, scenario: null, delta: null })}`);
    }
    return lines;
  }
  if (!record.scenario.ran) {
    lines.push(`    the what-if would not run: ${record.scenario.error?.code || 'unknown'}`);
    return lines;
  }
  for (const row of record.comparison) lines.push(`    ${describeFigure(row)}`);
  if (!record.distinctFromBase) {
    lines.push('    ! IDENTICAL TO THE BASE CASE — the lever reached nothing.');
    lines.push('      Do not read these as a what-if. This module does not honour that');
    lines.push('      override; the figures above are the base case.');
  }
  return lines;
}
