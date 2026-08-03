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

import { resolveShippedConsumerEnv } from './lib/shipped-consumer-config.mjs';

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


{
  /**
   * Every value the router PINS must equal the value the Worker will SHIP.
   *
   * This is the check that deploy #274 needed and did not have. The router's
   * approval gates work by fingerprint: they compare the live config against an
   * exact expected envelope and refuse the session on any mismatch. That is the
   * right design -- a Worker running yesterday's budget ceiling should refuse
   * rather than quietly spend -- but it means every pin is a second copy of a
   * config value, and a copy that is only ever compared at RUNTIME.
   *
   * So widening the module allowlist in wrangler.toml, or raising the response
   * ceiling, deployed a Worker whose own gates then rejected it: adviser invites,
   * voice and realtime all 503 while every pre-deploy check stayed green. The
   * failure was invisible until after the Worker was live.
   *
   * The pins are read out of the router source and checked against wrangler.toml
   * here, before anything ships. Pins with no matching Worker variable are
   * constants rather than config, and are skipped.
   */
  const routerSource = readFileSync(`${root}/worker/src/consumer/router.js`, 'utf8');
  const wrangler = readFileSync(`${root}/worker/wrangler.toml`, 'utf8');

  const envName = (field) => `CONSUMER_${field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;

  // Resolved once, in scripts/lib/shipped-consumer-config.mjs, so the pre-deploy
  // checks cannot disagree with each other about what is being deployed.
  const effective = resolveShippedConsumerEnv();
  const shipped = (name) => effective.get(name);

  let compared = 0;
  const pins = routerSource.matchAll(
    /config\?\.(\w+) === (?:'([^']*)'|([\d_]+))(?=\s*(?:$|\n|\s*&&))/gm
  );
  for (const [, field, stringPin, numberPin] of pins) {
    const configured = shipped(envName(field));
    if (configured === undefined) continue;
    compared += 1;
    const expected = stringPin !== undefined ? stringPin : String(Number(numberPin.replace(/_/g, '')));
    const actual = numberPin !== undefined ? String(Number(configured)) : configured;
    assert.equal(
      actual,
      expected,
      `${envName(field)} ships as "${configured}" but the router gate pins ${field} to `
        + `${stringPin !== undefined ? `"${stringPin}"` : numberPin}. A Worker deployed with this `
        + 'config would refuse its own adviser, voice and realtime sessions. Change both, or neither.'
    );
  }
  assert.ok(compared >= 10, `expected the router to pin many shipped values, found ${compared}`);

  // The module allowlist is the same class of pin, held as a list rather than a
  // scalar. It is defined once in config.js and imported by the gates, so the
  // only thing left to check is that the definition matches what ships.
  const { APPROVED_CONSUMER_MODULE_IDS } = await import('../worker/src/consumer/config.js');
  assert.equal(
    [...APPROVED_CONSUMER_MODULE_IDS].sort().join(','),
    (shipped('CONSUMER_ALLOWED_MODULE_IDS') || '').split(',').map((id) => id.trim()).sort().join(','),
    'APPROVED_CONSUMER_MODULE_IDS must match the allowlist wrangler.toml ships'
  );
  assert.doesNotMatch(
    routerSource,
    /allowedModules === '/,
    'a router gate is restating the module allowlist as a literal instead of importing the constant'
  );
  pass(`all ${compared} router gate pins match the config the Worker will ship`);
}


{
  /**
   * The spend envelope must stay private, and must still be verified.
   *
   * Those pull in opposite directions, so the plumbing that reconciles them is
   * asserted here: a credential the Worker holds, the same value handed to the
   * post-deploy check, and neither ever printed.
   */
  const routerSource = readFileSync(`${root}/worker/src/consumer/router.js`, 'utf8');
  const configSource = readFileSync(`${root}/worker/src/consumer/config.js`, 'utf8');

  // The figures may only be serialised by the protected envelope builder.
  const publicPayload = configSource.slice(configSource.indexOf('export function publicConsumerConfig'));
  const publicBody = publicPayload.slice(0, publicPayload.indexOf('\nexport function '));
  for (const field of ['sessionBudgetMicroEur', 'dailyBudgetMicroEur', 'dispatchStopMicroEur',
    'warnThresholdMicroEur', 'safetyReserveMicroEur']) {
    assert.ok(
      !publicBody.includes(field),
      `publicConsumerConfig serialises ${field}. Spend figures belong to deploymentCostEnvelope, `
        + 'which is served only behind the deploy verification credential.'
    );
  }
  assert.match(routerSource, /if \(!isDeployVerificationRequest\(request, env\)\) \{/,
    'the deployment envelope route must be gated by the verification credential');
  assert.match(routerSource, /expected\.length < 32/,
    'an unconfigured verification secret must authorise nobody');

  assert.match(workflow, /wrangler secret put CONSUMER_DEPLOY_VERIFICATION_KEY/,
    'the workflow must provision the verification credential as a Worker secret');
  assert.match(workflow, /echo "::add-mask::\$deploy_verification_key"/,
    'the verification credential must be masked before it can reach a log');
  assert.match(workflow, /echo "CONSUMER_DEPLOY_VERIFICATION_KEY=\$deploy_verification_key" >> "\$GITHUB_ENV"/,
    'the post-deploy check must receive the same value the Worker was given');
  assert.ok(
    workflow.indexOf('wrangler secret put CONSUMER_DEPLOY_VERIFICATION_KEY')
      < workflow.indexOf('Verify live consumer deployment mode'),
    'the credential must be provisioned before the step that uses it'
  );
  // The unauthenticated probe is the assertion that actually proves privacy, so
  // it must not be quietly dropped from the live check.
  const liveCheck = readFileSync(`${root}/scripts/check-consumer-live-deployment.mjs`, 'utf8');
  assert.match(liveCheck, /must not be readable publicly/,
    'the live check must prove the envelope route refuses an unauthenticated request');
  pass('the spend envelope is private, credentialled, and still verified live');
}

{
  /**
   * The adviser bridge and the deployed voice notice must agree.
   *
   * They did not: the bridge check pinned `voice-adviser-test-v1` while the
   * deployment moved to the OpenAI-audio notice, so it failed a Worker that was
   * disclosing correctly. The notice id is the consent key -- a stored
   * acknowledgement is rejected when it differs from the running config -- so
   * pinning a superseded id asserts that re-consent never happened.
   */
  const bridge = readFileSync(`${root}/scripts/check-consumer-live-advisor-bridge.mjs`, 'utf8');
  assert.doesNotMatch(
    bridge,
    /noticeId, 'voice-/,
    'the bridge check must read the expected notice from the protected environment, not restate it'
  );
  assert.match(bridge, /process\.env\.CONSUMER_BETA_VOICE_NOTICE_ID/,
    'the bridge check must derive the expected voice notice from the deploy environment');

  // The job environment the bridge check reads and the value actually deployed
  // must be the same string, or it would verify against a notice nobody shipped.
  const jobValue = (workflow.match(/^\s*CONSUMER_BETA_VOICE_NOTICE_ID: "([^"]*)"$/m) || [])[1];
  const deployedValue = (workflow.match(
    /CONSUMER_VOICE_NOTICE_ID: \['CONSUMER_BETA_VOICE_NOTICE_ID', '([^']*)'\]/
  ) || [])[1];
  assert.ok(jobValue, 'CONSUMER_BETA_VOICE_NOTICE_ID must be declared for the deploy job');
  assert.equal(jobValue, deployedValue,
    'the voice notice the bridge check verifies against is not the one the deploy ships');

  // A notice id may be superseded but never silently dropped: the router's
  // approved list must still contain whatever is being deployed.
  const routerSource = readFileSync(`${root}/worker/src/consumer/router.js`, 'utf8');
  const approved = (routerSource.match(/\[([^\]]*)\]\.includes\(config\?\.voiceNoticeId\)/) || [])[1] || '';
  assert.ok(approved.includes(`'${deployedValue}'`),
    `the router's approved voice notices do not include the deployed notice ${deployedValue}`);
  pass(`the adviser bridge verifies the deployed voice notice (${deployedValue})`);
}

console.info(`\n[DeployCanary] ${passes.length} assertions passed.`);
