import { readPlanPosition } from './story_facts.js';
import { storyRequirements, STORY_SECTIONS, STORY_PARTS } from './story_requirements.js';
import { storyTokens, storyWordRefusals, protectionOnly } from './story_wording.js';
import { checkStoryLink } from './story_links.js';
import { getFigures, figuresVersionLabel } from '../figures/get_figures.js';
import { getExplainers } from '../figures/get_explainers.js';
import { PLANEIR_ASSUMPTIONS_VERSION } from '../planeir_assumptions.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const meaningful = value => typeof value === 'string' && /[\p{L}\p{N}{]/u.test(value.replace(/\p{Cf}/gu, '').trim());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Also available to code authoring a draft: limitations are never supplied by the story. */
export function getStoryRequirements(compiledPlan, routeId) {
  const position = readPlanPosition(compiledPlan).routes.find(row => row.routeId === routeId);
  if (!position) throw Object.assign(new Error('Name a route in the successfully compiled plan.'), { code: 'unknown_route', path: '/story/routeId' });
  if (compiledPlan.source.normalizedPlanPack.routes.some(route => route.id === routeId && route.changes.length)
    && compiledPlan.versions.assumptions !== PLANEIR_ASSUMPTIONS_VERSION) throw Object.assign(new Error('Recompile with the matching assumptions before classifying route moves.'),
    { code: 'calculation_versions', path: '/compiledPlan/versions/assumptions' });
  return storyRequirements(compiledPlan, position);
}

/** Full submit_story check. Returns all applicable refusals; never edits either argument. */
export function checkStory(compiledPlan, story) {
  const refusals = [], links = [];
  const refuse = (code, path, message) => refusals.push({ code, path, message });
  const verdict = requirements => ({ ok: !refusals.length, verdict: refusals.length ? 'refused' : 'pass',
    checkerVersion: 'story-checker-1.0.0', routeId: story?.routeId ?? null, refusals, links, ...(requirements ? { limitations: requirements.limitations } : {}) });
  const shape = (value, fields, path) => {
    if (!object(value)) { refuse('shape', path, 'Use an object with the documented story fields.'); return false; }
    for (const key of Object.keys(value)) if (!fields.includes(key)) refuse('unknown_field', path + '/' + key, 'This field is not part of the story contract; nothing is silently discarded.');
    return true;
  };
  if (!shape(story, ['routeId', 'headline', 'summary', 'sections', 'whatifs'], '/story')) return verdict();
  if (!meaningful(story.routeId)) { refuse('route_id', '/story/routeId', 'Name the compiled route whose story this is.'); return verdict(); }
  let requirements;
  try { requirements = getStoryRequirements(compiledPlan, story.routeId); }
  catch (error) { refuse(error.code ?? 'compiled_plan', error.path ?? '/compiledPlan', error.message); return verdict(); }
  const { facts } = requirements;
  const sections = Array.isArray(story.sections) ? story.sections : [];
  const uses = new Map(), limitUses = new Map(), goalUses = new Map();
  const otherRoutes = compiledPlan.routes.filter(row => row.id !== story.routeId && row.id !== 'current');
  const registered = compiledPlan.versions.figures === figuresVersionLabel();
  const figures = new Map(getFigures().map(row => [row.id, row]));
  const explainers = new Map(getExplainers().map(row => [row.id, row]));
  const narrative = (text, path, sectionId, scope = null) => {
    if (!meaningful(text)) { refuse('empty_part', path, 'Write a non-empty education-only part, including what it costs.'); return; }
    const parsed = storyTokens(text, path); refusals.push(...parsed.errors);
    const seen = uses.get(sectionId) ?? new Set(); uses.set(sectionId, seen);
    const local = scope ?? new Set();
    const literal = parsed.tokens.filter(token => token.kind === 'text').map(token => token.text).join(' ');
    refusals.push(...storyWordRefusals(literal, path, { otherRoutes }));
    const numericRegistry = { ...facts };
    for (const token of parsed.tokens.filter(row => row.kind !== 'text')) {
      if (token.kind === 'explainer') {
        if (!registered) refuse('register_versions', path, 'The compiled register version is unavailable; recompile before citing an explainer.');
        if (!explainers.has(token.key)) refuse('unknown_explainer', path, 'The register has no explainer named ' + token.key + '.');
        continue;
      }
      if (token.key.startsWith('figure.')) {
        const figure = figures.get(token.key.slice('figure.'.length));
        if (!registered) refuse('register_versions', path, 'Use the register version recorded in the compiled plan.');
        if (!figure) refuse('unknown_figure', path, 'The dated register has no figure named ' + token.key + '.');
        if (token.kind === 'link') refuse('register_link', path, 'Register figures use {figure.id}; module links use {@key}.');
        if (figure && typeof figure.value === 'number') numericRegistry[token.key] = { unit: 'ratio' };
        continue;
      }
      const fact = Object.hasOwn(facts, token.key) ? facts[token.key] : null;
      if (!fact) { refuse('unknown_placeholder', path, 'This route has no registered fact named ' + token.key + '.'); continue; }
      if (fact.status !== 'available' || fact.value === null) { refuse('unavailable_placeholder', path, 'This result was not calculated; cite its code-produced limitation or not-applicable reason.'); continue; }
      seen.add(token.key); local.add(token.key);
      if (token.kind === 'link') {
        const checked = checkStoryLink(compiledPlan, fact, path);
        if (!checked.ok) refusals.push(checked.refusal); else links.push({ path, ...checked });
      }
    }
    const keys = parsed.tokens.filter(token => token.kind !== 'text').map(token => token.key);
    for (const key of protectionOnly(literal, keys, numericRegistry, sectionId)) refuse('protection_figure', path,
      'Protection may use only the income gap, savings duration and stated money received; ' + key + ' is outside that scope.');
    if (/\b(?:not shown|not calculated|not available|cannot calculate|could not show|unable to show)\b/i.test(literal)
      && !keys.some(key => key.startsWith('limitations.') || key.endsWith('.notApplicable'))) refuse('unregistered_limitation', path,
      'Use the code limitation that names the missing fact and affected result.');
  };
  const parts = (value, path, sectionId, scope = null) => {
    if (!shape(value, STORY_PARTS, path)) return;
    for (const key of STORY_PARTS) narrative(value[key], path + '/' + key, sectionId, scope);
  };
  const ids = (value, allowed, path) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) { refuse('shape', path, 'Use a list of code-produced identifiers.'); return []; }
    const seen = new Set();
    value.forEach((id, i) => {
      if (typeof id !== 'string' || !allowed.includes(id)) refuse('unknown_reference', path + '/' + i, 'This identifier was not produced for the compiled route.');
      if (seen.has(id)) refuse('duplicate_reference', path + '/' + i, 'Name this entry once.');
      seen.add(id);
    });
    return value;
  };
  narrative(story.headline, '/story/headline', 'headline'); narrative(story.summary, '/story/summary', 'summary');
  if (sections.length !== STORY_SECTIONS.length) refuse('section_order', '/story/sections', 'Include all nine sections in the prescribed order, without dropping or repeating any.');
  sections.forEach((section, index) => {
    const path = '/story/sections/' + index;
    if (!shape(section, ['id', 'title', 'parts', 'goals', 'issues', 'freedCash', 'risks', 'limitationIds', 'majorMoves'], path)) return;
    if (section.id !== STORY_SECTIONS[index]) refuse('section_order', path + '/id', 'This position must contain ' + (STORY_SECTIONS[index] ?? 'no further section') + '.');
    const sectionId = section.id;
    narrative(section.title, path + '/title', sectionId); parts(section.parts, path + '/parts', sectionId);
    const limitations = ids(section.limitationIds, requirements.limitations.map(row => row.id), path + '/limitationIds');
    limitUses.set(sectionId, new Set(limitations));
    for (const [field, expected] of [['goals', 'goals'], ['issues', 'inefficiencies'], ['freedCash', 'cash_flow_after'], ['risks', 'risks']]) {
      if (section[field] !== undefined && sectionId !== expected) refuse('misplaced_entry', path + '/' + field, 'Put these entries in ' + expected + '.');
    }
    if (sectionId === 'goals') {
      if (!Array.isArray(section.goals)) refuse('shape', path + '/goals', 'Use the ordered list of goal subsections, including an empty list when no goals exist.');
      const goals = Array.isArray(section.goals) ? section.goals : [];
      if (!same(goals.map(row => row?.goalId), requirements.goalIds)) refuse('goal_order', path + '/goals', 'Include each goal once, in the compiled ledger’s order.');
      goals.forEach((goal, i) => {
        const here = path + '/goals/' + i;
        if (!shape(goal, ['goalId', 'title', 'parts', 'limitationIds'], here)) return;
        const own = new Set(); goalUses.set(goal.goalId, own);
        narrative(goal.title, here + '/title', sectionId, own); parts(goal.parts, here + '/parts', sectionId, own);
        for (const id of ids(goal.limitationIds, requirements.limitations.map(row => row.id), here + '/limitationIds')) limitUses.get(sectionId).add(id);
      });
    }
    if (sectionId === 'inefficiencies') {
      const found = ids(section.issues, requirements.issues.map(row => row.id), path + '/issues');
      for (const issue of requirements.issues) if (!found.includes(issue.id)) refuse('issue_floor', path + '/issues', 'Include the code-found issue ' + issue.id + '.');
    }
    if (sectionId === 'cash_flow_after') {
      const found = ids(section.freedCash, requirements.freed.map(row => row.id), path + '/freedCash');
      for (const event of requirements.freed) if (!found.includes(event.id)) refuse('freed_cash_floor', path + '/freedCash', 'Include this freed-cash event inside the ledger years: ' + event.id + '.');
    }
    const moveIds = ids(section.majorMoves, requirements.majorMoves.map(row => row.id), path + '/majorMoves');
    if (moveIds.length && (!meaningful(section.parts?.costs) || !meaningful(section.parts?.check))) refuse('major_move_parts', path + '/parts', 'A major move needs its costs and what to check.');
    if (sectionId === 'risks') {
      if (section.risks !== undefined && !Array.isArray(section.risks)) refuse('shape', path + '/risks', 'Use a list of risks with compiled change identifiers and education-only parts.');
      const risks = Array.isArray(section.risks) ? section.risks : [];
      risks.forEach((risk, i) => {
        const here = path + '/risks/' + i;
        if (!shape(risk, ['changeIds', 'parts'], here)) return;
        ids(risk.changeIds, requirements.changes.map(row => row.id), here + '/changeIds'); parts(risk.parts, here + '/parts', sectionId);
      });
      if (story.routeId !== 'current' && !risks.some(risk => Array.isArray(risk?.changeIds) && risk.changeIds.some(id => requirements.mainChangeIds.includes(id)))) refuse('risk_floor', path + '/risks', 'Include a risk tied to the compiled route’s main change.');
    }
  });
  for (const entry of requirements.required) {
    const sectionIndex = STORY_SECTIONS.indexOf(entry.section), path = '/story/sections/' + sectionIndex;
    if (!uses.get(entry.section)?.has(entry.key)) refuse('required_fact', path + '/parts', 'Include the registered fact or code reason {' + entry.key + '}.');
    if (entry.section === 'goals' && entry.key.startsWith('goals.')) {
      const goalId = requirements.goalIds.find(id => entry.key.startsWith('goals.' + id + '.'));
      if (!goalUses.get(goalId)?.has(entry.key)) refuse('goal_fact', path + '/goals', 'Include {' + entry.key + '} in its own goal subsection.');
    }
  }
  for (const limitation of requirements.limitations) for (const sectionId of [limitation.section, 'check_next']) {
    if (!limitUses.get(sectionId)?.has(limitation.id) || !uses.get(sectionId)?.has(limitation.key)) refuse('limitation_floor',
      '/story/sections/' + STORY_SECTIONS.indexOf(sectionId) + '/limitationIds',
      'Include the code limitation {' + limitation.key + '} here, naming its missing fact and affected result.');
  }
  const whatifs = Array.isArray(story.whatifs) ? story.whatifs : [];
  if (story.whatifs !== undefined && !Array.isArray(story.whatifs)) refuse('shape', '/story/whatifs', 'Use a list of compiled what-if references.');
  const seenWhatifs = new Set();
  whatifs.forEach((item, i) => {
    if (!shape(item, ['id'], '/story/whatifs/' + i)) return;
    const found = requirements.whatifs.find(row => row.id === item.id);
    if (!found || found.status !== 'compiled') refuse('unrun_whatif', '/story/whatifs/' + i, 'Cite a matching compiled what-if, or its code limitation instead of claiming a run.');
    if (seenWhatifs.has(item.id)) refuse('duplicate_whatif', '/story/whatifs/' + i, 'Name this what-if once.');
    seenWhatifs.add(item.id);
  });
  for (const item of requirements.whatifs) if (item.status === 'compiled' && !seenWhatifs.has(item.id)) refuse('whatif_floor', '/story/whatifs', 'Include the compiled ' + item.id + ' illustration.');
  for (const move of requirements.majorMoves) if (!sections.some(section => Array.isArray(section?.majorMoves) && section.majorMoves.includes(move.id))) refuse('major_move_floor', '/story/sections', 'Name the major move ' + move.id + ' beside its costs and check parts.');
  if (requirements.majorMoves.length > 1 && !singleMajorEvidence(compiledPlan, requirements)) refuse('major_move_count', '/story/sections', 'Use at most one major move unless compiled singleton routes show that each alone leaves goals unmet.');
  return verdict(requirements);
}

function singleMajorEvidence(compiled, requirements) {
  const route = compiled.routes.find(row => row.id === requirements.routeId), evidence = route.majorMoveEvidence;
  if (evidence?.code !== 'single_major_insufficient' || !Array.isArray(evidence.singleMoveRouteIds)) return false;
  const pack = compiled.source.normalizedPlanPack;
  return requirements.majorMoves.every(move => evidence.singleMoveRouteIds.some(id => {
    if (id === route.id) return false;
    const candidate = compiled.routes.find(row => row.id === id);
    const ledger = compiled.resourceLedger?.routes?.find(row => row.routeId === id);
    const authored = pack.routes.find(row => row.id === id);
    if (!candidate || candidate.status !== 'compiled' || !authored || !ledger?.goals?.some(goal => ['partly', 'not'].includes(goal.state))) return false;
    // Singleton means a route with that major move only, with the same settings.
    const original = requirements.changes.find(row => row.id === move.id);
    const wanted = pack.routes.find(row => row.id === route.id).changes[Number(original.id.slice('change_'.length))];
    return authored.changes.length === 1 && same(authored.changes[0], wanted);
  }));
}
