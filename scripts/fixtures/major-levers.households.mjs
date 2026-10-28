// Entirely made-up supplements to #97's invented near-retirement household.
// Property tax facts, essential spending and separate bank income are review
// facts, not answers manufactured by the production form bridge.
import { readFileSync } from 'node:fs';
import { reviewedRouteExample } from './form-to-plan-reviewed.mjs';
const fixtures = JSON.parse(readFileSync(new URL('./form-to-profile.households.json', import.meta.url)));
const eur = amount => ({ amount, currency: 'EUR' });
export function majorHouseholds() {
  const profile = reviewedRouteExample(fixtures[2]).profile;
  const home = profile.properties.find(p => p.use === 'home');
  home.currentValue = eur(800000); home.homeUse = 'throughout'; home.jointEqualOwnership = true;
  home.ownerIds = ['primary', 'partner'];
  home.associatedLiabilityIds = ['fictional_home_loan'];
  profile.liabilities.push({ liabilityId: 'fictional_home_loan', type: 'mortgage', label: 'Invented home loan', ownerIds: ['primary'],
    currentBalance: eur(60000), monthlyPayment: eur(600), annualInterestRate: 0.04, remainingTermMonths: 120 });
  profile.assumptions.values.mortgage = { liabilityId: 'fictional_home_loan' };
  profile.goals.find(g => g.goalId === 'fictional_dated_cost').targetAmount = eur(400000);
  const rental = structuredClone(profile);
  rental.incomeSources[0].netAnnual = eur(50000); rental.incomeSources[1].netAnnual = eur(40000);
  rental.assumptions.values.planPack.planningInputs.takeHomeBasis = 'after_personal_pension';
  rental.incomeSources.push({ incomeId: 'fictional_rent', type: 'rental', label: 'Invented rental receipts', ownerIds: ['primary'], grossAnnual: eur(18000), netAnnual: eur(12000) });
  rental.properties.push({ propertyId: 'fictional_rental', use: 'rental', label: 'Invented second property', ownerIds: ['primary'],
    currentValue: eur(300000), baseCost: eur(150000), acquisitionDate: '2006-05-02', acquiredBy: 'purchase', homeUse: 'never',
    associatedLiabilityIds: ['fictional_rental_loan'], rentalIncomeSourceIds: ['fictional_rent'], rentAnnual: eur(18000),
    runningCostsAnnual: eur(2500), taxOnRentalProfitAnnual: eur(6000) });
  rental.liabilities.push({ liabilityId: 'fictional_rental_loan', type: 'mortgage', label: 'Invented rental loan', ownerIds: ['primary'],
    currentBalance: eur(50000), monthlyPayment: eur(400), annualInterestRate: 0.04, remainingTermMonths: 180 });
  rental.expenses.annualTotal.amount += 7300;
  rental.goals.find(g => g.goalId === 'fictional_dated_cost').targetAmount = eur(100000);
  return { tradeDown: profile, rental };
}
