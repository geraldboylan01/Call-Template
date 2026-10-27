import { buildPlanStoryScreen } from './plan_story_session.js';
import {
  buildBackToStoryPill,
  buildOffRouteNote,
  buildPlanStoryPage,
  buildStoryModulesSwitch,
  returnToParagraph,
  revealSelectedRoute
} from './plan_story_view.js';
import { PLAN_STORY_CASE_BRIDGES, backToRoute, evaluateOffRoute, openStoryLink } from './plan_story_links.js';
import { clearOutline, outlineFigure } from './plan_story_outline.js';

/**
 * THE STORY ON THE OVERVIEW SCREEN.
 *
 * A session built through the form carries a `planStory`. This draws it above
 * the module grid, behind a Story | Modules switch, and opens the real modules
 * from its links. It owns no figures and no module code: a link is handed to
 * `openStoryLink` (plan_story_links.js), which sets the module's case through
 * the bridges the app already has, opens the module full size and rings the
 * figure; coming back scrolls to the paragraph the link was in.
 *
 * A session without a story gets none of this: every call below returns at once.
 *
 * What the app supplies (`app`):
 *   getSession(), getMode(), getActiveModuleId()
 *   openModule(moduleId)   -> shows the module full size, not animated
 *   showOverview()         -> back to the overview, not animated
 *   refreshOverview()      -> draws the overview again
 *   save()                 -> remember the session changed
 *   toast(message, kind)
 */

const BAR_HEIGHT = 64;

const bridgeNames = (chapter) => {
  const name = PLAN_STORY_CASE_BRIDGES[chapter];
  return name ? { set: `__set${name}Scenario`, get: `__get${name}ScenarioForModule` } : null;
};

export function createPlanStoryController({ ui, app }) {
  let view = 'story';
  let bar = null;
  let host = null;
  let focusBar = null;
  let drawn = null; // { planStory, routeId, page }
  let open = null; // { target, moduleId, context, routeId }
  let pendingReturn = null;
  let busy = false;

  const session = () => app.getSession();
  const planStoryOf = () => session()?.planStory || null;
  const viewport = () => ui.overviewViewport;

  function chapterOfModule(moduleId) {
    const map = planStoryOf()?.chapterModules || {};
    return Object.keys(map).find((chapter) => map[chapter] === moduleId) || null;
  }

  function currentCase(moduleId) {
    const names = bridgeNames(chapterOfModule(moduleId));
    return names && typeof window[names.get] === 'function' ? (window[names.get](moduleId) ?? null) : null;
  }

  function scenarioControl() {
    return [...ui.swipeStage.querySelectorAll('*')].find((node) => typeof node.presenterSelectScenario === 'function') || null;
  }

  function isFocusedOn(moduleId) {
    return app.getMode() === 'focused' && app.getActiveModuleId() === moduleId;
  }

  async function setCase(moduleId, caseId) {
    const names = bridgeNames(chapterOfModule(moduleId));
    if (!names) return false;
    // A module already on screen moves its own figures through its own control; one that is not
    // yet open remembers the case and is drawn on it.
    const control = isFocusedOn(moduleId) ? scenarioControl() : null;
    try {
      if (control) await control.presenterSelectScenario(caseId);
      else if (typeof window[names.set] === 'function') await window[names.set](moduleId, caseId);
    } catch (_error) {
      return false;
    }
    return currentCase(moduleId) === caseId;
  }

  function makeDeps(target) {
    return {
      findModule: (chapter) => {
        const id = planStoryOf()?.chapterModules?.[chapter];
        return id && session().modules.some((module) => module.id === id) ? id : null;
      },
      setCase,
      currentCase,
      openModule: (moduleId) => app.openModule(moduleId),
      // Nothing to ring if the module did not open (the app ignores an open while a transition is running).
      outline: (_moduleId, _focusTargetId, figureText) => (app.getMode() !== 'focused' ? false : outlineFigure(ui.focusLayer, {
        selector: target.outlineSelector || null,
        text: target.outlineText || figureText || null
      })),
      openPanel: async () => { app.toast('That part of the plan is not on this screen yet.', 'error'); }
    };
  }

  function titles(chapter) {
    const planStory = planStoryOf();
    const screen = planStory ? buildPlanStoryScreen(planStory, session(), open?.routeId) : null;
    return {
      module: screen?.catalogue.chapters[chapter]?.title || 'this module',
      cases: screen?.catalogue.cases[chapter] || {}
    };
  }

  async function openLink(target, context) {
    const planStory = planStoryOf();
    if (!planStory || busy) return;
    busy = true;
    try {
      clearOutline();
      const routeId = planStory.selectedRouteId;
      const result = await openStoryLink(target, makeDeps(target), { routeId });
      if (!result.opened) {
        const { module } = titles(result.chapter);
        app.toast(result.reason === 'case_missing'
          ? `That case is not available in ${module}.`
          : `${module} is not part of this plan.`, 'error');
        return;
      }
      if (result.panel) return;
      if (app.getMode() !== 'focused') return;
      open = { target, moduleId: result.moduleId, context, routeId };
      syncChrome();
    } finally {
      busy = false;
    }
  }

  function selectRoute(routeId) {
    const planStory = planStoryOf();
    if (!planStory || planStory.selectedRouteId === routeId || !planStory.routes.some((route) => route.id === routeId)) return;
    planStory.selectedRouteId = routeId;
    app.save();
    drawn = null;
    app.refreshOverview();
    viewport().scrollTop = 0;
  }

  function ensureElements() {
    if (bar && host && bar.isConnected && host.isConnected) return;
    bar = document.createElement('div');
    bar.id = 'planStoryBar';
    bar.className = 'ps-bar';
    host = document.createElement('div');
    host.id = 'planStoryHost';
    host.className = 'ps-host';
    viewport().insertBefore(bar, ui.overviewZoomWrap);
    viewport().insertBefore(host, ui.overviewZoomWrap);
    drawn = null;
  }

  function drawBar() {
    bar.replaceChildren(buildStoryModulesSwitch({
      active: view,
      onChange: (next) => { view = next; app.refreshOverview(); }
    }));
  }

  function drawStory(planStory) {
    if (drawn && drawn.planStory === planStory && drawn.routeId === planStory.selectedRouteId && drawn.page.isConnected) return;
    const screen = buildPlanStoryScreen(planStory, session(), planStory.selectedRouteId);
    const page = buildPlanStoryPage({
      resolved: screen.resolved,
      routes: screen.routes,
      glance: screen.glance,
      glanceNote: planStory.glanceNote,
      selectedRouteId: screen.route.id,
      onSelectRoute: selectRoute,
      onOpenLink: openLink
    });
    host.replaceChildren(page);
    drawn = { planStory, routeId: screen.route.id, page };
    revealSelectedRoute(page);
  }

  function teardown() {
    bar?.remove();
    host?.remove();
    bar = null;
    host = null;
    drawn = null;
    viewport()?.classList.remove('has-plan-story');
    if (ui.overviewZoomWrap) ui.overviewZoomWrap.style.height = '';
  }

  /**
   * Called first by refreshOverview. Draws the story and the switch, and returns how much of
   * the top of the overview they take in the Modules view, so the grid is laid out in the rest.
   */
  function syncOverview() {
    const planStory = planStoryOf();
    if (!planStory) {
      teardown();
      return { chromeTop: 0 };
    }
    ensureElements();
    viewport().classList.add('has-plan-story');
    viewport().dataset.psView = view;
    drawBar();
    host.hidden = view !== 'story';
    if (view === 'story') drawStory(planStory);
    ui.overviewZoomWrap.style.height = `${Math.max(240, viewport().clientHeight - BAR_HEIGHT)}px`;
    return { chromeTop: BAR_HEIGHT };
  }

  /** "section 3, Removing inefficiencies", read from the page that is drawn; empty for the headline and summary. */
  function sectionLabel(sectionId) {
    const node = drawn?.page?.querySelector(`[data-ps-section="${sectionId}"]`);
    const number = node?.querySelector('.ps-eyebrow')?.textContent.match(/\d+/)?.[0];
    const title = node?.querySelector('h2')?.textContent;
    return number && title ? `section ${number}, ${title}` : '';
  }

  function removeFocusBar() {
    focusBar?.remove();
    focusBar = null;
    document.body.classList.remove('ps-focusbar-on');
  }

  function offRouteNote() {
    if (!open || !isFocusedOn(open.moduleId) || !open.target.caseId) return null;
    const chapter = open.target.chapter;
    const { cases } = titles(chapter);
    const verdict = evaluateOffRoute({ target: open.target, currentCaseId: currentCase(open.moduleId), caseTitles: cases });
    if (!verdict.offRoute) return null;
    return buildOffRouteNote({
      caseWas: verdict.caseWas,
      caseNow: verdict.caseNow,
      onBackToRoute: async () => {
        await backToRoute(open.target, open.moduleId, { setCase });
        syncChrome();
      }
    });
  }

  /** Called whenever the screen's chrome is refreshed: the Back pill and the off-route note, or the return to the story. */
  function syncChrome() {
    const planStory = planStoryOf();
    if (!planStory) {
      open = null;
      pendingReturn = null;
      removeFocusBar();
      return;
    }
    const mode = app.getMode();
    if (open && mode === 'overview') {
      pendingReturn = { sectionId: open.context.sectionId, paragraphIndex: open.context.paragraphIndex, figureKey: open.target.figureKey };
      open = null;
    }
    if (open && mode === 'focused') {
      removeFocusBar();
      focusBar = document.createElement('div');
      focusBar.className = 'ps-focusbar';
      focusBar.setAttribute('data-ps-chrome', '');
      focusBar.append(buildBackToStoryPill({
        sectionTitle: sectionLabel(open.context.sectionId),
        figureText: open.target.figureText,
        onBack: () => { void backToStory(); }
      }));
      const note = offRouteNote();
      if (note) focusBar.append(note);
      ui.focusLayer.append(focusBar);
      document.body.classList.add('ps-focusbar-on');
    } else {
      removeFocusBar();
    }
    if (pendingReturn && mode === 'overview' && drawn?.page?.isConnected) {
      const point = pendingReturn;
      pendingReturn = null;
      if (view !== 'story') {
        view = 'story';
        app.refreshOverview();
      }
      window.requestAnimationFrame(() => returnToParagraph(drawn.page, point));
    }
  }

  /** "Back to the story": the overview, scrolled to the paragraph the link was in. */
  async function backToStory() {
    if (!open) return false;
    pendingReturn = { sectionId: open.context.sectionId, paragraphIndex: open.context.paragraphIndex, figureKey: open.target.figureKey };
    open = null;
    view = 'story';
    clearOutline();
    removeFocusBar();
    await app.showOverview();
    return true;
  }

  // A case picked inside the module can take the screen off the route; look again once it has moved.
  ui.focusLayer.addEventListener('click', () => {
    if (open) window.setTimeout(syncChrome, 80);
  });

  return {
    syncOverview,
    syncChrome,
    backToStory,
    hasOpenLink: () => Boolean(open),
    reset() {
      open = null;
      pendingReturn = null;
      view = 'story';
      clearOutline();
      removeFocusBar();
    }
  };
}
