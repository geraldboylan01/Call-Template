import {
  PLANEIR_WORDMARK_LETTER_PATH, NEWGRANGE_RING_PATH,
  NEWGRANGE_DISC_PATH, PLANEIR_TITTLE_TRANSFORM
} from './planeir_brand_artwork.js';

export const SUCCESS_TIMING = Object.freeze({
  flightStart: 80, flightEnd: 830, beamStart: 900, ignite: 1520,
  copyAt: 1850, copyEnd: 2270, exitAt: 5650, returnEnd: 6210,
  fadeOutAt: 6090, endAt: 6490
});
export const PASSAGE_PATH = 'M 67.24 61.65 L 136.81 11.10 A 90 90 0 0 0 115.62 -9.72 L 66.29 60.72 A 4 4 0 0 1 67.24 61.65 Z';
export const span = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));
export const mix = (a, b, p) => a + (b - a) * p;

export function bezier(p, x1, y1, x2, y2) {
  if (p <= 0 || p >= 1) return Math.max(0, Math.min(1, p));
  const coordinate = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
  let low = 0, high = 1;
  for (let i = 0; i < 20; i += 1) {
    const t = (low + high) / 2;
    if (coordinate(t, x1, x2) < p) low = t;
    else high = t;
  }
  return coordinate((low + high) / 2, y1, y2);
}
export const arrival = p => bezier(p, 0.16, 1, 0.3, 1);
export const standard = p => bezier(p, 0.4, 0, 0.2, 1);
export const emphasis = p => bezier(p, 0.22, 1, 0.36, 1);

// Pure authored-time frame, shared by production and exact-time regression tests.
export function alignmentFrame(t) {
  const glow = span(t, 1480, 1900);
  const flash = span(t, 1460, 1580) * (1 - span(t, 1580, 2220));
  const dim = 1 - span(t, 80, 300) * (1 - glow);
  return {
    beamX: mix(150, 64, arrival(span(t, 900, 1560))) - 15,
    beam: span(t, 900, 1040) * (1 - span(t, 1640, 2040)),
    glow: glow * dim,
    ring: (0.16 + 0.56 * glow) * dim + 0.16 * (1 - dim),
    letters: 0.55 + 0.45 * glow,
    focus: 1 + 0.08 * (emphasis(span(t, 780, 1200)) - standard(span(t, 1850, 2270))),
    discBloom: Math.min(1, glow * 0.45 + flash * 0.9),
    outerBloom: Math.min(1, glow * 0.12 + flash * 0.34)
  };
}

let instanceId = 0;
export function createAlignmentMarkup() {
  const id = `planeir-alignment-${++instanceId}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1330 384" width="1330" height="384" class="lead-success-artwork" aria-hidden="true" focusable="false" data-planeir-alignment="" shape-rendering="geometricPrecision">
    <defs>
      <linearGradient id="${id}-letters" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#F4F8FC"/><stop offset="1" stop-color="#CFE8FB"/></linearGradient>
      <linearGradient id="${id}-beam" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#DFF2FF" stop-opacity="0"/><stop offset=".5" stop-color="#FFFFFF"/><stop offset="1" stop-color="#DFF2FF" stop-opacity="0"/></linearGradient>
      <radialGradient id="${id}-disc" cx=".42" cy=".38" r=".7"><stop stop-color="#FFFFFF"/><stop offset=".42" stop-color="#D8EFFF"/><stop offset="1" stop-color="#65BFF4"/></radialGradient>
      <filter id="${id}-soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.7"/></filter>
      <filter id="${id}-bloom" x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation="4.5"/></filter>
      <mask id="${id}-passage" maskUnits="userSpaceOnUse" x="-40" y="-40" width="208" height="208"><path d="${PASSAGE_PATH}" fill="#fff" filter="url(#${id}-soft)"/></mask>
    </defs>
    <g data-alignment-lit="">
      <path data-alignment-letters="" d="${PLANEIR_WORDMARK_LETTER_PATH}" fill="url(#${id}-letters)"/>
      <g data-planeir-mark="tittle" transform="${PLANEIR_TITTLE_TRANSFORM}">
        <g data-alignment-focus="">
          <g data-alignment-beam="" mask="url(#${id}-passage)"><rect data-alignment-light="" y="-40" width="30" height="208" fill="url(#${id}-beam)"/></g>
          <path data-alignment-ring="" d="${NEWGRANGE_RING_PATH}" fill="#A8DCFF"/>
          <path d="${NEWGRANGE_DISC_PATH}" fill="rgba(141,211,255,.10)" stroke="rgba(151,211,251,.28)" stroke-width=".6"/>
          <path data-alignment-disc="" d="${NEWGRANGE_DISC_PATH}" fill="url(#${id}-disc)"/>
          <circle data-alignment-disc-bloom="" cx="64" cy="64" r="13" fill="#EAF7FF" filter="url(#${id}-bloom)"/>
          <circle data-alignment-outer-bloom="" cx="64" cy="64" r="28" fill="#8DD3FF" filter="url(#${id}-bloom)"/>
        </g>
      </g>
    </g>
    <g data-alignment-neutral="" fill="#F4F8FC" opacity="0">
      <path d="${PLANEIR_WORDMARK_LETTER_PATH}"/>
      <g transform="${PLANEIR_TITTLE_TRANSFORM}"><path d="${NEWGRANGE_RING_PATH}"/><path d="${NEWGRANGE_DISC_PATH}"/></g>
    </g>
  </svg>`;
}

export function createAlignmentArtwork(root) {
  root.innerHTML = createAlignmentMarkup();
  const elements = Object.fromEntries(['lit', 'letters', 'focus', 'beam', 'light', 'ring', 'disc', 'disc-bloom', 'outer-bloom', 'neutral'].map(key => [key, root.querySelector(`[data-alignment-${key}]`)]));
  function render(frame, neutral = 0) {
    const set = (key, name, value) => elements[key]?.setAttribute(name, String(value));
    set('lit', 'opacity', 1 - neutral);
    set('neutral', 'opacity', neutral);
    set('letters', 'opacity', frame.letters);
    set('focus', 'transform', `translate(64 64) scale(${frame.focus}) translate(-64 -64)`);
    set('beam', 'opacity', frame.beam);
    set('light', 'x', frame.beamX);
    set('ring', 'opacity', frame.ring);
    set('disc', 'opacity', frame.glow);
    set('disc-bloom', 'opacity', frame.discBloom);
    set('outer-bloom', 'opacity', frame.outerBloom);
  }
  render(alignmentFrame(2270), 1);
  return { render, reset: () => render(alignmentFrame(2270), 1) };
}
