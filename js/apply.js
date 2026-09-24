/**
 * THE APPLICATION PAGE.
 *
 * One page, one submit. The form is rendered from js/case_application/schema.js
 * so the questions, the live write-up and the Worker's validation all read the
 * same description. Nothing is required except the question, a name, an email
 * and the two consents; every figure can be skipped or marked "Not sure".
 *
 * Answers are saved in this browser as the person types, so they can go and
 * find a statement and come back. Nothing is sent until they press Send.
 */

import {
  SECTIONS,
  TOPICS,
  TOPIC_GATED_SECTION_IDS,
  applicationToSections,
  countAnswers,
  countSectionAnswers,
  createContext,
  deletePath,
  formatMoney,
  formatPercent,
  getPath,
  getSection,
  isFieldVisible,
  isNumericField,
  isSectionNone,
  isSectionOffered,
  isSectionVisible,
  normalizeApplication,
  parseMoney,
  parsePercent,
  parseWhole,
  parseYears,
  pruneToVisible,
  setPath,
  topicLabels
} from './case_application/index.js';
import { createSuccessTakeover } from './success_takeover.js';

const WORKER_BASE_URL = (() => {
  const host = window.location.hostname;
  if (host === '127.0.0.1' || host === 'localhost') {
    return 'http://127.0.0.1:8787';
  }
  const override = typeof window.__WORKER_BASE_URL === 'string' ? window.__WORKER_BASE_URL.trim() : '';
  return override ? override.replace(/\/+$/, '') : '';
})();

const STORAGE_KEY = 'planeir.apply.draft.v1';
const SAVE_DELAY_MS = 400;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * What to have to hand, by what the person has told us so far. The wording
 * follows the voice briefing's "What to have ready" list (plan/index.html).
 */
const TO_HAND = [
  { title: 'A recent payslip', detail: 'Gross pay and take-home pay', when: () => true },
  { title: 'A recent bank statement', detail: 'What goes out each month', when: () => true },
  { title: 'Savings balances', detail: 'Bank, credit union and investment accounts', when: () => true },
  {
    title: 'Your latest pension statements',
    detail: 'Value today and what goes in each month',
    when: (draft, ctx) => isSectionOffered(getSection('pensions'), ctx)
  },
  {
    title: 'A pension benefit statement',
    detail: 'For a public service or defined benefit pension',
    when: (draft) => Array.isArray(draft.pensions) && draft.pensions.some((item) => item?.type === 'public')
  },
  {
    title: 'Your mortgage statement or banking app',
    detail: 'Balance, rate, years left and repayment',
    when: (draft, ctx) => ctx.topics.has('mortgage') || draft.home?.status === 'mortgage'
  },
  {
    title: 'Approval in principle, if you have one',
    detail: 'The amount a lender has said it will lend',
    when: (draft, ctx) => ctx.topics.has('buying')
  },
  {
    title: 'Loan statements or your banking app',
    detail: 'Balance, rate and payment for each loan',
    when: (draft, ctx) => isSectionOffered(getSection('loans'), ctx)
  }
];

const ui = {
  form: document.getElementById('applyForm'),
  layout: document.querySelector('.apply-layout'),
  topics: document.getElementById('applyTopics'),
  toHand: document.getElementById('applyToHand'),
  sections: document.getElementById('applySections'),
  extra: document.getElementById('applyExtra'),
  addMore: document.getElementById('applyAddMore'),
  addMoreButtons: document.getElementById('applyAddMoreButtons'),
  preview: document.getElementById('applyPreview'),
  previewCount: document.getElementById('applyPreviewCount'),
  progress: document.getElementById('applyProgress'),
  name: document.getElementById('applyName'),
  email: document.getElementById('applyEmail'),
  website: document.getElementById('applyWebsite'),
  consentVideo: document.getElementById('applyConsentVideo'),
  consentEducation: document.getElementById('applyConsentEducation'),
  status: document.getElementById('applyStatus'),
  submit: document.getElementById('applySubmit'),
  clear: document.getElementById('applyClear'),
  savedNote: document.getElementById('applySavedNote'),
  done: document.getElementById('applyDone')
};

const state = {
  draft: emptyDraft(),
  submitting: false,
  saveTimer: 0
};

function emptyDraft() {
  return { topics: [], added: [], unsure: [], none: [] };
}

/* ---------- small DOM helpers ---------- */

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attributes).forEach(([key, value]) => {
    if (value === false || value === null || value === undefined) return;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  });
  (Array.isArray(children) ? children : [children]).forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

function fieldId(path) {
  return `f-${String(path).replace(/[^A-Za-z0-9]+/g, '-')}`;
}

/* ---------- draft state ---------- */

function unsureSet() {
  return new Set(Array.isArray(state.draft.unsure) ? state.draft.unsure : []);
}

function isUnsure(path) {
  return unsureSet().has(path);
}

function setUnsure(path, unsure) {
  const next = unsureSet();
  if (unsure) {
    next.add(path);
    deletePath(state.draft, path);
  } else {
    next.delete(path);
  }
  state.draft.unsure = [...next];
}

function setDraftValue(path, value) {
  if (value === '' || value === null || value === undefined) {
    deletePath(state.draft, path);
  } else {
    setPath(state.draft, path, value);
  }
}

function prepared() {
  return normalizeApplication(state.draft);
}

function context() {
  return createContext(state.draft);
}

/** Give each visible repeater one empty card, so the questions are there to read. */
function ensureRepeaterItems(ctx) {
  SECTIONS.forEach((section) => {
    if (!section.repeater || !isSectionVisible(section, state.draft, ctx) || isSectionNone(section, state.draft)) return;
    const items = getPath(state.draft, section.repeater.path);
    if (!Array.isArray(items) || items.length === 0) {
      setPath(state.draft, section.repeater.path, [{}]);
    }
  });
}

function removeRepeaterItem(section, index) {
  const items = getPath(state.draft, section.repeater.path);
  if (!Array.isArray(items)) return;
  items.splice(index, 1);
  const prefix = `${section.repeater.path}.`;
  state.draft.unsure = (state.draft.unsure || []).flatMap((path) => {
    if (!path.startsWith(prefix)) return [path];
    const [, rawIndex, ...rest] = path.split('.');
    const itemIndex = Number(rawIndex);
    if (itemIndex === index) return [];
    return [[section.repeater.path, itemIndex > index ? itemIndex - 1 : itemIndex, ...rest].join('.')];
  });
}

/* ---------- saving on this device ---------- */

function scheduleSave() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(saveDraft, SAVE_DELAY_MS);
}

function saveDraft() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: 1,
      draft: state.draft,
      contact: { fullName: ui.name?.value || '', email: ui.email?.value || '' },
      savedAt: new Date().toISOString()
    }));
  } catch (_error) {
    // Private windows and full storage both land here. The form still works;
    // it just cannot be resumed later.
  }
}

function loadDraft() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || saved.v !== 1 || !saved.draft || typeof saved.draft !== 'object' || Array.isArray(saved.draft)) return null;
    return saved;
  } catch (_error) {
    return null;
  }
}

function clearSavedDraft() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (_error) {
    // Nothing to clear.
  }
}

/* ---------- reading figures back ---------- */

function readback(field, raw, unit) {
  const text = String(raw ?? '').trim();
  if (!text) return { message: '', error: false };
  switch (field.type) {
    case 'money': {
      const value = parseMoney(text);
      if (Number.isNaN(value)) return { message: 'Enter a figure, like 35000 or 35k.', error: true };
      return { message: /^\d+$/.test(text) ? '' : `Reads as ${formatMoney(value)}`, error: false };
    }
    case 'percent': {
      const value = parsePercent(text);
      if (Number.isNaN(value)) return { message: 'Enter a rate, like 4.2.', error: true };
      if (value > (field.max ?? 100)) return { message: `Enter a rate up to ${field.max ?? 100}%.`, error: true };
      return { message: /^\d+(\.\d+)?$/.test(text) ? '' : `Reads as ${formatPercent(value)}`, error: false };
    }
    case 'age': {
      const value = parseWhole(text);
      if (Number.isNaN(value)) return { message: 'Enter a whole number.', error: true };
      const min = field.min ?? 0;
      const max = field.max ?? 110;
      if (value < min || value > max) return { message: `Enter an age between ${min} and ${max}.`, error: true };
      return { message: '', error: false };
    }
    case 'years': {
      const value = parseYears(text);
      if (Number.isNaN(value)) return { message: 'Enter a number of years, like 22.', error: true };
      return { message: '', error: false };
    }
    case 'contribution': {
      if (unit === 'eur') {
        const value = parseMoney(text);
        if (Number.isNaN(value)) return { message: 'Enter a figure, like 265.', error: true };
        return { message: `Reads as ${formatMoney(value)} a month`, error: false };
      }
      const value = parsePercent(text);
      if (Number.isNaN(value) || value > 100) return { message: 'Enter a percentage, like 5.', error: true };
      return { message: `Reads as ${formatPercent(value)} of salary`, error: false };
    }
    default:
      return { message: '', error: false };
  }
}

function updateReadback(field, path, unit) {
  const node = document.getElementById(`${fieldId(path)}-readback`);
  if (!node) return;
  const { message, error } = readback(field, getPath(state.draft, path), unit);
  node.textContent = message;
  node.classList.toggle('is-error', error);
}

/* ---------- building fields ---------- */

function labelBlock(field, id, { required = false } = {}) {
  return [
    el('label', { class: 'apply-label', for: id }, [
      field.label,
      required ? el('em', { text: ' (required)' }) : null
    ]),
    field.hint ? el('p', { class: 'apply-hint', id: `${id}-hint`, text: field.hint }) : null
  ];
}

function unsureButton(path) {
  const pressed = isUnsure(path);
  return el('button', {
    type: 'button',
    class: `apply-unsure${pressed ? ' is-pressed' : ''}`,
    id: `${fieldId(path)}-unsure`,
    'aria-pressed': pressed ? 'true' : 'false',
    onclick: () => {
      setUnsure(path, !isUnsure(path));
      render();
    }
  }, 'Not sure');
}

const INPUT_MODES = { money: 'decimal', percent: 'decimal', years: 'decimal', age: 'numeric', contribution: 'decimal' };

function suffixFor(field) {
  if (field.type === 'percent') return '%';
  if (field.type === 'years') return 'years';
  if (field.type === 'money' && field.unit === 'month' && !/a month/.test(field.label)) return 'a month';
  if (field.type === 'money' && field.unit === 'year' && !/a year/.test(field.label)) return 'a year';
  return '';
}

function numberField(field, path) {
  const id = fieldId(path);
  const unsure = isUnsure(path);
  const raw = getPath(state.draft, path);
  const unitPath = field.unitKey ? path.replace(/[^.]+$/, field.unitKey) : '';
  const unit = field.unitKey ? (getPath(state.draft, unitPath) || field.units[0].value) : undefined;
  const prefix = field.type === 'money' || (field.type === 'contribution' && unit === 'eur') ? '€' : '';
  const suffix = field.type === 'contribution' ? (unit === 'eur' ? 'a month' : '% of salary') : suffixFor(field);

  const input = el('input', {
    id,
    type: 'text',
    inputmode: INPUT_MODES[field.type] || 'text',
    autocomplete: 'off',
    value: unsure ? '' : (raw ?? ''),
    disabled: unsure,
    placeholder: unsure ? 'Not sure' : '',
    'aria-describedby': [field.hint ? `${id}-hint` : '', `${id}-readback`].filter(Boolean).join(' ')
  });
  input.addEventListener('input', () => {
    setDraftValue(path, input.value.trim() === '' ? '' : input.value);
    updateReadback(field, path, unit);
    refresh();
  });

  const row = el('div', { class: `apply-input${unsure ? ' is-unsure' : ''}` }, [
    prefix ? el('span', { class: 'apply-input-prefix', 'aria-hidden': 'true', text: prefix }) : null,
    input,
    suffix ? el('span', { class: 'apply-input-suffix', 'aria-hidden': 'true', text: suffix }) : null
  ]);

  const unitToggle = field.unitKey
    ? el('div', { class: 'apply-unit-toggle', role: 'group', 'aria-label': `${field.label} is in` }, field.units.map((option) => {
      const active = unit === option.value;
      return el('button', {
        type: 'button',
        class: `apply-unit${active ? ' is-pressed' : ''}`,
        id: `${id}-unit-${option.value}`,
        'aria-pressed': active ? 'true' : 'false',
        onclick: () => {
          setPath(state.draft, unitPath, option.value);
          render();
        }
      }, option.label);
    }))
    : null;

  const readbackNode = el('p', { class: 'apply-readback', id: `${id}-readback`, 'aria-live': 'polite' });
  const node = el('div', { class: 'apply-field', 'data-path': path }, [
    ...labelBlock(field, id),
    el('div', { class: 'apply-input-line' }, [row, unsureButton(path)]),
    unitToggle,
    readbackNode
  ]);
  const { message, error } = readback(field, raw, unit);
  readbackNode.textContent = unsure ? '' : message;
  readbackNode.classList.toggle('is-error', error && !unsure);
  return node;
}

function choiceField(field, path) {
  const id = fieldId(path);
  const current = getPath(state.draft, path);
  const legendId = `${id}-label`;
  return el('div', { class: 'apply-field apply-choice', 'data-path': path, role: 'group', 'aria-labelledby': legendId }, [
    el('p', { class: 'apply-label', id: legendId, text: field.label }),
    field.hint ? el('p', { class: 'apply-hint', text: field.hint }) : null,
    el('div', { class: 'apply-chip-row' }, field.options.map((option) => {
      const active = current === option.value;
      return el('button', {
        type: 'button',
        class: `apply-chip${active ? ' is-pressed' : ''}`,
        id: `${id}-${option.value}`,
        'aria-pressed': active ? 'true' : 'false',
        onclick: () => {
          setDraftValue(path, active ? '' : option.value);
          render();
        }
      }, option.label);
    }))
  ]);
}

function monthField(field, path) {
  const id = fieldId(path);
  const current = String(getPath(state.draft, path) || '');
  const [currentYear, currentMonth] = current.split('-');
  const thisYear = new Date().getFullYear();
  const monthSelect = el('select', { id, 'aria-label': `${field.label}: month` }, [
    el('option', { value: '', text: 'Month' }),
    ...MONTH_NAMES.map((name, index) => {
      const value = String(index + 1).padStart(2, '0');
      return el('option', { value, selected: value === currentMonth, text: name });
    })
  ]);
  const yearSelect = el('select', { id: `${id}-year`, 'aria-label': `${field.label}: year` }, [
    el('option', { value: '', text: 'Year' }),
    ...Array.from({ length: 16 }, (_, offset) => String(thisYear - 1 + offset)).map((year) => (
      el('option', { value: year, selected: year === currentYear, text: year })
    ))
  ]);
  const update = () => {
    const month = monthSelect.value;
    const year = yearSelect.value;
    setDraftValue(path, month && year ? `${year}-${month}` : '');
    refresh();
  };
  monthSelect.addEventListener('change', update);
  yearSelect.addEventListener('change', update);
  return el('div', { class: 'apply-field', 'data-path': path }, [
    ...labelBlock(field, id),
    el('div', { class: 'apply-month' }, [monthSelect, yearSelect])
  ]);
}

function textField(field, path, { required = false } = {}) {
  const id = fieldId(path);
  const value = getPath(state.draft, path) ?? '';
  const attributes = {
    id,
    maxlength: field.maxLength || 120,
    'aria-describedby': field.hint ? `${id}-hint` : undefined,
    'aria-required': required ? 'true' : undefined
  };
  const control = field.type === 'longtext'
    ? el('textarea', { ...attributes, rows: field.rows || 3 })
    : el('input', { ...attributes, type: 'text', autocomplete: 'off' });
  control.value = value;
  control.addEventListener('input', () => {
    setDraftValue(path, control.value.trim() === '' ? '' : control.value);
    refresh();
  });
  return el('div', { class: 'apply-field apply-field-wide', 'data-path': path }, [
    ...labelBlock(field, id, { required }),
    control
  ]);
}

function buildField(field, path) {
  if (field.type === 'choice') return choiceField(field, path);
  if (field.type === 'month') return monthField(field, path);
  if (field.type === 'text' || field.type === 'longtext') return textField(field, path, { required: path === 'question' });
  if (isNumericField(field)) return numberField(field, path);
  return null;
}

/** Fields that share a `pair` sit side by side: yours, then your partner's. */
function buildFieldList(entries) {
  const nodes = [];
  for (let index = 0; index < entries.length; index += 1) {
    const { field, path } = entries[index];
    const next = entries[index + 1];
    if (field.pair && next && next.field.pair === field.pair) {
      nodes.push(el('div', { class: 'apply-pair' }, [buildField(field, path), buildField(next.field, next.path)]));
      index += 1;
    } else {
      nodes.push(buildField(field, path));
    }
  }
  return nodes;
}

function buildRepeater(section, ctx) {
  const { repeater } = section;
  const items = Array.isArray(getPath(state.draft, repeater.path)) ? getPath(state.draft, repeater.path) : [];
  const cards = items.slice(0, repeater.max).map((item, index) => {
    const entries = repeater.fields
      .filter((field) => isFieldVisible(field, state.draft, ctx, item))
      .map((field) => ({ field, path: `${repeater.path}.${index}.${field.key}` }));
    return el('div', { class: 'apply-item' }, [
      el('div', { class: 'apply-item-head' }, [
        el('h3', { class: 'apply-item-title', text: `${repeater.itemTitle} ${index + 1}` }),
        el('button', {
          type: 'button',
          class: 'apply-link-button',
          id: `${fieldId(repeater.path)}-${index}-remove`,
          'aria-label': `Remove ${repeater.itemTitle.toLowerCase()} ${index + 1}`,
          onclick: () => {
            removeRepeaterItem(section, index);
            render();
          }
        }, 'Remove')
      ]),
      ...buildFieldList(entries)
    ]);
  });
  const canAdd = items.length < repeater.max;
  return [
    ...cards,
    canAdd
      ? el('button', {
        type: 'button',
        class: 'apply-add',
        id: `${fieldId(repeater.path)}-add`,
        onclick: () => {
          const list = Array.isArray(getPath(state.draft, repeater.path)) ? getPath(state.draft, repeater.path) : [];
          list.push({});
          setPath(state.draft, repeater.path, list);
          render();
        }
      }, `+ ${repeater.addLabel}`)
      : null
  ];
}

function buildSection(section, ctx) {
  const titleId = `section-${section.id}-title`;
  const none = isSectionNone(section, state.draft);
  const scalarEntries = (section.fields || [])
    .filter((field) => isFieldVisible(field, state.draft, ctx))
    .map((field) => ({ field, path: field.path }));

  const noneToggle = section.none
    ? el('label', { class: 'apply-none' }, [
      el('input', {
        type: 'checkbox',
        id: `section-${section.id}-none`,
        checked: none,
        onchange: (event) => {
          const set = new Set(state.draft.none || []);
          if (event.target.checked) set.add(section.id);
          else set.delete(section.id);
          state.draft.none = [...set];
          render();
        }
      }),
      el('span', { text: section.none.label })
    ])
    : null;

  return el('section', { class: 'apply-card apply-section', id: `section-${section.id}`, 'aria-labelledby': titleId }, [
    el('div', { class: 'apply-section-head' }, [
      el('h2', { class: 'apply-card-title', id: titleId, text: section.title }),
      el('span', { class: 'apply-section-count', id: `section-${section.id}-count` })
    ]),
    section.intro ? el('p', { class: 'apply-card-intro', text: section.intro }) : null,
    noneToggle,
    ...(section.repeater && !none ? buildRepeater(section, ctx) : []),
    ...buildFieldList(scalarEntries)
  ]);
}

/* ---------- rendering ---------- */

function renderTopics() {
  ui.topics.replaceChildren(...TOPICS.map((topic) => {
    const active = state.draft.topics.includes(topic.id);
    return el('button', {
      type: 'button',
      class: `apply-chip apply-topic${active ? ' is-pressed' : ''}`,
      id: `topic-${topic.id}`,
      'aria-pressed': active ? 'true' : 'false',
      onclick: () => {
        const set = new Set(state.draft.topics);
        if (set.has(topic.id)) set.delete(topic.id);
        else set.add(topic.id);
        state.draft.topics = TOPICS.map((entry) => entry.id).filter((id) => set.has(id));
        render();
      }
    }, topic.label);
  }));
}

function renderToHand(ctx) {
  ui.toHand.replaceChildren(...TO_HAND
    .filter((item) => item.when(state.draft, ctx))
    .map((item) => el('li', {}, [el('strong', { text: item.title }), el('span', { text: item.detail })])));
}

function renderAddMore(ctx) {
  const offered = TOPIC_GATED_SECTION_IDS
    .map((id) => getSection(id))
    .filter((section) => section && !isSectionOffered(section, ctx));
  ui.addMore.hidden = offered.length === 0;
  ui.addMoreButtons.replaceChildren(...offered.map((section) => el('button', {
    type: 'button',
    class: 'apply-chip',
    id: `add-${section.id}`,
    onclick: () => {
      state.draft.added = [...new Set([...(state.draft.added || []), section.id])];
      render();
      document.getElementById(`section-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, section.title)));
}

function renderCounts() {
  const app = prepared();
  const ctx = createContext(app);
  SECTIONS.forEach((section) => {
    const node = document.getElementById(`section-${section.id}-count`);
    if (!node) return;
    const { answered, total } = countSectionAnswers(section, app, ctx);
    node.textContent = total > 0 ? `${answered} of ${total} filled` : '';
    node.classList.toggle('is-complete', total > 0 && answered === total);
  });
  const { answered, total } = countAnswers(app, ctx);
  ui.previewCount.textContent = `${answered} of ${total} answered`;
}

function renderProgress() {
  const app = prepared();
  const ctx = createContext(app);
  ui.progress.replaceChildren(...SECTIONS
    .filter((section) => isSectionVisible(section, app, ctx))
    .map((section) => {
      const { answered, total } = countSectionAnswers(section, app, ctx);
      return el('li', { class: total > 0 && answered === total ? 'is-complete' : '' }, [
        el('a', { href: `#section-${section.id}` }, [
          el('span', { text: section.title }),
          el('span', { class: 'apply-progress-count', text: total > 0 ? `${answered}/${total}` : '' })
        ])
      ]);
    }));
}

function renderPreview() {
  const app = pruneToVisible(prepared());
  const topics = topicLabels(app);
  const blocks = [];
  if (topics.length > 0) {
    blocks.push(el('p', { class: 'apply-preview-topics' }, [el('strong', { text: 'Help wanted with: ' }), topics.join(', ')]));
  }
  applicationToSections(app).forEach((section) => {
    const list = el('ul', { class: 'apply-preview-lines' }, section.lines.map((line) => {
      if (Array.isArray(line.items)) {
        return el('li', {}, [
          el('span', { class: 'apply-preview-label', text: line.label }),
          el('ul', { class: 'apply-preview-sub' }, line.items.map((item) => el('li', {}, [
            el('span', { class: 'apply-preview-label', text: `${item.label}: ` }),
            item.value
          ])))
        ]);
      }
      if (section.id === 'question' && line.label === 'Question') {
        return el('li', { class: 'apply-preview-question', text: line.value });
      }
      return el('li', {}, [el('span', { class: 'apply-preview-label', text: `${line.label}: ` }), line.value]);
    }));
    blocks.push(el('div', { class: 'apply-preview-section' }, [el('h3', { text: section.title }), list]));
  });
  if (blocks.length === 0) {
    blocks.push(el('p', { class: 'apply-preview-empty', text: 'Your answers will appear here as you fill in the form.' }));
  }
  ui.preview.replaceChildren(...blocks);
}

/** A light update after typing: counts, preview and save. Keeps focus where it is. */
function refresh() {
  renderCounts();
  renderProgress();
  renderPreview();
  scheduleSave();
}

/** A full render after anything that can show or hide questions. */
function render() {
  const focusedId = document.activeElement?.id || '';
  const ctx = context();
  ensureRepeaterItems(ctx);
  renderTopics();
  renderToHand(ctx);

  const main = [];
  const extra = [];
  SECTIONS.forEach((section) => {
    if (!isSectionVisible(section, state.draft, ctx)) return;
    (section.id === 'extra' ? extra : main).push(buildSection(section, ctx));
  });
  ui.sections.replaceChildren(...main);
  ui.extra.replaceChildren(...extra);
  renderAddMore(ctx);
  refresh();

  if (focusedId) {
    const target = document.getElementById(focusedId);
    if (target && target !== document.activeElement) target.focus({ preventScroll: true });
  }
}

/* ---------- sending ---------- */

function setStatus(kind, message) {
  ui.status.textContent = String(message || '');
  ui.status.classList.toggle('is-error', kind === 'error');
  ui.status.classList.toggle('is-success', kind === 'success');
}

function markInvalid(node, invalid) {
  if (!node) return;
  node.setAttribute('aria-invalid', invalid ? 'true' : 'false');
  node.closest('.consent-check')?.classList.toggle('is-invalid', invalid);
}

function validate() {
  const errors = [];
  const question = String(getPath(state.draft, 'question') || '').trim();
  const questionInput = document.getElementById(fieldId('question'));
  markInvalid(questionInput, !question);
  if (!question) errors.push({ node: questionInput, message: 'Add your question so Gerry knows what you want to understand.' });

  const name = ui.name.value.trim();
  markInvalid(ui.name, !name);
  if (!name) errors.push({ node: ui.name, message: 'Add your name. A first name is fine.' });

  const email = ui.email.value.trim();
  const emailOk = EMAIL_PATTERN.test(email);
  markInvalid(ui.email, !emailOk);
  if (!emailOk) errors.push({ node: ui.email, message: 'Enter a valid email address so Gerry can reply.' });

  [ui.consentVideo, ui.consentEducation].forEach((box) => {
    markInvalid(box, !box.checked);
    if (!box.checked) errors.push({ node: box, message: 'Tick both boxes to send your application.' });
  });
  return errors;
}

function friendlyError(error) {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  if (!message || error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(message)) {
    return 'Your application could not be sent right now. Your answers are still saved on this device. Please try again in a moment.';
  }
  return message;
}

async function onSubmit(event) {
  event.preventDefault();
  if (state.submitting) return;
  setStatus('', '');

  const errors = validate();
  if (errors.length > 0) {
    setStatus('error', errors[0].message);
    errors[0].node?.focus();
    return;
  }

  if (!WORKER_BASE_URL) {
    setStatus('error', 'Applications are not available on this copy of the site.');
    return;
  }

  const payload = {
    fullName: ui.name.value.trim(),
    email: ui.email.value.trim(),
    consentVideo: ui.consentVideo.checked,
    consentEducation: ui.consentEducation.checked,
    website: ui.website.value,
    application: pruneToVisible(prepared())
  };

  state.submitting = true;
  ui.submit.disabled = true;
  ui.submit.textContent = 'Sending...';
  ui.form.setAttribute('aria-busy', 'true');

  try {
    const response = await fetch(`${WORKER_BASE_URL}/api/applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error || 'Your application could not be sent right now. Please try again shortly.');
    }

    clearSavedDraft();
    window.clearTimeout(state.saveTimer);
    await successTakeover.play({
      titleText: 'Thanks, your application is in.',
      bodyText: 'Gerry reads every application.',
      restoreFocus: false
    });
    ui.form.reset();
    state.draft = emptyDraft();
    ui.layout.hidden = true;
    ui.done.hidden = false;
    window.scrollTo({ top: 0 });
    ui.done.focus({ preventScroll: true });
  } catch (error) {
    setStatus('error', friendlyError(error));
  } finally {
    state.submitting = false;
    ui.submit.disabled = false;
    ui.submit.textContent = 'Send my application';
    ui.form.removeAttribute('aria-busy');
  }
}

const successTakeover = createSuccessTakeover({
  overlay: document.getElementById('leadSuccessOverlay'),
  origin: document.querySelector('.site-brand-logo-wrap'),
  target: document.getElementById('leadSuccessTarget'),
  title: document.querySelector('#leadSuccessCopy .lead-success-title'),
  body: document.querySelector('#leadSuccessCopy .lead-success-body'),
  motionQuery: window.matchMedia('(prefers-reduced-motion: reduce)'),
  holdMs: 3200,
  lockTargets: [
    document.querySelector('.site-header'),
    document.querySelector('main'),
    document.querySelector('.site-footer')
  ].filter(Boolean)
});

/* ---------- start ---------- */

function start() {
  if (!ui.form) return;

  const saved = loadDraft();
  if (saved) {
    state.draft = { ...emptyDraft(), ...saved.draft };
    ['topics', 'added', 'unsure', 'none'].forEach((key) => {
      if (!Array.isArray(state.draft[key])) state.draft[key] = [];
    });
    ui.name.value = typeof saved.contact?.fullName === 'string' ? saved.contact.fullName : '';
    ui.email.value = typeof saved.contact?.email === 'string' ? saved.contact.email : '';
  }

  const requested = new URLSearchParams(window.location.search).get('topic');
  if (requested && TOPICS.some((topic) => topic.id === requested) && state.draft.topics.length === 0) {
    state.draft.topics = [requested];
  }

  ui.form.addEventListener('submit', onSubmit);
  [ui.name, ui.email].forEach((input) => input.addEventListener('input', () => {
    markInvalid(input, false);
    scheduleSave();
  }));
  [ui.consentVideo, ui.consentEducation].forEach((box) => box.addEventListener('change', () => markInvalid(box, false)));
  ui.clear.addEventListener('click', () => {
    if (!window.confirm('Clear all your answers from this device?')) return;
    clearSavedDraft();
    state.draft = emptyDraft();
    ui.form.reset();
    setStatus('', '');
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  render();
}

start();
