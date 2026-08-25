#!/usr/bin/env node

/**
 * The CI half of the approval gate.
 *
 * teach-lesson.mjs refuses to compile an unapproved lesson, but a compiler can
 * be bypassed — by hand-editing a manifest, by an agent that decided it knew
 * better, by a merge that brought in someone's half-finished branch. This runs
 * inside `npm run check:consumer` and asks the question from the other end:
 * every artefact in the tree that CLAIMS to come from a lesson must trace back
 * to an approval whose hash still matches.
 *
 * It also guards the corpus itself, because teaching/lessons/ is the one part
 * of this that gets committed. A lesson is supposed to be de-identified — "a
 * client with a DB pension who does not know its value", never a real person's
 * name and figures. The scan below is deliberately narrow: it catches the
 * identifiers that must never appear rather than pretending to detect
 * everything, and it says which it checked.
 *
 * FREE. No model calls. Safe in CI.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import {
  approvalFailure, LESSON_MARKER, listLessons, loadLesson
} from './teach-lesson.mjs';

const failures = [];
const notes = [];
const fail = (message) => failures.push(message);

/* ------------------------------------- 1. every marker traces to an approval */

// Tracked files only: an untracked scratch file is not something CI ships.
let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch (_error) {
  fail('could not list tracked files — is this a git checkout?');
}

const MARKER_PATTERN = new RegExp(`${LESSON_MARKER}:([A-Za-z0-9._-]+)`, 'g');
const claimed = new Map();
for (const path of tracked) {
  // The corpus itself carries the bare marker as a format header, not a claim.
  if (path.startsWith('teaching/lessons/')) continue;
  if (!existsSync(path)) continue;
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch (_error) { continue; }
  if (!text.includes(LESSON_MARKER)) continue;
  for (const match of text.matchAll(MARKER_PATTERN)) {
    const id = match[1];
    if (!claimed.has(id)) claimed.set(id, []);
    claimed.get(id).push(path);
  }
}

for (const [lessonId, paths] of claimed) {
  const lesson = loadLesson(lessonId);
  const failure = approvalFailure(lesson);
  if (failure) {
    fail(`${paths.join(', ')} claims lesson "${lessonId}" but ${failure}.\n`
      + '    An unapproved lesson must not be changing how the app behaves.');
  }
}
notes.push(`${claimed.size} compiled lesson reference(s) checked against approvals`);

/* --------------------------------------------- 2. the corpus is well-formed */

const lessons = listLessons();
for (const lesson of lessons) {
  if (lesson.status === 'unreadable') {
    fail(`teaching/lessons/${lesson.lessonId}.md could not be parsed`);
    continue;
  }
  const failure = approvalFailure(lesson);
  if (failure) fail(`lesson "${lesson.lessonId}" ${failure}`);
  if (!(lesson.doNotApplyWhen || []).length) {
    fail(`lesson "${lesson.lessonId}" records no boundaries.\n`
      + '    A lesson with no "do not apply when" cannot be guarded against over-generalising.');
  }
  if (lesson.layer === 4 && !lesson.displaces) {
    fail(`lesson "${lesson.lessonId}" lands in the per-turn state item (layer 4) without naming\n`
      + '    what it displaces. That budget is fixed — every entry is paid for on every turn.');
  }
  if (lesson.layer === 5) {
    fail(`lesson "${lesson.lessonId}" is layer 5 (module engine). That changes what a number\n`
      + '    MEANS and is never a teaching-loop change — take it to the adviser directly.');
  }
  // Not a failure — an unattended approval can be legitimate (a re-run, a
  // scripted replay of a decision already taken). But it is the first thing a
  // reviewer should look at, so it is never silent.
  if (lesson.approval && lesson.approval.interactive !== true) {
    notes.push(`lesson "${lesson.lessonId}" was approved without a terminal prompt `
      + `(approvedBy ${lesson.approval.approvedBy}) — confirm the adviser really saw it`);
  }
}

/* ----------------------------------------------- 3. the corpus is anonymous */

const IDENTIFIERS = [
  { name: 'email address', pattern: /[\w.+-]+@[\w-]+\.[\w.]{2,}/ },
  { name: 'PPS-shaped number', pattern: /\b\d{7}[A-Za-z]{1,2}\b/ },
  { name: 'IBAN-shaped token', pattern: /\bIE\d{2}[A-Z0-9]{14,}\b/i },
  { name: 'phone-shaped number', pattern: /\b(?:\+353|0)\s?8\d[\s-]?\d{3}[\s-]?\d{4}\b/ }
];
for (const lesson of lessons) {
  // The LESSON's own words, not the whole file. approval.approvedBy is the
  // adviser's email and belongs there — scanning the raw file flagged it as a
  // leaked identifier, which is exactly backwards.
  const text = [
    lesson.principle, lesson.oldBehaviour, lesson.newBehaviour, lesson.agentWording,
    ...(lesson.doNotApplyWhen || []), ...(lesson.risks || []), ...(lesson.tests || [])
  ].filter(Boolean).join('\n');
  for (const { name, pattern } of IDENTIFIERS) {
    if (pattern.test(text)) {
      fail(`teaching/lessons/${lesson.lessonId}.md contains a ${name}. The lesson corpus is\n`
        + '    committed — it must describe the SITUATION, never the person.');
    }
  }
}
notes.push(`${lessons.length} lesson(s) scanned for ${IDENTIFIERS.map((i) => i.name).join(', ')}`);

/* ------------------------------------ 4. the loop is not rubber-stamping (advisory) */

const approved = lessons.filter((lesson) => lesson.status === 'approved').length;
if (approved >= 5) {
  // Not a failure: it is a signal about the LOOP, not about any one lesson. A
  // reviewer that never returns "no lesson here" is not reviewing.
  notes.push(`${approved} approved lessons — check some proposals are being rejected too`);
}

/* --------------------------------------------------------------------- out */

for (const note of notes) console.info(`[TeachingLessons] ${note}`);
if (failures.length) {
  console.error(`\n[TeachingLessons] ${failures.length} problem(s):\n`);
  for (const message of failures) console.error(`  ✗ ${message}`);
  process.exit(1);
}
console.info('[TeachingLessons] PASS');
