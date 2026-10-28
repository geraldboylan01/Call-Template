import { describeLink } from './plan_story_model.js';

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
  sync: 'M13 5.5A5.5 5.5 0 003.5 4.5M3 2v3h3M3 10.5a5.5 5.5 0 009.5 1M13 14v-3h-3'
});

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('data-') || key.startsWith('aria-') || key === 'role' || key === 'href' || key === 'id' || key === 'type' || key === 'scope' || key === 'tabindex') node.setAttribute(key, value === true ? '' : value);
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

/** Text and plain figures as text; a linked figure as a real link with a tooltip beside it. */
function renderSegments(segments, context) {
  const fragment = document.createDocumentFragment();
  for (const segment of segments) {
    if (segment.type !== 'link') {
      fragment.append(document.createTextNode(segment.text));
      continue;
    }
    const tipId = `ps-tip-${tipCounter += 1}`;
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
      'data-ps-focus-target': segment.target.focusTargetId || ''
    }, el('span', { text: segment.text }), glyph ? buildGlyph(glyph, 'ps-g ps-g-hover') : null);
    link.addEventListener('click', (event) => {
      event.preventDefault();
      context.open(segment.target, { sectionId: context.sectionId, paragraphIndex: context.paragraphIndex, trigger: link });
    });
    const wrap = el('span', { class: 'ps-tw' }, link, el('span', { class: 'ps-tip', role: 'tooltip', id: tipId }, el('b', { text: tip.title }), tip.body));
    wrap.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') wrap.setAttribute('data-ps-dismissed', '');
    });
    wrap.addEventListener('mouseleave', () => wrap.removeAttribute('data-ps-dismissed'));
    wrap.addEventListener('focusout', () => wrap.removeAttribute('data-ps-dismissed'));
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
  if (section.seeIn.length) {
    const line = el('p', { class: 'ps-seein' }, el('span', { class: 'ps-seein-label', text: 'See it in' }));
    for (const entry of section.seeIn) {
      const link = el('a', { class: 'ps-see', href: `#ps-see-${entry.chapter || entry.panel}`, 'data-ps-chapter': entry.chapter || '' },
        entry.glyph ? buildGlyph(entry.glyph) : null, entry.title);
      link.addEventListener('click', (event) => {
        event.preventDefault();
        context.open({ chapter: entry.chapter, panel: entry.panel, caseId: entry.caseId, nativeCaseId: entry.nativeCaseId, focusTargetId: null, figureKey: null, figureText: null },
          { sectionId: section.id, paragraphIndex: section.paragraphs.length - 1, trigger: link });
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
        cell.approx ? el('small', { text: 'About' }) : null, cell.text));
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
      el('dd', { class: /\d/.test(row.cells[index].text) ? '' : 'ps-word' }, row.cells[index].approx ? el('small', { text: 'About' }) : null, row.cells[index].text)));
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
      el('h1', { class: 'ps-headline' }, renderSegments(resolved.headline, { ...context, sectionId: 'headline', paragraphIndex: 0 })),
      el('p', { class: 'ps-summary' }, renderSegments(resolved.summary, { ...context, sectionId: 'summary', paragraphIndex: 0 }))
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
export function buildBackToStoryPill({ sectionTitle = '', figureText = '', onBack }) {
  const pill = el('button', { class: 'ps-pill', type: 'button' }, buildGlyph('back'), 'Back to the story');
  pill.addEventListener('click', () => onBack?.());
  const context = el('span', { class: 'ps-pill-context' },
    figureText ? ['Opened from ', el('b', { text: `“${figureText}”` }), sectionTitle ? ` in ${sectionTitle}` : ''] : (sectionTitle ? `Opened from ${sectionTitle}` : ''));
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
