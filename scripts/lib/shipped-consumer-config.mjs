/**
 * The consumer environment the Worker will actually be deployed with.
 *
 * Reading wrangler.toml alone is misleading. The committed file holds the
 * DORMANT production defaults -- that is what makes an ordinary push unable to
 * enable anything -- and the deploy workflow rewrites named variables to their
 * approved values on the way to Cloudflare, only on the protected manual path.
 *
 * So "what ships" is wrangler.toml as overridden by the workflow's rewrite, and
 * anything that wants to check the shipped config before it ships has to resolve
 * both. This module does that once, so the pre-deploy checks cannot disagree
 * with each other about what is being deployed.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

export function readDeploySources() {
  return {
    workflow: readFileSync(`${root}/.github/workflows/deploy-worker.yml`, 'utf8'),
    wrangler: readFileSync(`${root}/worker/wrangler.toml`, 'utf8')
  };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.realtime] resolve the realtime canary rewrite too.
 *   The workflow applies it only inside `if (realtimeEnabled)`, so the default
 *   is the voice-only beta.
 * @returns {Map<string, string>} effective CONSUMER_* variables
 */
export function resolveShippedConsumerEnv({ realtime = true } = {}) {
  const { workflow, wrangler } = readDeploySources();
  const effective = new Map();

  // 1. The committed, dormant-by-default baseline.
  for (const [, name, value] of wrangler.matchAll(/^(CONSUMER_[A-Z0-9_]+) = "([^"]*)"$/gm)) {
    effective.set(name, value);
  }
  // 2. The protected beta rewrite.
  for (const [, name, value] of workflow.matchAll(
    /replaceTomlString\(\s*generatedSource,\s*'([A-Z0-9_]+)',\s*'([^']*)'\s*\)/g
  )) {
    effective.set(name, value);
  }
  // 3. The pinned beta values. Each is `[repository variable, approved default]`
  //    -- the workflow reads the variable if set and otherwise uses the default,
  //    and a separate protected assertion refuses anything but these exact
  //    values, so the default is what ships.
  for (const [, name, value] of workflow.matchAll(
    /^\s*(CONSUMER_[A-Z0-9_]+): \['CONSUMER_BETA_[A-Z0-9_]+', '([^']*)'\],?$/gm
  )) {
    effective.set(name, value);
  }
  // Only the realtime canary turns the paid realtime transport on, and only on
  // the protected manual path. Everything above is inert without this.
  effective.set('CONSUMER_REALTIME_VOICE_ENABLED', realtime ? 'true' : 'false');
  return effective;
}

/** The same variables as a plain env object, ready for `getConsumerConfig`. */
export function shippedConsumerEnv(options) {
  return Object.fromEntries(resolveShippedConsumerEnv(options));
}
