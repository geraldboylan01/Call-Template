const SUCCESS_CLASSES = ['is-measuring', 'is-active', 'is-entering', 'is-settling', 'is-showing-copy', 'is-exiting', 'is-reduced-motion'];
const DEFAULT_WORDMARK_RATIO = 1330 / 384;
const DEFAULT_FLIGHT_MS = 960;
const DEFAULT_SETTLE_LEAD_MS = 600;
const DEFAULT_REDUCED_HOLD_MS = 3000;
const DEFAULT_EXIT_MS = 400;
const DEFAULT_REDUCED_EXIT_MS = 220;

function waitForNextFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function waitForViewportStability(options = {}) {
  const {
    maxWaitMs = 520,
    stableFrameCount = 4
  } = options;
  const viewport = window.visualViewport;
  const readViewport = () => ({
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
    offsetLeft: viewport?.offsetLeft ?? 0,
    offsetTop: viewport?.offsetTop ?? 0
  });

  return new Promise((resolve) => {
    const startedAt = window.performance.now();
    let previous = readViewport();
    let stableFrames = 0;

    const check = (now) => {
      const current = readViewport();
      const isStable = Math.abs(current.width - previous.width) < 0.5
        && Math.abs(current.height - previous.height) < 0.5
        && Math.abs(current.offsetLeft - previous.offsetLeft) < 0.5
        && Math.abs(current.offsetTop - previous.offsetTop) < 0.5;

      stableFrames = isStable ? stableFrames + 1 : 0;
      previous = current;

      if (stableFrames >= stableFrameCount || now - startedAt >= maxWaitMs) {
        resolve();
        return;
      }

      window.requestAnimationFrame(check);
    };

    window.requestAnimationFrame(check);
  });
}

function toPlainRect(rect) {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  };
}

function getFallbackOriginRect(wordmarkRatio) {
  const width = Math.min(164, window.innerWidth * 0.42);
  const height = width / wordmarkRatio;

  return {
    left: 24,
    top: 20,
    width,
    height
  };
}

function getFallbackTargetRect(wordmarkRatio) {
  const width = Math.min(window.innerWidth * 0.82, 780);
  const height = width / wordmarkRatio;

  return {
    left: (window.innerWidth - width) / 2,
    top: Math.max(42, (window.innerHeight - height) / 2 - 48),
    width,
    height
  };
}

function getValidRect(element, fallbackRect) {
  if (!element) {
    return fallbackRect;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return fallbackRect;
  }

  return toPlainRect(rect);
}

function getContainedArtworkRect(rect, artworkRatio) {
  if (!rect || rect.width <= 0 || rect.height <= 0 || artworkRatio <= 0) {
    return rect;
  }

  const boxRatio = rect.width / rect.height;
  if (boxRatio > artworkRatio) {
    const width = rect.height * artworkRatio;
    return {
      left: rect.left + ((rect.width - width) / 2),
      top: rect.top,
      width,
      height: rect.height
    };
  }

  const height = rect.width / artworkRatio;
  return {
    left: rect.left,
    top: rect.top + ((rect.height - height) / 2),
    width: rect.width,
    height
  };
}

function buildInverseTransform(originRect, targetBoxRect, targetArtworkRect) {
  const scale = originRect.width / targetArtworkRect.width;
  const artworkOffsetX = targetArtworkRect.left - targetBoxRect.left;
  const artworkOffsetY = targetArtworkRect.top - targetBoxRect.top;
  const translateX = originRect.left - targetBoxRect.left - (artworkOffsetX * scale);
  const translateY = originRect.top - targetBoxRect.top - (artworkOffsetY * scale);

  return `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`;
}

function waitForTransition(element, propertyName, fallbackMs) {
  if (!element) {
    return delay(fallbackMs);
  }

  return new Promise((resolve) => {
    let completed = false;
    const finish = () => {
      if (completed) {
        return;
      }
      completed = true;
      element.removeEventListener('transitionend', handleTransitionEnd);
      element.removeEventListener('transitioncancel', handleTransitionCancel);
      window.clearTimeout(timeoutId);
      resolve();
    };
    const handleTransitionEnd = (event) => {
      if (event.target === element && event.propertyName === propertyName && !event.pseudoElement) {
        finish();
      }
    };
    const handleTransitionCancel = (event) => {
      if (event.target === element && event.propertyName === propertyName && !event.pseudoElement) {
        finish();
      }
    };
    const timeoutId = window.setTimeout(finish, fallbackMs);

    element.addEventListener('transitionend', handleTransitionEnd);
    element.addEventListener('transitioncancel', handleTransitionCancel);
  });
}

export function createSuccessTakeover(options = {}) {
  const {
    overlay,
    origin,
    target,
    title,
    body,
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)'),
    holdMs = 10000,
    flightMs = DEFAULT_FLIGHT_MS,
    settleLeadMs = DEFAULT_SETTLE_LEAD_MS,
    reducedHoldMs = DEFAULT_REDUCED_HOLD_MS,
    exitMs = DEFAULT_EXIT_MS,
    reducedExitMs = DEFAULT_REDUCED_EXIT_MS,
    wordmarkRatio = DEFAULT_WORDMARK_RATIO,
    activeBodyClass = 'is-lead-success-active',
    lockTargets = []
  } = options;

  let runId = 0;
  let activeFlight = null;
  let imageReadyPromise = null;
  let originInlineVisibility = null;

  function setInteractionLock(isLocked) {
    document.body.classList.toggle(activeBodyClass, isLocked);

    lockTargets.forEach((node) => {
      if (!node) {
        return;
      }

      if ('inert' in node) {
        node.inert = isLocked;
      }
    });
  }

  function ensureImagesReady() {
    if (imageReadyPromise) {
      return imageReadyPromise;
    }

    const images = [
      origin instanceof HTMLImageElement ? origin : origin?.querySelector?.('img'),
      target?.querySelector?.('.lead-success-stage-logo')
    ].filter(Boolean);

    imageReadyPromise = Promise.allSettled(images.map((image) => {
      if (typeof image.decode === 'function') {
        return image.decode();
      }
      return Promise.resolve();
    }));

    return imageReadyPromise;
  }

  function hideOrigin() {
    if (!origin?.style || originInlineVisibility !== null) {
      return;
    }

    originInlineVisibility = origin.style.visibility;
    origin.style.visibility = 'hidden';
  }

  function restoreOrigin() {
    if (!origin?.style || originInlineVisibility === null) {
      return;
    }

    if (originInlineVisibility) {
      origin.style.visibility = originInlineVisibility;
    } else {
      origin.style.removeProperty('visibility');
    }
    originInlineVisibility = null;
  }

  function clear() {
    if (!overlay) {
      return;
    }

    if (activeFlight) {
      activeFlight.cancel();
      activeFlight = null;
    }

    overlay.classList.remove(...SUCCESS_CLASSES);
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.removeProperty('--lead-success-hold-ms');
    overlay.style.removeProperty('--lead-success-exit-ms');
    overlay.style.removeProperty('--lead-success-reduced-exit-ms');

    if (target) {
      target.style.removeProperty('opacity');
      target.style.removeProperty('transform');
      target.style.removeProperty('transform-origin');
      target.style.removeProperty('transition');
      target.style.removeProperty('will-change');
    }

    restoreOrigin();
    setInteractionLock(false);
  }

  function reset() {
    runId += 1;
    clear();
  }

  async function runFlight(fromTransform, duration) {
    target.style.opacity = '1';
    target.style.transformOrigin = 'top left';
    target.style.transform = fromTransform;
    target.style.willChange = 'transform';

    if (typeof target.animate !== 'function') {
      target.getBoundingClientRect();
      target.style.transition = `transform ${duration}ms cubic-bezier(0.16, 1, 0.3, 1)`;
      await waitForNextFrame();
      target.style.transform = 'none';
      await waitForTransition(target, 'transform', duration + 80);
      target.style.removeProperty('transition');
      target.style.removeProperty('will-change');
      return;
    }

    activeFlight = target.animate([
      {
        transform: fromTransform
      },
      {
        transform: 'translate3d(0, 0, 0) scale(1)'
      }
    ], {
      duration,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'both'
    });

    try {
      await activeFlight.finished;
    } catch (_error) {
      return;
    }

    target.style.transform = 'none';
    activeFlight.cancel();
    activeFlight = null;
    target.style.removeProperty('will-change');
  }

  async function play(playOptions = {}) {
    if (!overlay || !target) {
      return;
    }

    const currentRunId = ++runId;
    const {
      titleText = '',
      bodyText = '',
      restoreFocusIfContainedIn = null,
      restoreFocusTo = null
    } = playOptions;

    const restoreContainer = restoreFocusIfContainedIn && typeof restoreFocusIfContainedIn.contains === 'function'
      ? restoreFocusIfContainedIn
      : null;
    const activeElement = document.activeElement;
    const shouldRestoreFocus = Boolean(restoreContainer?.contains(activeElement));
    const prefersReducedMotion = motionQuery.matches;
    const effectiveHoldMs = prefersReducedMotion ? Math.min(holdMs, reducedHoldMs) : holdMs;

    clear();
    await ensureImagesReady();
    if (currentRunId !== runId) {
      return;
    }

    if (activeElement instanceof HTMLElement && !overlay.contains(activeElement) && typeof activeElement.blur === 'function') {
      activeElement.blur();
    }

    setInteractionLock(true);
    overlay.classList.toggle('is-reduced-motion', prefersReducedMotion);
    overlay.classList.add('is-measuring');
    overlay.setAttribute('aria-hidden', 'false');
    overlay.style.setProperty('--lead-success-hold-ms', `${effectiveHoldMs}ms`);
    overlay.style.setProperty('--lead-success-exit-ms', `${exitMs}ms`);
    overlay.style.setProperty('--lead-success-reduced-exit-ms', `${reducedExitMs}ms`);

    if (title && typeof titleText === 'string' && titleText) {
      title.textContent = titleText;
    }
    if (body && typeof bodyText === 'string' && bodyText) {
      body.textContent = bodyText;
    }

    await waitForViewportStability();
    if (currentRunId !== runId) {
      return;
    }

    const fallbackOriginRect = getFallbackOriginRect(wordmarkRatio);
    const fallbackTargetRect = getFallbackTargetRect(wordmarkRatio);
    const originRect = getContainedArtworkRect(getValidRect(origin, fallbackOriginRect), wordmarkRatio);
    const targetBoxRect = getValidRect(target, fallbackTargetRect);
    const targetArtwork = target.querySelector('.lead-success-wordmark-shell') || target;
    const targetArtworkRect = getContainedArtworkRect(getValidRect(targetArtwork, fallbackTargetRect), wordmarkRatio);
    const fromTransform = buildInverseTransform(originRect, targetBoxRect, targetArtworkRect);

    if (prefersReducedMotion) {
      target.style.opacity = '1';
      target.style.transform = 'none';
    } else {
      target.style.opacity = '1';
      target.style.transformOrigin = 'top left';
      target.style.transform = fromTransform;
    }

    overlay.classList.remove('is-measuring');
    overlay.classList.add('is-active');
    hideOrigin();

    await waitForNextFrame();
    if (currentRunId !== runId) {
      return;
    }

    if (!prefersReducedMotion) {
      overlay.classList.add('is-entering');
      await runFlight(fromTransform, flightMs);
      if (currentRunId !== runId) {
        return;
      }
    }

    overlay.classList.add('is-settling');
    await delay(prefersReducedMotion ? 80 : settleLeadMs);
    if (currentRunId !== runId) {
      return;
    }

    overlay.classList.add('is-showing-copy');
    await delay(effectiveHoldMs);
    if (currentRunId !== runId) {
      return;
    }

    overlay.classList.add('is-exiting');
    await waitForTransition(overlay, 'opacity', (prefersReducedMotion ? reducedExitMs : exitMs) + 80);
    if (currentRunId !== runId) {
      return;
    }

    clear();

    if (shouldRestoreFocus && restoreFocusTo && typeof restoreFocusTo.focus === 'function') {
      restoreFocusTo.focus({ preventScroll: true });
    }
  }

  return {
    play,
    reset
  };
}
