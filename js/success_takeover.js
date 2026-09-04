import { alignmentFrame, arrival, emphasis, standard, mix, span, createAlignmentArtwork, SUCCESS_TIMING } from './success_alignment.js';

const RATIO = 1330 / 384;
const STYLE_PROPERTIES = ['opacity', 'transform', 'transform-origin', 'will-change'];
const defaultClock = {
  now: () => window.performance.now(),
  request: callback => window.requestAnimationFrame(callback),
  cancel: handle => window.cancelAnimationFrame(handle)
};

function visibleRect(element) {
  if (!element?.isConnected) return null;
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const width = Math.min(rect.width, rect.height * RATIO);
  const height = width / RATIO;
  return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
}

function inverse(origin, stage) {
  return { x: origin.left - stage.left, y: origin.top - stage.top, scale: origin.width / stage.width };
}
const transform = pose => `translate3d(${pose.x}px, ${pose.y}px, 0) scale(${pose.scale})`;

/** One cancellable clock owns flight, light, message, countdown, and return. */
export function createSuccessTakeover(options = {}) {
  const {
    overlay, origin, target, title, body, lockTargets = [],
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)'),
    holdMs = 3800, reducedHoldMs = 3800,
    activeBodyClass = 'is-lead-success-active', clock = defaultClock
  } = options;
  if (!overlay || !target) return { play: async () => false, reset() {} };
  const shell = target.querySelector('.lead-success-wordmark-shell') || target;
  const artwork = createAlignmentArtwork(shell);
  const copy = overlay.querySelector('.lead-success-copy');
  const timer = overlay.querySelector('.lead-success-timer');
  const timerBar = overlay.querySelector('.lead-success-timer-bar');
  const dismissButton = document.createElement('button');
  dismissButton.type = 'button';
  dismissButton.className = 'lead-success-dismiss';
  dismissButton.textContent = 'Close';
  dismissButton.setAttribute('aria-label', 'Dismiss success message');
  overlay.appendChild(dismissButton);
  let run = null;

  function finish(completed = false, restoreFocus = true) {
    const current = run;
    if (!current) return;
    run = null;
    clock.cancel(current.raf);
    current.cleanups.forEach(cleanup => cleanup());
    current.inert.forEach(([node, value]) => { node.inert = value; });
    document.body.classList.toggle(activeBodyClass, current.bodyWasActive);
    if (origin?.style) origin.style.visibility = current.originVisibility;
    overlay.classList.remove('is-active', 'is-measuring', 'is-exiting', 'is-reduced-motion');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.removeProperty('--lead-success-backdrop-opacity');
    for (const element of [target, copy, timer, timerBar]) {
      STYLE_PROPERTIES.forEach(property => element?.style.removeProperty(property));
    }
    current.savedStyles.forEach(([node, cssText]) => { node.style.cssText = cssText; });
    copy?.setAttribute('aria-hidden', 'true');
    artwork.reset();
    const focus = current.restoreFocusTo;
    if (restoreFocus && focus?.isConnected && !focus.disabled && focus.getClientRects().length && !focus.closest('[inert], [hidden], [aria-hidden="true"]')) {
      focus.focus({ preventScroll: true });
    }
    current.resolve(completed && !current.reduced);
  }

  function returnDestination() {
    const destination = visibleRect(origin);
    if (!destination) return null;
    // The shell inherits the flight transform: measure its neutral box briefly.
    const saved = target.style.transform;
    target.style.transform = 'none';
    const stage = visibleRect(shell);
    target.style.transform = saved;
    return stage ? inverse(destination, stage) : null;
  }

  function dismiss(rebase = false) {
    const current = run;
    if (!current || (current.exit && !rebase)) return;
    if (!current.started) { finish(false); return; }
    current.exit = {
      at: current.time, pose: { ...current.pose }, frame: { ...current.frame },
      copyOpacity: current.copyOpacity, backdrop: current.backdrop,
      opacity: current.opacity, neutral: current.neutral || 0,
      destination: current.reduced ? null : returnDestination()
    };
    overlay.classList.add('is-exiting');
  }

  function render(current) {
    const t = current.time;
    const copyAt = current.reduced ? 0 : SUCCESS_TIMING.copyAt;
    const hold = current.reduced ? Math.min(holdMs, reducedHoldMs) : holdMs;
    const copyProgress = span(t, copyAt, copyAt + (current.reduced ? 200 : 420));
    current.copyOpacity = copyProgress;
    current.backdrop = span(t, 0, current.reduced ? 200 : 420);
    current.opacity = current.reduced ? copyProgress : 1;
    if (current.reduced) {
      current.frame = { ...alignmentFrame(2270), beam: 0, focus: 1, discBloom: 0, outerBloom: 0 };
      current.pose = { x: 0, y: 0, scale: 1 };
    } else if (!current.exit) {
      const p = arrival(span(t, 80, 830));
      current.pose = { x: current.from.x * (1 - p), y: current.from.y * (1 - p) - 70 * Math.sin(Math.PI * p), scale: mix(current.from.scale, 1, p) };
      current.frame = alignmentFrame(t);
    }
    if (t >= copyAt && !current.announced) {
      current.announced = true;
      copy?.removeAttribute('aria-hidden');
      if (title) title.textContent = current.titleText;
      if (body) body.textContent = current.bodyText;
    }
    if (t >= copyAt + hold && !current.exit) {
      dismiss();
      current.exit.at = copyAt + hold;
    }
    let neutral = 0;
    if (current.exit) {
      const exit = current.exit;
      const e = Math.max(0, t - exit.at);
      const fly = !current.reduced && exit.destination;
      const p = standard(span(e, 0, 560));
      current.pose = fly ? {
        x: mix(exit.pose.x, exit.destination.x, p),
        y: mix(exit.pose.y, exit.destination.y, p) - 38.5 * Math.sin(Math.PI * p),
        scale: mix(exit.pose.scale, exit.destination.scale, p)
      } : exit.pose;
      current.frame = exit.frame;
      neutral = fly ? mix(exit.neutral, 1, span(e, 0, 560)) : exit.neutral;
      current.copyOpacity = exit.copyOpacity * (1 - span(e, 0, current.reduced ? 200 : 320));
      current.backdrop = exit.backdrop * (1 - span(e, fly ? 440 : 0, fly ? 840 : current.reduced ? 200 : 400));
      current.opacity = fly ? exit.opacity : exit.opacity * (1 - span(e, 0, current.reduced ? 200 : 400));
      if (e >= (fly ? 840 : current.reduced ? 200 : 400)) { finish(true); return; }
    }
    target.style.transform = transform(current.pose);
    current.neutral = neutral;
    target.style.opacity = String(current.opacity);
    artwork.render(current.frame, neutral);
    overlay.style.setProperty('--lead-success-backdrop-opacity', String(current.backdrop));
    if (copy) {
      copy.style.opacity = String(current.copyOpacity);
      copy.style.transform = current.reduced ? 'none' : `translateY(${16 * (1 - emphasis(copyProgress))}px)`;
    }
    if (timer) timer.style.opacity = String(current.copyOpacity);
    if (timerBar) timerBar.style.transform = `scaleX(${span(t, copyAt, copyAt + hold)})`;
  }

  function play(playOptions = {}) {
    const replayFocus = overlay.contains(document.activeElement) ? run?.restoreFocusTo : null;
    finish(false, false);
    return new Promise(resolve => {
      const active = document.activeElement;
      const shouldRestore = playOptions.restoreFocus ?? Boolean(replayFocus || !playOptions.restoreFocusIfContainedIn || playOptions.restoreFocusIfContainedIn.contains(active));
      const current = {
        resolve, raf: null, cleanups: [], time: 0, started: false, announced: false,
        last: clock.now(), preparationStart: clock.now(), stableFrames: 0, viewport: null,
        imagesReady: false, hidden: document.hidden, reduced: motionQuery.matches,
        restoreFocusTo: shouldRestore ? (playOptions.restoreFocusTo || replayFocus || active) : null,
        titleText: playOptions.titleText || title?.textContent || 'Congratulations',
        bodyText: playOptions.bodyText || body?.textContent || '',
        originVisibility: origin?.style.visibility || '',
        bodyWasActive: document.body.classList.contains(activeBodyClass),
        inert: lockTargets.filter(Boolean).map(node => [node, node.inert]),
        savedStyles: [target, copy, timer, timerBar].filter(Boolean).map(node => [node, node.style.cssText])
      };
      run = current;
      const listen = (node, event, handler, capture = false) => {
        node?.addEventListener?.(event, handler, capture);
        current.cleanups.push(() => node?.removeEventListener?.(event, handler, capture));
      };
      listen(overlay, 'click', event => { event.stopPropagation(); dismiss(); });
      listen(window, 'keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); dismiss(); }
        if (event.key === 'Tab') { event.preventDefault(); dismissButton.focus({ preventScroll: true }); }
      }, true);
      listen(window, 'pagehide', () => finish(false));
      listen(window, 'popstate', () => finish(false));
      listen(document, 'visibilitychange', () => {
        current.hidden = document.hidden;
        current.last = clock.now();
        clock.cancel(current.raf);
        if (!current.hidden) current.raf = clock.request(tick);
      });
      listen(window, 'resize', () => {
        if (current.exit) dismiss(true);
      });
      listen(motionQuery, 'change', event => {
        if (event.matches) {
          current.reduced = true;
          current.time = 0;
          current.exit = null;
          overlay.classList.add('is-reduced-motion');
        }
      });
      const image = origin?.tagName === 'IMG' ? origin : origin?.querySelector('img');
      Promise.resolve().then(() => image?.decode?.()).catch(() => {}).then(() => { current.imagesReady = true; });
      active?.blur?.();
      document.body.classList.add(activeBodyClass);
      current.inert.forEach(([node]) => { node.inert = true; });
      copy?.setAttribute('aria-hidden', 'true');
      // Reserve the final message's layout before measuring the flight target.
      if (title) title.textContent = current.titleText;
      if (body) body.textContent = current.bodyText;
      overlay.classList.add('is-measuring');
      target.style.transform = 'none';
      target.style.transformOrigin = 'top left';
      target.style.willChange = 'transform';

      function tick(now) {
        if (run !== current || current.hidden) return;
        if (!current.started) {
          const vv = window.visualViewport;
          const viewport = [vv?.width ?? window.innerWidth, vv?.height ?? window.innerHeight, vv?.offsetTop ?? 0, vv?.offsetLeft ?? 0].join(',');
          current.stableFrames = viewport === current.viewport ? current.stableFrames + 1 : 0;
          current.viewport = viewport;
          if ((current.imagesReady && current.stableFrames >= 4) || now - current.preparationStart >= 520) {
            const stage = visibleRect(shell);
            const originBox = visibleRect(origin);
            if (!stage) { finish(false); return; }
            current.from = originBox ? inverse(originBox, stage) : { x: 0, y: 0, scale: 1 };
            current.started = true;
            current.last = now;
            if (origin?.style) origin.style.visibility = 'hidden';
            overlay.classList.remove('is-measuring');
            overlay.classList.add('is-active');
            overlay.classList.toggle('is-reduced-motion', current.reduced);
            overlay.setAttribute('aria-hidden', 'false');
            dismissButton.focus({ preventScroll: true });
          }
        } else {
          current.time += Math.max(0, now - current.last);
          current.last = now;
        }
        if (current.started) render(current);
        if (run === current) current.raf = clock.request(tick);
      }
      if (!current.hidden) current.raf = clock.request(tick);
    });
  }
  return { play, reset: () => finish(false) };
}
