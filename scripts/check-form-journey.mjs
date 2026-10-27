import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const built = process.argv.includes('--dist');
const base = built ? resolve(root, 'dist') : root;
const read = path => readFile(resolve(base, path), 'utf8');

const retired = await read('plan/index.html');
assert.doesNotMatch(retired, /<script\b|<iframe\b|realtimeVoice|data-lane=|planeir-consumer-api-base-url/i);
assert.match(retired, /href="\.\.\/apply\/"/);
assert.match(retired, /href="\.\.\/demo\/"/);
assert.match(retired, /generation is not connected yet/);
assert.match(retired, /no-referrer/);

for (const page of ['app/index.html', 'app/clients.html', 'app/modules.html']) {
  assert.doesNotMatch(await read(page), /consumerPlannerTest|OverflowConsumerPlanner|href="\.\/analytics\.html"/);
}
assert.doesNotMatch(await read('app/analytics.html'), /analytics_manager\.js|id="analyticsShell"/);
assert.doesNotMatch(await read('js/app.js'), /consumerPlannerTest|openConsumerPlannerTest|\/api\/advisor\/consumer-invite/);
assert.doesNotMatch(await read('js/render.js'), /consumerPlannerTest|OverflowConsumerPlanner/);
assert.doesNotMatch(await read('js/education_call_report.js'), /from ['"]\.\/plan\//);
assert.doesNotMatch(await read('js/results/view.js'), /getUserMedia|RTCPeerConnection|\.\/store\.js|\.\/api\.js|createMeetingTranscript|createEducationCallCTA/);

const workflow = await readFile(resolve(root, '.github/workflows/deploy-worker.yml'), 'utf8');
for (const name of ['RUN_PAID_REALTIME_INFRASTRUCTURE_PROOF', 'CONSUMER_ADVISER_TEST_BETA_SOURCE_APPROVED',
  'CONSUMER_ADVISER_TEST_BETA_OVERRIDE', 'CONSUMER_REALTIME_ADVISER_CANARY_SOURCE_APPROVED',
  'CONSUMER_REALTIME_ADVISER_CANARY_OVERRIDE', 'CONSUMER_REALTIME_KEEP_ACTIVE',
  'CONSUMER_TYPED_LANE_ENABLED', 'CONSUMER_MODULE_OFFERS_ENABLED']) {
  assert.match(workflow, new RegExp(`^      ${name}: "false"$`, 'm'), `${name} must stay disabled regardless of repository variables`);
}
assert.doesNotMatch(workflow, /inputs\.(?:activate_realtime_adviser_canary|run_paid_realtime_infrastructure_proof)/);

if (built) {
  await assert.rejects(access(resolve(base, 'js/plan')), { code: 'ENOENT' });
  await assert.rejects(access(resolve(base, 'js/analytics_manager.js')), { code: 'ENOENT' });
  await assert.rejects(access(resolve(base, 'docs/archive')), { code: 'ENOENT' });

  // Follow the real app/form/report dependencies: excluding legacy code must
  // not strand an import used by a saved report or an active form.
  const seen = new Set();
  async function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(file, 'utf8');
    assert.ok(!file.startsWith(resolve(base, 'js/plan') + '/'), `Retired dependency: ${file}`);
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])(\.[^'"]+\.js(?:\?[^'"]*)?)\1/g)];
    for (const [, , target] of imports) await visit(resolve(dirname(file), target.split('?')[0]));
  }
  for (const file of ['js/app_entry.js', 'js/apply.js', 'js/demo_admin.js', 'js/education_call_report.js', 'js/session_viewer.js']) {
    await visit(resolve(base, file));
  }
}
console.log(`Form journey: retired entry points, dormant activation, independent reports${built ? ' and published dependencies' : ''} passed.`);
