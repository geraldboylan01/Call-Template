const SUCCESS_CLASSES = ['is-measuring', 'is-active', 'is-entering', 'is-settling', 'is-showing-copy', 'is-exiting', 'is-reduced-motion'];
const DEFAULT_WORDMARK_RATIO = 1330 / 384;

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

  return rect;
}

export function createSuccessTakeover(options = {}) {
  const {
    overlay,
    origin,
    ghost,
    target,
    title,
    body,
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)'),
    holdMs = 10000,
    wordmarkRatio = DEFAULT_WORDMARK_RATIO,
    activeBodyClass = 'is-lead-success-active',
    lockTargets = []
  } = options;

  let runId = 0;

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

  function reset() {
    if (!overlay) {
      return;
    }

    overlay.classList.remove(...SUCCESS_CLASSES);
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.removeProperty('--lead-success-origin-left');
    overlay.style.removeProperty('--lead-success-origin-top');
    overlay.style.removeProperty('--lead-success-origin-width');
    overlay.style.removeProperty('--lead-success-origin-height');
    overlay.style.removeProperty('--lead-success-dx');
    overlay.style.removeProperty('--lead-success-dy');
    overlay.style.removeProperty('--lead-success-sx');
    overlay.style.removeProperty('--lead-success-sy');
    overlay.style.removeProperty('--lead-success-hold-ms');
    setInteractionLock(false);
  }

  function configureGhostRect(originRect, targetRect) {
    if (!overlay) {
      return;
    }

    overlay.style.setProperty('--lead-success-origin-left', `${originRect.left}px`);
    overlay.style.setProperty('--lead-success-origin-top', `${originRect.top}px`);
    overlay.style.setProperty('--lead-success-origin-width', `${originRect.width}px`);
    overlay.style.setProperty('--lead-success-origin-height', `${originRect.height}px`);
    overlay.style.setProperty('--lead-success-dx', `${targetRect.left - originRect.left}px`);
    overlay.style.setProperty('--lead-success-dy', `${targetRect.top - originRect.top}px`);
    overlay.style.setProperty('--lead-success-sx', `${targetRect.width / originRect.width}`);
    overlay.style.setProperty('--lead-success-sy', `${targetRect.height / originRect.height}`);
  }

  async function play(playOptions = {}) {
    if (!overlay || !ghost || !target) {
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
    const shouldRestoreFocus = Boolean(restoreContainer?.contains(document.activeElement));
    const prefersReducedMotion = motionQuery.matches;

    if (title && typeof titleText === 'string' && titleText) {
      title.textContent = titleText;
    }
    if (body && typeof bodyText === 'string' && bodyText) {
      body.textContent = bodyText;
    }

    reset();
    overlay.classList.toggle('is-reduced-motion', prefersReducedMotion);
    overlay.classList.add('is-measuring');
    overlay.setAttribute('aria-hidden', 'false');
    overlay.style.setProperty('--lead-success-hold-ms', `${holdMs}ms`);

    await waitForNextFrame();
    if (currentRunId !== runId) {
      return;
    }

    const originRect = getValidRect(origin, getFallbackOriginRect(wordmarkRatio));
    const targetRect = getValidRect(target, getFallbackTargetRect(wordmarkRatio));
    configureGhostRect(originRect, targetRect);

    overlay.classList.remove('is-measuring');
    setInteractionLock(true);
    overlay.classList.add('is-active');

    await waitForNextFrame();
    if (currentRunId !== runId) {
      return;
    }

    if (prefersReducedMotion) {
      overlay.classList.add('is-settling');
      await delay(220);
    } else {
      overlay.classList.add('is-entering');
      await delay(980);
      if (currentRunId !== runId) {
        return;
      }
      overlay.classList.add('is-settling');
      await delay(560);
    }

    if (currentRunId !== runId) {
      return;
    }

    overlay.classList.add('is-showing-copy');
    await delay(holdMs);
    if (currentRunId !== runId) {
      return;
    }

    overlay.classList.add('is-exiting');
    await delay(prefersReducedMotion ? 260 : 420);
    if (currentRunId !== runId) {
      return;
    }

    reset();

    if (shouldRestoreFocus && restoreFocusTo && typeof restoreFocusTo.focus === 'function') {
      restoreFocusTo.focus({ preventScroll: true });
    }
  }

  return {
    play,
    reset
  };
}
