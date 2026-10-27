import { followsRoute } from './plan_story_model.js';

/**
 * OPENING A STORY LINK.
 *
 * The story decides nothing about where a link goes: the target (module, case,
 * figure) was worked out by code from the fact the figure came from. This file
 * is the hand-off to the app, written against a small list of things the app can
 * do, so it can be proved without a browser and wired to app.js in one place.
 *
 * What the app supplies:
 *   findModule(chapter)            -> the session's module for that chapter, or null
 *   setCase(moduleId, caseId)      -> true when the module is now on that case
 *   currentCase(moduleId)          -> the case the module shows now
 *   openModule(moduleId)           -> brings the module up full size
 *   outline(moduleId, focusTargetId, figureText) -> outlines the figure once; true if it could
 *   openPanel(panelId)             -> opens a panel of the plan view itself
 *
 * The case is set before the module opens, so it never shows the wrong case for
 * a moment; the figure is outlined last, once it is on screen.
 */

export const PLAN_STORY_CASE_BRIDGES = Object.freeze({
  mortgage_analysis: 'Mortgage',
  loan_analysis: 'Mortgage',
  household_cash_flow: 'HouseholdCashFlow',
  protection_gap: 'ProtectionGap',
  future_cost_fund: 'FutureCostFund',
  personal_balance_sheet: 'Pbs',
  pension_projection: 'Pension',
  net_retirement_cashflow: 'NetRetirement'
});

/**
 * `target` is what a link carries: { chapter, panel, caseId, focusTargetId, figureKey, figureText }.
 * Returns what happened, so the caller can show the Back pill or say why not.
 */
export async function openStoryLink(target, deps, { routeId = null } = {}) {
  if (target.panel && !target.chapter) {
    await deps.openPanel(target.panel);
    return { opened: true, panel: target.panel, moduleId: null, caseId: null, outlined: false, routeId };
  }
  const moduleId = deps.findModule(target.chapter);
  if (!moduleId) return { opened: false, reason: 'module_missing', chapter: target.chapter, routeId };

  let caseId = null;
  if (target.caseId) {
    const set = await deps.setCase(moduleId, target.caseId);
    if (!set) return { opened: false, reason: 'case_missing', chapter: target.chapter, caseId: target.caseId, routeId };
    caseId = target.caseId;
  } else {
    caseId = deps.currentCase?.(moduleId) ?? null;
  }

  await deps.openModule(moduleId);
  const outlined = target.focusTargetId || target.figureText
    ? Boolean(await deps.outline(moduleId, target.focusTargetId ?? null, target.figureText ?? null))
    : false;
  return { opened: true, moduleId, caseId, outlined, routeId };
}

/**
 * Is the module still on the route's case? When it is not, the screen shows
 * "This screen no longer follows the route" with "Back to the route".
 */
export function evaluateOffRoute({ target, currentCaseId, caseTitles = {} }) {
  if (followsRoute(target, currentCaseId)) return { offRoute: false };
  return {
    offRoute: true,
    caseWas: caseTitles[target.caseId] ?? target.caseId,
    caseNow: caseTitles[currentCaseId] ?? currentCaseId
  };
}

/** "Back to the route": put the module back on the case the link opened. */
export async function backToRoute(target, moduleId, deps) {
  if (!target.caseId) return true;
  return Boolean(await deps.setCase(moduleId, target.caseId));
}
