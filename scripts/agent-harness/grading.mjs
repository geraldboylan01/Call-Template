/**
 * A7 — the human grading loop.
 *
 * YOUR GRADE IS THE GROUND TRUTH. The judge's is a guess at it.
 *
 * That ordering is the whole design. Deterministic detectors find mechanical
 * blockers, which are objective and cheap. But "was this a good call?" is a
 * judgement about your product, and the only person who can settle it is you.
 * So the loop is:
 *
 *   1. A call runs. Detectors flag blockers. The judge scores it.
 *   2. A grading sheet is written with the judge's scores LEFT BLANK for you.
 *      Blank, deliberately: seeing the judge's guess first would anchor you to
 *      it, and a grade anchored to the judge cannot be used to check the judge.
 *   3. You grade it and add a note in your own words.
 *   4. Ingesting your grades produces a CALIBRATION: where the judge agreed
 *      with you, and where it did not. That gap is the thing to fix -- in the
 *      judge's prompt when it is misreading, in the app when it is right and
 *      the call was genuinely poor.
 *
 * The grading sheet is markdown so it can be filled in anywhere, and parsed
 * strictly enough that a half-filled sheet is reported as half-filled rather
 * than quietly scored as zero.
 */

export const GRADE_DIMENSIONS = Object.freeze([
  { key: 'usefulness', prompt: 'Would this call have been worth the client\'s time?' },
  { key: 'tone', prompt: 'Did it sound like someone you would want representing you?' },
  { key: 'understanding', prompt: 'Did it understand what this person actually needed?' },
  { key: 'progress', prompt: 'Did it get somewhere, at a reasonable pace?' },
  // The output, not the conversation. A call can feel excellent and still hand
  // the client an analysis that could not run, or one built on figures it
  // guessed at -- and you are the only person who can say whether what came out
  // the end was actually any good.
  { key: 'output', prompt: 'Was the analysis it produced worth having?' }
]);

const SCALE = '1 = bad, 5 = good, or leave blank if you would rather not say';

/** One line on what the call actually produced, for the top of a grading block. */
function describeExecution(execution) {
  if (!execution || execution.status === 'not_attempted') return 'not run';
  if (execution.error) return `refused (${execution.error})`;
  if (execution.status === 'complete') {
    return `ran — ${(execution.completedModuleIds || []).join(', ') || 'none completed'}`;
  }
  const missing = (execution.missingForModules || [])
    .map((item) => item.factId || item.fieldPath)
    .filter(Boolean);
  return `${execution.status}${missing.length ? ` — still needed ${missing.join(', ')}` : ''}`;
}

export function buildGradingSheet({ runId, calls }) {
  const lines = [
    `# Grading sheet — ${runId}`,
    '',
    'Fill in a score after each `:` and write whatever you like in Notes.',
    `Scores are ${SCALE}.`,
    '',
    'The judge\'s own scores are deliberately not shown here. Seeing them first',
    'would anchor you to them, and a grade anchored to the judge cannot be used',
    'to check the judge.',
    ''
  ];
  for (const call of calls) {
    lines.push(
      `## ${call.callId}`,
      '',
      `Caller: ${call.caller}`,
      `Turns: ${call.turns}  ·  Blockers found: ${call.blockerCount}`,
      `Analyses: ${describeExecution(call.execution)}`,
      ...(call.langfuse?.traceUrl ? [`Langfuse trace: ${call.langfuse.traceUrl}`] : []),
      '',
      '<!-- transcript -->',
      ...(call.transcript || []).map((entry) => (
        `> **${entry.role === 'client' ? 'CLIENT' : 'PLANÉIR'}:** ${entry.text}`
      )),
      '',
      ...((call.execution?.results || []).length
        ? [
            '<!-- what the analyses produced -->',
            ...call.execution.results.map((item) => (
              `> **${item.moduleId}** (${item.status}): `
              + `${JSON.stringify(item.output).slice(0, 600)}`
            )),
            ''
          ]
        : []),
      ...GRADE_DIMENSIONS.map((dimension) => `- ${dimension.key}: `),
      '- Notes: ',
      ''
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Parse a filled sheet. A missing score is MISSING, never zero: a blank line
 * means you did not grade it, and recording that as the worst possible score
 * would poison every trend it entered.
 */
export function parseGradingSheet(markdown) {
  const calls = [];
  let current = null;
  for (const rawLine of String(markdown ?? '').split('\n')) {
    const heading = rawLine.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      if (current) calls.push(current);
      current = { callId: heading[1], scores: {}, notes: '' };
      continue;
    }
    if (!current) continue;
    const field = rawLine.match(/^-\s*([A-Za-z_]+)\s*:\s*(.*)$/);
    if (!field) continue;
    const key = field[1].toLowerCase();
    const value = field[2].trim();
    if (key === 'notes') {
      current.notes = value;
      continue;
    }
    if (!GRADE_DIMENSIONS.some((dimension) => dimension.key === key)) continue;
    if (value === '') continue;
    const numeric = Number(value);
    current.scores[key] = Number.isFinite(numeric)
      ? Math.min(5, Math.max(1, Math.round(numeric)))
      : null;
  }
  if (current) calls.push(current);
  return calls.map((call) => {
    const scored = Object.values(call.scores).filter((value) => Number.isFinite(value));
    return {
      ...call,
      mean: scored.length ? scored.reduce((sum, value) => sum + value, 0) / scored.length : null,
      graded: scored.length > 0
    };
  });
}

/**
 * Where the judge agreed with you and where it did not.
 *
 * Reported per call and in aggregate, with the judge's BIAS -- whether it runs
 * kinder or harsher than you -- because a judge that is consistently one point
 * generous is a judge you can still read, while one that disagrees at random is
 * one to stop paying for.
 */
export function calibrate(humanGrades, judgements) {
  const judgeById = new Map(judgements.map((item) => [item.callId, item]));
  const pairs = [];
  for (const grade of humanGrades) {
    if (!grade.graded) continue;
    const judged = judgeById.get(grade.callId);
    if (!judged || !Number.isFinite(judged.mean)) continue;
    pairs.push({
      callId: grade.callId,
      human: grade.mean,
      judge: judged.mean,
      gap: judged.mean - grade.mean,
      notes: grade.notes
    });
  }
  if (pairs.length === 0) {
    return { pairs: [], compared: 0, bias: null, meanAbsoluteGap: null, worstDisagreement: null };
  }
  const bias = pairs.reduce((sum, pair) => sum + pair.gap, 0) / pairs.length;
  const meanAbsoluteGap = pairs.reduce((sum, pair) => sum + Math.abs(pair.gap), 0) / pairs.length;
  const worstDisagreement = pairs.slice().sort(
    (left, right) => Math.abs(right.gap) - Math.abs(left.gap)
  )[0];
  return {
    pairs,
    compared: pairs.length,
    bias: Number(bias.toFixed(2)),
    meanAbsoluteGap: Number(meanAbsoluteGap.toFixed(2)),
    worstDisagreement
  };
}

/** Plain-English reading of a calibration, for the report. */
export function describeCalibration(calibration) {
  if (!calibration.compared) return 'Not enough graded calls yet to check the judge against you.';
  const direction = calibration.bias > 0.25
    ? `kinder than you by ${calibration.bias.toFixed(2)}`
    : calibration.bias < -0.25
      ? `harsher than you by ${Math.abs(calibration.bias).toFixed(2)}`
      : 'about level with you';
  const reliability = calibration.meanAbsoluteGap <= 0.5
    ? 'and tracks your judgement closely'
    : calibration.meanAbsoluteGap <= 1
      ? 'and roughly tracks your judgement'
      : 'but disagrees with you enough that its scores should not be trusted on their own';
  return `Across ${calibration.compared} graded call(s) the judge runs ${direction}, ${reliability}.`;
}
