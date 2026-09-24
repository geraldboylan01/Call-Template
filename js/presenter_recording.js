import { createPresenterTake, buildTakeFiles, zipTakeFiles } from './presenter_take.js';

const storageKey = 'planeir-presenter-edit-take-v1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function mountPresenterRecording(host, { api, panel, recorderUI, run }) {
  const log = createPresenterTake();
  let generation = 0, countdown = false, storageError = '';
  host.innerHTML = `<h3>Record for editing · iPhone + OBS</h3>
    <p>Record yourself on your iPhone. In OBS, record this clean Planéir view and your external Mac microphone. Both recordings run continuously.</p>
    <p>Start preview, choose your final window size, then Validate live. Start both recorders and clap once. Start the take below: a countdown and SYNC slate mark the timing reference, then all controls disappear.</p>
    <p>RIGHT / LEFT: visual beat · M: mark a retake · C: controls · S: finish take log. OBS and iPhone must be stopped separately.</p>
    <label><input type="checkbox" class="presenter-capture-confirm"> OBS and iPhone are recording; the external mic meter is moving in OBS.</label>
    <div class="presenter-take-actions"></div><p class="presenter-take-status" role="status"></p>
    <a href="./recording.html" target="_blank" rel="noopener">Recording and editing guide</a>`;
  // Resolve relative to the deployed app rather than a private preview directory.
  host.querySelector('a').href = new URL('../app/recording.html', import.meta.url).href;
  const status = host.querySelector('.presenter-take-status'), confirm = host.querySelector('input');
  const slate = document.createElement('div'); slate.className = 'presenter-sync-slate'; slate.hidden = true; document.body.append(slate);
  const refresh = () => {
    const take = log.snapshot();
    status.textContent = `${take ? `${take.id} · ${take.status}${take.exported ? ' · package downloaded' : ''}` : 'No take yet. Planéir logs cues; it does not start or verify OBS or the iPhone.'}${storageError}`;
    start.disabled = log.active; download.disabled = !take || log.active; finishButton.disabled = !log.active;
  };
  const persist = () => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(log.snapshot())); storageError = ''; }
    catch { storageError = ' · Recovery storage unavailable. Keep this tab open and download the package after stopping.'; }
    refresh();
  };
  const observe = event => { if (!log.active) return; log.record(event); persist(); };
  const clean = value => document.body.classList.toggle('presenter-clean-recording', value);
  async function finish(reason = 'finished') {
    if (!log.active) return;
    generation++; countdown = false; slate.hidden = true;
    while (api.state().busy) await pause(30);
    log.end(reason); api.setExternalRecording(false); clean(false); confirm.checked = false; persist();
    if (!panel.open) panel.showModal();
  }
  async function startTake() {
    if (!confirm.checked) throw new Error('Start OBS and iPhone recording, check your microphone in OBS, then tick the confirmation.');
    if (recorderUI.recorder.recording || recorderUI.recorder.starting) throw new Error('Stop browser recording before starting an OBS take.');
    api.canRecord();
    if (log.snapshot() && !log.snapshot().exported) throw new Error('Download the previous edit package before starting another take.');
    // Release any devices prepared in the alternative browser recorder.
    await recorderUI.recorder.dispose();
    api.canRecord();
    await api.restart();
    log.begin(api.recordingBundle(), { width: innerWidth, height: innerHeight });
    api.setExternalRecording(true); countdown = true; clean(true); panel.close(); persist();
    const token = ++generation;
    try {
      slate.hidden = false;
      for (let n = 3; n > 0; n--) {
        slate.replaceChildren(); const heading = document.createElement('strong'); heading.textContent = String(n);
        const text = document.createElement('span'); text.textContent = 'Keep both recorders running. Get ready to speak.'; slate.append(heading, text);
        await pause(1000); if (token !== generation) return;
      }
      await new Promise(requestAnimationFrame); if (token !== generation) return;
      slate.replaceChildren(); const heading = document.createElement('strong'); heading.textContent = 'SYNC';
      const text = document.createElement('span'); text.textContent = '00:00:00.000 · edit timing reference'; slate.append(heading, text);
      log.sync(); persist();
      await pause(1000); if (token !== generation) return;
      slate.hidden = true; countdown = false; observe({ type: 'ready', label: 'Begin speaking; first RIGHT is cue 1' });
    } catch (error) { await finish('start-failed'); throw error; }
  }
  function downloadPackage() {
    const take = log.snapshot(), blob = zipTakeFiles(buildTakeFiles(take));
    const a = document.createElement('a'), url = URL.createObjectURL(blob); a.href = url; a.download = `${take.id}.zip`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); log.exported(); persist();
  }
  const button = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = () => run(fn); host.querySelector('.presenter-take-actions').append(b); return b; };
  const start = button('Start clean take', startTake);
  const finishButton = button('Finish take log', () => finish());
  const download = button('Download edit package', downloadPackage);
  try { const saved = sessionStorage.getItem(storageKey); if (saved) log.restore(JSON.parse(saved)); } catch { storageError = ' · The previous recovery log could not be read.'; }
  refresh();
  window.addEventListener('resize', () => observe({ type: 'viewport-changed', label: `${innerWidth} × ${innerHeight}; check framing and revalidate before another take` }));
  document.addEventListener('visibilitychange', () => observe({ type: document.hidden ? 'page-hidden' : 'page-visible', label: 'Check recording continuity and sync' }));
  window.addEventListener('pagehide', () => { if (log.active) { log.end('page-closed'); persist(); } });
  window.addEventListener('beforeunload', event => { if (log.active || (log.snapshot() && !log.snapshot().exported)) { event.preventDefault(); event.returnValue = ''; } });
  return { start: startTake, finish, observe, download: downloadPackage, snapshot: log.snapshot, get active() { return log.active; }, get countingDown() { return countdown; } };
}
