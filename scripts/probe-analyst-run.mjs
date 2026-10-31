// Read-only live verification. Load ADVISOR_SMOKE_PASSWORD with Node's
// --env-file option; credentials/cookies never enter output or saved reports.
import { mkdir, writeFile } from 'node:fs/promises';
const origin = process.env.ANALYST_PREVIEW_ORIGIN || 'https://planeir-analyst-preview.geraldboylan.workers.dev';
if (!['https://planeir-analyst-preview.geraldboylan.workers.dev', 'https://api.planeir.ie'].includes(origin)) throw new Error('Use an approved adviser API origin.');
const [runId] = process.argv.slice(2);
if (!/^run-[a-f0-9-]{36}$/.test(runId || '') || !process.env.ADVISOR_SMOKE_PASSWORD) throw new Error('Supply a run ID and load the existing adviser smoke password.');
const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: process.env.ADVISOR_SMOKE_PASSWORD }) });
if (!login.ok) throw new Error('Adviser verification login failed: ' + login.status);
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
async function readRun() {
const response = await fetch(`${origin}/api/advisor/analyst/${runId}`, { headers: { Origin: origin, Cookie: cookie } });
const run = await response.json();
if (!response.ok) throw new Error(run.error || 'Run could not be read.');
const tokens = (run.events || []).filter(row => row.type === 'model').reduce((sum, row) => {
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens']) sum[key] = (sum[key] || 0) + (row[key] || 0);
  return sum;
}, {});
const report = { runId, status: run.status, stage: run.stage, active: run.active, workflow: run.workflow,
  turns: run.turns, minutes: ((Date.parse(run.finishedAt || new Date().toISOString()) - Date.parse(run.createdAt)) / 60000),
  createdAt: run.createdAt, finishedAt: run.finishedAt, tokens, spend: run.spend, usage: run.usage,
  events: run.events, checkerReports: run.checkerReports, modelMessages: run.modelMessages };
if (run.status === 'accepted') {
  const storyResponse = await fetch(`${origin}/api/advisor/analyst/${runId}/session`, { headers: { Origin: origin, Cookie: cookie } });
  if (!storyResponse.ok) throw new Error('Accepted story failed to open: ' + storyResponse.status);
  const { session } = await storyResponse.json();
  report.storyRoutes = session.planStory.routes.map(row => row.id); report.modules = session.modules.length;
}
const output = new URL('../.worker-dry-run/analyst-live/', import.meta.url); await mkdir(output, { recursive: true });
await writeFile(new URL(runId + '.json', output), JSON.stringify(report, null, 2));
return { ...report, events: report.events.slice(-4), checkerReports: report.checkerReports.map(row => ({ sequence: row.sequence, ok: row.report?.ok, refusals: row.report?.refusals })) };
}
const watch = process.argv.includes('--watch'); let previous = '';
do {
  const report = await readRun();
  const marker = JSON.stringify([report.status, report.turns, report.events.at(-1)?.at, report.active?.name]);
  if (!watch || marker !== previous) console.log(JSON.stringify(watch ? { status: report.status, stage: report.stage, turns: report.turns,
    minutes: Number(report.minutes.toFixed(2)), euroCost: report.spend.knownActualEurMicros / 1000000,
    active: report.active?.name || report.active?.type, last: report.events.at(-1)?.name || report.events.at(-1)?.type } : report));
  previous = marker;
  if (!watch || !['queued', 'running'].includes(report.status) || report.workflow?.status === 'errored') break;
  await new Promise(resolve => setTimeout(resolve, 15000));
} while (true);
