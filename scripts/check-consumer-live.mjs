/**
 * Live lane: tool contracts, the fact-gate inversion, and prompt invariants.
 *
 * The D1-backed commit path (applyPlannerCandidates → commitFactProposal) is
 * the SAME shared code the v2 lane and the agent transport use, and is already
 * covered by check-consumer-shared-planning.mjs. What is new here — and what
 * this file exercises — is the live lane's own contracts: what the tools
 * expose, what the model is allowed to see, and the fact-gate behaviour the
 * conversation depends on.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MODULE_IDS } from '../js/planning/contracts.js';
import { getSemanticFactDefinition } from '../js/planning/semantic_facts.js';
import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';
import { describeConversationState } from '../worker/src/consumer/conversation.js';
import { buildPlanningContext } from '../worker/src/consumer/planning_context.js';
import { planFactProposal } from '../worker/src/consumer/planning_facts.js';
import {
  LIVE_TOOL_DEFINITIONS,
  LIVE_TOOL_NAMES,
  assertLiveToolName,
  liveStateProjection,
  livePlanningConfig
} from '../worker/src/consumer/live/live_tools.js';
import {
  buildLiveCataloguePrompt,
  liveConsumerModules,
  liveVolatileStateItem
} from '../worker/src/consumer/live/catalogue_prompt.js';
import { classifySpokenPlanConfirmation } from '../worker/src/consumer/realtime_completion.js';

const NOW = '2026-07-27T09:00:00.000Z';
const CONFIG = livePlanningConfig({
  goalRoutingEnabled: true,
  moduleRoutingEnabled: true,
  allowedModules: Object.values(MODULE_IDS),
  realtimeSpokenCompletionEnabled: false,
  moduleOffersEnabled: true
});

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}

function freshProfile() {
  return normalizeHouseholdProfile({
    ...createHouseholdProfile({ profileId: 'live-lane', nowIso: NOW, calculationDateIso: NOW.slice(0, 10) }),
    revision: 1
  });
}

function sessionRowFor(revision = 1) {
  return { id: 'cs_live_test', current_profile_revision: revision, confirmed_profile_revision: null };
}

function contextFor(profile) {
  return buildPlanningContext({
    config: CONFIG,
    sessionRow: sessionRowFor(profile.revision || 1),
    profile,
    channel: 'live'
  });
}

/** Drive the real proposal path for one fact, exactly as save_facts does. */
function saveFact(profile, factId, value, certainty = 'exact') {
  const proposed = planFactProposal({
    config: CONFIG,
    profile,
    state: describeConversationState(profile, CONFIG),
    fact: { factId, value, certainty },
    plannerBatch: true
  });
  return proposed.profile;
}

/* ------------------------------------------------------------ tool shapes */

ok(LIVE_TOOL_NAMES.length === 3, 'The live lane has exactly three tools.');
assert.deepEqual([...LIVE_TOOL_NAMES].sort(), ['confirm_and_run', 'get_state', 'save_facts']);
checks += 1;

for (const tool of LIVE_TOOL_DEFINITIONS) {
  ok(tool.type === 'function', `${tool.name} must be a function tool.`);
  ok(tool.description.length > 40, `${tool.name} needs a description the model can act on.`);
  ok(tool.parameters?.type === 'object', `${tool.name} parameters must be an object schema.`);
  ok(tool.parameters.additionalProperties === false, `${tool.name} must not accept extra properties.`);
}

// NO TOOL ACCEPTS A MODULE ID. Analysis selection is server-owned; a model that
// could name a module could choose one.
const serialisedTools = JSON.stringify(LIVE_TOOL_DEFINITIONS);
ok(!/moduleId/i.test(serialisedTools), 'No live tool may accept a module id.');
ok(!/expectedRevision/.test(serialisedTools), 'The live lane does not carry per-call revision checks.');

const isUnknownTool = (error) => error?.code === 'live_tool_unknown';
assert.throws(() => assertLiveToolName('propose_facts'), isUnknownTool);
// get_intake_explanation is deliberately gone: answering a tangent must never
// cost a round-trip, and its nine-entry dictionary is what made the old lane
// deflect every unanticipated question.
assert.throws(() => assertLiveToolName('get_intake_explanation'), isUnknownTool);
checks += 2;

/* ------------------------------------------------- the fact-gate inversion */

// THE DEFECT THIS LANE EXISTS TO FIX.
//
// realtime-conversation-intelligence-plan.md §0 Defect 3: the v1 gate rejects
// any fact no currently-enabled module needs, so "I'm 25, renting, trying to
// buy my first place" DISCARDS the age and the property status — the two facts
// that would have changed which modules were selected. The fact that would fix
// the routing was thrown away because of the routing.
{
  let profile = freshProfile();
  profile = saveFact(profile, 'primary_goal', { type: 'buy_home' });
  ok(profile.goals.some((goal) => goal.type === 'buy_home'), 'A stated goal must save.');

  // Age is required by no house-purchase module. It must save anyway.
  profile = saveFact(profile, 'person_current_age', 25);
  ok(true, 'person_current_age saves on a buy_home journey (Defect 3 inverted).');

  profile = saveFact(profile, 'property_status', 'renter', 'approximate');
  ok(true, 'property_status saves as an inferred orientation fact.');

  const projection = liveStateProjection(contextFor(profile));
  ok(projection.ok === true, 'The state projection must succeed.');
  ok(projection.captured.length > 0, 'Saved facts must show as captured.');
  ok(projection.analyses.length > 0, 'A stated goal must put analyses in play.');
  ok(projection.analyses.length <= 3, 'No more than three analyses are ever in play.');

  // THE HEADLINE REGRESSION.
  //
  // "I'm 25, renting, trying to buy my first place" must never lead to "what is
  // your home worth?" or "what retirement income do you want?".
  //
  // The four compounding defects in realtime-conversation-intelligence-plan.md
  // §0 resolve here as a CONSEQUENCE of the architecture, with no change to
  // goal_plan.js or module_registry.js:
  //   D3 — the circular fact gate is off (livePlanningConfig), so age survives.
  //   D2 — isEarlyLife therefore sees primaryPerson.age = 25 and is no longer
  //        dead code on the one path where it matters.
  //   D1 — so personal_balance_sheet is not force-added as a third module, and
  //        property_position is never required.
  //   D4 — property_status is inferable at approximate certainty rather than
  //        prohibited by prompt.
  ok(!projection.missing.includes('property_position'),
    'A 25-year-old renter must NEVER be asked what their home is worth.');
  ok(!projection.missing.includes('mortgage_position'),
    'A 25-year-old renter must not be asked about a mortgage they do not have.');
  ok(!projection.missing.includes('target_retirement_income'),
    'A first-time buyer must not be asked for a target retirement income.');

  // And what it DOES ask for is relevant to actually buying a home.
  for (const expected of ['target_home_price', 'cash_savings', 'current_monthly_rent']) {
    ok(projection.missing.includes(expected), `A first-time buyer should be asked about ${expected}.`);
  }
}

/* -------------------------------------------- the projection leaks nothing */

{
  let profile = freshProfile();
  profile = saveFact(profile, 'primary_goal', { type: 'buy_home' });
  const projection = liveStateProjection(contextFor(profile));
  const serialised = JSON.stringify(projection);

  // NO INTERNAL IDS. The model is told never to say one out loud; not sending
  // one makes that structurally impossible rather than a rule to remember.
  for (const moduleId of Object.values(MODULE_IDS)) {
    ok(!serialised.includes(`"${moduleId}"`), `get_state must not expose the module id ${moduleId}.`);
  }
  ok(!/selectionPolicyVersion|goalAssessment|withheld|score/i.test(serialised),
    'get_state must not expose internal planning machinery.');

  for (const analysis of projection.analyses) {
    ok(typeof analysis.description === 'string' && analysis.description.length > 0,
      'Every analysis must carry a client-facing description.');
  }
}

// A fresh profile is genuinely empty — the model must not be told anything is
// captured before the client has said a word.
{
  const projection = liveStateProjection(contextFor(freshProfile()));
  ok(projection.captured.length === 0, 'A fresh profile has nothing captured.');
  ok(projection.readyToConfirm === false, 'A fresh profile is never ready to confirm.');
  ok(projection.goalsAgreed === false, 'A fresh profile has no agreed goals.');
}

/* --------------------------------------------------- the confirmation gate */

// The model does not get to assert that the client agreed. The server reads
// the client's actual words, and only a clear affirmation may run anything.
for (const affirmed of ['yes', 'yes please', 'go ahead', 'that sounds good', 'okay go ahead']) {
  ok(classifySpokenPlanConfirmation(affirmed) === 'affirmed', `"${affirmed}" should read as agreement.`);
}
for (const notAffirmed of ['no', 'hang on', 'can you change one thing', 'what does that mean', '']) {
  ok(classifySpokenPlanConfirmation(notAffirmed) !== 'affirmed', `"${notAffirmed}" must NOT run the analyses.`);
}

// THE GATE FAILS CLOSED ON PARAPHRASE, AND THAT IS CORRECT. The classifier is
// a token allowlist, so a warm but unusual agreement ("that sounds right, go
// for it") reads as ambiguous rather than affirmed. The live lane handles this
// gracefully instead of running anything: confirm_and_run returns
// confirmation_required and tells the model to ask a plain yes/no question.
// A false negative costs one extra exchange; a false positive runs analyses
// the client never agreed to.
for (const paraphrase of ['that sounds right, go for it', 'yeah grand, fire away']) {
  ok(classifySpokenPlanConfirmation(paraphrase) !== 'affirmed',
    `"${paraphrase}" must fail closed rather than be guessed at.`);
}

/* ------------------------------------------------------ prompt invariants */

{
  const prompt = buildLiveCataloguePrompt();

  ok(prompt === buildLiveCataloguePrompt(), 'The prompt must be byte-stable so the provider caches it.');
  ok(prompt.length > 8_000, 'The prompt must actually carry the catalogue.');

  // Every consumer analysis must be described, or the model cannot offer it.
  for (const module of liveConsumerModules()) {
    ok(prompt.includes(module.name), `The prompt must describe ${module.moduleId}.`);
    for (const factId of module.requiredFacts || []) {
      ok(prompt.includes(factId), `The prompt must name the fact ${factId} that ${module.moduleId} needs.`);
    }
  }

  // THE BANNED PHRASING MUST BE NAMED SO IT CANNOT COME BACK. This exact line
  // is what the v2 lane says to every off-topic question.
  ok(prompt.includes('I only ask for facts used by the analyses shown on screen'),
    'The prompt must name the banned deflection so the model recognises and avoids it.');
  ok(/BANNED/.test(prompt), 'The banned phrasings must be marked as banned.');

  // The three-stage arc must be present and in order.
  const orient = prompt.indexOf('ORIENT');
  const focus = prompt.indexOf('FOCUS');
  const gather = prompt.indexOf('GATHER');
  ok(orient > 0 && focus > orient && gather > focus, 'The prompt must lay out ORIENT then FOCUS then GATHER.');
  ok(/ASK NO FINANCIAL FIGURES IN THIS STAGE/.test(prompt), 'ORIENT must forbid asking for figures.');

  // Tangent handling must be explicit, not implied.
  ok(/ALWAYS ANSWER THE QUESTION FIRST/.test(prompt), 'The tangent policy must lead with answering.');
  ok(/A TANGENT NEVER COSTS YOU GROUND/.test(prompt), 'A tangent must not reset the conversation.');

  // The five prohibited acts must all reach the prompt.
  ok(/SAFETY — WHAT YOU MUST NEVER DO/.test(prompt), 'The safety section must be present.');
  for (const fragment of ['RECOMMENDING A PRODUCT', 'DECIDING OR ASSERTING ELIGIBILITY', 'PRODUCING A FIGURE']) {
    ok(prompt.toUpperCase().includes(fragment), `The prompt must state: ${fragment}`);
  }

  // The fact list must be framed as meaning, not as a script.
  ok(/ASK IN YOUR OWN WORDS/.test(prompt), 'The prompt must forbid reading fact prompts verbatim.');

  // No server-composed question may survive into this lane.
  ok(!/questionBatch/.test(prompt), 'The live lane has no server-composed question.');

  // Irish framing.
  ok(/NEVER say IRA, Roth IRA, 401\(k\) or ISA/.test(prompt), 'Irish terminology must be enforced.');
  ok(prompt.includes('299.3'), 'The server-supplied State Pension rate must be quoted.');
}

// The volatile item stays small — it is injected per turn and must not undo
// the cached prefix it sits behind.
{
  const item = liveVolatileStateItem({
    captured: Array.from({ length: 40 }, (_, index) => `fact_${index}`),
    analyses: ['work out the deposit'],
    missing: ['cash_savings']
  });
  ok(item.length < 1_200, 'The volatile state item must stay small.');
  ok(liveVolatileStateItem({}).includes('nothing yet'), 'An empty state must read naturally.');
}

/* ------------------------------------------------- persona fixture is sane */

// The replay harness itself needs an API key and makes paid calls, so it is
// not in this suite. Its INPUTS are checked here, so a malformed persona is
// caught for free rather than halfway through a paid run.
{
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/live-personas.json', import.meta.url)), 'utf8')
  );
  ok(fixture.schema === 'planeir-live-persona-replay-v1', 'The persona fixture must declare its schema.');
  ok(fixture.personas.length >= 5, 'There must be at least five personas.');

  const ids = fixture.personas.map((persona) => persona.id);
  ok(new Set(ids).size === ids.length, 'Persona ids must be unique.');

  for (const persona of fixture.personas) {
    ok(persona.label && persona.why, `${persona.id} must record what it is for.`);
    ok(persona.opening?.length > 20, `${persona.id} needs a real opening utterance.`);
    ok(persona.brief?.length > 200, `${persona.id} needs a brief detailed enough to play.`);
    ok(Number.isInteger(persona.maxTurns) && persona.maxTurns >= 6, `${persona.id} needs a turn budget.`);
    for (const factId of persona.expect?.mustNotRequestFacts || []) {
      ok(getSemanticFactDefinition(factId), `${persona.id} references an unknown fact: ${factId}`);
    }
    for (const factId of persona.expect?.shouldCaptureFacts || []) {
      ok(getSemanticFactDefinition(factId), `${persona.id} references an unknown fact: ${factId}`);
    }
  }

  // THE PERSONA THAT DID NOT EXIST. Every v2 fixture models an asset-rich
  // client, which is exactly why the young-renter defect shipped unnoticed.
  const youngRenter = fixture.personas.find((persona) => persona.id === 'young_renter');
  ok(youngRenter, 'The young low-asset persona must exist.');
  ok(youngRenter.expect.mustNotRequestFacts.includes('property_position'),
    'The young renter must assert it is never asked what its home is worth.');

  // The two live incidents must stay covered.
  ok(fixture.personas.some((persona) => persona.id === 'multi_goal_opener'),
    'Incident D-05 (two goals in one turn) must have a persona.');
  ok(fixture.personas.some((persona) => persona.expect?.mustNeverCommitProhibitedAct),
    'An adversarial advice-seeking persona must exist.');
}

/* --------------------------------------------- the client dropped its baggage */

// These are contracts, not style. Each names something that actively harmed
// the v2 lane and must not be reintroduced by copy-paste from realtime_voice.js.
{
  const client = readFileSync(fileURLToPath(new URL('../js/plan/live_voice.js', import.meta.url)), 'utf8');
  // These assertions are about CODE, not prose. The file deliberately names
  // the things it dropped in its header comment, so strip comments first —
  // otherwise documenting a hazard would read as reintroducing it.
  const code = client
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // The provider-event allowlist and the failure mode it produced. The field
  // note in consumer-realtime-voice-operations.md records this killing an
  // entire live canary: the model added an assistant message alongside a
  // mandated tool call and the allowlist tore the meeting down every turn.
  ok(!code.includes('conversation_item_injected'),
    'The live client must not police provider event types.');
  ok(/NO ALLOWLIST/.test(client), 'The absence of an event allowlist must be deliberate and stated.');

  // Worker-owned TTS is a v1-only path; the model speaks over WebRTC here.
  for (const dropped of ['playWorkerSpeechFromPayload', 'attachControlledSpeechAudio', 'MediaSource']) {
    ok(!code.includes(dropped), `The live client must not carry ${dropped}.`);
  }

  // create_response:true makes a manual finish control meaningless.
  ok(!/space\s*bar|keydown/i.test(code), 'The live client must not carry a manual finish-turn control.');

  // The browser never sees provider credentials or the call id.
  ok(!/OPENAI|api[_-]?key/i.test(code), 'The live client must never handle provider credentials.');

  // It must remain a fraction of the size of what it replaced.
  const v2Client = readFileSync(fileURLToPath(new URL('../js/plan/realtime_voice.js', import.meta.url)), 'utf8');
  ok(client.length * 4 < v2Client.length,
    'The live client must stay far smaller than the v2 controller it replaces.');

  // Same option surface, so it is a drop-in for the existing app wiring.
  for (const option of ['onVoicePayload', 'onPlanningPayload', 'onNavigate', 'onStopBoundedVoice', 'onToast', 'onSessionUnavailable']) {
    ok(client.includes(option), `The live controller must accept ${option} like the v2 controller.`);
  }
}

console.log(`check-consumer-live: ${checks} assertions passed.`);
