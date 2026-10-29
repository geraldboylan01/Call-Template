import { importSession, drainSessionImportWarnings } from '../js/state.js';

/**
 * Opens a session written by `npm run analyst:open` in the local app: loads the file (only from
 * private/analyses/, over the local static server), normalises it as the app would, puts it in the
 * app's browser storage and goes to the app. It asks first when a session with modules is already there.
 *
 *   ?session=/private/analyses/<requestId>/<runId>/session.json
 */

const STORAGE_KEY = 'call_canvas_session_current';
const status = document.getElementById('status');
const replace = document.getElementById('replace');
const actions = document.getElementById('actions');
const open = document.getElementById('open');

const path = new URLSearchParams(location.search).get('session') || '';

function stop(message) {
  status.textContent = message;
  document.body.dataset.ready = 'error';
}

function existingSession() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return stored && Array.isArray(stored.modules) && stored.modules.length ? stored : null;
  } catch (_error) { return null; }
}

function write(session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  status.textContent = `Opened a story with ${session.modules.length} modules.`;
  document.body.dataset.ready = 'true';
  open.hidden = false;
  location.href = open.getAttribute('href');
}

try {
  if (!/^\/private\/analyses\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/session\.json$/.test(path)) {
    stop('Use ?session=/private/analyses/<requestId>/<runId>/session.json, the file analyst:open wrote.');
  } else {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`The session file could not be read (${response.status}). Is the static server running from the repository folder?`);
    const session = importSession(await response.text());
    const warnings = drainSessionImportWarnings();
    if (!session.planStory) throw new Error(`The story was left out. ${warnings.join(' ')}`);
    const current = existingSession();
    if (current && current.sessionId !== session.sessionId) {
      status.textContent = `The local app already holds a session (“${current.clientName || 'untitled'}”, ${current.modules.length} modules). Opening this story replaces it.`;
      actions.hidden = false;
      document.body.dataset.ready = 'waiting';
      replace.addEventListener('click', () => write(session));
    } else write(session);
  }
} catch (error) {
  stop(error.message);
}
