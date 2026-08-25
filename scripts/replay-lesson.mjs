#!/usr/bin/env node

/**
 * Did the lesson land, and did it break anything next to it?
 *
 *   node ./scripts/replay-lesson.mjs <caseId> [--lesson=<id>] [--offline]
 *
 * WHY NOT `compareRuns`. runlog.mjs keys a run by prompt version, manifest and
 * released module set, and refuses to compare across keys — correctly, because
 * two different systems are not comparable. But compiling a lesson CHANGES that
 * key by design, so every post-lesson comparison would report "different
 * system" and tell you nothing. Naively reusing it here does not work.
 *
 * WHAT THIS DOES INSTEAD. It holds the TRAJECTORY constant. The adviser's own
 * recorded turns are replayed against the current build, in the same order,
 * with the same words; the only thing that has changed is the app. So the
 * divergence counts are directly comparable, and a lesson that landed shows up
 * as the divergence it came from disappearing.
 *
 * A DIVERGENCE THAT DISAPPEARS IS NOT ENOUGH. A lesson can resolve its own case
 * and quietly break the case next door, so anything that appears where there
 * was nothing before is reported just as loudly, and fails the run.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { deterministicFallbackExtraction } from '../worker/src/consumer/planning_facts.js';
import { extractSegmentedPlannerTurn } from '../worker/src/consumer/realtime_planner.js';
import { observedCanonicalFacts } from './agent-harness/observability.mjs';
import { deterministicShadow, divergencesFor } from './agent-harness/shadow.mjs';
import {
  makeConfig, makeEnv, newDatabase, newSession, openCallDatabase
} from './agent-harness/transports.mjs';
import { loadAgentContext, processAgentTurn } from '../worker/src/consumer/agent_session.js';
import { resolveConfirmationCandidateModuleIds } from '../worker/src/consumer/planning_context.js';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const caseId = args.find((arg) => !arg.startsWith('--'));
const offline = args.includes('--offline');
const lessonId = flag('lesson', '');

if (!caseId) {
  console.error('Which case? replay-lesson.mjs <caseId> [--lesson=<id>] [--offline]');
  process.exit(1);
}
const bundlePath = join('teaching/pending', caseId, 'bundle.json');
if (!existsSync(bundlePath)) {
  console.error(`No bundle at ${bundlePath}. Run "teach-call.mjs finish" for that case first.`);
  process.exit(1);
}
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
if (!apiKey && !offline) {
  console.error('OPENAI_API_KEY is required: the replay must run the REAL extraction, or the\n'
    + 'baseline it compares against is not the real system. Add --offline to check the\n'
    + 'plumbing, but do not read the result as evidence.');
  process.exit(1);
}

/** (turn, kind) — coarse enough to survive a reworded prompt, precise enough to locate. */
const key = (item) => `${item.turn}:${item.kind}`;

const env = makeEnv(openCallDatabase(newDatabase(`replay-${caseId}`)), {
  OPENAI_API_KEY: apiKey,
  CONSUMER_PLANNER_RECONCILIATION_MODE: process.env.CONSUMER_PLANNER_RECONCILIATION_MODE || 'legacy'
});
const config = makeConfig(env);
const { sessionId, meetingId } = await newSession(env, config);

console.info(`Replaying ${bundle.turns.length} turn(s) of ${caseId} against the current build`
  + `${offline ? ' (offline — plumbing only)' : ''}\n`);

const now = [];
for (const recorded of bundle.turns) {
  const before = observedCanonicalFacts(await loadAgentContext(env, config, sessionId, meetingId));
  let shadow = null;
  try {
    await processAgentTurn(env, config, {
      sessionId,
      meetingId,
      message: recorded.client,
      deps: {
        extractTurn: async (options) => (offline
          ? {
              extraction: deterministicFallbackExtraction({
                transcript: options.transcript,
                profile: options.context.profile,
                sourceTurnId: options.sourceTurnId
              }),
              metadata: { model: 'deterministic_fallback', latencyMs: 0, costMicroEur: 0 }
            }
          : extractSegmentedPlannerTurn(options)),
        // The adviser's own words again, unchanged. Holding these constant is
        // what makes the two runs comparable at all.
        renderText: async ({ context }) => {
          shadow = deterministicShadow(context, {
            confirmationCandidateModuleIds: (() => {
              try { return resolveConfirmationCandidateModuleIds(context.state, config); }
              catch (_error) { return []; }
            })()
          });
          return {
            text: recorded.expert?.said || '(the adviser acted without speaking)',
            fallback: false, decisions: [], usageMicroEur: 0, context
          };
        }
      }
    });
  } catch (error) {
    console.error(`Turn ${recorded.turn} failed to replay: ${error?.code || error?.message}`);
    process.exit(1);
  }
  const after = observedCanonicalFacts(await loadAgentContext(env, config, sessionId, meetingId));
  now.push(...divergencesFor({
    turn: recorded.turn,
    shadow,
    expert: recorded.expert,
    factsBefore: before,
    factsAfter: after
  }));
}

const beforeKeys = new Set((bundle.divergences || []).map(key));
const afterKeys = new Set(now.map(key));
const resolved = [...beforeKeys].filter((item) => !afterKeys.has(item));
const remaining = [...beforeKeys].filter((item) => afterKeys.has(item));
const appeared = [...afterKeys].filter((item) => !beforeKeys.has(item));

console.info(`when the case was recorded : ${beforeKeys.size} divergence(s)`);
console.info(`against the current build  : ${afterKeys.size} divergence(s)\n`);
if (resolved.length) console.info(`  ✓ resolved : ${resolved.join(', ')}`);
if (remaining.length) console.info(`  · remaining: ${remaining.join(', ')}`);
if (appeared.length) console.info(`  ✗ NEW      : ${appeared.join(', ')}`);

if (appeared.length) {
  console.error('\nA divergence appeared where there was none before. Whatever was changed has'
    + '\nbroken behaviour the adviser was happy with. Roll it back rather than shipping it'
    + '\nwith a caveat.');
  process.exit(1);
}
if (lessonId && !resolved.length) {
  console.error(`\nNothing resolved, so ${lessonId} has not landed. It is not learned until the`
    + '\ndivergence it came from stops appearing.');
  process.exit(1);
}
console.info(`\n${resolved.length ? 'Landed.' : 'No change.'} Nothing new broke.`);
