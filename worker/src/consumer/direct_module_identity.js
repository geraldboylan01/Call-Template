import { stableStringify } from './crypto.js';

// This compares already interpreted native inputs. It never interprets speech
// or decides whether a financial correction is true. Evidence references,
// generated steering prose and planner pass numbers are review bookkeeping;
// the semantic verifier remains responsible for the meaning of the transcript.
//
// `selection` is DELIBERATELY absent. Attribution says whose idea an analysis
// was, not what will run: if the planner later decides an analysis it suggested
// was in fact requested, the frozen inputs, owners and figures are unchanged and
// the client has nothing new to approve. Including it would supersede a live
// offer over a wording judgement, which is exactly the churn Phase 1 removed.
export function directModuleCandidateMeaningKey(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.modules)) return null;
  return stableStringify({
    profileRevision: Number(snapshot.profileRevision || 0),
    modules: snapshot.modules.map((item) => ({
      moduleId: item.moduleId,
      status: item.status,
      input: item.status === 'not_relevant' ? null : item.input,
      assumptions: [...(item.assumptions || [])].sort((left, right) => (
        stableStringify(left).localeCompare(stableStringify(right))
      ))
    })).sort((left, right) => left.moduleId.localeCompare(right.moduleId))
  });
}

// A certificate must be independently authenticated before this identity is
// trusted. A newer certificate signature is expected after a review: its
// revision, through-turn and evidence hash are deliberately not plan identity.
export function directModulePlanMeaningKey(snapshot, certificate) {
  const candidate = directModuleCandidateMeaningKey(snapshot);
  if (!candidate || !certificate || certificate.version !== 2 || certificate.verdict !== 'pass') return null;
  return stableStringify({
    candidate,
    identity: Object.fromEntries([
      'profileRevision', 'moduleContractVersions', 'playbookVersion',
      'policyVersion', 'policyHash', 'assumptionsVersion', 'irelandRulesVersion',
      'calculationDateIso', 'baseCurrency', 'extractorPromptVersion',
      'verifierPromptVersion', 'model'
    ].map((key) => [key, certificate[key] ?? null]))
  });
}
