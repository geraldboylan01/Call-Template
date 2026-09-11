/**
 * How many cases a module may show.
 *
 * The prompt pack allows up to 4 cases per module, counting the base or
 * current case. PBS injects `Current position` as case 1 in the renderer, so a
 * PBS payload carries at most 3 alternatives.
 *
 * This lives in its own module because five call sites enforce it -- four
 * engine normalisers that reject on the way in, and the session importer that
 * tolerates on the way back out -- and a cap that is written out five times is
 * a cap that gets raised in four of them.
 */

/** Cases a module may show in total, base or current case included. */
export const MAX_MODULE_SCENARIO_CASES = 4;

/**
 * Alternatives a PBS payload may carry. `Current position` is not in the
 * payload, so this is one fewer than the module cap.
 */
export const MAX_PBS_SCENARIO_ALTERNATIVES = MAX_MODULE_SCENARIO_CASES - 1;
