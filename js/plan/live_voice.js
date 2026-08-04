/**
 * The live lane's browser controller.
 *
 * WHAT IS ABSENT, AND WHY
 *
 * `realtime_voice.js` is 3,147 lines. Most of what it does exists to service
 * the v2 lane's authority model, and none of it applies here:
 *
 *   - the provider-event allowlist, and the `conversation_item_injected`
 *     failure mode it produced. The field note in
 *     docs/consumer-realtime-voice-operations.md records that killing an
 *     entire live canary: gpt-realtime intermittently adds an assistant
 *     message alongside a mandated tool call, and the strict allowlist tore
 *     the meeting down on every real turn. This lane does not police provider
 *     events, so it cannot die that way.
 *   - Worker-owned TTS playback (`playWorkerSpeechFromPayload`,
 *     `attachControlledSpeechAudio`, MediaSource chunking). The model speaks
 *     directly over WebRTC.
 *   - the "I've finished" tap/space control. With `create_response: true` the
 *     provider decides when a turn ends; there is nothing to force.
 *   - welcome-pending microphone gating, lease polling for authorized speech,
 *     and the delta/seen-item bookkeeping that supports them.
 *
 * DELIBERATE MVP SIMPLIFICATION, STATED PLAINLY: this uses the default
 * microphone. The v2 controller carries ~150 lines of device enumeration,
 * saved preference and Continuity-camera heuristics. That is real work worth
 * porting before a public release; it is not what makes or breaks a demo, and
 * duplicating it now would mean maintaining two copies of it.
 */

import { createRealtimeVoiceCall, getSession } from './api.js';
import { RealtimeOrb } from './realtime_orb.js';
import {
  extractRealtimePlanningContext,
  isRealtimeVoiceSupported,
  normaliseRealtimeCallResponse
} from './realtime_voice.js';

const MAX_CAPTION_LENGTH = 3_000;
const MAX_TRANSCRIPT_ITEMS = 500;
// After the agent finishes speaking, refresh the session so newly saved drafts
// appear on screen. Short enough to feel live, long enough not to hammer the
// Worker while someone is mid-sentence.
const STATE_REFRESH_DELAY_MS = 400;

function cleanText(value, maximum = MAX_CAPTION_LENGTH) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > maximum ? text.slice(0, maximum) : text;
}

function newPrivateId(prefix) {
  const bytes = new Uint8Array(18);
  (window.crypto || {}).getRandomValues?.(bytes);
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return `${prefix}_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function stopTracks(stream) {
  stream?.getTracks?.().forEach((track) => {
    try { track.stop(); } catch (_error) { /* already stopped */ }
  });
}

export class LiveVoiceController {
  constructor({
    root,
    onVoicePayload = () => {},
    onPlanningPayload = () => {},
    onNavigate = () => {},
    onStopBoundedVoice = () => {},
    onToast = () => {},
    onSessionUnavailable = () => {}
  } = {}) {
    this.root = root || null;
    this.onVoicePayload = onVoicePayload;
    this.onPlanningPayload = onPlanningPayload;
    this.onNavigate = onNavigate;
    this.onStopBoundedVoice = onStopBoundedVoice;
    this.onToast = onToast;
    this.onSessionUnavailable = onSessionUnavailable;

    this.active = false;
    this.generation = 0;
    this.sessionId = '';
    this.leaseId = '';
    this.controlCapability = '';
    this.peerConnection = null;
    this.dataChannel = null;
    this.localStream = null;
    this.remoteAudio = null;
    this.shellElement = null;
    this.orb = null;
    this.startController = null;
    this.refreshTimer = null;
    this.transcriptHistory = [];
    this.assistantCaption = '';
    this.navigated = false;

    this.bindElements();
  }

  bindElements() {
    if (!this.root) return;
    this.startButton = this.root.querySelector('[data-live-start]');
    this.stopButton = this.root.querySelector('[data-live-stop]');
    this.statusElement = this.root.querySelector('[data-live-status]');
    this.userCaption = this.root.querySelector('[data-live-caption="user"]');
    this.agentCaption = this.root.querySelector('[data-live-caption="assistant"]');
    this.transcriptElement = this.root.querySelector('[data-live-transcript]');
    // The drawer, not the outer companion. RealtimeOrb watches `hidden` on
    // whatever node it is handed and stops painting when it is set; only the
    // drawer's `hidden` tracks open and close, so handing it the outer element
    // would leave the orb animating behind a collapsed panel.
    this.shellElement = this.root.querySelector('.realtime-voice-shell') || this.root;
    const canvas = this.root.querySelector('[data-live-orb]');
    if (canvas) this.orb = new RealtimeOrb(canvas, { shell: this.shellElement });

    this.startButton?.addEventListener('click', () => this.start());
    this.stopButton?.addEventListener('click', () => this.stop('consumer_closed'));
  }

  setPhase(phase, message) {
    this.orb?.syncPhase?.(phase);
    if (this.orb) this.orb.phase = phase;
    if (this.statusElement && message) this.statusElement.textContent = message;
    // `data-realtime-phase`, NOT `data-phase`. plan.css keys every phase style
    // off that exact attribute and RealtimeOrb.syncPhase reads it too, so the
    // shorter name styled nothing and left the orb permanently idle.
    this.root?.setAttribute('data-realtime-phase', phase);
    this.shellElement?.setAttribute('data-realtime-phase', phase);
    // The shared markup ships this button disabled for the v2 lane, which
    // enables it from its own state machine. This lane has none, so it says so
    // here: there is nothing to end until a meeting is running.
    if (this.stopButton) this.stopButton.disabled = !this.active;
  }

  setCaption(role, text) {
    const element = role === 'user' ? this.userCaption : this.agentCaption;
    if (element) element.textContent = text;
  }

  pushTranscript(role, text) {
    const clean = cleanText(text);
    if (!clean) return;
    this.transcriptHistory.push({ role, text: clean });
    if (this.transcriptHistory.length > MAX_TRANSCRIPT_ITEMS) this.transcriptHistory.shift();
    if (!this.transcriptElement) return;
    // An <li> carrying the classes plan.css actually styles. The transcript
    // region is an <ol>, so a bare <p> was both invalid content and invisible:
    // no stylesheet defines a `live-transcript-line` rule.
    const line = document.createElement('li');
    line.className = `realtime-history-item is-${role}`;
    line.textContent = clean;
    this.transcriptElement.append(line);
    this.transcriptElement.scrollTop = this.transcriptElement.scrollHeight;
  }

  /* ------------------------------------------------------------- lifecycle */

  async start() {
    if (this.active) return;
    if (!isRealtimeVoiceSupported()) {
      this.onToast('This browser cannot run a live meeting. Continue by typing.', { tone: 'error' });
      return;
    }
    const context = this.readContext();
    if (!context?.sessionId) {
      this.onToast('Start a planning session before opening a live meeting.', { tone: 'error' });
      return;
    }

    this.onStopBoundedVoice();
    const generation = ++this.generation;
    this.active = true;
    this.navigated = false;
    this.sessionId = context.sessionId;
    this.transcriptHistory = [];
    this.setCaption('user', 'Your words will appear here while you speak.');
    this.setCaption('assistant', 'Planéir will say hello in a moment.');
    this.setPhase('connecting', 'Connecting your private meeting…');

    const controller = new AbortController();
    this.startController = controller;
    const activationId = newPrivateId('rt_activation');
    const proposedControlCapability = newPrivateId('rt_control');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      if (generation !== this.generation || controller.signal.aborted) {
        stopTracks(stream);
        return;
      }
      this.localStream = stream;
      this.orb?.attachMicStream?.(stream);
      this.orb?.start?.();

      const peer = new window.RTCPeerConnection();
      this.peerConnection = peer;
      stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream));

      // The model's audio arrives over WebRTC and plays directly. The v2 lane
      // mutes this track unless the conversation version is v2 and routes
      // speech through Worker-owned TTS instead; there is no such path here.
      peer.addEventListener('track', (event) => {
        const [remote] = event.streams || [];
        if (!remote) return;
        this.attachRemoteAudio(remote);
        this.orb?.attachRemoteStream?.(remote);
      });
      peer.addEventListener('connectionstatechange', () => {
        if (['failed', 'closed'].includes(peer.connectionState) && this.active) {
          this.stop('connection_lost');
        }
      });

      const channel = peer.createDataChannel('oai-events');
      this.dataChannel = channel;
      channel.addEventListener('message', (event) => this.handleProviderEvent(event.data));

      const offer = await peer.createOffer({ offerToReceiveAudio: true });
      await peer.setLocalDescription(offer);
      const offerSdp = String(peer.localDescription?.sdp || offer.sdp || '');

      const response = await createRealtimeVoiceCall(context.sessionId, {
        sdp: offerSdp,
        idempotencyKey: newPrivateId('voice-live'),
        activationId,
        controlCapability: proposedControlCapability,
        signal: controller.signal
      });
      if (generation !== this.generation || controller.signal.aborted) return;

      const call = normaliseRealtimeCallResponse(response);
      if (!call.sdp.startsWith('v=0')) throw new Error('The service returned no valid live meeting answer.');
      if (!call.leaseId) throw new Error('The service returned no controllable live meeting lease.');
      if (call.activationId !== activationId) throw new Error('The service returned a mismatched activation.');
      if (call.controlCapability !== proposedControlCapability) {
        throw new Error('The service returned no authenticated control channel.');
      }
      this.leaseId = call.leaseId;
      this.controlCapability = call.controlCapability;

      await peer.setRemoteDescription({ type: 'answer', sdp: call.sdp });
      if (generation !== this.generation || controller.signal.aborted) return;

      // THE MICROPHONE IS LIVE IMMEDIATELY. The v2 lane holds the outbound
      // track disabled until its scripted welcome finishes playing; here the
      // model owns turn-taking, so interrupting the greeting is allowed and
      // works exactly as it would with a person.
      this.setPhase('listening', 'I’m listening — take your time.');
    } catch (error) {
      this.active = false;
      this.teardown();
      const message = error?.name === 'NotAllowedError'
        ? 'Microphone access is needed for a live meeting.'
        : error?.message || 'The live meeting could not be started.';
      this.setPhase('off', 'Live meeting ended.');
      this.onToast(message, { tone: 'error' });
      if (error?.code === 'session_not_found') this.onSessionUnavailable(error);
    }
  }

  attachRemoteAudio(stream) {
    if (!this.remoteAudio) {
      this.remoteAudio = document.createElement('audio');
      this.remoteAudio.autoplay = true;
      this.remoteAudio.setAttribute('playsinline', '');
      this.remoteAudio.style.display = 'none';
      document.body.append(this.remoteAudio);
    }
    this.remoteAudio.srcObject = stream;
    this.remoteAudio.play?.().catch(() => {
      this.onToast('Tap anywhere to let Planéir speak.', { tone: 'info' });
    });
  }

  async stop(reason = 'consumer_closed') {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    this.startController?.abort();
    this.teardown();
    this.setPhase('off', 'Live meeting ended.');
    // The Worker owns provider hang-up and lease settlement; the browser only
    // reports that it is finished.
    try {
      await getSession(this.sessionId).then((payload) => this.acceptSessionPayload(payload));
    } catch (_error) { /* the meeting is already over */ }
  }

  teardown() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    try { this.dataChannel?.close(); } catch (_error) { /* best effort */ }
    try { this.peerConnection?.close(); } catch (_error) { /* best effort */ }
    stopTracks(this.localStream);
    if (this.remoteAudio) this.remoteAudio.srcObject = null;
    this.dataChannel = null;
    this.peerConnection = null;
    this.localStream = null;
    this.orb?.stop?.();
  }

  /* -------------------------------------------------------- provider events */

  /**
   * NO ALLOWLIST. Unknown events are ignored, not treated as an attack.
   *
   * Everything that actually matters for authority happens on the server: the
   * browser never sees an API key or a provider call id, and it cannot save a
   * fact, choose an analysis or run anything. Policing event *types* here
   * bought nothing and cost an entire canary.
   */
  handleProviderEvent(data) {
    if (typeof data !== 'string' || data.length > 64_000) return;
    let event;
    try {
      event = JSON.parse(data);
    } catch (_error) {
      return;
    }
    const type = String(event?.type || '');

    if (type === 'input_audio_buffer.speech_started') {
      this.setPhase('user_speaking', 'I can hear you.');
      return;
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      this.setPhase('responding', 'Thinking…');
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = cleanText(event.transcript);
      if (transcript) {
        this.setCaption('user', transcript);
        this.pushTranscript('user', transcript);
      }
      return;
    }
    if (type === 'response.created') {
      this.assistantCaption = '';
      this.setPhase('assistant_speaking', 'Planéir is speaking.');
      return;
    }
    if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta') {
      if (typeof event.delta === 'string') {
        this.assistantCaption = cleanText(`${this.assistantCaption}${event.delta}`);
        this.setCaption('assistant', this.assistantCaption);
      }
      return;
    }
    if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
      const transcript = cleanText(event.transcript) || this.assistantCaption;
      if (transcript) {
        this.setCaption('assistant', transcript);
        this.pushTranscript('assistant', transcript);
      }
      return;
    }
    if (type === 'response.done') {
      this.setPhase('listening', 'I’m listening — take your time.');
      this.scheduleStateRefresh();
    }
  }

  /* --------------------------------------------------------- on-screen state */

  /**
   * Refreshing after each assistant turn is what makes the drafts appear on
   * screen as the client talks — which IS the demo. It is a poll rather than a
   * server push because the browser has no channel to the Durable Object, and
   * adding one is not worth it for a once-per-turn refresh.
   */
  scheduleStateRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshState().catch(() => { /* the next turn will refresh again */ });
    }, STATE_REFRESH_DELAY_MS);
  }

  async refreshState() {
    if (!this.sessionId) return;
    const payload = await getSession(this.sessionId);
    this.acceptSessionPayload(payload);
  }

  acceptSessionPayload(payload) {
    const body = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    if (!body || typeof body !== 'object') return;

    this.onVoicePayload(body);
    const planning = extractRealtimePlanningContext(body);
    if (planning) this.onPlanningPayload(planning);

    // The deterministic engine has run and the results exist. Navigate once.
    const status = String(body.session?.status || '');
    const hasResults = Boolean(body.analysis?.results?.length || body.analysis?.summary);
    if (!this.navigated && hasResults && ['complete', 'completed'].includes(status)) {
      this.navigated = true;
      this.stop('completed').catch(() => {});
      this.onNavigate('results');
    }
  }

  readContext() {
    const sessionId = this.root?.dataset?.sessionId
      || document.body?.dataset?.consumerSessionId
      || '';
    return { sessionId: String(sessionId || '') };
  }
}

export function createLiveVoiceController(options) {
  return new LiveVoiceController(options);
}
