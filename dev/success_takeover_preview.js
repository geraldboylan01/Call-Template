import { createSuccessTakeover } from '../js/success_takeover.js';

const ui = {
  shell: document.getElementById('successPreviewShell'),
  origin: document.getElementById('successPreviewOrigin'),
  overlay: document.getElementById('successPreviewOverlay'),
  target: document.getElementById('successPreviewTarget'),
  title: document.getElementById('successPreviewTitle'),
  body: document.getElementById('successPreviewBody'),
  variant: document.getElementById('successPreviewVariant'),
  reducedMotion: document.getElementById('successPreviewReducedMotion'),
  play: document.getElementById('successPreviewPlay'),
  replay: document.getElementById('successPreviewReplay'),
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

async function playResonantHalo() {
  const currentRunId = ++previewRunId;
  const copy = getCopy();

  if (ui.status) {
    ui.status.textContent = `Playing Resonant Halo${motionQuery.matches ? ' with reduced motion' : ''}.`;
  }

  const playedEffect = await takeover.play({
    ...copy,
    restoreFocusTo: ui.play
  });

  if (currentRunId !== previewRunId) {
    return null;
  }

  if (ui.status) {
    const result = playedEffect ? 'Played Resonant Halo. ' : '';
    ui.status.textContent = `${result}Finished and restored to the neutral logo.`;
  }

  return playedEffect;
}

ui.play?.addEventListener('click', () => {
  void playResonantHalo();
});

ui.replay?.addEventListener('click', () => {
  takeover.reset();
  void playResonantHalo();
});

ui.cancel?.addEventListener('click', () => {
  previewRunId += 1;
  takeover.reset();
  if (ui.status) {
    ui.status.textContent = 'Cancelled and reset.';
  }
});

window.__successTakeoverPreview = {
  play: playResonantHalo,
  reset: () => {
    previewRunId += 1;
    takeover.reset();
  }
};
