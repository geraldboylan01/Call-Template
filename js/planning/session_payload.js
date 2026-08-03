/**
 * Turn a finished planning call into the payload the app already renders.
 *
 * WHY THIS EXISTS. There are two pipelines in this repository that never met.
 * A call produces a profile and deterministic module results; the app that
 * draws the zoomed-out module pane, the drill-down and the charts consumes a
 * `generated.*` payload, the one an adviser pastes into the dev panel. The
 * module manifest has always DECLARED the join -- `"outputKey":
 * "generated.pbsInputs"` -- and nothing ever implemented it, so a call ended at
 * a summary card and never reached the surface that draws it.
 *
 * The contract here is docs/prompt-pack/MASTER_PROJECT_PROMPT.md, not
 * guesswork: section order, exact labels, two-column rows, numeric cells, bar
 * charts only. Where the prompt pack is strict, this file is strict, because the
 * app validates on the way in and a near-miss renders as nothing.
 *
 * WHAT THIS FILE MAY NOT DO. It must never invent a figure. Every number comes
 * from the deterministic engine result or the profile the client confirmed. The
 * prose is assembled from those same numbers, so a summary cannot drift from
 * the table above it.
 */

import { buildPersonalBalanceSheetInput } from './adapters/personal_balance_sheet.js';

/** Master-prompt bucket sections, in the exact order the app expects. */
const PBS_SECTIONS = Object.freeze([
  { key: 'lifestyle', title: 'Lifestyle', bucket: 'lifestyle_assets', subtotalLabel: 'Lifestyle assets' },
  { key: 'liquidity', title: 'Liquidity', bucket: 'spendable_reserves', subtotalLabel: 'Liquid reserves' },
  { key: 'longevity', title: 'Longevity', bucket: 'retirement_funding', subtotalLabel: 'Longevity assets' },
  { key: 'legacy', title: 'Legacy', bucket: 'concentrated_assets', subtotalLabel: 'Legacy assets' }
]);

const euro = (amount) => new Intl.NumberFormat('en-IE', {
  style: 'currency', currency: 'EUR', maximumFractionDigits: 0
}).format(Number.isFinite(amount) ? amount : 0);

const round = (amount) => Math.round(Number.isFinite(amount) ? amount : 0);

/**
 * The Personal Balance Sheet payload.
 *
 * The six sections are mandatory and ordered, every row is exactly
 * [label, number], and the summary row must be labelled "Net worth" -- the app
 * rejects "Known net worth" and its cousins. Numeric cells stay numbers:
 * "€880,000" in an outputsBucketed cell is a validation failure, not a
 * formatting preference.
 */
function buildPersonalBalanceSheetModule({ profile, result }) {
  const input = buildPersonalBalanceSheetInput(profile);
  const semantic = result?.semanticResult || {};

  const sections = PBS_SECTIONS.map((section) => {
    const rows = input.assetPositions
      .filter((position) => position.bucket === section.bucket)
      .map((position) => [String(position.label), round(position.amount)]);
    return {
      key: section.key,
      title: section.title,
      columns: ['Asset', 'Amount (€)'],
      rows,
      subtotalLabel: section.subtotalLabel,
      subtotalValue: rows.reduce((total, [, amount]) => total + amount, 0)
    };
  });

  const liabilityRows = input.liabilityPositions
    .map((position) => [String(position.label), round(position.amount)]);
  sections.push({
    key: 'liabilities',
    title: 'Liabilities',
    columns: ['Liability', 'Amount (€)'],
    rows: liabilityRows,
    subtotalLabel: 'Total liabilities',
    subtotalValue: liabilityRows.reduce((total, [, amount]) => total + amount, 0)
  });

  const grossAssets = round(semantic.grossAssets);
  const totalLiabilities = round(semantic.totalLiabilities);
  const netWorth = round(semantic.netWorth);
  sections.push({
    key: 'summary',
    title: 'Summary',
    columns: ['Metric', 'Amount (€)'],
    // These three rows, in this order, with this exact "Net worth" label.
    rows: [
      ['Gross assets', grossAssets],
      ['Total liabilities', totalLiabilities],
      ['Net worth', netWorth]
    ],
    subtotalLabel: 'Net worth',
    subtotalValue: netWorth
  });

  const bucketTotals = PBS_SECTIONS.map((section) => (
    sections.find((item) => item.key === section.key)?.subtotalValue ?? 0
  ));

  // pbsInputs drives the app's own liquidity colour coding. The contract says
  // never to guess these, so each is included only when the client gave it.
  const pbsInputs = {};
  const annualExpenditure = Number.isFinite(input.monthlyExpenditure)
    ? round(input.monthlyExpenditure * 12)
    : null;
  if (annualExpenditure !== null) pbsInputs.annualExpenditure = annualExpenditure;
  if (Number.isFinite(profile?.primaryPerson?.age)) pbsInputs.currentAge = profile.primaryPerson.age;
  const retirementStatus = profile?.assumptions?.values?.persona?.retirementStatus;
  if (retirementStatus === 'retired') pbsInputs.retirementStatus = 'retired';

  const generated = {
    summaryHtml: personalBalanceSheetSummary({
      sections, grossAssets, totalLiabilities, netWorth, annualExpenditure,
      reserveMonths: semantic.reserveMonths
    }),
    ...(Object.keys(pbsInputs).length > 0 ? { pbsInputs } : {}),
    outputsBucketed: { currencySymbol: '€', sections },
    charts: [
      {
        title: 'Assets by bucket',
        subtitle: 'Where household wealth is held, and the job each asset currently does.',
        type: 'bar',
        labels: PBS_SECTIONS.map((section) => section.title),
        display: { variant: 'wide', valueFormat: 'currency', yAxisTitle: 'Asset value' },
        datasets: [{ label: 'Assets', data: bucketTotals }]
      },
      {
        title: 'Overall financial position',
        subtitle: 'Gross assets, outstanding liabilities, and the resulting net worth.',
        type: 'bar',
        labels: ['Gross assets', 'Total liabilities', 'Net worth'],
        display: { variant: 'wide', valueFormat: 'currency', yAxisTitle: 'Amount' },
        datasets: [{ label: 'Financial position', data: [grossAssets, totalLiabilities, netWorth] }]
      }
    ]
  };

  return { title: 'Personal Balance Sheet', generated };
}

/**
 * Two to four sentences, assembled from the same numbers as the table.
 *
 * Written rather than generated so it cannot drift from what is above it, and
 * so a call costs nothing extra to publish. The contract asks it to explain the
 * buckets as jobs money does, state the position, and say how to read the first
 * screen.
 */
function personalBalanceSheetSummary({
  sections, grossAssets, totalLiabilities, netWorth, annualExpenditure, reserveMonths
}) {
  const named = sections
    .filter((section) => ['lifestyle', 'liquidity', 'longevity', 'legacy'].includes(section.key))
    .filter((section) => section.subtotalValue > 0)
    .map((section) => `${section.title.toLowerCase()} ${euro(section.subtotalValue)}`);

  const opening = 'This balance sheet groups your wealth by the job it currently does: the home and '
    + 'possessions you live with, reserves you could reach quickly, long-term retirement funding, '
    + 'and assets held for another purpose entirely.';
  const position = totalLiabilities > 0
    ? `Your known assets come to ${euro(grossAssets)} against ${euro(totalLiabilities)} of borrowing, `
      + `leaving a net worth of ${euro(netWorth)}.`
    : `Your known assets come to ${euro(grossAssets)}, with no borrowing recorded, so your net worth `
      + `is ${euro(netWorth)}.`;
  const split = named.length > 0
    ? ` The split across those jobs is ${named.join(', ')}.`
    : '';
  // The app prints its own orientation line above this paragraph -- "Start with
  // net worth, then read the buckets as jobs for your money" -- so repeating it
  // here made the client read the same instruction twice in two voices.
  const reading = ' The figures below separate what is tied up in things you live in or cannot easily '
    + 'sell from what is genuinely available to you.';
  const reserve = Number.isFinite(reserveMonths) && Number.isFinite(annualExpenditure)
    ? ` Your reserves would cover roughly ${Math.round(reserveMonths)} months of spending at `
      + `${euro(annualExpenditure)} a year.`
    : '';

  return `<p>${opening} ${position}${split}${reading}${reserve}</p>`;
}

/**
 * The Pension projection payload.
 *
 * EVERY FIGURE COMES FROM THE ENGINE'S OWN AUTHORED ROWS, verbatim. The module
 * already produces a client-facing table -- labelled, currency-formatted,
 * rounded the way a person should read it -- and the one previous attempt to
 * improve on that re-derived numbers from semanticResult instead, which put
 * "2,195,539.05" on the same page as "EUR 1,017,100", printed a raw
 * currentOnTrack enum as if it were English, and showed a year as "2,029".
 *
 * So nothing here recalculates and nothing reformats. generated.pensionInputs
 * is deliberately NOT emitted: it makes the app re-run its own projection, and
 * a second set of numbers that almost agrees is worse than one set that does.
 * Wiring that is a separate decision about which engine owns the figures.
 */
function buildPensionProjectionModule({ result }) {
  const outputs = result?.outputs && Array.isArray(result.outputs.rows)
    ? { columns: [...(result.outputs.columns || ['Output', 'Value'])], rows: result.outputs.rows.map((row) => [...row]) }
    : null;
  if (!outputs || outputs.rows.length === 0) return null;

  const row = (match) => outputs.rows.find(([label]) => match.test(String(label)))?.[1];
  // The contract allows bar and line only; the engine's pension charts are
  // already bar, so anything else is a change upstream and is dropped rather
  // than rendered as nothing.
  const charts = (result.charts || [])
    .filter((chart) => ['bar', 'line'].includes(chart?.type))
    .map((chart) => ({ ...chart }));

  return {
    title: 'Pension projection',
    generated: {
      summaryHtml: pensionProjectionSummary({
        readiness: result?.semanticResult?.readinessSentence,
        // Tolerant patterns: the engine labels the same figure "at income
        // start" or "at target start" depending on the scenario, and a summary
        // that silently drops a sentence when a label shifts is worse than one
        // that follows the table.
        potAtIncomeStart: row(/projected .*pot at .*\(current\)/i),
        requiredPot: row(/required pension pot/i),
        targetToday: row(/target income \(today/i),
        surplus: row(/surplus vs required/i)
      }),
      outputs,
      ...(charts.length ? { charts } : {})
    }
  };
}

/**
 * Two to four sentences, built from the same strings as the table above it.
 *
 * The readiness sentence is the engine's own client-facing prose, so the page
 * and the analysis cannot disagree about the conclusion. Anything the engine
 * did not produce is simply left out rather than described vaguely.
 */
function pensionProjectionSummary({ readiness, potAtIncomeStart, requiredPot, targetToday, surplus }) {
  const opening = 'This projection carries your pensions forward on Planéir\u2019s standard assumptions '
    + 'and compares what they are expected to be worth against what the retirement income you asked '
    + 'for would require.';
  const position = potAtIncomeStart && requiredPot
    ? ` At the point your retirement income starts, the projection puts your available pension at `
      + `${potAtIncomeStart} against a required pot of ${requiredPot}.`
    : '';
  const target = targetToday ? ` That target is ${targetToday} a year in today\u2019s money.` : '';
  const verdict = typeof readiness === 'string' && readiness.trim() ? ` ${readiness.trim()}` : '';
  const headroom = surplus ? ` The projected surplus against the required pot is ${surplus}.` : '';
  return `<p>${opening}${position}${target}${verdict}${headroom}</p>`;
}

/** Which planning modules can be published, and how. */
const MODULE_BUILDERS = Object.freeze({
  personal_balance_sheet: buildPersonalBalanceSheetModule,
  pension_projection: buildPensionProjectionModule
});

export function canPublishModule(moduleId) {
  return Object.hasOwn(MODULE_BUILDERS, moduleId);
}

/**
 * A published session for a finished call.
 *
 * Deliberately skips modules with no builder yet rather than emitting a
 * half-formed one: a module the app cannot validate renders as nothing at all,
 * which is worse than an honestly shorter list.
 */
export function buildPublishedSessionFromCall({
  profile, results, clientName = 'Client', sessionId, createdAt
}) {
  const stamp = createdAt || new Date().toISOString();
  const modules = [];
  const skipped = [];

  (results || []).forEach((result, index) => {
    const build = MODULE_BUILDERS[result?.moduleId];
    if (!build) {
      skipped.push(result?.moduleId);
      return;
    }
    const built = build({ profile, result });
    // A builder may decline: a module that ran but produced nothing publishable
    // must be skipped like one with no builder at all, not pushed as an empty
    // card the app would render as a heading over nothing.
    if (!built) {
      skipped.push(result?.moduleId);
      return;
    }
    modules.push({
      id: `module-${index + 1}`,
      createdAt: stamp,
      updatedAt: stamp,
      ...built
    });
  });

  return {
    session: {
      version: 1,
      sessionId: sessionId || `call-${stamp.replace(/[^0-9]/g, '').slice(0, 14)}`,
      clientName,
      order: modules.map((module) => module.id),
      activeModuleId: modules[0]?.id || null,
      modules
    },
    skipped
  };
}
