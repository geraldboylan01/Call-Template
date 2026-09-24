// A director's light over the live DOM. No values, charts or report nodes are copied.
export const prefersQuietMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const nextFrame = () => new Promise(requestAnimationFrame);

export async function glideTo(root, destination, immediate = false) {
  const from = root.scrollTop;
  const to = Math.min(Math.max(0, destination), Math.max(0, root.scrollHeight - root.clientHeight));
  if (immediate || prefersQuietMotion() || Math.abs(to - from) < 2) {
    root.scrollTo({ top: to, behavior: 'instant' });
    return;
  }
  const duration = Math.min(850, 440 + Math.sqrt(Math.abs(to - from)) * 9);
  const start = performance.now();
  await new Promise(resolve => {
    const tick = now => {
      const t = Math.min(1, (now - start) / duration);
      // Quintic smoothstep: no abrupt acceleration at departure or arrival.
      const eased = t * t * t * (t * (t * 6 - 15) + 10);
      root.scrollTo({ top: from + (to - from) * eased, behavior: 'instant' });
      if (t < 1 && root.isConnected) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
}

export async function changePresenterScene(update, root) {
  if (prefersQuietMotion()) return update();
  if (typeof document.startViewTransition === 'function') {
    // Only mount/paint here. Animation completion and final framing happen
    // afterwards: the browser suppresses rendering in the update callback.
    // Camera and HUD remain live, outside the named stage transition.
    const transition = document.startViewTransition(update);
    await transition.updateCallbackDone; // Never hide a real renderer error.
    await transition.finished.catch(() => {}); // Resizing may skip the visual effect.
    return;
  }
  const outgoing = root();
  const animation = outgoing?.animate([{ opacity: 1 }, { opacity: .15 }], { duration: 150, easing: 'ease-out', fill: 'forwards' });
  try {
    await animation?.finished;
    await update();
    await root()?.animate([{ opacity: .15 }, { opacity: 1 }], { duration: 360, easing: 'ease-out' }).finished;
  } finally { animation?.cancel(); }
}

export function createPresenterAttention() {
  const layer = document.createElement('div');
  layer.className = 'presenter-attention'; layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = '<div class="presenter-light"><i class="presenter-underline"></i></div><div class="presenter-point-guide"></div><div class="presenter-point-halo"></div>';
  document.body.append(layer);
  const light = layer.querySelector('.presenter-light');
  const underline = layer.querySelector('.presenter-underline');
  const guide = layer.querySelector('.presenter-point-guide');
  const halo = layer.querySelector('.presenter-point-halo');
  let root, element, treatment, getPoint, observer, frame, evidence = null;
  const place = (node, rect) => Object.assign(node.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  function position() {
    if (!root?.isConnected || !element?.isConnected) { clear(); return; }
    const bounds = root.getBoundingClientRect();
    const viewport = { top: Math.max(0, bounds.top), right: Math.min(innerWidth, bounds.right), bottom: Math.min(innerHeight, bounds.bottom), left: Math.max(0, bounds.left) };
    layer.style.clipPath = `inset(${viewport.top}px ${Math.max(0, innerWidth - viewport.right)}px ${Math.max(0, innerHeight - viewport.bottom)}px ${viewport.left}px round 18px)`;
    const rect = element.getBoundingClientRect();
    const padding = treatment === 'underline' ? 12 : 10;
    const left = Math.max(viewport.left + 2, rect.left - padding), top = Math.max(viewport.top + 2, rect.top - padding);
    const right = Math.min(viewport.right - 2, rect.right + padding), bottom = Math.min(viewport.bottom - 2, rect.bottom + padding);
    if (right <= left || bottom <= top) { layer.classList.remove('is-visible'); return; }
    place(light, { left, top, width: right - left, height: bottom - top });
    // Underline the actual value when a component provides one, otherwise the
    // selected row/card. These are renderer-owned elements, never script text.
    const value = element.querySelector('.pbs-bucket-row-amount, .pbs-amount-col, .report-kpi-value');
    const lineRect = (value || element).getBoundingClientRect();
    Object.assign(underline.style, { left: `${Math.max(10, lineRect.left - left)}px`, top: `${Math.min(bottom - top - 4, lineRect.bottom - top + 4)}px`, width: `${Math.min(lineRect.width, right - left - 20)}px` });
    const point = treatment === 'point' ? getPoint?.() : null;
    if (point) {
      place(halo, { left: point.x - 17, top: point.y - 17, width: 34, height: 34 });
      place(guide, { left: point.x, top: point.y + 20, width: 1, height: Math.max(0, point.bottom - point.y - 20) });
    }
    layer.classList.add('is-visible');
    evidence = { treatment, rect: { left, top, width: right - left, height: bottom - top }, point };
  }
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); };
  function clear() {
    layer.classList.remove('is-visible');
    root?.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    observer?.disconnect(); observer = null; cancelAnimationFrame(frame);
    root = element = getPoint = null; evidence = null;
  }
  return {
    clear,
    async focus(nextRoot, nextElement, nextTreatment, point) {
      clear(); root = nextRoot; element = nextElement; treatment = nextTreatment; getPoint = point;
      layer.dataset.treatment = treatment;
      position();
      root.addEventListener('scroll', schedule, { passive: true }); window.addEventListener('resize', schedule);
      observer = new ResizeObserver(schedule); observer.observe(root); observer.observe(element);
      await nextFrame();
      if (!prefersQuietMotion()) await new Promise(resolve => setTimeout(resolve, 420));
      return evidence;
    },
    refresh: schedule,
    get evidence() { return evidence; }
  };
}
