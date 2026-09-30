import { audioToWav, downloadAudio } from './application_voice.js';

export function createAdvisorVoice(host, { fetchAudio, deleteAudio, onDeleted }) {
  let generation = 0, activeKey = '', url = '';
  function release() {
    host.querySelector('audio')?.pause();
    if (url) URL.revokeObjectURL(url);
    url = '';
  }
  window.addEventListener('pagehide', release);
  return {
    set(note, leadId) {
      const key = note ? `${leadId}/${note.id}` : '';
      if (key && key === activeKey) return;
      activeKey = key; const current = ++generation; release(); host.replaceChildren(); host.hidden = !note;
      if (!note) return;
      const title = document.createElement('h4'); title.textContent = 'Voice note';
      const meta = document.createElement('p');
      const seconds = Math.ceil(note.durationMs / 1000);
      meta.textContent = `${seconds} second${seconds === 1 ? '' : 's'} · Permission to use in video · Agreed ${new Date(note.consentAt).toLocaleString()}`;
      const disclosure = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = 'Recorded publication permission';
      const permission = document.createElement('p'); permission.textContent = `${note.consentText} (${note.consentVersion})`;
      disclosure.append(summary, permission);
      const player = document.createElement('audio'); player.controls = true; player.hidden = true;
      player.setAttribute('aria-label', 'Applicant voice note'); player.style.width = '100%';
      const actions = document.createElement('div'); actions.className = 'voice-download-actions';
      const status = document.createElement('p'); status.setAttribute('role', 'status');
      const button = (label, run) => {
        const node = document.createElement('button'); node.type = 'button'; node.className = 'ui-button'; node.textContent = label;
        node.addEventListener('click', async () => {
          actions.querySelectorAll('button').forEach(item => item.disabled = true); status.textContent = '';
          try { await run(); }
          catch (error) { if (current === generation) status.textContent = error.message || 'Could not read the recording.'; }
          finally { if (current === generation) actions.querySelectorAll('button').forEach(item => item.disabled = false); }
        });
        actions.append(node);
      };
      button('Play voice note', async () => {
        status.textContent = 'Loading audio…'; const blob = await fetchAudio(leadId);
        if (current !== generation) return;
        release(); url = URL.createObjectURL(blob); player.src = url; player.hidden = false;
        status.textContent = ''; await player.play();
      });
      button('Download original', async () => {
        const blob = await fetchAudio(leadId); if (current !== generation) return;
        downloadAudio(blob, `application-${leadId}-voice-note.${note.extension}`);
      });
      button('Download WAV', async () => {
        status.textContent = 'Preparing an editing copy on this device…';
        const blob = await fetchAudio(leadId); if (current !== generation) return;
        try {
          const wav = await audioToWav(blob); if (current !== generation) return;
          downloadAudio(wav, `application-${leadId}-voice-note.wav`); status.textContent = 'WAV ready for your editing timeline.';
        } catch { if (current === generation) status.textContent = 'This browser could not convert the file. Use Download original and convert it locally in your editor.'; }
      });
      button('Delete voice note', async () => {
        if (!window.confirm('Delete this voice note and revoke its upload link? Remove any downloaded copies and published excerpts separately if permission was withdrawn.')) return;
        const result = await deleteAudio(leadId);
        if (current !== generation) return;
        release();
        await onDeleted(result);
      });
      host.append(title, meta, disclosure, player, actions, status);
    }
  };
}
