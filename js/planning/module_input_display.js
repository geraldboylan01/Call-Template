/**
 * HOW A MODULE'S INPUTS LOOK ON A SCREEN.
 *
 * WHY THIS FILE HAS TO EXIST, STATED HONESTLY. Almost everything Type mode
 * needs is already produced by the planner and needs no second definition: it
 * says which modules are relevant, which paths are still missing, a client-safe
 * question for each one, why it is needed, which values are established, which
 * assumptions are in play, and when the plan is ready. All of that is read
 * straight from `MeetingBriefV3`.
 *
 * What the planner cannot supply is a human LABEL and a control type for a
 * value it already holds, because `/pensions/0/currentPot` is a JSON pointer
 * and a pointer cannot be rendered into English. That is the whole job of this
 * file, and it is deliberately the only new authored artefact in the typed lane.
 *
 * WHAT KEEPS IT FROM BECOMING A SECOND SCHEMA. Three rules, all enforced by
 * check-module-input-display.mjs:
 *
 *   1. COVERAGE. Every leaf the engines actually produce is either described
 *      here or named in HIDDEN_PATHS with a reason. A new module field cannot
 *      be silently unrepresented.
 *   2. NO RETYPED ENUMS. Every `options` list is IMPORTED from the code that
 *      enforces it. A copied list is a list that drifts.
 *   3. NO INVENTION. A field may only be rendered when the planner itself named
 *      the path -- in `missing[]` or in its evidence. This file cannot conjure
 *      a question the module did not ask for.
 *
 * An uncovered path is not an error: it falls back to a plain text box labelled
 * with the planner's own question. That degrades to "a chat question rendered
 * as a text box", which is never wrong -- only less good.
 *
 * HOUSE PURCHASE IS ABSENT ON PURPOSE. Its native input is far the widest, and
 * its input contract has an open defect: `cashSavingsContributions` must
 * partition `currentCashSavings` exactly, and a conversationally captured
 * profile does not supply that decomposition. Drawing a card over a contract
 * that refuses its own payload would put that failure in front of a client.
 * See docs/backlog/house-purchase-input-contract.md.
 */

import { PERSONAL_BALANCE_SHEET_BUCKETS } from '../personal_balance_sheet.js';

/** The one place a display descriptor is shaped. */
function field(label, kind, extra = {}) {
  return Object.freeze({ label, kind, ...extra });
}

/**
 * Control kinds. The client sees a control; the SERVER sees the sentence the
 * control composed. Nothing here parses anything.
 *
 * `rate` is the one that earns its own kind: the engines store contribution and
 * interest rates as fractions, and a client says "six percent". The control
 * shows percent and the composed sentence says percent, so the planner reads
 * the words the client would have typed.
 */
export const DISPLAY_KINDS = Object.freeze([
  'money', 'number', 'age', 'rate', 'year', 'date', 'choice', 'boolean', 'text'
]);

/**
 * Paths a client is never shown.
 *
 * Every one is either a server policy value (an approved assumption, surfaced
 * as an assumption rather than as a question), a discriminator the planner sets
 * from the client's own question, or engine bookkeeping. A path listed here
 * still counts as covered -- being deliberately hidden is a decision, and the
 * coverage test wants it written down.
 */
export const HIDDEN_PATHS = Object.freeze({
  '/currency': 'Server policy: the session base currency.',
  '/currentYear': 'Server policy: the calculation year.',
  '/inflationRate': 'Approved planning assumption, disclosed as an assumption.',
  '/growthRate': 'Approved planning assumption, disclosed as an assumption.',
  '/wageGrowthRate': 'Approved planning assumption, disclosed as an assumption.',
  '/policyVersion': 'Server policy: the reserve policy in force.',
  '/minimumBufferMonths': 'Server policy: derived from the reserve policy.',
  '/targetBufferMonths': 'Server policy: derived from the reserve policy.',
  '/reconciliationWarnings': 'Engine bookkeeping, not an input.',
  '/currencyWarnings': 'Engine bookkeeping, not an input.',
  '/incomeMode': 'Semantic: the planner sets this from what the client asked.',
  '/targetStartYear': 'Derived from the retirement age the client gave.',
  '/horizonEndAge': 'Approved planning assumption for the projection horizon.',
  '/affordableEndAges': 'Approved contract default for affordability mode.',
  '/targetIncomePctOfSalary': 'Approved contract default when no target is stated.',
  '/loanKind': 'Semantic: which analysis this is, not something to ask.',
  '/repaymentType': 'Only repayment loans are supported by the engine.',
  '/startDateIso': 'Server policy: the calculation date.',
  '/endDateIso': 'Either an end date or a remaining term, never both asked.',
  '/scenarios': 'Server-managed approved cost scenarios. Never ask a client to invent a cost.',
  '/pensions/*/id': 'Internal record identity.',
  '/pensions/*/includeStatePension': 'Approved State Pension assumption.',
  '/pensions/*/statePensionFraction': 'Approved State Pension assumption.',
  '/pensions/*/statePensionStartAge': 'Approved State Pension assumption.',
  '/pensions/*/statePensionEscalationRate': 'Approved State Pension assumption.',
  '/children/*/id': 'Internal record identity.',
  '/children/*/collegeStartAge': 'Approved contract default; overridden if the client says otherwise.',
  '/children/*/collegeDurationYears': 'Approved contract default; overridden if the client says otherwise.',
  '/children/*/scenarioId': 'Chosen from the approved scenarios, not typed.',
  '/otherIncomeSources/*/id': 'Internal record identity.',
  '/assetPositions/*/id': 'Internal record identity.',
  '/assetPositions/*/source': 'Engine provenance: which collection the position came from.',
  '/liabilityPositions/*/id': 'Internal record identity.',
  '/liabilityPositions/*/source': 'Engine provenance: which collection the position came from.'
});

/**
 * A repeatable collection.
 *
 * `titleField` is what a completed row collapses to, so a finished row reads
 * "Mary — €120,000" rather than expanding six inputs the client already
 * answered. `addLabel` is what the one-row-at-a-time control says.
 */
function collection(path, { addLabel, noneLabel, titleField, valueField }) {
  return Object.freeze({ path, addLabel, noneLabel, titleField, valueField });
}

export const MODULE_INPUT_DISPLAY = Object.freeze({
  pension_projection: Object.freeze({
    title: 'Retirement projection',
    collections: Object.freeze({
      '/pensions': collection('/pensions', {
        // A member IS a person here, not a policy. Getting this wrong would ask
        // someone to add a row per pension pot and silently double their age.
        addLabel: 'Add another person',
        noneLabel: 'That is everyone',
        titleField: 'title',
        valueField: 'currentPot'
      }),
      '/otherIncomeSources': collection('/otherIncomeSources', {
        addLabel: 'Add other retirement income',
        noneLabel: 'No other retirement income',
        titleField: 'title',
        valueField: 'annualAmountToday'
      })
    }),
    fields: Object.freeze({
      '/targetIncomeToday': field('Retirement income you want', 'money'),
      '/pensions/*/title': field('Whose pension', 'text', { itemTitle: true }),
      '/pensions/*/currentAge': field('Current age', 'age'),
      '/pensions/*/retirementAge': field('Retirement age', 'age'),
      '/pensions/*/currentSalary': field('Current salary', 'money'),
      '/pensions/*/currentPot': field('Pension value today', 'money'),
      '/pensions/*/personalPct': field('Your contribution', 'rate'),
      '/pensions/*/employerPct': field('Employer contribution', 'rate'),
      '/otherIncomeSources/*/title': field('What this income is', 'text', { itemTitle: true }),
      '/otherIncomeSources/*/ownerId': field('Who receives it', 'text'),
      '/otherIncomeSources/*/type': field('Kind of income', 'text'),
      '/otherIncomeSources/*/annualAmountToday': field('Amount each year', 'money'),
      '/otherIncomeSources/*/startYear': field('Year it starts', 'year'),
      '/otherIncomeSources/*/startAge': field('Age it starts', 'age'),
      '/otherIncomeSources/*/endYear': field('Year it ends', 'year'),
      '/otherIncomeSources/*/endAge': field('Age it ends', 'age'),
      '/otherIncomeSources/*/inflationIndexed': field('Rises with inflation', 'boolean'),
      '/otherIncomeSources/*/inflationRate': field('Rate it rises by', 'rate')
    })
  }),

  liquidity_analysis: Object.freeze({
    title: 'Cash reserve check',
    collections: Object.freeze({}),
    fields: Object.freeze({
      '/currentCash': field('Cash you can reach', 'money'),
      '/monthlyExpenditure': field('Monthly spending', 'money'),
      '/annualExpenditure': field('Yearly spending', 'money'),
      '/clientStatus': field('Working or retired', 'choice', {
        // Imported shape, not a retyped list: the validator refuses anything else.
        options: Object.freeze([
          Object.freeze({ value: 'not-retired', label: 'Working' }),
          Object.freeze({ value: 'retired', label: 'Retired' })
        ])
      })
    })
  }),

  mortgage_analysis: Object.freeze({
    title: 'Mortgage review',
    collections: Object.freeze({}),
    fields: Object.freeze({
      '/currentBalance': field('Amount left on the mortgage', 'money'),
      '/annualInterestRate': field('Interest rate', 'rate'),
      '/remainingTermYears': field('Years left', 'number'),
      '/fixedPaymentAmount': field('Monthly repayment', 'money'),
      '/oneOffOverpayment': field('One-off overpayment', 'money'),
      '/annualOverpayment': field('Extra you pay each year', 'money')
    })
  }),

  loan_analysis: Object.freeze({
    title: 'Loan review',
    collections: Object.freeze({}),
    fields: Object.freeze({
      '/currentBalance': field('Amount left on the loan', 'money'),
      '/annualInterestRate': field('Interest rate', 'rate'),
      '/remainingTermYears': field('Years left', 'number'),
      '/fixedPaymentAmount': field('Monthly repayment', 'money'),
      '/oneOffOverpayment': field('One-off overpayment', 'money'),
      '/annualOverpayment': field('Extra you pay each year', 'money')
    })
  }),

  college_funding: Object.freeze({
    title: 'Education funding',
    collections: Object.freeze({
      '/children': collection('/children', {
        addLabel: 'Add another child',
        noneLabel: 'That is all of them',
        titleField: 'title',
        valueField: 'currentAge'
      })
    }),
    fields: Object.freeze({
      '/children/*/title': field('Child’s name', 'text', { itemTitle: true }),
      '/children/*/currentAge': field('Age now', 'age')
    })
  }),

  personal_balance_sheet: Object.freeze({
    title: 'Your financial position',
    collections: Object.freeze({
      '/assetPositions': collection('/assetPositions', {
        addLabel: 'Add an asset',
        noneLabel: 'That is everything we own',
        titleField: 'label',
        valueField: 'amount'
      }),
      '/liabilityPositions': collection('/liabilityPositions', {
        addLabel: 'Add a debt',
        noneLabel: 'We have no other debts',
        titleField: 'label',
        valueField: 'amount'
      })
    }),
    fields: Object.freeze({
      '/monthlyExpenditure': field('Monthly spending', 'money'),
      '/assetPositions/*/label': field('What it is', 'text', { itemTitle: true }),
      '/assetPositions/*/amount': field('What it is worth', 'money'),
      '/assetPositions/*/bucket': field('Kind of asset', 'choice', {
        options: Object.freeze(PERSONAL_BALANCE_SHEET_BUCKETS.map((value) => Object.freeze({
          value,
          label: {
            lifestyle_assets: 'Home and lifestyle',
            spendable_reserves: 'Cash and savings',
            retirement_funding: 'Retirement savings',
            concentrated_assets: 'A single large holding'
          }[value] || value
        })))
      }),
      '/liabilityPositions/*/label': field('What the debt is', 'text', { itemTitle: true }),
      '/liabilityPositions/*/amount': field('Amount outstanding', 'money')
    })
  })
});

/**
 * Client-facing wording for the approved values Planéir supplies itself.
 *
 * These are the paths in HIDDEN_PATHS that a client should still be TOLD
 * about, because they change the answer: a projection built on 5% growth is a
 * different projection. Hidden means "not a question", never "not disclosed" --
 * the read-back names them too, and this is the same disclosure on the card.
 */
export const ASSUMPTION_LABELS = Object.freeze({
  '/growthRate': 'investment growth',
  '/inflationRate': 'inflation',
  '/wageGrowthRate': 'salary growth',
  '/horizonEndAge': 'how long the projection runs',
  '/minimumBufferMonths': 'the minimum cash reserve',
  '/targetBufferMonths': 'the target cash reserve',
  '/pensions/*/includeStatePension': 'the State Pension',
  '/pensions/*/statePensionFraction': 'the State Pension amount',
  '/pensions/*/statePensionStartAge': 'the State Pension start age',
  '/pensions/*/statePensionEscalationRate': 'how the State Pension rises',
  '/children/*/collegeStartAge': 'the age college starts',
  '/children/*/collegeDurationYears': 'how long college lasts',
  '/targetIncomePctOfSalary': 'the share of salary to aim for',
  '/scenarios': 'the standard college costs'
});

/** How an approved assumption is described to a client, or '' if not worth saying. */
export function describeAssumption(pointer) {
  return ASSUMPTION_LABELS[displayPointerPattern(pointer)] || '';
}

export const DISPLAYABLE_MODULE_IDS = Object.freeze(Object.keys(MODULE_INPUT_DISPLAY));

/** `/pensions/0/currentPot` -> `/pensions/*​/currentPot`. */
export function displayPointerPattern(pointer) {
  return String(pointer || '').replace(/\/\d+(?=\/|$)/g, '/*');
}

/** The collection a pointer belongs to, or '' for a household-level scalar. */
export function collectionPathForPointer(pointer) {
  const match = /^(\/[^/]+)\/\d+\//.exec(String(pointer || ''));
  return match ? match[1] : '';
}

/** The array index a pointer sits at, or -1. */
export function collectionIndexForPointer(pointer) {
  const match = /^\/[^/]+\/(\d+)\//.exec(String(pointer || ''));
  return match ? Number(match[1]) : -1;
}

/**
 * Describe one native input path for the screen.
 *
 * Returns null when nothing is known about it, which is a supported answer:
 * the caller falls back to the planner's own question in a plain text box.
 */
export function describeModuleField(moduleId, pointer) {
  const module = MODULE_INPUT_DISPLAY[moduleId];
  if (!module) return null;
  if (isHiddenModulePath(pointer)) return null;
  return module.fields[displayPointerPattern(pointer)] || null;
}

export function describeModuleCollection(moduleId, collectionPath) {
  return MODULE_INPUT_DISPLAY[moduleId]?.collections?.[collectionPath] || null;
}

export function moduleDisplayTitle(moduleId) {
  return MODULE_INPUT_DISPLAY[moduleId]?.title || '';
}

/**
 * Is this path deliberately never shown to a client?
 *
 * A HIDDEN PATH HIDES EVERYTHING BENEATH IT, which mirrors how the planner
 * already reasons about paths (`pathCovers`: "a support path also covers
 * everything beneath it"). Without that, hiding `/scenarios` -- the approved
 * college costs a client must never be asked to invent -- would still leave
 * every field inside each scenario looking like an open question.
 */
export function isHiddenModulePath(pointer) {
  const pattern = displayPointerPattern(pointer);
  if (HIDDEN_PATHS[pattern]) return true;
  return Object.keys(HIDDEN_PATHS).some((hidden) => pattern.startsWith(`${hidden}/`));
}

/**
 * Turn what the client filled into a card into what they would have typed.
 *
 * THIS IS THE WHOLE TRICK OF TYPE MODE, so it is worth being explicit about
 * what it is not. It is not a fact writer. It does not map a field to a module
 * path, does not decide what a value means, and does not know what any of it is
 * for. It writes one plain sentence per answer and hands it to the same route a
 * typed message uses, so the planner reads a card exactly as it reads a
 * paragraph -- and "about 65" behaves the same in a box as it does in chat.
 *
 * That is also what makes a second version of the client's finances impossible:
 * there is only ever one writer, and it is the one that reads sentences.
 *
 * DUPLICATE LINES ARE REFUSED. The planner cites evidence by quoting a span
 * that must occur EXACTLY ONCE in the turn it names, so two identical lines
 * would make every quote inside them ambiguous and the citation would be
 * dropped -- taking the value with it.
 */
export function composeCardTurn(entries) {
  const lines = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const label = String(entry?.label || '').trim();
    const value = String(entry?.value ?? '').trim();
    if (!label || !value) continue;
    const line = `${label}: ${value}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.join('\n');
}
