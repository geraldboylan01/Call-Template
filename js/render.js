import { computeGridPosition, applyOverviewLayout } from './layout.js';

function formatLocalTime(isoString) {
  try {
    return new Date(isoString).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (_error) {
    return '';
  }
}

function makeOverviewSnippet(notes) {
  if (!notes || !notes.trim()) {
    return 'No notes yet.';
  }

  const clean = notes.replace(/\s+/g, ' ').trim();
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

export function getUiElements() {
  return {
    app: document.getElementById('app'),
    clientNameInput: document.getElementById('clientNameInput'),
    greetingHeadline: document.getElementById('greetingHeadline'),
    greetingView: document.getElementById('greetingView'),
    focusedView: document.getElementById('focusedView'),
    overviewView: document.getElementById('overviewView'),
    swipeStage: document.getElementById('swipeStage'),
    overviewViewport: document.getElementById('overviewViewport'),
    overviewZoomWrap: document.getElementById('overviewZoomWrap'),
    overviewGrid: document.getElementById('overviewGrid'),
    zoomButton: document.getElementById('zoomToggleBtn'),
    newModuleButton: document.getElementById('newModuleBtn'),
    resetButton: document.getElementById('resetBtn'),
    prevArrowButton: document.getElementById('navPrevBtn'),
    nextArrowButton: document.getElementById('navNextBtn')
  };
}

export function renderGreeting(ui, clientName) {
  ui.greetingHeadline.textContent = `Hello ${clientName || 'Client'}!`;
  if (ui.clientNameInput.value !== (clientName || '')) {
    ui.clientNameInput.value = clientName || '';
  }
}

export function buildFocusedPane({ module, moduleNumber, onTitleInput, onNotesInput }) {
  const pane = document.createElement('div');
  pane.className = 'focused-pane swipe-pane-content';

  const card = document.createElement('article');
  card.className = 'module-card focused-module-card';
  card.dataset.moduleId = module.id;

  const meta = document.createElement('div');
  meta.className = 'module-meta';
  meta.textContent = `Module ${moduleNumber}`;

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'module-title-input';
  titleInput.placeholder = 'Untitled Module';
  titleInput.value = module.title || '';
  titleInput.autocomplete = 'off';

  const notesInput = document.createElement('textarea');
  notesInput.className = 'module-notes-input';
  notesInput.placeholder = 'Type notes for this module...';
  notesInput.value = module.notes || '';

  titleInput.addEventListener('input', (event) => {
    onTitleInput(module.id, event.target.value);
  });

  notesInput.addEventListener('input', (event) => {
    onNotesInput(module.id, event.target.value);
  });

  card.appendChild(meta);
  card.appendChild(titleInput);
  card.appendChild(notesInput);
  pane.appendChild(card);

  return pane;
}

export function renderOverview({
  ui,
  modules,
  activeModuleId,
  layout,
  viewportWidth,
  viewportHeight,
  onCardClick
}) {
  ui.overviewGrid.innerHTML = '';

  modules.forEach((module, index) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'module-card overview-card';
    if (module.id === activeModuleId) {
      card.classList.add('is-active');
    }

    card.dataset.moduleId = module.id;

    const label = document.createElement('div');
    label.className = 'overview-meta';
    label.textContent = `#${index + 1} • ${formatLocalTime(module.createdAt)}`;

    const title = document.createElement('h3');
    title.className = 'overview-title';
    title.textContent = module.title?.trim() ? module.title : 'Untitled Module';

    const snippet = document.createElement('p');
    snippet.className = 'overview-snippet';
    snippet.textContent = makeOverviewSnippet(module.notes);

    card.appendChild(label);
    card.appendChild(title);
    card.appendChild(snippet);

    const position = computeGridPosition(index, modules.length, layout.cols);
    card.style.gridColumnStart = String(position.columnStart);
    card.style.gridRowStart = String(position.rowStart);

    card.addEventListener('click', () => onCardClick(module.id, card));

    ui.overviewGrid.appendChild(card);
  });

  applyOverviewLayout(ui.overviewZoomWrap, ui.overviewGrid, layout, viewportWidth, viewportHeight);
}

export function setMode(ui, mode) {
  ui.greetingView.classList.toggle('is-visible', mode === 'greeting');
  ui.focusedView.classList.toggle('is-visible', mode === 'focused');
  ui.overviewView.classList.toggle('is-visible', mode === 'overview');
}

export function updateControls(ui, { mode, moduleCount, hasPrevious }) {
  const hasModules = moduleCount > 0;

  ui.zoomButton.disabled = !hasModules;
  ui.zoomButton.textContent = mode === 'overview' ? 'Zoom In' : 'Zoom Out';

  ui.newModuleButton.disabled = false;

  ui.prevArrowButton.classList.toggle('is-hidden', mode !== 'focused');
  ui.nextArrowButton.classList.toggle('is-hidden', mode !== 'focused');
  ui.prevArrowButton.disabled = !hasPrevious;
}

export function getFocusedCardElement(ui) {
  return ui.swipeStage.querySelector('.focused-module-card');
}

export function getOverviewCardElement(ui, moduleId) {
  return ui.overviewGrid.querySelector(`.overview-card[data-module-id="${moduleId}"]`);
}

export function setViewVisibilityForAnimation(ui, { showFocused = false, showOverview = false }) {
  ui.focusedView.classList.toggle('is-visible', showFocused);
  ui.overviewView.classList.toggle('is-visible', showOverview);
}
