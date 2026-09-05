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
  inspect: document.getElementById('successPreviewInspect'),
  frame: document.getElementById('successPreviewFrame'),
  status: document.getElementById('successPreviewStatus')
};

const motionQuery = {
  get matches() {
    return Boolean(ui.reducedMotion?.checked);
  }
};

let manual = false;
let manualStarted = false;
let manualTime = 0;
let resumeAt = null;
let resumeTime = 0;
const previewClock = {
  now: () => manual ? manualTime : performance.now(),
  request: callback => requestAnimationFrame(now => {
    if (manual) {
      manualTime = resumeAt === null
        ? (manualStarted ? 520 + Number(ui.frame.value) : 520)
        : resumeTime + now - resumeAt;
      manualStarted = true;
    }
    callback(manual ? manualTime : now);
  }),
  cancel: id => cancelAnimationFrame(id)
};

const takeover = createSuccessTakeover({
  overlay: ui.overlay,
  origin: ui.origin,
  target: ui.target,
  title: ui.title,
  body: ui.body,
  motionQuery,
  clock: previewClock,
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

async function playAlignment(inspect = false) {
  manual = inspect;
  manualStarted = false;
  manualTime = 0;
  resumeAt = null;
  const currentRunId = ++previewRunId;
  const copy = getCopy();

  if (ui.status) {
    ui.status.textContent = `Playing Newgrange alignment${motionQuery.matches ? ' with reduced motion' : ''}.`;
  }

  const playedEffect = await takeover.play({
    ...copy,
    restoreFocusTo: ui.play
  });

  if (currentRunId !== previewRunId) {
    return null;
  }

  if (ui.status) {
    const result = playedEffect ? 'Played Newgrange alignment. ' : '';
    ui.status.textContent = `${result}Finished and restored to the neutral logo.`;
  }

  return playedEffect;
}

ui.play?.addEventListener('click', () => {
  void playAlignment();
});

ui.replay?.addEventListener('click', () => {
  takeover.reset();
  void playAlignment();
});

ui.inspect?.addEventListener('click', () => { void playAlignment(true); });

// A frozen inspection frame can still use the real dismissal/return path.
function resumeForDismissal() {
  if (manual && resumeAt === null) { resumeTime = manualTime; resumeAt = performance.now(); }
}
ui.overlay?.addEventListener('click', resumeForDismissal);
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') resumeForDismissal();
}, true);

ui.cancel?.addEventListener('click', () => {
  previewRunId += 1;
  takeover.reset();
  if (ui.status) {
    ui.status.textContent = 'Cancelled and reset.';
  }
});

window.__successTakeoverPreview = {
  play: playAlignment,
  reset: () => {
    previewRunId += 1;
    takeover.reset();
  }
};
