import { createSuccessTakeover } from '../js/success_takeover.js';

const ui = {
  shell: document.getElementById('successPreviewShell'),
  origin: document.getElementById('successPreviewOrigin'),
  overlay: document.getElementById('successPreviewOverlay'),
  target: document.getElementById('successPreviewTarget'),
  title: document.getElementById('successPreviewTitle'),
  body: document.getElementById('successPreviewBody'),
  trick: document.getElementById('successPreviewTrick'),
  variant: document.getElementById('successPreviewVariant'),
  reducedMotion: document.getElementById('successPreviewReducedMotion'),
  play: document.getElementById('successPreviewPlay'),
  cancel: document.getElementById('successPreviewCancel'),
  status: document.getElementById('successPreviewStatus')
};

const motionQuery = {
  get matches() {
    return Boolean(ui.reducedMotion?.checked);
  }
};

const takeover = createSuccessTakeover({
  overlay: ui.overlay,
  origin: ui.origin,
  target: ui.target,
  title: ui.title,
  body: ui.body,
  motionQuery,
  holdMs: 3500,
  reducedHoldMs: 1200,
  lockTargets: []
});

let previewRunId = 0;

function getCopy() {
  if (ui.variant?.value === 'request') {
    return {
      titleText: 'Congratulations',
      bodyText: 'You have taken the first step towards understanding your options more clearly.'
    };
  }

  return {
    titleText: 'Congratulations',
    bodyText: 'Thanks for using Planeir, your future self will thank you!'
  };
}

async function playSelectedTrick() {
  const currentRunId = ++previewRunId;
  const harpTrick = ui.trick?.value || 'random';
  const copy = getCopy();

  if (ui.status) {
    ui.status.textContent = `Playing ${harpTrick}${motionQuery.matches ? ' with reduced motion' : ''}.`;
  }

  const playedTrick = await takeover.play({
    ...copy,
    harpTrick,
    restoreFocusTo: ui.play
  });

  if (currentRunId !== previewRunId) {
    return null;
  }

  if (ui.status) {
    const result = playedTrick ? `Played ${playedTrick}. ` : '';
    ui.status.textContent = `${result}Finished and restored to the neutral logo.`;
  }

  return playedTrick;
}

ui.play?.addEventListener('click', () => {
  void playSelectedTrick();
});

ui.cancel?.addEventListener('click', () => {
  previewRunId += 1;
  takeover.reset();
  if (ui.status) {
    ui.status.textContent = 'Cancelled and reset.';
  }
});

window.__successTakeoverPreview = {
  play: playSelectedTrick,
  reset: () => {
    previewRunId += 1;
    takeover.reset();
  }
};
