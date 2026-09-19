/**
 * The count-up between two cases.
 *
 * When a module swaps one case for another it replaces its whole subtree, so
 * the old figures and the new ones never exist at the same time. Pairing them
 * by a stable key is what lets a number travel from what it was to what it
 * becomes, instead of blinking -- and a figure that travels is a figure the
 * client watches change, which is the entire point of clicking through cases.
 *
 * PBS proved this, and this module is PBS's implementation with the name taken
 * off. The `prefix` is why: PBS writes `data-pbs-value-key` and the mortgage
 * module writes `data-mortgage-value-key`, so two modules animating in the same
 * pane cannot pair a number against a stranger. Formatting is the CALLER's, so
 * that money is rendered by whatever already renders money there rather than by
 * a second implementation that drifts from the first.
 */

/** Duration of the tween. Long enough to read, short enough to feel immediate. */
const TWEEN_MS = 460;

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function isReducedMotionPreferred() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Tag an element so its value can be paired with the same value in the next case. */
export function setScenarioValueDataset(element, {
  prefix = 'scenario',
  key,
  value,
  format = 'currency',
  currencySymbol = '€'
} = {}) {
  const normalizedValue = finiteNumber(value);
  if (!element || !key || normalizedValue === null) {
    return;
  }

  element.dataset[`${prefix}ValueKey`] = key;
  element.dataset[`${prefix}Value`] = String(normalizedValue);
  element.dataset[`${prefix}ValueFormat`] = format;
  element.dataset[`${prefix}Currency`] = currencySymbol;
}

/** What every tagged figure reads right now, captured before the subtree goes. */
export function collectScenarioValueMap(root, { prefix = 'scenario' } = {}) {
  const values = new Map();
  if (!root) {
    return values;
  }

  root.querySelectorAll(`[data-${prefix}-value-key][data-${prefix}-value]`).forEach((element) => {
    const value = finiteNumber(element.dataset[`${prefix}Value`]);
    const key = element.dataset[`${prefix}ValueKey`];
    if (key && value !== null) {
      values.set(key, value);
    }
  });

  return values;
}

/**
 * Walk every changed figure from its old value to its new one.
 *
 * `formatValue(element, value)` belongs to the caller so the halfway frames are
 * rendered by the same formatter as the final one -- otherwise a number counts
 * up in one notation and lands in another.
 */
export function animateScenarioNumericValues(root, previousValues, {
  prefix = 'scenario',
  formatValue
} = {}) {
  if (!root || typeof formatValue !== 'function' || isReducedMotionPreferred()) {
    return false;
  }

  const animated = Array.from(root.querySelectorAll(`[data-${prefix}-value-key][data-${prefix}-value]`))
    .map((element) => {
      const key = element.dataset[`${prefix}ValueKey`];
      const start = previousValues instanceof Map ? previousValues.get(key) : undefined;
      const end = finiteNumber(element.dataset[`${prefix}Value`]);
      // A figure with no previous value is new to this case, and a figure that
      // did not move has nothing to show; both are left exactly as rendered.
      if (start === undefined || end === null || start === end) {
        return null;
      }

      return { element, start, end };
    })
    .filter(Boolean);

  if (animated.length === 0) {
    return false;
  }

  const startTime = performance.now();
  let settled = false;

  /** Land on the exact value rather than the last eased approximation of it. */
  const settle = () => {
    if (settled) {
      return;
    }
    settled = true;
    window.clearTimeout(safetyNet);
    animated.forEach(({ element, end }) => {
      element.textContent = formatValue(element, end);
    });
  };

  // A TWEEN MUST NOT BE ABLE TO STRAND A WRONG NUMBER ON SCREEN.
  //
  // requestAnimationFrame stops entirely while the page is hidden, so a client
  // who switches case and then switches tab -- or a laptop lid closed
  // mid-animation -- comes back to a figure frozen part-way between the case
  // they left and the case they chose. It is not a rounding error: halfway
  // between 218,474 and 47,797 is 164,973, a number that is true of nothing.
  // The timer is the guarantee that the final value lands whether or not the
  // page is ever painted again.
  const safetyNet = window.setTimeout(settle, TWEEN_MS + 120);

  const tick = (now) => {
    if (settled) {
      return;
    }

    const elapsed = Math.min(1, (now - startTime) / TWEEN_MS);
    if (elapsed >= 1) {
      settle();
      return;
    }

    const eased = 1 - Math.pow(1 - elapsed, 3);
    animated.forEach(({ element, start, end }) => {
      element.textContent = formatValue(element, start + ((end - start) * eased));
    });
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
  return true;
}
