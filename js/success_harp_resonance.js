import {
  HARP_STRINGS,
  createPlaneirHarpMarkup,
  getHarpStringPath
} from './planeir_harp_artwork.js';

export const HARP_RESONANCE_TIMING = Object.freeze({
  duration: 1550,
  focusEnd: 160,
  stringStarts: Object.freeze([120, 210, 300]),
  stringDuration: 420,
  haloStart: 250,
  haloEnd: 1050,
  beadStart: 920,
  beadEnd: 1180,
  retractStart: 1180
});

const RESONANCE_NAME = 'resonant-halo';
const MOBILE_BREAKPOINT_PX = 540;
const MOBILE_TARGET_HEIGHT_PX = 48;
const MOBILE_MAX_SCALE = 1.75;
const DESKTOP_FOCUS_SCALE = 1.08;
const STRING_DAMPING = 9.5;

function setNeutralAttribute(element, name, value) {
  if (!element) {
    return;
  }
  if (value === null) {
    element.removeAttribute(name);
    return;
  }
  element.setAttribute(name, value);
}

function getViewportWidth(view) {
  return view?.visualViewport?.width ?? view?.innerWidth ?? Number.POSITIVE_INFINITY;
}

function getFocusScale(root, view) {
  if (getViewportWidth(view) >= MOBILE_BREAKPOINT_PX) {
    return DESKTOP_FOCUS_SCALE;
  }

  const renderedHeight = root?.getBoundingClientRect?.().height || root?.offsetHeight || 0;
  if (renderedHeight <= 0) {
    return DESKTOP_FOCUS_SCALE;
  }

  return Math.min(
    MOBILE_MAX_SCALE,
    Math.max(DESKTOP_FOCUS_SCALE, MOBILE_TARGET_HEIGHT_PX / renderedHeight)
  );
}

function getPhase(elapsed) {
  if (elapsed < HARP_RESONANCE_TIMING.stringStarts[0]) {
    return 'focus';
  }
  if (elapsed < HARP_RESONANCE_TIMING.haloStart) {
    return 'pluck';
  }
  if (elapsed < HARP_RESONANCE_TIMING.beadStart) {
    return 'halo';
  }
  if (elapsed < HARP_RESONANCE_TIMING.retractStart) {
    return 'glint';
  }
  return 'retract';
}

function createScaleKeyframes(focusScale) {
  const focusOffset = HARP_RESONANCE_TIMING.focusEnd / HARP_RESONANCE_TIMING.duration;
  const retractOffset = HARP_RESONANCE_TIMING.retractStart / HARP_RESONANCE_TIMING.duration;

  return [
    { offset: 0, transform: 'scale(1)', easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    { offset: focusOffset, transform: `scale(${focusScale})` },
    { offset: retractOffset, transform: `scale(${focusScale})`, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
    { offset: 1, transform: 'scale(1)' }
  ];
}

function createArcKeyframes(index, arcCount) {
  const duration = HARP_RESONANCE_TIMING.duration;
  const releaseAt = HARP_RESONANCE_TIMING.haloStart + (index * 90);
  const availableDrawTime = HARP_RESONANCE_TIMING.haloEnd - releaseAt;
  const drawDuration = Math.min(620, Math.max(420, availableDrawTime));
  const drawnAt = Math.min(HARP_RESONANCE_TIMING.haloEnd, releaseAt + drawDuration);
  const opacity = Math.max(0.58, 0.88 - (index * (0.24 / Math.max(1, arcCount - 1))));

  return [
    { offset: 0, opacity: 0, strokeDasharray: '1', strokeDashoffset: '1' },
    { offset: releaseAt / duration, opacity: 0, strokeDasharray: '1', strokeDashoffset: '1' },
    {
      offset: drawnAt / duration,
      opacity,
      strokeDasharray: '1',
      strokeDashoffset: '0',
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
    },
    {
      offset: HARP_RESONANCE_TIMING.retractStart / duration,
      opacity,
      strokeDasharray: '1',
      strokeDashoffset: '0',
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)'
    },
    { offset: 1, opacity: 0, strokeDasharray: '1', strokeDashoffset: '-0.12' }
  ];
}

export function createSuccessHarpResonance(options = {}) {
  const {
    root,
    motionQuery
  } = options;
  const view = root?.ownerDocument?.defaultView || globalThis.window;
  const requestFrame = view?.requestAnimationFrame?.bind(view);
  const cancelFrame = view?.cancelAnimationFrame?.bind(view);

  if (root) {
    root.innerHTML = createPlaneirHarpMarkup({
      includeEffects: true,
      className: 'lead-success-harp-resonance-svg'
    });
  }

  const artwork = root?.querySelector?.('[data-harp-artwork]') || null;
  const stage = root?.querySelector?.('[data-harp-stage]') || null;
  const stringElements = HARP_STRINGS.map((definition) => ({
    definition,
    element: root?.querySelector?.(`[data-harp-string="${definition.id}"]`) || null
  }));
  const haloArcs = Array.from(root?.querySelectorAll?.('[data-harp-halo-arc]') || []);
  const secondaryArc = root?.querySelector?.('[data-harp-secondary-arc]') || null;
  const beadGuide = root?.querySelector?.('[data-harp-bead-guide]') || null;
  const bead = root?.querySelector?.('[data-harp-bead]') || null;
  const glint = root?.querySelector?.('[data-harp-glint]') || null;
  const neutralBeadX = bead?.getAttribute?.('cx') ?? null;
  const neutralBeadY = bead?.getAttribute?.('cy') ?? null;
  const activeAnimations = new Set();
  const activeFrameHandles = new Set();
  let activeCompletion = null;
  let runId = 0;

  function cancelAnimations() {
    activeAnimations.forEach((animation) => {
      try {
        animation.cancel();
      } catch (_error) {
        // The animation can already have detached after its final frame.
      }
    });
    activeAnimations.clear();
  }

  function cancelFrames() {
    if (cancelFrame) {
      activeFrameHandles.forEach((handle) => cancelFrame(handle));
    }
    activeFrameHandles.clear();
  }

  function requestTrackedFrame(callback) {
    if (!requestFrame) {
      return null;
    }
    const handle = requestFrame((timestamp) => {
      activeFrameHandles.delete(handle);
      callback(timestamp);
    });
    activeFrameHandles.add(handle);
    return handle;
  }

  function setPhase(phase) {
    if (!root?.dataset || root.dataset.harpPhase === phase) {
      return;
    }
    root.dataset.harpPhase = phase;
  }

  function neutralizeVisuals() {
    cancelAnimations();
    stringElements.forEach(({ definition, element }) => {
      element?.setAttribute?.('d', getHarpStringPath(definition, 0));
    });
    setNeutralAttribute(bead, 'cx', neutralBeadX);
    setNeutralAttribute(bead, 'cy', neutralBeadY);

    secondaryArc?.style?.removeProperty?.('display');
    [stage, bead, glint, ...haloArcs].forEach((element) => {
      element?.style?.removeProperty?.('opacity');
      element?.style?.removeProperty?.('transform');
      element?.style?.removeProperty?.('transform-box');
      element?.style?.removeProperty?.('transform-origin');
      element?.style?.removeProperty?.('will-change');
    });

    root?.classList?.remove('is-harp-resonance-active', 'is-harp-resonance-mobile');
    if (root?.dataset) {
      delete root.dataset.harpPhase;
    } else {
      root?.removeAttribute?.('data-harp-phase');
    }
  }

  function finishActiveCompletion(result) {
    const completion = activeCompletion;
    activeCompletion = null;
    completion?.resolve(result);
  }

  function reset() {
    runId += 1;
    cancelFrames();
    neutralizeVisuals();
    finishActiveCompletion(null);
  }

  function startAnimation(element, keyframes, animationOptions) {
    if (!element || typeof element.animate !== 'function') {
      return null;
    }
    const animation = element.animate(keyframes, {
      fill: 'both',
      ...animationOptions
    });
    if (animation) {
      activeAnimations.add(animation);
    }
    return animation;
  }

  function updateStrings(elapsed) {
    stringElements.forEach(({ definition, element }, index) => {
      if (!element) {
        return;
      }
      const startedAt = HARP_RESONANCE_TIMING.stringStarts[index]
        ?? HARP_RESONANCE_TIMING.stringStarts.at(-1);
      const stringElapsed = elapsed - startedAt;
      if (stringElapsed <= 0 || stringElapsed >= HARP_RESONANCE_TIMING.stringDuration) {
        element.setAttribute('d', getHarpStringPath(definition, 0));
        return;
      }

      const seconds = stringElapsed / 1000;
      const displacement = definition.amplitude
        * Math.exp(-STRING_DAMPING * seconds)
        * Math.sin(2 * Math.PI * definition.frequency * seconds);
      element.setAttribute('d', getHarpStringPath(definition, displacement));
    });
  }

  function updateBead(elapsed, beadGuide) {
    if (!bead || !beadGuide || elapsed < HARP_RESONANCE_TIMING.beadStart) {
      return;
    }
    const travelEnd = HARP_RESONANCE_TIMING.haloEnd + 20;
    const progress = Math.min(
      1,
      Math.max(0, (elapsed - HARP_RESONANCE_TIMING.beadStart) / (travelEnd - HARP_RESONANCE_TIMING.beadStart))
    );
    try {
      const length = beadGuide.getTotalLength();
      const point = beadGuide.getPointAtLength(length * progress);
      bead.setAttribute('cx', `${point.x}`);
      bead.setAttribute('cy', `${point.y}`);
    } catch (_error) {
      // The opacity choreography remains valid if path metrics are unavailable.
    }
  }

  function prepareAnimations(focusScale, isMobile) {
    stage.style?.setProperty?.('transform-box', 'fill-box');
    stage.style?.setProperty?.('transform-origin', '50% 100%');
    stage.style?.setProperty?.('will-change', 'transform');
    [bead, glint].forEach((element) => {
      element?.style?.setProperty?.('transform-box', 'fill-box');
      element?.style?.setProperty?.('transform-origin', 'center');
    });
    startAnimation(stage, createScaleKeyframes(focusScale), {
      duration: HARP_RESONANCE_TIMING.duration,
      easing: 'linear'
    });

    haloArcs.forEach((arc, index) => {
      if (isMobile && arc === secondaryArc) {
        arc.style?.setProperty?.('display', 'none');
        return;
      }
      startAnimation(arc, createArcKeyframes(index, haloArcs.length), {
        duration: HARP_RESONANCE_TIMING.duration,
        easing: 'linear'
      });
    });

    startAnimation(bead, [
      { opacity: 0, transform: 'scale(0.72)' },
      { offset: 0.12, opacity: 1, transform: 'scale(1)' },
      { offset: 0.62, opacity: 1, transform: 'scale(1)' },
      { opacity: 0, transform: 'scale(0.82)' }
    ], {
      delay: HARP_RESONANCE_TIMING.beadStart,
      duration: HARP_RESONANCE_TIMING.beadEnd - HARP_RESONANCE_TIMING.beadStart,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
    });

    startAnimation(glint, [
      { opacity: 0, transform: 'scale(0.7)' },
      { offset: 0.28, opacity: 0.9, transform: 'scale(1)' },
      { opacity: 0, transform: 'scale(1.3)' }
    ], {
      delay: HARP_RESONANCE_TIMING.beadEnd - 140,
      duration: 140,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
    });
  }

  function play() {
    reset();

    const canAnimate = root
      && artwork
      && stage
      && !motionQuery?.matches
      && typeof stage.animate === 'function'
      && typeof requestFrame === 'function'
      && typeof cancelFrame === 'function';
    if (!canAnimate) {
      return Promise.resolve(null);
    }

    const currentRunId = ++runId;
    const isMobile = getViewportWidth(view) < MOBILE_BREAKPOINT_PX;
    const focusScale = getFocusScale(root, view);
    const startedAt = view?.performance?.now?.() ?? null;

    root.classList.add('is-harp-resonance-active');
    root.classList.toggle('is-harp-resonance-mobile', isMobile);
    setPhase('focus');

    return new Promise((resolve) => {
      activeCompletion = { runId: currentRunId, resolve };

      try {
        prepareAnimations(focusScale, isMobile);
      } catch (_error) {
        neutralizeVisuals();
        finishActiveCompletion(null);
        return;
      }

      let firstFrameTime = startedAt;
      const renderFrame = (timestamp) => {
        if (currentRunId !== runId) {
          return;
        }
        if (firstFrameTime === null) {
          firstFrameTime = timestamp;
        }
        const elapsed = Math.max(0, timestamp - firstFrameTime);
        setPhase(getPhase(elapsed));
        updateStrings(elapsed);
        updateBead(elapsed, beadGuide);

        if (elapsed < HARP_RESONANCE_TIMING.duration) {
          requestTrackedFrame(renderFrame);
          return;
        }

        neutralizeVisuals();
        requestTrackedFrame(() => {
          if (currentRunId !== runId) {
            return;
          }
          requestTrackedFrame(() => {
            if (currentRunId === runId && activeCompletion?.runId === currentRunId) {
              finishActiveCompletion(RESONANCE_NAME);
            }
          });
        });
      };

      requestTrackedFrame(renderFrame);
    });
  }

  neutralizeVisuals();

  return {
    play,
    reset
  };
}
