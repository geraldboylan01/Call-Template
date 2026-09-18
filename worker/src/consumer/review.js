/**
 * THE HARD REVIEW BOUNDARY.
 *
 * Nothing a client says or types can reach the financial engine. Execution has
 * exactly one route: a trusted UI action naming the exact immutable review
 * object whose certified summary is on screen. This module owns that object,
 * the authoritative control record beside it, and the two competing atomic
 * transitions the buttons drive.
 *
 * WHAT THIS CODE IS ALLOWED TO DECIDE. Mode, review identity, whether accepted
 * work is settled, epoch ordering, supersession, certificate and snapshot
 * identity, whether a claim was won, and whether storage answered. It never
 * decides what anything MEANS: no text is inspected here, and there is no
 * predicate anywhere in this file that reads a transcript.
 *
 * WHY THE CONTROL RECORD LIVES IN THE DATABASE AND NOT THE DURABLE OBJECT.
 * Two tabs, a stale HTTP request, a reconnecting socket and a reconstructed
 * meeting must all resolve against ONE authority. The Durable Object owns the
 * conversation; it does not own execution authority, and it is not consulted
 * when a button is clicked.
 */

import { ConsumerError } from './errors.js';
import { MODULE_FAILURE_CODES, clientFailureMessage } from '../../../js/planning/module_failures.js';
import { runStoredConsumerAnalysis, runStoredConsumerAnalysisWithInputs } from './analysis.js';
import { getCurrentProfile, getSessionRow } from './repository.js';
import { verifyDirectModuleCertificate } from './direct_module_planner.js';
import { boundedSpeakableResult } from './realtime_analysis.js';
import {
  claimRealtimeAnalysisPlanRun,
  completeRealtimeAnalysisPlan,
  recordRealtimeRunProvenance,
  toPublicRealtimeAnalysisPlan
} from './realtime_repository.js';
import {
  decryptJson,
  encryptJson,
  randomId,
  sha256Base64Url,
  stableStringify
} from './crypto.js';

function db(env) {
  if (!env.CONSUMER_DB) {
    throw new ConsumerError(503, 'consumer_storage_unavailable', 'This planning journey is not available right now.');
  }
  return env.CONSUMER_DB;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * STORAGE UNCERTAINTY IS NOT AN ANSWER.
 *
 * Every read and write in this file goes through one of these two helpers. A
 * failure becomes `review_state_unavailable`, which no caller treats as "no
 * pending work", "nothing exists" or "everything settled". The alternative --
 * a caught error falling through to a default -- is exactly how a revoked
 * review gets its authority back.
 */
async function readOne(env, sql, bindings) {
  try {
    return await db(env).prepare(sql).bind(...bindings).first();
  } catch (error) {
    if (error instanceof ConsumerError) throw error;
    throw new ConsumerError(503, 'review_state_unavailable', 'The planning session state could not be read.');
  }
}

async function writeOne(env, sql, bindings) {
  try {
    return await db(env).prepare(sql).bind(...bindings).first();
  } catch (error) {
    if (error instanceof ConsumerError) throw error;
    throw new ConsumerError(503, 'review_state_unavailable', 'The planning session state could not be saved.');
  }
}

function presentationAad(sessionId, reviewId) {
  return `consumer/review/${sessionId}/${reviewId}/presentation`;
}

function toControl(row) {
  return {
    sessionId: String(row.session_id),
    mode: String(row.mode),
    stateVersion: Number(row.state_version),
    inputEpoch: Number(row.input_epoch),
    currentReviewId: row.current_review_id || null,
    executionId: row.execution_id || null
  };
}

function toReviewRecord(row) {
  return {
    reviewId: String(row.id),
    sessionId: String(row.session_id),
    leaseId: row.lease_id || null,
    planId: String(row.plan_id),
    planNonceHash: String(row.plan_nonce_hash_b64u),
    inputSnapshotHash: String(row.input_snapshot_hash_b64u),
    // NULL STAYS NULL. Coercing it to the string "null" would make an absent
    // certificate read as a present one to every truthiness check downstream.
    certificateSignature: row.certificate_signature || null,
    certificateProfileRevision: Number(row.certificate_profile_revision),
    snapshotRevision: Number(row.snapshot_revision),
    confirmationPromptHash: row.confirmation_prompt_hash_b64u || null,
    presentationHash: String(row.presentation_hash_b64u),
    sealedInputEpoch: Number(row.sealed_input_epoch),
    sealedThroughTurnId: row.sealed_through_turn_id || null,
    playbookVersion: String(row.playbook_version),
    extractorPromptVersion: String(row.extractor_prompt_version),
    verifierPromptVersion: String(row.verifier_prompt_version),
    policyVersion: String(row.policy_version),
    state: String(row.state),
    executionId: row.execution_id || null,
    analysisRunId: row.analysis_run_id || null,
    createdAt: String(row.created_at)
  };
}

/* ------------------------------------------------------------ control state */

export async function ensureReviewControl(env, sessionId) {
  const existing = await readOne(
    env,
    'SELECT * FROM consumer_review_control WHERE session_id = ? LIMIT 1',
    [sessionId]
  );
  if (existing) return toControl(existing);
  await writeOne(
    env,
    `INSERT OR IGNORE INTO consumer_review_control (
       session_id, mode, state_version, input_epoch, current_review_id, execution_id, updated_at
     ) VALUES (?, 'conversation', 0, 0, NULL, NULL, ?) RETURNING *`,
    [sessionId, nowIso()]
  );
  const created = await readOne(
    env,
    'SELECT * FROM consumer_review_control WHERE session_id = ? LIMIT 1',
    [sessionId]
  );
  // A row that will not read back after an insert is storage disagreeing with
  // itself. Conversation does not reopen on a guess.
  if (!created) throw new ConsumerError(503, 'review_state_unavailable', 'The planning session state could not be established.');
  return toControl(created);
}

export async function readReviewControl(env, sessionId) {
  const row = await readOne(
    env,
    'SELECT * FROM consumer_review_control WHERE session_id = ? LIMIT 1',
    [sessionId]
  );
  return row ? toControl(row) : null;
}

/**
 * The mode every input writer checks.
 *
 * A session that has never sealed has no row and is in CONVERSATION. That is a
 * genuine absence, established by a successful read -- not a read that failed,
 * which throws above and never reaches here.
 */
export async function currentInputMode(env, sessionId) {
  const control = await readReviewControl(env, sessionId);
  return control || { sessionId, mode: 'conversation', stateVersion: 0, inputEpoch: 0, currentReviewId: null, executionId: null };
}

export async function beginSealing(env, sessionId, expectedVersion) {
  const row = await writeOne(
    env,
    `UPDATE consumer_review_control
     SET mode = 'sealing', state_version = state_version + 1, updated_at = ?
     WHERE session_id = ? AND mode = 'conversation' AND state_version = ?
     RETURNING *`,
    [nowIso(), sessionId, expectedVersion]
  );
  return row ? toControl(row) : null;
}

/**
 * Sealing found more to do, so the conversation reopens.
 *
 * The epoch does NOT advance. Nothing was revoked and nothing was fenced: the
 * input admitted before this attempt belongs to this epoch and has just been
 * accounted for. Advancing here would orphan work that is legitimately still
 * in flight.
 */
export async function abandonSealing(env, sessionId, expectedVersion) {
  const row = await writeOne(
    env,
    `UPDATE consumer_review_control
     SET mode = 'conversation', current_review_id = NULL,
         state_version = state_version + 1, updated_at = ?
     WHERE session_id = ? AND mode = 'sealing' AND state_version = ?
     RETURNING *`,
    [nowIso(), sessionId, expectedVersion]
  );
  return row ? toControl(row) : null;
}

/* ------------------------------------------------------- the immutable review */

/**
 * Publish REVIEW, or publish nothing.
 *
 * The immutable record is written first and the control record claims it
 * second. If that claim loses -- a revocation or another seal got there -- the
 * orphan record is marked superseded and is unreachable forever, because Run
 * requires `control.currentReviewId` to name it. There is no ordering of these
 * two writes that can leave an executable review the client never saw.
 */
export async function publishReview(env, {
  sessionId,
  leaseId,
  planId,
  planNonce,
  inputSnapshotHash,
  certificateSignature,
  certificateProfileRevision,
  snapshotRevision,
  confirmationPromptHash,
  presentation,
  sealedInputEpoch,
  sealedThroughTurnId,
  playbookVersion,
  extractorPromptVersion,
  verifierPromptVersion,
  policyVersion,
  expectedVersion
}) {
  const reviewId = randomId('rv');
  const [presentationHash, planNonceHash] = await Promise.all([
    sha256Base64Url(stableStringify(presentation)),
    sha256Base64Url(String(planNonce))
  ]);
  const presentationEncrypted = await encryptJson(env, presentation, presentationAad(sessionId, reviewId));
  await writeOne(
    env,
    `INSERT INTO consumer_reviews (
       id, session_id, lease_id, plan_id, plan_nonce_hash_b64u,
       input_snapshot_hash_b64u, certificate_signature, certificate_profile_revision,
       snapshot_revision, confirmation_prompt_hash_b64u,
       presentation_encrypted, presentation_hash_b64u,
       sealed_input_epoch, sealed_through_turn_id,
       playbook_version, extractor_prompt_version, verifier_prompt_version, policy_version,
       created_at, state, execution_id, claim_click_id, analysis_run_id, decided_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'review', NULL, NULL, NULL, NULL)
     RETURNING *`,
    [
      reviewId, sessionId, leaseId || null, planId, planNonceHash,
      inputSnapshotHash, certificateSignature, Number(certificateProfileRevision),
      Number(snapshotRevision), confirmationPromptHash,
      presentationEncrypted, presentationHash,
      Number(sealedInputEpoch), sealedThroughTurnId || null,
      playbookVersion, extractorPromptVersion, verifierPromptVersion, policyVersion,
      nowIso()
    ]
  );
  const claimed = await writeOne(
    env,
    `UPDATE consumer_review_control
     SET mode = 'review', current_review_id = ?, execution_id = NULL,
         state_version = state_version + 1, updated_at = ?
     WHERE session_id = ? AND mode = 'sealing' AND state_version = ?
     RETURNING *`,
    [reviewId, nowIso(), sessionId, expectedVersion]
  );
  if (!claimed) {
    await writeOne(
      env,
      `UPDATE consumer_reviews SET state = 'superseded', decided_at = ?
       WHERE id = ? AND state = 'review' RETURNING id`,
      [nowIso(), reviewId]
    ).catch(() => null);
    return null;
  }
  return { reviewId, control: toControl(claimed), presentationHash };
}

export async function getReviewRecord(env, sessionId, reviewId) {
  const row = await readOne(
    env,
    'SELECT * FROM consumer_reviews WHERE id = ? AND session_id = ? LIMIT 1',
    [reviewId, sessionId]
  );
  return row ? toReviewRecord(row) : null;
}

async function readReviewPresentation(env, sessionId, reviewId) {
  const row = await readOne(
    env,
    'SELECT presentation_encrypted, presentation_hash_b64u FROM consumer_reviews WHERE id = ? AND session_id = ? LIMIT 1',
    [reviewId, sessionId]
  );
  if (!row) return null;
  const presentation = await decryptJson(env, row.presentation_encrypted, presentationAad(sessionId, reviewId));
  // The displayed summary and the Run button come from the same object. A
  // presentation whose digest no longer matches its record is not shown at all.
  if (await sha256Base64Url(stableStringify(presentation)) !== String(row.presentation_hash_b64u)) return null;
  return presentation;
}

/**
 * What the browser is allowed to see, and the only shape a Review screen is
 * drawn from. The reviewId it carries is the same id its buttons send back.
 */
export async function describeCurrentReview(env, sessionId) {
  const control = await readReviewControl(env, sessionId);
  if (!control) return { mode: 'conversation', review: null };
  if (!['review', 'running'].includes(control.mode) || !control.currentReviewId) {
    return { mode: control.mode, review: null };
  }
  const record = await getReviewRecord(env, sessionId, control.currentReviewId);
  if (!record) return { mode: control.mode, review: null };
  const presentation = await readReviewPresentation(env, sessionId, control.currentReviewId);
  if (!presentation) return { mode: control.mode, review: null };
  return {
    mode: control.mode,
    review: {
      reviewId: record.reviewId,
      state: record.state,
      presentation,
      // Actions are available only while the review is the executable one.
      actions: control.mode === 'review' && record.state === 'review'
        ? ['run', 'change']
        : []
    }
  };
}

/* ------------------------------------------------- run and make a change */

/**
 * The synchronous final admission assertion.
 *
 * Every objective fact below was established by an await that has already
 * returned. This function performs no I/O and schedules nothing, so the caller
 * can place it immediately before engine entry with no suspension point in
 * between -- which is the whole reason it is a separate, pure function rather
 * than another few lines inside the async flow.
 */
export function assertFinalAdmission({ control, record, planInput, claimedPlanRow, executionId }) {
  const fail = (code, message) => { throw new ConsumerError(409, code, message); };
  if (control?.mode !== 'running') fail('review_mode_conflict', 'This review is no longer the one being run.');
  if (control.currentReviewId !== record?.reviewId) fail('review_not_current', 'This review is no longer current.');
  if (control.executionId !== executionId) fail('review_execution_conflict', 'Another execution already claimed this review.');
  if (record.state !== 'running') fail('review_state_conflict', 'This review is not in a runnable state.');
  if (String(claimedPlanRow?.id || '') !== record.planId) fail('review_plan_conflict', 'The claimed plan is not this review’s frozen plan.');
  // A CERTIFIED REVIEW MUST STILL CARRY ITS OWN CERTIFICATE.
  //
  // The check is conditional on the RECORD, not on the input: a review sealed
  // with a certificate must present that exact certificate, and a review sealed
  // without one cannot acquire a forged one on the way in. There is no path
  // where a missing certificate reads as a passing one.
  const certified = planInput?.inputSource === 'verified_direct_module_input';
  if (certified !== Boolean(record.certificateSignature)) {
    fail('review_certificate_conflict', 'The frozen inputs do not match this review\u2019s certification.');
  }
  if (certified && String(planInput.verificationCertificate?.signature || '') !== record.certificateSignature) {
    fail('review_certificate_conflict', 'The frozen certificate does not belong to this review.');
  }
  const moduleIds = certified
    ? Object.keys(planInput.moduleInputs || {})
    : (Array.isArray(planInput?.moduleIds) ? planInput.moduleIds : []);
  if (moduleIds.length === 0) fail('review_input_conflict', 'This review has no analyses to run.');
  return moduleIds;
}

/**
 * REVIEW(R) -> RUNNING(R, E).
 *
 * The claim is one conditional update against the same control record Make a
 * change competes for, so exactly one of the two can win. It is conditional on
 * BOTH the current review and the control version, so a stale tab naming an
 * older review, and a click that raced a revocation, are refused by the same
 * statement rather than by a check that could be reordered around.
 *
 * The click id never widens this. Two clicks with different click ids still
 * find the mode moved and join the one execution.
 */
export async function claimReviewRun(env, { sessionId, reviewId, clickId }) {
  const control = await readReviewControl(env, sessionId);
  if (!control) return { ok: false, status: 409, code: 'review_not_found' };
  const record = await getReviewRecord(env, sessionId, reviewId);
  if (!record) return { ok: false, status: 404, code: 'review_not_found' };

  if (control.currentReviewId !== reviewId) {
    // NEVER SUBSTITUTE THE CURRENT REVIEW. A stale tab asking to run R while S
    // is current is refused; it does not silently acquire S's authority.
    return { ok: false, status: 409, code: record.state === 'revoked' ? 'review_revoked' : 'review_superseded' };
  }
  if (control.mode === 'running') {
    // A crash between the claim and its receipt is a reconciliation boundary,
    // not permission to run the engine a second time.
    return record.analysisRunId
      ? { ok: false, status: 409, code: 'review_already_executed', executionId: control.executionId, analysisRunId: record.analysisRunId }
      : { ok: false, status: 409, code: 'review_execution_pending', executionId: control.executionId };
  }
  if (control.mode !== 'review') return { ok: false, status: 409, code: 'review_not_open' };
  if (record.state !== 'review') return { ok: false, status: 409, code: `review_${record.state}` };

  const executionId = randomId('rx');
  const claimed = await writeOne(
    env,
    `UPDATE consumer_review_control
     SET mode = 'running', execution_id = ?, state_version = state_version + 1, updated_at = ?
     WHERE session_id = ? AND mode = 'review' AND current_review_id = ? AND state_version = ?
     RETURNING *`,
    [executionId, nowIso(), sessionId, reviewId, control.stateVersion]
  );
  if (!claimed) {
    // Make a change, or another click, committed between the read and the
    // claim. Zero engine entries from this request.
    const after = await readReviewControl(env, sessionId);
    if (after?.mode === 'running' && after.currentReviewId === reviewId) {
      return { ok: false, status: 409, code: 'review_execution_pending', executionId: after.executionId };
    }
    return { ok: false, status: 409, code: 'review_revoked' };
  }
  const marked = await writeOne(
    env,
    `UPDATE consumer_reviews
     SET state = 'running', execution_id = ?, claim_click_id = ?, decided_at = ?
     WHERE id = ? AND session_id = ? AND state = 'review'
     RETURNING *`,
    [executionId, String(clickId || '').slice(0, 120) || null, nowIso(), reviewId, sessionId]
  );
  if (!marked) {
    // The control record says this request won, but the immutable record was
    // already moved. That disagreement is unresolved state, so it blocks.
    return { ok: false, status: 409, code: 'review_execution_pending', executionId };
  }
  return { ok: true, executionId, control: toControl(claimed), record: toReviewRecord(marked) };
}

/**
 * The engine ran and could not produce a result. Reopen the conversation.
 *
 * WHY THIS EXISTS. RUNNING is a terminal-looking state: Make a change refuses
 * it, and rightly -- an execution that validly started cannot be revoked. But a
 * run that FAILED has finished, and leaving the session there would mean a
 * client whose analysis could not complete has no way back to the conversation
 * that would fix it, and no second button to press. The meeting would be over.
 *
 * It is the same shape as Make a change and for the same reason: ONE
 * conditional write clears the review, reopens the mode and advances the epoch.
 * The review itself stays `executed`, so reopening the conversation never
 * returns its execution authority -- it has had its one run, and failed it.
 */
async function reopenAfterFailedExecution(env, { sessionId, reviewId, executionId }) {
  return writeOne(
    env,
    `UPDATE consumer_review_control
     SET mode = 'conversation', current_review_id = NULL, execution_id = NULL,
         input_epoch = input_epoch + 1, state_version = state_version + 1, updated_at = ?
     WHERE session_id = ? AND mode = 'running' AND current_review_id = ? AND execution_id = ?
     RETURNING *`,
    [nowIso(), sessionId, reviewId, executionId]
  ).catch(() => null);
}

async function recordReviewOutcome(env, { sessionId, reviewId, state, analysisRunId }) {
  return writeOne(
    env,
    `UPDATE consumer_reviews SET state = ?, analysis_run_id = ?, decided_at = ?
     WHERE id = ? AND session_id = ? AND state = 'running' RETURNING *`,
    [state, analysisRunId || null, nowIso(), reviewId, sessionId]
  );
}

/**
 * REVIEW(R) -> CONVERSATION, as ONE durable write.
 *
 * Clearing the current review, reopening the mode and advancing the input epoch
 * happen in a single conditional update, so there is no ordering in which the
 * offer is destroyed but conversation stays shut, or conversation reopens while
 * R can still execute. Marking the immutable record afterwards is audit only:
 * R stopped being executable the instant `current_review_id` stopped naming it.
 *
 * A delayed request naming R while S is current matches nothing and changes
 * nothing -- it cannot revoke S.
 */
export async function revokeReview(env, { sessionId, reviewId }) {
  const control = await readReviewControl(env, sessionId);
  if (!control) return { ok: false, status: 409, code: 'review_not_found' };
  const record = await getReviewRecord(env, sessionId, reviewId);
  if (!record) return { ok: false, status: 404, code: 'review_not_found' };
  if (control.currentReviewId !== reviewId) {
    // Already revoked by an earlier identical request: report that outcome
    // rather than repeating the transition against newer state.
    if (record.state === 'revoked') {
      return { ok: true, alreadyRevoked: true, inputEpoch: control.inputEpoch, mode: control.mode };
    }
    return { ok: false, status: 409, code: 'review_superseded' };
  }
  if (control.mode === 'running') return { ok: false, status: 409, code: 'review_already_running' };
  if (control.mode !== 'review') return { ok: false, status: 409, code: 'review_not_open' };

  const reopened = await writeOne(
    env,
    `UPDATE consumer_review_control
     SET mode = 'conversation', current_review_id = NULL, execution_id = NULL,
         input_epoch = input_epoch + 1, state_version = state_version + 1, updated_at = ?
     WHERE session_id = ? AND mode = 'review' AND current_review_id = ? AND state_version = ?
     RETURNING *`,
    [nowIso(), sessionId, reviewId, control.stateVersion]
  );
  if (!reopened) {
    // Run won, or the state moved. Input does not reopen and success is not
    // acknowledged; the caller re-reads authoritative state.
    const after = await readReviewControl(env, sessionId);
    return { ok: false, status: 409, code: after?.mode === 'running' ? 'review_already_running' : 'review_not_open' };
  }
  await writeOne(
    env,
    `UPDATE consumer_reviews SET state = 'revoked', decided_at = ?
     WHERE id = ? AND session_id = ? AND state = 'review' RETURNING id`,
    [nowIso(), reviewId, sessionId]
  ).catch(() => null);
  return { ok: true, alreadyRevoked: false, inputEpoch: Number(reopened.input_epoch), mode: 'conversation' };
}

/* ------------------------------------------------------------- execution */

/**
 * Run the analysis this exact review froze.
 *
 * ZERO planner calls, ZERO verifier-model calls and ZERO approval readers. The
 * only model work that ever happened for this analysis happened before the
 * seal. What runs here is arithmetic over inputs that were frozen then, and
 * cryptography over the certificate that covered them.
 *
 * The request carries a review id and a click id. It carries no financial
 * value and no assertion that anybody approved anything: the server resolves
 * every input from the immutable record.
 */
export async function executeReviewRun(env, config, { sessionId, reviewId, clickId = '' }) {
  const claim = await claimReviewRun(env, { sessionId, reviewId, clickId });
  if (!claim.ok) return claim;
  const { executionId, control, record } = claim;

  const planClaim = await claimRealtimeAnalysisPlanRun(env, { sessionId, planId: record.planId });
  if (!planClaim) {
    // The frozen plan was already claimed by an earlier attempt whose outcome
    // is unknown. Prefer an unresolved execution to a second one.
    return { ok: false, status: 409, code: 'review_execution_pending', executionId };
  }
  if (String(planClaim.row.input_snapshot_hash_b64u) !== record.inputSnapshotHash) {
    await recordReviewOutcome(env, { sessionId, reviewId, state: 'unknown', analysisRunId: null }).catch(() => null);
    return { ok: false, status: 409, code: 'review_input_conflict', executionId };
  }

  const sessionRow = await getSessionRow(env, sessionId);
  if (!sessionRow) return { ok: false, status: 404, code: 'review_session_missing', executionId };
  const profile = await getCurrentProfile(env, sessionRow);
  const certified = planClaim.input.inputSource === 'verified_direct_module_input';
  const frozenCertificateValid = certified
    ? await verifyDirectModuleCertificate(
      env,
      planClaim.input.verificationCertificate,
      planClaim.input.directModuleSnapshot,
      planClaim.input.moduleInputs,
      {
        config,
        calculationDateIso: profile.assumptions.calculationDateIso,
        baseCurrency: profile.preferences.baseCurrency,
        currentProfileContext: profile
      }
    )
    // The deterministic lane has no semantic proposal to verify. What replaces
    // it is the frozen module set and the snapshot digest the claim already
    // matched, both checked in the synchronous assertion below.
    : !record.certificateSignature;
  if (!frozenCertificateValid) {
    await completeRealtimeAnalysisPlan(env, {
      sessionId, planId: record.planId, status: 'failed',
      result: emptyResult(config), analysisRunId: null, errorCode: 'review_certificate_invalid'
    }).catch(() => null);
    await recordReviewOutcome(env, { sessionId, reviewId, state: 'unknown', analysisRunId: null }).catch(() => null);
    return { ok: false, status: 409, code: 'review_certificate_invalid', executionId };
  }

  // NOTHING MAY SUSPEND BETWEEN THESE TWO LINES. Every fact the assertion reads
  // was established above; the engine call is the next statement, so there is
  // no scheduling boundary in which the claimed state could move underneath it.
  const moduleIds = assertFinalAdmission({
    control, record, planInput: planClaim.input, claimedPlanRow: planClaim.row, executionId
  });
  return finishReviewRun(env, config, {
    sessionId, reviewId, executionId, record, sessionRow, profile,
    planInput: planClaim.input,
    engine: certified
      ? runStoredConsumerAnalysisWithInputs({
        env, config, sessionRow, profile, moduleInputs: planClaim.input.moduleInputs
      })
      : runStoredConsumerAnalysis({
        env, config, sessionRow, profile, moduleIds, scenarioOverrides: planClaim.input.scenarioOverrides || {}
      })
  });
}

function emptyResult(config) {
  return {
    speakableText: '',
    promptVersion: config.realtimePromptVersion,
    toolsetVersion: config.realtimeToolsetVersion,
    calculationVersion: null,
    completedModuleIds: []
  };
}

async function finishReviewRun(env, config, {
  sessionId, reviewId, executionId, record, planInput, engine
}) {
  try {
    const run = await engine;
    const result = boundedSpeakableResult(run.analysis, config, planInput?.moduleSlots || []);
    const completed = await completeRealtimeAnalysisPlan(env, {
      sessionId, planId: record.planId, status: 'complete', result, analysisRunId: run.analysis.id
    });
    await recordReviewOutcome(env, { sessionId, reviewId, state: 'executed', analysisRunId: run.analysis.id });
    if (record.leaseId) {
      await recordRealtimeRunProvenance(env, {
        leaseId: record.leaseId,
        sessionId,
        analysisRunId: run.analysis.id,
        profileRevision: record.certificateProfileRevision,
        promptVersion: config.realtimePromptVersion,
        toolsetVersion: config.realtimeToolsetVersion
      }).catch(() => null);
    }
    return {
      ok: true,
      executionId,
      reviewId,
      analysisPlan: toPublicRealtimeAnalysisPlan(completed, planInput),
      result
    };
  } catch (error) {
    const failureCode = error instanceof ConsumerError && error.code === 'analysis_module_failed'
      ? (error.details?.failureCode || MODULE_FAILURE_CODES.UNKNOWN)
      : null;
    const result = failureCode
      ? { ...emptyResult(config), speakableText: clientFailureMessage(failureCode) }
      : emptyResult(config);
    const status = failureCode ? 'failed'
      : (error instanceof ConsumerError && error.code === 'analysis_missing_information' ? 'needs_information' : 'failed');
    await completeRealtimeAnalysisPlan(env, {
      sessionId, planId: record.planId, status, result,
      analysisRunId: error?.details?.analysis?.id || null,
      errorCode: failureCode || (error instanceof ConsumerError ? error.code : 'analysis_failed')
    }).catch(() => null);
    // The engine was entered. Whatever happened, this review has had its one
    // execution and can never claim another -- so it is marked FIRST, and only
    // then is the conversation reopened. The other order would briefly leave a
    // review that still looked runnable in an open conversation.
    await recordReviewOutcome(env, {
      sessionId, reviewId, state: 'executed', analysisRunId: error?.details?.analysis?.id || null
    }).catch(() => null);
    await reopenAfterFailedExecution(env, { sessionId, reviewId, executionId });
    return {
      ok: false,
      status: 409,
      code: failureCode || (error instanceof ConsumerError ? error.code : 'analysis_failed'),
      executionId,
      reviewId,
      result
    };
  }
}
