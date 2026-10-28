import { buildGlance, resolveStory } from '../js/plan_story_model.js';
import {
  buildBackToStoryPill,
  buildOffRouteNote,
  buildPlanStoryPage,
  buildStoryModulesSwitch,
  returnToParagraph,
  revealSelectedRoute
} from '../js/plan_story_view.js';
import {
  PLAN_STORY_SAMPLE_CATALOGUE,
  PLAN_STORY_SAMPLE_GLANCE_NOTE,
  PLAN_STORY_SAMPLE_REGISTRY,
  PLAN_STORY_SAMPLE_ROUTES,
  PLAN_STORY_SAMPLE_STORY
} from '../js/tests_plan_story_sample.js';

/**
 * The story screen on its own, against the sample fixture. A link opens a stub
 * standing in for the module (the app opens the real one), so the story's side
 * of the hand-off can be seen: the pill, the return to the same paragraph, and
 * the note that shows when the case no longer follows the route.
 *
 *   ?updating=goals,risks   sections still recalculating
 *   ?offroute=1             the stub shown on a case other than the route's
 */

const params = new URLSearchParams(location.search);
const resolved = resolveStory({ story: PLAN_STORY_SAMPLE_STORY, registry: PLAN_STORY_SAMPLE_REGISTRY, catalogue: PLAN_STORY_SAMPLE_CATALOGUE });
const glance = buildGlance(PLAN_STORY_SAMPLE_ROUTES);
const mount = document.getElementById('mount');
const bar = document.getElementById('bar');
let view = params.get('view') === 'modules' ? 'modules' : 'story';
let returnPoint = null;
let page = null;

function drawBar() {
  bar.replaceChildren(buildStoryModulesSwitch({ active: view, onChange: (next) => { view = next; draw(); } }));
}

function drawStory() {
  page = buildPlanStoryPage({
    resolved,
    routes: PLAN_STORY_SAMPLE_ROUTES,
    glance,
    glanceNote: PLAN_STORY_SAMPLE_GLANCE_NOTE,
    selectedRouteId: 'route-3',
    updatingSectionIds: (params.get('updating') || '').split(',').filter(Boolean),
    switchingToName: params.get('updating') ? 'Route 3' : null,
    onSelectRoute: (id) => console.info('select route', id),
    onOpenLink: (target, context) => {
      returnPoint = { sectionId: context.sectionId, paragraphIndex: context.paragraphIndex, figureKey: target.figureKey };
      drawOpened(target, context);
    }
  });
  mount.replaceChildren(page);
  revealSelectedRoute(page);
  if (returnPoint) { returnToParagraph(page, returnPoint); returnPoint = null; }
}

function drawOpened(target, context) {
  const chapter = PLAN_STORY_SAMPLE_CATALOGUE.chapters[target.chapter]?.title ?? target.panel;
  const caseName = PLAN_STORY_SAMPLE_CATALOGUE.cases[target.chapter]?.[target.caseId] ?? null;
  const section = resolved.sections.find((entry) => entry.id === context.sectionId);
  const stub = document.createElement('div');
  stub.className = 'preview-stub';
  stub.innerHTML = '';
  const strong = (text) => Object.assign(document.createElement('b'), { textContent: text });
  stub.append(strong(chapter), caseName ? ` · ${caseName}` : '', document.createElement('br'),
    'The app opens the real module here, on this case, and outlines ',
    target.figureText ? strong(`“${target.figureText}”`) : 'nothing (a “See it in” link opens the module without an outline)', '.');
  const parts = [buildBackToStoryPill({ sectionTitle: section ? `section ${section.number}, ${section.title}` : '', figureText: target.figureText, onBack: () => { view = 'story'; draw(); } })];
  if (params.get('offroute')) parts.push(buildOffRouteNote({ caseWas: caseName || 'the route’s case', caseNow: 'Today', onBackToRoute: () => {} }));
  parts.push(stub);
  mount.replaceChildren(...parts);
}

function drawModules() {
  const stub = document.createElement('div');
  stub.className = 'preview-stub';
  stub.textContent = 'The existing module grid, exactly as it is today.';
  mount.replaceChildren(stub);
}

function draw() {
  drawBar();
  if (view === 'modules') drawModules(); else drawStory();
}

draw();
await document.fonts.ready;
document.body.dataset.ready = 'true';
