#!/usr/bin/env node
// Free browser-controller regressions: real controller and HTTP adapter,
// synthetic DOM/network only. No model answers or financial maths are mocked.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

// Local to this file: the synthetic DOM these checks run against. It was
// exported without an importer, which is what the stale-export ratchet is for.
class TestNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map();
    this.dataset = {}; this.listeners = new Map(); this._value = null; this.hidden = false;
    this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map((node) => node.textContent ?? node).join(''); }
  get childNodes() { return this.children; }
  set value(value) { this._value = String(value); }
  get value() { return this._value ?? (this.tagName === 'OPTION' ? this.textContent : ''); }
  append(...nodes) { for (const node of nodes.flat()) { if (!node) continue; if (typeof node === 'object') node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.text = ''; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type) { this.listeners.delete(type); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const match = (node) => selector.startsWith('#') ? node.id === selector.slice(1)
      : selector.startsWith('.') ? String(node.className || '').split(' ').includes(selector.slice(1))
        : selector.split(',').some((tag) => node.tagName === tag.trim().toUpperCase());
    return this.children.filter((node) => typeof node === 'object').flatMap((node) => [ ...(match(node) ? [node] : []), ...node.querySelectorAll(selector) ]);
  }
  scrollIntoView() {}
  focus() {}
}

const storage = new Map();
globalThis.window = {
  location: { hostname: 'localhost', href: 'http://localhost/plan/', hash: '' },
  crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (callback) => callback(),
  sessionStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
  matchMedia: () => ({ matches: false })
};
const nodes = new Map();
globalThis.document = {
  createElement: (tag) => new TestNode(tag), querySelector: () => null,
  getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, new TestNode()); return nodes.get(id); },
  addEventListener() {}, body: new TestNode('body')
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: {} } });
const { TypedMeetingController } = await import('../js/plan/typed_meeting.js');
const { state, resetJourneyState, storeSessionAccess, getStoredTypedMeeting } = await import('../js/plan/store.js');
const leaseId = 'rt_frontend_recovery_1234567890';
const sessionId = 'cs_frontend_recovery_1234567890';
// 20+ characters after the prefix, because that is what the client actually
// generates and what realtimeControlHeaders enforces. The previous fixture was
// one character short, so every DELETE it drove was refused before it left the
// browser -- which made this file unable to observe the close it asserts.
const access = { leaseId, controlCapability: 'rt_control_frontend_12345678901' };
const execution = { planId: 'plan_current', profileRevision: 3, status: 'complete', analysisRunId: 'analysis_current' };
const completed = {
  session: { id: sessionId, currentProfileRevision: 3, stage: 'results' },
  analysisPlan: { ...execution, leaseId },
  analysis: { id: 'analysis_current', profileRevision: 3, status: 'complete', moduleRuns: [{ moduleId: 'mortgage_analysis', status: 'complete', outputs: {} }] }
};
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function init(options = {}) {
  storage.clear(); resetJourneyState();
  storeSessionAccess({ id: sessionId }, 'credential_frontend_recovery');
  state.session = { id: sessionId, currentProfileRevision: 3 };
  state.bootstrap = { enabled: true, typedLaneEnabled: true };
  return new TypedMeetingController(options);
}

test('Repeated start while opening creates exactly one lease', async () => {
  const gate = deferred(); let creates = 0;
  const c = init();
  globalThis.fetch = async () => { creates += 1; await gate.promise; return response(access); };
  const first = c.start(new TestNode()); const second = c.start(new TestNode());
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(creates, 1);
  await c.end();
});

test('Ending during startup closes the late lease and does not reopen the conversation', async () => {
  const gate = deferred(); let deletes = 0;
  const c = init();
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'DELETE') { deletes += 1; return response({}); }
    await gate.promise; return response(access);
  };
  const starting = c.start(new TestNode()); await c.end(); gate.resolve(); await starting;
  assert.equal(c.active, false); assert.equal(deletes, 1);
});

test('A lost create response reuses the saved activation and capability after refresh', async () => {
  const c = init(); const requests = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'DELETE') return response({});
    requests.push(Object.fromEntries(options.headers));
    if (requests.length === 1) throw new Error('Response lost after creating the meeting');
    return response({ ...access, controlCapability: options.headers.get('X-Realtime-Control-Capability'), assistantText: 'Welcome back.' });
  };
  await c.start(new TestNode());
  const refreshed = new TypedMeetingController();
  try {
    await refreshed.start(new TestNode());
    for (const header of ['x-voice-request-id', 'x-realtime-activation-id', 'x-realtime-control-capability']) {
      assert.ok(requests[0][header]);
      assert.equal(requests[1][header], requests[0][header], `${header} must survive a lost create response`);
    }
    assert.equal(refreshed.active, true);
  } finally { await refreshed.end(); }
});

test('Reopening after ending an unresolved startup waits for its late close', async () => {
  const gate = deferred(); const calls = []; const c = init();
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'DELETE') { calls.push('close'); return response({}); }
    calls.push('create');
    if (calls.length === 1) await gate.promise;
    return response(access);
  };
  const first = c.start(new TestNode()); await c.end();
  const reopened = c.start(new TestNode());
  await sleep(0); assert.deepEqual(calls, ['create']);
  gate.resolve(); await Promise.all([first, reopened]);
  try { assert.deepEqual(calls, ['create', 'close', 'create']); assert.equal(c.active, true); }
  finally { await c.end(); }
});

test('Completion retries a transient session read without requiring another client turn', async () => {
  let reads = 0; let navigated = 0;
  const c = init({ onNavigate: () => { navigated += 1; } });
  c.active = true; c.sessionId = sessionId; Object.assign(c, access); c.awaitingExecution = true;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'DELETE') return response({});
    if (String(url).includes('/text/meetings/')) return response({ realtimeExecution: execution });
    if (options.method === 'POST') return response({ assistantText: 'Your results are ready.' });
    reads += 1;
    return reads === 1 ? response({ error: { message: 'Temporary outage' } }, 503) : response(completed);
  };
  // Route POST separately from the lease read.
  const fetcher = globalThis.fetch;
  globalThis.fetch = (url, options) => options.method === 'POST'
    ? Promise.resolve(response({ assistantText: 'Your results are ready.' })) : fetcher(url, options);
  await c.send('Yes, go ahead.');
  await sleep(2400);
  assert.equal(navigated, 1);
  await c.end();
});

test('A failed message leaves the client wording available to retry', async () => {
  const c = init(); c.active = true; c.sessionId = sessionId; Object.assign(c, access);
  c.root = new TestNode(); c.renderShell();
  globalThis.fetch = async () => { throw new Error('offline'); };
  await c.send('Actually that savings account is my partner’s.');
  assert.equal(c.composerNode.value, 'Actually that savings account is my partner’s.');
  await c.end();
});

test('A lost approval reply still discovers completed results', async () => {
  let navigated = 0; const c = init({ onNavigate: () => { navigated += 1; } });
  c.active = true; c.sessionId = sessionId; Object.assign(c, access); c.awaitingExecution = true;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'DELETE') return response({});
    if (options.method === 'POST') throw new Error('Lost approval response');
    if (String(url).includes('/text/meetings/')) return response({ realtimeExecution: execution });
    return response(completed);
  };
  try { await c.send('Yes, go ahead.'); assert.equal(navigated, 1); }
  finally { await c.end(); }
});

test('A lost COLLECTING reply is recovered from the durable transcript', async () => {
  // THE DEFECT THIS PINS. Recovery ran only when awaitingExecution was set --
  // that is, only after a read-back. A collecting turn is the common case and
  // was silently unrecoverable: the client turn is persisted before the planner
  // runs, so the reply the server went on to produce sat in durable storage,
  // invisible, while the client saw an error, their own message and a stale
  // card. Retyping the answer then created a second turn of the same answer.
  // Planning turns are slow on purpose, so a lost reply must not cost the reply.
  let polls = 0;
  const c = init(); c.active = true; c.sessionId = sessionId; Object.assign(c, access);
  c.root = new TestNode(); c.renderShell();
  assert.equal(c.awaitingExecution, false, 'this is a collecting turn, not an approval');
  globalThis.fetch = async (url, options) => {
    if (options.method === 'DELETE') return response({});
    if (options.method === 'POST') throw new Error('Lost collecting response');
    if (String(url).includes('/text/meetings/')) {
      polls += 1;
      // First look: the POST has not been persisted yet, so the transcript still
      // ends with the PREVIOUS assistant question -- the shape that used to end
      // recovery having recovered nothing. Second look: the client's message
      // and its reply have both landed.
      return polls === 1
        ? response({ turns: [{ role: 'assistant', text: 'How much do you spend each month?' }] })
        : response({
          turns: [
            { role: 'assistant', text: 'How much do you spend each month?' },
            { role: 'user', text: 'We spend about 4000 a month.' },
            { role: 'assistant', text: 'Thanks — and do you have any other debts?' }
          ],
          card: { modules: [], readyToConfirm: false }
        });
    }
    return response({});
  };
  try {
    await c.send('We spend about 4000 a month.');
    assert.ok(polls >= 1, 'a failed collecting send must look for what actually landed');
    await c.checkCompletion();
    assert.equal(c.transcript.at(-1)?.role, 'assistant',
      'the reply the server produced is shown rather than lost');
    assert.equal(c.transcript.at(-1)?.text, 'Thanks — and do you have any other debts?');
    assert.equal(c.recovery, null, 'recovery stops once the reply to THIS message is in hand');
  } finally { await c.end(); }
});

test('Ending an in-flight turn cannot navigate into the old session later', async () => {
  const gate = deferred(); let navigated = 0;
  const c = init({ onNavigate: () => { navigated += 1; } });
  c.active = true; c.sessionId = sessionId; Object.assign(c, access); c.awaitingExecution = true;
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'DELETE') return response({});
    if (options.method === 'POST') { await gate.promise; return response({ assistantText: 'Done.' }); }
    return response(completed);
  };
  const sending = c.send('Yes, go ahead.'); await c.end(); gate.resolve(); await sending;
  assert.equal(navigated, 0);
});

test('Not sure sends the current action binding while drafts retain their field identity', async () => {
  const c = init();
  let sent;
  c.send = async (text, options) => { sent = { text, options }; };
  const row = c.renderField({ id: 'stable-draft-field', unknownFieldId: 'current-card-action', kind: 'rate', label: 'Mortgage rate' });
  row.querySelector('.typed-field-unsure').listeners.get('click')();
  assert.equal(sent.options.unknownFieldId, 'current-card-action');
  assert.ok(c.cardEntries.has('stable-draft-field'));
});

test('The choice placeholder is not a client answer', async () => {
  const c = init();
  const field = c.renderField({ id: 'choice', kind: 'choice', label: 'Ownership', options: [{ label: 'Joint', value: 'joint' }] });
  assert.equal(field.querySelector('select').children[0].value, '');
});

test('A plan still running at the first check reaches results without another client turn', async () => {
  let polls = 0; let navigated = 0;
  const c = init({ onNavigate: () => { navigated += 1; } });
  c.active = true; c.sessionId = sessionId; Object.assign(c, access); c.awaitingExecution = true;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'DELETE') return response({});
    if (options.method === 'POST') return response({ assistantText: 'I am working on your results.' });
    if (String(url).includes('/text/meetings/')) {
      polls += 1;
      return response({ status: 'active', realtimeExecution: { ...execution, status: polls > 1 ? 'complete' : 'executing' } });
    }
    return response(polls > 1 ? completed : { session: completed.session, analysis: null });
  };
  try {
    await c.send('Yes, go ahead.'); await sleep(2400);
    assert.equal(navigated, 1);
    assert.equal(polls, 2, 'only the pending execution should be polled');
  } finally { await c.end(); }
});

test('Refreshing Type resumes its original lease, transcript and input card without creating another meeting', async () => {
  const c = init(); let creates = 0;
  const card = { modules: [{ title: 'Your planning details', expanded: true, fields: [{ id: 'amount', kind: 'money', label: 'Amount' }], known: [] }] };
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'DELETE') return response({});
    if (options.method === 'POST') { creates += 1; return response({ ...access, assistantText: 'Welcome.' }); }
    return response({ leaseId, status: 'active', turns: [{ role: 'assistant', text: 'What amount would you like to use?' }], card });
  };
  await c.start(new TestNode());
  const refreshed = new TypedMeetingController();
  try {
    await refreshed.start(new TestNode());
    assert.equal(creates, 1, 'refresh must not reserve a second meeting budget');
    assert.equal(refreshed.leaseId, leaseId);
    assert.match(refreshed.threadNode.textContent, /What amount/);
    assert.equal(refreshed.cardEntries.size, 1);
  } finally { await refreshed.end(); await c.end(); }
});

test('Starting a new session after closing ignores old replies and resets the controller', async () => {
  const c = init(); const oldReply = deferred(); const secondSession = 'cs_second_frontend_1234567890';
  globalThis.fetch = async (url, options) => {
    if (options.method === 'DELETE') return response({});
    if (String(url).endsWith('/messages')) { await oldReply.promise; return response({ assistantText: 'Old private answer.' }); }
    return response({ ...access, assistantText: String(url).includes(secondSession) ? 'New session.' : 'Old session.' });
  };
  await c.start(new TestNode());
  const sending = c.send('Old private question.'); await c.end();
  storeSessionAccess({ id: secondSession }, 'credential_second_frontend'); state.session = { id: secondSession };
  await c.start(new TestNode()); oldReply.resolve(); await sending;
  try {
    assert.deepEqual(c.transcript.map((turn) => turn.text), ['New session.']);
    assert.equal(c.sending, false);
    assert.equal(c.navigated, false);
  } finally { await c.end(); }
});

test('A completed older analysis cannot satisfy the current typed execution', async () => {
  let navigated = 0;
  const c = init({ onNavigate: () => { navigated += 1; } });
  c.active = true; c.sessionId = sessionId; Object.assign(c, access); c.awaitingExecution = true;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'DELETE') return response({});
    if (String(url).includes('/text/meetings/')) return response({ status: 'active', realtimeExecution: { ...execution, planId: 'plan_new', analysisRunId: 'analysis_new' } });
    return response(completed);
  };
  try { await c.checkCompletion(); assert.equal(navigated, 0); }
  finally { await c.end(); }
});

test('An in-flight session read cannot replace a newly started session', async () => {
  const c = init(); const read = deferred(); let sessionRead = false;
  c.active = true; c.sessionId = sessionId; Object.assign(c, access); c.awaitingExecution = true;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'DELETE') return response({});
    if (String(url).includes('/text/meetings/')) return response({ realtimeExecution: execution });
    sessionRead = true; await read.promise; return response(completed);
  };
  const checking = c.checkCompletion();
  for (let attempts = 0; !sessionRead && attempts < 10; attempts += 1) await sleep(0);
  await c.end(); state.session = { id: 'cs_new_frontend_1234567890123', currentProfileRevision: 1 };
  read.resolve(); await checking;
  assert.equal(state.session.id, 'cs_new_frontend_1234567890123');
});

test('Saved completed sessions render results immediately on reload', async () => {
  init();
  globalThis.fetch = async (url) => String(url).endsWith('/bootstrap')
    ? response({ consumerJourneyEnabled: true, consumerTypedLaneEnabled: true })
    : response(completed);
  await import('../js/plan/app.js');
  await sleep(30);
  assert.equal(state.view, 'results');
  assert.match(nodes.get('appRoot').textContent, /results/i);
});

async function bootTypedApp(name, requestHandler) {
  init();
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/bootstrap')) return response({ consumerJourneyEnabled: true, consumerTypedLaneEnabled: true });
    return requestHandler(String(url), options);
  };
  await import(`../js/plan/app.js?first20=${name}`);
  for (let i = 0; !getStoredTypedMeeting()?.leaseId && i < 20; i += 1) await sleep(0);
  assert.equal(getStoredTypedMeeting()?.leaseId, leaseId, 'the real app must enter Type');
}

test('The application closes Type before deleting session access', async () => {
  const calls = [];
  await bootTypedApp('delete', (url, options) => {
    if (options.method === 'POST') return response({ ...access, assistantText: 'Welcome.' });
    if (options.method === 'DELETE') {
      calls.push({ url, credential: options.headers.get('X-Consumer-Session') });
      return response({});
    }
    return response({ session: { id: sessionId, currentProfileRevision: 3 } });
  });
  await nodes.get('confirmDeleteButton').listeners.get('click')();
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith(`/text/meetings/${leaseId}`));
  assert.ok(calls[1].url.endsWith(`/sessions/${sessionId}`));
  assert.ok(calls.every((call) => call.credential === 'credential_frontend_recovery'));
  assert.equal(getStoredTypedMeeting(), null);
  assert.equal(state.session, null);
});

test('Withdrawing AI consent closes Type and removes its stored control', async () => {
  const calls = [];
  await bootTypedApp('consent', (url, options) => {
    if (options.method === 'POST') return response({ ...access, assistantText: 'Welcome.' });
    if (options.method === 'PATCH' || options.method === 'DELETE') calls.push(`${options.method} ${url}`);
    return response({ session: { id: sessionId, currentProfileRevision: 3, aiProcessingConsented: options.method !== 'PATCH' } });
  });
  await nodes.get('withdrawAiConsentButton').listeners.get('click')();
  assert.equal(calls.length, 2);
  assert.ok(calls[0].endsWith(`/sessions/${sessionId}/consent`));
  assert.ok(calls[1].endsWith(`/text/meetings/${leaseId}`));
  assert.equal(getStoredTypedMeeting(), null);
  assert.equal(state.session.aiProcessingConsented, false);
  assert.match(nodes.get('appRoot').textContent, /AI assistance is off.*planning conversation has stopped/);
  assert.doesNotMatch(nodes.get('appRoot').textContent, /rules-only|live meeting is open/);
});

test('Reload after AI-consent withdrawal does not create another meeting', async () => {
  init(); let creates = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/bootstrap')) return response({ consumerJourneyEnabled: true, consumerTypedLaneEnabled: true });
    if (options.method === 'POST') creates += 1;
    return response({ session: { id: sessionId, currentProfileRevision: 3, aiProcessingConsented: false } });
  };
  await import('../js/plan/app.js?first20=consent-reload');
  await sleep(30);
  assert.equal(creates, 0);
  assert.match(nodes.get('appRoot').textContent, /AI assistance is off/);
});

test('Completed results remain available after AI-consent withdrawal', async () => {
  init(); let creates = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/bootstrap')) return response({ consumerJourneyEnabled: true, consumerTypedLaneEnabled: true });
    if (options.method === 'POST') creates += 1;
    return response({ ...completed, session: { ...completed.session, aiProcessingConsented: false } });
  };
  await import('../js/plan/app.js?first20=consent-results');
  await sleep(30);
  assert.equal(creates, 0);
  assert.equal(state.view, 'results');
  assert.match(nodes.get('appRoot').textContent, /Your educational analysis/);
});

test('Type failures preserve the saved conversation without voice-only copy', async () => {
  const { renderUnavailable } = await import('../js/plan/views.js');
  const root = new TestNode();
  renderUnavailable(root, { typedMeetingFailure: true, transcript: 'You: My savings belong to me.' });
  assert.match(root.textContent, /Planning session unavailable/);
  assert.doesNotMatch(root.textContent, /Live call|older call system/);
  assert.equal(root.querySelector('textarea').value, 'You: My savings belong to me.');
});

let failures = 0;
for (const [name, run] of tests) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`); }
}
console.log(`First 20 frontend: ${tests.length - failures}/${tests.length} passed.`);
if (failures) process.exitCode = 1;
