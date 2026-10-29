/**
 * WHERE A FIGURE COMES FROM, IN WORDS.
 *
 * Every fact the plan produces carries a `basis` (docs/story-facts.md): what kind
 * of figure it is and the evidence for it. This turns that basis into the words
 * the story screen shows on hover or tap. The wording is written here, from the
 * basis alone: the analyst writes none of it and cannot change it.
 *
 *   stated       you told us (with the form question it answers)
 *   calculated   worked out by the app (naming the module or engine)
 *   assumption   a Planeir assumption (with its plain basis)
 *   official     an official rate, band or limit (with its source and the day it was checked)
 *
 * Pure: no DOM, no clock. A basis the screen does not understand is refused by
 * name rather than guessed at.
 */

export const PLAN_STORY_BASIS_KINDS = Object.freeze(['stated', 'calculated', 'assumption', 'official']);

/** What the screen calls each kind, and the cue (a word, never only a colour) it carries. */
const PLAN_STORY_BASIS_LABELS = Object.freeze({
  stated: 'You told us',
  calculated: 'Worked out by the app',
  assumption: 'A Planeir assumption',
  official: 'An official figure'
});

/** The engines and parts of the plan a calculated figure can name, in the words the person would use. */
const ENGINE_NAMES = Object.freeze({
  personal_balance_sheet: 'the balance sheet',
  resolveLiquidityReserveForPlan: 'the cash reserve',
  household_cash_flow_math: 'household cash flow',
  protection_gap_math: 'the protection gap',
  mortgage_math: 'the mortgage and loan calculations',
  pension_math: 'the pension projection',
  college_funding_math: 'college funding',
  future_cost_fund_math: 'the future cost fund',
  net_retirement_math: 'retirement income',
  resource_ledger: 'the plan’s resource ledger',
  irish_tax_engine: 'the Irish tax calculations',
  application_to_profile: 'the answers you gave on the form',
  story_facts: 'the plan’s own results'
});

const isoDate = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);

/** "27 October 2026" from an ISO date, with no time zone in the way. */
export function formatBasisDate(value) {
  const iso = isoDate(value);
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-IE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T00:00:00Z`));
}

const sentence = (text) => {
  const trimmed = String(text ?? '').trim();
  return trimmed && !/[.!?]$/.test(trimmed) ? `${trimmed}.` : trimmed;
};

function describeStated(basis) {
  const questions = (basis.formQuestions || []).map((question) => (question.label
    ? { label: question.label, path: question.path }
    : { label: null, path: question.path, reason: question.reason || 'The wording of this question was not recorded.' }));
  const lines = [];
  if (questions.length) {
    lines.push(questions.length === 1 ? 'You told us this on the form, in answer to:' : 'You told us this on the form, in answer to these questions:');
  } else {
    lines.push(sentence(basis.reason?.message || 'This was stated in the plan’s inputs. No form question was recorded for it.'));
  }
  const confirmed = formatBasisDate(basis.form?.confirmedAt);
  if (confirmed) lines.push(`Confirmed on ${confirmed}.`);
  return { questions, lines };
}

function describeCalculated(basis, { moduleTitle }) {
  const engine = basis.engine;
  const where = moduleTitle || ENGINE_NAMES[engine] || (engine ? engine.replaceAll('_', ' ') : 'the plan');
  const lines = [moduleTitle
    ? `Worked out by the app, in the ${moduleTitle} module.`
    : engine === 'application_to_profile' ? 'Worked out by the app from the answers you gave on the form.'
      : `Worked out by the app, in ${where}.`];
  if (basis.description) lines.push(sentence(basis.description));
  return { lines };
}

function describeAssumption(basis) {
  const lines = ['A Planeir assumption, not something you told us.'];
  if (basis.description) lines.push(sentence(basis.description));
  if (basis.disclosure) lines.push(sentence(basis.disclosure));
  return { lines };
}

function describeOfficial(basis) {
  const lines = ['An official figure from the register of Irish rates, bands and limits.'];
  const checked = formatBasisDate(basis.checkedOn);
  if (checked) lines.push(`Checked on ${checked}.`);
  const sources = basis.source?.title || basis.source?.url
    ? [{ title: basis.source.title || basis.source.url, url: basis.source.url || null }] : [];
  return { lines, sources };
}

/**
 * The words for one basis. `moduleTitle` is the module the figure's source names, when it has one.
 * Returns `{ kind, label, lines, questions?, sources?, evidence: [...] }`; every `evidence` entry
 * is described the same way, so a mixed calculation shows what it is made of.
 */
export function describeBasis(basis, { moduleTitle = null } = {}) {
  if (!basis || typeof basis !== 'object' || !PLAN_STORY_BASIS_KINDS.includes(basis.kind)) {
    throw new Error(`A figure's basis must be one of: ${PLAN_STORY_BASIS_KINDS.join(', ')}.`);
  }
  const part = basis.kind === 'stated' ? describeStated(basis)
    : basis.kind === 'calculated' ? describeCalculated(basis, { moduleTitle })
      : basis.kind === 'assumption' ? describeAssumption(basis) : describeOfficial(basis);
  return {
    kind: basis.kind,
    label: PLAN_STORY_BASIS_LABELS[basis.kind],
    lines: part.lines,
    ...(part.questions?.length ? { questions: part.questions } : {}),
    ...(part.sources?.length ? { sources: part.sources } : {}),
    evidence: (Array.isArray(basis.evidence) ? basis.evidence : []).map((entry) => describeBasis(entry))
  };
}
