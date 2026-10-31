// Entirely invented supplements to #97's invented near-retirement household.
// These demonstrate facts established AFTER the v1 form, not answers that the
// form collects. No production intake or confirmation code is invoked here.
import { applicationToProfile } from '../../application_to_profile.js';

export function reviewedRouteExample(fixture) {
  const information = structuredClone(fixture.information);
  information.none = information.none.filter(scope => scope !== 'loans');
  information.loans = [{ type: 'car', balance: 3000, rate: 5, yearsLeft: 2, payment: 150 }];
  const profile = applicationToProfile(information, { revision: 7, confirmedAt: '2026-10-20T12:00:00.000Z', profileId: 'fictional-reviewed-routes' });
  const retire = profile.goals.find(goal => ['retire', 'retire_early', 'improve_pension'].includes(goal.type));
  const costId = 'fictional_dated_cost';
  retire.targetAmount = { amount: 32000, currency: 'EUR' };
  profile.expenses.monthlyEssential = { amount: 3000, currency: 'EUR' };
  for (const path of ['/expenses/monthlyEssential', `/goals/${profile.goals.indexOf(retire)}/targetAmount`]) {
    profile.fieldMetadata[path] = { source: 'user_confirmation', confidence: 'high', certainty: 'exact', confirmedByUser: true,
      capturedAt: profile.confirmedAt, note: 'Explicit invented supplemental review fact; not collected by the v1 form.' };
  }
  profile.goals.push({ goalId: costId, type: 'assess_decision', title: 'Invented dated cost', status: 'active', priority: 'medium',
    targetDate: '2028-10-20', targetAmount: { amount: 10000, currency: 'EUR' } });
  const investment = profile.assets.find(asset => asset.type === 'investment');
  investment.ownerIds = ['primary'];
  investment.baseCost = { amount: 30000, currency: 'EUR' };
  investment.sellingCosts = { amount: 0, currency: 'EUR' };
  investment.investmentTaxTreatment = 'ordinary_cgt';
  profile.assumptions.values.retirement.statePensionFraction = { primary: 0.7, partner: 1 };
  profile.assumptions.values.planPack = {
    planningInputs: { retirementIncomeBasis: 'net', goalSavingBasis: 'excluded_from_regular_costs', goalFundingLabel: 'Dated cost saving',
      goalBindings: [{ goalId: retire.goalId, personId: 'primary' }],
      goalFundingFacts: [{ goalId: costId, kind: 'dated_cost', currentAnnualSaving: 0, costKind: 'general', durationYears: 1,
        funding: 'save_then_pay', payerIds: ['primary', 'partner'] }] },
    goalFlexibility: { [retire.goalId]: { retirementAge: [65, 68], targetIncomeToday: [30000, 32000] } }
  };
  return { information, profile, retirementGoalId: retire.goalId, costId };
}
