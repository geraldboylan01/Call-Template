/**
 * The Live voice disclosure for the active live call controller.
 *
 * WHY THIS IS SHARED AND NOT LANE BEHAVIOUR. The disclosure is page chrome:
 * one <dialog> in plan/index.html, one Worker endpoint, one receipt. Which
 * conversation lane happens to be running has nothing to do with it.
 *
 * It lives here because it was previously reachable only as methods on the
 * now-archived controlled controller. When the live controller first replaced
 * it, the disclosure could not be opened,
 * and its form was never bound — meaning it could not have been submitted even
 * if something had opened it. A client whose receipt went stale got
 * "Review and accept the current live voice disclosure before starting."
 * with no disclosure and no way to accept: the meeting could be neither
 * started nor re-agreed, and every retry repeated it.
 *
 * The active live controller now owns this one implementation.
 */

import { updateRealtimeVoiceConsent } from './api.js';
import {
  clearRealtimeVoiceConsent,
  hasCurrentRealtimeVoiceConsent,
  mergeVoicePayload
} from './store.js';

const ELEMENT_IDS = Object.freeze({
  dialog: 'realtimeVoiceConsentDialog',
  form: 'realtimeVoiceConsentForm',
  checkbox: 'realtimeVoiceConsentAcknowledgement',
  policy: 'realtimeVoiceConsentPolicy',
  privacyLink: 'realtimeVoiceConsentPrivacyLink',
  error: 'realtimeVoiceConsentError',
  cancel: 'cancelRealtimeVoiceConsentButton'
});

const element = (key) => document.getElementById(ELEMENT_IDS[key]) || null;

/** The Worker's word for "this receipt is not the current disclosure". */
const CONSENT_REQUIRED_CODE = 'realtime_consent_required';

export function isConsentRequiredError(error) {
  return String(error?.code || '') === CONSENT_REQUIRED_CODE;
}

export function showConsentError(message) {
  const error = element('error');
  if (!error) return;
  error.textContent = String(message || 'Live voice consent could not be saved.');
  error.hidden = false;
}

export function closeConsentDialog() {
  const dialog = element('dialog');
  if (typeof dialog?.close === 'function' && dialog.open) dialog.close();
  else dialog?.removeAttribute('open');
  document.body?.classList?.remove('dialog-open');
}

/**
 * Put the disclosure on screen.
 *
 * @returns {boolean} whether a disclosure is now visible. A caller that gets
 *   `false` has nothing to offer the client and must say so rather than
 *   leaving them with an error they cannot act on.
 */
export function openConsentDialog({ noticeId, policyVersion, privacyNoticeUrl } = {}) {
  const dialog = element('dialog');
  const checkbox = element('checkbox');
  if (!dialog || !checkbox) return false;
  checkbox.checked = false;
  checkbox.disabled = false;
  const policy = element('policy');
  if (policy && noticeId && policyVersion) {
    policy.textContent = `Disclosure ${noticeId} · policy ${policyVersion}`;
  }
  const privacyLink = element('privacyLink');
  if (privacyLink && privacyNoticeUrl) privacyLink.href = privacyNoticeUrl;
  const error = element('error');
  if (error) {
    error.hidden = true;
    error.textContent = '';
  }
  document.body?.classList?.add('dialog-open');
  if (!dialog.open) {
    try {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } catch (_error) {
      // Older Safari builds expose <dialog> incompletely. The styled `open`
      // fallback still presents the disclosure and keeps the client unblocked.
      dialog.setAttribute('open', '');
    }
  }
  window.requestAnimationFrame?.(() => checkbox.focus());
  return true;
}

/**
 * Record agreement to the CURRENT disclosure, then hand back to the caller.
 *
 * The Worker is authoritative: if it does not confirm a current receipt, this
 * reports failure rather than letting the caller walk into the same refusal.
 */
export async function submitConsent(form, {
  sessionId,
  noticeId,
  policyVersion,
  privacyNoticeUrl,
  onVoicePayload = () => {},
  onAccepted = () => {}
} = {}) {
  if (typeof form?.reportValidity === 'function' && !form.reportValidity()) return false;
  if (!sessionId) {
    showConsentError('Live voice is not configured for this private session.');
    return false;
  }
  const submit = form?.querySelector?.('[type="submit"]') || null;
  const cancel = element('cancel');
  const checkbox = element('checkbox');
  if (submit) {
    submit.disabled = true;
    submit.textContent = 'One moment…';
  }
  if (cancel) cancel.disabled = true;
  if (checkbox) checkbox.disabled = true;
  try {
    const payload = await updateRealtimeVoiceConsent(sessionId, {
      granted: true,
      noticeId,
      policyVersion,
      privacyNoticeUrl
    });
    mergeVoicePayload(payload);
    onVoicePayload(payload);
    if (!hasCurrentRealtimeVoiceConsent()) {
      throw new Error('The service did not confirm Live voice consent for the current disclosure.');
    }
    closeConsentDialog();
    onAccepted();
    return true;
  } catch (error) {
    showConsentError(error instanceof Error
      ? error.message
      : 'Your agreement could not be saved. Please try again.');
    return false;
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.textContent = 'Agree and start my meeting';
    }
    if (cancel) cancel.disabled = false;
    if (checkbox) checkbox.disabled = false;
  }
}

/**
 * Bind the disclosure form once, for a lane that would otherwise never bind it.
 *
 * @returns {() => void} an unbind function.
 */
export function bindConsentForm(handler) {
  const form = element('form');
  if (!form || typeof form.addEventListener !== 'function') return () => {};
  const listener = (event) => {
    event.preventDefault?.();
    handler(form);
  };
  form.addEventListener('submit', listener);
  const cancel = element('cancel');
  const cancelListener = () => closeConsentDialog();
  cancel?.addEventListener?.('click', cancelListener);
  return () => {
    form.removeEventListener('submit', listener);
    cancel?.removeEventListener?.('click', cancelListener);
  };
}

/**
 * The whole recovery, for a lane that has just been refused for consent.
 *
 * The local receipt is discarded first: the Worker has said it is not current,
 * so anything the client still believes about it is wrong by definition, and
 * a stale receipt left in place is what previously made the disclosure decide
 * it had nothing to show.
 */
export function beginConsentRecovery(context) {
  clearRealtimeVoiceConsent();
  return openConsentDialog(context);
}
