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
  globalThis.document = { querySelector: () => null, getElementById: () => null, addEventListener: () => {}, body: {} };
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
    const acknowledgements = [];
    globalThis.fetch = async (_url, options) => { acknowledgements.push(JSON.parse(options.body)); return response({ ok: true }); };
    const audio = controller();
    events(audio,
      { type: 'response.created', response: { id: 'readback_complete' } },
      { type: 'output_audio_buffer.started', response_id: 'readback_complete' },
      { type: 'output_audio_buffer.stopped', response_id: 'readback_complete', event_id: 'normal_drain' }
    );
    assert.equal(acknowledgements.length, 0, 'Drain before response.done is not sufficient delivery.');
    events(audio, { type: 'response.done', response: { id: 'readback_complete', status: 'completed' } });
    await audio.deliveries.for('readback_complete').pending;
    assert.deepEqual(acknowledgements[0], { responseId: 'readback_complete', eventId: 'normal_drain', playback: 'completed' });
    for (const interruption of ['output_audio_buffer.cleared', 'input_audio_buffer.speech_started', 'cancelled']) {
      const id = `readback_${interruption}`;
      events(audio, { type: 'response.created', response: { id } }, { type: 'output_audio_buffer.started', response_id: id });
      events(audio, interruption === 'cancelled'
        ? { type: 'response.done', event_id: id, response: { id, status: 'cancelled' } }
        : { type: interruption, response_id: id, event_id: id });
      events(audio,
        { type: 'output_audio_buffer.stopped', response_id: id, event_id: 'late_stop' },
        { type: 'response.done', response: { id, status: 'completed' } }
      );
      await audio.deliveries.for(id).pending;
      assert.equal(acknowledgements.filter((ack) => ack.responseId === id).every((ack) => ack.playback === 'interrupted'), true, 'Late completion cannot reactivate interrupted delivery.');
    }
    audio.teardown();
    audio.active = false;

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
    events(c, { type: 'response.function_call_arguments.done', name: 'confirm_and_run' });
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
