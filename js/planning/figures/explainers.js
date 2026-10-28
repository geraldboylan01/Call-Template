/**
 * Working with the explainer catalogue: which figures an explainer covers, the
 * explainers a figure carries, the index entry for each explainer, and the rules
 * `check:figures` holds the catalogue to.
 *
 * Pure. The catalogue (`explainers_ie.js`) is data; this turns it into what the
 * register reads, and does no arithmetic of its own on dates, so the generated
 * files depend only on the catalogue and the figures.
 */

import { EXPLAINER_BANNED_WORDING, OFFICIAL_SOURCE_HOSTS, namesAProvider } from './kinds.js';

const EXPLAINER_ID = /^[a-z][a-z0-9_]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIGURE_OR_RULE_ID = /^[a-z][a-z0-9_.-]*$/;

/** How many sentences an explainer has, how long its title and each sentence may be. */
export const EXPLAINER_LIMITS = Object.freeze({ minSentences: 2, maxSentences: 4, maxTitleLength: 70, maxSentenceWords: 40 });

/** Days after which an explainer's sources are due to be read again. */
export const EXPLAINER_REREAD_DAYS = 180;

const wordCount = (text) => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Whether `figureId` is covered by a rule id: the rule id itself, or anything
 * beneath it. `ie.dirt` covers `ie.dirt.2026.rate`; it does not cover `ie.dirty`.
 */
function underRule(figureId, ruleId) {
  return figureId === ruleId || figureId.startsWith(`${ruleId}.`);
}

/** The ids of the figures an explainer covers, in the order the register lists them. */
export function figuresCoveredBy(explainer, figures) {
  const exact = new Set(explainer.figureIds);
  return figures
    .filter((figure) => exact.has(figure.id) || explainer.ruleIds.some((ruleId) => underRule(figure.id, ruleId)))
    .map((figure) => figure.id);
}

/**
 * The same figures, each with the ids of the explainers that cover it. A figure
 * no explainer covers is returned as it was.
 */
export function attachExplainers(figures, explainers) {
  return figures.map((figure) => {
    const naming = explainers
      .filter((explainer) => explainer.figureIds.includes(figure.id)
        || explainer.ruleIds.some((ruleId) => underRule(figure.id, ruleId)))
      .map((explainer) => explainer.id);
    return naming.length > 0 ? Object.freeze({ ...figure, explainers: Object.freeze(naming) }) : figure;
  });
}

/** An id the register cannot resolve: no figure carries it and none lies beneath it. */
function unresolvedIds(explainer, figures) {
  return {
    figureIds: explainer.figureIds.filter((id) => !figures.some((figure) => figure.id === id)),
    ruleIds: explainer.ruleIds.filter((id) => !figures.some((figure) => underRule(figure.id, id)))
  };
}

/**
 * The index entry for each explainer: the catalogue's own fields, the sentences
 * as one text, and the figures it covers. Throws, naming them, if an id does not
 * resolve, so a bad catalogue never reaches the generated files.
 */
export function buildExplainers(explainers, figures, version) {
  return explainers.map((explainer) => {
    const missing = unresolvedIds(explainer, figures);
    const unresolved = [...missing.figureIds, ...missing.ruleIds];
    if (unresolved.length > 0) {
      throw new Error(`Explainer ${explainer.id} explains ids the register does not hold: ${unresolved.join(', ')}.`);
    }
    return Object.freeze({
      id: explainer.id,
      title: explainer.title,
      sentences: Object.freeze([...explainer.sentences]),
      text: explainer.sentences.join(' '),
      figureIds: Object.freeze([...explainer.figureIds]),
      ruleIds: Object.freeze([...explainer.ruleIds]),
      coversFigureIds: Object.freeze(figuresCoveredBy(explainer, figures)),
      sources: Object.freeze(explainer.sources.map((source) => Object.freeze({ title: source.title, url: source.url }))),
      checkedOn: explainer.checkedOn,
      catalogueVersion: version
    });
  });
}

/** Whether `host` is an official host or beneath one. */
export function isOfficialHost(host) {
  return OFFICIAL_SOURCE_HOSTS.some((official) => host === official || host.endsWith(`.${official}`));
}

/** The problems with one source link, as strings. Offline: it never fetches. */
function sourceProblems(source, where) {
  const problems = [];
  if (typeof source?.title !== 'string' || source.title.trim() === '') problems.push(`${where} needs a title.`);
  else if (namesAProvider(source.title)) problems.push(`${where} title names a provider (${namesAProvider(source.title)}).`);
  let url = null;
  try {
    url = new URL(source?.url ?? '');
  } catch {
    problems.push(`${where} needs a valid url.`);
    return problems;
  }
  if (url.protocol !== 'https:') problems.push(`${where} needs an https url.`);
  if (!isOfficialHost(url.hostname)) problems.push(`${where} is not an official page (${url.hostname}).`);
  if (/[?&](utm_|fbclid|gclid)/i.test(url.search)) problems.push(`${where} has tracking parameters.`);
  if (url.hash) problems.push(`${where} has a fragment; link the page.`);
  return problems;
}

/**
 * The problems with one explainer, as strings; an empty list means it is sound.
 *
 * Offline by design: the gate that runs this has no network, and the pages
 * behind gov.ie and Citizens Information refuse scripted requests. That every
 * source link still resolves is `npm run check:figure-links`, which fetches them.
 *
 * @param {object} explainer
 * @param {object[]} figures The register's figures, to resolve the ids against.
 * @param {string} today YYYY-MM-DD, for the check date not to be in the future.
 */
export function explainerProblems(explainer, figures, today) {
  const problems = [];
  const add = (message) => problems.push(`${explainer?.id ?? 'explainer'}: ${message}`);

  if (typeof explainer?.id !== 'string' || !EXPLAINER_ID.test(explainer.id)) add('id must be short snake_case.');
  if (typeof explainer?.title !== 'string' || explainer.title.trim() === '') {
    add('needs a title.');
  } else if (explainer.title.length > EXPLAINER_LIMITS.maxTitleLength) {
    add(`title is longer than ${EXPLAINER_LIMITS.maxTitleLength} characters.`);
  }

  const sentences = explainer?.sentences;
  if (!Array.isArray(sentences) || sentences.some((sentence) => typeof sentence !== 'string' || sentence.trim() === '')) {
    add('needs its sentences as a list of text.');
    return problems;
  }
  if (sentences.length < EXPLAINER_LIMITS.minSentences || sentences.length > EXPLAINER_LIMITS.maxSentences) {
    add(`needs ${EXPLAINER_LIMITS.minSentences} to ${EXPLAINER_LIMITS.maxSentences} sentences; it has ${sentences.length}.`);
  }
  sentences.forEach((sentence, index) => {
    if (!/[.!?]$/.test(sentence.trim())) add(`sentence ${index + 1} must end with a full stop.`);
    if (/[.!?]\s+[A-Z]/.test(sentence)) add(`sentence ${index + 1} is more than one sentence.`);
    if (wordCount(sentence) > EXPLAINER_LIMITS.maxSentenceWords) {
      add(`sentence ${index + 1} is longer than ${EXPLAINER_LIMITS.maxSentenceWords} words; keep it plain.`);
    }
  });
  const text = sentences.join(' ');
  if (!/\byou(r|rs)?\b/i.test(text)) add('is not in the "you" voice.');
  for (const { name, pattern } of EXPLAINER_BANNED_WORDING) {
    const found = text.match(pattern);
    if (found) add(`carries ${name} (${JSON.stringify(found[0])}).`);
  }
  const bannedInTitle = EXPLAINER_BANNED_WORDING.find(({ pattern }) => pattern.test(explainer.title ?? ''));
  if (bannedInTitle) add(`title carries ${bannedInTitle.name}.`);
  const named = namesAProvider(text) ?? namesAProvider(explainer.title);
  if (named) add(`names a provider (${named}).`);

  const { figureIds, ruleIds } = explainer;
  if (!Array.isArray(figureIds) || !Array.isArray(ruleIds)) {
    add('needs figureIds and ruleIds, each a list.');
  } else {
    if (figureIds.length + ruleIds.length === 0) add('must explain at least one figure or rule.');
    for (const id of [...figureIds, ...ruleIds]) {
      if (typeof id !== 'string' || !FIGURE_OR_RULE_ID.test(id)) add(`has a malformed id ${JSON.stringify(id)}.`);
    }
    if (new Set([...figureIds, ...ruleIds]).size !== figureIds.length + ruleIds.length) add('lists an id twice.');
    const missing = unresolvedIds({ figureIds, ruleIds }, figures);
    for (const id of missing.figureIds) add(`explains ${id}, which is not a figure in the register.`);
    for (const id of missing.ruleIds) add(`explains ${id}, under which the register has no figure.`);
  }

  if (!Array.isArray(explainer.sources) || explainer.sources.length === 0) {
    add('needs at least one source.');
  } else {
    explainer.sources.forEach((source, index) => problems.push(...sourceProblems(source, `${explainer.id}: source ${index + 1}`)));
    const urls = explainer.sources.map((source) => source?.url);
    if (new Set(urls).size !== urls.length) add('lists a source twice.');
  }

  if (!ISO_DATE.test(explainer.checkedOn ?? '')) add('needs checkedOn as a date.');
  else if (ISO_DATE.test(today ?? '') && explainer.checkedOn > today) add('checkedOn is in the future.');
  return problems;
}

/** Problems across the whole catalogue: each explainer, and ids that repeat. */
export function explainersProblems(explainers, figures, today) {
  const problems = explainers.flatMap((explainer) => explainerProblems(explainer, figures, today));
  const ids = explainers.map((explainer) => explainer?.id);
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (repeated.length > 0) problems.push(`explainer ids repeat: ${[...new Set(repeated)].join(', ')}.`);
  return problems;
}

/** Explainers whose sources are due to be read again, as warnings. */
export function explainerWarnings(explainers, today) {
  const warnings = [];
  const day = 86_400_000;
  for (const explainer of explainers) {
    const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${explainer.checkedOn}T00:00:00Z`)) / day);
    if (age > EXPLAINER_REREAD_DAYS) {
      warnings.push(`${explainer.id} was last checked ${age} days ago; read its sources again.`);
    }
  }
  return warnings;
}
