import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relativePath) => readFileSync(`${root}/${relativePath}`, 'utf8');

const SITE_ORIGIN = 'https://planeir.ie';
const API_ORIGIN = 'https://api.planeir.ie';
const LEGACY_CROSS_SITE_ORIGIN = 'https://call-canvas-session-worker.geraldboylan.workers.dev';

assert.equal(
  new URL(API_ORIGIN).hostname.endsWith(`.${new URL(SITE_ORIGIN).hostname}`),
  true,
  'The production API must remain same-site with planeir.ie so Safari can retain the advisor cookie.'
);

for (const page of [
  'app/index.html',
  'app/session.html',
  'app/clients.html',
  'app/analytics.html',
  'app/modules.html',
  'app/access.html'
]) {
  const html = read(page);
  assert.ok(
    html.includes(`name="call-canvas-worker-base-url"`) && html.includes(`content="${API_ORIGIN}"`),
    `${page} must call the same-site production API.`
  );
  assert.ok(html.includes(API_ORIGIN), `${page} CSP must allow the same-site production API.`);
  assert.ok(!html.includes(LEGACY_CROSS_SITE_ORIGIN), `${page} must not regress to the Safari-blocked workers.dev origin.`);
}

const landingHtml = read('index.html');
assert.ok(
  landingHtml.includes(`window.__WORKER_BASE_URL = "${API_ORIGIN}";`),
  'The public landing page must check advisor sessions against the same-site API.'
);
assert.ok(!landingHtml.includes(LEGACY_CROSS_SITE_ORIGIN), 'The landing page must not use the cross-site Worker origin.');

const planHtml = read('plan/index.html');
assert.ok(
  planHtml.includes(`name="planeir-consumer-api-base-url"`) && planHtml.includes(`content="${API_ORIGIN}"`),
  'The consumer page must use the same production API origin.'
);
assert.ok(!planHtml.includes(LEGACY_CROSS_SITE_ORIGIN), 'The consumer page must not use the legacy Worker origin.');

const wrangler = read('worker/wrangler.toml');
assert.match(
  wrangler,
  /routes\s*=\s*\[\s*\{\s*pattern\s*=\s*"api\.planeir\.ie",\s*custom_domain\s*=\s*true\s*\}\s*\]/m,
  'Wrangler must bind the Worker to api.planeir.ie as a custom domain.'
);

const worker = read('worker/src/index.js');
assert.match(worker, /HttpOnly; Secure; SameSite=Lax; Max-Age=/, 'Advisor cookies must be secure, HTTP-only, and same-site.');
assert.doesNotMatch(worker, /ADVISOR_SESSION_COOKIE[^\n]*SameSite=None/, 'Advisor cookies must not require third-party cookie access.');

const appScript = read('js/app.js');
assert.match(
  appScript,
  /const verifiedSession = await fetchAdvisorAuthSession\(\);[\s\S]*verifiedSession\?\.authenticated !== true/,
  'The login UI must verify that the browser retained the cookie before reporting success.'
);

const deployWorkflow = read('.github/workflows/deploy-worker.yml');
assert.ok(
  deployWorkflow.includes(`WORKER_BASE_URL: \${{ vars.WORKER_BASE_URL || '${API_ORIGIN}' }}`),
  'Production deployment smoke tests must exercise the same-site API hostname.'
);

console.info('[AdvisorBrowserAuth] PASS: production auth uses a verified same-site cookie on api.planeir.ie.');
