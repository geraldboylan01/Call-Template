/**
 * Income tax (brief, 4.2, 4.3 and 4.6).
 *
 * One liability per assessment. A jointly assessed couple is one assessment on
 * their total income, with the standard rate band raised by the lower earner's
 * income up to the cap; because that increase can never exceed the lower
 * earner's income, this gives the same result as Revenue's allocation. Two
 * people assessed as single are two separate assessments.
 *
 * The ring-fenced standard-rate slice of a lump sum never reaches this head.
 * The Schedule E part does, as ordinary income for the year.
 *
 * Nursing home fees a person pays themselves (never the HSE's share) are a
 * deduction from total income, so they are relieved at the payer's marginal
 * rate: 40% on the part of their income taxed at the higher rate, 20% below it
 * (Revenue, TDM Part 15-01-12, section 4). They change income tax only. For a
 * jointly assessed couple the deduction comes off the couple's combined income.
 * The age exemption and the standard rate band's increase are tested on income
 * before the deduction, which never gives more relief than the Manual shows.
 */

const INCOME_TAX_HEAD_ID = 'income_tax';

/**
 * Income that is taxed: every Phase 1 type, with employment after pension
 * contributions. Illness Benefit is the recipient's own taxable income, so it
 * counts towards the recipient's income for the extra band a couple gets.
 */
function taxableIncome(income) {
  return income.statePension
    + income.occupationalPension
    + income.arfDistribution
    + Math.max(0, income.employment - income.employmentPensionContribution)
    + income.rentalProfit
    + income.illnessBenefit
    + income.lumpSumScheduleE;
}

/**
 * Income that earns the employee (PAYE) credit. Rental profit does not.
 * Employment counts after pension contributions, as taxable pay. Illness
 * Benefit earns the recipient's own credit, which does not pass to anyone else.
 */
function employeeCreditIncome(income) {
  return income.statePension
    + income.occupationalPension
    + income.arfDistribution
    + Math.max(0, income.employment - income.employmentPensionContribution)
    + income.illnessBenefit
    + income.lumpSumScheduleE;
}

function bandFor(unit, rules, incomes) {
  const band = rules.incomeTax.standardRateBand;
  if (unit.basis === 'single') {
    return { band: band.single, increase: 0 };
  }
  if (unit.basis === 'widowed') {
    return { band: band.widowed, increase: 0 };
  }
  const bothHaveIncome = incomes.length === 2 && incomes.every((amount) => amount > 0);
  const increase = bothHaveIncome
    ? Math.min(band.secondIncomeIncreaseMax, Math.min(...incomes))
    : 0;
  return { band: band.marriedOneIncome + increase, increase };
}

function creditKey(basis) {
  return basis === 'joint' ? 'married' : basis;
}

function assessUnit(unit, rules) {
  const it = rules.incomeTax;
  const exemption = rules.ageExemption;
  const ruleId = it.ruleId;
  const lines = [];
  const disclosures = [];
  const incomes = unit.people.map((person) => taxableIncome(person.income));
  const totalIncome = incomes.reduce((total, amount) => total + amount, 0);
  const { band, increase } = bandFor(unit, rules, incomes);

  // Fees paid come off total income, and never below nothing: with no income
  // taxed there is no tax to relieve, so the relief is nil.
  const nursingHomeExpenses = unit.people.reduce((total, person) => total + person.income.nursingHomeExpenses, 0);
  const incomeAfterNursingHome = Math.max(0, totalIncome - nursingHomeExpenses);

  const atStandardRate = Math.min(incomeAfterNursingHome, band);
  const atHigherRate = Math.max(0, incomeAfterNursingHome - band);
  const grossTax = (atStandardRate * it.standardRate) + (atHigherRate * it.higherRate);
  const personIds = unit.people.map((person) => person.id);
  const unitPersonId = personIds.length === 1 ? personIds[0] : null;

  lines.push(
    { head: INCOME_TAX_HEAD_ID, ruleId, personId: unitPersonId, kind: 'charge', label: 'Income tax at the standard rate', base: atStandardRate, rate: it.standardRate, amount: atStandardRate * it.standardRate },
    { head: INCOME_TAX_HEAD_ID, ruleId, personId: unitPersonId, kind: 'charge', label: 'Income tax at the higher rate', base: atHigherRate, rate: it.higherRate, amount: atHigherRate * it.higherRate }
  );

  const key = creditKey(unit.basis);
  const personalCredit = it.personalCredit[key];
  const employeeCredits = unit.people.map((person) => {
    const qualifying = employeeCreditIncome(person.income);
    return qualifying > 0
      ? Math.min(it.employeeCredit.amount, it.employeeCredit.maxShareOfQualifyingIncome * qualifying)
      : 0;
  });
  const reaches65 = unit.people.some((person) => person.age >= it.ageCredit.fromAge);
  const ageCredit = reaches65 ? it.ageCredit[key] : 0;
  const totalCredits = personalCredit + employeeCredits.reduce((total, amount) => total + amount, 0) + ageCredit;

  lines.push({ head: INCOME_TAX_HEAD_ID, ruleId, personId: unitPersonId, kind: 'credit', label: 'Personal tax credit', base: null, rate: null, amount: -personalCredit });
  unit.people.forEach((person, index) => {
    if (employeeCredits[index] > 0) {
      lines.push({ head: INCOME_TAX_HEAD_ID, ruleId: it.employeeCredit.ruleId, personId: person.id, kind: 'credit', label: 'Employee (PAYE) tax credit', base: null, rate: null, amount: -employeeCredits[index] });
    }
  });
  if (ageCredit > 0) {
    lines.push({ head: INCOME_TAX_HEAD_ID, ruleId: it.ageCredit.ruleId, personId: unitPersonId, kind: 'credit', label: 'Age tax credit', base: null, rate: null, amount: -ageCredit });
  }

  const normalTax = Math.max(0, grossTax - totalCredits);
  let incomeTax = normalTax;
  let ageRelief = null;

  const exemptionApplies = unit.people.some((person) => person.age >= exemption.fromAge);
  if (exemptionApplies) {
    const limit = exemption.limit[key];
    if (totalIncome <= limit) {
      incomeTax = 0;
      ageRelief = { kind: 'exemption', limit };
      if (totalIncome > 0) {
        disclosures.push({ code: 'IT_AGE_EXEMPTION', params: { years: [rules.year] } });
      }
    } else if (totalIncome <= limit * exemption.marginalReliefCeilingMultiple) {
      const capped = exemption.marginalReliefRate * (totalIncome - limit);
      if (capped < normalTax) {
        incomeTax = capped;
        ageRelief = { kind: 'marginal', limit };
        disclosures.push({ code: 'IT_MARGINAL_RELIEF', params: { years: [rules.year] } });
      }
    }
    if (ageRelief && normalTax > incomeTax) {
      lines.push({
        head: INCOME_TAX_HEAD_ID,
        ruleId: exemption.ruleId,
        personId: unitPersonId,
        kind: 'relief',
        label: ageRelief.kind === 'exemption' ? 'Over-65 exemption' : 'Over-65 marginal relief',
        base: totalIncome,
        rate: null,
        amount: incomeTax - normalTax
      });
    }
  }

  if (unit.people.some((person) => person.income.rentalProfit > 0)) {
    disclosures.push({ code: 'RENT_AS_ENTERED' });
  }
  if (nursingHomeExpenses > 0) {
    disclosures.push({ code: 'IT_NURSING_HOME_RELIEF', params: { years: [rules.year] } });
  }
  if (unit.people.some((person) => person.income.illnessBenefit > 0)) {
    disclosures.push({ code: 'IT_ILLNESS_BENEFIT' });
  }

  return {
    assessment: {
      basis: unit.basis,
      personIds,
      totalIncome,
      nursingHomeExpenses,
      incomeAfterNursingHome,
      standardRateBand: band,
      bandIncrease: increase,
      grossTax,
      credits: {
        personal: personalCredit,
        employee: Object.fromEntries(personIds.map((id, index) => [id, employeeCredits[index]])),
        age: ageCredit,
        total: totalCredits
      },
      normalTax,
      ageRelief,
      incomeTax
    },
    lines,
    disclosures
  };
}

export const incomeTaxHead = Object.freeze({
  id: INCOME_TAX_HEAD_ID,
  phase: 'income',
  compute(context) {
    const lines = [];
    const disclosures = [];
    const assessments = context.assessmentUnits.map((unit) => {
      const outcome = assessUnit(unit, context.rules);
      lines.push(...outcome.lines);
      disclosures.push(...outcome.disclosures);
      return outcome.assessment;
    });
    return {
      lines,
      disclosures,
      assessments,
      total: assessments.reduce((total, assessment) => total + assessment.incomeTax, 0)
    };
  }
});
