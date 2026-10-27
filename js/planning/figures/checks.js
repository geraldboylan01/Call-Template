/**
 * The rules the figures register is held to. Pure: each takes the figures or the
 * catalogues and returns what is wrong, so `check:figures` runs them on the real
 * data and the tests run them on data with something deliberately broken.
 *
 * A failure stops the check. A warning is printed and does not: it is how a
 * stale market figure, a reviewed rate the evidence has moved away from, or an
 * announced rule that may have since been enacted gets noticed.
 */

import { FIGURE_KINDS, FIGURE_MODULES } from './kinds.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Days from one ISO date to another, using calendar dates only. */
export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * Failures in the figures themselves: a figure with no source, no check date, a
 * check date in the future, or a kind or module the register does not know.
 */
export function figureFailures(figures, today) {
  const failures = [];
  for (const figure of figures) {
    const add = (message) => failures.push(`${figure.id}: ${message}`);
    if (!FIGURE_KINDS.includes(figure.kind)) add(`unknown kind ${JSON.stringify(figure.kind)}.`);
    if (!figure.source || typeof figure.source.title !== 'string' || figure.source.title.trim() === '') add('has no source.');
    if (figure.kind === 'law' || figure.kind === 'announced_law') {
      if (!figure.sources.some((source) => /^https:\/\//.test(source.url ?? ''))) add('is law, so it needs a source with an https url.');
      if (figure.sources.some((source) => /[?&]utm_/.test(source.url ?? ''))) add('has a source url with tracking parameters.');
    }
    if (figure.kind === 'market') {
      const quotes = figure.observations ?? [];
      if (quotes.length === 0 || quotes.some((quote) => !/^https:\/\//.test(quote.url ?? ''))) add('is a market figure, so every quote needs an https url.');
    }
    if (!ISO_DATE.test(figure.checkedOn ?? '')) add('has no checkedOn date.');
    else if (figure.checkedOn > today) add(`was checked on ${figure.checkedOn}, which is in the future.`);
    if (!figure.usedBy?.every((name) => FIGURE_MODULES.includes(name)) || !figure.usedBy?.length) add('usedBy must name known modules.');
  }
  return failures;
}

/**
 * Quantities defined twice. A quantity is one thing in the world: DIRT, the
 * standard-rate band for a single person. It may have many dated values, but it
 * is owned by one catalogue, and no two values share an effective date.
 */
export function duplicateQuantities(figures) {
  const problems = [];
  const owners = new Map();
  const dated = new Map();
  for (const figure of figures) {
    const owner = owners.get(figure.quantity);
    if (owner && owner !== figure.catalogue.id) {
      problems.push(`${figure.quantity} is defined in both ${owner} and ${figure.catalogue.id}.`);
    }
    owners.set(figure.quantity, owner ?? figure.catalogue.id);
    const key = `${figure.quantity}@${figure.effectiveFrom}`;
    if (dated.has(key)) problems.push(`${figure.quantity} has two values with the same effective date (${figure.id} and ${dated.get(key)}).`);
    dated.set(key, figure.id);
  }
  return problems;
}

/** Every `announcedBy: "Budget YYYY"` anywhere in a catalogue, with where it was found. */
export function budgetReferences(value, path = '', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => budgetReferences(item, `${path}[${index}]`, found));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'announcedBy' && typeof child === 'string') {
        const match = /^Budget (\d{4})$/.exec(child);
        if (match) found.push({ budget: child, year: Number(match[1]), path: `${path}.${key}`.replace(/^\./, '') });
      } else {
        budgetReferences(child, path ? `${path}.${key}` : key, found);
      }
    }
  }
  return found;
}

/**
 * Budgets recorded for a tax year that has no block for that year. The tax
 * catalogue's own rule is to add an announced block on Budget day; recording a
 * rate from a Budget without one leaves the bands, credits and USC that Budget
 * changed at the old year's values.
 */
export function budgetGaps(rulesByYear, catalogues) {
  const references = Object.entries(catalogues).flatMap(([name, catalogue]) => budgetReferences(catalogue, name));
  const gaps = new Map();
  for (const reference of references) {
    const block = rulesByYear[reference.year];
    if (!block || (block.status !== 'announced' && block.status !== 'enacted')) {
      const entry = gaps.get(reference.budget) ?? { budget: reference.budget, year: reference.year, where: [] };
      entry.where.push(reference.path);
      gaps.set(reference.budget, entry);
    }
  }
  return [...gaps.values()];
}

/** Problems with the tax blocks: an announced block must say which Budget, an enacted one which Act. */
export function blockProblems(rulesByYear) {
  const problems = [];
  for (const [year, block] of Object.entries(rulesByYear)) {
    if (block.status === 'announced' && (!block.announcedBy || !ISO_DATE.test(block.announcedOn ?? ''))) {
      problems.push(`Tax year ${year} is announced, so it needs announcedBy and announcedOn.`);
    }
    if (block.status === 'enacted' && !block.enactedBy) problems.push(`Tax year ${year} is enacted, so it needs enactedBy.`);
    if (!['announced', 'enacted'].includes(block.status)) problems.push(`Tax year ${year} has status ${JSON.stringify(block.status)}.`);
    if (!ISO_DATE.test(block.verifiedOn ?? '')) problems.push(`Tax year ${year} has no verifiedOn date.`);
  }
  return problems;
}

/**
 * Things worth a look that do not stop anything: a market figure past its
 * review interval, a reviewed rate its evidence has moved away from, and an
 * announced rule not looked at for a quarter, which may have been enacted since.
 */
export function figureWarnings(figures, today, { announcedStaleAfterDays = 90 } = {}) {
  const warnings = [];
  for (const figure of figures) {
    if (figure.kind === 'market') {
      const age = daysBetween(figure.checkedOn, today);
      if (age > figure.reviewEveryDays) {
        warnings.push(`${figure.id} was last checked ${age} days ago; it is reviewed every ${figure.reviewEveryDays}.`);
      }
      if (figure.evidence?.drifted) {
        warnings.push(`${figure.id} is ${figure.valueShown}, but its quotes now point to ${(figure.evidence.median * 100).toFixed(2)}%.`);
      }
    }
    if (figure.kind === 'announced_law' && daysBetween(figure.checkedOn, today) > announcedStaleAfterDays) {
      warnings.push(`${figure.id} is still announced and was last checked ${daysBetween(figure.checkedOn, today)} days ago; check whether it has been enacted.`);
    }
  }
  return warnings;
}
