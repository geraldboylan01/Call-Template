export const euros = micros => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format((micros || 0) / 1000000);
export const analystElement = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const el = analystElement;
export function renderAnalystReview(root, data) {
  root.replaceChildren(el('h2', data.status === 'accepted' ? 'Draft ready for review' : 'Analysis progress'));
  root.append(el('p', `${data.stage || 'queued'} · ${data.status} · ${data.turns || 0} model turns`));
  if (data.createdAt) root.append(el('p', `${Math.max(0, (Date.parse(data.finishedAt || new Date().toISOString()) - Date.parse(data.createdAt)) / 60000).toFixed(1)} minutes elapsed${data.model ? ' · ' + data.model + ' · ' + data.reasoningEffort : ''}`));
  const spend = data.spend;
  root.append(el('p', `${euros(spend?.knownActualEurMicros)} token cost at configured EUR rates · ${euros(spend?.reservedOrUnknownEurMicros)} reserved or uncertain · ${euros(spend?.limitEurMicros)} run cap`, 'analyst-spend'));
  const usage = data.usage || {};
  root.append(el('p', `${usage.pricingCalls || 0} pricing calls · ${usage.compilerRuns || 0} compiler runs`));
  const tokens = (data.events || []).filter(row => row.type === 'model').reduce((sum, row) => {
    for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens']) sum[key] = (sum[key] || 0) + (row[key] || 0);
    return sum;
  }, {});
  root.append(el('p', `Tokens: ${tokens.inputTokens || 0} input (${tokens.cachedInputTokens || 0} cached), ${tokens.outputTokens || 0} output (${tokens.reasoningTokens || 0} reasoning).`));
  if (data.active) root.append(el('p', `${data.active.name || 'Model turn ' + data.active.turn} · ${data.active.status}`, 'analyst-active'));
  const timeline = el('ol', undefined, 'analyst-timeline');
  for (const row of data.events || []) {
    const item = el('li'), detail = el('details');
    const name = row.name || (row.type === 'model' ? `Model turn ${row.turn}` : 'Run');
    detail.append(el('summary', `${name} · ${row.status}${row.costEurMicros !== undefined ? ' · ' + euros(row.costEurMicros) : ''}`));
    detail.append(el('p', row.at ? new Date(row.at).toLocaleString('en-IE', { timeZone: 'Europe/Dublin' }) : ''));
    if (row.message) detail.append(el('p', row.message));
    if (row.usage) detail.append(el('p', `${row.usage.pricingCalls || 0} pricing calls · ${row.usage.compilerRuns || 0} compiler runs`));
    for (const refusal of row.refusals || []) detail.append(el('p', `${refusal.path}: ${refusal.message} (${refusal.code})`, 'analyst-refusal'));
    if (row.type === 'model') detail.append(el('p', `${row.inputTokens} input · ${row.cachedInputTokens} cached · ${row.outputTokens} output · ${row.reasoningTokens} reasoning tokens`));
    item.append(detail); timeline.append(item);
  }
  root.append(timeline);
  if (data.status !== 'accepted' && data.modelMessages?.length) {
    const message = el('details'); message.open = true;
    message.append(el('summary', 'Analyst message'), el('pre', data.modelMessages.at(-1))); root.append(message);
  }
  if (data.checkerReports?.length) {
    const checker = el('details'); checker.append(el('summary', 'Checker reports'), el('pre', JSON.stringify(data.checkerReports, null, 2))); root.append(checker);
  }
  if (data.versions) { const versions = el('details'); versions.append(el('summary', 'Pinned versions'), el('pre', JSON.stringify(data.versions, null, 2))); root.append(versions); }
  const log = el('a', 'Read the full run log'); log.href = `./analyst.html?run=${encodeURIComponent(data.runId)}&log=1`; root.append(log);
}

export function attachAnalystReview(data) {
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('../styles/analyst.css', import.meta.url); document.head.append(link);
  const aside = el('aside', undefined, 'analyst-review'); aside.setAttribute('aria-label', 'Analyst checker and run log');
  const close = el('button', 'Hide review', 'ui-button'); close.type = 'button';
  const reopen = el('button', 'Show analyst review', 'ui-button analyst-review-reopen'); reopen.type = 'button'; reopen.hidden = true;
  const body = el('div'); renderAnalystReview(body, data); aside.append(close, body); document.body.append(aside); document.body.classList.add('analyst-story-review');
  document.body.append(reopen);
  close.addEventListener('click', () => { aside.hidden = true; reopen.hidden = false; document.body.classList.remove('analyst-story-review'); });
  reopen.addEventListener('click', () => { aside.hidden = false; reopen.hidden = true; document.body.classList.add('analyst-story-review'); });
}
