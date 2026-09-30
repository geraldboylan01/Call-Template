import { VOICE_CONSENT_VERSION, VOICE_CONSENT_TEXT, VOICE_MAX_BYTES, VOICE_MAX_DURATION_MS, VOICE_TYPES } from './case_application/voice_contract.js';

export function downloadAudio(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function decodeAudio(blob) {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) throw new Error('This browser cannot read the audio. Please use a recent browser or send the application without a recording.');
  const context = new Audio();
  try { return await context.decodeAudioData(await blob.arrayBuffer()); }
  finally { await context.close(); }
}

// Local conversion only. The compressed original remains in private storage.
export async function audioToWav(blob) {
  const audio = await decodeAudio(blob);
  if (audio.duration > 125) throw new Error('This recording is too long to convert here. Download the original.');
  const channels = Math.min(audio.numberOfChannels, 2);
  const pcm = new ArrayBuffer(44 + audio.length * channels * 2);
  const view = new DataView(pcm);
  const word = (offset, value) => [...value].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
  word(0, 'RIFF'); view.setUint32(4, pcm.byteLength - 8, true); word(8, 'WAVE'); word(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, pcm.byteLength - 44, true);
  const samples = Array.from({ length: channels }, (_, channel) => audio.getChannelData(channel));
  let offset = 44;
  for (let i = 0; i < audio.length; i++) for (const channel of samples) {
    const sample = Math.max(-1, Math.min(1, channel[i]));
    view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true); offset += 2;
  }
  return new Blob([pcm], { type: 'audio/wav' });
}

export function createApplicationVoice(host, { baseUrl, onChange = () => {} } = {}) {
  if (!host) throw new Error('Missing voice-note container.');
  host.innerHTML = `
    <h2 class="apply-card-title">Tell Gerry in your own words <span class="voice-optional">Optional</span></h2>
    <p>Adding a clear voice note greatly improves your chances of being chosen for a video review. Written-only applications are still considered, and selection is not guaranteed.</p>
    <p>In 30–90 seconds, explain what you hope to achieve, what worries you most, and what you would like this review to answer.</p>
    <p class="apply-card-intro">Speak naturally. Leave out your full name, address, employer, account details and other people's names. Maximum two minutes and 10 MiB.</p>
    <div class="voice-actions">
      <button type="button" class="button button-secondary" data-voice="record">Record a voice note</button>
      <button type="button" class="button button-secondary" data-voice="stop" hidden>Stop recording</button>
      <label class="voice-file-label">Upload an audio file<input type="file" data-voice="file" accept="audio/mp4,audio/x-m4a,audio/webm,audio/ogg,audio/mpeg,audio/wav,audio/x-wav,.m4a,.mp3,.webm,.ogg,.wav" /></label>
    </div>
    <p data-voice="timer" class="voice-timer" hidden></p>
    <div data-voice="preview" hidden>
      <audio controls preload="metadata" data-voice="player" aria-label="Your voice-note preview"></audio>
      <p data-voice="details"></p>
      <div class="voice-actions"><button type="button" class="button button-secondary" data-voice="save">Save recording on this device</button><button type="button" class="apply-link-button" data-voice="remove">Remove recording</button></div>
      <p class="apply-card-intro">Your recording stays on this page until you send it. Save a copy before refreshing or leaving.</p>
      <label class="consent-check voice-consent"><input type="checkbox" data-voice="consent" /><span data-voice="consent-text"></span></label>
      <p class="apply-card-intro">This permission is required to send a recording. You can remove the recording and send a written application instead. To withdraw permission later, email hello@planeir.ie.</p>
    </div>
    <p data-voice="status" role="status" aria-live="polite"></p>`;
  const ui = Object.fromEntries([...host.querySelectorAll('[data-voice]')].map(node => [node.dataset.voice, node]));
  ui['consent-text'].textContent = VOICE_CONSENT_TEXT;
  let blob = null, durationMs = 0, previewUrl = '', recorder = null, stream = null;
  let interval = null, autoStop = null, busy = false, processing = false, starting = false;
  let generation = 0, uploadId = '', accessToken = '', enabled = false;
  const status = (message, error = false) => { ui.status.textContent = message; ui.status.classList.toggle('is-error', error); };
  const notify = () => { sync(); onChange(); };
  function sync() {
    const recording = recorder?.state === 'recording';
    ui.record.disabled = busy || processing || starting || recording || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder;
    ui.record.textContent = blob ? 'Record again' : 'Record a voice note';
    ui.stop.hidden = !recording;
    ui.file.disabled = busy || processing || starting || recording;
    ui.remove.disabled = busy || processing || starting || recording;
    ui.consent.disabled = busy || processing || recording;
    ui.consent.required = Boolean(blob);
    ui.preview.hidden = !blob;
  }
  function releaseMicrophone() {
    clearInterval(interval); clearTimeout(autoStop);
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    ui.timer.hidden = true;
  }
  function releasePreview() {
    ui.player.pause(); ui.player.removeAttribute('src'); ui.player.load();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
  }
  async function api(path, options) {
    const response = await fetch(`${baseUrl}/api/applications/voice-note/${path}`, options);
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(data?.error || 'The voice note could not be uploaded. Please try again.'), { retryNew: data?.retryNew });
    return data;
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function discardUpload() {
    if (uploadId && accessToken) await post('discard', { token: accessToken, uploadId });
    uploadId = '';
  }
  async function clear() {
    await discardUpload(); generation++;
    if (recorder?.state === 'recording') recorder.stop();
    releaseMicrophone(); releasePreview(); blob = null; durationMs = 0;
    processing = false; starting = false;
    ui.file.value = ''; ui.consent.checked = false; ui.consent.removeAttribute('aria-invalid');
    status(''); notify();
  }
  async function select(file) {
    const current = ++generation;
    processing = true; sync(); status('Checking your recording…');
    try {
      if (!file.size || file.size > VOICE_MAX_BYTES) throw new Error('Choose a recording smaller than 10 MiB.');
      const byExtension = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg' };
      const type = file.type.split(';')[0].toLowerCase() || byExtension[file.name?.split('.').pop().toLowerCase()];
      if (!VOICE_TYPES[type]) throw new Error('Choose an M4A, MP3, WAV, Ogg or WebM audio file.');
      const nextBlob = file.slice(0, file.size, type);
      const audio = await decodeAudio(nextBlob);
      const ms = Math.ceil(audio.duration * 1000);
      if (!Number.isFinite(ms) || ms <= 0 || ms > VOICE_MAX_DURATION_MS) throw new Error('Choose a recording of two minutes or less.');
      if (current !== generation) return;
      await discardUpload(); releasePreview();
      blob = nextBlob; durationMs = ms; ui.consent.checked = false;
      ui.consent.removeAttribute('aria-invalid');
      previewUrl = URL.createObjectURL(blob); ui.player.src = previewUrl;
      const seconds = Math.ceil(ms / 1000);
      ui.details.textContent = `${seconds} second${seconds === 1 ? '' : 's'} · ${(blob.size / 1024 / 1024).toFixed(1)} MiB`;
      status('Listen back, then tick the permission box to send this recording.');
    } catch (error) { status(error.message || 'Could not read that recording.', true); }
    finally { if (current === generation) { processing = false; notify(); } }
  }
  ui.file.addEventListener('change', () => { const file = ui.file.files?.[0]; ui.file.value = ''; if (file) void select(file); });
  ui.consent.addEventListener('change', () => { ui.consent.removeAttribute('aria-invalid'); notify(); });
  ui.save.addEventListener('click', () => { if (blob) downloadAudio(blob, `my-voice-note.${VOICE_TYPES[blob.type]}`); });
  ui.remove.addEventListener('click', async () => {
    busy = true; sync();
    try { await clear(); } catch (error) { status(error.message, true); }
    finally { busy = false; notify(); }
  });
  ui.stop.addEventListener('click', () => { if (recorder?.state === 'recording') recorder.stop(); });
  ui.record.addEventListener('click', async () => {
    const current = ++generation; starting = true; sync(); status('Allow microphone access to record.');
    try {
      const obtained = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (current !== generation) { obtained.getTracks().forEach(track => track.stop()); return; }
      stream = obtained;
      const mimeType = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 96_000 });
      const currentRecorder = recorder;
      const chunks = []; let recordingFailed = false;
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { recordingFailed = true; releaseMicrophone(); status('Recording stopped unexpectedly. Try again or upload a file.', true); notify(); };
      recorder.onstop = () => {
        const type = currentRecorder.mimeType;
        obtained.getTracks().forEach(track => track.stop());
        if (recorder === currentRecorder) { recorder = null; releaseMicrophone(); }
        if (current === generation && !recordingFailed) void select(new Blob(chunks, { type }));
        else notify();
      };
      recorder.start();
      const started = Date.now(); ui.timer.hidden = false;
      const tick = () => { ui.timer.textContent = `Recording · ${Math.floor((Date.now() - started) / 1000)} seconds`; };
      tick(); interval = setInterval(tick, 1000);
      // Leave room for encoder padding while keeping the actual file <= 120s.
      autoStop = setTimeout(() => { if (recorder?.state === 'recording') recorder.stop(); }, 119_000);
      status('Recording. Press Stop when you are finished.');
    } catch { releaseMicrophone(); status('Could not start the microphone. Check permission or upload an audio file instead.', true); }
    finally { starting = false; notify(); }
  });
  window.addEventListener('pagehide', () => { generation++; if (recorder?.state === 'recording') recorder.stop(); releaseMicrophone(); releasePreview(); });
  window.addEventListener('pageshow', event => {
    if (event.persisted && blob && !previewUrl) { previewUrl = URL.createObjectURL(blob); ui.player.src = previewUrl; }
  });
  window.addEventListener('beforeunload', event => { if (blob || recorder?.state === 'recording') { event.preventDefault(); event.returnValue = ''; } });
  host.hidden = true;
  const ready = api('config').then(config => { enabled = config.enabled === true; host.hidden = !enabled; sync(); }).catch(() => { enabled = false; });
  sync();
  return {
    ready,
    get hasRecording() { return Boolean(blob); },
    get enabled() { return enabled; },
    consent() { return blob ? { consentPublication: ui.consent.checked, consentVersion: VOICE_CONSENT_VERSION } : null; },
    validate() {
      if (processing || starting || recorder?.state === 'recording') return 'Finish checking or recording your voice note before sending.';
      if (blob && !ui.consent.checked) { ui.consent.setAttribute('aria-invalid', 'true'); ui.consent.focus(); return 'Tick the voice-recording permission box, or remove the recording to send a written application.'; }
      return '';
    },
    setBusy(value) { busy = value; sync(); },
    async upload(token) {
      const invalid = this.validate(); if (invalid) throw new Error(invalid);
      if (!blob) return;
      if (!token) throw new Error('Your application is saved, but voice uploads are unavailable. Save your recording and try the link in your receipt email later.');
      accessToken = token; uploadId ||= crypto.randomUUID();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
      const sha256 = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const payload = () => ({ token, uploadId, sha256, bytes: blob.size, contentType: blob.type, durationMs, ...this.consent() });
      status('Uploading your voice note…');
      let prepared;
      try { prepared = await post('prepare', payload()); }
      catch (error) { if (!error.retryNew) throw error; uploadId = crypto.randomUUID(); prepared = await post('prepare', payload()); }
      if (!prepared.ready) await api('upload', { method: 'PUT', headers: { 'Content-Type': blob.type, 'X-Application-Audio-Token': token, 'X-Voice-Request-Id': uploadId, 'X-Voice-Publication-Consent': VOICE_CONSENT_VERSION }, body: blob });
      status('Your voice note has been received with permission to use it in the review.');
    },
    // Success clears only local state, never discards the submitted file.
    complete() { uploadId = ''; accessToken = ''; blob = null; ui.consent.checked = false; releasePreview(); notify(); },
    clear
  };
}
