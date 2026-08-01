// Protected-canary deploy configuration checks.
//
// The fail-closed config builder in deploy-worker.yml compares each protected
// runtime value against an approved literal:
//
//   CONSUMER_REALTIME_MODEL: ['CONSUMER_BETA_REALTIME_MODEL', 'gpt-realtime-2.1']
//
// `envValue(sourceName)` reads process.env, which is populated from the
// job-level `env:` block. So a value that is REFERENCED there but never
// DECLARED resolves to an empty string, mismatches its approved literal, and
// aborts the deployment — correctly, but only at manual-dispatch time, after a
// human has ticked the canary boxes and waited for the run.
//
// That is exactly how Deploy Worker #260 failed: CONSUMER_BETA_REALTIME_PLANNER_MODEL
// was added to fixedRealtimeValues without being added to the job env.
//
// These checks catch that class of mismatch in CI instead. They verify the
// wiring, never weaken it: nothing here bypasses the assertion, relaxes the
// paid proof, or makes realtime always-on.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = readFileSync(`${root}/.github/workflows/deploy-worker.yml`, 'utf8');

const passes = [];
function pass(message) {
  passes.push(message);
  console.info(`[DeployCanary] PASS: ${message}`);
}

/** The job-level `env:` block: everything before the first `steps:`. */
const jobEnv = workflow.slice(0, workflow.indexOf('\n    steps:'));

/** Declarations of the form `NAME: "value"` in the job env. */
function declaredEnvLiterals(source) {
  const declared = new Map();
  for (const match of source.matchAll(/^ {6}([A-Z][A-Z0-9_]*): "([^"]*)"$/gm)) {
    declared.set(match[1], match[2]);
  }
  return declared;
}

/** Approved pairs from a `fixed*Values` table. */
function approvedPairs(tableName) {
  const start = workflow.indexOf(`const ${tableName} = {`);
  assert.notEqual(start, -1, `${tableName} must exist in the deploy workflow`);
  const body = workflow.slice(start, workflow.indexOf('};', start));
  const pairs = [];
  for (const match of body.matchAll(/([A-Z][A-Z0-9_]*):\s*\['([A-Z][A-Z0-9_]*)',\s*'([^']*)'\]/g)) {
    pairs.push({ runtimeName: match[1], sourceName: match[2], approvedValue: match[3] });
  }
  return pairs;
}

const declared = declaredEnvLiterals(jobEnv);

for (const tableName of ['fixedVoiceValues', 'fixedRealtimeValues']) {
  const pairs = approvedPairs(tableName);
  assert.ok(pairs.length > 0, `${tableName} must contain approved value pairs`);

  for (const { runtimeName, sourceName, approvedValue } of pairs) {
    // 1. The source variable must be DECLARED, or envValue() yields '' and the
    //    deployment aborts at dispatch time.
    assert.ok(
      declared.has(sourceName),
      `${tableName}: ${sourceName} is compared against "${approvedValue}" but is never declared `
        + 'in the job env block. envValue() would return an empty string and abort the deployment.'
    );

    // 2. The declared literal must EQUAL the approved literal, or the same
    //    abort happens for a subtler reason.
    assert.equal(
      declared.get(sourceName),
      approvedValue,
      `${tableName}: ${sourceName} is declared as "${declared.get(sourceName)}" but the protected `
        + `assertion requires exactly "${approvedValue}".`
    );

    // 3. The runtime variable must exist in the committed Wrangler source, or
    //    replaceTomlString has nothing to substitute.
    const wrangler = readFileSync(`${root}/worker/wrangler.toml`, 'utf8');
    assert.ok(
      new RegExp(`^${runtimeName}\\s*=`, 'm').test(wrangler),
      `${tableName}: ${runtimeName} is overlaid at deploy time but is absent from worker/wrangler.toml`
    );
  }
  pass(`${tableName}: all ${pairs.length} protected values are declared, matching, and present in wrangler.toml`);
}

{
  // The planner model specifically — the value this incident turned on.
  const pairs = approvedPairs('fixedRealtimeValues');
  const planner = pairs.find((item) => item.runtimeName === 'CONSUMER_REALTIME_PLANNER_MODEL');
  assert.ok(planner, 'the planner model is a protected canary value');
  assert.equal(planner.approvedValue, 'gpt-5.6-luna', 'the approved canary planner model is gpt-5.6-luna');

  // It must agree with the code allowlist and the code default, or the canary
  // would deploy a model the Worker then refuses to use.
  const config = readFileSync(`${root}/worker/src/consumer/config.js`, 'utf8');
  const allowlistStart = config.indexOf('APPROVED_PLANNER_MODELS = new Set([');
  assert.notEqual(allowlistStart, -1, 'the planner model allowlist must exist');
  const allowlist = config.slice(allowlistStart, config.indexOf(']);', allowlistStart));
  assert.ok(
    allowlist.includes(`'${planner.approvedValue}'`),
    'the approved canary planner model must be on the server-side allowlist'
  );
  assert.match(
    config,
    new RegExp(`DEFAULT_PLANNER_MODEL = '${planner.approvedValue}'`),
    'the approved canary planner model must equal the code default'
  );
  pass('the approved canary planner model agrees with the allowlist and the code default');
}

{
  // The protections themselves must remain intact.
  assert.match(
    workflow,
    /must remain exactly \$\{approvedValue\} for the protected realtime canary/,
    'the protected realtime assertion is still enforced'
  );
  assert.match(
    workflow,
    /CONSUMER_REALTIME_ADVISER_CANARY_SOURCE_APPROVED: \$\{\{ github\.event_name == 'workflow_dispatch'/,
    'realtime activation still requires an explicit manual dispatch'
  );
  const wranglerSource = readFileSync(`${root}/worker/wrangler.toml`, 'utf8');
  assert.match(
    wranglerSource,
    /^CONSUMER_REALTIME_VOICE_ENABLED = "false"$/m,
    'realtime stays false in the committed source; only the builder may enable it'
  );
  assert.match(
    workflow,
    /if \(realtimeEnabled\) \{/,
    'realtime values are applied only inside the realtimeEnabled branch'
  );
  assert.match(
    workflow,
    /run_paid_realtime_infrastructure_proof/,
    'the paid infrastructure proof input still exists'
  );
  pass('the protected assertion, manual-dispatch gate and paid proof are all still in place');
}

{
  const credentialStep = workflow.indexOf('- name: Verify protected Realtime planner credential');
  const activationStep = workflow.indexOf('- name: Deploy final Worker configuration');
  assert.ok(credentialStep > 0, 'the protected realtime planner credential probe must exist');
  assert.ok(
    credentialStep < activationStep,
    'the planner credential probe must pass before the final configuration can activate realtime'
  );
  const credentialBlock = workflow.slice(credentialStep, activationStep);
  assert.match(
    credentialBlock,
    /if: env\.CONSUMER_REALTIME_ADVISER_CANARY_ENABLED == 'true'/,
    'the paid planner probe runs only for an explicitly approved realtime canary'
  );
  assert.match(
    credentialBlock,
    /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/,
    'the planner probe uses the protected deployment credential'
  );
  assert.match(
    credentialBlock,
    /node \.\/scripts\/run-consumer-planner-probe\.mjs/,
    'the deployment uses the current production-shaped planner probe'
  );
  pass('the exact planner credential and model are proven before realtime activation');
}

{
  // An undeclared or mismatched value must still abort. Prove the checks above
  // would actually have caught #260 by simulating both faults.
  const brokenUndeclared = jobEnv.replace(/^ {6}CONSUMER_BETA_REALTIME_PLANNER_MODEL: "[^"]*"$/m, '');
  assert.ok(
    !declaredEnvLiterals(brokenUndeclared).has('CONSUMER_BETA_REALTIME_PLANNER_MODEL'),
    'removing the declaration is detectable — this is the Deploy Worker #260 fault'
  );
  const brokenValue = jobEnv.replace(
    /^ {6}CONSUMER_BETA_REALTIME_PLANNER_MODEL: "[^"]*"$/m,
    '      CONSUMER_BETA_REALTIME_PLANNER_MODEL: "gpt-5.6-sol"'
  );
  assert.notEqual(
    declaredEnvLiterals(brokenValue).get('CONSUMER_BETA_REALTIME_PLANNER_MODEL'),
    'gpt-5.6-luna',
    'a silently changed approved value is detectable'
  );
  pass('both the undeclared-variable and changed-value faults are detectable by these checks');
}

{
  // The release allowlist must track the manifest.
  //
  // It is the fourth consumer gate, and it is meant to be a STAGED-RELEASE
  // control, not a second approval decision. It was pinned to two modules on
  // the first day of the adviser beta and never widened as modules were
  // approved, so a client asking about their overall position or their
  // children's education routed to nothing at all and saw "0 focus areas".
  const { MODULE_MANIFEST } = await import('../js/planning/module_manifest.generated.js');
  const { effectiveConsumerAvailability } = await import('../js/planning/module_availability.js');
  const { consumerLanguageForModule } = await import('../js/planning/module_offers.js');

  const releasable = MODULE_MANIFEST
    .filter((entry) => effectiveConsumerAvailability(entry.moduleId, {}).visible
      && entry.routing?.consumerRoutable === true
      && Boolean(consumerLanguageForModule(entry.moduleId)))
    .map((entry) => entry.moduleId)
    .sort();

  // Modules deliberately held back despite passing every manifest gate. Adding
  // one here is a conscious product decision and must be justified in review.
  const INTENTIONALLY_WITHHELD = [];

  const expected = releasable.filter((id) => !INTENTIONALLY_WITHHELD.includes(id));
  const wrangler = readFileSync(`${root}/worker/wrangler.toml`, 'utf8');
  const configured = (wrangler.match(/^CONSUMER_ALLOWED_MODULE_IDS = "([^"]*)"$/m) || [])[1];
  assert.ok(configured, 'the release allowlist must be set in wrangler.toml');
  const configuredIds = configured.split(',').map((id) => id.trim()).filter(Boolean).sort();

  // Safety direction: never release something the manifest has not approved.
  for (const moduleId of configuredIds) {
    assert.ok(
      releasable.includes(moduleId),
      `the release allowlist contains ${moduleId}, which does not pass every manifest consumer gate`
    );
  }
  // Coverage direction: never silently withhold an approved module.
  assert.deepEqual(
    configuredIds,
    expected,
    'the release allowlist has drifted from the manifest-approved set. Add the module, or list it '
      + 'in INTENTIONALLY_WITHHELD with a reason.'
  );

  // The deploy workflow pin must agree, or a correct allowlist fails the deploy.
  assert.ok(
    workflow.includes(configured),
    'the deploy workflow allowlist pin must match wrangler.toml exactly'
  );
  pass(`the release allowlist matches the ${expected.length} manifest-approved modules, and the deploy pin agrees`);
}

{
  // Every routable goal must reach at least one releasable analysis, or a client
  // stating that goal gets nothing.
  const { MODULE_MANIFEST } = await import('../js/planning/module_manifest.generated.js');
  const wrangler = readFileSync(`${root}/worker/wrangler.toml`, 'utf8');
  const configured = (wrangler.match(/^CONSUMER_ALLOWED_MODULE_IDS = "([^"]*)"$/m) || [])[1]
    .split(',').map((id) => id.trim());
  const covered = new Set();
  for (const entry of MODULE_MANIFEST) {
    if (!configured.includes(entry.moduleId)) continue;
    for (const goal of entry.routing?.goals || []) covered.add(goal.type);
  }
  for (const goalType of ['understand_position', 'fund_education', 'buy_home', 'improve_pension', 'retire']) {
    assert.ok(
      covered.has(goalType),
      `no releasable analysis serves the ${goalType} goal — a client stating it would see zero focus areas`
    );
  }
  pass(`the released modules cover ${covered.size} client goals, including the ones this incident exposed`);
}

console.info(`\n[DeployCanary] ${passes.length} assertions passed.`);
