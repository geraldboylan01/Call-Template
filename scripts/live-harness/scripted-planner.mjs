/**
 * The background planner, scripted.
 *
 * WHAT IS REAL AND WHAT IS NOT. Everything downstream of the model is real:
 * `runPlannerReconciliation`, the deterministic validator, the identity
 * catalogue, the CAS, the rebase, the ledger. Only the model's OPINION is
 * scripted — the harness says "the planner concludes the client is 57" and the
 * production code decides whether that conclusion is admissible.
 *
 * THE EVIDENCE IS NOT SCRIPTED. A repair names a quote, and this module finds
 * the real stored turn that quote came from by reading the reconciliation
 * context the Worker actually built. If the quote is not a contiguous, unique
 * span of something the client genuinely said, the real validator rejects the
 * operation — as it should. That is the difference between scripting the
 * planner and scripting the result: a repair only lands here if the production
 * rules would have let it land.
 */

/**
 * @param {() => {repairs?: Array, verdict?: string}|null} planFor
 *   Called once per reconciliation, in order. Return null for "no changes".
 * @param {{latencyMs?: number}} options
 */
export function scriptedPlanner(planFor, { latencyMs = 0 } = {}) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('api.openai.com')) return original(url, init);

    const request = safeJson(init?.body) || {};
    const context = reconciliationContextFrom(request);
    const turns = context.transcriptTurns || [];
    // The whole reconciliation context, so a test can aim a repair at the exact
    // server-issued identity slot and source occurrence the Worker offered —
    // rather than guessing at them, which is indistinguishable from a planner
    // that proposed nothing.
    const instruction = planFor({ turns, notes: context.notes || [], request, context });
    const startedAt = Date.now();
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));

    // A provider failure, so a test can assert what an UNREVIEWED material turn
    // does rather than only what a reviewed one does.
    if (instruction?.fail === true) {
      calls.push({ at: startedAt, latencyMs: Date.now() - startedAt, operationCount: 0, verdict: 'provider_error' });
      return new Response(JSON.stringify({ error: { message: 'scripted planner failure' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      });
    }

    // `clean` is the contract's word for "nothing to change" — the schema
    // enum is ['clean', 'changes_proposed', 'clarification_required']. Anything
    // else fails the whole plan, which is how a harness that invented its own
    // vocabulary produced five `failed` reconciliations and blamed the Worker.
    const plan = instruction === null || instruction === undefined
      ? buildPlan({ verdict: 'clean', repairs: [] }, turns, context.notes || [], context)
      : buildPlan(instruction, turns, context.notes || [], context);
    calls.push({
      at: startedAt,
      latencyMs: Date.now() - startedAt,
      operationCount: plan.operationGroups.reduce((total, group) => total + group.operations.length, 0),
      verdict: plan.verdict,
      // Recorded so a test can tell a REAL recovery from the harness quietly
      // declining an occurrence. An end-to-end proof that a missed figure is
      // recovered must not be satisfiable by an auto-generated
      // `not_current_fact`, so the disposition mix is observable here.
      uncoveredValueEvidenceCount: (context?.uncoveredValueEvidence || []).length,
      valueEvidenceDispositions: plan.valueEvidenceDispositions.map((item) => item.disposition)
    });

    return new Response(JSON.stringify({
      id: `resp_reconcile_${calls.length}`,
      status: 'completed',
      output_text: JSON.stringify(plan),
      usage: { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  return {
    restore: () => { globalThis.fetch = original; },
    calls: () => [...calls],
    modelCalls: () => calls.length
  };
}

function safeJson(value) {
  try { return JSON.parse(String(value || '')); } catch (_error) { return null; }
}

/**
 * The client turns the Worker put in front of the planner.
 *
 * Read out of the request body rather than passed in, so the harness can only
 * cite evidence the reconciler genuinely had — the same 8-client-turn window
 * (plus note-referenced turns) the production path assembles.
 *
 * The context travels as a JSON document inside the `input` text, so it is
 * recovered by parsing rather than by pattern-matching the serialized form.
 * A regex here was wrong twice over: the Worker emits object keys in
 * alphabetical order, and the payload is escaped one level deeper than it
 * looks. Both made every quote unresolvable, and an unresolvable quote is
 * indistinguishable from a planner that proposed nothing.
 */
function reconciliationContextFrom(request) {
  for (const candidate of jsonDocumentsIn(request)) {
    if (Array.isArray(candidate?.transcriptTurns) && Array.isArray(candidate?.notes)) {
      return candidate;
    }
  }
  return {};
}

/** Every object in the request, including ones encoded as JSON strings. */
function* jsonDocumentsIn(value, depth = 0) {
  if (depth > 8) return;
  if (typeof value === 'string') {
    const parsed = safeJson(value);
    if (parsed && typeof parsed === 'object') yield* jsonDocumentsIn(parsed, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* jsonDocumentsIn(item, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    yield value;
    for (const item of Object.values(value)) yield* jsonDocumentsIn(item, depth + 1);
  }
}

function buildPlan(instruction, turns, notes, context) {
  const repairs = Array.isArray(instruction.repairs) ? instruction.repairs : [];
  const operationGroups = repairs.map((repair, index) => {
    const quote = String(repair.quote || '');
    // `resolveWith` picks the turn while `quote` is what gets cited, so a test
    // can aim a deliberately INEXACT quote at a turn that really exists —
    // otherwise an unusable quote fails as an unknown turn and never reaches
    // the rule that judges the quote itself.
    const locator = String(repair.resolveWith || quote);
    const turn = turns.find((item) => item.role === 'user' && item.text.includes(locator));
    // A reclassification or retraction names an EXISTING note, whose id the
    // Worker minted. Resolve it from the ledger the reconciler was actually
    // shown, so a test cannot cite a note that is not really there.
    const targetNoteId = repair.targetNoteId
      || (repair.targetEntity
        ? String(notes.find((note) => note.entityId === repair.targetEntity)?.noteId || '')
        : '');
    return {
      groupId: repair.groupId || `group_${index + 1}`,
      atomic: repair.atomic === true,
      operations: [{
        operationId: repair.operationId || `op_${index + 1}`,
        op: repair.op || 'upsert_note',
        targetNoteId,
        factId: repair.factId,
        factInstanceId: repair.factInstanceId,
        entityId: repair.entityId || '',
        ownerId: repair.ownerId || '',
        noteKind: repair.noteKind || 'fact',
        certainty: repair.certainty || 'exact',
        targetEntityId: repair.targetEntityId || '',
        sourceEntityIds: repair.sourceEntityIds || [],
        valueJson: JSON.stringify(repair.value),
        reasonCode: repair.reasonCode || 'missing_note',
        // An unresolved quote deliberately cites a turn id that does not exist,
        // so the production validator rejects it instead of the harness quietly
        // dropping the operation and reporting a pass.
        evidence: [{ turnId: turn?.turnId || 'unresolved_evidence_turn', quote }]
      }]
    };
  });
  const operations = operationGroups.flatMap((group) => group.operations);
  const valueEvidenceDispositions = (context?.uncoveredValueEvidence || []).map((item) => {
    const turn = turns.find((candidate) => candidate.turnId === item.turnId);
    const matching = operations.filter((operation) => (operation.evidence || []).some((ref) => {
      if (!turn || ref.turnId !== item.turnId) return false;
      const start = turn.text.indexOf(ref.quote);
      return start >= 0 && start <= item.start && start + ref.quote.length >= item.end;
    }));
    if (matching.length === 0) {
      return { evidenceId: item.evidenceId, disposition: 'not_current_fact', operationIds: [] };
    }
    return {
      evidenceId: item.evidenceId,
      disposition: matching.every((operation) => operation.op === 'request_clarification')
        ? 'clarification_proposed'
        : 'operation_proposed',
      operationIds: matching.map((operation) => operation.operationId)
    };
  });
  return {
    schemaVersion: 1,
    verdict: instruction.verdict || (operationGroups.length ? 'changes_proposed' : 'clean'),
    reviewedNoteIds: instruction.reviewedNoteIds || [],
    valueEvidenceDispositions,
    operationGroups
  };
}
