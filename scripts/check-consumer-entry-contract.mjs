/**
 * WHAT AN AUTHENTICATED CLIENT MUST REACH ON THE WAY IN, AND WHAT THE
 * PROTECTED DEPLOYMENT MUST PROVE ABOUT IT.
 *
 * WHY THIS EXISTS. Turning the typed lane on changed the entry screen: instead
 * of auto-opening the voice meeting, `/plan/` renders the Speak/Type card and
 * deliberately leaves the voice companion hidden until a door is chosen. The
 * paid deployment proof still waited for the companion, so a correct product
 * failed its own activation and Realtime was rolled back -- the product was
 * fine and the proof was stale.
 *
 * A stale proof is worse than a missing one: it fails good deployments, and it
 * would have passed a deployment that shipped the chooser with the Type door
 * missing, because it never looked. So this holds BOTH halves of the contract:
 * the app must offer both doors, and the deployment proof must require them.
 *
 * FREE. No browser, no provider, no meeting. The entry decision is a pure
 * function and the rest is read off the source.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveMeetingEntry } from './run-consumer-realtime-infrastructure-proof.mjs';

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const VOICE_ONLY = { typedLaneEnabled: false };
const BOTH_LANES = { typedLaneEnabled: true };
const chooser = (...doors) => ({
  shellOpen: false, launcherShown: false, chooserShown: true, laneChoiceDoors: doors
});

/* ------------------------------------------- voice-only: unchanged behaviour */

assert.equal(
  resolveMeetingEntry({ shellOpen: true, launcherShown: false }, VOICE_ONLY).ready,
  true,
  'An auto-opened meeting shell must still prove the entry point on a voice-only deployment.'
);
assert.equal(
  resolveMeetingEntry({ shellOpen: false, launcherShown: true }, VOICE_ONLY).action,
  'open-launcher',
  'A collapsed launcher must still be opened on a voice-only deployment.'
);
const voiceOnlyMissing = resolveMeetingEntry({ shellOpen: false, launcherShown: false }, VOICE_ONLY);
assert.equal(voiceOnlyMissing.ready, false);
assert.match(
  voiceOnlyMissing.reason,
  /Neither the auto-opened meeting shell nor the Talk to Plan/,
  'A voice-only deployment with no entry point must still fail with its original diagnosis.'
);

/* ------------------------------- typed lane on: the chooser is the entry point */

const chosen = resolveMeetingEntry(chooser('speak', 'type'), BOTH_LANES);
assert.equal(chosen.ready, true, 'The Speak/Type card is a valid entry point when the typed lane is on.');
assert.equal(chosen.action, 'choose-speak', 'The paid Realtime proof must take the Speak door explicitly.');

// THE REGRESSION THAT FAILED IN PRODUCTION. The typed lane is on, the product
// correctly renders the chooser and correctly leaves the voice companion
// hidden -- and this must not be read as a broken deployment.
assert.equal(
  resolveMeetingEntry(chooser('speak', 'type'), BOTH_LANES).reason,
  '',
  'A hidden voice companion behind a rendered Speak/Type card is the intended entry, not a failure.'
);

/* ------------------------- and it is stricter than the check it replaces */

for (const [label, doors] of [['Type', ['speak']], ['Speak', ['type']], ['both', []]]) {
  const broken = resolveMeetingEntry(chooser(...doors), BOTH_LANES);
  assert.equal(broken.ready, false, `A chooser missing its ${label} door must not certify a deployment.`);
  assert.equal(broken.terminal, true, `A chooser missing its ${label} door is broken, not still propagating.`);
  assert.match(broken.reason, /missing its/, 'The failure must name the missing door.');
}

// A voice entry point does NOT satisfy a typed-lane deployment. Accepting it
// would let an activation that never rendered the chooser pass by falling back
// to the old screen -- which is exactly the staleness this file exists to stop.
const stale = resolveMeetingEntry({ shellOpen: true, launcherShown: true, chooserShown: false }, BOTH_LANES);
assert.equal(stale.ready, false, 'A typed-lane deployment must render the chooser, not the old voice entry.');
assert.match(stale.reason, /Speak\/Type entry card did not appear/);
assert.notEqual(stale.terminal, true, 'A missing card may still be bootstrap propagation, so it must be retried.');

/* ---------------------------------- the app must actually offer both doors */

const views = source('js/plan/views.js');
assert.match(
  views,
  /speak\.dataset\.lane = 'speak';/,
  'The Speak door must carry a stable lane hook the deployment proof can select.'
);
assert.match(
  views,
  /type\.dataset\.lane = 'type';/,
  'The Type door must carry a stable lane hook.'
);
assert.match(views, /class="?lane-choice-card|'unavailable-card lane-choice-card'/,
  'The chooser must keep the lane-choice-card marker the proof looks for.');

const app = source('js/plan/app.js');
assert.match(
  app,
  /if \(typedAvailable && voiceAvailable\)[\s\S]{0,240}renderLaneChoice\(/,
  'With both lanes available the entry must be the chooser.'
);
assert.match(app, /onSpeak: \(\) => enterMeetingOrFail\(/, 'The Speak door must open the voice lane.');
assert.match(app, /onType: \(\) => enterTypedMeeting\(/, 'The Type door must open the typed lane.');
assert.match(
  app,
  /if \(typedAvailable && !voiceAvailable\) return enterTypedMeeting\(/,
  'A typed-only deployment must still reach a usable meeting rather than a failure page.'
);

/* --------------------- the deployment proof must consult the typed lane flag */

const proof = source('scripts/run-consumer-realtime-infrastructure-proof.mjs');
assert.match(
  proof,
  /typedLaneEnabled = payload\?\.flags\?\.consumerTypedLaneEnabled === true;/,
  'The proof must read the typed lane from the same settled bootstrap sample as the conversation lane.'
);
assert.match(
  proof,
  /resolveMeetingEntry\(entry, \{ typedLaneEnabled \}\)/,
  'The proof must resolve its entry screen against the deployment it is proving.'
);
assert.match(
  proof,
  /\[data-lane="speak"\]'\)\.click\(\)/,
  'The proof must choose Speak by lane, not by button wording.'
);
assert.doesNotMatch(
  proof,
  /if \(entry\.shellOpen \|\| entry\.launcherShown\) break;/,
  'The proof must not go back to assuming a voice-only entry screen.'
);

/* ----------- and a failed activation must roll the typed lane back with it */

const workflow = source('.github/workflows/deploy-worker.yml');
const rollbackList = workflow.slice(
  workflow.indexOf('let bootstrapSource = ['),
  workflow.indexOf('].reduce((source, flag) => replaceTomlString(source, flag, \'false\')')
);
assert.match(
  rollbackList,
  /'CONSUMER_TYPED_LANE_ENABLED'/,
  'The compensating rollback must switch the typed lane off with every other conversation layer, '
  + 'not leave it true and rely on the planner gate to make it inert.'
);
assert.match(
  workflow,
  /must keep the typed conversational lane disabled/,
  'The rollback config must assert the typed lane is off, like every other lane it disables.'
);

console.log('Consumer planning entry-contract checks passed.');
