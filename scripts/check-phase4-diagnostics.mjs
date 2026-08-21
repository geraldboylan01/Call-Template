#!/usr/bin/env node

/**
 * A FAILED RUN MUST BE READABLE AFTER THE PROCESS THAT FAILED IT HAS GONE.
 *
 * The first 15-run batch wrote each run's trace to a temp workspace and deleted
 * it on exit. It returned twelve k/5 scores and no evidence: "medium captured
 * module-critical facts 2 times in 5" was true, unactionable, and cost €0.90.
 *
 * This spawns a real run as a SEPARATE PROCESS, lets it exit, and only then
 * looks for the artifacts — because that is the exact thing the old runner got
 * wrong, and a check that inspects in-process state would have passed against it.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIAGNOSTICS_ROOT, renderTimeline } from './live-harness/diagnostics.mjs';
import { ownershipVerdict, supersededFigures } from './live-harness/metrics.mjs';
import { MODULE_MANIFEST } from '../js/planning/module_manifest.generated.js';

const pass = (message) => console.info(`[Phase4Diagnostics] PASS: ${message}`);
const runner = fileURLToPath(new URL('./run-live-call.mjs', import.meta.url));
const runId = `selftest-${Date.now()}`;
const runDir = join(DIAGNOSTICS_ROOT, runId);

try {
  const outcome = spawnSync('node', [
    runner, '--persona=pension_easy', '--model=scripted', `--run-id=${runId}`
  ], { encoding: 'utf8', timeout: 600_000 });
  assert.equal(outcome.status, 0, `the run must complete: ${String(outcome.stderr || '').slice(-400)}`);

  /* The artifacts exist AFTER that process has exited. */
  for (const file of ['events.jsonl', 'run.json']) {
    assert.ok(existsSync(join(runDir, file)),
      `${file} must survive process exit — this is the defect that cost a batch`);
  }
  pass('diagnostic artifacts survive the run process exiting');

  /* Everything needed to reconstruct the call, in order. */
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  const seen = new Set(events.map((event) => event.type));
  for (const type of [
    'client', 'assistant', 'tool', 'canonical', 'readiness',
    'barrier', 'reconciliation', 'confirmation', 'module_input', 'module_output'
  ]) {
    assert.ok(seen.has(type), `the record must contain ${type} events`);
  }
  const stamps = events.map((event) => event.at);
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b),
    'events must be chronological, or a timeline cannot be read from them');
  pass('every layer of the call is recorded, in order');

  /* The rejection detail that makes a failure diagnosable at all. */
  const rejections = events.filter((event) => event.type === 'tool')
    .flatMap((event) => event.rejected || []);
  assert.ok(rejections.length > 0, 'the easy persona genuinely produces a rejection to record');
  assert.ok(rejections.every((item) => item.factId && item.reason),
    'every rejection must carry the fact and the reason, never just a count');
  pass('rejections are recorded with their fact and reason');

  /* The pair that answers "did a wrong number reach a client". */
  const moduleIn = events.find((event) => event.type === 'module_input');
  const moduleOut = events.find((event) => event.type === 'module_output');
  assert.ok(moduleIn.canonical.pensions, 'the canonical state given to the module must be recorded');
  assert.ok(Object.hasOwn(moduleOut, 'openingPot') && Object.hasOwn(moduleOut, 'expectedOpeningPot'),
    'the module result must be recorded beside what the persona said it should be');
  pass('module input, module output and ground truth are recorded together');

  /* A failed run leaves a readable trail. */
  const summary = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  assert.ok(Array.isArray(summary.criteriaFailed), 'the summary must name which criteria failed');
  if (summary.criteriaFailed.length) {
    assert.ok(existsSync(join(runDir, 'timeline.txt')),
      'a run with a failed criterion must leave a human-readable timeline');
  }
  // Rendered independently of the run, so the renderer is covered even when the
  // spawned run happens to pass every criterion.
  const rendered = renderTimeline(runId, { ...summary, criteriaFailed: ['module_executed'] }, events);
  assert.match(rendered, /CLIENT/, 'the timeline must show what the client said');
  assert.match(rendered, /MODULE OUT/, 'and what the module produced');
  assert.match(rendered, /GROUND TRUTH/, 'and what it should have been');
  pass('a failed run renders a readable timeline from client speech to module result');

  /* ------------------------------------------------------------------ *
   * "WRONG NUMBER" AND "NO NUMBER" ARE DIFFERENT SEVERITIES.
   *
   * module_arithmetic_correct was false both when a module calculated the
   * wrong figure and when no module ran at all, so a batch scoring it 2/5
   * could not say whether any client had ever been given a wrong number —
   * and every failure to reach a module was counted twice.
   * ------------------------------------------------------------------ */
  const ran = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  assert.equal(ran.moduleCompleted, true, 'the easy persona must reach its module');
  assert.equal(typeof ran.moduleArithmeticCorrect, 'boolean',
    'when a module ran, its arithmetic is a real yes or no');

  const idleId = `${runId}-idle`;
  const idleDir = join(DIAGNOSTICS_ROOT, idleId);
  try {
    // legacy mode leaves readiness open, so nothing is ever executed.
    spawnSync('node', [runner, '--persona=pension_medium', '--model=scripted',
      '--reconciliation=legacy', `--run-id=${idleId}`], { encoding: 'utf8', timeout: 600_000 });
    const idle = JSON.parse(readFileSync(join(idleDir, 'run.json'), 'utf8'));
    assert.equal(idle.moduleCompleted, false, 'this control must not reach a module');
    assert.equal(idle.moduleArithmeticCorrect, null,
      'no module means no arithmetic to judge — null, never false');
    assert.equal(idle.criteriaFailed.includes('module_arithmetic_correct'), false,
      'and it must not be reported as a wrong number on top of the missing module');
    assert.equal(idle.criteriaFailed.includes('module_executed'), true,
      'the real failure — no module ran — must still be reported');
    pass('no module ran is null arithmetic, not a wrong number, and is counted once');
  } finally {
    rmSync(idleDir, { recursive: true, force: true });
  }

  /* ------------------------------------------------------------------ *
   * OWNERSHIP: WRONG NAME vs NEVER CAME UP.
   *
   * The first batch reported four ownership failures. Three were runs where
   * the synthetic client never mentioned their partner, so the profile had
   * none and a long `&&` called that incorrect ownership. NONE of the four had
   * a holding in the wrong name — the failure the metric exists to catch,
   * because it is the one that would feed a module someone else's money.
   * ------------------------------------------------------------------ */
  {
    const household = (over = {}) => ({
      primaryPerson: { personId: 'primary', age: 57 },
      pensions: [{ pensionId: 'p1', ownerId: 'primary' }],
      incomeSources: [{ incomeSourceId: 'i1', ownerId: 'primary' }],
      ...over
    });
    const truth = { primaryAge: 57, partnerAge: 59 };

    // FALSE — something is genuinely wrong. No scripted run can produce these,
    // which is why the verdict lives in a module that can be called directly.
    assert.equal(ownershipVerdict(household({
      partner: { personId: 'partner', age: 59 },
      pensions: [{ pensionId: 'p1', ownerId: 'partner' }]
    }), truth), false, "a holding in the partner's name is WRONG, not unresolved");
    assert.equal(ownershipVerdict(household({
      partner: { personId: 'partner', age: 59 },
      incomeSources: [{ incomeSourceId: 'i1', ownerId: 'partner' }]
    }), truth), false, 'an income in the wrong name is wrong too');
    assert.equal(ownershipVerdict(household({
      partner: { personId: 'partner', age: 61 }
    }), truth), false, 'a captured age that contradicts the client is wrong');

    // NULL — nothing to judge.
    assert.equal(ownershipVerdict(household(), truth), null,
      'a partner the conversation never reached is unresolved, not mis-owned');
    assert.equal(ownershipVerdict({}, truth), null, 'no household at all is unresolved');

    // TRUE — everything stated was established and correctly owned.
    assert.equal(ownershipVerdict(household({
      partner: { personId: 'partner', age: 59 }
    }), truth), true, 'a complete, correctly owned household passes');
    // A persona that states no ages gives nothing to contradict — comparing
    // against `undefined` used to report every such run as mis-owned.
    assert.equal(ownershipVerdict(household(), {}), true,
      'a persona with no stated truth is not thereby wrong');
    pass('ownership separates a wrong owner from a partner never mentioned');
  }

  /* The verdict, end to end, from a run that really happened.
   *
   * This asserted `null` until the live lane stopped refusing "My partner is
   * 59" — the easy persona states the partner in its opening line, so once
   * that age is captured there IS an ownership judgement to make, and it must
   * be the right one. The n/a state is covered directly above, where it can be
   * constructed rather than waited for. */
  {
    const reached = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    assert.equal(reached.ownership.correct, true,
      'the easy persona states both ages, so both must be captured and correctly owned');
    assert.equal(reached.criteriaFailed.includes('ownership_correct'), false,
      'and a correctly owned household must not be reported as a failure');
    pass('a real run captures both stated ages and owns them correctly');
  }

  /* ------------------------------------------------------------------ *
   * A CORRECTION THAT WAS LOST MUST BE REPORTED AS LOST.
   *
   * A paid run heard "I pay in 7 percent", then "sorry, 6 percent is right",
   * ended with 0.07 canonical and ran the module on it. The batch reported
   * correction_superseded 3/3, because this metric looked only at the
   * retirement age and the gross income. Silent loss reported as success is
   * worse than no metric at all.
   * ------------------------------------------------------------------ */
  {
    // The persona declares WHICH figures matter and where they live, so this
    // same code scores a mortgage rate or a college contribution. No module
    // name appears anywhere in the metric.
    const truth = {
      primaryAge: 57,
      figures: [
        { name: 'intendedRetirementAge', path: '/primaryPerson/intendedRetirementAge', expected: 62 },
        { name: 'pensionValue', path: '/pensions/0/currentValue/amount', expected: 319_000 },
        { name: 'employeeRate', path: '/pensions/0/employeeContributionRate', expected: 0.06 },
        { name: 'employerRate', path: '/pensions/0/employerContributionRate', expected: 0.08 }
      ]
    };
    const household = (pension = {}, over = {}) => ({
      primaryPerson: { personId: 'primary', age: 57, intendedRetirementAge: 62 },
      pensions: [{ pensionId: 'p1', ownerId: 'primary',
        currentValue: { amount: 319_000, currency: 'EUR' },
        employeeContributionRate: 0.06, employerContributionRate: 0.08, ...pension }],
      incomeSources: [{ incomeSourceId: 'i1', ownerId: 'primary',
        grossAnnual: { amount: 95_000, currency: 'EUR' } }],
      ...over
    });

    const SAID = 'I retire at 62. The pension is 319,000. I pay 6 percent, my employer pays 8 percent.';
    const lost = (profile, transcript = SAID) => supersededFigures(profile, truth, transcript);

    assert.deepEqual(lost(household()), [],
      'a household matching everything the client last said has lost nothing');

    /* A FIGURE THE CLIENT NEVER SAID IS NOT A LOST CORRECTION.
     * A paid run's synthetic client said "around EUR 300,000" and never
     * corrected it. The lane captured 300,000 and the module used 300,000 —
     * faithful, and flagged as a supersession failure purely for differing from
     * the persona's brief. That reports a wandering persona as a defect. */
    assert.deepEqual(
      lost(household({ currentValue: { amount: 300_000, currency: 'EUR' } }),
        'The pension is around 300,000 at the moment.'),
      [], 'a figure the client never said is not a correction they lost');

    assert.deepEqual(lost(household({ employeeContributionRate: 0.07 })),
      ['employeeRate'], 'a superseded contribution rate must be named, not silently passed');
    assert.deepEqual(lost(household({ currentValue: { amount: 300_000, currency: 'EUR' } })),
      ['pensionValue'], 'and a pension value left at the pre-correction figure');
    assert.deepEqual(
      lost(household({}, { primaryPerson: { personId: 'primary', intendedRetirementAge: 63 } })),
      ['intendedRetirementAge'], 'and the retirement age this metric already covered');
    // The original loss, in the client's own words.
    assert.deepEqual(
      lost(household({ employeeContributionRate: 0.07 }),
        'I pay in 7 percent. Sorry, I said 7 percent earlier, 6 percent is right.'),
      ['employeeRate'], 'the correction that started all this must still be caught');

    // A figure never reached is MISSING, not stale.
    assert.deepEqual(lost(household({ employeeContributionRate: undefined })), [],
      'a rate the conversation never reached is missing, not superseded');

    /* THE SAME METRIC, ON A MODULE THAT IS NOT A PENSION. No new evaluator
     * code: a mortgage rate is a figure with a path like any other. */
    const mortgageTruth = {
      figures: [{ name: 'mortgageRate', path: '/liabilities/0/annualInterestRate', expected: 0.041 }]
    };
    const withRate = (rate) => ({
      primaryPerson: { personId: 'primary' },
      liabilities: [{ liabilityId: 'l1', ownerIds: ['primary'], annualInterestRate: rate }]
    });
    assert.deepEqual(
      supersededFigures(withRate(0.045), mortgageTruth, 'It is 4.5 percent. Sorry, it is 4.1 percent.'),
      ['mortgageRate'], 'a lost mortgage correction is caught by the same code as a pension one');
    assert.deepEqual(
      supersededFigures(withRate(0.041), mortgageTruth, 'It is 4.5 percent. Sorry, it is 4.1 percent.'),
      [], 'and a mortgage correction that landed is not reported');
    pass('every figure the client corrects is checked, and named when it is stale');
  }

  /* ------------------------------------------------------------------ *
   * OWNERSHIP ACROSS COLLECTIONS, NOT JUST PENSIONS.
   *
   * The metric understood pensions and incomeSources. Every other collection a
   * module uses — liabilities, properties, assets, businesses — was invisible,
   * so a mortgage in the wrong name scored as correct ownership.
   * ------------------------------------------------------------------ */
  {
    const truth = { primaryAge: 46, partnerAge: 44 };
    const people = {
      primaryPerson: { personId: 'primary', age: 46 },
      partner: { personId: 'partner', age: 44 }
    };
    const owned = (collection, ownerValue) => {
      const key = collection === 'pensions' || collection === 'incomeSources' ? 'ownerId' : 'ownerIds';
      const idKey = { liabilities: 'liabilityId', properties: 'propertyId', assets: 'assetId',
        pensions: 'pensionId', incomeSources: 'incomeSourceId' }[collection];
      return { ...people, [collection]: [{ [idKey]: 'x1',
        [key]: key === 'ownerIds' ? [ownerValue] : ownerValue }] };
    };

    for (const collection of ['liabilities', 'properties', 'assets', 'pensions', 'incomeSources']) {
      assert.equal(ownershipVerdict(owned(collection, 'primary'), truth), true,
        `a ${collection} record owned by the client is correct`);
      assert.equal(ownershipVerdict(owned(collection, 'partner'), truth), false,
        `a ${collection} record in the partner's name must be caught — it was invisible before`);
    }
    pass('ownership is judged across every owned collection, not only pensions');

    /* JOINT IS DECLARED, NOT GUESSED. A jointly held house legitimately carries
     * both names; the persona says so and either owner is then accepted. */
    const joint = { ...people, properties: [{ propertyId: 'p1', ownerIds: ['primary', 'partner'] }] };
    assert.equal(ownershipVerdict(joint, { ...truth, owners: { properties: 'joint' } }), true,
      'a joint holding the persona declares joint is correctly owned');
    assert.equal(ownershipVerdict(joint, truth), false,
      'and the same holding is wrong when the persona said it was the client\'s alone');
    pass('joint ownership is accepted only where the persona declares it');

    /* DEPENDANTS HAVE NO OWNER. Scoring them would fail every college run. */
    const children = { ...people, dependants: [{ dependantId: 'd1', currentAge: 8 }] };
    assert.equal(ownershipVerdict(children, truth), true,
      'a dependant has no owner key, so it cannot be misowned');
    pass('collections without an owner are not scored for ownership');
  }

  /* ------------------------------------------------------------------ *
   * EVERY PERSONA MUST BE SCORABLE BEFORE IT IS PAID FOR.
   *
   * A persona whose declared path does not resolve, or whose target module is
   * not runnable, produces a page of failures that say nothing about the
   * product — which is what happened when the harness looked for
   * `pension_projection` in a mortgage run.
   * ------------------------------------------------------------------ */
  {
    const dataset = JSON.parse(readFileSync(
      fileURLToPath(new URL('./fixtures/phase4-personas.json', import.meta.url)), 'utf8'));
    const runnable = new Set((MODULE_MANIFEST.modules || Object.values(MODULE_MANIFEST))
      .filter((module) => module.availability?.consumer && module.implementation?.hasRunnableEngine)
      .map((module) => module.moduleId));

    for (const persona of dataset.personas) {
      assert.ok(persona.targetModule, `${persona.id} must declare the module it is testing`);
      assert.ok(runnable.has(persona.targetModule),
        `${persona.id} targets ${persona.targetModule}, which is not a runnable consumer module`);
      const truth = persona.groundTruth || {};
      for (const figure of truth.figures || []) {
        assert.ok(figure.name && figure.path, `${persona.id} figures need a name and a path`);
        assert.ok(figure.path.startsWith('/'), `${persona.id}: ${figure.path} must be a profile path`);
        assert.ok(Number.isFinite(figure.expected),
          `${persona.id}: ${figure.name} must state the figure the client ends up with`);
      }
      for (const collection of Object.keys(truth.expectedCounts || {})) {
        assert.ok(Number.isFinite(truth.expectedCounts[collection]),
          `${persona.id}: expectedCounts.${collection} must be a number`);
      }
      if (truth.headline) {
        assert.ok(truth.headline.datasetLabel,
          `${persona.id}: a declared headline needs the dataset label to read`);
      }
    }
    pass(`all ${dataset.personas.length} personas declare a runnable module and scorable ground truth`);
  }

  /* No secrets. */
  const raw = readFileSync(join(runDir, 'events.jsonl'), 'utf8')
    + readFileSync(join(runDir, 'run.json'), 'utf8');
  assert.equal(/sk-[A-Za-z0-9_-]{20,}/.test(raw), false, 'no API key may ever reach an artifact');
  assert.equal(/OPENAI_API_KEY/.test(raw), false, 'nor the name of one alongside a value');
  pass('artifacts contain no credentials');
} finally {
  rmSync(runDir, { recursive: true, force: true });
}

console.info('\n[Phase4Diagnostics] PASS: a failed run can be read after the fact');
