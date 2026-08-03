/**
 * A finished call, converted into the payload the app already renders.
 *
 * The module manifest has always DECLARED this join -- `"outputKey":
 * "generated.pbsInputs"` -- and nothing implemented it, so a call ended at a
 * summary card and never reached the pane that draws modules and charts.
 *
 * The contract is docs/prompt-pack/MASTER_PROJECT_PROMPT.md. Where it is
 * strict, these checks are strict, because the app validates on the way in and
 * a near-miss renders as nothing at all.
 */

import assert from 'node:assert/strict';

import { applyProfilePatch, createHouseholdProfile, runPlanningModule } from '../js/planning/index.js';
import { buildPublishedSessionFromCall, canPublishModule } from '../js/planning/session_payload.js';
import { importPublishedSession } from '../js/state.js';

const NOW = '2026-08-02T09:00:00.000Z';
const provenance = {
  source: 'user_confirmation', confidence: 'high', certainty: 'exact',
  capturedAt: NOW, confirmedByUser: true
};

let checks = 0;
const check = (label, condition, detail = '') => {
  checks += 1;
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
};

const profile = applyProfilePatch(
  createHouseholdProfile({ profileId: 'sp', nowIso: NOW, calculationDateIso: '2026-08-02' }),
  {
    patchId: 'sp-1',
    operations: [
      { op: 'add', path: '/primaryPerson/age', value: 35, provenance },
      { op: 'add', path: '/properties/-', value: { propertyId: 'home', label: 'Family home', use: 'home', currentValue: { amount: 1_200_000, currency: 'EUR' } }, provenance },
      { op: 'add', path: '/assets/-', value: { assetId: 'cash', label: 'Cash savings', type: 'cash', currentValue: { amount: 38_000, currency: 'EUR' }, liquid: true }, provenance },
      { op: 'add', path: '/pensions/-', value: { pensionId: 'irl', ownerId: 'primary', label: 'Client Irish pension', type: 'occupational', currentValue: { amount: 77_000, currency: 'EUR' } }, provenance },
      { op: 'add', path: '/assets/-', value: { assetId: 'btc', label: 'Bitcoin', type: 'other', currentValue: { amount: 1_500, currency: 'EUR' } }, provenance },
      { op: 'add', path: '/liabilities/-', value: { liabilityId: 'm', label: 'Family home mortgage', type: 'mortgage', currentBalance: { amount: 575_000, currency: 'EUR' } }, provenance },
      { op: 'add', path: '/expenses/annualTotal', value: { amount: 100_000, currency: 'EUR' }, provenance }
    ]
  },
  { nowIso: NOW }
).profile;

const result = await runPlanningModule('personal_balance_sheet', profile, { calculationDateIso: '2026-08-02' });
const { session, skipped } = buildPublishedSessionFromCall({
  profile, results: [result], clientName: 'Test Client'
});

/* --------------------------------------------- the app must accept it */

// The real gate: the app's own importer. A payload it rejects renders as
// nothing, so this is the check that actually matters.
const imported = importPublishedSession(session);
check('the app validator accepts the converted call', imported.modules.length === 1);
check('the module is ordered and active', session.order.length === 1 && session.activeModuleId === session.order[0]);

const generated = session.modules[0].generated;
const sections = generated.outputsBucketed.sections;

/* ------------------------------------------------- the PBS contract */

check('the six sections are present in the required order',
  sections.map((section) => section.key).join() === 'lifestyle,liquidity,longevity,legacy,liabilities,summary',
  sections.map((section) => section.key).join());
check('the currency symbol is the euro sign, not a code',
  generated.outputsBucketed.currencySymbol === '€');
for (const section of sections) {
  check(`${section.key} has exactly two columns`, section.columns.length === 2);
  // A formatted string in a numeric cell is a validation failure, not a
  // styling choice: "€880,000" breaks the app's own arithmetic.
  check(`${section.key} rows are [label, number]`,
    section.rows.every((row) => row.length === 2 && typeof row[0] === 'string' && typeof row[1] === 'number'),
    JSON.stringify(section.rows));
}
const summary = sections.at(-1);
check('the summary rows are the required three, in order',
  summary.rows.map(([label]) => label).join() === 'Gross assets,Total liabilities,Net worth');
check('the net-worth row is labelled exactly "Net worth"',
  summary.rows.some(([label]) => label === 'Net worth'),
  'the app rejects "Known net worth" and its cousins');
check('the summary subtotal matches the net-worth row',
  summary.subtotalLabel === 'Net worth' && summary.subtotalValue === summary.rows[2][1]);

/* ------------------------------------------------------ the numbers */

const bucketed = Object.fromEntries(sections.map((section) => [section.key, section.subtotalValue]));
check('the home is a lifestyle asset', bucketed.lifestyle === 1_200_000);
check('cash is a liquid reserve', bucketed.liquidity === 38_000);
check('the pension is longevity funding', bucketed.longevity === 77_000);
check('crypto is Legacy', bucketed.legacy === 1_500);
// The three summary figures must reconcile against the buckets independently,
// or the client is reading a table that does not add up.
check('gross assets equal the four buckets summed',
  summary.rows[0][1] === bucketed.lifestyle + bucketed.liquidity + bucketed.longevity + bucketed.legacy);
check('net worth equals gross assets less liabilities',
  summary.rows[2][1] === summary.rows[0][1] - summary.rows[1][1]);

/* -------------------------------------------------- inputs and charts */

check('annual expenditure reaches the app, driving its liquidity colouring',
  generated.pbsInputs.annualExpenditure === 100_000);
check('current age reaches the app', generated.pbsInputs.currentAge === 35);
// The contract forbids guessing these. A profile without them must omit them
// rather than invent a default.
const bare = applyProfilePatch(
  createHouseholdProfile({ profileId: 'bare', nowIso: NOW, calculationDateIso: '2026-08-02' }),
  {
    patchId: 'bare-1',
    operations: [
      { op: 'add', path: '/assets/-', value: { assetId: 'c', label: 'Savings', type: 'cash', currentValue: { amount: 10_000, currency: 'EUR' }, liquid: true }, provenance },
      { op: 'add', path: '/assumptions/values/completionFacts', value: { confirmedNonePaths: { '/liabilities': true } }, provenance }
    ]
  },
  { nowIso: NOW }
).profile;
const bareResult = await runPlanningModule('personal_balance_sheet', bare, { calculationDateIso: '2026-08-02' });
const bareGenerated = buildPublishedSessionFromCall({ profile: bare, results: [bareResult] })
  .session.modules[0].generated;
check('an unknown age or spend is omitted, never guessed',
  !Object.hasOwn(bareGenerated, 'pbsInputs') || !Object.hasOwn(bareGenerated.pbsInputs, 'currentAge'),
  JSON.stringify(bareGenerated.pbsInputs));

check('there are exactly two charts', generated.charts.length === 2);
for (const chart of generated.charts) {
  // The contract allows only bar or line. The planning engine's own chart for
  // this module is a doughnut, which the app will not render.
  check(`"${chart.title}" is a bar chart`, chart.type === 'bar');
  check(`"${chart.title}" carries only numeric data`,
    chart.datasets.every((dataset) => dataset.data.every((value) => typeof value === 'number')));
  check(`"${chart.title}" is marked as currency`, chart.display.valueFormat === 'currency');
}
check('the bucket chart matches the bucket subtotals',
  generated.charts[0].datasets[0].data.join() === [
    bucketed.lifestyle, bucketed.liquidity, bucketed.longevity, bucketed.legacy
  ].join());

/* ------------------------------------------------------- the summary */

check('the summary is a single client-facing paragraph',
  /^<p>.*<\/p>$/.test(generated.summaryHtml));
// Assembled from the same numbers as the table, so it cannot drift from it.
check('the summary states the net worth shown above it',
  generated.summaryHtml.includes('€741,500'));
check('the summary names no internal terminology',
  !/payload|engine|runtime|JSON|schema|bucket_|semanticResult/i.test(generated.summaryHtml));

/* --------------------------------------------------- unknown modules */

check('a module with no builder is known to be unpublishable', !canPublishModule('college_funding'));
check('personal_balance_sheet is publishable', canPublishModule('personal_balance_sheet'));
// Skipping is honest; emitting a half-formed module renders as nothing.
const mixed = buildPublishedSessionFromCall({
  profile, results: [result, { moduleId: 'college_funding' }]
});
check('an unsupported module is skipped and reported',
  mixed.session.modules.length === 1 && mixed.skipped.join() === 'college_funding');
check('nothing was skipped for the supported case', skipped.length === 0);

/* ------------------------------------------------ the pension projection */

const pensionProfile = applyProfilePatch(profile, {
  patchId: 'pension-ready',
  operations: [
    { op: 'add', path: '/primaryPerson/intendedRetirementAge', value: 60, provenance },
    { op: 'add', path: '/incomeSources/-', value: { incomeId: 'job', ownerId: 'primary', label: 'Salary', type: 'employment', grossAnnualAmount: { amount: 90_000, currency: 'EUR' } }, provenance },
    { op: 'add', path: '/pensions/0/employeeContributionRate', value: 0.2, provenance },
    { op: 'add', path: '/pensions/0/employerContributionRate', value: 0.1, provenance },
    { op: 'add', path: '/assumptions/values/retirement', value: { targetIncomeToday: 45_000 }, provenance }
  ]
}, { nowIso: NOW }).profile;
const pensionResult = await runPlanningModule('pension_projection', pensionProfile, { calculationDateIso: '2026-08-02' });
const pensionModule = buildPublishedSessionFromCall({
  profile: pensionProfile, results: [pensionResult], clientName: 'Pension Client'
}).session.modules[0];

check('the pension projection can be published', Boolean(pensionModule));
check('the app validator accepts the pension projection',
  importPublishedSession({ ...session, modules: [pensionModule], order: [pensionModule.id], activeModuleId: pensionModule.id })
    .modules.length === 1);

const pensionGenerated = pensionModule.generated;
// EVERY FIGURE COMES FROM THE ENGINE'S OWN AUTHORED ROWS. Re-deriving them from
// semanticResult once put "2,195,539.05" beside "€1,017,100" on the same page,
// printed a raw currentOnTrack enum as English, and showed a year as "2,029".
check('the pension table is the engine\'s own rows, unchanged',
  JSON.stringify(pensionGenerated.outputs.rows) === JSON.stringify(pensionResult.outputs.rows));
check('the pension table keeps the engine\'s own formatting',
  pensionGenerated.outputs.rows.every(([, value]) => typeof value === 'string'),
  'a re-rounded or re-formatted figure is a second source of truth');
check('no raw status enum reaches the client',
  !/currentOnTrack|maxOnTrack|offTrack/.test(JSON.stringify(pensionGenerated)));
// The app must not be handed inputs to re-run its own projection alongside the
// engine's: two sets of numbers that almost agree is worse than one that does.
check('the app is not asked to recompute the projection',
  !Object.hasOwn(pensionGenerated, 'pensionInputs'));

for (const chart of pensionGenerated.charts || []) {
  check(`pension chart "${chart.title}" is bar or line`, ['bar', 'line'].includes(chart.type));
}
check('the pension summary is a single client-facing paragraph',
  /^<p>.*<\/p>$/.test(pensionGenerated.summaryHtml));
check('the pension summary names no internal terminology',
  !/semanticResult|payload|schema|readinessStatus/i.test(pensionGenerated.summaryHtml));
// THE INVARIANT, not a specific label: every figure the summary states must
// appear verbatim in the table above it, so prose and table cannot disagree.
const tableValues = new Set(pensionResult.outputs.rows.map(([, value]) => String(value)));
const summaryFigures = pensionGenerated.summaryHtml.match(/€[\d,]+/g) || [];
check('the pension summary states no figure the table does not',
  summaryFigures.every((figure) => [...tableValues].some((value) => value.includes(figure))),
  JSON.stringify(summaryFigures));
check('the pension summary carries the engine\'s own verdict',
  pensionGenerated.summaryHtml.includes(pensionResult.semanticResult.readinessSentence.slice(0, 40)));

// A module that produced nothing must not publish an empty card.
check('a pension result with no rows does not publish',
  buildPublishedSessionFromCall({
    profile: pensionProfile, results: [{ moduleId: 'pension_projection', outputs: { columns: [], rows: [] } }]
  }).session.modules.length === 0);

console.info(`[SessionPayload] ${checks} checks passed: a finished call converts into a payload the `
  + 'app accepts, with the required sections, reconciling totals and bar charts only.');
