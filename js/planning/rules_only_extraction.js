import { createHouseholdProfile, createProfilePatch, normalizeHouseholdProfile } from './profile.js';
import { readJsonPointer } from './utils.js';

export const RULES_ONLY_EXTRACTION_VERSION = 'rules-extraction-2.0.0';

const AMOUNT_SOURCE = '(?:€|eur\\s*|£|gbp\\s*|\\$|usd\\s*)?\\s*[\\d][\\d,.]*(?:\\s*(?:k|m|grand|thousand|million))?';
const APPROXIMATE_WORDS = /\b(?:about|around|roughly|approximately|approx\.?|circa|nearly|almost)\b/i;

function parseAmount(raw, defaultCurrency = 'EUR') {
  if (typeof raw !== 'string') return null;
  const currency = /£|\bgbp\b/i.test(raw) ? 'GBP' : (/\$|\busd\b/i.test(raw) ? 'USD' : defaultCurrency);
  const match = raw.toLowerCase().replace(/\s+/g, ' ').match(/([\d][\d,.]*)\s*(k|m|grand|thousand|million)?/i);
  if (!match) return null;
  let amount = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;
  if (['k', 'grand', 'thousand'].includes(match[2])) amount *= 1000;
  if (['m', 'million'].includes(match[2])) amount *= 1000000;
  return { amount, currency };
}

function parsePercent(raw) {
  const match = String(raw || '').match(/([\d]+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) / 100 : null;
}

function findMatch(text, regex) {
  const match = regex.exec(text);
  if (!match) return null;
  return { match, value: match.groups?.amount || match[1], index: match.index };
}

function amountNear(text, regex, currency) {
  const found = findMatch(text, regex);
  return found ? { ...found, money: parseAmount(found.value, currency) } : null;
}

function opFor(profile, path, value) {
  return { op: typeof readJsonPointer(profile, path) === 'undefined' ? 'add' : 'replace', path, value };
}

function unusedCollectionId(profile, operations, collection, idKey, base) {
  const used = new Set((profile[collection] || []).map((entry) => entry[idKey]));
  operations
    .filter((operation) => operation.path === `/${collection}/-` && operation.value?.[idKey])
    .forEach((operation) => used.add(operation.value[idKey]));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function unusedPersonId(profile, base) {
  const used = new Set([profile.primaryPerson?.personId, profile.partner?.personId].filter(Boolean));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function addGoalOperation(profile, operations, type, title, priority = 'high') {
  if (profile.goals.some((goal) => goal.type === type && !['completed', 'paused'].includes(goal.status))) return;
  operations.push({
    op: 'add',
    path: '/goals/-',
    value: {
      goalId: unusedCollectionId(profile, operations, 'goals', 'goalId', `rules-goal-${type}`),
      type,
      title,
      priority,
      status: 'exploring'
    }
  });
}

function findExisting(profile, collection, predicate) {
  const items = profile[collection] || [];
  const index = items.findIndex(predicate);
  return index >= 0 ? { item: items[index], index } : null;
}

function addCandidate(candidates, candidate) {
  const existing = candidates.find((entry) => entry.type === candidate.type);
  if (!existing || candidate.priority > existing.priority) {
    if (existing) candidates.splice(candidates.indexOf(existing), 1);
    candidates.push(candidate);
  }
}

export function detectRulesOnlyGoalCandidates(text) {
  const normalized = String(text || '').trim();
  const candidates = [];
  const add = (type, priority, ruleId, rationale) => addCandidate(candidates, {
    type,
    priority,
    confidence: 'high',
    triggeredRuleIds: [ruleId],
    rationale: [rationale]
  });
  if (/\b(?:buy|buying|purchase|purchasing|get)\b.{0,30}\b(?:first\s+)?(?:home|house|property)\b|\bfirst[- ]time buyer\b/i.test(normalized)) {
    add('buy_home', 100, 'text.buy_home.v1', 'The message explicitly describes buying a home.');
  }
  if (/\b(?:emergency fund|rainy day fund|cash buffer|cash reserve|liquidity|enough (?:cash|savings)|financial cushion)\b/i.test(normalized)) {
    add('maintain_liquidity', 95, 'text.liquidity.v1', 'The message asks about cash resilience or an emergency reserve.');
  }
  if (/\b(?:retire early|early retirement|financial independence|fire)\b/i.test(normalized)) {
    add('retire_early', 100, 'text.retire_early.v1', 'The message explicitly describes early retirement.');
  } else if (/\b(?:retire|retirement)\b/i.test(normalized)) {
    add('retire', 90, 'text.retire.v1', 'The message explicitly describes retirement.');
  }
  if (/\b(?:pension|prsa)\b/i.test(normalized)) {
    add('improve_pension', 85, 'text.pension.v1', 'The message explicitly mentions a pension.');
  }
  if (/\b(?:overpay|pay off|clear|reduce|refinance|switch)\b.{0,25}\bmortgage\b|\bmortgage\b.{0,25}\b(?:overpay|pay off|clear|reduce|refinance|switch)\b/i.test(normalized)) {
    add('optimise_mortgage', 90, 'text.mortgage.v1', 'The message asks about changing an existing mortgage path.');
  }
  if (/\b(?:personal|car|student|business|non[- ]housing) loan\b|\b(?:repay|pay off|clear|reduce|review)\b.{0,25}\bloan\b/i.test(normalized)) {
    add('manage_loan', 90, 'text.loan.v1', 'The message asks about a non-housing loan.');
  }
  if (/\b(?:college|university|third[- ]level|education fund|education funding)\b/i.test(normalized)) {
    add('fund_education', 85, 'text.education.v1', 'The message asks about education funding.');
  }
  if (/\b(?:overall position|financial position|financial overview|how (?:am i|are we) doing|complete financial review|full financial review)\b/i.test(normalized)) {
    add('understand_position', 85, 'text.position.v1', 'The message asks for an overall view of the household position.');
  }
  if (/\b(?:build|grow|create)\b.{0,25}\b(?:wealth|investments?|portfolio)\b/i.test(normalized)) {
    add('build_wealth', 80, 'text.wealth.v1', 'The message describes building long-term wealth.');
  }
  if (/\b(?:financial decision|weigh up|compare my options|compare our options)\b/i.test(normalized)) {
    add('assess_decision', 70, 'text.decision.v1', 'The message mentions a financial decision without a supported topic.');
  }
  if (/\b(?:inheritance planning|estate planning|transfer(?:ring)? wealth|capital acquisitions tax|cat planning|gift(?:ing)? assets?)\b/i.test(normalized)) {
    add('transfer_wealth', 80, 'text.transfer_wealth.v1', 'The message explicitly asks about a gift, estate or wealth transfer.');
  }
  if (/\b(?:business succession|business planning|business relief|company succession|company shares?|shareholding)\b/i.test(normalized)) {
    add('business_planning', 80, 'text.business_planning.v1', 'The message explicitly asks about planning around a business interest.');
  }
  if (/\b(?:farm succession|farm planning|agricultural planning|agricultural relief|agricultural assets?|farmland)\b/i.test(normalized)) {
    add('agricultural_planning', 80, 'text.agricultural_planning.v1', 'The message explicitly asks about agricultural assets or succession.');
  }
  return candidates.sort((left, right) => right.priority - left.priority || left.type.localeCompare(right.type));
}

/**
 * Conservative, no-model extraction for common home, liquidity and retirement
 * statements. It returns a draft patch; callers must still show review and
 * explicitly apply/confirm it.
 */
export function extractRulesOnlyProfilePatch(text, {
  profile: rawProfile,
  capturedAt = new Date().toISOString(),
  conversationTurnId,
  calculationDateIso = capturedAt.slice(0, 10)
} = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Rules-only extraction requires a non-empty message.');
  const profile = rawProfile
    ? normalizeHouseholdProfile(rawProfile)
    : createHouseholdProfile({ nowIso: capturedAt, calculationDateIso });
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  const currency = profile.preferences.baseCurrency;
  const goalCandidates = detectRulesOnlyGoalCandidates(normalized);
  const operations = [];
  const ambiguities = [];
  const followUpIntents = [];
  const warnings = [];
  const extractedPartnerId = profile.partner?.personId || unusedPersonId(profile, 'partner');
  const provenance = {
    source: 'user_statement',
    confidence: 'high',
    certainty: 'exact',
    capturedAt,
    confirmedByUser: false,
    ...(conversationTurnId ? { conversationTurnId } : {})
  };
  const approximateProvenance = { ...provenance, confidence: 'medium', certainty: 'approximate' };

  goalCandidates.forEach((candidate) => {
    const titles = {
      buy_home: 'Buy a home',
      maintain_liquidity: 'Maintain an emergency cash reserve',
      retire: 'Plan for retirement',
      retire_early: 'Explore early retirement',
      improve_pension: 'Improve pension readiness',
      optimise_mortgage: 'Optimise the mortgage',
      manage_loan: 'Review or repay a non-housing loan',
      fund_education: 'Fund children’s education',
      understand_position: 'Understand my current position',
      build_wealth: 'Build long-term wealth',
      assess_decision: 'Assess a financial decision',
      transfer_wealth: 'Plan a wealth transfer',
      business_planning: 'Plan around a business interest',
      agricultural_planning: 'Plan around agricultural assets'
    };
    addGoalOperation(profile, operations, candidate.type, titles[candidate.type], candidate.priority >= 90 ? 'high' : 'medium');
  });

  const primaryAge = findMatch(normalized, /\b(?:i am|i'm|i’m|aged|my age is)\s*(\d{1,3})\b/i);
  if (primaryAge) operations.push(opFor(profile, '/primaryPerson/age', Number(primaryAge.value)));
  const partnerAge = findMatch(normalized, /\b(?:my\s+)?(?:partner|spouse|wife|husband)\s+(?:is|is aged|aged)\s*(\d{1,3})\b/i);
  if (partnerAge) {
    if (profile.partner) operations.push(opFor(profile, '/partner/age', Number(partnerAge.value)));
    else operations.push({
      op: 'add',
      path: '/partner',
      value: { personId: extractedPartnerId, role: 'partner', age: Number(partnerAge.value), employmentStatus: 'unknown' }
    });
  }

  const partnerIncome = amountNear(
    normalized,
    new RegExp('\\b(?:my\\s+)?(?:partner|spouse|wife|husband).{0,35}?(?:earns?|earning|salary(?:\\s+is)?|income(?:\\s+is)?|makes?)\\s*(?<amount>' + AMOUNT_SOURCE + ')', 'i'),
    currency
  );
  const incomeMatches = Array.from(normalized.matchAll(new RegExp('\\b(?:i\\s+)?(?:earn|earning|salary(?:\\s+is)?|income(?:\\s+is)?|make|making)\\s*(?<amount>' + AMOUNT_SOURCE + ')(?<period>\\s*(?:a|per)\\s+month)?', 'gi')));
  const primaryIncomeMatch = incomeMatches.find((match) => {
    const prefix = lower.slice(Math.max(0, match.index - 30), match.index);
    return !/(?:partner|spouse|wife|husband)/.test(prefix);
  });

  const upsertIncome = (ownerId, money, period, label) => {
    if (!money) return;
    const annualMoney = { ...money, amount: /month/i.test(period || '') ? money.amount * 12 : money.amount };
    const existing = findExisting(profile, 'incomeSources', (income) => (
      income.ownerId === ownerId && ['employment', 'self_employment'].includes(income.type)
    ));
    if (existing) operations.push(opFor(profile, `/incomeSources/${existing.index}/grossAnnual`, annualMoney));
    else operations.push({
      op: 'add',
      path: '/incomeSources/-',
      value: {
        incomeId: unusedCollectionId(profile, operations, 'incomeSources', 'incomeId', `rules-${ownerId}-employment`),
        ownerId,
        type: 'employment',
        label,
        grossAnnual: annualMoney
      }
    });
  };
  if (primaryIncomeMatch) upsertIncome(
    profile.primaryPerson.personId,
    parseAmount(primaryIncomeMatch.groups.amount, currency),
    primaryIncomeMatch.groups.period,
    'Employment income'
  );
  if (partnerIncome) {
    if (!profile.partner && !partnerAge) {
      operations.push({ op: 'add', path: '/partner', value: { personId: extractedPartnerId, role: 'partner', employmentStatus: 'unknown' } });
    }
    upsertIncome(profile.partner?.personId || extractedPartnerId, partnerIncome.money, '', 'Partner employment income');
  }

  const cash = amountNear(
    normalized,
    new RegExp('(?:(?<amount>' + AMOUNT_SOURCE + ')\\s+(?:in|of)\\s+(?:cash|savings|deposit)|(?:cash|savings|deposit)(?:\\s+(?:of|is|are|totals?))?\\s*(?<amount2>' + AMOUNT_SOURCE + '))', 'i'),
    currency
  );
  if (cash?.match) {
    const rawAmount = cash.match.groups.amount || cash.match.groups.amount2;
    const money = parseAmount(rawAmount, currency);
    const existing = findExisting(profile, 'assets', (asset) => asset.type === 'cash');
    if (existing) operations.push(opFor(profile, `/assets/${existing.index}/currentValue`, money));
    else operations.push({
      op: 'add',
      path: '/assets/-',
      value: {
        assetId: unusedCollectionId(profile, operations, 'assets', 'assetId', 'rules-cash'),
        ownerIds: [profile.primaryPerson.personId],
        type: 'cash',
        label: 'Cash savings',
        currentValue: money,
        liquid: true
      }
    });
  }

  const spending = amountNear(
    normalized,
    new RegExp('\\b(?:we\\s+)?(?:spend|spending|expenses|outgoings|living costs)(?:\\s+(?:are|is|of|about|around))?\\s*(?<amount>' + AMOUNT_SOURCE + ')(?<period>\\s*(?:a|per)\\s+(?:month|year|annum))?', 'i'),
    currency
  );
  if (spending?.money) {
    const period = spending.match.groups.period || '';
    const path = /year|annum/i.test(period) ? '/expenses/annualTotal' : '/expenses/monthlyEssential';
    operations.push(opFor(profile, path, spending.money));
    if (!period) ambiguities.push({ fieldPath: path, reason: 'The spending period was not explicit; monthly was assumed.' });
  }
  const rent = amountNear(
    normalized,
    new RegExp('(?:rent(?:\\s+(?:is|of))?\\s*(?<amount>' + AMOUNT_SOURCE + ')|(?:pay|paying)\\s*(?<amount2>' + AMOUNT_SOURCE + ')(?:\\s+(?:a|per)?\\s*month)?\\s+(?:in\\s+)?rent)', 'i'),
    currency
  );
  if (rent?.match) {
    operations.push(opFor(profile, '/expenses/currentMonthlyRent', parseAmount(rent.match.groups.amount || rent.match.groups.amount2, currency)));
  }

  const houseSettings = { ...(profile.assumptions.values.housePurchase || {}) };
  let houseSettingsChanged = false;
  const monthlySaving = amountNear(
    normalized,
    new RegExp('\\b(?:save|saving|put aside|set aside)\\s*(?<amount>' + AMOUNT_SOURCE + ')\\s*(?:a|per)\\s+month', 'i'),
    currency
  );
  if (monthlySaving?.money) {
    houseSettings.currentMonthlySavings = monthlySaving.money.amount;
    houseSettings.plannedMonthlySavings = monthlySaving.money.amount;
    houseSettingsChanged = true;
  }
  if (/\bfirst[- ]time buyer\b/i.test(normalized)) {
    houseSettings.lendingCategory = 'first_time_buyer';
    houseSettings.schemeBuyerStatus = 'first_time_buyer';
    houseSettingsChanged = true;
  } else if (/\bfresh[- ]start\b/i.test(normalized)) {
    houseSettings.lendingCategory = 'second_or_subsequent';
    houseSettings.schemeBuyerStatus = 'fresh_start';
    houseSettingsChanged = true;
  } else if (/\b(?:second|subsequent|previous)(?:[- ]time)?(?: buyer| purchase| owner)?\b|\b(?:owned|bought)\s+(?:a\s+)?(?:home|house|property)\s+before\b|\bnot\s+(?:a\s+)?first[- ]time buyer\b/i.test(normalized)) {
    houseSettings.lendingCategory = 'second_or_subsequent';
    houseSettings.schemeBuyerStatus = 'previous_owner';
    houseSettingsChanged = true;
  }

  const buyHomeIntent = goalCandidates.some((candidate) => candidate.type === 'buy_home');
  const homePrice = buyHomeIntent ? amountNear(
    normalized,
    new RegExp('(?:\\b(?:home|house|property).{0,25}?(?:for|price|cost|budget|worth|at)\\s*(?:about|around|roughly|approximately|up to)?\\s*(?<amount>' + AMOUNT_SOURCE + ')|(?<amount2>' + AMOUNT_SOURCE + ').{0,15}\\b(?:home|house|property)\\b)', 'i'),
    currency
  ) : null;
  if (homePrice?.match) {
    const money = parseAmount(homePrice.match.groups.amount || homePrice.match.groups.amount2, currency);
    const existing = findExisting(profile, 'goals', (goal) => goal.type === 'buy_home' && !['completed', 'paused'].includes(goal.status));
    if (existing) {
      const operation = opFor(profile, `/goals/${existing.index}/targetAmount`, money);
      if (APPROXIMATE_WORDS.test(homePrice.match[0])) operation.provenance = approximateProvenance;
      operations.push(operation);
    }
    else {
      const pendingIndex = operations.findIndex((operation) => operation.path === '/goals/-' && operation.value?.type === 'buy_home');
      if (pendingIndex >= 0) {
        operations[pendingIndex].value.targetAmount = money;
        if (APPROXIMATE_WORDS.test(homePrice.match[0])) operations[pendingIndex].provenance = approximateProvenance;
      }
    }
  } else if (buyHomeIntent) {
    followUpIntents.push({ fieldPaths: ['/goals'], intent: 'ask_target_property_price' });
  }
  const targetYear = findMatch(normalized, /\b(?:by|in|before)\s+(20\d{2})\b/i);
  if (buyHomeIntent && targetYear) {
    const existing = findExisting(profile, 'goals', (goal) => goal.type === 'buy_home' && !['completed', 'paused'].includes(goal.status));
    const date = `${targetYear.value}-12-31`;
    if (existing) operations.push(opFor(profile, `/goals/${existing.index}/targetDate`, date));
    else {
      const pending = operations.find((operation) => operation.path === '/goals/-' && operation.value?.type === 'buy_home');
      if (pending) pending.value.targetDate = date;
    }
    ambiguities.push({ fieldPath: '/goals', reason: `Only the year ${targetYear.value} was stated; year-end was used as the reviewable draft date.` });
  }
  if (houseSettingsChanged) {
    operations.push(opFor(profile, '/assumptions/values/housePurchase', houseSettings));
  }

  const retirementAge = findMatch(normalized, /\b(?:retire|retirement)\s+(?:at|by|around|age)?\s*(\d{2})\b|\bretire\s+at\s+age\s+(\d{2})\b/i);
  if (retirementAge) {
    const value = Number(retirementAge.match[1] || retirementAge.match[2]);
    operations.push(opFor(profile, '/primaryPerson/intendedRetirementAge', value));
  }
  const retirementSettings = { ...(profile.assumptions.values.retirement || {}) };
  let retirementSettingsChanged = false;
  const retirementIncome = amountNear(
    normalized,
    new RegExp('(?:(?<amount>' + AMOUNT_SOURCE + ')\\s*(?:a|per)\\s+year.{0,20}\\b(?:in|during)\\s+retirement|retirement.{0,30}?(?:income|spending|need|target).{0,15}?(?<amount2>' + AMOUNT_SOURCE + '))', 'i'),
    currency
  );
  if (retirementIncome?.match) {
    retirementSettings.targetIncomeToday = parseAmount(
      retirementIncome.match.groups.amount || retirementIncome.match.groups.amount2,
      currency
    ).amount;
    retirementSettingsChanged = true;
  }
  const pensionPot = amountNear(
    normalized,
    new RegExp('(?:pension(?:\\s+pot|\\s+fund|\\s+value)?(?:\\s+(?:is|of|worth|has))?\\s*(?<amount>' + AMOUNT_SOURCE + ')|(?<amount2>' + AMOUNT_SOURCE + ')\\s+(?:in\\s+)?(?:my\\s+)?pension)', 'i'),
    currency
  );
  const personalContribution = parsePercent((normalized.match(/(?:i\s+)?contribut(?:e|ing)\s+([\d.]+\s*%)/i) || [])[1]);
  const employerContribution = parsePercent((normalized.match(/employer\s+(?:contribut(?:es|ion)|puts?\s+in)\s+([\d.]+\s*%)/i) || [])[1]);
  if (pensionPot?.match || personalContribution !== null || employerContribution !== null) {
    const existing = findExisting(profile, 'pensions', (pension) => pension.ownerId === profile.primaryPerson.personId);
    const money = pensionPot?.match
      ? parseAmount(pensionPot.match.groups.amount || pensionPot.match.groups.amount2, currency)
      : null;
    if (existing) {
      if (money) operations.push(opFor(profile, `/pensions/${existing.index}/currentValue`, money));
      if (personalContribution !== null) {
        operations.push(opFor(profile, `/pensions/${existing.index}/employeeContributionRate`, personalContribution));
      }
      if (employerContribution !== null) {
        operations.push(opFor(profile, `/pensions/${existing.index}/employerContributionRate`, employerContribution));
      }
    } else {
      operations.push({
        op: 'add',
        path: '/pensions/-',
        value: {
          pensionId: unusedCollectionId(profile, operations, 'pensions', 'pensionId', 'rules-primary-pension'),
          ownerId: profile.primaryPerson.personId,
          type: 'other',
          ...(money ? { currentValue: money } : {}),
          ...(personalContribution !== null ? { employeeContributionRate: personalContribution } : {}),
          ...(employerContribution !== null ? { employerContributionRate: employerContribution } : {})
        }
      });
    }
  }
  if (retirementSettingsChanged) operations.push(opFor(profile, '/assumptions/values/retirement', retirementSettings));

  const mortgage = /\bmortgage\b/i.test(normalized) ? amountNear(
    normalized,
    new RegExp('(?:mortgage(?:\\s+(?:balance|of|is))?\\s*(?<amount>' + AMOUNT_SOURCE + ')|(?<amount2>' + AMOUNT_SOURCE + ')\\s+mortgage)', 'i'),
    currency
  ) : null;
  if (mortgage?.match) {
    const existing = findExisting(profile, 'liabilities', (liability) => liability.type === 'mortgage');
    const money = parseAmount(mortgage.match.groups.amount || mortgage.match.groups.amount2, currency);
    const rate = parsePercent((normalized.match(/(?:at|rate(?:\s+of)?)\s+([\d.]+\s*%)/i) || [])[1]);
    const termMatch = normalized.match(/(\d{1,2})\s+years?\s+(?:left|remaining|to go)/i);
    if (existing) {
      operations.push(opFor(profile, `/liabilities/${existing.index}/currentBalance`, money));
      if (rate !== null) operations.push(opFor(profile, `/liabilities/${existing.index}/annualInterestRate`, rate));
      if (termMatch) operations.push(opFor(profile, `/liabilities/${existing.index}/remainingTermMonths`, Number(termMatch[1]) * 12));
    } else {
      operations.push({
        op: 'add',
        path: '/liabilities/-',
        value: {
          liabilityId: unusedCollectionId(profile, operations, 'liabilities', 'liabilityId', 'rules-mortgage'),
          ownerIds: [profile.primaryPerson.personId],
          type: 'mortgage',
          label: 'Mortgage',
          currentBalance: money,
          ...(rate !== null ? { annualInterestRate: rate } : {}),
          ...(termMatch ? { remainingTermMonths: Number(termMatch[1]) * 12 } : {})
        }
      });
    }
  }

  const loan = /\b(?:personal|car|student|business|non[- ]housing) loan\b/i.test(normalized) ? amountNear(
    normalized,
    new RegExp('(?:(?:personal|car|student|business|non[- ]housing)?\\s*loan(?:\\s+(?:balance|of|is))?\\s*(?<amount>' + AMOUNT_SOURCE + ')|(?<amount2>' + AMOUNT_SOURCE + ')\\s+(?:personal|car|student|business|non[- ]housing)?\\s*loan)', 'i'),
    currency
  ) : null;
  if (loan?.match) {
    const existing = findExisting(profile, 'liabilities', (liability) => liability.type === 'loan');
    const loanMoney = parseAmount(loan.match.groups.amount || loan.match.groups.amount2, currency);
    const rate = parsePercent((normalized.match(/(?:at|rate(?:\s+of)?)\s+([\d.]+\s*%)/i) || [])[1]);
    const termMatch = normalized.match(/(\d{1,2})\s+years?\s+(?:left|remaining|to go)/i);
    if (existing) {
      operations.push(opFor(profile, `/liabilities/${existing.index}/currentBalance`, loanMoney));
      if (rate !== null) operations.push(opFor(profile, `/liabilities/${existing.index}/annualInterestRate`, rate));
      if (termMatch) operations.push(opFor(profile, `/liabilities/${existing.index}/remainingTermMonths`, Number(termMatch[1]) * 12));
    } else {
      operations.push({
        op: 'add',
        path: '/liabilities/-',
        value: {
          liabilityId: unusedCollectionId(profile, operations, 'liabilities', 'liabilityId', 'rules-loan'),
          ownerIds: [profile.primaryPerson.personId],
          type: 'loan',
          label: 'Loan',
          currentBalance: loanMoney,
          ...(rate !== null ? { annualInterestRate: rate } : {}),
          ...(termMatch ? { remainingTermMonths: Number(termMatch[1]) * 12 } : {})
        }
      });
    }
  }

  if (/\b(?:college|university|third[- ]level|education fund)\b/i.test(normalized)) {
    const college = { ...(profile.assumptions.values.collegeFunding || {}), requested: true };
    operations.push(opFor(profile, '/assumptions/values/collegeFunding', college));
  }

  if (operations.length === 0) {
    warnings.push('No bounded profile fields were confidently extracted; continue with structured questions.');
  }
  const patch = createProfilePatch(operations.map((operation) => ({ provenance, ...operation })), {
    patchId: `rules-${conversationTurnId || 'turn'}`,
    provenance
  });
  return {
    extractionVersion: RULES_ONLY_EXTRACTION_VERSION,
    patch,
    goalCandidates,
    ambiguities,
    followUpIntents,
    warnings
  };
}
