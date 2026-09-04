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
import { composeCardTurn } from '../planning/module_input_display.js';
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

/** The whole component layer, matching views.js. Text only, never markup. */
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
    this.cardNode = null;
    this.cardEntries = new Map();
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
      this.renderCard(result.card);
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

  /* ------------------------------------------------------------------ card */

  /**
   * Draw the compact module card, if the planner has one.
   *
   * It lives INSIDE the conversation, at the bottom, and scrolls with it. A
   * fixed panel beside the thread would make this a dashboard with a chat box
   * attached, which is the shape this mode exists to avoid.
   */
  renderCard(card) {
    this.cardNode?.remove();
    this.cardNode = null;
    this.cardEntries = new Map();
    const modules = Array.isArray(card?.modules) ? card.modules : [];
    const active = modules.find((module) => module.expanded && module.fields.length > 0);
    if (!modules.length) return;

    const wrap = element('div', 'typed-card-stack');

    // Everything not being collected for right now collapses to one line.
    // Only one card is ever open: a screen showing three at once is a form.
    for (const module of modules) {
      if (module === active) continue;
      const line = element('p', 'typed-card-summary',
        `${module.title} — ${module.status === 'ready' ? 'ready' : 'in progress'}`);
      wrap.append(line);
    }

    if (active) wrap.append(this.renderModuleCard(active));
    if (!wrap.childNodes.length) return;
    this.cardNode = wrap;
    this.threadNode?.append(wrap);
    wrap.scrollIntoView({ block: 'nearest' });
  }

  renderModuleCard(module) {
    const card = element('section', 'typed-card');
    card.setAttribute('aria-label', module.title);
    card.append(element('h3', 'typed-card-title', module.title));

    // Say whose idea this was, honestly. Telling someone they asked for an
    // analysis they never mentioned is a small lie about their own conversation.
    if (module.reason) {
      card.append(element('p', 'typed-card-reason',
        module.origin === 'client_requested' ? module.reason : `I think this would help: ${module.reason}`));
    }

    // What Planéir already has. Shown so the client sees their own answers
    // reflected instead of wondering whether they landed.
    if (module.known.length) {
      const known = element('ul', 'typed-card-known');
      for (const item of module.known.slice(0, 8)) {
        const row = element('li', 'typed-card-known-row');
        row.append(element('span', 'typed-card-tick', '✓'));
        row.append(element('span', 'typed-card-known-label', item.label));
        row.append(element('span', 'typed-card-known-value', item.value));
        known.append(row);
      }
      card.append(known);
    }

    const fieldList = element('div', 'typed-card-fields');
    for (const field of module.fields) fieldList.append(this.renderField(field));
    card.append(fieldList);

    // "+ Add" adds ONE row. A grid of empty rows is the thing that makes a
    // fact-find feel like paperwork.
    for (const group of module.collections || []) {
      const actions = element('div', 'typed-card-collection');
      const add = element('button', 'typed-card-add', group.addLabel);
      add.type = 'button';
      add.addEventListener('click', () => {
        void this.send(`${group.addLabel}.`, { inputMode: 'form' });
      });
      const none = element('button', 'typed-card-none', group.noneLabel);
      none.type = 'button';
      none.addEventListener('click', () => {
        void this.send(`${group.noneLabel}.`, { inputMode: 'form' });
      });
      actions.append(add, none);
      card.append(actions);
    }

    if (module.assumptions?.length) {
      card.append(element('p', 'typed-card-assumptions',
        `Planéir will use its standard planning figures for ${module.assumptions.join(', ')}.`));
    }

    const save = element('button', 'primary-button typed-card-save', 'Save these');
    save.type = 'button';
    save.addEventListener('click', () => void this.submitCard());
    const actions = element('div', 'typed-card-actions');
    actions.append(save);
    actions.append(element('p', 'typed-card-hint',
      'Leave anything you are not sure about — you can also just ask me about it below.'));
    card.append(actions);
    return card;
  }

  renderField(field) {
    const wrap = element('div', 'typed-field');
    const label = field.label || field.question;
    const input = field.kind === 'choice'
      ? element('select', 'typed-field-input')
      : element('input', 'typed-field-input');
    input.id = `typed-field-${field.id}`;
    if (field.kind === 'choice') {
      input.append(element('option', '', 'Choose…'));
      for (const option of field.options || []) {
        const node = element('option', '', option.label);
        node.value = option.value;
        input.append(node);
      }
    } else {
      input.type = ['money', 'number', 'age', 'year'].includes(field.kind) ? 'number' : 'text';
      input.inputMode = input.type === 'number' ? 'decimal' : 'text';
      if (field.kind === 'money') input.placeholder = '€';
      if (field.kind === 'rate') input.placeholder = '%';
    }
    const labelNode = element('label', 'typed-field-label', label);
    labelNode.htmlFor = input.id;

    wrap.append(labelNode, input);
    // WHY DO YOU NEED THAT? Asking is a first-class action, not an escape
    // hatch: the client stays in the conversation and the field stays put.
    if (field.why || field.question) {
      const ask = element('button', 'typed-field-ask', 'Why?');
      ask.type = 'button';
      ask.setAttribute('aria-label', `Why does Planéir need ${label}?`);
      ask.addEventListener('click', () => void this.send(`Why do you need ${label.toLowerCase()}?`));
      wrap.append(ask);
    }
    // NOT SURE is an answer, and it has to leave as one. Until the planner
    // carries an acknowledged-unknown state (D-09) it reaches the model as the
    // sentence a client would have typed, which is the honest interim.
    const unsure = element('button', 'typed-field-unsure', 'Not sure');
    unsure.type = 'button';
    unsure.addEventListener('click', () => void this.send(`I don't know ${label.toLowerCase()}.`, { inputMode: 'form' }));
    wrap.append(unsure);

    this.cardEntries.set(field.id, { field, input, label: label });
    return wrap;
  }

  /**
   * Send everything the client filled in, as one turn.
   *
   * Unanswered fields are simply absent -- there is no validation here and no
   * "required" anywhere, because whether an analysis can run is the planner's
   * judgement and not this file's.
   */
  async submitCard() {
    const entries = [];
    for (const { field, input, label } of this.cardEntries.values()) {
      const raw = String(input.value || '').trim();
      if (!raw) continue;
      entries.push({ label, value: field.kind === 'rate' && !raw.includes('%') ? `${raw}%` : raw });
    }
    const text = composeCardTurn(entries);
    if (!text) {
      this.onToast('Fill in anything you know, or just ask me about it below.');
      return;
    }
    await this.send(text, { inputMode: 'form' });
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
