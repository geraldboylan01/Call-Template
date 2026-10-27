/**
 * OUTLINING A FIGURE, ONCE.
 *
 * When a story link opens a module, the figure the sentence named gets a ring so
 * you can see which number it meant. The module is drawn by the module; this
 * only finds the figure in what it drew and puts a ring over it for a moment.
 * The ring is a separate fixed element, so nothing inside the module is touched,
 * restyled or moved.
 *
 * A figure is found by a selector (a place inside the module), or by the words
 * the module itself prints, taking the smallest element that holds them. Modules
 * count their figures up, so it waits for the final text rather than failing at
 * the first look.
 */

const SKIP = new Set(['SCRIPT', 'STYLE', 'SVG', 'PATH', 'CANVAS']);
const RING_MS = 2200;

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

function isVisible(element) {
  if (!element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** The smallest visible element in `root` whose text holds `text`. */
export function findElementWithText(root, text) {
  const needle = squash(text);
  if (!needle) return null;
  const hits = [...root.querySelectorAll('*')].filter((element) => (
    !SKIP.has(element.tagName.toUpperCase())
    && !element.closest('[data-ps-chrome]')
    && squash(element.textContent).includes(needle)
  ));
  const smallest = hits.filter((element) => !hits.some((other) => other !== element && element.contains(other)));
  return smallest.find(isVisible) || null;
}

export function findFigureElement(root, { selector = null, text = null } = {}) {
  if (selector) {
    let found = null;
    try { found = root.querySelector(selector); } catch (_error) { found = null; }
    if (found && isVisible(found)) return found;
  }
  return text ? findElementWithText(root, text) : null;
}

const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const frame = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

let activeRing = null;

export function clearOutline() {
  if (!activeRing) return;
  activeRing.cleanup();
  activeRing = null;
}

/**
 * Finds the figure (waiting up to `timeoutMs` for it to be drawn), brings it to
 * the middle of the screen, rings it once and takes the ring away again.
 * Resolves true when a ring was drawn.
 */
export async function outlineFigure(root, { selector = null, text = null, timeoutMs = 3000 } = {}) {
  clearOutline();
  if (!root || (!selector && !text)) return false;

  const started = Date.now();
  let element = null;
  while (!element && Date.now() - started < timeoutMs) {
    element = findFigureElement(root, { selector, text });
    if (!element) await wait(120);
  }
  if (!element) return false;

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  await frame();
  await frame();
  // The figure may still be moving (a count-up, a chart settling): ring where it ends up.
  let rect = element.getBoundingClientRect();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await wait(80);
    const next = element.getBoundingClientRect();
    const still = Math.abs(next.top - rect.top) < 1 && Math.abs(next.left - rect.left) < 1;
    rect = next;
    if (still) break;
  }

  const pad = 6;
  const ring = document.createElement('div');
  ring.className = `ps-outline${reduced ? ' is-still' : ''}`;
  ring.setAttribute('aria-hidden', 'true');
  ring.setAttribute('data-ps-chrome', '');
  // What the ring is around, in the module's own words, so a check can compare it with the story.
  ring.setAttribute('data-ps-figure', squash(element.textContent).slice(0, 200));
  Object.assign(ring.style, {
    top: `${rect.top - pad}px`,
    left: `${rect.left - pad}px`,
    width: `${rect.width + pad * 2}px`,
    height: `${rect.height + pad * 2}px`
  });
  document.body.appendChild(ring);

  const cleanup = () => {
    window.clearTimeout(timer);
    window.removeEventListener('pointerdown', clearOutline, true);
    window.removeEventListener('keydown', clearOutline, true);
    window.removeEventListener('wheel', clearOutline, true);
    ring.remove();
  };
  const timer = window.setTimeout(clearOutline, RING_MS);
  window.addEventListener('pointerdown', clearOutline, true);
  window.addEventListener('keydown', clearOutline, true);
  window.addEventListener('wheel', clearOutline, true);
  activeRing = { cleanup };
  return true;
}
