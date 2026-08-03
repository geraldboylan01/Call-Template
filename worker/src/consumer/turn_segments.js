import { figuresAreGrounded } from './spoken_figures.js';

/**
 * A client turn, read in pieces rather than all at once.
 *
 * THE PROBLEM THIS SOLVES. Extraction works turn-by-turn only when the client
 * says one thing at a time. Measured on real calls: one figure per turn is
 * captured every time; two pension values plus both contribution rates loses
 * the rates; three fund amounts loses all three; five income figures times the
 * planner out and loses the whole turn. Real callers -- especially on a voice
 * call, where people speak in paragraphs -- do not take turns that way. A
 * household with €300,000 in cash got a balance sheet saying its liquid
 * reserves were zero, because the sentence naming them was too dense to read.
 *
 * Both failures scale with density, so the fix is to stop presenting density.
 * A long answer is cut into clause-sized segments and each is read separately.
 * Every segment is small enough to be read comfortably, and -- this is the part
 * that matters -- a segment that fails now loses one clause instead of the
 * whole answer.
 *
 * ONE PATH, NOT TWO. A short turn segments into exactly one piece and behaves
 * precisely as it did before. There is no flag, no second implementation and no
 * old path to leave behind: this is how every turn is read.
 *
 * The industry name for this is a micro-turn (DuplexCascade, 2026), where
 * partial speech is aggregated into small units and read while the speaker
 * continues. Phase 1 segments a FINALIZED turn, so every segment is a substring
 * of what the client actually said and needs no reconciliation. Feeding it live
 * transcript deltas is a later step, and that step will need a groundedness
 * check against the final transcript, because streaming recognisers revise
 * words -- "sixty" becomes "sixteen" -- before they settle.
 */

/**
 * How many financial values one piece may carry.
 *
 * THE TRIGGER IS DENSITY, NOT LENGTH. This was length at first, and the check
 * for the three-fund answer caught it: "Jointly we have 80,000 in Zurich Prisma
 * 4 and 12,000 in Prisma 5. There's also 3,000 in a Prisma 5 for the kids" is
 * only 111 characters and lost every one of its three amounts. Meanwhile a long
 * sentence carrying one figure reads perfectly well. The measurements say the
 * same thing: one figure always worked, three never did.
 */
const MAX_FIGURES_PER_SEGMENT = 2;

/** A backstop for prose that carries no figures at all but rambles. */
const MAX_SEGMENT_CHARS = 220;

/**
 * Below this, a piece is not worth a planner call of its own and is merged into
 * its neighbour. "No." and "About 30 percent." are answers, not turns.
 */
const MIN_SEGMENT_CHARS = 24;

/**
 * A ceiling on planner calls for one turn. A client who talks for two minutes
 * without pausing should cost a bounded amount to read, so beyond this the
 * remaining clauses are packed into the last segments rather than each earning
 * a call.
 */
const MAX_SEGMENTS = 6;

/** Sentence enders, keeping the terminator with the sentence it ends. */
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

/**
 * Where a long sentence may be cut, safest first.
 *
 * A thousands separator is never a boundary: the comma in "1,250,000" binds
 * tighter than any clause join, so the comma rule requires a space after it and
 * a non-digit before.
 */
const CLAUSE_BOUNDARIES = [
  /(?:;\s+|,\s+(?:and|plus|as well as|along with)\s+|\s+and then\s+)/i,
  /\s+and\s+/i,
  /(?<=\D),\s+/
];

/** Every number-looking token in a piece. */
function figureCount(text) {
  return (String(text).match(/\d[\d,.]*/g) || []).length;
}

/**
 * Whether a piece can stand on its own after a cut.
 *
 * THE DANGEROUS CUT is the one that separates a number from what it describes.
 * "80,000 in Zurich Prisma 4" split into "80,000" and "in Zurich Prisma 4"
 * gives the engine a real amount with nothing to attach it to, and it will be
 * placed on the wrong holding -- worse than never reading it. So a piece
 * carrying a figure must also carry enough words to name what the figure is.
 */
function carriesItsOwnMeaning(piece) {
  if (!/\d/.test(piece)) return true;
  return (piece.match(/[A-Za-z][A-Za-z'\u2019-]{2,}/g) || []).length >= 2;
}

function tooDense(piece) {
  return figureCount(piece) > MAX_FIGURES_PER_SEGMENT || piece.length > MAX_SEGMENT_CHARS;
}

/** The first cut that both relieves the density and leaves every piece meaningful. */
function splitLongPiece(piece) {
  if (!tooDense(piece)) return [piece];
  for (const boundary of CLAUSE_BOUNDARIES) {
    const parts = piece.split(boundary).map((part) => part.trim()).filter(Boolean);
    if (parts.length <= 1) continue;
    if (!parts.every(carriesItsOwnMeaning)) continue;
    return parts.flatMap((part) => (tooDense(part) ? splitLongPiece(part) : [part]));
  }
  // Nothing safe to cut on. A dense clause is left whole rather than chopped
  // mid-figure: reading it as one piece may fail, but reading a number apart
  // from its label will place the wrong value.
  return [piece];
}

/**
 * Cut a finalized client turn into clause-sized pieces.
 *
 * @param {string} transcript what the client said
 * @returns {string[]} one or more pieces, in spoken order, together covering
 *   the turn. An answer that is not dense returns a single piece.
 */
export function segmentClientTurn(transcript) {
  const text = String(transcript || '').trim();
  if (!text) return [];
  if (!tooDense(text)) return [text];

  const pieces = text
    .split(SENTENCE_BOUNDARY)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .flatMap((sentence) => splitLongPiece(sentence));

  // Merge anything too small to deserve its own read into the piece before it,
  // so a stray "Yes." does not cost a planner call.
  const merged = [];
  for (const piece of pieces) {
    const previous = merged[merged.length - 1];
    // Merging must never rebuild the density that was just relieved.
    const wouldFit = previous && !tooDense(`${previous} ${piece}`);
    if (previous && (piece.length < MIN_SEGMENT_CHARS || previous.length < MIN_SEGMENT_CHARS) && wouldFit) {
      merged[merged.length - 1] = `${previous} ${piece}`;
    } else {
      merged.push(piece);
    }
  }

  if (merged.length <= MAX_SEGMENTS) return merged;
  // Too many pieces: pack the tail so the turn still costs a bounded number of
  // reads. The earliest clauses stay separate, because they are the ones the
  // meeting is most likely to be answering.
  const head = merged.slice(0, MAX_SEGMENTS - 1);
  return [...head, merged.slice(MAX_SEGMENTS - 1).join(' ')];
}

/**
 * Whether a cut is worth making at all.
 *
 * Segmenting costs one planner call per segment, so it must only happen where
 * reading the whole turn at once is actually likely to fail.
 */
export function shouldSegmentTurn(transcript) {
  return segmentClientTurn(transcript).length > 1;
}

/**
 * Combine per-segment extractions into one, later segments revising earlier.
 *
 * A client who says "about 200,000, no sorry 220,000" produces two readings of
 * the same fact in one turn. The later one is what they meant, which is the
 * revision rule micro-turn architectures use: a subsequent unit supersedes the
 * earlier one for the same slot.
 *
 * Candidate ids are rewritten to stay unique across segments -- every segment
 * numbers its own candidates from one, so without this the second segment's
 * "position-1" would collide with the first's and one would be lost.
 */
export function mergeSegmentExtractions(extractions, sourceTurnId) {
  const usable = (extractions || []).filter(Boolean);
  if (usable.length === 0) return null;

  const goals = new Map();
  const facts = new Map();
  const positions = new Map();
  const sections = new Map();
  const invalidCandidates = [];

  usable.forEach((extraction, segmentIndex) => {
    for (const goal of extraction.goalCandidates || []) {
      // A goal named in several clauses is one goal. Keep the first sighting's
      // priority hint: "I want to retire early, and also look at the mortgage"
      // states its own order.
      if (!goals.has(goal.goalType)) goals.set(goal.goalType, goal);
    }
    for (const fact of extraction.semanticFacts || []) {
      facts.set(fact.factId, fact);
    }
    for (const position of extraction.positions || []) {
      // Two positions are the same when they are the same kind of thing with
      // the same label. Anything else is a different holding and must not
      // overwrite: three funds are three rows, not one revised three times.
      positions.set(`${position.kind}:${String(position.label || '').toLowerCase()}`, position);
    }
    for (const completion of extraction.sectionCompletions || []) {
      sections.set(`${completion.section}:${completion.signal}`, completion);
    }
    for (const invalid of extraction.invalidCandidates || []) {
      invalidCandidates.push({ ...invalid, candidateId: `s${segmentIndex + 1}-${invalid.candidateId}` });
    }
  });

  const renumber = (items, prefix) => items.map((item, index) => ({
    ...item, candidateId: `${prefix}-${index + 1}`
  }));

  return Object.freeze({
    schemaVersion: usable[0].schemaVersion,
    sourceTurnId,
    goalCandidates: renumber([...goals.values()], 'goal'),
    semanticFacts: renumber([...facts.values()], 'fact'),
    positions: renumber([...positions.values()], 'position'),
    invalidCandidates,
    sectionCompletions: [...sections.values()]
  });
}

/* ------------------------------------- reading while the client still speaks */

/**
 * The pieces of an in-progress turn that are safe to read now.
 *
 * A streaming recogniser appends as it goes and revises before it settles, so
 * the LAST piece of what has arrived so far is never safe: the client is still
 * mid-clause and the words may still change. Every earlier piece is followed by
 * speech that has already moved on, which is the strongest signal available
 * that the recogniser is done with it.
 *
 * This is the conservative half of the micro-turn idea. Reading early buys the
 * time back; reading the trailing fragment early would buy a wrong figure.
 */
export function readableSegments(inProgressTranscript) {
  const segments = segmentClientTurn(inProgressTranscript);
  return segments.length <= 1 ? [] : segments.slice(0, -1);
}

/**
 * Drop anything whose figures are not in the final transcript.
 *
 * NOTHING READ FROM A PARTIAL IS TRUSTED. Work done while the client was still
 * speaking is a head start, never a decision: a value read from "I have sixteen
 * thousand" must not survive the recogniser settling on "sixty thousand". The
 * candidate's own evidence text is checked against what the client finally said,
 * and anything that no longer appears is discarded and re-read.
 *
 * @param {object} extraction merged candidates, possibly read from partials
 * @param {string} finalTranscript what the client actually said
 */
export function reconcileAgainstFinalTranscript(extraction, finalTranscript) {
  if (!extraction) return null;
  const grounded = (candidate) => {
    const evidence = String(candidate?.evidenceText || '');
    // A candidate with no evidence text cannot be checked, so it is not kept:
    // the whole point is that a partial read must prove itself.
    if (!evidence) return false;
    return figuresAreGrounded(evidence, finalTranscript);
  };
  const dropped = [];
  const keep = (items, kind) => (items || []).filter((candidate) => {
    if (grounded(candidate)) return true;
    dropped.push({ kind, candidateId: candidate.candidateId || null });
    return false;
  });
  return Object.freeze({
    ...extraction,
    semanticFacts: keep(extraction.semanticFacts, 'fact'),
    positions: keep(extraction.positions, 'position'),
    // Goals carry no figures, so revision cannot make them wrong.
    goalCandidates: extraction.goalCandidates || [],
    droppedByReconciliation: dropped
  });
}
