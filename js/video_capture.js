// Shared local recorder, extracted from the existing private video scene's
// camera + microphone / display capture / WebM flow. No upload path.
export function createVideoCapture({ onChange = () => {}, mediaDevices = globalThis.navigator?.mediaDevices, Recorder = globalThis.MediaRecorder, Stream = globalThis.MediaStream } = {}) {
  let devices = null, display = null, recorder = null, chunks = [], recording = false, starting = false;
  let audioContext = null, audioSource = null, url = null, stopPromise = null, finishStop = null;
  let generation = 0;
  let status = 'Prepare your microphone before recording.';
  const emit = () => onChange({ recording, starting, status, stream: devices, url });
  const tracksOff = stream => stream?.getTracks().forEach(track => track.stop());
  const audioOff = () => { audioSource?.disconnect(); audioSource = null; void audioContext?.close(); audioContext = null; };
  const mime = () => ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => Recorder?.isTypeSupported?.(type));
  async function prepare({ camera = false, cameraId = '', microphoneId = '' } = {}) {
    if (recording || starting) throw new Error('Stop recording before changing devices.');
    const operation = ++generation;
    tracksOff(devices); devices = null;
    try {
      const prepared = await mediaDevices.getUserMedia({ video: camera ? { width: { ideal: 1920 }, height: { ideal: 1080 }, ...(cameraId ? { deviceId: { exact: cameraId } } : {}) } : false,
        audio: microphoneId ? { deviceId: { exact: microphoneId } } : true });
      if (operation !== generation) { tracksOff(prepared); return null; }
      devices = prepared;
      if (!devices.getAudioTracks().some(t => t.enabled && t.readyState === 'live')) throw new Error('No live microphone. Recording will not start silently.');
      status = camera ? 'Camera + microphone ready.' : 'Microphone ready.'; emit();
      return devices;
    } catch (error) { if (operation !== generation) return null; tracksOff(devices); devices = null; status = error.message; emit(); throw error; }
  }
  function finish(error = null) {
    recording = false; starting = false;
    tracksOff(display); display = null; audioOff();
    if (chunks.length) {
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob(chunks, { type: recorder?.mimeType || 'video/webm' }));
      status = error ? `Recording ended: ${error.message}. Partial recording is available.` : 'Recording ready. Save WebM locally.';
    } else status = error?.message || 'No video was captured.';
    chunks = []; emit(); finishStop?.(); finishStop = null; stopPromise = null;
  }
  async function start({ quality = 'high' } = {}) {
    if (recording || starting) return;
    if (!Recorder || !mediaDevices?.getDisplayMedia) throw new Error('Tab recording is unavailable in this browser.');
    const mic = devices?.getAudioTracks().filter(t => t.enabled && t.readyState === 'live') || [];
    if (!mic.length) throw new Error('Prepare a live microphone first.');
    const operation = generation;
    starting = true; status = 'Choose this tab or window in the browser picker.'; emit();
    try {
      // Invoke immediately from the Record button, before awaited audio setup.
      const captured = await mediaDevices.getDisplayMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
      if (operation !== generation) { tracksOff(captured); return; }
      display = captured;
      const video = display.getVideoTracks();
      if (!video.length) throw new Error('The selected source has no video track.');
      let audio = mic;
      const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (Audio) {
        audioContext = new Audio(); await audioContext.resume();
        const destination = audioContext.createMediaStreamDestination();
        audioSource = audioContext.createMediaStreamSource(new Stream(mic));
        audioSource.connect(destination); audio = destination.stream.getAudioTracks();
      }
      if (operation !== generation) return;
      if (!mic.some(t => t.readyState === 'live')) throw new Error('Microphone disconnected before recording.');
      const type = mime();
      recorder = new Recorder(new Stream([...video, ...audio]), { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: { standard: 8e6, high: 16e6, max: 28e6 }[quality] || 16e6, audioBitsPerSecond: 192000 });
      chunks = []; let failure = null;
      recorder.addEventListener('dataavailable', event => { if (event.data?.size) chunks.push(event.data); });
      recorder.addEventListener('error', event => { failure = event.error || new Error('Recorder error'); if (recorder.state !== 'inactive') recorder.stop(); });
      recorder.addEventListener('stop', () => finish(failure), { once: true });
      video[0].addEventListener('ended', () => { if (recording) void stop(); }, { once: true });
      mic.forEach(t => t.addEventListener('ended', () => { if (recording) { failure = new Error('Microphone disconnected'); void stop(); } }, { once: true }));
      recorder.start(1000); recording = true; starting = false; status = 'Recording — S stops and saves; Esc exits.'; emit();
    } catch (error) { if (operation !== generation) return; tracksOff(display); display = null; audioOff(); starting = false; status = error.message; emit(); throw error; }
  }
  function stop() {
    if (stopPromise) return stopPromise;
    if (!recording) return Promise.resolve();
    stopPromise = new Promise(resolve => { finishStop = resolve; });
    const pending = stopPromise;
    if (recorder.state !== 'inactive') recorder.stop(); else finish();
    return pending;
  }
  async function dispose() { generation++; await stop(); starting = false; tracksOff(display); display = null; tracksOff(devices); devices = null; audioOff(); emit(); }
  return { prepare, start, stop, dispose, get recording() { return recording; }, get starting() { return starting; }, get url() { return url; } };
}

export function mountVideoCapture(host, { beforeStart = () => {}, onRecordingChange = () => {} } = {}) {
  host.classList.add('video-capture-controls');
  const title = document.createElement('strong'); title.textContent = 'Local recording'; host.append(title);
  const preview = document.createElement('video'); preview.className = 'presenter-camera'; preview.muted = true; preview.autoplay = true; preview.playsInline = true; preview.hidden = true; document.body.append(preview);
  const cameraLabel = document.createElement('label'), camera = document.createElement('input'); camera.type = 'checkbox'; cameraLabel.append(camera, ' Include camera'); host.append(cameraLabel);
  const deviceSelect = label => { const s = document.createElement('select'); s.setAttribute('aria-label', label); s.add(new Option(label, '')); host.append(s); return s; };
  const microphones = deviceSelect('Default microphone'), cameras = deviceSelect('Default camera');
  const quality = deviceSelect('High quality'); quality.replaceChildren(); for (const v of ['standard', 'high', 'max']) quality.add(new Option(v, v)); quality.value = 'high';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const save = document.createElement('a'); save.textContent = 'Save WebM'; save.download = 'planeir-recording.webm'; save.hidden = true;
  let wasCapturing = false;
  const recorder = createVideoCapture({ onChange(state) {
    status.textContent = state.status; preview.srcObject = state.stream;
    preview.hidden = !state.stream?.getVideoTracks().length;
    document.body.classList.toggle('video-recording', state.recording || state.starting);
    onRecordingChange(state);
    const dialog = host.closest('dialog');
    if (wasCapturing && !state.recording && !state.starting && dialog && !dialog.open) dialog.showModal();
    wasCapturing = state.recording || state.starting;
    save.hidden = !state.url || state.recording || state.starting; if (state.url) save.href = state.url;
  } });
  const button = (label, run) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', () => { Promise.resolve().then(run).catch(e => { status.textContent = e.message; const dialog = host.closest('dialog'); if (dialog && !dialog.open) dialog.showModal(); }); }); host.append(b); return b; };
  button('Prepare microphone / camera', async () => {
    await recorder.prepare({ camera: camera.checked, microphoneId: microphones.value, cameraId: cameras.value });
    for (const [select, kind] of [[microphones, 'audioinput'], [cameras, 'videoinput']]) {
      const selected = select.value; select.replaceChildren(new Option(`Default ${kind === 'audioinput' ? 'microphone' : 'camera'}`, ''));
      for (const d of await navigator.mediaDevices.enumerateDevices()) if (d.kind === kind) select.add(new Option(d.label || kind, d.deviceId));
      select.value = selected;
    }
  });
  button('Fullscreen', () => document.documentElement.requestFullscreen());
  button('Record', () => { beforeStart(); return recorder.start({ quality: quality.value }); });
  button('Stop', () => recorder.stop());
  host.append(save, status); status.textContent = 'Prepare the microphone, then choose Record.';
  const emergency = document.createElement('button'); emergency.type = 'button'; emergency.className = 'presenter-emergency-stop'; emergency.textContent = 'Stop recording'; emergency.addEventListener('click', () => { emergency.style.visibility = 'hidden'; requestAnimationFrame(() => void recorder.stop().finally(() => { emergency.style.visibility = ''; })); }); document.body.append(emergency);
  return { recorder, preview, dispose: async () => { await recorder.dispose(); preview.remove(); emergency.remove(); } };
}
