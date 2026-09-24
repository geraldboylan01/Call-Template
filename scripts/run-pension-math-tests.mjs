#!/usr/bin/env node

/**
 * The pension math and Irish tax suites, run where CI can see it.
 *
 * `runPensionMathTests()` was reachable only from the browser Dev Panel, which
 * means the one suite that proves a case equals the standalone payload it
 * describes could go red without anything noticing. This runs it in Node and
 * exits non-zero on the first failure.
 *
 * The Irish tax engine's golden cases run here too, with two checks only Node
 * can make: that `scripts/ie-tax.mjs` returns the same numbers as the engine
 * for every golden case, and that a 60-year projection with a solver in every
 * year stays inside the brief's 300 ms.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { runPensionMathTests } from '../js/tests_pension_math.js';
import {
  IE_TAX_GOLDEN_CASES,
  benchmarkSixtyYearProjection,
  runGoldenCaseInEngine,
  runIeTaxTests
} from '../js/tests_ie_tax.js';
import { computePensionProjection } from '../js/pension_math.js';

const CLI = fileURLToPath(new URL('./ie-tax.mjs', import.meta.url));
const PERFORMANCE_BUDGET_MS = 300;

function reportFailures(label, summary) {
  if (summary.failed === 0) {
    return false;
  }
  console.error(`[${label}] ${summary.failed} of ${summary.total} cases failed.`);
  summary.results
    .filter((entry) => !entry.pass)
    .forEach((entry) => console.error(`  - ${entry.name}: ${entry.error}`));
  return true;
}

/** The figures a golden case is judged on, from the engine or from the CLI's JSON. */
function comparableFigures(command, output) {
  if (command === 'year') {
    return { totals: output.result.totals, crystallisations: output.result.crystallisations, nextState: output.nextState };
  }
  if (command === 'marginal') {
    return { byHead: output.byHead, total: output.total, netIncomeChange: output.netIncomeChange };
  }
  return { amount: output.amount, netIncome: output.netIncome, met: output.met, totals: output.result.totals };
}

function checkCliParity() {
  const failures = [];
  IE_TAX_GOLDEN_CASES.forEach((goldenCase) => {
    const run = spawnSync(process.execPath, [CLI, goldenCase.command], {
      input: JSON.stringify(goldenCase.request),
      encoding: 'utf8'
    });
    if (run.status !== 0) {
      failures.push(`${goldenCase.id}: the CLI exited ${run.status}: ${run.stderr.trim()}`);
      return;
    }
    const fromCli = JSON.stringify(comparableFigures(goldenCase.command, JSON.parse(run.stdout)));
    const fromEngine = JSON.stringify(comparableFigures(goldenCase.command, JSON.parse(JSON.stringify(runGoldenCaseInEngine(goldenCase)))));
    if (fromCli !== fromEngine) {
      failures.push(`${goldenCase.id}: the CLI and the engine disagree`);
    }
  });

  const refused = spawnSync(process.execPath, [CLI, 'year'], {
    input: JSON.stringify({ year: 2026, status: 'single', people: [{ id: 'a', age: 60 }], items: [{ personId: 'a', type: 'dividend', amount: 1 }] }),
    encoding: 'utf8'
  });
  if (refused.status === 0 || !/not supported yet/.test(refused.stderr)) {
    failures.push('a Part B type should make the CLI exit non-zero with the validation message');
  }

  if (failures.length > 0) {
    console.error(`[IeTaxCli] ${failures.length} parity checks failed.`);
    failures.forEach((failure) => console.error(`  - ${failure}`));
    return false;
  }
  console.info(`[IeTaxCli] The CLI matches the engine on all ${IE_TAX_GOLDEN_CASES.length} golden cases.`);
  return true;
}

function time(label, fn, runs = 5) {
  fn();
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const median = samples[Math.floor(samples.length / 2)];
  console.info(`[IeTaxTiming] ${label}: median ${median.toFixed(1)} ms over ${runs} runs`);
  return median;
}

function checkPerformance() {
  const sixtyYears = time(
    '60-year household projection, solver every year',
    () => benchmarkSixtyYearProjection(() => performance.now())
  );
  const couple = {
    currentYear: 2026,
    incomeMode: 'target',
    targetIncomeToday: 70_000,
    householdTaxStatus: 'married_or_civil_partners',
    rentalIncomeToday: 12_000,
    pensions: [
      { id: 'a', title: 'Aoife', currentAge: 45, retirementAge: 63, currentSalary: 95_000, currentPot: 300_000, personalPct: 0.1, employerPct: 0.06, lumpSum: { mode: 'max' } },
      { id: 'b', title: 'Brian', currentAge: 47, retirementAge: 65, currentSalary: 70_000, currentPot: 220_000, personalPct: 0.08, employerPct: 0.05 }
    ]
  };
  time('Retirement module, couple, gross target (taxes reported)', () => computePensionProjection(couple));
  time('Retirement module, couple, net target (solver every year, required-pot search)', () => computePensionProjection({ ...couple, targetIncomeBasis: 'net' }), 3);
  time('Retirement module, couple, net affordable income', () => computePensionProjection({ ...couple, targetIncomeBasis: 'net', incomeMode: 'affordable', affordableEndAges: [95] }), 3);

  if (sixtyYears > PERFORMANCE_BUDGET_MS) {
    console.error(`[IeTaxTiming] The 60-year projection took ${sixtyYears.toFixed(1)} ms, over the ${PERFORMANCE_BUDGET_MS} ms budget.`);
    return false;
  }
  return true;
}

const pensionSummary = runPensionMathTests();
const taxSummary = runIeTaxTests();
const pensionFailed = reportFailures('PensionTests', pensionSummary);
const taxFailed = reportFailures('IeTaxTests', taxSummary);
const cliOk = checkCliParity();
const performanceOk = checkPerformance();

if (pensionFailed || taxFailed || !cliOk || !performanceOk) {
  process.exit(1);
}

console.info(`[PensionTests] ${pensionSummary.passed}/${pensionSummary.total} pension math cases passed.`);
console.info(`[IeTaxTests] ${taxSummary.passed}/${taxSummary.total} Irish tax cases passed.`);
