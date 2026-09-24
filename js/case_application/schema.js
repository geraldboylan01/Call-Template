/**
 * THE APPLICATION, DESCRIBED ONCE.
 *
 * The /apply/ page renders its form from this file, the Worker validates a
 * submission against it, and the write-up and the public case both read their
 * labels from it. One description means a question cannot say one thing on the
 * page and another in Gerry's admin view.
 *
 * The stored shape is deliberately plain and forgiving. It is NOT the planner's
 * HouseholdProfile: that normalizer is strict about ids and owners, and a
 * public form must never be refused over a detail. `profilePath` on a field is
 * a hint for a later converter, nothing more.
 *
 * Copy rules: plain, factual sentences. No em dashes. Nothing required except
 * the question, which the page enforces alongside the contact details.
 */

import { parseMoney, parsePercent, parseWhole, parseYears } from './format.js';

export const APPLICATION_SCHEMA = 'planeir.application.v1';
export const APPLICATION_SCHEMA_VERSION = 1;

export const MAX_QUESTION_LENGTH = 2_000;
export const MAX_LONG_TEXT_LENGTH = 2_000;

/**
 * What a person can ask for help with. The goal types are the planner's own
 * vocabulary (js/planning/goal_catalogue.js), kept here so a later converter
 * does not have to guess what "My mortgage" meant.
 */
export const TOPICS = Object.freeze([
  { id: 'retirement', label: 'Retirement and pensions', short: 'retirement', goalTypes: ['retire', 'improve_pension'] },
  { id: 'mortgage', label: 'My mortgage', short: 'the mortgage', goalTypes: ['optimise_mortgage'] },
  { id: 'buying', label: 'Buying a home', short: 'buying a home', goalTypes: ['buy_home'] },
  { id: 'education', label: 'Children’s education', short: 'college costs', goalTypes: ['fund_education'] },
  { id: 'loans', label: 'Loans and credit cards', short: 'loans', goalTypes: ['manage_loan'] },
  { id: 'savings', label: 'Savings and a rainy day fund', short: 'savings', goalTypes: ['maintain_liquidity'] },
  { id: 'whole', label: 'The whole picture', short: 'the whole picture', goalTypes: ['understand_position'] },
  { id: 'other', label: 'Something else', short: '', goalTypes: [] }
]);

const TOPIC_IDS = new Set(TOPICS.map((topic) => topic.id));

export function topicLabel(id) {
  return TOPICS.find((topic) => topic.id === id)?.label || '';
}

const YES_NO = Object.freeze([
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' }
]);
const YES_NO_UNSURE = Object.freeze([
  ...YES_NO,
  { value: 'unsure', label: 'Not sure' }
]);
const CONTRIBUTION_UNITS = Object.freeze([
  { value: 'pct', label: '% of salary', short: 'of salary' },
  { value: 'eur', label: '€ a month', short: 'a month' }
]);

const PENSION_CONTRIBUTORY = new Set(['company', 'prsa', 'personal', 'unsure']);
const PENSION_EMPLOYER = new Set(['company', 'prsa', 'unsure']);

const hasPartner = (app) => app?.household?.partner === 'yes';
const hasChildren = (app) => app?.household?.children === 'yes';
const hasTopic = (ctx, ...ids) => ids.some((id) => ctx.topics.has(id));

/**
 * Each section is one card on the page. A section is shown when it is
 * `always` shown or one of its `topics` is chosen, and then only if its own
 * `showIf` holds. Sections hidden only by topic are offered under "Add more".
 */
export const SECTIONS = Object.freeze([
  {
    id: 'question',
    title: 'Your question',
    summaryTitle: 'The question',
    always: true,
    fields: [
      {
        path: 'question',
        label: 'What do you want to understand?',
        short: 'Question',
        hint: 'For example: should we overpay the mortgage or pay more into our pensions?',
        type: 'longtext',
        maxLength: MAX_QUESTION_LENGTH,
        rows: 4,
        private: true
      },
      {
        path: 'upcoming',
        label: 'Is anything coming up, and when?',
        short: 'Coming up',
        hint: 'For example: our fixed rate ends in March.',
        type: 'longtext',
        maxLength: 600,
        rows: 2,
        private: true
      }
    ]
  },
  {
    id: 'about',
    title: 'About you',
    summaryTitle: 'Household',
    intro: 'Ages set the timelines for pensions, mortgages and college.',
    always: true,
    fields: [
      { path: 'household.age', label: 'Your age', short: 'Age', type: 'age', min: 16, max: 100, profilePath: '/primaryPerson/age' },
      { path: 'household.partner', label: 'Are you planning with a partner?', short: 'Planning with a partner', type: 'choice', options: YES_NO },
      { path: 'household.partnerAge', label: 'Your partner’s age', short: 'Partner’s age', type: 'age', min: 16, max: 100, showIf: hasPartner, when: 'household.partner is "yes"', profilePath: '/partner/age' },
      { path: 'household.married', label: 'Are you married or in a civil partnership?', short: 'Married or civil partners', hint: 'It changes how you are taxed.', type: 'choice', options: YES_NO, showIf: hasPartner, when: 'household.partner is "yes"' },
      { path: 'household.children', label: 'Do you have children?', short: 'Children', type: 'choice', options: YES_NO }
    ]
  },
  {
    id: 'children',
    title: 'Children',
    intro: 'Their ages show when college costs start and how long they depend on you.',
    always: true,
    showIf: hasChildren,
    when: 'household.children is "yes"',
    repeater: {
      path: 'children',
      max: 8,
      itemTitle: 'Child',
      addLabel: 'Add a child',
      fields: [
        { key: 'age', label: 'Age', short: 'Age', type: 'age', min: 0, max: 30, profilePath: '/dependants/*/currentAge' },
        {
          key: 'collegePlan',
          label: 'College plans',
          short: 'College',
          type: 'choice',
          options: [
            { value: 'away', label: 'Away from home' },
            { value: 'home', label: 'From home' },
            { value: 'unsure', label: 'Not sure yet' }
          ],
          showIf: (_app, ctx) => hasTopic(ctx, 'education', 'whole'),
          when: 'topics include "education" or "whole"'
        },
        {
          key: 'saved',
          label: 'Saved for them so far',
          short: 'Saved for them',
          type: 'money',
          showIf: (_app, ctx) => hasTopic(ctx, 'education', 'whole'),
          when: 'topics include "education" or "whole"'
        }
      ]
    }
  },
  {
    id: 'income',
    title: 'Income',
    intro: 'Income sets your tax, your pension relief and what a lender will offer.',
    always: true,
    fields: [
      { path: 'income.gross', label: 'Your gross pay a year, before tax', short: 'Gross pay a year', type: 'money', unit: 'year', pair: 'gross', profilePath: '/incomeSources/*/grossAnnual' },
      { path: 'income.partnerGross', label: 'Your partner’s gross pay a year', short: 'Partner’s gross pay a year', type: 'money', unit: 'year', pair: 'gross', showIf: hasPartner, when: 'household.partner is "yes"', profilePath: '/incomeSources/*/grossAnnual' },
      {
        path: 'income.work',
        label: 'Your work',
        short: 'Work',
        type: 'choice',
        pair: 'work',
        options: [
          { value: 'employee', label: 'Employee' },
          { value: 'self_employed', label: 'Self-employed' },
          { value: 'director', label: 'Company director' },
          { value: 'not_working', label: 'Not working' },
          { value: 'retired', label: 'Retired' }
        ],
        profilePath: '/primaryPerson/employmentStatus'
      },
      {
        path: 'income.partnerWork',
        label: 'Your partner’s work',
        short: 'Partner’s work',
        type: 'choice',
        pair: 'work',
        options: [
          { value: 'employee', label: 'Employee' },
          { value: 'self_employed', label: 'Self-employed' },
          { value: 'director', label: 'Company director' },
          { value: 'not_working', label: 'Not working' },
          { value: 'retired', label: 'Retired' }
        ],
        showIf: hasPartner,
        when: 'household.partner is "yes"',
        profilePath: '/partner/employmentStatus'
      },
      {
        path: 'income.sector',
        label: 'Your sector',
        short: 'Sector',
        type: 'choice',
        pair: 'sector',
        options: [
          { value: 'public', label: 'Public sector' },
          { value: 'private', label: 'Private sector' }
        ],
        showIf: (app) => app?.income?.work === 'employee',
        when: 'income.work is "employee"'
      },
      {
        path: 'income.partnerSector',
        label: 'Your partner’s sector',
        short: 'Partner’s sector',
        type: 'choice',
        pair: 'sector',
        options: [
          { value: 'public', label: 'Public sector' },
          { value: 'private', label: 'Private sector' }
        ],
        showIf: (app) => hasPartner(app) && app?.income?.partnerWork === 'employee',
        when: 'household.partner is "yes" and income.partnerWork is "employee"'
      },
      { path: 'income.takeHome', label: 'Household take-home pay a month, after tax', short: 'Household take-home pay a month', type: 'money', unit: 'month', profilePath: '/householdIncome/netMonthly' }
    ]
  },
  {
    id: 'spending',
    title: 'Spending and saving',
    intro: 'This shows how much room there is each month.',
    always: true,
    fields: [
      {
        path: 'spending.pattern',
        label: 'Most months, do you',
        short: 'Most months',
        type: 'choice',
        options: [
          { value: 'save', label: 'Save some' },
          { value: 'even', label: 'Break even' },
          { value: 'more', label: 'Spend more than you earn', publicLabel: 'Spend more than they earn' }
        ]
      },
      { path: 'spending.saved', label: 'Roughly how much you save a month', short: 'Saved a month', type: 'money', unit: 'month', showIf: (app) => !['even', 'more'].includes(app?.spending?.pattern), when: 'spending.pattern is not "even" or "more"' },
      { path: 'spending.spend', label: 'What you spend a month, not counting rent or mortgage', short: 'Spending a month, not counting rent or mortgage', hint: 'A recent bank statement helps.', type: 'money', unit: 'month', profilePath: '/expenses/monthlyEssential' }
    ]
  },
  {
    id: 'home',
    title: 'Your home',
    summaryTitle: 'Home',
    intro: 'Your home and what it costs are part of the full picture.',
    always: true,
    fields: [
      {
        path: 'home.status',
        label: 'Your home',
        short: 'Home',
        type: 'choice',
        options: [
          { value: 'mortgage', label: 'Own with a mortgage' },
          { value: 'owned', label: 'Own outright' },
          { value: 'rent', label: 'Rent' },
          { value: 'family', label: 'Live with family' }
        ]
      },
      { path: 'home.value', label: 'What it would sell for today', short: 'Home value', type: 'money', showIf: (app) => ['mortgage', 'owned'].includes(app?.home?.status), when: 'home.status is "mortgage" or "owned"', profilePath: '/properties/*/currentValue' },
      { path: 'home.rent', label: 'Rent a month', short: 'Rent a month', type: 'money', unit: 'month', showIf: (app) => app?.home?.status === 'rent', when: 'home.status is "rent"', profilePath: '/expenses/currentMonthlyRent' }
    ]
  },
  {
    id: 'mortgage',
    title: 'Mortgage',
    intro: 'Your rate and years left decide what overpaying would save.',
    always: true,
    showIf: (app) => app?.home?.status === 'mortgage',
    when: 'home.status is "mortgage"',
    fields: [
      { path: 'mortgage.balance', label: 'Balance left', short: 'Mortgage balance', type: 'money', profilePath: '/liabilities/*/currentBalance' },
      { path: 'mortgage.rate', label: 'Interest rate', short: 'Interest rate', type: 'percent', max: 30, profilePath: '/liabilities/*/annualInterestRate' },
      {
        path: 'mortgage.rateType',
        label: 'Rate type',
        short: 'Rate type',
        type: 'choice',
        options: [
          { value: 'tracker', label: 'Tracker' },
          { value: 'variable', label: 'Variable' },
          { value: 'fixed', label: 'Fixed' }
        ]
      },
      { path: 'mortgage.fixedEnds', label: 'When the fixed rate ends', short: 'Fixed rate ends', type: 'month', showIf: (app) => app?.mortgage?.rateType === 'fixed', when: 'mortgage.rateType is "fixed"' },
      { path: 'mortgage.trackerMargin', label: 'Margin above the ECB rate', short: 'Tracker margin above ECB', type: 'percent', max: 10, showIf: (app) => app?.mortgage?.rateType === 'tracker', when: 'mortgage.rateType is "tracker"' },
      { path: 'mortgage.yearsLeft', label: 'Years left', short: 'Years left', hint: 'Not the original term.', type: 'years', max: 40, profilePath: '/liabilities/*/remainingTermMonths' },
      { path: 'mortgage.repayment', label: 'Repayment a month', short: 'Repayment a month', type: 'money', unit: 'month', profilePath: '/liabilities/*/monthlyPayment' },
      { path: 'mortgage.overpaying', label: 'Are you overpaying now?', short: 'Overpaying now', type: 'choice', options: YES_NO },
      { path: 'mortgage.overpayment', label: 'Overpayment a month', short: 'Overpayment a month', type: 'money', unit: 'month', showIf: (app) => app?.mortgage?.overpaying === 'yes', when: 'mortgage.overpaying is "yes"' },
      { path: 'mortgage.lender', label: 'Lender', short: 'Lender', hint: 'Never shown in videos.', type: 'text', maxLength: 60, private: true }
    ]
  },
  {
    id: 'buying',
    title: 'Buying a home',
    intro: 'A lender looks at the price, your deposit and your income.',
    topics: ['buying'],
    fields: [
      { path: 'buying.price', label: 'Price you are looking at', short: 'Price looking at', type: 'money' },
      { path: 'buying.firstTime', label: 'First-time buyer?', short: 'First-time buyer', type: 'choice', options: YES_NO },
      { path: 'buying.deposit', label: 'Deposit saved so far', short: 'Deposit saved', type: 'money' },
      { path: 'buying.approval', label: 'Approval in principle, if you have one', short: 'Approval in principle', type: 'money' },
      { path: 'buying.scheme', label: 'Using Help to Buy or the First Home scheme?', short: 'Help to Buy or First Home', type: 'choice', options: YES_NO_UNSURE },
      {
        path: 'buying.when',
        label: 'When would you like to buy?',
        short: 'When',
        type: 'choice',
        options: [
          { value: '6m', label: 'Within 6 months' },
          { value: '12m', label: '6 to 12 months' },
          { value: '24m', label: '1 to 2 years' },
          { value: 'later', label: 'Later' }
        ]
      }
    ]
  },
  {
    id: 'savings',
    title: 'Savings and investments',
    intro: 'Savings show what is there for goals and emergencies.',
    always: true,
    fields: [
      { path: 'savings.cash', label: 'Cash in the bank, all accounts', short: 'Cash', type: 'money', profilePath: '/assets/*/currentValue' },
      { path: 'savings.investments', label: 'Investments and shares', short: 'Investments and shares', type: 'money', profilePath: '/assets/*/currentValue' },
      { path: 'savings.employerShares', label: 'Shares in your employer', short: 'Shares in employer', type: 'money', profilePath: '/assets/*/currentValue' }
    ]
  },
  {
    id: 'properties',
    title: 'Other property',
    intro: 'Rental or holiday property you own apart from your home.',
    topics: ['whole'],
    none: { label: 'No other property', short: 'Other property' },
    repeater: {
      path: 'properties',
      max: 4,
      itemTitle: 'Property',
      addLabel: 'Add a property',
      fields: [
        { key: 'value', label: 'Value', short: 'Value', type: 'money', profilePath: '/properties/*/currentValue' },
        { key: 'mortgage', label: 'Mortgage on it', short: 'Mortgage', type: 'money' },
        { key: 'rent', label: 'Rent a year', short: 'Rent a year', type: 'money', unit: 'year' },
        { key: 'costs', label: 'Costs a year, not counting mortgage interest', short: 'Costs a year', type: 'money', unit: 'year' },
        { key: 'rate', label: 'Mortgage interest rate', short: 'Rate', type: 'percent', max: 30 }
      ]
    }
  },
  {
    id: 'pensions',
    title: 'Pensions',
    intro: 'Your pension statement has most of these.',
    topics: ['retirement', 'mortgage', 'whole'],
    none: { label: 'We have no pensions', short: 'Pensions' },
    repeater: {
      path: 'pensions',
      max: 6,
      itemTitle: 'Pension',
      addLabel: 'Add a pension',
      fields: [
        {
          key: 'owner',
          label: 'Whose pension',
          short: 'Whose',
          type: 'choice',
          options: [
            { value: 'you', label: 'Yours', publicLabel: 'The applicant' },
            { value: 'partner', label: 'Your partner’s', publicLabel: 'Their partner' }
          ],
          showIf: (app) => hasPartner(app),
          when: 'household.partner is "yes" (otherwise the pension is the applicant\'s)'
        },
        {
          key: 'type',
          label: 'Type',
          short: 'Type',
          type: 'choice',
          options: [
            { value: 'company', label: 'Company pension' },
            { value: 'public', label: 'Public service or defined benefit' },
            { value: 'prsa', label: 'PRSA' },
            { value: 'personal', label: 'Personal pension' },
            { value: 'bond', label: 'Buy-out bond from an old job' },
            { value: 'unsure', label: 'Not sure' }
          ],
          profilePath: '/pensions/*/type'
        },
        { key: 'value', label: 'Value today', short: 'Value today', type: 'money', showIf: (_app, _ctx, item) => item?.type !== 'public', when: 'type is not "public"', profilePath: '/pensions/*/currentValue' },
        {
          key: 'youPay',
          label: 'Personal contribution',
          short: 'Personal contribution',
          type: 'contribution',
          unitKey: 'youPayUnit',
          units: CONTRIBUTION_UNITS,
          showIf: (_app, _ctx, item) => !item?.type || PENSION_CONTRIBUTORY.has(item.type),
          when: 'type is "company", "prsa", "personal" or "unsure"',
          profilePath: '/pensions/*/employeeContributionRate'
        },
        {
          key: 'employerPays',
          label: 'Employer contribution',
          short: 'Employer contribution',
          type: 'contribution',
          unitKey: 'employerPaysUnit',
          units: CONTRIBUTION_UNITS,
          showIf: (_app, _ctx, item) => !item?.type || PENSION_EMPLOYER.has(item.type),
          when: 'type is "company", "prsa" or "unsure"',
          profilePath: '/pensions/*/employerContributionRate'
        },
        {
          key: 'contributing',
          label: 'Still paying in?',
          short: 'Still paying in',
          type: 'choice',
          options: YES_NO,
          showIf: (_app, _ctx, item) => !item?.type || PENSION_CONTRIBUTORY.has(item.type),
          when: 'type is "company", "prsa", "personal" or "unsure"',
          profilePath: '/pensions/*/contributionStatus'
        },
        { key: 'dbPension', label: 'Expected pension a year', short: 'Expected pension a year', hint: 'Your benefit statement shows this.', type: 'money', unit: 'year', showIf: (_app, _ctx, item) => item?.type === 'public', when: 'type is "public"', profilePath: '/pensions/*/projectedAnnualIncome' },
        { key: 'dbLumpSum', label: 'Expected lump sum', short: 'Expected lump sum', type: 'money', showIf: (_app, _ctx, item) => item?.type === 'public', when: 'type is "public"', profilePath: '/pensions/*/retirementLumpSum' },
        { key: 'dbAge', label: 'From what age', short: 'From age', type: 'age', min: 50, max: 75, showIf: (_app, _ctx, item) => item?.type === 'public', when: 'type is "public"', profilePath: '/pensions/*/benefitStartAge' }
      ]
    }
  },
  {
    id: 'retirement',
    title: 'Retirement',
    intro: 'These set the target the projection works towards.',
    topics: ['retirement', 'whole'],
    fields: [
      { path: 'retirement.age', label: 'Age you would like to stop working', short: 'Would like to stop working at', type: 'age', min: 40, max: 80, pair: 'retireAge', profilePath: '/primaryPerson/intendedRetirementAge' },
      { path: 'retirement.partnerAge', label: 'Age your partner would like to stop working', short: 'Partner would like to stop working at', type: 'age', min: 40, max: 80, pair: 'retireAge', showIf: hasPartner, when: 'household.partner is "yes"', profilePath: '/partner/intendedRetirementAge' },
      { path: 'retirement.income', label: 'Income you would like a year in retirement, in today’s money', short: 'Income wanted a year in retirement', hint: 'Before tax, for the household.', type: 'money', unit: 'year' },
      {
        path: 'retirement.statePension',
        label: 'Do you expect the full State Pension?',
        short: 'Full State Pension expected',
        type: 'choice',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'partly', label: 'Partly' },
          { value: 'unsure', label: 'Not sure' }
        ]
      }
    ]
  },
  {
    id: 'loans',
    title: 'Loans and credit cards',
    intro: 'Repayments affect what you can save and what you can borrow.',
    topics: ['loans', 'buying', 'whole'],
    none: { label: 'No loans', short: 'Loans' },
    repeater: {
      path: 'loans',
      max: 6,
      itemTitle: 'Loan',
      addLabel: 'Add a loan',
      fields: [
        {
          key: 'type',
          label: 'Type',
          short: 'Type',
          type: 'choice',
          options: [
            { value: 'car', label: 'Car' },
            { value: 'personal', label: 'Personal' },
            { value: 'credit_union', label: 'Credit union' },
            { value: 'student', label: 'Student' },
            { value: 'other', label: 'Other' }
          ]
        },
        { key: 'balance', label: 'Balance', short: 'Balance', type: 'money', profilePath: '/liabilities/*/currentBalance' },
        { key: 'rate', label: 'Interest rate', short: 'Rate', type: 'percent', max: 60, profilePath: '/liabilities/*/annualInterestRate' },
        { key: 'yearsLeft', label: 'Years left', short: 'Years left', type: 'years', max: 30, profilePath: '/liabilities/*/remainingTermMonths' },
        { key: 'payment', label: 'Payment a month', short: 'Payment a month', type: 'money', unit: 'month', profilePath: '/liabilities/*/monthlyPayment' }
      ]
    },
    fields: [
      { path: 'creditCard.clears', label: 'Do you clear your credit card in full each month?', short: 'Credit card cleared each month', type: 'choice', options: [...YES_NO, { value: 'none', label: 'No credit card' }] },
      { path: 'creditCard.balance', label: 'Credit card balance', short: 'Credit card balance', type: 'money', showIf: (app) => app?.creditCard?.clears === 'no', when: 'creditCard.clears is "no"' }
    ]
  },
  {
    id: 'cover',
    title: 'Cover',
    intro: 'Cover that pays out if someone dies or cannot work.',
    topics: ['whole'],
    fields: [
      { path: 'cover.life', label: 'Life cover', short: 'Life cover', hint: 'Including mortgage protection.', type: 'choice', options: YES_NO_UNSURE },
      { path: 'cover.incomeProtection', label: 'Income protection', short: 'Income protection', type: 'choice', options: YES_NO_UNSURE }
    ]
  },
  {
    id: 'extra',
    title: 'Anything else',
    always: true,
    fields: [
      { path: 'anythingElse', label: 'Anything else Gerry should know?', short: 'Anything else', type: 'longtext', maxLength: MAX_LONG_TEXT_LENGTH, rows: 3, private: true },
      { path: 'videoName', label: 'Name to use in the video', short: 'Name for the video', hint: 'Optional. A made-up name is fine. Leave it blank and Gerry will not use a name.', type: 'text', maxLength: 60, private: true }
    ]
  }
]);

const SECTION_BY_ID = new Map(SECTIONS.map((section) => [section.id, section]));

export function getSection(id) {
  return SECTION_BY_ID.get(id) || null;
}

/** Sections that only a topic can open, so "Add more" can offer them. */
export const TOPIC_GATED_SECTION_IDS = Object.freeze(
  SECTIONS.filter((section) => !section.always).map((section) => section.id)
);
const NONE_SECTION_IDS = new Set(SECTIONS.filter((section) => section.none).map((section) => section.id));

const NUMERIC_TYPES = new Set(['money', 'percent', 'age', 'years', 'contribution']);

export function isNumericField(field) {
  return NUMERIC_TYPES.has(field.type);
}

/* ---------- paths ---------- */

export function getPath(object, path) {
  return String(path).split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);
}

export function setPath(object, path, value) {
  const keys = String(path).split('.');
  let target = object;
  keys.slice(0, -1).forEach((key, index) => {
    const nextIsIndex = /^\d+$/.test(keys[index + 1]);
    if (target[key] == null || typeof target[key] !== 'object') {
      target[key] = nextIsIndex ? [] : {};
    }
    target = target[key];
  });
  target[keys[keys.length - 1]] = value;
  return object;
}

export function deletePath(object, path) {
  const keys = String(path).split('.');
  const parent = keys.slice(0, -1).reduce((value, key) => (value == null ? undefined : value[key]), object);
  if (parent && typeof parent === 'object') delete parent[keys[keys.length - 1]];
  return object;
}

/* ---------- visibility ---------- */

export function createContext(app) {
  const topics = new Set(Array.isArray(app?.topics) ? app.topics : []);
  const added = new Set(Array.isArray(app?.added) ? app.added : []);
  return { topics, added };
}

/** Shown by topic (or by being added), before the section's own condition. */
export function isSectionOffered(section, ctx) {
  if (section.always) return true;
  if (ctx.added.has(section.id)) return true;
  return (section.topics || []).some((topic) => ctx.topics.has(topic));
}

export function isSectionVisible(section, app, ctx = createContext(app)) {
  if (!isSectionOffered(section, ctx)) return false;
  return typeof section.showIf === 'function' ? Boolean(section.showIf(app, ctx)) : true;
}

export function isFieldVisible(field, app, ctx, item) {
  return typeof field.showIf === 'function' ? Boolean(field.showIf(app, ctx, item)) : true;
}

export function isSectionNone(section, app) {
  return Boolean(section.none) && Array.isArray(app?.none) && app.none.includes(section.id);
}

/**
 * Every field the person can currently see, with its concrete path.
 * Repeater fields come out as `pensions.0.value`. A section marked "none"
 * keeps its scalar fields and hides its repeater.
 */
export function listVisibleFields(app, ctx = createContext(app)) {
  const instances = [];
  SECTIONS.forEach((section) => {
    if (!isSectionVisible(section, app, ctx)) return;
    (section.fields || []).forEach((field) => {
      if (isFieldVisible(field, app, ctx)) {
        instances.push({ section, field, path: field.path });
      }
    });
    if (section.repeater && !isSectionNone(section, app)) {
      const items = Array.isArray(getPath(app, section.repeater.path)) ? getPath(app, section.repeater.path) : [];
      items.slice(0, section.repeater.max).forEach((item, index) => {
        section.repeater.fields.forEach((field) => {
          if (isFieldVisible(field, app, ctx, item)) {
            instances.push({
              section,
              field,
              item,
              index,
              path: `${section.repeater.path}.${index}.${field.key}`
            });
          }
        });
      });
    }
  });
  return instances;
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

/** How many visible questions have an answer, counting "Not sure" as one. */
export function countAnswers(app, ctx = createContext(app)) {
  const unsure = new Set(Array.isArray(app?.unsure) ? app.unsure : []);
  let answered = 0;
  let total = 0;
  listVisibleFields(app, ctx).forEach(({ path }) => {
    total += 1;
    if (hasValue(getPath(app, path)) || unsure.has(path)) answered += 1;
  });
  return { answered, total };
}

export function countSectionAnswers(section, app, ctx = createContext(app)) {
  const unsure = new Set(Array.isArray(app?.unsure) ? app.unsure : []);
  let answered = 0;
  let total = 0;
  listVisibleFields(app, ctx)
    .filter((instance) => instance.section.id === section.id)
    .forEach(({ path }) => {
      total += 1;
      if (hasValue(getPath(app, path)) || unsure.has(path)) answered += 1;
    });
  return { answered, total };
}

/**
 * Keep only what the person can see. Answers in a section they have since
 * hidden, by changing topic or saying "No loans", stay in their saved draft
 * but are not sent: they are no longer part of what the person is telling us.
 */
export function pruneToVisible(app) {
  const ctx = createContext(app);
  const result = baseOf(app);
  const unsure = new Set(Array.isArray(app?.unsure) ? app.unsure : []);
  const keptUnsure = [];

  SECTIONS.forEach((section) => {
    if (!isSectionVisible(section, app, ctx)) return;
    if (section.repeater && !isSectionNone(section, app)) {
      const items = getPath(app, section.repeater.path);
      if (Array.isArray(items) && items.length > 0) {
        setPath(result, section.repeater.path, items.slice(0, section.repeater.max).map(() => ({})));
      }
    }
    if (isSectionNone(section, app)) result.none.push(section.id);
  });

  listVisibleFields(app, ctx).forEach(({ field, path }) => {
    const value = getPath(app, path);
    if (hasValue(value)) {
      setPath(result, path, value);
      if (field.unitKey) {
        const unitPath = path.replace(/[^.]+$/, field.unitKey);
        const unit = getPath(app, unitPath);
        if (unit) setPath(result, unitPath, unit);
      }
    } else if (unsure.has(path) && isNumericField(field)) {
      keptUnsure.push(path);
    }
  });

  result.unsure = keptUnsure;
  return result;
}

function sectionHasAnswers(section, app) {
  if (isSectionNone(section, app)) return true;
  const scalar = (section.fields || []).some((field) => hasValue(getPath(app, field.path)));
  if (scalar) return true;
  if (!section.repeater) return false;
  const items = getPath(app, section.repeater.path);
  return Array.isArray(items) && items.some((item) => (
    item && typeof item === 'object' && section.repeater.fields.some((field) => hasValue(item[field.key]))
  ));
}

/**
 * Open every topic-gated section that already holds answers.
 *
 * A person on the page opens a section with "Add more" before filling it in.
 * An assistant sends the answers directly, so a section it filled in would
 * otherwise stay closed, and its answers would never reach Gerry's write-up,
 * just because a topic chip was not chosen.
 */
export function includeAnsweredSections(app) {
  const ctx = createContext(app);
  const added = new Set(Array.isArray(app?.added) ? app.added : []);
  SECTIONS.forEach((section) => {
    if (section.always || isSectionOffered(section, ctx)) return;
    if (sectionHasAnswers(section, app)) added.add(section.id);
  });
  return { ...app, added: TOPIC_GATED_SECTION_IDS.filter((id) => added.has(id)) };
}

function baseOf(app) {
  const topics = Array.isArray(app?.topics) ? app.topics.filter((id) => TOPIC_IDS.has(id)) : [];
  const added = Array.isArray(app?.added) ? app.added.filter((id) => TOPIC_GATED_SECTION_IDS.includes(id)) : [];
  return {
    schema: APPLICATION_SCHEMA,
    topics: [...new Set(topics)],
    added: [...new Set(added)],
    unsure: [],
    none: []
  };
}

/* ---------- normalizing a submission ---------- */

function normalizeText(value, maxLength, { multiline = false } = {}) {
  if (typeof value !== 'string') return undefined;
  let text = value.replace(/\r\n?/g, '\n');
  text = multiline
    ? text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
    : text.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.slice(0, maxLength);
}

function inRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

/** One value, checked against its field. Anything it cannot read is dropped. */
export function normalizeFieldValue(field, raw, unit) {
  switch (field.type) {
    case 'money':
      return inRange(parseMoney(raw), 0, 1_000_000_000);
    case 'percent':
      return inRange(parsePercent(raw), 0, field.max ?? 100);
    case 'age':
      return inRange(parseWhole(raw), field.min ?? 0, field.max ?? 110);
    case 'years':
      return inRange(parseYears(raw), 0, field.max ?? 60);
    case 'contribution':
      return unit === 'eur'
        ? inRange(parseMoney(raw), 0, 1_000_000)
        : inRange(parsePercent(raw), 0, 100);
    case 'month': {
      const text = typeof raw === 'string' ? raw.trim() : '';
      const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(text);
      return match && Number(match[1]) >= 2000 && Number(match[1]) <= 2100 ? text : undefined;
    }
    case 'choice':
      return field.options.some((option) => option.value === raw) ? raw : undefined;
    case 'text':
      return normalizeText(raw, field.maxLength ?? 120);
    case 'longtext':
      return normalizeText(raw, field.maxLength ?? MAX_LONG_TEXT_LENGTH, { multiline: true });
    default:
      return undefined;
  }
}

function normalizeUnit(field, raw) {
  if (!field.unitKey) return undefined;
  return field.units.some((unit) => unit.value === raw) ? raw : field.units[0].value;
}

/**
 * Accept whatever arrives and keep what can be read. This never throws for a
 * bad figure: it drops it. Unknown keys are dropped, repeaters are capped, and
 * "Not sure" marks are kept only for figures that really are empty.
 *
 * It does not hide sections by topic: the Worker cannot see the page, so it
 * keeps every known answer. The page prunes to what is visible before sending.
 */
export function normalizeApplication(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = baseOf(source);

  SECTIONS.forEach((section) => {
    (section.fields || []).forEach((field) => {
      const unitPath = field.unitKey ? field.path.replace(/[^.]+$/, field.unitKey) : '';
      const unit = field.unitKey ? normalizeUnit(field, getPath(source, unitPath)) : undefined;
      const value = normalizeFieldValue(field, getPath(source, field.path), unit);
      if (value !== undefined) {
        setPath(result, field.path, value);
        if (unitPath) setPath(result, unitPath, unit);
      }
    });

    if (section.repeater) {
      const items = getPath(source, section.repeater.path);
      if (Array.isArray(items) && items.length > 0) {
        const normalizedItems = items.slice(0, section.repeater.max).map((item) => {
          const next = {};
          if (!item || typeof item !== 'object' || Array.isArray(item)) return next;
          section.repeater.fields.forEach((field) => {
            const unit = field.unitKey ? normalizeUnit(field, item[field.unitKey]) : undefined;
            const value = normalizeFieldValue(field, item[field.key], unit);
            if (value !== undefined) {
              next[field.key] = value;
              if (field.unitKey) next[field.unitKey] = unit;
            }
          });
          return next;
        });
        setPath(result, section.repeater.path, normalizedItems);
      }
    }
  });

  if (Array.isArray(source.none)) {
    result.none = [...new Set(source.none.filter((id) => NONE_SECTION_IDS.has(id)))];
  }

  if (Array.isArray(source.unsure)) {
    const numericPaths = knownNumericPaths(result);
    result.unsure = [...new Set(source.unsure.filter((path) => (
      typeof path === 'string'
      && numericPaths.has(path)
      && !hasValue(getPath(result, path))
    )))].slice(0, 200);
  }

  return result;
}

/** Every numeric path the application could hold, given its repeater lengths. */
function knownNumericPaths(app) {
  const paths = new Set();
  SECTIONS.forEach((section) => {
    (section.fields || []).forEach((field) => {
      if (isNumericField(field)) paths.add(field.path);
    });
    if (section.repeater) {
      const items = getPath(app, section.repeater.path);
      const count = Array.isArray(items) ? items.length : 0;
      for (let index = 0; index < count; index += 1) {
        section.repeater.fields.forEach((field) => {
          if (isNumericField(field)) paths.add(`${section.repeater.path}.${index}.${field.key}`);
        });
      }
    }
  });
  return paths;
}

/**
 * A field's option label, for the write-up and the admin. A published case is
 * about someone else, so an option written as "Yours" has a third-person label
 * for public use.
 */
export function optionLabel(field, value, { publicMode = false } = {}) {
  const option = field.options?.find((candidate) => candidate.value === value);
  if (!option) return '';
  return publicMode && option.publicLabel ? option.publicLabel : option.label;
}
