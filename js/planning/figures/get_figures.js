/**
 * Reading the figures register. Read-only: it returns frozen copies of what the
 * generated index holds, so nothing that reads a figure can change one.
 *
 * Two readers use it. The plan pack resolves `{figure.<id>}` placeholders from
 * it the same way it resolves engine figures, so narration never types a figure.
 * The analyst loop gets a `read_figures` tool backed by it (see
 * docs/plan-and-routes-implementation-plan.md), so the in-app AI states a rate
 * from the register and never from memory.
 *
 * An entry carries what a person or the AI may be told: the label, the value and
 * how it reads, the unit, the kind, the status, when it takes effect, its source,
 * when it was checked, the catalogue version and who uses it. It does not carry a
 * market figure's quotes: those name banks and lenders and are internal
 * provenance, kept in the index for the audit trail and the weekly job.
 */

import { FIGURES_CATALOGUES, FIGURES_INDEX, FIGURES_INDEX_VERSION } from './figures_index.generated.js';
import { FIGURE_KINDS, FIGURE_MODULES } from './kinds.js';

const BY_ID = new Map(FIGURES_INDEX.map((figure) => [figure.id, figure]));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function frozenCopy(figure) {
  return Object.freeze({
    id: figure.id,
    label: figure.label,
    value: figure.value,
    valueShown: figure.valueShown,
    unit: figure.unit,
    kind: figure.kind,
    status: figure.status,
    effectiveFrom: figure.effectiveFrom,
    source: Object.freeze({ ...figure.source }),
    sources: Object.freeze(figure.sources.map((source) => Object.freeze({ ...source }))),
    checkedOn: figure.checkedOn,
    catalogueVersion: figure.catalogue.version,
    usedBy: Object.freeze([...figure.usedBy]),
    ...(figure.appliesTo ? { appliesTo: figure.appliesTo } : {}),
    ...(figure.note ? { note: figure.note } : {}),
    ...(figure.aliases ? { aliases: Object.freeze([...figure.aliases]) } : {})
  });
}

/**
 * Of every value of a quantity, the one in force on a date: the latest that has
 * taken effect by then. A figure with no effective date is always in force. A
 * quantity whose values all start later has none in force.
 */
function inForceOn(figures, onDate) {
  const latest = new Map();
  for (const figure of figures) {
    if (figure.effectiveFrom !== null && figure.effectiveFrom > onDate) continue;
    const held = latest.get(figure.quantity);
    if (!held || (figure.effectiveFrom ?? '') >= (held.effectiveFrom ?? '')) latest.set(figure.quantity, figure);
  }
  return figures.filter((figure) => latest.get(figure.quantity) === figure);
}

/**
 * The figures in the register, each with its value and source.
 *
 * @param {object} [options]
 * @param {string[]} [options.ids] Exactly these figures. An id the register does not
 *   hold is an error, not an omission: a figure silently missing from an answer is
 *   how a rate gets typed in from memory. With `onDate`, the ids are candidates: one
 *   already superseded on that date, or not yet in force, is left out, so listing an
 *   old and a new id returns the one in force.
 * @param {string[]} [options.kinds] Only these kinds: law, announced_law, market,
 *   planeir_assumption.
 * @param {string} [options.module] Only the figures this module uses.
 * @param {string} [options.onDate] YYYY-MM-DD. For each quantity, only the value in
 *   force on that date, decided before any other filter is applied; later announced
 *   values are left out, and a filter never brings a superseded one back.
 */
export function getFigures({ ids, kinds, module, onDate } = {}) {
  if (ids !== undefined && !(Array.isArray(ids) && ids.every((id) => typeof id === 'string'))) {
    throw new Error('ids must be an array of figure ids.');
  }
  if (kinds !== undefined) {
    const unknown = (Array.isArray(kinds) ? kinds : [kinds]).filter((kind) => !FIGURE_KINDS.includes(kind));
    if (unknown.length > 0) throw new Error(`Unknown figure kind: ${unknown.join(', ')}. Kinds are ${FIGURE_KINDS.join(', ')}.`);
  }
  if (module !== undefined && !FIGURE_MODULES.includes(module)) {
    throw new Error(`Unknown module ${JSON.stringify(module)}. Modules are ${FIGURE_MODULES.join(', ')}.`);
  }
  if (onDate !== undefined && !ISO_DATE.test(onDate)) {
    throw new Error(`onDate must be a YYYY-MM-DD date; received ${JSON.stringify(onDate)}.`);
  }

  if (ids !== undefined) {
    const missing = ids.filter((id) => !BY_ID.has(id));
    if (missing.length > 0) throw new Error(`The figures register holds no figure with the id ${missing.map((id) => JSON.stringify(id)).join(', ')}.`);
  }
  // What is in force on a date is decided against the whole register first. Filtering
  // first would drop a newer value from the comparison and let the superseded one
  // through: the 2012 CGT rate for an id, or the old band for the law kind.
  let selected = onDate !== undefined ? inForceOn(FIGURES_INDEX, onDate) : FIGURES_INDEX;
  if (ids !== undefined) {
    const wanted = new Set(ids);
    selected = selected.filter((figure) => wanted.has(figure.id));
  }
  if (kinds !== undefined) {
    const wanted = new Set(Array.isArray(kinds) ? kinds : [kinds]);
    selected = selected.filter((figure) => wanted.has(figure.kind));
  }
  if (module !== undefined) selected = selected.filter((figure) => figure.usedBy.includes(module));
  return Object.freeze(selected.map(frozenCopy));
}

/**
 * One string naming the index and every catalogue behind it, so a saved plan can
 * say which register its narrated figures came from.
 */
export function figuresVersionLabel() {
  return `${FIGURES_INDEX_VERSION} (${FIGURES_CATALOGUES.map((catalogue) => catalogue.version).join(', ')})`;
}
