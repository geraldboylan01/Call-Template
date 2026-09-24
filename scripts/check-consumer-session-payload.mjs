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
import { readFileSync } from 'node:fs';

import { normalizeCollegeFundingInputs } from '../js/college_funding_math.js';
import {
  computeMortgageComparison,
  normalizeMortgageInputs
} from '../js/mortgage_math.js';
import { normalizeNetRetirementInputs } from '../js/net_retirement_math.js';
import {
  validateOutputsBucketedPayload,
  validateOutputsBucketedScenariosPayload
} from '../js/outputs_bucketed_contract.js';
import { computePensionProjection, normalizePensionInputs } from '../js/pension_math.js';
import { applyProfilePatch, createHouseholdProfile, runPlanningModule } from '../js/planning/index.js';
import { buildPublishedSessionFromCall, canPublishModule } from '../js/planning/session_payload.js';
import { MAX_MODULE_SCENARIO_CASES, MAX_PBS_SCENARIO_ALTERNATIVES } from '../js/scenario_cap.js';
import { drainSessionImportWarnings, importPublishedSession } from '../js/state.js';

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

/* ================================================= the scenario cap ===
 *
 * A module shows at most 4 cases, counting the base or current case. The rule
 * is enforced twice over, in opposite directions, and both halves are checked
 * here because getting only one of them right is worse than neither:
 *
 *   - the engine normalisers REJECT an over-cap payload, so a fifth case fails
 *     loudly at the point it is authored rather than rendering as a partial
 *     set nobody can explain;
 *   - the session importer TOLERATES one, because a client link published
 *     before the cap existed is a promise that was already made.
 */

const checkThrows = (label, run, pattern) => {
  let message = '';
  try {
    run();
  } catch (error) {
    message = error.message;
  }
  check(label, Boolean(message) && pattern.test(message), message || 'nothing was thrown');
};

// The prompt pack's worked examples are the fixtures. Copying them in here
// would let the document and the code drift apart, which is the failure the
// cap itself is guarding against.
const examplePayloads = [
  ...readFileSync(new URL('../docs/prompt-pack/91_artifact_payload_examples.md', import.meta.url), 'utf8')
    .matchAll(/```json\n([\s\S]*?)\n```/g)
].map(([, body]) => JSON.parse(body));

const exampleGenerated = (predicate) => examplePayloads.map((payload) => payload.generated).find(predicate);

/* ----------------------------------------- PBS: three alternatives, no more */

const pbsExample = exampleGenerated((generated) => generated.outputsBucketed?.scenarios);
check('the documented PBS example carries the full three alternatives',
  pbsExample.outputsBucketed.scenarios.length === MAX_PBS_SCENARIO_ALTERNATIVES);

const validatedPbs = validateOutputsBucketedPayload(pbsExample.outputsBucketed);
check('a three-alternative PBS payload applies cleanly',
  validatedPbs.scenarios.length === MAX_PBS_SCENARIO_ALTERNATIVES,
  JSON.stringify(validatedPbs.scenarios?.map((scenario) => scenario.id)));

const pbsAlternatives = pbsExample.outputsBucketed.scenarios;
// The message counts alternatives, not cases, so the number in it matches what
// the payload actually contains.
checkThrows('a fourth PBS alternative is rejected by count',
  () => validateOutputsBucketedScenariosPayload(
    [...pbsAlternatives, { ...pbsAlternatives[0], id: 'one-too-many' }],
    'generated.outputsBucketed.scenarios'
  ),
  /generated\.outputsBucketed\.scenarios supports at most 3 alternatives; received 4\./);

checkThrows('two PBS alternatives sharing an id are rejected',
  () => validateOutputsBucketedScenariosPayload(
    [pbsAlternatives[0], { ...pbsAlternatives[1], id: pbsAlternatives[0].id }],
    'generated.outputsBucketed.scenarios'
  ),
  /\.id must be unique\./);

/* --------------------------------------- the engines: four cases, no more */

const casesOf = (count, build) => Array.from({ length: count }, (_, index) => build(index));

const pensionExample = exampleGenerated((generated) => generated.pensionInputs?.rentalIncomeScenarios);
const rentalCases = (count) => casesOf(count, (index) => ({
  id: `rental-case-${index + 1}`, title: `Rental case ${index + 1}`, rentalIncomeToday: 18_000 - (index * 1_000)
}));
check('four rental income cases normalise',
  normalizePensionInputs({ ...pensionExample.pensionInputs, baseScenarioId: 'rental-case-1', rentalIncomeScenarios: rentalCases(MAX_MODULE_SCENARIO_CASES) })
    .rentalIncomeScenarios.length === MAX_MODULE_SCENARIO_CASES);
checkThrows('a fifth rental income case is rejected',
  () => normalizePensionInputs({ ...pensionExample.pensionInputs, baseScenarioId: 'rental-case-1', rentalIncomeScenarios: rentalCases(5) }),
  /generated\.pensionInputs\.rentalIncomeScenarios supports at most 4 cases; received 5\./);

// Retirement cases change more than rent -- an age, a contribution, a pot --
// so the cap, the case names and the round trip all have to hold for them too.
const RETIREMENT_CASE_INPUTS = {
  currentAge: 50,
  retirementAge: 62,
  currentSalary: 90_000,
  currentPot: 400_000,
  personalPct: 0.05,
  employerPct: 0.06,
  growthRate: 0.05,
  inflationRate: 0.02,
  wageGrowthRate: 0.02,
  horizonEndAge: 92,
  currentYear: 2026,
  incomeMode: 'target',
  targetIncomeToday: 45_000,
  baseScenarioId: 'retirement-case-1'
};
const retirementCases = (count) => casesOf(count, (index) => ({
  id: `retirement-case-${index + 1}`, title: `Retirement case ${index + 1}`, retirementAge: 60 + index
}));
check('four retirement cases normalise',
  normalizePensionInputs({ ...RETIREMENT_CASE_INPUTS, scenarios: retirementCases(MAX_MODULE_SCENARIO_CASES) })
    .scenarios.length === MAX_MODULE_SCENARIO_CASES);
checkThrows('a fifth retirement case is rejected',
  () => normalizePensionInputs({ ...RETIREMENT_CASE_INPUTS, scenarios: retirementCases(5) }),
  /generated\.pensionInputs\.scenarios supports at most 4 cases; received 5\./);
checkThrows('a retirement payload cannot carry both case lists',
  () => normalizePensionInputs({
    ...RETIREMENT_CASE_INPUTS,
    scenarios: retirementCases(2),
    rentalIncomeScenarios: rentalCases(2)
  }),
  /must use scenarios or rentalIncomeScenarios, not both\./);

// THE SAME SILENT FAILURE THE MORTGAGE CASES HAVE. The engine nests a case's
// changes under `overrides`, and a session importer that does not carry those
// keys drops them on load: four buttons, four identical retirement ages.
{
  const stored = normalizePensionInputs({
    ...RETIREMENT_CASE_INPUTS,
    scenarios: retirementCases(MAX_MODULE_SCENARIO_CASES)
  });
  const requiredPots = (inputs) => stored.scenarios
    .map((scenario) => Math.round(computePensionProjection(inputs, { scenarioId: scenario.id }).debug.requiredPot));
  const before = requiredPots(stored);
  check('the retirement cases need different pots to begin with', new Set(before).size > 1);

  const reopened = importPublishedSession({
    ...session,
    modules: [{ ...session.modules[0], id: 'module-retirement-cases', generated: { pensionInputs: stored } }]
  });
  drainSessionImportWarnings();
  const reloaded = reopened.modules[0].generated.pensionInputs;
  check('a reopened session still carries every retirement case',
    reloaded.scenarios.length === MAX_MODULE_SCENARIO_CASES);
  check('and the case that each one is measured against',
    reloaded.baseScenarioId === 'retirement-case-1');
  check('and each case still needs the pot it did before publishing',
    JSON.stringify(requiredPots(reloaded)) === JSON.stringify(before));
}

// Over the cap on the way back out is tolerated, not thrown.
{
  const overCap = {
    ...normalizePensionInputs({ ...RETIREMENT_CASE_INPUTS, scenarios: retirementCases(MAX_MODULE_SCENARIO_CASES) })
  };
  overCap.scenarios = [...overCap.scenarios, { id: 'retirement-case-5', title: 'Fifth', description: '', overrides: {} }];
  const reopened = importPublishedSession({
    ...session,
    modules: [{ ...session.modules[0], id: 'module-retirement-over-cap', generated: { pensionInputs: overCap } }]
  });
  const warnings = drainSessionImportWarnings();
  check('an over-cap retirement session opens, capped rather than refused',
    reopened.modules[0].generated.pensionInputs.scenarios.length === MAX_MODULE_SCENARIO_CASES);
  check('and says so',
    warnings.some((warning) => /pensionInputs\.scenarios carried 5 cases/.test(warning)));
}

const netRetirementExample = exampleGenerated((generated) => generated.netRetirementInputs?.scenarios);
const netCases = (count) => casesOf(count, (index) => ({
  id: `net-case-${index + 1}`, title: `Net case ${index + 1}`, availableInvestmentFundToday: 1_027_000 + (index * 50_000)
}));
check('four net retirement cases normalise',
  normalizeNetRetirementInputs({ ...netRetirementExample.netRetirementInputs, baseScenarioId: 'net-case-1', scenarios: netCases(MAX_MODULE_SCENARIO_CASES) })
    .scenarios.length === MAX_MODULE_SCENARIO_CASES);
checkThrows('a fifth net retirement case is rejected',
  () => normalizeNetRetirementInputs({ ...netRetirementExample.netRetirementInputs, baseScenarioId: 'net-case-1', scenarios: netCases(5) }),
  /generated\.netRetirementInputs\.scenarios supports at most 4 cases; received 5\./);

const collegeExample = exampleGenerated((generated) => generated.collegeFundingInputs);
const { collegeFundingInputs: collegeShorthand } = collegeExample;
const collegeWithoutShorthand = { ...collegeShorthand };
delete collegeWithoutShorthand.atHomeAnnualCostTodayPerChild;
delete collegeWithoutShorthand.awayAnnualCostTodayPerChild;
delete collegeWithoutShorthand.carSupportTodayPerChild;
const collegeCases = (count) => casesOf(count, (index) => ({
  id: `college-case-${index + 1}`, title: `College case ${index + 1}`, annualCostTodayPerChild: 5_000 + (index * 2_500)
}));

// The shorthand is exactly at the cap on its own: at home and away, each with
// and without car support.
check('the at-home / away shorthand expands to the four standard scenarios',
  normalizeCollegeFundingInputs(collegeShorthand).scenarios.length === MAX_MODULE_SCENARIO_CASES);
check('four explicit college cases normalise',
  normalizeCollegeFundingInputs({ ...collegeWithoutShorthand, scenarios: collegeCases(MAX_MODULE_SCENARIO_CASES) })
    .scenarios.length === MAX_MODULE_SCENARIO_CASES);
checkThrows('a fifth college case is rejected',
  () => normalizeCollegeFundingInputs({ ...collegeWithoutShorthand, scenarios: collegeCases(5) }),
  /generated\.collegeFundingInputs\.scenarios supports at most 4 cases; received 5\./);
// Sent together they are eight cases dressed as two fields, and the payload
// does not say which set was meant.
checkThrows('the shorthand and an explicit scenarios array cannot be sent together',
  () => normalizeCollegeFundingInputs({ ...collegeShorthand, scenarios: collegeCases(2) }),
  /must not combine the at-home\/away cost shorthand with an explicit scenarios array/);

const MORTGAGE_LOAN = {
  currentBalance: 320_000,
  annualInterestRate: 0.0425,
  startDateIso: '2026-01-01',
  endDateIso: '2052-12-01',
  repaymentType: 'repayment',
  loanKind: 'mortgage',
  baseScenarioId: 'mortgage-case-1'
};
const mortgageCases = (count) => casesOf(count, (index) => ({
  id: `mortgage-case-${index + 1}`, title: `Mortgage case ${index + 1}`, annualOverpayment: index * 1_000
}));
check('four mortgage cases normalise',
  normalizeMortgageInputs({ ...MORTGAGE_LOAN, scenarios: mortgageCases(MAX_MODULE_SCENARIO_CASES) })
    .scenarios.length === MAX_MODULE_SCENARIO_CASES);
checkThrows('a fifth mortgage case is rejected',
  () => normalizeMortgageInputs({ ...MORTGAGE_LOAN, scenarios: mortgageCases(5) }),
  /generated\.mortgageInputs\.scenarios supports at most 4 cases; received 5\./);

// THE ONE FAILURE MODE HERE THAT IS SILENT.
//
// The engine returns a case's changes nested under `overrides`, and the app
// stores what the engine returned. If the session importer's own whitelist
// does not carry those keys they are dropped on load with no error anywhere --
// the buttons still appear, and every one of them shows the same answer.
{
  const stored = normalizeMortgageInputs({ ...MORTGAGE_LOAN, scenarios: mortgageCases(MAX_MODULE_SCENARIO_CASES) });
  const savings = (inputs) => computeMortgageComparison(inputs).cases.map((item) => Math.round(item.interestSaved));
  const before = savings(stored);
  check('the mortgage cases save different amounts to begin with', new Set(before).size > 1);

  const reopened = importPublishedSession({
    ...session,
    modules: [{ ...session.modules[0], id: 'module-mortgage-cases', generated: { mortgageInputs: stored } }]
  });
  drainSessionImportWarnings();
  const reloaded = reopened.modules[0].generated.mortgageInputs;
  check('a reopened session still carries every mortgage case',
    reloaded.scenarios.length === MAX_MODULE_SCENARIO_CASES);
  check('and the case that each one is measured against',
    reloaded.baseScenarioId === 'mortgage-case-1');
  check('and each case still describes the same saving it did before publishing',
    JSON.stringify(savings(reloaded)) === JSON.stringify(before));
}

// Over the cap on the way back out is tolerated, not thrown: a session that was
// published when the rules were looser still has to open.
{
  const overCap = {
    ...normalizeMortgageInputs({ ...MORTGAGE_LOAN, scenarios: mortgageCases(MAX_MODULE_SCENARIO_CASES) })
  };
  overCap.scenarios = [...overCap.scenarios, { id: 'mortgage-case-5', title: 'Fifth', description: '', overrides: {} }];
  const reopened = importPublishedSession({
    ...session,
    modules: [{ ...session.modules[0], id: 'module-mortgage-over-cap', generated: { mortgageInputs: overCap } }]
  });
  const warnings = drainSessionImportWarnings();
  check('an over-cap mortgage session opens, capped rather than refused',
    reopened.modules[0].generated.mortgageInputs.scenarios.length === MAX_MODULE_SCENARIO_CASES);
  check('and says so',
    warnings.some((warning) => /mortgageInputs\.scenarios carried 5 cases/.test(warning)));
}

/* ------------------------------- the importer: tolerate, do not throw */

const publishedPbsModule = session.modules[0];
const overCapPbsSession = {
  ...session,
  modules: [{
    ...publishedPbsModule,
    generated: {
      ...publishedPbsModule.generated,
      outputsBucketed: {
        ...publishedPbsModule.generated.outputsBucketed,
        scenarios: casesOf(5, (index) => ({
          id: `published-alternative-${index + 1}`,
          title: `Published alternative ${index + 1}`,
          sections: publishedPbsModule.generated.outputsBucketed.sections
        }))
      }
    }
  }]
};

drainSessionImportWarnings();
const importedOverCap = importPublishedSession(overCapPbsSession);
const importedPbsWarnings = drainSessionImportWarnings();
check('a published session carrying five PBS alternatives still imports',
  importedOverCap.modules.length === 1);
check('the extra PBS alternatives are dropped rather than rejected',
  importedOverCap.modules[0].generated.outputsBucketed.scenarios.length === MAX_PBS_SCENARIO_ALTERNATIVES,
  String(importedOverCap.modules[0].generated.outputsBucketed.scenarios.length));
check('the ones kept are the first three, in order',
  importedOverCap.modules[0].generated.outputsBucketed.scenarios.map((scenario) => scenario.id).join()
    === 'published-alternative-1,published-alternative-2,published-alternative-3');
check('dropping them is reported rather than silent',
  importedPbsWarnings.length === 1 && /outputsBucketed\.scenarios carried 5 alternatives; kept the first 3/.test(importedPbsWarnings[0]),
  JSON.stringify(importedPbsWarnings));

const collegeModuleId = 'module-college-over-cap';
const overCapCollegeSession = {
  version: 1,
  sessionId: 'session-cap-college',
  clientName: 'Cap Client',
  modules: [{
    id: collegeModuleId,
    title: 'College Funding',
    generated: {
      summaryHtml: '<p>Published before the cap existed.</p>',
      collegeFundingInputs: { ...collegeWithoutShorthand, scenarios: collegeCases(5) }
    }
  }],
  order: [collegeModuleId],
  activeModuleId: collegeModuleId
};

drainSessionImportWarnings();
const importedCollege = importPublishedSession(overCapCollegeSession);
const importedCollegeWarnings = drainSessionImportWarnings();
check('a published session carrying five college cases imports with four',
  importedCollege.modules[0].generated.collegeFundingInputs.scenarios.length === MAX_MODULE_SCENARIO_CASES,
  String(importedCollege.modules[0].generated.collegeFundingInputs.scenarios.length));
check('the dropped college cases are reported',
  importedCollegeWarnings.length === 1 && /collegeFundingInputs\.scenarios carried 5 cases; kept the first 4/.test(importedCollegeWarnings[0]),
  JSON.stringify(importedCollegeWarnings));

// A payload inside the cap must leave the channel silent, or a warning means
// nothing.
drainSessionImportWarnings();
importPublishedSession(session);
check('an in-cap session imports with no warnings', drainSessionImportWarnings().length === 0);

console.info(`[SessionPayload] ${checks} checks passed: a finished call converts into a payload the `
  + 'app accepts, with the required sections, reconciling totals and bar charts only, and the '
  + '4-case cap is rejected on the way in and tolerated on the way back out.');
