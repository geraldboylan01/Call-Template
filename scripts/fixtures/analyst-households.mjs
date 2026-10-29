// Explicitly invented review supplements to #97, shared by the CLI and tests.
import { createCaseFile } from '../../js/planning/analyst/case_file.js';
import { compilerBudget } from '../../js/planning/analyst/budget.js';
import { compiledFacts } from '../../js/planning/analyst/facts.js';
import { compilePlanPack } from '../../js/planning/plan_pack/compiler.js';
import { profileToPlanPack } from '../../js/planning/profile_to_plan_pack.js';
import { sha256Json } from '../../js/planning/utils.js';
import { reviewedRouteExample } from './form-to-plan-reviewed.mjs';
import { majorHouseholds } from './major-levers.households.mjs';

export const REVIEWED_FIXTURES = [
  { name: 'fictional-reviewed-couple', description: 'Invented couple with explicit supplemental goal, spending and funding facts.', reachesRoutes: true },
  { name: 'fictional-trade-down', description: 'Invented couple whose dated cost needs a major home move.', reachesRoutes: true },
  { name: 'fictional-rental-sale', description: 'Invented couple with supplemental property tax and rental facts.', reachesRoutes: true }
];

export async function buildReviewedAnalystCase(profile, input) {
  const c = await createCaseFile(input);
  const meter = compilerBudget(c);
  const assembly = await profileToPlanPack(profile, { confirmedRevision: c.pinned.confirmedRevision,
    calculationDate: c.pinned.calculationDate, clientLabel: c.pinned.planPack.clientName, beforeCompile: meter.beforeCompile });
  const compiled = await compilePlanPack(assembly.planPack, { ...assembly.compileOptions, beforeCompile: meter.beforeCompile });
  if (compiled.status !== 'compiled') throw new Error('The invented reviewed household must compile: ' + JSON.stringify(compiled.diagnostics));
  c.pinned = JSON.parse(JSON.stringify({ ...c.pinned, profile, planPack: assembly.planPack, currentPosition: compiled,
    planningFacts: assembly.planPack.planningInputs, missingFacts: assembly.missingFacts,
    omittedChapters: assembly.omittedChapters, provenance: assembly.provenance,
    notes: ['Explicit invented supplemental review facts from the route-lever fixtures. These are made-up households, not facts collected by the v1 form.'] }));
  c.pinHash = await sha256Json(c.pinned);
  c.factRegistry.current = compiledFacts(compiled, 'current').registry;
  c.runLog[0].result.sourceHash = compiled.source.hash;
  c.runLog[0].usage = { pricingCalls: 0, compilerRuns: c.budget.compilerRuns };
  return c;
}

export function buildReviewedFixture(name, fixtures, input) {
  let profile;
  if (name === 'fictional-reviewed-couple') profile = reviewedRouteExample(fixtures[2]).profile;
  else {
    const properties = majorHouseholds();
    // The route test's sale illustration needs a sale, rather than an already
    // affordable bill. This is an explicit invented supplement too.
    properties.rental.goals.find(goal => goal.goalId === 'fictional_dated_cost').targetAmount.amount = 150000;
    profile = name === 'fictional-trade-down' ? properties.tradeDown : name === 'fictional-rental-sale' ? properties.rental : null;
  }
  if (!profile) throw new Error('Unknown reviewed fixture: ' + name);
  return buildReviewedAnalystCase(profile, input);
}
