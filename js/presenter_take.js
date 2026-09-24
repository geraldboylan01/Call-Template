// Local editorial metadata only. OBS and the iPhone own their video recordings.
// All offsets use one monotonic clock and refer to the visible SYNC slate.
import { annotateScript } from './presenter_package.js';

export function createPresenterTake({ now = () => performance.now(), date = () => new Date(), id = () => crypto.randomUUID() } = {}) {
  let take = null, origin = null;
  const snapshot = () => take && structuredClone(take);
  const record = event => {
    if (take?.status !== 'recording' || origin === null) return;
    take.events.push({ ...structuredClone(event), elapsedMs: Math.round(now() - origin) });
  };
  return {
    snapshot,
    begin(bundle, viewport) {
      if (take && !take.exported) throw new Error('Download the previous edit package before starting another take.');
      origin = null;
      take = { version: 1, id: `take-${date().toISOString().replace(/[:.]/g, '-')}-${id().slice(0, 8)}`, createdAt: date().toISOString(), status: 'countdown', exported: false, viewport, bundle: structuredClone(bundle), events: [],
        timeReference: 'Milliseconds from the first visible SYNC slate, not from OBS file start. Locate that frame in the screen recording and add its offset. These are browser event times, not frame-accurate media timecodes.',
        capture: { screen: 'External recorder (OBS)', camera: 'iPhone local recording', audio: 'External Mac microphone in OBS; iPhone audio for sync', verifiedByApp: false } };
      return snapshot();
    },
    sync() { if (take?.status !== 'countdown') throw new Error('No take is waiting for sync.'); origin = now(); take.status = 'recording'; record({ type: 'sync', label: 'First visible SYNC slate' }); },
    record,
    end(reason = 'finished') { if (!take || !['countdown', 'recording'].includes(take.status)) return; record({ type: 'end', reason }); take.status = origin === null ? 'cancelled' : reason === 'finished' ? 'completed' : 'interrupted'; take.endedAt = date().toISOString(); return snapshot(); },
    restore(saved) { if (saved?.version !== 1 || !saved.bundle?.compiled || !Array.isArray(saved.events)) throw new Error('Unrecognised saved take.'); take = structuredClone(saved); origin = null; if (['recording', 'countdown'].includes(take.status)) { take.status = 'interrupted'; take.interruption = 'Page reloaded: recovered events only. OBS/iPhone recording state is unknown.'; } return snapshot(); },
    exported() { if (take) take.exported = true; },
    get active() { return ['countdown', 'recording'].includes(take?.status); }
  };
}

export function elapsedTime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(Math.round(ms) % 1000).padStart(3, '0')}`;
}
const csv = value => `"${String(value ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');

export function buildTakeFiles(take) {
  if (!take || ['countdown', 'recording'].includes(take.status)) throw new Error('Finish the take before exporting.');
  const { compiled, script, presentation, validation } = take.bundle;
  const rows = take.events.map(e => [elapsedTime(e.elapsedMs), e.elapsedMs, e.type, e.navigationId || '', e.direction || '', e.stepId || '', e.label || '', e.error || e.reason || '']);
  const arrivals = take.events.filter(e => e.type === 'arrived' && e.stepId);
  const guide = [
    `# Edit guide — ${compiled.title}`, '', `Take: ${take.id} · ${take.status}`, '',
    '**Recordings are separate files. This package contains timings and direction, not video.**', '',
    take.timeReference, '',
    '1. Import the iPhone original and OBS MP4 into DaVinci Resolve. Create a multicam clip using Sound to synchronise them; verify the clap and speech at the start and end.',
    '2. Use the OBS external-microphone track continuously. Switch video only; mute the iPhone reference audio.',
    '3. Locate the FIRST frame of the SYNC slate in the screen source. Its source-file position + the elapsed times below locates each event in that file. After trimming, use the new timeline offset. CSV is a readable cue log, not an automatic Resolve import.',
    '4. Start on the presenter. Show Planéir when the evidence helps. Hold a useful view; a cue is not a mandatory camera cut. Return to the presenter for interpretation and reassurance.',
    '5. Arrived means the visual has settled. Requested marks the start of its transition. Choose either by watching the footage. Repeated visits, failed moves, controls, visibility changes and retakes require review.',
    '6. Remove the countdown, sync slates, setup panels and mistakes. Check the entire edit and export H.264/AAC MP4 at the project frame rate.', '',
    '## Actual visual arrivals', '', '| Elapsed from SYNC | Beat | Direction | Suggested picture | Why |', '| --- | --- | --- | --- | --- |',
    ...arrivals.map(e => { const step = compiled.steps.find(s => s.id === e.stepId); return `| ${elapsedTime(e.elapsedMs)} | ${cell(e.label)} | ${cell(e.direction)} | ${cell(step?.edit?.shot || 'screen candidate')} | ${cell(step?.edit?.reason || step?.rationale || 'Review this visual against the spoken explanation.')} |`; }), '',
    'These are editorial suggestions, not automatic cuts. Script anchors are planned words, not a transcript or word-level audio alignment.', '',
    '## Events to review', '',
    ...take.events.filter(e => ['failed', 'retake', 'controls-opened', 'viewport-changed', 'page-hidden', 'page-visible', 'end'].includes(e.type)).map(e => `- ${elapsedTime(e.elapsedMs)} — ${cell(e.type)}: ${cell(e.error || e.reason || e.label || '')}`),
    ...(take.interruption ? ['', `Recovery note: ${take.interruption}`] : []), '',
    'Keep the original iPhone video, OBS MKV/MP4 and this package together. Confirm both recorders have stopped separately.'
  ].join('\n');
  let timed = script;
  for (const cue of [...compiled.cues].reverse()) {
    const visits = arrivals.filter(e => e.stepId === cue.stepId).map(e => `${elapsedTime(e.elapsedMs)} ${e.direction}`);
    timed = `${timed.slice(0, cue.offset)}[→ ${cue.label} — ${visits.length ? visits.join('; ') : 'not reached in this take'}]\n\n${timed.slice(cue.offset)}`;
  }
  return {
    'take.json': JSON.stringify(take, null, 2),
    'cues.csv': [['elapsed_from_sync', 'elapsed_ms', 'event', 'navigation_id', 'direction', 'step_id', 'label', 'note'], ...rows].map(row => row.map(csv).join(',')).join('\r\n'),
    'edit-guide.md': guide,
    'script-timed.md': `# Recorded cue timings\n\n${take.timeReference}\n\nThese are visual arrivals, not word timings. All repeated visits are retained.\n\n${timed}`,
    'script.md': script,
    'script-presenter.md': annotateScript(script, compiled),
    'presentation.json': JSON.stringify(presentation, null, 2),
    'validation.json': JSON.stringify(validation, null, 2)
  };
}

// Small, uncompressed ZIP: one download, no dependency, network or client upload.
export function zipTakeFiles(files) {
  const encoder = new TextEncoder(), locals = [], central = [];
  let offset = 0, centralSize = 0;
  const crc32 = bytes => { let crc = -1; for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; };
  for (const [name, value] of Object.entries(files)) {
    const filename = encoder.encode(name), bytes = encoder.encode(value), crc = crc32(bytes);
    const local = new Uint8Array(30 + filename.length), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint16(12, 33, true);
    l.setUint32(14, crc, true); l.setUint32(18, bytes.length, true); l.setUint32(22, bytes.length, true); l.setUint16(26, filename.length, true); local.set(filename, 30);
    const entry = new Uint8Array(46 + filename.length), c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(14, 33, true);
    c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, filename.length, true); c.setUint32(42, offset, true); entry.set(filename, 46);
    locals.push(local, bytes); central.push(entry); offset += local.length + bytes.length; centralSize += entry.length;
  }
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, central.length, true); e.setUint16(10, central.length, true); e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
  return new Blob([...locals, ...central, end], { type: 'application/zip' });
}
