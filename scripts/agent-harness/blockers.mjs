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

/** Detectors run against the turns so far, after each turn. */
const DETECTORS = [
  {
    id: 'repeated_question',
    severity: 'blocking',
    detect(turns) {
      const asked = turns.map((turn) => turn.questionFactId).filter(Boolean);
      const findings = [];
      for (const factId of new Set(asked)) {
        const at = asked.map((value, index) => (value === factId ? index + 1 : null)).filter(Boolean);
        if (at.length >= 3) {
          findings.push({
            detail: `asked for ${factId} ${at.length} times (turns ${at.join(', ')})`,
            turn: at[at.length - 1],
            factId
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
        if (turn.questionFactId && answered.has(turn.questionFactId)) {
          findings.push({
            detail: `asked for ${turn.questionFactId} after the client had already answered it`,
            turn: index + 1,
            factId: turn.questionFactId
          });
        }
        for (const factId of turn.acceptedFactIds || []) answered.add(factId);
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

export function summariseBlockers(findings) {
  const bySeverity = { blocking: 0, friction: 0, smell: 0 };
  const byId = {};
  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
    byId[finding.id] = (byId[finding.id] || 0) + 1;
  }
  return { total: findings.length, bySeverity, byId };
}
