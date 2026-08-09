/**
 * A7 — conversational blocker detection.
 *
 * DETERMINISTIC, FREE, AND THE BACKBONE OF THE FEEDBACK LOOP.
 *
 * These are the failures that have actually shown up in live calls: the meeting
 * asking the same thing four times; asking for something the client already
 * answered; asking for a figure they just said they do not have; ending with no
 * goal; a silent planner error the client experiences as a non-sequitur.
 *
 * They are detected from the turn record, which means they are found WITHOUT a
 * model, without cost, and identically on every run. A model's read of a
 * transcript is a useful second opinion (see agent-judges/review.mjs) but it
 * cannot be the primary detector: it would find different things each time, and
 * a blocker you cannot reproduce is a blocker you cannot fix.
 *
 * Severity is about the client's experience, not about internals:
 *   blocking — the call cannot achieve its purpose in this state
 *   friction — the client notices something is wrong
 *   smell    — worth a look; may be legitimate
 */

function questionInstance(turn) {
  return turn?.questionFactInstanceId
    || turn?.observation?.question?.factInstanceId
    || turn?.questionFactId
    || null;
}

function candidateRows(turn) {
  return turn?.observation?.extraction?.candidates || [];
}

function sameTarget(item, factId, factInstanceId) {
  if (factInstanceId && item?.factInstanceId) return item.factInstanceId === factInstanceId;
  return item?.factId === factId;
}

export const MISSING_INPUT_CAUSES = Object.freeze([
  'never_asked',
  'asked_but_unanswered',
  'stated_but_never_extracted',
  'stated_but_rejected',
  'extracted_but_not_persisted',
  'persisted_but_not_used',
  'explicit_unknown',
  'wrong_owner_capture',
  'stale_reconciliation',
  'expected_correction_missed'
]);

/**
 * Classify a missing module input at the earliest observable broken layer.
 *
 * Transcript semantics that require an answer key are accepted as explicit
 * observation markers from a scorer; the detector never guesses that a phrase
 * means a fact. Everything else follows deterministic question/candidate/state
 * records from the versioned turn archive.
 */
export function classifyMissingInput(missing = {}, turns = []) {
  const factId = missing.factId || null;
  const factInstanceId = missing.factInstanceId || null;
  const explicitMarker = turns.flatMap((turn) => turn?.observation?.diagnosticMarkers || [])
    .find((item) => sameTarget(item, factId, factInstanceId));
  if (explicitMarker && MISSING_INPUT_CAUSES.includes(explicitMarker.cause)) {
    return { cause: explicitMarker.cause, turn: explicitMarker.turn || null };
  }
  const candidates = turns.flatMap((turn, index) => candidateRows(turn).map((item) => ({
    ...item, turn: index + 1
  }))).filter((item) => sameTarget(item, factId, factInstanceId));
  const unknown = candidates.find((item) => item.certainty === 'unknown');
  if (unknown) return { cause: 'explicit_unknown', turn: unknown.turn };
  const rejected = candidates.find((item) => item.accepted === false && item.rejectionCode);
  if (rejected) {
    return { cause: 'stated_but_rejected', turn: rejected.turn, rejectionCode: rejected.rejectionCode };
  }
  const accepted = candidates.find((item) => item.accepted === true);
  const lastFacts = turns.at(-1)?.observation?.canonicalFactsAfter || [];
  const persisted = lastFacts.some((item) => sameTarget(item, factId, factInstanceId));
  if (accepted && !persisted) return { cause: 'extracted_but_not_persisted', turn: accepted.turn };
  if (persisted) return { cause: 'persisted_but_not_used', turn: turns.length };
  const askedAt = turns
    .map((turn, index) => (questionInstance(turn) === (factInstanceId || factId) ? index + 1 : null))
    .filter(Boolean);
  return askedAt.length
    ? { cause: 'asked_but_unanswered', turn: askedAt.at(-1), askedAt }
    : { cause: 'never_asked', turn: null, askedAt: [] };
}

/** Detectors run against the turns so far, after each turn. */
const DETECTORS = [
  {
    id: 'repeated_question',
    severity: 'blocking',
    detect(turns) {
      const asked = turns.map(questionInstance).filter(Boolean);
      const findings = [];
      for (const factInstanceId of new Set(asked)) {
        const at = turns.map((turn, index) => (
          questionInstance(turn) === factInstanceId ? index + 1 : null
        )).filter(Boolean);
        if (at.length >= 3) {
          const factId = turns[at[0] - 1]?.questionFactId
            || turns[at[0] - 1]?.observation?.question?.factId
            || factInstanceId;
          findings.push({
            detail: `asked for ${factInstanceId} ${at.length} times (turns ${at.join(', ')})`,
            turn: at[at.length - 1],
            factId,
            factInstanceId
          });
        }
      }
      return findings;
    }
  },
  {
    id: 'asked_again_after_answering',
    severity: 'friction',
    detect(turns) {
      const findings = [];
      const answered = new Set();
      for (const [index, turn] of turns.entries()) {
        const question = questionInstance(turn);
        if (question && answered.has(question)) {
          findings.push({
            detail: `asked for ${question} after the client had already answered it`,
            turn: index + 1,
            factId: turn.questionFactId,
            factInstanceId: question
          });
        }
        for (const factInstanceId of turn.acceptedFactInstanceIds || []) answered.add(factInstanceId);
        // Legacy archives did not retain instance identity.
        if (!(turn.acceptedFactInstanceIds || []).length) {
          for (const factId of turn.acceptedFactIds || []) answered.add(factId);
        }
      }
      return findings;
    }
  },
  {
    id: 'no_question_left',
    severity: 'blocking',
    detect(turns) {
      return turns.flatMap((turn, index) => (turn.questionFactId || turn.analyses?.length
        ? []
        : [{ detail: 'the turn left the client with nothing to answer and no analysis', turn: index + 1 }]));
    }
  },
  {
    id: 'planner_error',
    severity: 'blocking',
    detect(turns) {
      return turns.flatMap((turn, index) => (turn.plannerErrorCode
        ? [{ detail: `planner failed: ${turn.plannerErrorCode}`, turn: index + 1 }]
        : []));
    }
  },
  {
    id: 'degraded_turn',
    severity: 'friction',
    detect(turns) {
      return turns.flatMap((turn, index) => (turn.degraded
        ? [{ detail: 'the turn ran on the deterministic fallback, not the planner', turn: index + 1 }]
        : []));
    }
  },
  {
    id: 'facts_rejected',
    severity: 'friction',
    detect(turns) {
      return turns.flatMap((turn, index) => ((turn.rejectedFactIds || []).length
        ? [{
            detail: `the client said something the engine would not record: ${turn.rejectedFactIds.join(', ')}`,
            turn: index + 1
          }]
        : []));
    }
  },
  {
    id: 'no_goal_captured',
    severity: 'blocking',
    detect(turns) {
      const last = turns.at(-1);
      if (!last || turns.length < 3) return [];
      return (last.goals || []).length === 0
        ? [{ detail: `${turns.length} turns in and the call still has no goal`, turn: turns.length }]
        : [];
    }
  },
  {
    id: 'no_analysis_selected',
    severity: 'smell',
    detect(turns) {
      const last = turns.at(-1);
      if (!last || turns.length < 4) return [];
      return (last.analyses || []).length === 0
        ? [{ detail: `${turns.length} turns in and no analysis is selected`, turn: turns.length }]
        : [];
    }
  },
  {
    id: 'goal_lost',
    severity: 'blocking',
    detect(turns) {
      const findings = [];
      for (let index = 1; index < turns.length; index += 1) {
        const before = new Set(turns[index - 1].goals || []);
        const after = new Set(turns[index].goals || []);
        const dropped = [...before].filter((goal) => !after.has(goal));
        if (dropped.length) {
          findings.push({
            detail: `goal ${dropped.join(', ')} was captured and then disappeared`,
            turn: index + 1
          });
        }
      }
      return findings;
    }
  },
  {
    id: 'analysis_lost',
    severity: 'friction',
    detect(turns) {
      const findings = [];
      for (let index = 1; index < turns.length; index += 1) {
        const before = new Set(turns[index - 1].analyses || []);
        const after = new Set(turns[index].analyses || []);
        const dropped = [...before].filter((moduleId) => !after.has(moduleId));
        // A drop is legitimate when an essential input is missing -- that is the
        // designed behaviour -- so this is reported for a look, not as a fault.
        if (dropped.length) {
          findings.push({ detail: `analysis ${dropped.join(', ')} left the plan`, turn: index + 1 });
        }
      }
      return findings;
    }
  },
  {
    id: 'stalled_progress',
    severity: 'blocking',
    detect(turns) {
      // Three consecutive turns that changed nothing the client would notice.
      const signature = (turn) => JSON.stringify([turn.goals, turn.analyses, turn.factIds]);
      let run = 1;
      for (let index = 1; index < turns.length; index += 1) {
        run = signature(turns[index]) === signature(turns[index - 1]) ? run + 1 : 1;
        if (run === 3) {
          return [{ detail: 'three turns in a row changed nothing in the plan', turn: index + 1 }];
        }
      }
      return [];
    }
  }
];

export const BLOCKER_IDS = Object.freeze(DETECTORS.map((detector) => detector.id));

/**
 * Findings for a call, in the order they first became visible.
 *
 * @param {Array<object>} turns comparable turn records
 * @returns {Array<{id: string, severity: string, detail: string, turn: number}>}
 */
export function detectBlockers(turns = []) {
  const findings = DETECTORS.flatMap((detector) => (
    detector.detect(turns).map((finding) => ({
      id: detector.id, severity: detector.severity, ...finding
    }))
  ));
  const rank = { blocking: 0, friction: 1, smell: 2 };
  return findings.sort((left, right) => (
    rank[left.severity] - rank[right.severity] || left.turn - right.turn
  ));
}

/**
 * The same detectors, run after each turn, so a blocker is visible AS THE CALL
 * HAPPENS rather than only in the post-mortem. This is what lets a run stop
 * early instead of burning ten more turns going nowhere.
 *
 * @returns {Array<object>} findings that are new as of this turn
 */
export function newBlockersAfterTurn(turns, alreadySeen = new Set()) {
  return detectBlockers(turns).filter((finding) => {
    const key = `${finding.id}:${finding.detail}`;
    if (alreadySeen.has(key)) return false;
    alreadySeen.add(key);
    return true;
  });
}

/** True when the call is not worth continuing. */
export function shouldAbandon(findings) {
  return findings.some((finding) => (
    finding.severity === 'blocking'
    && ['repeated_question', 'stalled_progress', 'planner_error'].includes(finding.id)
  ));
}

/**
 * Findings about the END of the call: whether the analyses the meeting promised
 * could actually run.
 *
 * This is the sharpest signal the harness produces. A call can feel perfect and
 * still fail here, because feeling perfect and having gathered enough to run a
 * pension projection are different things. When it fails, the required
 * questions name exactly which fact each analysis was short of -- which is a
 * work list, not a complaint.
 *
 * @param {object|null} execution from runAgentScenario({confirmAndRun: true})
 * @param {number} atTurn the turn the call ended on, for ordering
 * @param {Array<object>} turns versioned turn observations, when available
 */
export function detectExecutionBlockers(execution, atTurn = 0, turns = []) {
  if (!execution) return [];
  const findings = [];
  if (execution.error) {
    // A refusal is not automatically a fault: an unanswered priority question
    // or a goal with no released analysis are both correct refusals. They are
    // reported so a person can tell the difference.
    const expected = ['goal_priority_required', 'analysis_plan_empty'];
    findings.push({
      id: 'analysis_refused',
      severity: expected.includes(execution.error) ? 'smell' : 'blocking',
      detail: `the plan would not run: ${execution.error}`,
      turn: atTurn
    });
    return findings;
  }
  const missingRows = execution.missingForModules || [];
  const missingClassifications = missingRows.map((missing) => classifyMissingInput(missing, turns));
  const unavailableOnly = missingClassifications.length > 0
    && missingClassifications.every((item) => item.cause === 'explicit_unknown');
  if (execution.status !== 'complete') {
    findings.push({
      id: 'analysis_did_not_run',
      // An analysis that truthfully stops on a fact the client does not have is
      // a legitimate limitation, not an application failure. It remains
      // visible for review, while deterministic capture/persistence failures
      // continue to block the run.
      severity: unavailableOnly ? 'smell' : 'blocking',
      detail: `the call promised ${(execution.moduleIds || []).length} analysis/analyses `
        + `but finished as "${execution.status}"${unavailableOnly ? ' because the client did not know an essential input' : ''}`,
      turn: atTurn
    });
  }
  for (const [index, missing] of missingRows.entries()) {
    const classification = missingClassifications[index];
    const explanation = {
      never_asked: 'the call never asked for it',
      asked_but_unanswered: 'the call asked, but did not obtain an answer',
      stated_but_never_extracted: 'the client stated it, but the planner never extracted it',
      stated_but_rejected: `the client stated it, but the write was rejected${classification.rejectionCode ? ` (${classification.rejectionCode})` : ''}`,
      extracted_but_not_persisted: 'the planner extracted it, but it did not persist',
      persisted_but_not_used: 'it was persisted, but the module did not use it',
      explicit_unknown: 'the client explicitly did not know it',
      wrong_owner_capture: 'it was captured for the wrong owner',
      stale_reconciliation: 'the latest transcript was not reconciled before readiness was checked',
      expected_correction_missed: 'a stated correction was not applied'
    }[classification.cause];
    findings.push({
      id: 'analysis_missing_input',
      severity: classification.cause === 'explicit_unknown' ? 'smell' : 'blocking',
      detail: `${(missing.moduleIds || []).join(', ') || 'an analysis'} still needed `
        + `${missing.factInstanceId || missing.factId || missing.fieldPath} — ${explanation}`,
      turn: atTurn,
      factId: missing.factId,
      factInstanceId: missing.factInstanceId || null,
      entityId: missing.entityId || null,
      ownerId: missing.ownerId || null,
      cause: classification.cause,
      causeTurn: classification.turn
    });
  }
  for (const moduleId of execution.gatedModuleIds || []) {
    findings.push({
      id: 'analysis_gated',
      severity: 'smell',
      detail: `${moduleId} was selected but is not released for automated calculation`,
      turn: atTurn
    });
  }
  return findings;
}

export function summariseBlockers(findings) {
  const bySeverity = { blocking: 0, friction: 0, smell: 0 };
  const byId = {};
  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
    byId[finding.id] = (byId[finding.id] || 0) + 1;
  }
  return { total: findings.length, bySeverity, byId };
}
