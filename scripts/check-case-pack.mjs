#!/usr/bin/env node

/**
 * A CASE PACK, CHECKED BEFORE ANYONE OPENS A BROWSER.
 *
 * A call is six to ten modules written outside the app, and the only way to
 * find out whether one worked used to be to paste it and look. This runs the
 * EXACT code the Dev Panel runs -- `js/module_pipeline.js`, the auto repairs,
 * the payload contract and every engine -- so a pack that passes here cannot
 * fail in the browser. There is no second implementation of the rules for this
 * to drift away from, which is the whole reason the pipeline came out of
 * `app.js`.
 *
 * Usage:
 *   node scripts/check-case-pack.mjs <pack.json> [--summary] [--strict] [--json]
 *   node scripts/check-case-pack.mjs --payload <module.json> [--summary] [--strict] [--json]
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { computeCollegeFundingProjection } from '../js/college_funding_math.js';
import { computeMortgageComparison } from '../js/mortgage_math.js';
import {
  computeNetRetirementProjection,
  getNetRetirementScenarioCases
} from '../js/net_retirement_math.js';
import {
  computePensionProjection,
  getPensionScenarioCases
} from '../js/pension_math.js';
import {
  casePackModuleLabel,
  checkCasePack,
  checkModulePayload,
  getOutputsBucketedSubtotal,
  getPbsBalanceMetrics,
  isOutputsBucketedSummarySection,
  PBS_ASSET_SECTION_KEYS,
  resolveLiquidityReserveForPlan
} from '../js/module_pipeline.js';

/* ------------------------------------------------------------- arguments */

function parseArgs(argv) {
  const options = { file: '', payloadMode: false, summary: false, strict: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--summary') options.summary = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--payload') options.payloadMode = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else if (!options.file) options.file = arg;
    else throw new Error('Only one file can be checked at a time.');
  }
  if (!options.file) {
    throw new Error('Usage: node scripts/check-case-pack.mjs <pack.json> [--payload] [--summary] [--strict] [--json]');
  }
  return options;
}

/* --------------------------------------------------------------- figures */

const EURO = new Intl.NumberFormat('en-IE', {
  style: 'currency', currency: 'EUR', maximumFractionDigits: 0
});
const eur = (value) => (Number.isFinite(value) ? EURO.format(value) : 'n/a');
const months = (value) => (Number.isFinite(value) ? `${value.toFixed(1)} months` : 'n/a');
const ROUNDING_TOLERANCE = 1;

/**
 * A balance sheet that does not add up is the one failure a reader cannot
 * catch by eye, so every case is re-added here from its own rows.
 */
function reconcilePbsCase(sections) {
  const problems = [];
  sections.forEach((section) => {
    // The summary section's rows are gross assets, liabilities and net worth.
    // They are not parts of a total and adding them up means nothing; the Dev
    // Panel fills its missing subtotal with a zero for exactly that reason.
    if (section.subtotalValue === null || isOutputsBucketedSummarySection(section)) return;
    const rowTotal = section.rows.reduce((total, [, amount]) => total + amount, 0);
    if (Math.abs(rowTotal - section.subtotalValue) > ROUNDING_TOLERANCE) {
      problems.push(`${section.title} subtotal ${eur(section.subtotalValue)} but its rows add to ${eur(rowTotal)}`);
    }
  });

  const metrics = getPbsBalanceMetrics({ sections });
  const assetSubtotals = PBS_ASSET_SECTION_KEYS
    .map((key) => sections.find((section) => section.key === key))
    .filter(Boolean)
    .reduce((total, section) => total + getOutputsBucketedSubtotal(section), 0);

  if (Number.isFinite(metrics.grossAssets) && Math.abs(metrics.grossAssets - assetSubtotals) > ROUNDING_TOLERANCE) {
    problems.push(`gross assets ${eur(metrics.grossAssets)} but the asset sections add to ${eur(assetSubtotals)}`);
  }

  if (Number.isFinite(metrics.netAssets) && Number.isFinite(metrics.grossAssets)
    && Number.isFinite(metrics.grossLiabilities)) {
    const expected = metrics.grossAssets - metrics.grossLiabilities;
    if (Math.abs(metrics.netAssets - expected) > ROUNDING_TOLERANCE) {
      problems.push(`net worth ${eur(metrics.netAssets)} but gross assets less liabilities is ${eur(expected)}`);
    }
  }

  return { metrics, problems };
}

function summarizePbs(generated) {
  const bucketed = generated.outputsBucketed;
  const cases = [
    { id: 'current', title: 'Current position', sections: bucketed.sections },
    ...(bucketed.scenarios || []).map((scenario) => ({
      id: scenario.id, title: scenario.title, sections: scenario.sections
    }))
  ];

  return {
    kind: 'balance-sheet',
    cases: cases.map((entry) => {
      const { metrics, problems } = reconcilePbsCase(entry.sections);
      return {
        id: entry.id,
        title: entry.title,
        figures: {
          grossAssets: metrics.grossAssets,
          totalLiabilities: metrics.grossLiabilities,
          netWorth: metrics.netAssets
        },
        text: `gross assets ${eur(metrics.grossAssets)}, liabilities ${eur(metrics.grossLiabilities)}, net worth ${eur(metrics.netAssets)}`,
        problems
      };
    })
  };
}

function summarizeLiquidity(generated) {
  const { reserve, targetBufferMonths } = resolveLiquidityReserveForPlan(generated.liquidityPlan);
  const standing = reserve.shortfallCash > 0
    ? `shortfall ${eur(reserve.shortfallCash)}`
    : `surplus ${eur(reserve.surplusCash)}`;
  return {
    kind: 'liquidity',
    cases: [{
      id: 'current',
      title: 'Current position',
      figures: {
        monthsCovered: reserve.monthsCovered,
        targetBufferMonths,
        surplusCash: reserve.surplusCash,
        shortfallCash: reserve.shortfallCash
      },
      text: `${months(reserve.monthsCovered)} of cover against a ${targetBufferMonths}-month target, ${standing}`,
      problems: []
    }]
  };
}

function summarizeRetirement(generated) {
  const inputs = generated.pensionInputs;
  return {
    kind: 'retirement',
    cases: getPensionScenarioCases(inputs).map((entry) => {
      const { debug } = computePensionProjection(inputs, { scenarioId: entry.id });
      return {
        id: entry.id,
        title: entry.title,
        figures: {
          requiredPot: debug.requiredPot,
          projectedPotAtRetirement: debug.projectedPotCurrent,
          retirementYear: debug.retirementYear
        },
        text: `required pot ${eur(debug.requiredPot)}, projected ${eur(debug.projectedPotCurrent)} at retirement in ${debug.retirementYear}`,
        problems: []
      };
    })
  };
}

function summarizeLoan(generated, loanKind) {
  const inputs = loanKind === 'loan' ? generated.loanInputs : generated.mortgageInputs;
  const comparison = computeMortgageComparison(inputs, { defaultLoanKind: loanKind });
  return {
    kind: loanKind,
    cases: comparison.cases.map((entry) => ({
      id: entry.id,
      title: entry.title,
      figures: {
        interestSaved: entry.interestSaved,
        payoffDateIso: entry.payoffDateIso,
        totalInterestLifetime: entry.totalInterestLifetime
      },
      text: entry.isBase
        ? `paid off ${entry.payoffDateIso || 'never'}, ${eur(entry.totalInterestLifetime)} interest`
        : `paid off ${entry.payoffDateIso || 'never'}, saves ${eur(entry.interestSaved)}`,
      problems: []
    }))
  };
}

function summarizeNetRetirement(generated) {
  const inputs = generated.netRetirementInputs;
  return {
    kind: 'net-retirement',
    cases: getNetRetirementScenarioCases(inputs).map((entry) => {
      const { debug } = computeNetRetirementProjection(inputs, { scenarioId: entry.id });
      const scenario = debug.scenario || {};
      return {
        id: entry.id,
        title: entry.title,
        figures: {
          requiredFundToday: debug.requiredFundToday,
          availableFundToday: scenario.availableInvestmentFundToday ?? null
        },
        text: `required net fund ${eur(debug.requiredFundToday)}, available ${eur(scenario.availableInvestmentFundToday)}`,
        problems: []
      };
    })
  };
}

function summarizeCollegeFunding(generated) {
  const { debug } = computeCollegeFundingProjection(generated.collegeFundingInputs);
  return {
    kind: 'college-funding',
    cases: [{
      id: 'range',
      title: 'Funding range',
      figures: { low: debug.todayRange.low, high: debug.todayRange.high },
      text: `${eur(debug.todayRange.low)} to ${eur(debug.todayRange.high)} in today's money`,
      problems: []
    }]
  };
}

function summarizeBlocks(kind, generated) {
  const blocks = kind === 'report'
    ? (generated.report?.blocks || [])
    : (generated.education?.blocks || generated.education?.visuals || []);
  const visuals = kind === 'report'
    ? blocks.filter((block) => block?.type === 'chart' || block?.type === 'visual').length
    : (generated.education?.visuals || []).length;
  return {
    kind,
    cases: [{
      id: 'content',
      title: kind === 'report' ? 'Report' : 'Education',
      figures: { blocks: blocks.length, visuals },
      text: `${blocks.length} block${blocks.length === 1 ? '' : 's'}, ${visuals} visual${visuals === 1 ? '' : 's'}`,
      problems: []
    }]
  };
}

/** What a module is, decided the way the renderer decides it: by what it carries. */
function summarizeModule(module) {
  const generated = module.generated || {};
  if (generated.outputsBucketed) return summarizePbs(generated);
  if (generated.liquidityPlan) return summarizeLiquidity(generated);
  if (generated.pensionInputs) return summarizeRetirement(generated);
  if (generated.loanInputs) return summarizeLoan(generated, 'loan');
  if (generated.mortgageInputs) return summarizeLoan(generated, 'mortgage');
  if (generated.netRetirementInputs) return summarizeNetRetirement(generated);
  if (generated.collegeFundingInputs) return summarizeCollegeFunding(generated);
  if (generated.report) return summarizeBlocks('report', generated);
  if (generated.education) return summarizeBlocks('education', generated);
  return { kind: 'module', cases: [] };
}

/* ----------------------------------------------------------------- output */

function buildReport(options) {
  const raw = readFileSync(options.file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, file: basename(options.file), errors: [`Not valid JSON: ${error.message}`], modules: [] };
  }

  const result = options.payloadMode
    ? { ok: false, clientName: '', errors: [], modules: [checkModulePayload(parsed, { number: 1, total: 1 })] }
    : checkCasePack(parsed);
  if (options.payloadMode) {
    result.ok = result.modules[0].ok;
  }

  const modules = result.modules.map((row) => {
    const entry = {
      number: row.number,
      total: row.total,
      title: row.title,
      ok: row.ok,
      warnings: row.warnings,
      error: row.error
    };

    if (row.ok && options.summary) {
      try {
        const summary = summarizeModule(row.module);
        entry.kind = summary.kind;
        entry.cases = summary.cases;
        entry.reconciliation = summary.cases.flatMap((item) => item.problems.map((problem) => (
          `${item.title}: ${problem}`
        )));
      } catch (error) {
        entry.ok = false;
        entry.error = `summary failed: ${error.message}`;
      }
    }

    return entry;
  });

  const reconciliationProblems = modules.flatMap((entry) => entry.reconciliation || []);
  return {
    ok: result.errors.length === 0
      && modules.every((entry) => entry.ok)
      && (!options.strict || reconciliationProblems.length === 0),
    file: basename(options.file),
    clientName: result.clientName || '',
    errors: result.errors,
    modules,
    reconciliationProblems
  };
}

function printText(report, options) {
  const header = options.payloadMode
    ? `${report.file}: one module payload`
    : `${report.file}: case pack for ${report.clientName || '(no client name)'}, ${report.modules.length} module${report.modules.length === 1 ? '' : 's'}`;
  console.log(header);

  report.errors.forEach((error) => console.log(`  ERROR  ${error}`));

  report.modules.forEach((entry) => {
    const label = casePackModuleLabel(entry.number, entry.total, entry.title);
    if (!entry.ok) {
      console.log(`  FAIL   ${label}: ${entry.error}`);
      return;
    }
    console.log(`  OK     ${label}${entry.kind ? ` [${entry.kind}]` : ''}`);
    entry.warnings.forEach((warning) => console.log(`           repaired: ${warning}`));
    (entry.cases || []).forEach((item) => {
      console.log(`           ${item.title}: ${item.text}`);
      item.problems.forEach((problem) => console.log(`           ${options.strict ? 'FAIL' : 'WARN'}: ${problem}`));
    });
  });

  console.log(report.ok
    ? `\n${report.file}: everything checks out.`
    : `\n${report.file}: not ready.`);
}

/* ------------------------------------------------------------------- main */

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

// The engines narrate what they compute, which is useful in a browser console
// and noise in a report. Quietened only while the modules are being built.
const realInfo = console.info;
console.info = () => {};
let report;
try {
  report = buildReport(options);
} finally {
  console.info = realInfo;
}

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printText(report, options);
}

process.exit(report.ok ? 0 : 1);
