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
  sanitizeScenarioOverrides, ScenarioLeverError, scenarioAwareModuleIds, scenarioLeversFor,
  scenarioPromptSection
} from '../js/planning/scenario_levers.js';

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
  const aware = scenarioAwareModuleIds();
  assert.ok(aware.includes('pension_projection'), 'pension_projection must declare levers');
  for (const moduleId of aware) {
    for (const lever of scenarioLeversFor(moduleId)) {
      assert.ok(lever.id && lever.type && lever.means,
        `${moduleId}.${lever.id} must say what it means in a client's terms`);
      assert.ok(Number.isFinite(lever.min) && Number.isFinite(lever.max) && lever.min < lever.max,
        `${moduleId}.${lever.id} must declare a usable range`);
    }
  }
  pass(`${aware.length} scenario-aware module(s), every lever ranged and explained`);

  assert.deepEqual(sanitizeScenarioOverrides('pension_projection', { retirement_age: 60 }),
    { retirement_age: 60 });
  assert.deepEqual(sanitizeScenarioOverrides('pension_projection', { retirement_age: '60' }),
    { retirement_age: 60 }, 'a numeric string from a tool call must coerce');

  // STRICT IS THE POINT. A model told nothing about an out-of-range lever would
  // describe base-case results as though the scenario had run.
  assert.throws(() => sanitizeScenarioOverrides('pension_projection', { retirement_age: 95 }),
    /between 50 and 75/);
  assert.throws(() => sanitizeScenarioOverrides('pension_projection', { invented: 1 }),
    /has no "invented" to change/);
  assert.throws(() => sanitizeScenarioOverrides('liquidity_analysis', { anything: 1 }),
    /declares no scenario levers/);
  pass('an unusable lever is refused by name, with its range');

  // The error is a CLASS, not just a message, so a caller can tell a bad lever
  // apart from a module that blew up — and can tell the client which assumption
  // it could not use rather than failing the whole turn.
  try {
    sanitizeScenarioOverrides('pension_projection', { retirement_age: 95 });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error instanceof ScenarioLeverError);
    assert.equal(error.code, 'scenario_lever_invalid');
    assert.equal(error.moduleId, 'pension_projection');
    assert.equal(error.leverId, 'retirement_age');
  }
  pass('a lever error is catchable by class and names the module and the lever');

  // Lenient mode still exists for browser controls, where a half-typed value
  // must mean "use the base case" rather than blank the screen.
  assert.deepEqual(
    sanitizeScenarioOverrides('pension_projection', { retirement_age: 95 }, { strict: false }), {});
  pass('lenient mode drops silently, for browser controls');

  const section = scenarioPromptSection();
  for (const moduleId of aware) {
    for (const lever of scenarioLeversFor(moduleId)) {
      assert.ok(section.includes(`${moduleId}.${lever.id}`),
        `the generated prompt section must name ${moduleId}.${lever.id}`);
    }
  }
  pass('the prompt section is generated from the manifests and names every lever');
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
