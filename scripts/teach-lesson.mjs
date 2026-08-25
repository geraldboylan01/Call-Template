#!/usr/bin/env node

/**
 * The approval gate.
 *
 * NOTHING A CODING AGENT PROPOSES CAN CHANGE HOW PLANÉIR BEHAVES UNTIL THE
 * ADVISER APPROVES IT HERE. That is not a convention this file politely asks
 * agents to follow — an instruction can be ignored, and an agent that ignored
 * it would silently reshape a regulated advice product. It is enforced three
 * ways, and all three have to be got past:
 *
 *   1. A proposal lives in teaching/pending/, which is gitignored and which no
 *      runtime code reads. Writing one changes nothing.
 *   2. `compile` refuses any lesson that is not `approved` AND whose canonical
 *      text does not still hash to what was approved. Edit an approved lesson
 *      and it needs approving again.
 *   3. `check:teaching-lessons` runs inside `npm run check:consumer` and fails
 *      the build if any compiled artefact references a lesson that is not
 *      approved with a matching hash.
 *
 * SO A DIVERGENCE IS NOT A LESSON, AND A LESSON IS NOT A CHANGE. The adviser
 * saying "interesting" is not approval either. Approval is this command, run
 * against a specific piece of text they have read.
 *
 *   node ./scripts/teach-lesson.mjs propose  <caseId>   (agents: write proposal.json first)
 *   node ./scripts/teach-lesson.mjs approve  <caseId> --as="<the adviser's own words>"
 *   node ./scripts/teach-lesson.mjs approve  <caseId> --accept-as-written
 *   node ./scripts/teach-lesson.mjs reject   <caseId> --why="..."
 *   node ./scripts/teach-lesson.mjs compile  <lessonId> --artefact=<file> [...]
 *   node ./scripts/teach-lesson.mjs list
 *
 * FREE. No model calls, ever. The thinking happened in Claude Code or Codex
 * under the adviser's own subscription; this file only records the decision.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const LESSON_SCHEMA_VERSION = 'planeir-teaching-lesson-v1';
export const LESSON_MARKER = 'planeir-teaching-lesson';

const PENDING = 'teaching/pending';
const LESSONS = 'teaching/lessons';

export const sha256 = (text) => `sha256:${createHash('sha256').update(String(text)).digest('hex')}`;

/**
 * The text an approval is an approval OF.
 *
 * Composed from the fields rather than free-form, so that editing any part the
 * adviser actually read — the principle, its boundaries, its risks — breaks the
 * hash. A lesson whose "do not apply when" was quietly widened after approval
 * is a different lesson.
 */
export function canonicalLessonText(lesson) {
  return [
    `principle: ${lesson.principle || ''}`,
    `oldBehaviour: ${lesson.oldBehaviour || ''}`,
    `newBehaviour: ${lesson.newBehaviour || ''}`,
    `doNotApplyWhen: ${(lesson.doNotApplyWhen || []).join(' | ')}`,
    `risks: ${(lesson.risks || []).join(' | ')}`,
    `layer: ${lesson.layer ?? ''}`
  ].join('\n');
}

/** Parse a lesson file. The fenced JSON block is the record; the prose is for people. */
export function parseLessonFile(text) {
  const match = String(text).match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) throw new Error('lesson file has no JSON block');
  return JSON.parse(match[1]);
}

export function renderLessonFile(lesson) {
  return `# Lesson ${lesson.lessonId}

<!-- ${LESSON_MARKER} -->

\`\`\`json
${JSON.stringify(lesson, null, 2)}
\`\`\`

## What the app used to do

${lesson.oldBehaviour || '_not recorded_'}

## What it should do instead

${lesson.newBehaviour || '_not recorded_'}

## The principle

${lesson.principle || '_not recorded_'}

## Do not apply when

${(lesson.doNotApplyWhen || []).map((item) => `- ${item}`).join('\n') || '_no boundaries recorded — treat with suspicion_'}

## Risks of generalising this

${(lesson.risks || []).map((item) => `- ${item}`).join('\n') || '_none recorded_'}

## Tests that guard it

${(lesson.tests || []).map((item) => `- ${item}`).join('\n') || '_none recorded_'}
`;
}

/**
 * Whether a lesson may change behaviour.
 *
 * Shared with check-teaching-lessons.mjs so the CI gate and the compiler can
 * never disagree about what "approved" means.
 */
export function approvalFailure(lesson) {
  if (!lesson) return 'lesson not found';
  if (lesson.schemaVersion !== LESSON_SCHEMA_VERSION) {
    return `unknown schema ${lesson.schemaVersion}`;
  }
  if (lesson.status !== 'approved') return `status is "${lesson.status}", not "approved"`;
  const approval = lesson.approval || {};
  if (!approval.textHash) return 'no approval hash recorded';
  if (!approval.approvedAt || !approval.approvedBy) return 'approval is missing who or when';
  const actual = sha256(canonicalLessonText(lesson));
  if (actual !== approval.textHash) {
    return 'the lesson text has changed since it was approved — it needs approving again';
  }
  return null;
}

export function loadLesson(lessonId) {
  const path = join(LESSONS, `${lessonId}.md`);
  if (!existsSync(path)) return null;
  return parseLessonFile(readFileSync(path, 'utf8'));
}

export function listLessons() {
  if (!existsSync(LESSONS)) return [];
  return readdirSync(LESSONS)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      try { return parseLessonFile(readFileSync(join(LESSONS, name), 'utf8')); }
      catch (_error) { return { lessonId: name.replace(/\.md$/, ''), status: 'unreadable' }; }
    });
}

/* ------------------------------------------------------------------ CLI */

// Importable without running: check-teaching-lessons.mjs reuses the helpers above.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('teach-lesson.mjs');
if (!invokedDirectly) { /* imported as a library */ } else {

const args = process.argv.slice(2);
const command = args[0];
const flag = (name, fallback = '') => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const flagAll = (name) => args
  .filter((arg) => arg.startsWith(`--${name}=`))
  .map((arg) => arg.slice(name.length + 3));
const target = args.slice(1).find((arg) => !arg.startsWith('--'));

const die = (message) => { console.error(message); process.exit(1); };

/**
 * Make an agent unable to approve on the adviser's behalf.
 *
 * BE HONEST ABOUT WHAT THIS CAN AND CANNOT DO. No local command can prove a
 * human typed it. What it can do is refuse to run unattended: when stdin is a
 * terminal the adviser has to type the lesson id back, which a script driving
 * this non-interactively cannot satisfy. When stdin is NOT a terminal the
 * approval still records `interactive: false`, so a review can see at a glance
 * that nobody was asked. That flag is the audit trail; the prompt is the lock.
 */
async function confirmAtTerminal(lessonId, principle) {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.info('\nYou are about to approve this as a lesson:\n');
  console.info(`  ${principle}\n`);
  const typed = await rl.question(`Type the lesson id (${lessonId}) to approve, or anything else to stop: `);
  rl.close();
  if (typed.trim() !== lessonId) {
    console.info('\nStopped. Nothing was approved.');
    process.exit(1);
  }
  return true;
}

function whoApproves() {
  try {
    return execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim() || 'unknown';
  } catch (_error) { return 'unknown'; }
}

if (command === 'list') {
  const lessons = listLessons();
  if (!lessons.length) { console.info('No lessons yet.'); process.exit(0); }
  for (const lesson of lessons) {
    const failure = approvalFailure(lesson);
    console.info(`${lesson.lessonId}  layer ${lesson.layer ?? '?'}  ${lesson.status}`
      + `${failure ? `  ⚠ ${failure}` : ''}`
      + `${lesson.compiled?.at ? `  compiled ${lesson.compiled.at.slice(0, 10)}` : ''}`);
  }
  process.exit(0);
}

if (command === 'approve') {
  if (!target) die('Which case? teach-lesson.mjs approve <caseId> --as="..."');
  const proposalPath = join(PENDING, target, 'proposal.json');
  if (!existsSync(proposalPath)) {
    die(`No proposal for ${target}. The coding agent writes ${proposalPath} after reading the bundle.\n`
      + 'Approving something nobody has proposed is not a thing this command can do.');
  }
  const proposal = JSON.parse(readFileSync(proposalPath, 'utf8'));
  const restated = flag('as', '');
  const acceptAsWritten = args.includes('--accept-as-written');
  if (!restated && !acceptAsWritten) {
    die('Approval has to be explicit and has to be about specific words.\n'
      + '  --as="<your own wording of the lesson>"   (your words replace the agent\'s)\n'
      + '  --accept-as-written                        (accept the proposal verbatim)');
  }
  if (proposal.principle === null || proposal.principle === undefined) {
    die('This proposal concluded there is no generalisable lesson here.\n'
      + 'That is a legitimate outcome. Use "reject" to record it, not "approve".');
  }

  const lessonId = flag('id', `${target}-${Date.now().toString(36)}`);
  // THE ADVISER'S WORDS WIN. Where they restated the principle, the agent's
  // phrasing is kept only as provenance — it is never what gets compiled.
  const lesson = {
    lessonId,
    schemaVersion: LESSON_SCHEMA_VERSION,
    status: 'approved',
    caseId: target,
    layer: Number(flag('layer', proposal.layer ?? '')) || proposal.layer || null,
    principle: restated || proposal.principle,
    oldBehaviour: proposal.oldBehaviour || '',
    newBehaviour: proposal.newBehaviour || '',
    doNotApplyWhen: proposal.doNotApplyWhen || [],
    risks: proposal.risks || [],
    tests: proposal.tests || [],
    proposedBy: proposal.proposedBy || 'coding-agent',
    restatedByAdviser: Boolean(restated),
    agentWording: restated ? proposal.principle : null,
    approval: null,
    compiled: { at: null, artefacts: [] }
  };
  const interactive = await confirmAtTerminal(lessonId, lesson.principle);
  lesson.approval = {
    textHash: sha256(canonicalLessonText(lesson)),
    approvedAt: new Date().toISOString(),
    approvedBy: whoApproves(),
    // False means nobody was prompted — the command ran unattended. Not
    // invalid, but the one thing a reviewer should look at first.
    interactive
  };
  mkdirSync(LESSONS, { recursive: true });
  writeFileSync(join(LESSONS, `${lessonId}.md`), renderLessonFile(lesson));
  console.info(`Approved as ${lessonId}${restated ? ' (in your words)' : ' (as written)'}.`);
  console.info(`  ${join(LESSONS, `${lessonId}.md`)}`);
  console.info(`\nStill nothing has changed. To make it real:\n  teach-lesson.mjs compile ${lessonId} --artefact=<file you changed>`);
  process.exit(0);
}

if (command === 'reject') {
  if (!target) die('Which case? teach-lesson.mjs reject <caseId> --why="..."');
  const why = flag('why', '');
  if (!why) die('Say why — a rejected proposal with no reason teaches nobody anything.');
  const path = join(PENDING, target, 'rejected.json');
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  existing.push({ why, at: new Date().toISOString(), by: whoApproves() });
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
  console.info(`Recorded. ${target} will not change anything.`);
  process.exit(0);
}

if (command === 'compile') {
  if (!target) die('Which lesson? teach-lesson.mjs compile <lessonId> --artefact=<file>');
  const lesson = loadLesson(target);
  const failure = approvalFailure(lesson);
  if (failure) {
    die(`REFUSED: ${failure}.\n\n`
      + 'Nothing was changed. A lesson reaches runtime only after the adviser approves\n'
      + 'the exact text, and only while that text still hashes to what they approved.');
  }
  const artefacts = flagAll('artefact');
  if (!artefacts.length) die('Name what you changed: --artefact=<file> (repeatable).');
  const missing = artefacts.filter((path) => !existsSync(path));
  if (missing.length) die(`These do not exist: ${missing.join(', ')}`);

  lesson.compiled = { at: new Date().toISOString(), artefacts };
  writeFileSync(join(LESSONS, `${lesson.lessonId}.md`), renderLessonFile(lesson));
  console.info(`Compiled ${lesson.lessonId} into layer ${lesson.layer}:`);
  for (const path of artefacts) console.info(`  ${path}`);
  console.info(`\nEach artefact must carry the marker "${LESSON_MARKER}:${lesson.lessonId}"`);
  console.info('so check:teaching-lessons can prove it traces back to an approval.');
  console.info(`Then replay:\n  node ./scripts/replay-lesson.mjs ${lesson.lessonId}`);
  process.exit(0);
}

console.error(`Unknown command "${command || ''}". Try: list, approve, reject, compile.`);
process.exit(1);

}
