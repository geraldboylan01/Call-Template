import { getFigures } from './planning/figures/get_figures.js';
import { parseNarration } from './plan_story_model.js';

/**
 * THE STORY'S FACTS, AS THE SCREEN READS THEM.
 *
 * `readPlanPosition(compiled)` (docs/story-facts.md) produces every fact a story may use. This turns those facts
 * into the registry the story screen resolves placeholders against (text, where it opens, its basis), reads
 * `{figure.<id>}` from the figures register, and finds which placeholders a story names. The analyst's
 * `submit_story` and the screen's `buildPlanStory` use the same functions, so a story that is accepted at
 * submission opens on the screen.
 *
 * Pure: no DOM, no clock, no state.
 */

export const FIGURE_PREFIX = 'figure.';
const PARTS = ['does', 'why', 'gives', 'costs', 'check'];

/** Where a fact opens: the module and case it came from, or the part of the plan view that worked it out. */
function linkSource(source) {
  if (source?.chapter) {
    return {
      chapter: source.chapter,
      caseId: source.caseId ?? null,
      nativeCaseId: source.nativeCaseId ?? null,
      focusTargetId: source.focusTargetId ?? null
    };
  }
  return { panel: source?.panel ?? 'plan_facts' };
}

/** One available fact as a registry entry, or null for a fact the plan did not produce. */
export function factEntry(fact) {
  if (fact?.status !== 'available') return null;
  return { text: fact.display, source: linkSource(fact.source), basis: fact.basis, ...(fact.explainerId ? { explainerId: fact.explainerId } : {}) };
}

/** `{figure.<id>}` from the figures register, on the plan's calculation date; null when the register does not hold it. */
export function figureEntry(id, calculationDate) {
  let figure;
  try { [figure] = getFigures({ ids: [id], onDate: calculationDate }); } catch (_error) { return null; }
  if (!figure) return null;
  return {
    text: figure.valueShown,
    source: { panel: 'figures' },
    basis: {
      kind: 'official', registerId: figure.id, value: figure.value, source: { ...figure.source },
      checkedOn: figure.checkedOn, catalogueVersion: figure.catalogueVersion
    }
  };
}

/** Every available fact of one route as registry entries, keyed as the story names them. */
export function storyFactRegistry(position, routeId) {
  const facts = position.routes.find((route) => route.routeId === routeId)?.facts ?? {};
  return Object.fromEntries(Object.entries(facts).map(([key, fact]) => [key, factEntry(fact)]).filter(([, entry]) => entry));
}

/** What a story author is told it may use: each key with how it reads and whether it opens a module. */
export function compactStoryFacts(position, routeId) {
  return Object.fromEntries(Object.entries(storyFactRegistry(position, routeId))
    .map(([key, entry]) => [key, { text: entry.text, opens: entry.source.chapter ? 'module' : 'plan' }]));
}

/** Every narration string in a story (headline, summary, section titles, parts, goal subsections). */
export function* narrations(story) {
  yield story.headline;
  yield story.summary;
  const parts = (holder) => [...(holder.paragraphs ?? []), ...PARTS.map((part) => holder.parts?.[part])];
  for (const section of story.sections ?? []) {
    yield section.title;
    yield* parts(section);
    for (const goal of section.goals ?? []) {
      yield goal.title;
      yield* parts(goal);
    }
  }
}

/** The placeholders a story names. Text that cannot be parsed is left for resolveStory to refuse, with its path. */
export function referencedPlaceholders(story) {
  const keys = new Set();
  const explainers = new Set();
  for (const text of narrations(story)) {
    let tokens = [];
    try { tokens = parseNarration(text); } catch (_error) { continue; }
    for (const token of tokens) {
      if (token.type !== 'placeholder') continue;
      if (token.explainer) explainers.add(token.key.slice('explainer.'.length));
      else keys.add(token.key);
    }
  }
  return { keys, explainers };
}
