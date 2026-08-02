/**
 * A7 — deterministic guarantees for callers, blockers, grading and trends.
 *
 * Free to run. The properties proved here are the ones the feedback loop rests
 * on: a caller is used verbatim, a blocker is found the same way every time, a
 * blank grade is not a zero, and two runs of different systems are never
 * compared as though they were the same one.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BLOCKER_IDS, detectBlockers, newBlockersAfterTurn, shouldAbandon } from './agent-harness/blockers.mjs';
import {
  buildGradingSheet, calibrate, describeCalibration, GRADE_DIMENSIONS, parseGradingSheet
} from './agent-harness/grading.mjs';
import { parseCaller, callerBrief } from './agent-harness/caller.mjs';
import {
  applyRetention, compareRuns, loadRuns, regressionsIn, runKey, saveRun, trendFor
} from './agent-harness/runlog.mjs';
import { aggregateReviews, normaliseReview, reviewCall } from './agent-judges/review.mjs';

let checks = 0;
const check = (label, condition, detail = '') => {
  checks += 1;
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
};

const turn = (over = {}) => ({
  questionFactId: null, goals: [], analyses: [], factIds: [],
  acceptedFactIds: [], rejectedFactIds: [], plannerErrorCode: null, degraded: false, ...over
});

/* ------------------------------------------------------------- callers */

{
  const raw = `Deirdre, 44, self-employed graphic designer in Galway.
Earns about 52,000 a year. No pension at all. Renting.
Has 12,000 saved. Wants to buy somewhere in the next few years.

# Questions
- Am I mad not to have a pension at my age?
- Could I actually afford a mortgage on my own?

# Behaviour
- deflects when asked about money
- asks a lot of questions back`;

  const caller = parseCaller(raw, 'deirdre');
  const brief = callerBrief(caller);

  // The pasted words are used verbatim: any restructuring would decide in
  // advance which details matter, and the dropped ones are what a call trips on.
  check('the caller text survives verbatim', brief.includes('self-employed graphic designer in Galway'));
  check('an exact figure survives verbatim', brief.includes('52,000'));
  check('an absence survives verbatim', brief.includes('No pension at all'));
  check('questions are parsed off', caller.client.questions.length === 2);
  check('behaviours are parsed off', caller.client.behaviours.length === 2);
  check('question markers are stripped from the brief body', !brief.split('Things you want to ask')[0].includes('# Questions'));
  check('questions are given as things to raise, not a checklist',
    /Raise them when it feels natural/.test(brief));
  check('a caller carries no answer key', Object.keys(caller.expected).length === 0);
  check('a caller is marked synthetic', caller.synthetic === true);

  const plain = parseCaller('Just a person with a pension question.', 'plain');
  check('a file with no headings is valid', callerBrief(plain).trim() === 'Just a person with a pension question.');
  check('an empty caller is refused',
    (() => { try { parseCaller('   ', 'x'); return false; } catch { return true; } })());

  const bulleted = parseCaller('Someone.\n\n## Questions\n1. First?\n* Second?\n- Third?', 'b');
  check('numbered, starred and dashed questions all parse',
    bulleted.client.questions.length === 3, JSON.stringify(bulleted.client.questions));
}

/* ------------------------------------------------------------- blockers */

{
  const repeated = [
    turn({ questionFactId: 'property_position' }),
    turn({ questionFactId: 'property_position' }),
    turn({ questionFactId: 'property_position' })
  ];
  const findings = detectBlockers(repeated);
  const repeatFinding = findings.find((item) => item.id === 'repeated_question');
  check('the live loop that started all this is detected', Boolean(repeatFinding));
  check('it is reported as blocking', repeatFinding.severity === 'blocking');
  check('it names the turns it happened on', /turns 1, 2, 3/.test(repeatFinding.detail), repeatFinding.detail);

  check('asking twice is not yet a loop',
    !detectBlockers([turn({ questionFactId: 'a' }), turn({ questionFactId: 'a' })])
      .some((item) => item.id === 'repeated_question'));

  const answeredThenAsked = [
    turn({ questionFactId: 'person_current_age', acceptedFactIds: ['person_current_age'] }),
    turn({ questionFactId: 'person_current_age' })
  ];
  check('asking for something already answered is caught',
    detectBlockers(answeredThenAsked).some((item) => item.id === 'asked_again_after_answering'));

  check('a lost goal is caught', detectBlockers([
    turn({ goals: ['retire'] }), turn({ goals: [] })
  ]).some((item) => item.id === 'goal_lost'));

  check('a planner error is caught', detectBlockers([turn({ plannerErrorCode: 'planner_failed' })])
    .some((item) => item.id === 'planner_error'));

  check('a turn with nothing to answer is caught', detectBlockers([turn({})])
    .some((item) => item.id === 'no_question_left'));

  const stalled = Array.from({ length: 3 }, () => turn({ questionFactId: 'x', goals: ['retire'] }));
  check('three turns that changed nothing is a stall',
    detectBlockers(stalled).some((item) => item.id === 'stalled_progress'));

  const healthy = [
    turn({ questionFactId: 'primary_goal', goals: ['retire'], acceptedFactIds: ['primary_goal'] }),
    turn({ questionFactId: 'person_current_age', goals: ['retire'], analyses: ['pension_projection'], factIds: ['primary_goal'] }),
    turn({ questionFactId: 'pension_positions', goals: ['retire'], analyses: ['pension_projection'], factIds: ['primary_goal', 'person_current_age'] })
  ];
  check('a healthy call produces no blocking findings',
    detectBlockers(healthy).every((item) => item.severity !== 'blocking'),
    JSON.stringify(detectBlockers(healthy)));

  // Findings are ordered worst-first, so a report leads with what matters.
  const mixed = detectBlockers([...repeated, turn({ rejectedFactIds: ['cash_savings'] })]);
  check('findings are ordered worst first', mixed[0].severity === 'blocking');

  // Mid-call detection reports each finding ONCE, or every later turn would
  // re-report the same loop and drown the real signal.
  const seen = new Set();
  const first = newBlockersAfterTurn(repeated, seen);
  const second = newBlockersAfterTurn(repeated, seen);
  check('a mid-call finding is reported once', first.length > 0 && second.length === 0);
  check('a call going nowhere is abandonable', shouldAbandon(first));
  check('a call with only friction is not abandoned',
    !shouldAbandon(detectBlockers([turn({ questionFactId: 'a', rejectedFactIds: ['b'] })])));
  check('every detector has an id', BLOCKER_IDS.length >= 10 && BLOCKER_IDS.every(Boolean));
}

/* -------------------------------------------------------------- grading */

{
  const sheet = buildGradingSheet({
    runId: 'run-1',
    calls: [
      { callId: 'deirdre', caller: 'deirdre', turns: 6, blockerCount: 1, transcript: [{ role: 'client', text: 'hello' }] },
      { callId: 'mary', caller: 'mary', turns: 8, blockerCount: 0, transcript: [] }
    ]
  });
  check('the sheet has a section per call', (sheet.match(/^## /gm) || []).length === 2);
  check('the sheet never shows the judge its own score first',
    !/judge.*[1-5]\s*\/\s*5/i.test(sheet) && /deliberately not shown/.test(sheet));
  check('the transcript is in the sheet so you can grade what was said', sheet.includes('hello'));

  // Built from GRADE_DIMENSIONS rather than a hardcoded list, so adding a
  // dimension does not silently stop exercising this.
  const scored = GRADE_DIMENSIONS.map((dimension, index) => `- ${dimension.key}: ${index % 5 + 1}`).join('\n');
  const blank = GRADE_DIMENSIONS.map((dimension) => `- ${dimension.key}: `).join('\n');
  const filled = `## deirdre\n\n${scored}\n- Notes: felt human\n\n## mary\n\n${blank}\n- Notes: \n`;
  const parsed = parseGradingSheet(filled);
  const expectedMean = GRADE_DIMENSIONS
    .map((unused, index) => index % 5 + 1)
    .reduce((sum, value) => sum + value, 0) / GRADE_DIMENSIONS.length;
  const deirdre = parsed.find((item) => item.callId === 'deirdre');
  const mary = parsed.find((item) => item.callId === 'mary');
  check('a filled call is graded', deirdre.graded === true && deirdre.mean === expectedMean,
    `mean ${deirdre.mean}`);
  check('your note is kept', deirdre.notes === 'felt human');
  // The property that protects every trend downstream.
  check('a blank grade is MISSING, not zero', mary.graded === false && mary.mean === null);
  check('a blank grade records no scores', Object.keys(mary.scores).length === 0);

  const outOfRange = parseGradingSheet('## x\n- usefulness: 9\n- tone: 0\n');
  check('grades are clamped into range',
    outOfRange[0].scores.usefulness === 5 && outOfRange[0].scores.tone === 1);
  check('an unknown field is ignored', !('nonsense' in parseGradingSheet('## x\n- nonsense: 3\n')[0].scores));

  const calibration = calibrate(
    [
      { callId: 'a', graded: true, mean: 3, notes: 'too pushy' },
      { callId: 'b', graded: true, mean: 4, notes: '' },
      { callId: 'c', graded: false, mean: null, notes: '' }
    ],
    [{ callId: 'a', mean: 5 }, { callId: 'b', mean: 4.5 }, { callId: 'c', mean: 5 }]
  );
  check('only graded calls are compared', calibration.compared === 2);
  // Gaps of +2 and +0.5: the judge is a full 1.25 kinder than you on average.
  check('the judge running kind is measured as bias', calibration.bias === 1.25, String(calibration.bias));
  check('the widest disagreement is surfaced with your note',
    calibration.worstDisagreement.callId === 'a' && calibration.worstDisagreement.notes === 'too pushy');
  check('the calibration reads in plain English', /kinder than you/.test(describeCalibration(calibration)));
  check('no graded calls yields no false confidence',
    /Not enough graded calls/.test(describeCalibration(calibrate([], []))));
}

/* --------------------------------------------------------------- trends */

{
  const dir = mkdtempSync(join(tmpdir(), 'agent-runs-'));
  try {
    const key = runKey({
      config: { realtimePromptVersion: 'v4', realtimeToolsetVersion: 't1', realtimePlannerModel: 'gpt-5.6-luna' },
      releasedModuleIds: 'a,b',
      manifestVersion: '2.0.0'
    });
    check('a run key names everything that could change the answer',
      /prompt=v4/.test(key) && /planner=gpt-5\.6-luna/.test(key) && /modules=a,b/.test(key));

    const earlier = {
      runId: 'r1', runKey: key, generatedAt: '2026-08-01T10:00:00.000Z',
      metrics: { blockingFindings: 5, goalCaptureRate: 0.5, humanGradeMean: 3 }, calls: []
    };
    const later = {
      runId: 'r2', runKey: key, generatedAt: '2026-08-02T10:00:00.000Z',
      metrics: { blockingFindings: 2, goalCaptureRate: 0.4, humanGradeMean: 4 }, calls: []
    };
    saveRun(earlier, { dir });
    saveRun(later, { dir });

    const comparison = compareRuns(later, earlier);
    check('two runs of the same system are comparable', comparison.comparable);
    const byKey = Object.fromEntries(comparison.changes.map((change) => [change.key, change]));
    // Direction matters: fewer blockers is good, fewer goals captured is not.
    check('fewer blocking findings reads as an improvement', byKey.blockingFindings.improved === true);
    check('a lower goal-capture rate reads as a regression', byKey.goalCaptureRate.improved === false);
    check('a higher grade from you reads as an improvement', byKey.humanGradeMean.improved === true);
    check('regressions are extractable on their own',
      regressionsIn(comparison).map((item) => item.key).join() === 'goalCaptureRate');

    const otherSystem = { ...later, runKey: runKey({ config: { realtimePromptVersion: 'v5' } }) };
    const across = compareRuns(otherSystem, earlier);
    check('runs of DIFFERENT systems are never compared', across.comparable === false);
    check('and the reason says so', /different system/.test(across.reason));
    check('no earlier run is not a regression', compareRuns(later, null).comparable === false);

    const runs = loadRuns({ dir });
    check('the archive loads newest first', runs[0].runId === 'r2');
    check('a trend excludes runs from another system', trendFor(runs, key).runs === 2);
    check('the trend series is oldest first, for reading left to right',
      trendFor(runs, key).series.humanGradeMean.map((point) => point.value).join() === '3,4');

    writeFileSync(join(dir, 'corrupt.json'), '{not json');
    check('a corrupt archive entry does not take down the report', loadRuns({ dir }).length === 2);

    // Retention: the words go before the numbers do.
    const old = saveRun({
      runId: 'r0', runKey: key, generatedAt: '2026-01-01T00:00:00.000Z',
      metrics: { blockingFindings: 1 },
      calls: [{ callId: 'x', transcript: [{ role: 'client', text: 'private circumstances' }] }]
    }, { dir });
    const longAgo = (Date.now() - 60 * 86_400_000) / 1000;
    utimesSync(old, longAgo, longAgo);
    const retention = applyRetention({ dir, transcriptDays: 30, runDays: 365 });
    check('an old transcript is cleared', retention.transcriptsCleared === 1);
    const pruned = loadRuns({ dir }).find((run) => run.runId === 'r0');
    check('the words are gone', pruned.calls[0].transcript.length === 0 && pruned.calls[0].transcriptCleared === true);
    check('the numbers survive for the trend', pruned.metrics.blockingFindings === 1);

    utimesSync(old, longAgo, longAgo);
    check('a run past its retention window is deleted',
      applyRetention({ dir, transcriptDays: 30, runDays: 30 }).runsDeleted === 1);
    check('retention on a missing directory is harmless',
      applyRetention({ dir: join(dir, 'nope') }).runsDeleted === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------- review */

{
  const review = normaliseReview({
    worked: ['opened warmly'],
    did_not_work: [{ what: 'asked for the house value twice', turn: 4, why: 'the first answer was vague', change: 'accept a range' }],
    biggest_single_change: 'accept a range',
    would_a_person_come_back: true
  });
  check('a review normalises into something actionable',
    review.didNotWork[0].change === 'accept a range' && review.wouldComeBack === true);
  check('a malformed entry is dropped, not half-kept',
    normaliseReview({ did_not_work: [{ turn: 2 }] }).didNotWork.length === 0);

  const themes = aggregateReviews([review, review, { ...review, worked: ['clear'] }]);
  check('a change suggested across calls is ranked by recurrence',
    themes.recurringChanges[0].calls === 3 && themes.recurringChanges[0].change === 'accept a range');
  check('what worked is collected too', themes.worked.includes('opened warmly'));

  const failed = await reviewCall({ async review() { throw new Error('down'); } }, { transcript: [] }, []);
  check('a reviewer that throws yields an absent opinion, never a failure', failed.available === false);
  check('no reviewer at all is a valid state', (await reviewCall(null, {}, [])).available === false);
  check('an unavailable review reports why', /review unavailable/.test(failed.biggestSingleChange));
}

console.info(`[Agent report] ${checks} checks passed: callers verbatim, blockers deterministic, `
  + 'blank grades not zero, different systems never compared.');
