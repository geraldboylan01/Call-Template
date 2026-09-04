/**
 * The live lane's browser controller.
 *
 * WHAT IS ABSENT, AND WHY
 *
 * The previous controlled WebRTC client is retained only under
 * `js/plan/legacy/controlled_realtime_voice.js`. It is historical reference
 * code, is not imported by production, and must not be used for new calls.
 * Most of what it did existed to service the old authority model and does not
 * apply here:
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
 * microphone. The archived controlled client carries ~150 lines of device enumeration,
 * saved preference and Continuity-camera heuristics. That is real work worth
 * porting before a public release; it is not what makes or breaks a demo, and
 * duplicating it now would mean maintaining two copies of it.
 */

import {
  acknowledgeRealtimePlayback,
  createRealtimeVoiceCall,
  deleteRealtimeVoiceCall,
  getRealtimeVoiceCall,
  getRealtimeVoiceMeetingTranscript,
  getSession
} from './api.js';
import {
  bindConsentForm,
  beginConsentRecovery,
  isConsentRequiredError,
  submitConsent
} from './live_voice_consent.js';
import { RealtimeOrb } from './realtime_orb.js';
import { describePlanningCompletion } from './completion.js';
import { getSessionId, state as journeyState } from './store.js';
import { createPlaybackDeliveryLedger } from './playback_delivery.js';

const MAX_CAPTION_LENGTH = 3_000;
const MAX_TRANSCRIPT_ITEMS = 500;
// After the agent finishes speaking, refresh the session so newly saved drafts
// appear on screen. Short enough to feel live, long enough not to hammer the
// Worker while someone is mid-sentence.
const STATE_REFRESH_DELAY_MS = 400;
// How long the client will hold a turn open waiting for the Worker to request
// the continuation a function call ended. This is a stall net, not a schedule:
// the Worker normally asks within milliseconds of delivering the tool output,
// but that output can itself be deferred behind the finalized transcript. Long
// enough not to cut a legitimate continuation short, short enough that a lost
// one does not leave the orb thinking for the rest of the meeting.
const CONTINUATION_STALL_TIMEOUT_MS = 15_000;

function cleanText(value, maximum = MAX_CAPTION_LENGTH) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > maximum ? text.slice(0, maximum) : text;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function unwrap(payload) {
  const root = asObject(payload) || {};
  return asObject(root.data) || root;
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || ''));
  } catch (_error) {
    return null;
  }
}

function headerValue(headers, names) {
  if (!headers || typeof headers.get !== 'function') return '';
  for (const name of names) {
    const value = String(headers.get(name) || '').trim();
    if (value) return value;
  }
  return '';
}

export function isLiveVoiceSupported(win = window, nav = navigator) {
  return Boolean(
    win?.isSecureContext
    && typeof win?.RTCPeerConnection === 'function'
    && nav?.mediaDevices
    && typeof nav.mediaDevices.getUserMedia === 'function'
  );
}

/** Parse the answer contract used by the only active browser call lane. */
function normaliseLiveVoiceCallResponse(response) {
  const rawBody = String(response?.body || '');
  const body = rawBody.trim();
  const parsed = String(response?.contentType || '').toLowerCase().includes('json') || body.startsWith('{')
    ? parseJson(body)
    : null;
  const root = unwrap(parsed);
  const answer = asObject(firstDefined(root.answer, root.sessionDescription, root.remoteDescription)) || {};
  const lease = asObject(firstDefined(root.lease, root.realtimeLease, root.call)) || {};
  return {
    // SDP is line-oriented protocol text. Preserve its framing exactly.
    sdp: String(firstDefined(
      root.sdp,
      root.answerSdp,
      root.answer_sdp,
      answer.sdp,
      body.startsWith('v=0') ? rawBody : ''
    ) || '').slice(0, 120_000),
    leaseId: cleanText(firstDefined(
      root.leaseId,
      root.lease_id,
      lease.leaseId,
      lease.lease_id,
      lease.id,
      headerValue(response?.headers, [
        'X-Voice-Realtime-Lease-Id',
        'X-Realtime-Voice-Lease-Id',
        'X-Voice-Lease-Id',
        'X-Realtime-Lease-Id',
        'X-Lease-Id'
      ])
    ), 200),
    controlCapability: cleanText(headerValue(response?.headers, [
      'X-Realtime-Control-Capability'
    ]), 120),
    activationId: cleanText(headerValue(response?.headers, [
      'X-Realtime-Activation-Id'
    ]), 120),
    payload: parsed || null
  };
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
    onToast = () => {},
    onSessionUnavailable = () => {},
    onFailure = () => {}
  } = {}) {
    this.root = root || null;
    this.onVoicePayload = onVoicePayload;
    this.onPlanningPayload = onPlanningPayload;
    this.onNavigate = onNavigate;
    this.onToast = onToast;
    this.onSessionUnavailable = onSessionUnavailable;
    this.onFailure = onFailure;

    // THE DISCLOSURE HAS TO BE REACHABLE FROM THIS LANE.
    //
    // This is the only controller production constructs. The archived
    // controlled client that used to own the disclosure is never imported.
    // Binding the form here is what
    // makes accepting it possible at all: without it the dialog could be put
    // on screen and ticking the box would do nothing.
    this.unbindConsentForm = bindConsentForm((form) => this.acceptDisclosure(form));

    this.active = false;
    this.generation = 0;
    this.sessionId = '';
    this.leaseId = '';
    this.controlCapability = '';
    this.peerConnection = null;
    this.dataChannel = null;
    this.localStream = null;
    this.remoteAudio = null;
    this.remotePlaybackReady = false;
    this.shellElement = null;
    this.orb = null;
    this.startController = null;
    this.refreshTimer = null;
    this.transcriptHistory = [];
    this.assistantCaption = '';
    // Generation and WebRTC playout are different lifecycles. The provider
    // may finish generating (`response.done`) while its output buffer is
    // still playing, so neither event is allowed to stand in for the other.
    this.responseInProgress = false;
    this.responseNeedsContinuation = false;
    this.assistantPlaybackActive = false;
    this.continuationStallTimer = null;
    this.phase = 'off';
    this.navigated = false;
    this.refreshPromise = null;
    this.shutdownPromise = null;
    this.completionPromise = null;
    this.completionPayload = null;
    this.expectedExecution = null;
    this.executionWatching = false;
    this.deliveries = createPlaybackDeliveryLedger({
      limit: MAX_TRANSCRIPT_ITEMS,
      newEventId: () => newPrivateId('playback'),
      canSend: () => Boolean(this.leaseId && this.controlCapability),
      audible: () => this.remotePlaybackReady
        && (!this.remoteAudio
          || (!this.remoteAudio.paused && !this.remoteAudio.muted && this.remoteAudio.volume !== 0)),
      send: (evidence) => acknowledgeRealtimePlayback(
        this.sessionId, this.leaseId, evidence, { controlCapability: this.controlCapability }
      )
    });
    this.currentResponseId = '';
    this.playbackResponseId = '';
    this.completionTimings = {};

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
    this.transcriptCard = this.root.querySelector('#realtimeVoiceCaptionCard');
    this.transcriptToggle = this.root.querySelector('#realtimeVoiceTranscriptToggle');
    this.transcriptCopyButton = this.root.querySelector('#realtimeVoiceTranscriptCopyButton');
    this.textForm = this.root.querySelector('#liveVoiceTextForm');
    this.textInput = this.root.querySelector('#liveVoiceTextInput');
    this.textSendButton = this.root.querySelector('#liveVoiceTextSendButton');
    // The drawer, not the outer companion. RealtimeOrb watches `hidden` on
    // whatever node it is handed and stops painting when it is set; only the
    // drawer's `hidden` tracks open and close, so handing it the outer element
    // would leave the orb animating behind a collapsed panel.
    this.shellElement = this.root.querySelector('.realtime-voice-shell') || this.root;
    const canvas = this.root.querySelector('[data-live-orb]');
    if (canvas) this.orb = new RealtimeOrb(canvas, { shell: this.shellElement });

    this.startButton?.addEventListener('click', () => this.start());
    this.stopButton?.addEventListener('click', () => this.stop('consumer_closed').catch(() => {}));
    this.transcriptToggle?.addEventListener('click', () => this.toggleTranscript());
    this.transcriptCopyButton?.addEventListener('click', () => this.copyTranscript());
    this.textForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.sendTypedTurn();
    });
  }

  setPhase(phase, message) {
    this.phase = phase;
    // `data-realtime-phase`, NOT `data-phase`. plan.css keys every phase style
    // off that exact attribute and RealtimeOrb.syncPhase reads it too, so the
    // shorter name styled nothing and left the orb permanently idle.
    this.root?.setAttribute('data-realtime-phase', phase);
    this.shellElement?.setAttribute('data-realtime-phase', phase);
    // RealtimeOrb reads the shell attribute, so publish the new phase before
    // asking it (and its thinking tone) to synchronize.
    this.orb?.syncPhase?.();
    if (this.orb) this.orb.phase = phase;
    if (this.statusElement && message) this.statusElement.textContent = message;
    // The markup ships End disabled. There is nothing to end until this live
    // controller has a meeting running.
    if (this.stopButton) this.stopButton.disabled = !this.active && !this.leaseId;
    this.syncShellFace();
  }

  /**
   * THE SHELL HAS TWO FACES AND THE CSS PICKS BETWEEN THEM BY CLASS.
   *
   * plan.css hides the pre-call briefing under `.is-live`, and — this is the
   * one that matters — hides `#realtimeVoiceEndButton`, the mute button and
   * the context grid under `:not(.is-live)`. A lane that never sets the class
   * leaves the client on the landing face for the whole meeting, WITH NO WAY
   * TO END IT: the End button is styled out of existence while the meeting it
   * would end is running.
   *
   * `has-transcript` is the same story for the transcript toggle.
   */
  syncShellFace() {
    const hasTranscript = this.transcriptHistory.length > 0;
    [this.root, this.shellElement].filter(Boolean).forEach((element) => {
      element.classList?.toggle?.('is-live', this.active || Boolean(this.leaseId));
      element.classList?.toggle?.('has-transcript', hasTranscript);
    });
    if (this.transcriptToggle) {
      const shown = this.transcriptCard?.hidden === false;
      this.transcriptToggle.setAttribute('aria-pressed', shown ? 'true' : 'false');
      this.transcriptToggle.textContent = shown
        ? 'Hide transcript'
        : (this.active ? 'Show transcript' : 'View saved transcript');
    }
    if (this.transcriptCopyButton) this.transcriptCopyButton.disabled = !hasTranscript;
    const typingReady = this.active && this.dataChannel?.readyState === 'open';
    if (this.textInput) this.textInput.disabled = !typingReady;
    if (this.textSendButton) this.textSendButton.disabled = !typingReady;
  }

  /**
   * Send text through the SAME live Realtime connection as microphone turns.
   * This is a second input method, not a fallback call lane. The provider
   * echoes the item to the Worker's authenticated sideband, where it is saved
   * and reviewed like a finalized spoken turn.
   */
  sendTypedTurn() {
    const text = cleanText(this.textInput?.value, 4_000);
    if (!text) return;
    if (!this.active || this.dataChannel?.readyState !== 'open') {
      this.onToast('The live call is not ready for a typed message.', { tone: 'error' });
      return;
    }
    const itemId = newPrivateId('msg');
    this.dataChannel.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        id: itemId,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }]
      }
    }));
    this.dataChannel.send(JSON.stringify({ type: 'response.create' }));
    this.pushTranscript('user', text);
    this.setCaption('user', text);
    this.setPhase('thinking', 'Thinking…');
    this.textInput.value = '';
    this.textInput.focus?.();
  }

  reportFailure(message, details = {}) {
    this.onFailure({
      message: cleanText(message, 1_000) || 'The live call could not continue.',
      transcript: this.transcriptForCopy(),
      ...details
    });
  }

  setCaption(role, text) {
    const element = role === 'user' ? this.userCaption : this.agentCaption;
    if (element) element.textContent = text;
  }

  pushTranscript(role, text) {
    const clean = cleanText(text);
    if (!clean) return;
    this.transcriptHistory.push({ role, text: clean });
    if (this.transcriptHistory.length > MAX_TRANSCRIPT_ITEMS) {
      this.transcriptHistory.shift();
      this.transcriptElement?.firstElementChild?.remove?.();
    }
    if (!this.transcriptElement) return;
    this.transcriptElement.append(this.createTranscriptLine({ role, text: clean }));
    this.transcriptElement.scrollTop = this.transcriptElement.scrollHeight;
    this.syncShellFace();
  }

  createTranscriptLine(item) {
    const line = document.createElement('li');
    line.className = `realtime-history-item is-${item.role}`;
    const speaker = document.createElement('span');
    speaker.textContent = item.role === 'user' ? 'You' : 'Planéir voice · AI';
    const copy = document.createElement('p');
    copy.textContent = item.text;
    line.append(speaker, copy);
    return line;
  }

  replaceTranscript(turns) {
    if (!Array.isArray(turns)) return;
    this.transcriptHistory = turns.flatMap((turn) => {
      const role = turn?.role === 'assistant' ? 'assistant' : turn?.role === 'user' ? 'user' : '';
      // Final turns are stored at up to 4,000 characters. Captions are more
      // tightly bounded while streaming, but a saved transcript must not lose
      // the final 1,000 characters when it is restored for review or copying.
      const text = cleanText(turn?.transcript || turn?.text, 4_000);
      return role && text ? [{ id: cleanText(turn?.id, 120), role, text }] : [];
    });
    if (this.transcriptElement) {
      const fragment = document.createDocumentFragment();
      this.transcriptHistory.forEach((item) => fragment.append(this.createTranscriptLine(item)));
      this.transcriptElement.replaceChildren(fragment);
      this.transcriptElement.scrollTop = this.transcriptElement.scrollHeight;
    }
    this.syncShellFace();
  }

  toggleTranscript() {
    if (!this.transcriptCard) return;
    this.transcriptCard.hidden = !this.transcriptCard.hidden;
    this.syncShellFace();
  }

  revealTranscript() {
    if (!this.transcriptCard || this.transcriptHistory.length === 0) return;
    this.transcriptCard.hidden = false;
    this.syncShellFace();
  }

  transcriptForCopy() {
    return this.transcriptHistory
      .map((item) => `${item.role === 'user' ? 'You' : 'Planéir (AI)'}: ${item.text}`)
      .join('\n\n');
  }

  async copyTranscript() {
    const transcript = this.transcriptForCopy();
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript);
      this.onToast('The full transcript was copied to your clipboard.', { tone: 'success' });
    } catch (_error) {
      this.onToast('The transcript could not be copied automatically. You can still select and copy it from this panel.', { tone: 'error' });
    }
  }

  async loadServerTranscript(sessionId, meetingId) {
    const turns = [];
    let cursor = '';
    let meeting = null;
    const seenCursors = new Set();
    do {
      const payload = await getRealtimeVoiceMeetingTranscript(sessionId, meetingId, {
        cursor,
        limit: 50
      });
      meeting = payload.meeting || meeting;
      turns.push(...(Array.isArray(payload.turns) ? payload.turns : []));
      cursor = String(payload.nextCursor || '');
      if (cursor && seenCursors.has(cursor)) {
        throw new Error('The saved meeting transcript could not be paged safely.');
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    this.replaceTranscript(turns);
    this.onVoicePayload({ meeting, transcriptTurns: turns, nextCursor: null });
    return turns;
  }

  /* ------------------------------------------------------------- lifecycle */

  async start() {
    if (this.active || this.leaseId || this.shutdownPromise) return;
    if (!isLiveVoiceSupported()) {
      this.reportFailure('This browser cannot run the live call. Please try a recent version of Chrome, Edge, or Safari.', {
        reason: 'unsupported-browser'
      });
      return;
    }
    const context = this.readContext();
    if (!context?.sessionId) {
      this.reportFailure('The live call could not find an active planning session.', { reason: 'no-session' });
      return;
    }

    const generation = ++this.generation;
    this.active = true;
    this.navigated = false;
    this.completionPayload = null;
    this.expectedExecution = null;
    this.executionWatching = false;
    this.deliveries.clear();
    this.currentResponseId = '';
    this.playbackResponseId = '';
    this.completionTimings = {};
    this.sessionId = context.sessionId;
    this.transcriptHistory = [];
    this.responseInProgress = false;
    this.responseNeedsContinuation = false;
    this.assistantPlaybackActive = false;
    this.clearContinuationStallTimer();
    this.transcriptElement?.replaceChildren?.();
    if (this.transcriptCard) this.transcriptCard.hidden = true;
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
      this.setTransportState(peer.connectionState);
      stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream));

      // The model's audio arrives over WebRTC and plays directly. The archived
      // controlled implementation routed speech through Worker-owned TTS;
      // there is no such active path here.
      peer.addEventListener('track', (event) => {
        const [remote] = event.streams || [];
        if (!remote) return;
        this.attachRemoteAudio(remote);
        this.orb?.attachRemoteStream?.(remote);
      });
      peer.addEventListener('connectionstatechange', () => {
        this.setTransportState(peer.connectionState);
        if (peer.connectionState === 'failed' && this.active) {
          this.stop('connection_lost').catch(() => {}).finally(() => {
            this.reportFailure('The live connection was lost during the call.', { reason: 'connection-lost' });
          });
        }
      });

      const channel = peer.createDataChannel('oai-events');
      this.dataChannel = channel;
      channel.addEventListener('message', (event) => this.handleProviderEvent(event.data));
      channel.addEventListener('open', () => this.syncShellFace());
      channel.addEventListener('close', () => {
        this.syncShellFace();
        if (this.active) {
          this.stop('connection_lost').catch(() => {}).finally(() => {
            this.reportFailure('The live call’s secure message channel was lost.', { reason: 'connection-lost' });
          });
        }
      });

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

      const call = normaliseLiveVoiceCallResponse(response);
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

      // THE MICROPHONE IS LIVE IMMEDIATELY. The archived controlled client
      // held the outbound track until a scripted welcome finished. Here the
      // model owns turn-taking, so interrupting the greeting is allowed.
      // The Worker can request the opening response as soon as its sideband is
      // connected. If those provider events have already advanced the UI to
      // thinking or playback, finishing SDP setup must not rewind the orb to
      // listening in the middle of Planéir's greeting.
      if (this.phase === 'connecting') {
        this.setPhase('listening', 'I’m listening — take your time.');
      }
    } catch (error) {
      const cancelled = generation !== this.generation || controller.signal.aborted;
      this.active = false;
      this.teardown();
      // A lease created moments ago is already billing. Failing between the
      // answer and the connection must not leave it running to its alarm.
      try { await this.releaseLease(); } catch (closeError) {
        this.setPhase('closing', 'Your microphone is off. The call is still closing.');
        this.onToast(closeError.message, { tone: 'error' });
        return;
      }
      if (cancelled) return;
      // A STALE DISCLOSURE MUST NOT DEAD-END THE MEETING.
      //
      // The Worker refuses the call until the client has agreed to the CURRENT
      // disclosure. Reporting that as an ordinary failure left the client with
      // "Review and accept the current live voice disclosure before starting."
      // and nothing on screen to accept — the meeting could be neither started
      // nor re-agreed, and pressing Start again produced the same dead end.
      if (isConsentRequiredError(error)) {
        const opened = beginConsentRecovery(this.readDisclosure());
        this.setPhase('off', opened
          ? 'Please review the updated meeting notice to continue.'
          : 'Live meeting ended.');
        if (!opened) {
          // Never leave an error the client cannot act on: if the disclosure
          // is genuinely not on this page, say what to do instead.
          this.onToast('The live meeting notice could not be opened. Reload the page to review it, or continue by typing.', { tone: 'error' });
        }
        return;
      }
      const message = error?.name === 'NotAllowedError'
        ? 'Microphone access was not available, so the live call could not start.'
        : error?.message || 'The live call could not be started.';
      this.setPhase('off', 'Live meeting ended.');
      if (error?.code === 'session_not_found') this.onSessionUnavailable(error);
      this.reportFailure(message, {
        reason: error?.name === 'NotAllowedError' ? 'microphone-unavailable' : 'start-failed'
      });
    }
  }

  /**
   * TELL THE WORKER THE MEETING IS OVER.
   *
   * Closing the peer connection is invisible to the server: the lease stays
   * open and the provider call stays billable until the idle alarm fires
   * minutes later. The Worker still OWNS the hang-up — it decides it, confirms
   * it with the provider and settles the lease — but it has to be told, and
   * the browser is the only thing that knows the client pressed End.
   *
   * Keep the same private capability until both the provider and lease are
   * confirmed closed. A lost response must remain safely retryable.
   */
  async releaseLease() {
    const leaseId = this.leaseId;
    const controlCapability = this.controlCapability;
    if (!leaseId || !this.sessionId) return;
    const body = unwrap(await deleteRealtimeVoiceCall(this.sessionId, leaseId, { controlCapability }));
    if (body.providerHangupConfirmed !== true
      || !['complete', 'failed', 'withdrawn', 'budget_exhausted', 'expired', 'deleted'].includes(String(body.realtimeLease?.status || ''))
      || body.realtimeLease?.leaseId !== leaseId) {
      throw new Error('Your microphone is off, but the service has not yet confirmed that the call is closed. Please retry End.');
    }
    this.recordCompletionTiming('providerHangupConfirmedAt');
    this.recordCompletionTiming('terminalLeaseAt');
    if (this.leaseId === leaseId) {
      this.leaseId = '';
      this.controlCapability = '';
    }
    return body;
  }

  /**
   * The companion already ships a hidden `<audio>` element, so use it rather
   * than appending a second one nobody can find. The active live lane plays
   * the model through this one discoverable node, which makes audibility
   * answerable from outside the controller and by the activation proof.
   */
  attachRemoteAudio(stream) {
    if (!this.remoteAudio) {
      this.remoteAudio = document.getElementById('realtimeVoiceAudio');
    }
    if (!this.remoteAudio) {
      this.remoteAudio = document.createElement('audio');
      this.remoteAudio.style.display = 'none';
      document.body.append(this.remoteAudio);
    }
    this.remoteAudio.autoplay = true;
    this.remoteAudio.setAttribute('playsinline', '');
    this.remoteAudio.srcObject = stream;
    this.remotePlaybackReady = false;
    this.remoteAudio.play?.().then(() => {
      this.remotePlaybackReady = true;
      this.deliveries.acknowledgeAll();
    }).catch(() => {
      this.onToast('Tap anywhere to let Planéir speak.', { tone: 'info' });
    });
  }

  /**
   * The peer connection's own state, on the page.
   *
   * Nothing else reports whether media actually negotiated: the phase says
   * what the controller believes, and an SDP answer only says the offer was
   * accepted. This is read by the activation proof, and it is the difference
   * between proving a live meeting connected and proving a call was created.
   */
  setTransportState(value) {
    const state = String(value || 'new');
    if (this.root) this.root.dataset.liveTransport = state;
    this.shellElement?.setAttribute?.('data-live-transport', state);
  }

  stop(reason = 'consumer_closed') {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this.active && !this.leaseId) return Promise.resolve();
    const meetingId = this.leaseId;
    const sessionId = this.sessionId;
    this.active = false;
    this.generation += 1;
    this.startController?.abort();
    this.teardown();
    this.recordCompletionTiming('localMediaStoppedAt');
    this.setPhase('closing', 'Your microphone is off. Closing the call…');
    this.shutdownPromise = this.releaseLease().then(() => {
      this.setPhase('off', 'Live meeting ended.');
      if (reason !== 'completed') {
        getSession(sessionId).then((payload) => this.acceptSessionPayload(payload)).catch(() => {});
      }
      if (sessionId && meetingId && !['completed', 'navigation', 'reset', 'deletion'].includes(reason)) {
        this.loadServerTranscript(sessionId, meetingId).then(() => this.revealTranscript()).catch(() => {
          this.onToast('The saved transcript could not be refreshed. This browser’s transcript is still available to review.', { tone: 'error' });
        });
      }
    }).catch((error) => {
      this.setPhase('closing', 'Your microphone is off. The call is still closing — retry End.');
      throw error;
    }).finally(() => { this.shutdownPromise = null; });
    return this.shutdownPromise;
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
    this.remotePlaybackReady = false;
    this.dataChannel = null;
    this.peerConnection = null;
    this.localStream = null;
    this.responseInProgress = false;
    this.responseNeedsContinuation = false;
    this.assistantPlaybackActive = false;
    this.clearContinuationStallTimer();
    this.setTransportState('closed');
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
    if (!this.active) return;
    if (typeof data !== 'string' || data.length > 64_000) return;
    let event;
    try {
      event = JSON.parse(data);
    } catch (_error) {
      return;
    }
    const type = String(event?.type || '');

    if (type === 'input_audio_buffer.speech_started') {
      if (this.assistantPlaybackActive || this.responseInProgress) {
        this.deliveries.interrupt(this.playbackResponseId || this.currentResponseId, event.event_id);
      }
      // The client answering is itself a resolution: the Worker will abandon
      // any pending continuation rather than talk over them.
      this.responseNeedsContinuation = false;
      this.clearContinuationStallTimer();
      this.setPhase('user_speaking', 'I can hear you.');
      return;
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      this.setPhase('thinking', 'Thinking…');
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
      this.currentResponseId = String(event.response?.id || '');
      this.deliveries.for(this.currentResponseId);
      this.assistantCaption = '';
      this.responseInProgress = true;
      this.responseNeedsContinuation = false;
      this.clearContinuationStallTimer();
      // A continuation may be created while audio from its parent response is
      // still draining. Playback remains the user-visible truth until the
      // provider reports that buffer stopped or was cleared.
      if (!this.assistantPlaybackActive) this.setPhase('thinking', 'Thinking…');
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      if (event.name === 'confirm_and_run') this.watchExecution();
      // A function call ends this provider response. The Worker will deliver
      // its result and explicitly request the continuation response; until
      // then the client is still waiting for Planéir, not listening for a
      // new turn.
      this.responseNeedsContinuation = true;
      if (!this.assistantPlaybackActive && !['user_speaking', 'interrupted'].includes(this.phase)) {
        this.setPhase('thinking', 'Planéir is noting that down…');
      }
      return;
    }
    if (type === 'output_audio_buffer.started') {
      this.playbackResponseId = String(event.response_id || this.currentResponseId || '');
      const delivery = this.deliveries.for(this.playbackResponseId);
      if (delivery) delivery.started = true;
      this.assistantPlaybackActive = true;
      this.setPhase('assistant_speaking', 'Planéir is speaking.');
      return;
    }
    if (type === 'output_audio_buffer.stopped' || type === 'output_audio_buffer.cleared') {
      const responseId = String(event.response_id || this.playbackResponseId || '');
      const delivery = this.deliveries.for(responseId);
      if (type === 'output_audio_buffer.cleared') this.deliveries.interrupt(responseId, event.event_id);
      else if (delivery) {
        delivery.stopped = true;
        delivery.eventId = String(event.event_id || delivery.eventId || newPrivateId('playback'));
        this.deliveries.acknowledge(delivery);
      }
      this.playbackResponseId = '';
      this.assistantPlaybackActive = false;
      if (this.responseInProgress) {
        if (!['user_speaking', 'interrupted'].includes(this.phase)) {
          this.setPhase('thinking', 'Thinking…');
        }
      } else {
        this.settleAssistantTurn();
      }
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
      const delivery = this.deliveries.for(String(event.response?.id || ''));
      if (delivery) {
        delivery.responseCompleted = event.response?.status === 'completed';
        if (!delivery.responseCompleted) this.deliveries.interrupt(delivery.responseId, event.event_id);
        else this.deliveries.acknowledge(delivery);
      }
      this.responseInProgress = false;
      const output = Array.isArray(event?.response?.output) ? event.response.output : [];
      if (output.some((item) => item?.type === 'function_call' && item.name === 'confirm_and_run')) this.watchExecution();
      this.responseNeedsContinuation = this.responseNeedsContinuation
        || output.some((item) => item?.type === 'function_call');
      // `response.done` is generation completion, not audible completion.
      // It is only the compatibility/no-audio fallback when no provider
      // output-buffer playback is active. A tool-only response also remains
      // in thinking while the Worker requests its continuation.
      if (!this.assistantPlaybackActive && !this.responseNeedsContinuation) {
        this.settleAssistantTurn();
      } else if (this.responseNeedsContinuation) {
        this.armContinuationStallTimer();
      }
    }
  }

  recordCompletionTiming(name) {
    if (this.completionTimings[name]) return;
    this.completionTimings[name] = Date.now();
    if (this.root?.dataset) this.root.dataset.liveCompletionTimings = JSON.stringify(this.completionTimings);
  }

  watchExecution() {
    this.executionWatching = true;
    this.recordCompletionTiming('approvalToolObservedAt');
    this.scheduleStateRefresh();
  }

  /**
   * A function call ends its provider response, so nothing more will arrive
   * until the Worker sends response.create. If that request never lands — a
   * socket failure on the Worker's side, a dropped continuation — no further
   * provider event will ever clear responseNeedsContinuation, and the orb sits
   * in thinking until the client gives up and speaks. Release the turn instead.
   */
  armContinuationStallTimer() {
    this.clearContinuationStallTimer();
    this.continuationStallTimer = setTimeout(() => {
      this.continuationStallTimer = null;
      if (!this.responseNeedsContinuation) return;
      this.responseNeedsContinuation = false;
      this.settleAssistantTurn();
    }, CONTINUATION_STALL_TIMEOUT_MS);
  }

  clearContinuationStallTimer() {
    if (!this.continuationStallTimer) return;
    clearTimeout(this.continuationStallTimer);
    this.continuationStallTimer = null;
  }

  settleAssistantTurn() {
    if (!this.active
      || this.responseInProgress
      || this.assistantPlaybackActive
      || this.responseNeedsContinuation
      || ['user_speaking', 'interrupted'].includes(this.phase)) return;
    this.setPhase('listening', 'I’m listening — take your time.');
    this.scheduleStateRefresh();
  }

  /* --------------------------------------------------------- on-screen state */

  // Keep the existing cadence. Request, lease and budget limits remain the
  // bounds until real provider/browser timing evidence supports new limits.
  scheduleStateRefresh() {
    if (this.refreshTimer || this.refreshPromise || (!this.active && !this.completionPayload)) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshState().catch(() => {}).finally(() => {
        if ((this.active && this.executionWatching) || (this.completionPayload && !this.navigated)) {
          this.scheduleStateRefresh();
        }
      });
    }, STATE_REFRESH_DELAY_MS);
  }

  refreshState() {
    if (this.refreshPromise) return this.refreshPromise;
    if (!this.sessionId) return Promise.resolve();
    this.refreshPromise = (async () => {
      if (this.completionPayload) {
        await this.completeWithResults(this.completionPayload);
        return;
      }
      let call = null;
      if (this.leaseId && this.controlCapability) {
        this.deliveries.acknowledgeAll();
        call = unwrap(await getRealtimeVoiceCall(this.sessionId, this.leaseId, {
          controlCapability: this.controlCapability
        }));
        const execution = call.realtimeExecution;
        if (execution?.planId) {
          if (!this.expectedExecution || this.expectedExecution.planId === execution.planId) {
            this.expectedExecution = execution;
            this.recordCompletionTiming('approvedExecutionObservedAt');
          }
          this.executionWatching = true;
          if (['failed', 'expired', 'conflicted', 'cancelled'].includes(execution.status)) {
            this.executionWatching = false;
            await this.stop('execution_failed');
            this.reportFailure('The analysis could not complete. Your saved information is still available.', { reason: 'execution-failed' });
            return;
          }
        }
      }
      const payload = unwrap(await getSession(this.sessionId));
      const body = { ...payload, ...(call?.analysisPlan ? { analysisPlan: call.analysisPlan } : {}) };
      await this.acceptSessionPayload(body);
      if (this.active && call?.realtimeLease
        && !['pending', 'active', 'closing'].includes(call.realtimeLease.status)) {
        this.executionWatching = false;
        await this.stop('server_closed');
      }
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  acceptSessionPayload(payload) {
    const body = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    if (!body || typeof body !== 'object') return;

    this.onVoicePayload(body);
    this.onPlanningPayload(body);

    // A live call requires the identity observed on its authenticated lease.
    // Historical results at the same profile revision cannot end this call.
    if (!this.navigated && this.expectedExecution
      && describePlanningCompletion(body, this.expectedExecution).ready) {
      this.recordCompletionTiming('resultsObservedAt');
      this.completionPayload = body;
      return this.completeWithResults(body);
    }
  }

  completeWithResults(body) {
    if (this.completionPromise) return this.completionPromise;
    if (this.navigated) return Promise.resolve();
    this.completionPromise = this.stop('completed').then(async () => {
      this.onVoicePayload(body);
      this.onPlanningPayload(body);
      await this.onNavigate('results');
      this.navigated = true;
      this.executionWatching = false;
      this.recordCompletionTiming('resultsRenderedAt');
      this.completionPayload = null;
    }).finally(() => { this.completionPromise = null; });
    return this.completionPromise;
  }

  /**
   * WHERE THE SESSION ID COMES FROM.
   *
   * The active journey store. This used to read two
   * dataset attributes — `data-session-id` on the companion and
   * `data-consumer-session-id` on the body — and NOTHING IN THE APP HAS EVER
   * SET EITHER. `start()` therefore returned at its session guard on every
   * press: a toast, no provider call, no phase change. That is precisely how
   * Deploy Worker run #295 failed, with `requests: none` and the companion
   * still showing its unstarted status line.
   *
   * A locally stored id can outlive a failed session creation, so only a
   * server-confirmed session counts. The datasets remain
   * as an explicit override for harnesses that set them.
   */
  /** The disclosure this deployment is asking the client to agree to. */
  readDisclosure() {
    const bootstrap = journeyState.bootstrap || {};
    return {
      sessionId: this.readContext()?.sessionId || '',
      noticeId: String(bootstrap.voiceRealtimeNoticeId || ''),
      policyVersion: String(bootstrap.voiceRealtimePolicyVersion || ''),
      privacyNoticeUrl: String(bootstrap.voiceRealtimePrivacyNoticeUrl || '')
    };
  }

  /** Agreement submitted from the disclosure: record it, then start. */
  async acceptDisclosure(form) {
    const accepted = await submitConsent(form, {
      ...this.readDisclosure(),
      onVoicePayload: (payload) => this.onVoicePayload(payload),
      onAccepted: () => {
        // They pressed Start and then agreed. Continue into the meeting rather
        // than asking for a second press.
        this.setPhase('connecting', 'Connecting your private meeting…');
        window.requestAnimationFrame(() => this.start());
      }
    });
    return accepted;
  }

  readContext() {
    const override = this.root?.dataset?.sessionId
      || document.body?.dataset?.consumerSessionId
      || '';
    if (override) return { sessionId: String(override) };
    const confirmed = Boolean(journeyState.session?.id || journeyState.session?.sessionId);
    return { sessionId: confirmed ? String(getSessionId() || '') : '' };
  }
}

export function createLiveVoiceController(options) {
  return new LiveVoiceController(options);
}
