// Synthetic holdouts authored independently of the extraction/repair prompts.
// Only turns/profile metadata belong in model requests. Never send expected,
// semanticRubric, or the assertions below to either planner or verifier.
import assert from 'node:assert/strict';

function turnsFromScript(lines) {
  return lines.map((transcript, i) => ({
    id: `${i % 2 ? 'c' : 'a'}${Math.floor(i / 2) + 1}`,
    role: i % 2 ? 'user' : 'assistant', transcript,
    answersTurnId: i % 2 ? `a${Math.floor(i / 2) + 1}` : null
  }));
}
const scenario = (id, moduleId, lines, expected, extra = {}) => ({
  id, moduleId, turns: turnsFromScript(lines), expected, ready: true, ...extra
});

export const AI_LED_HOLDOUTS = [
  scenario('holdout-pbs-equal-balances-owner-swap', 'personal_balance_sheet', [
    'What would help today?',
    'I am Aoife and my spouse is Ben. Please show our household net worth. We have two separate savings accounts, each with 25000: the AIB account is mine and the Bank of Ireland account is Ben\'s. We jointly own our home worth 400000 with a joint mortgage of 150000.',
    'Anything else you own or owe, and what is your monthly spending?',
    'No other accounts, pensions, investments, businesses, properties, assets or debts. We spend 3000 a month. That is the complete list.',
    'Anything to correct before I read it back?',
    'Yes, I swapped the owners of the savings accounts. Ben alone owns the AIB account; I alone own the Bank of Ireland account. Each account still has 25000 and they are separate accounts. The home and mortgage are still joint. Everything else stays the same. Go ahead.'
  ], { values: { monthlyExpenditure: 3000 } }, { partner: true,
    semanticRubric: 'Two distinct cash accounts of 25000 survive. The current AIB owner is Ben and current Bank of Ireland owner is Aoife. The ownership correction must survive even though all amounts and the 300000 net worth remain unchanged. Home and mortgage remain joint.' }),

  scenario('holdout-mortgage-fresh-uncertainty', 'mortgage_analysis', [
    'Which borrowing would you like to review?',
    'My existing home mortgage: balance 240000, 22 years remaining, repayment mortgage, annual rate 4.1 percent. No annual or lump sum overpayments and no fixed payment amount for the illustration.',
    'I can use that rate for the illustration. Anything to correct?',
    'Stop: I was reading an old rate letter. I do not know the current interest rate and cannot check now. Do not use 4.1 percent or any guessed rate. The balance and remaining term are current and correct.'
  ], { values: { currentBalance: 240000, remainingTermYears: 22, annualInterestRate: null } },
  { ready: false, unknownPath: '/annualInterestRate',
    semanticRubric: 'The later uncertainty withdraws support for 4.1 percent. Keep the confirmed balance and term, but do not certify or execute the mortgage. Asking for the unavailable current rate is safe but less helpful than acknowledging that the review must wait.' }),

  scenario('holdout-pbs-reopened-collection', 'personal_balance_sheet', [
    'What would you like to understand?',
    'My net worth. I have 20000 in savings and a pension pot of 90000, and I owe 7000 on a personal loan. I have no home, investments, business or other assets and no other debts. Spending is 2500 per month. That is everything, please proceed.',
    'Before I read that back, is there anything else?',
    'Wait, do not go ahead yet. I found an account I have not checked, and there may also be another debt. The figures I already gave you are right, but my list is no longer complete. I need to check both before you total my net worth.'
  ], { values: { monthlyExpenditure: 2500 } }, { ready: false,
    semanticRubric: 'The final turn reopens assets and liabilities after explicit closure. Preserve the known 20000 savings, 90000 pension and 7000 loan as known information; do not invent the new account/debt, certify completeness, or produce a ready net-worth plan.' }),

  scenario('holdout-mortgage-competing-corrections', 'mortgage_analysis', [
    'What would you like to review?',
    'My one home mortgage, repayment, 240000 outstanding at 4.1 percent with 22 years left. No overpayments and no fixed monthly payment supplied for the illustration.',
    'Are those figures up to date?',
    'I found a statement showing 232000 instead of 240000. Use 232000; the rate and term are unchanged.',
    'Anything else to check?',
    'There is another statement for this same mortgage showing 238000. I cannot tell which statement is current. Neither 232000 nor 238000 is confirmed, and 240000 was my old estimate. Do not pick a balance for me. I will need to ask the lender.'
  ], { values: { currentBalance: null, annualInterestRate: 0.041, remainingTermYears: 22 } },
  { ready: false, unknownPath: '/currentBalance',
    semanticRubric: 'The newest number is not an accepted correction: the client explicitly cannot establish which of two statements is current. Balance must remain unknown; rate and term retain support. No certificate or execution, and no default to 238000, 232000 or the superseded estimate.' }),

  scenario('holdout-loan-changed-selected-borrower', 'loan_analysis', [
    'What would you like to review?',
    'I am Aoife. I have a car loan with 18000 outstanding at 8.5 percent, four years remaining. My spouse Ben has a separate car loan of 9000 at 7 percent, two years remaining. Both are normal repayment loans. Review only my loan and try 500 extra each year, with no lump sum and no fixed monthly payment supplied.',
    'Anything to change before I read that back?',
    'Actually, switch the review completely to Ben\'s car loan. Do not review mine. His current figures are definitely 9000 outstanding, 7 percent a year and exactly two years remaining. For his loan use no annual overpayment and no lump sum; do not carry over the extra 500 from my loan. No fixed payment amount for his illustration either.'
  ], { values: { currentBalance: 9000, annualInterestRate: 0.07, remainingTermYears: 2,
    annualOverpayment: 0, oneOffOverpayment: 0, loanKind: 'loan' } }, { partner: true,
    semanticRubric: 'The selected entity changes from Aoife to Ben, not just the amount. All execution inputs belong to Ben. The confirmation must identify Ben\'s loan and must not describe it as Aoife\'s; the abandoned 500 annual overpayment must not survive.' })
];

// Return the same {name,pass,message?} records as the existing FIRST20 runner.
// These are additional checks: retain the runner's selected-module, native
// values, certificate authentication, and (for ready cases) execution checks.
export function checkAiLedHoldout(test, result) {
  if (!test.id.startsWith('holdout-')) return [];
  const checks = [];
  const check = (name, work) => {
    try { work(); checks.push({ name, pass: true }); }
    catch (error) { checks.push({ name, pass: false, message: error.message }); }
  };
  const snapshot = result?.snapshot;
  const row = snapshot?.modules?.find((item) => item.moduleId === test.moduleId);
  const input = row?.input || {};
  if (!test.ready) check('holdout: withdrawn certainty or completeness blocks certification', () => {
    assert.ok(['collecting', 'needs_clarification'].includes(row?.status), `Unexpected status ${row?.status}`);
    assert.equal(result?.certificate ?? null, null);
  });
  if (test.id === 'holdout-pbs-equal-balances-owner-swap') {
    check('holdout: equal-value accounts retain corrected distinct owners', () => {
      const assets = input.assetPositions || [];
      assert.equal(assets.length, 3);
      assert.equal(new Set(assets.map((item) => `${item.source}:${item.id}`)).size, 3);
      const cash = assets.filter((item) => item.bucket === 'spendable_reserves');
      assert.equal(cash.length, 2);
      assert.ok(cash.every((item) => item.amount === 25000));
      const aib = cash.filter((item) => /\bAIB\b/i.test(item.label));
      const boi = cash.filter((item) => /Bank of Ireland|\bBOI\b/i.test(item.label));
      assert.equal(aib.length, 1, 'Expected one identifiable AIB account');
      assert.equal(boi.length, 1, 'Expected one identifiable Bank of Ireland account');
      assert.notEqual(aib[0].id, boi[0].id);
      assert.match(aib[0].label, /\bBen\b/i);
      assert.doesNotMatch(aib[0].label, /\bAoife\b/i);
      assert.match(boi[0].label, /\bAoife\b/i);
      assert.doesNotMatch(boi[0].label, /\bBen\b/i);
      assert.equal(assets.find((item) => item.bucket === 'lifestyle_assets')?.amount, 400000);
      assert.deepEqual((input.liabilityPositions || []).map((item) => item.amount), [150000]);
    });
  }
  if (test.id === 'holdout-pbs-reopened-collection') {
    check('holdout: reopening preserves known positions without inventing unchecked amounts', () => {
      const assets = input.assetPositions || [];
      assert.deepEqual(assets.filter((item) => item.bucket === 'spendable_reserves').map((item) => item.amount), [20000]);
      assert.deepEqual(assets.filter((item) => item.bucket === 'retirement_funding').map((item) => item.amount), [90000]);
      assert.equal(assets.length, 2);
      assert.deepEqual((input.liabilityPositions || []).map((item) => item.amount), [7000]);
    });
  }
  if (test.id === 'holdout-loan-changed-selected-borrower') {
    check('holdout: changed selected loan is identified in the confirmation', () => {
      assert.match(snapshot?.confirmationPrompt || '', /\bBen(?:['’]s)?\b/i);
    });
  }
  return checks;
}
