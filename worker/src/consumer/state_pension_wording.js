/**
 * How the consumer lanes say the State Pension rule: in the spoken confirmation,
 * the reviewed explanation, and the prompts the models are given.
 *
 * Every amount, date and age comes from the rule handed in, which is
 * `publicIrishStatePensionRule(planYearOrDate)` for the plan's own year. Nothing
 * here is typed in, so the wording follows the register when a Budget changes the
 * rate, and a 2027 plan says what the Budget announced for 2027 while a 2026 plan
 * says what is in force.
 */

import { monthYearText } from '../../../js/planning/utils.js';

const amountText = (amount) => new Intl.NumberFormat('en-IE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
}).format(amount);

const percentText = (fraction) => `${Number((fraction * 100).toFixed(2))}%`;

/**
 * The pieces of wording for a rule, or null when the rule is missing any of what
 * a sentence needs. Callers then say nothing about the amount rather than guess
 * one.
 *
 * `effective` reads "effective January 2026" while the rate is in force, and
 * "effective January 2027, announced in Budget 2027" while it is only announced.
 */
export function statePensionWording(rule) {
  if (!rule
    || !Number.isFinite(rule.weeklyMaximumEur)
    || !Number.isFinite(rule.annualMaximumEur)
    || !Number.isFinite(rule.defaultStartAge)
    || !Number.isFinite(rule.defaultEscalationRate)
    || !/^\d{4}-\d{2}-\d{2}$/.test(rule.effectiveFrom ?? '')) {
    return null;
  }
  const announced = rule.status === 'announced' && rule.announcedBy;
  return Object.freeze({
    weeklyAmount: amountText(rule.weeklyMaximumEur),
    annualAmount: amountText(rule.annualMaximumEur),
    weekly: `€${amountText(rule.weeklyMaximumEur)}`,
    annual: `€${amountText(rule.annualMaximumEur)}`,
    effective: `effective ${monthYearText(rule.effectiveFrom)}${announced ? `, announced in ${rule.announcedBy}` : ''}`,
    startAge: rule.defaultStartAge,
    escalation: percentText(rule.defaultEscalationRate)
  });
}
