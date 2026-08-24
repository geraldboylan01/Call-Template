/**
 * THE ACTIVATION PROOF MUST VERIFY THE LANE THAT IS ACTUALLY RUNNING.
 *
 * Deploy Worker run #295 activated the live canary, passed the deployment-mode
 * check, and then failed its paid infrastructure proof with
 *
 *     page.waitForResponse: Timeout 45000ms exceeded (requests: none)
 *
 * because the proof read the announced conversation version through
 *
 *     payload?.realtimeVoice?.conversationVersion === 'v2' ? 'v2' : 'v1'
 *
 * A deployment announcing `live` was therefore verified as `v1`, and the proof
 * spent its whole budget waiting for a `POST .../speech` that only the v1 lane
 * has ever produced. The rollback then took Realtime back off.
 *
 * Two defects, one shape: an unknown value silently became a known one. These
 * tests pin the corrected behaviour — each lane proved by its own evidence,
 * and anything unrecognised refusing to certify at all.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  LANE_PROOFS,
  assertControlPlaneProvesLane,
  assertLaneProofResult,
  laneProofPlan,
  resolveConversationVersion
} from './run-consumer-realtime-infrastructure-proof.mjs';
import { LIVE_PROMPT_VERSION } from '../worker/src/consumer/live/catalogue_prompt.js';
import { LIVE_TOOL_DEFINITIONS, LIVE_TOOLSET_VERSION } from '../worker/src/consumer/live/live_tools.js';
import { LIVE_TOOL_NAMES } from '../worker/src/consumer/realtime_repository.js';

const source = (relativePath) => readFileSync(
  fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
  'utf8'
);

const bootstrapAnnouncing = (conversationVersion) => ({
  flags: { consumerRealtimeVoiceEnabled: true },
  realtimeVoice: { enabled: true, conversationVersion }
});

/* ------------------------------------------------ the lane is resolved, not guessed */

assert.equal(resolveConversationVersion(bootstrapAnnouncing('v1')), 'v1');
assert.equal(resolveConversationVersion(bootstrapAnnouncing('v2')), 'v2');
assert.equal(resolveConversationVersion(bootstrapAnnouncing('live')), 'live');

// THE REGRESSION ITSELF. `live` must not resolve to `v1`.
assert.notEqual(
  resolveConversationVersion(bootstrapAnnouncing('live')),
  'v1',
  'A live deployment must never be verified as v1.'
);

// FAIL CLOSED. No default, no nearest match, no empty-string fallback.
for (const unknown of ['v3', 'live-2', 'LIVE', 'v1.5', 'liveish', '', null, undefined, 42, {}]) {
  assert.throws(
    () => resolveConversationVersion({
      flags: { consumerRealtimeVoiceEnabled: true },
      realtimeVoice: { conversationVersion: unknown }
    }),
    /cannot verify/,
    `An unrecognised conversation version (${JSON.stringify(unknown)}) must stop the activation.`
  );
}
// A bootstrap with no realtimeVoice block at all is just as unverifiable.
assert.throws(() => resolveConversationVersion({}), /cannot verify/);
assert.throws(() => resolveConversationVersion(null), /cannot verify/);

// Surrounding whitespace is trimmed to a KNOWN lane — deliberate tolerance
// for a stray variable value, and the only tolerance there is. It never
// invents a lane: everything above still throws.
assert.equal(resolveConversationVersion(bootstrapAnnouncing(' live ')), 'live');

assert.throws(() => laneProofPlan('v3'), /No activation proof is defined/);
assert.throws(() => laneProofPlan(''), /No activation proof is defined/);

/* ------------------------------------- each lane waits for its own transport */

const v1 = laneProofPlan('v1');
const v2 = laneProofPlan('v2');
const live = laneProofPlan('live');

// v1 is the ONLY lane that waits for Worker-composed speech. This is the exact
// wait that hung run #295.
assert.equal(v1.expectsControlledSpeech, true, 'v1 must still prove Worker-composed speech.');
assert.equal(v2.expectsControlledSpeech, false);
assert.equal(
  live.expectsControlledSpeech,
  false,
  'The live lane must never wait for v1-only /speech behaviour.'
);

// v1 plays a Worker-generated MP3; v2 and live play the provider's own track.
assert.equal(v1.expectsDirectProviderAudio, false);
assert.equal(v2.expectsDirectProviderAudio, true);
assert.equal(live.expectsDirectProviderAudio, true);

// Only the live lane publishes and proves a peer-connection state, because it
// is the only lane whose model speech cannot be forced.
assert.equal(live.expectsLiveTransportState, true, 'The live lane must prove its WebRTC transport connected.');
assert.equal(v1.expectsLiveTransportState, false);
assert.equal(v2.expectsLiveTransportState, false);

// The mic badge and transcript toggle belong to the v2 controller's state
// machine; live_voice.js binds neither.
assert.equal(live.expectsMicBadge, false);
assert.equal(live.transcriptToggleIsWired, false);
assert.equal(v1.transcriptToggleIsWired, true);
assert.equal(v2.transcriptToggleIsWired, true);

// The live lane cannot promise model speech: nothing sends `response.create`.
assert.equal(v1.assistantSpeechIsProof, true);
assert.equal(v2.assistantSpeechIsProof, true);
assert.equal(
  live.assistantSpeechIsProof,
  false,
  'The live lane must not gate on speech it never forces.'
);

/* ------------------------------------------ three distinct control-plane gates */

const controlPlaneFieldSets = Object.values(LANE_PROOFS)
  .map((plan) => [...plan.requiredControlPlaneFields].sort().join('+'));
assert.equal(
  new Set(controlPlaneFieldSets).size,
  controlPlaneFieldSets.length,
  'Each lane must be proven by a distinct set of control-plane milestones.'
);
assert.deepEqual([...live.requiredControlPlaneFields], ['liveCallActivated', 'liveSidebandConnected']);
assert.deepEqual([...v1.requiredControlPlaneFields], ['sidebandConnected', 'readOnlyToolSucceeded']);
assert.deepEqual([...v2.requiredControlPlaneFields], ['sidebandConnected', 'initialWelcomeSucceeded']);

// The live milestones share no field with either controlled lane, so a live
// meeting can never be waved through by v1/v2 evidence and vice versa.
for (const controlled of [v1, v2]) {
  for (const field of live.requiredControlPlaneFields) {
    assert.equal(
      controlled.requiredControlPlaneFields.includes(field),
      false,
      `${field} must not be shared with the ${controlled.lane} lane.`
    );
  }
}

/* -------------------------------- a lane that did not start cannot be certified */

const controlPlane = (overrides = {}) => ({
  sidebandConnected: false,
  readOnlyToolSucceeded: false,
  initialWelcomeSucceeded: false,
  liveCallActivated: false,
  liveSidebandConnected: false,
  liveResponseCompleted: false,
  liveToolSucceeded: false,
  ...overrides
});

// The healthy shapes pass.
assertControlPlaneProvesLane(
  controlPlane({ sidebandConnected: true, readOnlyToolSucceeded: true }),
  'v1'
);
assertControlPlaneProvesLane(
  controlPlane({ sidebandConnected: true, initialWelcomeSucceeded: true }),
  'v2'
);
assertControlPlaneProvesLane(
  controlPlane({ liveCallActivated: true, liveSidebandConnected: true }),
  'live'
);

// THE LIVE LANE DID NOT START. This is the control plane a live meeting leaves
// behind when nothing activated: every live milestone false.
assert.throws(
  () => assertControlPlaneProvesLane(controlPlane(), 'live'),
  /never activated its meeting/,
  'A live meeting that never activated must fail the proof.'
);
// Activated, but the Worker's sideband to the provider never came up.
assert.throws(
  () => assertControlPlaneProvesLane(controlPlane({ liveCallActivated: true }), 'live'),
  /live provider sideband was not proven/
);

// THE FALLBACK THAT CAUSED RUN #295. A live meeting must not be certified by
// the v1 lane's evidence, no matter how complete that evidence looks.
assert.throws(
  () => assertControlPlaneProvesLane(
    controlPlane({ sidebandConnected: true, readOnlyToolSucceeded: true, initialWelcomeSucceeded: true }),
    'live'
  ),
  /never activated its meeting/,
  'v1/v2 evidence must not satisfy the live lane.'
);
// ...and a live meeting that somehow ran the v2 read-only tool is a crossed
// lane, not a stronger proof.
assert.throws(
  () => assertControlPlaneProvesLane(
    controlPlane({ liveCallActivated: true, liveSidebandConnected: true, readOnlyToolSucceeded: true }),
    'live'
  ),
  /lanes are crossed/
);

// The controlled lanes are equally unable to borrow live evidence.
assert.throws(
  () => assertControlPlaneProvesLane(
    controlPlane({ liveCallActivated: true, liveSidebandConnected: true }),
    'v1'
  ),
  /sideband was not proven/
);
assert.throws(
  () => assertControlPlaneProvesLane(
    controlPlane({ sidebandConnected: true, readOnlyToolSucceeded: true }),
    'v2'
  ),
  /Marin welcome did not complete/
);
assert.throws(() => assertControlPlaneProvesLane(controlPlane(), 'v3'), /No activation proof is defined/);

/* ------------------------------------- the reported result must match the lane */

const proofResult = (conversationVersion, overrides = {}) => {
  const plan = laneProofPlan(conversationVersion);
  return {
    conversationVersion,
    promptVersion: plan.promptVersion,
    toolsetVersion: plan.toolsetVersion,
    launcherVisible: true,
    companionStartWired: true,
    audibleGreetingObserved: plan.assistantSpeechIsProof,
    controlledSpeechObserved: plan.expectsControlledSpeech,
    directProviderAudioAttached: plan.expectsDirectProviderAudio,
    webRtcConnected: true,
    sidebandConnected: true,
    readOnlyToolSucceeded: conversationVersion === 'v1',
    initialWelcomeSucceeded: conversationVersion === 'v2',
    liveLaneActivated: conversationVersion === 'live',
    liveTransportConnected: conversationVersion === 'live',
    liveResponseCompleted: false,
    liveToolSucceeded: false,
    providerHangupConfirmed: true,
    ...overrides
  };
};

for (const lane of ['v1', 'v2', 'live']) {
  assertLaneProofResult(proofResult(lane));
}

// A live result missing its activation marker means the live branch never ran.
assert.throws(
  () => assertLaneProofResult(proofResult('live', { liveLaneActivated: false })),
  /must be set for exactly the live lane/
);
// A v1 result carrying the live marker means the lane was misreported.
assert.throws(
  () => assertLaneProofResult(proofResult('v1', { liveLaneActivated: true })),
  /must be set for exactly the live lane/
);
// A live result that never proved its transport.
assert.throws(
  () => assertLaneProofResult(proofResult('live', { liveTransportConnected: false })),
  /transport marker must be set for exactly the live lane/
);
// A live result carrying v1 evidence.
assert.throws(
  () => assertLaneProofResult(proofResult('live', { readOnlyToolSucceeded: true })),
  /never be certified by the v1 read-only tool proof/
);
assert.throws(
  () => assertLaneProofResult(proofResult('live', { controlledSpeechObserved: true })),
  /never be certified by v1 Worker-composed speech/
);
// The sideband gate still binds every lane.
for (const lane of ['v1', 'v2', 'live']) {
  assert.throws(
    () => assertLaneProofResult(proofResult(lane, { sidebandConnected: false })),
    /sideband was not proven/,
    `${lane} must fail when the provider sideband is unproven.`
  );
}
// An unknown lane cannot produce a certifiable result at all.
assert.throws(() => assertLaneProofResult(proofResult('v1', { conversationVersion: 'v3' })), /No activation proof is defined/);

/* ------------------------------------------------- the pinned live identities */

assert.equal(live.promptVersion, 'planeir-live-conversation-v9');
assert.equal(live.toolsetVersion, 'planeir-live-tools-v1');
// Pinned against the modules that define them, so a prompt or toolset bump
// cannot leave the activation proof verifying a version nothing runs.
assert.equal(live.promptVersion, LIVE_PROMPT_VERSION);
assert.equal(live.toolsetVersion, LIVE_TOOLSET_VERSION);
// The controlled lanes keep their own pair, and the two pairs stay distinct.
assert.equal(v1.promptVersion, 'consumer-realtime-orchestrator-v9');
assert.equal(v1.toolsetVersion, 'consumer-realtime-tools-v7');
assert.equal(v1.promptVersion, v2.promptVersion, 'The controlled lanes share one prompt identity.');
assert.equal(v1.toolsetVersion, v2.toolsetVersion, 'The controlled lanes share one tool surface.');
assert.notEqual(live.promptVersion, v2.promptVersion);
assert.notEqual(live.toolsetVersion, v2.toolsetVersion);

// A live meeting recorded under the wrong prompt or tool surface is not a live
// meeting, whatever its control plane says.
assert.throws(
  () => assertLaneProofResult(proofResult('live', { promptVersion: 'consumer-realtime-orchestrator-v9' })),
  /did not run the planeir-live-conversation-v9 prompt/
);
assert.throws(
  () => assertLaneProofResult(proofResult('live', { toolsetVersion: 'consumer-realtime-tools-v7' })),
  /did not run the planeir-live-tools-v1 tool surface/
);
assert.throws(
  () => assertLaneProofResult(proofResult('live', { promptVersion: '' })),
  /did not run the planeir-live-conversation-v9 prompt/
);

/* --------------------------------- the live lane's tool surface is its own */

assert.deepEqual(
  [...LIVE_TOOL_NAMES],
  LIVE_TOOL_DEFINITIONS.map((definition) => definition.name),
  'The control-plane query must count exactly the tools this lane defines.'
);
assert.equal(
  LIVE_TOOL_NAMES.includes('get_planning_state'),
  false,
  'get_planning_state is the v2 surface; counting it would let a v2 meeting prove the live lane.'
);
assert.equal(LIVE_TOOL_NAMES.length, 3, 'The live lane has three tools, not the v2 lane\'s seven.');

/* ------------------------------------- the collapse cannot come back by edit */

{
  const proofSource = source('scripts/run-consumer-realtime-infrastructure-proof.mjs');
  // The exact expression that caused this. Any ternary that resolves a
  // conversation version by falling back to a literal lane is the same bug.
  assert.doesNotMatch(
    proofSource,
    /conversationVersion\s*===\s*'v2'\s*\?\s*'v2'\s*:\s*'v1'/,
    'The lane must never be resolved by collapsing unknown versions to v1.'
  );
  assert.match(proofSource, /export function resolveConversationVersion/);
  assert.match(proofSource, /plan\.expectsControlledSpeech/);
  // The lane the call actually ran must be checked against the lane announced.
  assert.match(proofSource, /x-realtime-conversation-version/);

  const repositorySource = source('worker/src/consumer/realtime_repository.js');
  for (const liveEvent of ['live.call.activated', 'live.provider.connected', 'live.response.completed']) {
    assert.match(
      repositorySource,
      new RegExp(liveEvent.replace(/\./g, '\\.')),
      `The control-plane proof must be able to see ${liveEvent}.`
    );
  }

  const bridgeSource = source('scripts/check-consumer-live-advisor-bridge.mjs');
  assert.match(bridgeSource, /proof\.conversationVersion === 'live'/, 'The bridge must assert the live lane on its own terms.');
  assert.match(bridgeSource, /proof\.liveLaneActivated/);
  assert.match(bridgeSource, /planeir-live-conversation-v9/);
  assert.match(bridgeSource, /planeir-live-tools-v1/);

  // The live client has to be startable at all: the session id must come from
  // the store, not from dataset attributes nothing in the app ever sets.
  const liveClientSource = source('js/plan/live_voice.js');
  assert.match(liveClientSource, /getSessionId/, 'The live controller must read the session id the app actually holds.');
  assert.match(liveClientSource, /deleteRealtimeVoiceCall/, 'Ending a live meeting must close its lease.');
  assert.match(liveClientSource, /data-live-transport|liveTransport/, 'The live lane must publish its transport state.');
  assert.match(
    liveClientSource,
    /getElementById\('realtimeVoiceAudio'\)/,
    'Both lanes must play the model through the shared companion audio element.'
  );
}

/* ------------------------------- the live lane has to be able to start at all */

/**
 * WHAT `requests: none` MEANT.
 *
 * Run #295's diagnostic said the browser made no call at all, and the status
 * line still read the markup's unstarted copy. That is `start()` returning at
 * its session guard: `readContext()` looked for `data-session-id` on the
 * companion and `data-consumer-session-id` on the body, and NOTHING IN THE APP
 * HAS EVER SET EITHER. The lane-aware proof above would have reported the
 * failure honestly; it would still have failed, because the lane genuinely
 * could not start.
 *
 * These run the real controller against a stubbed browser. Nothing in the
 * live client was exercised before — it was checked by reading its source —
 * which is why a guard that could never pass survived review.
 */
{
  const storage = new Map();
  const stubElement = () => ({
    dataset: {},
    textContent: '',
    disabled: false,
    listeners: {},
    classes: new Set(),
    classList: {
      toggle(name, force) {
        if (force) this.owner.classes.add(name);
        else this.owner.classes.delete(name);
      }
    },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    setAttribute() {},
    append() {},
    replaceChildren() {},
    scrollTop: 0,
    scrollHeight: 0
  });
  const withClassList = (element) => {
    element.classList.owner = element;
    return element;
  };
  const shell = withClassList(stubElement());
  const stopButton = stubElement();
  const elements = new Map([
    ['[data-live-start]', stubElement()],
    ['[data-live-stop]', stopButton],
    ['[data-live-status]', stubElement()],
    ['[data-live-caption="user"]', stubElement()],
    ['[data-live-caption="assistant"]', stubElement()],
    ['[data-live-transcript]', stubElement()],
    ['.realtime-voice-shell', shell]
  ]);
  const root = withClassList({
    ...stubElement(),
    querySelector: (selector) => elements.get(selector) || null
  });

  const requests = [];
  globalThis.window = {
    location: { hostname: 'localhost', href: 'http://localhost/plan/' },
    isSecureContext: true,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (callback) => callback(),
    crypto: { getRandomValues: (bytes) => bytes.fill(7) },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    RTCPeerConnection: class StubPeerConnection {
      constructor() {
        this.connectionState = 'new';
        this.localDescription = null;
        this.handlers = {};
      }

      addTrack() {}

      addEventListener(type, handler) { this.handlers[type] = handler; }

      createDataChannel() { return { addEventListener() {}, close() {} }; }

      async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' }; }

      async setLocalDescription(description) { this.localDescription = description; }

      async setRemoteDescription() {
        this.connectionState = 'connected';
        this.handlers.connectionstatechange?.();
      }

      close() {}
    }
  };
  const audioElement = { ...stubElement(), srcObject: null, play: async () => {} };
  globalThis.document = {
    hidden: false,
    querySelector: () => null,
    getElementById: (id) => (id === 'realtimeVoiceAudio' ? audioElement : null),
    createElement: () => ({ ...stubElement(), style: {}, play: async () => {} }),
    addEventListener: () => {},
    body: { dataset: {}, classList: { add: () => {}, remove: () => {} }, append: () => {} }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [],
          getAudioTracks: () => []
        })
      }
    }
  });
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    const headers = new Headers(options.headers || {});
    requests.push({ method: options.method || 'GET', pathname: target.pathname });
    if (options.method === 'POST' && target.pathname.endsWith('/voice/realtime/calls')) {
      return new Response('v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n', {
        status: 201,
        headers: {
          'Content-Type': 'application/sdp',
          'X-Realtime-Lease-Id': 'rt_stub_lease_00000000000000000001',
          'X-Realtime-Activation-Id': headers.get('X-Realtime-Activation-Id') || '',
          'X-Realtime-Control-Capability': headers.get('X-Realtime-Control-Capability') || '',
          'X-Realtime-Conversation-Version': 'live'
        }
      });
    }
    return new Response(JSON.stringify({ session: { id: 'cs_stubsession000000000001', status: 'active' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const { LiveVoiceController } = await import('../js/plan/live_voice.js');
  const { state: journeyState } = await import('../js/plan/store.js');
  storage.set('planeir.consumer.credential.v1', 'cs_stubsession000000000001.stub-credential');

  const toasts = [];
  const controller = new LiveVoiceController({ root, onToast: (message) => toasts.push(message) });

  // NO CONFIRMED SESSION: the guard is right to refuse, and refusing must not
  // look like a started meeting.
  journeyState.session = null;
  assert.deepEqual(controller.readContext(), { sessionId: '' });
  await controller.start();
  assert.equal(
    requests.some((entry) => entry.pathname.endsWith('/voice/realtime/calls')),
    false,
    'No provider call may be created without a confirmed session.'
  );
  assert.equal(toasts.length, 1, 'The refusal must tell the client something.');
  assert.equal(controller.active, false);

  // A SERVER-CONFIRMED SESSION: the lane starts, which run #295 could not do.
  journeyState.session = { id: 'cs_stubsession000000000001', status: 'active' };
  assert.deepEqual(
    controller.readContext(),
    { sessionId: 'cs_stubsession000000000001' },
    'The live controller must read the session id the app actually holds.'
  );
  await controller.start();
  assert.equal(
    requests.filter((entry) => (
      entry.method === 'POST' && entry.pathname.endsWith('/voice/realtime/calls')
    )).length,
    1,
    'A confirmed session must produce exactly one provider call.'
  );
  assert.equal(controller.active, true, 'The live meeting must be running after a successful start.');
  assert.equal(controller.leaseId, 'rt_stub_lease_00000000000000000001');
  // The transport state the activation proof waits on.
  assert.equal(
    root.dataset.liveTransport,
    'connected',
    'The live lane must publish the peer connection state the proof reads.'
  );
  // THE SHELL FACE. plan.css hides #realtimeVoiceEndButton under
  // `.realtime-voice-shell:not(.is-live)`, so a live meeting that never sets
  // the class leaves the client — and the activation proof — with no way to
  // end the meeting that is running.
  assert.equal(
    shell.classes.has('is-live'),
    true,
    'A running live meeting must switch the shell to its live face, or End is styled away.'
  );
  assert.equal(stopButton.disabled, false, 'End must be actionable while a live meeting runs.');

  // ENDING THE MEETING MUST TELL THE WORKER. Closing the peer connection is
  // invisible to the server, and an unclosed lease keeps a paid provider call
  // open until its idle alarm.
  requests.length = 0;
  await controller.stop('consumer_closed');
  assert.equal(
    requests.some((entry) => (
      entry.method === 'DELETE'
      && entry.pathname.endsWith('/voice/realtime/calls/rt_stub_lease_00000000000000000001')
    )),
    true,
    'Ending a live meeting must close its lease with the Worker.'
  );
  assert.equal(controller.active, false);
  assert.equal(controller.leaseId, '', 'A settled lease must not be closed twice.');
  assert.equal(
    shell.classes.has('is-live'),
    false,
    'An ended meeting must return the shell to its pre-call face.'
  );

  // Stopping again is a no-op, not a second hang-up.
  requests.length = 0;
  await controller.stop('consumer_closed');
  assert.deepEqual(requests, [], 'A second End press must not reissue the hang-up.');
}

const conversationProbeSource = source('scripts/run-consumer-realtime-conversation-probe.mjs');
assert.doesNotMatch(
  conversationProbeSource,
  /flags\?\.consumerLiveVoiceEnabled/,
  'The paid conversation probe must not wait on a private live-voice flag that the public bootstrap does not expose.'
);
assert.match(
  conversationProbeSource,
  /realtimeVoice\?\.conversationVersion === 'live'/,
  'The paid conversation probe must settle the public bootstrap using the authoritative advertised live lane.'
);
assert.match(
  conversationProbeSource,
  /ASSISTANT_REPLY_SETTLE_MS[\s\S]*replyQuietDeadline/,
  'The paid conversation probe must let a completed assistant reply settle before injecting the next turn.'
);
assert.match(
  conversationProbeSource,
  /shouldReflectTurn\(finalizedClientText\) \? 2 : 1[\s\S]*newAssistant\.length >= expectedAssistantLines/,
  'The paid conversation probe must wait for both the reflection and planner-backed answer on reflected turns.'
);

console.log('Realtime activation proof lane checks passed.');
