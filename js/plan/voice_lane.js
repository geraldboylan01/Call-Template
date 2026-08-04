/**
 * Which controller drives the voice companion, behind one surface.
 *
 * There are two conversation lanes and they share one companion in the page.
 * The v2 controller already presents everything `app.js` calls; the live
 * controller deliberately does not — it dropped the v2 authority model, the
 * Worker-owned TTS playback and the device picker, and kept only what a lane
 * that lets the provider decide when to speak actually needs. That is the
 * point of it, not an omission to paper over.
 *
 * So this file is an adapter, not a base class: it gives the live controller
 * the handful of app-facing methods it lacks, and hands the v2 controller
 * straight through untouched. Nothing here belongs in `live_voice.js`, whose
 * whole contract is that it does not carry v2's baggage.
 *
 * THE LANE IS CHOSEN BEFORE THE CALL, NOT AFTER. Each controller creates its
 * own provider call, so the lane has to be known first. It comes from the
 * bootstrap; the call response then echoes it back as
 * `X-Realtime-Conversation-Version` for the controller to verify.
 */

import { createLiveVoiceController } from './live_voice.js';
import {
  createRealtimeVoiceController,
  realtimeMeetingAvailable,
  realtimeMeetingUnavailableDetail,
  realtimeMeetingUnavailableReason,
  withdrawRealtimeVoiceConsent
} from './realtime_voice.js';

export const LIVE_LANE = 'live';

/** The lane this deployment will run, as announced by the bootstrap. */
export function resolveVoiceLane(bootstrap) {
  return String(bootstrap?.voiceRealtimeConversationVersion || bootstrap?.conversationVersion || '') === LIVE_LANE
    ? LIVE_LANE
    : 'controlled';
}

/**
 * The live lane's app-facing wrapper.
 *
 * The drawer chrome lives here rather than in the controller because it is not
 * lane behaviour: opening a panel, dimming the page and restoring focus works
 * the same whoever is talking.
 */
class LiveVoiceLaneAdapter {
  constructor(options) {
    this.controller = createLiveVoiceController(options);
    this.root = options?.root || null;
    this.onVoicePayload = options?.onVoicePayload || (() => {});
    this.onToast = options?.onToast || (() => {});
    this.onSessionUnavailable = options?.onSessionUnavailable || (() => false);
    this.bound = false;
    this.expanded = false;
    this.lastFocusedElement = null;
  }

  element(id) {
    return this.root?.querySelector?.(`#${id}`) || null;
  }

  bind() {
    // The controller already bound its own start/stop buttons in its
    // constructor. Only the shared chrome is left.
    if (this.bound || !this.root) return;
    this.bound = true;
    this.element('realtimeVoiceLauncher')?.addEventListener('click', () => this.openCompanion());
    this.element('realtimeVoiceCollapseButton')?.addEventListener('click', () => this.collapseCompanion());
    this.element('realtimeVoiceBackdrop')?.addEventListener('click', () => this.collapseCompanion());
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.expanded) this.collapseCompanion();
    });
  }

  openCompanion({ focus = true } = {}) {
    if (!this.root || this.root.hidden) return;
    this.expanded = true;
    this.lastFocusedElement = document.activeElement || this.element('realtimeVoiceLauncher');
    const panel = this.element('realtimeVoiceShell');
    const backdrop = this.element('realtimeVoiceBackdrop');
    if (panel) panel.hidden = false;
    if (backdrop) backdrop.hidden = false;
    this.element('realtimeVoiceLauncher')?.setAttribute('aria-expanded', 'true');
    this.root.classList?.toggle?.('is-expanded', true);
    document.body?.classList?.toggle?.('realtime-companion-open', true);
    // The canvas has no box while the drawer is hidden, so the orb can only
    // size itself once the panel is actually on screen.
    this.controller.orb?.resize?.();
    if (focus) {
      window.requestAnimationFrame(() => {
        this.element('realtimeVoiceCollapseButton')?.focus?.({ preventScroll: true });
      });
    }
  }

  collapseCompanion({ restoreFocus = true } = {}) {
    if (!this.root) return;
    this.expanded = false;
    const panel = this.element('realtimeVoiceShell');
    const backdrop = this.element('realtimeVoiceBackdrop');
    const launcher = this.element('realtimeVoiceLauncher');
    if (panel) panel.hidden = true;
    if (backdrop) backdrop.hidden = true;
    launcher?.setAttribute('aria-expanded', 'false');
    this.root.classList?.toggle?.('is-expanded', false);
    document.body?.classList?.toggle?.('realtime-companion-open', false);
    if (restoreFocus) {
      const target = this.lastFocusedElement?.isConnected === false
        ? launcher
        : (this.lastFocusedElement || launcher);
      window.requestAnimationFrame(() => target?.focus?.({ preventScroll: true }));
    }
  }

  sync() {
    const shouldShow = realtimeMeetingAvailable();
    if (this.root) this.root.hidden = !shouldShow;
    if (!shouldShow && this.isLive()) void this.end({ reason: 'navigation' });
    if (!shouldShow && this.expanded) this.collapseCompanion({ restoreFocus: false });
  }

  isLive() {
    return this.controller.active === true;
  }

  // Identical gates for both lanes — see realtime_voice.js. They read session
  // and bootstrap state only, so there is nothing lane-shaped to fork here.
  isMeetingAvailable() {
    return realtimeMeetingAvailable();
  }

  meetingUnavailableReason() {
    return realtimeMeetingUnavailableReason();
  }

  meetingUnavailableDetail() {
    return realtimeMeetingUnavailableDetail();
  }

  async end({ reason = 'user' } = {}) {
    return this.controller.stop(reason);
  }

  /**
   * Put the companion back to a state a NEW meeting can start from.
   *
   * `teardown()` is not enough and must not be used here: it closes the peer
   * connection but never clears `active`, and `start()` returns immediately
   * while `active` is set — so a controller reset that way could never open
   * another meeting. `stop()` is what clears it.
   *
   * The rest runs unconditionally because `stop()` returns early when no
   * meeting is running, and a reset still has to clear the screen.
   */
  reset() {
    void this.controller.stop('reset');
    this.collapseCompanion({ restoreFocus: false });
    this.controller.transcriptHistory = [];
    const transcript = this.root?.querySelector?.('[data-live-transcript]');
    if (transcript) transcript.replaceChildren();
    this.controller.setCaption('user', '');
    this.controller.setCaption('assistant', '');
    if (this.root) this.root.hidden = true;
    document.body?.classList?.remove('realtime-companion-open');
  }

  async withdrawConsent() {
    return withdrawRealtimeVoiceConsent({
      endMeeting: () => this.end({ reason: 'consent_withdrawn' }),
      afterWithdraw: () => {
        this.collapseCompanion({ restoreFocus: false });
        this.controller.setPhase('off', 'Live voice is off. Short voice and typing remain available.');
      },
      onVoicePayload: this.onVoicePayload,
      onToast: this.onToast,
      onSessionUnavailable: this.onSessionUnavailable
    });
  }

  /**
   * Worker-composed speech is a v1 concept. In this lane the model speaks
   * directly over WebRTC, so there is never a payload to play.
   */
  playWorkerSpeechFromPayload() {}

  acceptSessionPayload(payload) {
    return this.controller.acceptSessionPayload?.(payload);
  }
}

/**
 * Build the controller for whichever lane this deployment runs.
 *
 * The v2 controller is returned as-is: it already answers every call site, and
 * wrapping it would only add a layer to step through when something breaks.
 */
export function createVoiceLaneController({ lane, ...options } = {}) {
  return lane === LIVE_LANE
    ? new LiveVoiceLaneAdapter(options)
    : createRealtimeVoiceController(options);
}
