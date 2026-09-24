/**
 * CONFIRMING AN APPLICATION AN ASSISTANT SENT.
 *
 * The person went through their answers with their assistant before it sent
 * them, so the email Planeir sends is one button, and this page is its result:
 * it confirms as it opens and says so. Pressing the button again later shows
 * the same thank-you, not an error.
 *
 * The token arrives after "#t=". It is read once, removed from the address
 * bar, and only ever sent in a request body.
 */

const WORKER_BASE_URL = (() => {
  const host = window.location.hostname;
  if (host === '127.0.0.1' || host === 'localhost') {
    return 'http://127.0.0.1:8787';
  }
  const override = typeof window.__WORKER_BASE_URL === 'string' ? window.__WORKER_BASE_URL.trim() : '';
  return override ? override.replace(/\/+$/, '') : '';
})();

const ui = {
  result: document.getElementById('confirmResult'),
  eyebrow: document.getElementById('confirmEyebrow'),
  title: document.getElementById('confirmTitle'),
  body: document.getElementById('confirmBody'),
  note: document.getElementById('confirmNote'),
  action: document.getElementById('confirmAction')
};

function show({ eyebrow, title, body, note = '', action = null }) {
  ui.eyebrow.textContent = eyebrow;
  ui.title.textContent = title;
  ui.body.textContent = body;
  ui.note.textContent = note;
  ui.note.hidden = !note;
  if (action) {
    ui.action.textContent = action.label;
    ui.action.href = action.href;
    ui.action.hidden = false;
  } else {
    ui.action.hidden = true;
  }
  ui.result.focus({ preventScroll: true });
}

function showConfirmed(name) {
  show({
    eyebrow: 'Confirmed',
    title: name ? `Thank you, ${name}.` : 'Thank you.',
    body: 'Your application is confirmed and with Gerry. He reads every application. If yours is picked, he will email you when the video is live.',
    note: 'If you change your mind, email hello@planeir.ie and we will delete it.',
    action: { label: 'Watch the cases', href: '../../cases/' }
  });
}

function showExpired() {
  show({
    eyebrow: 'Link expired',
    title: 'This link has expired.',
    body: 'Confirmation links work for 7 days. You can still apply yourself on the application page.',
    action: { label: 'Go to the application page', href: '../' }
  });
}

async function confirm(token) {
  const response = await fetch(`${WORKER_BASE_URL}/api/agent/applications/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function start() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = params.get('t') || '';
  if (token) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    show({
      eyebrow: 'Link not complete',
      title: 'This link is not complete.',
      body: 'Press the button in the email from Planeir again. If it still does not work, email hello@planeir.ie.'
    });
    return;
  }
  if (!WORKER_BASE_URL) {
    show({ eyebrow: 'Not available', title: 'This copy of the site cannot confirm applications.', body: '' });
    return;
  }

  try {
    const { status, data } = await confirm(token);
    if (status === 200) {
      showConfirmed(data?.name || '');
    } else if (status === 404) {
      showExpired();
    } else {
      show({
        eyebrow: 'Not confirmed yet',
        title: 'We could not confirm it just now.',
        body: data?.error || 'Please press the button in the email again in a few minutes.'
      });
    }
  } catch (_error) {
    show({
      eyebrow: 'Not confirmed yet',
      title: 'We could not confirm it just now.',
      body: 'Check your connection, then press the button in the email again.'
    });
  }
}

start();
