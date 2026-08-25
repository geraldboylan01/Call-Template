/**
 * ACTIVE CALL ADAPTER — LIVE LANE ONLY.
 *
 * There is deliberately no lane selector in production. Every browser call
 * uses `live_voice.js`, where the realtime model owns turn-taking and speaks
 * directly over WebRTC. The former controlled client is historical reference
 * code under `js/plan/legacy/` and must never be imported here.
 */

import { updateRealtimeVoiceConsent } from './api.js';
import { createLiveVoiceController, isLiveVoiceSupported } from './live_voice.js';
import {
  getRealtimeVoiceConsent,
  getSessionId,
  hasCurrentRealtimeVoiceConsent,
  mergeVoicePayload,
  state
} from './store.js';

const ADVISER_TEST_COHORT = 'adviser_test';

function safePrivacyUrl(value) {
  try {
    const url = new URL(String(value || ''), window.location.href);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      return url.href;
    }
  } catch (_error) {
    // An invalid disclosure URL makes the live meeting unavailable.
  }
  return '';
}

function liveMeetingContext() {
  const bootstrap = state.bootstrap || {};
  const savedConsent = getRealtimeVoiceConsent() || {};
  const noticeId = String(bootstrap.voiceRealtimeNoticeId || savedConsent.noticeId || '');
  const policyVersion = String(bootstrap.voiceRealtimePolicyVersion || savedConsent.policyVersion || '');
  const privacyNoticeUrl = safePrivacyUrl(
    bootstrap.voiceRealtimePrivacyNoticeUrl
    || bootstrap.privacyNoticeUrl
    || savedConsent.privacyNoticeUrl
    || ''
  );
  const serverSessionConfirmed = Boolean(state.session?.id || state.session?.sessionId);
  return {
    eligible: bootstrap.enabled === true
      && bootstrap.voiceRealtimeEnabled === true
      && String(bootstrap.cohort || '').toLowerCase() === ADVISER_TEST_COHORT,
    configured: Boolean(noticeId && policyVersion && privacyNoticeUrl),
    noticeId,
    policyVersion,
    privacyNoticeUrl,
    consentGranted: hasCurrentRealtimeVoiceConsent(),
    sessionId: serverSessionConfirmed ? getSessionId() : '',
    consentRefreshRequired: state.consentRefreshRequired === true
  };
}

export function liveMeetingAvailable() {
  const context = liveMeetingContext();
  return context.eligible
    && context.configured
    && Boolean(context.sessionId)
    && isLiveVoiceSupported()
    && !context.consentRefreshRequired;
}

export function liveMeetingUnavailableReason() {
  const context = liveMeetingContext();
  if (!isLiveVoiceSupported()) return 'unsupported-browser';
  if (!context.eligible || !context.configured) return 'service-off';
  if (!context.sessionId) return 'no-session';
  if (context.consentRefreshRequired) return 'consent-refresh';
  return '';
}

export function liveMeetingUnavailableDetail() {
  const context = liveMeetingContext();
  const bootstrap = state.bootstrap || {};
  return {
    reason: liveMeetingUnavailableReason(),
    journeyEnabled: bootstrap.enabled === true,
    realtimeFlagEnabled: bootstrap.voiceRealtimeEnabled === true,
    cohort: String(bootstrap.cohort || ''),
    cohortMatches: String(bootstrap.cohort || '').toLowerCase() === ADVISER_TEST_COHORT,
    noticesConfigured: context.configured,
    browserSupported: isLiveVoiceSupported(),
    serverSessionConfirmed: Boolean(context.sessionId),
    consentRefreshRequired: context.consentRefreshRequired === true
  };
}

async function withdrawLiveVoiceConsent({
  endMeeting = async () => {},
  afterWithdraw = () => {},
  onVoicePayload = () => {},
  onToast = () => {},
  onSessionUnavailable = () => false
} = {}) {
  const context = liveMeetingContext();
  if (!context.sessionId || getRealtimeVoiceConsent()?.granted !== true) return;
  const button = document.getElementById('withdrawRealtimeVoiceConsentButton');
  if (button) {
    button.disabled = true;
    button.textContent = 'Turning off…';
  }
  await endMeeting();
  try {
    const payload = await updateRealtimeVoiceConsent(context.sessionId, {
      granted: false,
      noticeId: context.noticeId,
      policyVersion: context.policyVersion,
      privacyNoticeUrl: context.privacyNoticeUrl
    });
    mergeVoicePayload(payload);
    onVoicePayload(payload);
    afterWithdraw();
    onToast('Live voice is off for this session.');
  } catch (error) {
    if (onSessionUnavailable(error)) return;
    onToast(error instanceof Error ? error.message : 'Live voice could not be turned off.', { error: true });
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Stop Live voice';
    }
  }
}

/**
 * The live lane's app-facing wrapper.
 *
 * The drawer chrome lives here rather than in the controller because it is not
 * lane behaviour: opening a panel, dimming the page and restoring focus works
 * the same whoever is talking.
 */
export class LiveVoiceLaneAdapter {
  constructor(options) {
    this.root = options?.root || null;
    this.onVoicePayload = options?.onVoicePayload || (() => {});
    this.onToast = options?.onToast || (() => {});
    this.onSessionUnavailable = options?.onSessionUnavailable || (() => false);
    this.onFailure = options?.onFailure || (() => {});
    this.controller = createLiveVoiceController({
      ...options,
      onFailure: (failure) => this.handleFailure(failure)
    });
    this.bound = false;
    this.expanded = false;
    this.lastFocusedElement = null;
  }

  handleFailure(failure = {}) {
    this.collapseCompanion({ restoreFocus: false });
    if (this.root) this.root.hidden = true;
    this.onFailure(failure);
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

  sync(currentState) {
    if (!this.isLive()) {
      const selectedTurns = currentState?.selectedRealtimeMeeting?.turns;
      const savedTurns = Array.isArray(selectedTurns) && selectedTurns.length > 0
        ? selectedTurns
        : currentState?.realtimeTurns;
      if (Array.isArray(savedTurns) && savedTurns.length > 0) {
        this.controller.replaceTranscript(savedTurns);
      }
    }
    const shouldShow = liveMeetingAvailable();
    if (this.root) this.root.hidden = !shouldShow;
    if (!shouldShow && this.isLive()) void this.end({ reason: 'navigation' });
    if (!shouldShow && this.expanded) this.collapseCompanion({ restoreFocus: false });
  }

  isLive() {
    return this.controller.active === true;
  }

  isMeetingAvailable() {
    return liveMeetingAvailable();
  }

  meetingUnavailableReason() {
    return liveMeetingUnavailableReason();
  }

  meetingUnavailableDetail() {
    return liveMeetingUnavailableDetail();
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
    return withdrawLiveVoiceConsent({
      endMeeting: () => this.end({ reason: 'consent_withdrawn' }),
      afterWithdraw: () => {
        this.collapseCompanion({ restoreFocus: false });
        this.controller.setPhase('off', 'Live voice is off. You can continue by typing.');
      },
      onVoicePayload: this.onVoicePayload,
      onToast: this.onToast,
      onSessionUnavailable: this.onSessionUnavailable
    });
  }

  acceptSessionPayload(payload) {
    return this.controller.acceptSessionPayload?.(payload);
  }
}

/** Build the one and only active browser call controller. */
export function createLiveVoiceLaneController(options = {}) {
  return new LiveVoiceLaneAdapter(options);
}
