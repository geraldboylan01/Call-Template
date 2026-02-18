const SWIPE_DURATION_MS = 400;
const SWIPE_EASING = 'cubic-bezier(0.2, 0.84, 0.28, 1)';
const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

function reflowChartsAfterTransition() {
  if (typeof window.__callcanvasReflowCharts === 'function') {
    window.__callcanvasReflowCharts();
  }
}

function waitForTransitionEnd(element, timeoutMs) {
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
      if (event.target === element) {
        finish();
      }
    }

    const timeoutId = window.setTimeout(finish, timeoutMs + 80);
    element.addEventListener('transitionend', onEnd);
  });
}

export function mountInitialPane(stageElement, paneElement) {
  stageElement.innerHTML = '';
  paneElement.classList.add('swipe-pane', 'active');
  paneElement.style.transform = 'translateX(0)';
  paneElement.style.opacity = '1';
  stageElement.appendChild(paneElement);
}

export async function swipeToPane(stageElement, nextPaneElement, direction = 'forward') {
  const currentPane = stageElement.querySelector('.swipe-pane.active');

  if (!currentPane) {
    if (reduceMotionQuery.matches) {
      mountInitialPane(stageElement, nextPaneElement);
      reflowChartsAfterTransition();
      return;
    }

    nextPaneElement.classList.add('swipe-pane', 'active');
    nextPaneElement.style.transform = 'translateX(100%)';
    nextPaneElement.style.opacity = '0.9';
    stageElement.innerHTML = '';
    stageElement.appendChild(nextPaneElement);

    await new Promise((resolve) => requestAnimationFrame(resolve));

    nextPaneElement.style.transition = `transform ${SWIPE_DURATION_MS}ms ${SWIPE_EASING}, opacity ${SWIPE_DURATION_MS}ms ${SWIPE_EASING}`;
    nextPaneElement.style.transform = 'translateX(0)';
    nextPaneElement.style.opacity = '1';

    await waitForTransitionEnd(nextPaneElement, SWIPE_DURATION_MS);

    nextPaneElement.style.transition = '';
    reflowChartsAfterTransition();
    return;
  }

  if (reduceMotionQuery.matches) {
    mountInitialPane(stageElement, nextPaneElement);
    reflowChartsAfterTransition();
    return;
  }

  const outgoingX = direction === 'backward' ? '100%' : '-100%';
  const incomingX = direction === 'backward' ? '-100%' : '100%';

  nextPaneElement.classList.add('swipe-pane', 'incoming');
  nextPaneElement.style.transform = `translateX(${incomingX})`;
  nextPaneElement.style.opacity = '0.92';
  stageElement.appendChild(nextPaneElement);

  // Split reads/writes with requestAnimationFrame for smoothness.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  currentPane.style.transition = `transform ${SWIPE_DURATION_MS}ms ${SWIPE_EASING}, opacity ${SWIPE_DURATION_MS}ms ${SWIPE_EASING}`;
  nextPaneElement.style.transition = `transform ${SWIPE_DURATION_MS}ms ${SWIPE_EASING}, opacity ${SWIPE_DURATION_MS}ms ${SWIPE_EASING}`;

  currentPane.style.transform = `translateX(${outgoingX})`;
  currentPane.style.opacity = '0.66';
  nextPaneElement.style.transform = 'translateX(0)';
  nextPaneElement.style.opacity = '1';

  await Promise.all([
    waitForTransitionEnd(currentPane, SWIPE_DURATION_MS),
    waitForTransitionEnd(nextPaneElement, SWIPE_DURATION_MS)
  ]);

  currentPane.remove();

  nextPaneElement.classList.remove('incoming');
  nextPaneElement.classList.add('active');
  nextPaneElement.style.transition = '';
  nextPaneElement.style.transform = 'translateX(0)';
  nextPaneElement.style.opacity = '1';
  reflowChartsAfterTransition();
}

export function getSwipeTiming() {
  return {
    duration: SWIPE_DURATION_MS,
    easing: SWIPE_EASING
  };
}
