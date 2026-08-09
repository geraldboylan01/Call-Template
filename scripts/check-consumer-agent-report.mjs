/**
 * A7 — deterministic guarantees for callers, blockers, grading and trends.
 *
 * Free to run. The properties proved here are the ones the feedback loop rests
 * on: a caller is used verbatim, a blocker is found the same way every time, a
 * blank grade is not a zero, and two runs of different systems are never
 * compared as though they were the same one.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BLOCKER_IDS,
  classifyMissingInput,
  detectBlockers,
  detectExecutionBlockers,
  MISSING_INPUT_CAUSES,
  newBlockersAfterTurn,
  shouldAbandon
} from './agent-harness/blockers.mjs';
import {
  buildGradingSheet, calibrate, describeCalibration, GRADE_DIMENSIONS, parseGradingSheet
} from './agent-harness/grading.mjs';
import { parseCaller, callerBrief, loadCallerFixture } from './agent-harness/caller.mjs';
import { archiveCandidates, usageDelta } from './agent-harness/observability.mjs';
import {
  exportCall,
  exportReconciliationShadow,
  exportReconciliationShadowSpan,
  traceIdForCall,
  traceLinkForCall
} from './agent-harness/langfuse-export.mjs';
import { __testing as langfuseTesting } from './lib/langfuse.mjs';
import {
  AGENT_RUN_ARCHIVE_VERSION,
  applyRetention,
  compareRuns,
  firstGoalTurn,
  loadRuns,
  regressionsIn,
  runKey,
  saveRun,
  trendFor
} from './agent-harness/runlog.mjs';
import { aggregateReviews, normaliseReview, reviewCall } from './agent-judges/review.mjs';

let checks = 0;
const check = (label, condition, detail = '') => {
  checks += 1;
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
};

const turn = (over = {}) => ({
  questionFactId: null, goals: [], analyses: [], factIds: [],
  acceptedFactIds: [], rejectedFactIds: [], plannerErrorCode: null, degraded: false, ...over
});

/* ------------------------------------------------------------- callers */

{
  const raw = `Deirdre, 44, self-employed graphic designer in Galway.
Earns about 52,000 a year. No pension at all. Renting.
Has 12,000 saved. Wants to buy somewhere in the next few years.

# Questions
- Am I mad not to have a pension at my age?
- Could I actually afford a mortgage on my own?

# Behaviour
- deflects when asked about money
- asks a lot of questions back`;

  const caller = parseCaller(raw, 'deirdre');
  const brief = callerBrief(caller);

  // The pasted words are used verbatim: any restructuring would decide in
  // advance which details matter, and the dropped ones are what a call trips on.
  check('the caller text survives verbatim', brief.includes('self-employed graphic designer in Galway'));
  check('an exact figure survives verbatim', brief.includes('52,000'));
  check('an absence survives verbatim', brief.includes('No pension at all'));
  check('questions are parsed off', caller.client.questions.length === 2);
  check('behaviours are parsed off', caller.client.behaviours.length === 2);
  check('question markers are stripped from the brief body', !brief.split('Things you want to ask')[0].includes('# Questions'));
  check('questions are given as things to raise, not a checklist',
    /Raise them when it feels natural/.test(brief));
  check('a caller carries no answer key', Object.keys(caller.expected).length === 0);
  check('a caller is marked synthetic', caller.synthetic === true);

  const plain = parseCaller('Just a person with a pension question.', 'plain');
  check('a file with no headings is valid', callerBrief(plain).trim() === 'Just a person with a pension question.');
  check('an empty caller is refused',
    (() => { try { parseCaller('   ', 'x'); return false; } catch { return true; } })());

  const bulleted = parseCaller('Someone.\n\n## Questions\n1. First?\n* Second?\n- Third?', 'b');
  check('numbered, starred and dashed questions all parse',
    bulleted.client.questions.length === 3, JSON.stringify(bulleted.client.questions));
}

{
  const dir = mkdtempSync(join(tmpdir(), 'agent-caller-fixture-'));
  try {
    const callerPath = join(dir, 'retire.md');
    const keyPath = join(dir, 'retire.answer-key.json');
    writeFileSync(callerPath, 'Age 57. Wants to compare retiring now with retiring next year.');
    writeFileSync(keyPath, JSON.stringify({
      schemaVersion: 1,
      frozenAt: '2026-08-09T00:00:00.000Z',
      buckets: { goals: [{ id: 'retire_now_or_later' }] }
    }));
    const loaded = loadCallerFixture(callerPath);
    check('an optional frozen answer key is loaded outside the caller model brief',
      loaded.answerKey.buckets.goals[0].id === 'retire_now_or_later'
      && Object.keys(loaded.caller.expected).length === 0);
    check('the persona and answer key receive stable sha256 freeze hashes',
      /^sha256:[a-f0-9]{64}$/.test(loaded.fixture.personaHash)
      && /^sha256:[a-f0-9]{64}$/.test(loaded.fixture.answerKey.hash));
    check('answer-key freeze metadata is retained without copying scoring truth into caller.expected',
      loaded.fixture.answerKey.schemaVersion === 1
      && loaded.fixture.answerKey.frozenAt === '2026-08-09T00:00:00.000Z');

    writeFileSync(join(dir, 'plain.md'), 'A caller with no answer key.');
    check('a caller without an answer key remains valid',
      loadCallerFixture(join(dir, 'plain.md')).fixture.answerKey === null);
    writeFileSync(join(dir, 'broken.md'), 'A caller.');
    writeFileSync(join(dir, 'broken.answer-key.json'), '{broken');
    check('a malformed frozen answer key fails before a paid call', (() => {
      try { loadCallerFixture(join(dir, 'broken.md')); return false; } catch { return true; }
    })());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------- blockers */

{
  const repeated = [
    turn({ questionFactId: 'property_position' }),
    turn({ questionFactId: 'property_position' }),
    turn({ questionFactId: 'property_position' })
  ];
  const findings = detectBlockers(repeated);
  const repeatFinding = findings.find((item) => item.id === 'repeated_question');
  check('the live loop that started all this is detected', Boolean(repeatFinding));
  check('it is reported as blocking', repeatFinding.severity === 'blocking');
  check('it names the turns it happened on', /turns 1, 2, 3/.test(repeatFinding.detail), repeatFinding.detail);

  check('asking twice is not yet a loop',
    !detectBlockers([turn({ questionFactId: 'a' }), turn({ questionFactId: 'a' })])
      .some((item) => item.id === 'repeated_question'));

  const distinctPensions = [
    turn({ questionFactId: 'pension_current_value', questionFactInstanceId: 'pension_current_value:p1' }),
    turn({ questionFactId: 'pension_current_value', questionFactInstanceId: 'pension_current_value:p2' }),
    turn({ questionFactId: 'pension_current_value', questionFactInstanceId: 'pension_current_value:p3' })
  ];
  check('three owner-scoped questions with one bare fact id are not a repeated-question loop',
    !detectBlockers(distinctPensions).some((item) => item.id === 'repeated_question'));

  const answeredThenAsked = [
    turn({ questionFactId: 'person_current_age', acceptedFactIds: ['person_current_age'] }),
    turn({ questionFactId: 'person_current_age' })
  ];
  check('asking for something already answered is caught',
    detectBlockers(answeredThenAsked).some((item) => item.id === 'asked_again_after_answering'));

  check('a lost goal is caught', detectBlockers([
    turn({ goals: ['retire'] }), turn({ goals: [] })
  ]).some((item) => item.id === 'goal_lost'));

  check('a planner error is caught', detectBlockers([turn({ plannerErrorCode: 'planner_failed' })])
    .some((item) => item.id === 'planner_error'));

  check('a turn with nothing to answer is caught', detectBlockers([turn({})])
    .some((item) => item.id === 'no_question_left'));

  const stalled = Array.from({ length: 3 }, () => turn({ questionFactId: 'x', goals: ['retire'] }));
  check('three turns that changed nothing is a stall',
    detectBlockers(stalled).some((item) => item.id === 'stalled_progress'));

  const healthy = [
    turn({ questionFactId: 'primary_goal', goals: ['retire'], acceptedFactIds: ['primary_goal'] }),
    turn({ questionFactId: 'person_current_age', goals: ['retire'], analyses: ['pension_projection'], factIds: ['primary_goal'] }),
    turn({ questionFactId: 'pension_positions', goals: ['retire'], analyses: ['pension_projection'], factIds: ['primary_goal', 'person_current_age'] })
  ];
  check('a healthy call produces no blocking findings',
    detectBlockers(healthy).every((item) => item.severity !== 'blocking'),
    JSON.stringify(detectBlockers(healthy)));

  // Findings are ordered worst-first, so a report leads with what matters.
  const mixed = detectBlockers([...repeated, turn({ rejectedFactIds: ['cash_savings'] })]);
  check('findings are ordered worst first', mixed[0].severity === 'blocking');

  // Mid-call detection reports each finding ONCE, or every later turn would
  // re-report the same loop and drown the real signal.
  const seen = new Set();
  const first = newBlockersAfterTurn(repeated, seen);
  const second = newBlockersAfterTurn(repeated, seen);
  check('a mid-call finding is reported once', first.length > 0 && second.length === 0);
  check('a call going nowhere is abandonable', shouldAbandon(first));
  check('a call with only friction is not abandoned',
    !shouldAbandon(detectBlockers([turn({ questionFactId: 'a', rejectedFactIds: ['b'] })])));
  check('every detector has an id', BLOCKER_IDS.length >= 10 && BLOCKER_IDS.every(Boolean));
  check('the missing-input taxonomy names every planned diagnostic layer',
    MISSING_INPUT_CAUSES.includes('stated_but_never_extracted')
    && MISSING_INPUT_CAUSES.includes('persisted_but_not_used')
    && MISSING_INPUT_CAUSES.includes('wrong_owner_capture'));

  const missing = { factId: 'pension_employee_contribution_rate', factInstanceId: 'pension_employee_contribution_rate:p1' };
  check('a requirement that was never questioned is classified as never asked',
    classifyMissingInput(missing, []).cause === 'never_asked');
  check('a requirement with a signed instance question is classified as asked but unanswered',
    classifyMissingInput(missing, [turn({
      questionFactId: missing.factId,
      questionFactInstanceId: missing.factInstanceId
    })]).cause === 'asked_but_unanswered');
  const rejectedTurn = turn({
    observation: { extraction: { candidates: [{
      factId: missing.factId,
      factInstanceId: missing.factInstanceId,
      accepted: false,
      rejectionCode: 'pension_ambiguous',
      certainty: 'exact'
    }] } }
  });
  check('a rejected extracted value is distinguished from a never-asked input',
    classifyMissingInput(missing, [rejectedTurn]).cause === 'stated_but_rejected');
  const unknownTurn = turn({
    observation: { extraction: { candidates: [{
      factId: missing.factId,
      factInstanceId: missing.factInstanceId,
      accepted: true,
      certainty: 'unknown'
    }] } }
  });
  check('an explicit unknown is distinguished from an unanswered question',
    classifyMissingInput(missing, [unknownTurn]).cause === 'explicit_unknown');
  const persistedTurn = turn({
    observation: { extraction: { candidates: [] }, canonicalFactsAfter: [{
      factId: missing.factId,
      factInstanceId: missing.factInstanceId
    }] }
  });
  check('a persisted fact still reported missing is classified as not used',
    classifyMissingInput(missing, [persistedTurn]).cause === 'persisted_but_not_used');
  const executionFinding = detectExecutionBlockers({
    status: 'needs_information', moduleIds: ['pension_projection'], gatedModuleIds: [],
    missingForModules: [{ ...missing, moduleIds: ['pension_projection'] }]
  }, 1, [rejectedTurn]).find((item) => item.id === 'analysis_missing_input');
  check('execution blockers carry the concrete cause and exact instance identity',
    executionFinding.cause === 'stated_but_rejected'
    && executionFinding.factInstanceId === missing.factInstanceId
    && /pension_ambiguous/.test(executionFinding.detail));
  const unknownFindings = detectExecutionBlockers({
    status: 'needs_information', moduleIds: ['pension_projection'], gatedModuleIds: [],
    missingForModules: [{ ...missing, moduleIds: ['pension_projection'] }]
  }, 1, [unknownTurn]);
  check('a genuinely unavailable input remains visible without being called a system blocker',
    unknownFindings.filter((item) => ['analysis_missing_input', 'analysis_did_not_run'].includes(item.id))
      .every((item) => item.severity === 'smell'));
}

/* --------------------------------------------------------- observations */

{
  const profile = {
    primaryPerson: { personId: 'primary-1' },
    partner: { personId: 'partner-1' },
    pensions: [{ pensionId: 'pension-a', ownerId: 'partner-1' }]
  };
  const candidates = archiveCandidates({
    profile,
    candidates: [{
      candidateId: 'c1', factId: 'pension_current_value', operation: 'upsert',
      value: { entityId: 'pension-a', owner: 'partner', amount: 50_000 },
      certainty: 'approximate', evidenceText: 'hers is about fifty thousand'
    }],
    outcomes: [{
      candidateId: 'c1', factId: 'pension_current_value', accepted: false,
      errorCode: 'money_invalid'
    }]
  });
  check('candidate observations retain value, exact evidence and rejection code',
    candidates[0].value.amount === 50_000
    && candidates[0].evidenceText === 'hers is about fifty thousand'
    && candidates[0].rejectionCode === 'money_invalid');
  check('candidate observations preserve owner and instance identity',
    candidates[0].ownerId === 'partner-1'
    && candidates[0].entityId === 'pension-a'
    && candidates[0].factInstanceId === 'pension_current_value:pension-a');
  const boundAnswer = archiveCandidates({
    profile,
    askedQuestion: {
      targets: [{
        factId: 'pension_employee_contribution_rate',
        factInstanceId: 'pension_employee_contribution_rate:pension-a',
        entityId: 'pension-a',
        ownerId: 'partner-1'
      }]
    },
    candidates: [{
      candidateId: 'rate', factId: 'pension_employee_contribution_rate',
      value: { rate: 0.08 }, certainty: 'exact', evidenceText: 'eight percent'
    }],
    outcomes: [{ candidateId: 'rate', factId: 'pension_employee_contribution_rate', accepted: true }]
  });
  check('an answer inherits the exact signed question instance in the archive',
    boundAnswer[0].factInstanceId === 'pension_employee_contribution_rate:pension-a'
    && boundAnswer[0].ownerId === 'partner-1');
  const repaired = archiveCandidates({
    candidates: [{
      candidateId: 'first-pass', factId: 'cash_savings', value: 'not-money',
      evidenceText: 'about fifty thousand'
    }],
    outcomes: [{ candidateId: 'repair-pass', factId: 'cash_savings', accepted: true }]
  });
  check('a repair outcome is not falsely attributed to the first-pass candidate shape',
    repaired[0].accepted === null
    && repaired[1].accepted === true
    && repaired[1].source === 'repair_outcome_without_raw_extraction');

  const delta = usageDelta({
    clientCalls: 1, plannerCalls: 1,
    client: { model: 'client-model', inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 },
    planner: { model: 'planner-model', inputTokens: 200, outputTokens: 20, cachedInputTokens: 100 },
    plannerLatenciesMs: [500]
  }, {
    clientCalls: 2, plannerCalls: 2,
    client: { model: 'client-model', inputTokens: 250, outputTokens: 25, cachedInputTokens: 90 },
    planner: { model: 'planner-model', inputTokens: 500, outputTokens: 50, cachedInputTokens: 240 },
    plannerLatenciesMs: [500, 750]
  });
  check('per-turn usage keeps cached input as a subset rather than adding it to input',
    delta.planner.inputTokens === 300 && delta.planner.cachedInputTokens === 140);
  check('per-turn planner latency is retained',
    delta.planner.latencyMs === 750 && delta.planner.latenciesMs.join() === '750');
}

/* ------------------------------------------------------------- Langfuse */

{
  const makeCollector = () => new langfuseTesting.LangfuseCollector({
    host: 'https://example.invalid', publicKey: 'pk-test', secretKey: 'sk-test',
    release: 'test', environment: 'harness', tags: [], sessionId: 'run-1'
  });
  const record = { runId: 'run-1', runKey: 'test', generatedAt: '2026-08-09T12:00:00.000Z' };
  const baseCall = {
    callId: 'call-1', caller: 'synthetic', synthetic: true,
    transcript: [
      { id: 'client-1', role: 'client', text: 'I have about fifty thousand.' },
      { id: 'assistant-1', role: 'assistant', text: 'Thanks.' }
    ],
    turnRecords: [{
      clientTurnId: 'client-1', assistantTurnId: 'assistant-1',
      observation: {
        extraction: { raw: { semanticFacts: [{ factId: 'cash_savings', valueJson: '50000' }] }, candidates: [] },
        profiles: { beforeRevision: 0, afterRevision: 1 }
      }
    }],
    blockers: [],
    usage: {
      planner: {
        model: 'planner-model', inputTokens: 200, outputTokens: 20,
        cachedInputTokens: 150, latencyMs: 50
      }
    },
    execution: { status: 'not_attempted' }
  };
  const syntheticCollector = makeCollector();
  exportCall(syntheticCollector, record, { ...baseCall, contentPolicy: 'synthetic_test_content' });
  check('synthetic Langfuse traces include a nested raw-extraction observation',
    syntheticCollector.spans.some((span) => span.name === 'planner.extraction'));
  const plannerSpan = syntheticCollector.spans.find((span) => span.name === 'planner');
  check('cached input tokens stay outside the gen_ai usage namespace',
    plannerSpan.attributes.some((item) => item.key === 'langfuse.observation.metadata.cachedInputTokens')
    && !plannerSpan.attributes.some((item) => /gen_ai\.usage\..*cached/i.test(item.key)));

  const publicCollector = makeCollector();
  const privacySentinels = {
    caller: 'PRIVATE_CALLER_SENTINEL_94217',
    review: 'PRIVATE_REVIEW_SENTINEL_94218',
    tag: 'PRIVATE_ARBITRARY_TAG_SENTINEL_94219',
    evidence: 'PRIVATE_EVIDENCE_SENTINEL_94220',
    value: 'PRIVATE_VALUE_SENTINEL_94221'
  };
  const metadataOnlyCall = {
    ...baseCall,
    caller: privacySentinels.caller,
    callerPath: `/ignored/${privacySentinels.caller}.md`,
    tags: [privacySentinels.tag],
    review: { biggestSingleChange: privacySentinels.review },
    turnRecords: [{
      clientTurnId: privacySentinels.evidence,
      assistantTurnId: privacySentinels.value,
      questionFactInstanceId: privacySentinels.value,
      rejectedFactInstances: [{ rejectionCode: privacySentinels.evidence }],
      observation: {
        extraction: {
          raw: {
            evidenceText: privacySentinels.evidence,
            semanticFacts: [{ factId: 'cash_savings', valueJson: privacySentinels.value }]
          },
          candidates: [{ value: privacySentinels.value, evidenceText: privacySentinels.evidence }]
        },
        profiles: { beforeRevision: 0, afterRevision: 1 }
      }
    }],
    blockers: [{ severity: 'blocking', id: privacySentinels.evidence, turn: 1 }],
    judge: {
      available: true, tone: 5, groundedness: 5, explains_why: 5, momentum: 5,
      note: privacySentinels.review
    },
    scores: { naturalness: 5, [privacySentinels.tag]: 5 },
    scoreNote: privacySentinels.review,
    contentPolicy: 'metadata_only'
  };
  exportCall(publicCollector, {
    ...record,
    runKey: privacySentinels.tag
  }, metadataOnlyCall);
  const contentKeys = new Set([
    'langfuse.observation.input', 'langfuse.observation.output',
    'langfuse.trace.input', 'langfuse.trace.output'
  ]);
  check('metadata-only public/live traces suppress transcript and planner content',
    !publicCollector.spans.some((span) => span.attributes.some((item) => contentKeys.has(item.key))));
  check('metadata-only public/live traces do not create raw-extraction spans',
    !publicCollector.spans.some((span) => span.name === 'planner.extraction'));
  check('metadata-only public/live traces suppress caller, review, tag, evidence and value sentinels',
    Object.values(privacySentinels)
      .every((sentinel) => !JSON.stringify(publicCollector).includes(sentinel)));
  check('metadata-only traces retain fixed scores but reject arbitrary score names',
    publicCollector.pendingScores.some((score) => score.name === 'naturalness')
    && !publicCollector.pendingScores.some((score) => score.name === privacySentinels.tag));

  const nonSyntheticCollector = makeCollector();
  exportCall(nonSyntheticCollector, record, {
    ...metadataOnlyCall,
    synthetic: false,
    contentPolicy: 'synthetic_test_content'
  });
  check('the content policy alone never enables content for a non-synthetic call',
    !nonSyntheticCollector.spans.some((span) => span.name === 'planner.extraction')
    && Object.values(privacySentinels)
      .every((sentinel) => !JSON.stringify(nonSyntheticCollector).includes(sentinel)));

  const reconciliationCollector = makeCollector();
  const reconciliationTraceId = traceIdForCall('run-1', 'call-1');
  const reconciliation = exportReconciliationShadowSpan(reconciliationCollector, {
    runId: 'run-1', callId: 'call-1', traceId: reconciliationTraceId,
    checkpoint: 'full-call', synthetic: true, contentPolicy: 'synthetic_test_content',
    finishedAt: '2026-08-09T12:00:01.000Z',
    input: { evidence: privacySentinels.evidence },
    output: { value: privacySentinels.value },
    verdict: 'changes_proposed', status: 'shadow',
    operationCount: 4, acceptedOperationCount: 3, rejectedOperationCount: 1,
    clarificationCount: 0,
    usage: {
      model: 'planner-model', inputTokens: 300, outputTokens: 40,
      cachedInputTokens: 220, latencyMs: 750
    }
  }, { env: { LANGFUSE_HOST: 'https://example.invalid/' } });
  const reconciliationSpan = reconciliationCollector.spans
    .find((span) => span.name === 'planner.reconciliation.shadow');
  const reconciliationRoot = reconciliationCollector.spans
    .find((span) => span.name === 'call:reconciliation-shadow');
  check('the synthetic T2 replay appends a generation span to the deterministic call trace',
    reconciliationSpan.traceId === reconciliationTraceId
    && reconciliation.traceLink === `https://example.invalid/trace/${reconciliationTraceId}`
    && reconciliationSpan.attributes.some((item) => (
      item.key === 'langfuse.observation.type' && item.value.stringValue === 'generation'
    )));
  check('the T2 generation is nested below a session-grouped root observation',
    reconciliationSpan.parentSpanId === reconciliationRoot.spanId
    && reconciliationRoot.attributes.some((item) => (
      item.key === 'langfuse.session.id' && item.value.stringValue === 'run-1'
    )));
  check('the T2 span carries model, token, cached-token, latency and operation counts',
    reconciliationSpan.attributes.some((item) => item.key === 'gen_ai.request.model')
    && reconciliationSpan.attributes.some((item) => item.key === 'gen_ai.usage.prompt_tokens')
    && reconciliationSpan.attributes.some((item) => (
      item.key === 'langfuse.observation.metadata.cachedInputTokens'
      && item.value.intValue === '220'
    ))
    && reconciliationSpan.attributes.some((item) => (
      item.key === 'langfuse.observation.metadata.latencyMs'
      && item.value.intValue === '750'
    ))
    && reconciliationSpan.attributes.some((item) => (
      item.key === 'langfuse.observation.metadata.operationCount'
      && item.value.intValue === '4'
    )));
  check('the deterministic trace-link helper agrees with the T2 span',
    traceLinkForCall('run-1', 'call-1', {
      env: { LANGFUSE_HOST: 'https://example.invalid/' }
    }).traceLink === reconciliation.traceLink);

  const metadataReconciliationCollector = makeCollector();
  exportReconciliationShadowSpan(metadataReconciliationCollector, {
    runId: 'run-1', callId: 'call-2', synthetic: false,
    contentPolicy: 'synthetic_test_content', input: privacySentinels.evidence,
    output: privacySentinels.value, verdict: 'clean', status: 'shadow',
    usage: { model: 'planner-model', inputTokens: 10, outputTokens: 2, latencyMs: 5 }
  });
  check('metadata-only T2 spans retain metrics but suppress reconciliation input and output',
    !JSON.stringify(metadataReconciliationCollector).includes(privacySentinels.evidence)
    && !JSON.stringify(metadataReconciliationCollector).includes(privacySentinels.value)
    && metadataReconciliationCollector.spans.some((span) => (
      span.name === 'planner.reconciliation.shadow'
      && span.attributes.some((item) => item.key === 'gen_ai.usage.prompt_tokens')
    )));

  const failedExport = await exportReconciliationShadow({
    runId: 'run-1', callId: 'call-3', synthetic: true,
    contentPolicy: 'synthetic_test_content', usage: { model: 'planner-model' }
  }, {
    client: {
      enabled: true,
      startSpan() { throw new Error('offline test failure'); },
      async flush() { throw new Error('must not be reached'); }
    }
  });
  check('a T2 telemetry exception is reported but never thrown into the shadow runner',
    failedExport.failures === 1 && failedExport.delivered === 0);

  const shadowRunnerSource = readFileSync(
    new URL('./run-planner-reconciliation-shadow.mjs', import.meta.url),
    'utf8'
  );
  check('the shadow runner freezes the exact approved persona and answer-key hashes before replay',
    shadowRunnerSource.includes('ee5c9806a55548d467ffe439f9a10767538968b67336e752e5e9429d71ad2b34')
    && shadowRunnerSource.includes('a1ae6bb1992a09051bf74e77b1247d0cbaaf8f90f474f9eb985d9a5eeae6b39e')
    && shadowRunnerSource.indexOf('assertFrozenFixtureHashes()')
      < shadowRunnerSource.indexOf('for (const callId of calls)'));
  check('the shadow runner reuses the canonical lazy legacy-import helper',
    /legacyPlanningNotesFromProfile\(context\.profile\)/.test(shadowRunnerSource)
    && !/function\s+legacyNotesFromProfile\s*\(/.test(shadowRunnerSource));
  check('the authoritative shadow artifact keeps context, digest, outcomes and trace link',
    /reconciliationContext:\s*input/.test(shadowRunnerSource)
    // The digest is computed once and carried into the artifact by shorthand,
    // so match the computation and the field separately rather than assuming
    // the literal is written inline in the output object.
    && /inputDigest\s*=\s*`sha256:\$\{/.test(shadowRunnerSource)
    && /^\s*inputDigest,\s*$/m.test(shadowRunnerSource)
    && /operationOutcomes:\s*validation\.operationOutcomes/.test(shadowRunnerSource)
    && /traceLink/.test(shadowRunnerSource));
  check('the shadow artifact is written before best-effort Langfuse export starts',
    shadowRunnerSource.indexOf('writeFileSync(outputPath')
      < shadowRunnerSource.indexOf('await exportReconciliationShadow'));
}

/* -------------------------------------------------------------- grading */

{
  const sheet = buildGradingSheet({
    runId: 'run-1',
    calls: [
      {
        callId: 'deirdre', caller: 'deirdre', turns: 6, blockerCount: 1,
        transcript: [{ role: 'client', text: 'hello' }],
        langfuse: { traceUrl: 'https://cloud.langfuse.com/trace/abc123' }
      },
      { callId: 'mary', caller: 'mary', turns: 8, blockerCount: 0, transcript: [] }
    ]
  });
  check('the sheet has a section per call', (sheet.match(/^## /gm) || []).length === 2);
  check('the sheet never shows the judge its own score first',
    !/judge.*[1-5]\s*\/\s*5/i.test(sheet) && /deliberately not shown/.test(sheet));
  check('the transcript is in the sheet so you can grade what was said', sheet.includes('hello'));
  check('the scorecard carries the deterministic Langfuse trace link',
    sheet.includes('https://cloud.langfuse.com/trace/abc123'));

  // Built from GRADE_DIMENSIONS rather than a hardcoded list, so adding a
  // dimension does not silently stop exercising this.
  const scored = GRADE_DIMENSIONS.map((dimension, index) => `- ${dimension.key}: ${index % 5 + 1}`).join('\n');
  const blank = GRADE_DIMENSIONS.map((dimension) => `- ${dimension.key}: `).join('\n');
  const filled = `## deirdre\n\n${scored}\n- Notes: felt human\n\n## mary\n\n${blank}\n- Notes: \n`;
  const parsed = parseGradingSheet(filled);
  const expectedMean = GRADE_DIMENSIONS
    .map((unused, index) => index % 5 + 1)
    .reduce((sum, value) => sum + value, 0) / GRADE_DIMENSIONS.length;
  const deirdre = parsed.find((item) => item.callId === 'deirdre');
  const mary = parsed.find((item) => item.callId === 'mary');
  check('a filled call is graded', deirdre.graded === true && deirdre.mean === expectedMean,
    `mean ${deirdre.mean}`);
  check('your note is kept', deirdre.notes === 'felt human');
  // The property that protects every trend downstream.
  check('a blank grade is MISSING, not zero', mary.graded === false && mary.mean === null);
  check('a blank grade records no scores', Object.keys(mary.scores).length === 0);

  const outOfRange = parseGradingSheet('## x\n- usefulness: 9\n- tone: 0\n');
  check('grades are clamped into range',
    outOfRange[0].scores.usefulness === 5 && outOfRange[0].scores.tone === 1);
  check('an unknown field is ignored', !('nonsense' in parseGradingSheet('## x\n- nonsense: 3\n')[0].scores));

  const calibration = calibrate(
    [
      { callId: 'a', graded: true, mean: 3, notes: 'too pushy' },
      { callId: 'b', graded: true, mean: 4, notes: '' },
      { callId: 'c', graded: false, mean: null, notes: '' }
    ],
    [{ callId: 'a', mean: 5 }, { callId: 'b', mean: 4.5 }, { callId: 'c', mean: 5 }]
  );
  check('only graded calls are compared', calibration.compared === 2);
  // Gaps of +2 and +0.5: the judge is a full 1.25 kinder than you on average.
  check('the judge running kind is measured as bias', calibration.bias === 1.25, String(calibration.bias));
  check('the widest disagreement is surfaced with your note',
    calibration.worstDisagreement.callId === 'a' && calibration.worstDisagreement.notes === 'too pushy');
  check('the calibration reads in plain English', /kinder than you/.test(describeCalibration(calibration)));
  check('no graded calls yields no false confidence',
    /Not enough graded calls/.test(describeCalibration(calibrate([], []))));
}

/* --------------------------------------------------------------- trends */

{
  const dir = mkdtempSync(join(tmpdir(), 'agent-runs-'));
  try {
    const key = runKey({
      config: { realtimePromptVersion: 'v4', realtimeToolsetVersion: 't1', realtimePlannerModel: 'gpt-5.6-luna' },
      releasedModuleIds: 'a,b',
      manifestVersion: '2.0.0'
    });
    check('a run key names everything that could change the answer',
      /prompt=v4/.test(key) && /planner=gpt-5\.6-luna/.test(key) && /modules=a,b/.test(key));

    const earlier = {
      runId: 'r1', runKey: key, generatedAt: '2026-08-01T10:00:00.000Z',
      metrics: { blockingFindings: 5, goalCaptureRate: 0.5, humanGradeMean: 3 }, calls: []
    };
    const later = {
      runId: 'r2', runKey: key, generatedAt: '2026-08-02T10:00:00.000Z',
      metrics: { blockingFindings: 2, goalCaptureRate: 0.4, humanGradeMean: 4 }, calls: []
    };
    saveRun(earlier, { dir });
    saveRun(later, { dir });

    check('a run archive is explicitly versioned',
      JSON.parse(readFileSync(loadRuns({ dir })[0].path, 'utf8')).schemaVersion === AGENT_RUN_ARCHIVE_VERSION);
    check('turns to goal reports the actual first goal-bearing turn',
      firstGoalTurn([turn(), turn(), turn({ goals: ['retire'] }), turn({ goals: ['retire'] })]) === 3);
    check('a call with no captured goal has no turns-to-goal value', firstGoalTurn([turn(), turn()]) === null);

    const comparison = compareRuns(later, earlier);
    check('two runs of the same system are comparable', comparison.comparable);
    const byKey = Object.fromEntries(comparison.changes.map((change) => [change.key, change]));
    // Direction matters: fewer blockers is good, fewer goals captured is not.
    check('fewer blocking findings reads as an improvement', byKey.blockingFindings.improved === true);
    check('a lower goal-capture rate reads as a regression', byKey.goalCaptureRate.improved === false);
    check('a higher grade from you reads as an improvement', byKey.humanGradeMean.improved === true);
    check('regressions are extractable on their own',
      regressionsIn(comparison).map((item) => item.key).join() === 'goalCaptureRate');

    const otherSystem = { ...later, runKey: runKey({ config: { realtimePromptVersion: 'v5' } }) };
    const across = compareRuns(otherSystem, earlier);
    check('runs of DIFFERENT systems are never compared', across.comparable === false);
    check('and the reason says so', /different system/.test(across.reason));
    check('no earlier run is not a regression', compareRuns(later, null).comparable === false);

    const runs = loadRuns({ dir });
    check('the archive loads newest first', runs[0].runId === 'r2');
    check('a trend excludes runs from another system', trendFor(runs, key).runs === 2);
    check('the trend series is oldest first, for reading left to right',
      trendFor(runs, key).series.humanGradeMean.map((point) => point.value).join() === '3,4');

    writeFileSync(join(dir, 'corrupt.json'), '{not json');
    check('a corrupt archive entry does not take down the report', loadRuns({ dir }).length === 2);

    // Retention: the words go before the numbers do.
    const old = saveRun({
      runId: 'r0', runKey: key, generatedAt: '2026-01-01T00:00:00.000Z',
      metrics: { blockingFindings: 1 },
      calls: [{
        callId: 'x',
        transcript: [{ role: 'client', text: 'private circumstances' }],
        turnRecords: [{
          observation: {
            extraction: { raw: { semanticFacts: [{ valueJson: '{"amount":50000}' }] } },
            profiles: { before: { assets: [] }, after: { assets: [{ amount: 50_000 }] } }
          }
        }]
      }]
    }, { dir });
    const longAgo = (Date.now() - 60 * 86_400_000) / 1000;
    utimesSync(old, longAgo, longAgo);
    const retention = applyRetention({ dir, transcriptDays: 30, runDays: 365 });
    check('an old transcript is cleared', retention.transcriptsCleared === 1);
    const pruned = loadRuns({ dir }).find((run) => run.runId === 'r0');
    check('the words are gone', pruned.calls[0].transcript.length === 0 && pruned.calls[0].transcriptCleared === true);
    check('raw extraction and profile snapshots share transcript retention',
      pruned.calls[0].turnRecords.length === 0 && pruned.calls[0].turnRecordsCleared === true);
    check('the numbers survive for the trend', pruned.metrics.blockingFindings === 1);

    utimesSync(old, longAgo, longAgo);
    check('a run past its retention window is deleted',
      applyRetention({ dir, transcriptDays: 30, runDays: 30 }).runsDeleted === 1);
    check('retention on a missing directory is harmless',
      applyRetention({ dir: join(dir, 'nope') }).runsDeleted === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------- review */

{
  const review = normaliseReview({
    worked: ['opened warmly'],
    did_not_work: [{ what: 'asked for the house value twice', turn: 4, why: 'the first answer was vague', change: 'accept a range' }],
    biggest_single_change: 'accept a range',
    would_a_person_come_back: true
  });
  check('a review normalises into something actionable',
    review.didNotWork[0].change === 'accept a range' && review.wouldComeBack === true);
  check('a malformed entry is dropped, not half-kept',
    normaliseReview({ did_not_work: [{ turn: 2 }] }).didNotWork.length === 0);

  const themes = aggregateReviews([review, review, { ...review, worked: ['clear'] }]);
  check('a change suggested across calls is ranked by recurrence',
    themes.recurringChanges[0].calls === 3 && themes.recurringChanges[0].change === 'accept a range');
  check('what worked is collected too', themes.worked.includes('opened warmly'));

  const failed = await reviewCall({ async review() { throw new Error('down'); } }, { transcript: [] }, []);
  check('a reviewer that throws yields an absent opinion, never a failure', failed.available === false);
  check('no reviewer at all is a valid state', (await reviewCall(null, {}, [])).available === false);
  check('an unavailable review reports why', /review unavailable/.test(failed.biggestSingleChange));
}

console.info(`[Agent report] ${checks} checks passed: callers verbatim, blockers deterministic, `
  + 'blank grades not zero, different systems never compared.');
