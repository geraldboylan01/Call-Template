/**
 * CONFIRMING AN APPLICATION AN ASSISTANT SENT.
 *
 * The emailed link carries a token after "#t=". It is read once and removed
 * from the address bar, and it is only ever sent in a request body. Opening
 * the page changes nothing: the application is filed only when the person
 * presses Confirm, so a mail scanner that follows the link cannot confirm it.
 */

import {
  applicationToSections,
  countAnswers,
  topicLabels
} from './case_application/index.js';

const WORKER_BASE_URL = (() => {
  const host = window.location.hostname;
  if (host === '127.0.0.1' || host === 'localhost') {
    return 'http://127.0.0.1:8787';
  }
  const override = typeof window.__WORKER_BASE_URL === 'string' ? window.__WORKER_BASE_URL.trim() : '';
  return override ? override.replace(/\/+$/, '') : '';
})();

const ui = {
  title: document.getElementById('confirmTitle'),
  lede: document.getElementById('confirmLede'),
  review: document.getElementById('confirmReview'),
  preview: document.getElementById('confirmPreview'),
  count: document.getElementById('confirmCount'),
  status: document.getElementById('confirmStatus'),
  send: document.getElementById('confirmSend'),
  cancel: document.getElementById('confirmCancel'),
  done: document.getElementById('confirmDone'),
  doneEyebrow: document.getElementById('confirmDoneEyebrow'),
  doneTitle: document.getElementById('confirmDoneTitle'),
  doneBody: document.getElementById('confirmDoneBody')
};

let token = '';
let busy = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function post(path) {
  const response = await fetch(`${WORKER_BASE_URL}/api/agent/applications/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || 'Something went wrong. Please try again shortly.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function showMessage(title, lede) {
  ui.title.textContent = title;
  ui.lede.textContent = lede;
  ui.review.hidden = true;
}

function renderPreview(application) {
  const blocks = [];
  const topics = topicLabels(application);
  if (topics.length > 0) {
    const line = el('p', 'apply-preview-topics');
    line.append(el('strong', '', 'Help wanted with: '), topics.join(', '));
    blocks.push(line);
  }
  applicationToSections(application).forEach((section) => {
    const block = el('div', 'apply-preview-section');
    block.append(el('h3', '', section.title));
    const list = el('ul', 'apply-preview-lines');
    section.lines.forEach((line) => {
      const item = el('li');
      if (section.id === 'question' && line.label === 'Question') {
        item.className = 'apply-preview-question';
        item.textContent = line.value;
      } else if (Array.isArray(line.items)) {
        item.append(el('span', 'apply-preview-label', line.label));
        const sub = el('ul', 'apply-preview-sub');
        line.items.forEach((entry) => {
          const subItem = el('li');
          subItem.append(el('span', 'apply-preview-label', `${entry.label}: `), entry.value);
          sub.append(subItem);
        });
        item.append(sub);
      } else {
        item.append(el('span', 'apply-preview-label', `${line.label}: `), line.value);
      }
      list.append(item);
    });
    block.append(list);
    blocks.push(block);
  });
  ui.preview.replaceChildren(...blocks);
  const { answered, total } = countAnswers(application);
  ui.count.textContent = `${answered} of ${total} answered`;
}

function finish(eyebrow, title, body) {
  ui.review.hidden = true;
  ui.title.textContent = eyebrow === 'Deleted' ? 'Deleted.' : 'Done.';
  ui.lede.textContent = '';
  ui.doneEyebrow.textContent = eyebrow;
  ui.doneTitle.textContent = title;
  ui.doneBody.textContent = body;
  ui.done.hidden = false;
  ui.done.focus();
}

function setBusy(value, label) {
  busy = value;
  ui.send.disabled = value;
  ui.cancel.disabled = value;
  ui.send.textContent = value && label ? label : 'Confirm and send to Gerry';
}

async function onConfirm() {
  if (busy) return;
  ui.status.textContent = '';
  setBusy(true, 'Sending...');
  try {
    await post('confirm');
    finish(
      'Application sent',
      'Thanks, your application is in.',
      'Gerry reads every application. If yours is picked, he will email you when the video is live.'
    );
  } catch (error) {
    if (error.status === 404) {
      showMessage('This link has expired or has already been used.', 'Nothing more needs doing. You can also apply yourself on the application page.');
    } else {
      ui.status.textContent = error.message;
      ui.status.classList.add('is-error');
    }
  } finally {
    setBusy(false);
  }
}

async function onCancel() {
  if (busy) return;
  if (!window.confirm('Delete this application? Nothing will be sent to Gerry.')) return;
  setBusy(true);
  try {
    await post('cancel');
    finish('Deleted', 'Your application was deleted.', 'Nothing was sent to Gerry.');
  } catch (error) {
    if (error.status === 404) {
      showMessage('This link has expired or has already been used.', 'Nothing more needs doing.');
    } else {
      ui.status.textContent = error.message;
      ui.status.classList.add('is-error');
    }
  } finally {
    setBusy(false);
  }
}

async function start() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  token = params.get('t') || '';
  if (token) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    showMessage('This link is not complete.', 'Open the link from the email again. If it still does not work, email hello@planeir.ie.');
    return;
  }
  if (!WORKER_BASE_URL) {
    showMessage('This page cannot check links on this copy of the site.', '');
    return;
  }

  try {
    const data = await post('preview');
    ui.title.textContent = `Hi ${data.name}, check your application.`;
    ui.lede.textContent = 'An AI assistant sent this to Planeir for you. Nothing has gone to Gerry yet. Check it, then confirm it or delete it.';
    renderPreview(data.application || {});
    ui.review.hidden = false;
  } catch (error) {
    if (error.status === 404) {
      showMessage('This link has expired or has already been used.', 'Links work for 7 days. You can apply yourself on the application page.');
    } else {
      showMessage('This application cannot be shown right now.', error.message);
    }
  }
}

ui.send.addEventListener('click', onConfirm);
ui.cancel.addEventListener('click', onCancel);
start();
