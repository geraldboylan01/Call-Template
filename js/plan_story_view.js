import { describeLink } from './plan_story_model.js';
import { describeBasis, formatBasisDate } from './plan_story_basis.js';

/**
 * THE PLAN STORY, DRAWN.
 *
 * A reading column of eight sections under a headline and summary, a narrow rail
 * with the route tabs and the at-a-glance table, and a "See it in" line at the
 * end of each section. Every figure that came from a module is a real link; the
 * screen asks the app to open it and takes no decision of its own about where it
 * goes. The words and the targets come from plan_story_model.js.
 *
 * Nothing here ranks, scores or colours a route. The selected route gets an
 * outline and the words "You're reading", and nothing else.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Small module marks, stand-ins until each module has an icon of its own. */
const PLAN_STORY_GLYPHS = Object.freeze({
  flow: 'M2 5h10M9 2l3 3-3 3M14 11H4M7 8l-3 3 3 3',
  res: 'M3 4.5c0-1 2.2-1.8 5-1.8s5 .8 5 1.8-2.2 1.8-5 1.8-5-.8-5-1.8zM3 4.5v3c0 1 2.2 1.8 5 1.8s5-.8 5-1.8v-3M3 7.5v3c0 1 2.2 1.8 5 1.8s5-.8 5-1.8v-3',
  prot: 'M8 1.8l5 1.8v4.2c0 3-2.2 5-5 6.4-2.8-1.4-5-3.4-5-6.4V3.6z',
  mort: 'M2 7.5L8 2.5l6 5M3.8 6.5v7h8.4v-7M6.5 13.5v-4h3v4',
  car: 'M2.5 10V8l1.4-3.2h8.2L13.5 8v2M2.5 10h11M2.5 10v2h2v-2M11.5 10v2h2v-2M4 8h8',
  coll: 'M1.5 6L8 3l6.5 3L8 9zM4 7.6v3c0 .9 1.8 1.8 4 1.8s4-.9 4-1.8v-3M14.5 6v4',
  pen: 'M4 2h8M4 14h8M5 2c0 3 3 4 3 6s-3 3-3 6M11 2c0 3-3 4-3 6s3 3 3 6',
  bal: 'M8 2v12M3 14h10M3 4.5h10M3 4.5L1.5 9a2 2 0 003 0zM13 4.5L11.5 9a2 2 0 003 0z',
  back: 'M13 8H3M7 4L3 8l4 4',
  info: 'M8 7.2V11M8 5v.2M14 8A6 6 0 112 8a6 6 0 0112 0z',
  stated: 'M8 8.4a2.6 2.6 0 100-5.2 2.6 2.6 0 000 5.2zM3 14c.4-2.6 2.4-4 5-4s4.6 1.4 5 4',
  calculated: 'M3 2.5h10v11H3zM5.5 5h5M5.5 8h1M9.5 8h1M5.5 11h1M9.5 11h1',
  assumption: 'M2 5h7M12 5h2M9 3.2v3.6M2 11h2M7 11h7M4 9.2v3.6',
  official: 'M8 1.8l5 1.8v4.2c0 3-2.2 5-5 6.4-2.8-1.4-5-3.4-5-6.4V3.6zM5.8 8l1.5 1.5 3-3',
  sync: 'M13 5.5A5.5 5.5 0 003.5 4.5M3 2v3h3M3 10.5a5.5 5.5 0 009.5 1M13 14v-3h-3'
});

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('data-') || key.startsWith('aria-') || key === 'role' || key === 'href' || key === 'id' || key === 'type' || key === 'scope' || key === 'tabindex' || key === 'target' || key === 'rel') node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function buildGlyph(name, className = 'ps-g') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', PLAN_STORY_GLYPHS[name] || PLAN_STORY_GLYPHS.info);
  svg.append(path);
  return svg;
}

let tipCounter = 0;
const nextTipId = () => `ps-tip-${tipCounter += 1}`;

/* ---------------------------------------------------------------- where a figure comes from */

/** One described basis (plan_story_basis.js) as the words in a popover. Evidence nests one level, as the fact holds it. */
function renderDescribed(described, nested = false) {
  const block = el('span', { class: `ps-basis${nested ? ' ps-basis-ev' : ''}`, 'data-ps-basis': described.kind },
    el('span', { class: 'ps-basis-kind' }, buildGlyph(described.kind), described.label));
  // A stated figure reads "You told us this on the form, in answer to:", then the question, then the rest.
  const [first, ...rest] = described.lines;
  block.append(el('span', { class: 'ps-basis-line', text: first }));
  for (const question of described.questions ?? []) {
    block.append(el('span', { class: 'ps-basis-q', text: question.label ? `“${question.label}”` : `Form question ${question.path} (its wording was not recorded)` }));
  }
  for (const line of rest) block.append(el('span', { class: 'ps-basis-line', text: line }));
  for (const source of described.sources ?? []) {
    block.append(el('span', { class: 'ps-basis-line' }, 'Source: ',
      source.url ? el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', text: source.title }) : source.title));
  }
  for (const entry of described.evidence ?? []) block.append(renderDescribed(entry, true));
  return block;
}

/** An explainer, whole: its title, its sentences, its official sources and the day they were read. */
function renderExplainer(explainer) {
  const block = el('span', { class: 'ps-about' }, el('b', { class: 'ps-about-title', text: explainer.title }));
  for (const sentence of explainer.sentences) block.append(el('span', { class: 'ps-about-line', text: sentence }));
  if (explainer.sources?.length) {
    const sources = el('span', { class: 'ps-about-sources' }, 'Sources: ');
    explainer.sources.forEach((source, index) => {
      if (index) sources.append('; ');
      sources.append(source.url ? el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', text: source.title }) : source.title);
    });
    block.append(sources);
  }
  const read = formatBasisDate(explainer.checkedOn);
  if (read) block.append(el('span', { class: 'ps-about-date', text: `Sources read on ${read}.` }));
  return block;
}

/** What a figure's popover says about where it comes from; the words come from the fact, never from the story. */
function basisBlock(segment) {
  if (!segment.basis) return null;
  const block = el('span', { class: 'ps-pop-basis' }, el('span', { class: 'ps-pop-head', text: 'Where this comes from' }),
    renderDescribed(describeBasis(segment.basis, { moduleTitle: segment.basisModule ?? null })));
  if (segment.about) block.append(el('span', { class: 'ps-pop-rule' }), renderExplainer(segment.about));
  return block;
}

/* ---------------------------------------------------------------- popovers: hover, focus, tap, Esc */

let documentWired = false;

function closePopover(wrap) {
  wrap.removeAttribute('data-ps-open');
  wrap.removeAttribute('data-ps-touch');
  wrap.querySelector('[aria-expanded]')?.setAttribute('aria-expanded', 'false');
}

/** Keeps a popover on screen: shifted in from the edge, and below its figure when there is no room above. */
function placePopover(wrap) {
  const pop = wrap.querySelector(':scope > .ps-tip');
  if (!pop) return;
  const place = () => {
    pop.style.removeProperty('--ps-shift');
    wrap.classList.remove('ps-below');
    const rect = pop.getBoundingClientRect();
    if (!rect.width) return;
    const limit = document.documentElement.clientWidth;
    const shift = rect.right > limit - 12 ? limit - 12 - rect.right : rect.left < 12 ? 12 - rect.left : 0;
    if (shift) pop.style.setProperty('--ps-shift', `${Math.round(shift)}px`);
    // The story scrolls inside the overview, under the app's header and the Story | Modules bar: "above" means above those.
    const scroller = wrap.closest('.overview-viewport');
    const top = scroller ? scroller.getBoundingClientRect().top + (scroller.querySelector('.ps-bar')?.offsetHeight ?? 0) : 0;
    if (rect.top < top + 8) wrap.classList.add('ps-below');
  };
  // Now, so it is in place when it first shows, and once more after the frame in case hover had not been applied yet.
  place();
  window.requestAnimationFrame(place);
}

function wireDocument() {
  if (documentWired) return;
  documentWired = true;
  // A tap elsewhere closes an open popover; Esc closes the one that is open or being pointed at.
  document.addEventListener('pointerdown', (event) => {
    for (const open of document.querySelectorAll('.ps-tw[data-ps-open]')) if (!open.contains(event.target)) closePopover(open);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const wrap of document.querySelectorAll('.ps-tw[data-ps-open], .ps-tw:hover, .ps-tw:focus-within')) {
      wrap.setAttribute('data-ps-dismissed', '');
      closePopover(wrap);
    }
  });
}

/** Hover and focus show a popover through the stylesheet; this adds tap, Esc and its placement. */
function wirePopover(wrap) {
  wireDocument();
  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { wrap.setAttribute('data-ps-dismissed', ''); closePopover(wrap); }
  });
  wrap.addEventListener('mouseenter', () => placePopover(wrap));
  wrap.addEventListener('focusin', () => placePopover(wrap));
  wrap.addEventListener('mouseleave', () => wrap.removeAttribute('data-ps-dismissed'));
  wrap.addEventListener('focusout', () => wrap.removeAttribute('data-ps-dismissed'));
}

function togglePopover(wrap, trigger) {
  const opening = !wrap.hasAttribute('data-ps-open');
  for (const other of document.querySelectorAll('.ps-tw[data-ps-open]')) if (other !== wrap) closePopover(other);
  wrap.removeAttribute('data-ps-dismissed');
  if (opening) {
    wrap.setAttribute('data-ps-open', '');
    trigger.setAttribute('aria-expanded', 'true');
    placePopover(wrap);
  } else closePopover(wrap);
}

/** A figure that is plain text in the story, with its basis: a button that opens its popover. */
function renderFigure(segment) {
  const id = nextTipId();
  const button = el('button', { class: `ps-fig${segment.type === 'reason' ? ' ps-fig-reason' : ''}`, type: 'button', 'aria-describedby': id, 'aria-expanded': 'false', 'data-ps-key': segment.key, 'data-ps-basis-kind': segment.basis.kind }, segment.text);
  const wrap = el('span', { class: 'ps-tw ps-tw-fig' }, button, el('span', { class: 'ps-tip ps-pop', role: 'tooltip', id }, basisBlock(segment)));
  button.addEventListener('click', () => togglePopover(wrap, button));
  wirePopover(wrap);
  return wrap;
}

/** The small info marker after a phrase: the register's explainer on hover, focus or tap. */
function renderExplainerMarker(segment) {
  const id = nextTipId();
  const button = el('button', { class: 'ps-explain', type: 'button', 'aria-describedby': id, 'aria-expanded': 'false', 'aria-label': `About: ${segment.explainer.title}`, 'data-ps-explainer': segment.id }, buildGlyph('info'));
  const wrap = el('span', { class: 'ps-tw ps-tw-explain' }, button, el('span', { class: 'ps-tip ps-pop ps-pop-explain', role: 'tooltip', id }, renderExplainer(segment.explainer)));
  button.addEventListener('click', () => togglePopover(wrap, button));
  wirePopover(wrap);
  return wrap;
}

/** Text and figures as text; a figure with a basis opens its basis; a linked figure is a real link with the same popover. */
function renderSegments(segments, context) {
  const fragment = document.createDocumentFragment();
  for (const segment of segments) {
    if (segment.type === 'explainer') { fragment.append(renderExplainerMarker(segment)); continue; }
    if ((segment.type === 'figure' || segment.type === 'reason') && segment.basis) { fragment.append(renderFigure(segment)); continue; }
    if (segment.type !== 'link') {
      fragment.append(document.createTextNode(segment.text));
      continue;
    }
    const tipId = nextTipId();
    const tip = describeLink(segment);
    const glyph = segment.describe?.glyph || null;
    const link = el('a', {
      class: 'ps-link',
      href: `#ps-open-${segment.key}`,
      'aria-describedby': tipId,
      'data-ps-key': segment.key,
      'data-ps-chapter': segment.target.chapter || '',
      'data-ps-case': segment.target.caseId || '',
      'data-ps-native-case': segment.target.nativeCaseId || '',
      'data-ps-focus-target': segment.target.focusTargetId || '',
      'data-ps-basis-kind': segment.basis?.kind || ''
    }, el('span', { text: segment.text }), glyph ? buildGlyph(glyph, 'ps-g ps-g-hover') : null);
    const pop = el('span', { class: 'ps-tip ps-pop', role: 'tooltip', id: tipId }, el('b', { text: tip.title }), tip.body);
    const wrap = el('span', { class: 'ps-tw' }, link, pop);
    const openIt = () => context.open(segment.target, { sectionId: context.sectionId, paragraphIndex: context.paragraphIndex, trigger: link });
    if (segment.basis) {
      pop.append(el('span', { class: 'ps-pop-rule' }), basisBlock(segment));
      // On a touch screen a tap cannot also hover, so the first tap shows where the figure comes from, and the button in the popover (or a second tap) opens the module.
      const opener = el('button', { class: 'ps-pop-open', type: 'button' }, buildGlyph('back', 'ps-g ps-g-flip'), segment.describe?.opensPanel ? 'Open in the plan view' : `Open ${segment.describe?.module || 'the module'}`);
      opener.addEventListener('click', () => { closePopover(wrap); openIt(); });
      pop.append(opener);
    }
    link.addEventListener('click', (event) => {
      event.preventDefault();
      if (segment.basis && event.pointerType === 'touch' && !wrap.hasAttribute('data-ps-open')) {
        wrap.setAttribute('data-ps-touch', '');
        togglePopover(wrap, link);
        return;
      }
      closePopover(wrap);
      openIt();
    });
    wirePopover(wrap);
    fragment.append(wrap);
  }
  return fragment;
}

function buildSection(section, count, { updating, context }) {
  const node = el('section', {
    class: 'ps-section',
    id: `ps-s-${section.id}`,
    'data-ps-section': section.id,
    'aria-labelledby': `ps-h-${section.id}`,
    'aria-busy': updating ? 'true' : null
  },
  el('p', { class: 'ps-eyebrow' }, `Section ${section.number} of ${count}`, updating ? el('span', { class: 'ps-tag', text: 'Updating' }) : null),
  el('h2', { id: `ps-h-${section.id}` }, renderSegments(section.titleSegments, { ...context, sectionId: section.id, paragraphIndex: 0 })));
  if (updating) {
    node.append(el('div', { class: 'ps-sk', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')));
    return node;
  }
  section.paragraphs.forEach((paragraph, index) => {
    const p = el('p', { 'data-ps-paragraph': `${section.id}:${index}` });
    p.append(renderSegments(paragraph.segments, { ...context, sectionId: section.id, paragraphIndex: index }));
    node.append(p);
  });
  // The goals section tells each goal in its own subsection, in the ledger's order. Paragraph numbers carry on from the section's.
  let next = section.paragraphs.length;
  for (const goal of section.goals ?? []) {
    const sub = el('div', { class: 'ps-goal', 'data-ps-goal': goal.goalId },
      el('h3', { id: `ps-h-${section.id}-${goal.goalId}` }, renderSegments(goal.titleSegments, { ...context, sectionId: section.id, paragraphIndex: next })));
    for (const paragraph of goal.paragraphs) {
      const p = el('p', { 'data-ps-paragraph': `${section.id}:${next}` });
      p.append(renderSegments(paragraph.segments, { ...context, sectionId: section.id, paragraphIndex: next }));
      sub.append(p);
      next += 1;
    }
    node.append(sub);
  }
  if (section.seeIn.length) {
    const line = el('p', { class: 'ps-seein' }, el('span', { class: 'ps-seein-label', text: 'See it in' }));
    for (const entry of section.seeIn) {
      const link = el('a', { class: 'ps-see', href: `#ps-see-${entry.chapter || entry.panel}`, 'data-ps-chapter': entry.chapter || '' },
        entry.glyph ? buildGlyph(entry.glyph) : null, entry.title);
      link.addEventListener('click', (event) => {
        event.preventDefault();
        context.open({ chapter: entry.chapter, panel: entry.panel, caseId: entry.caseId, nativeCaseId: entry.nativeCaseId, focusTargetId: null, figureKey: null, figureText: null },
          { sectionId: section.id, paragraphIndex: Math.max(0, next - 1), trigger: link });
      });
      line.append(link);
    }
    node.append(line);
  }
  return node;
}

function buildRouteTabs(routes, selectedRouteId, onSelectRoute) {
  const nav = el('nav', { class: 'ps-routes', 'aria-label': 'Routes, from least to most change' }, el('p', { class: 'ps-eyebrow', text: 'Routes · least to most change' }));
  const list = el('div', { class: 'ps-route-list' });
  for (const route of routes) {
    const link = el('a', { class: 'ps-route', href: `#${route.id}`, 'aria-current': route.id === selectedRouteId ? 'true' : null, 'data-ps-route': route.id },
      el('small', { text: String(route.number) }), route.name);
    link.addEventListener('click', (event) => { event.preventDefault(); onSelectRoute?.(route.id); });
    list.append(link);
  }
  nav.append(list);
  return nav;
}

/** A glance figure: plain words, or a button that shows where it comes from when the plan says. */
function glanceFigure(cell) {
  if (!cell.basis) return cell.text;
  const id = nextTipId();
  const button = el('button', { class: 'ps-fig', type: 'button', 'aria-describedby': id, 'aria-expanded': 'false', 'data-ps-basis-kind': cell.basis.kind }, cell.text);
  const wrap = el('span', { class: 'ps-tw ps-tw-fig' }, button, el('span', { class: 'ps-tip ps-pop', role: 'tooltip', id }, basisBlock({ basis: cell.basis })));
  button.addEventListener('click', () => togglePopover(wrap, button));
  wirePopover(wrap);
  return wrap;
}

function buildGlanceTable(glance, selectedRouteId, note, onSelectRoute) {
  const section = el('section', { class: 'ps-glance', 'aria-label': 'The four routes at a glance' }, el('p', { class: 'ps-eyebrow', text: 'At a glance' }));
  const selected = glance.columns.findIndex((column) => column.id === selectedRouteId);
  const cellClass = (index, edge) => ['ps-cell', index === selected ? 'ps-sel' : '', index === selected ? edge : ''].filter(Boolean).join(' ');

  const table = el('table', { class: 'ps-glance-table' });
  const readRow = el('tr', { class: 'ps-readrow', 'aria-hidden': 'true' }, el('td'));
  glance.columns.forEach((column, index) => readRow.append(el('td', { class: 'ps-readcell', text: index === selected ? 'You’re reading' : '' })));
  const head = el('tr', {}, el('th', { class: 'ps-rowlabel', scope: 'col' }));
  glance.columns.forEach((column, index) => {
    const link = el('a', { href: `#${column.id}`, 'data-ps-route': column.id }, el('small', { text: `Route ${column.number}` }), column.name);
    link.addEventListener('click', (event) => { event.preventDefault(); onSelectRoute?.(column.id); });
    head.append(el('th', { class: cellClass(index, 'ps-sel-top'), scope: 'col' }, link));
  });
  table.append(el('thead', {}, readRow, head));
  const body = el('tbody');
  glance.rows.forEach((row, rowIndex) => {
    const tr = el('tr', {}, el('th', { class: 'ps-rowlabel', scope: 'row', text: row.label }));
    row.cells.forEach((cell, index) => {
      const last = rowIndex === glance.rows.length - 1;
      tr.append(el('td', { class: cellClass(index, last ? 'ps-sel-bottom' : '') + (/\d/.test(cell.text) ? '' : ' ps-word') },
        cell.approx ? el('small', { text: 'About' }) : null, glanceFigure(cell)));
    });
    body.append(tr);
  });
  table.append(body);
  section.append(table);

  const cards = el('div', { class: 'ps-cards' });
  glance.columns.forEach((column, index) => {
    const card = el('div', { class: `ps-card${index === selected ? ' ps-sel' : ''}` },
      index === selected ? el('span', { class: 'ps-readcard', text: 'You’re reading' }) : null,
      el('p', { class: 'ps-eyebrow', text: `Route ${column.number}` }), el('h3', { text: column.name }));
    const dl = el('dl');
    glance.rows.forEach((row) => dl.append(el('dt', { text: row.label }),
      el('dd', { class: /\d/.test(row.cells[index].text) ? '' : 'ps-word' }, row.cells[index].approx ? el('small', { text: 'About' }) : null, glanceFigure(row.cells[index]))));
    card.append(dl);
    cards.append(card);
  });
  section.append(cards);
  if (note) section.append(el('p', { class: 'ps-glance-note', text: note }));
  return section;
}

/**
 * The whole story screen.
 * `onOpenLink(target, { sectionId, paragraphIndex, trigger })` is the app's: it opens
 * the module on target.caseId and outlines target.focusTargetId, and keeps the
 * return point so the pill below can come back to the same paragraph.
 */
export function buildPlanStoryPage({
  resolved,
  routes,
  glance,
  glanceNote = '',
  selectedRouteId,
  updatingSectionIds = [],
  switchingToName = null,
  onSelectRoute = null,
  onOpenLink = () => {}
}) {
  const updating = new Set(updatingSectionIds);
  const selected = routes.find((route) => route.id === selectedRouteId);
  const context = { open: onOpenLink };
  const page = el('div', { class: 'ps', 'data-ps-route': selectedRouteId });

  const read = el('article', { class: 'ps-read' });
  if (switchingToName) {
    read.append(el('div', { class: 'ps-status', role: 'status' }, buildGlyph('sync'),
      el('span', {}, el('b', { text: `Switched to ${switchingToName}. ` }), 'Sections still recalculating say Updating.')));
  }
  const eyebrow = el('p', { class: 'ps-eyebrow', text: `Route ${selected?.number ?? ''} · ${selected?.name ?? ''}` });
  if (!resolved) {
    // A route whose story has not been told yet: its name, and that it is on its way.
    read.append(eyebrow,
      el('h1', { class: 'ps-headline', text: selected?.name ?? '' }),
      el('div', { class: 'ps-status', role: 'status' }, buildGlyph('sync'),
        el('span', {}, el('b', { text: 'The story for this route is updating. ' }), 'It will appear here as soon as it is ready.')),
      el('div', { class: 'ps-sk', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')));
  } else {
    read.append(
      eyebrow,
      // The headline and summary can carry links too, so coming back from a module has somewhere to return to.
      el('h1', { class: 'ps-headline', 'data-ps-paragraph': 'headline:0' }, renderSegments(resolved.headline, { ...context, sectionId: 'headline', paragraphIndex: 0 })),
      el('p', { class: 'ps-summary', 'data-ps-paragraph': 'summary:0' }, renderSegments(resolved.summary, { ...context, sectionId: 'summary', paragraphIndex: 0 }))
    );
    for (const section of resolved.sections) {
      read.append(buildSection(section, resolved.count, { updating: updating.has(section.id), context }));
    }
  }

  const rail = el('aside', { class: 'ps-rail', 'aria-label': 'Routes and comparison' },
    buildRouteTabs(routes, selectedRouteId, onSelectRoute),
    buildGlanceTable(glance, selectedRouteId, glanceNote, onSelectRoute));

  page.append(el('div', { class: 'ps-grid' }, read, rail));
  return page;
}

/** Back from a module to the paragraph the link came from, with a quiet "You were here". */
export function returnToParagraph(page, { sectionId, paragraphIndex, figureKey }) {
  const paragraph = page.querySelector(`[data-ps-paragraph="${sectionId}:${paragraphIndex}"]`);
  const section = page.querySelector(`[data-ps-section="${sectionId}"]`);
  const target = paragraph || section;
  if (!target) return false;
  page.querySelectorAll('.ps-here').forEach((node) => node.classList.remove('ps-here'));
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  target.classList.add('ps-here');
  const link = (figureKey ? target.querySelector(`a[data-ps-key="${figureKey}"]`) : null) || target.querySelector('a');
  if (link) {
    // Focus comes back to the link you used, without its tooltip covering the page.
    link.closest('.ps-tw')?.setAttribute('data-ps-dismissed', '');
    link.focus({ preventScroll: true });
  }
  return true;
}

/** On a narrow screen the tabs and cards scroll sideways: bring the selected route into view. */
export function revealSelectedRoute(page) {
  for (const [container, selected] of [['.ps-route-list', '.ps-route[aria-current="true"]'], ['.ps-cards', '.ps-card.ps-sel']]) {
    const list = page.querySelector(container);
    const item = list?.querySelector(selected);
    if (list && item && list.scrollWidth > list.clientWidth) list.scrollLeft = Math.max(0, item.offsetLeft - (list.clientWidth - item.offsetWidth) / 2);
  }
}

/** The pill a module screen carries while it was opened from the story. */
export function buildBackToStoryPill({ sectionTitle = '', figureText = '', showing = '', onBack }) {
  const pill = el('button', { class: 'ps-pill', type: 'button' }, buildGlyph('back'), 'Back to the story');
  pill.addEventListener('click', () => onBack?.());
  const context = el('span', { class: 'ps-pill-context' },
    figureText ? ['Opened from ', el('b', { text: `“${figureText}”` }), sectionTitle ? ` in ${sectionTitle}` : ''] : (sectionTitle ? `Opened from ${sectionTitle}` : ''),
    showing ? ` Showing ${showing}.` : '');
  return el('div', { class: 'ps-pillbar' }, pill, context);
}

/** Shown inside a module when its case no longer matches the route. */
export function buildOffRouteNote({ caseWas = '', caseNow = '', onBackToRoute }) {
  const button = el('button', { class: 'ps-btn', type: 'button' }, buildGlyph('back'), 'Back to the route');
  button.addEventListener('click', () => onBackToRoute?.());
  return el('div', { class: 'ps-offroute', role: 'status' }, buildGlyph('info', 'ps-g ps-g-lg'),
    el('div', {}, el('b', { text: 'This screen no longer follows the route' }),
      caseWas && caseNow ? el('span', { text: `You changed the case from ${caseWas} to ${caseNow}, so the figures here are for the case you chose.` }) : null),
    button);
}

/** The simple Story | Modules switch for the top of the overview. */
export function buildStoryModulesSwitch({ active = 'story', onChange }) {
  const wrap = el('div', { class: 'ps-switch', role: 'group', 'aria-label': 'View' });
  for (const [id, label] of [['story', 'Story'], ['modules', 'Modules']]) {
    const button = el('button', { type: 'button', 'aria-pressed': id === active ? 'true' : 'false', text: label });
    button.addEventListener('click', () => onChange?.(id));
    wrap.append(button);
  }
  return wrap;
}
