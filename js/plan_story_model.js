import {
  HOUSEHOLD_CASH_FLOW_BANNED_PHRASES,
  HOUSEHOLD_CASH_FLOW_PROVIDER_NAMES
} from './household_cash_flow_math.js';
import { PLAN_STORY_BASIS_KINDS } from './plan_story_basis.js';

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
const PLAN_STORY_RANKING_WORDS = Object.freeze([
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

/**
 * Two markers and nothing else: `@` makes a figure a link, and `?` (only as `{?explainer.<id>}`) attaches
 * an explainer to a phrase. Anything else that looks like a placeholder is refused.
 */
const PLACEHOLDER = /\{([@?]?)([a-z][A-Za-z0-9_.-]*)\}/g;
const EXPLAINER_KEY = /^explainer\.([a-z][a-z0-9_]*)$/;

/** The five education-only parts a section may be told in, in the order they read. */
const PLAN_STORY_PARTS = Object.freeze(['does', 'why', 'gives', 'costs', 'check']);
const SECTION_IDS = Object.freeze([
  'current_position', 'ledger', 'protecting', 'inefficiencies', 'goals',
  'cash_flow_after', 'net_worth_after', 'risks', 'check_next'
]);

/** Words, and only words: a figure, a date or a percentage is always a placeholder. */
export function findTypedFigures(text) {
  return String(text).match(/[\p{N}€%£$]/gu) || [];
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
    const explainer = match[1] === '?';
    if (explainer && !EXPLAINER_KEY.test(match[2])) {
      fail(path, `has {?${match[2]}}. The ? marker names an explainer: {?explainer.<id>}.`, 'bad_placeholder');
    }
    tokens.push({ type: 'placeholder', key: match[2], link: match[1] === '@', explainer });
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) });
  for (const token of tokens) {
    if (token.type === 'text' && /[{}]/.test(token.text)) {
      fail(path, 'has a brace that is not a placeholder. A placeholder is {key}, {@key} or {?explainer.<id>}.', 'bad_placeholder');
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

/**
 * A fact the screen can show: its text, where it comes from (the `basis` the plan wrote for it, which the
 * screen turns into words; a sample without one shows none), and the explainer it points to, if any.
 */
function readFact(fact, path) {
  if (!fact || typeof fact !== 'object') fail(path, 'is not a registered fact.', 'unknown_placeholder');
  const text = typeof fact.text === 'string' && fact.text.trim() ? fact.text.trim() : null;
  if (!text) fail(path, 'has no computed value. Register a .notApplicable key for a code-produced reason.', 'empty_fact');
  const basis = fact.basis ?? null;
  if (basis !== null && (typeof basis !== 'object' || !PLAN_STORY_BASIS_KINDS.includes(basis.kind))) {
    fail(`${path}.basis`, `must be one of: ${PLAN_STORY_BASIS_KINDS.join(', ')}.`, 'bad_basis');
  }
  const explainerId = typeof fact.explainerId === 'string' && fact.explainerId ? fact.explainerId : null;
  return { text, basis, explainerId };
}

/** An explainer as the screen shows it: the register's own words, whole. */
function readExplainer(explainer, path) {
  const bad = (message) => fail(path, message, 'bad_explainer');
  if (!explainer || typeof explainer !== 'object' || typeof explainer.title !== 'string' || !explainer.title.trim()) bad('has no title.');
  if (!Array.isArray(explainer.sentences) || !explainer.sentences.length || explainer.sentences.some((entry) => typeof entry !== 'string' || !entry.trim())) bad('has no sentences.');
  const sources = Array.isArray(explainer.sources) ? explainer.sources : [];
  if (sources.some((source) => !source || typeof source.title !== 'string' || !source.title.trim())) bad('has a source with no title.');
  return {
    title: explainer.title.trim(),
    sentences: explainer.sentences.map((entry) => entry.trim()),
    sources: sources.map((source) => ({ title: source.title.trim(), url: typeof source.url === 'string' && source.url ? source.url : null })),
    checkedOn: typeof explainer.checkedOn === 'string' ? explainer.checkedOn : null,
    catalogueVersion: typeof explainer.catalogueVersion === 'string' ? explainer.catalogueVersion : null
  };
}

function readSource(source, path) {
  if (!source) return null;
  if (typeof source !== 'object' || Array.isArray(source)) fail(path, 'must be an object.', 'bad_source');
  const { chapter = null, caseId = null, nativeCaseId = null, focusTargetId = null, panel = null, outlineText = null, outlineSelector = null } = source;
  if (Boolean(chapter) === Boolean(panel)) fail(path, 'must name either a chapter (a module) or a panel of the plan view.', 'bad_source');
  for (const [name, value] of Object.entries({ chapter, caseId, nativeCaseId, focusTargetId, panel })) {
    if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 500)) {
      fail(`${path}.${name}`, 'must be a non-empty source identifier.', 'bad_source');
    }
  }
  if (panel && (caseId || nativeCaseId)) fail(path, 'a plan panel cannot also name a module case.', 'bad_source');
  if (nativeCaseId && !caseId) fail(path, 'a native case needs its chapter caseId.', 'bad_source');
  for (const [name, value] of [['outlineText', outlineText], ['outlineSelector', outlineSelector]]) {
    if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 200)) fail(`${path}.${name}`, 'must be a short non-empty string.', 'bad_source');
  }
  return { chapter, caseId, nativeCaseId, focusTargetId, panel, outlineText, outlineSelector };
}

/**
 * Turn narration into what the screen draws: text, plain figures, figures that
 * are links, and reasons. `registry` maps a placeholder key to
 * `{ text, source: { chapter, caseId?, nativeCaseId?, focusTargetId?, panel? } }`.
 * Code-produced reasons are registered under their explicit `<key>.notApplicable` key.
 * `explainers` maps an explainer id to the register's explainer; `{?explainer.<id>}` names one of them.
 */
export function resolveNarration(text, registry, { path = '/narration', label = () => null, explainers = {} } = {}) {
  checkWordsInText(text, path);
  const segments = [];
  const aboutOf = (id, where) => (id && explainers?.[id] ? readExplainer(explainers[id], `${where}.explainer`) : null);
  for (const token of parseNarration(text, path)) {
    if (token.type === 'text') { segments.push(token); continue; }
    const where = `${path}{${token.explainer ? '?' : token.link ? '@' : ''}${token.key}}`;
    if (token.explainer) {
      const id = EXPLAINER_KEY.exec(token.key)[1];
      if (!explainers || !Object.hasOwn(explainers, id)) {
        fail(where, `names the explainer "${id}", which the explainer catalogue does not hold for this plan.`, 'unknown_explainer');
      }
      segments.push({ type: 'explainer', key: token.key, id, explainer: readExplainer(explainers[id], where) });
      continue;
    }
    const fact = readFact(registry?.[token.key], where);
    const source = readSource(registry[token.key].source, `${where}.source`);
    if (!source) fail(where, token.link ? 'is marked as a link but the fact has no source to open.' : 'has no registered source.', token.link ? 'unlinkable_placeholder' : 'bad_source');
    // What the screen shows on hover or tap comes from the fact, never from the story.
    const explained = aboutOf(fact.explainerId, where);
    // The module a figure's source names is shown in its basis ("worked out by the app, in the Mortgage module").
    const basisModule = fact.basis && source.chapter ? label(source, token.key)?.module ?? null : null;
    const about = { ...(fact.basis ? { basis: fact.basis } : {}), ...(basisModule ? { basisModule } : {}), ...(explained ? { about: explained } : {}) };
    if (!token.link) {
      segments.push({ type: token.key.endsWith('.notApplicable') ? 'reason' : 'figure', key: token.key, text: fact.text, ...about });
      continue;
    }
    segments.push({
      type: 'link',
      key: token.key,
      text: fact.text,
      target: { ...source, figureKey: token.key, figureText: fact.text },
      describe: label(source, token.key),
      ...about
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
  if (section.paragraphs && section.parts) fail(path, 'must use paragraphs or parts, not both.');
  // Paragraphs remain a screen-preview format, not evidence of the B1.5 completeness floor.
  if (Array.isArray(section.paragraphs) && section.paragraphs.length) return section.paragraphs;
  if (section.parts && typeof section.parts === 'object' && !Array.isArray(section.parts)) {
    const unknown = Object.keys(section.parts).filter((key) => !PLAN_STORY_PARTS.includes(key));
    if (unknown.length) fail(`${path}/parts`, `has parts the story does not know (${unknown.join(', ')}).`);
    for (const key of PLAN_STORY_PARTS) {
      if (typeof section.parts[key] !== 'string' || !section.parts[key].trim()) fail(`${path}/parts/${key}`, 'needs this education-only part.');
    }
    return PLAN_STORY_PARTS.map((key) => section.parts[key]);
  }
  return fail(path, 'needs paragraphs, or the five parts (does, why, gives, costs, check).');
}

/**
 * The modules a section drew on, in order of first use. Derived from the links
 * themselves, never written by the analyst, so "See it in" can only name a
 * module the section really linked.
 */
function deriveSeeIn(paragraphs) {
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
export function resolveStory({ story, registry, catalogue = {}, explainers = {} }) {
  if (!story || typeof story !== 'object') fail('/story', 'must be an object.');
  if (typeof story.routeId !== 'string' || !story.routeId.trim()) fail('/story/routeId', 'needs its route id.');
  if (!Array.isArray(story.sections) || story.sections.length !== SECTION_IDS.length) {
    fail('/story/sections', 'needs all nine B1.5 sections, in their prescribed order.');
  }
  const chapters = catalogue.chapters || {};
  const cases = catalogue.cases || {};
  const moduleTitle = (source) => chapters[source.chapter]?.title || source.panel || source.chapter;
  const caseTitle = (source) => cases[source.chapter]?.[source.caseId] || cases[source.chapter]?.[source.nativeCaseId] || null;
  const label = (source, key) => ({
    module: moduleTitle(source),
    case: caseTitle(source),
    figure: registry?.[key]?.text || null,
    glyph: chapters[source.chapter]?.glyph || null,
    opensPanel: !source.chapter
  });
  const resolve = (text, path) => resolveNarration(text, registry, { path, label, explainers });
  const plainText = (segments) => segments.map((segment) => segment.text ?? '').join('');

  const sections = (story.sections || []).map((section, index) => {
    const path = `/story/sections/${index}`;
    if (section?.id !== SECTION_IDS[index]) fail(`${path}/id`, `must be ${SECTION_IDS[index]}; sections cannot be dropped, repeated or reordered.`);
    const titleSegments = resolve(section.title, `${path}/title`);
    const paragraphs = sectionParagraphs(section, path).map((text, p) => ({
      segments: resolve(text, `${path}/paragraphs/${p}`)
    }));
    // B1.5 section 3: the goals section has one subsection per goal, in the ledger's order.
    if (section.goals !== undefined && section.id !== 'goals') fail(`${path}/goals`, 'only the goals section has goal subsections.');
    const goalIds = new Set();
    const goals = (section.goals ?? []).map((goal, g) => {
      const goalPath = `${path}/goals/${g}`;
      if (typeof goal?.goalId !== 'string' || !goal.goalId.trim()) fail(`${goalPath}/goalId`, 'needs the goal it tells.');
      if (goalIds.has(goal.goalId)) fail(`${goalPath}/goalId`, `repeats the goal ${goal.goalId}.`);
      goalIds.add(goal.goalId);
      const goalTitle = resolve(goal.title, `${goalPath}/title`);
      return {
        goalId: goal.goalId,
        title: plainText(goalTitle),
        titleSegments: goalTitle,
        paragraphs: sectionParagraphs(goal, goalPath).map((text, p) => ({ segments: resolve(text, `${goalPath}/paragraphs/${p}`) }))
      };
    });
    return {
      id: section.id,
      title: titleSegments.map((segment) => segment.text).join(''),
      titleSegments,
      number: index + 1,
      paragraphs,
      goals,
      seeIn: deriveSeeIn([{ segments: titleSegments }, ...paragraphs, ...goals.flatMap((goal) => [{ segments: goal.titleSegments }, ...goal.paragraphs])]).map((entry) => ({
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
  const nativeCaseId = target?.nativeCaseId ?? target?.caseId;
  return !nativeCaseId || currentCaseId === nativeCaseId;
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
