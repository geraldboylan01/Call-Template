// A7 — ingest your grades and check the judge against them.
//
//   node ./scripts/apply-consumer-agent-grades.mjs agent-runs/call-*-grading.md --run=agent-runs/<run>.json
//
// FREE. No model calls. This reads a filled grading sheet, writes your grades
// into the archived run, and reports where the automated judge agreed with you
// and where it did not.
//
// That gap is the actionable output. Where the judge tracks you, its scores can
// stand in for yours on runs you have not graded. Where it does not, either its
// prompt needs work or -- more often, and more usefully -- it is right and the
// call was genuinely worse than it looked.

import { readFileSync, writeFileSync } from 'node:fs';

import { calibrate, describeCalibration, parseGradingSheet } from './agent-harness/grading.mjs';
import { compareRuns, loadRuns, regressionsIn, trendFor } from './agent-harness/runlog.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const sheetPath = args.find((arg) => !arg.startsWith('--'));
const runPath = flag('run', '');
const archiveDir = flag('archive', 'agent-runs');

if (!sheetPath || !runPath) {
  console.error('Usage: node ./scripts/apply-consumer-agent-grades.mjs <grading-sheet.md> --run=<run.json>');
  process.exit(1);
}

const grades = parseGradingSheet(readFileSync(sheetPath, 'utf8'));
const record = JSON.parse(readFileSync(runPath, 'utf8'));

const graded = grades.filter((grade) => grade.graded);
const ungraded = grades.filter((grade) => !grade.graded);

console.info(`[Grades] ${graded.length} of ${grades.length} call(s) graded`);
if (ungraded.length) {
  // Half-filled is reported as half-filled. A blank score is a score you did
  // not give, and scoring it as zero would poison every trend it entered.
  console.info(`[Grades] not graded: ${ungraded.map((grade) => grade.callId).join(', ')}`);
}

const byId = new Map(grades.map((grade) => [grade.callId, grade]));
for (const call of record.calls || []) {
  const grade = byId.get(call.callId);
  if (grade?.graded) call.humanGrade = { scores: grade.scores, mean: grade.mean, notes: grade.notes };
}

const humanMeans = (record.calls || [])
  .map((call) => call.humanGrade?.mean)
  .filter((value) => Number.isFinite(value));
record.metrics = record.metrics || {};
record.metrics.humanGradeMean = humanMeans.length
  ? Number((humanMeans.reduce((sum, value) => sum + value, 0) / humanMeans.length).toFixed(2))
  : null;

const calibration = calibrate(
  grades,
  (record.calls || []).map((call) => ({ callId: call.callId, mean: call.judge?.mean }))
);
record.calibration = calibration;
writeFileSync(runPath, `${JSON.stringify(record, null, 2)}\n`);

console.info(`\n[Grades] your mean grade: ${record.metrics.humanGradeMean ?? 'n/a'}`);
console.info(`[Grades] judge mean      : ${record.metrics.judgeGradeMean ?? 'n/a'}`);
console.info(`[Grades] ${describeCalibration(calibration)}`);
if (calibration.worstDisagreement) {
  const worst = calibration.worstDisagreement;
  console.info(`[Grades] widest gap: ${worst.callId} — you ${worst.human.toFixed(2)}, `
    + `judge ${worst.judge.toFixed(2)}${worst.notes ? ` — your note: "${worst.notes}"` : ''}`);
}

/* ------------------------------------------------------- trend & regression */

const runs = loadRuns({ dir: archiveDir });
const previous = runs.find((run) => run.runId !== record.runId && run.runKey === record.runKey);
const comparison = compareRuns(record, previous);

console.info(`\n[Trend] system key: ${record.runKey}`);
if (!comparison.comparable) {
  console.info(`[Trend] ${comparison.reason}`);
} else {
  const regressions = regressionsIn(comparison);
  const improvements = comparison.changes.filter((change) => change.improved);
  console.info(`[Trend] vs ${previous.runId}:`);
  for (const change of improvements) {
    console.info(`  ✓ ${change.label}: ${change.before} → ${change.now}`);
  }
  for (const change of regressions) {
    console.info(`  ✗ ${change.label}: ${change.before} → ${change.now}`);
  }
  if (!comparison.changes.length) console.info('  nothing moved');
}

const trend = trendFor(runs, record.runKey);
if (trend.runs > 2) {
  const series = trend.series.humanGradeMean;
  if (series.length > 1) {
    console.info(`\n[Trend] your grade over ${series.length} runs: `
      + series.map((point) => point.value).join(' → '));
  }
}

console.info(`\n[Grades] written back to ${runPath}`);
