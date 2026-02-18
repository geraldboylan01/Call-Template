const ZOOM_DURATION_MS = 420;
const ZOOM_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

let isAnimating = false;

function reflowChartsAfterTransition() {
  if (typeof window.__callcanvasReflowCharts === 'function') {
    window.__callcanvasReflowCharts();
  }
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function waitForTransitionEnd(element, propertyName, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;

    function finish() {
      if (done) {
        return;
      }
      done = true;
      element.removeEventListener('transitionend', onEnd);
      clearTimeout(timeoutId);
      resolve();
    }

    function onEnd(event) {
      if (event.target !== element) {
        return;
      }

      if (!propertyName || event.propertyName === propertyName) {
        finish();
      }
    }

    const timeoutId = window.setTimeout(finish, timeoutMs + 80);
    element.addEventListener('transitionend', onEnd);
  });
}

function createGhostElement(sourceEl, sourceRect, animLayer) {
  const ghostEl = sourceEl.cloneNode(true);
  ghostEl.classList.add('zoom-ghost');
  ghostEl.removeAttribute('id');
  ghostEl.style.position = 'fixed';
  ghostEl.style.top = `${sourceRect.top}px`;
  ghostEl.style.left = `${sourceRect.left}px`;
  ghostEl.style.width = `${sourceRect.width}px`;
  ghostEl.style.height = `${sourceRect.height}px`;
  ghostEl.style.margin = '0';
  ghostEl.style.pointerEvents = 'none';
  ghostEl.style.transformOrigin = 'top left';
  ghostEl.style.transform = 'translate3d(0px, 0px, 0px) scale(1, 1)';
  ghostEl.style.opacity = '1';
  ghostEl.style.zIndex = '120';

  animLayer.innerHTML = '';
  animLayer.appendChild(ghostEl);

  return ghostEl;
}

function resetLayerStyles(layer) {
  layer.style.opacity = '';
  layer.style.visibility = '';
  layer.style.filter = '';
  layer.style.pointerEvents = '';
  layer.style.transition = '';
}

function markLayerVisible(layer) {
  layer.classList.remove('is-hidden');
  layer.setAttribute('aria-hidden', 'false');
}

function markLayerHidden(layer) {
  layer.classList.add('is-hidden');
  layer.setAttribute('aria-hidden', 'true');
}

function setLayerOrder({ overviewLayer, focusLayer, top }) {
  overviewLayer.classList.remove('layer-active');
  focusLayer.classList.remove('layer-active');

  if (top === 'overview') {
    overviewLayer.classList.add('layer-active');
  } else {
    focusLayer.classList.add('layer-active');
  }
}

function cleanupGhost(ghostEl, sourceEl, animLayer) {
  if (sourceEl) {
    sourceEl.style.opacity = '';
  }

  if (ghostEl && ghostEl.parentNode) {
    ghostEl.remove();
  }

  animLayer.innerHTML = '';
}

async function quickCrossfadeToFocus({ overviewLayer, focusLayer }) {
  markLayerVisible(focusLayer);
  markLayerVisible(overviewLayer);
  setLayerOrder({ overviewLayer, focusLayer, top: 'focus' });

  focusLayer.style.visibility = 'visible';
  focusLayer.style.opacity = '1';
  overviewLayer.style.opacity = '0';
  overviewLayer.style.pointerEvents = 'none';

  await waitForTransitionEnd(overviewLayer, 'opacity', 180);

  markLayerHidden(overviewLayer);
  resetLayerStyles(overviewLayer);
  resetLayerStyles(focusLayer);
}

async function quickCrossfadeToOverview({ overviewLayer, focusLayer }) {
  markLayerVisible(overviewLayer);
  markLayerVisible(focusLayer);
  setLayerOrder({ overviewLayer, focusLayer, top: 'overview' });

  overviewLayer.style.opacity = '1';
  overviewLayer.style.pointerEvents = 'none';
  focusLayer.style.opacity = '0';

  await waitForTransitionEnd(focusLayer, 'opacity', 180);

  markLayerHidden(focusLayer);
  resetLayerStyles(overviewLayer);
  resetLayerStyles(focusLayer);
  overviewLayer.style.pointerEvents = 'auto';
}

export function getIsZoomAnimating() {
  return isAnimating;
}

export async function zoomToModuleFromOverview(moduleId, sourceCardEl, {
  overviewLayer,
  focusLayer,
  animLayer,
  prepareFocusTarget
}) {
  if (isAnimating || !moduleId || !sourceCardEl) {
    return false;
  }

  isAnimating = true;
  let ghostEl = null;

  try {
    const sourceRect = sourceCardEl.getBoundingClientRect();

    const targetEl = await prepareFocusTarget(moduleId);
    if (!targetEl) {
      return false;
    }

    markLayerVisible(focusLayer);
    markLayerVisible(overviewLayer);
    setLayerOrder({ overviewLayer, focusLayer, top: 'overview' });

    focusLayer.style.visibility = 'hidden';
    focusLayer.style.opacity = '0';
    focusLayer.style.pointerEvents = 'none';

    const targetRect = targetEl.getBoundingClientRect();

    await nextFrame();

    ghostEl = createGhostElement(sourceCardEl, sourceRect, animLayer);

    sourceCardEl.style.opacity = '0';

    overviewLayer.classList.add('is-transitioning-out');
    overviewLayer.style.pointerEvents = 'none';

    if (reduceMotionQuery.matches) {
      await quickCrossfadeToFocus({ overviewLayer, focusLayer });
      cleanupGhost(ghostEl, sourceCardEl, animLayer);
      reflowChartsAfterTransition();
      return true;
    }

    const dx = targetRect.left - sourceRect.left;
    const dy = targetRect.top - sourceRect.top;
    const sx = Math.max(0.01, targetRect.width / sourceRect.width);
    const sy = Math.max(0.01, targetRect.height / sourceRect.height);

    await nextFrame();

    ghostEl.style.transition = `transform ${ZOOM_DURATION_MS}ms ${ZOOM_EASING}, opacity 220ms ease`;
    ghostEl.style.transform = `translate3d(${dx}px, ${dy}px, 0px) scale(${sx}, ${sy})`;

    await waitForTransitionEnd(ghostEl, 'transform', ZOOM_DURATION_MS);

    // Tear down overview completely to avoid lingering background after zoom-in.
    markLayerHidden(overviewLayer);
    overviewLayer.classList.remove('is-transitioning-out', 'is-transitioning-in');
    resetLayerStyles(overviewLayer);

    markLayerVisible(focusLayer);
    setLayerOrder({ overviewLayer, focusLayer, top: 'focus' });
    focusLayer.style.visibility = 'visible';
    focusLayer.style.opacity = '1';
    focusLayer.style.pointerEvents = 'auto';

    cleanupGhost(ghostEl, sourceCardEl, animLayer);
    reflowChartsAfterTransition();

    return true;
  } finally {
    isAnimating = false;
  }
}

export async function zoomOutToOverview({
  moduleId,
  overviewLayer,
  focusLayer,
  animLayer,
  getFocusSource,
  prepareOverviewTarget
}) {
  if (isAnimating || !moduleId) {
    return false;
  }

  isAnimating = true;
  let ghostEl = null;
  let sourceEl = null;

  try {
    markLayerVisible(overviewLayer);
    setLayerOrder({ overviewLayer, focusLayer, top: 'overview' });

    overviewLayer.classList.remove('is-transitioning-out');
    overviewLayer.classList.add('is-transitioning-in');
    overviewLayer.style.opacity = '0';
    overviewLayer.style.filter = 'blur(6px)';
    overviewLayer.style.pointerEvents = 'none';

    const targetEl = await prepareOverviewTarget(moduleId);
    sourceEl = getFocusSource();

    if (!targetEl || !sourceEl) {
      return false;
    }

    markLayerVisible(focusLayer);

    const sourceRect = sourceEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    await nextFrame();

    ghostEl = createGhostElement(sourceEl, sourceRect, animLayer);

    sourceEl.style.opacity = '0';

    // Hide focus immediately so only ghost + incoming overview are visible.
    focusLayer.classList.add('is-transitioning-out');
    focusLayer.style.opacity = '0';
    focusLayer.style.pointerEvents = 'none';

    if (reduceMotionQuery.matches) {
      await quickCrossfadeToOverview({ overviewLayer, focusLayer });
      cleanupGhost(ghostEl, sourceEl, animLayer);
      reflowChartsAfterTransition();
      return true;
    }

    const dx = targetRect.left - sourceRect.left;
    const dy = targetRect.top - sourceRect.top;
    const sx = Math.max(0.01, targetRect.width / sourceRect.width);
    const sy = Math.max(0.01, targetRect.height / sourceRect.height);

    await nextFrame();

    ghostEl.style.transition = `transform ${ZOOM_DURATION_MS}ms ${ZOOM_EASING}, opacity 220ms ease`;
    ghostEl.style.transform = `translate3d(${dx}px, ${dy}px, 0px) scale(${sx}, ${sy})`;

    overviewLayer.style.opacity = '1';
    overviewLayer.style.filter = 'blur(0px)';

    await waitForTransitionEnd(ghostEl, 'transform', ZOOM_DURATION_MS);

    markLayerVisible(overviewLayer);
    setLayerOrder({ overviewLayer, focusLayer, top: 'overview' });
    overviewLayer.classList.remove('is-transitioning-in', 'is-transitioning-out');
    overviewLayer.style.pointerEvents = 'auto';
    overviewLayer.style.opacity = '1';
    overviewLayer.style.filter = '';

    markLayerHidden(focusLayer);
    focusLayer.classList.remove('is-transitioning-out', 'is-transitioning-in');
    resetLayerStyles(focusLayer);

    cleanupGhost(ghostEl, sourceEl, animLayer);
    reflowChartsAfterTransition();

    return true;
  } finally {
    isAnimating = false;
  }
}
