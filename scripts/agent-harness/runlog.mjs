/**
 * A7 — the run archive: trends, regression detection and retention.
 *
 * A single call tells you what happened once. The archive is what turns that
 * into a feedback loop: the same personas, run again after a change, compared
 * against what they did before.
 *
 * RUNS ARE KEYED BY WHAT COULD HAVE CHANGED THE ANSWER. Prompt version, toolset
 * version, goal-routing policy version, manifest version, planner model, and the
 * released module set. Two runs with different keys are not a regression, they
 * are a different system -- and saying so is the difference between a useful
 * comparison and a misleading one.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_ARCHIVE_DIR = 'agent-runs';

/** The versions that make two runs comparable. */
export function runKey({ config = {}, releasedModuleIds = '', manifestVersion = '' } = {}) {
  return [
    `prompt=${config.realtimePromptVersion || 'none'}`,
    `toolset=${config.realtimeToolsetVersion || 'none'}`,
    `planner=${config.realtimePlannerModel || 'none'}`,
    `manifest=${manifestVersion || 'none'}`,
    `modules=${releasedModuleIds || 'none'}`
  ].join(' ');
}

export function saveRun(record, { dir = DEFAULT_ARCHIVE_DIR } = {}) {
  mkdirSync(dir, { recursive: true });
  const stamp = (record.generatedAt || new Date().toISOString()).replace(/[:.]/g, '-');
  const path = join(dir, `${stamp}-${record.runId || 'run'}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function loadRuns({ dir = DEFAULT_ARCHIVE_DIR, limit = 50 } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => {
      try {
        return { path: join(dir, name), ...JSON.parse(readFileSync(join(dir, name), 'utf8')) };
      } catch {
        // A corrupt archive entry must not take down the report.
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * The metrics a trend is drawn over. Each carries the direction that counts as
 * BETTER, because "blockers went up" and "goals captured went up" are not the
 * same news and a report that cannot tell them apart is worse than none.
 */
export const TREND_METRICS = Object.freeze([
  { key: 'blockingFindings', label: 'blocking findings', better: 'lower' },
  { key: 'frictionFindings', label: 'friction findings', better: 'lower' },
  { key: 'repeatedQuestions', label: 'repeated questions', better: 'lower' },
  { key: 'turnsToGoal', label: 'turns to first goal', better: 'lower' },
  { key: 'goalCaptureRate', label: 'calls that captured a goal', better: 'higher' },
  { key: 'analysisSelectionRate', label: 'calls that selected an analysis', better: 'higher' },
  { key: 'humanGradeMean', label: 'your grade', better: 'higher' },
  { key: 'judgeGradeMean', label: 'judge grade', better: 'higher' }
]);

const DIRECTION = Object.fromEntries(TREND_METRICS.map((metric) => [metric.key, metric.better]));

/**
 * Compare two runs. Only comparable runs produce a verdict.
 *
 * @returns {{comparable: boolean, reason?: string, changes: Array<object>}}
 */
export function compareRuns(current, previous, { minChange = 0.0001 } = {}) {
  if (!previous) return { comparable: false, reason: 'no earlier run to compare against', changes: [] };
  if (current.runKey !== previous.runKey) {
    return {
      comparable: false,
      reason: `different system: "${previous.runKey}" then "${current.runKey}"`,
      changes: []
    };
  }
  const changes = [];
  for (const metric of TREND_METRICS) {
    const now = current.metrics?.[metric.key];
    const before = previous.metrics?.[metric.key];
    if (!Number.isFinite(now) || !Number.isFinite(before)) continue;
    const delta = now - before;
    if (Math.abs(delta) < minChange) continue;
    const improved = DIRECTION[metric.key] === 'lower' ? delta < 0 : delta > 0;
    changes.push({
      key: metric.key, label: metric.label, before, now, delta, improved
    });
  }
  return { comparable: true, changes };
}

/** Regressions only: the changes that went the wrong way. */
export function regressionsIn(comparison) {
  return comparison.comparable ? comparison.changes.filter((change) => !change.improved) : [];
}

/**
 * A trend line per metric across the archive, newest last.
 * Runs from a different system are excluded rather than silently averaged in.
 */
export function trendFor(runs, key) {
  const comparable = runs.filter((run) => run.runKey === key).reverse();
  const series = {};
  for (const metric of TREND_METRICS) {
    series[metric.key] = comparable
      .map((run) => ({ at: run.generatedAt, value: run.metrics?.[metric.key] }))
      .filter((point) => Number.isFinite(point.value));
  }
  return { key, runs: comparable.length, series };
}

/**
 * Retention. Transcripts are a person's financial circumstances -- synthetic
 * here, but the shape is the same -- so the archive prunes by age, and prunes
 * the transcript body before it prunes the metrics: the numbers stay useful for
 * a trend long after the words should have gone.
 */
export function applyRetention({
  dir = DEFAULT_ARCHIVE_DIR,
  transcriptDays = 30,
  runDays = 365,
  now = Date.now()
} = {}) {
  if (!existsSync(dir)) return { transcriptsCleared: 0, runsDeleted: 0 };
  let transcriptsCleared = 0;
  let runsDeleted = 0;
  for (const name of readdirSync(dir).filter((item) => item.endsWith('.json'))) {
    const path = join(dir, name);
    const ageDays = (now - statSync(path).mtimeMs) / 86_400_000;
    if (ageDays > runDays) {
      rmSync(path);
      runsDeleted += 1;
      continue;
    }
    if (ageDays > transcriptDays) {
      let record;
      try {
        record = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        continue;
      }
      let changed = false;
      for (const call of record.calls || []) {
        if (call.transcript?.length) {
          call.transcript = [];
          call.transcriptCleared = true;
          changed = true;
        }
      }
      if (changed) {
        writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
        transcriptsCleared += 1;
      }
    }
  }
  return { transcriptsCleared, runsDeleted };
}
