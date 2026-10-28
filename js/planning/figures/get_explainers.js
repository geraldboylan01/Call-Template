/**
 * Reading the explainer catalogue. Read-only, like `getFigures`: it returns frozen
 * copies of what the generated index holds, so nothing that reads an explainer
 * can change one.
 *
 * Two readers use it. The story screen shows an explainer on hover or tap, and the
 * analyst points to one instead of explaining a rule in its own words (see
 * docs/analyst-architecture.md, 3.2). The wording is code-owned and checked like a
 * figure; neither reader rewrites it. An explainer types no figure: it names the
 * figures it explains by id, and the reader fills the values in with `getFigures`.
 */

import { EXPLAINERS_INDEX, FIGURES_INDEX } from './figures_index.generated.js';

const BY_ID = new Map(EXPLAINERS_INDEX.map((explainer) => [explainer.id, explainer]));
const FIGURE_IDS = new Set(FIGURES_INDEX.map((figure) => figure.id));

function frozenCopy(explainer) {
  return Object.freeze({
    id: explainer.id,
    title: explainer.title,
    sentences: Object.freeze([...explainer.sentences]),
    text: explainer.text,
    figureIds: Object.freeze([...explainer.coversFigureIds]),
    ruleIds: Object.freeze([...explainer.ruleIds]),
    sources: Object.freeze(explainer.sources.map((source) => Object.freeze({ ...source }))),
    checkedOn: explainer.checkedOn,
    catalogueVersion: explainer.catalogueVersion
  });
}

/**
 * The explainers in the register, each with its sentences, the figures it
 * explains, its official sources and the day they were read.
 *
 * @param {object} [options]
 * @param {string[]} [options.ids] Exactly these explainers. An id the catalogue does
 *   not hold is an error, not an omission, so an explainer is never silently missing
 *   from an answer.
 * @param {string[]} [options.figureIds] Only the explainers that explain at least
 *   one of these figures. A figure id the register does not hold is an error; a
 *   figure that no explainer covers simply returns none for it. Combined with `ids`,
 *   both must hold.
 */
export function getExplainers({ ids, figureIds } = {}) {
  for (const [name, value] of [['ids', ids], ['figureIds', figureIds]]) {
    if (value !== undefined && !(Array.isArray(value) && value.every((entry) => typeof entry === 'string'))) {
      throw new Error(`${name} must be an array of ids.`);
    }
  }
  if (ids !== undefined) {
    const missing = ids.filter((id) => !BY_ID.has(id));
    if (missing.length > 0) {
      throw new Error(`The explainer catalogue holds no explainer with the id ${missing.map((id) => JSON.stringify(id)).join(', ')}.`);
    }
  }
  if (figureIds !== undefined) {
    const missing = figureIds.filter((id) => !FIGURE_IDS.has(id));
    if (missing.length > 0) {
      throw new Error(`The figures register holds no figure with the id ${missing.map((id) => JSON.stringify(id)).join(', ')}.`);
    }
  }

  let selected = EXPLAINERS_INDEX;
  if (ids !== undefined) {
    const wanted = new Set(ids);
    selected = selected.filter((explainer) => wanted.has(explainer.id));
  }
  if (figureIds !== undefined) {
    const wanted = new Set(figureIds);
    selected = selected.filter((explainer) => explainer.coversFigureIds.some((id) => wanted.has(id)));
  }
  return Object.freeze(selected.map(frozenCopy));
}
