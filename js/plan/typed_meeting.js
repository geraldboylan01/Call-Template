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
  getTypedMeeting,
  sendTypedMessage
} from './api.js';
import { composeCardTurn } from '../planning/module_input_display.js';
import { describePlanningCompletion } from './completion.js';
import { clearTypedMeeting, getSessionId, getStoredTypedMeeting, mergePayload, state, storeTypedMeeting } from './store.js';

const MAX_MESSAGE_CHARACTERS = 4_000;

// One status request every two seconds only while execution is pending. The
// session endpoint is read when results exist, to verify their exact identity.
const COMPLETION_RETRY_MS = 2_000;
const TERMINAL_MEETING_STATUSES = new Set(['ended', 'expired', 'failed', 'budget_exhausted', 'completed', 'cancelled']);
const RUNNING_PLAN_STATUSES = new Set(['approved', 'executing', 'pending', 'running']);
// What the screen says while a typed turn is with the planner. Plain progress,
// no invented percentage and no promised time.
const THINKING_STAGES = Object.freeze([
  'Planéir is thinking…',
  'Planéir is going back over what you have told it…',
  'Planéir is checking the figures before it reads them back…',
  'Still working. Your answers are saved.'
]);
const THINKING_STAGE_MS = 12_000;
// How long the browser keeps looking for a reply whose HTTP response it lost.
// Thirty two-second polls covers a turn the server is still finishing; past
// that the client is told plainly rather than watching a spinner forever.
const MAX_TURN_RECOVERY_ATTEMPTS = 30;

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
    this.sessionId = '';
    this.controlCapability = '';
    this.active = false;
    this.sending = false;
    this.transcript = [];
    this.navigated = false;
    this.awaitingExecution = false;
    // Looking for a reply whose HTTP response was lost, and how long for.
    this.recoveringTurn = false;
    this.recoveryAttempts = 0;
    this.thinkingTimer = null;
    this.abandoned = false;
    this.startPromise = null;
    this.generation = 0;
    this.completionTimer = null;
    this.completionPromise = null;
    this.root = null;
    this.cardNode = null;
    this.cardEntries = new Map();
    this.carriedCardValues = new Map();
  }

  /* ------------------------------------------------------------- lifecycle */

  isAvailable() {
    const bootstrap = state.bootstrap || {};
    return bootstrap.enabled === true
      && bootstrap.typedLaneEnabled === true
      && Boolean(getSessionId());
  }

  /**
   * Open the meeting, at most once.
   *
   * `active` is only true once the server has answered, so guarding on it let a
   * second call -- a double-click, a re-render, a retry -- open a SECOND
   * meeting while the first was still in flight. Each one reserves the whole
   * remaining session budget, so the second is not merely untidy: it is the
   * client's next meeting, spent. The in-flight promise is the guard, and
   * concurrent callers await the same open rather than racing it.
   */
  async start(root) {
    if (this.startPromise) {
      if (!this.abandoned && this.sessionId === getSessionId()) return this.startPromise;
      // A late create response still has to be closed. Reopening first could
      // replay that lease and then have its predecessor close the new screen.
      await this.startPromise;
      return this.start(root);
    }
    if (this.active && this.sessionId === getSessionId()) return undefined;
    this.stopPolling();
    const generation = ++this.generation;
    this.sessionId = getSessionId();
    this.leaseId = '';
    this.controlCapability = '';
    this.abandoned = false;
    this.active = false;
    this.sending = false;
    this.navigated = false;
    this.awaitingExecution = false;
    this.transcript = [];
    this.cardNode = null;
    this.cardEntries = new Map();
    this.carriedCardValues = new Map();
    const starting = this.openMeeting(root, generation);
    this.startPromise = starting;
    try {
      return await starting;
    } finally {
      if (this.startPromise === starting) this.startPromise = null;
    }
  }

  isCurrent(generation) {
    return generation === this.generation && !this.abandoned && this.sessionId === getSessionId();
  }

  async openMeeting(root, generation) {
    this.root = root;
    this.renderShell();
    this.setStatus('Starting your planning session…');
    const sessionId = this.sessionId;
    if (!sessionId) {
      this.onFailure({ message: 'The planning session could not be found. Please try again.' });
      return;
    }
    try {
      const saved = getStoredTypedMeeting(sessionId);
      const opening = saved || {
        requestId: newPrivateId('typed'),
        activationId: newPrivateId('rt_activation'),
        controlCapability: newPrivateId('rt_control')
      };
      // Save BEFORE POST: a lost response must replay the original reservation
      // instead of abandoning its control capability and opening another one.
      if (!saved) storeTypedMeeting(sessionId, opening);
      const meeting = saved?.leaseId
        ? await getTypedMeeting(sessionId, saved.leaseId, saved)
        : await createTypedMeeting(sessionId, opening);
      const leaseId = String(meeting.leaseId || '');
      const controlCapability = String(opening.controlCapability || meeting.controlCapability || '');
      if (!leaseId || !controlCapability) {
        throw new Error('The typed meeting did not open.');
      }
      // THE CLIENT LEFT WHILE THIS WAS OPENING.
      //
      // A meeting that arrives after they have gone must be closed, not shown.
      // Leaving it open holds their whole budget against a conversation nobody
      // is having, and showing it reopens a screen they deliberately left.
      if (!this.isCurrent(generation)) {
        await endTypedMeeting(sessionId, leaseId, { controlCapability }).catch(() => {});
        clearTypedMeeting(sessionId, saved?.leaseId, opening.activationId);
        return;
      }
      this.leaseId = leaseId;
      this.controlCapability = controlCapability;
      this.active = true;
      storeTypedMeeting(sessionId, { leaseId, controlCapability });
      this.setStatus('');
      if (Array.isArray(meeting.turns)) this.restoreTurns(meeting.turns);
      else if (meeting.assistantText) this.pushTurn('assistant', meeting.assistantText);
      this.renderCard(meeting.card);
      await this.observeMeeting(meeting, generation);
      this.focusComposer();
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      if (this.active && ![401, 403, 404, 410].includes(error?.status)) {
        this.setStatus('Reconnecting to your planning session…');
        this.scheduleCompletion(generation);
        return;
      }
      this.onFailure({
        message: error?.message || 'Planéir could not start your typed meeting. Please try again.'
      });
    }
  }

  async end(reason = 'consumer_closed') {
    // Recorded before the early return: a meeting still opening has no lease to
    // close yet, and `openMeeting` closes the one that arrives late.
    this.abandoned = true;
    this.active = false;
    this.generation += 1;
    this.sending = false;
    this.stopPolling();
    if (!this.leaseId) {
      clearTypedMeeting(this.sessionId);
      return;
    }
    const { sessionId, leaseId, controlCapability } = this;
    this.leaseId = '';
    this.controlCapability = '';
    clearTypedMeeting(sessionId, leaseId);
    try {
      await endTypedMeeting(sessionId, leaseId, { controlCapability });
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
  async send(text, { inputMode = 'text', unknownFieldId = '' } = {}) {
    const message = String(text || '').trim().slice(0, MAX_MESSAGE_CHARACTERS);
    if (!message || !this.active || this.sending || this.sessionId !== getSessionId()) return;
    const generation = this.generation;
    this.sending = true;
    this.pushTurn('user', message);
    this.setComposerValue('');
    this.setThinking(true);
    // Cleared optimistically so the box is ready for the next thought, but
    // remembered: if the send fails, the client gets their own wording back
    // rather than being asked to retype a correction they already made.
    const draft = message;
    try {
      const result = await sendTypedMessage(this.sessionId, this.leaseId, {
        text: message,
        inputMode,
        unknownFieldId,
        controlCapability: this.controlCapability
      });
      // THE CLIENT MAY HAVE LEFT WHILE THIS TURN WAS IN FLIGHT.
      //
      // Everything below writes to a screen they are no longer on, and
      // `checkCompletion` would navigate them into a session they closed.
      if (!this.isCurrent(generation)) return;
      if (result.assistantText) this.pushTurn('assistant', result.assistantText, { readback: result.readback });
      // A read-back is the ONLY moment a plan can start running, so it is the
      // only moment worth watching for results. Polling the session after every
      // turn would be a request per sentence for an event that happens once.
      if (result.readback === true) this.awaitingExecution = true;
      else if (this.awaitingExecution) await this.checkCompletion();
      if (!this.isCurrent(generation)) return;
      this.renderCard(result.card);
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      // The turn is already durable on the server whatever happened here, so
      // the client is told the reply failed -- never that their answer was lost.
      if (!this.composerNode?.value) this.setComposerValue(draft);
      this.onToast(
        error?.message || 'That did not send. Your answers are safe — please try again.',
        { tone: 'error' }
      );
      // THE SERVER'S WORK SURVIVES A LOST RESPONSE; the screen has to as well.
      //
      // This used to recover only an approval, because approval is the moment
      // results appear. But a COLLECTING turn is the common case and it was
      // silently unrecoverable: the client turn is persisted before the planner
      // runs, so the assistant reply the server went on to produce sat in
      // durable storage, invisible, while the client saw an error, a stale card
      // and their own message. Retyping it then created a second turn of the
      // same answer. A planning turn is slow on purpose -- that is the whole
      // point of this transport -- so losing one reply must never cost the
      // reply, and every failed send now looks for what actually landed.
      this.recoveringTurn = true;
      this.recoveryAttempts = 0;
      await this.checkCompletion();
    } finally {
      if (this.isCurrent(generation)) {
        this.sending = false;
        this.setThinking(false);
        this.focusComposer();
      }
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
    if (this.navigated || this.abandoned || this.sessionId !== getSessionId()) return;
    if (this.completionPromise) return this.completionPromise;
    const generation = this.generation;
    const checking = this.pollMeeting(generation);
    this.completionPromise = checking;
    try { await checking; }
    finally { if (this.completionPromise === checking) this.completionPromise = null; }
  }

  stopPolling() {
    window.clearTimeout(this.completionTimer);
    this.completionTimer = null;
    this.completionPromise = null;
  }

  scheduleCompletion(generation) {
    if (!this.isCurrent(generation) || this.navigated || this.completionTimer) return;
    this.completionTimer = window.setTimeout(() => {
      this.completionTimer = null;
      if (this.isCurrent(generation)) void this.checkCompletion();
    }, COMPLETION_RETRY_MS);
  }

  async pollMeeting(generation) {
    try {
      const meeting = await getTypedMeeting(this.sessionId, this.leaseId, { controlCapability: this.controlCapability });
      if (!this.isCurrent(generation)) return;
      await this.observeMeeting(meeting, generation);
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      if ([401, 403, 404, 410].includes(error?.status)) {
        this.active = false;
        this.onFailure({ message: error.message });
        return;
      }
      this.setStatus('Reconnecting to your planning session…');
      this.scheduleCompletion(generation);
    }
  }

  async observeMeeting(meeting, generation) {
    if (!this.isCurrent(generation)) return;
    const execution = meeting.realtimeExecution;
    const status = String(execution?.status || meeting.analysisPlan?.status || '');
    if (['complete', 'partial'].includes(status)) {
      const payload = await getSession(this.sessionId);
      if (!this.isCurrent(generation)) return;
      const completion = describePlanningCompletion(payload, execution || meeting.analysisPlan);
      if (completion.ready) {
        mergePayload(payload);
        this.navigated = true;
        this.awaitingExecution = false;
        await this.end('completed');
        // end invalidates the meeting, but a new session may also have begun
        // while its DELETE was in flight.
        if (this.generation === generation + 1 && this.sessionId === getSessionId()) this.onNavigate('results');
        return;
      }
      this.setStatus('Your results are being saved…');
      this.scheduleCompletion(generation);
      return;
    }
    const meetingStatus = String(meeting.status || meeting.realtimeLease?.status || '');
    if (TERMINAL_MEETING_STATUSES.has(meetingStatus) || ['failed', 'cancelled'].includes(status)) {
      this.active = false;
      this.stopPolling();
      this.onFailure({ message: 'Your meeting has ended before results were ready. Your saved answers are still available.', transcript: this.transcriptForCopy() });
      return;
    }
    if (Array.isArray(meeting.turns)) this.restoreTurns(meeting.turns);
    if (meeting.card) this.renderCard(meeting.card);
    if (this.recoveringTurn) {
      // The durable transcript ending in the client's own words means the
      // planner has not finished the turn yet; an assistant turn after it means
      // the reply we lost has been recovered, along with its card.
      if (this.transcript.at(-1)?.role === 'assistant') {
        this.recoveringTurn = false;
        this.setStatus('');
      } else if (this.recoveryAttempts < MAX_TURN_RECOVERY_ATTEMPTS) {
        this.recoveryAttempts += 1;
        this.setStatus('Reconnecting to your planning session…');
        this.scheduleCompletion(generation);
        return;
      } else {
        this.recoveringTurn = false;
        this.setStatus('');
      }
    }
    if (RUNNING_PLAN_STATUSES.has(status)) {
      this.awaitingExecution = true;
      this.setStatus('Planéir is preparing your results…');
      this.scheduleCompletion(generation);
    } else if (status) {
      // A correction may have returned the plan to collection or confirmation.
      this.awaitingExecution = status === 'awaiting_confirmation';
      this.stopPolling();
      this.setStatus('');
    } else if (this.awaitingExecution) {
      this.scheduleCompletion(generation);
    }
  }

  restoreTurns(turns) {
    if (!Array.isArray(turns)) return;
    const normalized = turns.filter((turn) => ['user', 'assistant'].includes(turn.role))
      .map((turn) => ({ role: turn.role, text: String(turn.text || turn.transcript || '').trim() }))
      .filter((turn) => turn.text);
    if (JSON.stringify(normalized) === JSON.stringify(this.transcript)) return;
    this.transcript = [];
    this.threadNode?.replaceChildren();
    this.cardNode = null;
    for (const turn of normalized) this.pushTurn(turn.role, turn.text);
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
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
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
    // WHAT THE CLIENT HAD ALREADY TYPED SURVIVES THE RE-RENDER.
    //
    // The card is rebuilt from the planner on every turn, and a client is
    // explicitly invited to ask a question mid-card ("why do you need that?").
    // Without this, asking would silently wipe the two figures they had just
    // entered -- which is precisely the trap a structured input must not be.
    // Values are carried by field id, so anything the planner has since
    // answered or dropped simply does not come back.
    const carried = new Map();
    for (const [id, entry] of this.cardEntries) {
      const value = String(entry.input?.value || '').trim();
      if (value) carried.set(id, value);
    }
    this.cardNode?.remove();
    this.cardNode = null;
    this.cardEntries = new Map();
    this.carriedCardValues = carried;
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
      // An <option> with no value attribute reports its TEXT as its value, so
      // an untouched select submitted "Choose…" to the planner as though the
      // client had said it -- a made-up answer, quoted as evidence.
      const placeholder = element('option', '', 'Choose…');
      placeholder.value = '';
      input.append(placeholder);
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
    unsure.addEventListener('click', () => void this.send(
      `I don't know ${label.toLowerCase()}.`,
      // The id tells the server to stop asking. The sentence tells the planner
      // what happened. Both are needed: one ends the loop, the other keeps the
      // transcript an honest record of the conversation.
      { inputMode: 'form', unknownFieldId: field.unknownFieldId || field.id }
    ));
    wrap.append(unsure);

    const carried = this.carriedCardValues?.get(field.id);
    if (carried) input.value = carried;
    this.cardEntries.set(field.id, { field, input, label });
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

  /**
   * A long typed turn is not a broken one, and the screen has to say so.
   *
   * The planner runs to completion before the reply, and a full pass -- read
   * the conversation, check it, repair a citation, check again -- has been
   * measured at over fifty seconds. An unchanging spinner for that long reads
   * as a hang, and a client who reloads or retypes at forty seconds turns a
   * working turn into a duplicate one. So the wording moves on while the work
   * does, and never promises a time it cannot keep.
   */
  setThinking(active) {
    if (this.sendNode) this.sendNode.disabled = active === true;
    if (this.composerNode) this.composerNode.readOnly = active === true;
    window.clearTimeout(this.thinkingTimer);
    this.thinkingTimer = null;
    if (!active) {
      if (THINKING_STAGES.includes(this.statusNode?.textContent)) this.setStatus('');
      return;
    }
    let stage = 0;
    this.setStatus(THINKING_STAGES[stage]);
    const advance = () => {
      stage += 1;
      if (stage >= THINKING_STAGES.length) return;
      this.setStatus(THINKING_STAGES[stage]);
      this.thinkingTimer = window.setTimeout(advance, THINKING_STAGE_MS);
    };
    this.thinkingTimer = window.setTimeout(advance, THINKING_STAGE_MS);
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
