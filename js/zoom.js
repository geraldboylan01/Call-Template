const DEFAULT_DURATION = 430;
const DEFAULT_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

function isReducedMotion() {
  return reduceMotionQuery.matches;
}

function waitForAnimation(animation) {
  if (!animation || !animation.finished) {
    return Promise.resolve();
  }

  return animation.finished.catch(() => undefined);
}

function makeGhost(sourceElement) {
  const rect = sourceElement.getBoundingClientRect();
  const ghost = sourceElement.cloneNode(true);

  ghost.removeAttribute('id');
  ghost.classList.add('zoom-ghost');
  ghost.style.position = 'fixed';
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.margin = '0';
  ghost.style.transformOrigin = 'top left';
  ghost.style.pointerEvents = 'none';
  ghost.style.zIndex = '70';

  document.body.appendChild(ghost);

  return {
    ghost,
    rect
  };
}

async function crossFade(fromView, toView, duration) {
  toView.style.opacity = '0';
  toView.style.visibility = 'visible';

  const fadeOut = fromView.animate(
    [
      { opacity: 1 },
      { opacity: 0 }
    ],
    {
      duration,
      easing: 'ease',
      fill: 'forwards'
    }
  );

  const fadeIn = toView.animate(
    [
      { opacity: 0 },
      { opacity: 1 }
    ],
    {
      duration,
      easing: 'ease',
      fill: 'forwards'
    }
  );

  await Promise.all([waitForAnimation(fadeOut), waitForAnimation(fadeIn)]);

  fromView.style.opacity = '';
  toView.style.opacity = '';
}

export async function animateZoomTransition({
  fromCard,
  toCard,
  fromView,
  toView,
  duration = DEFAULT_DURATION,
  easing = DEFAULT_EASING
}) {
  if (!fromCard || !toCard || !fromView || !toView) {
    return;
  }

  toView.style.visibility = 'visible';

  if (isReducedMotion()) {
    await crossFade(fromView, toView, 180);
    return;
  }

  const { ghost, rect: fromRect } = makeGhost(fromCard);
  const toRect = toCard.getBoundingClientRect();

  const deltaX = toRect.left - fromRect.left;
  const deltaY = toRect.top - fromRect.top;
  const scaleX = Math.max(0.01, toRect.width / fromRect.width);
  const scaleY = Math.max(0.01, toRect.height / fromRect.height);

  fromCard.style.visibility = 'hidden';
  toCard.style.visibility = 'hidden';

  toView.style.opacity = '0';
  toView.style.filter = 'blur(1px)';

  // Force style flush before starting animations.
  void toView.offsetWidth;

  const ghostAnimation = ghost.animate(
    [
      { transform: 'translate(0px, 0px) scale(1, 1)', opacity: 1 },
      {
        transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})`,
        opacity: 0.98
      }
    ],
    {
      duration,
      easing,
      fill: 'forwards'
    }
  );

  const incomingAnimation = toView.animate(
    [
      { opacity: 0, filter: 'blur(1px)' },
      { opacity: 1, filter: 'blur(0px)' }
    ],
    {
      duration,
      easing,
      fill: 'forwards'
    }
  );

  const outgoingAnimation = fromView.animate(
    [
      { opacity: 1 },
      { opacity: 0.45 }
    ],
    {
      duration,
      easing,
      fill: 'forwards'
    }
  );

  await Promise.all([
    waitForAnimation(ghostAnimation),
    waitForAnimation(incomingAnimation),
    waitForAnimation(outgoingAnimation)
  ]);

  fromCard.style.visibility = '';
  toCard.style.visibility = '';

  toView.style.opacity = '';
  toView.style.filter = '';
  fromView.style.opacity = '';

  ghost.remove();
}

export function reduceMotionListener(callback) {
  reduceMotionQuery.addEventListener('change', callback);
  return () => reduceMotionQuery.removeEventListener('change', callback);
}
