// Independent reference: imports no engine, normaliser, rate resolver or contract.
// Find funding by simulating nominal start-of-year cash flows and bisection.
export function referenceDatedCostFunding({ costYears, rate, startsInYears, cashToday = 0,
  funding = 'save_then_pay', savingStartsInYears = 0 }) {
  function simulate(initial, annual, payBills = false) {
    let balance = initial;
    const rows = [];
    for (let yearIndex = 0; yearIndex <= costYears.at(-1).yearIndex; yearIndex++) {
      if (yearIndex > 0) balance *= 1 + rate;
      const cost = costYears.find(row => row.yearIndex === yearIndex)?.cost ?? 0;
      const amount = payBills ? Math.max(0, cost - balance)
        : yearIndex >= savingStartsInYears && yearIndex < startsInYears ? annual : 0;
      balance += amount - cost;
      rows.push({ yearIndex, amount, cost, balance });
    }
    return { closing: balance, rows };
  }
  function bisect(fn) {
    let low = 0, high = Math.max(1, costYears.reduce((sum, row) => sum + row.cost, 0));
    while (fn(high) < 0) high *= 2;
    for (let i = 0; i < 160; i++) {
      const mid = (low + high) / 2;
      if (fn(mid) < 0) low = mid; else high = mid;
    }
    return (low + high) / 2;
  }
  const requiredToday = bisect(lump => simulate(lump, 0).closing);
  const annual = funding === 'save_then_pay' ? bisect(amount => simulate(cashToday, amount).closing) : 0;
  const result = simulate(funding === 'lump_sum_now' ? requiredToday : cashToday, annual, funding === 'each_year');
  return { requiredToday, moneyNow: Math.max(0, requiredToday - cashToday),
    moneyEachYear: result.rows.filter(row => funding === 'each_year' || (funding === 'save_then_pay' && row.yearIndex < startsInYears))
      .map(({ yearIndex, amount }) => ({ yearIndex, amount })), rows: result.rows };
}
