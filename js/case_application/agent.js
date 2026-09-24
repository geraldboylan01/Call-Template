/**
 * THE APPLICATION, FOR AI ASSISTANTS.
 *
 * People increasingly talk their finances through with ChatGPT or Claude. This
 * module lets an assistant do the whole application for its user in one step,
 * from the same description the /apply/ page is built from:
 *
 *   - prepareAgentApplication() takes whatever the assistant sends, keeps what
 *     it can read, and says precisely what it could not use and why, so the
 *     assistant can fix it with its user rather than guess.
 *   - parsePrefill() reads a link an assistant wrote for its user, so an
 *     assistant with no way to call an API can still hand over every answer.
 *   - buildApplicationJsonSchema() and buildOpenApiDocument() publish the
 *     format, generated here so the documentation cannot drift from the form.
 *
 * An assistant never submits on its own authority. The API it can reach only
 * files a request: the person confirms it from an email before Gerry sees it.
 */

import {
  APPLICATION_SCHEMA,
  MAX_QUESTION_LENGTH,
  SECTIONS,
  TOPICS,
  countAnswers,
  getPath,
  includeAnsweredSections,
  isNumericField,
  listVisibleFields,
  normalizeApplication,
  setPath
} from './schema.js';

export const AGENT_REQUEST_FORMAT = 'planeir.agent-application.v1';
export const SITE_URL = 'https://planeir.ie';
export const API_URL = 'https://api.planeir.ie';
export const CONFIRMATION_DAYS = 7;
export const STILL_USEFUL_LIMIT = 12;

const LIST_KEYS = ['topics', 'unsure', 'none', 'added'];
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const NONE_SECTIONS = SECTIONS.filter((section) => section.none).map((section) => section.id);

/* ---------- which field a path means ---------- */

const FIELD_INDEX = new Map();
SECTIONS.forEach((section) => {
  (section.fields || []).forEach((field) => {
    FIELD_INDEX.set(field.path, { section, field });
  });
  if (section.repeater) {
    section.repeater.fields.forEach((field) => {
      FIELD_INDEX.set(`${section.repeater.path}.*.${field.key}`, { section, field });
      if (field.unitKey) FIELD_INDEX.set(`${section.repeater.path}.*.${field.unitKey}`, { section, field, unit: true });
    });
  }
});

function indexKey(path) {
  return String(path).split('.').map((segment) => (/^\d+$/.test(segment) ? '*' : segment)).join('.');
}

/** The schema field behind a concrete path such as "pensions.0.value". */
export function describePath(path) {
  return FIELD_INDEX.get(indexKey(path)) || null;
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

function leafEntries(value, prefix = '') {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    if (LIST_KEYS.includes(prefix)) return value.map((item) => ({ path: prefix, value: item, listItem: true }));
    return value.flatMap((item, index) => leafEntries(item, `${prefix}.${index}`));
  }
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => leafEntries(child, prefix ? `${prefix}.${key}` : key));
  }
  return [{ path: prefix, value }];
}

/* ---------- plain words for what a field expects ---------- */

function unitWords(field) {
  if (field.unit === 'month') return 'euro a month';
  if (field.unit === 'year') return 'euro a year';
  return 'euro';
}

export function expectationFor(field) {
  switch (field.type) {
    case 'money':
      return `A number in ${unitWords(field)}, like 35000.`;
    case 'percent':
      return `A percentage as a number, like 4.2${field.max ? ` (up to ${field.max})` : ''}.`;
    case 'age':
      return `A whole number from ${field.min ?? 0} to ${field.max ?? 110}.`;
    case 'years':
      return 'A number of years, like 22 or 22.5.';
    case 'month':
      return 'Year and month, like 2027-03.';
    case 'contribution':
      return `A number: a percentage of salary like 5, or euro a month with ${field.unitKey} set to "eur".`;
    case 'choice':
      return `One of: ${field.options.map((option) => `"${option.value}" (${option.label})`).join(', ')}.`;
    case 'text':
    case 'longtext':
      return `Text, up to ${field.maxLength ?? 120} characters.`;
    default:
      return '';
  }
}

/* ---------- checking what an assistant sent ---------- */

function listWarning(key, value, application) {
  const kept = Array.isArray(application[key]) ? application[key] : [];
  if (kept.includes(value)) return null;
  const shown = JSON.stringify(value);
  if (key === 'topics') {
    return { path: 'topics', message: `${shown} is not a topic. Use: ${TOPICS.map((topic) => topic.id).join(', ')}.` };
  }
  if (key === 'none') {
    return { path: 'none', message: `${shown} cannot be marked none. Use: ${NONE_SECTIONS.join(', ')}.` };
  }
  if (key === 'unsure') {
    return {
      path: 'unsure',
      message: `${shown} was not kept. It must be the path of a figure the person does not know, left empty, like "pensions.0.value".`
    };
  }
  return null;
}

function droppedValueWarnings(raw, application) {
  const warnings = [];
  leafEntries(raw).forEach((entry) => {
    if (entry.path === 'schema' || !hasValue(entry.value)) return;
    if (entry.listItem) {
      const warning = listWarning(entry.path, entry.value, application);
      if (warning) warnings.push(warning);
      return;
    }
    const known = describePath(entry.path);
    if (!known) {
      warnings.push({ path: entry.path, message: 'Not a Planeir field, so it was left out.' });
      return;
    }
    if (known.unit) return;
    if (hasValue(getPath(application, entry.path))) return;
    const segments = entry.path.split('.');
    const repeater = known.section.repeater;
    if (repeater && Number(segments[1]) >= repeater.max) {
      warnings.push({ path: entry.path, message: `Only ${repeater.max} entries are kept for ${repeater.path}.` });
      return;
    }
    warnings.push({
      path: entry.path,
      message: `Could not use ${JSON.stringify(entry.value)}. ${expectationFor(known.field)}`
    });
  });
  return warnings;
}

function hiddenValueWarnings(application) {
  const visible = new Set(listVisibleFields(application).map((instance) => instance.path));
  const warnings = [];
  leafEntries(application).forEach((entry) => {
    if (entry.listItem || entry.path === 'schema' || !hasValue(entry.value)) return;
    const known = describePath(entry.path);
    if (!known || known.unit || visible.has(entry.path)) return;
    const reason = known.field.when || known.section.when;
    warnings.push({
      path: entry.path,
      message: reason
        ? `Kept, but Gerry will not see it: it only applies when ${reason}.`
        : 'Kept, but Gerry will not see it with the other answers given.'
    });
  });
  return warnings;
}

/**
 * The questions still worth asking, for the topics chosen. An assistant can put
 * these to its user; every one of them can still be skipped.
 */
function stillUsefulQuestions(application) {
  const unsure = new Set(Array.isArray(application.unsure) ? application.unsure : []);
  return listVisibleFields(application)
    .filter(({ field, path }) => (
      !['question', 'upcoming', 'anythingElse', 'videoName'].includes(path)
      && field.type !== 'text'
      && !hasValue(getPath(application, path))
      && !unsure.has(path)
    ))
    .slice(0, STILL_USEFUL_LIMIT)
    .map(({ field, path }) => ({ path, question: field.label, expects: expectationFor(field) }));
}

/**
 * Everything an assistant needs to hear back about an application: the
 * application as it will be kept, what could not be used and why, and what
 * would still help.
 */
export function prepareAgentApplication(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const application = includeAnsweredSections(normalizeApplication(source));
  return {
    application,
    counts: countAnswers(application),
    warnings: [...droppedValueWarnings(source, application), ...hiddenValueWarnings(application)],
    stillUseful: stillUsefulQuestions(application)
  };
}

/* ---------- links an assistant writes for its user ---------- */

/**
 * Read a prefill link. Two forms are accepted after "#" on /apply/:
 *
 *   #topics=retirement,mortgage&question=Can+we+retire+at+60&household.age=58
 *   #prefill=<the application as URL-encoded JSON>
 *
 * The first is what a chat assistant can write reliably by hand: every key is
 * a field path, lists are comma separated, and figures are plain numbers.
 * Returns the raw application, or null when the link carries none.
 */
export function parsePrefill(fragment) {
  const text = String(fragment || '').replace(/^#/, '');
  if (!text) return null;
  const params = new URLSearchParams(text);
  if (params.has('prefill')) {
    try {
      const parsed = JSON.parse(params.get('prefill'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  const application = {};
  let found = false;
  for (const [rawKey, value] of params) {
    const key = rawKey === 'q' ? 'question' : rawKey;
    if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/.test(key)) continue;
    if (key.split('.').some((segment) => UNSAFE_SEGMENTS.has(segment))) continue;
    if (LIST_KEYS.includes(key)) {
      application[key] = value.split(',').map((item) => item.trim()).filter(Boolean);
      found = true;
      continue;
    }
    if (!describePath(key)) continue;
    setPath(application, key, value);
    found = true;
  }
  return found ? application : null;
}

/** Write a prefill link for an application, in the readable dotted form. */
export function buildPrefillLink(application, base = `${SITE_URL}/apply/`) {
  const params = new URLSearchParams();
  const source = application && typeof application === 'object' ? application : {};
  LIST_KEYS.filter((key) => key !== 'added').forEach((key) => {
    if (Array.isArray(source[key]) && source[key].length > 0) params.set(key, source[key].join(','));
  });
  leafEntries(source).forEach((entry) => {
    if (entry.listItem || entry.path === 'schema' || !hasValue(entry.value)) return;
    if (!describePath(entry.path)) return;
    params.set(entry.path, String(entry.value));
  });
  return `${base}#${params.toString()}`;
}

/* ---------- the published format ---------- */

const ROOT_DESCRIPTIONS = {
  household: 'Ages and household.',
  children: 'One entry per child. Read when household.children is "yes".',
  income: 'Pay before tax, type of work, and household take-home pay.',
  spending: 'Whether the household saves most months, and monthly spending.',
  home: 'The housing situation.',
  mortgage: 'The mortgage on the home. Read when home.status is "mortgage".',
  buying: 'For someone planning to buy a home.',
  savings: 'Cash, investments and shares in an employer.',
  properties: 'Property owned apart from the home, one entry each.',
  pensions: 'One entry per pension, for the person or their partner.',
  retirement: 'Retirement ages and the income wanted.',
  loans: 'One entry per loan. Not the home mortgage.',
  creditCard: 'How the credit card is used.',
  cover: 'Life cover and income protection.'
};

function describeField(field, section) {
  const parts = [field.label.replace(/[?.]$/, '')];
  if (field.hint) parts.push(field.hint.replace(/\.$/, ''));
  parts.push(expectationFor(field).replace(/\.$/, ''));
  const when = field.when || (section.when && !section.repeater ? section.when : '');
  if (when) parts.push(`Read when ${when}`);
  if (field.private) parts.push('Never published');
  return `${parts.join('. ')}.`;
}

function fieldJsonSchema(field, section) {
  const description = describeField(field, section);
  switch (field.type) {
    case 'money':
      return { type: 'number', minimum: 0, description };
    case 'percent':
      return { type: 'number', minimum: 0, maximum: field.max ?? 100, description };
    case 'age':
      return { type: 'integer', minimum: field.min ?? 0, maximum: field.max ?? 110, description };
    case 'years':
      return { type: 'number', minimum: 0, maximum: field.max ?? 60, description };
    case 'month':
      return { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', description };
    case 'choice':
      return { type: 'string', enum: field.options.map((option) => option.value), description };
    case 'contribution':
      return { type: 'number', minimum: 0, description };
    case 'text':
    case 'longtext':
      return { type: 'string', maxLength: field.maxLength ?? 120, description };
    default:
      return { description };
  }
}

function unitJsonSchema(field) {
  return {
    type: 'string',
    enum: field.units.map((unit) => unit.value),
    default: field.units[0].value,
    description: `Unit for ${field.key}: ${field.units.map((unit) => `"${unit.value}" = ${unit.label}`).join(', ')}.`
  };
}

function objectSchema(description) {
  return {
    type: 'object',
    additionalProperties: false,
    ...(description ? { description } : {}),
    properties: {}
  };
}

function placeScalar(root, field, section) {
  const segments = field.path.split('.');
  let node = root;
  segments.slice(0, -1).forEach((segment) => {
    if (!node.properties[segment]) node.properties[segment] = objectSchema(ROOT_DESCRIPTIONS[segment]);
    node = node.properties[segment];
  });
  node.properties[segments[segments.length - 1]] = fieldJsonSchema(field, section);
}

function repeaterJsonSchema(section) {
  const { repeater } = section;
  const item = objectSchema();
  repeater.fields.forEach((field) => {
    item.properties[field.key] = fieldJsonSchema(field, section);
    if (field.unitKey) item.properties[field.unitKey] = unitJsonSchema(field);
  });
  const notes = [ROOT_DESCRIPTIONS[repeater.path] || section.title];
  if (section.none) notes.push(`If there are none, put "${section.id}" in the "none" list instead.`);
  return {
    type: 'array',
    maxItems: repeater.max,
    description: notes.join(' '),
    items: item
  };
}

/**
 * JSON Schema (2020-12) for the application object, generated from the same
 * sections the /apply/ page renders.
 */
export function buildApplicationJsonSchema() {
  const root = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${SITE_URL}/agents/application.schema.json`,
    title: 'Planeir case video application',
    description: [
      `The application format ${APPLICATION_SCHEMA}.`,
      'Only "question" is required. Leave out anything the person does not know, or list its path in "unsure".',
      'Use plain numbers for money (35000), percentages (4.2) and years (22).',
      'Planeir is financial education from Gerry Boylan, a Qualified Financial Adviser in Ireland. It is not financial advice.'
    ].join(' '),
    type: 'object',
    additionalProperties: false,
    required: ['question'],
    properties: {
      topics: {
        type: 'array',
        uniqueItems: true,
        items: { type: 'string', enum: TOPICS.map((topic) => topic.id) },
        description: `What the person wants help with. ${TOPICS.map((topic) => `"${topic.id}" = ${topic.label}`).join(', ')}.`
      }
    }
  };

  SECTIONS.forEach((section) => {
    (section.fields || []).forEach((field) => placeScalar(root, field, section));
    if (section.repeater) root.properties[section.repeater.path] = repeaterJsonSchema(section);
  });

  root.properties.question.minLength = 1;
  root.properties.question.maxLength = MAX_QUESTION_LENGTH;
  root.properties.unsure = {
    type: 'array',
    uniqueItems: true,
    items: { type: 'string' },
    description: 'Paths of figures the person said they do not know, left empty, like "pensions.0.value" or "mortgage.yearsLeft". Different from leaving a field out.'
  };
  root.properties.none = {
    type: 'array',
    uniqueItems: true,
    items: { type: 'string', enum: NONE_SECTIONS },
    description: 'Sections the person confirmed do not apply: "pensions" (no pensions), "loans" (no loans), "properties" (no other property).'
  };
  return root;
}

/** Plain-language question guide, grouped as on the page, for the docs. */
export function buildFieldGuide() {
  return SECTIONS.map((section) => {
    const fields = [];
    (section.fields || []).forEach((field) => fields.push({ path: field.path, field }));
    if (section.repeater) {
      section.repeater.fields.forEach((field) => fields.push({ path: `${section.repeater.path}[].${field.key}`, field }));
    }
    return {
      id: section.id,
      title: section.title,
      intro: section.intro || '',
      shownFor: section.always
        ? (section.when ? `when ${section.when}` : 'every application')
        : `topics: ${(section.topics || []).join(', ')} (or any answers given)`,
      none: section.none ? section.id : '',
      fields: fields.map(({ path, field }) => ({
        path,
        question: field.label,
        expects: expectationFor(field),
        when: field.when || '',
        private: Boolean(field.private)
      }))
    };
  });
}

/* ---------- the API, described for tool-using assistants ---------- */

function personSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'email'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120, description: 'The person’s name. A first name is fine.' },
      email: {
        type: 'string',
        format: 'email',
        maxLength: 160,
        description: 'The person’s own email address. Planeir emails them a button to confirm the application.'
      }
    }
  };
}

function consentSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['videoPublication', 'educationOnly'],
    description: 'Set both only after asking the person and hearing a clear yes. They confirm again with one button in an email.',
    properties: {
      videoPublication: {
        type: 'boolean',
        enum: [true],
        description: 'The person agrees Gerry may use their situation in a video published online, with their name removed and figures rounded, and that they will be emailed when it is live.'
      },
      educationOnly: {
        type: 'boolean',
        enum: [true],
        description: 'The person understands Planeir is education only. It is not financial advice and does not recommend products.'
      }
    }
  };
}

const WARNING_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'The field the warning is about.' },
    message: { type: 'string', description: 'What happened, in plain words.' }
  }
};

const STILL_USEFUL_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    question: { type: 'string', description: 'A question the assistant can ask its user.' },
    expects: { type: 'string', description: 'The form of answer that fits.' }
  }
};

export function buildOpenApiDocument() {
  const application = buildApplicationJsonSchema();
  delete application.$schema;
  delete application.$id;
  const errorResponse = (description) => ({
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
  });

  return {
    openapi: '3.1.0',
    info: {
      title: 'Planeir case video applications',
      version: '1.0.0',
      description: [
        'Apply, on a person’s behalf and with their agreement, for a free Planeir case video.',
        'Gerry Boylan, a Qualified Financial Adviser in Ireland, reads every application and explains some in short education videos, with names left out and figures rounded.',
        'Planeir is financial education, not financial advice, and does not recommend products.',
        'Nothing reaches Gerry until the person confirms from an email.',
        `Guide: ${SITE_URL}/for-ai-assistants/`
      ].join(' '),
      contact: { email: 'hello@planeir.ie', url: `${SITE_URL}/for-ai-assistants/` }
    },
    servers: [{ url: API_URL }],
    paths: {
      '/api/agent/applications/check': {
        post: {
          operationId: 'checkCaseApplication',
          summary: 'Check an application before sending it',
          description: 'Returns the application as Gerry will read it, what could not be used, and questions that would still help. Stores nothing. Show the person the summary before sending: it is the only review they see.',
          'x-openai-isConsequential': false,
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CheckRequest' } } }
          },
          responses: {
            200: {
              description: 'How the application reads.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/CheckResult' } } }
            },
            400: errorResponse('The request could not be read.'),
            429: errorResponse('Too many requests. Try again later.')
          }
        }
      },
      '/api/agent/applications': {
        post: {
          operationId: 'sendCaseApplication',
          summary: 'Send an application for the person to confirm',
          description: 'Only after the person has seen the summary and agreed. Planeir emails them a Confirm button; nothing reaches Gerry until they press it. The button works for 7 days.',
          'x-openai-isConsequential': true,
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApplicationRequest' } } }
          },
          responses: {
            202: {
              description: 'Waiting for the person to confirm by email.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/SendResult' } } }
            },
            400: errorResponse('Something required is missing, such as consent, the email address or the question.'),
            429: errorResponse('Too many applications for this email address or from this connection today.'),
            503: errorResponse('Applications are not open right now.')
          }
        }
      }
    },
    components: {
      schemas: {
        Application: application,
        CheckRequest: {
          type: 'object',
          required: ['application'],
          properties: {
            application: { $ref: '#/components/schemas/Application' }
          }
        },
        ApplicationRequest: {
          type: 'object',
          required: ['person', 'consent', 'application'],
          properties: {
            format: { type: 'string', enum: [AGENT_REQUEST_FORMAT] },
            person: personSchema(),
            consent: consentSchema(),
            application: { $ref: '#/components/schemas/Application' },
            assistant: {
              type: 'object',
              properties: {
                name: { type: 'string', maxLength: 40, description: 'The assistant sending this, for example ChatGPT or Claude.' }
              }
            }
          }
        },
        CheckResult: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            ready: { type: 'boolean', description: 'True when the application has a question and can be sent.' },
            summary: { type: 'string', description: 'The application as Gerry will read it. Show it to the person before sending: the email only asks them to confirm.' },
            answered: { type: 'integer' },
            total: { type: 'integer' },
            warnings: { type: 'array', items: WARNING_SCHEMA },
            stillUseful: { type: 'array', items: STILL_USEFUL_SCHEMA }
          }
        },
        SendResult: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            status: { type: 'string', enum: ['waiting_for_confirmation'] },
            message: { type: 'string', description: 'What to tell the person next.' },
            confirmBy: { type: 'string', format: 'date-time' },
            warnings: { type: 'array', items: WARNING_SCHEMA }
          }
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' }
          }
        }
      }
    }
  };
}
