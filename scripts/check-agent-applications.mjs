#!/usr/bin/env node

/**
 * APPLICATIONS FROM AI ASSISTANTS, CHECKED THROUGH THE REAL WORKER.
 *
 * Runs worker/src/index.js against a fresh SQLite database built from every
 * adviser migration, with email captured instead of sent. It holds the flow
 * to its promises:
 *
 *   - checking an application stores nothing and emails nobody;
 *   - sending one needs the person's email and both consents, and only files
 *     a request: nothing reaches the pipeline until the person confirms;
 *   - the confirmation email carries a link and none of the figures;
 *   - confirming files exactly one lead, once; cancelling deletes everything;
 *   - limits per email address stop the endpoint being used to email people;
 *   - expired requests are deleted by the hourly cron;
 *   - with no email or no encryption key, nothing is accepted.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const originalWarn = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  originalWarn.call(process, warning, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workspace = mkdtempSync(join(tmpdir(), 'agent-applications-'));
process.once('exit', () => rmSync(workspace, { recursive: true, force: true }));

/* ---------- a D1 over node:sqlite ---------- */

function bindable(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return value;
}

class TestStatement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new TestStatement(this.database, this.sql, values);
  }

  async first() {
    const row = this.database.prepare(this.sql).get(...this.values.map(bindable));
    return row ? { ...row } : null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values.map(bindable)).map((row) => ({ ...row })) };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values.map(bindable));
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class TestD1 {
  constructor(path) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA foreign_keys = ON');
  }

  prepare(sql) {
    return new TestStatement(this.database, sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  rows(sql, ...values) {
    return this.database.prepare(sql).all(...values.map(bindable)).map((row) => ({ ...row }));
  }
}

function freshDatabase(label) {
  const database = new TestD1(join(workspace, `${label}.sqlite`));
  readdirSync(resolve(root, 'worker/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .forEach((name) => database.database.exec(readFileSync(resolve(root, 'worker/migrations', name), 'utf8')));
  return database;
}

/* ---------- email captured, not sent ---------- */

const emails = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith('https://api.resend.com/emails')) {
    emails.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: `email_${emails.length}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  throw new Error(`Unexpected network request in test: ${url}`);
};

const { default: worker } = await import('../worker/src/index.js');

function makeEnv(database, overrides = {}) {
  return {
    LEADS_DB: database,
    APPLICATION_DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
    RESEND_API_KEY: 're_test',
    LEAD_EMAIL_FROM: 'Planeir <hello@planeir.ie>',
    LEAD_NOTIFICATION_TO: 'gerry@example.com',
    LEAD_REPLY_TO: 'hello@planeir.ie',
    ...overrides
  };
}

let ipCounter = 0;
async function call(env, path, body, { origin = null, ip = `203.0.113.${++ipCounter % 250}` } = {}) {
  const pending = [];
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  const response = await worker.fetch(new Request(`https://api.planeir.ie${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  }), env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
  return { status: response.status, json: await response.json().catch(() => null) };
}

let checks = 0;
async function check(label, run) {
  await run();
  checks += 1;
  console.log(`ok - ${label}`);
}

const application = {
  topics: ['mortgage', 'retirement'],
  question: 'Should we overpay the mortgage or pay more into our pensions?',
  household: { age: 41, partner: 'yes', partnerAge: 39, children: 'no' },
  income: { gross: 62000, partnerGross: 48000 },
  home: { status: 'mortgage', value: 420000 },
  mortgage: { balance: 281234, rate: 3.9, yearsLeft: 23 },
  pensions: [{ type: 'company', value: 85000 }],
  madeUpField: 'x'
};
const person = { name: 'Aoife', email: 'aoife@example.com' };
const consent = { videoPublication: true, educationOnly: true };

const database = freshDatabase('main');
const env = makeEnv(database);

await check('check shows the write-up and warnings, and stores and sends nothing', async () => {
  const result = await call(env, '/api/agent/applications/check', { application });
  assert.equal(result.status, 200);
  assert.equal(result.json.ready, true);
  assert.match(result.json.summary, /overpay the mortgage/);
  assert.match(result.json.summary, /€281,234/);
  assert.ok(result.json.warnings.some((warning) => warning.path === 'madeUpField'));
  assert.ok(Array.isArray(result.json.stillUseful) && result.json.stillUseful.length > 0);
  assert.equal(database.rows('SELECT COUNT(*) AS n FROM agent_application_requests')[0].n, 0);
  assert.equal(emails.length, 0);
});

await check('sending needs both consents, a real email address and a question', async () => {
  const noConsent = await call(env, '/api/agent/applications', { person, consent: { videoPublication: true }, application });
  assert.equal(noConsent.status, 400);
  assert.match(noConsent.json.error, /consent\.educationOnly/);
  const stringConsent = await call(env, '/api/agent/applications', { person, consent: { videoPublication: 'yes', educationOnly: true }, application });
  assert.equal(stringConsent.status, 400, 'consent must be the boolean true');
  const badEmail = await call(env, '/api/agent/applications', { person: { name: 'A', email: 'not-an-email' }, consent, application });
  assert.equal(badEmail.status, 400);
  assert.match(badEmail.json.error, /person\.email/);
  const noQuestion = await call(env, '/api/agent/applications', { person, consent, application: { topics: ['mortgage'] } });
  assert.equal(noQuestion.status, 400);
  assert.match(noQuestion.json.error, /application\.question/);
  assert.equal(emails.length, 0);
});

let token = '';
await check('sending files a request and emails the person a link, with no figures', async () => {
  const result = await call(env, '/api/agent/applications', { person, consent, application, assistant: { name: 'ChatGPT <script>' } });
  assert.equal(result.status, 202);
  assert.equal(result.json.status, 'waiting_for_confirmation');
  assert.match(result.json.message, /a\*\*\*@example\.com/);
  assert.ok(result.json.warnings.some((warning) => warning.path === 'madeUpField'));

  const rows = database.rows('SELECT * FROM agent_application_requests');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assistant_name, 'ChatGPT script');
  assert.ok(!rows[0].application_payload_encrypted.includes('overpay'), 'the question is encrypted');
  assert.ok(!rows[0].application_payload_encrypted.includes('281234'), 'the figures are encrypted');
  assert.equal(database.rows('SELECT COUNT(*) AS n FROM leads')[0].n, 0, 'no lead before confirmation');

  assert.equal(emails.length, 1);
  const [email] = emails;
  assert.deepEqual(email.to, ['aoife@example.com']);
  assert.equal(email.subject, 'Confirm your Planeir application');
  const link = /https:\/\/planeir\.ie\/apply\/confirm\/#t=([A-Za-z0-9_-]{43})/.exec(email.text);
  assert.ok(link, 'the email carries the confirmation link');
  token = link[1];
  for (const secret of ['overpay', '281,234', '281234', '85,000', 'ChatGPT']) {
    assert.ok(!email.text.includes(secret) && !email.html.includes(secret), `the email must not carry ${secret}`);
  }
});

await check('the confirmation page can read the request with the token, and nothing without it', async () => {
  const preview = await call(env, '/api/agent/applications/preview', { token }, { origin: 'https://planeir.ie' });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.name, 'Aoife');
  assert.equal(preview.json.application.mortgage.balance, 281234);
  const wrong = await call(env, '/api/agent/applications/preview', { token: 'A'.repeat(43) }, { origin: 'https://planeir.ie' });
  assert.equal(wrong.status, 404);
  const malformed = await call(env, '/api/agent/applications/preview', { token: 'short' }, { origin: 'https://planeir.ie' });
  assert.equal(malformed.status, 404);
});

await check('confirming files one lead, tells Gerry, and uses up the link', async () => {
  emails.length = 0;
  const confirm = await call(env, '/api/agent/applications/confirm', { token }, { origin: 'https://planeir.ie' });
  assert.equal(confirm.status, 200);
  const leads = database.rows('SELECT * FROM leads');
  assert.equal(leads.length, 1);
  assert.equal(leads[0].source, 'agent-api');
  assert.equal(leads[0].application_channel, 'agent-api');
  assert.equal(leads[0].application_assistant, 'ChatGPT script');
  assert.equal(leads[0].status, 'new');
  assert.equal(leads[0].help_reason, application.question);
  const clients = database.rows('SELECT * FROM clients');
  assert.equal(clients.length, 1);
  assert.equal(clients[0].source, 'case_application');
  assert.equal(database.rows('SELECT COUNT(*) AS n FROM agent_application_requests')[0].n, 0);

  assert.equal(emails.length, 1, 'Gerry is told; the person has just confirmed on the page');
  assert.deepEqual(emails[0].to, ['gerry@example.com']);
  assert.match(emails[0].text, /Sent by an AI assistant and confirmed by the person by email \(ChatGPT script\)/);
  assert.ok(!emails[0].text.includes('281,234'), 'Gerry’s email carries no figures');

  const again = await call(env, '/api/agent/applications/confirm', { token }, { origin: 'https://planeir.ie' });
  assert.equal(again.status, 404);
  assert.equal(database.rows('SELECT COUNT(*) AS n FROM leads')[0].n, 1, 'never filed twice');
});

await check('the admin reads the confirmed application like any other', async () => {
  const [lead] = database.rows('SELECT id FROM leads');
  const response = await worker.fetch(new Request(`https://api.planeir.ie/api/advisor/leads/${lead.id}/application`, {
    // Adviser routes only answer the site's own origin.
    headers: { 'CF-Connecting-IP': '198.51.100.9', Origin: 'https://planeir.ie' }
  }), env, { waitUntil() {} });
  const json = await response.json();
  assert.equal(response.status, 200);
  assert.equal(json.channel, 'agent-api');
  assert.equal(json.application.mortgage.balance, 281234);
});

await check('cancelling deletes the request and everything in it', async () => {
  const sent = await call(env, '/api/agent/applications', { person: { name: 'Tom', email: 'tom@example.com' }, consent, application });
  assert.equal(sent.status, 202);
  const cancelToken = /#t=([A-Za-z0-9_-]{43})/.exec(emails.at(-1).text)[1];
  const cancel = await call(env, '/api/agent/applications/cancel', { token: cancelToken }, { origin: 'https://planeir.ie' });
  assert.equal(cancel.status, 200);
  assert.equal(database.rows('SELECT COUNT(*) AS n FROM agent_application_requests')[0].n, 0);
  const preview = await call(env, '/api/agent/applications/preview', { token: cancelToken }, { origin: 'https://planeir.ie' });
  assert.equal(preview.status, 404);
});

await check('one email address can only be sent 3 requests a day', async () => {
  const target = { name: 'Nora', email: 'nora@example.com' };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await call(env, '/api/agent/applications', { person: target, consent, application });
    assert.equal(result.status, 202, `attempt ${attempt}`);
  }
  const fourth = await call(env, '/api/agent/applications', { person: target, consent, application });
  assert.equal(fourth.status, 429);
  assert.match(fourth.json.error, /already has applications waiting/);
});

await check('the hourly cron deletes requests whose link has expired', async () => {
  database.database.exec("UPDATE agent_application_requests SET expires_at = '2000-01-01T00:00:00.000Z'");
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
  assert.equal(database.rows('SELECT COUNT(*) AS n FROM agent_application_requests')[0].n, 0);
});

await check('with no email or no encryption key, nothing is accepted', async () => {
  const noEmailDb = freshDatabase('no-email');
  const noEmail = await call(makeEnv(noEmailDb, { RESEND_API_KEY: '' }), '/api/agent/applications', { person, consent, application });
  assert.equal(noEmail.status, 503);
  assert.equal(noEmailDb.rows('SELECT COUNT(*) AS n FROM agent_application_requests')[0].n, 0);
  const noKeyDb = freshDatabase('no-key');
  const noKey = await call(makeEnv(noKeyDb, { APPLICATION_DATA_ENCRYPTION_KEY: '' }), '/api/agent/applications', { person, consent, application });
  assert.equal(noKey.status, 503);
  assert.equal(noKeyDb.rows('SELECT COUNT(*) AS n FROM agent_application_requests')[0].n, 0);
});

await check('a page sent from an assistant’s link is marked as such', async () => {
  const pageDb = freshDatabase('page');
  const pageEnv = makeEnv(pageDb);
  const result = await call(pageEnv, '/api/applications', {
    fullName: 'Ciara',
    email: 'ciara@example.com',
    consentVideo: true,
    consentEducation: true,
    via: 'assistant-link',
    application: { question: 'Can we retire at 60?', topics: ['retirement'], pensions: [{ type: 'company', value: 120000 }] }
  }, { origin: 'https://planeir.ie' });
  assert.equal(result.status, 201);
  const [lead] = pageDb.rows('SELECT source, application_channel FROM leads');
  assert.deepEqual(lead, { source: 'apply-page', application_channel: 'assistant-link' });
});

console.log(`\n${checks} assistant application checks passed.`);
