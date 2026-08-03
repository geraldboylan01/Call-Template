/**
 * Every figure the system uses must appear in what the client actually said.
 *
 * Deterministic, free, and the only guard that catches an invented number. It
 * was written for the spoken reflection -- the line Planéir says back while the
 * planner reads a turn -- where a hallucinated figure would confirm a value the
 * client never gave. It now also guards extraction done from a partial
 * transcript, where the risk is the reverse but just as bad: a streaming
 * recogniser revises words before it settles, so a value read early may not be
 * what the client said by the time they stop speaking.
 *
 * It lives in worker source rather than in a check because both callers are
 * real code paths. Keeping it in a test file and copying it here is exactly the
 * duplication that has broken this repository before.
 */

/**
 * The written numbers worth normalising.
 *
 * Only the confusable range. The mishearings that matter are spoken-word pairs
 * -- thirty and thirteen, sixty and sixteen, fifty and fifteen -- and they are
 * all in the tens.
 */
const NUMBER_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
});

/**
 * Written numbers become digits on BOTH sides before comparing, because a
 * digits-only check misses every confusable pair. Compound forms ("three
 * hundred and sixty thousand") are left alone.
 */
// Internal to the two checks below: nothing outside needs the normalised form.
function normaliseFigures(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\b([a-z]+)\b/g, (word) => (
      Object.hasOwn(NUMBER_WORDS, word) ? String(NUMBER_WORDS[word]) : word
    ))
    .replace(/[,\s]/g, '');
}

/**
 * The figures in `candidate` that do not appear in `spokenText`.
 *
 * An empty result means everything is grounded. Anything returned was invented,
 * misheard, or -- for a partial transcript -- has since been revised away.
 */
export function ungroundedFigures(candidate, spokenText) {
  const spoken = normaliseFigures(spokenText);
  return [...normaliseFigures(candidate).matchAll(/\d+/g)]
    .map((match) => match[0])
    .filter((figure) => figure && !spoken.includes(figure));
}

/** Whether every figure in `candidate` was actually said. */
export function figuresAreGrounded(candidate, spokenText) {
  return ungroundedFigures(candidate, spokenText).length === 0;
}
