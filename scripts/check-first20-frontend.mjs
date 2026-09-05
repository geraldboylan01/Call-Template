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
const { state, resetJourneyState, storeSessionAccess } = await import('../js/plan/store.js');
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

test('The choice placeholder is not a client answer', async () => {
  const c = init();
  const field = c.renderField({ id: 'choice', kind: 'choice', label: 'Ownership', options: [{ label: 'Joint', value: 'joint' }] });
  assert.equal(field.querySelector('select').children[0].value, '');
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

let failures = 0;
for (const [name, run] of tests) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`); }
}
console.log(`First 20 frontend: ${tests.length - failures}/${tests.length} passed.`);
if (failures) process.exitCode = 1;
