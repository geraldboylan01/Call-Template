#!/usr/bin/env node

/**
 * THE LIQUIDITY RENDERER, DRIVEN FOR REAL.
 *
 * THE DEFECT THIS PINS. `computeLiquidityAssessment` in js/render.js decided
 * two labels — the reserve readout and the target-buffer caption — by reading
 * a bare `retired` that nothing in the file ever declared. Every Liquidity
 * render therefore threw `retired is not defined` (`Can't find variable:
 * retired` in WebKit, which is what the Dev Payload Tester reported) before it
 * drew a single card. It was not a payload-validation failure: `clientLabel`
 * reads the identifier unconditionally, so supplying `minimumBufferMonths` and
 * `targetBufferMonths` explicitly did not avoid it, and neither did omitting
 * `clientStatus`. The module was unrenderable for every payload.
 *
 * The payload contract in MASTER_PROJECT_PROMPT.md has no `retired` field and
 * is not gaining one. Retirement is a status — `clientStatus: "retired"` —
 * and the cohort is derived from it, the same value the policy lookup already
 * consumes.
 *
 * WHAT THIS CHECK DOES. It renders through the app's own entry points,
 * `buildFocusedPane` (js/app.js:9212) and `buildOverviewPreviewDescriptor`
 * (the overview path), with no stubbing of the Liquidity code itself, and
 * reads the buffer months back off the produced markup. A `ReferenceError`
 * anywhere in that path fails the run rather than being caught and summarised.
 *
 * The DOM shim below exists because this repo has no dependencies and that is
 * worth keeping. It implements only what the Liquidity renderer actually uses.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const pass = (message) => console.info(`[LiquidityRender] PASS: ${message}`);

/* ------------------------------------------------------------- DOM shim */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'hr', 'img', 'input', 'link', 'meta', 'source']);

const escapeText = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (value) => escapeText(value).replace(/"/g, '&quot;');

class ShimNode {
  constructor(tag) {
    this.tagName = String(tag).toLowerCase();
    this.children = [];
    this.attributes = new Map();
    this.styleProperties = new Map();
    this.style = {
      setProperty: (name, value) => this.styleProperties.set(String(name), String(value)),
      removeProperty: (name) => this.styleProperties.delete(String(name)),
      getPropertyValue: (name) => this.styleProperties.get(String(name)) ?? ''
    };
    // `sanitizeSummaryHtml` builds a <template> and walks `content`. Summary
    // HTML in these cases is fixture-authored, so an empty walk is faithful.
    this.content = { querySelectorAll: () => [] };
    this.dataset = new Proxy({}, {
      set: (target, key, value) => {
        this.attributes.set(`data-${String(key).replace(/([A-Z])/g, '-$1').toLowerCase()}`, String(value));
        target[key] = value;
        return true;
      },
      get: (target, key) => target[key]
    });
    this.classList = {
      add: (...names) => {
        const current = new Set(String(this.attributes.get('class') || '').split(/\s+/).filter(Boolean));
        names.forEach((name) => current.add(name));
        this.attributes.set('class', [...current].join(' '));
      },
      remove: (...names) => {
        const current = new Set(String(this.attributes.get('class') || '').split(/\s+/).filter(Boolean));
        names.forEach((name) => current.delete(name));
        this.attributes.set('class', [...current].join(' '));
      },
      contains: () => false,
      toggle: () => {}
    };
  }

  set className(value) { this.attributes.set('class', String(value)); }
  get className() { return this.attributes.get('class') || ''; }

  set textContent(value) { this.children = [escapeText(value)]; }
  get textContent() {
    return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }

  set innerHTML(value) { this.children = [String(value)]; }
  get innerHTML() {
    return this.children.map((child) => (typeof child === 'string' ? child : child.toHtml())).join('');
  }

  set type(value) { this.attributes.set('type', String(value)); }
  set href(value) { this.attributes.set('href', String(value)); }
  set id(value) { this.attributes.set('id', String(value)); }
  set value(value) { this.attributes.set('value', String(value)); }
  set disabled(value) { if (value) this.attributes.set('disabled', ''); else this.attributes.delete('disabled'); }
  set hidden(value) { if (value) this.attributes.set('hidden', ''); else this.attributes.delete('hidden'); }

  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
  removeAttribute(name) { this.attributes.delete(String(name)); }
  hasAttribute(name) { return this.attributes.has(String(name)); }

  appendChild(node) {
    this.children.push(typeof node === 'string' ? escapeText(node) : node);
    return node;
  }

  append(...nodes) {
    nodes.flat().filter((node) => node !== null && node !== undefined && node !== false)
      .forEach((node) => this.children.push(typeof node === 'string' ? escapeText(node) : node));
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  remove() {}
  addEventListener() {}

  toHtml() {
    const attributes = [...this.attributes.entries()]
      .map(([name, value]) => (value === '' ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`))
      .join('');
    if (VOID_TAGS.has(this.tagName)) return `<${this.tagName}${attributes}>`;
    const inner = this.children
      .map((child) => (typeof child === 'string' ? child : child.toHtml()))
      .join('');
    return `<${this.tagName}${attributes}>${inner}</${this.tagName}>`;
  }
}

globalThis.document = {
  createElement: (tag) => new ShimNode(tag),
  createElementNS: (_namespace, tag) => new ShimNode(tag),
  createDocumentFragment: () => new ShimNode('fragment'),
  createTextNode: (text) => escapeText(text),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => []
};
globalThis.window = {
  location: { hash: '', href: 'https://planeir.test/' },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  getComputedStyle: () => ({}),
  requestAnimationFrame: (callback) => { if (typeof callback === 'function') callback(0); return 0; }
};
globalThis.HTMLElement = ShimNode;
globalThis.Node = ShimNode;
globalThis.requestAnimationFrame = () => 0;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const render = await import(resolve(REPO, 'js/render.js'));
const { liquidityConversationGuidance } = await import(resolve(REPO, 'js/liquidity_reserve.js'));

/* ----------------------------------------------------- bare-identifier scan */

/**
 * Blank out every comment, string, template and regex literal, preserving the
 * source's length and line breaks so offsets still map back to line numbers.
 *
 * A regex-based version of this collapsed js/render.js from 480k characters to
 * 28k -- a naive template-literal pattern cannot survive nested `${}` -- and
 * silently reported a clean file. What is left here is a small state machine
 * that walks the text once, which is the only form of this that can be trusted.
 */
function stripNonCode(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  // What a `/` means depends on what came before it: a value means division,
  // anything else starts a regex literal.
  const DIVISION_AFTER = /[\w$)\]]/;
  const stack = [{ template: false, braces: 0 }];
  let i = 0;
  let lastSignificant = '';

  while (i < source.length) {
    const top = stack[stack.length - 1];
    const ch = source[i];
    const next = source[i + 1];

    if (top.template) {
      if (ch === '\\') { blank(i, i + 2); i += 2; continue; }
      if (ch === '`') { stack.pop(); lastSignificant = '`'; i += 1; continue; }
      // `${` re-enters code, which may itself hold templates and strings.
      if (ch === '$' && next === '{') { stack.push({ template: false, braces: 0 }); i += 2; continue; }
      blank(i, i + 1); i += 1; continue;
    }

    if (ch === '/' && next === '/') {
      let j = i;
      while (j < source.length && source[j] !== '\n') j += 1;
      blank(i, j); i = j; continue;
    }
    if (ch === '/' && next === '*') {
      let j = i + 2;
      while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) j += 1;
      j = Math.min(j + 2, source.length);
      blank(i, j); i = j; continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      blank(i + 1, j); lastSignificant = ch; i = Math.min(j + 1, source.length); continue;
    }
    if (ch === '`') { stack.push({ template: true, braces: 0 }); i += 1; continue; }
    if (ch === '{') { top.braces += 1; lastSignificant = ch; i += 1; continue; }
    if (ch === '}') {
      if (top.braces === 0 && stack.length > 1) { stack.pop(); i += 1; continue; }
      top.braces -= 1; lastSignificant = ch; i += 1; continue;
    }
    if (ch === '/' && !DIVISION_AFTER.test(lastSignificant)) {
      let j = i + 1;
      let inCharacterClass = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') inCharacterClass = true;
        else if (c === ']') inCharacterClass = false;
        else if (c === '/' && !inCharacterClass) break;
        else if (c === '\n') break;
        j += 1;
      }
      blank(i + 1, j); lastSignificant = '/'; i = Math.min(j + 1, source.length); continue;
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }
  return out.join('');
}

/** Line numbers where `retired` is read as a standalone variable. */
function findBareRetired(source) {
  const code = stripNonCode(source);
  const lines = [];
  const bare = /(?<![.$\w])retired(?![\w$])/g;
  let match;
  while ((match = bare.exec(code)) !== null) {
    // `retired:` is an object key, not a variable read.
    if (/^\s*:/.test(code.slice(match.index + 'retired'.length))) continue;
    lines.push(code.slice(0, match.index).split('\n').length);
  }
  return lines;
}

/* ------------------------------------------------------------- fixtures */

/**
 * A payload with everything the module needs EXCEPT the retirement contract,
 * so each case below varies only the thing under test. `targetLabel` is
 * deliberately absent: supplying it short-circuits the cohort branch, and the
 * branch is the point.
 */
const liquidityModule = (liquidityPlan) => ({
  id: 'liquidity-under-test',
  title: 'Liquidity Plan - Client',
  notes: '',
  generated: {
    summaryHtml: '<p>Cash position for the call.</p>',
    liquidityPlan: {
      currencySymbol: '€',
      annualExpenditure: 60000,
      currentCash: 90000,
      ...liquidityPlan
    }
  }
});

/**
 * Render through the pane the app builds for a focused module, and read the
 * cohort decision back out of the markup rather than out of an internal.
 */
function renderLiquidity(liquidityPlan) {
  const pane = render.buildFocusedPane({
    module: liquidityModule(liquidityPlan),
    moduleNumber: 1,
    readOnly: true
  });
  const html = pane.toHtml();
  const months = (caption) => {
    const match = html.match(new RegExp(`${caption}:\\s*([\\d.,]+)\\s*months`));
    assert.ok(match, `Rendered Liquidity markup should state "${caption}". Got:\n${html}`);
    return Number(match[1].replace(/,/g, ''));
  };
  const label = html.match(/<span class="liquidity-readout-label">([^<]*)<\/span>/);
  assert.ok(label, `Rendered Liquidity markup should carry a reserve readout label. Got:\n${html}`);
  return {
    html,
    clientLabel: label[1],
    minimumBufferMonths: months('Safety floor'),
    targetBufferMonths: months('Target buffer')
  };
}

/* ------------------------------------------- 1. retired takes 12/24 */

{
  const rendered = renderLiquidity({ clientStatus: 'retired' });
  assert.equal(rendered.minimumBufferMonths, 12);
  assert.equal(rendered.targetBufferMonths, 24);
  assert.equal(rendered.clientLabel, 'Retired reserve');
  assert.match(rendered.html, /24 months retired reserve/);
  pass('clientStatus "retired" renders the 12/24 policy buffer and the retired label.');
}

/* --------------------------------------- 2. not-retired takes 3/6 */

{
  const rendered = renderLiquidity({ clientStatus: 'not-retired' });
  assert.equal(rendered.minimumBufferMonths, 3);
  assert.equal(rendered.targetBufferMonths, 6);
  assert.equal(rendered.clientLabel, 'Working reserve');
  assert.match(rendered.html, /6 months emergency fund/);
  pass('clientStatus "not-retired" renders the 3/6 policy buffer and the working label.');
}

/* ---------- 3. explicit 12/24 with clientStatus omitted still renders */

{
  // The exact payload the Dev Payload Tester failed on. It must render, and
  // the omitted status must fall back to the working cohort for the LABEL
  // while the supplied months stand.
  const rendered = renderLiquidity({ minimumBufferMonths: 12, targetBufferMonths: 24 });
  assert.equal(rendered.minimumBufferMonths, 12);
  assert.equal(rendered.targetBufferMonths, 24);
  assert.equal(rendered.clientLabel, 'Working reserve');
  pass('Explicit 12/24 with no clientStatus renders instead of throwing.');
}

{
  const rendered = renderLiquidity({});
  assert.equal(rendered.minimumBufferMonths, 3);
  assert.equal(rendered.targetBufferMonths, 6);
  assert.equal(rendered.clientLabel, 'Working reserve');
  pass('An omitted clientStatus defaults to the working cohort rather than failing.');
}

/* ------------------------- 4. explicit months beat the status defaults */

{
  const retiredOverridden = renderLiquidity({
    clientStatus: 'retired',
    minimumBufferMonths: 3,
    targetBufferMonths: 6
  });
  assert.equal(retiredOverridden.minimumBufferMonths, 3);
  assert.equal(retiredOverridden.targetBufferMonths, 6);
  // The cohort still governs the wording; only the months were overridden.
  assert.equal(retiredOverridden.clientLabel, 'Retired reserve');

  const workingOverridden = renderLiquidity({
    clientStatus: 'not-retired',
    minimumBufferMonths: 12,
    targetBufferMonths: 24
  });
  assert.equal(workingOverridden.minimumBufferMonths, 12);
  assert.equal(workingOverridden.targetBufferMonths, 24);
  assert.equal(workingOverridden.clientLabel, 'Working reserve');

  pass('Explicit minimumBufferMonths/targetBufferMonths override the status defaults in both directions.');
}

/* ------ 5. no Liquidity path reads an undefined bare `retired` variable */

{
  // (a) EXECUTION. Every Liquidity rendering entry point, across the payload
  // matrix, including the shapes that reach the cohort branch. A
  // ReferenceError here is a failure, not a caught-and-reported condition.
  const payloads = [
    {},
    { clientStatus: 'retired' },
    { clientStatus: 'not-retired' },
    { clientStatus: 'RETIRED' },
    { clientStatus: '' },
    { clientStatus: null },
    { minimumBufferMonths: 12, targetBufferMonths: 24 },
    { clientStatus: 'retired', minimumBufferMonths: 3, targetBufferMonths: 6 },
    { currentCash: 0 },
    { annualExpenditure: undefined, monthlyExpenditure: 5000, clientStatus: 'retired' },
    { annualExpenditure: undefined, currentCash: undefined },
    { currentCash: 400000, clientStatus: 'retired' },
    { targetLabel: 'Custom reserve', clientStatus: 'retired' }
  ];

  for (const payload of payloads) {
    const shape = JSON.stringify(payload);
    const module = liquidityModule(payload);
    render.buildFocusedPane({ module, moduleNumber: 1, readOnly: true }).toHtml();
    const descriptor = render.buildOverviewPreviewDescriptor(module);
    assert.equal(descriptor.moduleKind.token, 'liquidity', `Overview should treat ${shape} as Liquidity.`);
  }
  // The engine's own guidance text destructures `retired` from the policy; run
  // it so that legitimate binding is proved rather than assumed.
  assert.equal(liquidityConversationGuidance().length, 3);
  pass(`Every Liquidity rendering entry point runs clean across ${payloads.length} payload shapes.`);

  // (b) STATIC. Execution only proves the branches it takes. js/render.js has
  // no legitimate `retired` binding of its own -- the cohort is always derived
  // from clientStatus -- so a bare `retired` token anywhere in the file is the
  // defect returning, possibly in a branch no fixture reaches. (The same rule
  // cannot be applied to js/liquidity_reserve.js, which destructures a real
  // `retired` off the policy object; that binding is exercised above instead.)
  const offenders = findBareRetired(readFileSync(resolve(REPO, 'js/render.js'), 'utf8'));

  assert.deepEqual(
    offenders,
    [],
    'js/render.js reads a bare `retired` variable at line(s) '
      + `${offenders.join(', ')}. Retirement state is derived from `
      + '`liquidityPlan.clientStatus === "retired"`; there is no `retired` '
      + 'payload field and no `retired` binding in this file, so this throws '
      + 'at runtime the moment the line is reached.'
  );
  pass('js/render.js contains no bare `retired` variable read.');
}

console.info('[LiquidityRender] All Liquidity rendering checks passed.');
