import { createOBSConnection } from './presenter_obs.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1)), parentOrigin = params.get('origin'), session = params.get('session');
const allowedParents = ['https://planeir.ie', 'https://www.planeir.ie', 'http://127.0.0.1:8788', 'http://localhost:8788'];
const linked = Boolean(window.opener && allowedParents.includes(parentOrigin) && /^[a-f\d-]{36}$/.test(session || ''));
let appState = null, lastAppMessage = 0, seq = 0, busy = false, polling = false, obsState = null, lastOBSMessage = 0;
let lastPaused = false, pauseObserved = false, mayBeRecording = false;
const pending = new Map();
const appAlive = () => linked && !window.opener.closed && Date.now() - lastAppMessage < 5000;
const obsKnown = () => obs.connected && obsState && Date.now() - lastOBSMessage < 4000;
const send = message => { if (linked) window.opener.postMessage({ channel: 'planeir-presenter', session, ...message }, parentOrigin); };
function command(name) {
  if (!appAlive()) return Promise.reject(new Error('The Planéir window is disconnected. Keep it open; reopen controls there if needed.'));
  return new Promise((resolve, reject) => {
    const id = String(++seq), timer = setTimeout(() => { pending.delete(id); reject(new Error('Planéir did not confirm the operation. Check its window before continuing.')); }, name === 'validate' ? 240000 : 30000);
    pending.set(id, { resolve, reject, timer }); send({ type: 'command', command: name, id });
  });
}
function showError(error) { $('error').textContent = error?.message || String(error); }
function render() {
  const alive = appAlive(), known = obsKnown(), active = known && obsState.outputActive;
  $('connection').textContent = alive ? 'Planéir connected · controls stay outside the video' : 'Open these controls from Planéir → Presenter Mode → Open recording controls. Keep both windows open.';
  $('record-state').textContent = !known ? 'OBS status unknown' : active ? obsState.outputPaused ? 'PAUSED IN OBS' : 'RECORDING · confirmed by OBS' : 'STOPPED · confirmed by OBS';
  $('record-state').dataset.state = !known ? 'unknown' : active ? obsState.outputPaused ? 'paused' : 'recording' : 'stopped';
  $('timer').textContent = known ? (obsState.outputTimecode || '00:00:00.000').split('.')[0] : '— — : — —';
  $('record-detail').textContent = !known ? 'Connect or reconnect to OBS. A lost connection does not stop recording.' : active ? 'OBS records the screen and configured audio. The iPhone is separate.' : 'Screen recording is stopped. Start/stop the iPhone yourself.';
  $('record').disabled = busy || !alive || !known || active || !appState?.active || appState.busy || appState.remoteCapture || appState.validationStatus !== 'passed' || !$('ready').checked || (appState.take && !appState.take.exported);
  $('stop').disabled = busy || !known || (!active && !appState?.remoteCapture);
  $('ready').disabled = busy || Boolean(active) || Boolean(appState?.remoteCapture);
  $('connect').disabled = busy;
  const take = appState?.take;
  $('download').disabled = busy || !alive || !take || ['recording', 'countdown'].includes(take.status) || Boolean(appState?.remoteCapture);
  $('take-state').textContent = appState?.countingDown ? 'Countdown · wait for SYNC, then clap and begin.' : take ? `Cue log: ${take.status}${take.exported ? ' · package downloaded' : ''}` : 'No take yet';
  $('exit').disabled = busy || !alive || mayBeRecording || appState?.remoteCapture;
  for (const button of document.querySelectorAll('[data-command]')) {
    const recording = Boolean(active || appState?.remoteCapture);
    button.disabled = busy || !alive || !appState?.active || appState.busy || appState.countingDown || (recording && ['validate', 'restart'].includes(button.dataset.command));
  }
  if (!appState) return;
  $('beat').textContent = `VISUAL ${Math.max(0, appState.index + 1)} OF ${appState.count}${appState.busy ? ' · MOVING…' : ''}`;
  $('current').textContent = appState.current; $('next').textContent = `Next: ${appState.next}`;
  $('exploring').hidden = !appState.exploring;
  $('validation').textContent = `Live validation: ${appState.validationStatus}${appState.error ? ` · ${appState.error}` : ''}`;
  if ($('script').textContent !== appState.words) $('script').textContent = appState.words || '(The next cue starts the spoken section.)';
}
const obs = createOBSConnection({
  onDisconnect(error) { obsState = null; showError(error); render(); },
  onRecordState() { if (!busy) void pollOBS(); }
});
async function checkOBS() { const state = await obs.status(); obsState = state; mayBeRecording = state.outputActive; lastOBSMessage = Date.now(); render(); return state; }
async function pollOBS() {
  if (polling || busy || !obs.connected) return; polling = true;
  try {
    const state = await checkOBS();
    if (busy) return; // A user stop/start now owns the transition.
    if (state.outputPaused && !lastPaused) {
      pauseObserved = true;
      if (appState?.remoteCapture && appAlive()) { try { await command('paused'); } catch { /* Stop still marks the take interrupted if the app is currently busy. */ } }
      showError('OBS was paused. Browser cue times include the pause; review sync before using those timings.');
    }
    lastPaused = state.outputPaused;
    if (!state.outputActive && appState?.remoteCapture && appAlive()) {
      await command('interrupted'); $('ready').checked = false;
      showError('OBS stopped outside these controls. The cue log was closed as interrupted. Download it before another take; stop the iPhone separately.');
    }
  } catch (error) { obsState = null; showError(error); }
  finally { polling = false; render(); }
}
async function run(fn) {
  if (busy) return; busy = true; $('error').textContent = ''; render();
  try { await fn(); } catch (error) { showError(error); } finally { busy = false; render(); }
}
async function startRecording() {
  if (!$('ready').checked) throw new Error('Start the iPhone and check your OBS capture and external mic first.');
  if ((await checkOBS()).outputActive) throw new Error('OBS is already recording. Stop that recording before starting a new take.');
  await command('prepare'); // Hide the captured UI and restart BEFORE OBS starts.
  let startRequested = false;
  try {
    // Check again after preparing; never take ownership of a recording started elsewhere.
    if ((await checkOBS()).outputActive) throw new Error('OBS started outside these controls. Stop it explicitly before continuing.');
    startRequested = true;
    mayBeRecording = true;
    await obs.request('StartRecord');
    const state = await checkOBS();
    if (!state.outputActive || state.outputPaused) throw new Error('OBS did not confirm an active recording.');
    pauseObserved = false; lastPaused = false;
    await command('begin');
  } catch (error) {
    // Never guess after a timeout or lost connection, and never stop an unrelated
    // recording automatically. Keep the output clean; Stop remains the recovery action.
    try { if (!(await checkOBS()).outputActive) await command('stopped'); } catch { obsState = null; }
    throw new Error(`${error.message}${startRequested ? ' Check OBS status here and use Stop if recording began.' : ''}`);
  }
}
async function stopRecording() {
  let state = await checkOBS();
  if (state.outputActive) {
    await obs.request('StopRecord');
    // A reply is not enough: keep the output clean until OBS reports inactive.
    for (let n = 0; n < 15; n++) {
      state = await checkOBS(); if (!state.outputActive) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (state.outputActive) throw new Error('OBS is still stopping. Keep both windows open and retry Stop.');
  }
  if (appState?.remoteCapture) await command(pauseObserved ? 'interrupted' : 'stopped');
  $('ready').checked = false;
  $('error').textContent = 'Screen recording stopped. Stop the iPhone, then download the edit package.';
}
window.addEventListener('message', event => {
  const data = event.data;
  if (!linked || event.source !== window.opener || event.origin !== parentOrigin || data?.channel !== 'planeir-presenter' || data.session !== session) return;
  lastAppMessage = Date.now();
  if (data.state) appState = data.state;
  if (data.type === 'reply') {
    const request = pending.get(data.id);
    if (request) { clearTimeout(request.timer); pending.delete(data.id); data.error ? request.reject(new Error(data.error)) : request.resolve(data.state); }
  } else if (data.type === 'error') showError(data.error);
  else if (data.type === 'stop-request') void run(stopRecording);
  render();
});
$('connect-form').addEventListener('submit', event => {
  event.preventDefault();
  const password = $('password').value, port = Number($('port').value); $('password').value = '';
  void run(async () => {
    obsState = null; render();
    const state = await obs.connect(password, port); obsState = state; mayBeRecording = state.outputActive; lastOBSMessage = Date.now();
    $('obs-setup').open = false;
    if (!state.outputActive && appState?.remoteCapture) { await command('interrupted'); $('ready').checked = false; }
  });
});
$('record').onclick = () => void run(startRecording);
$('stop').onclick = () => void run(stopRecording);
$('download').onclick = () => void run(() => command('download'));
$('exit').onclick = () => void run(async () => {
  if (mayBeRecording || appState?.remoteCapture || (obs.connected && (await checkOBS()).outputActive)) throw new Error('Stop OBS first.');
  await command('exit'); window.close();
});
$('ready').onchange = render;
for (const button of document.querySelectorAll('[data-command]')) button.onclick = () => void run(() => command(button.dataset.command));
window.addEventListener('keydown', event => {
  if (event.repeat || event.target.matches('input,textarea,select,summary') || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (['arrowright', 'arrowleft', 's', 'm'].includes(key)) event.preventDefault();
  if (key === 's') { void run(stopRecording); return; }
  if (appState?.countingDown || appState?.busy) return;
  const action = { arrowright: 'next', arrowleft: 'previous', m: 'retake' }[key];
  if (action) void run(() => command(action));
});
window.addEventListener('beforeunload', event => {
  if (appState?.remoteCapture || obsState?.outputActive) { event.preventDefault(); event.returnValue = ''; }
});
send({ type: 'hello' });
setInterval(() => {
  send({ type: appAlive() ? 'heartbeat' : 'hello' }); render(); void pollOBS();
}, 750);
render();
