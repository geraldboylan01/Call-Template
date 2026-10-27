// The refresh, end to end: read the pages, work out the plan, say what it would
// change, and (when asked) write it, check it and open the pull request.
//
// Everything that touches the outside world is passed in (the page loader, the
// file, the command runner), so the tests run the whole thing on saved pages and
// a fake `git` and `gh`.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyPlanToSource, decideOnPullRequest, planRefresh, summarisePlan, verifyEditedSource } from './plan.mjs';
import { QUOTE_SOURCES, readQuote, sourceFor } from './readers.mjs';
import { renderReport } from './report.mjs';

export const MARKET_FILE = 'js/planning/figures/market_ie.js';
export const GENERATED_FILES = Object.freeze(['js/planning/figures/figures_index.generated.js', 'docs/figures-register.md']);
export const BRANCH_PREFIX = 'figures/market-refresh-';

/** Checks that pin figure values in their own right. They are run when a value moves, to report which fail. */
export const GOLDEN_CHECKS = Object.freeze(['check:future-cost-fund', 'check:goals-and-resources', 'check:house-purchase', 'check:planeir-assumptions']);

/** Every quote read, one at a time: the banks are asked politely, and the report keeps their order. */
export async function readAll(figures, load, sources = QUOTE_SOURCES) {
  const reads = [];
  for (const figure of figures) {
    for (const observation of figure.observations) {
      const source = sourceFor(figure.id, observation.sourceLabel, sources);
      const result = source
        ? await readQuote(observation, source, load)
        : { ok: false, reason: 'no reader is defined for this quote (add one to scripts/lib/market-refresh/readers.mjs)', urls: [observation.url], pages: [] };
      reads.push({ figureId: figure.id, sourceLabel: observation.sourceLabel, result });
    }
  }
  return reads;
}

const tail = (text, lines = 25) => text.trim().split('\n').slice(-lines).join('\n');

function npmCheck(run, script) {
  const result = run('npm', ['run', '--silent', script]);
  return { command: `npm run ${script}`, ok: result.code === 0, output: tail(`${result.stdout}\n${result.stderr}`) };
}

function titleFor(plan) {
  const summary = summarisePlan(plan);
  const parts = [];
  if (summary.valuesChanged > 0) parts.push(`${summary.valuesChanged} value${summary.valuesChanged === 1 ? '' : 's'} changed`);
  if (summary.quotesMoved > 0) parts.push(`${summary.quotesMoved} quote${summary.quotesMoved === 1 ? '' : 's'} moved`);
  return `Refresh market figures (${plan.today}): ${parts.length > 0 ? parts.join(', ') : 'check dates only'}`;
}

function git(run, args, { allowFail = false } = {}) {
  const result = run('git', args);
  if (result.code !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${tail(`${result.stderr}\n${result.stdout}`, 6)}`);
  return result;
}

/** Things that must be true before the job writes anything it will commit. */
function preflightForPullRequest(run, { base, today }) {
  if (git(run, ['status', '--porcelain']).stdout.trim() !== '') {
    throw new Error('The working tree has changes. Run the job from a clean checkout (a fresh worktree of main is best).');
  }
  git(run, ['fetch', 'origin', base.replace(/^origin\//, '')]);
  if (git(run, ['merge-base', '--is-ancestor', base, 'HEAD'], { allowFail: true }).code !== 0) {
    throw new Error(`This checkout does not include ${base}. Update it first, so the refresh is made on the latest figures.`);
  }
  const listed = run('gh', ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,url', '--limit', '100']);
  if (listed.code !== 0) throw new Error(`Could not list open pull requests with gh: ${tail(listed.stderr, 4)}`);
  const open = JSON.parse(listed.stdout || '[]').find((pr) => pr.headRefName.startsWith(BRANCH_PREFIX));
  return { earlierPullRequest: open ?? null, branch: branchName(run, today) };
}

function branchName(run, today) {
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const name = `${BRANCH_PREFIX}${today}${attempt === 1 ? '' : `-${attempt}`}`;
    const local = git(run, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true }).code === 0;
    const remote = git(run, ['ls-remote', '--exit-code', '--heads', 'origin', name], { allowFail: true }).code === 0;
    if (!local && !remote) return name;
  }
  throw new Error(`Branches ${BRANCH_PREFIX}${today} to -9 are all taken. Clear some out.`);
}

/**
 * @param {object} deps
 * @param {{apply?: boolean, openPr?: boolean, diff?: boolean, base?: string, freshnessDays?: number, pagesDir?: string|null, today: string}} deps.options
 */
export async function refreshMarketFigures({
  options,
  figures,
  catalogueVersion,
  sources = QUOTE_SOURCES,
  registerFigures,
  load,
  marketFile,
  run,
  log = console.log,
  tmp = tmpdir()
}) {
  const { today } = options;
  const base = options.base ?? 'origin/main';

  let branch = null;
  let earlier = null;
  if (options.openPr) {
    ({ branch, earlierPullRequest: earlier } = preflightForPullRequest(run, { base, today }));
    if (earlier) {
      const message = `An earlier market refresh is still open (${earlier.url}). Merge or close it, then run the job again.`;
      log(message);
      return { blocked: message, earlier };
    }
  }

  const reads = await readAll(figures, load, sources);
  const plan = planRefresh({ figures, catalogueVersion, today, reads });
  const decision = decideOnPullRequest(plan, { freshnessDays: options.freshnessDays ?? 21 });

  const sourceText = await marketFile.read();
  const edited = applyPlanToSource(sourceText, plan);
  await verifyEditedSource(edited, plan);
  const changesFile = edited !== sourceText;

  const write = options.apply || options.openPr;
  const result = { plan, decision, edited, changesFile, wrote: false, pullRequestUrl: null, checks: [], report: '' };

  // Without --apply or --open-pr this is a dry run: say what would happen and stop.
  if (!write || (options.openPr && !decision.openPullRequest) || !changesFile) {
    const intro = !write
      ? null
      : (changesFile ? 'Nothing was written: no pull request is warranted yet.' : 'Nothing was written: the file already says this.');
    result.report = renderReport({ plan, decision, registerFigures, mode: 'dry-run', intro, pagesDir: options.pagesDir, format: 'terminal' });
    return result;
  }

  await marketFile.write(edited);
  result.wrote = true;
  const build = run('npm', ['run', '--silent', 'build:figures']);
  if (build.code !== 0) throw new Error(`npm run build:figures failed after the refresh:\n${tail(`${build.stderr}\n${build.stdout}`)}`);
  const rules = npmCheck(run, 'check:figures');
  result.checks.push(rules);
  if (!rules.ok) {
    throw new Error(`check:figures fails after the refresh, so no pull request was opened. The changes are left in the working tree to inspect.\n${rules.output}`);
  }
  if (plan.figures.some((figure) => figure.valueChanged)) {
    for (const script of GOLDEN_CHECKS) result.checks.push(npmCheck(run, script));
  }

  const mode = options.openPr ? 'pull-request' : 'applied';
  result.report = renderReport({ plan, decision, registerFigures, mode, checks: result.checks, pagesDir: options.pagesDir, format: options.openPr ? 'github' : 'terminal' });
  if (!options.openPr) return result;

  const title = titleFor(plan);
  git(run, ['switch', '-c', branch]);
  git(run, ['add', MARKET_FILE, ...GENERATED_FILES]);
  git(run, ['commit', '-m', title, '-m', `Read by the weekly market-figures job. ${decision.reasons.join('; ')}. See the pull request for each figure's old and new value and the pages read.`]);
  git(run, ['push', '-u', 'origin', branch]);
  const bodyPath = join(await mkdtemp(join(tmp, 'market-refresh-')), 'body.md');
  await writeFile(bodyPath, result.report);
  const created = run('gh', ['pr', 'create', '--base', base.replace(/^origin\//, ''), '--head', branch, '--title', title, '--body-file', bodyPath]);
  if (created.code !== 0) throw new Error(`The branch ${branch} was pushed but the pull request could not be opened: ${tail(created.stderr, 6)}`);
  result.pullRequestUrl = created.stdout.trim().split('\n').pop();
  result.branch = branch;
  return result;
}
