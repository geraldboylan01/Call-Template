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

assert.equal(resolveConversationVersion(bootstrapAnnouncing('live')), 'live');

// THE REGRESSION ITSELF. `live` must not resolve to `v1`.
assert.notEqual(
  resolveConversationVersion(bootstrapAnnouncing('live')),
  'v1',
  'A live deployment must never be verified as v1.'
);

// FAIL CLOSED. No default, no nearest match, no empty-string fallback.
for (const unknown of ['v1', 'v2', 'v3', 'live-2', 'LIVE', 'v1.5', 'liveish', '', null, undefined, 42, {}]) {
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

/* ---------------------------------------- only the live proof plan can exist */

const live = laneProofPlan('live');
assert.deepEqual(Object.keys(LANE_PROOFS), ['live']);
assert.deepEqual([...live.requiredControlPlaneFields], ['liveCallActivated', 'liveSidebandConnected']);

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

// The healthy live shape passes.
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
  /implementations are crossed/
);

assert.throws(() => assertControlPlaneProvesLane(controlPlane(), 'v1'), /No activation proof is defined/);
assert.throws(() => assertControlPlaneProvesLane(controlPlane(), 'v2'), /No activation proof is defined/);
assert.throws(() => assertControlPlaneProvesLane(controlPlane(), 'v3'), /No activation proof is defined/);

/* ------------------------------------- the reported result must match the lane */

const proofResult = (overrides = {}) => {
  const plan = laneProofPlan('live');
  return {
    conversationVersion: 'live',
    promptVersion: plan.promptVersion,
    toolsetVersion: plan.toolsetVersion,
    launcherVisible: true,
    companionStartWired: true,
    audibleGreetingObserved: true,
    clientTurnObserved: false,
    controlledSpeechObserved: false,
    directProviderAudioAttached: true,
    webRtcConnected: true,
    sidebandConnected: true,
    readOnlyToolSucceeded: false,
    liveLaneActivated: true,
    liveTransportConnected: true,
    liveResponseCompleted: false,
    liveToolSucceeded: false,
    providerHangupConfirmed: true,
    ...overrides
  };
};

assertLaneProofResult(proofResult());

// A live result missing its activation marker means the live branch never ran.
assert.throws(
  () => assertLaneProofResult(proofResult({ liveLaneActivated: false })),
  /live activation marker is required/i
);
// A live result that never proved its transport.
assert.throws(
  () => assertLaneProofResult(proofResult({ liveTransportConnected: false })),
  /live transport marker is required/i
);
assert.throws(
  () => assertLaneProofResult(proofResult({ audibleGreetingObserved: false })),
  /no transcribed, non-silent opening greeting/i,
  'A paid silent-microphone call may not certify a lane that never opened the conversation.'
);
// A greeting that ANSWERED the client proves the opposite of an autonomous
// opening, and an observation that never left the page proves nothing at all.
assert.throws(
  () => assertLaneProofResult(proofResult({ clientTurnObserved: true })),
  /greeting may have been a REPLY/,
  'A client turn during a silent-microphone proof may not certify an autonomous opening.'
);
assert.throws(
  () => assertLaneProofResult(proofResult({ clientTurnObserved: undefined })),
  /never propagated/,
  'An unreported observation must fail rather than pass by default.'
);
// A live result carrying v1 evidence.
assert.throws(
  () => assertLaneProofResult(proofResult({ readOnlyToolSucceeded: true })),
  /archived controlled-lane tool/
);
assert.throws(
  () => assertLaneProofResult(proofResult({ controlledSpeechObserved: true })),
  /archived Worker-composed speech/
);
assert.throws(
  () => assertLaneProofResult(proofResult({ sidebandConnected: false })),
  /sideband was not proven/
);
// An unknown lane cannot produce a certifiable result at all.
assert.throws(() => assertLaneProofResult(proofResult({ conversationVersion: 'v3' })), /No activation proof is defined/);

/* ------------------------------------------------- the pinned live identities */

assert.equal(live.promptVersion, 'planeir-live-conversation-v12');
assert.equal(live.toolsetVersion, 'planeir-live-tools-v1');
// Pinned against the modules that define them, so a prompt or toolset bump
// cannot leave the activation proof verifying a version nothing runs.
assert.equal(live.promptVersion, LIVE_PROMPT_VERSION);
assert.equal(live.toolsetVersion, LIVE_TOOLSET_VERSION);
// A live meeting recorded under the wrong prompt or tool surface is not a live
// meeting, whatever its control plane says.
assert.throws(
  () => assertLaneProofResult(proofResult({ promptVersion: 'consumer-realtime-orchestrator-v9' })),
  /did not run the planeir-live-conversation-v12 prompt/
);
assert.throws(
  () => assertLaneProofResult(proofResult({ toolsetVersion: 'consumer-realtime-tools-v7' })),
  /did not run the planeir-live-tools-v1 tool surface/
);
assert.throws(
  () => assertLaneProofResult(proofResult({ promptVersion: '' })),
  /did not run the planeir-live-conversation-v12 prompt/
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
  assert.doesNotMatch(proofSource, /expectsControlledSpeech|controlledSpeechPromise|x-realtime-speech-id/);
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
  assert.match(bridgeSource, /proof\.conversationVersion, 'live'/, 'The bridge must assert the live lane on its own terms.');
  assert.match(bridgeSource, /proof\.liveLaneActivated/);
  assert.match(bridgeSource, /planeir-live-conversation-v12/);
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
    'The live lane must play the model through the companion audio element.'
  );
  assert.match(liveClientSource, /output_audio_buffer\.started/);
  assert.match(liveClientSource, /output_audio_buffer\.stopped/);
  assert.doesNotMatch(
    liveClientSource.slice(
      liveClientSource.indexOf("if (type === 'response.created')"),
      liveClientSource.indexOf("if (type === 'response.function_call_arguments.done')")
    ),
    /setPhase\('assistant_speaking'/,
    'Generation start must not claim that remote audio is already playing.'
  );
}

/* ------ the tool dispatcher must not review a turn mid-chain --------------- */

// A save whose evidence waited on ASR reports back long after its own
// response.done, and the dispatcher schedules reconciliation from there. Left
// ungated it reviews the turn while the chain it just extended is still
// writing — and deduplication by turn id means the later writes never earn
// another look. Unit-testing this path needs the database, so the gate itself
// is pinned here.
{
  const sessionSource = source('worker/src/consumer/live/live_session.js');
  const scheduler = sessionSource.slice(
    sessionSource.indexOf('maybeScheduleReconciliation(response, forcedTrigger = null) {')
  );
  assert.match(scheduler.slice(0, 800), /if \(this\.awaitsContinuationChain\(response\)\) return;/,
    'The settlement invariant must live INSIDE the scheduler. Repeated at its '
    + 'callers it is one forgotten call away from reviewing a turn mid-chain, '
    + 'and one caller had already forgotten it.');
  // Callers must not re-implement it; a local copy drifts from the real rule.
  const callerGuards = [...sessionSource.matchAll(/!this\.awaitsContinuationChain\(/g)];
  assert.equal(callerGuards.length, 0,
    'No caller should re-check settlement; the scheduler owns that invariant.');
}

/* ------------- the paid opening proof must actually be run in silence ------ */

// This proof cannot run in CI — it needs a deployment and spends money. So the
// property that makes it meaningful is asserted on its SOURCE instead, because
// a proof that quietly stops being silent still passes while proving nothing.
{
  const proofSource = source('scripts/run-consumer-realtime-infrastructure-proof.mjs');
  assert.match(proofSource, /--use-file-for-fake-audio-capture=/,
    'Chromium\'s fake device emits a tone; without an explicit capture file the '
    + '"silent microphone" is a 400 Hz beep that can trip VAD.');
  assert.match(proofSource, /function writeSilentCaptureFile/,
    'The proof must generate its own silence rather than trust a checked-in asset.');
  assert.match(proofSource, /clientTurnObserved/,
    'The proof must record whether any client turn was observed at all.');
  assert.doesNotMatch(proofSource, /firstAssistant|firstUser/,
    'Transcript entries are appended when ASR RETURNS, not when the client '
    + 'spoke, so ordering them cannot answer who went first. Presence of any '
    + 'client turn is the sound test under a silent microphone.');
  assert.match(proofSource, /assert\.equal\(result\.clientTurnObserved, false/,
    'The causality guard must require an explicit false. `notEqual(..., true)` '
    + 'passes on undefined, so an observation that is never propagated out of '
    + 'the page reads as proof of silence.');
  assert.match(proofSource, /clientTurnObserved,\n/,
    'The observation must be carried into the proof result, not just recorded '
    + 'in the page where the assertion cannot see it.');
  assert.doesNotMatch(proofSource, /clientTurnObserved = greetingProof\.[A-Za-z]+ === true/,
    'Coercing the observation with `=== true` turns a field the observer never '
    + 'set into false, which is how missing evidence passes an exact-false gate.');
  assert.match(proofSource, /settled === true/,
    'The proof must read the page state after its post-greeting grace, or a '
    + 'client turn racing the greeting is missed by construction.');
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
    setAttribute(name, value) {
      if (name === 'data-realtime-phase') this.dataset.realtimePhase = String(value);
    },
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
  let remoteDescriptionGate = null;
  let markRemoteDescriptionStarted = () => {};
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
        markRemoteDescriptionStarted();
        if (remoteDescriptionGate) await remoteDescriptionGate;
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
  const failures = [];
  const controller = new LiveVoiceController({
    root,
    onToast: (message) => toasts.push(message),
    onFailure: (failure) => failures.push(failure)
  });
  const syncedOrbPhases = [];
  controller.orb = {
    phase: 'off',
    syncPhase() { syncedOrbPhases.push(shell.dataset.realtimePhase); },
    attachMicStream() {},
    start() {},
    stop() {}
  };

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
  assert.equal(failures.length, 1, 'The refusal must open the explicit live-call failure page.');
  assert.equal(failures[0].reason, 'no-session');
  assert.equal(toasts.length, 0, 'A call failure must not be reduced to a transient toast.');
  assert.equal(controller.active, false);

  // A SERVER-CONFIRMED SESSION: the lane starts, which run #295 could not do.
  journeyState.session = { id: 'cs_stubsession000000000001', status: 'active' };
  assert.deepEqual(
    controller.readContext(),
    { sessionId: 'cs_stubsession000000000001' },
    'The live controller must read the session id the app actually holds.'
  );
  let releaseRemoteDescription;
  remoteDescriptionGate = new Promise((resolve) => { releaseRemoteDescription = resolve; });
  const remoteDescriptionStarted = new Promise((resolve) => { markRemoteDescriptionStarted = resolve; });
  const starting = controller.start();
  await remoteDescriptionStarted;

  // The Worker may request the opening response before the async browser
  // start() continuation resumes after setRemoteDescription(). Those events
  // own the visible phase; SDP completion must not rewind an audible greeting
  // to listening.
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.created',
    response: { id: 'response_live_opening_001' }
  }));
  assert.equal(controller.phase, 'thinking');
  assert.equal(syncedOrbPhases.at(-1), 'thinking');
  controller.handleProviderEvent(JSON.stringify({ type: 'output_audio_buffer.started' }));
  assert.equal(controller.phase, 'assistant_speaking');
  assert.equal(syncedOrbPhases.at(-1), 'assistant_speaking');
  releaseRemoteDescription();
  await starting;
  remoteDescriptionGate = null;
  markRemoteDescriptionStarted = () => {};
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

  // Provider output-buffer events are the playback clock. Generation may
  // finish while buffered WebRTC audio is still audible, so response.done
  // cannot invite the client to speak until output_audio_buffer.stopped.
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.done',
    response: { id: 'response_live_opening_001', status: 'completed' }
  }));
  assert.equal(
    controller.phase,
    'assistant_speaking',
    'Generation completion must not end the speaking phase while provider playback is active.'
  );
  controller.handleProviderEvent(JSON.stringify({ type: 'output_audio_buffer.stopped' }));
  assert.equal(controller.phase, 'listening');
  assert.equal(syncedOrbPhases.at(-1), 'listening');

  // Barge-in clears, rather than naturally stops, the provider buffer. That
  // official event must release playback ownership without overwriting the
  // user-speaking phase or leaking a stale active flag into the next reply.
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.created',
    response: { id: 'response_live_interrupted_002' }
  }));
  controller.handleProviderEvent(JSON.stringify({ type: 'output_audio_buffer.started' }));
  controller.handleProviderEvent(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  controller.handleProviderEvent(JSON.stringify({ type: 'output_audio_buffer.cleared' }));
  assert.equal(controller.assistantPlaybackActive, false);
  assert.equal(controller.phase, 'user_speaking');
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.done',
    response: { id: 'response_live_interrupted_002', status: 'cancelled' }
  }));
  assert.equal(controller.phase, 'user_speaking');

  controller.handleProviderEvent(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
  assert.equal(controller.phase, 'thinking', 'A finished client utterance must expose the thinking phase.');
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.created',
    response: { id: 'response_live_no_audio_003' }
  }));
  assert.equal(controller.phase, 'thinking', 'Response generation is thinking, not speaking.');
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.done',
    response: { id: 'response_live_no_audio_003', status: 'completed', output: [] }
  }));
  assert.equal(
    controller.phase,
    'listening',
    'response.done remains the no-audio compatibility fallback.'
  );

  // A function call may finish and its continuation may be created while
  // audio from the parent response is still draining. Neither event may
  // downgrade an audibly-speaking orb; once that parent buffer stops, the
  // still-generating continuation becomes thinking until its own audio starts.
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.created',
    response: { id: 'response_live_tool_004' }
  }));
  controller.handleProviderEvent(JSON.stringify({ type: 'output_audio_buffer.started' }));
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.function_call_arguments.done',
    response_id: 'response_live_tool_004',
    call_id: 'call_live_tool_004'
  }));
  assert.equal(controller.phase, 'assistant_speaking');
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.done',
    response: {
      id: 'response_live_tool_004',
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'call_live_tool_004' }]
    }
  }));
  assert.equal(controller.phase, 'assistant_speaking');
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.created',
    response: { id: 'response_live_continuation_005' }
  }));
  assert.equal(controller.phase, 'assistant_speaking');
  controller.handleProviderEvent(JSON.stringify({ type: 'output_audio_buffer.stopped' }));
  assert.equal(controller.phase, 'thinking');
  controller.handleProviderEvent(JSON.stringify({ type: 'output_audio_buffer.started' }));
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.done',
    response: { id: 'response_live_continuation_005', status: 'completed' }
  }));
  assert.equal(controller.phase, 'assistant_speaking');
  controller.handleProviderEvent(JSON.stringify({ type: 'output_audio_buffer.stopped' }));
  assert.equal(controller.phase, 'listening');

  // A LOST CONTINUATION MUST NOT STRAND THE ORB. A function call ends its
  // provider response, so nothing further arrives until the Worker sends
  // response.create. If that request never lands, no provider event will ever
  // clear the wait, and the orb thinks until the client gives up and speaks.
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.created',
    response: { id: 'response_live_lost_006' }
  }));
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.function_call_arguments.done',
    response_id: 'response_live_lost_006',
    call_id: 'call_live_lost_006'
  }));
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.done',
    response: {
      id: 'response_live_lost_006',
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'call_live_lost_006' }]
    }
  }));
  assert.equal(controller.phase, 'thinking',
    'A tool-only response must keep waiting while the Worker requests its continuation.');
  assert.ok(controller.continuationStallTimer,
    'That wait must be bounded rather than open-ended.');
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  controller.continuationStallTimer._onTimeout?.() ?? (() => {
    // Node exposes the callback on the Timeout object; fall back to firing the
    // recovery directly if that internal ever changes.
    controller.responseNeedsContinuation = false;
    controller.settleAssistantTurn();
  })();
  assert.equal(controller.phase, 'listening',
    'A continuation that never arrives must release the turn back to the client.');
  assert.equal(controller.responseNeedsContinuation, false);

  // The ordinary case must not be cut short: a continuation that does arrive
  // cancels the stall net rather than racing it.
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.created',
    response: { id: 'response_live_tool_007' }
  }));
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.function_call_arguments.done',
    response_id: 'response_live_tool_007',
    call_id: 'call_live_tool_007'
  }));
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.done',
    response: {
      id: 'response_live_tool_007',
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'call_live_tool_007' }]
    }
  }));
  assert.ok(controller.continuationStallTimer);
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.created',
    response: { id: 'response_live_continuation_008' }
  }));
  assert.equal(controller.continuationStallTimer, null,
    'An arriving continuation must disarm the stall net.');
  assert.equal(controller.phase, 'thinking');
  controller.handleProviderEvent(JSON.stringify({ type: 'output_audio_buffer.started' }));
  controller.handleProviderEvent(JSON.stringify({
    type: 'response.done',
    response: { id: 'response_live_continuation_008', status: 'completed' }
  }));
  controller.handleProviderEvent(JSON.stringify({ type: 'output_audio_buffer.stopped' }));
  assert.equal(controller.phase, 'listening');

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
