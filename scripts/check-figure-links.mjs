// Fetches the links the explainers cite and reports any that no longer resolve.
//
// `check:figures` is offline: it checks a link's shape and that it is an official
// page, but cannot fetch, because the gate runs without a network and gov.ie and
// Citizens Information refuse scripted requests. This is the other half: run it
// before a release and whenever an explainer is re-read.
//
//   npm run check:figure-links               every explainer source
//   npm run check:figure-links -- --all      every source link in the register
//   npm run check:figure-links -- --strict   a refusal from gov.ie or Citizens
//                                            Information also fails
//
// A page that answers 200 but says it is not found (Revenue does this) is broken.
// A refusal from a host that refuses scripts is "unverified": open those in a
// browser, and the exit code stays 0 unless --strict.

import { EXPLAINERS_INDEX, FIGURES_INDEX } from '../js/planning/figures/figures_index.generated.js';
import { classifyLinkResponse } from '../js/planning/figures/links.js';

const all = process.argv.includes('--all');
const strict = process.argv.includes('--strict');
const USER_AGENT = 'Mozilla/5.0 (compatible; PlaneirLinkCheck/1.0)';

const urls = new Map();
const note = (url, where) => {
  if (typeof url === 'string' && url.startsWith('https://')) urls.set(url, [...(urls.get(url) ?? []), where]);
};
for (const explainer of EXPLAINERS_INDEX) explainer.sources.forEach((source) => note(source.url, `explainer ${explainer.id}`));
if (all) for (const figure of FIGURES_INDEX) figure.sources.forEach((source) => note(source.url, `figure ${figure.id}`));

async function check(url) {
  const host = new URL(url).hostname;
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/pdf;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(30_000)
    });
    const type = response.headers.get('content-type') ?? '';
    const body = /text\/html/.test(type) ? await response.text() : '';
    return { url, host, ...classifyLinkResponse({ status: response.status, host, body }) };
  } catch (error) {
    return { url, host, ...classifyLinkResponse({ status: 0, host, error: error?.cause?.code ?? error?.message ?? 'no answer' }) };
  }
}

const results = [];
const queue = [...urls.keys()];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length > 0) results.push(await check(queue.shift()));
}));

const order = { broken: 0, refused: 1, ok: 2 };
results.sort((left, right) => order[left.result] - order[right.result] || left.url.localeCompare(right.url));
for (const { url, result, reason } of results) {
  console.info(`[FigureLinks] ${result.toUpperCase().padEnd(7)} ${url} (${reason})`);
}
const broken = results.filter((entry) => entry.result === 'broken');
const refused = results.filter((entry) => entry.result === 'refused');
console.info(`[FigureLinks] ${results.length} links: ${results.length - broken.length - refused.length} resolve, ${broken.length} broken, ${refused.length} unverified (the host refuses scripted requests).`);
if (refused.length > 0) {
  console.info('[FigureLinks] Open the unverified ones in a browser and confirm each shows the page the explainer cites.');
}
if (broken.length > 0 || (strict && refused.length > 0)) process.exit(1);
