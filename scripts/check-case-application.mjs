#!/usr/bin/env node

/**
 * THE APPLICATION MODULE, CHECKED.
 *
 * js/case_application/ is shared by the /apply/ page, the Worker and the admin.
 * These checks hold it to its three promises:
 *
 *   1. A submission is never refused over a detail. Bad figures are dropped,
 *      unknown keys are dropped, repeaters are capped, and nothing throws.
 *   2. What was hidden is not sent. Answers in a section the person has since
 *      hidden stay out of what is submitted.
 *   3. A published case carries rounded figures and none of the person's own
 *      words, name or lender.
 *
 * The write-up and the public case are compared with committed snapshots.
 * Run with --update to rewrite them after an intended wording change.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  APPLICATION_SCHEMA,
  SECTIONS,
  buildApplicationJsonSchema,
  buildOpenApiDocument,
  buildPrefillLink,
  parsePrefill,
  prepareAgentApplication,
  applicationToMarkdown,
  applicationToText,
  countAnswers,
  normalizeApplication,
  parseMoney,
  parsePercent,
  pruneToVisible,
  roundPublicMoney,
  slugify,
  suggestCaseTitle,
  toPublicCase
} from '../js/case_application/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = (name) => `${root}scripts/fixtures/case-applications/${name}`;
const update = process.argv.includes('--update');

let checks = 0;
function check(label, run) {
  run();
  checks += 1;
  console.log(`ok - ${label}`);
}

function snapshot(name, actual) {
  const path = fixture(name);
  if (update) {
    writeFileSync(path, actual);
    return;
  }
  let expected;
  try {
    expected = readFileSync(path, 'utf8');
  } catch (_error) {
    throw new Error(`Missing snapshot ${name}. Run: node scripts/check-case-application.mjs --update`);
  }
  assert.equal(actual, expected, `${name} changed. If the change is intended, run with --update.`);
}

check('money parses the way people type it', () => {
  assert.equal(parseMoney('35k'), 35_000);
  assert.equal(parseMoney('€35,000'), 35_000);
  assert.equal(parseMoney('35 000'), 35_000);
  assert.equal(parseMoney('1.2m'), 1_200_000);
  assert.equal(parseMoney('265 euro'), 265);
  assert.equal(parseMoney(''), null);
  assert.ok(Number.isNaN(parseMoney('about thirty')));
  assert.ok(Number.isNaN(parseMoney('-5')));
});

check('rates accept a decimal comma and a percent sign', () => {
  assert.equal(parsePercent('4,69'), 4.69);
  assert.equal(parsePercent('4.2%'), 4.2);
  assert.equal(parsePercent(''), null);
  assert.ok(Number.isNaN(parsePercent('four')));
});

check('a submission with only a question is kept', () => {
  const app = normalizeApplication({ question: '  Can we retire at 60?  ' });
  assert.equal(app.schema, APPLICATION_SCHEMA);
  assert.equal(app.question, 'Can we retire at 60?');
  assert.deepEqual(app.topics, []);
  assert.deepEqual(countAnswers(app).answered, 1);
});

check('garbage never throws and produces an empty application', () => {
  for (const raw of [null, undefined, 'text', 42, [], [1, 2], { household: 'x', pensions: 'y' }]) {
    const app = normalizeApplication(raw);
    assert.equal(app.schema, APPLICATION_SCHEMA);
    assert.deepEqual(app.unsure, []);
  }
});

check('unknown keys, bad topics and out-of-range figures are dropped', () => {
  const app = normalizeApplication({
    topics: ['retirement', 'bogus', 'retirement'],
    injected: '<script>',
    household: { age: 200, partnerAge: '35', partner: 'maybe', sneaky: true },
    mortgage: { rate: 95, balance: '280k' },
    income: { gross: 'lots' }
  });
  assert.deepEqual(app.topics, ['retirement']);
  assert.equal(app.injected, undefined);
  assert.equal(app.household.age, undefined);
  assert.equal(app.household.partnerAge, 35);
  assert.equal(app.household.partner, undefined);
  assert.equal(app.household.sneaky, undefined);
  assert.equal(app.mortgage.rate, undefined);
  assert.equal(app.mortgage.balance, 280_000);
  assert.equal(app.income, undefined);
});

check('repeaters are capped and long text is cut, not refused', () => {
  const pensions = Array.from({ length: 20 }, (_, index) => ({ type: 'company', value: 1000 * (index + 1) }));
  const app = normalizeApplication({ pensions, question: 'x'.repeat(5_000), videoName: 'y'.repeat(500) });
  const cap = SECTIONS.find((section) => section.id === 'pensions').repeater.max;
  assert.equal(app.pensions.length, cap);
  assert.equal(app.question.length, 2_000);
  assert.equal(app.videoName.length, 60);
});

check('"not sure" is kept only for empty figures the application can hold', () => {
  const app = normalizeApplication({
    savings: { cash: 1000 },
    pensions: [{ type: 'company' }],
    unsure: ['savings.cash', 'savings.investments', 'pensions.0.value', 'pensions.3.value', 'household.partner', 'nonsense']
  });
  assert.deepEqual(app.unsure, ['savings.investments', 'pensions.0.value']);
});

check('pension contributions keep their unit, and a missing unit means % of salary', () => {
  const app = normalizeApplication({ pensions: [{ youPay: '265', youPayUnit: 'eur' }, { youPay: '5' }, { youPay: '150', youPayUnit: 'pct' }] });
  assert.deepEqual(app.pensions[0], { youPay: 265, youPayUnit: 'eur' });
  assert.deepEqual(app.pensions[1], { youPay: 5, youPayUnit: 'pct' });
  assert.deepEqual(app.pensions[2], {}, 'a percentage over 100 is dropped');
});

check('answers in hidden sections are not sent', () => {
  const app = pruneToVisible(normalizeApplication({
    topics: ['buying'],
    household: { partner: 'no', partnerAge: 40 },
    buying: { price: 350_000 },
    pensions: [{ type: 'company', value: 20_000 }],
    retirement: { age: 60 },
    loans: [{ balance: 5_000 }],
    none: ['loans'],
    home: { status: 'rent', rent: 1_500, value: 300_000 },
    unsure: ['pensions.0.youPay', 'buying.deposit']
  }));
  assert.equal(app.buying.price, 350_000);
  assert.equal(app.pensions, undefined, 'pensions are not a buying topic');
  assert.equal(app.retirement, undefined);
  assert.equal(app.household.partnerAge, undefined, 'no partner, no partner age');
  assert.equal(app.loans, undefined, 'marked as no loans');
  assert.deepEqual(app.none, ['loans']);
  assert.equal(app.home.value, undefined, 'a renter has no home value');
  assert.deepEqual(app.unsure, ['buying.deposit']);
});

check('a section added with "Add more" is kept', () => {
  const app = pruneToVisible(normalizeApplication({
    topics: ['buying'],
    added: ['pensions'],
    pensions: [{ type: 'company', value: 20_000 }]
  }));
  assert.equal(app.pensions[0].value, 20_000);
  assert.deepEqual(app.added, ['pensions']);
});

check('public rounding moves big figures further and never rounds a figure to nothing', () => {
  assert.equal(roundPublicMoney(123_456), 125_000);
  assert.equal(roundPublicMoney(12_345), 12_000);
  assert.equal(roundPublicMoney(1_234), 1_200);
  assert.equal(roundPublicMoney(265, { monthly: true }), 250);
  assert.equal(roundPublicMoney(20, { monthly: true }), 50);
  assert.equal(roundPublicMoney(30), 100);
  assert.equal(roundPublicMoney(0), 0);
});

const full = pruneToVisible(normalizeApplication(JSON.parse(readFileSync(fixture('full.json'), 'utf8'))));

check('the full fixture reads the same as its snapshot', () => {
  snapshot('full.expected.txt', `${applicationToText(full)}\n`);
  snapshot('full.expected.md', applicationToMarkdown(full, { heading: 'Application: Aoife', submittedAt: '2026-09-24' }));
});

check('the public case carries no name, lender or free text, and rounds figures', () => {
  const publicCase = toPublicCase(full);
  const text = JSON.stringify(publicCase);
  for (const secret of ['Aoife', 'Example Bank', 'part-time', 'fixed rate ends in March', '281,234', '12,345', '265']) {
    assert.ok(!text.includes(secret), `public case leaked: ${secret}`);
  }
  assert.equal(publicCase.question, '');
  assert.equal(publicCase.youtubeId, '');
  assert.ok(text.includes('€280,000'), 'mortgage balance rounded to the nearest 5,000');
  assert.ok(text.includes('The applicant'), 'owner written in the third person');
  snapshot('full.expected.public.json', `${JSON.stringify(publicCase, null, 2)}\n`);
});

check('titles and slugs read like a forum thread', () => {
  assert.equal(suggestCaseTitle(full), '34 and 35, two children: retirement, the mortgage and the whole picture');
  assert.equal(suggestCaseTitle({ household: { age: 58, partner: 'no', children: 'no' }, topics: ['retirement'] }), '58, no children: retirement');
  assert.equal(suggestCaseTitle({}), 'A Planeir case');
  assert.equal(slugify('34 and 35: Pension or Overpay?'), '34-and-35-pension-or-overpay');
});

check('the JSON Schema for assistants covers every question on the form', () => {
  const schema = buildApplicationJsonSchema();
  const at = (path) => path.split('.').reduce((node, key) => node?.properties?.[key], schema);
  SECTIONS.forEach((section) => {
    (section.fields || []).forEach((field) => {
      assert.ok(at(field.path), `schema is missing ${field.path}`);
    });
    if (section.repeater) {
      const items = schema.properties[section.repeater.path]?.items?.properties || {};
      section.repeater.fields.forEach((field) => {
        assert.ok(items[field.key], `schema is missing ${section.repeater.path}[].${field.key}`);
        if (field.unitKey) assert.ok(items[field.unitKey], `schema is missing ${field.unitKey}`);
      });
    }
  });
  assert.deepEqual(schema.required, ['question']);
  assert.match(at('mortgage.fixedEnds').description, /Read when mortgage\.rateType is "fixed"/);
});

check('an assistant hears exactly what could not be used, and why', () => {
  const { application, warnings } = prepareAgentApplication({
    topics: ['retirement', 'crypto'],
    question: 'Can we retire at 60?',
    household: { age: 'sixty', partner: 'no', partnerAge: 58 },
    income: { gross: 'about 50k' },
    pensions: [{ type: 'company', value: 120000 }],
    favouriteColour: 'blue'
  });
  const byPath = Object.fromEntries(warnings.map((warning) => [warning.path, warning.message]));
  assert.match(byPath.topics, /"crypto" is not a topic/);
  assert.match(byPath['household.age'], /Could not use "sixty"\. A whole number/);
  assert.match(byPath['income.gross'], /A number in euro a year/);
  assert.match(byPath.favouriteColour, /Not a Planeir field/);
  assert.match(byPath['household.partnerAge'], /Gerry will not see it: it only applies when household\.partner is "yes"/);
  assert.equal(application.pensions[0].value, 120000);
});

check('answers an assistant gives in a section with no chosen topic still reach Gerry', () => {
  const { application } = prepareAgentApplication({
    topics: ['buying'],
    question: 'Can we afford it?',
    pensions: [{ type: 'company', value: 40000 }],
    cover: { life: 'yes' }
  });
  assert.deepEqual(application.added, ['pensions', 'cover']);
  const text = applicationToText(application);
  assert.match(text, /Value today: €40,000/);
  assert.match(text, /Life cover: Yes/);
});

check('prefill links read field paths, lists and JSON, and nothing else', () => {
  const dotted = parsePrefill('#topics=retirement,mortgage&q=Can+we+retire%3F&household.age=58&pensions.0.value=120k&unknown.path=1&__proto__.polluted=1&constructor.prototype.polluted=1');
  assert.deepEqual(dotted, {
    topics: ['retirement', 'mortgage'],
    question: 'Can we retire?',
    household: { age: '58' },
    pensions: [{ value: '120k' }]
  });
  assert.equal({}.polluted, undefined);
  const json = parsePrefill(`#prefill=${encodeURIComponent(JSON.stringify({ question: 'From JSON', household: { age: 40 } }))}`);
  assert.deepEqual(json, { question: 'From JSON', household: { age: 40 } });
  assert.equal(parsePrefill('#prefill=not-json'), null);
  assert.equal(parsePrefill('#'), null);
  assert.equal(parsePrefill('#t=abc'), null, 'a confirmation token is not a prefill');
});

check('a prefill link carries an application there and back unchanged', () => {
  const { application } = prepareAgentApplication(full);
  const link = buildPrefillLink(application);
  assert.ok(link.startsWith('https://planeir.ie/apply/#'));
  assert.ok(!/Aoife/.test(decodeURIComponent(link.split('#')[1]).replace(/videoName=[^&]*/, '')), 'no name beyond the chosen video name');
  const again = prepareAgentApplication(parsePrefill(link.split('#')[1])).application;
  assert.deepEqual(again, application);
});

check('the OpenAPI description asks before sending and its references resolve', () => {
  const document = buildOpenApiDocument();
  const send = document.paths['/api/agent/applications'].post;
  const checkOperation = document.paths['/api/agent/applications/check'].post;
  assert.equal(send.operationId, 'sendCaseApplication');
  assert.equal(send['x-openai-isConsequential'], true);
  assert.equal(checkOperation['x-openai-isConsequential'], false);
  const text = JSON.stringify(document);
  for (const [, name] of text.matchAll(/"#\/components\/schemas\/([A-Za-z]+)"/g)) {
    assert.ok(document.components.schemas[name], `unresolved reference ${name}`);
  }
  for (const operation of [send, checkOperation]) {
    assert.ok(operation.description.length <= 300, `${operation.operationId} description is too long for GPT actions`);
  }
});

console.log(`\n${checks} case application checks passed${update ? ' (snapshots updated)' : ''}.`);
