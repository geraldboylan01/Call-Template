#!/usr/bin/env node

/**
 * TWO ARMS, ONE GRADER: does the model need to author storage operations?
 *
 * ARM A is production shape: `buildPlannerReconciliationContext` hands the model
 * a mutation language — eight operation types, six note kinds, server-issued
 * slots, `valueJson` — and the model returns a plan.
 *
 * ARM B is the proposal: the model is shown the conversation, the holdings
 * already on file, and a list of fact ids with plain labels. Nothing else. It
 * returns CLAIMS. Deterministic code compiles those into the same operations,
 * and the same validator applies them.
 *
 * Both arms end at `applyReconciliationPlan` and are graded by the same module
 * on the same expectations, so what is being measured is the REPRESENTATION and
 * nothing else.
 *
 * WHAT THIS IS NOT. It is a feasibility spike, not authority to delete anything.
 * Fourteen cases and one run apiece cannot support retiring a path that carries
 * years of accumulated safety. The bar for that is stated at the bottom of this
 * file and is deliberately much higher.
 *
 * COST IS MEASURED FROM THE PROVIDER, NOT FROM US. Our own metering cannot be
 * used here: the planner's usage is priced through the Realtime model's rates,
 * and the turn reader is not metered at all, so a comparison drawn from our
 * telemetry would be comparing two different fictions.
 *
 *   node --env-file-if-exists=.env.local scripts/run-semantic-claims-spike.mjs
 *     --case <id>      run one case
 *     --repeat <n>     run every case n times (stochastic failures need this)
 *     --arm a|b|both   default both
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MODULE_IDS } from '../js/planning/contracts.js';
import { applyReconciliationPlan, buildReconciliationIdentityCatalogue } from '../js/planning/reconciliation.js';
import { compileClaims, readingsFromClaims } from '../js/planning/claim_compiler.js';
import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';
import { getSemanticFactDefinition, listSemanticFactDefinitions } from '../js/planning/semantic_facts.js';
import { describeConversationState } from '../worker/src/consumer/conversation.js';
import { buildPlanningContext } from '../worker/src/consumer/planning_context.js';
import {
  buildPlannerReconciliationContext,
  requestPlannerReconciliation
} from '../worker/src/consumer/planner_reconciliation.js';
import { readClientTurnFigures } from '../worker/src/consumer/turn_reading.js';
import {
  INTERPRETER_SYSTEM_PROMPT,
  VERIFIER_SYSTEM_PROMPT,
  PROMPT_VERSIONS,
  corroborate,
  readSemanticClaims
} from '../worker/src/consumer/semantic_claims.js';
import { canonicalProblems, collectionCounts } from './lib/canonical-grading.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const ONLY = flag('case');
const REPEAT = Math.max(1, Number(flag('repeat', '1')) || 1);
const ARM = String(flag('arm', 'both')).toLowerCase();
const KEY = String(process.env.OPENAI_API_KEY || '').trim();
if (!KEY) {
  console.error('OPENAI_API_KEY is not set. Run with --env-file-if-exists=.env.local from the repo root.');
  process.exit(1);
}

const MODEL = process.env.SPIKE_MODEL || 'gpt-5.6-luna';
const NOW = '2026-08-09T10:00:00.000Z';

const CONFIG = Object.freeze({
  realtimePlannerModel: MODEL,
  plannerReconciliationTimeoutMs: 60_000,
  plannerReconciliationMaxOutputTokens: 6_000,
  plannerReconciliationPromptVersion: 'planning-reconciliation-v2',
  plannerReconciliationMode: 'apply',
  // ARM A RUNS IN ITS BEST SHIPPED CONFIGURATION, not a strawman. Without the
  // independent reader the deterministic scan reads "two and a half thousand"
  // as 2 and refuses the correct figure — a defect Phase 3 already fixed, and
  // comparing against the version before that fix would be measuring a
  // convenient opponent rather than the system we actually have.
  turnReadingMode: 'apply',
  turnReadingModel: MODEL,
  turnReadingTimeoutMs: 30_000,
  turnReadingMaxOutputTokens: 800,
  semanticClaimsModel: MODEL,
  semanticClaimsTimeoutMs: 60_000,
  semanticClaimsMaxOutputTokens: 8_000,
  semanticClaimsReasoningEffort: process.env.SPIKE_EFFORT || 'low',
  goalRoutingEnabled: true,
  moduleRoutingEnabled: true,
  allowedModules: Object.values(MODULE_IDS),
  moduleOffersEnabled: true,
  realtimeSpokenCompletionEnabled: false
});

const fixtures = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/semantic-claims-spike.json', import.meta.url)),
  'utf8'
));
const cases = fixtures.cases.filter((item) => !ONLY || item.id === ONLY);
if (cases.length === 0) {
  console.error(`No case matches --case ${ONLY}.`);
  process.exit(1);
}

/* ============================================================ fixture setup */

function freshContext(testCase) {
  const seed = createHouseholdProfile({
    profileId: 'profile_semantic_spike',
    primaryPersonId: 'primary',
    nowIso: NOW,
    calculationDateIso: '2026-08-09'
  });
  seed.goals = [{
    goalId: 'goal_spike',
    type: testCase.goalType,
    title: 'The goal this meeting agreed',
    status: 'active',
    priority: 'high'
  }];
  // "hers is ninety" can only bind to somebody. A case about two owners needs
  // two owners on the profile, or a refusal is the correct answer.
  if (testCase.withPartner) {
    seed.partner = {
      personId: 'partner', role: 'partner', displayName: 'Aoife', employmentStatus: 'employee'
    };
  }
  const profile = normalizeHouseholdProfile(seed);
  const sessionRow = {
    id: 'cs_semantic_spike',
    current_profile_revision: profile.revision,
    confirmed_profile_revision: null
  };
  const planning = buildPlanningContext({ config: CONFIG, sessionRow, profile, channel: 'live' });
  return {
    ...planning,
    profile,
    sessionRow,
    state: planning.state || describeConversationState(profile, CONFIG)
  };
}

/** The transcript as stored rows: ids, roles, and the link each answer carries. */
function turnsFor(testCase) {
  let lastAssistant = null;
  return testCase.transcript.map((turn, index) => {
    const id = `turn_${index + 1}`;
    const row = {
      id,
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      finalized: true,
      sequence: index + 1,
      transcript: turn.text,
      created_at: new Date(Date.parse(NOW) + index * 1_000).toISOString(),
      // The proposition this answer replied to, as the live session records it.
      // Adjacency is not a substitute; it is what paired a bare "400" with the
      // wrong question and told the reconciler the client was discussing
      // something else entirely.
      answersTurnId: turn.role === 'assistant' ? null : lastAssistant
    };
    if (row.role === 'assistant') lastAssistant = id;
    return row;
  });
}

const tokensOf = (usage) => ({
  input: Number(usage?.input_tokens || 0),
  output: Number(usage?.output_tokens || 0),
  cached: Number(usage?.input_tokens_details?.cached_tokens || 0)
});
const addTokens = (left, right) => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cached: left.cached + right.cached
});
const NO_TOKENS = { input: 0, output: 0, cached: 0 };

/* ==================================================================== ARM A */

async function runCurrentPath(testCase) {
  const context = freshContext(testCase);
  const turns = turnsFor(testCase);
  const throughTurnId = [...turns].reverse().find((turn) => turn.role === 'user')?.id;
  const input = buildPlannerReconciliationContext({
    context, turns, notes: [], throughTurnId, reviewTurnIds: [throughTurnId]
  });
  // The reconciler and the independent reader, exactly as production runs them:
  // the reader never sees the plan, and its reading is the authority on which
  // figures the turn contains.
  const clientTurns = input.transcriptTurns.filter((turn) => turn.role !== 'assistant');
  const startedAt = Date.now();
  const [requested, ...readings] = await Promise.all([
    requestPlannerReconciliation({ env: { OPENAI_API_KEY: KEY }, config: CONFIG, input }),
    ...clientTurns.map((turn) => readClientTurnFigures({
      env: { OPENAI_API_KEY: KEY },
      config: CONFIG,
      turnId: turn.turnId,
      transcript: turn.text,
      assistantQuestion: input.transcriptTurns
        .find((candidate) => candidate.turnId === turn.answersTurnId)?.text || ''
    }).catch(() => null))
  ]);
  const latencyMs = Date.now() - startedAt;
  const validation = await applyReconciliationPlan({
    profile: context.profile,
    notes: [],
    plan: requested.plan,
    transcriptTurns: input.transcriptTurns,
    sessionId: 'cs_semantic_spike',
    transcriptWatermark: throughTurnId,
    baseProfileRevision: context.profile.revision,
    owners: input.owners,
    entities: input.entities,
    turnReadings: readings.filter(Boolean),
    nowIso: NOW
  });
  const operations = (requested.plan?.operationGroups || []).flatMap((group) => group.operations);
  return {
    profile: validation.profile,
    validation,
    latencyMs,
    // The reader is part of this arm, so its calls and tokens are too. Counting
    // only the reconciler would understate what the current path actually costs.
    calls: 1 + clientTurns.length,
    tokens: {
      input: Number(requested.metadata?.inputTokens || 0),
      output: Number(requested.metadata?.outputTokens || 0),
      cached: Number(requested.metadata?.cachedInputTokens || 0)
    },
    clarifications: operations.filter((operation) => operation.op === 'request_clarification').length
      + (validation.clarificationNeeds || []).length,
    notes: []
  };
}

/* ==================================================================== ARM B */

/** Fact ids and plain labels. Not where they are stored, not what shape they take. */
function factCatalogue(input) {
  const inPlay = new Set([
    ...(input.needs || []).map((need) => need.factId),
    ...(input.valueContracts || []).map((entry) => entry.factId),
    ...(input.positionContracts || []).map((entry) => entry.factId)
  ].filter(Boolean));
  return listSemanticFactDefinitions()
    .filter((definition) => inPlay.has(definition.factId))
    .map((definition) => ({ factId: definition.factId, label: definition.label }));
}

async function runClaimsPath(testCase, { solo = false } = {}) {
  const context = freshContext(testCase);
  const turns = turnsFor(testCase);
  const throughTurnId = [...turns].reverse().find((turn) => turn.role === 'user')?.id;
  // Arm A's context builder is reused ONLY to derive the owner and entity
  // catalogue and the set of facts in play — the same starting position for both
  // arms. None of its contracts, slots or prompts reach the model in this arm.
  const input = buildPlannerReconciliationContext({
    context, turns, notes: [], throughTurnId, reviewTurnIds: [throughTurnId]
  });
  const transcript = input.transcriptTurns.map((turn) => ({
    turnId: turn.turnId, role: turn.role, text: turn.text
  }));
  const knownEntities = (input.entities || [])
    .filter((entity) => !entity.newEntitySlot)
    .map((entity) => ({ entityId: entity.entityId, label: entity.label }));
  const facts = factCatalogue(input);

  const startedAt = Date.now();
  // CONCURRENT AND BLIND. Neither reading is shown the other's answer, so
  // agreement cannot be an echo. Running them in parallel also means the second
  // opinion costs a second call rather than a second wait.
  const [interpreted, verified] = await Promise.all([
    readSemanticClaims({
      env: { OPENAI_API_KEY: KEY },
      config: CONFIG,
      systemPrompt: INTERPRETER_SYSTEM_PROMPT,
      promptVersion: PROMPT_VERSIONS.interpreter,
      transcript,
      knownEntities,
      factCatalogue: facts
    }),
    readSemanticClaims({
      env: { OPENAI_API_KEY: KEY },
      config: CONFIG,
      systemPrompt: VERIFIER_SYSTEM_PROMPT,
      promptVersion: PROMPT_VERSIONS.verifier,
      transcript,
      knownEntities,
      factCatalogue: facts
    })
  ]);
  const latencyMs = Date.now() - startedAt;
  const tokens = addTokens(tokensOf(interpreted.usage), tokensOf(verified.usage));

  if (!interpreted.reading || !verified.reading) {
    return {
      profile: context.profile,
      latencyMs,
      calls: 2,
      tokens,
      failed: interpreted.error || verified.error,
      clarifications: 0,
      claims: { corroborated: [], disputed: [] }
    };
  }

  const agreement = corroborate(interpreted.reading, verified.reading, {
    singletonFactIds: input.singletonFactIds || []
  });
  // SOLO ISOLATES THE TWO HYPOTHESES. "Can a model express this conversation as
  // claims at all" and "can two independent readings agree on them" are
  // different questions, and a single pass/fail number cannot tell which one
  // failed. Solo takes the interpreter's claims uncorroborated — deliberately
  // unsafe, and never a shipping configuration — purely so the two can be told
  // apart.
  const corroborated = solo ? interpreted.reading.claims : agreement.corroborated;
  const disputed = solo ? [] : agreement.disputed;

  const owners = new Map((input.owners || []).map((owner) => [owner.ownerId, owner]));
  const entities = new Map((input.entities || []).map((entity) => [entity.entityId, entity]));
  const { plan, uncompilable } = compileClaims(corroborated, { owners, entities });
  // The claims are the reading of their own turns. Without this the validator
  // falls back to the deterministic scan this architecture exists to retire,
  // and refuses the correct figure it just corroborated twice.
  const claimReadings = readingsFromClaims(corroborated, {
    quantityFor: (claim) => (getSemanticFactDefinition(claim.factId)?.valueType === 'money'
      ? 'money'
      : 'count')
  });

  const validation = await applyReconciliationPlan({
    profile: context.profile,
    notes: [],
    plan,
    transcriptTurns: input.transcriptTurns,
    sessionId: 'cs_semantic_spike',
    transcriptWatermark: throughTurnId,
    baseProfileRevision: context.profile.revision,
    owners: input.owners,
    entities: input.entities,
    turnReadings: claimReadings,
    nowIso: NOW
  });
  const operations = plan.operationGroups.flatMap((group) => group.operations);
  return {
    profile: validation.profile,
    validation,
    latencyMs,
    calls: 2,
    tokens,
    clarifications: operations.filter((operation) => operation.op === 'request_clarification').length
      + (validation.clarificationNeeds || []).length,
    claims: { corroborated, disputed },
    uncompilable
  };
}

/* =================================================================== grading */

function grade(testCase, outcome) {
  const problems = [];
  if (outcome.failed) return { ok: false, problems: [`arm failed: ${outcome.failed}`] };

  const expectations = testCase.expect.canonical || [];
  const forbidden = testCase.expect.forbidden || [];
  problems.push(...canonicalProblems(outcome.profile, expectations, forbidden));

  // DUPLICATED OR COLLAPSED ENTITIES. Two pensions where the client has one
  // silently doubles a retirement pot; one where they have two loses a holding.
  // Neither is visible to any check that looks only at amounts.
  if (testCase.expect.collections) {
    const counts = collectionCounts(outcome.profile);
    for (const [collection, want] of Object.entries(testCase.expect.collections)) {
      if (counts[collection] !== want) {
        problems.push(`${collection} holds ${counts[collection]} record(s), expected ${want}`);
      }
    }
  }
  if (testCase.expect.clarificationExpected === true && outcome.clarifications === 0) {
    problems.push('no clarification was raised where the client had to be asked');
  }
  const rejected = (outcome.validation?.rejectedGroups || [])
    .map((group) => (group.message ? `${group.code} (${group.message})` : group.code));
  return { ok: problems.length === 0, problems, rejected };
}

/* ==================================================================== report */

console.log(`Semantic-claims spike — ${cases.length} case(s) x ${REPEAT}`);
console.log(`model: ${MODEL}  effort: ${CONFIG.semanticClaimsReasoningEffort}  arms: ${ARM}\n`);

const ARMS = ['a', 'b', 'solo'];
const tally = Object.fromEntries(ARMS.map((arm) => [
  arm, { passed: 0, failed: 0, tokens: { ...NO_TOKENS }, latency: [], calls: 0 }
]));
const perCase = new Map();
let uncompilableTotal = 0;
let disputedTotal = 0;

for (const testCase of cases) {
  for (let attempt = 1; attempt <= REPEAT; attempt += 1) {
    const suffix = REPEAT > 1 ? ` (run ${attempt}/${REPEAT})` : '';
    for (const arm of ARMS) {
      if (ARM !== 'both' && ARM !== arm) continue;
      let outcome;
      try {
        outcome = arm === 'a'
          ? await runCurrentPath(testCase)
          : await runClaimsPath(testCase, { solo: arm === 'solo' });
      } catch (error) {
        outcome = { failed: String(error?.message || error), tokens: NO_TOKENS, latencyMs: 0, calls: 0 };
      }
      const verdict = grade(testCase, outcome);
      tally[arm][verdict.ok ? 'passed' : 'failed'] += 1;
      tally[arm].tokens = addTokens(tally[arm].tokens, outcome.tokens || NO_TOKENS);
      tally[arm].latency.push(outcome.latencyMs || 0);
      tally[arm].calls += outcome.calls || 0;
      const key = `${testCase.id}:${arm}`;
      perCase.set(key, (perCase.get(key) || 0) + (verdict.ok ? 1 : 0));

      console.log(`  ${verdict.ok ? 'PASS' : 'FAIL'}  [${arm.toUpperCase()}] ${testCase.id}${suffix}`);
      if (!verdict.ok) {
        for (const problem of verdict.problems) console.log(`         ${problem}`);
        if (verdict.rejected?.length) console.log(`         gate refused: ${verdict.rejected.join(', ')}`);
      }
      if (arm !== 'a') {
        if (process.env.SPIKE_DEBUG) {
          console.log(`         corroborated ${outcome.claims?.corroborated?.length ?? 0}: `
            + JSON.stringify((outcome.claims?.corroborated || []).map((c) => (
              { f: c.factId, a: c.amount, o: c.ownerRef, e: c.entityAction, m: c.modality }))));
        }
        disputedTotal += outcome.claims?.disputed?.length || 0;
        uncompilableTotal += outcome.uncompilable?.length || 0;
        // A claim the compiler could not place is a gap in the REPRESENTATION,
        // and it has to be counted rather than absorbed into a shorter plan.
        for (const item of outcome.uncompilable || []) {
          console.log(`         uncompilable: ${item.claim.factId} — ${item.reason}`);
        }
        for (const item of outcome.claims?.disputed || []) {
          console.log(`         disputed: ${item.claim.factId} ${item.claim.amount ?? ''} — ${item.reason}`);
          if (process.env.SPIKE_DEBUG) console.log(`           ${JSON.stringify(item.claim)}`);
        }
      }
    }
  }
}

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

console.log('\n──────────────────────────────────────────────────────────────');
for (const arm of ARMS) {
  if (ARM !== 'both' && ARM !== arm) continue;
  const stats = tally[arm];
  const total = stats.passed + stats.failed;
  if (total === 0) continue;
  const label = arm === 'a' ? 'A     current path (model authors operations)'
    : arm === 'b' ? 'B     claims path, corroborated by two blind readings'
      : 'SOLO  claims path, interpreter only — UNSAFE, diagnostic only';
  console.log(`\n${label}`);
  console.log(`   passed          : ${stats.passed}/${total} (${Math.round((stats.passed / total) * 100)}%)`);
  console.log(`   model calls     : ${stats.calls}`);
  console.log(`   tokens in/out   : ${stats.tokens.input} / ${stats.tokens.output}  (cached ${stats.tokens.cached})`);
  console.log(`   latency median  : ${median(stats.latency)}ms`);
}
if (ARM === 'both') {
  console.log('\nPer case (passes out of ' + REPEAT + '):');
  for (const testCase of cases) {
    const a = perCase.get(`${testCase.id}:a`) ?? 0;
    const b = perCase.get(`${testCase.id}:b`) ?? 0;
    const marker = b > a ? '  B better' : a > b ? '  A better' : '';
    console.log(`   ${testCase.id.padEnd(30)} A ${a}/${REPEAT}   B ${b}/${REPEAT}${marker}`);
  }
}
if (ARM !== 'a') {
  console.log(`\nArm B diagnostics: ${disputedTotal} disputed claim(s), ${uncompilableTotal} uncompilable claim(s).`);
  console.log('A disputed claim is the two readings failing to agree on the FULL signature —');
  console.log('fact, owner, entity, value, unit, modality and meaning — not merely the number.');
}

/* THE BAR FOR ACTUALLY REPLACING ANYTHING, stated here so it cannot drift.
 *
 * This spike decides only whether the representation is worth pursuing. Before
 * any part of the current path is deleted:
 *   - 40-60 stratified claim-level cases, and 10+ annotated production-shaped
 *     transcripts, including every transcript we have that has already failed;
 *   - 5 repeated runs per configuration, because the failures that matter here
 *     are stochastic and a single run cannot see them;
 *   - grading end to end: claim ledger, canonical state, outstanding needs and
 *     the exact module inputs;
 *   - ZERO wrong-owner bindings, ZERO duplicate entities and ZERO invented
 *     values reaching a verified snapshot. Not "fewer than A" — zero.
 * Anything less measures a prototype and licenses dismantling a system that has
 * absorbed years of real failures. */
process.exit(0);
