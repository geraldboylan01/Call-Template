// Invented consumer transcripts. Expectations are not sent to the model.
export const FIRST20_EVAL_DATE = '2026-09-05';
function turnsFromScript(lines) {
  return lines.map((transcript, i) => ({ id: `${i % 2 ? 'c' : 'a'}${Math.floor(i / 2) + 1}`,
    role: i % 2 ? 'user' : 'assistant', transcript,
    answersTurnId: i % 2 ? `a${Math.floor(i / 2) + 1}` : null }));
}
const scenario = (id, moduleId, lines, expected, extra = {}) => ({
  id, moduleId, turns: turnsFromScript(lines), expected, ready: true, ...extra
});
export const FIRST20_SEMANTIC_CORPUS = [
  scenario('pbs-partners-distinct-correction-closure', 'personal_balance_sheet', [
    'What would you like to understand?',
    'I am Aoife and my husband is Ben. Please add up everything we own and owe so we can see our net worth. Only that for now.',
    'Tell me about your assets and debts.',
    'Our jointly owned home is about 600 thousand with a joint mortgage of 250 thousand. I have an AIB savings account of 20 thousand and Ben has his own AIB savings account of 15 thousand. They are separate accounts, not the same money. My pension is worth 90 thousand and his is worth 50 thousand.',
    'Anything to correct or add?',
    'Wait, my AIB savings is 25 thousand, not 20. The 15 thousand is still Ben\'s. If we inherited another 100 thousand someday that would be nice, but there is no inheritance now or confirmed in the future.',
    'Any other assets, pensions, investments, businesses or debts, and what is your spending?',
    'No, that is everything we own and all our debts. No businesses, other property, investments or other pensions. We spend about 4000 a month. Please go ahead with the net worth review.'
  ], { monthlyExpenditure: 4000, assets: [
    { amount: 600000, bucket: 'lifestyle_assets' },
    { amount: 25000, bucket: 'spendable_reserves', owner: 'Aoife' },
    { amount: 15000, bucket: 'spendable_reserves', owner: 'Ben' },
    { amount: 90000, bucket: 'retirement_funding', owner: 'Aoife' },
    { amount: 50000, bucket: 'retirement_funding', owner: 'Ben' }
  ], liabilities: [250000] }, { partner: true }),
  scenario('liquidity-cash-boundary-question', 'liquidity_analysis', [
    'What would help today?',
    'I only want to check how long our cash would keep us going if I lost my job. I work full time and my wife works too.',
    'How much cash can you access?',
    'My savings is 18 thousand and my wife has 12 thousand. We are counting both. There is also 2 thousand in our joint current account. Those are separate accounts and all our cash. Our home is worth 400 thousand and pension 80 thousand, but we cannot spend those.',
    'What do you spend per month?',
    'Roughly 3200 all in. Is the mortgage balance taken off the cash?',
    'This check compares available cash with spending. It does not subtract the balance of a long-term mortgage.',
    'Okay. I checked the joint current account: it is 3000, not 2000. Keep spending at about 3200. Neither of us is retired. That is all for this check.'
  ], { values: { currentCash: 33000, monthlyExpenditure: 3200, annualExpenditure: 38400, clientStatus: 'not-retired' } }, { partner: true }),
  scenario('mortgage-correction-hypothetical', 'mortgage_analysis', [
    'What are you hoping to work out?',
    'I want to review our existing home mortgage, jointly held by me, Aoife, and Ben. The balance is about 240 grand, rate 4.5 percent and 22 years remaining. It is repayment.',
    'What changes would you like to explore?',
    'I checked the rate and it is actually 4.1 percent. Maybe if rates reached 6 percent someday that would be scary, but do not use 6. Show what paying 500 extra a year does. No lump sum overpayment and no fixed payment amount for this illustration.',
    'Keep the current 4.1 percent rate for this comparison?',
    'Yes. The mortgage is still about 240000, 4.1 percent, 22 years. Use the normal calculation date and compare the 500 a year overpayment.'
  ], { values: { currentBalance: 240000, annualInterestRate: 0.041, remainingTermYears: 22, annualOverpayment: 500, oneOffOverpayment: 0, loanKind: 'mortgage' } }, { partner: true }),
  scenario('loan-similar-names-change-mind', 'loan_analysis', [
    'What would you like to look at?',
    'We have two car loans. My car loan has 18000 left at 8.5 percent over four years. Ben\'s car loan is 9000 at 7 percent over two years. We want to look only at mine; I am Aoife.',
    'What would you like to change on your loan?',
    'Could we try paying 1000 extra each year? Actually, make that 500 a year, not 1000. No lump sum. Do not include Ben\'s loan or our mortgage.',
    'Is your remaining term confirmed?',
    'Yes, I have the statement now: my balance is 18000, the rate is 8.5 percent and exactly four years remain. Normal repayment loan, no fixed monthly payment supplied for the illustration. Only the extra 500 each year.'
  ], { values: { currentBalance: 18000, annualInterestRate: 0.085, remainingTermYears: 4, annualOverpayment: 500, oneOffOverpayment: 0, loanKind: 'loan' } }, { partner: true }),
  scenario('college-distinct-children-correction', 'college_funding', [
    'What would help you plan?',
    'We want to see the future college costs for our two children, Anna and Anne. Anna is twelve and Anne is eight. They are two different children.',
    'What ages and course lengths should we use?',
    'Anna would start at eighteen for four years, Anne at nineteen for five years. Sorry, Anna just had her birthday, so she is thirteen now, not twelve.',
    'Do you know whether they will live at home or away?',
    'I do not know and we should not choose one. Please compare all your standard cost scenarios for both children. There are no other children to include. Use the standard education inflation and costs.'
  ], { children: [{ title: 'Anna', currentAge: 13, collegeStartAge: 18, collegeDurationYears: 4 },
    { title: 'Anne', currentAge: 8, collegeStartAge: 19, collegeDurationYears: 5 }] }),
  scenario('pension-partners-contributions-correction', 'pension_projection', [
    'What would you like to work out?',
    'Can our pensions support a gross household income of 60000 a year in today\'s money from 2052? I am Aoife, 42, and Ben is 40. I retire at 67 and Ben at 66. Use target income, not a maximum affordable income comparison.',
    'What are your salaries, pension pots and contributions?',
    'My salary is 80000, my pot is 180000, I pay 8 percent of salary and my employer pays 6 percent. Ben earns 60000, his pot is 120000, he pays 7 percent and his employer pays 5 percent. We are both employees.',
    'Any corrections, other pensions or future retirement income?',
    'I checked: Ben\'s pot is 125000, not 120000. Those are our only pension funds. No defined benefit pensions, rental income, annuities or other retirement income. Include the full Irish State Pension for both from age 66 as a planning assumption. Use your standard growth, inflation and salary growth, and plan to age 100. The target stays 60000 from 2052.'
  ], { values: { incomeMode: 'target', targetIncomeToday: 60000, targetStartYear: 2052 },
    pensions: [{ title: 'Aoife', currentAge: 42, retirementAge: 67, currentSalary: 80000, currentPot: 180000, personalPct: 0.08, employerPct: 0.06 },
      { title: 'Ben', currentAge: 40, retirementAge: 66, currentSalary: 60000, currentPot: 125000, personalPct: 0.07, employerPct: 0.05 }] }, { partner: true }),
  scenario('house-joint-cash-ringfence-unknown-schemes', 'house_purchase', [
    'What would you like to plan?',
    'Our first home purchase together. I am Aoife, age 34, and Ben is 35. We have never owned property anywhere, neither retains an interest in any property, and both have the right to reside in Ireland. We are first time buyers applying jointly. We both have permanent employee jobs with stable income. My gross basic salary is 68000 and his is 52000, with no bonuses or variable income.',
    'Tell me about cash and other commitments.',
    'I have 40000 saved and Ben has 30000. Include both, separately owned, total 70000. We have no other savings to include. Protect 10000 for another goal, separately from an emergency reserve that I want you to suggest. We have no debt repayments, other commitments or dependants and no lump sums expected. We currently save 1800 a month and intend to keep doing that.',
    'What property and household spending should this cover?',
    'A second hand house around 420000, Dublin City, to be our main home in June 2028. Our take-home household income is 6900 per month, essential spending excluding rent and debts is 2700, rent is 2100 and allow 200 a month for homeownership costs. We have not received a tenant notice.',
    'Do you have a lender amount or any confirmed support?',
    'No approval in principle, no lender amount, no chosen lender and no confirmed lending exception or maximum borrowing. We have not applied for the First Home Scheme and have no confirmed equity or site equity. No Help to Buy claim is confirmed; I do not know the tax compliance or four-year tax figure and do not know about an approved developer. Keep those unknown. Please use the standard cost and rate assumptions. Actually change the target price to 410000; everything else stays as I said.'
  ], { values: { applicationType: 'joint', lendingCategory: 'first_time_buyer', currentCashSavings: 70000,
    amountRingfencedForOtherGoals: 10000, currentMonthlySavings: 1800, plannedMonthlySavings: 1800,
    targetPropertyPrice: 410000, targetPurchaseDate: '2028-06-30', monthlyNetHouseholdIncome: 6900,
    monthlyEssentialExpensesExcludingHousingDebtAndRent: 2700, currentMonthlyRent: 2100,
    'helpToBuy/confirmedClaimAmount': 0, 'helpToBuy/expectedIncomeTaxAndDirtPaidPriorFourYears': null,
    'firstHomeScheme/confirmedEquityAmount': 0, 'lenderCapacity/amount': null },
    applicants: [{ label: 'Aoife', age: 34, grossAnnualIncome: 68000, cash: 40000 },
      { label: 'Ben', age: 35, grossAnnualIncome: 52000, cash: 30000 }] }, { partner: true }),
  scenario('pbs-open-collection-must-wait', 'personal_balance_sheet', [
    'What would you like?', 'Show my overall net worth. I have 20000 in savings.',
    'Anything else you own or owe?', 'Hang on, I need to check. I have a pension and might have another account. I have not told you about all my debts yet.'
  ], {}, { ready: false }),
  scenario('mortgage-doubt-must-wait', 'mortgage_analysis', [
    'What would you like?', 'Review my mortgage. Balance 240000, 22 years left, repayment, no overpayments.',
    'Do you know the interest rate?', 'Maybe 4.1 percent, I think, but I am not sure at all. Please do not treat that as confirmed.'
  ], {}, { ready: false, unknownPath: '/annualInterestRate' }),
  scenario('mortgage-acknowledged-unknown-must-wait', 'mortgage_analysis', [
    'What would you like?', 'Review my mortgage. Balance 240000, 22 years left, repayment, no overpayments.',
    'What is the rate?', 'I do not know the interest rate and cannot check it now.'
  ], {}, { ready: false, unknownPath: '/annualInterestRate', acknowledgedUnknown: [{ moduleId: 'mortgage_analysis', path: '/annualInterestRate', sourceTurnId: 'c2' }] }),
  scenario('mortgage-acknowledged-unknown-recovered', 'mortgage_analysis', [
    'What would you like?', 'Review my mortgage. Balance 240000, 22 years left, repayment, no overpayments.',
    'What is the rate?', 'I do not know the interest rate and cannot check it now.',
    'We can leave that mortgage review unavailable until you have the rate.',
    'Actually I found the statement. The mortgage interest rate is definitely 4.1 percent. Use that rate for the 240000 balance over 22 years with no overpayments.'
  ], { values: { currentBalance: 240000, annualInterestRate: 0.041, remainingTermYears: 22 } },
  { acknowledgedUnknown: [{ moduleId: 'mortgage_analysis', path: '/annualInterestRate', sourceTurnId: 'c2' }], resolved: '/annualInterestRate' })
];

// Keep the original colloquial ownership wording and its expectation intact.
// This separate case isolates ownership wording from correction/hypothetical
// handling; it must not replace or conceal the original case's result.
const mortgageIndex = FIRST20_SEMANTIC_CORPUS.findIndex((item) => item.id === 'mortgage-correction-hypothetical');
const originalMortgage = FIRST20_SEMANTIC_CORPUS[mortgageIndex];
FIRST20_SEMANTIC_CORPUS.splice(mortgageIndex + 1, 0, {
  ...originalMortgage,
  id: 'mortgage-explicit-joint-ownership-correction',
  turns: originalMortgage.turns.map((turn) => turn.id === 'c1' ? {
    ...turn,
    transcript: 'I am Aoife. I want to review our existing home mortgage, jointly held by Ben and me. The balance is about 240 grand, rate 4.5 percent and 22 years remaining. It is repayment.'
  } : { ...turn })
});
