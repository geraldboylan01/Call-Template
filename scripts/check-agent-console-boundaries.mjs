// Agent test console boundaries.
//
// The console is a LOCAL DEVELOPER TOOL. Two properties must hold, and neither
// is obvious from reading the page:
//
//  1. It never ships. It is deliberately absent from the build allowlist, so
//     `npm run build` cannot put it on planeir.ie.
//  2. It renders; it does not plan. Every string it shows comes from a server
//     projection. The moment it composes a question, picks a module or decides
//     anything, it has become the shadow planner the agent-testing plan forbids.
//
// It also enforces the visibility split: the consumer column may only be fed
// from the consumer projection, and the tester column from the diagnostic one.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(`${root}/dev/agent-console.html`, 'utf8');
const script = readFileSync(`${root}/dev/agent_console.js`, 'utf8');
const build = readFileSync(`${root}/scripts/build-pages.mjs`, 'utf8');

const passes = [];
function pass(message) {
  passes.push(message);
  console.info(`[AgentConsole] PASS: ${message}`);
}

{
  // 1 — it never ships.
  const htmlFiles = build.slice(build.indexOf('const HTML_FILES'), build.indexOf('const COPY_ENTRIES'));
  assert.ok(!htmlFiles.includes('agent-console'), 'the console must not be in the build HTML allowlist');
  assert.ok(!htmlFiles.includes('dev/'), 'no dev page may be in the build HTML allowlist');
  const copyEntries = build.slice(build.indexOf('const COPY_ENTRIES'), build.indexOf('const VERSION'));
  assert.ok(!copyEntries.includes("'dev'"), 'the dev directory must not be copied into dist');
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/, 'the page is noindex');
  pass('the console is excluded from the production build and marked noindex');
}

{
  // 2 — it plans nothing.
  const forbidden = [
    ['buildGoalModulePlan', 'routes modules'],
    ['buildQuestionPlan', 'composes questions'],
    ['describeConversationState', 'derives planning state'],
    ['nextModuleOffer', 'builds offers'],
    ['composeCapacityChoice', 'builds capacity choices'],
    ['composeMeetingBrief', 'builds briefs'],
    ['MODULE_IDS', 'hardcodes module identity']
  ];
  for (const [symbol, why] of forbidden) {
    assert.ok(!script.includes(symbol), `the console must not import or use ${symbol} — it ${why}`);
  }
  assert.ok(!/\bimport\s.*from\s+['"]\.\.\/js\/planning/.test(script),
    'the console must not import the planning core');
  assert.ok(!/\bimport\s.*from\s+['"]\.\.\/worker/.test(script),
    'the console must not import Worker code');
  pass('the console imports no planning code and composes no planning decision');
}

{
  // The consumer column is fed only from the consumer projection.
  const transcriptWrites = [...script.matchAll(/state\.turns\.push\(\{[^}]*\}\)/g)].map((m) => m[0]);
  assert.ok(transcriptWrites.length > 0, 'the console renders a transcript');
  for (const write of transcriptWrites) {
    // `result.result.acknowledgement` is the decision acknowledgement composed
    // by the shared offer/capacity handlers from manifest-owned client
    // descriptions. check-consumer-shared-planning.mjs asserts it carries no
    // internal terminology, so it is legitimately client-facing.
    assert.ok(
      /result\.consumer\.assistantMessage|result\.result\??\.acknowledgement|text: message/.test(write),
      `the client transcript may only carry consumer-projection text, found: ${write}`
    );
    assert.ok(
      !/diagnostics\./.test(write),
      `diagnostic state must never be rendered into the client transcript: ${write}`
    );
  }
  pass('the client transcript is fed only from the consumer projection');
}

{
  // Module ids must appear only in the tester column.
  const renderDiagnostics = script.slice(
    script.indexOf('function renderDiagnostics'),
    script.indexOf('/* ---------------------------------------------------------------- */\n/* Action mode')
  );
  assert.ok(renderDiagnostics.includes('moduleId('), 'the tester column does show internal module ids');
  assert.ok(
    renderDiagnostics.includes('item.description') || renderDiagnostics.includes('choice.description'),
    'the tester column pairs each internal id with its client wording, so a mismatch is visible'
  );
  const renderTranscript = script.slice(
    script.indexOf('function renderTranscript'),
    script.indexOf('function panel')
  );
  assert.ok(!renderTranscript.includes('moduleId'), 'no module id is rendered into the client transcript');
  pass('internal module ids appear only in the tester column, paired with client wording');
}

{
  // Action mode must be unmistakable.
  assert.match(script, /ACTION MODE/, 'action-mode controls carry an explicit label');
  assert.match(script, /[Nn]ot valid as a voice\/text parity test/, 'the label says it is not a parity path');
  const actionCalls = [...script.matchAll(/decisions\/(offer|capacity)|\/confirm`/g)];
  assert.ok(actionCalls.length >= 3, 'the console exposes the offer, capacity and confirm action endpoints');
  const buttons = [...script.matchAll(/button\.className = '([^']*)'/g)].map((m) => m[1]);
  assert.ok(
    buttons.length > 0 && buttons.every((name) => name.includes('action-mode')),
    'every dynamically created decision button is badged action-mode'
  );
  assert.match(html, /\.action-mode\s*\{[^}]*var\(--warn\)/, 'action-mode controls are visually distinguished');
  pass('action-mode controls are labelled, badged and visually distinct from utterance mode');
}

{
  // Transcript text is untrusted content and must never be injected as markup.
  // Assignment, not the substring: the file mentions innerHTML in a comment
  // explaining why it is never used.
  assert.ok(
    !/\.innerHTML\s*(?:=|\+=)/.test(script),
    'the console never assigns innerHTML'
  );
  assert.ok(
    !/insertAdjacentHTML|outerHTML\s*=|document\.write/.test(script),
    'the console uses no other markup-injection sink'
  );
  assert.match(script, /bubble\.textContent = turn\.text/, 'transcript text is rendered via textContent');
  pass('transcript and diagnostic text are rendered as text, never as markup');
}

{
  // Authentication and safety posture.
  assert.match(script, /X-Advisor-CSRF/, 'mutating calls send the adviser CSRF token');
  assert.match(script, /credentials: 'include'/, 'the adviser session cookie is sent');
  assert.match(script, /\/api\/agent-tests\//, 'the console talks only to the protected agent-test API');
  assert.ok(
    !/\/api\/consumer\/sessions\/[^`'"]*\/(turns|profile|analyses)/.test(script),
    'the console does not drive the real consumer journey'
  );
  assert.match(html, /synthetic data only/i, 'the page states that only synthetic data belongs here');
  assert.match(html, /local only|not deployed/i, 'the page states that it is not deployed');
  pass('the console is adviser authenticated, agent-API only, and labelled synthetic/local');
}

{
  // The two columns are labelled for what they are.
  assert.match(html, /What the client sees/i, 'the consumer column is labelled');
  assert.match(html, /What the tester sees/i, 'the tester column is labelled');
  assert.match(html, /Consumer projection only/i, 'the consumer column states its projection');
  assert.match(html, /Diagnostic projection/i, 'the tester column states its projection');
  pass('both columns state which projection they render');
}

console.info(`\n[AgentConsole] ${passes.length} assertions passed.`);
