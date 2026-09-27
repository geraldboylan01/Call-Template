const controlsOrigin = 'http://127.0.0.1:8790';

// The captured page exposes a small command protocol to one explicitly opened
// window. Validate origin + window identity + per-session nonce on every message.
export function mountPresenterConsole({ api, panel, take, exit }) {
  let desk, connected = false, closed = false, executing = false, lastMessage = 0;
  const session = crypto.randomUUID();
  const send = message => { if (desk && !desk.closed) desk.postMessage({ channel: 'planeir-presenter', session, ...message }, controlsOrigin); };
  const status = () => {
    const state = api.state(), log = take.snapshot();
    let words = '';
    if (state.loaded) {
      const bundle = api.recordingBundle(), cues = bundle.compiled.cues;
      words = bundle.script.slice(state.index < 0 ? 0 : cues[state.index]?.offset || 0, cues[state.index + 1]?.offset ?? bundle.script.length).trim();
    }
    return { ...state, words, remoteCapture: take.controlled, countingDown: take.countingDown, take: log ? { id: log.id, status: log.status, exported: log.exported } : null };
  };
  const commands = {
    status,
    next: () => api.next(), previous: () => api.previous(), resume: () => api.resume(), restart: () => api.restart(),
    validate: () => api.validateLive(),
    retake: () => take.observe({ type: 'retake', label: api.state().current }),
    paused: () => take.observe({ type: 'capture-warning', label: 'OBS paused: browser cue offsets include the pause; verify video timing before editing.' }),
    prepare: () => take.prepareControlled(),
    begin() { void take.beginControlled().catch(error => send({ type: 'error', error: error.message })); },
    stopped: () => take.finishControlled(),
    interrupted: () => take.finishControlled('obs-stopped-outside-controls'),
    download: () => take.download(),
    async exit() {
      if (take.controlled) throw new Error('Stop OBS before returning to setup.');
      closed = true; connected = false; document.body.classList.remove('presenter-console-open');
      await exit();
    }
  };
  window.addEventListener('message', async event => {
    const data = event.data;
    if (closed || event.source !== desk || event.origin !== controlsOrigin || data?.channel !== 'planeir-presenter' || data.session !== session) return;
    lastMessage = Date.now();
    if (data.type === 'hello') {
      connected = true; panel.close(); document.body.classList.add('presenter-console-open'); send({ type: 'state', state: status() }); return;
    }
    if (data.type === 'heartbeat') return;
    if (data.type !== 'command' || !Object.hasOwn(commands, data.command) || typeof data.id !== 'string') return;
    try {
      if (executing && !['status', 'stopped', 'interrupted'].includes(data.command)) throw new Error('Wait for the current operation to finish.');
      if (take.countingDown && !['status', 'stopped', 'interrupted', 'paused'].includes(data.command)) throw new Error('Wait for the countdown to finish.');
      if (data.command !== 'status') executing = data.command;
      await commands[data.command](); send({ type: 'reply', id: data.id, state: status() });
    } catch (error) { send({ type: 'reply', id: data.id, error: error.message, state: status() }); }
    finally { if (executing === data.command) executing = false; }
  });
  setInterval(() => {
    if (!desk || closed) return;
    if (desk.closed || Date.now() - lastMessage > 5000) connected = false;
    // Never reveal UI because a connection vanished: OBS may still be recording.
    send({ type: 'state', state: status() });
  }, 500);
  return {
    open() {
      if (!api.state().active) throw new Error('Start preview first.');
      if (desk && !desk.closed && !closed) { desk.focus(); return; }
      closed = false; connected = false;
      const params = new URLSearchParams({ origin: location.origin, session });
      desk = window.open(`${controlsOrigin}/#${params}`, `planeir-controls-${session}`, 'popup,width=720,height=940');
      if (!desk) throw new Error('Allow the recording controls popup, then click Open recording controls again.');
      lastMessage = Date.now();
    },
    focus() { if (desk && !desk.closed) desk.focus(); else this.open(); },
    stop() {
      if (!connected || desk?.closed) { this.open(); throw new Error('Reconnect the recording controls to OBS, then stop. The captured view remains clean.'); }
      send({ type: 'stop-request' });
    },
    report(error) { send({ type: 'error', error }); },
    get isOpen() { return !closed && Boolean(desk); }
  };
}
