import { consumerLanguageForModule } from '../../../js/planning/module_offers.js';

export const REALTIME_MEETING_PHASES = Object.freeze([
  'discovery',
  'intake',
  'awaiting_voice_confirmation',
  'generating_modules',
  'closing',
  'completed'
]);

export const REALTIME_COMPLETION_OUTRO = 'Thanks very much for your time today. Your analyses are ready, and I’m taking you to them now.';

function normalizedConfirmationText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const AFFIRMATIVE_PHRASES = new Set([
  'yes', 'yes please', 'yep', 'yeah', 'correct', 'confirmed', 'i confirm',
  'that is correct', 'thats correct', 'that sounds good', 'sounds good',
  'go ahead', 'please go ahead', 'proceed', 'please proceed', 'do it',
  'generate the modules', 'please generate the modules', 'run the modules',
  'generate the analyses', 'please generate the analyses', 'run the analyses',
  'create the modules', 'okay go ahead', 'ok go ahead', 'im happy with that',
  'okay', 'ok'
]);

const AFFIRMATIVE_TOKENS = new Set([
  'yes', 'yep', 'yeah', 'okay', 'ok', 'please', 'i', 'ive', 'have', 'confirm',
  'confirmed', 'that', 'thats', 'this', 'is', 'correct', 'right', 'sounds', 'sound', 'good', 'all',
  'go', 'ahead', 'proceed', 'do', 'it', 'generate', 'create', 'run', 'the',
  'modules', 'analysis', 'analyses', 'now', 'so', 'lets', 'just', 'move', 'on', 'im', 'happy', 'with',
  'and', 'absolutely', 'sure'
]);
const AFFIRMATIVE_SIGNAL = /\b(?:yes|yep|yeah|confirm|confirmed|correct|right|sounds good|go ahead|proceed|generate|create|run|do it|okay|ok|absolutely|sure)\b/;

const NEGATIVE_OR_CORRECTION = /\b(?:no|nope|not|dont|do not|wait|hold|stop|change|correct that|correction|actually|wrong|before|but|except|instead|question)\b/;

export function classifySpokenPlanConfirmation(value) {
  const text = normalizedConfirmationText(value);
  if (!text || text.split(' ').length > 12) return 'ambiguous';
  if (NEGATIVE_OR_CORRECTION.test(text)) return text === 'no' || text === 'nope' ? 'rejected' : 'ambiguous';
  if (AFFIRMATIVE_PHRASES.has(text)) return 'affirmed';
  const tokens = text.split(' ');
  return AFFIRMATIVE_SIGNAL.test(text) && tokens.every((token) => AFFIRMATIVE_TOKENS.has(token))
    ? 'affirmed'
    : 'ambiguous';
}

function assumptionLabel(key) {
  return String(key || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
}

function assumptionValue(key, value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (/rate/i.test(key) && Math.abs(value) <= 1) return `${Number((value * 100).toFixed(2))}%`;
    return new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(value);
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'boolean') return value ? 'included' : 'excluded';
  return 'not specified';
}

export function buildVoiceConfirmationSummary({
  analyses = [],
  statePensionRule = null,
  understood = []
} = {}) {
  const selectedAnalyses = analyses.slice(0, 3);
  const confirmationPhrases = selectedAnalyses.map((item) => (
    consumerLanguageForModule(item?.moduleId)?.confirmationDescription || ''
  ));
  const everyAnalysisHasClientLanguage = selectedAnalyses.length > 0
    && confirmationPhrases.every(Boolean);
  const analysisText = everyAnalysisHasClientLanguage
    ? confirmationPhrases.length === 1
      ? confirmationPhrases[0]
      : confirmationPhrases.length === 2
        ? `${confirmationPhrases[0]} and ${confirmationPhrases[1]}`
        : `${confirmationPhrases.slice(0, -1).join(', ')}, and ${confirmationPhrases.at(-1) || ''}`
    : 'prepare the selected analyses';
  const materialAssumptions = analyses
    .flatMap((analysis) => Array.isArray(analysis?.assumptions) ? analysis.assumptions : [])
    .filter((assumption) => assumption?.key && assumption.key !== 'statePensionContributory')
    .filter((assumption, index, items) => items.findIndex((item) => item.key === assumption.key) === index)
    .slice(0, 6)
    .map((assumption) => `${assumptionLabel(assumption.key)} ${assumptionValue(assumption.key, assumption.value)}`);
  const assumptionsText = materialAssumptions.length
    ? ` The other material assumptions are ${materialAssumptions.join(', ')}.`
    : '';
  const memberAssumptions = Array.isArray(statePensionRule?.perPersonAssumptions)
    ? statePensionRule.perPersonAssumptions
    : [];
  const statedFractions = (Array.isArray(understood) ? understood : [])
    .filter((item) => item?.factId === 'state_pension_fraction' && Number.isFinite(Number(item.value)))
    .map((item) => `${Math.round(Number(item.value) * 100)}%`);
  const fractionText = memberAssumptions.length
    ? ` The per-person assumptions are ${memberAssumptions.map((item) => `${item.label || 'a household member'} at ${Math.round(Number(item.fraction) * 100)}% from age ${Number(item.startAge) || 66}`).join(' and ')}.`
    : statedFractions.length
    ? ` Any included person without a stated fraction defaults to 100%; the stated per-person ${statedFractions.length === 1 ? 'fraction is' : 'fractions are'} ${statedFractions.join(' and ')}.`
    : ' The fraction defaults to 100% for each included person unless you change it.';
  const pensionText = statePensionRule
    ? ` Where the Irish State Pension is included, I’ll use the editable maximum-rate assumption of €15,563.60 gross a year, effective January 2026, with a default start age of 66.${fractionText} I’ll apply each fraction before escalating it by 2% a year. Actual entitlement depends on each person’s PRSI record.`
    : '';
  return `I’m ready to ${analysisText} using the assumptions shown.${assumptionsText}${pensionText} Does that all sound correct, and would you like me to run those analyses now?`;
}
