#!/usr/bin/env node

/**
 * WHAT THE DEV PANEL DOES WITH WHAT SOMEONE ACTUALLY PASTES.
 *
 * The single-payload path reads the FIRST complete `{...}` and ignores
 * everything after it, which is correct for one module and silent for six:
 * paste a whole call and one module loads with no error anywhere. This covers
 * the multi-module extractor that replaces that silence, and pins the shapes a
 * person really pastes -- an array, a file with a `modules` list, payloads one
 * after another, and several fenced blocks out of a chat window.
 */

import assert from 'node:assert/strict';

import {
  extractJsonObjectFromEditorText,
  extractModulePayloadsFromEditorText
} from '../js/dev_payload_input.js';

let checks = 0;
const check = (label, run) => {
  run();
  checks += 1;
  console.info(`[DevPayloadInput] PASS: ${label}`);
};

const extract = (text) => extractModulePayloadsFromEditorText(text);
const titles = (text) => extract(text).payloads.map((payload) => payload.title);
const rejects = (label, text, expected) => check(label, () => {
  assert.throws(() => extractModulePayloadsFromEditorText(text), (error) => {
    assert.equal(error.message, expected);
    return true;
  });
});

const ONE = '{"title":"Balance sheet","generated":{"summaryHtml":"<p>a</p>"}}';
const TWO = '{"title":"Cash reserve","generated":{"summaryHtml":"<p>b</p>"}}';

check('one payload is one module, exactly as before', () => {
  assert.deepEqual(titles(ONE), ['Balance sheet']);
});

check('an array of payloads is every module in it', () => {
  assert.deepEqual(titles(`[${ONE},${TWO}]`), ['Balance sheet', 'Cash reserve']);
});

check('a bare modules list is every module in the list', () => {
  assert.deepEqual(titles(`{"modules":[${ONE},${TWO}]}`), ['Balance sheet', 'Cash reserve']);
});

// A case pack comes back WHOLE. Flattening it to its modules here would throw
// away the version and the client name before either could be checked.
check('a case pack is handed back intact for the pack validator', () => {
  const found = extract(`{"casePackVersion":1,"clientName":"AAM: someone","modules":[${ONE},${TWO}]}`);
  assert.equal(found.payloads.length, 0);
  assert.equal(found.pack.clientName, 'AAM: someone');
  assert.equal(found.pack.modules.length, 2);
});

// THE ONE THE SINGLE-PAYLOAD PATH LOSES. Two objects with nothing between
// them is what pasting two modules looks like, and it used to load one.
check('payloads pasted one after another are all found', () => {
  assert.deepEqual(titles(`${ONE}\n\n${TWO}`), ['Balance sheet', 'Cash reserve']);
  assert.equal(extractJsonObjectFromEditorText(`${ONE}\n\n${TWO}`), ONE);
});

check('and with a stray comma between them, the way a half-written array reads', () => {
  assert.deepEqual(titles(`${ONE},\n${TWO}`), ['Balance sheet', 'Cash reserve']);
});

check('several fenced blocks out of a chat window are all kept', () => {
  assert.deepEqual(
    titles(`Here you go:\n\`\`\`json\n${ONE}\n\`\`\`\nand the second:\n\`\`\`json\n${TWO}\n\`\`\``),
    ['Balance sheet', 'Cash reserve']
  );
});

check('a braces-in-strings payload is not cut short by its own content', () => {
  const tricky = '{"title":"Report","generated":{"summaryHtml":"<p>a } brace and a \\" quote</p>"}}';
  assert.deepEqual(titles(`${tricky}${TWO}`), ['Report', 'Cash reserve']);
});

check('smart quotes from a document still parse', () => {
  assert.deepEqual(titles('{\u201Ctitle\u201D:\u201CBalance sheet\u201D}'), ['Balance sheet']);
});

rejects('an empty box says what to do', '   ', 'Paste one or more module payloads first.');
rejects('an empty array is refused', '[]', 'That array has no modules in it.');
rejects('an empty modules list is refused', '{"modules":[]}', 'That file has no modules in it.');
rejects('a non-object entry is named by position', `[${ONE},42]`, 'Module 2 must be a payload object.');
rejects('prose with no payload in it is refused', 'here are the modules', 'No module payloads found (check quotes).');
rejects('valid JSON that is not a payload is refused', '"just a string"', 'That is valid JSON but not a module payload.');
rejects(
  'a broken second payload is named by position',
  `${ONE}{"title":"Cash reserve",}`,
  'Module 2 is not valid JSON (check quotes).'
);

console.info(`[DevPayloadInput] ${checks} checks passed.`);
