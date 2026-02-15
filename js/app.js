import {
  loadSession,
  createStateManager,
  getModuleById,
  getOrderedModules,
  ensureActiveModule
} from './state.js';
import { computeBestOverviewLayout } from './layout.js';
import {
  zoomToModuleFromOverview,
  zoomOutToOverview,
  getIsZoomAnimating
} from './zoom.js';
import { mountInitialPane, swipeToPane } from './swipe.js';
import {
  getUiElements,
  renderGreeting,
  buildFocusedPane,
  renderOverview,
  setMode,
  updateControls,
  getFocusedCardElement,
  getOverviewCardElement,
  ensureLayerVisibleForMeasure
} from './render.js';

const ui = getUiElements();
const stateManager = createStateManager(300);

const appState = {
  session: loadSession(),
  mode: 'greeting',
  sortable: null,
  transitionLock: false
};

function nowIso() {
  return new Date().toISOString();
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function makeModuleId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }

  return `module-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createBlankModule() {
  const timestamp = nowIso();
  return {
    id: makeModuleId(),
    createdAt: timestamp,
    updatedAt: timestamp,
    title: '',
    notes: ''
  };
}

function getModulesInOrder() {
  return getOrderedModules(appState.session);
}

function getActiveIndex() {
  return appState.session.order.indexOf(appState.session.activeModuleId);
}

function hasModules() {
  return appState.session.modules.length > 0;
}

function normalizeClientName(value) {
  return value.trim();
}

function updateModule(moduleId, patch) {
  const module = getModuleById(appState.session, moduleId);
  if (!module) {
    return;
  }

  Object.assign(module, patch);
  module.updatedAt = nowIso();
  stateManager.scheduleSave(appState.session);

  if (appState.mode === 'overview') {
    refreshOverview({ enableSortable: true });
  }
}

function updateUiChrome() {
  const activeIndex = getActiveIndex();
  updateControls(ui, {
    mode: appState.mode,
    moduleCount: appState.session.modules.length,
    hasPrevious: activeIndex > 0
  });

  renderGreeting(ui, appState.session.clientName);
}

function getFocusedPaneForModule(module) {
  const moduleNumber = Math.max(1, appState.session.order.indexOf(module.id) + 1);

  return buildFocusedPane({
    module,
    moduleNumber,
    onTitleInput: (moduleId, value) => updateModule(moduleId, { title: value }),
    onNotesInput: (moduleId, value) => updateModule(moduleId, { notes: value })
  });
}

async function renderFocused({ useSwipe = true, direction = 'forward', revealMode = true } = {}) {
  ensureActiveModule(appState.session);

  if (!hasModules()) {
    appState.mode = 'greeting';
    ui.swipeStage.innerHTML = '';
    setMode(ui, 'greeting');
    updateUiChrome();
    return;
  }

  const activeModule = getModuleById(appState.session, appState.session.activeModuleId);
  if (!activeModule) {
    return;
  }

  const pane = getFocusedPaneForModule(activeModule);

  if (useSwipe) {
    await swipeToPane(ui.swipeStage, pane, direction);
  } else {
    mountInitialPane(ui.swipeStage, pane);
  }

  if (revealMode) {
    appState.mode = 'focused';
    setMode(ui, 'focused');
    updateUiChrome();
  }
}

function refreshOverview({ enableSortable = appState.mode === 'overview' } = {}) {
  const modules = getModulesInOrder();

  const width = ui.overviewViewport.clientWidth;
  const height = ui.overviewViewport.clientHeight;
  const layout = computeBestOverviewLayout(modules.length, width, height, {
    maxCols: 6,
    gap: width < 900 ? 14 : 18,
    outerPadding: width < 900 ? 22 : 36
  });

  renderOverview({
    ui,
    modules,
    activeModuleId: appState.session.activeModuleId,
    layout,
    viewportWidth: width,
    viewportHeight: height,
    onCardClick: async (moduleId, cardEl) => {
      await zoomIntoModuleFromOverview(moduleId, cardEl);
    }
  });

  if (enableSortable) {
    initSortable();
  }
}

function destroySortable() {
  if (appState.sortable) {
    appState.sortable.destroy();
    appState.sortable = null;
  }
}

function initSortable() {
  destroySortable();

  if (typeof window.Sortable === 'undefined') {
    return;
  }

  if (appState.session.modules.length < 2 || appState.mode !== 'overview') {
    return;
  }

  appState.sortable = window.Sortable.create(ui.overviewGrid, {
    animation: 180,
    ghostClass: 'overview-drag-ghost',
    chosenClass: 'overview-drag-chosen',
    dragClass: 'overview-drag-dragging',
    onEnd: () => {
      const nextOrder = [...ui.overviewGrid.querySelectorAll('.overview-card')]
        .map((card) => card.dataset.moduleId)
        .filter(Boolean);

      if (nextOrder.length === appState.session.order.length) {
        appState.session.order = nextOrder;
        ensureActiveModule(appState.session);
        stateManager.scheduleSave(appState.session);
      }

      refreshOverview({ enableSortable: true });
    }
  });
}

async function zoomIntoModuleFromOverview(moduleId, sourceCardEl) {
  if (
    appState.transitionLock ||
    appState.mode !== 'overview' ||
    !moduleId ||
    !sourceCardEl ||
    getIsZoomAnimating()
  ) {
    return;
  }

  const targetModule = getModuleById(appState.session, moduleId);
  if (!targetModule) {
    return;
  }

  appState.transitionLock = true;
  destroySortable();
  appState.session.activeModuleId = moduleId;

  const completed = await zoomToModuleFromOverview(moduleId, sourceCardEl, {
    overviewLayer: ui.overviewLayer,
    focusLayer: ui.focusLayer,
    animLayer: ui.animLayer,
    prepareFocusTarget: async () => {
      await renderFocused({ useSwipe: false, revealMode: false });
      ensureLayerVisibleForMeasure(ui.focusLayer);
      ui.focusLayer.style.visibility = 'hidden';
      ui.focusLayer.style.opacity = '0';
      await nextFrame();
      return getFocusedCardElement(ui);
    }
  });

  if (completed) {
    appState.mode = 'focused';
    setMode(ui, 'focused');
    updateUiChrome();
    stateManager.scheduleSave(appState.session);
  }

  appState.transitionLock = false;
}

async function zoomOutToOverviewMode() {
  if (appState.transitionLock || appState.mode === 'overview' || !hasModules() || getIsZoomAnimating()) {
    return;
  }

  appState.transitionLock = true;
  destroySortable();

  const moduleId = appState.session.activeModuleId;

  const completed = await zoomOutToOverview({
    moduleId,
    overviewLayer: ui.overviewLayer,
    focusLayer: ui.focusLayer,
    animLayer: ui.animLayer,
    getFocusSource: () => getFocusedCardElement(ui),
    prepareOverviewTarget: async (activeModuleId) => {
      ensureLayerVisibleForMeasure(ui.overviewLayer);
      refreshOverview({ enableSortable: false });
      await nextFrame();
      return getOverviewCardElement(ui, activeModuleId)
        || ui.overviewGrid.querySelector('.overview-card');
    }
  });

  if (completed) {
    appState.mode = 'overview';
    setMode(ui, 'overview');
    updateUiChrome();
    initSortable();
  }

  appState.transitionLock = false;
}

async function toggleOverview() {
  if (!hasModules() || appState.transitionLock || getIsZoomAnimating()) {
    return;
  }

  if (appState.mode === 'overview') {
    const sourceCardEl = getOverviewCardElement(ui, appState.session.activeModuleId)
      || ui.overviewGrid.querySelector('.overview-card');
    await zoomIntoModuleFromOverview(appState.session.activeModuleId, sourceCardEl);
    return;
  }

  await zoomOutToOverviewMode();
}

async function createNewModule() {
  if (appState.transitionLock || getIsZoomAnimating()) {
    return;
  }

  const module = createBlankModule();
  appState.session.modules.push(module);
  appState.session.order.push(module.id);
  appState.session.activeModuleId = module.id;

  stateManager.scheduleSave(appState.session);

  if (appState.mode === 'overview') {
    refreshOverview({ enableSortable: false });
    await nextFrame();
    const sourceCardEl = getOverviewCardElement(ui, module.id)
      || ui.overviewGrid.querySelector(`.overview-card[data-module-id="${module.id}"]`);
    await zoomIntoModuleFromOverview(module.id, sourceCardEl);
    return;
  }

  appState.mode = 'focused';
  setMode(ui, 'focused');

  await renderFocused({
    useSwipe: true,
    direction: 'forward',
    revealMode: true
  });
}

async function focusPreviousModule() {
  if (appState.transitionLock || appState.mode !== 'focused' || getIsZoomAnimating()) {
    return;
  }

  const activeIndex = getActiveIndex();
  if (activeIndex <= 0) {
    return;
  }

  appState.session.activeModuleId = appState.session.order[activeIndex - 1];
  stateManager.scheduleSave(appState.session);

  await renderFocused({
    useSwipe: true,
    direction: 'backward',
    revealMode: true
  });
}

function bindEvents() {
  ui.clientNameInput.addEventListener('input', (event) => {
    appState.session.clientName = normalizeClientName(event.target.value);
    renderGreeting(ui, appState.session.clientName);
    stateManager.scheduleSave(appState.session);
  });

  ui.newModuleButton.addEventListener('click', async () => {
    await createNewModule();
  });

  ui.nextArrowButton.addEventListener('click', async () => {
    await createNewModule();
  });

  ui.prevArrowButton.addEventListener('click', async () => {
    await focusPreviousModule();
  });

  ui.zoomButton.addEventListener('click', async () => {
    await toggleOverview();
  });

  ui.resetButton.addEventListener('click', () => {
    stateManager.reset();
    window.location.reload();
  });

  window.addEventListener('resize', () => {
    if (appState.mode === 'overview') {
      refreshOverview({ enableSortable: true });
    }
  });

  window.addEventListener('keydown', async (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    );

    const key = event.key;
    const lower = key.toLowerCase();

    if (typing && key !== 'Escape') {
      return;
    }

    if (lower === 'n') {
      event.preventDefault();
      await createNewModule();
      return;
    }

    if (lower === 'o') {
      event.preventDefault();
      await toggleOverview();
      return;
    }

    if (key === 'ArrowRight') {
      event.preventDefault();
      await createNewModule();
      return;
    }

    if (key === 'ArrowLeft') {
      event.preventDefault();
      await focusPreviousModule();
      return;
    }

    if (key === 'Escape' && appState.mode === 'overview' && hasModules()) {
      event.preventDefault();
      const sourceCardEl = getOverviewCardElement(ui, appState.session.activeModuleId)
        || ui.overviewGrid.querySelector('.overview-card');
      await zoomIntoModuleFromOverview(appState.session.activeModuleId, sourceCardEl);
    }
  });

  window.addEventListener('beforeunload', () => {
    stateManager.saveNow(appState.session);
  });
}

async function init() {
  ensureActiveModule(appState.session);
  appState.mode = hasModules() ? 'focused' : 'greeting';

  bindEvents();
  renderGreeting(ui, appState.session.clientName);

  if (appState.mode === 'focused') {
    await renderFocused({ useSwipe: false, revealMode: true });
  } else {
    setMode(ui, 'greeting');
    updateUiChrome();
  }
}

void init();
