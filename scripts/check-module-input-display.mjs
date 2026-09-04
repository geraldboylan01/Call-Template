#!/usr/bin/env node

/**
 * THE DISPLAY CONTRACT, HELD TO THE ENGINES' OWN INPUTS.
 *
 * `module_input_display.js` is the one thing in the typed lane that had to be
 * authored rather than derived, because a JSON pointer cannot be rendered into
 * English. Everything authored can drift, so this file is what stops it: it
 * walks the inputs the engines actually accept and fails when a field appears
 * that nobody has decided how to show, or when an options list has quietly
 * stopped matching the validator that enforces it.
 *
 * The failure mode this exists to prevent is the one the brief named: a module
 * requiring one set of inputs while the Type UI has separately hard-coded
 * another.
 */

import assert from 'node:assert/strict';

import { directModuleTestInputs } from './live-harness/direct-fixtures.mjs';
import {
  DISPLAYABLE_MODULE_IDS,
  DISPLAY_KINDS,
  HIDDEN_PATHS,
  MODULE_INPUT_DISPLAY,
  collectionIndexForPointer,
  composeCardTurn,
  collectionPathForPointer,
  describeModuleCollection,
  describeModuleField,
  displayPointerPattern,
  isHiddenModulePath
} from '../js/planning/module_input_display.js';
import { DIRECT_MODULE_IDS } from '../worker/src/consumer/direct_module_planner.js';
import { PERSONAL_BALANCE_SHEET_BUCKETS } from '../js/personal_balance_sheet.js';

let checks = 0;
function ok(value, message) { checks += 1; assert.ok(value, message); }
function equal(actual, expected, message) { checks += 1; assert.equal(actual, expected, message); }

const TODAY = '2026-09-04';
const inputs = directModuleTestInputs(TODAY);

/** Every leaf pointer in a real native input. */
function leafPointers(value, prefix = '') {
  if (value === null || typeof value !== 'object') return [prefix];
  if (Array.isArray(value)) {
    // An empty array still has a shape worth covering, but nothing to walk.
    return value.flatMap((item, index) => leafPointers(item, `${prefix}/${index}`));
  }
  return Object.entries(value).flatMap(([key, item]) => leafPointers(item, `${prefix}/${key}`));
}

/* ---------------------------------------------------- 1. scope is explicit */

// House purchase is out of scope for v1, and that has to be a decision on the
// record rather than an omission nobody noticed.
const missingModules = DIRECT_MODULE_IDS.filter((id) => !DISPLAYABLE_MODULE_IDS.includes(id));
assert.deepEqual(missingModules, ['house_purchase'],
  'house_purchase is the only module without a card, and its absence is deliberate');
checks += 1;
ok(/house-purchase-input-contract/.test(
  (await import('node:fs')).readFileSync(new URL('../js/planning/module_input_display.js', import.meta.url), 'utf8')
), 'the reason house_purchase is excluded is written down, with a link to the defect');

/* ------------------------------------------------------- 2. full coverage */

const uncovered = [];
for (const moduleId of DISPLAYABLE_MODULE_IDS) {
  const input = inputs[moduleId];
  ok(input && typeof input === 'object', `${moduleId} has a real native input to walk`);
  for (const pointer of leafPointers(input)) {
    if (isHiddenModulePath(pointer)) continue;
    if (describeModuleField(moduleId, pointer)) continue;
    uncovered.push(`${moduleId}${displayPointerPattern(pointer)}`);
  }
}
assert.deepEqual(uncovered, [],
  'every field the engines actually accept is either described or explicitly hidden');
checks += 1;

/* ------------------------------------------ 3. nothing described is unused */

// The mirror of coverage. A descriptor for a path no engine produces is a
// field that would be drawn and then refused, which is worse than absent.
const enginePatterns = new Set(
  DISPLAYABLE_MODULE_IDS.flatMap((moduleId) => leafPointers(inputs[moduleId] || {})
    .map((pointer) => `${moduleId}${displayPointerPattern(pointer)}`))
);
const orphans = [];
for (const moduleId of DISPLAYABLE_MODULE_IDS) {
  for (const pattern of Object.keys(MODULE_INPUT_DISPLAY[moduleId].fields)) {
    if (!enginePatterns.has(`${moduleId}${pattern}`)) orphans.push(`${moduleId}${pattern}`);
  }
}
// Optional fields legitimately absent from a happy-path fixture are allowed,
// but they must be a short, reviewable list rather than an open door.
const ALLOWED_ABSENT = new Set([
  'pension_projection/otherIncomeSources/*/title',
  'pension_projection/otherIncomeSources/*/ownerId',
  'pension_projection/otherIncomeSources/*/type',
  'pension_projection/otherIncomeSources/*/annualAmountToday',
  'pension_projection/otherIncomeSources/*/startYear',
  'pension_projection/otherIncomeSources/*/startAge',
  'pension_projection/otherIncomeSources/*/endYear',
  'pension_projection/otherIncomeSources/*/endAge',
  'pension_projection/otherIncomeSources/*/inflationIndexed',
  'pension_projection/otherIncomeSources/*/inflationRate',
  'personal_balance_sheet/liabilityPositions/*/label'
]);
assert.deepEqual(orphans.filter((entry) => !ALLOWED_ABSENT.has(entry)), [],
  'no descriptor names a path the engines do not produce');
checks += 1;

/* --------------------------------------------------- 4. enums are imported */

// A retyped enum is an enum that drifts. Each options list must equal the set
// the code that VALIDATES it uses.
const bucketField = describeModuleField('personal_balance_sheet', '/assetPositions/0/bucket');
assert.deepEqual(
  bucketField.options.map((option) => option.value),
  [...PERSONAL_BALANCE_SHEET_BUCKETS],
  'asset buckets come from the engine that enforces them, in its order'
);
checks += 1;

const statusField = describeModuleField('liquidity_analysis', '/clientStatus');
assert.deepEqual(statusField.options.map((option) => option.value).sort(), ['not-retired', 'retired'],
  'the liquidity client status matches exactly what validateLiquidityInput accepts');
checks += 1;

for (const moduleId of DISPLAYABLE_MODULE_IDS) {
  for (const [pattern, descriptor] of Object.entries(MODULE_INPUT_DISPLAY[moduleId].fields)) {
    ok(DISPLAY_KINDS.includes(descriptor.kind), `${moduleId}${pattern} uses a known control kind`);
    ok(descriptor.label && descriptor.label.length <= 40,
      `${moduleId}${pattern} has a short client-facing label`);
    // Internal vocabulary must never reach a label.
    ok(!/[_/]|Json|pointer|moduleId/i.test(descriptor.label),
      `${moduleId}${pattern} label reads as English, not as a field name`);
    if (descriptor.kind === 'choice') {
      ok(Array.isArray(descriptor.options) && descriptor.options.length > 1,
        `${moduleId}${pattern} offers real choices`);
    }
  }
}

/* ------------------------------------------------ 5. every hidden path says why */

for (const [pattern, reason] of Object.entries(HIDDEN_PATHS)) {
  ok(typeof reason === 'string' && reason.length > 20,
    `${pattern} records WHY it is hidden, so hiding stays a decision`);
  ok(pattern.startsWith('/'), `${pattern} is a JSON pointer pattern`);
}
ok(isHiddenModulePath('/scenarios/0/annualCostTodayPerChild'),
  'hiding a subtree hides everything inside it');
ok(!isHiddenModulePath('/currentCashSavings'),
  'a hidden path does not accidentally hide a longer name that merely starts the same way');

/* ------------------------------------------------------- 6. collections */

// Only collections that genuinely repeat get "+ Add". Half the modules take
// scalars only, and giving those an add button would be inventing structure.
equal(Object.keys(MODULE_INPUT_DISPLAY.liquidity_analysis.collections).length, 0,
  'the cash reserve check has no repeatable inputs');
equal(Object.keys(MODULE_INPUT_DISPLAY.mortgage_analysis.collections).length, 0,
  'a mortgage review has no repeatable inputs');
equal(Object.keys(MODULE_INPUT_DISPLAY.loan_analysis.collections).length, 0,
  'a loan review has no repeatable inputs');

for (const moduleId of DISPLAYABLE_MODULE_IDS) {
  for (const [path, spec] of Object.entries(MODULE_INPUT_DISPLAY[moduleId].collections)) {
    equal(spec.path, path, `${moduleId}${path} knows its own path`);
    ok(spec.addLabel && spec.noneLabel,
      `${moduleId}${path} can both add one row and declare there are none`);
    // A completed row must collapse to something readable, or the card grows
    // without bound as the conversation succeeds.
    const titlePattern = `${path}/*/${spec.titleField}`;
    ok(MODULE_INPUT_DISPLAY[moduleId].fields[titlePattern]?.itemTitle === true,
      `${moduleId}${path} has a title field a finished row can collapse to`);
    ok(Boolean(MODULE_INPUT_DISPLAY[moduleId].fields[`${path}/*/${spec.valueField}`])
      || isHiddenModulePath(`${path}/*/${spec.valueField}`),
      `${moduleId}${path} has a summary value for a finished row`);
  }
}

// A pension member is a PERSON, not a policy. If this ever reads like a pot,
// the card will ask someone to add a row per pension and double their age.
ok(/A member IS a person here/.test(
  (await import('node:fs')).readFileSync(new URL('../js/planning/module_input_display.js', import.meta.url), 'utf8')
), 'the pensions collection records that a row is a person');

/* -------------------------------------------------------- 7. pointer maths */

equal(displayPointerPattern('/pensions/0/currentPot'), '/pensions/*/currentPot', 'indices normalise');
equal(displayPointerPattern('/pensions/12/currentPot'), '/pensions/*/currentPot', 'multi-digit indices normalise');
equal(displayPointerPattern('/currentCash'), '/currentCash', 'scalars are unchanged');
equal(collectionPathForPointer('/assetPositions/2/amount'), '/assetPositions', 'a row knows its collection');
equal(collectionPathForPointer('/currentCash'), '', 'a scalar belongs to no collection');
equal(collectionIndexForPointer('/assetPositions/2/amount'), 2, 'a row knows its index');
equal(collectionIndexForPointer('/currentCash'), -1, 'a scalar has no index');
ok(describeModuleCollection('college_funding', '/children'), 'children are a collection');
equal(describeModuleCollection('liquidity_analysis', '/children'), null, 'not for a module without one');
equal(describeModuleField('house_purchase', '/targetPropertyPrice'), null,
  'an out-of-scope module describes nothing, so it falls back to plain chat');

/* -------------------------------------------- 8. the card composes sentences */

// A card answer must reach the planner as words the client could have typed,
// and must be quotable exactly once -- the planner drops a citation whose quote
// is ambiguous, and drops the value with it.
equal(composeCardTurn([
  { label: 'Retirement age', value: '65' },
  { label: 'Your contribution', value: '6%' }
]), 'Retirement age: 65\nYour contribution: 6%', 'each answer is one plain line');

equal(composeCardTurn([
  { label: 'Retirement age', value: '65' },
  { label: 'Retirement age', value: '65' }
]), 'Retirement age: 65', 'an identical line is never emitted twice');

equal(composeCardTurn([
  { label: 'Retirement age', value: '' },
  { label: '', value: '65' },
  { label: 'Pension value today', value: '185000' }
]), 'Pension value today: 185000', 'unanswered fields are simply absent, never blank lines');

equal(composeCardTurn([]), '', 'nothing filled in composes nothing');
equal(composeCardTurn(null), '', 'a malformed card composes nothing rather than throwing');

// Two DIFFERENT answers that happen to share a value stay distinct, because the
// label is part of the line.
ok(composeCardTurn([
  { label: 'Your contribution', value: '6%' },
  { label: 'Employer contribution', value: '6%' }
]).split('\n').length === 2, 'two fields with the same value remain two quotable lines');

// Free text survives untouched: "about 65" must reach the planner as "about
// 65", because hedging is meaning and this file is not allowed to interpret it.
ok(composeCardTurn([{ label: 'Retirement age', value: 'about 65' }]).includes('about 65'),
  'a hedged answer is passed through verbatim, for the planner to interpret');

console.log(`[ModuleInputDisplay] ${checks} checks passed across ${DISPLAYABLE_MODULE_IDS.length} modules.`);
