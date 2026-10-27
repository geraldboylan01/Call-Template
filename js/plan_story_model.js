import {
  HOUSEHOLD_CASH_FLOW_BANNED_PHRASES,
  HOUSEHOLD_CASH_FLOW_PROVIDER_NAMES
} from './household_cash_flow_math.js';

/**
 * THE PLAN STORY, AS DATA.
 *
 * A route's story is told by the analyst and drawn by the screen. This file is
 * the line between them, and it holds the plan's rule that narration types no
 * figures: the analyst writes words and placeholders, the code fills every
 * placeholder from the facts it computed, and every figure that came from a
 * module knows which module and which case it came from.
 *
 *   {key}   a figure, printed as plain text
 *   {@key}  the same figure as a link; the analyst may mark a link but never
 *           builds one, so a link can only open what the fact itself points at
 *
 * Pure: no DOM, no network, no clock. The view (plan_story_view.js) draws what
 * this returns, and tests ask it questions without a browser.
 */

export class PlanStoryError extends Error {
  constructor(path, message, code = 'invalid_story') {
    super(`${path}: ${message}`);
    this.name = 'PlanStoryError';
    this.path = path;
    this.code = code;
  }
}

const fail = (path, message, code) => { throw new PlanStoryError(path, message, code); };

/** Words that rank routes. The plan never ranks, so a story may not either. */
export const PLAN_STORY_RANKING_WORDS = Object.freeze([
  /\bbetter\b/i,
  /\bworse\b/i,
  /\bcheapest\b/i,
  /\bsmartest\b/i,
  /\bpreferred\b/i,
  /\btop\b/i,
  /\bwinners?\b/i,
  /\branked\b/i,
  /\bscores?\b/i
]);

const FORBIDDEN = Object.freeze([
  ...HOUSEHOLD_CASH_FLOW_BANNED_PHRASES,
  ...HOUSEHOLD_CASH_FLOW_PROVIDER_NAMES,
  ...PLAN_STORY_RANKING_WORDS
]);

/** The marker is `@` and nothing else, as the plan's placeholder syntax says. */
const PLACEHOLDER = /\{(@?)([a-z][A-Za-z0-9_.-]*)\}/g;

/** The five education-only parts a section may be told in, in the order they read. */
export const PLAN_STORY_PARTS = Object.freeze(['does', 'why', 'gives', 'costs', 'check']);

/** Words, and only words: a figure, a date or a percentage is always a placeholder. */
export function findTypedFigures(text) {
  return String(text).match(/[0-9€%£$]/g) || [];
}

export function findForbiddenWording(text) {
  return FORBIDDEN.filter((pattern) => pattern.test(String(text))).map(String);
}

/**
 * Split narration into text and placeholders. Anything that looks like a
 * placeholder but is not one (a stray brace, a second marker) is refused with
 * where it is, so a typo never reaches the screen as raw braces.
 */
export function parseNarration(text, path = '/narration') {
  if (typeof text !== 'string' || !text.trim()) fail(path, 'must be a non-empty string.');
  const tokens = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (match.index > last) tokens.push({ type: 'text', text: text.slice(last, match.index) });
    tokens.push({ type: 'placeholder', key: match[2], link: match[1] === '@' });
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) });
  for (const token of tokens) {
    if (token.type === 'text' && /[{}]/.test(token.text)) {
      fail(path, 'has a brace that is not a placeholder. A placeholder is {key} or {@key}.', 'bad_placeholder');
    }
  }
  return tokens;
}

function checkWords(text, path) {
  const figures = findTypedFigures(text);
  if (figures.length) {
    fail(path, `types a figure ("${text.trim().slice(0, 60)}"). Narration is words; every figure is a placeholder.`, 'typed_figure');
  }
  const banned = findForbiddenWording(text);
  if (banned.length) {
    fail(path, `uses wording the plan does not allow (${banned.join(', ')}). It speaks to you, never recommends or ranks.`, 'forbidden_wording');
  }
}

/** A fact the screen can show: plain text, or the reason there is no figure. */
function readFact(fact, path) {
  if (!fact || typeof fact !== 'object') fail(path, 'is not a registered fact.', 'unknown_placeholder');
  const text = typeof fact.text === 'string' && fact.text.trim() ? fact.text.trim() : null;
  const reason = typeof fact.notApplicable === 'string' && fact.notApplicable.trim() ? fact.notApplicable.trim() : null;
  if (!text && !reason) fail(path, 'has neither a value nor a reason there is none.', 'empty_fact');
  return { text: text ?? reason, reason: !text };
}

function readSource(source, path) {
  if (!source) return null;
  if (typeof source !== 'object') fail(path, 'must be an object.');
  const { chapter = null, caseId = null, nativeCaseId = null, focusTargetId = null, panel = null, outlineText = null, outlineSelector = null } = source;
  if (!chapter && !panel) fail(path, 'must name a chapter (a module) or a panel of the plan view.', 'bad_source');
  for (const [name, value] of [['outlineText', outlineText], ['outlineSelector', outlineSelector]]) {
    if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 200)) fail(`${path}.${name}`, 'must be a short non-empty string.', 'bad_source');
  }
  return { chapter, caseId, nativeCaseId, focusTargetId, panel, outlineText, outlineSelector };
}

/**
 * Turn narration into what the screen draws: text, plain figures, figures that
 * are links, and reasons. `registry` maps a placeholder key to
 * `{ text | notApplicable, source?: { chapter, caseId?, nativeCaseId?, focusTargetId?, panel? } }`.
 */
export function resolveNarration(text, registry, { path = '/narration', label = () => null } = {}) {
  checkWordsInText(text, path);
  const segments = [];
  for (const token of parseNarration(text, path)) {
    if (token.type === 'text') { segments.push(token); continue; }
    const where = `${path}{${token.link ? '@' : ''}${token.key}}`;
    const fact = readFact(registry?.[token.key], where);
    if (fact.reason) { segments.push({ type: 'reason', key: token.key, text: fact.text }); continue; }
    if (!token.link) { segments.push({ type: 'figure', key: token.key, text: fact.text }); continue; }
    const source = readSource(registry[token.key].source, `${where}.source`);
    if (!source) fail(where, 'is marked as a link but the fact has no source to open.', 'unlinkable_placeholder');
    segments.push({
      type: 'link',
      key: token.key,
      text: fact.text,
      target: { ...source, figureKey: token.key, figureText: fact.text },
      describe: label(source, token.key)
    });
  }
  return segments;
}

/** Words in the narration itself, not in the figures that fill it. */
function checkWordsInText(text, path) {
  for (const token of parseNarration(text, path)) {
    if (token.type === 'text') checkWords(token.text, path);
  }
}

function sectionParagraphs(section, path) {
  if (Array.isArray(section.paragraphs)) return section.paragraphs;
  if (section.parts && typeof section.parts === 'object') {
    const unknown = Object.keys(section.parts).filter((key) => !PLAN_STORY_PARTS.includes(key));
    if (unknown.length) fail(`${path}/parts`, `has parts the story does not know (${unknown.join(', ')}).`);
    return PLAN_STORY_PARTS.filter((key) => section.parts[key]).map((key) => section.parts[key]);
  }
  return fail(path, 'needs paragraphs, or the five parts (does, why, gives, costs, check).');
}

/**
 * The modules a section drew on, in order of first use. Derived from the links
 * themselves, never written by the analyst, so "See it in" can only name a
 * module the section really linked.
 */
export function deriveSeeIn(paragraphs) {
  const seen = new Map();
  for (const paragraph of paragraphs) {
    for (const segment of paragraph.segments) {
      if (segment.type !== 'link') continue;
      const { chapter, panel, caseId, nativeCaseId } = segment.target;
      const id = chapter || `panel:${panel}`;
      if (!seen.has(id)) seen.set(id, { chapter, panel, caseId, nativeCaseId });
    }
  }
  return [...seen.values()];
}

/**
 * Resolve a whole route story. `catalogue` supplies the words for a module or a
 * case ({ chapters: { id: { title, glyph } }, cases: { id: { caseId: title } } }),
 * so a tooltip can say "Car loan · Clear it now" without the story knowing it.
 */
export function resolveStory({ story, registry, catalogue = {} }) {
  if (!story || typeof story !== 'object') fail('/story', 'must be an object.');
  const chapters = catalogue.chapters || {};
  const cases = catalogue.cases || {};
  const moduleTitle = (source) => chapters[source.chapter]?.title || source.panel || source.chapter;
  const caseTitle = (source) => cases[source.chapter]?.[source.caseId] || null;
  const label = (source, key) => ({
    module: moduleTitle(source),
    case: caseTitle(source),
    figure: registry?.[key]?.text || null,
    glyph: chapters[source.chapter]?.glyph || null,
    opensPanel: !source.chapter
  });
  const resolve = (text, path) => resolveNarration(text, registry, { path, label });

  const sections = (story.sections || []).map((section, index) => {
    const path = `/story/sections/${index}`;
    if (!section.id || !section.title) fail(path, 'needs an id and a title.');
    const paragraphs = sectionParagraphs(section, path).map((text, p) => ({
      segments: resolve(text, `${path}/paragraphs/${p}`)
    }));
    return {
      id: section.id,
      title: section.title,
      number: index + 1,
      paragraphs,
      seeIn: deriveSeeIn(paragraphs).map((entry) => ({
        ...entry,
        title: chapters[entry.chapter]?.title || entry.panel || entry.chapter,
        glyph: chapters[entry.chapter]?.glyph || null
      }))
    };
  });
  if (!sections.length) fail('/story/sections', 'needs at least one section.');
  const ids = new Set();
  for (const section of sections) {
    if (ids.has(section.id)) fail('/story/sections', `repeats the section ${section.id}.`);
    ids.add(section.id);
  }
  return {
    routeId: story.routeId,
    headline: resolve(story.headline, '/story/headline'),
    summary: resolve(story.summary, '/story/summary'),
    sections,
    count: sections.length
  };
}

/**
 * The at-a-glance rows. Routes keep the order they are given in (current
 * first, then by cash committed) and nothing here scores, ranks or flags one.
 */
export function buildGlance(routes) {
  if (!Array.isArray(routes) || !routes.length) fail('/routes', 'needs at least one route.');
  const rows = [
    { key: 'savingsUsed', label: 'Savings used now' },
    { key: 'leftOver', label: 'Left over each year' },
    { key: 'goalsCovered', label: 'Goals covered' }
  ];
  routes.forEach((route, index) => {
    for (const forbidden of ['rank', 'score', 'best', 'recommended', 'winner']) {
      if (forbidden in route) fail(`/routes/${index}/${forbidden}`, 'is not allowed: routes are never ranked.', 'ranking_field');
    }
    for (const row of rows) {
      if (!route[row.key]?.text) fail(`/routes/${index}/${row.key}`, 'needs a text value.');
    }
  });
  return {
    columns: routes.map((route) => ({ id: route.id, number: route.number, name: route.name })),
    rows: rows.map((row) => ({
      ...row,
      cells: routes.map((route) => ({ ...route[row.key] }))
    }))
  };
}

/** A link opens a module on the route's case. If the module is on another case, the screen no longer follows the route. */
export function followsRoute(target, currentCaseId) {
  if (!target?.caseId) return true;
  return currentCaseId === target.caseId;
}

/** The words a tooltip shows for a link. */
export function describeLink(segment) {
  const { module, case: caseName, figure, opensPanel } = segment.describe || {};
  const title = caseName ? `${module} · ${caseName}` : module;
  const action = opensPanel
    ? `Opens ${module} in the plan view`
    : `Opens the module with ${figure} outlined`;
  return { title, body: `${action}.` };
}
