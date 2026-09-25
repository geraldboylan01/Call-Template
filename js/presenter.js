import { buildPresentationCatalogue, buildLivePresenterBrief, fingerprint } from './presenter_catalogue.js';
import { compilePresentation, annotateScript } from './presenter_package.js';
import { focusPresenterChartPoint, waitForPresenterCharts } from './charts.js';
import { mountVideoCapture } from './video_capture.js';
import { createPresenterAttention, glideTo, changePresenterScene } from './presenter_attention.js';
import { mountPresenterRecording } from './presenter_recording.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const attr = value => CSS.escape(String(value));

export function resolvePresentationTarget(root, target) {
  const r = target.ref;
  const block = r.blockId ? root?.querySelector(`[data-report-block-id="${attr(r.blockId)}"]`) : root;
  let element;
  switch (r.type) {
    case 'module': element = root; break;
    case 'card': element = root?.querySelector(`[data-module-card-id="${attr(r.cardId)}"], [data-generated-card="${attr(r.cardId)}"]`); break;
    case 'pbs-bucket': element = root?.querySelector(`.pbs-bucket-card[data-pbs-section-key="${attr(r.section)}"], .pbs-stacked-card[data-pbs-section-key="${attr(r.section)}"]`); break;
    case 'pbs-row': element = root?.querySelector(`[data-pbs-section-key="${attr(r.section)}"][data-pbs-row-label="${attr(r.rowKey)}"]`); break;
    case 'liquidity-metric': element = root?.querySelector(`[data-presenter-metric="${attr(r.key)}"]`); break;
    case 'report-block': case 'chart-point': element = block; break;
    case 'report-item': element = block?.querySelector(`[data-report-item-id="${attr(r.itemId)}"]`); break;
    case 'output-row': element = root?.querySelectorAll(`[data-generated-card="outputs"] tbody tr`)[r.row]; break;
    case 'table-row': element = block?.querySelectorAll('tbody tr')[r.row]; break;
    case 'timeline-event': element = block?.querySelector(`[data-timeline-event-id="${attr(r.eventId)}"]`); break;
    case 'chart': element = root?.querySelector(`[data-chart-index="${r.chartIndex}"]`); break;
    default: throw new Error(`Unsupported target resolver: ${r.type}`);
  }
  if (!element) throw new Error(`The live view cannot resolve “${target.label}” (${target.id}).`);
  return element;
}

// Controller owns only navigation and ephemeral visual state. The host owns the
// ordinary app renderer and isolates the financial session before any operation.
export function createPresenterController(host, onChange = () => {}, onEvent = () => {}) {
  let pkg, script, catalogue, compiled, active = false, busy = false, index = -1;
  let error = '', cleanupPoint, focused, framed, currentModule, validation = null;
  let externalRecording = false, navigationId = 0;
  const attention = createPresenterAttention();
  const targets = () => new Map(catalogue.targets.map(t => [t.id, t]));
  const emit = () => onChange(api.state());
  const clean = () => { attention.clear(); cleanupPoint?.(); cleanupPoint = null; focused?.classList.remove('presenter-focus'); focused = null; framed?.classList.remove('presenter-timeline-overview', 'presenter-timeline-compact'); framed = null; };
  const defaults = () => Object.fromEntries(catalogue.modules.filter(m => m.scenarios.length).map(m => [m.key, m.defaultScenarioId]));
  let liveScenarios = {};
  async function show(key) {
    if (currentModule === key && host.root()?.isConnected) return;
    clean();
    const module = catalogue.modules.find(m => m.key === key);
    if (currentModule) await changePresenterScene(() => host.showModule(module.moduleId), host.root);
    else await host.showModule(module.moduleId);
    currentModule = key;
    if (liveScenarios[key]) await host.setScenario(module, liveScenarios[key]);
  }
  async function settle(root) {
    // Wait for the real component animations, including CSS transitions. Existing
    // scenario adapters await their own chart/SVG animation completion too.
    const animations = root.getAnimations?.({ subtree: true }).filter(a => a.effect?.getTiming().iterations !== Infinity) || [];
    let timer;
    try { await Promise.race([Promise.all(animations.map(a => a.finished.catch(() => {}))), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The live view did not finish animating.')), 5000); })]); } finally { clearTimeout(timer); }
    await new Promise(requestAnimationFrame);
    await waitForPresenterCharts(root);
  }
  async function visual(target, action, emphasis) {
    clean();
    const root = host.root();
    root.querySelectorAll('details[data-default-open]').forEach(d => { d.open = d.dataset.defaultOpen === 'true'; });
    if (action === 'reset') target = catalogue.targets.find(t => t.moduleKey === target.moduleKey && t.ref.type === 'module');
    let element = resolvePresentationTarget(root, target);
    if (action === 'frame' && target.kind === 'timeline') {
      framed = element; framed.classList.add('presenter-timeline-overview');
      if (framed.getBoundingClientRect().height > root.clientHeight - 100) framed.classList.add('presenter-timeline-compact');
    }
    const details = element.closest('details');
    if (details) details.open = true;
    await settle(root);
    const bounds = root.getBoundingClientRect(), rect = element.getBoundingClientRect();
    const desired = element === root ? 0 : root.scrollTop + rect.top - bounds.top - (rect.height < bounds.height - 80 ? (bounds.height - rect.height) / 2 : 30);
    await glideTo(root, desired);
    if (action === 'focus') { element.classList.add('presenter-focus'); focused = element; }
    if (target.ref.type === 'chart-point') { cleanupPoint = focusPresenterChartPoint(element, target.ref.datasetIndex, target.ref.pointIndex, { value: target.value, xLabel: target.xLabel }); await waitForPresenterCharts(root); }
    let attentionEvidence = null;
    if (action === 'focus') {
      const treatment = emphasis || target.suggestedEmphasis || (target.ref.type === 'chart-point' ? 'point' : 'spotlight');
      attentionEvidence = await attention.focus(root, element, treatment, cleanupPoint?.anchor);
    }
    const visible = element.getBoundingClientRect();
    if (visible.width <= 0 || visible.height <= 0 || visible.bottom <= bounds.top || visible.top >= bounds.bottom) throw new Error(`Target is not visible: ${target.label}`);
    return { targetId: target.id, label: target.label, scrollTop: root.scrollTop, rect: { top: visible.top, left: visible.left, width: visible.width, height: visible.height }, text: element.innerText?.trim().slice(0, 250) || '', sourceValue: target.value ?? null, attention: attentionEvidence };
  }
  async function execute(step, reconstruct = false) {
    const t = targets();
    if (reconstruct) {
      liveScenarios = { ...step.view.scenarios };
      await show(step.view.moduleKey);
      const module = catalogue.modules.find(m => m.key === step.view.moduleKey);
      if (liveScenarios[module.key]) await host.setScenario(module, liveScenarios[module.key]);
      return visual(t.get(step.view.targetId), step.view.action, step.view.emphasis);
    }
    let evidence;
    for (const [i, op] of step.operations.entries()) {
      const target = t.get(op.target);
      await show(target.moduleKey);
      if (op.action === 'state') {
        const module = catalogue.modules.find(m => m.key === target.moduleKey);
        await host.setScenario(module, op.scenarioId);
        liveScenarios[module.key] = op.scenarioId;
      }
      // STATE + FOCUS/FRAME is one arrival. Do not pan to the module top and
      // back to the target merely because setup has more than one operation.
      if (op.action !== 'state' || i === step.operations.length - 1) evidence = await visual(target, op.action === 'state' ? 'frame' : op.action, op.emphasis);
    }
    return evidence;
  }
  async function ready() {
    liveScenarios = defaults(); currentModule = null;
    await show(compiled.steps[0].view.moduleKey);
    const module = catalogue.targets.find(t => t.moduleKey === currentModule && t.ref.type === 'module');
    await visual(module, 'reset'); index = -1;
  }
  async function exclusive(fn) {
    if (busy) throw new Error('Wait for the current visual beat to finish.');
    busy = true; error = ''; emit();
    try { return await fn(); } catch (e) { error = e.message; throw e; } finally { busy = false; emit(); }
  }
  const api = {
    discover: () => buildPresentationCatalogue(host.session()),
    brief: () => buildLivePresenterBrief(api.discover()),
    unload() {
      if (active || busy) throw new Error('Exit the current preview before changing its files.');
      pkg = script = catalogue = compiled = undefined; index = -1; error = ''; validation = null; emit();
    },
    load(nextPackage, nextScript) {
      if (active || busy) throw new Error('Exit the current preview before loading another package.');
      api.unload();
      try {
        const nextCatalogue = api.discover(), nextCompiled = compilePresentation(nextPackage, nextCatalogue, nextScript);
        catalogue = nextCatalogue; compiled = nextCompiled; pkg = structuredClone(nextPackage); script = nextScript;
      } catch (e) { error = e.message; emit(); throw e; }
      emit();
      return { ...api.state(), narrative: compiled.narrative, annotatedScript: annotateScript(script, compiled) };
    },
    start: () => exclusive(async () => {
      if (active) return;
      if (!pkg || !compiled) throw new Error('Choose presentation.json and script.md before starting preview. Both files are required.');
      catalogue = api.discover(); compiled = compilePresentation(pkg, catalogue, script);
      await host.begin(); active = true; document.body.classList.add('presenter-active');
      try { await ready(); } catch(e) { clean(); await host.end(); active = false; document.body.classList.remove('presenter-active'); throw e; }
    }),
    goTo: destination => exclusive(async () => {
      if (!active) throw new Error('Start preview first.');
      if (!Number.isInteger(destination) || destination < -1 || destination >= compiled.steps.length) return;
      const previous = index;
      const navigation = { navigationId: ++navigationId, fromIndex: previous, index: destination, direction: destination > previous ? 'forward' : destination < previous ? 'backward' : 'repeat', stepId: compiled.steps[destination]?.id || null, label: compiled.steps[destination]?.label || 'Ready' };
      onEvent({ type: 'requested', ...navigation });
      try {
        if (destination === -1) await ready();
        else { await execute(compiled.steps[destination], destination !== index + 1); index = destination; }
        onEvent({ type: 'arrived', ...navigation });
      } catch(e) {
        // A failure cannot consume a script cue or leave a half-selected scenario.
        try { if (previous < 0) await ready(); else await execute(compiled.steps[previous], true); } catch (_) { /* Surface original error; exit still restores the saved session. */ }
        index = previous; onEvent({ type: 'failed', ...navigation, error: e.message }); throw e;
      }
    }),
    next: () => api.goTo(index + 1), previous: () => api.goTo(index - 1),
    restart: () => api.goTo(-1),
    async exit() {
      if (busy) { while (busy) await pause(30); }
      return exclusive(async () => {
        if (!active) return;
        clean(); document.body.classList.remove('presenter-active', 'presenter-wide', 'presenter-hud-hidden');
        await host.end(); active = false; index = -1; currentModule = null;
      });
    },
    validateLive: () => exclusive(async () => {
      if (externalRecording) throw new Error('Finish the take before running validation.');
      if (!active) throw new Error('Start preview before live validation.');
      const originalIndex = index, evidence = [], failures = [];
      try {
        await ready();
        for (const [i, step] of compiled.steps.entries()) {
          try { evidence.push({ stepId: step.id, direction: 'forward', ...(await execute(step)) }); index = i; }
          catch(e) { failures.push({ stepId: step.id, error: e.message }); break; }
        }
        if (!failures.length) for (let i = compiled.steps.length - 2; i >= 0; i--) {
          try { evidence.push({ stepId: compiled.steps[i].id, direction: 'backward', ...(await execute(compiled.steps[i], true)) }); index = i; }
          catch(e) { failures.push({ stepId: compiled.steps[i].id, direction: 'backward', error: e.message }); break; }
        }
      } finally { if (originalIndex < 0) await ready(); else { await execute(compiled.steps[originalIndex], true); index = originalIndex; } }
      validation = { version: 1, status: failures.length ? 'failed' : 'passed', validatedAt: new Date().toISOString(), caseFingerprint: catalogue.caseFingerprint, scriptHash: fingerprint(script), stepCount: compiled.steps.length, cueCount: compiled.cues.length, viewport: { width: innerWidth, height: innerHeight }, surface: { width: host.root().clientWidth, height: host.root().clientHeight }, failures, evidence, narrative: compiled.narrative, unmapped: compiled.unmapped };
      return structuredClone(validation);
    }),
    state: () => ({ active, busy, loaded: Boolean(compiled), index, count: compiled?.steps.length || 0, current: index < 0 ? 'Ready — first cue is next' : compiled?.steps[index]?.label, next: compiled?.steps[index + 1]?.label || 'End', error, narrative: compiled?.narrative, validationStatus: validation?.status || 'not-run', scenarios: { ...liveScenarios } }),
    recordingBundle: () => ({ presentation: structuredClone(pkg), script, compiled: structuredClone(compiled), validation: structuredClone(validation) }),
    setExternalRecording: value => { externalRecording = Boolean(value); },
    canRecord() {
      if (!active || busy) throw new Error('Start preview and wait for the current beat.');
      if (validation && (validation.viewport.width !== innerWidth || validation.viewport.height !== innerHeight || validation.surface.width !== host.root().clientWidth || validation.surface.height !== host.root().clientHeight)) throw new Error('The capture layout changed. Run live validation again at this size.');
      if (compiled.narrative.status !== 'recorded' || validation?.status !== 'passed') throw new Error('Complete the narrative review and live validation before recording.');
    }
  };
  return api;
}

const saveFile = (name, value, type = 'application/json') => {
  const a = document.createElement('a'), url = URL.createObjectURL(new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], { type }));
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export function installPresenter(host) {
  const launch = document.createElement('button'); launch.id = 'presenterLaunch'; launch.className = 'ui-button presenter-launch'; launch.textContent = 'Presenter Mode'; document.querySelector('.topbar-right')?.prepend(launch);
  const panel = document.createElement('dialog'); panel.className = 'presenter-setup';
  panel.innerHTML = '<h2>Live Presenter Mode</h2><p>Choose the two files for this analysis, one at a time or together. Preview starts before the first cue. Each RIGHT ARROW presents one visual idea.</p><label>1. Presentation — presentation.json <input class="presenter-package-file" type="file" accept=".json,.md" multiple></label><label>2. Spoken script — script.md <input class="presenter-script-file" type="file" accept=".md"></label><p class="presenter-files-status" role="status"></p><p class="presenter-message" role="status"></p><div class="presenter-actions"></div><div class="presenter-edit-recording"></div><details class="presenter-browser-recording"><summary>Alternative: browser WebM recording</summary><div class="presenter-recording"></div></details>';
  document.body.append(panel);
  const message = panel.querySelector('.presenter-message'), actions = panel.querySelector('.presenter-actions');
  const hud = document.createElement('aside'); hud.className = 'presenter-hud'; hud.setAttribute('aria-live', 'polite'); document.body.append(hud);
  let recorderUI, editRecording, exiting = false, wideScroll = null, startButton;
  const fileInputs = [...panel.querySelectorAll('input[type=file]')], chosen = { json: null, script: null };
  let fileGeneration = 0;
  const filesStatus = panel.querySelector('.presenter-files-status');
  const api = createPresenterController(host, state => {
    hud.replaceChildren();
    const text = document.createElement('span'); text.textContent = `${Math.max(0, state.index + 1)}/${state.count} · ${state.current} · Next: ${state.next}${state.busy ? ' · Moving…' : ''}${state.error ? ` · ${state.error}` : ''}`; hud.append(text);
    const controls = document.createElement('button'); controls.textContent = 'Controls'; controls.onclick = () => { editRecording?.observe({ type: 'controls-opened' }); panel.showModal(); }; hud.append(controls);
    message.textContent = state.error || (state.loaded ? `${state.count} beats ready · Live validation: ${state.validationStatus}` : 'Choose both files to enable Start preview.');
    filesStatus.textContent = state.loaded ? 'Presentation and script are ready.' : `Presentation: ${chosen.json?.name || 'not selected'} · Script: ${chosen.script?.name || 'not selected'}`;
    if (startButton) startButton.disabled = !state.loaded || state.busy;
    fileInputs.forEach(input => { input.disabled = state.active || state.busy; });
  }, event => editRecording?.observe(event));
  const run = fn => Promise.resolve().then(fn).catch(e => { message.textContent = e.message; hud.dataset.error = e.message; if (editRecording?.active && !panel.open) { editRecording.observe({ type: 'controls-opened', reason: e.message }); panel.showModal(); } });
  const button = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = () => run(fn); actions.append(b); return b; };
  launch.onclick = () => panel.showModal();
  fileInputs.forEach(input => { input.onchange = event => run(async () => {
    const files = [...event.target.files];
    if (!files.length) return; // Cancelling the picker keeps the current selection.
    const generation = ++fileGeneration;
    api.unload(); // Never leave an old package startable after a failed replacement.
    const json = files.find(f => f.name === 'presentation.json') || files.find(f => f.name.endsWith('.json'));
    const md = files.find(f => f.name === 'script.md');
    if (event.target.classList.contains('presenter-script-file')) chosen.script = null;
    else if (!json && !md) chosen.json = null;
    if (json) chosen.json = json;
    if (md) chosen.script = md;
    filesStatus.textContent = `Presentation: ${chosen.json?.name || 'not selected'} · Script: ${chosen.script?.name || 'not selected'}`;
    if (files.some(f => f.name.endsWith('.md') && f.name !== 'script.md')) throw new Error('Choose script.md as the spoken script. Keep script-presenter.md as your reading copy.');
    if (!json && !md) throw new Error('Choose presentation.json or script.md. Keep script-presenter.md as your reading copy.');
    if (!chosen.json || !chosen.script) {
      message.textContent = chosen.json ? 'Presentation selected. Now choose script.md in the second box.' : 'Script selected. Now choose presentation.json in the first box.';
      return;
    }
    message.textContent = 'Checking the presentation and script…';
    try {
      const [packageText, scriptText] = await Promise.all([chosen.json.text(), chosen.script.text()]);
      if (generation !== fileGeneration) return;
      let parsed;
      try { parsed = JSON.parse(packageText); } catch { throw new Error('The presentation file is not valid JSON. Choose the original presentation.json.'); }
      api.load(parsed, scriptText);
    } catch (e) { if (generation === fileGeneration) throw e; }
  }); });
  startButton = button('Start preview', async () => { await api.start(); panel.close(); });
  startButton.disabled = true;
  message.textContent = 'Choose both files to enable Start preview.';
  filesStatus.textContent = 'Presentation: not selected · Script: not selected';
  button('Validate live', async () => { panel.close(); const result = await api.validateLive(); saveFile('validation.json', result); panel.showModal(); });
  button('Restart at first cue', async () => { await api.restart(); panel.close(); });
  button('Fullscreen', () => document.documentElement.requestFullscreen());
  button('Download presenter script', () => { const b = api.recordingBundle(); if (!b.compiled) throw new Error('Load a presentation package first.'); saveFile('script-presenter.md', annotateScript(b.script, b.compiled), 'text/markdown'); });
  button('Export presentation targets', () => saveFile('presentation-targets.json', api.discover()));
  button('Export live-presenter brief', () => saveFile('live-presenter-brief.json', api.brief()));
  button('Close controls', () => panel.close());
  async function exit() {
    if (exiting) return; exiting = true;
    try { restoreWide(); await editRecording.finish('exit'); await recorderUI.recorder.dispose(); await api.exit(); panel.showModal(); } finally { exiting = false; }
  }
  button('Exit presenter', exit);
  recorderUI = mountVideoCapture(panel.querySelector('.presenter-recording'), { beforeStart: () => { if (editRecording.active) throw new Error('Finish the OBS take before using the browser recorder.'); api.canRecord(); panel.close(); } });
  editRecording = mountPresenterRecording(panel.querySelector('.presenter-edit-recording'), { api, panel, recorderUI, run });
  const handleKey = event => {
    if (!api.state().active) return false;
    if (event.key === 'Escape') { event.preventDefault(); void run(exit); return true; }
    if (editRecording.countingDown) { event.preventDefault(); return true; }
    if (event.target?.matches?.('input,textarea,select,[contenteditable="true"]') || panel.open) return true;
    const key = event.key.toLowerCase();
    if (['arrowright', 'arrowleft', 'arrowup', 'h', 's', 'c', 'm'].includes(key)) event.preventDefault();
    if (event.repeat) return true;
    if (key === 's') { void run(async () => { await editRecording.finish(); await recorderUI.recorder.stop(); if (!panel.open) panel.showModal(); }); return true; }
    if (key === 'c') { editRecording.observe({ type: 'controls-opened' }); panel.showModal(); return true; }
    if (key === 'm') { editRecording.observe({ type: 'retake', label: api.state().current }); return true; }
    if (event.repeat || api.state().busy) return true;
    if (key === 'arrowright') void run(() => api.next());
    if (key === 'arrowleft') void run(() => api.previous());
    if (key === 'arrowup') { wideScroll = host.root().scrollTop; host.root().scrollTop = 0; document.body.classList.add('presenter-wide'); }
    if (key === 'h' && !editRecording.active) document.body.classList.toggle('presenter-hud-hidden');
    return true;
  };
  const restoreWide = () => { if (wideScroll !== null && host.root()) host.root().scrollTop = wideScroll; wideScroll = null; document.body.classList.remove('presenter-wide'); };
  window.addEventListener('keyup', e => { if (e.key === 'ArrowUp') restoreWide(); });
  window.addEventListener('blur', restoreWide);
  panel.addEventListener('cancel', e => { e.preventDefault(); panel.close(); });
  // Intercept mouse changes in live content: the storyboard is the sole director.
  document.addEventListener('click', e => { if (api.state().active && e.target.closest?.('#swipeStage button, #swipeStage input, #swipeStage summary, #swipeStage a')) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  return { ...api, handleKey, exit, take: editRecording };
}
