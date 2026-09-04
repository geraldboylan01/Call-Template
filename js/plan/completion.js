import { consumerLanguageForModule } from '../planning/module_offers.js';

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const array = (value) => Array.isArray(value) ? value : [];
const visible = (item) => Boolean(consumerLanguageForModule(String(item?.moduleId || item?.id || item?.module?.id || '')));
const terminal = (status) => ['complete', 'partial'].includes(String(status || ''));

// Rendering and completion must agree about what is actually displayable.
export function getDisplayableResultItems(analysis) {
  const root = object(analysis) || {};
  const nested = object(root.results);
  const candidates = [root.moduleRuns, root.moduleResults, root.modules,
    Array.isArray(root.results) ? root.results : null,
    nested?.moduleRuns, nested?.moduleResults, nested?.modules]
    .find((value) => value !== undefined && value !== null);
  if (Array.isArray(candidates)) return candidates.filter(visible);
  if (object(candidates)) {
    return Object.entries(candidates)
      .map(([moduleId, value]) => ({ moduleId, ...(object(value) || { value }) }))
      .filter(visible);
  }
  return (root.outputs || root.semanticResult || root.highlights || root.summary) && visible(root) ? [root] : [];
}

/** A terminal, current, displayable outcome. Stage/status alone prove nothing. */
export function describePlanningCompletion(payload, expectedExecution = null) {
  const state = object(payload?.data) || object(payload) || {};
  const plan = state.analysisPlan || null;
  const analysis = state.analysis || null;
  const expected = expectedExecution || state.realtimeExecution || null;
  const revision = Number(state.session?.currentProfileRevision ?? state.session?.profileRevision ?? state.profile?.revision ?? 0);
  const result = { ready: false, kind: null, planId: plan?.planId || null, analysisRunId: analysis?.id || analysis?.analysisRunId || null, profileRevision: revision };
  if (!(revision > 0)) return result;
  if (plan?.leaseId && Number(plan.profileRevision) === revision) {
    if (!terminal(plan.status)) return result;
    if (plan.analysisRunId && plan.analysisRunId !== result.analysisRunId) return result;
  }
  if (expected) {
    if (!expected.planId || Number(expected.profileRevision) !== revision || !terminal(expected.status)) return result;
    if (plan?.planId !== expected.planId || Number(plan?.profileRevision) !== revision || !terminal(plan?.status)) return result;
    if (expected.analysisRunId && result.analysisRunId !== expected.analysisRunId) return result;
    if (plan.analysisRunId && result.analysisRunId !== plan.analysisRunId) return result;
  }
  const items = getDisplayableResultItems(analysis);
  if (Number(analysis?.profileRevision) === revision && terminal(analysis?.status) && items.length > 0) {
    // A live execution cannot accidentally consume a previous run at the same revision.
    if (expected && (!expected.analysisRunId || expected.analysisRunId !== result.analysisRunId)) return result;
    return { ...result, ready: true, kind: 'analysis' };
  }
  const slots = array(plan?.moduleSlots);
  if (Number(plan?.profileRevision) === revision && plan?.status === 'complete'
    && array(plan?.moduleIds).length === 0 && !plan?.analysisRunId
    && slots.length >= 1 && slots.length <= 3
    && slots.every((slot) => slot?.availability === 'adviser_review_required' && typeof slot?.moduleId === 'string' && slot.moduleId)) {
    return { ...result, ready: true, kind: 'adviser_review', analysisRunId: null };
  }
  return result;
}
