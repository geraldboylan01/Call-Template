import { classifySpokenPlanConfirmation } from '../realtime_completion.js';

/**
 * The single affirmation component for untrusted save_facts evidence binding.
 * Phase 1 preserves its observable behavior. Later semantic resolution belongs
 * to the existing detached planner/reconciler, never a synchronous model call
 * on this boundary.
 *
 * Numeric anti-forgery permanently lives in BOTH structural checks at the
 * caller: the figure was client-sourced AND occurs in the immediately preceding
 * assistant turn. Neither this implementation nor a future semantic affirmation
 * test may relax those checks or the categorical-none/identity propositions.
 */
export function classifyEvidenceAffirmation(value) {
  return classifySpokenPlanConfirmation(value);
}
