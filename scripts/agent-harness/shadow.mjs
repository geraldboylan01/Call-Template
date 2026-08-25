/**
 * Apprentice mode — what the rules-based system WOULD have done.
 *
 * THIS FILE MAKES NO JUDGEMENTS. It records two decisions side by side and
 * states, mechanically, where they differ. Whether Gerald's move was better,
 * why he made it, and whether anything about it generalises are questions for
 * the coding agent that reads the bundle afterwards — see
 * docs/apprentice-mode.md. A heuristic that guessed at those answers here
 * would be worse than no answer, because it would look like one.
 *
 * WHY THE COMPARISON IS STRUCTURAL AND NOT SEMANTIC. The obvious thing to do
 * is parse Gerald's sentence and work out what he was asking about. That is
 * exactly what scripts/agent-harness/caller.mjs refuses to do to a pasted
 * caller, and for the same reason: any parse decides in advance which details
 * matter, and the ones it drops are the ones worth learning from. So the
 * divergence here is derived from things that are already deterministic —
 * which fact the engine was targeting, which facts actually landed afterwards,
 * which analyses were offered, which were run — and the prose is carried
 * through verbatim for a reader that can actually read it.
 *
 * COST. Everything in this file is free. The deterministic shadow reads state
 * the engine has already computed. The renderer shadow (--shadow=full) is the
 * one paid part and lives in the runner, not here; this module only records
 * what it returned.
 */

import {
  observedCanonicalFacts, observedDeterministicNeeds, observedNeeds, observedQuestion
} from './observability.mjs';

/**
 * The rule or manifest field responsible for a baseline decision.
 *
 * The bundle exists so an agent can fix the RIGHT LAYER, and it cannot do that
 * from the decision alone: "would have asked about the pension value" does not
 * say whether that came from the question plan, a module's required facts, or a
 * goal rule. Every baseline decision therefore carries its provenance.
 */
function provenanceFor(state = {}) {
  return {
    selectionPolicyVersion: state.selectionPolicyVersion || null,
    // Which modules put a fact on the critical path. A question the engine asks
    // is almost always some module's required input, and naming that module is
    // what points at docs/modules/<id>.md rather than at the prompt.
    blockingModuleIds: (state.meetingBrief?.questionBatch?.primaryFact?.moduleId
      ? [state.meetingBrief.questionBatch.primaryFact.moduleId]
      : (state.nextQuestion?.blockingModuleIds || [])).filter(Boolean),
    requiresDecisionTopicQuestion: state.requiresDecisionTopicQuestion === true,
    requiresGoalPriorityQuestion: state.requiresGoalPriorityQuestion === true
  };
}

/**
 * The deterministic baseline: what the engine would do next, and why.
 *
 * @param {object} context loadAgentContext() result — profile + state
 * @param {object} [options]
 * @param {string[]} [options.confirmationCandidateModuleIds] from
 *   resolveConfirmationCandidateModuleIds(), passed in rather than recomputed so
 *   the shadow and the real confirmation path can never drift apart.
 * @returns {object} the baseline decision, free of any model call
 */
export function deterministicShadow(context = {}, { confirmationCandidateModuleIds = [] } = {}) {
  const state = context?.state || {};
  return {
    tier: 'deterministic',
    question: observedQuestion(context),
    moduleSlots: (state.moduleSlots || []).map((slot) => ({
      moduleId: slot.moduleId || null,
      status: slot.status || null,
      goalType: slot.goalType || null
    })),
    goalAssessment: state.goalAssessment
      ? {
          activeGoalTypes: state.goalAssessment.activeGoalTypes || [],
          deferredGoalTypes: state.goalAssessment.deferredGoalTypes || []
        }
      : null,
    // What the engine would read out for confirmation if the call ended here.
    // This is the routing decision in its most answerable form: not "which
    // analyses exist" but "which would this person actually be offered".
    confirmationCandidateModuleIds: [...confirmationCandidateModuleIds],
    needs: {
      brief: observedNeeds(context),
      adapters: observedDeterministicNeeds(context)
    },
    facts: observedCanonicalFacts(context),
    provenance: provenanceFor(state)
  };
}

/**
 * The renderer's shadow — the words and the TOOL CHOICE.
 *
 * The tool choice is the reason this tier exists. Half the routing decision
 * lives in the deterministic planner and the other half in whether the model
 * calls confirm_and_run; a baseline that recorded only the first would show
 * agreement on turns where the two systems actually diverged.
 *
 * @param {object|null} rendered the renderAssistantText() result, or null when
 *   running --shadow=deterministic
 */
export function rendererShadow(rendered) {
  if (!rendered) return null;
  return {
    tier: 'full',
    text: rendered.text || null,
    fallback: rendered.fallback === true,
    toolCalls: (rendered.decisions || []).map((decision) => ({
      tool: decision.tool || null,
      args: decision.args ?? null,
      ok: decision.result?.ok ?? null,
      code: decision.result?.code || null
    }))
  };
}

const factKey = (fact) => (fact?.factInstanceId || fact?.factId || null);

/** Facts present after a turn that were not present before it. */
function newFactKeys(before = [], after = []) {
  const seen = new Set(before.map(factKey).filter(Boolean));
  return [...new Set(after.map(factKey).filter(Boolean).filter((key) => !seen.has(key)))];
}

/**
 * Where the baseline and the expert differ, stated mechanically.
 *
 * `sameTarget` is deliberately three-valued. `true` and `false` are claims the
 * data supports; `null` means the comparison could not be made — the engine had
 * no question queued, or Gerald's turn produced no facts to compare against.
 * Reporting an unknown as `false` would manufacture divergences, and a corpus
 * of manufactured divergences is worse than an empty one.
 *
 * @returns {object[]} zero or more divergences; an empty array is a turn where
 *   the expert and the rules agreed, which costs nothing downstream.
 */
export function divergencesFor({
  turn,
  shadow,
  expert,
  factsBefore = [],
  factsAfter = []
} = {}) {
  const found = [];
  const landed = newFactKeys(factsBefore, factsAfter);
  const wanted = factKey(shadow?.question);

  // 1. TOPIC. The engine had a fact queued; did the conversation move toward it?
  if (wanted) {
    const sameTarget = landed.length === 0 ? null : landed.includes(wanted);
    if (sameTarget === false) {
      found.push({
        turn,
        kind: 'question_target',
        baseline: {
          wouldHaveAsked: shadow.question.prompt || null,
          targetFact: wanted,
          reason: shadow.question.reason || null,
          blockingModuleIds: shadow.provenance?.blockingModuleIds || []
        },
        expert: { said: expert?.said || null, note: expert?.note || null },
        observed: { factsLanded: landed },
        sameTarget
      });
    }
  }

  // 2. ROUTING. Gerald ran an analysis the engine was not offering, or set a
  // scenario lever at all — the engine currently has no way to do the latter.
  for (const run of expert?.runs || []) {
    const offered = (shadow?.confirmationCandidateModuleIds || []).includes(run.moduleId);
    const usedLevers = Object.keys(run.scenarioOverrides || {}).length > 0;
    if (!offered || usedLevers) {
      found.push({
        turn,
        kind: usedLevers ? 'scenario_construction' : 'analysis_run',
        baseline: {
          wouldHaveOffered: shadow?.confirmationCandidateModuleIds || [],
          moduleSlots: shadow?.moduleSlots || []
        },
        expert: {
          moduleId: run.moduleId,
          scenarioOverrides: run.scenarioOverrides || {},
          note: expert?.note || null
        },
        observed: { offered, usedLevers },
        sameTarget: offered && !usedLevers
      });
    }
  }

  // 3. FACT CAPTURE. Gerald corrected what the engine heard. A /fix is always a
  // divergence: he would not have typed it if the record were right.
  for (const fix of expert?.fixes || []) {
    found.push({
      turn,
      kind: 'fact_capture',
      baseline: { captured: landed, extractionOutcomes: expert?.extractionOutcomes || [] },
      expert: { correction: fix, note: expert?.note || null },
      observed: { factsLanded: landed },
      sameTarget: false
    });
  }

  // 4. TOOL CHOICE, only when the renderer shadow was recorded.
  const shadowRan = (shadow?.renderer?.toolCalls || []).some((call) => call.tool === 'confirm_and_run');
  const expertRan = (expert?.runs || []).length > 0;
  if (shadow?.renderer && shadowRan !== expertRan) {
    found.push({
      turn,
      kind: 'run_timing',
      baseline: { wouldHaveRun: shadowRan, said: shadow.renderer.text },
      expert: { ran: expertRan, said: expert?.said || null, note: expert?.note || null },
      observed: { toolCalls: shadow.renderer.toolCalls },
      sameTarget: false
    });
  }

  return found;
}

/** Counts for the run log. A turn with no divergence is the goal, not a gap. */
export function summariseDivergences(divergences = []) {
  const byKind = {};
  for (const item of divergences) byKind[item.kind] = (byKind[item.kind] || 0) + 1;
  return { total: divergences.length, byKind };
}
