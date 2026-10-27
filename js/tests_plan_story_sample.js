/**
 * THE SAMPLE STORY.
 *
 * Route 3 of the sample household (Niamh and Dara, both 45, one child, Ella):
 * the story, the facts it is filled from, the words for each module and case,
 * and the four routes' at-a-glance figures. The tests and the dev preview both
 * read it, so what a test proves is what the preview draws.
 *
 * These are a fixture. The figures mirror the design sample in the plan story
 * brief; in the product the code computes every one of them and registers its
 * source, and the analyst writes only the words.
 */

const fact = (text, source = { panel: 'ledger' }) => ({ text, source });

// A figure is a link only where a module prints it. Three of these have no module that does (what is left over
// once the whole route is in place, a mortgage after rates rise, a college saving after costs rise), so they stay
// plain figures; the cash flow module's own case for clearing the car shows €17,000, not the route's €8,900.
//
// `outlineText` and `outlineSelector` say how to find the figure inside the module once it is open: the words the
// module itself prints (they can differ from the story's), or a selector inside it. The hints here match the
// modules the demo session builds from the same inputs.

export const PLAN_STORY_SAMPLE_REGISTRY = Object.freeze({
  'position.leftOver': fact('€11,000 a year', { chapter: 'household_cash_flow', caseId: 'today', outlineText: '€11,000' }),
  'position.savings': fact('€90,000', { chapter: 'liquidity_analysis', outlineText: '€90,000' }),
  'position.reserve': fact('€42,000', { chapter: 'liquidity_analysis', outlineText: '€42,000' }),
  'position.reserveMonths': fact('six months', { chapter: 'liquidity_analysis' }),
  'route.goals.coverage': fact('all goals are covered'),
  'route.netWorth.changeWord': fact('Unchanged', { panel: 'net_worth_after' }),
  'protection.niamh.gap': fact('€38,000 a year short', { chapter: 'protection_gap', caseId: 'niamh-cannot-work', outlineText: '€38,000 a year short' }),
  'route.protection.niamh.months': fact('24 months', { chapter: 'protection_gap', caseId: 'niamh-cannot-work', outlineText: '24 months' }),
  'protection.dara.gap': fact('€26,000 a year short', { chapter: 'protection_gap', caseId: 'dara-cannot-work', outlineText: '€26,000 a year short' }),
  'loan.car.rate': fact('6%', { chapter: 'loan_analysis', caseId: 'clear', outlineText: '6%' }),
  'route.loan.car.balance': fact('€15,000 balance', { chapter: 'loan_analysis', caseId: 'clear', outlineText: '€15,000' }),
  'route.loan.car.interestSaved': fact('€1,293 in interest', { chapter: 'loan_analysis', caseId: 'clear', outlineText: '€1,293' }),
  'route.cashFlow.freed': fact('€6,000 a year', { chapter: 'household_cash_flow', caseId: 'clear-car', outlineText: '€6,000 less than today' }),
  'route.cashFlow.freedFrom': fact('2026'),
  'route.goals.college.yearly': fact('€3,600 a year', { chapter: 'future_cost_fund', caseId: 'yearly', outlineText: '€3,600 a year' }),
  'route.goals.college.from': fact('2026'),
  'route.goals.mortgage.clears': fact('2042 instead of 2046', { chapter: 'mortgage_analysis', caseId: 'extra', outlineSelector: '.rcm-hero-figure' }),
  'route.goals.mortgage.extraMonthly': fact('€371 more a month', { chapter: 'mortgage_analysis', caseId: 'extra', outlineText: 'Pay €371 more a month' }),
  'goals.retirement.age': fact('67'),
  'goals.retirement.state': fact('strong position', { chapter: 'pension_projection', outlineText: 'strong position' }),
  'route.cashFlow.leftOverAfter': fact('€8,900 a year'),
  'route.netWorth.after': fact('€625,000', { chapter: 'personal_balance_sheet', caseId: 'route3', outlineText: '€625,000' }),
  'route.netWorth.moved': fact('€15,000'),
  'risk.rates.points': fact('2 points'),
  'route.risk.ratesUp': fact('€3,700 more a year'),
  'risk.college.points': fact('2 points'),
  'route.risk.collegeCosts': fact('€4,000 a year'),
  'route.savingsUsed': fact('€15,000')
});

export const PLAN_STORY_SAMPLE_CATALOGUE = Object.freeze({
  chapters: Object.freeze({
    household_cash_flow: { title: 'Household cash flow', glyph: 'flow' },
    liquidity_analysis: { title: 'Cash reserve', glyph: 'res' },
    protection_gap: { title: 'Protection gap', glyph: 'prot' },
    mortgage_analysis: { title: 'Mortgage', glyph: 'mort' },
    loan_analysis: { title: 'Car loan', glyph: 'car' },
    future_cost_fund: { title: 'College fund', glyph: 'coll' },
    pension_projection: { title: 'Pension', glyph: 'pen' },
    personal_balance_sheet: { title: 'Balance sheet', glyph: 'bal' }
  }),
  cases: Object.freeze({
    household_cash_flow: { today: 'Today', 'clear-car': 'Clear your car loan' },
    protection_gap: { 'niamh-cannot-work': 'Niamh cannot work', 'dara-cannot-work': 'Dara cannot work' },
    loan_analysis: { clear: 'Clear it now' },
    mortgage_analysis: { extra: 'Pay €371 more a month', today: 'Today' },
    future_cost_fund: { yearly: 'Save every year' },
    personal_balance_sheet: { route3: 'Route 3' }
  })
});

export const PLAN_STORY_SAMPLE_STORY = Object.freeze({
  routeId: 'route-3',
  headline: 'Clear the car loan first: {route.savingsUsed} from savings frees {route.cashFlow.freed}',
  summary: 'College and the mortgage are paid from income, about {route.cashFlow.leftOverAfter} is left over and {route.goals.coverage}.',
  sections: Object.freeze([
    {
      id: 'current_position',
      title: 'Where you are now',
      paragraphs: ['You have about {@position.leftOver} left over after everything you pay, and {@position.savings} in savings. {@position.reserve} of that is your emergency fund, {position.reserveMonths} of spending, and every route leaves it untouched.']
    },
    {
      id: 'ledger',
      title: 'The money this route uses',
      paragraphs: ['This route uses {route.savingsUsed} of savings to clear the car loan. The emergency fund stays set aside; the same money is not offered to another goal.']
    },
    {
      id: 'protecting',
      title: 'Protecting what you have',
      paragraphs: ['Your emergency fund is {position.reserve}, covering {position.reserveMonths} of spending. If Niamh couldn’t work, you’d be {@protection.niamh.gap}. In this route your savings would cover that for {@route.protection.niamh.months}. If Dara couldn’t work, {@protection.dara.gap}.']
    },
    {
      id: 'inefficiencies',
      title: 'Removing inefficiencies',
      paragraphs: ['Your car loan costs {@loan.car.rate} while your savings earn far less. Clearing the {@route.loan.car.balance} from savings saves about {@route.loan.car.interestSaved} and frees {@route.cashFlow.freed} from {route.cashFlow.freedFrom}.']
    },
    {
      id: 'goals',
      title: 'Your goals, soonest first',
      paragraphs: ['Ella’s college is covered by saving {@route.goals.college.yearly} from {route.goals.college.from}. The mortgage clears in {@route.goals.mortgage.clears} with {@route.goals.mortgage.extraMonthly}. Retirement at {goals.retirement.age} is in a {@goals.retirement.state}.']
    },
    {
      id: 'cash_flow_after',
      title: 'Cash flow after',
      paragraphs: ['You’d still have about {route.cashFlow.leftOverAfter} left over.']
    },
    {
      id: 'net_worth_after',
      title: 'Net worth after',
      paragraphs: ['{route.netWorth.changeWord} at {@route.netWorth.after}. {route.netWorth.moved} moves from savings to clear the loan.']
    },
    {
      id: 'risks',
      title: 'Risks',
      paragraphs: ['If interest rates rose by {risk.rates.points}, the mortgage would cost about {route.risk.ratesUp}, still within what’s left over. If college costs rose {risk.college.points} faster, saving would need about {route.risk.collegeCosts}.']
    },
    {
      id: 'check_next',
      title: 'What to check next',
      paragraphs: ['Whether the car loan has an early repayment charge, and whether either of you has income protection through work.']
    }
  ])
});

/** In the order the plan gives routes: the current position first, then by cash committed. Never ranked. */
export const PLAN_STORY_SAMPLE_ROUTES = Object.freeze([
  { id: 'route-1', number: 1, name: 'Today', savingsUsed: { text: 'None' }, leftOver: { text: '€11,000' }, goalsCovered: { text: 'Partly' } },
  { id: 'route-2', number: 2, name: 'Pay from income', savingsUsed: { text: 'None' }, leftOver: { text: '€2,900', approx: true }, goalsCovered: { text: 'All' } },
  { id: 'route-3', number: 3, name: 'Clear the car loan first', savingsUsed: { text: '€15,000' }, leftOver: { text: '€8,900', approx: true }, goalsCovered: { text: 'All' } },
  { id: 'route-4', number: 4, name: 'Use savings for college', savingsUsed: { text: '€28,700' }, leftOver: { text: '€6,500', approx: true }, goalsCovered: { text: 'All' } }
]);

const PLAN_STORY_SAMPLE_GLANCE_NOTE = 'Partly: Ella’s college is partly covered and the mortgage clears in 2046, after the 2042 goal.';

/** The sample as a session carries it. `chapterModules` says which session module each chapter became. */
export function buildSamplePlanStory(chapterModules = {}) {
  return JSON.parse(JSON.stringify({
    version: 1,
    routes: PLAN_STORY_SAMPLE_ROUTES,
    selectedRouteId: 'route-3',
    stories: { 'route-3': PLAN_STORY_SAMPLE_STORY },
    registries: { 'route-3': PLAN_STORY_SAMPLE_REGISTRY },
    catalogue: PLAN_STORY_SAMPLE_CATALOGUE,
    chapterModules,
    glanceNote: PLAN_STORY_SAMPLE_GLANCE_NOTE
  }));
}
