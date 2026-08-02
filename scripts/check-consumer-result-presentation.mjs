/**
 * What a client actually reads on the results page.
 *
 * Every fault below reached a real client-facing page, found by rendering a
 * finished agent-driven call through the real view code. They all had one
 * cause: the card was built by REFLECTING over a module's internal
 * `semanticResult` and guessing presentation from how each key happened to be
 * spelled. Only liquidity_analysis and house_purchase had hand-written metric
 * lists, so the two modules anyone looked at never took that path.
 */

import assert from 'node:assert/strict';

/* ------------------------------------------------------------- DOM shim */
// Matches scripts/render-client-results.mjs. views.js is browser code and this
// repo carries no dependencies.

class ShimNode {
  constructor(tag) {
    this.tagName = String(tag).toLowerCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = new Proxy({}, { set: () => true, get: () => undefined });
    this.classList = { add: () => {}, remove: () => {}, toggle: () => {} };
  }
  set className(value) { this.attributes.set('class', String(value)); }
  get className() { return this.attributes.get('class') || ''; }
  set textContent(value) { this.children = [String(value)]; }
  get textContent() {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set type(value) { this.attributes.set('type', String(value)); }
  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
  append(...nodes) {
    nodes.flat().filter((n) => n !== null && n !== undefined && n !== false)
      .forEach((n) => this.children.push(n));
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  querySelector() { return null; }
  addEventListener() {}
  /** Every [label, value] pair the card renders, in order. */
  pairs() {
    const out = [];
    const walk = (node) => {
      if (typeof node === 'string') return;
      if (node.className === 'metric-item') {
        const [dt, dd] = node.children;
        out.push([dt?.textContent ?? '', dd?.textContent ?? '']);
        return;
      }
      node.children.forEach(walk);
    };
    walk(this);
    return out;
  }
}

globalThis.document = { createElement: (tag) => new ShimNode(tag), getElementById: () => null };
globalThis.window = { location: { hash: '' }, matchMedia: () => ({ matches: false }) };

const { createResultsView } = await import('../js/plan/views.js');

let checks = 0;
const check = (label, condition, detail = '') => {
  checks += 1;
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
};

const render = (results) => createResultsView({
  analysis: { results },
  analysisPlan: { moduleSlots: results.map((item) => ({ moduleId: item.moduleId })) },
  bootstrap: { handoffEnabled: false },
  stage: 'results'
}).pairs();

/* ------------------------------------------------------------------ */

{
  // The exact shape a module publishes: an authored table plus an internal
  // semantic result carrying renderer metadata and enums.
  const pairs = render([{
    moduleId: 'pension_projection',
    status: 'complete',
    outputs: {
      columns: ['Output', 'Value'],
      rows: [
        ['Projected pot at target start (current)', '€422,748'],
        ['Max-contribution gap vs required', '€355,527'],
        ['Retirement income position', 'This is a strong position.']
      ]
    },
    semanticResult: {
      currency: 'EUR',
      projectedPotAtRetirement: 2_195_539.05,
      projectedPotAtIncomeStart: 1_017_100,
      readinessStatus: 'currentOnTrack',
      retirementYear: 2029
    }
  }]);
  const labels = pairs.map(([label]) => label);
  const values = pairs.map(([, value]) => value);

  // The four faults, each asserted by absence.
  check('the internal currency metadata is not shown as a result',
    !labels.includes('Currency'), JSON.stringify(labels));
  check('a raw internal enum never reaches the page',
    !values.includes('currentOnTrack'), JSON.stringify(values));
  check('an unformatted money figure is not shown beside a formatted one',
    !values.some((value) => /^\d[\d,]*\.\d{2}$/.test(String(value))), JSON.stringify(values));
  check('a year is not grouped as a quantity',
    !values.includes('2,029'), JSON.stringify(values));

  // And by presence: the module's own table is what is rendered.
  check('the module\'s authored labels are used', labels.includes('Projected pot at target start (current)'));
  check('its own formatting is preserved', values.includes('€422,748'));
  check('an authored label is NOT rewritten',
    labels.includes('Max-contribution gap vs required'),
    'humanise() turns "Max-contribution" into "Max contribution"');
}

{
  // The module knows which of its numbers are money; the view must not guess.
  // "spendable reserves" matched a currency heuristic and "gross assets" did
  // not, so two figures on one card came out in different shapes.
  const pairs = render([{
    moduleId: 'personal_balance_sheet',
    status: 'complete',
    outputs: {
      columns: ['Metric', 'Value'],
      rows: [
        ['Gross assets', '€650,000'],
        ['Net worth', '€470,000'],
        ['Reserve months', '10 months']
      ]
    },
    semanticResult: { currency: 'EUR', grossAssets: 650_000, reserveMonths: 10 }
  }]);
  const values = pairs.map(([, value]) => value);
  check('every money figure on one card is shaped the same way',
    values.filter((value) => /^€/.test(String(value))).length === 2, JSON.stringify(values));
  check('months are months, not euro',
    values.includes('10 months') && !values.includes('€10'), JSON.stringify(values));
}

{
  // A module that publishes no table still renders, via the reflection path --
  // which must no longer leak metadata or enums either.
  const pairs = render([{
    moduleId: 'some_future_module',
    status: 'complete',
    semanticResult: { currency: 'EUR', readinessStatus: 'currentOnTrack', retirementYear: 2029 }
  }]);
  const labels = pairs.map(([label]) => label);
  const values = pairs.map(([, value]) => value);
  check('the fallback path drops renderer metadata too', !labels.includes('Currency'));
  check('the fallback path humanises a leaked enum',
    !values.includes('currentOnTrack'), JSON.stringify(values));
  check('the fallback path does not group a year',
    !values.includes('2,029'), JSON.stringify(values));
}

console.info(`[ResultPresentation] ${checks} checks passed: the client's page shows the module's own `
  + 'table, with no internal enum, metadata row, grouped year or unformatted money.');
