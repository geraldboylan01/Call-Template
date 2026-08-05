/**
 * The live lane's three tools.
 *
 * DESIGN RULE: EVERY EXECUTOR IS PURE JS PLUS AT MOST A FEW D1 WRITES.
 *
 * The v2 lane put an 8-second LLM call between the client finishing a sentence
 * and the model being allowed to reply (plus a serialized 12-second retry). The
 * work that call was doing — deciding what the client said — is done here by
 * the model itself, inside the same response it speaks. What is left on the
 * server is validation, which is deterministic and fast.
 *
 * If anything in this file ever grows a network call to a model, the latency
 * bug is back.
 *
 * The versioned-tool machinery from the v2 lane is deliberately NOT ported:
 * no per-call `expectedRevision`, no tool-attempt rows, no nonce binding, no
 * retry loop on rejection. Once nothing but confirm_and_run can mutate money,
 * optimistic concurrency on that one call is sufficient, and every other
 * rejection can simply be ignored by a conversation that keeps moving.
 */

import { ConsumerError } from '../errors.js';
import { applyPlannerCandidates, confirmPlanSelection } from '../planning_turn.js';
import { buildPlanningContext } from '../planning_context.js';
import {
  confirmAndRunRealtimeAnalysisPlan,
  prepareRealtimeVoiceAnalysisPlan
} from '../realtime_analysis.js';
import { classifySpokenPlanConfirmation } from '../realtime_completion.js';
import { getCurrentProfile, getSessionRow } from '../repository.js';
import { buildConfirmedRealtimeFactSummary, formattedFactValue } from '../realtime_fact_mapper.js';
import { MODULE_IDS } from '../../../../js/planning/contracts.js';
import { getSemanticFactDefinition, resolveSemanticFact } from '../../../../js/planning/semantic_facts.js';

const MAX_FACTS_PER_CALL = 10;

/**
 * The identity of THIS tool surface, recorded on the lease.
 *
 * Three tools, not the v2 lane's seven, and the difference is the point: the
 * model saves what it heard, reads its own state, and runs the plan. Anything
 * that recorded a live meeting under `consumer-realtime-tools-v7` would be
 * describing a surface this lane has never had.
 */
export const LIVE_TOOLSET_VERSION = 'planeir-live-tools-v1';

export const LIVE_TOOL_DEFINITIONS = Object.freeze([
  {
    type: 'function',
    name: 'save_facts',
    description:
      'Record what the client just told you. Batch everything from one answer into a single call. '
      + 'This never interrupts you — keep talking; the drafts appear on the client\'s screen. '
      + 'Use the exact factId and "Save as" value shape from your instructions. Never encode a '
      + 'structured answer as a prose string. Monetary values are '
      + '{"amount": <number copied from the client>, "currency": "EUR"}. '
      + 'The primary_goal value is {"type": "<goal>"}. '
      + 'Certainty is "exact" when they stated it plainly, "approximate" when they hedged or you '
      + 'inferred it from context, "range" for {"min":..,"max":..}, "unknown" when they genuinely '
      + 'do not know. For an unknown money or number use value:null; never substitute zero. '
      + 'Numbers and money must come from what they actually said — never estimate. '
      + 'Life-stage and household context may be inferred from a clear narrative at "approximate". '
      + 'confirm_none is a categorical claim that a position does not exist, so use it only when '
      + 'the client explicitly says they have none. Missing, unknown, withheld or deferred details '
      + 'are not confirm_none; omit that position fact instead. '
      + 'An explicit "I do not have any loans or other debts" must be saved as liability_position '
      + 'with {"operation":"confirm_none"} in the same response; acknowledging it aloud is not enough. '
      + 'If a fact comes back rejected, that is not the client\'s fault: say nothing about it and '
      + 'carry on.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['facts'],
      properties: {
        facts: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_FACTS_PER_CALL,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['factId', 'value', 'certainty'],
            properties: {
              factId: { type: 'string', minLength: 1, maxLength: 120 },
              value: {},
              certainty: { type: 'string', enum: ['exact', 'approximate', 'range', 'unknown'] }
            }
          }
        }
      }
    }
  },
  {
    type: 'function',
    name: 'get_state',
    description:
      'See what you have captured so far, which analyses are in play, and what is still missing. '
      + 'Use it whenever you are deciding what to ask next, or to check you are not about to '
      + 'repeat yourself. It is cheap — use it freely. It returns plain descriptions only; there '
      + 'are no internal names to read out.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} }
  },
  {
    type: 'function',
    name: 'confirm_and_run',
    description:
      'Run the analyses. Call this ONLY after you have said out loud what you are going to run '
      + 'and the client has clearly agreed in their own words. The server checks their actual '
      + 'last words and refuses if they did not clearly say yes. Never call it on an assumption, '
      + 'a maybe, or to move things along.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} }
  }
]);

export const LIVE_TOOL_NAMES = Object.freeze(LIVE_TOOL_DEFINITIONS.map((tool) => tool.name));

/**
 * The config the shared planning core sees.
 *
 * `realtimeConversationV2Enabled` is what the core uses to mean "this is a
 * free conversation, not the controlled v1 question journey". Two behaviours
 * hang off it and the live lane needs both:
 *
 *   1. planFactProposal skips the module-relevance gate, so an orientation
 *      fact can be saved BEFORE the analyses that would need it are chosen.
 *      Gating it the other way round is the circular-fact-gate defect from
 *      docs/realtime-conversation-intelligence-plan.md §0 Defect 3.
 *   2. facts save as reviewable drafts rather than waiting for a spoken
 *      read-back, which the live lane does not have.
 *
 * The live lane's own rollout flag is separate and is never conflated with it.
 */
function clientExplicitlyRequestedWiderPicture(profile) {
  const widerGoals = new Set(['understand_position', 'build_wealth']);
  const activeGoalTypes = (Array.isArray(profile?.goals) ? profile.goals : [])
    .filter((goal) => !['completed', 'paused'].includes(goal?.status))
    .map((goal) => goal?.type)
    .filter(Boolean);
  const selectedFocus = profile?.assumptions?.values?.planning?.primaryGoalType;
  if (selectedFocus) return widerGoals.has(selectedFocus);
  return activeGoalTypes.length > 0 && activeGoalTypes.every((goalType) => widerGoals.has(goalType));
}

export function livePlanningConfig(config, profile = null) {
  const base = { ...config, realtimeConversationV2Enabled: true };
  if (!profile || clientExplicitlyRequestedWiderPicture(profile)) return base;
  if (!Array.isArray(base.allowedModules)) return base;
  return {
    ...base,
    // The shared planner pins a balance-sheet review for most established
    // households. In a free conversation that silently turns a focused pension
    // or mortgage request into property/asset/business intake. The live lane
    // includes that wider review only when the client explicitly asks for it.
    allowedModules: base.allowedModules.filter(
      (moduleId) => moduleId !== MODULE_IDS.PERSONAL_BALANCE_SHEET
    )
  };
}

/** Load the planning context for the current session state. */
export async function loadLiveContext({ env, config, sessionId }) {
  const sessionRow = await getSessionRow(env, sessionId);
  if (!sessionRow) throw new ConsumerError(404, 'session_not_found', 'That planning session no longer exists.');
  const profile = await getCurrentProfile(env, sessionRow);
  return buildPlanningContext({
    config: livePlanningConfig(config, profile),
    sessionRow,
    profile,
    channel: 'live'
  });
}

function factLabel(factId) {
  return getSemanticFactDefinition(factId)?.label || factId;
}

/* ------------------------------------------------------------- save_facts */

const CONFIRMED_NONE_SUPPORT = Object.freeze({
  partner_person:
    /\b(?:(?:no|without)\s+(?:a\s+)?(?:partner|spouse|husband|wife)|(?:do not|don't)\s+have\s+(?:a\s+)?(?:partner|spouse|husband|wife)|i(?:\s+am|'m)\s+single)\b/i,
  income_sources:
    /\b(?:(?:no|without)\s+(?:income|earnings|wages|salary)|(?:do not|don't)\s+have\s+(?:any\s+)?(?:income|earnings|wages|salary))\b/i,
  asset_position:
    /\b(?:(?:no|without)\s+(?:cash\s+)?(?:savings?|investments?|assets?)|(?:do not|don't)\s+(?:have|own|hold)\s+(?:any\s+)?(?:cash\s+)?(?:savings?|investments?|assets?))\b/i,
  liability_position:
    /\b(?:(?:no|without)\s+(?:any\s+)?(?:loans?\s+or\s+(?:other\s+)?debts?|debts?|liabilit(?:y|ies))|(?:do not|don't)\s+(?:have|owe|carry)\s+any\s+(?!figures?|details?|balances?|amounts?)[^.!?]{0,100}\b(?:debts?|liabilit(?:y|ies))\b)\b/i,
  mortgage_position:
    /\b(?:(?:no|without)\s+(?:a\s+)?mortgage|(?:do not|don't)\s+have\s+(?:a\s+)?mortgage)\b/i,
  loan_position:
    /\b(?:(?:no|without)\s+(?:any\s+)?loans?|(?:do not|don't)\s+have\s+(?:any\s+)?loans?)\b/i,
  property_position:
    /\b(?:(?:no|without)\s+(?:any\s+)?(?:property|properties|home|house)|(?:do not|don't)\s+own\s+(?:any\s+)?(?:property|properties|home|house))\b/i,
  business_position:
    /\b(?:(?:no|without)\s+(?:a\s+|any\s+)?(?:business(?:es)?|compan(?:y|ies)|business interests?)|(?:do not|don't)\s+(?:have|own|run)\s+(?:a\s+|any\s+)?(?:business(?:es)?|compan(?:y|ies)|business interests?))\b/i,
  pension_positions:
    /\b(?:(?:no|without)\s+(?:a\s+|any\s+)?(?:pensions?|retirement funds?)|(?:do not|don't)\s+have\s+(?:a\s+|any\s+)?(?:pensions?|retirement funds?))\b/i,
  dependants:
    /\b(?:(?:no|without)\s+(?:dependants?|dependents?|children)|(?:do not|don't)\s+have\s+(?:any\s+)?(?:dependants?|dependents?|children))\b/i
});

const CONFIRMED_NONE_CORRECTION_OBJECTS = Object.freeze({
  partner_person: '(?:partner|spouse|husband|wife|boyfriend|girlfriend)',
  income_sources: '(?:income|earnings|wages|salary)',
  asset_position: '(?:cash|savings?|investments?|assets?|funds?)',
  liability_position:
    '(?:debts?|loans?|liabilit(?:y|ies)|mortgages?|credit cards?|cards?(?: balances?)?|'
    + 'overdrafts?|car finance|hire purchase)',
  mortgage_position: 'mortgage',
  loan_position: '(?:loans?|car finance|hire purchase)',
  property_position: '(?:property|properties|home|house|land|apartment|flat)',
  business_position: '(?:business(?:es)?|compan(?:y|ies)|business interests?)',
  pension_positions: '(?:pensions?|retirement funds?|PRSAs?|occupational schemes?)',
  dependants: '(?:dependants?|dependents?|children|kids?|sons?|daughters?|boys?|girls?)'
});

const DENIED_ABSENCE_PREFIX =
  /\b(?:is(?:\s+not|n't)\s+true\s+that|not\s+true\s+that|did(?:\s+not|n't)\s+(?:say|mean|claim|confirm)|can(?:\s+not|'t)\s+(?:say|confirm|claim)|ask(?:ed|ing)?\s+(?:me\s+)?(?:whether|if)|whether)\b/i;
const NON_CURRENT_ABSENCE_PREFIX =
  /\b(?:wish|if only|hope|used\s+to|formerly|previously|once|should|will|would|could|might|may|plan(?:ning)?|aim(?:ing)?|try(?:ing)?|want|intend|expect|suppose|hypothetically|think|believe|assume|guess|doubt|apparently|probably|possibly|maybe|perhaps|almost|nearly|virtually|practically|eventually|someday|goal)\b|\b(?:i|we|they|he|she)\s+had\b/i;
const NON_CURRENT_ABSENCE_SUFFIX =
  /^\s*(?:[,;:—-]\s*)*(?:by\s+(?:next|the)|next\s+(?:year|month)|eventually|someday|last\s+(?:year|month)|back\s+then|as\s+such|(?:as far as|so far as)\s+i\s+know|that\s+i\s+know(?:\s+of)?|probably|possibly|maybe|perhaps|apparently|really|i\s+(?:think|believe|suppose|guess))\b/i;
const NUMBER_IN_TRANSCRIPT =
  /(?<![\p{L}\p{N}_])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\p{L}\p{N}_])/gu;
const NUMERIC_STRING = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
const SPOKEN_NUMBER_VALUES = Object.freeze({
  zero: 0,
  one: 1,
  two: 2,
  both: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
});
const SPOKEN_NUMBER_SCALES = Object.freeze({
  hundred: 100,
  thousand: 1_000,
  million: 1_000_000
});

function requestsConfirmedNone(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.confirmNone === true || value.none === true) return true;
  return String(value.operation || value.action || '').trim().toLowerCase() === 'confirm_none';
}

function requestsCompleteSection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return String(value.operation || value.action || '').trim().toLowerCase() === 'complete_section';
}

function confirmedNoneHasPresenceConflict(factId, transcript) {
  const object = CONFIRMED_NONE_CORRECTION_OBJECTS[factId];
  if (!object) return false;
  const subjectAction =
    '(?:(?:i|we)\\s+(?:do\\s+)?'
    + '(?:have|own|hold|owe|carry|run|earn|receive|pay\\s+into)'
    + '|my\\s+(?:partner|spouse|husband|wife)\\s+'
    + '(?:has|owns|holds|owes|carries|runs|earns|receives)'
    + '|there\\s+(?:is|are))';
  const nonNegativeWord = '(?!(?:no|not|zero|none|neither|nor)\\b)[^\\s,.!?;:]+';
  const presence = new RegExp(
    `\\b${subjectAction}\\s+(?:the\\s+|a\\s+|an\\s+|any\\s+|some\\s+|my\\s+|our\\s+)?`
      + `(?:${nonNegativeWord}\\s+){0,4}${object}\\b`,
    'iu'
  );
  if (presence.test(transcript)) return true;
  if (factId === 'partner_person'
    && /\b(?:i|we)\s+(?:am|are|'m|'re)\s+married\b/i.test(transcript)) return true;
  if (factId === 'income_sources'
    && /\b(?:i|we)\s+(?:earn|make|receive|get paid)\s+(?!(?:no|nothing|zero)\b)/i.test(transcript)) {
    return true;
  }
  return false;
}

function confirmedNoneIsSupported(factId, transcript) {
  const pattern = CONFIRMED_NONE_SUPPORT[factId];
  if (!pattern) return false;
  const match = transcript.match(pattern);
  if (!match || typeof match.index !== 'number') return false;

  const sentenceStart = Math.max(
    transcript.lastIndexOf('.', match.index - 1),
    transcript.lastIndexOf('?', match.index - 1),
    transcript.lastIndexOf('!', match.index - 1),
    transcript.lastIndexOf(';', match.index - 1)
  ) + 1;
  const sentencePrefix = transcript.slice(sentenceStart, match.index);
  const clauseBreaks = [
    ...sentencePrefix.matchAll(
      /\b(?:but|however|although|though)\b|\band\s+(?=(?:i|we|there|my)\b)/gi
    )
  ];
  const lastClauseBreak = clauseBreaks.at(-1);
  const assertionPrefix = lastClauseBreak
    ? sentencePrefix.slice(lastClauseBreak.index + lastClauseBreak[0].length)
    : sentencePrefix;
  if (DENIED_ABSENCE_PREFIX.test(assertionPrefix)
    || NON_CURRENT_ABSENCE_PREFIX.test(assertionPrefix)) return false;
  if (confirmedNoneHasPresenceConflict(factId, transcript)) return false;

  const matchEnd = match.index + match[0].length;
  const suffix = transcript.slice(matchEnd);
  if (/^\s*\?/.test(suffix)) return false;
  if (NON_CURRENT_ABSENCE_SUFFIX.test(suffix)) return false;
  if (factId === 'liability_position') {
    const explicitOwedAmount =
      /\b(?:i|we)\s+(?:do\s+)?(?:owe|carry)\b[^.!?;]{0,70}(?:[€£$]\s*\d|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b)/i;
    const qualifiedAmount =
      /^\s*(?:[,;.!?—-]\s*)*(?:but|plus|just|only|although|except(?: for)?|apart from|other than|bar|well)\b[^.!?;]{0,100}(?:[€£$]\s*\d|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b)/i;
    const debtQualifier =
      /\b(?:owe|owing|carry|carrying|cards?|loans?|mortgages?|overdrafts?|finance|debts?|balances?)\b/i;
    const clearlyDifferentAsset =
      /\b(?:cash|savings?|investments?|assets?|credit union)\b/i;
    if (explicitOwedAmount.test(transcript)
      || (qualifiedAmount.test(suffix)
        && (debtQualifier.test(suffix) || !clearlyDifferentAsset.test(suffix)))) {
      return false;
    }
  }
  // Catch immediate corrections without treating "no debts, but I do have
  // savings" as a denial of the debt statement.
  const correctionLead =
    '(?:\\s*[,;.!?—-]\\s*)*'
    + '(?:(?:(?:but|however|actually|sorry|in fact|correction)'
    + '|(?:except for|apart from|other than))\\s*[:,;—-]?\\s*)*';
  if (new RegExp(
    `^\\s*${correctionLead}(?:i|we)\\s+do(?:\\s*[.!?]|$)`,
    'i'
  ).test(suffix)) {
    return false;
  }
  const correctionObject = CONFIRMED_NONE_CORRECTION_OBJECTS[factId];
  if (correctionObject) {
    const corrected = new RegExp(
      `^\\s*${correctionLead}(?:(?:i|we)\\s+(?:do\\s+)?`
        + `(?:have|own|hold|owe|carry|run)|there\\s+(?:is|are))\\s+`
        + `(?:a\\s+|any\\s+)?(?:[\\p{L}-]+\\s+){0,3}${correctionObject}\\b`,
      'iu'
    );
    if (corrected.test(suffix)) return false;
    const exception = new RegExp(
      '^\\s*(?:[,;.!?]\\s*)*'
        + `(?:but|plus|just|only|although|except(?: for)?|apart from|other than|bar|[—-])\\s+`
        + '(?:the\\s+|a\\s+|any\\s+)?'
        + `(?:[^\\s,.!?;:]+\\s+){0,3}${correctionObject}\\b`,
      'iu'
    );
    if (exception.test(suffix)) return false;
  }
  return true;
}

function numericLeaves(value, found = [], path = []) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    found.push({ value, path });
    return found;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (NUMERIC_STRING.test(trimmed)) {
      found.push({ value: Number(trimmed.replaceAll(',', '')), path });
    }
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => numericLeaves(item, found, [...path, String(index)]));
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    numericLeaves(item, found, [...path, key]);
  }
  return found;
}

function spokenNumberOccurrences(transcript) {
  const tokens = [...String(transcript || '').toLowerCase().matchAll(/\p{L}+/gu)]
    .map((match) => ({
      word: match[0],
      start: match.index,
      end: match.index + match[0].length
    }));
  const found = [];

  for (let start = 0; start < tokens.length; start += 1) {
    const first = tokens[start].word;
    if (!Object.hasOwn(SPOKEN_NUMBER_VALUES, first)
      && !(first === 'a'
        && Object.hasOwn(SPOKEN_NUMBER_SCALES, tokens[start + 1]?.word))) continue;

    let total = 0;
    let group = 0;
    let decimal = '';
    let point = false;
    let consumed = 0;
    for (let index = start; index < tokens.length; index += 1) {
      const token = tokens[index].word;
      if (token === 'and' && consumed > 0 && !point) {
        const next = tokens[index + 1]?.word;
        if (Object.hasOwn(SPOKEN_NUMBER_VALUES, next)
          || Object.hasOwn(SPOKEN_NUMBER_SCALES, next)) {
          consumed += 1;
          continue;
        }
        break;
      }
      if (token === 'point' && consumed > 0 && !point) {
        point = true;
        consumed += 1;
        continue;
      }
      if (point) {
        const digit = SPOKEN_NUMBER_VALUES[token];
        if (!Number.isInteger(digit) || digit < 0 || digit > 9) break;
        decimal += String(digit);
        consumed += 1;
        continue;
      }
      if (token === 'a'
        && Object.hasOwn(SPOKEN_NUMBER_SCALES, tokens[index + 1]?.word)) {
        group += 1;
        consumed += 1;
        continue;
      }
      if (Object.hasOwn(SPOKEN_NUMBER_VALUES, token)) {
        group += SPOKEN_NUMBER_VALUES[token];
        consumed += 1;
        continue;
      }
      if (!Object.hasOwn(SPOKEN_NUMBER_SCALES, token)) break;
      const scale = SPOKEN_NUMBER_SCALES[token];
      if (scale === 100) {
        group = (group || 1) * scale;
      } else {
        total += (group || 1) * scale;
        group = 0;
      }
      consumed += 1;
    }
    if (!consumed || (point && !decimal)) continue;
    found.push({
      value: Number(`${total + group}${decimal ? `.${decimal}` : ''}`),
      start: tokens[start].start,
      end: tokens[start + consumed - 1].end
    });
    start += consumed - 1;
  }
  return found;
}

function numberOccurrences(transcript) {
  return [
    ...[...transcript.matchAll(NUMBER_IN_TRANSCRIPT)]
      .map((match) => ({
        value: Number(match[0].replaceAll(',', '')),
        start: match.index,
        end: match.index + match[0].length
      }))
      .filter((item) => Number.isFinite(item.value)),
    ...spokenNumberOccurrences(transcript)
  ];
}

function metadataForNumericPath(value, path) {
  let node = value;
  let owner = '';
  let type = '';
  for (const segment of path) {
    if (node && typeof node === 'object') {
      owner = String(node.owner || node.ownerId || node.personId || owner).toLowerCase();
      type = String(node.type || type).toLowerCase();
      node = node[segment];
    }
  }
  return { owner, type };
}

function ownerSlotSuffix(owner) {
  if (['primary', 'self', 'me'].includes(owner)) return ':primary';
  if (['partner', 'spouse', 'husband', 'wife'].includes(owner)) return ':partner';
  if (['joint', 'household'].includes(owner)) return ':joint';
  return '';
}

function numericSlot(fact, leaf) {
  const factId = String(fact?.factId || '');
  const path = leaf.path.map((part) => String(part).toLowerCase());
  const joined = path.join('.');
  const last = path.at(-1) || '';
  const metadata = metadataForNumericPath(fact?.value, leaf.path);
  const owner = ownerSlotSuffix(metadata.owner);

  const scalarSlots = {
    target_home_price: 'home_price',
    gross_household_income: 'income',
    cash_savings: 'cash_savings',
    liability_monthly_payment: 'debt_payment',
    monthly_spending: 'monthly_spending',
    annual_net_spending: 'annual_spending',
    current_monthly_rent: 'rent',
    person_current_age: `current_age${owner}`,
    intended_retirement_age: `retirement_age${owner}`,
    state_pension_fraction: 'state_pension_fraction',
    state_pension_start_age: 'state_pension_age',
    pension_current_value: 'pension_value',
    pension_employee_contribution_rate: 'employee_pension_rate',
    pension_employer_contribution_rate: 'employer_pension_rate',
    target_retirement_income: 'retirement_income',
    mortgage_current_balance: 'mortgage_balance',
    mortgage_annual_interest_rate: 'mortgage_rate',
    loan_current_balance: 'loan_balance',
    loan_annual_interest_rate: 'loan_rate',
    dependant_current_age: 'dependant_age',
    dependant_count: 'dependant_count'
  };
  if (scalarSlots[factId]) return scalarSlots[factId];
  if (factId === 'mortgage_remaining_term_months') {
    return joined.includes('year') ? 'mortgage_term_years' : 'mortgage_term_months';
  }
  if (factId === 'loan_remaining_term_months') {
    return joined.includes('year') ? 'loan_term_years' : 'loan_term_months';
  }
  if (factId === 'partner_person') {
    if (joined.includes('retirement')) return 'retirement_age:partner';
    if (last === 'age' || joined.includes('currentage')) return 'current_age:partner';
    return null;
  }
  if (factId === 'income_sources') {
    const subtype = metadata.type ? `:${metadata.type}` : '';
    if (joined.includes('grossannual') || joined.includes('netannual')) {
      return `income${owner}${subtype}`;
    }
    return last === 'amount' ? `income${owner}${subtype}` : null;
  }
  if (factId === 'asset_position') {
    if (!joined.includes('currentvalue') && last !== 'amount') return null;
    return metadata.type === 'cash'
      ? 'cash_savings'
      : `asset_value${metadata.type ? `:${metadata.type}` : ''}`;
  }
  if (['liability_position', 'mortgage_position', 'loan_position'].includes(factId)) {
    const domain = factId === 'mortgage_position' ? 'mortgage'
      : factId === 'loan_position' ? 'loan' : 'debt';
    if (joined.includes('annualinterestrate') || last === 'rate') return `${domain}_rate`;
    if (joined.includes('monthlypayment')) return `${domain}_payment`;
    if (joined.includes('remainingtermyears') || last === 'years') return `${domain}_term_years`;
    if (joined.includes('remainingtermmonths') || last === 'months') return `${domain}_term_months`;
    if (joined.includes('currentbalance') || last === 'amount') return `${domain}_balance`;
    return null;
  }
  if (factId === 'property_position') {
    return joined.includes('currentvalue') || last === 'amount' ? 'property_value' : null;
  }
  if (factId === 'business_position') {
    return joined.includes('estimatedvalue') || last === 'amount' ? 'business_value' : null;
  }
  if (factId === 'pension_positions') {
    if (joined.includes('currentvalue') || (last === 'amount' && !joined.includes('contribution'))) {
      return `pension_value${metadata.type ? `:${metadata.type}` : ''}`;
    }
    if (joined.includes('employeecontributionrate')) return 'employee_pension_rate';
    if (joined.includes('employercontributionrate')) return 'employer_pension_rate';
    return null;
  }
  if (factId === 'dependants') {
    return last === 'age' || joined.includes('currentage') ? 'dependant_age' : null;
  }
  if (factId === 'college_cost_scenarios') {
    if (joined.includes('annualcosttodayperchild')) return 'college_annual_cost';
    if (joined.includes('oneoffcosttodayperchild')) return 'college_oneoff_cost';
    return null;
  }
  return null;
}

function localNumberContext(transcript, occurrence) {
  const barriers = [
    ...transcript.matchAll(
      /[.!?;\n]|,(?!\d)|\b(?:but|whereas|while|with)\b|\band\s+(?=(?:i|we|my|the|there|have|hold|own|owe|pay|rent|earn|salary|income|savings?|cash|work|occupational|prsa|pension|mortgage|loan)\b)/gi
    )
  ];
  let start = 0;
  let end = transcript.length;
  for (const barrier of barriers) {
    const barrierEnd = barrier.index + barrier[0].length;
    if (barrierEnd <= occurrence.start) start = Math.max(start, barrierEnd);
    else if (barrier.index >= occurrence.end) {
      end = barrier.index;
      break;
    }
  }
  return transcript.slice(start, end).toLowerCase();
}

function ownerCueMatches(slot, context) {
  const qualifiers = slot.split(':').slice(1);
  if (qualifiers.includes('primary')) {
    return /\b(?:i|i'm|i am)\b/i.test(context)
      || /\bmy\s+(?:income|salary|wage|pay|earnings|age|pension)\b/i.test(context);
  }
  if (qualifiers.includes('partner')) {
    return /\b(?:partner|spouse|husband|wife|boyfriend|girlfriend)\b/i.test(context);
  }
  if (qualifiers.includes('joint')) return /\b(?:we|our|household|joint)\b/i.test(context);
  return true;
}

function numericOccurrenceSupportsSlot(slot, occurrence, transcript) {
  const context = localNumberContext(transcript, occurrence);
  if (!ownerCueMatches(slot, context)) return false;
  const base = slot.split(':')[0];
  const before = transcript.slice(Math.max(0, occurrence.start - 24), occurrence.start).toLowerCase();
  const after = transcript.slice(occurrence.end, occurrence.end + 28).toLowerCase();
  const nearby = transcript
    .slice(Math.max(0, occurrence.start - 150), occurrence.end + 150)
    .toLowerCase();
  const hasPercent = /^\s*(?:%|percent\b|per\s+cent\b)/i.test(after);
  const hasYears = /^\s*(?:years?|yrs?)\b/i.test(after);
  const hasMonths = /^\s*(?:months?|mos?)\b/i.test(after);
  const hasCurrency = /(?:€|£|\$)\s*$/u.test(before)
    || /^\s*(?:euros?|pounds?|dollars?)\b/i.test(after);
  const amountLike = hasCurrency || Math.abs(occurrence.value) >= 100;

  if (base === 'income') {
    if (!amountLike
      || !/\b(?:earn(?:s|ed|ing)?|income|salary|wage|gross|net|before tax|self-employ|paid|rent)\b/i
        .test(context)) return false;
    const qualifiers = slot.split(':').slice(1);
    const subtype = qualifiers.find((item) =>
      !['primary', 'partner', 'joint'].includes(item)
    );
    const hasEmploymentCue =
      /\b(?:salar(?:y|ied)|wages?|employ(?:ed|ee|er|ment)|job|paye|payroll|staff)\b/i
        .test(context)
      || /\bwork(?:ing)?\s+for\s+(?:a|an|the|my)\s+(?:company|employer)\b/i.test(context);
    const hasSelfEmploymentCue =
      /\b(?:self-employ|freelanc|business|sole trader)\b/i.test(context);
    const hasRentalCue = /\b(?:rental income|rent from|tenant)\b/i.test(context);
    const hasPensionCue = /\b(?:pension|state pension)\b/i.test(context);
    if (subtype === 'employment') {
      return !hasSelfEmploymentCue && !hasRentalCue && !hasPensionCue;
    }
    if (subtype === 'self_employment') {
      // The income amount often follows an earlier turn that established the
      // work type, so a natural "I earn €35,000 before tax" must remain usable
      // without making the client repeat "self-employed". Explicit competing
      // same-clause subtype evidence still fails closed.
      return hasSelfEmploymentCue
        || (!hasEmploymentCue && !hasRentalCue && !hasPensionCue);
    }
    if (subtype === 'rental') return /\b(?:rental income|rent from|tenant)\b/i.test(context);
    if (subtype === 'pension' || subtype === 'state_pension') {
      return /\b(?:pension|state pension)\b/i.test(context);
    }
    return true;
  }
  if (base === 'cash_savings') {
    return amountLike
      && /\b(?:cash|sav(?:e|ed|ing|ings)|deposit|credit union|rainy day)\b/i.test(context);
  }
  if (base === 'asset_value') {
    return amountLike && /\b(?:asset|investment|shares?|fund|worth|value)\b/i.test(context);
  }
  if (base === 'home_price') {
    if (!amountLike) return false;
    if (/\b(?:home|house|property|price|purchase|budget)\b/i.test(context)) return true;
    return hasCurrency
      && !/\b(?:earn|income|salary|wage|saving|cash|rent|mortgage|loan|debt|pension|retire|spend|expense|business)\b/i
        .test(context);
  }
  if (base === 'rent') {
    if (!amountLike) return false;
    if (/\b(?:rent|landlord|house share|tenan)\b/i.test(context)) return true;
    const preceding = transcript
      .slice(Math.max(0, occurrence.start - 140), occurrence.start)
      .toLowerCase();
    return /\b(?:pay|paying)\b/i.test(context)
      && /\b(?:month|monthly)\b/i.test(context)
      && /\b(?:rent|landlord|house share|tenan)\b/i.test(preceding)
      && !/\b(?:mortgage|loan|debt|pension)\b/i.test(context);
  }
  if (base === 'monthly_spending') {
    return amountLike && /\b(?:spend|spending|essential|outgoing|expense|costs? each month)\b/i.test(context);
  }
  if (base === 'annual_spending') {
    return amountLike
      && /\b(?:spend|spending|outgoing|expense)\b/i.test(context)
      && /\b(?:annual|year|yearly)\b/i.test(context);
  }
  if (base.endsWith('_rate') || base.endsWith('pension_rate')) {
    if (!hasPercent) return false;
    if (base === 'employee_pension_rate') {
      return /\b(?:i|we|employee|contribut(?:e|es|ed|ing|ion|ions)?|put in|pay in)\b/i
        .test(context);
    }
    if (base === 'employer_pension_rate') {
      if (/\b(?:employer|company|match)\b/i.test(context)) return true;
      return /\b(?:employer|company)\b[^.!?;]{0,80}\bmatch/i.test(transcript)
        && /\b(?:contribut(?:e|es|ed|ing|ion|ions)?|put in|pay in)\b[^.!?;]{0,40}(?:%|percent|per cent)/i
          .test(transcript);
    }
    return /\b(?:rate|interest|mortgage|loan|debt)\b/i.test(context)
      || (
        /\bat\s*$/i.test(before)
        && !/\b(?:pension|employer|employee|contribut|salary|income)\b/i.test(context)
      );
  }
  if (base.endsWith('_term_years')) return hasYears;
  if (base.endsWith('_term_months')) return hasMonths;
  if (base.endsWith('_balance')) {
    const domain = base.startsWith('mortgage') ? 'mortgage'
      : base.startsWith('loan') ? 'loan' : '(?:debt|loan|mortgage|liabilit)';
    return amountLike && !hasPercent && !hasYears && !hasMonths
      && new RegExp(`\\b(?:${domain}|balance|owe|outstanding|left)`, 'i').test(context);
  }
  if (base.endsWith('_payment') || base === 'debt_payment') {
    return amountLike
      && /\b(?:payment|repay|pay each month|monthly)\b/i.test(context);
  }
  if (base === 'pension_value') {
    if (!(amountLike && !hasPercent
      && /\b(?:pension|prsa|pot|fund|worth|value|built up)\b/i.test(context))) return false;
    const subtype = slot.split(':')[1];
    if (subtype === 'prsa') return /\bprsa\b/i.test(context);
    if (subtype === 'occupational') return /\b(?:occupational|workplace|work pension)\b/i.test(context);
    if (subtype === 'personal') return /\bpersonal pension\b/i.test(context);
    if (subtype === 'defined_benefit') return /\b(?:defined benefit|final salary)\b/i.test(context);
    return true;
  }
  if (base === 'retirement_income') {
    return amountLike
      && /\b(?:retire|retirement)\b/i.test(nearby)
      && /\b(?:income|target|today's money|a year|per year|yearly)\b/i.test(context)
      && !/\b(?:mortgage|loan|debt|balance|repay|salary|wage|before tax|earn|savings?|cash|rent|spend|expense)\b/i
        .test(context);
  }
  if (base === 'current_age') {
    return Number.isInteger(occurrence.value)
      && occurrence.value >= 16
      && occurrence.value <= 120
      && /\b(?:age|aged|years old|i'm|i am|we are)\b/i.test(context)
      && !/\b(?:retire|retirement)\b/i.test(context);
  }
  if (base === 'retirement_age') {
    return Number.isInteger(occurrence.value)
      && occurrence.value >= 18
      && occurrence.value <= 100
      && /\b(?:retire|retirement|stop working)\b/i.test(context);
  }
  if (base === 'dependant_age') {
    return Number.isInteger(occurrence.value)
      && occurrence.value >= 0
      && occurrence.value <= 100
      && /\b(?:child|children|kid|son|daughter|age|aged|years old|they're|they are)\b/i.test(context);
  }
  if (base === 'dependant_count') {
    return Number.isInteger(occurrence.value)
      && occurrence.value >= 0
      && occurrence.value <= 30
      && /\b(?:child|children|kid|dependant|dependent|son|daughter)\b/i.test(context);
  }
  if (base === 'property_value') {
    return amountLike && /\b(?:property|home|house|land|apartment|worth|value)\b/i.test(context);
  }
  if (base === 'business_value') {
    return amountLike && /\b(?:business|company|farm|worth|value)\b/i.test(context);
  }
  if (base.startsWith('college_')) {
    return amountLike && /\b(?:college|education|course|fees?|cost)\b/i.test(context);
  }
  if (base === 'state_pension_fraction' || base === 'state_pension_age') {
    const inRange = base === 'state_pension_fraction'
      ? occurrence.value >= 0 && occurrence.value <= 1
      : Number.isInteger(occurrence.value)
        && occurrence.value >= 60
        && occurrence.value <= 80;
    return inRange
      && /\b(?:state pension|contributory|entitlement|fraction)\b/i.test(context);
  }
  return false;
}

function numericOccurrenceHasStrongCue(occurrence, transcript) {
  const context = localNumberContext(transcript, occurrence);
  return /(?:%|\b(?:age|aged|years old|child|children|kid|dependant|dependent|earn|earns|earned|income|salary|wage|gross|net|before tax|cash|saving|savings|deposit|rent|landlord|spend|spending|expense|outgoing|mortgage|loan|debt|balance|outstanding|interest|rate|repayment|pension|prsa|retire|retirement|state pension|property|home|house|price|business|college|education|worth|value)\b)/i
    .test(context);
}

/**
 * `confirm_none` completes a required section, so an unsupported call can make
 * an analysis look ready using a categorical claim the client never made.
 * `complete_section` is even less specific and has no safe spoken evidence
 * contract in this lane, so it is rejected outright.
 *
 * Numeric values have the same boundary: every numeric leaf must occur in the
 * exact client transcript that caused this response and bind to that fact's
 * local semantic cue. Transcript-wide membership is insufficient because it
 * would allow income and savings figures in one sentence to be swapped. A
 * false negative costs one follow-up exchange; a misbound saved number could
 * silently affect an analysis.
 *
 * Keep these evidence checks at the untrusted live-tool boundary: the shared
 * mapper still needs to accept valid proposals from other lanes.
 */
export function partitionSupportedLiveFacts(facts, latestClientTranscript) {
  const submitted = Array.isArray(facts) ? facts : [];
  const transcript = String(latestClientTranscript || '')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const occurrences = numberOccurrences(transcript);
  const numericEvidence = submitted.flatMap((fact) =>
    numericLeaves(fact?.value).map((leaf) => ({
      fact,
      leaf,
      slot: numericSlot(fact, leaf)
    }))
  );
  const evidenceSlots = new Set(numericEvidence.map((item) => item.slot).filter(Boolean));
  const candidateValues = new Set(numericEvidence.map((item) => item.leaf.value));
  const transcriptValues = new Set(occurrences.map((item) => item.value));
  const soleFact = new Set(numericEvidence.map((item) => item.fact)).size === 1;
  const fallbackShape = numericEvidence.length > 0
    && numericEvidence.every((item) => item.slot)
    && evidenceSlots.size === 1
    && (
      candidateValues.size === 1
      || [...evidenceSlots][0] === 'dependant_age'
      || (soleFact && numericEvidence.every((item) =>
        ['min', 'max'].includes(String(item.leaf.path.at(-1) || '').toLowerCase())
      ))
    )
    && candidateValues.size === transcriptValues.size
    && [...candidateValues].every((value) => transcriptValues.has(value));
  const accepted = [];
  const rejected = [];

  for (const fact of submitted) {
    const factId = String(fact?.factId || '');
    if (requestsCompleteSection(fact?.value)) {
      rejected.push({ factId, reason: 'live_complete_section_unsupported' });
      continue;
    }
    const supported = !requestsConfirmedNone(fact?.value)
      || confirmedNoneIsSupported(factId, transcript);
    if (!supported) {
      rejected.push({ factId, reason: 'live_confirm_none_unsupported' });
      continue;
    }
    const unsupportedNumber = numericEvidence
      .filter((item) => item.fact === fact)
      .some(({ leaf, slot }) => {
        if (!slot) return true;
        const supportedOccurrences = occurrences.filter((occurrence) =>
          numericOccurrenceSupportsSlot(slot, occurrence, transcript)
        );
        const matchingOccurrence = supportedOccurrences.some((occurrence) =>
          Object.is(occurrence.value, leaf.value)
        );
        const cueFreeFallback = fallbackShape
          && occurrences.some((occurrence) =>
            Object.is(occurrence.value, leaf.value)
            && !numericOccurrenceHasStrongCue(occurrence, transcript)
          );
        if (!matchingOccurrence && !cueFreeFallback) return true;
        if (!matchingOccurrence) return false;
        const pathParts = leaf.path.map((part) => String(part).toLowerCase());
        const unordered = slot === 'dependant_age'
          || pathParts.includes('min')
          || pathParts.includes('max')
          || String(fact?.certainty || '').toLowerCase() === 'range';
        return !unordered
          && new Set(supportedOccurrences.map((occurrence) => occurrence.value)).size > 1;
      });
    if (unsupportedNumber) {
      rejected.push({ factId, reason: 'live_numeric_fact_unsupported' });
      continue;
    }
    accepted.push(fact);
  }

  return { accepted, rejected };
}

// Kept as a compatibility export for callers and tests that predate the
// numeric evidence gate. Its behaviour now includes every live evidence check.
export const partitionSupportedConfirmedNoneFacts = partitionSupportedLiveFacts;

function normalizedFacts(args) {
  const facts = Array.isArray(args?.facts) ? args.facts : [];
  if (!facts.length) {
    throw new ConsumerError(400, 'live_facts_required', 'save_facts needs at least one fact.');
  }
  return facts.slice(0, MAX_FACTS_PER_CALL).map((fact, index) => ({
    candidateId: `live-${index}`,
    operation: 'upsert',
    factId: String(fact?.factId || '').slice(0, 120),
    value: fact?.value,
    certainty: String(fact?.certainty || 'exact'),
    evidenceText: '',
    correctionTarget: ''
  }));
}

/**
 * Shape the model's own extraction into the candidate list the shared core
 * already consumes, then reuse applyPlannerCandidates wholesale.
 *
 * That reuse is the point: each candidate is proposed against a freshly
 * reloaded profile, so one bad fact cannot discard the rest of a good answer —
 * the behaviour the v2 lane spent several incidents arriving at.
 */
async function executeSaveFacts(args, deps) {
  const candidates = normalizedFacts(args);
  const guarded = partitionSupportedLiveFacts(candidates, deps.latestClientTranscript);
  let context = await deps.loadContext();
  const outcomes = [];

  // Focus can change inside one batched answer (for example, two goals plus
  // the client's chosen priority). Recompute the live module projection before
  // each fact, just as the in-memory replay does, instead of holding the
  // pre-batch focus config across every commit.
  for (const candidate of guarded.accepted) {
    const applied = await applyPlannerCandidates({
      env: deps.env,
      config: livePlanningConfig(deps.config, context.profile),
      context,
      extraction: {
        goalCandidates: [],
        semanticFacts: [candidate],
        positions: [],
        sectionCompletions: [],
        invalidCandidates: []
      },
      evidenceRef: deps.evidenceRef || null,
      leaseId: deps.leaseId || null,
      toolAttemptId: null,
      loadContext: deps.loadContext
    });
    outcomes.push(...applied.outcomes);
    context = applied.context;
  }

  const acceptedCandidateIds = new Set(
    outcomes.filter((item) => item.accepted).map((item) => item.candidateId)
  );
  const saved = outcomes.filter((item) => item.accepted).map((item) => item.factId);
  const rejected = [
    ...guarded.rejected,
    ...outcomes
      .filter((item) => !item.accepted && item.factId)
      .map((item) => ({ factId: item.factId, reason: item.errorCode }))
  ];

  return {
    ok: true,
    saved,
    rejected,
    // Anything that saved is available to later responses. The Durable Object
    // folds these into the global sourced-figure set, while its response-start
    // snapshot prevents this response from laundering a model-invented value.
    sourcedValues: guarded.accepted
      .filter((candidate) => acceptedCandidateIds.has(candidate.candidateId))
      .map((candidate) => candidate.value),
    context
  };
}

/* -------------------------------------------------------------- get_state */

/**
 * NO INTERNAL IDS LEAVE THIS FUNCTION.
 *
 * The model is told never to say a module id out loud; not returning one makes
 * that structurally impossible rather than a rule it has to remember. Module
 * selection is server-owned, so the model never needs to name one back to us.
 */
function liveStateProjection(context) {
  const state = context.state || {};
  const captured = capturedFactMemory(context);
  const capturedInstanceIds = new Set(captured.map((fact) => fact.instanceId));
  const unknown = Object.entries(
    context.profile?.assumptions?.values?.completionFacts?.unknownFactIds || {}
  )
    .filter(([, acknowledged]) => acknowledged === true)
    .map(([factId]) => factId);
  const unknownFactIds = new Set(unknown);

  const analyses = (state.recommendations || []).map((item) => ({
    description: item.description,
    status: item.status,
    // RECONCILED AGAINST WHAT IS ALREADY KNOWN, PER INSTANCE.
    //
    // A requirement is only satisfied by a fact captured for the SAME entity.
    // Dropping every requirement whose bare fact id happens to be captured
    // somewhere would let the client's pension value answer the partner's
    // missing pension value. Comparing instance ids -- both sides built from
    // resolveSemanticFact's identity -- keeps the two apart while still
    // removing the genuine duplicate that made a fact read as captured AND
    // still needed at the same time.
    stillNeeded: (item.requiredMissing || [])
      .map((missing) => ({
        instanceId: requirementInstanceId(missing),
        factId: missing.factId,
        whose: missing.entityLabel || '',
        why: missing.reason
      }))
      .filter((need) => !capturedInstanceIds.has(need.instanceId))
      // AND NOT SOMETHING THEY HAVE ALREADY SAID THEY CANNOT ANSWER.
      //
      // An acknowledged-unknown fact used to appear in `unknown` AND in this
      // list, so the same item was rendered as "do not ask for these again"
      // and "still needed" in one breath. The analysis genuinely cannot run
      // without it -- readyToConfirm below still counts it -- but presenting
      // it as an open question is asking the client to answer something they
      // have already told you they cannot.
      .filter((need) => !unknownFactIds.has(need.factId)),
    // OPTIONAL INPUTS, AND THEY STAY OPTIONAL. An assumption is a value the
    // deterministic engine already has an approved default for, so it never
    // appears in `missing` and never holds up `readyToConfirm` below. It is
    // surfaced only so the model can tell "must ask" from "may ask" -- and so
    // it stops asking for something the server is going to supply anyway.
    //
    // The label comes from planning_context, which reads the ENGINE assumption
    // registry. Looking these camelCase keys up in the semantic fact registry
    // returned null for every one of them, the renderer filtered the nulls
    // away, and the "never ask for these" line was therefore never emitted.
    mayAssume: (item.assumptionsUsed || [])
      .map((assumption) => ({
        label: assumption.label || null,
        why: assumption.reason
      }))
      .filter((assumption) => Boolean(assumption.label))
  }));

  const missing = [...new Set(analyses.flatMap((analysis) => analysis.stillNeeded.map((item) => item.factId)))];
  // Requirements the client has said they cannot answer. Removed from the ask
  // list above, but still counted against readiness: an analysis that needs a
  // figure nobody can supply is not ready, it is blocked, and offering to run
  // it would be offering a result its own inputs do not support.
  const blocked = [...new Set((state.recommendations || [])
    .flatMap((item) => (item.requiredMissing || []))
    .filter((need) => (
      unknownFactIds.has(need.factId)
      && !capturedInstanceIds.has(requirementInstanceId(need))
    ))
    .map((need) => need.factId))];

  assertNoCapturedRequirementContradiction(capturedInstanceIds, analyses);
  assertNoUnknownRequirementContradiction(unknownFactIds, analyses);

  return {
    ok: true,
    // Rendered phrases, values included -- never bare topic labels. See
    // capturedFactMemory for why the value has to travel with the label.
    //
    // Figures first. Whatever budget the per-turn item has, the entries that
    // stop a question being re-asked are the ones carrying a number; a presence
    // fact ("your PRSA — Pension positions") was never going to be asked for
    // twice, so it yields its place under truncation.
    captured: [
      ...captured.filter((fact) => fact.hasValue),
      ...captured.filter((fact) => !fact.hasValue)
    ].map((fact) => fact.phrase).slice(0, MAX_CAPTURED_FACTS),
    // `instanceId` is internal reconciliation scope and never crosses to the
    // model; `whose` is the consumer-safe way to say the same thing.
    analyses: analyses.slice(0, 3).map((analysis) => ({
      ...analysis,
      stillNeeded: analysis.stillNeeded.map(({ instanceId: _instanceId, ...need }) => need)
    })),
    missing: missing.slice(0, 20),
    // The fact ids a VALUE is known for. Same vocabulary as `missing`, and it
    // is what the deterministic duplicate-question guard compares an assistant
    // turn against without having to re-derive the profile. See question_guard.
    capturedFactIds: captured.filter((fact) => fact.hasValue).map((fact) => fact.factId).slice(0, 40),
    unknown: unknown.slice(0, 20),
    // Named separately so the model can say WHY a plan is stuck without
    // re-asking: "we cannot run this until there is a rough price" reads very
    // differently from asking for the price a third time.
    blocked: blocked.slice(0, 20),
    goalsAgreed: !state.requiresDecisionTopicQuestion
      && !state.requiresGoalPriorityQuestion
      && (state.moduleSlots || []).length > 0,
    // Blocked counts against readiness exactly as missing does. Dropping an
    // unanswerable requirement from the ask list must never be the thing that
    // makes a plan look runnable.
    readyToConfirm: analyses.length > 0 && missing.length === 0 && blocked.length === 0,
    deferredTopics: (state.deferredOrAdviserTopics || []).map((topic) => ({
      description: topic.description,
      reason: topic.reason
    }))
  };
}

/**
 * How many captured facts the model is shown. Bounded because this rides in the
 * per-turn item, but far above the number a real meeting produces -- the old
 * ceiling of sixteen (buildPlanningStateSlice's slice, sized for the v2 meeting
 * brief) silently dropped the earliest figures out of a long conversation,
 * which is exactly the memory this lane needed.
 */
const MAX_CAPTURED_FACTS = 32;

/** Values a client actually said. Anything structural renders as presence only. */
function renderableFactValue(factId, value, currency) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return formattedFactValue(factId, value, currency);
  if (typeof value === 'boolean') return formattedFactValue(factId, value, currency);
  // Through the shared formatter, never raw: a stored choice is a server-owned
  // token like `improve_pension`, and the projection must not be the thing that
  // teaches the model to say one out loud.
  if (typeof value === 'string') return formattedFactValue(factId, value, currency).slice(0, 60);
  if (typeof value === 'object' && !Array.isArray(value)) {
    // A money object, a {value: x} wrapper or a stated range formats cleanly.
    // A collection record (a pension, an asset, a property) does not: it would
    // render as "[object Object]", so it stays a presence fact with no figure.
    if (Number.isFinite(value.amount)) return formattedFactValue(factId, value, currency);
    if (Object.hasOwn(value, 'value')) return renderableFactValue(factId, value.value, currency);
    const range = value.range && typeof value.range === 'object' ? value.range : value;
    if (Object.hasOwn(range, 'min') && Object.hasOwn(range, 'max')) {
      return formattedFactValue(factId, value, currency);
    }
  }
  return '';
}

/**
 * THE DURABLE FACT MEMORY, AS THE MODEL SEES IT.
 *
 * Read straight from the profile rather than from state.facts: that array is
 * capped at sixteen for the v2 meeting brief, and a client who answers twenty
 * questions loses the first four figures they gave.
 *
 * Each entry carries its VALUE. The projection used to send bare topic labels
 * -- "Current pension value" with no number -- so the model knew the subject
 * had been covered but not what the answer was, and asking again was the only
 * move it had. That is the whole redundant-question bug.
 */
function capturedFactMemory(context) {
  const profile = context.profile || {};
  const currency = profile.preferences?.baseCurrency || 'EUR';
  const seen = new Set();
  const entries = [];
  for (const fact of buildConfirmedRealtimeFactSummary(profile)) {
    if (!fact?.factId) continue;
    const instanceId = fact.entityId ? `${fact.factId}:${fact.entityId}` : fact.factId;
    if (seen.has(instanceId)) continue;
    seen.add(instanceId);
    const whose = fact.fieldPath
      ? resolveSemanticFact({ fieldPath: fact.fieldPath, entityId: fact.entityId }, { profile }).entityLabel
      : '';
    const label = factLabel(fact.factId);
    const rendered = renderableFactValue(fact.factId, fact.value, currency);
    const qualifier = rendered && fact.certainty === 'approximate' ? 'approximately ' : '';
    const subject = whose ? `${whose} — ${label}` : label;
    entries.push({
      instanceId,
      factId: fact.factId,
      entityId: fact.entityId || null,
      certainty: fact.certainty,
      hasValue: Boolean(rendered),
      phrase: rendered ? `${subject}: ${qualifier}${rendered}` : subject
    });
  }
  return entries;
}

/** The instance a requirement is asking about, in the captured set's terms. */
function requirementInstanceId(missing) {
  if (typeof missing?.factInstanceId === 'string' && missing.factInstanceId) return missing.factInstanceId;
  return missing?.entityId ? `${missing.factId}:${missing.entityId}` : missing?.factId;
}

/**
 * A contradictory projection must not reach the model.
 *
 * "You told me X" and "I still need X" in the same breath is the state that
 * produces a re-asked question, and it is a server bug every time -- the model
 * has no way to resolve it. Fail loudly here rather than let the meeting do it
 * politely and wrongly.
 *
 * The reconciliation filters above are what make this unreachable today. That
 * is deliberate: this exists so that deleting one of those filters fails a test
 * instead of quietly costing another persona two points of question relevance.
 */
function assertNoCapturedRequirementContradiction(capturedInstanceIds, analyses) {
  for (const analysis of analyses) {
    for (const need of analysis.stillNeeded || []) {
      if (!capturedInstanceIds.has(need.instanceId)) continue;
      throw new ConsumerError(
        500,
        'live_state_contradiction',
        `A requirement is both captured and still needed for the same instance (${need.factId}).`
      );
    }
  }
}

/**
 * The other way a state note can contradict itself: telling the model never to
 * ask for something again and listing it as outstanding in the same breath.
 */
function assertNoUnknownRequirementContradiction(unknownFactIds, analyses) {
  for (const analysis of analyses) {
    for (const need of analysis.stillNeeded || []) {
      if (!unknownFactIds.has(need.factId)) continue;
      throw new ConsumerError(
        500,
        'live_state_contradiction',
        `A requirement the client cannot supply is still listed as an open question (${need.factId}).`
      );
    }
  }
}

/* -------------------------------------------------------- confirm_and_run */

/**
 * THE ONE HARD GATE IN THE LANE.
 *
 * Everything else here is permissive by design; this is not. The model is an
 * untrusted caller: it does not get to assert that the client agreed. The
 * server reads the client's actual last words and classifies them with the
 * existing deterministic classifier, and a plan runs only against the exact
 * profile revision it was prepared for.
 */
async function executeConfirmAndRun(_args, deps) {
  const transcript = String(deps.latestClientTranscript || '');
  if (classifySpokenPlanConfirmation(transcript) !== 'affirmed') {
    return {
      ok: false,
      code: 'confirmation_required',
      message: 'The client has not clearly agreed yet. Ask a plain yes/no question and wait for their answer.'
    };
  }

  const context = await deps.loadContext();
  const config = livePlanningConfig(deps.config, context.profile);
  const expectedRevision = Number(context.sessionRow.current_profile_revision);

  const prepared = await prepareRealtimeVoiceAnalysisPlan({
    env: deps.env,
    config,
    sessionRow: context.sessionRow,
    profile: context.profile,
    leaseId: deps.leaseId || null,
    idempotencyKey: `live-confirm-${context.sessionRow.id}-${expectedRevision}`
  });

  // Records the exact set the client just agreed to, then confirms the
  // revision in place (D-01). Only that set may execute.
  await confirmPlanSelection({
    env: deps.env,
    config,
    sessionRow: context.sessionRow,
    profile: context.profile,
    channel: 'live'
  });

  const executed = await confirmAndRunRealtimeAnalysisPlan({
    env: deps.env,
    config,
    sessionId: context.sessionRow.id,
    planId: prepared.row.id,
    planNonce: prepared.planNonce,
    expectedRevision
  });

  return {
    ok: executed.analysisPlan?.status === 'complete',
    status: executed.analysisPlan?.status || 'unknown',
    // Deterministic, server-owned copy. The model must speak it as given and
    // must never recompute or embellish anything in it.
    speakableText: executed.result?.speakableText || '',
    completedCount: (executed.result?.completedModuleIds || []).length,
    navigationTarget: '/plan/#results',
    result: executed.result || null
  };
}

/* ------------------------------------------------------------- dispatcher */

export function assertLiveToolName(name) {
  if (!LIVE_TOOL_NAMES.includes(name)) {
    throw new ConsumerError(400, 'live_tool_unknown', 'That tool is not available in this meeting.');
  }
  return name;
}

/**
 * Run one tool call.
 *
 * A rejection is a normal outcome, not an error: the conversation carries on
 * regardless. Only a genuinely broken call throws, and the caller turns that
 * into an ordinary tool result too — a tool failure must never stall speech.
 */
export async function executeLiveTool(name, args, deps) {
  assertLiveToolName(name);
  if (name === 'save_facts') return executeSaveFacts(args, deps);
  if (name === 'get_state') return liveStateProjection(await deps.loadContext());
  return executeConfirmAndRun(args, deps);
}

export { liveStateProjection };
