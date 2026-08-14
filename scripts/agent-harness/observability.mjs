/**
 * Synthetic-call observability helpers.
 *
 * These functions only shape data the harness has already seen. They do not
 * participate in planning, fact acceptance, or the live response path.
 */

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function entityIdFrom(candidate = {}) {
  const value = candidate?.value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value.entityId || value.id || value.pensionId || value.incomeId
      || value.assetId || value.propertyId || value.liabilityId || null;
  }
  return candidate.entityId || null;
}

function ownerRefFrom(candidate = {}) {
  const value = candidate?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value.ownerId || value.owner || (Array.isArray(value.ownerIds) ? value.ownerIds[0] : null) || null;
}

function resolveOwnerId(profile, ownerRef, entityId = null) {
  if (ownerRef === 'primary') return profile?.primaryPerson?.personId || 'primary';
  if (ownerRef === 'partner') return profile?.partner?.personId || 'partner';
  if (ownerRef === 'joint' || ownerRef === 'household') return 'household';
  if (ownerRef) return ownerRef;
  if (entityId === profile?.primaryPerson?.personId) return entityId;
  if (entityId === profile?.partner?.personId) return entityId;
  const collections = [
    ...(profile?.pensions || []),
    ...(profile?.incomeSources || []),
    ...(profile?.assets || []),
    ...(profile?.properties || []),
    ...(profile?.liabilities || []),
    ...(profile?.businesses || [])
  ];
  const record = collections.find((item) => (
    [item?.pensionId, item?.incomeId, item?.assetId, item?.propertyId,
      item?.liabilityId, item?.businessId].includes(entityId)
  ));
  return record?.ownerId || (Array.isArray(record?.ownerIds) && record.ownerIds.length === 1
    ? record.ownerIds[0]
    : null);
}

function factInstanceId(factId, entityId, ownerId) {
  if (!factId) return null;
  if (entityId) return `${factId}:${entityId}`;
  // Owner-scoped absence/unknown candidates sometimes have no collection id.
  if (ownerId && ownerId !== 'household') return `${factId}:${ownerId}`;
  return factId;
}

/**
 * Join the raw planner candidates to their deterministic application outcomes.
 * Candidate values and evidence are intentionally retained only in the local,
 * ignored synthetic archive and are removed by archive retention.
 */
export function archiveCandidates({
  candidates = [], invalidCandidates = [], outcomes = [], profile = {}, askedQuestion = null
} = {}) {
  const remaining = [...outcomes];
  const consumeOutcome = (candidate) => {
    const index = candidate?.candidateId
      ? remaining.findIndex((item) => item?.candidateId === candidate.candidateId)
      : remaining.findIndex((item) => item?.factId === candidate?.factId);
    return index < 0 ? null : remaining.splice(index, 1)[0];
  };
  const observed = candidates.map((candidate) => {
    const outcome = consumeOutcome(candidate);
    const askedTarget = (askedQuestion?.targets || [askedQuestion])
      .find((target) => target?.factId === candidate?.factId);
    const entityId = entityIdFrom(candidate) || askedTarget?.entityId || null;
    const ownerId = resolveOwnerId(
      profile,
      ownerRefFrom(candidate) || askedTarget?.ownerId || null,
      entityId
    );
    return {
      candidateId: candidate?.candidateId || null,
      operation: candidate?.operation || 'upsert',
      factId: candidate?.factId || outcome?.factId || null,
      factInstanceId: askedTarget?.factInstanceId
        || factInstanceId(candidate?.factId || outcome?.factId, entityId, ownerId),
      entityId,
      ownerId,
      value: clone(candidate?.value),
      certainty: candidate?.certainty || null,
      evidenceText: candidate?.evidenceText || null,
      correctionTarget: candidate?.correctionTarget || null,
      accepted: outcome ? outcome.accepted === true : null,
      rejectionCode: outcome?.accepted === false ? outcome.errorCode || 'unknown_rejection' : null,
      profileRevision: Number.isFinite(Number(outcome?.profileRevision))
        ? Number(outcome.profileRevision)
        : null
    };
  });
  for (const item of invalidCandidates || []) {
    const outcome = consumeOutcome(item);
    observed.push({
      candidateId: item?.candidateId || null,
      operation: item?.operation || null,
      factId: item?.factId || outcome?.factId || null,
      factInstanceId: item?.factId || outcome?.factId || null,
      entityId: null,
      ownerId: null,
      value: clone(item?.value),
      certainty: item?.certainty || null,
      evidenceText: item?.evidenceText || null,
      correctionTarget: item?.correctionTarget || null,
      accepted: false,
      rejectionCode: outcome?.errorCode || item?.errorCode || 'planner_output_invalid',
      profileRevision: null
    });
  }
  // A repair pass can produce outcomes that are not in the first-pass raw
  // extraction. Preserve the rejection/application code without pretending we
  // retained a value or quote that the harness did not receive.
  for (const outcome of remaining) {
    const askedTarget = (askedQuestion?.targets || [askedQuestion])
      .find((target) => target?.factId === outcome?.factId);
    observed.push({
      candidateId: outcome?.candidateId || null,
      operation: null,
      factId: outcome?.factId || null,
      factInstanceId: askedTarget?.factInstanceId || outcome?.factId || null,
      entityId: askedTarget?.entityId || null,
      ownerId: askedTarget?.ownerId || null,
      value: null,
      certainty: null,
      evidenceText: null,
      correctionTarget: null,
      accepted: outcome?.accepted === true,
      rejectionCode: outcome?.accepted === false ? outcome.errorCode || 'unknown_rejection' : null,
      profileRevision: Number.isFinite(Number(outcome?.profileRevision))
        ? Number(outcome.profileRevision)
        : null,
      source: 'repair_outcome_without_raw_extraction'
    });
  }
  return observed;
}

export function observedQuestion(context = {}) {
  const batch = context?.state?.meetingBrief?.questionBatch;
  const primary = batch?.primaryFact
    || context?.state?.nextQuestion
    || null;
  if (!primary?.factId) return null;
  const shapeTarget = (fact) => {
    if (!fact?.factId) return null;
    const instance = fact.factInstanceId || fact.factId;
    const entityId = instance.startsWith(`${fact.factId}:`)
      ? instance.slice(fact.factId.length + 1)
      : null;
    return {
      factId: fact.factId,
      factInstanceId: instance,
      entityId,
      ownerId: resolveOwnerId(context.profile, null, entityId),
      entityLabel: fact.entityLabel || null
    };
  };
  const primaryTarget = shapeTarget(primary);
  const linkedTarget = shapeTarget(batch?.linkedFact);
  return {
    questionId: context?.state?.nextQuestion?.questionId || null,
    ...primaryTarget,
    targets: [primaryTarget, linkedTarget].filter(Boolean),
    prompt: batch?.prompt
      || context?.state?.nextQuestion?.prompt
      || null,
    reason: primary.reason || context?.state?.nextQuestion?.reason || null,
    blockingModuleIds: clone(context?.state?.nextQuestion?.blockingModuleIds || (
      primary.moduleId ? [primary.moduleId] : []
    ))
  };
}

export function observedCanonicalFacts(context = {}) {
  return (context?.state?.facts || []).map((fact) => {
    const entityId = fact?.entityId || null;
    const ownerId = resolveOwnerId(context.profile, null, entityId);
    return {
      factId: fact?.factId || null,
      factInstanceId: factInstanceId(fact?.factId, entityId, ownerId),
      entityId,
      ownerId,
      fieldPath: fact?.fieldPath || null,
      certainty: fact?.certainty || null,
      status: fact?.status || null
    };
  });
}

/**
 * What is still outstanding according to the DETERMINISTIC module adapters.
 *
 * `observedNeeds` below reads `meetingBrief.stillNeeded`, and the brief is a
 * signed artefact composed mid-turn — before that turn's reconciliation has
 * run. So an archive that records only the brief can show a need alongside the
 * very canonical fact that satisfies it, which is exactly what
 * `person_current_age:primary` did in the r11 batch: needed and captured in the
 * same record, with `/primaryPerson/age` set to 57.
 *
 * That is a stale RECORD, not a stale question — the brief is recomposed from
 * the profile on the next turn, and the live lane never reads a brief at all.
 * But it made the archive impossible to reason about, and Phase 3's whole
 * measurement is "did readiness change after reconciliation". This is the same
 * derivation the live lane's projection and the reconciler's own needs list use,
 * so before/after can be compared against one source of truth.
 */
export function observedDeterministicNeeds(context = {}) {
  return (context?.state?.recommendations || []).flatMap((item) => (
    (item?.requiredMissing || []).map((need) => ({
      factId: need?.factId || null,
      factInstanceId: need?.factInstanceId || need?.factId || null,
      entityId: need?.entityId || null,
      ownerId: need?.ownerId || null,
      moduleId: item?.moduleId || null,
      status: need?.status || 'open',
      importance: need?.importance || null
    }))
  ));
}

export function observedNeeds(context = {}) {
  const rows = context?.state?.meetingBrief?.stillNeeded || [];
  return rows.map((need) => {
    const instance = need?.factInstanceId || need?.factId || null;
    const entityId = need?.factId && instance?.startsWith(`${need.factId}:`)
      ? instance.slice(need.factId.length + 1)
      : null;
    return {
      factId: need?.factId || null,
      factInstanceId: instance,
      entityId,
      ownerId: resolveOwnerId(context.profile, null, entityId),
      entityLabel: need?.entityLabel || null,
      moduleId: need?.moduleId || null,
      reason: need?.reason || null,
      prompt: need?.prompt || null
    };
  });
}

export function usageSnapshot(usage = {}) {
  return {
    clientCalls: Number(usage.clientCalls || 0),
    plannerCalls: Number(usage.plannerCalls || 0),
    client: clone(usage.client || {}),
    planner: clone(usage.planner || {}),
    plannerLatenciesMs: [...(usage.plannerLatenciesMs || [])].map(Number).filter(Number.isFinite)
  };
}

export function usageDelta(before = {}, after = {}) {
  const roleDelta = (role) => ({
    model: after?.[role]?.model || before?.[role]?.model || null,
    inputTokens: Math.max(0, Number(after?.[role]?.inputTokens || 0) - Number(before?.[role]?.inputTokens || 0)),
    outputTokens: Math.max(0, Number(after?.[role]?.outputTokens || 0) - Number(before?.[role]?.outputTokens || 0)),
    // Cached tokens remain a subset of input tokens. This shape is metadata;
    // the Langfuse transport deliberately does not put it in gen_ai.usage.*.
    cachedInputTokens: Math.max(
      0,
      Number(after?.[role]?.cachedInputTokens || 0) - Number(before?.[role]?.cachedInputTokens || 0)
    )
  });
  const beforeLatencies = before.plannerLatenciesMs || [];
  const latencies = (after.plannerLatenciesMs || []).slice(beforeLatencies.length);
  return {
    clientCalls: Math.max(0, Number(after.clientCalls || 0) - Number(before.clientCalls || 0)),
    plannerCalls: Math.max(0, Number(after.plannerCalls || 0) - Number(before.plannerCalls || 0)),
    client: roleDelta('client'),
    planner: { ...roleDelta('planner'), latenciesMs: latencies, latencyMs: latencies.reduce((sum, value) => sum + value, 0) }
  };
}

export function cloneForArchive(value) {
  return clone(value);
}
