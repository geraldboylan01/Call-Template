// The report a refresh prints, and the body of the PR it opens. One document for
// both, so what Gerry reads in the PR is what the dry run showed.
//
// It leads with what moved, then what needs a person, then the evidence: every
// quote as printed, and every page read. Nothing in it is worked out here: values
// come from the plan, which got them from `market_math.js`.

import { daysBetween, figureWarnings } from '../../../js/planning/figures/checks.js';
import { formatFigureValue } from '../../../js/planning/figures/format.js';
import { summarisePlan } from './plan.mjs';
import { savedPageName } from './pages.mjs';

/** The checks that pin the central cash rate. The job never edits them. */
export const CASH_RATE_ID = 'ie.market.cash.instant_access_gross_rate';
export const CASH_RATE_GOLDENS = Object.freeze([
  'scripts/check-future-cost-fund.mjs',
  'scripts/check-goals-and-resources.mjs',
  'js/tests_future_cost_fund_math.js'
]);

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const percent = (value) => formatFigureValue(value, 'rate');
const shown = (figure, value) => formatFigureValue(value, figure.unit);
const points = (value) => `${(value * 100).toFixed(2)} percentage points`;
const dateOrDash = (iso) => iso ?? 'not printed';

/** The register's own warnings, as they will read once this refresh is merged. */
export function registerWarningsAfter(plan, registerFigures) {
  const byId = new Map(plan.figures.map((figure) => [figure.id, figure]));
  const patched = registerFigures.map((figure) => {
    const planned = byId.get(figure.id);
    if (figure.kind !== 'market' || !planned) return figure;
    const evidence = planned.reviewed?.evidenceAfter;
    return {
      ...figure,
      checkedOn: planned.checkedOn.after,
      valueShown: shown(planned, planned.valueAfter),
      ...(evidence ? { evidence } : {})
    };
  });
  return figureWarnings(patched, plan.today);
}

/** Quotes whose last read is older than their figure's review interval: a page the job keeps failing to read. */
export function staleQuotes(plan) {
  return plan.figures.flatMap((figure) => figure.quotes
    .map((quote) => ({ figure, quote, age: daysBetween(quote.after.retrievedOn, plan.today) }))
    .filter(({ age }) => age > figure.reviewEveryDays));
}

function movedLine(figure, quote) {
  const parts = [];
  if (quote.changedFields.includes('value')) parts.push(`${percent(quote.before.value)} to ${percent(quote.after.value)}`);
  if (quote.changedFields.includes('effective')) parts.push(`effective ${dateOrDash(quote.before.effective)} to ${dateOrDash(quote.after.effective)}`);
  if (quote.changedFields.includes('url')) parts.push('now on a different page');
  if (quote.changedFields.includes('quotedAs')) parts.push('its description changed');
  return `- ${quote.sourceLabel}: ${parts.join('; ')}.`;
}

/**
 * The report, as Markdown.
 *
 * - `mode`: 'dry-run', 'applied' or 'pull-request', for the opening line (`intro` replaces it).
 * - `decision`: from `decideOnPullRequest`.
 * - `registerFigures`: the collected register, for the register's own warnings.
 * - `checks`: results of checks run on the branch, `[{ command, ok, output }]`.
 * - `pagesDir`: where browser-saved pages are looked for, to say where to save one.
 * - `format`: 'github' may use collapsible sections; 'terminal' stays plain.
 */
export function renderReport({ plan, decision, registerFigures, mode = 'dry-run', intro = null, checks = [], pagesDir = null, format = 'terminal' }) {
  const summary = summarisePlan(plan);
  const lines = [];
  const add = (...text) => lines.push(...text);

  const headline = summary.valuesChanged > 0
    ? `${summary.valuesChanged} figure value${summary.valuesChanged === 1 ? '' : 's'} changed`
    : (summary.quotesMoved > 0 ? `${summary.quotesMoved} quote${summary.quotesMoved === 1 ? '' : 's'} moved, no figure value changed` : 'no quote moved');
  add(`## Market figures, read on ${plan.today}: ${headline}`, '');
  add(
    intro ?? (mode === 'dry-run'
      ? 'This is a dry run. Nothing has been written.'
      : 'Read by `npm run refresh:market-figures`. Every number below is a rate a bank\'s page printed on the day it was read; none was typed in or taken from memory.'),
    ''
  );
  add(`Quotes read ${summary.quotesRead} of ${summary.quotesRead + summary.quotesUnread}.${summary.quotesUnread > 0 ? ` ${summary.quotesUnread} could not be read and were left as they were (below).` : ''} ${decision.openPullRequest ? `A pull request is warranted: ${decision.reasons.join('; ')}.` : 'Nothing moved, so no pull request is warranted.'}`, '');

  const moved = plan.figures.flatMap((figure) => figure.quotes.filter((quote) => quote.status === 'moved').map((quote) => movedLine(figure, quote)));
  if (moved.length > 0) add('### What moved', '', ...moved, '');

  // Figures
  add('### Figures', '', '| Figure | Was | Now | Version | Checked |', '|---|---|---|---|---|');
  for (const figure of plan.figures) {
    const now = figure.methodKind === 'reviewed'
      ? `${shown(figure, figure.valueAfter)} (held by a person; not changed by the job)`
      : (figure.valueChanged ? `**${shown(figure, figure.valueAfter)}**` : `${shown(figure, figure.valueAfter)} (unchanged)`);
    add(`| ${cell(figure.label)}<br>\`${figure.id}\` | ${shown(figure, figure.valueBefore)} | ${now} | ${figure.version.before}${figure.valueChanged ? ` to ${figure.version.after}` : ''} | ${figure.checkedOn.before}${figure.checkedOn.after !== figure.checkedOn.before ? ` to ${figure.checkedOn.after}` : ''} |`);
  }
  add('');
  if (plan.catalogueVersion.after !== plan.catalogueVersion.before) {
    add(`Catalogue version \`${plan.catalogueVersion.before}\` to \`${plan.catalogueVersion.after}\`.`, '');
  }

  // Quotes
  add('### Quotes, as printed', '', '| Source | As printed | Was | Now | Effective | Page |', '|---|---|---|---|---|---|');
  for (const figure of plan.figures) {
    for (const quote of figure.quotes) {
      if (quote.status === 'unread') {
        add(`| ${cell(quote.sourceLabel)} | not read | ${percent(quote.before.value)} | left as it was | ${dateOrDash(quote.before.effective)} | ${cell(quote.before.url)} |`);
        continue;
      }
      const same = quote.before.value === quote.after.value;
      add(`| ${cell(quote.sourceLabel)} | ${cell(quote.printed)} | ${percent(quote.before.value)} | ${same ? percent(quote.after.value) : `**${percent(quote.after.value)}**`} | ${dateOrDash(quote.after.effective)}${quote.before.effective !== quote.after.effective ? ` (was ${dateOrDash(quote.before.effective)})` : ''} | ${cell(quote.after.url)} |`);
    }
  }
  add('');

  // Needs a person
  const attention = [];
  const cashRate = plan.figures.find((figure) => figure.id === CASH_RATE_ID);
  if (cashRate?.valueChanged) {
    attention.push(
      `**The central cash rate moves from ${shown(cashRate, cashRate.valueBefore)} to ${shown(cashRate, cashRate.valueAfter)}.** These checks pin the old rate and will fail on this branch until a person reviews them: ${CASH_RATE_GOLDENS.map((file) => `\`${file}\``).join(', ')}. The job does not edit them.`
    );
  }
  for (const figure of plan.figures.filter((candidate) => candidate.valueChanged && candidate.id !== CASH_RATE_ID)) {
    attention.push(`**${figure.label}** moves from ${shown(figure, figure.valueBefore)} to ${shown(figure, figure.valueAfter)}. Anything that pins the old value in a golden check will fail until a person reviews it.`);
  }
  for (const figure of plan.figures.filter((candidate) => candidate.reviewed)) {
    const { held, evidenceBefore, evidenceAfter, driftWarnAt } = figure.reviewed;
    attention.push(
      `**${figure.label}** is held at ${shown(figure, held)} by a person and the job does not change it. The quotes now point to ${percent(evidenceAfter.median)} (was ${percent(evidenceBefore.median)}), ${points(Math.abs(evidenceAfter.gap))} ${evidenceAfter.gap >= 0 ? 'above' : 'below'} the held value.${evidenceAfter.drifted ? ` That is past the ${points(driftWarnAt)} warning point, so \`check:figures\` warns. Moving the held value is a decision: it changes every figure that uses it.` : ''}`
    );
  }
  for (const { figure, quote } of plan.figures.flatMap((figure) => figure.quotes.filter((quote) => quote.largeMove).map((quote) => ({ figure, quote })))) {
    attention.push(`**Large move, check it by eye:** ${quote.sourceLabel} went from ${percent(quote.before.value)} to ${percent(quote.after.value)} (as printed: ${quote.printed}). It was applied as printed.`);
  }
  for (const { figure, quote } of plan.figures.flatMap((figure) => figure.quotes.filter((quote) => quote.notes?.length).map((quote) => ({ figure, quote })))) {
    attention.push(`${quote.sourceLabel}: ${quote.notes.join('; ')}.`);
  }
  for (const { quote, age } of staleQuotes(plan)) {
    attention.push(`**Stale quote:** ${quote.sourceLabel} was last read ${age} days ago and has not been read since.`);
  }
  const warnings = registerFigures ? registerWarningsAfter(plan, registerFigures) : [];
  const marketWarnings = warnings.filter((warning) => warning.startsWith('ie.market.') && !/but its quotes now point to/.test(warning));
  const announced = warnings.filter((warning) => / is still announced and was last checked /.test(warning));
  for (const warning of marketWarnings) attention.push(`**Overdue:** ${warning}`);
  if (announced.length > 0) {
    const list = announced.map((warning) => warning.replace(/ is still announced and was last checked (\d+) days ago.*$/, ' ($1 days)'));
    attention.push(
      `**Announced law not checked for 90 days or more (${announced.length}).** These may have been enacted since. The job does not check law; it reports them.`
      + (format === 'github'
        ? `\n\n  <details><summary>The ${announced.length} figures</summary>\n\n${list.map((item) => `  - \`${item}\``).join('\n')}\n\n  </details>`
        : `\n${list.map((item) => `    - ${item}`).join('\n')}`)
    );
  }
  add('### Needs a person', '');
  if (attention.length === 0) add('Nothing.', '');
  else add(...attention.map((item) => `- ${item}`), '');

  // Not read
  const unread = plan.figures.flatMap((figure) => figure.quotes.filter((quote) => quote.status === 'unread').map((quote) => ({ figure, quote })));
  if (unread.length > 0) {
    add('### Could not be read (left as they were)', '');
    for (const { figure, quote } of unread) {
      add(`- **${quote.sourceLabel}** (${figure.id}): ${quote.reason}.`);
    }
    if (pagesDir) {
      add('', `Some sites refuse plain requests. For those, open the page in a browser, save its visible text into \`${pagesDir}\` with the file name below, and run again:`, '');
      for (const url of [...new Set(unread.flatMap(({ quote }) => (quote.urls ?? [])))].filter((candidate) => !/\.pdf($|\?)/i.test(candidate))) {
        add(`- ${url} as \`${savedPageName(url)}.txt\``);
      }
    }
    add('');
  }

  // Pages read
  const read = new Map();
  for (const quote of plan.figures.flatMap((figure) => figure.quotes)) {
    for (const page of quote.pages ?? []) read.set(page.url, page);
  }
  add('### Pages read', '');
  if (read.size === 0) add('None.');
  for (const page of read.values()) add(`- ${page.url} (${page.role}, ${page.how})`);
  add('');

  if (checks.length > 0) {
    add('### Checks run on this branch', '');
    for (const check of checks) add(`- \`${check.command}\`: ${check.ok ? 'passed' : '**failed**'}${check.ok || !check.output ? '' : `\n\n  \`\`\`\n${check.output.split('\n').map((line) => `  ${line}`).join('\n')}\n  \`\`\`\n`}`);
    add('');
  }

  if (mode === 'pull-request') {
    add('---', '', 'Opened by the weekly market-figures job (`docs/figures-market-refresh.md`). Merge it to accept the quotes, or close it to leave the register as it was; the job opens the next one from `main`.', '');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
