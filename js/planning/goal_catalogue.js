/**
 * Canonical consumer goal vocabulary.
 *
 * The module manifest owns goal -> analysis routing. This catalogue owns what
 * a goal means, how it is labelled, and the conservative no-model evidence
 * rule. Keeping those concerns separate also retains recognised adviser-only
 * goals and the generic decision goal, which do not all have consumer routes.
 */

const definitions = [
  {
    type: 'understand_position',
    recordTitle: 'Understand my current position',
    clientPhrase: 'understanding your overall position',
    include: 'an explicit request for an overall financial view, health check or understanding where the household stands',
    exclude: 'a list of balances without a request to review the overall position',
    evidence: /\b(?:financial|money|household)\s+(?:health\s*check|check[- ]?up|overview|review)\b|\b(?:understand(?:ing)?|see(?:ing)?|show|work(?:ing)? out|find(?:ing)? out|get(?:ting)? (?:a )?(?:clear )?(?:sense|view) of|know(?:ing)?)\b.{0,40}\b(?:where|how)\s+(?:i|we|our household)\s+(?:stand|stands|are doing)\b|\b(?:overall|broader|full|complete)\s+(?:financial\s+)?(?:position|picture|review|overview)\b|\b(?:review|check|assess)\b.{0,30}\b(?:our|my)\s+(?:finances|financial position|money situation)\b|\b(?:know|see|check|work(?:ing)? out|find(?:ing)? out)\b.{0,45}\b(?:money|savings|assets|finances)\b.{0,25}\b(?:will|can|might|should)\s+last\b/i,
    score: 92
  },
  {
    type: 'maintain_liquidity',
    recordTitle: 'Maintain an emergency cash reserve',
    clientPhrase: 'building cash resilience',
    include: 'an explicit aim to build, keep or size an emergency fund, cash buffer or reserve',
    exclude: 'merely holding cash or saying flexibility matters to another decision',
    evidence: /\b(?:build(?:ing)?|creat(?:e|ing)|keep(?:ing)?|maintain(?:ing)?|protect(?:ing)?|set(?:ting)? up|put(?:ting)? aside|work(?:ing)? out|siz(?:e|ing)|need(?:ing)?|want(?:ing)?|sav(?:e|ing))\b.{0,35}\b(?:emergency fund|emergency buffer|rainy day fund|cash buffer|cash reserve|financial cushion|liquidity)\b|\b(?:emergency fund|emergency buffer|cash buffer|cash reserve)\b.{0,25}\b(?:goal|priority|enough|target)\b|\b(?:keep|keeping|hold|holding)\b.{0,25}\b(?:three|six|\d+)\s+months?\b.{0,25}\bcash\b/i,
    score: 95
  },
  {
    type: 'buy_home',
    recordTitle: 'Buy a home',
    clientPhrase: 'buying a home',
    include: 'an explicit aim to buy or purchase a home or become a first-time buyer',
    exclude: 'owning, valuing or discussing an existing property without purchase intent',
    evidence: /\b(?:buy|buying|purchas(?:e|ing)|get(?:ting)?|sav(?:e|ing) for|afford(?:ing)?|move|moving)\b.{0,35}\b(?:first\s+)?(?:home|house|property|place)\b|\b(?:sav(?:e|ing))\b.{0,20}\b(?:home|house)?\s*deposit\b|\b(?:get(?:ting)? on|join(?:ing)?)\b.{0,20}\bproperty ladder\b|\bfirst[- ]time buyer\b|\b(?:home|house)\s+purchase\b.{0,25}\b(?:goal|plan|priority|next)\b/i,
    score: 100
  },
  {
    type: 'build_wealth',
    recordTitle: 'Build long-term wealth',
    clientPhrase: 'building wealth',
    include: 'an explicit aim to grow wealth, investments or a portfolio over time',
    exclude: 'merely stating the value of an investment holding',
    evidence: /\b(?:build(?:ing)?|grow(?:ing)?|creat(?:e|ing)|increas(?:e|ing)|develop(?:ing)?)\b.{0,35}\b(?:wealth|investments?|portfolio|long[- ]term assets?)\b|\b(?:start(?:ing)? (?:to )?invest|invest(?:ing)? more|sav(?:e|ing) for the long term)\b/i,
    score: 85
  },
  {
    type: 'improve_pension',
    recordTitle: 'Improve pension readiness',
    clientPhrase: 'improving your pension position',
    include: 'an explicit aim to improve, review, increase or compare pension saving or contributions',
    exclude: 'merely stating that a pension exists or giving its current value',
    evidence: /\b(?:improv(?:e|ing)|review(?:ing)?|increas(?:e|ing)|boost(?:ing)?|maximi[sz](?:e|ing)|top(?:ping)? up|add(?:ing)? to|contribut(?:e|ing)\s+(?:more|extra)|start(?:ing)?(?:\s+(?:a|my|our))?|open(?:ing)?|set(?:ting)? up|pay(?:ing)? more|put(?:ting)? more|put(?:ting)? extra|mak(?:e|ing)\s+(?:additional|extra)\s+contributions?|sort(?:ing)? out|compar(?:e|ing))\b.{0,35}\b(?:pension|prsa|avcs?|retirement saving)\b|\b(?:get|got)(?:ting)?\s+(?:around|round)\s+to\s+(?:start|starting|open|opening|set|setting|sort|sorting)\b.{0,30}\b(?:pension|prsa|retirement saving)\b|\b(?:pension|prsa|avcs?)\b.{0,35}\b(?:improv(?:e|ing)|review(?:ing)?|increas(?:e|ing)|boost(?:ing)?|maximi[sz](?:e|ing)|top(?:ping)? up|contribut(?:e|ing)\s+(?:more|extra)|start(?:ing)? contributions?|pay(?:ing)? more|put(?:ting)? more|put(?:ting)? extra|mak(?:e|ing)\s+(?:additional|extra)\s+contributions?|option|saving|plan(?:ning)?)\b/i,
    score: 90
  },
  {
    type: 'retire',
    recordTitle: 'Plan for retirement',
    clientPhrase: 'planning retirement',
    include: 'an explicit aim to plan, prepare or determine readiness for ordinary retirement',
    exclude: 'early-retirement or FIRE evidence, merely saying someone is retired, or quoting a pension value',
    evidence: /\b(?:want(?:ing)?|hop(?:e|ing)|aim(?:ing)?|expect(?:ing)?|intend(?:ing)? to|need(?:ing)? to|plan(?:ning)?|prepar(?:e|ing)|consider(?:ing)?|ready|on track|afford|work(?:ing)? out|look(?:ing)? at|would like|i['’]d like)\b.{0,35}\bretir(?:e|ement|ing)\b|\bretir(?:e|ement|ing)\b.{0,35}\b(?:goal|priority|focus|plan(?:ning)?|ready|on track|afford|age|can wait|later|eventually|help|options?)\b/i,
    score: 88
  },
  {
    type: 'retire_early',
    recordTitle: 'Explore early retirement',
    clientPhrase: 'planning early retirement',
    include: 'an explicit aim to retire early or reach financial independence before ordinary retirement',
    exclude: 'ordinary retirement with no early timing intent',
    evidence: /\b(?:retire early|early retirement|financial independence|fire)\b/i,
    score: 100
  },
  {
    type: 'optimise_mortgage',
    recordTitle: 'Review the mortgage path',
    clientPhrase: 'reviewing your mortgage',
    include: 'an explicit aim to review, shorten, switch, overpay, reduce or clear an existing mortgage',
    exclude: 'merely stating a mortgage balance, rate or home ownership',
    evidence: /\b(?:overpay(?:ing|ments?)?|repay(?:ing)?|pay(?:ing)? (?:off|down)|clear(?:ing)?|reduc(?:e|ing)|shorten(?:ing)?|refinanc(?:e|ing)|switch(?:ing)?|review(?:ing)?|optimis(?:e|ing)|optimiz(?:e|ing)|accelerat(?:e|ing)|manag(?:e|ing)|check(?:ing)?|assess(?:ing)?|compar(?:e|ing)|see(?:ing)?|work(?:ing)? out|find(?:ing)? out)\b.{0,60}\b(?:mortgage|home loan)\b|\b(?:mortgage|home loan)\b.{0,35}\b(?:overpay(?:ing|ments?)?|repay(?:ing)?|pay(?:ing)? (?:off|down)|paid off|clear(?:ing)?|reduc(?:e|ing)|shorten(?:ing)?|refinanc(?:e|ing)|switch(?:ing)?|review(?:ing)?|optimis(?:e|ing)|optimiz(?:e|ing)|accelerat(?:e|ing)|rate|deal|cost|expensive|over the odds|goal|priority|focus)\b|\bget(?:ting)?\b.{0,20}\b(?:mortgage|home loan)\b.{0,20}\bpaid off\b/i,
    score: 95
  },
  {
    type: 'manage_loan',
    recordTitle: 'Review or repay a non-housing loan',
    clientPhrase: 'reviewing or repaying your loan',
    include: 'an explicit aim to review, reduce, manage or clear a non-housing loan or debt',
    exclude: 'merely stating a loan balance or the existence of car finance',
    evidence: /\b(?:repay(?:ing)?|pay(?:ing)? (?:off|down)|clear(?:ing)?|reduc(?:e|ing)|review(?:ing)?|manag(?:e|ing)|consolidat(?:e|ing)|tackl(?:e|ing)|deal(?:ing)? with)\b.{0,35}\b(?:(?:personal|car|student|business|non[- ]housing|credit union)\s+)?(?:loans?|debts?|finance|credit[- ]cards?)\b|\b(?:priority|focus|main concern|biggest concern|real thing)\b.{0,45}\b(?:(?:personal|car|student|business|non[- ]housing|credit union)\s+)?(?:loans?|debts?|finance|credit[- ]cards?)\b|\b(?:(?:personal|car|student|business|non[- ]housing|credit union)\s+)?(?:loans?|debts?|finance|credit[- ]cards?)\b.{0,35}\b(?:repay(?:ing)?|pay(?:ing)? (?:off|down)|paid off|clear(?:ing)?|reduc(?:e|ing)|review(?:ing)?|manag(?:e|ing)|consolidat(?:e|ing)|tackl(?:e|ing)|costing|expensive|burden|problem|concern|priority|focus)\b/i,
    score: 93
  },
  {
    type: 'fund_education',
    recordTitle: 'Fund children’s education',
    clientPhrase: 'funding education',
    include: 'an explicit aim to save, fund, pay or plan for education, college or university costs',
    exclude: 'merely mentioning a child, school, college attendance or a baby',
    evidence: /\b(?:sav(?:e|ing)|fund(?:ing)?|pay(?:ing)?|cover(?:ing)?|plan(?:ning)?|prepar(?:e|ing)|look(?:ing)? at|review(?:ing)?|explor(?:e|ing)|afford(?:ing)?|send(?:ing)?)\b.{0,55}\b(?:college|university|third[- ]level|education|school fees|tuition)\b|\b(?:college|university|third[- ]level|education|school fees|tuition)\b.{0,40}\b(?:sav(?:e|ing)|fund(?:ing)?|pay(?:ing)?|cover(?:ing)?|afford(?:ing)?|costs?|plan(?:ning)?|prepar(?:e|ing)|look(?:ing)? at|review(?:ing)?|explor(?:e|ing)|goal|priority|later)\b|\b(?:put|get|send)\b.{0,35}\b(?:through|into|to)\s+(?:college|university)\b/i,
    score: 90
  },
  {
    type: 'assess_decision',
    recordTitle: 'Assess a financial decision',
    clientPhrase: 'assessing a financial decision',
    include: 'an explicit financial choice whose concrete subject does not yet map to another catalogue goal',
    exclude: 'a comparison whose concrete subjects already map to catalogue goals',
    evidence: /\b(?:financial decision|financial choice|weigh up|compare (?:my|our) options|choose between|not sure what financial path)\b/i,
    score: 70
  },
  {
    type: 'transfer_wealth',
    recordTitle: 'Plan a wealth transfer',
    clientPhrase: 'transferring wealth',
    include: 'an explicit aim to plan a gift, estate, inheritance or wealth transfer',
    exclude: 'merely mentioning an inheritance already received or an asset value',
    evidence: /\b(?:plan|planning|arrange|structure|prepare|reduce tax on)\b.{0,35}\b(?:inheritance|estate|gift|wealth transfer|capital acquisitions tax|cat)\b|\b(?:transfer(?:ring)? wealth|estate planning|inheritance planning|gift(?:ing)? assets?)\b/i,
    score: 85
  },
  {
    type: 'business_planning',
    recordTitle: 'Plan around a business interest',
    clientPhrase: 'business planning',
    include: 'an explicit aim to plan business succession, exit, relief or ownership',
    exclude: 'merely stating a company shareholding or business value',
    evidence: /\b(?:business|company)\s+(?:succession|exit|planning|relief)\b|\b(?:plan|review|structure|sell|transfer|exit|succeed)\b.{0,35}\b(?:business|company|shareholding)\b/i,
    score: 84
  },
  {
    type: 'agricultural_planning',
    recordTitle: 'Plan around agricultural assets',
    clientPhrase: 'agricultural planning',
    include: 'an explicit aim to plan farm succession, transfer or agricultural relief',
    exclude: 'merely stating that farmland exists or giving its value',
    evidence: /\b(?:farm|agricultural)\s+(?:succession|transfer|planning|relief)\b|\b(?:plan|review|structure|transfer|succeed)\b.{0,35}\b(?:farm|farmland|agricultural assets?)\b/i,
    score: 84
  }
];

export const GOAL_CATALOGUE = Object.freeze(definitions.map((definition) => Object.freeze(definition)));
export const GOAL_TYPES = Object.freeze(GOAL_CATALOGUE.map((definition) => definition.type));

const BY_TYPE = new Map(GOAL_CATALOGUE.map((definition) => [definition.type, definition]));

function getGoalDefinition(type) {
  return BY_TYPE.get(String(type || '')) || null;
}

export function getGoalTitle(type) {
  return getGoalDefinition(type)?.recordTitle || String(type || '');
}

export function getGoalClientPhrase(type) {
  return getGoalDefinition(type)?.clientPhrase || String(type || '');
}

export function goalEvidenceMatches(type, text) {
  const source = String(text || '');
  if (!catalogueEvidenceMatch(type, source)) return false;
  if (type === 'manage_loan' && !containsNonHousingLoanSubject(source)) return false;
  if (type === 'retire' && catalogueEvidenceMatch('retire_early', source)) return false;
  if (type === 'assess_decision') {
    // A vague choice is useful only until its concrete subject is known. Apply
    // this exclusion in the grounding gate as well as the fallback detector so
    // a model cannot add the vague goal alongside clearly classified outcomes.
    return !GOAL_CATALOGUE.some((candidate) => (
      candidate.type !== 'assess_decision' && goalEvidenceMatches(candidate.type, source)
    ));
  }
  return true;
}

const PRIMARY_CUE = /\b(?:main|primary|top|first|number one|highest|most important|immediate)\s+(?:goal|priority|focus|concern)\b|\b(?:my|our|the)\s+(?:goal|priority|focus)\s+is\b|\b(?:the\s+)?real\s+(?:goal|thing|priority|focus)\b|\b(?:focus|start|begin)\s+(?:on|with)\b|^\s*first\b|\b(?:comes?|goes?)\s+first\b|\b(?:right now|today|initially)\b.{0,30}\b(?:priority|focus|matters most|need|want|would like)\b/i;
const SECONDARY_CUE = /\b(?:second(?:ary)?\s+(?:goal|priority|focus)|next\s+(?:goal|priority|focus)|later|eventually|afterwards|then|longer term|down the line|after that|can wait|less urgent|lower priority|not (?:the )?priority|not urgent)\b/i;
const PRIORITY_BARRIER = /[.;!?\u2013\u2014]|\s*,\s*|\b(?:and|but|then|whereas|while)\b/gi;

/**
 * Prefer evidence that stands within one ordering clause. This prevents an
 * action attached to one goal from reaching across a comma/conjunction and
 * falsely becoming the action for another. If coordinated grammar genuinely
 * needs the conjunction (for example, "buy and renovate a house"), the whole
 * span remains a conservative fallback after every local clause was tried.
 */
function catalogueEvidenceMatch(type, text) {
  const definition = getGoalDefinition(type);
  const source = String(text || '');
  if (!definition) return null;
  let start = 0;
  for (const barrier of source.matchAll(PRIORITY_BARRIER)) {
    const local = source.slice(start, barrier.index);
    const match = definition.evidence.exec(local);
    if (match) {
      match.index += start;
      return match;
    }
    start = barrier.index + barrier[0].length;
  }
  const trailing = source.slice(start);
  const trailingMatch = definition.evidence.exec(trailing);
  if (trailingMatch) {
    trailingMatch.index += start;
    return trailingMatch;
  }
  return definition.evidence.exec(source);
}

function localPriorityHint(text, match) {
  const barriers = [...text.matchAll(PRIORITY_BARRIER)];
  let start = 0;
  let end = text.length;
  for (const barrier of barriers) {
    const barrierEnd = barrier.index + barrier[0].length;
    if (barrierEnd <= match.index) {
      // "then" is itself an ordering cue for the following goal. Other
      // separators are discarded, but this one stays inside the local span.
      start = /\bthen\b/i.test(barrier[0]) ? barrier.index : barrierEnd;
    }
    else if (barrier.index >= match.index + match[0].length) { end = barrier.index; break; }
  }
  const local = text.slice(start, end);
  const primary = PRIMARY_CUE.test(local);
  const secondary = SECONDARY_CUE.test(local);
  if (primary === secondary) return 'unspecified';
  if (primary) return 'primary';
  if (secondary) return 'secondary';
  return 'unspecified';
}

/** Derive order from client evidence; model-provided rank is never authority. */
export function classifyGoalPriorityHint(type, text) {
  const source = String(text || '');
  const match = catalogueEvidenceMatch(type, source);
  return match ? localPriorityHint(source, match) : 'unspecified';
}

/**
 * Fail closed when independent planner reads each claim a primary goal.
 * Choosing one by array order would silently turn segmentation order into
 * client preference; no focus is safer and lets the normal focus question ask.
 */
export function normalizeGoalCandidatePriorities(candidates) {
  const normalized = (Array.isArray(candidates) ? candidates : []).map((candidate) => ({ ...candidate }));
  const primaryIndexes = normalized
    .map((candidate, index) => candidate?.priorityHint === 'primary' ? index : -1)
    .filter((index) => index >= 0);
  if (primaryIndexes.length > 1) {
    for (const index of primaryIndexes) normalized[index].priorityHint = 'unspecified';
  }
  return normalized;
}

/** Canonical profile rank for an explicit client ordering cue. */
export function goalProfilePriority(priorityHint, fallback = 'medium') {
  if (priorityHint === 'primary') return 'high';
  if (priorityHint === 'secondary') return 'low';
  return ['high', 'medium', 'low'].includes(fallback) ? fallback : 'medium';
}

function containsNonHousingLoanSubject(text) {
  const source = String(text || '');
  if (/\bnon[- ]housing\s+loan\b/i.test(source)) return true;
  const withoutHousingLoans = source.replace(/\b(?:home|housing|mortgage)\s+loans?\b/gi, '');
  return /\b(?:loans?|debt|finance|credit[- ]cards?)\b/i.test(withoutHousingLoans);
}

/** Conservative no-model classification derived only from this catalogue. */
export function detectCatalogueGoalCandidates(text) {
  const source = String(text || '').trim();
  const candidates = [];
  for (const definition of GOAL_CATALOGUE) {
    const match = catalogueEvidenceMatch(definition.type, source);
    if (!match || !goalEvidenceMatches(definition.type, source)) continue;
    candidates.push({
      type: definition.type,
      priority: definition.score,
      priorityHint: classifyGoalPriorityHint(definition.type, source),
      confidence: 'high',
      triggeredRuleIds: [`goal-catalogue.${definition.type}.v1`],
      rationale: [definition.include]
    });
  }
  return normalizeGoalCandidatePriorities(candidates)
    .sort((left, right) => right.priority - left.priority || left.type.localeCompare(right.type));
}

/** Stable prompt vocabulary generated from the same records validators use. */
export function goalClassificationPrompt() {
  return GOAL_CATALOGUE.map((definition) => (
    `- ${definition.type}: include for ${definition.include}; do not use for ${definition.exclude}.`
  )).join('\n');
}
