#!/usr/bin/env node

/**
 * The pension math suite, run where CI can see it.
 *
 * `runPensionMathTests()` was reachable only from the browser Dev Panel, which
 * means the one suite that proves a case equals the standalone payload it
 * describes could go red without anything noticing. This runs it in Node and
 * exits non-zero on the first failure.
 */

import { runPensionMathTests } from '../js/tests_pension_math.js';

const summary = runPensionMathTests();

if (summary.failed > 0) {
  console.error(`[PensionTests] ${summary.failed} of ${summary.total} cases failed.`);
  summary.results
    .filter((entry) => !entry.pass)
    .forEach((entry) => console.error(`  - ${entry.name}: ${entry.error}`));
  process.exit(1);
}

console.info(`[PensionTests] ${summary.passed}/${summary.total} pension math cases passed.`);
