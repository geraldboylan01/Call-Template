// Which planner reconciliation mode a production deployment may actually run.
//
// Shared by the fail-closed config builder in deploy-worker.yml and by the
// checks that cover it, so the rule is stated once. Deploy Worker #293 failed
// because the builder decided this from the requested live-voice toggle while
// the rest of the deployment resolved the lane from the Realtime canary too:
// the generated config said legacy, the safety check expected apply, and the
// build aborted. It was right to abort — apply had been claimed for a lane that
// was not going to be on.
//
// The rule, in order:
//   1. An unrecognised or missing mode is legacy. A typo never activates it.
//   2. The reconciler reads the transcript and notes a live turn produces, so it
//      cannot outrank the lane producing them: no live lane, no reconciliation.
//   3. The live lane is itself gated on the Realtime canary, so a deployment
//      with Realtime off can never reach apply however the variables are set.
//
// Turning it on therefore takes the protected production environment AND the
// Realtime canary AND live voice AND an explicit mode — no single variable, and
// no ordinary push, can enable it on its own.

const PLANNER_RECONCILIATION_MODES = Object.freeze(['legacy', 'shadow', 'apply']);

/** True when the value is one this deployment is allowed to run at all. */
function isPlannerReconciliationMode(value) {
  return PLANNER_RECONCILIATION_MODES.includes(String(value || '').trim());
}

/**
 * The mode the generated config must carry.
 *
 * `realtimeEnabled` and `liveVoiceRequested` are the deployment's resolved
 * Realtime canary and its CONSUMER_LIVE_VOICE_ENABLED toggle. Anything that is
 * not a recognised mode, or any lane that is not fully on, yields legacy.
 */
function resolvePlannerReconciliationMode({
  requestedMode,
  realtimeEnabled,
  liveVoiceRequested
} = {}) {
  const requested = String(requestedMode || '').trim() || 'legacy';
  if (!isPlannerReconciliationMode(requested)) return 'legacy';
  const liveVoiceEnabled = realtimeEnabled === true && liveVoiceRequested === true;
  return liveVoiceEnabled ? requested : 'legacy';
}

module.exports = {
  PLANNER_RECONCILIATION_MODES,
  isPlannerReconciliationMode,
  resolvePlannerReconciliationMode
};
