import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootPath = fileURLToPath(new URL('..', import.meta.url));
const storage = new Map();
const realtimeMicrophonePreferenceKey = 'planeir.consumer.realtime-microphone.v1';

globalThis.window = {
  location: {
    hostname: 'localhost',
    href: 'http://localhost/plan/'
  },
  isSecureContext: true,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: (callback) => callback(),
  sessionStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  },
  MediaRecorder: class TestMediaRecorder {}
};
globalThis.document = {
  hidden: false,
  querySelector: () => null,
  getElementById: () => null,
  addEventListener: () => {},
  body: { classList: { add: () => {}, remove: () => {} } }
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { mediaDevices: { getUserMedia: async () => null } }
});

const {
  ConsumerVoiceController,
  appendTranscriptForReview,
  captureConversationDraft,
  crossedAccessibleCountdownThreshold,
  restoreConversationDraft,
  selectSupportedRecordingMimeType
} = await import('../js/plan/voice.js');
const {
  classifyRealtimeEvent,
  extractRealtimePlanningContext,
  isLikelyIncompleteVoiceCaption,
  normaliseRealtimeCallResponse,
  RealtimeVoiceController
} = await import('../js/plan/realtime_voice.js');
const {
  getAnalysisPlanNonce,
  mergePayload,
  mergeVoicePayload,
  normaliseBootstrap,
  state: journeyState
} = await import('../js/plan/store.js');
const { getAvailableViews } = await import('../js/plan/views.js');

const FORMAL_CONSUMER_MODULE_NAMES = /\b(?:Personal Balance Sheet|Mortgage Analysis|College Funding|Pension Projection|Liquidity Analysis|Liquidity Reserve|Loan Analysis|House Purchase(?: Planner)?)\b/i;
const INTERNAL_CONSUMER_MODULE_IDS = /\b(?:personal_balance_sheet|mortgage_analysis|college_funding|pension_projection|liquidity_analysis|loan_analysis|house_purchase|net_retirement_cashflow)\b/i;

function assertClientOutcomeLabel(value, message) {
  const label = String(value || '');
  assert.doesNotMatch(label, FORMAL_CONSUMER_MODULE_NAMES, `${message}: formal module name leaked`);
  assert.doesNotMatch(label, INTERNAL_CONSUMER_MODULE_IDS, `${message}: internal module id leaked`);
}

assert.equal(isLikelyIncompleteVoiceCaption('Yes, my home is'), true);
assert.equal(isLikelyIncompleteVoiceCaption('And the mortgage is about...'), true);
assert.equal(isLikelyIncompleteVoiceCaption('Yes, it is.'), false);
assert.equal(isLikelyIncompleteVoiceCaption('What does net worth mean?'), false);
assert.equal(isLikelyIncompleteVoiceCaption('The college fund is what I am saving for.'), false);
assert.equal(isLikelyIncompleteVoiceCaption('€500,000 is roughly what it is worth.'), false);
assert.equal(isLikelyIncompleteVoiceCaption('€50,000 is what my annual spending is.'), false);

class WebmRecorder {
  static isTypeSupported(type) {
    return type === 'audio/webm;codecs=opus' || type === 'audio/webm';
  }
}
class OggRecorder {
  static isTypeSupported(type) {
    return type.startsWith('audio/ogg');
  }
}
class Mp4Recorder {
  static isTypeSupported(type) {
    return type.startsWith('audio/mp4');
  }
}
class UnsupportedRecorder {
  static isTypeSupported() {
    return false;
  }
}

assert.equal(selectSupportedRecordingMimeType(WebmRecorder), 'audio/webm;codecs=opus');
assert.equal(selectSupportedRecordingMimeType(OggRecorder), 'audio/ogg;codecs=opus');
assert.equal(selectSupportedRecordingMimeType(Mp4Recorder), 'audio/mp4;codecs=mp4a.40.2');
assert.equal(selectSupportedRecordingMimeType(UnsupportedRecorder), '');

// Live meetings expose an explicit microphone source and replace only the
// outbound audio track. A failed switch keeps the previously active source.
{
  storage.delete(realtimeMicrophonePreferenceKey);
  const originalMediaDevices = navigator.mediaDevices;
  const requestedConstraints = [];
  const stoppedTracks = [];
  const makeStream = (deviceId) => {
    const track = {
      kind: 'audio',
      label: `Microphone ${deviceId}`,
      enabled: true,
      getSettings: () => ({ deviceId }),
      stop: () => stoppedTracks.push(deviceId)
    };
    return {
      track,
      getAudioTracks: () => [track],
      getTracks: () => [track]
    };
  };
  const firstStream = makeStream('mic-one');
  const replacementStream = makeStream('mic-two');
  const failedStream = makeStream('mic-three');
  let nextStream = replacementStream;
  navigator.mediaDevices = {
    getUserMedia: async (constraints) => {
      requestedConstraints.push(constraints);
      return nextStream;
    },
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'mic-one', label: 'Built-in microphone' },
      { kind: 'audioinput', deviceId: 'mic-two', label: 'External microphone' },
      { kind: 'audioinput', deviceId: 'mic-three', label: 'Unavailable microphone' }
    ]
  };
  const replacedTracks = [];
  const deviceController = new RealtimeVoiceController({ root: null });
  deviceController.active = true;
  deviceController.localStream = firstStream;
  deviceController.selectedMicrophoneId = 'mic-one';
  const sender = {
    track: firstStream.track,
    replaceTrack: async (track) => {
      replacedTracks.push(track);
      sender.track = track;
    }
  };
  deviceController.peerConnection = { getSenders: () => [sender] };
  await deviceController.selectMicrophone('mic-two');
  assert.equal(requestedConstraints[0].audio.deviceId.exact, 'mic-two');
  assert.equal(replacedTracks[0], replacementStream.track);
  assert.deepEqual(stoppedTracks, ['mic-one']);
  assert.equal(deviceController.localStream, replacementStream);
  assert.equal(deviceController.selectedMicrophoneId, 'mic-two');
  assert.deepEqual(
    JSON.parse(storage.get(realtimeMicrophonePreferenceKey)),
    { deviceId: 'mic-two', label: 'External microphone' }
  );

  nextStream = failedStream;
  sender.replaceTrack = async () => { throw new Error('replace failed'); };
  await deviceController.selectMicrophone('mic-three');
  assert.equal(deviceController.selectedMicrophoneId, 'mic-two');
  assert.equal(deviceController.localStream, replacementStream);
  assert.deepEqual(stoppedTracks, ['mic-one', 'mic-three']);
  assert.deepEqual(
    JSON.parse(storage.get(realtimeMicrophonePreferenceKey)),
    { deviceId: 'mic-two', label: 'External microphone' },
    'A failed live switch must retain the previous microphone preference.'
  );
  navigator.mediaDevices = originalMediaDevices;
  storage.delete(realtimeMicrophonePreferenceKey);
}

// Before permission, browsers can hide device labels and route a generic
// request to Continuity Camera. The permission stream must be replaced with
// the built-in laptop microphone before it reaches the meeting connection.
{
  const originalMediaDevices = navigator.mediaDevices;
  const requests = [];
  const stoppedTracks = [];
  let permissionGranted = false;
  const makeStream = (deviceId, label) => {
    const track = {
      kind: 'audio',
      label,
      enabled: true,
      readyState: 'live',
      getSettings: () => ({ deviceId }),
      stop: () => stoppedTracks.push(deviceId)
    };
    return {
      getAudioTracks: () => [track],
      getTracks: () => [track]
    };
  };
  navigator.mediaDevices = {
    enumerateDevices: async () => permissionGranted
      ? [
          { kind: 'audioinput', deviceId: 'iphone-mic', label: 'Gerald’s iPhone Microphone' },
          { kind: 'audioinput', deviceId: 'macbook-mic', label: 'MacBook Pro Microphone (Built-in)' }
        ]
      : [
          { kind: 'audioinput', deviceId: 'iphone-mic', label: '' },
          { kind: 'audioinput', deviceId: 'macbook-mic', label: '' }
        ],
    getUserMedia: async (constraints) => {
      requests.push(constraints);
      const exact = constraints.audio.deviceId?.exact || '';
      if (exact === 'macbook-mic') {
        return makeStream('macbook-mic', 'MacBook Pro Microphone (Built-in)');
      }
      permissionGranted = true;
      return makeStream('iphone-mic', 'Gerald’s iPhone Microphone');
    }
  };
  const controller = new RealtimeVoiceController({ root: null });
  const stream = await controller.openMicrophoneStream();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].audio.deviceId, undefined, 'The first request only unlocks microphone labels.');
  assert.equal(requests[1].audio.deviceId.exact, 'macbook-mic');
  assert.equal(stream.getAudioTracks()[0].label, 'MacBook Pro Microphone (Built-in)');
  assert.deepEqual(stoppedTracks, ['iphone-mic'], 'The browser-selected iPhone probe must be stopped before joining.');
  assert.equal(controller.selectedMicrophoneId, 'macbook-mic');
  navigator.mediaDevices = originalMediaDevices;
}

// An explicit iPhone choice remains selectable, is stored for this tab, and is
// honoured exactly instead of being overwritten by the automatic laptop rule.
{
  const originalMediaDevices = navigator.mediaDevices;
  const requests = [];
  const iphoneTrack = {
    kind: 'audio',
    label: 'Gerald’s iPhone Microphone',
    enabled: true,
    readyState: 'live',
    getSettings: () => ({ deviceId: 'iphone-mic' }),
    stop: () => {}
  };
  navigator.mediaDevices = {
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'iphone-mic', label: 'Gerald’s iPhone Microphone' },
      { kind: 'audioinput', deviceId: 'macbook-mic', label: 'MacBook Pro Microphone (Built-in)' }
    ],
    getUserMedia: async (constraints) => {
      requests.push(constraints);
      return {
        getAudioTracks: () => [iphoneTrack],
        getTracks: () => [iphoneTrack]
      };
    }
  };
  const chooser = new RealtimeVoiceController({ root: null });
  await chooser.refreshMicrophones();
  assert.equal(chooser.selectedMicrophoneId, 'macbook-mic');
  await chooser.selectMicrophone('iphone-mic');
  assert.deepEqual(
    JSON.parse(storage.get(realtimeMicrophonePreferenceKey)),
    { deviceId: 'iphone-mic', label: 'Gerald’s iPhone Microphone' }
  );
  const restored = new RealtimeVoiceController({ root: null });
  assert.equal(restored.selectedMicrophoneId, 'iphone-mic');
  await restored.openMicrophoneStream();
  assert.equal(requests[0].audio.deviceId.exact, 'iphone-mic');
  navigator.mediaDevices = originalMediaDevices;
  storage.delete(realtimeMicrophonePreferenceKey);
}

// Origin-scoped device IDs can rotate. Recover an explicit source by its saved
// label, and update the tab preference to the new ID.
{
  const originalMediaDevices = navigator.mediaDevices;
  const requestedIds = [];
  storage.set(realtimeMicrophonePreferenceKey, JSON.stringify({
    deviceId: 'old-iphone-id',
    label: 'Gerald’s iPhone Microphone'
  }));
  const track = {
    kind: 'audio',
    label: 'Gerald’s iPhone Microphone',
    readyState: 'live',
    getSettings: () => ({ deviceId: 'new-iphone-id' }),
    stop: () => {}
  };
  navigator.mediaDevices = {
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'new-iphone-id', label: 'Gerald’s iPhone Microphone' },
      { kind: 'audioinput', deviceId: 'macbook-mic', label: 'MacBook Pro Microphone (Built-in)' }
    ],
    getUserMedia: async (constraints) => {
      requestedIds.push(constraints.audio.deviceId?.exact || 'automatic');
      return { getAudioTracks: () => [track], getTracks: () => [track] };
    }
  };
  const controller = new RealtimeVoiceController({ root: null });
  await controller.openMicrophoneStream();
  assert.deepEqual(requestedIds, ['new-iphone-id']);
  assert.deepEqual(
    JSON.parse(storage.get(realtimeMicrophonePreferenceKey)),
    { deviceId: 'new-iphone-id', label: 'Gerald’s iPhone Microphone' }
  );
  navigator.mediaDevices = originalMediaDevices;
  storage.delete(realtimeMicrophonePreferenceKey);
}

// A definitely unavailable saved source falls back directly to the built-in
// microphone rather than asking the browser to choose (and choosing iPhone).
{
  const originalMediaDevices = navigator.mediaDevices;
  const requestedIds = [];
  storage.set(realtimeMicrophonePreferenceKey, JSON.stringify({
    deviceId: 'missing-iphone-id',
    label: 'Missing iPhone Microphone'
  }));
  const macTrack = {
    kind: 'audio',
    label: 'MacBook Pro Microphone (Built-in)',
    readyState: 'live',
    getSettings: () => ({ deviceId: 'macbook-mic' }),
    stop: () => {}
  };
  navigator.mediaDevices = {
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'iphone-mic', label: 'Gerald’s iPhone Microphone' },
      { kind: 'audioinput', deviceId: 'macbook-mic', label: 'MacBook Pro Microphone (Built-in)' }
    ],
    getUserMedia: async (constraints) => {
      const exact = constraints.audio.deviceId?.exact || 'automatic';
      requestedIds.push(exact);
      if (exact === 'missing-iphone-id') {
        const error = new Error('missing');
        error.name = 'OverconstrainedError';
        throw error;
      }
      assert.equal(exact, 'macbook-mic');
      return { getAudioTracks: () => [macTrack], getTracks: () => [macTrack] };
    }
  };
  const controller = new RealtimeVoiceController({ root: null });
  const stream = await controller.openMicrophoneStream();
  assert.equal(stream.getAudioTracks()[0], macTrack);
  assert.deepEqual(requestedIds, ['missing-iphone-id', 'macbook-mic']);
  assert.equal(storage.has(realtimeMicrophonePreferenceKey), false);
  navigator.mediaDevices = originalMediaDevices;
}

// Cancelling setup while the post-permission exact device is opening must stop
// the temporary browser-selected probe immediately and discard the later track.
{
  const originalMediaDevices = navigator.mediaDevices;
  let permissionGranted = false;
  let probeStopped = false;
  let exactStopped = false;
  let resolveExactStream;
  let markExactStarted;
  const exactStarted = new Promise((resolve) => { markExactStarted = resolve; });
  const probeTrack = {
    kind: 'audio',
    label: 'Gerald’s iPhone Microphone',
    readyState: 'live',
    getSettings: () => ({ deviceId: 'iphone-mic' }),
    stop: () => { probeStopped = true; }
  };
  const exactTrack = {
    kind: 'audio',
    label: 'MacBook Pro Microphone (Built-in)',
    readyState: 'live',
    getSettings: () => ({ deviceId: 'macbook-mic' }),
    stop: () => { exactStopped = true; }
  };
  navigator.mediaDevices = {
    enumerateDevices: async () => permissionGranted
      ? [
          { kind: 'audioinput', deviceId: 'iphone-mic', label: 'Gerald’s iPhone Microphone' },
          { kind: 'audioinput', deviceId: 'macbook-mic', label: 'MacBook Pro Microphone (Built-in)' }
        ]
      : [
          { kind: 'audioinput', deviceId: 'iphone-mic', label: '' },
          { kind: 'audioinput', deviceId: 'macbook-mic', label: '' }
        ],
    getUserMedia: async (constraints) => {
      const exact = constraints.audio.deviceId?.exact || '';
      if (!exact) {
        permissionGranted = true;
        return { getAudioTracks: () => [probeTrack], getTracks: () => [probeTrack] };
      }
      assert.equal(exact, 'macbook-mic');
      markExactStarted();
      return new Promise((resolve) => { resolveExactStream = resolve; });
    }
  };
  const controller = new RealtimeVoiceController({ root: null });
  const abortController = new AbortController();
  const opening = controller.openMicrophoneStream('', { signal: abortController.signal });
  await exactStarted;
  abortController.abort('test_cancelled');
  assert.equal(probeStopped, true, 'Abort must stop the temporary browser-selected stream immediately.');
  resolveExactStream({ getAudioTracks: () => [exactTrack], getTracks: () => [exactTrack] });
  await assert.rejects(opening, (error) => error?.name === 'AbortError');
  assert.equal(exactStopped, true, 'A track that resolves after cancellation must never remain live.');
  assert.equal(controller.microphonePermissionStream, null);
  navigator.mediaDevices = originalMediaDevices;
}

// Switching sources must preserve response/speaking phases. A later track end
// fails closed and refreshes choices without silently activating another mic.
{
  storage.delete(realtimeMicrophonePreferenceKey);
  const originalMediaDevices = navigator.mediaDevices;
  const sentEvents = [];
  const trackListeners = new Map();
  let replacementStopped = false;
  let mediaRequests = 0;
  const oldTrack = {
    kind: 'audio',
    label: 'Built-in microphone',
    enabled: true,
    getSettings: () => ({ deviceId: 'mic-one' }),
    stop: () => {}
  };
  const replacementTrack = {
    kind: 'audio',
    label: 'External microphone',
    enabled: true,
    readyState: 'live',
    getSettings: () => ({ deviceId: 'mic-two' }),
    addEventListener: (type, listener) => trackListeners.set(type, listener),
    stop: () => { replacementStopped = true; }
  };
  const oldStream = { getAudioTracks: () => [oldTrack], getTracks: () => [oldTrack] };
  const replacementStream = {
    getAudioTracks: () => [replacementTrack],
    getTracks: () => [replacementTrack]
  };
  const recoveryTrack = {
    kind: 'audio',
    label: 'Built-in microphone',
    enabled: true,
    readyState: 'live',
    getSettings: () => ({ deviceId: 'mic-one' }),
    addEventListener: () => {},
    stop: () => {}
  };
  const recoveryStream = {
    getAudioTracks: () => [recoveryTrack],
    getTracks: () => [recoveryTrack]
  };
  navigator.mediaDevices = {
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'mic-one', label: 'Built-in microphone' },
      { kind: 'audioinput', deviceId: 'mic-two', label: 'External microphone' }
    ],
    getUserMedia: async (constraints) => {
      mediaRequests += 1;
      return constraints.audio.deviceId.exact === 'mic-one'
        ? recoveryStream
        : replacementStream;
    }
  };
  const sender = {
    track: oldTrack,
    replaceTrack: async (track) => { sender.track = track; }
  };
  const controller = new RealtimeVoiceController({ root: null });
  controller.active = true;
  controller.phase = 'responding';
  controller.localStream = oldStream;
  controller.selectedMicrophoneId = 'mic-one';
  controller.peerConnection = { getSenders: () => [sender] };
  controller.dataChannel = {
    readyState: 'open',
    send: (value) => sentEvents.push(JSON.parse(value))
  };
  await controller.selectMicrophone('mic-two');
  assert.equal(controller.phase, 'responding', 'A microphone switch must not erase the preparing-response phase.');
  controller.toggleMute();
  assert.equal(controller.phase, 'responding', 'Muting during response preparation must keep the response orb phase.');
  controller.toggleMute();
  assert.equal(controller.phase, 'responding', 'Unmuting during response preparation must keep the response orb phase.');
  trackListeners.get('ended')?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controller.muted, true);
  assert.equal(controller.phase, 'muted');
  assert.equal(controller.localStream, null);
  assert.equal(replacementStopped, true);
  assert.equal(mediaRequests, 1, 'Track-ended handling must not auto-open a fallback microphone.');
  assert.equal(
    controller.selectedMicrophoneId,
    '',
    'Recovery must leave the selector on Automatic so choosing a listed source emits a real change.'
  );
  assert.equal(sentEvents.at(-1)?.type, 'input_audio_buffer.clear');
  await controller.selectMicrophone('');
  assert.equal(mediaRequests, 2, 'The explicit automatic reconnect action must reopen a source.');
  assert.equal(controller.localStream, recoveryStream);
  assert.equal(controller.selectedMicrophoneId, 'mic-one');
  assert.equal(controller.muted, true, 'Recovered capture stays fail-closed until the user unmutes.');
  controller.active = false;
  controller.cleanupLocal();
  navigator.mediaDevices = originalMediaDevices;
  storage.delete(realtimeMicrophonePreferenceKey);
}

// Device changes are serialized so a slower first selection cannot resolve
// after and overwrite the user's newer source choice.
{
  storage.delete(realtimeMicrophonePreferenceKey);
  const originalMediaDevices = navigator.mediaDevices;
  const requestedIds = [];
  let resolveFirstStream;
  let markFirstRequested;
  const firstRequested = new Promise((resolve) => { markFirstRequested = resolve; });
  const makeStream = (deviceId) => {
    const track = {
      kind: 'audio',
      label: `Microphone ${deviceId}`,
      enabled: true,
      readyState: 'live',
      getSettings: () => ({ deviceId }),
      addEventListener: () => {},
      stop: () => {}
    };
    return { track, getAudioTracks: () => [track], getTracks: () => [track] };
  };
  const oldStream = makeStream('mic-one');
  const firstStream = makeStream('mic-two');
  const finalStream = makeStream('mic-three');
  navigator.mediaDevices = {
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'mic-one', label: 'Built-in microphone' },
      { kind: 'audioinput', deviceId: 'mic-two', label: 'Desk microphone' },
      { kind: 'audioinput', deviceId: 'mic-three', label: 'Headset microphone' }
    ],
    getUserMedia: async (constraints) => {
      const exact = constraints.audio.deviceId.exact;
      requestedIds.push(exact);
      if (exact === 'mic-two') {
        markFirstRequested();
        return new Promise((resolve) => { resolveFirstStream = resolve; });
      }
      assert.equal(exact, 'mic-three');
      return finalStream;
    }
  };
  const sender = {
    track: oldStream.track,
    replaceTrack: async (track) => { sender.track = track; }
  };
  const controller = new RealtimeVoiceController({ root: null });
  controller.active = true;
  controller.localStream = oldStream;
  controller.selectedMicrophoneId = 'mic-one';
  controller.peerConnection = { getSenders: () => [sender] };
  const firstSwitch = controller.selectMicrophone('mic-two');
  const finalSwitch = controller.selectMicrophone('mic-three');
  await firstRequested;
  assert.deepEqual(requestedIds, ['mic-two'], 'The newer switch must wait instead of racing the first replace.');
  resolveFirstStream(firstStream);
  await Promise.all([firstSwitch, finalSwitch]);
  assert.deepEqual(requestedIds, ['mic-two', 'mic-three']);
  assert.equal(controller.selectedMicrophoneId, 'mic-three');
  assert.equal(controller.localStream, finalStream);
  assert.equal(sender.track, finalStream.track);
  controller.active = false;
  controller.cleanupLocal();
  navigator.mediaDevices = originalMediaDevices;
  storage.delete(realtimeMicrophonePreferenceKey);
}

// If the meeting ends while replaceTrack is pending, the late track is stopped
// and detached instead of being committed onto the preserved provider peer.
{
  storage.set(realtimeMicrophonePreferenceKey, JSON.stringify({
    deviceId: 'mic-one',
    label: 'Built-in microphone'
  }));
  const originalMediaDevices = navigator.mediaDevices;
  let nextTrackStopped = false;
  let oldTrackStopped = false;
  let resolveReplace;
  let markReplaceStarted;
  const replaceStarted = new Promise((resolve) => { markReplaceStarted = resolve; });
  const oldTrack = {
    kind: 'audio', label: 'Built-in microphone', enabled: true,
    getSettings: () => ({ deviceId: 'mic-one' }),
    stop: () => { oldTrackStopped = true; }
  };
  const nextTrack = {
    kind: 'audio', label: 'External microphone', enabled: true, readyState: 'live',
    getSettings: () => ({ deviceId: 'mic-two' }),
    stop: () => { nextTrackStopped = true; }
  };
  const oldStream = { getAudioTracks: () => [oldTrack], getTracks: () => [oldTrack] };
  const nextStream = { getAudioTracks: () => [nextTrack], getTracks: () => [nextTrack] };
  navigator.mediaDevices = {
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'mic-one', label: 'Built-in microphone' },
      { kind: 'audioinput', deviceId: 'mic-two', label: 'External microphone' }
    ],
    getUserMedia: async () => nextStream
  };
  const replacedTracks = [];
  const sender = {
    track: oldTrack,
    replaceTrack: (track) => {
      replacedTracks.push(track);
      if (track === null) {
        sender.track = null;
        return Promise.resolve();
      }
      sender.track = track;
      markReplaceStarted();
      return new Promise((resolve) => { resolveReplace = resolve; });
    }
  };
  const controller = new RealtimeVoiceController({ root: null });
  controller.active = true;
  controller.localStream = oldStream;
  controller.selectedMicrophoneId = 'mic-one';
  controller.peerConnection = {
    getSenders: () => [sender],
    close: () => {}
  };
  const switching = controller.selectMicrophone('mic-two');
  await replaceStarted;
  await controller.end({ reason: 'user', notifyServer: false, announce: false });
  assert.equal(oldTrackStopped, true);
  resolveReplace();
  await switching;
  assert.equal(nextTrackStopped, true, 'A replacement that resolves after end must be stopped immediately.');
  assert.deepEqual(replacedTracks, [nextTrack, null]);
  assert.equal(controller.localStream, null);
  assert.equal(controller.active, false);
  assert.equal(controller.phase, 'off');
  assert.deepEqual(
    JSON.parse(storage.get(realtimeMicrophonePreferenceKey)),
    { deviceId: 'mic-one', label: 'Built-in microphone' }
  );
  navigator.mediaDevices = originalMediaDevices;
  storage.delete(realtimeMicrophonePreferenceKey);
}

const draftEvents = [];
const draftInput = {
  value: 'About €40,000, but I need to check.',
  selectionStart: 6,
  selectionEnd: 13,
  selectionDirection: 'forward',
  dispatchEvent: (event) => draftEvents.push(event.type),
  setSelectionRange(start, end, direction) {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
};
const draftRoot = {
  querySelector: (selector) => selector === '#conversationInput' ? draftInput : null
};
const draftSnapshot = captureConversationDraft(draftRoot);
draftInput.value = '';
draftInput.selectionStart = 0;
draftInput.selectionEnd = 0;
assert.equal(restoreConversationDraft(draftRoot, draftSnapshot), true);
assert.equal(draftInput.value, 'About €40,000, but I need to check.');
assert.deepEqual([draftInput.selectionStart, draftInput.selectionEnd], [6, 13]);
assert.deepEqual(draftEvents, ['input']);

let submittedTurns = 0;
const transcriptEvents = [];
const transcriptInput = {
  value: 'My salary is approximate.',
  maxLength: 3000,
  form: { requestSubmit: () => { submittedTurns += 1; } },
  dispatchEvent: (event) => transcriptEvents.push(event.type),
  focus: () => {},
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
};
appendTranscriptForReview(transcriptInput, 'Our savings are about €50,000.');
assert.equal(transcriptInput.value, 'My salary is approximate.\nOur savings are about €50,000.');
assert.deepEqual(transcriptEvents, ['input']);
assert.equal(submittedTurns, 0, 'Adding a transcript must never submit the planning form.');

assert.equal(crossedAccessibleCountdownThreshold(16, 15), 15);
assert.equal(crossedAccessibleCountdownThreshold(15, 14), null);
assert.equal(crossedAccessibleCountdownThreshold(6, 5), 5);
assert.equal(crossedAccessibleCountdownThreshold(16, 4), 5);

const timer = { textContent: '' };
const status = { textContent: '' };
const controllerRoot = {
  querySelector(selector) {
    if (selector === '[data-voice-timer]') return timer;
    if (selector === '[data-voice-status]') return status;
    return null;
  }
};
const countdownController = new ConsumerVoiceController({
  root: controllerRoot,
  currentQuestion: () => 'Test question'
});
countdownController.recording = {
  startedAt: performance.now() - 30_100,
  maxDurationMs: 45_000,
  previousRemainingSeconds: 16,
  announcedCountdownThresholds: new Set()
};
countdownController.updateTimer();
assert.match(status.textContent, /15 seconds of recording time remain/);

let recorderStops = 0;
let trackStops = 0;
let networkAborts = 0;
let sourceStops = 0;
let sourceDisconnects = 0;
const lifecycleController = new ConsumerVoiceController({
  root: { querySelector: () => null },
  currentQuestion: () => 'Test question'
});
lifecycleController.phase = 'recording';
lifecycleController.recording = {
  recorder: {
    state: 'recording',
    stop() {
      recorderStops += 1;
      this.state = 'inactive';
    }
  },
  stream: { getTracks: () => [{ stop: () => { trackStops += 1; } }] },
  chunks: [],
  startedAt: performance.now(),
  maxDurationMs: 45_000,
  shouldUpload: true,
  mimeType: 'audio/webm;codecs=opus',
  timeoutId: null,
  intervalId: null,
  error: null
};
lifecycleController.cancelActiveVoice({ reason: 'deletion', refreshBudget: false });
assert.equal(recorderStops, 1);
assert.ok(trackStops >= 1);
assert.match(lifecycleController.statusText, /discarded before upload/);

lifecycleController.phase = 'loading_speech';
lifecycleController.networkController = { abort: () => { networkAborts += 1; } };
lifecycleController.audioSource = {
  stop: () => { sourceStops += 1; },
  disconnect: () => { sourceDisconnects += 1; }
};
lifecycleController.cancelActiveVoice({ reason: 'deletion', refreshBudget: false });
assert.equal(networkAborts, 1);
assert.equal(sourceStops, 1);
assert.equal(sourceDisconnects, 1);
assert.doesNotMatch(lifecycleController.statusText, /nothing was submitted/i);
assert.match(lifecycleController.statusText, /server-side allowance remains authoritative/);

let budgetRefreshes = 0;
lifecycleController.refreshVoiceBudget = async () => { budgetRefreshes += 1; };
const refreshableAbort = {};
await lifecycleController.refreshVoiceBudgetAfterAbort(refreshableAbort, 'session-test');
assert.equal(budgetRefreshes, 1);
const deletionAbort = {};
lifecycleController.abortWithoutBudgetRefresh.add(deletionAbort);
await lifecycleController.refreshVoiceBudgetAfterAbort(deletionAbort, 'session-test');
assert.equal(budgetRefreshes, 1, 'Deletion/reset cancellation must not race a session-budget refresh.');

const appSource = readFileSync(`${rootPath}/js/plan/app.js`, 'utf8');
const apiSource = readFileSync(`${rootPath}/js/plan/api.js`, 'utf8');
const realtimeSource = readFileSync(`${rootPath}/js/plan/realtime_voice.js`, 'utf8');
const storeSource = readFileSync(`${rootPath}/js/plan/store.js`, 'utf8');
const viewsSource = readFileSync(`${rootPath}/js/plan/views.js`, 'utf8');
const planCssSource = readFileSync(`${rootPath}/styles/plan.css`, 'utf8');
const privacySource = readFileSync(`${rootPath}/plan/privacy.html`, 'utf8');
const planIndexSource = readFileSync(`${rootPath}/plan/index.html`, 'utf8');
assert.match(
  viewsSource,
  /const consumerDescription = consumerLanguageForModule\(id\)\?\.shortDescription;[\s\S]{0,180}consumerDescription,[\s\S]{0,80}'an analysis'/,
  'Consumer recommendation headings must use manifest-owned outcome language and fail closed.'
);
assert.doesNotMatch(viewsSource, /net_retirement_cashflow:\s*'Net retirement cash flow'/);
assert.doesNotMatch(
  viewsSource,
  /firstDefined\(error\?\.moduleName,\s*MODULE_LABELS\[error\?\.moduleId\]/,
  'Typed error summaries must not trust formal module labels.'
);
// The consumer can always force-finish a turn the voice-activity detector
// missed: the live orb doubles as the commit control, space bar works on
// desktop, and a mistimed empty commit is tolerated silently.
assert.match(realtimeSource, /commitTurn\(\) \{/);
assert.match(realtimeSource, /type: 'input_audio_buffer\.commit'/);
assert.match(realtimeSource, /if \(this\.active\) this\.commitTurn\(\);\s*else this\.start\(\);/);
assert.match(realtimeSource, /event\.code !== 'Space'/);
assert.match(realtimeSource, /Tap the circle or press space when you’ve finished/);
assert.match(realtimeSource, /Finish your answer and send it to Planéir/);
assert.match(realtimeSource, /commit_empty\|buffer_too_small\|input_audio_buffer_commit/);
assert.match(appSource, /const draft = captureConversationDraft\(appRoot\)[\s\S]*renderCurrentJourney\(\)[\s\S]*restoreConversationDraft\(appRoot, draft\)/);
assert.match(appSource, /async function handleDeleteSession\(\) \{\s*await realtimeVoiceController\.end\(\{ reason: 'deletion' \}\);\s*voiceController\.cancelActiveVoice\(\{ reason: 'deletion', refreshBudget: false \}\)/);
assert.match(appSource, /deleteSessionButton\.addEventListener\('click',[\s\S]*realtimeVoiceController\.end\(\{ reason: 'deletion' \}\)[\s\S]*voiceController\.cancelActiveVoice\(\{ reason: 'deletion', refreshBudget: false \}\)[\s\S]*openDialog\(deleteSessionDialog\)/);
assert.match(viewsSource, /app allowance/);
assert.match(viewsSource, /fixed conservative reservation/);
assert.match(privacySource, /conservative application reservation rather than promising an exact provider/);
assert.match(privacySource, /Short voice recording and playback[\s\S]*€2[\s\S]*Live voice feature[\s\S]*€10 per private session/);
assert.match(privacySource, /Realtime-response, input-transcription, and character-priced approved speech/);
assert.match(privacySource, /OpenAI Realtime is used for microphone streaming,\s+speech recognition, turn detection, and natural dialogue/);
assert.match(privacySource, /separate authenticated server control\s+connection owns protected tools and deterministic calculations/);
assert.match(privacySource, /only a clear finalized answer to that closed\s+confirmation question authorizes the exact prepared plan and profile revision/);
assert.match(privacySource, /complete finalized welcome,\s+conversation, and closing turns remain reviewable with the modules after reload/);
assert.match(privacySource, /Partial caption streams are not retained/);
assert.match(privacySource, /final, it is processed automatically as the next live turn/);
assert.match(privacySource, /microphone input is disabled, playback is allowed to finish \(with a bounded\s+timeout\), the session closes, and the results view opens automatically/);
assert.match(planIndexSource, /id="realtimeVoiceShell"/);
assert.ok(
  planIndexSource.indexOf('id="realtimeVoiceShell"') > planIndexSource.indexOf('id="appRoot"'),
  'The persistent realtime shell must live after and outside the rerendered appRoot.'
);
assert.match(planIndexSource, /id="realtimeVoiceCompanion"/);
assert.match(planIndexSource, /id="realtimeVoiceLauncher"[\s\S]*Talk to Planéir/);
assert.match(planIndexSource, /id="realtimeVoiceLauncher"[\s\S]*aria-controls="realtimeVoiceShell"/);
assert.match(planIndexSource, /id="realtimeVoiceShell"[\s\S]*role="dialog"[\s\S]*aria-modal="true"/);
assert.match(planIndexSource, /id="realtimeVoiceCollapseButton"/);
assert.match(planIndexSource, /id="realtimeVoiceMuteButton"[\s\S]*id="realtimeVoiceEndButton"[\s\S]*id="realtimeVoiceFocusComposerButton"[\s\S]*id="realtimeVoiceReviewButton"/);
assert.match(planIndexSource, /id="realtimeVoiceBoundedFallbackButton"/);
assert.equal(
  [...planIndexSource.matchAll(/class="is-empty is-module-slot"/g)].length,
  1,
  'The unopened companion must show one goal-listening state without filler slots.'
);
assert.match(planIndexSource, /id="realtimeVoiceTranscriptHistory"[\s\S]*aria-live="polite"/);
assert.match(planIndexSource, /id="realtimeVoiceFactsList"/);
assert.match(planIndexSource, /id="realtimeVoiceModulesList"/);
assert.match(planIndexSource, /id="realtimeVoiceConsentDialog"/);
assert.match(appSource, /root:\s*document\.getElementById\('realtimeVoiceCompanion'\)/);
assert.match(realtimeSource, /openCompanion\(\{ focus = true \} = \{\}\)/);
assert.match(realtimeSource, /collapseCompanion\(\{ restoreFocus = true \} = \{\}\)/);
const collapseCompanionSource = realtimeSource.slice(
  realtimeSource.indexOf('collapseCompanion({ restoreFocus = true } = {})'),
  realtimeSource.indexOf('trapFocus(event)')
);
assert.doesNotMatch(collapseCompanionSource, /this\.end\(/, 'Minimising the drawer must not stop an active microphone session.');
const reviewAndConfirmSource = realtimeSource.slice(
  realtimeSource.indexOf('\n  reviewAndConfirm() {'),
  realtimeSource.indexOf('configureLeaseExpiry(')
);
assert.doesNotMatch(reviewAndConfirmSource, /this\.end\(/, 'Opening the profile-and-module review must not stop an active voice session.');
// Meeting-experience regression guards.
// 1. The entry screen is the calm meeting surface: reassuring heading, one
//    supporting sentence, a single central start control, and a transcript
//    that stays hidden until requested.
assert.match(planIndexSource, /Let’s talk about what matters to you\./);
assert.match(planIndexSource, /class="realtime-meeting-sub"/);
assert.match(planIndexSource, /id="realtimeVoiceCaptionCard"[\s\S]*hidden/);
assert.match(planIndexSource, /id="realtimeVoiceTranscriptToggle"/);
assert.match(realtimeSource, /toggleTranscript\(\)/);
// 2. An eligible adviser invitation lands on the meeting screen automatically.
assert.match(appSource, /function maybeAutoOpenRealtimeMeeting\(\)[\s\S]*openCompanion\(\{ focus: false \}\)/);
// 3. Accepting the disclosure flows straight into microphone permission and
//    connection instead of demanding a second start press.
const submitConsentSource = realtimeSource.slice(
  realtimeSource.indexOf('async submitConsent(form)'),
  realtimeSource.indexOf('showConsentError(message)')
);
assert.match(submitConsentSource, /this\.start\(\)/);
// 4. The client must never hang up an active meeting from merged display
//    budget state; the server lease status owns allowance termination.
const syncSource = realtimeSource.slice(
  realtimeSource.indexOf('sync(currentState = state)'),
  realtimeSource.indexOf('setPhase(phase, statusText')
);
assert.doesNotMatch(
  syncSource,
  /end\(\{ reason: 'budget' \}\)/,
  'sync() must not terminate an active meeting based on display budget state.'
);
assert.match(
  realtimeSource,
  /errorElement\.hidden = !errorText \|\| errorText === this\.statusText/,
  'An identical connection status and error must not be rendered twice.'
);
assert.match(realtimeSource, /if \(event\.key === 'Escape'\)[\s\S]*this\.collapseCompanion\(\)/);
assert.match(realtimeSource, /if \(event\.key === 'Tab'\) this\.trapFocus\(event\)/);
assert.match(realtimeSource, /if \(document\.hidden\)[\s\S]*this\.end\(\{ reason: 'hidden' \}\)[\s\S]*this\.collapseCompanion/);
assert.match(realtimeSource, /modules\.slice\(0, 3\)/);
assert.match(realtimeSource, /for \(let index = 0; index < 3; index \+= 1\)/);
assert.doesNotMatch(realtimeSource, /appendTranscriptForReview|\/turns/);
assert.doesNotMatch(realtimeSource, /sendEvent\(\{\s*type:\s*'response\.cancel'/);
assert.match(realtimeSource, /input_audio_buffer\.speech_started/);
assert.match(realtimeSource, /MAX_TRANSCRIPT_ITEMS/);
assert.match(realtimeSource, /classList\.toggle\('is-budget-low', budgetLow\)/);
assert.match(realtimeSource, /setPhase\('interrupted', 'Planéir stopped speaking\./);
assert.match(planCssSource, /\.realtime-voice-shell\.is-budget-low \.realtime-budget-card/);
assert.match(planCssSource, /\.realtime-voice-launcher\s*\{/);
assert.match(planCssSource, /body\.realtime-companion-open/);
assert.match(planCssSource, /\.realtime-voice-shell\s*\{[\s\S]*width:\s*min\(33rem/);
assert.match(planCssSource, /@media \(max-width: 720px\)[\s\S]*\.realtime-voice-shell\s*\{[\s\S]*max-height:\s*100dvh/);
assert.match(planCssSource, /env\(safe-area-inset-bottom/);
assert.match(planCssSource, /min-height:\s*44px/);
assert.match(planCssSource, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(realtimeSource, /responding: 'Preparing to respond…'/);
assert.match(realtimeSource, /Reconnect automatic microphone/);
assert.match(planCssSource, /data-realtime-phase="responding"/);
assert.match(planCssSource, /@keyframes realtime-orb-listen/);
assert.match(planCssSource, /@keyframes realtime-orb-hearing/);
assert.match(planCssSource, /@keyframes realtime-orb-think/);
assert.match(planCssSource, /@keyframes realtime-orb-prepare-outer/);
assert.match(planCssSource, /@keyframes realtime-orb-response-outer/);
const reducedMotionListeningIndex = planCssSource.lastIndexOf(
  '.realtime-voice-shell[data-realtime-phase="listening"]'
);
const reducedMotionOrbSource = planCssSource.slice(
  planCssSource.lastIndexOf('@media (prefers-reduced-motion: reduce)', reducedMotionListeningIndex)
);
assert.match(reducedMotionOrbSource, /data-realtime-phase="listening"/);
assert.match(reducedMotionOrbSource, /data-realtime-phase="user_speaking"/);
assert.match(reducedMotionOrbSource, /data-realtime-phase="thinking"/);
assert.match(reducedMotionOrbSource, /data-realtime-phase="responding"/);
assert.match(reducedMotionOrbSource, /data-realtime-phase="assistant_speaking"/);
const outboundRealtimeEventTypes = [...new Set(
  [...realtimeSource.matchAll(/sendEvent\(\{\s*type:\s*'([^']+)'/g)]
    .map((match) => match[1])
)].sort();
// The browser may only clear its own audio buffer (mute) and force-commit
// its own finished turn. It must never create responses or update sessions.
assert.deepEqual(outboundRealtimeEventTypes, ['input_audio_buffer.clear', 'input_audio_buffer.commit']);
assert.match(realtimeSource, /'complete'[\s\S]*'withdrawn'[\s\S]*'deleted'[\s\S]*'budget_exhausted'/);
assert.doesNotMatch(realtimeSource, /sendEvent\(\{\s*type:\s*'(?:response\.create|session\.update)'/);
assert.match(apiSource, /\/voice\/realtime\/consent/);
assert.match(apiSource, /\/voice\/realtime\/calls/);
const preparePlanRequestSource = appSource.slice(
  appSource.indexOf("action: 'prepare'"),
  appSource.indexOf("action: 'prepare'") + 320
);
assert.match(preparePlanRequestSource, /expectedRevision:\s*revision/);
assert.doesNotMatch(
  preparePlanRequestSource,
  /moduleIds/,
  'The browser must let the Worker derive the exact goal-led bundle.'
);
assert.match(appSource, /action:\s*'confirm_and_run'[\s\S]*planId,[\s\S]*planNonce,[\s\S]*confirmation:\s*true/);
assert.doesNotMatch(appSource, /runAnalyses\(/);
const confirmPlanRequestSource = appSource.slice(
  appSource.indexOf("action: 'confirm_and_run'"),
  appSource.indexOf("action: 'confirm_and_run'") + 420
);
assert.doesNotMatch(confirmPlanRequestSource, /moduleIds|scenarioOverrides/);
assert.doesNotMatch(appSource, /planNonce:\s*newIdempotencyKey|planNonce:\s*crypto\./);
assert.match(appSource, /state\.recommendations\.length < 1 \|\| state\.recommendations\.length > 3/);
assert.match(viewsSource, /Confirm profile & save review plan/);
assert.match(viewsSource, /Your analysis plan is shown below/);
assert.match(storeSource, /state\.selectedModuleIds = \[\.\.\.new Set\(state\.analysisPlan\.moduleIds\)\]/);
assert.doesNotMatch(
  storeSource,
  /export function setModuleSelected/,
  'The browser store must not expose a user-controlled module-selection mutator.'
);
const transcriptionApiSource = apiSource.slice(
  apiSource.indexOf('export function transcribeVoice'),
  apiSource.indexOf('export function speakNextQuestion')
);
assert.doesNotMatch(transcriptionApiSource, /FormData|formData/);
assert.match(transcriptionApiSource, /rawBody:\s*audio/);
assert.match(transcriptionApiSource, /'X-Voice-Duration-Ms'/);
assert.match(transcriptionApiSource, /'X-Voice-Request-Id'/);

const rawRealtimeCall = normaliseRealtimeCallResponse({
  body: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n',
  contentType: 'application/sdp',
  headers: new Headers({
    'X-Realtime-Lease-Id': 'rt_lease_frontend_001',
    'X-Realtime-Hard-Expires-At': '2030-01-01T00:00:00.000Z',
    'X-Realtime-Budget-Micro-Eur': '1750000',
    'X-Realtime-Activation-Id': `rt_activation_${'B'.repeat(24)}`,
    'X-Realtime-Control-Capability': `rt_control_${'C'.repeat(24)}`
  })
});
assert.match(rawRealtimeCall.sdp, /^v=0/);
assert.equal(rawRealtimeCall.leaseId, 'rt_lease_frontend_001');
assert.equal(rawRealtimeCall.expiresAt, '2030-01-01T00:00:00.000Z');
assert.equal(rawRealtimeCall.budget.remainingMicroEur, 1_750_000);
assert.equal(rawRealtimeCall.controlCapability, `rt_control_${'C'.repeat(24)}`);
assert.equal(rawRealtimeCall.activationId, `rt_activation_${'B'.repeat(24)}`);
assert.deepEqual(rawRealtimeCall.payload, {
  realtimeVoiceBudget: {
    limitMicroEur: null,
    spentMicroEur: null,
    remainingMicroEur: 1_750_000
  }
});

const headerDurationCall = normaliseRealtimeCallResponse({
  body: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n',
  contentType: 'application/sdp',
  headers: new Headers({ 'X-Voice-Realtime-Max-Duration-Ms': '90000' })
});
assert.equal(headerDurationCall.maxDurationMs, 90_000);

const jsonRealtimeCall = normaliseRealtimeCallResponse({
  body: JSON.stringify({
    data: {
      answer: { sdp: 'v=0\r\no=- 2 3 IN IP4 127.0.0.1\r\n' },
      lease: { id: 'rt_json_lease', maxDurationMs: 120000 }
    }
  }),
  contentType: 'application/json',
  headers: new Headers()
});
assert.equal(jsonRealtimeCall.leaseId, 'rt_json_lease');
assert.equal(jsonRealtimeCall.maxDurationMs, 120000);

assert.deepEqual(
  classifyRealtimeEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_1',
    transcript: 'We have about €50,000 saved.'
  }),
  {
    type: 'conversation.item.input_audio_transcription.completed',
    kind: 'user_final',
    itemId: 'item_1',
    text: 'We have about €50,000 saved.',
    event: {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_1',
      transcript: 'We have about €50,000 saved.'
    }
  }
);
assert.equal(classifyRealtimeEvent({ type: 'input_audio_buffer.speech_started' }).kind, 'speech_started');
assert.equal(classifyRealtimeEvent({ type: 'response.output_audio.delta' }).kind, 'assistant_audio');
assert.equal(classifyRealtimeEvent({ type: 'output_audio_buffer.started' }).kind, 'assistant_playback_started');
assert.equal(classifyRealtimeEvent({ type: 'output_audio_buffer.stopped' }).kind, 'assistant_playback_stopped');
for (const type of ['conversation.item.created', 'conversation.item.added', 'conversation.item.done']) {
  const planningUpdate = classifyRealtimeEvent({
    type,
    item: {
      type: 'function_call_output',
      output: JSON.stringify({ ok: true, assistantSpeech: { speechId: 'speech_test', text: 'Approved.' } })
    }
  });
  assert.equal(planningUpdate.kind, 'planning_update');
  assert.equal(planningUpdate.payload.assistantSpeech.text, 'Approved.');
}

const planningContext = extractRealtimePlanningContext({
  planning: {
    facts: [{ path: '/goals/0/targetAmount', label: 'Target', value: 350000, certainty: 'approximate' }],
    modules: [{ moduleId: 'house_purchase', status: 'recommended' }],
    readyForReview: true
  }
}, { profile: null, recommendations: [] });
assert.equal(planningContext.facts[0].badge.label, 'Approximate');
assert.equal(
  planningContext.modules[0].label,
  'a review of your home-purchase affordability and savings path'
);
assertClientOutcomeLabel(planningContext.modules[0].label, 'Fallback planning-context label');
assert.equal(planningContext.readyForReview, true);

const signedGuideLabelContext = extractRealtimePlanningContext({
  conversationGuide: {
    analyses: [{
      moduleId: 'house_purchase',
      label: 'House Purchase'
    }]
  }
}, { profile: null, recommendations: [] });
assert.equal(
  signedGuideLabelContext.modules[0].label,
  'a review of your home-purchase affordability and savings path',
  'Manifest-owned outcome language must take precedence over a legacy formal label.'
);
assertClientOutcomeLabel(signedGuideLabelContext.modules[0].label, 'Signed guide label');

const hiddenPlanningContext = extractRealtimePlanningContext({
  planningState: {
    moduleSlots: [
      { slot: 1, moduleId: 'net_retirement_cashflow', label: 'Net retirement cash flow' },
      { slot: 2, moduleId: 'house_purchase', label: 'House Purchase' }
    ]
  }
}, { profile: null, recommendations: [] });
assert.deepEqual(
  hiddenPlanningContext.modules.map((item) => item.moduleId),
  ['house_purchase'],
  'A hidden analysis must not enter the typed Realtime planning context.'
);
assertClientOutcomeLabel(hiddenPlanningContext.modules[0].label, 'Hidden-slot boundary');

const workerFactContext = extractRealtimePlanningContext({
  planningState: {
    facts: [{
      factId: 'gross_household_income',
      value: { amount: 65000, currency: 'EUR' },
      certainty: 'approximate',
      status: 'saved_draft'
    }]
  }
}, { profile: null, recommendations: [] });
assert.equal(workerFactContext.facts[0].factId, 'gross_household_income');
assert.equal(workerFactContext.facts[0].label, 'Gross household income');
assert.equal(workerFactContext.facts[0].value, '€65,000');
assert.equal(workerFactContext.facts[0].badge.label, 'Approximate');
assert.doesNotMatch(workerFactContext.facts[0].value, /\[object Object\]/);

const authoritativeSlots = extractRealtimePlanningContext({
  planningState: {
    moduleSlots: [
      {
        slot: 1,
        moduleId: 'personal_balance_sheet',
        availability: 'adviser_review_required',
        reasons: ['This deterministic analysis is waiting for its consumer release gate.']
      },
      {
        slot: 2,
        moduleId: 'house_purchase',
        availability: 'ready',
        reasons: ['The immediate home-purchase goal requires this analysis.']
      },
      {
        slot: 3,
        moduleId: 'liquidity_analysis',
        availability: 'needs_facts',
        reasons: ['More confirmed information is required.']
      }
    ],
    recommendations: [
      { moduleId: 'mortgage_analysis', status: 'recommended' },
      { moduleId: 'college_funding', status: 'recommended' }
    ]
  }
}, { profile: null, recommendations: [] });
assert.deepEqual(
  authoritativeSlots.modules.map((item) => item.moduleId),
  ['personal_balance_sheet', 'house_purchase', 'liquidity_analysis'],
  'The companion must render the Worker-authoritative plan slots, not the broader recommendation list.'
);
assert.equal(authoritativeSlots.modules[0].badge.label, 'Gerry review');
assert.equal(authoritativeSlots.modules[1].badge.label, 'Released');
assert.equal(authoritativeSlots.modules[2].badge.label, 'Needs information');
assert.deepEqual(
  authoritativeSlots.modules.map((item) => item.label),
  [
    'a review of your overall financial picture',
    'a review of your home-purchase affordability and savings path',
    'a review of your accessible cash and emergency reserves'
  ]
);
authoritativeSlots.modules.forEach((item) => {
  assertClientOutcomeLabel(item.label, `Authoritative typed label for ${item.moduleId}`);
});

const pristineProfileContext = extractRealtimePlanningContext({}, {
  profile: {
    primaryPerson: { personId: 'primary', role: 'primary', employmentStatus: 'unknown' },
    preferences: { baseCurrency: 'EUR', riskDiscussionCompleted: false },
    assumptions: { calculationDateIso: '2026-07-14', values: { persona: {} } },
    fieldMetadata: {}
  },
  recommendations: []
});
assert.equal(
  pristineProfileContext.facts.length,
  0,
  'System identifiers and default policy/calculation values must not appear as facts Planéir understood.'
);
const userSuppliedProfileContext = extractRealtimePlanningContext({}, {
  profile: {
    primaryPerson: { age: 38 },
    fieldMetadata: {
      '/primaryPerson/age': {
        source: 'consumer_edit', certainty: 'exact', confirmedByUser: false
      }
    }
  },
  recommendations: []
});
assert.equal(userSuppliedProfileContext.facts.length, 1);
assert.equal(userSuppliedProfileContext.facts[0].label, 'Age');

const independentRealtimeBootstrap = normaliseBootstrap({
  flags: {
    consumerJourneyEnabled: true,
    consumerVoiceEnabled: false,
    consumerRealtimeVoiceEnabled: true
  },
  cohort: 'adviser_test',
  voice: { enabled: false, sessionBudgetMicroEur: 0 },
  realtimeVoice: {
    enabled: true,
    noticeId: 'realtime-notice-v1',
    policyVersion: 'consumer-v1',
    privacyNoticeUrl: 'https://planeir.ie/privacy',
    sessionBudgetMicroEur: 2_000_000
  }
});
assert.equal(independentRealtimeBootstrap.voiceEnabled, false);
assert.equal(independentRealtimeBootstrap.voiceRealtimeEnabled, true);
assert.equal(independentRealtimeBootstrap.realtimeVoiceBudget.limitMicroEur, 2_000_000);

storage.set('planeir.consumer.analysis-plan-id.v1', 'realtime_plan_stale');
storage.set('planeir.consumer.analysis-plan-nonce.v1', 'plan_nonce_stale');
journeyState.session = { id: 'cs_frontend_voice_contract', currentProfileRevision: 7 };
journeyState.analysisPlan = null;
journeyState.selectedModuleIds = [];
mergePayload({
  session: { id: 'cs_frontend_voice_contract', currentProfileRevision: 7 },
  analysisPlan: {
    planId: 'realtime_plan_restored',
    moduleIds: ['house_purchase'],
    profileRevision: 7,
    status: 'prepared'
  }
});
assert.deepEqual(journeyState.selectedModuleIds, ['house_purchase']);
assert.equal(getAnalysisPlanNonce('realtime_plan_restored'), '');
assert.equal(storage.has('planeir.consumer.analysis-plan-nonce.v1'), false);
mergePayload({
  analysisPlan: {
    planId: 'realtime_plan_restored',
    planNonce: 'plan_nonce_server_issued_only',
    moduleIds: ['house_purchase'],
    profileRevision: 7,
    status: 'prepared'
  }
});
assert.equal(getAnalysisPlanNonce('realtime_plan_restored'), 'plan_nonce_server_issued_only');

const gatedViewAvailability = getAvailableViews({
  session: { currentProfileRevision: 7, confirmedProfileRevision: 7 },
  profile: { revision: 7 },
  analysis: null,
  analysisPlan: {
    profileRevision: 7,
    status: 'complete',
    moduleIds: [],
    moduleSlots: [
      { slot: 1, moduleId: 'personal_balance_sheet', availability: 'adviser_review_required' },
      { slot: 2, moduleId: 'business_owner_analysis', availability: 'adviser_review_required' },
      { slot: 3, moduleId: 'business_relief_analysis', availability: 'adviser_review_required' }
    ]
  },
  bootstrap: { handoffEnabled: true }
});
assert.equal(gatedViewAvailability.results, true, 'a completed all-gated plan has a deterministic review outcome');
assert.equal(gatedViewAvailability.handoff, true, 'the explicit consented handoff remains reachable after an all-gated plan');

const realtimeClassStates = new Map();
const realtimeControllerRoot = {
  dataset: {},
  classList: {
    toggle: (name, enabled) => realtimeClassStates.set(name, enabled === true)
  },
  querySelector: () => null
};
journeyState.bootstrap = {
  enabled: true,
  voiceRealtimeEnabled: true,
  cohort: 'adviser_test',
  voiceRealtimeMaxSeconds: 600,
  voiceRealtimePollSeconds: 20
};
journeyState.voice.realtimeBudget = {
  limitMicroEur: 2_000_000,
  spentMicroEur: 1_750_000,
  remainingMicroEur: 250_000
};
const realtimeController = new RealtimeVoiceController({ root: realtimeControllerRoot });
realtimeController.updateUi();
assert.equal(realtimeClassStates.get('is-budget-low'), true);
assert.equal(realtimeControllerRoot.dataset.budgetState, 'low');
journeyState.voice.realtimeBudget.remainingMicroEur = 350_000;
realtimeController.updateUi();
assert.equal(realtimeClassStates.get('is-budget-low'), false);
assert.equal(realtimeControllerRoot.dataset.budgetState, 'available');

storage.set('planeir.consumer.session-id.v1', 'cs_frontend_voice_contract');
journeyState.view = 'review';
realtimeController.sync(journeyState);
assert.equal(
  realtimeControllerRoot.hidden,
  false,
  'The floating companion must remain available while the consumer reviews their information.'
);
journeyState.view = 'results';
realtimeController.sync(journeyState);
assert.equal(
  realtimeControllerRoot.hidden,
  false,
  'The floating companion must remain available to present verified results.'
);
journeyState.view = 'conversation';

// Ending while device enumeration is pending must not let start() resume and
// create a peer with a stopped microphone after local privacy cleanup.
{
  const previousBootstrap = journeyState.bootstrap;
  const previousConsent = journeyState.voice.realtimeConsent;
  const previousBudget = journeyState.voice.realtimeBudget;
  const PreviousPeerConnection = window.RTCPeerConnection;
  let peerConstructions = 0;
  let microphoneStopped = false;
  let resolveRefresh;
  let markRefreshStarted;
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  const track = {
    kind: 'audio',
    label: 'Built-in microphone',
    readyState: 'live',
    getSettings: () => ({ deviceId: 'mic-one' }),
    addEventListener: () => {},
    stop: () => { microphoneStopped = true; }
  };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  try {
    journeyState.bootstrap = {
      ...previousBootstrap,
      enabled: true,
      voiceRealtimeEnabled: true,
      cohort: 'adviser_test',
      voiceRealtimeNoticeId: 'realtime-notice-start-cancel',
      voiceRealtimePolicyVersion: 'consumer-start-cancel-v1',
      voiceRealtimePrivacyNoticeUrl: 'https://planeir.ie/privacy'
    };
    journeyState.voice.realtimeConsent = {
      granted: true,
      noticeId: 'realtime-notice-start-cancel',
      policyVersion: 'consumer-start-cancel-v1'
    };
    journeyState.voice.realtimeBudget = {
      limitMicroEur: 2_000_000,
      spentMicroEur: 0,
      remainingMicroEur: 2_000_000
    };
    window.RTCPeerConnection = class TestCancelledPeerConnection {
      constructor() { peerConstructions += 1; }
    };
    const controller = new RealtimeVoiceController({ root: null });
    controller.openMicrophoneStream = async () => stream;
    controller.refreshMicrophones = () => {
      markRefreshStarted();
      return new Promise((resolve) => { resolveRefresh = resolve; });
    };
    const starting = controller.start();
    await refreshStarted;
    await controller.end({ reason: 'user', notifyServer: false, announce: false });
    resolveRefresh();
    await starting;
    assert.equal(microphoneStopped, true);
    assert.equal(peerConstructions, 0, 'Cancelled start must not create a peer after refresh resolves.');
    assert.equal(controller.localStream, null);
    assert.equal(controller.active, false);
  } finally {
    journeyState.bootstrap = previousBootstrap;
    journeyState.voice.realtimeConsent = previousConsent;
    journeyState.voice.realtimeBudget = previousBudget;
    window.RTCPeerConnection = PreviousPeerConnection;
  }
}

const remoteAudioElement = { srcObject: 'worker-controlled-audio-only' };
const remotePeerListeners = new Map();
const remoteTrackController = new RealtimeVoiceController({
  root: {
    querySelector: (selector) => selector === '#realtimeVoiceAudio' ? remoteAudioElement : null
  }
});
const remotePeer = {
  addEventListener: (type, listener) => remotePeerListeners.set(type, listener)
};
remoteTrackController.bindPeerConnection(remotePeer, remoteTrackController.generation);
const providerAudioTrack = { enabled: true };
remotePeerListeners.get('track')?.({ track: providerAudioTrack, streams: [{ id: 'provider-stream' }] });
assert.equal(providerAudioTrack.enabled, false, 'A provider audio track must be disabled before it can become audible.');
assert.equal(
  remoteAudioElement.srcObject,
  'worker-controlled-audio-only',
  'The provider media stream must never be assigned to the companion audio element.'
);
const directAudioElement = {
  srcObject: null,
  playCalls: 0,
  play() { this.playCalls += 1; return Promise.resolve(); }
};
const directPeerListeners = new Map();
const directTrackController = new RealtimeVoiceController({
  root: {
    querySelector: (selector) => selector === '#realtimeVoiceAudio' ? directAudioElement : null
  }
});
directTrackController.conversationVersion = 'v2';
directTrackController.bindPeerConnection({
  addEventListener: (type, listener) => directPeerListeners.set(type, listener)
}, directTrackController.generation);
const marinTrack = { enabled: false };
const marinStream = { id: 'direct-marin-stream' };
directPeerListeners.get('track')?.({ track: marinTrack, streams: [marinStream] });
assert.equal(marinTrack.enabled, true);
assert.equal(directAudioElement.srcObject, marinStream);
assert.equal(directAudioElement.playCalls, 1);

// V2 holds the outbound microphone track until the server-authorized Marin
// welcome completes. No click or space press can commit intake audio early.
const welcomeTrack = { kind: 'audio', enabled: true, stop: () => {} };
const welcomeController = new RealtimeVoiceController({ root: null });
welcomeController.active = true;
welcomeController.conversationVersion = 'v2';
welcomeController.localStream = {
  getAudioTracks: () => [welcomeTrack],
  getTracks: () => [welcomeTrack]
};
welcomeController.setWelcomePending(true);
assert.equal(welcomeTrack.enabled, false);
assert.equal(welcomeController.commitTurn(), false);
welcomeController.handleRealtimeEvent({ type: 'response.created' });
welcomeController.handleRealtimeEvent({ type: 'response.output_audio.delta' });
assert.equal(welcomeTrack.enabled, false, 'Client audio must remain gated while Marin is welcoming the client.');
welcomeController.handleRealtimeEvent({ type: 'output_audio_buffer.started' });
welcomeController.handleRealtimeEvent({ type: 'response.done' });
assert.equal(welcomeController.welcomePending, true, 'A completed response may still have buffered welcome audio playing.');
assert.equal(welcomeTrack.enabled, false, 'Client audio must remain gated until buffered welcome playback stops.');
welcomeController.handleRealtimeEvent({ type: 'output_audio_buffer.stopped' });
assert.equal(welcomeController.welcomePending, false);
assert.equal(welcomeTrack.enabled, true, 'Client audio must open immediately after the welcome playback stops.');
assert.equal(welcomeController.phase, 'listening');
welcomeController.cleanupLocal();

// If semantic VAD finalizes an obviously unfinished clause, the server stays
// silent and the UI should invite the client to continue instead of looking
// stuck in a thinking state.
{
  const fragmentController = new RealtimeVoiceController({ root: null });
  fragmentController.active = true;
  fragmentController.conversationVersion = 'v2';
  fragmentController.handleRealtimeEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_frontend_fragment_001',
    transcript: 'Yes, my home is'
  });
  assert.equal(fragmentController.phase, 'listening');
  assert.match(fragmentController.statusText, /finish that thought/i);
  fragmentController.handleRealtimeEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_frontend_fragment_002',
    transcript: 'worth €500,000.'
  });
  assert.equal(fragmentController.phase, 'thinking');
  fragmentController.cleanupLocal();
}

// Response ids keep a canceled question's late transcript/audio envelopes
// from becoming a ghost assistant turn after the consumer has barged in.
{
  const responseGateController = new RealtimeVoiceController({ root: null });
  responseGateController.active = true;
  responseGateController.conversationVersion = 'v2';
  responseGateController.handleRealtimeEvent({
    type: 'response.created',
    response: { id: 'response_frontend_old_001' }
  });
  responseGateController.handleRealtimeEvent({
    type: 'response.output_audio_transcript.delta',
    response_id: 'response_frontend_old_001',
    item_id: 'item_frontend_old_001',
    delta: 'Do you own your home?'
  });
  responseGateController.handleRealtimeEvent({ type: 'input_audio_buffer.speech_started' });
  responseGateController.handleRealtimeEvent({
    type: 'response.output_audio_transcript.done',
    response_id: 'response_frontend_old_001',
    item_id: 'item_frontend_old_001',
    transcript: 'Do you own your home, and if so, roughly what is it worth?'
  });
  assert.deepEqual(responseGateController.transcriptHistory, []);

  responseGateController.handleRealtimeEvent({
    type: 'response.created',
    response: { id: 'response_frontend_current_002' }
  });
  responseGateController.handleRealtimeEvent({
    type: 'response.output_audio_transcript.done',
    response_id: 'response_frontend_old_001',
    item_id: 'item_frontend_old_001',
    transcript: 'A late canceled response must remain ignored.'
  });
  responseGateController.handleRealtimeEvent({
    type: 'response.output_audio_transcript.done',
    response_id: 'response_frontend_current_002',
    item_id: 'item_frontend_current_002',
    transcript: 'Thanks. Let’s move on to your pension.'
  });
  assert.deepEqual(responseGateController.transcriptHistory, [{
    role: 'assistant',
    text: 'Thanks. Let’s move on to your pension.'
  }]);
  responseGateController.handleRealtimeEvent({
    type: 'response.done',
    response: { id: 'response_frontend_old_001', status: 'cancelled' }
  });
  assert.equal(responseGateController.responseInProgress, true);
  assert.equal(responseGateController.activeResponseId, 'response_frontend_current_002');
  responseGateController.handleRealtimeEvent({
    type: 'response.done',
    response: { id: 'response_frontend_current_002', status: 'completed' }
  });
  assert.equal(responseGateController.responseInProgress, false);
  assert.equal(responseGateController.activeResponseId, '');
  responseGateController.cleanupLocal();
}

// Once the server authorizes the completion outro, microphone controls and
// competing meeting actions remain locked until playback ends (or times out).
{
  const completionTrack = { kind: 'audio', enabled: true, stop: () => {} };
  const startButton = { setAttribute: () => {} };
  const muteButton = { setAttribute: () => {} };
  const endButton = {};
  const reviewButton = {};
  const microphoneSelect = {};
  const refreshButton = {};
  const completionElements = new Map([
    ['#realtimeVoiceStartButton', startButton],
    ['#realtimeVoiceMuteButton', muteButton],
    ['#realtimeVoiceEndButton', endButton],
    ['#realtimeVoiceReviewButton', reviewButton],
    ['#realtimeVoiceMicrophoneSelect', microphoneSelect],
    ['#realtimeVoiceRefreshDevicesButton', refreshButton]
  ]);
  const completionController = new RealtimeVoiceController({
    root: {
      dataset: {},
      classList: { toggle: () => {} },
      querySelector: (selector) => completionElements.get(selector) || null
    }
  });
  completionController.active = true;
  completionController.localStream = {
    getAudioTracks: () => [completionTrack],
    getTracks: () => [completionTrack]
  };
  completionController.selectedMicrophoneId = 'mic-one';
  completionController.beginCompletionPlayback({
    outroSpeechId: 'speech_completion_frontend_lock_123456'
  });
  assert.equal(completionTrack.enabled, false);
  assert.equal(completionController.muted, true);
  completionController.toggleMute();
  assert.equal(completionController.muted, true, 'The outro lock must not allow the microphone to be unmuted.');
  assert.equal(completionController.commitTurn(), false);
  assert.equal(await completionController.selectMicrophone('mic-two'), false);
  assert.equal(completionController.selectedMicrophoneId, 'mic-one');
  assert.equal(startButton.disabled, true);
  assert.equal(muteButton.disabled, true);
  assert.equal(endButton.disabled, true);
  assert.equal(reviewButton.disabled, true);
  assert.equal(microphoneSelect.disabled, true);
  assert.equal(refreshButton.disabled, true);
  completionController.cleanupLocal();
}

const sentRealtimeEvents = [];
realtimeController.active = true;
realtimeController.responseInProgress = true;
realtimeController.phase = 'assistant_speaking';
realtimeController.dataChannel = {
  readyState: 'open',
  send: (value) => sentRealtimeEvents.push(JSON.parse(value)),
  close: () => {}
};
realtimeController.handleRealtimeEvent({ type: 'input_audio_buffer.speech_started' });
assert.equal(sentRealtimeEvents.length, 0);
assert.equal(realtimeController.phase, 'interrupted');
assert.notEqual(realtimeController.interruptTimer, null);
realtimeController.handleRealtimeEvent({ type: 'input_audio_buffer.speech_stopped' });
assert.equal(realtimeController.interruptTimer, null);
assert.equal(realtimeController.phase, 'thinking');
realtimeController.handleRealtimeEvent({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: 'item_empty_audio',
  transcript: ''
});
assert.equal(
  realtimeController.phase,
  'listening',
  'An empty finalized transcript must invite a microphone retry instead of looking stuck or disconnected.'
);
realtimeController.handleRealtimeEvent({
  type: 'conversation.item.input_audio_transcription.failed',
  item_id: 'item_failed_audio',
  error: { type: 'transcription_error', message: 'Audio was unintelligible.' }
});
assert.equal(
  realtimeController.phase,
  'listening',
  'An item-scoped transcription failure must remain retryable instead of presenting a lost connection.'
);
realtimeController.handleRealtimeEvent({ type: 'response.created' });
realtimeController.handleRealtimeEvent({ type: 'response.done' });
assert.equal(realtimeController.phase, 'thinking');
realtimeController.handleRealtimeEvent({
  type: 'conversation.item.created',
  item: {
    type: 'function_call_output',
    output: JSON.stringify({ ok: true, response_text: '', require_repeat_verbatim: false })
  }
});
assert.equal(
  realtimeController.phase,
  'listening',
  'An explicit wait_for_user result must settle without waiting for Worker speech that will not exist.'
);
assert.equal(realtimeController.awaitingWorkerSpeech, false);
realtimeController.handleRealtimeEvent({ type: 'response.created' });
realtimeController.handleRealtimeEvent({ type: 'response.done' });
realtimeController.handleRealtimeEvent({
  type: 'conversation.item.done',
  item: {
    type: 'function_call_output',
    output: JSON.stringify({ ok: true, moduleSlots: [] })
  }
});
assert.equal(
  realtimeController.phase,
  'listening',
  'A final tool result whose Worker speech authorization failed must not leave the orb thinking forever.'
);
assert.equal(realtimeController.awaitingWorkerSpeech, false);
realtimeController.cleanupLocal();

const floatingPanel = { hidden: true };
const floatingBackdrop = { hidden: true };
const floatingLauncherAttributes = new Map();
const floatingLauncher = {
  setAttribute: (name, value) => floatingLauncherAttributes.set(name, value),
  focus: () => {}
};
const floatingElements = new Map([
  ['#realtimeVoiceShell', floatingPanel],
  ['#realtimeVoiceBackdrop', floatingBackdrop],
  ['#realtimeVoiceLauncher', floatingLauncher]
]);
const floatingRoot = {
  hidden: false,
  classList: { toggle: () => {} },
  querySelector: (selector) => floatingElements.get(selector) || null
};
const floatingController = new RealtimeVoiceController({ root: floatingRoot });
floatingController.active = true;
floatingController.openCompanion({ focus: false });
assert.equal(floatingController.expanded, true);
assert.equal(floatingPanel.hidden, false);
assert.equal(floatingBackdrop.hidden, false);
assert.equal(floatingLauncherAttributes.get('aria-expanded'), 'true');
floatingController.collapseCompanion({ restoreFocus: false });
assert.equal(floatingController.expanded, false);
assert.equal(floatingPanel.hidden, true);
assert.equal(floatingBackdrop.hidden, true);
assert.equal(floatingLauncherAttributes.get('aria-expanded'), 'false');
assert.equal(floatingController.active, true, 'Minimising the companion must keep the active microphone lifecycle intact.');

let fallbackView = '';
const fallbackController = new RealtimeVoiceController({
  root: floatingRoot,
  onNavigate: (view) => { fallbackView = view; }
});
fallbackController.focusComposer();
assert.equal(fallbackView, 'conversation', 'Type instead must return to the written conversation from review or results.');
fallbackView = '';
fallbackController.focusBoundedVoice();
assert.equal(fallbackView, 'conversation', 'The bounded voice fallback must return to the conversation before focusing its controls.');

storage.set('planeir.consumer.credential.v1', 'cs_frontend_voice_contract.test-secret');
const { transcribeVoice } = await import('../js/plan/api.js');
const originalFetch = globalThis.fetch;
let capturedVoiceRequest = null;
try {
  globalThis.fetch = async (url, init) => {
    capturedVoiceRequest = { url: String(url), init };
    return new Response(JSON.stringify({ transcript: 'Review this transcript.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const rawAudio = new Blob([new Uint8Array([1, 2, 3, 4])], {
    type: 'audio/ogg;codecs=opus'
  });
  await transcribeVoice('cs_frontend_voice_contract', {
    audio: rawAudio,
    durationMs: 1_234,
    idempotencyKey: 'voice-frontend-contract-0001'
  });
  assert.equal(capturedVoiceRequest?.url, 'http://127.0.0.1:8787/api/consumer/sessions/cs_frontend_voice_contract/voice/transcriptions');
  assert.equal(capturedVoiceRequest?.init?.body, rawAudio);
  const rawHeaders = new Headers(capturedVoiceRequest?.init?.headers);
  assert.equal(rawHeaders.get('content-type'), 'audio/ogg;codecs=opus');
  assert.equal(rawHeaders.get('x-voice-duration-ms'), '1234');
  assert.equal(rawHeaders.get('x-voice-request-id'), 'voice-frontend-contract-0001');
  assert.equal(rawHeaders.get('content-length'), null, 'Browser code must not try to set the forbidden Content-Length header.');
  assert.equal(rawHeaders.get('x-consumer-session'), 'cs_frontend_voice_contract.test-secret');
} finally {
  globalThis.fetch = originalFetch;
}

const {
  createRealtimeVoiceCall,
  deleteRealtimeVoiceActivation,
  deleteRealtimeVoiceCall,
  getRealtimeVoiceCall,
  speakRealtimeAuthorized
} = await import('../js/plan/api.js');
const realtimeRequests = [];
const apiControlCapability = `rt_control_${'A'.repeat(24)}`;
const apiActivationId = `rt_activation_${'B'.repeat(24)}`;
try {
  globalThis.fetch = async (url, init) => {
    realtimeRequests.push({ url: String(url), init });
    if (String(url).endsWith('/speech')) {
      return new Response(new Uint8Array([73, 68, 51]), {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
          'X-Realtime-Speech-Id': 'speech_api_contract_1234567890'
        }
      });
    }
    if (String(url).includes('/voice/realtime/activations/')) {
      return new Response(JSON.stringify({
        cleanedUp: true,
        leaseFound: false,
        leaseClosed: false,
        providerHangupConfirmed: true
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init.method === 'POST') {
      return new Response('v=0\r\no=- 4 5 IN IP4 127.0.0.1\r\n', {
        status: 200,
        headers: {
          'Content-Type': 'application/sdp',
          'X-Voice-Lease-Id': 'rt_api_contract_001',
          'X-Realtime-Activation-Id': apiActivationId,
          'X-Realtime-Control-Capability': apiControlCapability
        }
      });
    }
    return new Response(JSON.stringify({ lease: { id: 'rt_api_contract_001', status: 'active' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const offerSdp = 'v=0\r\no=- 7 8 IN IP4 127.0.0.1\r\n';
  const created = await createRealtimeVoiceCall('cs_frontend_voice_contract', {
    sdp: offerSdp,
    idempotencyKey: 'voice-realtime-contract-0001',
    activationId: apiActivationId,
    controlCapability: apiControlCapability
  });
  assert.match(created.body, /^v=0/);
  await getRealtimeVoiceCall('cs_frontend_voice_contract', 'rt_api_contract_001', {
    controlCapability: apiControlCapability
  });
  await deleteRealtimeVoiceCall('cs_frontend_voice_contract', 'rt_api_contract_001', {
    controlCapability: apiControlCapability
  });
  const speechAuthorization = {
    speechId: 'speech_api_contract_1234567890',
    kind: 'question',
    profileRevision: 7,
    bindingId: 'tool_attempt_api_contract_001',
    text: 'What would you like help planning first?',
    token: 'signed_api_contract_token_1234567890',
    controlId: `realtime_control_${'D'.repeat(24)}`,
    expiresAt: '2030-01-01T00:00:00.000Z'
  };
  const speechResponse = await speakRealtimeAuthorized(
    'cs_frontend_voice_contract',
    'rt_api_contract_001',
    speechAuthorization,
    { controlCapability: apiControlCapability }
  );
  assert.equal(speechResponse.contentType, 'audio/mpeg');
  assert.equal(typeof speechResponse.stream?.getReader, 'function');
  await speechResponse.stream.cancel('frontend_contract_complete');
  assert.equal(realtimeRequests[0].url, 'http://127.0.0.1:8787/api/consumer/sessions/cs_frontend_voice_contract/voice/realtime/calls');
  assert.equal(realtimeRequests[0].init.body, offerSdp);
  const realtimeHeaders = new Headers(realtimeRequests[0].init.headers);
  assert.equal(realtimeHeaders.get('content-type'), 'application/sdp');
  assert.equal(realtimeHeaders.get('x-consumer-session'), 'cs_frontend_voice_contract.test-secret');
  assert.equal(realtimeHeaders.get('x-realtime-activation-id'), apiActivationId);
  assert.equal(realtimeHeaders.get('x-realtime-control-capability'), apiControlCapability);
  assert.equal(realtimeRequests[1].url, 'http://127.0.0.1:8787/api/consumer/sessions/cs_frontend_voice_contract/voice/realtime/calls/rt_api_contract_001');
  assert.equal(realtimeRequests[1].init.method, 'GET');
  assert.equal(new Headers(realtimeRequests[1].init.headers).get('x-realtime-control-capability'), apiControlCapability);
  assert.equal(realtimeRequests[2].init.method, 'DELETE');
  assert.equal(
    realtimeRequests[3].url,
    'http://127.0.0.1:8787/api/consumer/sessions/cs_frontend_voice_contract/voice/realtime/calls/rt_api_contract_001/speech'
  );
  assert.equal(realtimeRequests[3].init.method, 'POST');
  assert.deepEqual(JSON.parse(realtimeRequests[3].init.body), speechAuthorization);
  const activationCleanup = await deleteRealtimeVoiceActivation(
    'cs_frontend_voice_contract',
    apiActivationId,
    { controlCapability: apiControlCapability }
  );
  assert.equal(activationCleanup.providerHangupConfirmed, true);
  assert.match(realtimeRequests[4].url, /\/voice\/realtime\/activations\/rt_activation_/);
  assert.equal(realtimeRequests[4].init.method, 'DELETE');
  assert.equal(
    new Headers(realtimeRequests[4].init.headers).get('x-realtime-control-capability'),
    apiControlCapability
  );
} finally {
  globalThis.fetch = originalFetch;
}

// End voice must make the microphone inert immediately while retaining the
// WebRTC transport until the Worker confirms its authoritative provider
// hangup. Closing the peer before DELETE races OpenAI's active-call endpoint.
let resolveEndVoiceRequest;
let endVoiceRequest = null;
let endVoicePeerClosed = false;
let endVoiceChannelClosed = false;
let endVoiceTrackStopped = false;
const endVoiceController = new RealtimeVoiceController({ root: null });
endVoiceController.active = true;
endVoiceController.sessionId = 'cs_frontend_voice_contract';
endVoiceController.leaseId = 'rt_api_contract_001';
endVoiceController.controlCapability = apiControlCapability;
endVoiceController.peerConnection = { close: () => { endVoicePeerClosed = true; } };
endVoiceController.dataChannel = { close: () => { endVoiceChannelClosed = true; } };
endVoiceController.localStream = {
  getTracks: () => [{ stop: () => { endVoiceTrackStopped = true; } }]
};
try {
  globalThis.fetch = (url, init) => {
    endVoiceRequest = { url: String(url), init };
    return new Promise((resolve) => { resolveEndVoiceRequest = resolve; });
  };
  const endVoicePromise = endVoiceController.end({ reason: 'user' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(endVoiceTrackStopped, true, 'End voice must stop microphone capture before awaiting the Worker.');
  assert.equal(endVoicePeerClosed, false, 'The peer must remain active until server hangup is confirmed.');
  assert.equal(endVoiceChannelClosed, false, 'The event channel must remain active until server hangup is confirmed.');
  assert.equal(endVoiceRequest?.init?.method, 'DELETE');
  resolveEndVoiceRequest(new Response(JSON.stringify({
    realtimeLease: { id: 'rt_api_contract_001', status: 'complete' },
    providerHangupConfirmed: true
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  }));
  await endVoicePromise;
  assert.equal(endVoicePeerClosed, true, 'The peer must close after server hangup is confirmed.');
  assert.equal(endVoiceChannelClosed, true, 'The event channel must close after server hangup is confirmed.');
} finally {
  globalThis.fetch = originalFetch;
  endVoiceController.cleanupLocal();
}

let phaseWhenApprovedPlaybackStarted = '';
const approvedAudio = {
  dataset: {},
  muted: true,
  paused: true,
  src: '',
  srcObject: 'must-be-cleared-before-playback',
  onended: null,
  onerror: null,
  playCalls: 0,
  pauseCalls: 0,
  async play() {
    this.playCalls += 1;
    phaseWhenApprovedPlaybackStarted = approvedController.phase;
    this.paused = false;
  },
  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  },
  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
};
const approvedCaption = { textContent: '' };
const approvedResumeButton = { hidden: true };
const approvedElements = new Map([
  ['#realtimeVoiceAudio', approvedAudio],
  ['#realtimeVoiceAssistantCaption', approvedCaption],
  ['#realtimeVoiceResumeAudioButton', approvedResumeButton]
]);
const approvedRoot = {
  dataset: {},
  classList: { toggle: () => {} },
  querySelector: (selector) => approvedElements.get(selector) || null
};
const approvedController = new RealtimeVoiceController({ root: approvedRoot });
approvedController.active = true;
approvedController.sessionId = 'cs_frontend_voice_contract';
approvedController.leaseId = 'rt_api_contract_001';
approvedController.controlCapability = `rt_control_${'P'.repeat(24)}`;
approvedController.scheduleLeasePoll = () => {};
const approvedSpeech = {
  speechId: 'speech_frontend_playback_123456',
  kind: 'question',
  profileRevision: 7,
  bindingId: 'tool_attempt_frontend_001',
  text: 'What would you like help planning first?',
  token: 'signed_frontend_contract_token_1234567890',
  controlId: `realtime_control_${'F'.repeat(24)}`,
  expiresAt: '2030-01-01T00:00:00.000Z'
};
const originalWindowUrl = window.URL;
const controlledSpeechRequests = [];
const revokedSpeechUrls = [];
try {
  window.URL = {
    createObjectURL: (blob) => {
      assert.ok(blob instanceof Blob);
      return 'blob:worker-controlled-speech';
    },
    revokeObjectURL: (url) => revokedSpeechUrls.push(url)
  };
  globalThis.fetch = async (url, init) => {
    controlledSpeechRequests.push({ url: String(url), init });
    const requestedSpeechId = JSON.parse(init.body).speechId;
    return new Response(new Uint8Array([73, 68, 51]), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'X-Realtime-Speech-Id': requestedSpeechId
      }
    });
  };
  await approvedController.playWorkerSpeechFromPayload({ assistantSpeech: approvedSpeech });
  assert.equal(
    controlledSpeechRequests.length,
    0,
    'A provider-mirrored sideband payload must never authorize browser speech.'
  );
  approvedController.handleRealtimeEvent({ type: 'response.created' });
  approvedController.handleRealtimeEvent({ type: 'response.done' });
  assert.equal(
    approvedController.phase,
    'thinking',
    'A silent provider response must not flash back to listening while authenticated Worker speech is pending.'
  );
  assert.equal(approvedController.awaitingWorkerSpeech, true);
  const approvedPlayback = approvedController.playWorkerSpeechFromPayload({
    realtimeControl: { type: 'authorized_speech', assistantSpeech: approvedSpeech }
  });
  assert.equal(
    approvedController.phase,
    'responding',
    'Authenticated Worker speech must expose a distinct preparing-to-respond phase before playback.'
  );
  await approvedPlayback;
  assert.equal(controlledSpeechRequests.length, 1);
  assert.match(controlledSpeechRequests[0].url, /\/rt_api_contract_001\/speech$/);
  assert.deepEqual(JSON.parse(controlledSpeechRequests[0].init.body), approvedSpeech);
  assert.equal(approvedAudio.srcObject, null);
  assert.equal(approvedAudio.src, 'blob:worker-controlled-speech');
  assert.equal(approvedAudio.muted, false);
  assert.equal(approvedAudio.playCalls, 1);
  assert.equal(approvedAudio.dataset.controlledSpeechId, approvedSpeech.speechId);
  assert.equal(approvedAudio.dataset.controlledSpeechPlayed, 'true');
  assert.equal(
    phaseWhenApprovedPlaybackStarted,
    'responding',
    'The speaking phase must not begin until audio.play() has succeeded.'
  );
  assert.equal(approvedCaption.textContent, approvedSpeech.text);
  assert.deepEqual(approvedController.transcriptHistory, [{ role: 'assistant', text: approvedSpeech.text }]);
  assert.equal(approvedController.phase, 'assistant_speaking');

  approvedController.handleRealtimeEvent({ type: 'input_audio_buffer.speech_started' });
  assert.equal(approvedAudio.paused, true, 'Barge-in must stop the separately generated speech audio.');
  assert.equal(approvedAudio.src, '');
  assert.equal(approvedAudio.srcObject, null);
  assert.equal(approvedController.currentControlledSpeech, null);
  assert.equal(approvedController.phase, 'interrupted');
  assert.deepEqual(revokedSpeechUrls, ['blob:worker-controlled-speech']);

  const blockedResumeButton = { hidden: true };
  const blockedAudio = {
    dataset: {},
    muted: true,
    paused: true,
    src: '',
    srcObject: null,
    pause() { this.paused = true; },
    async play() { throw new Error('autoplay blocked'); },
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  };
  const blockedController = new RealtimeVoiceController({
    root: {
      dataset: {},
      classList: { toggle: () => {} },
      querySelector: (selector) => new Map([
        ['#realtimeVoiceAudio', blockedAudio],
        ['#realtimeVoiceAssistantCaption', { textContent: '' }],
        ['#realtimeVoiceResumeAudioButton', blockedResumeButton]
      ]).get(selector) || null
    }
  });
  blockedController.active = true;
  blockedController.sessionId = 'cs_frontend_voice_contract';
  blockedController.leaseId = 'rt_api_contract_001';
  blockedController.controlCapability = `rt_control_${'B'.repeat(24)}`;
  const blockedSpeech = {
    ...approvedSpeech,
    speechId: 'speech_frontend_autoplay_blocked_123456',
    bindingId: 'speech_binding_autoplay_blocked_123456',
    controlId: `realtime_control_${'C'.repeat(24)}`,
    token: `${'U'.repeat(43)}`
  };
  await blockedController.playWorkerSpeechFromPayload({
    realtimeControl: { type: 'authorized_speech', assistantSpeech: blockedSpeech }
  });
  assert.equal(
    blockedController.phase,
    'responding',
    'Autoplay rejection must remain ready-to-respond instead of claiming audio is playing.'
  );
  assert.equal(blockedResumeButton.hidden, false);
  blockedController.cleanupLocal();

  const deferredPlayback = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };
  const controlledPlaybackHarness = ({ speechId, play }) => {
    const resumeButton = { hidden: true };
    const audio = {
      dataset: {},
      muted: true,
      paused: true,
      src: '',
      srcObject: null,
      onended: null,
      onerror: null,
      playCalls: 0,
      play() {
        this.playCalls += 1;
        this.paused = false;
        return play(this.playCalls);
      },
      pause() { this.paused = true; },
      removeAttribute(name) { if (name === 'src') this.src = ''; }
    };
    const elements = new Map([
      ['#realtimeVoiceAudio', audio],
      ['#realtimeVoiceAssistantCaption', { textContent: '' }],
      ['#realtimeVoiceResumeAudioButton', resumeButton]
    ]);
    const controller = new RealtimeVoiceController({
      root: {
        dataset: {},
        classList: { toggle: () => {} },
        querySelector: (selector) => elements.get(selector) || null
      }
    });
    controller.active = true;
    controller.sessionId = 'cs_frontend_voice_contract';
    controller.leaseId = 'rt_api_contract_001';
    controller.controlCapability = `rt_control_${'R'.repeat(24)}`;
    controller.scheduleLeasePoll = () => {};
    return {
      audio,
      controller,
      resumeButton,
      speech: {
        ...approvedSpeech,
        speechId,
        bindingId: `binding_${speechId}`,
        controlId: `realtime_control_${'S'.repeat(24)}`,
        token: `${'V'.repeat(43)}`
      }
    };
  };
  const waitForPlaybackAttempt = async (audio) => {
    for (let attempt = 0; attempt < 10 && audio.playCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(audio.playCalls, 1, 'The controlled audio play attempt must start before teardown.');
  };

  // A play promise may settle after barge-in. Its stale continuation must not
  // restore the speaking phase or controlled-speech ownership markers.
  {
    const pendingPlay = deferredPlayback();
    const harness = controlledPlaybackHarness({
      speechId: 'speech_initial_play_resolve_teardown_123456',
      play: () => pendingPlay.promise
    });
    const playback = harness.controller.playWorkerSpeechFromPayload({
      realtimeControl: { type: 'authorized_speech', assistantSpeech: harness.speech }
    });
    await waitForPlaybackAttempt(harness.audio);
    harness.controller.handleRealtimeEvent({ type: 'input_audio_buffer.speech_started' });
    pendingPlay.resolve();
    await playback;
    assert.equal(harness.controller.phase, 'interrupted');
    assert.equal(harness.controller.currentControlledSpeech, null);
    assert.equal(harness.audio.dataset.controlledSpeechId, undefined);
    assert.equal(harness.audio.dataset.controlledSpeechPlayed, undefined);
    harness.controller.cleanupLocal();
  }

  // A late rejection after the meeting ends must not turn the settled off
  // state back into a playback error or expose a stale resume button.
  {
    const pendingPlay = deferredPlayback();
    const harness = controlledPlaybackHarness({
      speechId: 'speech_initial_play_reject_teardown_123456',
      play: () => pendingPlay.promise
    });
    const playback = harness.controller.playWorkerSpeechFromPayload({
      realtimeControl: { type: 'authorized_speech', assistantSpeech: harness.speech }
    });
    await waitForPlaybackAttempt(harness.audio);
    await harness.controller.end({ notifyServer: false, announce: false });
    pendingPlay.reject(new Error('play rejected after teardown'));
    await playback;
    assert.equal(harness.controller.phase, 'off');
    assert.equal(harness.resumeButton.hidden, true);
  }

  // Resume playback has the same asynchronous ownership boundary. Cover both
  // late success and late rejection after the live meeting has ended.
  for (const outcome of ['resolve', 'reject']) {
    const pendingResume = deferredPlayback();
    const harness = controlledPlaybackHarness({
      speechId: `speech_resume_${outcome}_teardown_123456`,
      play: (attempt) => (attempt === 1
        ? Promise.reject(new Error('initial autoplay blocked'))
        : pendingResume.promise)
    });
    await harness.controller.playWorkerSpeechFromPayload({
      realtimeControl: { type: 'authorized_speech', assistantSpeech: harness.speech }
    });
    assert.equal(harness.controller.phase, 'responding');
    assert.equal(harness.resumeButton.hidden, false);
    const resumed = harness.controller.resumeAudio();
    assert.equal(harness.audio.playCalls, 2);
    await harness.controller.end({ notifyServer: false, announce: false });
    if (outcome === 'resolve') pendingResume.resolve();
    else pendingResume.reject(new Error('resume rejected after teardown'));
    await resumed;
    assert.equal(harness.controller.phase, 'off');
    assert.equal(harness.resumeButton.hidden, true);
    assert.equal(harness.audio.dataset.controlledSpeechId, undefined);
  }
} finally {
  approvedController.cleanupLocal();
  window.URL = originalWindowUrl;
  globalThis.fetch = originalFetch;
}

// Barge-in while MediaSource is still appending the first chunk must cancel
// the stale continuation before it can call play or replace newer speech.
{
  const originalMediaSource = window.MediaSource;
  const originalUrl = window.URL;
  let sourceBuffer = null;
  class DelayedSourceBuffer extends EventTarget {
    constructor() {
      super();
      this.chunks = [];
    }

    appendBuffer(chunk) {
      this.chunks.push([...chunk]);
    }
  }
  class DelayedMediaSource extends EventTarget {
    static isTypeSupported(type) { return type === 'audio/mpeg'; }

    constructor() {
      super();
      this.readyState = 'closed';
      queueMicrotask(() => {
        this.readyState = 'open';
        this.dispatchEvent(new Event('sourceopen'));
      });
    }

    addSourceBuffer() {
      sourceBuffer = new DelayedSourceBuffer();
      return sourceBuffer;
    }

    endOfStream() { this.readyState = 'ended'; }
  }
  const streamingAudio = {
    dataset: {},
    muted: true,
    paused: true,
    src: '',
    srcObject: null,
    playCalls: 0,
    pause() { this.paused = true; },
    async play() { this.playCalls += 1; this.paused = false; },
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  };
  const streamingCaption = { textContent: '' };
  const streamingRoot = {
    dataset: {},
    classList: { toggle: () => {} },
    querySelector: (selector) => new Map([
      ['#realtimeVoiceAudio', streamingAudio],
      ['#realtimeVoiceAssistantCaption', streamingCaption],
      ['#realtimeVoiceResumeAudioButton', { hidden: true }]
    ]).get(selector) || null
  };
  const streamingController = new RealtimeVoiceController({ root: streamingRoot });
  streamingController.active = true;
  streamingController.sessionId = 'cs_frontend_voice_contract';
  streamingController.leaseId = 'rt_api_contract_001';
  streamingController.controlCapability = `rt_control_${'M'.repeat(24)}`;
  const streamingSpeech = {
    ...approvedSpeech,
    speechId: 'speech_media_source_abort_123456',
    bindingId: 'speech_binding_media_source_abort_123456',
    controlId: `realtime_control_${'N'.repeat(24)}`,
    token: `${'T'.repeat(43)}`,
    text: 'This caption remains available even when streaming playback is interrupted.'
  };
  try {
    window.MediaSource = DelayedMediaSource;
    window.URL = {
      createObjectURL: () => 'blob:media-source-speech',
      revokeObjectURL: () => {}
    };
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([73, 68, 51]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      }
    }), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'X-Realtime-Speech-Id': streamingSpeech.speechId
      }
    });
    const playback = streamingController.playWorkerSpeechFromPayload({
      realtimeControl: { type: 'authorized_speech', assistantSpeech: streamingSpeech }
    });
    for (let attempt = 0; attempt < 10 && !sourceBuffer?.chunks.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.deepEqual(sourceBuffer?.chunks[0], [73, 68, 51]);
    assert.equal(streamingCaption.textContent, streamingSpeech.text);
    streamingController.handleRealtimeEvent({ type: 'input_audio_buffer.speech_started' });
    await playback;
    assert.equal(streamingAudio.playCalls, 0, 'Interrupted first-chunk append must never resume stale audio.');
    assert.equal(streamingAudio.src, '');
    assert.equal(streamingController.currentControlledSpeech, null);
  } finally {
    streamingController.cleanupLocal();
    window.MediaSource = originalMediaSource;
    window.URL = originalUrl;
    globalThis.fetch = originalFetch;
  }
}

mergeVoicePayload({
  realtimeConsent: {
    granted: true,
    noticeId: 'realtime-voice-adviser-test-v2',
    policyVersion: 'consumer-adviser-test-v1'
  }
});
assert.deepEqual(journeyState.voice.realtimeConsent, {
  granted: true,
  noticeId: 'realtime-voice-adviser-test-v2',
  policyVersion: 'consumer-adviser-test-v1'
}, 'The Worker realtimeConsent response must immediately unlock the visible Live voice flow.');

console.log('Consumer bounded and controlled-realtime voice lifecycle, SDP, speech authorization, transcript, planning-context, and accessibility checks passed.');
