/**
 * A7 — turn a pasted person into a caller.
 *
 * THE PASTED TEXT IS THE BRIEF. It is not parsed, structured, summarised or
 * mapped onto fields. That is deliberate: any parsing step would decide in
 * advance which details matter, and the details it dropped would be exactly the
 * ones a real conversation trips over. The model playing the client reads what
 * you wrote, in your words, and behaves like that person.
 *
 * A caller file is plain text or markdown. Two optional headings are
 * recognised, and everything else is passed through untouched:
 *
 *     # Questions
 *     things this person wants to ask during the call, one per line
 *
 *     # Behaviour
 *     how they act -- vague about figures, interrupts, distrusts jargon
 *
 * Everything above the first recognised heading is who they are and what they
 * have. Nothing else is required. A file with no headings at all is valid and is
 * used verbatim as the brief.
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

const SECTION_PATTERN = /^#{1,6}\s*(questions?|behaviours?|behavior[s]?)\s*:?\s*$/i;

function sectionKind(line) {
  const match = line.match(SECTION_PATTERN);
  if (!match) return null;
  return /^question/i.test(match[1]) ? 'questions' : 'behaviours';
}

function bulletLines(block) {
  return block
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

/**
 * @param {string} text the pasted caller
 * @param {string} id scenario id
 * @returns {object} a scenario the runners accept
 */
export function parseCaller(text, id) {
  const lines = String(text ?? '').split('\n');
  const sections = { brief: [], questions: [], behaviours: [] };
  let current = 'brief';
  for (const line of lines) {
    const kind = sectionKind(line);
    if (kind) {
      current = kind;
      continue;
    }
    sections[current].push(line);
  }

  const brief = sections.brief.join('\n').trim();
  if (!brief) {
    throw new Error('a caller file needs at least some text describing the person');
  }
  const questions = bulletLines(sections.questions.join('\n'));
  const behaviours = bulletLines(sections.behaviours.join('\n'));

  return {
    id,
    synthetic: true,
    note: 'Caller supplied by a person, played by a model. Not a fixed scenario: '
      + 'there are no expected outcomes, because the point is to find out what happens.',
    client: {
      // Verbatim. See the note at the top of this file.
      brief,
      questions,
      behaviours
    },
    // A caller run has no answer key. Findings come from deterministic blocker
    // detection over the call and from review afterwards, never from a
    // pre-agreed outcome -- there is nothing to agree in advance.
    expected: {}
  };
}

export function loadCaller(path) {
  const id = basename(path, extname(path)).replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
  return parseCaller(readFileSync(path, 'utf8'), id || 'caller');
}

/**
 * The brief handed to the model playing the client.
 *
 * A caller's own words come first and unedited. The questions are given as
 * things to RAISE WHEN IT FEELS NATURAL rather than a checklist, because a
 * person who recites their questions in order is not a person, and a meeting
 * that survives that is not evidence of anything.
 */
export function callerBrief(scenario) {
  const client = scenario.client || {};
  if (!client.brief) return null;
  const parts = [client.brief];
  if ((client.questions || []).length) {
    parts.push(
      '',
      'Things you want to ask about at some point. Raise them when it feels natural,',
      'in your own words, not as a list, and not all at once:',
      ...client.questions.map((question) => `- ${question}`)
    );
  }
  if ((client.behaviours || []).length) {
    parts.push('', 'How you behave:', ...client.behaviours.map((item) => `- ${item}`));
  }
  return parts.join('\n');
}
