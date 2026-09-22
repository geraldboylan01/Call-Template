#!/usr/bin/env node

/**
 * THE PACK CHECK, CHECKED.
 *
 * Two things are proved here. First, that each fixture passes or fails for the
 * reason it was written to, message and all. Second -- and this is the one that
 * matters -- that the Dev Panel and this command reach the SAME validator. A
 * check that agreed with a separate copy of the rules would be worth nothing:
 * the only claim worth making about `check:case-pack` is that a pack it passes
 * cannot fail in the browser, and that claim is only true while there is one
 * implementation.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  casePackModuleLabel,
  CASE_PACK_VERSION,
  checkCasePack,
  checkModulePayload,
  firstCasePackProblem,
  looksLikeCasePack
} from '../js/module_pipeline.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = (name) => `${root}scripts/fixtures/case-packs/${name}`;
const readPack = (name) => JSON.parse(readFileSync(fixture(name), 'utf8'));

// The engines narrate what they compute. Useful in a browser console, noise
// in a test log, so they are quietened around each case and restored to print
// the result.
const say = console.info;
let checks = 0;
const check = (label, run) => {
  console.info = () => {};
  try {
    run();
  } finally {
    console.info = say;
  }
  checks += 1;
  say(`[CasePack] PASS: ${label}`);
};

function runCheck(args) {
  try {
    return { status: 0, stdout: execFileSync('node', [`${root}scripts/check-case-pack.mjs`, ...args], { encoding: 'utf8' }) };
  } catch (error) {
    return { status: error.status ?? 1, stdout: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

/* ------------------------------------------------------- the valid pack */

check('the documented pack format is version 1', () => {
  assert.equal(CASE_PACK_VERSION, 1);
  assert.equal(readPack('valid-call.json').casePackVersion, CASE_PACK_VERSION);
});

check('a whole call passes, every module and every case', () => {
  const result = checkCasePack(readPack('valid-call.json'));
  assert.equal(firstCasePackProblem(result), '');
  assert.ok(result.ok, 'the valid pack should pass');
  assert.equal(result.clientName, 'AAM: threekids');
  assert.equal(result.modules.length, 5);
  assert.deepEqual(result.modules.map((row) => row.title), [
    'Your balance sheet', 'Your cash reserve', 'Your retirement', 'Your mortgage', 'What we covered'
  ]);
});

check('and it passes through the command, strictly, with a summary', () => {
  const { status, stdout } = runCheck([fixture('valid-call.json'), '--summary', '--strict']);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /everything checks out/);
  // Per case, not per module: the point of the summary.
  assert.match(stdout, /Retire at 58: required pot €901,566/);
  assert.match(stdout, /Pay €300 more a month: paid off 2043-09-01, saves €36,404/);
  assert.match(stdout, /Current position: gross assets €1,040,000, liabilities €295,000, net worth €745,000/);
  assert.match(stdout, /7\.7 months of cover against a 6-month target/);
});

check('the summary reports every case of every module that has cases', () => {
  const { stdout } = runCheck([fixture('valid-call.json'), '--summary']);
  ['Retire at 62', 'Retire at 58', 'Keep going to 66',
    'Clear the credit union loan', 'Sell the shares into cash', 'Do both',
    'As things stand', 'Put €20,000 against it'].forEach((title) => {
    assert.ok(stdout.includes(title), `expected the summary to cover "${title}"`);
  });
});

check('--json gives the same answer in a shape something else can read', () => {
  const { status, stdout } = runCheck([fixture('valid-call.json'), '--summary', '--json']);
  assert.equal(status, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.clientName, 'AAM: threekids');
  assert.equal(report.modules.length, 5);
  const retirement = report.modules.find((entry) => entry.kind === 'retirement');
  assert.equal(retirement.cases.length, 3);
  assert.equal(Math.round(retirement.cases[1].figures.requiredPot), 901566);
  assert.deepEqual(report.reconciliationProblems, []);
});

check('a single payload can be checked on its own', () => {
  const { status, stdout } = runCheck(['--payload', fixture('single-payload.json'), '--summary']);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /one module payload/);
  assert.match(stdout, /Module 1 of 1 \(Your retirement\)/);
});

/* ---------------------------------------------------- the invalid packs */

const REJECTIONS = [
  ['invalid-fifth-case.json',
    'Module 2 of 2 (Your retirement): generated.pensionInputs.scenarios supports at most 4 cases; received 5.'],
  ['invalid-duplicate-case-id.json',
    'Module 2 of 2 (Your retirement): generated.pensionInputs.scenarios[1].id must be unique.'],
  ['invalid-module-id.json',
    'Module 2 of 2 (Your retirement): moduleId cannot be used in a case pack; every module in a pack is a new one.'],
  ['invalid-version.json', 'casePackVersion must be 1.'],
  ['invalid-empty-modules.json', 'modules is required and must be a non-empty array.'],
  ['invalid-unknown-key.json', 'Unknown case pack keys: author, notes.'],
  ['invalid-no-client-name.json', 'clientName is required and must be a non-empty string.']
];

REJECTIONS.forEach(([name, expected]) => {
  check(`${name} is refused: ${expected}`, () => {
    const result = checkCasePack(readPack(name));
    assert.equal(result.ok, false);
    assert.equal(firstCasePackProblem(result), expected);

    const { status, stdout } = runCheck([fixture(name)]);
    assert.equal(status, 1, 'the command must exit non-zero');
    assert.ok(stdout.includes(expected), `expected the command to say: ${expected}\ngot:\n${stdout}`);
    assert.match(stdout, /not ready/);
  });
});

check('a pack that is not JSON is refused before anything else', () => {
  const { status, stdout } = runCheck([fixture('invalid-malformed.json')]);
  assert.equal(status, 1);
  assert.match(stdout, /Not valid JSON/);
});

check('nothing is left applied when a pack fails', () => {
  const result = checkCasePack(readPack('invalid-fifth-case.json'));
  // The first module is fine; the pack is still not ok, which is what the Dev
  // Panel reads before it decides whether to touch the session.
  assert.equal(result.modules[0].ok, true);
  assert.equal(result.ok, false);
});

/* --------------------------------- one validator, reached two ways */

check('the Dev Panel and this command call the same validator', () => {
  const appSource = readFileSync(`${root}js/app.js`, 'utf8');
  const commandSource = readFileSync(`${root}scripts/check-case-pack.mjs`, 'utf8');

  ['checkCasePack', 'checkModulePayload'].forEach((name) => {
    assert.ok(appSource.includes(name), `js/app.js must use ${name}`);
    assert.ok(commandSource.includes(name), `the command must use ${name}`);
  });

  [appSource, commandSource].forEach((source) => {
    assert.match(source, /from '(\.\.\/js|\.)\/module_pipeline\.js'/,
      'both must import the validator from the pipeline rather than carry their own');
  });
});

check('a pack and a module payload are told apart before either is validated', () => {
  assert.equal(looksLikeCasePack(readPack('valid-call.json')), true);
  assert.equal(looksLikeCasePack(readPack('single-payload.json')), false);
  assert.equal(looksLikeCasePack(null), false);
  assert.equal(looksLikeCasePack([{ title: 'a' }]), false);
});

check('a module names itself the same way wherever it is reported', () => {
  assert.equal(casePackModuleLabel(3, 7, 'Your retirement'), 'Module 3 of 7 (Your retirement)');
  const row = checkModulePayload({ title: 'Your retirement', generated: { summaryHtml: '<p>x</p>' } }, { number: 3, total: 7 });
  assert.equal(row.ok, true);
  assert.equal(casePackModuleLabel(row.number, row.total, row.title), 'Module 3 of 7 (Your retirement)');
});

check('an untitled module still says which one it is', () => {
  const result = checkCasePack({
    casePackVersion: 1,
    clientName: 'AAM: untitled',
    modules: [{ generated: { summaryHtml: '<p>fine</p>' } }, { generated: { pensionInputs: {} } }]
  });
  assert.equal(result.ok, false);
  assert.match(firstCasePackProblem(result), /^Module 2 of 2 \(untitled\): /);
});

say(`[CasePack] ${checks} checks passed.`);
