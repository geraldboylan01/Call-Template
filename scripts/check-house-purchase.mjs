import { runHousePurchaseMathTests } from '../js/tests_house_purchase_math.js';

const summary = runHousePurchaseMathTests();
if (summary.failed > 0) {
  console.error(`House Purchase checks failed: ${summary.failed}/${summary.total}`);
  process.exitCode = 1;
} else {
  console.log(`House Purchase checks passed: ${summary.passed}/${summary.total}`);
}

