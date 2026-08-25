#!/usr/bin/env node

/**
 * The teaching harness, asserted.
 *
 * Every claim apprentice mode makes about itself is checked here, because the
 * claims are the point. "Your approval is required" is worth nothing as a
 * sentence in a README; it is worth something as a test that fails when an
 * unapproved lesson can be compiled.
 *
 * FREE. No model calls, no database, no network. Safe in CI.
 */

import assert from 'node:assert/strict';

import { TEACHING_BUNDLE_VERSION } from './agent-harness/bundle.mjs';
import { divergencesFor, summariseDivergences } from './agent-harness/shadow.mjs';
import { parseAdviserTurn } from './teach-call.mjs';
import {
  approvalFailure, canonicalLessonText, LESSON_SCHEMA_VERSION, parseLessonFile, renderLessonFile,
  sha256
} from './teach-lesson.mjs';
import {
  APPRENTICE_SCENARIO_ID, applyScenarioToInput, sanitizeScenarioRequest, SCENARIO_ARCHITECTURAL_GAPS,
  SCENARIO_CATALOGUE, ScenarioLeverError, scenarioCapableModuleIds, scenarioLeversFor,
  scenarioMechanismFor, scenarioPromptSection
} from '../js/planning/scenario_catalogue.js';
import { compareFigures, describeFigure, headlineFigures } from './agent-harness/adviser-run.mjs';

const pass = (message) => console.info(`[TeachingHarness] PASS: ${message}`);

/* ------------------------------------------- what the adviser typed, parsed */

{
  const turn = parseAdviserTurn([
    'Before that, tell me about Tom.',
    '/run pension_projection retirement_age=60 growth_rate=0.04',
    '/note going part-time is a household question',
    '/fix the 30k is joint, not hers'
  ].join('\n'));
  assert.equal(turn.said, 'Before that, tell me about Tom.');
  assert.deepEqual(turn.runs, [{
    moduleId: 'pension_projection',
    scenarioOverrides: { retirement_age: 60, growth_rate: 0.04 }
  }]);
  assert.equal(turn.note, 'going part-time is a household question');
  assert.deepEqual(turn.fixes, ['the 30k is joint, not hers']);
  pass('speech, /run, /note and /fix are separated from one typed turn');

  // Speech is VERBATIM. A command-looking line that is not a command stays speech.
  const prose = parseAdviserTurn('I would not run a projection on that yet.');
  assert.equal(prose.said, 'I would not run a projection on that yet.');
  assert.equal(prose.runs.length, 0);
  pass('a sentence mentioning a module is speech, not a command');

  // Acting without speaking is legitimate: an adviser can just run something.
  const silent = parseAdviserTurn('/run house_purchase targetPropertyPrice=350000');
  assert.equal(silent.said, null);
  assert.equal(silent.runs[0].scenarioOverrides.targetPropertyPrice, 350000);
  pass('an adviser may act without speaking');
}

/* --------------------------------------------------- divergence, mechanical */

const shadow = {
  question: {
    factId: 'pension_current_value',
    factInstanceId: 'pension_current_value:p1',
    prompt: 'What is the pension worth?',
    reason: 'required by pension_projection'
  },
  confirmationCandidateModuleIds: ['pension_projection'],
  moduleSlots: [{ moduleId: 'pension_projection' }],
  provenance: { blockingModuleIds: ['pension_projection'] }
};

{
  const agreed = divergencesFor({
    turn: 1, shadow, expert: { said: 'And the pension?' },
    factsBefore: [], factsAfter: [{ factInstanceId: 'pension_current_value:p1' }]
  });
  assert.equal(agreed.length, 0, 'agreement must cost nothing downstream');
  pass('a turn where the adviser and the rules agree produces no divergence');

  // THE THREE-VALUED CASE. Nothing landed, so no claim is possible. Recording
  // an unknown as a divergence would manufacture evidence, and a corpus of
  // manufactured divergences is worse than an empty one.
  const unknown = divergencesFor({
    turn: 2, shadow, expert: { said: 'How have you been?' }, factsBefore: [], factsAfter: []
  });
  assert.equal(unknown.length, 0);
  pass('a turn that produced no facts is unknown, not a divergence');

  const topic = divergencesFor({
    turn: 3, shadow, expert: { said: 'Tell me about Tom first.', note: 'household question' },
    factsBefore: [], factsAfter: [{ factInstanceId: 'income_sources:i1' }]
  });
  assert.equal(topic.length, 1);
  assert.equal(topic[0].kind, 'question_target');
  assert.equal(topic[0].sameTarget, false);
  assert.equal(topic[0].baseline.blockingModuleIds[0], 'pension_projection');
  pass('a real change of subject is caught, and names the module that wanted the fact');

  const scenario = divergencesFor({
    turn: 4,
    shadow,
    expert: { runs: [{ moduleId: 'pension_projection', scenarioOverrides: { retirement_age: 60 } }] },
    factsBefore: [], factsAfter: [{ factInstanceId: 'pension_current_value:p1' }]
  });
  assert.ok(scenario.some((item) => item.kind === 'scenario_construction'));
  pass('a what-if on an already-offered analysis is still a divergence');

  const timing = divergencesFor({
    turn: 5,
    shadow: { ...shadow, renderer: { text: 'Anything else?', toolCalls: [] } },
    expert: { runs: [{ moduleId: 'pension_projection', scenarioOverrides: {} }] },
    factsBefore: [], factsAfter: [{ factInstanceId: 'pension_current_value:p1' }]
  });
  assert.ok(timing.some((item) => item.kind === 'run_timing'));
  pass('run timing is compared only when the renderer shadow was recorded');

  assert.equal(summariseDivergences([...topic, ...scenario, ...timing]).total, 3);
  pass('divergences summarise by kind for the run log');
}

/* ------------------------------------------------------------ what-if levers */

{
  // THE PROMPT PACK IS THE AUTHORITY. Every lever must trace to a pack citation,
  // because the failure that made this catalogue necessary was declaring levers
  // (retirement_age, annual_contribution, growth_rate on the pension) that the
  // pack never authorises and no engine computes -- and watching a call come
  // back with base-case figures dressed as a what-if.
  const ids = scenarioCapableModuleIds();
  assert.deepEqual(ids.sort(), [
    'college_funding', 'house_purchase', 'net_retirement_cashflow', 'pension_projection'
  ], 'the scenario-capable set is fixed by the Prompt Pack, not by what is convenient');
  for (const moduleId of ids) {
    const mechanism = scenarioMechanismFor(moduleId);
    assert.ok(mechanism.source, `${moduleId} must cite the Prompt Pack line that authorises it`);
    assert.ok(['input_scenarios', 'runtime_overrides', 'income_source_amount'].includes(mechanism.kind),
        `${moduleId} declares an unknown mechanism kind`);
    for (const lever of scenarioLeversFor(moduleId)) {
      assert.ok(lever.id && lever.type && lever.means,
        `${moduleId}.${lever.id} must say what it means in a client's terms`);
      if (lever.type === 'enum') assert.ok(lever.values.length > 0);
      else if (lever.type !== 'idList') {
        assert.ok(Number.isFinite(lever.min) && Number.isFinite(lever.max) && lever.min < lever.max,
          `${moduleId}.${lever.id} must declare a usable range`);
      }
    }
  }
  pass(`${ids.length} scenario-capable module(s), every lever cited to the Prompt Pack`);

  // The pension's entire authorised surface is ONE field.
  assert.deepEqual(scenarioLeversFor('pension_projection').map((l) => l.id), ['rentalIncomeToday']);
  for (const invented of ['retirement_age', 'annual_contribution', 'growth_rate']) {
    assert.throws(() => sanitizeScenarioRequest('pension_projection', { [invented]: 60 }),
      /does not give pension_projection/,
      `${invented} was never in the Prompt Pack and must stay refused`);
  }
  pass('the pension what-if is rental income only; the invented levers stay refused');

  // House purchase is runtime-only by pack instruction and must never gain a
  // persisted selector (17_house_purchase_playbook.md:26).
  assert.equal(SCENARIO_CATALOGUE.house_purchase.kind, 'runtime_overrides');
  assert.equal(applyScenarioToInput('house_purchase', { a: 1 }, { mortgageTermYears: 25 }).scenarioId, '',
    'a house-purchase what-if must not create a persisted scenario id');
  assert.throws(() => sanitizeScenarioRequest('house_purchase', { supportCase: 'htb_and_more' }),
    /must be one of/);
  assert.deepEqual(sanitizeScenarioRequest('house_purchase', { supportCase: 'htb_only' }),
    { supportCase: 'htb_only' });
  pass('house purchase stays runtime-only, with the four scheme cases the pack names');

  // Net retirement carries whole scenario definitions into the input.
  const applied = applyScenarioToInput('net_retirement_cashflow',
    { scenarios: [{ id: 'base', title: 'Current position' }] },
    sanitizeScenarioRequest('net_retirement_cashflow', { annualExpenditureToday: 38000 }));
  assert.equal(applied.scenarioId, APPRENTICE_SCENARIO_ID);
  assert.equal(applied.input.scenarios.length, 2, 'the base case must survive alongside the what-if');
  assert.equal(applied.input.scenarios[1].annualExpenditureToday, 38000);
  pass('a net-retirement what-if is added beside the base case, never instead of it');

  // THE RENT MUST NOT BE COUNTED TWICE. The engine adds rentalIncomeToday ON TOP
  // of otherIncomeSources (pension_math.js:797-803), so a scenario that wrote
  // the pack's field while the rent still sat in otherIncomeSources would
  // silently double it. The scenario varies the amount where the rent already
  // lives, and the pack's top-level field stays untouched.
  const withRent = {
    currentYear: 2026,
    pensions: [{ id: 'primary', currentAge: 52, retirementAge: 65 }],
    otherIncomeSources: [
      { id: 'r1', type: 'rental', annualAmountToday: 12000, startYear: 2039, inflationIndexed: true },
      { id: 'r2', type: 'rental', annualAmountToday: 6000, startYear: 2039, inflationIndexed: true },
      { id: 'db', type: 'pension', annualAmountToday: 9000, startYear: 2039, inflationIndexed: false }
    ]
  };
  const halved = applyScenarioToInput('pension_projection', withRent,
    sanitizeScenarioRequest('pension_projection', { rentalIncomeToday: 9000 }));
  assert.equal(typeof halved.input.rentalIncomeToday, 'undefined',
    'the pack top-level field must stay unset, or the rent is counted twice');
  const rentals = halved.input.otherIncomeSources.filter((item) => item.type === 'rental');
  assert.equal(rentals.reduce((sum, item) => sum + item.annualAmountToday, 0), 9000);
  // Proportional, so a household with two rented properties keeps its shape.
  assert.equal(rentals[0].annualAmountToday, 6000);
  assert.equal(rentals[1].annualAmountToday, 3000);
  // And everything the client actually told us survives untouched.
  assert.equal(rentals[0].startYear, 2039);
  assert.equal(rentals[0].inflationIndexed, true);
  assert.equal(halved.input.otherIncomeSources.find((item) => item.id === 'db').annualAmountToday, 9000,
    'a non-rental income must not be touched');
  pass('rental income is varied in place, proportionally, with its timing intact');

  const soldUp = applyScenarioToInput('pension_projection', withRent,
    sanitizeScenarioRequest('pension_projection', { rentalIncomeToday: 0 }));
  assert.equal(soldUp.input.otherIncomeSources.filter((item) => item.type === 'rental').length, 0,
    'a source scaled to nothing is removed, not left as a zero-amount record');
  assert.ok(soldUp.input.otherIncomeSources.some((item) => item.id === 'db'));
  pass('selling up removes the rental sources and leaves the rest alone');

  // A client with no rent yet, considering an investment property.
  const noRent = { currentYear: 2026, pensions: [{ id: 'primary', currentAge: 52, retirementAge: 65 }], otherIncomeSources: [] };
  const bought = applyScenarioToInput('pension_projection', noRent,
    sanitizeScenarioRequest('pension_projection', { rentalIncomeToday: 15000 }));
  const added = bought.input.otherIncomeSources.find((item) => item.type === 'rental');
  assert.equal(added.annualAmountToday, 15000);
  assert.equal(added.startYear, 2039, 'the engine refuses a source with no start year');
  pass('a client with no rental income can still be shown one');

  assert.equal(applyScenarioToInput('pension_projection', noRent,
    sanitizeScenarioRequest('pension_projection', { rentalIncomeToday: 0 })).scenarioId, '',
    'zero rent against no rent is not a scenario');
  pass('varying nothing to nothing is correctly not a what-if');

  // College funding has no base selector -- cases coexist as separate stacks.
  const college = applyScenarioToInput('college_funding',
    { scenarios: [{ id: 'living_at_home' }], children: [{ id: 'c1' }] },
    sanitizeScenarioRequest('college_funding', { annualCostTodayPerChild: 15000 }));
  assert.equal(college.input.scenarios.length, 2);
  assert.equal(college.input.children[0].scenarioId, APPRENTICE_SCENARIO_ID);
  pass('a college what-if is an extra case each child is pointed at');

  // PBS is recorded as an architectural gap, not silently omitted.
  assert.ok(SCENARIO_ARCHITECTURAL_GAPS.personal_balance_sheet.packDefines);
  assert.throws(() => sanitizeScenarioRequest('personal_balance_sheet', { anything: 1 }),
    /no engine support/);
  pass('PBS is refused with the reason, not quietly treated as having no scenarios');

  assert.throws(() => sanitizeScenarioRequest('liquidity_analysis', { anything: 1 }),
    /no scenario defined in the Prompt Pack/);
  assert.deepEqual(
    sanitizeScenarioRequest('pension_projection', { retirement_age: 60 }, { strict: false }), {},
    'lenient mode drops rather than throws, for browser controls');
  pass('a module with no pack scenario is refused; lenient mode drops silently');

  try {
    sanitizeScenarioRequest('pension_projection', { rentalIncomeToday: -5 });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error instanceof ScenarioLeverError);
    assert.equal(error.code, 'scenario_lever_invalid');
    assert.equal(error.moduleId, 'pension_projection');
    assert.equal(error.leverId, 'rentalIncomeToday');
  }
  pass('a lever error is catchable by class and names the module and the lever');

  const section = scenarioPromptSection();
  for (const moduleId of ids) {
    for (const lever of scenarioLeversFor(moduleId)) {
      assert.ok(section.includes(`${moduleId}.${lever.id}`),
        `the generated prompt section must name ${moduleId}.${lever.id}`);
    }
  }
  pass('the prompt section is generated from the catalogue and names every lever');
}

/* --------------------------------------------------- reading a what-if back */

{
  assert.deepEqual(headlineFigures({ currency: 'EUR', requiredPot: 780000, scenarioId: 'x', note: 'text' }),
    { requiredPot: 780000 }, 'only numeric outcomes are figures');
  const rows = compareFigures({ requiredPot: 780000 }, { requiredPot: 905000 });
  assert.equal(rows[0].delta, 125000);
  assert.match(describeFigure(rows[0]), /780,000.*905,000/);
  pass('base and what-if figures are compared and read back as movement');
}

/* ------------------------------------------------------- the approval gate */

const lessonFixture = () => ({
  lessonId: 'fixture',
  schemaVersion: LESSON_SCHEMA_VERSION,
  status: 'approved',
  caseId: 'case1',
  layer: 2,
  principle: 'Ask about the partner before committing to a plan.',
  oldBehaviour: 'Pursues the client alone.',
  newBehaviour: 'Marks the partner as required.',
  doNotApplyWhen: ['the client is single'],
  risks: ['can feel intrusive'],
  tests: [],
  approval: null,
  compiled: { at: null, artefacts: [] }
});

{
  const lesson = lessonFixture();
  lesson.approval = {
    textHash: sha256(canonicalLessonText(lesson)),
    approvedAt: new Date().toISOString(),
    approvedBy: 'adviser@example.com',
    interactive: true
  };
  assert.equal(approvalFailure(lesson), null);
  pass('a properly approved lesson passes the gate');

  // THE TAMPER CASE. Widening the boundaries after approval is a different
  // lesson, and the hash is what makes that undeniable rather than arguable.
  const widened = { ...lesson, doNotApplyWhen: ['the client is single', 'whenever it feels awkward'] };
  assert.match(approvalFailure(widened), /changed since it was approved/);
  pass('editing an approved lesson invalidates the approval');

  assert.match(approvalFailure({ ...lesson, status: 'proposed' }), /not "approved"/);
  assert.match(approvalFailure({ ...lesson, approval: null }), /no approval hash/);
  assert.match(approvalFailure(null), /not found/);
  assert.match(
    approvalFailure({ ...lesson, schemaVersion: 'something-else' }), /unknown schema/);
  pass('proposed, unhashed, missing and unknown-schema lessons are all refused');

  // Every field the adviser actually READ must be inside the hash. A lesson
  // whose risks were quietly dropped is not the lesson they approved.
  for (const field of ['principle', 'oldBehaviour', 'newBehaviour', 'layer']) {
    const altered = { ...lesson, [field]: 'something else' };
    assert.notEqual(canonicalLessonText(altered), canonicalLessonText(lesson),
      `${field} must be covered by the approval hash`);
  }
  assert.notEqual(canonicalLessonText({ ...lesson, risks: [] }), canonicalLessonText(lesson));
  pass('every field the adviser read is covered by the hash');

  const roundTripped = parseLessonFile(renderLessonFile(lesson));
  assert.deepEqual(roundTripped, lesson);
  assert.equal(approvalFailure(roundTripped), null);
  pass('a lesson survives a write/read round trip with its approval intact');
}

/* ---------------------------------------------------------------- versions */

assert.equal(TEACHING_BUNDLE_VERSION, 'planeir-teaching-bundle-v1');
assert.equal(LESSON_SCHEMA_VERSION, 'planeir-teaching-lesson-v1');
pass('bundle and lesson schema versions are pinned');

console.info('\n[TeachingHarness] all assertions passed');
