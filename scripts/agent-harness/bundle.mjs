/**
 * The teaching bundle — everything a coding agent needs, and nothing it can get
 * for itself.
 *
 * WHY THIS IS PLAIN FILES. The semantic half of this loop runs in Claude Code
 * or Codex, under a subscription the user already pays for, not as a metered
 * API call from Planéir. Neither of those can be invoked as a library, so the
 * handover is a directory: the runner writes it, the agent reads it. That means
 * no bespoke format, no tool requirement, and no assumption about WHICH agent
 * picks it up.
 *
 * WHY IT POINTS RATHER THAN COPIES. context.md names the manifests, the prompt
 * and the question plan by file:line instead of pasting them. An agent reading
 * this bundle has the repository open in front of it; a pasted copy would only
 * be a second version of the truth, and it would be stale the moment anyone
 * edited the original.
 *
 * WHAT IS NOT IN HERE. Any judgement about whether the adviser was right. The
 * bundle states what the rules would have done, what the adviser did, and where
 * those differ. Everything after that is the agent's reading and then the
 * adviser's decision.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TEACHING_BUNDLE_VERSION = 'planeir-teaching-bundle-v1';

/**
 * Where each layer lives, for an agent deciding which one to change.
 *
 * Ordered by what a lesson COSTS at runtime, cheapest first, because that
 * ordering is the whole discipline: a rule that could have been a manifest
 * field but was written into the per-turn prompt is paid for on every turn of
 * every call, forever.
 */
const LAYERS = [
  {
    layer: 1,
    name: 'Deterministic planning',
    cost: 'zero — no tokens at all',
    where: [
      'js/planning/* (module adapters, orchestrator, registry)',
      'worker/src/consumer/conversation.js (question plan, meeting brief)',
      'worker/src/consumer/question_plan.js'
    ]
  },
  {
    layer: 2,
    name: 'Manifest / registry',
    cost: 'zero after the first turn — feeds the byte-stable cached prompt prefix',
    where: [
      'docs/modules/<moduleId>.md (routing, eligibility, requiredFacts, scenarioLevers)',
      'js/planning/semantic_facts.js (which fields a fact owns)',
      'js/planning/goal_catalogue.js (goal meanings and classification)'
    ]
  },
  {
    layer: 3,
    name: 'Cached prompt prose',
    cost: 'cached — paid once per session, then free; costs a LIVE_PROMPT_VERSION bump',
    where: ['worker/src/consumer/live/catalogue_prompt.js (the static instruction block)']
  },
  {
    layer: 4,
    name: 'Volatile per-turn state item',
    cost: 'PAID ON EVERY TURN — fixed budget, a new entry must displace an old one',
    where: ['worker/src/consumer/live/catalogue_prompt.js liveVolatileStateItem()'],
    budget: 'MAX_VOLATILE_ITEM_CHARS 1150 · MAX_CAPTURED_CHARS 520 · MAX_SHOWN_ANALYSES 3'
  },
  {
    layer: 5,
    name: 'Module engine',
    cost: 'zero tokens, but it changes what a number MEANS',
    where: ['js/planning/adapters/*', 'js/house_purchase/engine.js'],
    stop: 'Never change this from a teaching case without asking the adviser directly.'
  }
];

function describeDivergence(item) {
  const lines = [`### Turn ${item.turn} — ${item.kind}`, ''];
  if (item.kind === 'question_target') {
    lines.push(
      `- **The rules would have asked:** ${item.baseline.wouldHaveAsked || '(no prompt composed)'}`,
      `- **Targeting the fact:** \`${item.baseline.targetFact}\``,
      `- **Because:** ${item.baseline.reason || 'not recorded'}`,
      `- **Needed by:** ${(item.baseline.blockingModuleIds || []).join(', ') || 'no module named'}`,
      `- **The adviser said instead:** ${item.expert.said || '(acted without speaking)'}`,
      `- **What actually landed on the record:** ${(item.observed.factsLanded || []).join(', ') || 'nothing'}`
    );
  } else if (item.kind === 'scenario_construction' || item.kind === 'analysis_run') {
    lines.push(
      `- **The rules would have offered:** ${(item.baseline.wouldHaveOffered || []).join(', ') || 'nothing'}`,
      `- **The adviser ran:** ${item.expert.moduleId}`,
      `- **On these assumptions:** ${Object.entries(item.expert.scenarioOverrides || {})
        .map(([key, value]) => `${key}=${value}`).join(', ') || 'the base case'}`
    );
    if (item.kind === 'scenario_construction') {
      lines.push(
        '',
        '> The engine currently has **no way at all** to do this — there is no scenario',
        '> tool and `realtime_analysis.js` hardcodes `scenarioOverrides: {}`. Treat this',
        '> as a missing capability first and a missing rule second.'
      );
    }
  } else if (item.kind === 'fact_capture') {
    lines.push(
      `- **The adviser corrected:** ${item.expert.correction}`,
      `- **What the turn captured:** ${(item.observed.factsLanded || []).join(', ') || 'nothing'}`
    );
  } else if (item.kind === 'run_timing') {
    lines.push(
      `- **The rules would have run the analyses:** ${item.baseline.wouldHaveRun ? 'yes' : 'no'}`,
      `- **The adviser did:** ${item.expert.ran ? 'yes' : 'no'}`,
      `- **The rules would have said:** ${item.baseline.said || '(nothing recorded)'}`
    );
  }
  if (item.expert?.note) lines.push(`- **The adviser's own note:** ${item.expert.note}`);
  lines.push('');
  return lines.join('\n');
}

function contextMarkdown({ record, turns, transcript, execution, executionError, divergences }) {
  const brief = record.fixture?.personaPath
    ? `Loaded from \`${record.fixture.personaPath}\` (not committed — real client detail).`
    : 'No caller file was used.';
  return `# Teaching case ${record.caseId}

${brief}

- Turns: ${turns.length}
- Divergences: ${divergences.length}
- Shadow tier: \`${record.shadowTier}\`${record.offline ? ' · **offline run — plumbing only, not evidence**' : ''}
- Analyses: ${executionError ? `did not run (\`${executionError}\`)` : (execution?.completedModuleIds || []).join(', ') || 'none completed'}

## The conversation

${transcript.map((entry) => (
  `**${entry.role === 'client' ? 'CLIENT' : 'ADVISER'}:** ${entry.text || '_(acted without speaking)_'}`
  + (entry.note ? `\n> note: ${entry.note}` : '')
)).join('\n\n')}

## Where the rules and the adviser diverged

${divergences.length === 0
  ? '_None. The adviser and the engine agreed on every turn that could be compared._'
  : divergences.map(describeDivergence).join('\n')}

## Which layer holds a fix

A lesson may only land at layer N if it genuinely cannot be expressed at N−1.

${LAYERS.map((entry) => (
  `**${entry.layer}. ${entry.name}** — ${entry.cost}\n`
  + entry.where.map((path) => `   - \`${path}\``).join('\n')
  + (entry.budget ? `\n   - budget: ${entry.budget}` : '')
  + (entry.stop ? `\n   - **${entry.stop}**` : '')
)).join('\n\n')}

## Read these before proposing anything

They are the current structure this case should be compared against. Read them
live — this file deliberately does not copy them.

- \`worker/src/consumer/live/catalogue_prompt.js\` — the live prompt, its version, and the per-turn budgets
- \`docs/modules/*.md\` — every module's manifest: routing, eligibility, required facts
- \`js/planning/semantic_facts.js\` — which fields each fact owns
- \`js/planning/goal_catalogue.js\` — goal meanings
- \`worker/src/consumer/live/live_tools.js\` — the tools the live model actually has
- \`js/planning/orchestrator.js\` \`scenarioFor()\` — how scenario overrides reach a module
`;
}

const README = (caseId) => `# Teaching case ${caseId} — instructions for the coding agent

You are Claude Code or Codex, running under the adviser's own subscription.
Planéir has already done the deterministic half: it recorded what its rules
would have done, what the adviser actually did, and where those differ.

**Your job is the semantic half.** Read \`context.md\` and \`bundle.json\`, then
read the live repository files \`context.md\` points at. For each divergence,
work out:

1. exactly what the adviser did differently from the existing rules;
2. the likely planning rationale behind the intervention;
3. whether their behaviour genuinely appears preferable — **"no" and "unclear"
   are real answers**;
4. the generalisable principle, **if one exists** — \`null\` is a first-class
   answer meaning "a one-off, do not learn from it";
5. the boundaries: when this must NOT apply;
6. the risks of over-generalising it;
7. the regression and adversarial cases that would guard it.

Then present each proposal to the adviser in plain English, in this shape:

    Existing behaviour:    ...
    Adviser's behaviour:   ...
    Why it appears better: ...
    Proposed lesson:       ...
    Do not apply when:     ...
    Potential risks:       ...
    Recommended tests:     ...

## Rules you may not break

- **Do not edit production rules, prompts, manifests or planning code from this
  bundle.** Not one line, however obvious the fix looks.
- **Observing a divergence is not approval.** Neither is the adviser saying
  "interesting" or "makes sense". Approval is them accepting a specific written
  lesson.
- **The adviser may restate the lesson.** If they do, their words replace yours
  and become the canonical text.
- Record the approved lesson with:

      node ./scripts/teach-lesson.mjs approve ${caseId} --as="<their words>"

  and only then:

      node ./scripts/teach-lesson.mjs compile <lessonId>

  \`compile\` refuses anything that is not approved with a matching hash, and
  \`npm run check:teaching-lessons\` fails the build if a compiled artefact ever
  references a lesson that is not.
- If you find no generalisable lesson, say so and stop. A corpus of
  rubber-stamped lessons is worse than an empty one.
`;

/**
 * Write the bundle. Returns the directory it wrote.
 *
 * The raw case stays under teaching/pending/, which is gitignored: it holds a
 * real person's finances. Only the de-identified lesson that comes out the far
 * end is ever committed.
 */
export function writeTeachingBundle({
  root, record, turns, transcript, execution, executionError, results, profileRevision, blockers
}) {
  mkdirSync(root, { recursive: true });
  const divergences = turns.flatMap((turn) => turn.divergences || []);
  const bundle = {
    schemaVersion: TEACHING_BUNDLE_VERSION,
    caseId: record.caseId,
    createdAt: new Date().toISOString(),
    synthetic: false,
    contentPolicy: 'real_client_detail_local_only',
    shadowTier: record.shadowTier,
    offline: record.offline === true,
    fixture: record.fixture || null,
    profileRevision,
    turns,
    transcript,
    divergences,
    execution: execution || null,
    executionError: executionError || null,
    results,
    blockers
  };
  writeFileSync(join(root, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);
  writeFileSync(join(root, 'context.md'), contextMarkdown({
    record, turns, transcript, execution, executionError, divergences
  }));
  writeFileSync(join(root, 'README.md'), README(record.caseId));
  return root;
}
