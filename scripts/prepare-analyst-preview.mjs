// Non-secret, isolated preview configuration. Never points at production D1.
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const [databaseId, origin] = process.argv.slice(2);
if (!/^[a-f0-9-]{36}$/.test(databaseId || '') || !/^https:\/\/planeir-analyst-preview\.[a-z0-9-]+\.workers\.dev$/.test(origin || '')) throw new Error('Provide the isolated preview D1 ID and preview Worker origin.');
const assets = new URL('.worker-dry-run/analyst-preview-assets/', root); await mkdir(assets, { recursive: true });
for (const name of ['app', 'js', 'styles', 'assets/brand', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) {
  await cp(new URL('dist/' + name, root), new URL(name, assets), { recursive: true }).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
for (const name of await readdir(new URL('app/', assets))) {
  if (!name.endsWith('.html')) continue;
  const file = new URL('app/' + name, assets);
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('https://api.planeir.ie', origin));
}
await writeFile(new URL('worker/wrangler.analyst-preview.generated.toml', root), `name = "planeir-analyst-preview"
main = "src/analyst/preview.js"
compatibility_date = "2026-02-20"
workers_dev = true
[build]
command = "node ../scripts/build-analyst-instructions.mjs"
[limits]
cpu_ms = 300000
subrequests = 100000
[observability]
enabled = true
head_sampling_rate = 1
[assets]
directory = "../.worker-dry-run/analyst-preview-assets"
binding = "ASSETS"
run_worker_first = ["/api/*"]
[[workflows]]
name = "planeir-analyst-preview"
binding = "ANALYST_WORKFLOW"
class_name = "AnalystWorkflow"
[[d1_databases]]
binding = "LEADS_DB"
database_name = "planeir-analyst-preview"
database_id = "${databaseId}"
migrations_dir = "migrations"
[[r2_buckets]]
binding = "SESSIONS_BUCKET"
bucket_name = "call-canvas-sessions-preview"
[vars]
ANALYST_ENABLED = "true"
ANALYST_CONFIRMED_APPLICATIONS_ENABLED = "false"
ALLOWED_ORIGINS = "${origin},http://localhost:8788,http://127.0.0.1:8788,http://127.0.0.1:8787"
`);
console.log('Prepared isolated analyst preview assets and configuration.');
