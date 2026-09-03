/**
 * WHAT THE CLIENT'S PROFILE ACTUALLY SAYS, GRADED.
 *
 * FIGURE AGREEMENT IS NOT SEMANTIC AGREEMENT. Two readers can both say 90,000
 * and the write can still attach it to the wrong person's pension, put a
 * monthly figure in an annual field, or store it as a summary that no module
 * reads. Those are correct numbers in the wrong life, and grading numbers
 * cannot tell them apart from the right answer. So this grades the STATE:
 * value, field, owner, entity and representation.
 *
 * IT LIVES HERE BECAUSE TWO ARMS MUST BE GRADED IDENTICALLY. The semantic-claims
 * spike compares a new path against the current one, and a comparison whose two
 * sides use two copies of the grader measures the copies as much as the paths.
 */

const NON_VALUE_KEYS = new Set([
  'schemaVersion', 'revision', 'priority', 'sequence', 'version', 'ordinal'
]);

/** Figures an operation actually WRITES. A clarification writes none. */
export function amountsIn(operations) {
  const found = [];
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    for (const [key, item] of Object.entries(value)) {
      if (NON_VALUE_KEYS.has(key)) continue;
      if (typeof item === 'number' && Number.isFinite(item)) found.push({ key, value: item });
      else walk(item);
    }
  };
  operations
    .filter((operation) => operation.op !== 'request_clarification')
    .forEach((operation) => walk(operation.value));
  return found;
}

/** Read a slash path out of a profile. */
export function atPath(profile, path) {
  return String(path || '').split('/').filter(Boolean)
    .reduce((node, key) => (node === null || node === undefined ? node : node[key]), profile);
}

/** Every money value in the resulting profile, with where it landed. */
export function canonicalMoney(profile, node = profile, trail = [], found = []) {
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    node.forEach((item, index) => canonicalMoney(profile, item, [...trail, String(index)], found));
    return found;
  }
  if (typeof node.amount === 'number' && typeof node.currency === 'string') {
    found.push({ trail: trail.join('/'), amount: node.amount, currency: node.currency });
    return found;
  }
  for (const [key, item] of Object.entries(node)) {
    canonicalMoney(profile, item, [...trail, key], found);
  }
  return found;
}

/** Does the resulting canonical state say what this case expects? */
export function canonicalProblems(profile, expectations, forbidden) {
  const problems = [];
  const money = canonicalMoney(profile);
  const has = (want) => {
    if (want.path !== undefined) {
      const node = atPath(profile, want.path);
      return Boolean(node)
        && Math.abs(Number(node.amount) - want.amount) < 1e-6
        && (!want.currency || node.currency === want.currency);
    }
    if (want.collection !== undefined) {
      const records = profile?.[want.collection] || [];
      return records.some((record) => {
        if (want.ownerId !== undefined) {
          const owners = record.ownerId !== undefined
            ? [record.ownerId]
            : (record.ownerIds || []);
          if (!owners.includes(want.ownerId)) return false;
        }
        if (want.type !== undefined && record.type !== want.type) return false;
        const field = want.field ? record[want.field] : null;
        if (!field) return Boolean(want.field === undefined);
        return Math.abs(Number(field.amount) - want.amount) < 1e-6
          && (!want.currency || field.currency === want.currency);
      });
    }
    return money.some((item) => Math.abs(item.amount - want.anyMoney) < 1e-6
      && (!want.currency || item.currency === want.currency));
  };

  for (const want of expectations) {
    if (!has(want)) problems.push(`canonical state is missing ${JSON.stringify(want)}`);
  }
  for (const want of forbidden) {
    if (has(want)) problems.push(`canonical state contains the FORBIDDEN binding ${JSON.stringify(want)}`);
  }
  // ANYTHING WRITTEN THAT NO EXPECTATION ACCOUNTS FOR — counted per landing
  // place, not per amount. Matching by amount alone meant a correct EUR 2,500
  // in the right field plus a second EUR 2,500 on the wrong owner scored clean,
  // because the number was "expected". Each expectation accounts for one write.
  const budget = expectations
    .map((want) => (want.amount !== undefined ? want.amount : want.anyMoney))
    .filter((value) => value !== undefined);
  for (const item of money) {
    const index = budget.findIndex((value) => Math.abs(item.amount - value) < 1e-6);
    if (index !== -1) { budget.splice(index, 1); continue; }
    problems.push(`canonical state contains an unexpected ${item.currency} ${item.amount} at ${item.trail}`);
  }
  return problems;
}

/**
 * COUNT THE RECORDS IN A COLLECTION, so a duplicated entity is visible.
 *
 * Two pensions where the client has one is the worst failure this system can
 * produce: it silently doubles a retirement pot, and every figure in it is a
 * figure the client really said, so no numeric check can see it.
 */
export function collectionCounts(profile) {
  const counts = {};
  for (const key of ['pensions', 'assets', 'liabilities', 'incomeSources', 'properties', 'businesses', 'dependants']) {
    counts[key] = (profile?.[key] || []).length;
  }
  return counts;
}
