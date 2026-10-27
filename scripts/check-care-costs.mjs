// Care costs: the Fair Deal rules, the State Pension rate they are measured
// against, and the register entries for both, proved against figures typed from
// the Act and the pages. The care builder and its independent reference
// calculator are added to this check as they land.

import { runCareCostsTests } from '../js/tests_care_costs_math.js';

let failures = 0;

const summary = runCareCostsTests();
if (summary.failed > 0) {
  failures += summary.failed;
}

if (failures > 0) {
  console.error(`[CareCostsAudit] ${failures} check(s) failed.`);
  process.exit(1);
}

console.info('[CareCostsAudit] the Fair Deal rules and their register entries pass.');
