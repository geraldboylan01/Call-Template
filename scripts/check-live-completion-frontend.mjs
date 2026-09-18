import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function checkLiveCompletionFrontend() {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const storage = new Map([['planeir.consumer.credential.v1', 'cs_completion_test.private-test-credential']]);
  globalThis.window = {
    setTimeout, clearTimeout,
    location: { hostname: 'localhost', href: 'http://localhost/plan/' },
    sessionStorage: { getItem: (key) => storage.get(key) || '', setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  };
  // A node just real enough for the review panel: children, text and clicks.
  // The controller builds the panel with document.createElement, so a stub that
  // could not create one would be testing nothing.
  const makeNode = (tag) => ({
    tagName: String(tag).toUpperCase(),
    children: [],
    listeners: new Map(),
    className: '',
    type: '',
    disabled: false,
    set textContent(value) { this._text = String(value); this.children = []; },
    get textContent() { return (this._text || '') + this.children.map((child) => child.textContent).join(' '); },
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); },
    setAttribute() {},
    focus() {},
    addEventListener(name, handler) { this.listeners.set(name, handler); },
    querySelectorAll(selector) {
      const all = [];
      const walk = (node) => {
        if (selector === 'button' && node.tagName === 'BUTTON') all.push(node);
        node.children.forEach(walk);
      };
      walk(this);
      return all;
    }
  });
  globalThis.document = {
    querySelector: () => null,
    getElementById: () => null,
    addEventListener: () => {},
    createElement: makeNode,
    body: {}
  };
  const controllers = [];
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  try {
    const { LiveVoiceController } = await import('../js/plan/live_voice.js');
    const { describePlanningCompletion } = await import('../js/plan/completion.js');
    const execution = { planId: 'plan_approved', profileRevision: 3, status: 'complete', analysisRunId: 'run_approved' };
    const completed = {
      session: { id: 'cs_completion_test', status: 'active', stage: 'results', currentProfileRevision: 3 },
      analysisPlan: { ...execution, leaseId: 'lease_completion', moduleIds: ['mortgage_analysis'] },
      analysis: { id: 'run_approved', profileRevision: 3, status: 'complete', results: { modules: [{ moduleId: 'mortgage_analysis', outputs: { total: 123 } }] } }
    };
    assert.equal(describePlanningCompletion(completed, execution).ready, true, 'Production active/results state must complete.');
    assert.equal(describePlanningCompletion({ ...completed, analysis: { ...completed.analysis, status: 'partial' } }, execution).ready, true);
    for (const bad of [
      { ...completed, analysis: { ...completed.analysis, id: 'unrelated_run' } },
      { ...completed, analysis: { ...completed.analysis, profileRevision: 2 } },
      { ...completed, analysis: { ...completed.analysis, status: 'running' } },
      { ...completed, analysis: { ...completed.analysis, results: [] } },
      { ...completed, analysisPlan: { ...completed.analysisPlan, planId: 'unrelated_plan' } },
      { ...completed, analysis: null }
    ]) assert.equal(describePlanningCompletion(bad, execution).ready, false, 'Stale, unrelated, running and empty results are not completion.');
    const adviser = {
      ...completed,
      analysis: null,
      analysisPlan: { ...completed.analysisPlan, analysisRunId: null, moduleIds: [], moduleSlots: [{ moduleId: 'personal_balance_sheet', availability: 'adviser_review_required' }] }
    };
    assert.equal(describePlanningCompletion(adviser, { ...execution, analysisRunId: null }).kind, 'adviser_review');
    assert.equal(describePlanningCompletion({ ...adviser, analysisPlan: { ...adviser.analysisPlan, status: 'running' } }).ready, false);

    function controller(options = {}) {
      const c = new LiveVoiceController(options);
      c.active = true;
      c.sessionId = 'cs_completion_test';
      c.leaseId = 'lease_completion';
      c.controlCapability = 'rt_control_completion_test_capability';
      c.remotePlaybackReady = true;
      controllers.push(c);
      return c;
    }
    const events = (c, ...items) => items.forEach((event) => c.handleProviderEvent(JSON.stringify(event)));

    // THE PLAYBACK-ACKNOWLEDGEMENT LEDGER IS GONE, AND SO IS ITS REASON.
    //
    // It existed to prove the client had HEARD a plan read out before a spoken
    // "yes" could run it. Speech no longer authorises anything, so audio
    // delivery is only what it looks like: whether Planeir is currently
    // talking. What replaces it is the Review screen, tested below.
    const audio = controller();
    assert.equal(typeof audio.deliveries, 'undefined', 'no delivery ledger survives in the browser');
    events(audio,
      { type: 'response.created', response: { id: 'r1' } },
      { type: 'output_audio_buffer.started', response_id: 'r1' },
      { type: 'output_audio_buffer.stopped', response_id: 'r1', event_id: 'drain' },
      { type: 'response.done', response: { id: 'r1', status: 'completed' } }
    );
    assert.equal(audio.assistantPlaybackActive, false, 'playback still tracks whether Planeir is speaking');

    /* ------------------------------------------------------- the review screen */

    // THE SUMMARY AND BOTH BUTTONS COME FROM ONE OBJECT, IN ONE PASS.
    //
    // That is the whole anti-substitution property in the browser: a click can
    // only ever carry the id of the review whose summary is on screen, because
    // the handlers were bound while that object was being rendered.
    const review = {
      reviewId: 'rv_frontend_test_review_identity',
      actions: ['run', 'change'],
      presentation: {
        schemaVersion: 'ReviewPresentationV1',
        summary: 'I will run the mortgage analysis using the figures we discussed.',
        modules: [{ id: 'm0', title: 'Mortgage review', origin: 'client_requested', reason: 'you asked', inputs: [{ id: 'k0', label: 'Amount left', value: '€240,000' }], assumptions: [] }]
      }
    };
    const screen = controller();
    const host = {
      children: [],
      append(...nodes) { this.children.push(...nodes); },
      querySelector: () => null,
      setAttribute() {},
      removeAttribute() {}
    };
    screen.shellElement = host;
    let muted = 0;
    screen.localStream = { getAudioTracks: () => [{ set enabled(value) { if (!value) muted += 1; } }] };
    screen.applyReviewState('review', review);
    assert.equal(screen.reviewId, review.reviewId, 'the controller holds the review the server published');
    assert.ok(muted > 0, 'the microphone is released while the review stands');
    const panel = host.children.at(-1);
    const rendered = panel.textContent;
    assert.ok(rendered.includes('Run analysis'), 'the Run action is drawn');
    assert.ok(rendered.includes('Make a change'), 'the change action is drawn');
    assert.ok(rendered.includes(review.presentation.summary), 'beside the certified summary it authorises');
    // NOTHING TELLS THE CLIENT PLANEIR HAS STOPPED LISTENING. The screen is the
    // message; narrating it would be telling someone what they can already see.
    assert.equal(/stopped listening|no longer listening|not listening/i.test(rendered), false,
      'the review says nothing about the microphone');

    // The click names that exact review, and carries no financial value.
    const sent = [];
    globalThis.fetch = async (url, options = {}) => {
      sent.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
      return response({ ok: true, mode: 'conversation', inputEpoch: 1 });
    };
    await screen.decideReview('change', screen.reviewId);
    assert.ok(sent[0].url.includes(`/reviews/${review.reviewId}/change`),
      'the action names the exact review in its path');
    assert.deepEqual(Object.keys(sent[0].body || {}), ['clickId'],
      'and carries only a retry identity — no inputs and no claim of approval');
    assert.equal(screen.reviewId, '', 'the review clears only after the server answered');
    screen.active = false;
    audio.teardown();
    audio.active = false;

    globalThis.fetch = async () => response({ ok: true });
    const acknowledgements = [];

    // Delayed persistence needs repeated observations; only one authenticated
    // request chain may be in flight, regardless of provider speech events.
    let callReads = 0;
    let sessionReads = 0;
    let deletes = 0;
    const readGate = deferred();
    const closeGate = deferred();
    let mediaStopped = 0;
    let transportClosed = 0;
    let navigated = 0;
    let transcriptReads = 0;
    const c = controller({ onNavigate: () => {
      assert.equal(c.leaseId, '', 'Results must follow confirmed provider hang-up and terminal lease.');
      navigated += 1;
    } });
    c.localStream = { getTracks: () => [{ stop: () => { mediaStopped += 1; } }] };
    c.peerConnection = { close: () => { transportClosed += 1; } };
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'DELETE') {
        deletes += 1;
        await closeGate.promise;
        return response({ providerHangupConfirmed: true, realtimeLease: { leaseId: c.leaseId, status: 'complete' } });
      }
      if (String(url).includes('/calls/')) {
        callReads += 1;
        if (callReads === 1) await readGate.promise;
        const observed = { ...execution, status: callReads < 3 ? 'running' : 'complete' };
        return response({ realtimeExecution: observed, analysisPlan: { ...completed.analysisPlan, ...observed }, realtimeLease: { status: 'active' } });
      }
      if (String(url).includes('/transcript')) { transcriptReads += 1; return new Promise(() => {}); }
      sessionReads += 1;
      return response(sessionReads < 3 ? { ...completed, analysis: null } : completed);
    };
    // A HUMAN PRESSING RUN IS THE ONLY THING THAT STARTS AN EXECUTION WATCH.
    // A provider tool call used to. There is no such tool, so there is no such
    // event, and the watch has exactly one cause.
    c.watchExecution();
    assert.equal(c.executionWatching, true);
    clearTimeout(c.refreshTimer); c.refreshTimer = null;
    const first = c.refreshState();
    assert.equal(c.refreshState(), first, 'Concurrent refreshes must share the same request chain.');
    readGate.resolve(); await first;
    await c.refreshState();
    assert.equal(navigated, 0, 'One-shot and premature results checks must not navigate.');
    const final = c.refreshState();
    for (let i = 0; i < 20 && !deletes; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(mediaStopped, 1, 'Local capture must stop before waiting for provider close.');
    assert.equal(transportClosed, 1);
    assert.equal(navigated, 0);
    assert.equal(c.controlCapability, 'rt_control_completion_test_capability');
    const duplicateStop = c.stop('completed');
    assert.equal(duplicateStop, c.shutdownPromise, 'All shutdown requests join one promise.');
    assert.equal(deletes, 1);
    closeGate.resolve(); await final;
    assert.equal(navigated, 1);
    assert.equal(transcriptReads, 0, 'Transcript loading must not gate completion.');
    assert.equal(c.active, false);
    for (const key of ['approvedExecutionObservedAt', 'resultsObservedAt', 'localMediaStoppedAt', 'providerHangupConfirmedAt', 'terminalLeaseAt', 'resultsRenderedAt']) assert.ok(c.completionTimings[key], key);

    const retry = controller();
    let closeAttempts = 0;
    globalThis.fetch = async (_url, options = {}) => {
      if (options.method !== 'DELETE') return response({});
      closeAttempts += 1;
      return response({ providerHangupConfirmed: closeAttempts > 1, realtimeLease: { leaseId: 'lease_completion', status: closeAttempts > 1 ? 'complete' : 'closing' } });
    };
    await assert.rejects(retry.stop('completed'), /not yet confirmed/);
    assert.equal(retry.active, false);
    assert.equal(retry.leaseId, 'lease_completion', 'A failed close must retain the lease and private retry capability.');
    assert.equal(retry.phase, 'closing');
    await retry.stop('completed');
    assert.equal(retry.leaseId, '');
    assert.equal(closeAttempts, 2);
    console.log('Live completion frontend: matching results, delayed observation, delivery ordering and confirmed shutdown passed.');
  } finally {
    for (const controller of controllers) { controller.active = false; controller.teardown(); }
    Object.assign(globalThis, previous);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkLiveCompletionFrontend();
