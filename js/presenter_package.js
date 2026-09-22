import { fingerprint } from './presenter_catalogue.js';

const actions = new Set(['frame', 'focus', 'state', 'reset']);
const assert = (ok, message) => { if (!ok) throw new Error(message); };
function keys(value, allowed, where) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${where} must be an object.`);
  for (const key of Object.keys(value)) assert(allowed.includes(key), `${where}: unsupported field ${key}.`);
}
export function flattenSteps(steps, depth = 0) {
  assert(Array.isArray(steps) && steps.length > 0, 'steps must be a non-empty array.');
  assert(depth < 5, 'Sequences are nested too deeply.');
  return steps.flatMap(step => {
    if (step.action === 'sequence') {
      keys(step, ['id', 'label', 'action', 'steps'], 'sequence');
      return flattenSteps(step.steps, depth + 1);
    }
    return [step];
  });
}

export function compilePresentation(pkg, catalogue, script = '') {
  keys(pkg, ['version', 'id', 'title', 'caseFingerprint', 'scriptHash', 'steps', 'cues', 'narrativeReview', 'unmapped', 'sourceFiles'], 'presentation');
  assert(pkg.version === 1, 'Unsupported presentation version.');
  assert(typeof pkg.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(pkg.id), 'A stable presentation id is required.');
  assert(typeof pkg.title === 'string' && pkg.title.trim(), 'Presentation title is required.');
  assert(catalogue.errors.length === 0, catalogue.errors.join('\n'));
  assert(pkg.caseFingerprint === catalogue.caseFingerprint, 'The loaded case differs from this presentation. Rediscover and revalidate it.');
  assert(pkg.scriptHash === fingerprint(script), 'The spoken script has changed. Regenerate and validate its cues.');
  assert(!/^\[→.*\]/m.test(script), 'script.md must contain spoken text, without presenter cues.');
  const targets = new Map(catalogue.targets.map(t => [t.id, t]));
  const modules = new Map(catalogue.modules.map(m => [m.key, m]));
  const steps = flattenSteps(pkg.steps);
  assert(steps.length <= 500, 'A presentation supports at most 500 visual beats.');
  const seen = new Set();
  const states = Object.fromEntries(catalogue.modules.filter(m => m.scenarios.length).map(m => [m.key, m.defaultScenarioId || m.scenarios[0].id]));
  const compiled = steps.map(step => {
    keys(step, ['id', 'label', 'operations', 'rationale'], 'step');
    assert(typeof step.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(step.id) && !seen.has(step.id), `Invalid or duplicate step id: ${step.id}`);
    seen.add(step.id);
    assert(typeof step.label === 'string' && step.label.trim() && !/[\[\]\r\n]/.test(step.label), `${step.id}: label must be one line without brackets.`);
    assert(Array.isArray(step.operations) && step.operations.length > 0 && step.operations.length <= 12, `${step.id}: supply 1–12 operations.`);
    let visual = null;
    for (const op of step.operations) {
      keys(op, ['action', 'target', 'scenarioId'], `${step.id} operation`);
      assert(actions.has(op.action), `${step.id}: unsupported action ${op.action}.`);
      const target = targets.get(op.target);
      assert(target, `${step.id}: missing target ${op.target}.`);
      assert(target.available && !target.error, `${step.id}: unavailable target ${target.label}.`);
      assert(target.supportedActions.includes(op.action), `${step.id}: ${op.action} is unsupported for ${target.label}.`);
      if (op.action === 'state') {
        assert(modules.get(target.moduleKey).scenarios.some(s => s.id === op.scenarioId), `${step.id}: unknown scenario ${op.scenarioId}.`);
        states[target.moduleKey] = op.scenarioId;
      } else {
        assert(!('scenarioId' in op), `${step.id}: scenarioId belongs only to STATE.`);
        assert(!target.scenarioId || states[target.moduleKey] === target.scenarioId, `${step.id}: ${target.label} requires scenario ${target.scenarioId}.`);
      }
      visual = { targetId: target.id, moduleKey: target.moduleKey, action: op.action === 'state' ? 'frame' : op.action };
    }
    return { ...structuredClone(step), view: { ...visual, scenarios: { ...states } } };
  });
  assert(Array.isArray(pkg.cues) && pkg.cues.length === compiled.length, 'Every visual beat needs exactly one cue.');
  let previousOffset = -1;
  const cues = pkg.cues.map((cue, index) => {
    keys(cue, ['stepId', 'before'], 'cue');
    assert(cue.stepId === compiled[index].id, 'Cue and step IDs must occur in exactly the same order.');
    assert(typeof cue.before === 'string' && cue.before.length > 0, `${cue.stepId}: a script anchor is required.`);
    const offset = script.indexOf(cue.before);
    assert(offset >= 0 && script.indexOf(cue.before, offset + 1) < 0, `${cue.stepId}: script anchor is missing or ambiguous.`);
    assert(offset > previousOffset, `${cue.stepId}: cue positions must be ordered and distinct.`);
    previousOffset = offset;
    return { ...cue, offset, label: compiled[index].label };
  });
  const review = pkg.narrativeReview;
  const narrativeIssues = [];
  if (!review || review.status !== 'passed') narrativeIssues.push('Source-grounded narrative review is pending.');
  for (const claim of review?.claims || []) {
    if (!script.includes(claim.quote)) narrativeIssues.push(`Review quote is no longer in the script: ${claim.quote}`);
    if (!Array.isArray(claim.targetIds) || !claim.targetIds.length) narrativeIssues.push(`Review claim has no output source: ${claim.quote}`);
    for (const id of claim.targetIds || []) if (!targets.has(id)) narrativeIssues.push(`Review source no longer exists: ${id}`);
    if (!claim.assessment || claim.status !== 'supported') narrativeIssues.push(`Unresolved claim: ${claim.quote}`);
  }
  if (!review?.claims?.length || !review?.scenarioIndependence || !review?.assumptionsAndCaveats) narrativeIssues.push('Review must cover claims, scenario independence, and assumptions.');
  return { id: pkg.id, title: pkg.title, caseFingerprint: pkg.caseFingerprint, steps: compiled, cues,
    narrative: { status: narrativeIssues.length ? 'needs-review' : 'recorded', issues: narrativeIssues, limitation: 'Checks review references and completeness; semantic truth remains a source-grounded Codex review, not a mathematical proof.' },
    unmapped: pkg.unmapped || [] };
}

export function annotateScript(script, compiled) {
  let result = script;
  for (const cue of [...compiled.cues].reverse()) {
    result = `${result.slice(0, cue.offset)}[→ ${cue.label}] <!-- presenter:${cue.stepId} -->\n\n${result.slice(cue.offset)}`;
  }
  return result;
}
export function validateAnnotatedScript(script, annotated, compiled) {
  assert(annotated === annotateScript(script, compiled), 'Annotated script differs from the validated cue map.');
  return true;
}
