import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WORKSPACE_COPY, WORKSPACE_POLICY, WORKSPACE_RELEASE, workspaceAcknowledgements, workspaceLaunchReady, workspaceStatusCopy } from '../js/workspace/copy.js';
import { workspaceReceiptText, workspaceReportText } from '../js/workspace/output_copy.js';
import { renderWorkspaceStatus } from '../js/workspace/status.js';
import { createTestRuntime, captureEmail, writtenApplication } from './lib/application-test-runtime.mjs';

const source = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
assert.equal(workspaceLaunchReady(), false);
for (const capability of ['automaticGeneration', 'persistentAccess', 'deletion', 'paidBooking']) {
  assert.equal(WORKSPACE_RELEASE[capability], false, `${capability} has not been implemented by a copy change`);
}
const receipt = workspaceReceiptText('https://planeir.ie/workspace/example');
assert.match(receipt, /generated automatically/);
assert.match(receipt, /Read all the assumptions/);
assert.doesNotMatch(receipt, /check the figures|inactivity expiry/i);
assert.doesNotMatch(receipt, /video|picked|Gerry reads|€180/);
assert.throws(() => workspaceReceiptText('https://example.com/workspace/example'));
assert.throws(() => workspaceReceiptText('http://planeir.ie/workspace/example'));
const report = workspaceReportText({ comparisons: 'Fixture comparison', assumptions: 'Fixture assumptions', figuresToCheck: 'Fixture missing figure' });
for (const heading of ['Your financial picture', 'Compare outcomes', 'Assumptions used', 'Missing information']) assert.ok(report.includes(heading));
assert.match(report, /Fixture missing figure/);
const confirmed = { adultConfirmed: true, educationAcknowledged: true, privacyNoticeAcknowledged: true, termsAccepted: true, aiProcessingAcknowledged: true };
assert.deepEqual(workspaceAcknowledgements(confirmed), { ...WORKSPACE_POLICY, ...confirmed });
for (const key of Object.keys(confirmed)) {
  for (const value of [false, undefined, 'true']) assert.throws(() => workspaceAcknowledgements({ ...confirmed, [key]: value }));
}
assert.throws(() => workspaceAcknowledgements({ consentVideo: true, consentEducation: true }));
assert.equal(workspaceStatusCopy('unknown').title, workspaceStatusCopy('unavailable').title);
assert.equal(workspaceStatusCopy('preparing').title, 'Preparing your workspace');
assert.equal(workspaceStatusCopy('ready').title, WORKSPACE_COPY.resultTitle);
assert.match(workspaceStatusCopy('failed').body, /No completed result/);
// Real processing events must set accessible busy state; a failed or unknown
// event must never leave the page claiming that a result is being prepared.
const statusHeading = {}, statusBody = {}, statusAttributes = {};
const statusHost = {
  querySelector: selector => selector === 'p' ? statusBody : statusHeading,
  setAttribute: (name, value) => { statusAttributes[name] = value; }
};
renderWorkspaceStatus(statusHost, 'calculating');
assert.equal(statusAttributes['aria-busy'], 'true');
renderWorkspaceStatus(statusHost, 'failed');
assert.equal(statusAttributes['aria-busy'], 'false');
assert.match(statusBody.textContent, /No completed result/);
renderWorkspaceStatus(statusHost, 'unknown');
assert.equal(statusAttributes['aria-busy'], 'false');
assert.equal(statusHeading.textContent, workspaceStatusCopy('unavailable').title);

const home = await source('index.html');
const form = await source('apply/index.html');
const app = await source('js/apply.js');
const privacy = await source('privacy/index.html');
assert.equal(privacy, await source('plan/privacy.html'), 'Both public privacy routes must present the same notice');
assert.doesNotMatch(home, /€100|\bpaid\b|paidBooking|\bfee\b|\bcharging\b|\bpayment\b|40[ -]min/i);
for (const file of ['apply/index.html', 'apply/preparing/index.html', 'privacy/index.html', 'plan/privacy.html', 'terms/index.html', 'llms.txt']) {
  assert.doesNotMatch(await source(file), /€100|\bpaid\b|\bcharging\b|\bfee\b|\bpayment\b|40[ -]min/i, `Call pricing must wait until the analysis: ${file}`);
}
assert.doesNotMatch(home, /optional call with Gerry|Can I talk through my results with Gerry/);
assert.match(home, /technology/i);
assert.match(home, /worked with clients across every part of the financial advice process/);
assert.doesNotMatch(home, /being built|being developed|in development|planned service|not open yet|at launch|will prepare|will be generated|AI-powered|unlock/i);
assert.doesNotMatch(home, /1%|thousands of euros|equivalent to professional advice/i);
assert.match(home, /scenarios to model from your objectives/);
assert.match(home, /Read all the assumptions/);
for (const file of ['index.html', 'apply/index.html', 'privacy/index.html', 'plan/privacy.html', 'terms/index.html', 'for-ai-assistants/index.html', 'llms.txt', 'js/plan/views.js']) {
  assert.doesNotMatch(await source(file), /check the figures|check the assumptions|no inactivity expiry|AI[^.\n]*explain[^.\n]*modules|AI[^.\n]*explain[^.\n]*results/i, `Outdated workspace wording in ${file}`);
}
assert.doesNotMatch(home, /<iframe|VideoObject|ApplyAction|cases:latest|href="[^\"]*cases\//);
assert.match(form, /id="applySubmit"[^>]*disabled/);
assert.match(home, /Currently available for demos only/);
assert.match(home, /different routes to your financial goals/);
assert.doesNotMatch(form, /applyConsentVideo|applyVoiceNote|Send my application|Gerry reads every/);
assert.doesNotMatch(app, /\/api\/applications|createApplicationVoice|consentVideo|sentPayload/);
assert.match(app, /demoApi/);
assert.match(app, /DEMO_CONFIRMED/);
assert.match(app, /planeir\.workspace\.draft\.v1/);
assert.match(privacy, /until you delete it/);
assert.match(await source('plan/privacy-legacy.html'), /seven days/);
assert.match(await source('privacy/legacy-applications.html'), /12 months/);
assert.equal(JSON.parse(await source('agents/application.schema.json')).properties.household.properties.age.minimum, 18);
const openapi = JSON.parse(await source('agents/openapi.json'));
assert.deepEqual(openapi.paths, {}, 'Do not advertise the old case-video submission API as a workspace API');

// Verify closure through the real Worker: no records, confirmation emails or
// workspace permission can accidentally enter the publication pipeline.
const mail = captureEmail();
const runtime = createTestRuntime({ CASE_APPLICATIONS_ENABLED: undefined });
try {
  for (const route of ['/api/applications', '/api/agent/applications', '/api/agent/applications/check']) {
    const result = await runtime.call(route, writtenApplication());
    assert.equal(result.status, 410, route);
    assert.equal(result.json.code, 'case_applications_closed');
  }
  assert.equal(runtime.sql.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 0);
  assert.equal(runtime.sql.prepare('SELECT COUNT(*) AS n FROM agent_application_requests').get().n, 0);
  assert.equal(mail.emails.length, 0);
} finally { runtime.close(); mail.restore(); }
console.log('Workspace wording, acknowledgements, release boundaries and closed intake checks passed.');
