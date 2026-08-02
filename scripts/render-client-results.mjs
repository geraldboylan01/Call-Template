// Render a finished call EXACTLY as the client sees it.
//
//   node ./scripts/render-client-results.mjs agent-calls/easy-result.json
//   node ./scripts/render-client-results.mjs agent-calls/easy-result.json --out=client.html
//
// FREE. No model calls.
//
// WHY THIS EXISTS. Reviewing a test call from a summary is reviewing someone
// else's reading of it. The question "is this any good?" is about the page the
// client actually lands on -- its headings, its wording, its ordering, the
// disclaimers around the numbers -- and none of that survives being retyped
// into a report.
//
// So this drives the REAL client renderer, `createResultsView` from
// js/plan/views.js, the same function the live app calls, and serialises what
// it produces with the real stylesheet inlined. Nothing here re-implements the
// page; if the client's view changes, this changes with it.
//
// The DOM shim below exists because this repo has no dependencies and that is
// worth keeping. It implements only what views.js actually uses.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

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
      toggle: () => {}
    };
  }

  set className(value) { this.attributes.set('class', String(value)); }
  get className() { return this.attributes.get('class') || ''; }

  set textContent(value) { this.children = [escapeText(value)]; }
  get textContent() {
    return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }

  // `type`, `href` and friends are set as plain properties by views.js.
  set type(value) { this.attributes.set('type', String(value)); }
  set href(value) { this.attributes.set('href', String(value)); }
  set id(value) { this.attributes.set('id', String(value)); }
  set hidden(value) { if (value) this.attributes.set('hidden', ''); else this.attributes.delete('hidden'); }

  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
  removeAttribute(name) { this.attributes.delete(String(name)); }

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
  getElementById: () => null,
  querySelector: () => null
};
globalThis.window = { location: { hash: '' }, matchMedia: () => ({ matches: false }) };

/* --------------------------------------------------------------- render */

const { createResultsView } = await import('../js/plan/views.js');

const args = process.argv.slice(2);
const resultPath = args.find((arg) => !arg.startsWith('--'));
const flag = (name, fallback = '') => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

if (!resultPath) {
  console.error('Usage: node ./scripts/render-client-results.mjs <call-result.json> [--out=<file.html>]');
  process.exit(1);
}

const record = JSON.parse(readFileSync(resultPath, 'utf8'));
const outPath = flag('out', resultPath.replace(/\.json$/, '')) + (flag('out') ? '' : '-client.html');

// The shape createResultsView reads. Only `analysis` carries content; the rest
// is the surrounding journey state, which a finished call has settled.
const currentState = {
  analysis: { results: record.results || [] },
  analysisPlan: { moduleSlots: (record.execution?.moduleIds || []).map((moduleId) => ({ moduleId })) },
  bootstrap: { handoffEnabled: false },
  stage: 'results'
};

const view = createResultsView(currentState);
const css = readFileSync(new URL('../styles/plan.css', import.meta.url), 'utf8');

// Emitted without <!doctype>/<html>/<body> so the same file opens locally in a
// browser AND publishes as an artifact, which supplies that skeleton itself.
writeFileSync(outPath, `<title>Your educational analysis — ${escapeText(record.callId || basename(resultPath))}</title>
<style>
${css}
/* The real page is a full app shell; this is the results view alone, so give it
   the page background and breathing room the shell would have provided. */
:where(main.plan-shell){max-width:1100px;margin:0 auto;padding:2rem 1.25rem 5rem}
</style>
<main class="plan-shell" id="plan-root">
${view.toHtml()}
</main>
`);

const moduleIds = (record.results || []).map((item) => item.moduleId);
console.info(`Rendered ${moduleIds.length} analysis card(s) with the real client view: ${moduleIds.join(', ') || 'none'}`);
console.info(`Written to ${outPath}`);
