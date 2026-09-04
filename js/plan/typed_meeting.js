/**
 * TYPE MODE — Planéir chats, and uses the screen.
 *
 * WHAT THIS FILE IS NOT. It is not a second planning client. It composes no
 * questions, decides no relevance, holds no view of the client's finances and
 * validates no figures. Every question on screen was authored by the planner;
 * every answer leaves here as one ordinary client turn. The screen is a better
 * interface onto the same intelligence, not a second one.
 *
 * WHAT IT DELIBERATELY DOES NOT CREATE: no RTCPeerConnection, no getUserMedia,
 * no <audio>, no orb, no data channel. Choosing Type must cost the client no
 * microphone permission and no audio. `check-consumer-live.mjs` asserts this
 * file contains none of them.
 */

import {
  createTypedMeeting,
  endTypedMeeting,
  getSession,
  sendTypedMessage
} from './api.js';
import { describePlanningCompletion } from './completion.js';
import { getSessionId, mergePayload, state } from './store.js';

const MAX_MESSAGE_CHARACTERS = 4_000;

function newPrivateId(prefix) {
  const bytes = new Uint8Array(18);
  (window.crypto || {}).getRandomValues?.(bytes);
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return `${prefix}_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class TypedMeetingController {
  constructor({ onNavigate, onFailure, onToast } = {}) {
    this.onNavigate = onNavigate || (() => {});
    this.onFailure = onFailure || (() => {});
    this.onToast = onToast || (() => {});
    this.leaseId = '';
    this.controlCapability = '';
    this.active = false;
    this.sending = false;
    this.transcript = [];
    this.navigated = false;
    this.awaitingExecution = false;
    this.root = null;
  }

  /* ------------------------------------------------------------- lifecycle */

  isAvailable() {
    const bootstrap = state.bootstrap || {};
    return bootstrap.enabled === true
      && bootstrap.typedLaneEnabled === true
      && Boolean(getSessionId());
  }

  async start(root) {
    if (this.active) return;
    this.root = root;
    this.renderShell();
    this.setStatus('Starting your planning session…');
    const sessionId = getSessionId();
    if (!sessionId) {
      this.onFailure({ message: 'The planning session could not be found. Please try again.' });
      return;
    }
    try {
      const meeting = await createTypedMeeting(sessionId, {
        requestId: newPrivateId('typed'),
        activationId: newPrivateId('rt_activation'),
        controlCapability: newPrivateId('rt_control')
      });
      this.leaseId = String(meeting.leaseId || '');
      this.controlCapability = String(meeting.controlCapability || '');
      if (!this.leaseId || !this.controlCapability) {
        throw new Error('The typed meeting did not open.');
      }
      this.active = true;
      this.setStatus('');
      if (meeting.assistantText) this.pushTurn('assistant', meeting.assistantText);
      this.focusComposer();
    } catch (error) {
      this.onFailure({
        message: error?.message || 'Planéir could not start your typed meeting. Please try again.'
      });
    }
  }

  async end(reason = 'consumer_closed') {
    if (!this.leaseId) return;
    const { leaseId, controlCapability } = this;
    this.active = false;
    this.leaseId = '';
    try {
      await endTypedMeeting(getSessionId(), leaseId, { controlCapability });
    } catch (_error) {
      // Ending is best effort. The lease expires on its own, and telling the
      // client their finished meeting failed to finish would be noise.
      void reason;
    }
  }

  /* ----------------------------------------------------------------- turns */

  /**
   * Send one turn.
   *
   * `inputMode` is the only thing a structured card changes. The text it
   * submits is the client's own words, it travels the same route, and the
   * planner reads it the same way -- which is what stops the card and the chat
   * becoming two versions of the same finances.
   */
  async send(text, { inputMode = 'text' } = {}) {
    const message = String(text || '').trim().slice(0, MAX_MESSAGE_CHARACTERS);
    if (!message || !this.active || this.sending) return;
    this.sending = true;
    this.pushTurn('user', message);
    this.setComposerValue('');
    this.setThinking(true);
    try {
      const result = await sendTypedMessage(getSessionId(), this.leaseId, {
        text: message,
        inputMode,
        controlCapability: this.controlCapability
      });
      if (result.assistantText) this.pushTurn('assistant', result.assistantText, { readback: result.readback });
      // A read-back is the ONLY moment a plan can start running, so it is the
      // only moment worth watching for results. Polling the session after every
      // turn would be a request per sentence for an event that happens once.
      if (result.readback === true) this.awaitingExecution = true;
      else if (this.awaitingExecution) await this.checkCompletion();
    } catch (error) {
      // The turn is already durable on the server whatever happened here, so
      // the client is told the reply failed -- never that their answer was lost.
      this.onToast(
        error?.message || 'That did not send. Your answers are safe — please try again.',
        { tone: 'error' }
      );
    } finally {
      this.sending = false;
      this.setThinking(false);
      this.focusComposer();
    }
  }

  /**
   * Has the plan run?
   *
   * Reuses the SAME terminal-outcome test the voice meeting uses, over the same
   * session payload. A typed meeting must not invent its own idea of
   * "finished": that test requires a current, identity-matched, displayable
   * result and nothing weaker, and half of it lives in fields only the session
   * endpoint carries.
   */
  async checkCompletion() {
    if (this.navigated) return;
    try {
      mergePayload(await getSession(getSessionId()));
    } catch (_error) {
      // A failed refresh is not a failed plan. The next turn tries again.
      return;
    }
    const completion = describePlanningCompletion(state, null);
    if (!completion?.kind) return;
    this.navigated = true;
    this.awaitingExecution = false;
    await this.end('completed');
    this.onNavigate('results');
  }

  /* --------------------------------------------------------------- surface */

  renderShell() {
    const root = this.root;
    if (!root) return;
    root.replaceChildren();
    const shell = element('section', 'typed-meeting');
    shell.setAttribute('aria-label', 'Your planning conversation with Planéir');

    this.statusNode = element('p', 'typed-status');
    this.statusNode.setAttribute('role', 'status');
    this.statusNode.setAttribute('aria-live', 'polite');

    // The conversation is the page. Everything else sits inside it.
    this.threadNode = element('ol', 'typed-thread');
    this.threadNode.setAttribute('aria-label', 'Conversation');
    this.threadNode.setAttribute('aria-live', 'polite');

    const form = element('form', 'typed-composer');
    this.composerNode = element('textarea', 'typed-input');
    this.composerNode.id = 'typedMessageInput';
    this.composerNode.rows = 2;
    this.composerNode.maxLength = MAX_MESSAGE_CHARACTERS;
    this.composerNode.placeholder = 'Ask Planéir anything…';
    const label = element('label', 'visually-hidden', 'Message Planéir');
    label.htmlFor = this.composerNode.id;
    this.sendNode = element('button', 'primary-button typed-send', 'Send');
    this.sendNode.type = 'submit';

    form.append(label, this.composerNode, this.sendNode);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.send(this.composerNode.value);
    });
    // Enter sends; Shift+Enter is a new line. A planning answer is usually one
    // line, and reaching for a button after every sentence is friction.
    this.composerNode.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.send(this.composerNode.value);
      }
    });

    shell.append(this.statusNode, this.threadNode, form);
    root.append(shell);
  }

  pushTurn(role, text, { readback = false } = {}) {
    const value = String(text || '').trim();
    if (!value) return;
    this.transcript.push({ role, text: value });
    if (!this.threadNode) return;
    const row = element('li', `typed-turn is-${role === 'user' ? 'user' : 'assistant'}`);
    if (readback) row.classList.add('is-readback');
    row.append(element('span', 'typed-who', role === 'user' ? 'You' : 'Planéir'));
    // textContent throughout: model output is never trusted as markup.
    row.append(element('p', 'typed-bubble', value));
    this.threadNode.append(row);
    row.scrollIntoView({ block: 'nearest' });
  }

  setThinking(active) {
    if (this.sendNode) this.sendNode.disabled = active === true;
    if (this.composerNode) this.composerNode.readOnly = active === true;
    this.setStatus(active ? 'Planéir is thinking…' : '');
  }

  setStatus(text) {
    if (this.statusNode) this.statusNode.textContent = String(text || '');
  }

  setComposerValue(value) {
    if (this.composerNode) this.composerNode.value = String(value || '');
  }

  focusComposer() {
    this.composerNode?.focus?.();
  }

  transcriptForCopy() {
    return this.transcript.map((turn) => `${turn.role === 'user' ? 'You' : 'Planéir'}: ${turn.text}`).join('\n\n');
  }
}
