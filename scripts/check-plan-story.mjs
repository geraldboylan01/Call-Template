// Plan story: the model's rules and the link hand-off, run where CI can see them.
//
// The story is told by an analyst and drawn by a screen, and this is the line
// between them: narration types no figures, a link can only open the module and
// case its figure came from, and "See it in" can only name what a section
// linked. The view is checked in a browser; this checks everything that does
// not need one.

import { runPlanStoryModelTests } from '../js/tests_plan_story_model.js';
import { runPlanStoryLinksTests } from '../js/tests_plan_story_links.js';
import { runPlanStorySessionTests } from '../js/tests_plan_story_session.js';

let failures = 0;

async function check(name, fn) {
  try {
    const passed = await fn();
    for (const label of passed || [name]) console.info(`[PlanStoryAudit] PASS: ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`[PlanStoryAudit] FAIL: ${name}\n    ${error.message}`);
  }
}

await check('model rules', runPlanStoryModelTests);
await check('link hand-off', runPlanStoryLinksTests);
await check('story on a session', runPlanStorySessionTests);

if (failures) {
  console.error(`[PlanStoryAudit] ${failures} check(s) failed.`);
  process.exit(1);
}
console.info('[PlanStoryAudit] All checks passed.');
