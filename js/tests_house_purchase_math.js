import {
  DEFAULT_HOUSE_PURCHASE_RULES,
  FHS_PRICE_CEILINGS,
  FHS_PRICE_CEILING_ROWS,
  HOUSE_PURCHASE_SCENARIO_OVERRIDE_KEYS,
  calculateStampDuty,
  computeHousePurchaseProjection,
  createDefaultHousePurchaseInputs,
  findFhsPriceCeiling,
  normalizeHousePurchaseInputs,
  sanitizeHousePurchaseScenarioOverrides,
  screenFirstHomeScheme,
  screenHelpToBuy
} from './house_purchase/engine.js';
import {
  exportPublishedSession,
  exportSession,
  importSession
} from './state.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function assertApprox(actual, expected, tolerance, message) {
  const delta = Math.abs(actual - expected);
  if (delta > tolerance) {
    throw new Error(`${message} (expected ${expected}, got ${actual}, delta ${delta})`);
  }
}

function assertThrows(fn, expectedText, message) {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert(error, `${message}: expected an error`);
  if (expectedText) {
    assert(String(error.message).includes(expectedText), `${message}: unexpected error ${error.message}`);
  }
}

function mergeInput(base, patch) {
  const merged = {
    ...base,
    ...patch,
    applicants: patch.applicants || base.applicants.map((entry) => ({ ...entry })),
    cashSavingsContributions: patch.cashSavingsContributions || base.cashSavingsContributions.map((entry) => ({ ...entry })),
    lumpSums: patch.lumpSums || base.lumpSums.map((entry) => ({ ...entry })),
    lenderCapacity: { ...base.lenderCapacity, ...(patch.lenderCapacity || {}) },
    purchaseCosts: { ...base.purchaseCosts, ...(patch.purchaseCosts || {}) },
    helpToBuy: { ...base.helpToBuy, ...(patch.helpToBuy || {}) },
    firstHomeScheme: { ...base.firstHomeScheme, ...(patch.firstHomeScheme || {}) }
  };
  if (Object.hasOwn(patch, 'currentCashSavings') && !Object.hasOwn(patch, 'cashSavingsContributions') && merged.applicationType === 'single') {
    merged.cashSavingsContributions = [{ ownerId: merged.applicants[0].id, amount: merged.currentCashSavings }];
  }
  return merged;
}

function makeInputs(patch = {}) {
  const defaults = createDefaultHousePurchaseInputs('2026-07-12');
  const base = mergeInput(defaults, {
    lendingCategory: 'first_time_buyer',
    applicants: [{
      ...defaults.applicants[0],
      age: 32,
      employmentStatus: 'employee',
      grossAnnualIncome: 80000,
      incomeReliability: 'stable',
      schemeBuyerStatus: 'first_time_buyer',
      previouslyOwnedPropertyAnywhere: false,
      retainedInterestInPreviousProperty: false,
      rightToResideInIreland: true
    }],
    currentCashSavings: 60000,
    cashSavingsContributions: [{ ownerId: 'applicant-1', amount: 60000 }],
    emergencyReserveMode: 'custom',
    emergencyReserveTarget: 0,
    currentMonthlySavings: 1000,
    plannedMonthlySavings: 1000,
    monthlyNetHouseholdIncome: 5000,
    monthlyEssentialExpensesExcludingHousingDebtAndRent: 1800,
    currentMonthlyRent: 1500,
    targetPropertyPrice: 400000,
    targetPurchaseDate: '2028-07-01',
    acquisitionType: 'new_build',
    dwellingType: 'house',
    localAuthorityCode: 'dublin_city',
    lenderCapacity: {
      status: 'confirmed',
      amount: 320000,
      lenderId: 'aib',
      isMaximumAvailable: true,
      macroPrudentialException: false,
      htbQualifyingLender: true
    },
    helpToBuy: {
      taxCompliant: true,
      revenueApprovedDeveloperOrApprover: true,
      expectedIncomeTaxAndDirtPaidPriorFourYears: 25000,
      confirmedClaimAmount: 0
    },
    firstHomeScheme: {
      applicationStatus: 'not_applied',
      confirmedEquityAmount: 0,
      siteEquity: 0
    }
  });
  return mergeInput(base, patch);
}

function runCase(name, fn) {
  try {
    fn();
    console.info(`[HousePurchaseTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[HousePurchaseTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

export function runHousePurchaseMathTests() {
  const cases = [];

  cases.push(runCase('Blank defaults are draft-safe and strict calculation rejects them', () => {
    const draft = createDefaultHousePurchaseInputs('2026-07-12');
    assertEqual(draft.emergencyReserveMode, 'suggested', 'Default reserve token mismatch');
    assertEqual(draft.lenderCapacity.status, 'not_obtained', 'Default lender token mismatch');
    assertEqual(draft.purchaseCosts.stampDutyMode, 'rules', 'Default stamp-duty token mismatch');
    assertEqual(normalizeHousePurchaseInputs(null, { allowPartial: true }), null, 'Partial null should remain null');
    assertThrows(() => normalizeHousePurchaseInputs(draft), 'targetPropertyPrice', 'Blank draft should not calculate');
  }));

  cases.push(runCase('Strict normalization enforces joint contribution totals and confirmed lender amount', () => {
    const first = makeInputs().applicants[0];
    const joint = makeInputs({
      applicationType: 'joint',
      applicants: [first, { ...first, id: 'applicant-2', label: 'Applicant 2', grossAnnualIncome: 50000 }],
      cashSavingsContributions: [
        { ownerId: 'applicant-1', amount: 20000 },
        { ownerId: 'applicant-2', amount: 20000 }
      ]
    });
    assertThrows(() => normalizeHousePurchaseInputs(joint), 'must total', 'Joint split mismatch should fail');
    assertThrows(() => normalizeHousePurchaseInputs(makeInputs({
      lenderCapacity: { status: 'confirmed', amount: null }
    })), 'amount is required', 'Confirmed lender status needs amount');
  }));

  cases.push(runCase('Scenario override contract is explicit and rejects unrelated keys', () => {
    ['targetPropertyPrice', 'targetPurchaseDate', 'plannedMonthlySavings', 'applicantIncomeById', 'supportCase']
      .forEach((key) => assert(HOUSE_PURCHASE_SCENARIO_OVERRIDE_KEYS.includes(key), `Missing override key ${key}`));
    assertThrows(
      () => computeHousePurchaseProjection(makeInputs(), { scenarioOverrides: { arbitraryOutput: 1 } }),
      'not a supported',
      'Unknown scenario key should fail'
    );
  }));

  cases.push(runCase('Transient scenario values restore the base and no-op overrides stay inactive', () => {
    const inputs = makeInputs();
    const noOps = sanitizeHousePurchaseScenarioOverrides({
      targetPropertyPrice: inputs.targetPropertyPrice,
      targetPurchaseDate: inputs.targetPurchaseDate,
      plannedMonthlySavings: inputs.plannedMonthlySavings,
      supportCase: 'none',
      includeVariableIncome: false
    }, inputs);
    assertEqual(Object.keys(noOps).length, 0, 'Base-equivalent and false variable-income values should not activate a what-if');
    assertEqual(
      sanitizeHousePurchaseScenarioOverrides({ supportCase: 'htb_only' }).supportCase,
      'htb_only',
      'Sanitizer default inputs should remain null-safe'
    );

    const sanitized = sanitizeHousePurchaseScenarioOverrides({
      targetPropertyPrice: 0,
      targetPurchaseDate: '',
      plannedMonthlySavings: Number.NaN,
      mortgageIllustrationRate: Infinity,
      mortgageTermYears: 0,
      applicantIncomeById: {
        'applicant-1': inputs.applicants[0].grossAnnualIncome,
        unknown: 90000
      },
      supportCase: 'unsupported',
      includeVariableIncome: false,
      arbitraryOutput: 1
    }, inputs);
    assertEqual(Object.keys(sanitized).length, 0, 'Invalid and base-equivalent values should restore the base');
    assert(computeHousePurchaseProjection(inputs, { scenarioOverrides: sanitized }).result, 'Sanitized override must remain calculable');

    const active = sanitizeHousePurchaseScenarioOverrides({
      targetPropertyPrice: inputs.targetPropertyPrice + 25000,
      applicantIncomeById: { 'applicant-1': inputs.applicants[0].grossAnnualIncome + 5000 },
      includeVariableIncome: true
    }, inputs);
    assertEqual(active.targetPropertyPrice, inputs.targetPropertyPrice + 25000, 'Valid price override should remain');
    assertEqual(active.applicantIncomeById['applicant-1'], inputs.applicants[0].grossAnnualIncome + 5000, 'Valid income override should remain');
    assertEqual(active.includeVariableIncome, true, 'Active variable-income scenario should remain');
  }));

  cases.push(runCase('Stamp duty uses the dated progressive bands and supports custom override', () => {
    assertEqual(calculateStampDuty(1000000), 10000, 'Duty at first breakpoint');
    assertEqual(calculateStampDuty(1500000), 20000, 'Duty at second breakpoint');
    assertEqual(calculateStampDuty(1600000), 26000, 'Duty above second breakpoint');
    assertEqual(calculateStampDuty(400000, { mode: 'custom', customStampDuty: 1234 }), 1234, 'Custom duty');
  }));

  cases.push(runCase('FHS ceiling data covers all 31 authorities and all property types', () => {
    assertEqual(FHS_PRICE_CEILINGS.length, 31, 'Authority count');
    assertEqual(FHS_PRICE_CEILING_ROWS.length, 93, 'Flattened ceiling-row count');
    const waterford = findFhsPriceCeiling('waterford');
    assertEqual(waterford.house, 400000, 'Waterford house ceiling');
    assertEqual(waterford.apartment, 450000, 'Waterford apartment ceiling');
    assertEqual(waterford.selfBuild, 400000, 'Waterford self-build ceiling');
    assert(FHS_PRICE_CEILINGS.every((entry) => entry.verifiedOn === '2026-07-11'), 'Every ceiling needs verification date');
  }));

  cases.push(runCase('Single first-time buyer can be income-aligned but deposit-limited', () => {
    const projection = computeHousePurchaseProjection(makeInputs({ currentCashSavings: 20000 }));
    assert(projection.result.capacities.standardMortgageCapacity >= 320000, 'Income capacity should support target mortgage');
    assert(projection.result.targetFunding.currentCashGap > 0, 'Expected cash gap');
    assert(projection.result.bottlenecks.all.some((entry) => entry.code === 'deposit_gap'), 'Deposit bottleneck missing');
  }));

  cases.push(runCase('Joint HTB fails when either purchaser is not a first-time purchaser', () => {
    const first = makeInputs().applicants[0];
    const inputs = makeInputs({
      applicationType: 'joint',
      applicants: [
        first,
        { ...first, id: 'applicant-2', label: 'Applicant 2', grossAnnualIncome: 50000, schemeBuyerStatus: 'previous_owner', previouslyOwnedPropertyAnywhere: true }
      ],
      currentCashSavings: 80000,
      cashSavingsContributions: [
        { ownerId: 'applicant-1', amount: 40000 },
        { ownerId: 'applicant-2', amount: 40000 }
      ]
    });
    const screen = screenHelpToBuy(inputs, { mortgageAmount: 320000 });
    assertEqual(screen.status, 'unlikely_eligible', 'Joint HTB status');
    assert(screen.failedCriteria.some((label) => label.includes('Every purchaser')), 'Buyer criterion should fail');
  }));

  cases.push(runCase('New build under 500k exposes potential HTB capped by tax paid', () => {
    const screen = screenHelpToBuy(makeInputs(), { mortgageAmount: 320000 });
    assertEqual(screen.status, 'potentially_eligible', 'HTB screen status');
    assertEqual(screen.maximumAmount, 25000, 'HTB tax-paid cap');
  }));

  cases.push(runCase('Second-hand property does not receive HTB', () => {
    const inputs = makeInputs({ acquisitionType: 'second_hand' });
    const screen = screenHelpToBuy(inputs, { mortgageAmount: 320000 });
    assertEqual(screen.status, 'unlikely_eligible', 'Second-hand HTB status');
    assertEqual(screen.potentialAmount, 0, 'Second-hand HTB amount');
  }));

  cases.push(runCase('Unknown prior-four-year tax produces an HTB range, not false certainty', () => {
    const screen = screenHelpToBuy(makeInputs({
      helpToBuy: { expectedIncomeTaxAndDirtPaidPriorFourYears: null }
    }), { mortgageAmount: 320000 });
    assertEqual(screen.maximumAmount, null, 'Unknown tax should not produce exact amount');
    assertEqual(screen.amountRange.maximum, 30000, 'HTB range cap');
    assertEqual(screen.taxPaidVerificationRequired, true, 'Tax verification flag');
  }));

  cases.push(runCase('Scheme criterion details describe their pass, fail and unknown states', () => {
    const htbPass = screenHelpToBuy(makeInputs(), { mortgageAmount: 320000 });
    assert(htbPass.criteria.every((entry) => entry.status === 'pass'), 'Baseline HTB facts should all pass');
    const htbPricePass = htbPass.criteria.find((entry) => entry.id === 'price_limit');
    assert(htbPricePass.detail.includes('is within'), 'Passing HTB price detail should describe the target as within the limit');
    assert(!htbPricePass.detail.includes('exceeds'), 'Passing HTB price detail must not describe a failure');

    const htbFail = screenHelpToBuy(makeInputs({ targetPropertyPrice: 600000 }), { mortgageAmount: 420000 });
    const htbPriceFail = htbFail.criteria.find((entry) => entry.id === 'price_limit');
    assertEqual(htbPriceFail.status, 'fail', 'HTB price should fail above the limit');
    assert(htbPriceFail.detail.includes('exceeds'), 'Failing HTB price detail should describe the exceeded limit');

    const htbUnknown = screenHelpToBuy(makeInputs({ helpToBuy: { taxCompliant: null } }), { mortgageAmount: 320000 });
    const htbTaxUnknown = htbUnknown.criteria.find((entry) => entry.id === 'tax_compliant');
    assertEqual(htbTaxUnknown.status, 'unknown', 'Missing tax-compliance fact should be unknown');
    assert(htbTaxUnknown.detail.startsWith('Confirm'), 'Unknown HTB detail should request the missing fact');

    const fhsPass = screenFirstHomeScheme(makeInputs(), {
      mortgageAmount: 300000,
      standardMortgageCapacity: 320000,
      ownDeposit: 40000
    });
    assert(fhsPass.criteria.every((entry) => entry.status === 'pass'), 'Baseline FHS facts should all pass');
    const fhsPricePass = fhsPass.criteria.find((entry) => entry.id === 'price_ceiling');
    assert(fhsPricePass.detail.includes('is within'), 'Passing FHS price detail should describe the target as within the ceiling');
    assert(!fhsPricePass.detail.includes('exceeds'), 'Passing FHS price detail must not describe a failure');

    const fhsFail = screenFirstHomeScheme(makeInputs({ localAuthorityCode: 'carlow' }), {
      mortgageAmount: 320000,
      standardMortgageCapacity: 320000,
      ownDeposit: 40000
    });
    const fhsPriceFail = fhsFail.criteria.find((entry) => entry.id === 'price_ceiling');
    assertEqual(fhsPriceFail.status, 'fail', 'FHS price should fail above the local ceiling');
    assert(fhsPriceFail.detail.includes('exceeds'), 'Failing FHS price detail should describe the exceeded ceiling');

    const tenantFail = screenFirstHomeScheme(makeInputs({
      acquisitionType: 'tenant_purchase',
      tenantNoticeReceived: false
    }), { mortgageAmount: 320000, standardMortgageCapacity: 320000, ownDeposit: 40000 });
    const tenantPropertyFail = tenantFail.criteria.find((entry) => entry.id === 'qualifying_property');
    assertEqual(tenantPropertyFail.status, 'fail', 'Tenant route should fail when the required notice was not received');
    assert(tenantPropertyFail.detail.includes('not received'), 'Tenant-route failure detail should reflect the negative answer');

    const fhsUnknown = screenFirstHomeScheme(makeInputs({ localAuthorityCode: '' }), {
      mortgageAmount: 320000,
      standardMortgageCapacity: 320000,
      ownDeposit: 40000
    });
    const fhsPriceUnknown = fhsUnknown.criteria.find((entry) => entry.id === 'price_ceiling');
    assertEqual(fhsPriceUnknown.status, 'unknown', 'Missing local authority should leave the FHS ceiling unknown');
    assert(fhsPriceUnknown.detail.includes('Select the local authority'), 'Unknown FHS price detail should request the local authority');
  }));

  cases.push(runCase('Fresh-start classification remains distinct between mortgage, HTB and FHS', () => {
    const applicant = {
      ...makeInputs().applicants[0],
      schemeBuyerStatus: 'fresh_start',
      previouslyOwnedPropertyAnywhere: true,
      retainedInterestInPreviousProperty: false
    };
    const inputs = makeInputs({
      lendingCategory: 'first_time_buyer',
      applicants: [applicant]
    });
    const projection = computeHousePurchaseProjection(inputs);
    assertEqual(projection.result.capacities.centralBankMultiple, 4, 'Fresh-start lending category must remain explicit');
    assertEqual(screenHelpToBuy(inputs, { mortgageAmount: 320000 }).status, 'unlikely_eligible', 'Fresh start must fail HTB first-purchaser test');
    const fhs = screenFirstHomeScheme(inputs, {
      mortgageAmount: 320000,
      standardMortgageCapacity: 320000,
      ownDeposit: 40000,
      htbAmount: 0
    });
    assert(fhs.criteria.find((entry) => entry.id === 'buyer_status').status === 'pass', 'Eligible fresh-start fact should pass FHS buyer screen');
  }));

  cases.push(runCase('Fresh-start retained interest blocks FHS and missing retained-interest fact requests information', () => {
    const fresh = { ...makeInputs().applicants[0], schemeBuyerStatus: 'fresh_start', previouslyOwnedPropertyAnywhere: true };
    const failed = screenFirstHomeScheme(makeInputs({ applicants: [{ ...fresh, retainedInterestInPreviousProperty: true }] }), {
      mortgageAmount: 320000, standardMortgageCapacity: 320000, ownDeposit: 40000
    });
    assertEqual(failed.criteria.find((entry) => entry.id === 'buyer_status').status, 'fail', 'Retained interest should fail');
    const unknown = screenFirstHomeScheme(makeInputs({ applicants: [{ ...fresh, retainedInterestInPreviousProperty: null }] }), {
      mortgageAmount: 320000, standardMortgageCapacity: 320000, ownDeposit: 40000
    });
    assertEqual(unknown.criteria.find((entry) => entry.id === 'buyer_status').status, 'unknown', 'Missing retained-interest fact should be unknown');
  }));

  cases.push(runCase('FHS with HTB accepts eligible gap below 20 percent', () => {
    const screen = screenFirstHomeScheme(makeInputs(), {
      mortgageAmount: 320000,
      standardMortgageCapacity: 320000,
      ownDeposit: 40000,
      htbAmount: 20000,
      usingHtb: true
    });
    assertEqual(screen.status, 'potentially_eligible', 'FHS+HTB screen');
    assertEqual(screen.maximumShare, 0.2, 'FHS+HTB max share');
    assertEqual(screen.fundingGap, 20000, 'FHS+HTB gap');
  }));

  cases.push(runCase('FHS without HTB accepts eligible gap below 30 percent', () => {
    const screen = screenFirstHomeScheme(makeInputs(), {
      mortgageAmount: 300000,
      standardMortgageCapacity: 320000,
      ownDeposit: 40000,
      htbAmount: 0,
      usingHtb: false
    });
    assertEqual(screen.status, 'potentially_eligible', 'FHS-only screen');
    assertEqual(screen.maximumShare, 0.3, 'FHS-only max share');
    assertEqual(screen.fundingGap, 60000, 'FHS-only gap');
  }));

  cases.push(runCase('FHS gap above maximum share is unlikely', () => {
    const screen = screenFirstHomeScheme(makeInputs(), {
      mortgageAmount: 200000,
      standardMortgageCapacity: 320000,
      ownDeposit: 40000,
      usingHtb: false
    });
    assertEqual(screen.status, 'unlikely_eligible', 'FHS excess gap status');
    assert(screen.failedCriteria.some((label) => label.includes('Funding gap')), 'Equity-range criterion should fail');
  }));

  cases.push(runCase('FHS property above local ceiling is unlikely', () => {
    const inputs = makeInputs({ targetPropertyPrice: 400000, localAuthorityCode: 'carlow' });
    const screen = screenFirstHomeScheme(inputs, {
      mortgageAmount: 320000,
      standardMortgageCapacity: 320000,
      ownDeposit: 40000
    });
    assertEqual(screen.status, 'unlikely_eligible', 'Above-ceiling status');
    assertEqual(screen.priceCeiling, 375000, 'Carlow ceiling');
  }));

  cases.push(runCase('Missing AIP, lender, local authority or dwelling is more-information-required', () => {
    const inputs = makeInputs({
      localAuthorityCode: '',
      dwellingType: 'unknown',
      lenderCapacity: { status: 'not_obtained', amount: null, lenderId: 'unknown', isMaximumAvailable: null, macroPrudentialException: null }
    });
    const screen = screenFirstHomeScheme(inputs, { mortgageAmount: 320000, standardMortgageCapacity: 320000, ownDeposit: 40000 });
    assertEqual(screen.status, 'more_information_required', 'Missing FHS facts status');
    assert(screen.unansweredCriteria.length >= 3, 'Expected several unanswered criteria');
  }));

  cases.push(runCase('FHS minimum, maximum and service-charge boundaries are exact', () => {
    const rules = DEFAULT_HOUSE_PURCHASE_RULES.firstHomeScheme;
    assertEqual(Math.max(rules.minimumEquityAmount, 300000 * rules.minimumEquityShare), 10000, 'Minimum at 300k');
    assertEqual(Math.max(rules.minimumEquityAmount, 500000 * rules.minimumEquityShare), 12500, 'Minimum at 500k');
    assertEqual(rules.serviceChargeBands.find((band) => band.fromYear === 0).rate, 0, 'Years 0-5');
    assertEqual(rules.serviceChargeBands.find((band) => band.fromYear === 6).rate, 0.0175, 'Years 6-15');
    assertEqual(rules.serviceChargeBands.find((band) => band.fromYear === 16).rate, 0.0215, 'Years 16-29');
    assertEqual(rules.serviceChargeBands.find((band) => band.fromYear === 30).rate, 0.0285, 'Year 30+');
  }));

  cases.push(runCase('Protected reserve shortfall is refilled before purchase cash', () => {
    const projection = computeHousePurchaseProjection(makeInputs({
      currentCashSavings: 10000,
      emergencyReserveTarget: 20000,
      applicants: [{ ...makeInputs().applicants[0], grossAnnualIncome: 100000 }],
      targetPropertyPrice: 300000,
      helpToBuy: {
        expectedIncomeTaxAndDirtPaidPriorFourYears: 30000,
        confirmedClaimAmount: 30000
      }
    }));
    assertEqual(projection.result.protectedCash.shortfall, 10000, 'Reserve shortfall');
    assertApprox(
      projection.result.targetFunding.cashRequired,
      projection.result.targetFunding.purchaseCashRequired + 10000,
      0.01,
      'Timeline target must include reserve refill'
    );
    assertEqual(projection.result.bottlenecks.primary.code, 'emergency_reserve', 'Reserve bottleneck precedence');
  }));

  cases.push(runCase('Zero-rate deposit projection adds contributions without interest', () => {
    const projection = computeHousePurchaseProjection(makeInputs({
      currentCashSavings: 10000,
      plannedMonthlySavings: 500,
      depositSavingsGrossAer: 0,
      dirtRate: 0
    }));
    const month = projection.result.depositTimeline.series[1];
    assertEqual(month.interest, 0, 'Zero-rate interest');
    assertEqual(month.closingBalance, 10500, 'Zero-rate month-end balance');
  }));

  cases.push(runCase('Deposit interest is calculated after DIRT with monthly effective rate', () => {
    const projection = computeHousePurchaseProjection(makeInputs({
      currentCashSavings: 10000,
      plannedMonthlySavings: 0,
      depositSavingsGrossAer: 0.02,
      dirtRate: 0.33
    }));
    const expectedMonthlyRate = Math.pow(1 + 0.02 * 0.67, 1 / 12) - 1;
    assertApprox(projection.result.depositTimeline.netAer, 0.0134, 1e-12, 'Net AER');
    assertApprox(projection.result.depositTimeline.series[1].interest, 10000 * expectedMonthlyRate, 0.01, 'First-month interest');
  }));

  cases.push(runCase('Lump sums land at first eligible month-end and estimated sums stay excluded', () => {
    const projection = computeHousePurchaseProjection(makeInputs({
      calculationDateIso: '2026-01-15',
      plannedMonthlySavings: 0,
      lumpSums: [
        { id: 'past', amount: 1000, expectedDate: '2026-01-01', confidence: 'confirmed' },
        { id: 'month-end', amount: 2000, expectedDate: '2026-01-31', confidence: 'confirmed' },
        { id: 'future', amount: 3000, expectedDate: '2026-02-01', confidence: 'confirmed' },
        { id: 'estimate', amount: 9000, expectedDate: '2026-01-20', confidence: 'estimated' }
      ]
    }));
    assertEqual(projection.result.depositTimeline.series[1].dateIso, '2026-01-31', 'First period end');
    assertEqual(projection.result.depositTimeline.series[1].lumpSums, 3000, 'January lump sums');
    assertEqual(projection.result.depositTimeline.series[2].dateIso, '2026-02-28', 'February period end');
    assertEqual(projection.result.depositTimeline.series[2].lumpSums, 3000, 'February lump sum');
  }));

  cases.push(runCase('January 31 projection does not skip February', () => {
    const projection = computeHousePurchaseProjection(makeInputs({ calculationDateIso: '2026-01-31' }));
    assertEqual(projection.result.depositTimeline.series[1].dateIso, '2026-01-31', 'Current month end');
    assertEqual(projection.result.depositTimeline.series[2].dateIso, '2026-02-28', 'Next month end');
  }));

  cases.push(runCase('Same-month target uses month-end while past month gets explicit target-timeline state', () => {
    const sameMonth = computeHousePurchaseProjection(makeInputs({
      calculationDateIso: '2026-07-12',
      targetPurchaseDate: '2026-07-01'
    }));
    assertEqual(sameMonth.debug.targetMonths, 1, 'Same calendar month should be one contribution period');
    assertEqual(sameMonth.result.targetFunding.targetMonthEndIso, '2026-07-31', 'Same-month target EOM');
    const past = computeHousePurchaseProjection(makeInputs({
      calculationDateIso: '2026-07-12',
      targetPurchaseDate: '2026-06-30',
      currentCashSavings: 10000
    }));
    assertEqual(past.result.targetFunding.targetDateStatus, 'past', 'Past-date status');
    assert(past.result.bottlenecks.all.some((entry) => entry.code === 'target_timeline'), 'Past target should be timeline bottleneck');
  }));

  cases.push(runCase('Already-funded route reports calculation month-end as ready date', () => {
    const projection = computeHousePurchaseProjection(makeInputs({
      calculationDateIso: '2026-07-12',
      currentCashSavings: 200000,
      targetPropertyPrice: 250000,
      applicants: [{ ...makeInputs().applicants[0], grossAnnualIncome: 100000 }]
    }));
    assertEqual(projection.result.depositTimeline.status, 'already_funded', 'Already-funded status');
    assertEqual(projection.result.targetFunding.readyDateIso, '2026-07-31', 'Already-funded EOM');
  }));

  cases.push(runCase('Projection caps at 600 months and exposes out-of-horizon state', () => {
    const projection = computeHousePurchaseProjection(makeInputs({
      currentCashSavings: 0,
      plannedMonthlySavings: 0,
      applicants: [{ ...makeInputs().applicants[0], grossAnnualIncome: 10000 }],
      targetPropertyPrice: 1000000,
      lenderCapacity: { status: 'not_obtained', amount: null }
    }));
    assertEqual(projection.result.depositTimeline.series.length, 601, 'Projection row count');
    assertEqual(projection.result.depositTimeline.status, 'out_of_horizon', 'Projection horizon status');
    assertEqual(projection.result.targetFunding.readyDateIso, null, 'No ready date');
  }));

  cases.push(runCase('Deposit chart stays focused on the selected route while retaining the full search horizon', () => {
    const projection = computeHousePurchaseProjection(makeInputs({
      currentCashSavings: 200000,
      targetPropertyPrice: 250000,
      targetPurchaseDate: '2028-07-01',
      applicants: [{ ...makeInputs().applicants[0], grossAnnualIncome: 100000 }]
    }));
    const chart = projection.charts.find((entry) => entry.id === 'house-purchase-deposit-journey');
    assertEqual(projection.result.depositTimeline.series.length, 601, 'Full diagnostic horizon should remain available');
    assertEqual(chart.labels.at(-1), '2028-07-31', 'Chart should end at the selected target month');
    assert(chart.labels.length < projection.result.depositTimeline.series.length, 'Chart should not render the full 50-year horizon');
  }));

  cases.push(runCase('Mortgage illustration is zero-safe and includes 25/30/35-year rate sensitivity', () => {
    const projection = computeHousePurchaseProjection(makeInputs({ mortgageIllustrationRate: 0 }));
    assertApprox(projection.result.mortgage.monthlyPayment, projection.result.mortgage.principal / (35 * 12), 0.01, 'Zero-rate payment');
    assertEqual(projection.result.mortgage.sensitivity.length, 9, 'Sensitivity matrix size');
    assertEqual([...new Set(projection.result.mortgage.sensitivity.map((entry) => entry.termYears))].join(','), '25,30,35', 'Sensitivity terms');
    assert(projection.result.mortgage.sensitivity.some((entry) => entry.rate === 0.01), 'Higher-rate case missing');
  }));

  cases.push(runCase('Impossible target on current income is income-limited and out of horizon', () => {
    const projection = computeHousePurchaseProjection(makeInputs({
      applicants: [{ ...makeInputs().applicants[0], grossAnnualIncome: 20000 }],
      lenderCapacity: { status: 'not_obtained', amount: null },
      currentCashSavings: 20000,
      plannedMonthlySavings: 0,
      targetPropertyPrice: 700000
    }));
    assertEqual(projection.result.bottlenecks.primary.code, 'income_borrowing_capacity', 'Income bottleneck');
    assertEqual(projection.result.depositTimeline.status, 'out_of_horizon', 'Impossible target horizon');
  }));

  cases.push(runCase('Sufficient cash and income but weak headroom is monthly-affordability-limited', () => {
    const projection = computeHousePurchaseProjection(makeInputs({
      applicants: [{ ...makeInputs().applicants[0], grossAnnualIncome: 100000 }],
      currentCashSavings: 120000,
      targetPropertyPrice: 300000,
      monthlyNetHouseholdIncome: 2200,
      monthlyEssentialExpensesExcludingHousingDebtAndRent: 1500,
      currentMonthlyRent: 500,
      estimatedMonthlyOwnershipCosts: 300,
      lenderCapacity: { status: 'confirmed', amount: 250000 }
    }));
    assertEqual(projection.result.affordability.status, 'stretched', 'Affordability status');
    assertEqual(projection.result.bottlenecks.primary.code, 'monthly_affordability', 'Affordability bottleneck');
  }));

  cases.push(runCase('Tighter cash flow creates a warning affordability bottleneck', () => {
    const projection = computeHousePurchaseProjection(makeInputs({
      applicants: [{ ...makeInputs().applicants[0], grossAnnualIncome: 100000 }],
      currentCashSavings: 120000,
      targetPropertyPrice: 300000,
      monthlyNetHouseholdIncome: 5000,
      monthlyEssentialExpensesExcludingHousingDebtAndRent: 1600,
      currentMonthlyRent: 300,
      currentMonthlySavings: 100,
      estimatedMonthlyOwnershipCosts: 300,
      lenderCapacity: { status: 'confirmed', amount: 250000 }
    }));
    assertEqual(projection.result.affordability.status, 'tighter', 'Tighter status');
    const bottleneck = projection.result.bottlenecks.all.find((entry) => entry.code === 'monthly_affordability');
    assertEqual(bottleneck.status, 'warning', 'Tighter bottleneck tone');
  }));

  cases.push(runCase('Missing household cash-flow facts block funding-ready status', () => {
    const projection = computeHousePurchaseProjection(makeInputs({
      emergencyReserveMode: 'suggested',
      emergencyReserveTarget: null,
      monthlyNetHouseholdIncome: null,
      monthlyEssentialExpensesExcludingHousingDebtAndRent: null,
      currentMonthlyRent: null
    }));
    assertEqual(projection.result.bottlenecks.primary.code, 'insufficient_information', 'Missing-info bottleneck');
    assertEqual(projection.result.targetFunding.status, 'more_information_required', 'Funding-ready status');
    assertEqual(projection.result.targetFunding.readyDateIso, null, 'Funding-ready date should be suppressed');
    assert(projection.result.targetFunding.cashReadyDateIso !== null, 'Cash-only date should remain visible');
  }));

  cases.push(runCase('Variable income is excluded from base and included only by explicit scenario', () => {
    const inputs = makeInputs({
      applicants: [{
        ...makeInputs().applicants[0],
        grossAnnualIncome: 60000,
        variableAnnualIncome: 20000,
        lenderRecognisedVariableAnnualIncome: 0
      }],
      lenderCapacity: { status: 'not_obtained', amount: null }
    });
    const base = computeHousePurchaseProjection(inputs);
    const scenario = computeHousePurchaseProjection(inputs, { scenarioOverrides: { includeVariableIncome: true } });
    assertEqual(base.result.capacities.qualifyingIncome, 60000, 'Base qualifying income');
    assertEqual(scenario.result.capacities.qualifyingIncome, 80000, 'Scenario qualifying income');
    assertEqual(scenario.result.capacities.standardMortgageCapacity - base.result.capacities.standardMortgageCapacity, 80000, 'Capacity delta');
  }));

  cases.push(runCase('Potential support never changes standard current capacity', () => {
    const inputs = makeInputs();
    const base = computeHousePurchaseProjection(inputs);
    const htb = computeHousePurchaseProjection(inputs, { scenarioOverrides: { supportCase: 'htb_only' } });
    assertEqual(htb.result.capacities.currentSupportablePrice, base.result.capacities.currentSupportablePrice, 'Standard capacity must stay scheme-free');
    assert(htb.result.capacities.activeSupportablePrice > base.result.capacities.currentSupportablePrice, 'Active HTB scenario should show separate upside');
    assert(htb.result.fundingStack.potentialHtb > 0, 'Potential HTB should be labelled separately');
    assertEqual(htb.result.bottlenecks.primary.code, 'scheme_or_property_mismatch', 'Potential support confirmation guard');
  }));

  cases.push(runCase('Confirmed FHS cannot improve funding before property and lender facts pass', () => {
    const projection = computeHousePurchaseProjection(makeInputs({
      localAuthorityCode: '',
      dwellingType: 'unknown',
      firstHomeScheme: { applicationStatus: 'confirmed', confirmedEquityAmount: 30000 }
    }));
    assertEqual(projection.result.schemes.firstHomeScheme.status, 'more_information_required', 'FHS screen status');
    assertEqual(projection.result.fundingStack.confirmedFhs, 0, 'Unscreened confirmed FHS must not fund target');
    assertEqual(projection.result.capacities.activeSupportablePrice, projection.result.capacities.currentSupportablePrice, 'Unscreened FHS capacity');
  }));

  cases.push(runCase('Confirmed FHS is capped to the eligible property funding gap', () => {
    const inputs = makeInputs({
      targetPropertyPrice: 400000,
      firstHomeScheme: { applicationStatus: 'confirmed', confirmedEquityAmount: 80000 }
    });
    const screen = screenFirstHomeScheme(inputs, {
      mortgageAmount: 320000,
      standardMortgageCapacity: 320000,
      ownDeposit: 40000,
      htbAmount: 0
    });
    assertEqual(screen.fundingGap, 40000, 'FHS eligible gap');
    assertEqual(screen.confirmedAmount, 40000, 'Confirmed FHS gap cap');
  }));

  cases.push(runCase('Above-standard unconfirmed lender amount cannot produce Ready', () => {
    const projection = computeHousePurchaseProjection(makeInputs({
      currentCashSavings: 200000,
      applicants: [{ ...makeInputs().applicants[0], grossAnnualIncome: 50000 }],
      lenderCapacity: { status: 'estimated', amount: 300000, macroPrudentialException: true }
    }));
    assert(projection.result.bottlenecks.all.some((entry) => entry.code === 'income_borrowing_capacity'), 'Unconfirmed exception bottleneck');
    assertEqual(projection.result.bottlenecks.ready, false, 'Unconfirmed exception should not be ready');
  }));

  cases.push(runCase('Funding stack property segments do not mix buying costs into property gap', () => {
    const projection = computeHousePurchaseProjection(makeInputs({ currentCashSavings: 30000 }));
    const stack = projection.result.fundingStack;
    const propertySegments = stack.ownCash + stack.estimatedMortgage + stack.confirmedHtb + stack.confirmedFhs
      + stack.potentialHtb + stack.potentialFhs + stack.siteEquity + stack.remainingGap;
    assertApprox(propertySegments, stack.total, 0.01, 'Property stack should sum to target price');
    assert(stack.cashGapIncludingCosts >= stack.remainingGap, 'Cash gap including costs should remain separate');
  }));

  cases.push(runCase('Current maximum-price solver protects reserve and buying costs without double-counting', () => {
    const projection = computeHousePurchaseProjection(makeInputs({
      currentCashSavings: 90000,
      emergencyReserveTarget: 20000,
      amountRingfencedForOtherGoals: 10000,
      applicants: [{ ...makeInputs().applicants[0], grossAnnualIncome: 100000 }],
      lenderCapacity: { status: 'not_obtained', amount: null }
    }));
    assertEqual(projection.result.protectedCash.usableCash, 60000, 'Usable cash after protected amounts');
    const price = projection.result.capacities.currentSupportablePrice;
    assert(price > 0 && price < 460000, 'Solved price should allow for buying costs');
    const atPrice = computeHousePurchaseProjection(makeInputs({
      currentCashSavings: 90000,
      emergencyReserveTarget: 20000,
      amountRingfencedForOtherGoals: 10000,
      applicants: [{ ...makeInputs().applicants[0], grossAnnualIncome: 100000 }],
      lenderCapacity: { status: 'not_obtained', amount: null },
      targetPropertyPrice: price
    }));
    assert(atPrice.result.targetFunding.currentCashGap <= 1, 'Solved price should be currently cash-feasible');
  }));

  cases.push(runCase('Rule metadata marks current rules fresh and aged rules stale', () => {
    const fresh = computeHousePurchaseProjection(makeInputs());
    assertEqual(fresh.result.ruleVersions.requiresReleaseSourceCheck, false, 'Current rules should be fresh');
    const stale = computeHousePurchaseProjection(makeInputs({ calculationDateIso: '2027-07-12' }));
    assertEqual(stale.result.ruleVersions.requiresReleaseSourceCheck, true, 'Aged rules should require refresh');
    assert(stale.result.ruleVersions.staleRuleIds.includes('firstHomeScheme'), 'FHS stale flag');
  }));

  cases.push(runCase('Projection returns standard tables, charts, deterministic actions and semantic result', () => {
    const projection = computeHousePurchaseProjection(makeInputs());
    assert(Array.isArray(projection.assumptionsTable.rows) && projection.assumptionsTable.rows.length > 0, 'Assumptions table');
    assert(Array.isArray(projection.outputsTable.rows) && projection.outputsTable.rows.length > 0, 'Outputs table');
    assert(projection.tables.length >= 4, 'Supporting tables');
    assert(projection.charts.some((chart) => chart.id === 'house-purchase-deposit-journey'), 'Deposit chart');
    assertEqual(projection.result.actions.length, 3, 'Exactly three actions');
    assert(projection.summaryHtml.includes('standard-rule route'), 'Summary narrative');
  }));

  cases.push(runCase('Session state round-trips house-purchase input and published export omits draft editor', () => {
    const inputs = makeInputs();
    const session = importSession({
      version: 1,
      sessionId: 'house-purchase-roundtrip',
      clientName: 'House Purchase Client',
      order: ['house'],
      activeModuleId: 'house',
      modules: [{
        id: 'house',
        title: 'House Purchase Planner',
        generated: { summaryHtml: '<p>Plan</p>', housePurchaseInputs: inputs },
        ui: { housePurchaseEditor: { active: true, stepIndex: 4, draft: { targetPropertyPrice: 425000 } } }
      }]
    });
    const roundTrip = importSession(exportSession(session));
    assertEqual(roundTrip.modules[0].generated.housePurchaseInputs.targetPropertyPrice, 400000, 'Input round-trip');
    assertEqual(roundTrip.modules[0].ui.housePurchaseEditor.stepIndex, 4, 'Advisor draft round-trip');
    const published = JSON.parse(exportPublishedSession(session));
    assert(!Object.hasOwn(published.modules[0].ui, 'housePurchaseEditor'), 'Published export must omit advisor draft');
    assertEqual(published.modules[0].generated.housePurchaseInputs.targetPropertyPrice, 400000, 'Published base input');
  }));

  cases.push(runCase('Generated-state exclusivity retains only one calculator contract', () => {
    const session = importSession({
      version: 1,
      sessionId: 'house-purchase-exclusive',
      clientName: 'House Purchase Client',
      order: ['house'],
      activeModuleId: 'house',
      modules: [{
        id: 'house',
        title: 'Exclusive calculator',
        generated: {
          housePurchaseInputs: makeInputs(),
          collegeFundingInputs: {
            currentYear: 2026,
            childrenCount: 1,
            childCurrentAge: 12,
            collegeStartAge: 18,
            collegeDurationYears: 4,
            inflationRate: 0.02
          }
        }
      }]
    });
    const generated = session.modules[0].generated;
    const calculators = [generated.housePurchaseInputs, generated.collegeFundingInputs].filter(Boolean);
    assertEqual(calculators.length, 1, 'Only one calculator contract may survive normalization');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  return { total: cases.length, passed, failed, results: cases };
}
