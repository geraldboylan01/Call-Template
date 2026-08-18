function formatMoney(value, currency = 'EUR') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'not yet available';
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0
  }).format(value);
}

function formatMonths(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'not yet available';
  return `${value.toFixed(1)} months`;
}

function liquidityHighlight(result) {
  const semantic = result.semanticResult;
  const shortfall = semantic.shortfallCash;
  // A reserve we could not compare is not a reserve that passed. Reading the
  // engine's own verdict keeps "we never established your spending" from being
  // reported to the client as "at or above target", in a positive tone.
  const position = semantic.position
    || (shortfall > 0 ? 'below_target' : 'at_or_above_target');
  const unknown = position === 'unknown';
  const below = position === 'below_target';
  return {
    id: 'liquidity-position',
    moduleId: result.moduleId,
    title: unknown
      ? 'Cash reserve could not be compared'
      : (below ? 'Cash reserve needs attention' : 'Cash reserve is at or above target'),
    message: unknown
      ? 'There was not enough about cash or monthly spending to compare the reserve against its target.'
      : (below
        ? `Current cash covers ${formatMonths(semantic.monthsCovered)}. The deterministic reserve target is ${formatMoney(semantic.targetCash, semantic.currency)}, leaving a ${formatMoney(shortfall, semantic.currency)} gap.`
        : `Current cash covers ${formatMonths(semantic.monthsCovered)} and is at least the ${formatMoney(semantic.targetCash, semantic.currency)} target.`),
    tone: below ? 'attention' : (unknown ? 'neutral' : 'positive'),
    priority: below ? 95 : 60,
    numericFacts: {
      currentCash: semantic.currentCash,
      monthsCovered: semantic.monthsCovered,
      targetCash: semantic.targetCash,
      shortfallCash: semantic.shortfallCash,
      surplusCash: semantic.surplusCash
    }
  };
}

function houseHighlight(result) {
  const semantic = result.semanticResult;
  const gap = semantic.currentCashGap || 0;
  const dateText = semantic.readyDateIso
    ? ` The protected-cash target is illustrated by ${semantic.readyDateIso}.`
    : ' No reliable ready date is available from the current inputs.';
  return {
    id: 'house-purchase-position',
    moduleId: result.moduleId,
    title: gap > 0 ? 'Home target has a protected-cash gap' : 'Home target is currently cash-ready',
    message: `The current standard-rule route supports about ${formatMoney(semantic.currentSupportablePrice, semantic.currency)} against a ${formatMoney(semantic.targetPropertyPrice, semantic.currency)} target. The current protected-cash gap is ${formatMoney(gap, semantic.currency)}.${dateText}`,
    tone: gap > 0 ? 'attention' : 'positive',
    priority: 100,
    numericFacts: {
      targetPropertyPrice: semantic.targetPropertyPrice,
      currentSupportablePrice: semantic.currentSupportablePrice,
      standardMortgageCapacity: semantic.standardMortgageCapacity,
      currentCashGap: semantic.currentCashGap,
      readyDateIso: semantic.readyDateIso,
      monthlySavingNeeded: semantic.monthlySavingNeeded
    }
  };
}

function pensionHighlight(result) {
  const semantic = result.semanticResult;
  const gap = semantic.gapVsRequired || 0;
  return {
    id: 'pension-position',
    moduleId: result.moduleId,
    title: gap > 0 ? 'Pension path is below the illustrated requirement' : 'Pension path meets the illustrated requirement',
    message: semantic.readinessSentence || `The deterministic projection compares ${formatMoney(semantic.projectedPotAtRetirement, semantic.currency)} with the required pension path.`,
    tone: gap > 0 ? 'attention' : 'positive',
    priority: 80,
    numericFacts: {
      projectedPotAtRetirement: semantic.projectedPotAtRetirement,
      requiredPot: semantic.requiredPot,
      gapVsRequired: semantic.gapVsRequired,
      surplusVsRequired: semantic.surplusVsRequired
    }
  };
}

function netRetirementHighlight(result) {
  const semantic = result.semanticResult;
  const gap = semantic.gapVsRequired || 0;
  return {
    id: 'net-retirement-position',
    moduleId: result.moduleId,
    title: gap > 0 ? 'Net retirement funding gap illustrated' : 'Available net fund meets the illustrated need',
    message: `The after-tax cash-flow engine estimates a required net fund today of ${formatMoney(semantic.requiredNetFundToday, semantic.currency)}${gap > 0 ? ` and a ${formatMoney(gap, semantic.currency)} gap` : ''}.`,
    tone: gap > 0 ? 'attention' : 'positive',
    priority: 78,
    numericFacts: {
      requiredNetFundToday: semantic.requiredNetFundToday,
      firstYearShortfall: semantic.firstYearShortfall,
      gapVsRequired: semantic.gapVsRequired,
      surplusVsRequired: semantic.surplusVsRequired
    }
  };
}

function mortgageHighlight(result) {
  const semantic = result.semanticResult;
  return {
    id: 'mortgage-position',
    moduleId: result.moduleId,
    title: 'Mortgage repayment path',
    message: `The modelled monthly payment is ${formatMoney(semantic.monthlyPayment, semantic.currency)}, with ${formatMoney(semantic.totalInterestLifetime, semantic.currency)} of lifetime interest${semantic.payoffYear ? ` and payoff in ${semantic.payoffYear}` : ''}.`,
    tone: 'neutral',
    priority: 70,
    numericFacts: { ...semantic }
  };
}

function loanHighlight(result) {
  const semantic = result.semanticResult;
  return {
    id: 'loan-position',
    moduleId: result.moduleId,
    title: 'Loan repayment path',
    message: `The modelled monthly payment is ${formatMoney(semantic.monthlyPayment, semantic.currency)}, with ${formatMoney(semantic.totalInterestLifetime, semantic.currency)} of lifetime interest${semantic.payoffYear ? ` and payoff in ${semantic.payoffYear}` : ''}.`,
    tone: 'neutral',
    priority: 69,
    numericFacts: { ...semantic }
  };
}

function collegeHighlight(result) {
  const semantic = result.semanticResult;
  return {
    id: 'college-position',
    moduleId: result.moduleId,
    title: 'Future college-cost range',
    message: `The reviewed scenarios run from ${formatMoney(semantic.nominalCostRange?.low, semantic.currency)} to ${formatMoney(semantic.nominalCostRange?.high, semantic.currency)} in nominal costs, starting in ${semantic.firstCollegeYear}.`,
    tone: 'neutral',
    priority: 65,
    numericFacts: { ...semantic }
  };
}

function personalBalanceSheetHighlight(result) {
  const semantic = result.semanticResult;
  const reserveText = typeof semantic.reserveMonths === 'number'
    ? ` Spendable reserves cover ${formatMonths(semantic.reserveMonths)} of current spending.`
    : '';
  return {
    id: 'personal-balance-sheet-position',
    moduleId: result.moduleId,
    title: semantic.netWorth < 0 ? 'Liabilities exceed recorded assets' : 'Recorded assets and liabilities are reconciled',
    message: `The deterministic calculation records gross assets of ${formatMoney(semantic.grossAssets, semantic.currency)}, liabilities of ${formatMoney(semantic.totalLiabilities, semantic.currency)}, and net worth of ${formatMoney(semantic.netWorth, semantic.currency)}.${reserveText}`,
    tone: semantic.netWorth < 0 ? 'attention' : 'neutral',
    priority: 90,
    numericFacts: {
      grossAssets: semantic.grossAssets,
      totalLiabilities: semantic.totalLiabilities,
      netWorth: semantic.netWorth,
      spendableReserves: semantic.spendableReserves,
      reserveMonths: semantic.reserveMonths
    }
  };
}

const HIGHLIGHT_BUILDERS = Object.freeze({
  personal_balance_sheet: personalBalanceSheetHighlight,
  liquidity_analysis: liquidityHighlight,
  house_purchase: houseHighlight,
  pension_projection: pensionHighlight,
  net_retirement_cashflow: netRetirementHighlight,
  mortgage_analysis: mortgageHighlight,
  loan_analysis: loanHighlight,
  college_funding: collegeHighlight
});

export const MAX_SPEAKABLE_TEXT_CHARACTERS = 2400;

function buildSpeakableText(highlights) {
  const included = [];
  for (const highlight of highlights) {
    if (typeof highlight.message !== 'string' || !highlight.message) continue;
    const candidate = [...included, highlight.message].join(' ');
    // Never cut a deterministic message mid-figure. If a future module emits
    // an unexpectedly large message, omit that whole message and fail closed.
    if (candidate.length <= MAX_SPEAKABLE_TEXT_CHARACTERS) included.push(highlight.message);
  }
  return included.join(' ');
}

/** Produce a number-preserving summary entirely from code-owned results. */
export function summarizeAnalysisResults({ results = [], errors = [], analysisPlan } = {}) {
  const highlights = results
    .map((result) => HIGHLIGHT_BUILDERS[result.moduleId]?.(result))
    .filter(Boolean)
    .sort((left, right) => right.priority - left.priority || left.moduleId.localeCompare(right.moduleId));
  const warnings = [...new Set(results.flatMap((result) => result.warnings || []))];
  const missingCount = (analysisPlan?.requiredQuestions || []).length;
  const nextSteps = [];
  if (missingCount > 0) nextSteps.push(`Review ${missingCount} missing information ${missingCount === 1 ? 'item' : 'items'} before running the affected analyses.`);
  if (errors.length > 0) nextSteps.push('Review analyses that could not run; no failed analysis changed another result.');
  if (highlights.length > 0) nextSteps.push('Confirm the inputs and dated assumptions before acting on any illustration.');
  return {
    generatedBy: 'deterministic_rules',
    headline: highlights[0]?.title || (missingCount > 0 ? 'More information is needed' : 'No consumer analysis was run'),
    speakableText: buildSpeakableText(highlights),
    highlights,
    warnings,
    nextSteps,
    completedModuleIds: results.map((result) => result.moduleId)
  };
}
