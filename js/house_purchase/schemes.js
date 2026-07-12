import {
  DEFAULT_HOUSE_PURCHASE_RULES,
  FHS_PRICE_CEILINGS
} from './config.js';
import { normalizeHousePurchaseInputs } from './normalize.js';
import { roundHousePurchaseMoney } from './calculations.js';

const LOCAL_AUTHORITY_ALIASES = Object.freeze({
  carlow: 'carlow_county',
  cavan: 'cavan_county',
  clare: 'clare_county',
  donegal: 'donegal_county',
  kerry: 'kerry_county',
  kildare: 'kildare_county',
  kilkenny: 'kilkenny_county',
  laois: 'laois_county',
  leitrim: 'leitrim_county',
  limerick: 'limerick_city_and_county',
  longford: 'longford_county',
  louth: 'louth_county',
  mayo: 'mayo_county',
  meath: 'meath_county',
  monaghan: 'monaghan_county',
  offaly: 'offaly_county',
  roscommon: 'roscommon_county',
  sligo: 'sligo_county',
  tipperary: 'tipperary_county',
  waterford: 'waterford_city_and_county',
  westmeath: 'westmeath_county',
  wexford: 'wexford_county',
  wicklow: 'wicklow_county'
});

function comparable(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export function findFhsPriceCeiling(localAuthorityCode, rules = DEFAULT_HOUSE_PURCHASE_RULES) {
  const rawKey = comparable(localAuthorityCode);
  const canonical = LOCAL_AUTHORITY_ALIASES[rawKey] || rawKey;
  const entries = Array.isArray(rules?.firstHomeScheme?.priceCeilings)
    ? rules.firstHomeScheme.priceCeilings
    : FHS_PRICE_CEILINGS;
  return entries.find((entry) => {
    if (comparable(entry.code) === canonical || comparable(entry.localAuthority) === canonical) return true;
    return Array.isArray(entry.aliases) && entry.aliases.some((alias) => comparable(alias) === canonical);
  }) || null;
}

function criterion(id, label, state, detail) {
  const status = state === true ? 'pass' : (state === false ? 'fail' : 'unknown');
  return { id, label, status, detail };
}

function detailForState(state, { pass, fail, unknown }) {
  if (state === true) return pass;
  if (state === false) return fail;
  return unknown;
}

function summarizeCriteria(criteria) {
  const failed = criteria.filter((entry) => entry.status === 'fail');
  const unknown = criteria.filter((entry) => entry.status === 'unknown');
  const passed = criteria.filter((entry) => entry.status === 'pass');
  return {
    passedCriteria: passed.map((entry) => entry.label),
    failedCriteria: failed.map((entry) => entry.label),
    unansweredCriteria: unknown.map((entry) => entry.label),
    missingInformation: unknown.map((entry) => entry.detail || entry.label),
    failed,
    unknown,
    passed
  };
}

function normalizeForScreen(rawInputs) {
  return normalizeHousePurchaseInputs(rawInputs, { allowPartial: true });
}

function allApplicantState(applicants, predicate) {
  const states = applicants.map(predicate);
  if (states.includes(false)) return false;
  if (states.includes(null)) return null;
  return true;
}

export function screenHelpToBuy(rawInputs, options = {}) {
  const inputs = normalizeForScreen(rawInputs);
  const rules = options.rules || DEFAULT_HOUSE_PURCHASE_RULES;
  const htbRules = rules.helpToBuy;
  const targetPrice = options.targetPropertyPrice ?? inputs.targetPropertyPrice;
  const mortgageAmount = options.mortgageAmount ?? inputs.lenderCapacity.amount;

  const allFirstTime = allApplicantState(inputs.applicants, (applicant) => {
    if (applicant.schemeBuyerStatus === 'previous_owner' || applicant.schemeBuyerStatus === 'fresh_start') return false;
    if (applicant.previouslyOwnedPropertyAnywhere === true) return false;
    if (applicant.schemeBuyerStatus === 'unknown' || applicant.previouslyOwnedPropertyAnywhere === null) return null;
    return applicant.schemeBuyerStatus === 'first_time_buyer' && applicant.previouslyOwnedPropertyAnywhere === false;
  });
  const propertyState = inputs.acquisitionType === 'new_build' || inputs.acquisitionType === 'self_build'
    ? true
    : (inputs.acquisitionType === 'unknown' ? null : false);
  const mainHomeState = inputs.intendedUse === 'principal_private_residence'
    ? true
    : (inputs.intendedUse === 'unknown' ? null : false);
  const priceState = targetPrice === null ? null : targetPrice <= htbRules.maximumPrice;

  let periodState = null;
  if (inputs.targetPurchaseDate) {
    periodState = inputs.targetPurchaseDate <= htbRules.schemeEndDateIso;
  }
  const lenderState = inputs.lenderCapacity.htbQualifyingLender;
  const mortgageShare = targetPrice > 0 && typeof mortgageAmount === 'number'
    ? mortgageAmount / targetPrice
    : null;
  const mortgageShareState = mortgageShare === null ? null : mortgageShare >= htbRules.minimumQualifyingMortgageShare;

  const criteria = [
    criterion('all_first_time_buyers', 'Every purchaser is a first-time purchaser for HTB', allFirstTime,
      detailForState(allFirstTime, {
        pass: 'Every purchaser is recorded as a first-time purchaser who has not previously bought or built a home.',
        fail: 'At least one purchaser is recorded as a fresh-start or previous owner, or as having previously owned a home. HTB requires every purchaser to be a first-time purchaser.',
        unknown: 'Confirm every purchaser\u2019s HTB buyer status and whether they have ever bought or built a home.'
      })),
    criterion('qualifying_property', 'New-build or self-build property', propertyState,
      detailForState(propertyState, {
        pass: 'The selected acquisition is a new build or self-build, which is within the encoded HTB property routes.',
        fail: 'The selected acquisition is not a new build or self-build. HTB does not apply to second-hand or tenant purchases.',
        unknown: 'Select whether the purchase is a new build, self-build, second-hand home or tenant purchase.'
      })),
    criterion('principal_home', 'Property will be the principal home', mainHomeState,
      detailForState(mainHomeState, {
        pass: 'The property is recorded as the purchaser\u2019s principal home.',
        fail: 'The property is not recorded as the purchaser\u2019s principal home, which HTB requires.',
        unknown: 'Confirm whether the property will be occupied as the purchaser\u2019s principal home.'
      })),
    criterion('price_limit', `Property value is no more than \u20ac${htbRules.maximumPrice.toLocaleString('en-IE')}`, priceState,
      detailForState(priceState, {
        pass: `The target value of \u20ac${targetPrice?.toLocaleString('en-IE')} is within the \u20ac${htbRules.maximumPrice.toLocaleString('en-IE')} HTB limit.`,
        fail: `The target value of \u20ac${targetPrice?.toLocaleString('en-IE')} exceeds the \u20ac${htbRules.maximumPrice.toLocaleString('en-IE')} HTB limit.`,
        unknown: 'Enter the target property value to test the HTB limit.'
      })),
    criterion('scheme_period', `Purchase or build falls by ${htbRules.schemeEndDateIso}`, periodState,
      detailForState(periodState, {
        pass: `The target date ${inputs.targetPurchaseDate} falls within the currently encoded scheme period ending ${htbRules.schemeEndDateIso}.`,
        fail: `The target date ${inputs.targetPurchaseDate} falls after the currently encoded scheme period ending ${htbRules.schemeEndDateIso}.`,
        unknown: 'Enter a target purchase date to screen the scheme period.'
      })),
    criterion('tax_compliant', 'Purchaser is tax compliant', inputs.helpToBuy.taxCompliant,
      detailForState(inputs.helpToBuy.taxCompliant, {
        pass: 'The purchaser is recorded as tax compliant.',
        fail: 'The purchaser is recorded as not tax compliant; Revenue tax compliance is required for HTB.',
        unknown: 'Confirm the purchaser\u2019s Revenue tax-compliance status.'
      })),
    criterion('approved_developer_or_approver', 'Developer or contractor is Revenue approved', inputs.helpToBuy.revenueApprovedDeveloperOrApprover,
      detailForState(inputs.helpToBuy.revenueApprovedDeveloperOrApprover, {
        pass: 'The relevant developer or contractor is recorded as Revenue approved.',
        fail: 'The relevant developer or contractor is recorded as not Revenue approved.',
        unknown: 'Confirm whether the relevant developer or contractor is Revenue approved.'
      })),
    criterion('qualifying_lender', 'Mortgage is with a qualifying lender', lenderState,
      detailForState(lenderState, {
        pass: 'The mortgage lender is recorded as a qualifying HTB lender.',
        fail: 'The mortgage lender is recorded as not qualifying for HTB.',
        unknown: 'Confirm whether the mortgage lender is a qualifying HTB lender.'
      })),
    criterion('minimum_mortgage_share', `Qualifying mortgage is at least ${(htbRules.minimumQualifyingMortgageShare * 100).toFixed(0)}% of value`, mortgageShareState,
      detailForState(mortgageShareState, {
        pass: `The illustrated qualifying-mortgage share is ${(mortgageShare * 100).toFixed(1)}%, meeting the ${(htbRules.minimumQualifyingMortgageShare * 100).toFixed(0)}% minimum.`,
        fail: `The illustrated qualifying-mortgage share is ${(mortgageShare * 100).toFixed(1)}%, below the ${(htbRules.minimumQualifyingMortgageShare * 100).toFixed(0)}% minimum.`,
        unknown: 'Enter a target property value and lender capacity or mortgage amount to test the qualifying-mortgage share.'
      }))
  ];

  const summary = summarizeCriteria(criteria);
  const status = summary.failed.length > 0
    ? 'unlikely_eligible'
    : (summary.unknown.length > 0 ? 'more_information_required' : 'potentially_eligible');
  const valueCap = typeof targetPrice === 'number'
    ? Math.min(htbRules.maximumRelief, targetPrice * htbRules.priceShare)
    : 0;
  const taxPaid = inputs.helpToBuy.expectedIncomeTaxAndDirtPaidPriorFourYears;
  const maximumAmount = taxPaid === null ? null : roundHousePurchaseMoney(Math.min(valueCap, taxPaid));
  const maximumBeforeTaxVerification = roundHousePurchaseMoney(valueCap);
  const potentialAmount = status === 'unlikely_eligible'
    ? 0
    : (maximumAmount ?? maximumBeforeTaxVerification);
  const confirmedCap = maximumAmount ?? maximumBeforeTaxVerification;
  const confirmedAmount = status === 'unlikely_eligible'
    ? 0
    : roundHousePurchaseMoney(Math.min(inputs.helpToBuy.confirmedClaimAmount, confirmedCap));

  return {
    id: 'help_to_buy',
    label: 'Help to Buy',
    status,
    eligible: status === 'potentially_eligible' ? true : (status === 'unlikely_eligible' ? false : null),
    estimatedAmount: maximumAmount,
    maximumAmount,
    maximumBeforeTaxVerification,
    amountRange: taxPaid === null ? { minimum: 0, maximum: maximumBeforeTaxVerification } : null,
    rawConfirmedAmount: inputs.helpToBuy.confirmedClaimAmount,
    confirmedAmount,
    potentialAmount,
    taxPaidVerificationRequired: taxPaid === null,
    criteria,
    passedCriteria: summary.passedCriteria,
    failedCriteria: summary.failedCriteria,
    unansweredCriteria: summary.unansweredCriteria,
    missingInformation: summary.missingInformation,
    asOfDate: htbRules.asOfDate,
    sources: [...htbRules.sources],
    notes: [
      'This is an eligibility screen, not Revenue approval.',
      'Any amount remains subject to the Income Tax and DIRT paid in the relevant prior four tax years.'
    ]
  };
}

export function screenFirstHomeScheme(rawInputs, options = {}) {
  const inputs = normalizeForScreen(rawInputs);
  const rules = options.rules || DEFAULT_HOUSE_PURCHASE_RULES;
  const fhsRules = rules.firstHomeScheme;
  const targetPrice = options.targetPropertyPrice ?? inputs.targetPropertyPrice;
  const mortgageAmount = options.mortgageAmount ?? inputs.lenderCapacity.amount;
  const standardMortgageCapacity = options.standardMortgageCapacity ?? null;
  const ownDeposit = Math.max(0, options.ownDeposit ?? 0);
  const htbAmount = Math.max(0, options.htbAmount ?? 0);
  const usingHtb = options.usingHtb ?? htbAmount > 0;
  const siteEquity = inputs.acquisitionType === 'self_build' ? inputs.firstHomeScheme.siteEquity : 0;

  const ageState = allApplicantState(inputs.applicants, (applicant) => (
    applicant.age === null ? null : applicant.age > fhsRules.minimumApplicantAge
  ));
  const buyerState = allApplicantState(inputs.applicants, (applicant) => {
    if (applicant.schemeBuyerStatus === 'first_time_buyer') {
      if (applicant.previouslyOwnedPropertyAnywhere === true) return false;
      if (applicant.previouslyOwnedPropertyAnywhere === null) return null;
      return true;
    }
    if (applicant.schemeBuyerStatus === 'fresh_start') {
      if (applicant.retainedInterestInPreviousProperty === true) return false;
      if (applicant.retainedInterestInPreviousProperty === null) return null;
      return true;
    }
    if (applicant.schemeBuyerStatus === 'previous_owner') return false;
    return null;
  });
  const resideState = allApplicantState(inputs.applicants, (applicant) => applicant.rightToResideInIreland);
  const participatingLender = fhsRules.participatingLenderIds.includes(inputs.lenderCapacity.lenderId);
  const lenderKnown = inputs.lenderCapacity.lenderId !== 'unknown';
  const lenderState = lenderKnown ? participatingLender : null;
  const approvalState = inputs.lenderCapacity.status === 'confirmed' ? true : null;
  const maximumState = inputs.lenderCapacity.isMaximumAvailable;

  let mpeState = inputs.lenderCapacity.macroPrudentialException === null
    ? null
    : !inputs.lenderCapacity.macroPrudentialException;
  const unexplainedAboveStandard = typeof mortgageAmount === 'number'
    && typeof standardMortgageCapacity === 'number'
    && mortgageAmount > standardMortgageCapacity + 0.01
    && inputs.lenderCapacity.macroPrudentialException !== true;
  if (unexplainedAboveStandard) mpeState = false;

  let propertyState = null;
  if (inputs.acquisitionType === 'new_build' || inputs.acquisitionType === 'self_build') {
    propertyState = true;
  } else if (inputs.acquisitionType === 'tenant_purchase') {
    propertyState = inputs.tenantNoticeReceived;
  } else if (inputs.acquisitionType !== 'unknown') {
    propertyState = false;
  }
  const mainHomeState = inputs.intendedUse === 'principal_private_residence'
    ? true
    : (inputs.intendedUse === 'unknown' ? null : false);

  const priceEntry = findFhsPriceCeiling(inputs.localAuthorityCode, rules);
  const propertyType = inputs.acquisitionType === 'self_build' ? 'self_build' : inputs.dwellingType;
  const propertyCeiling = priceEntry && propertyType !== 'unknown'
    ? (propertyType === 'self_build' ? priceEntry.selfBuild : priceEntry[propertyType])
    : null;
  const ceilingState = targetPrice === null || propertyCeiling === null
    ? null
    : targetPrice <= propertyCeiling;

  const depositAmount = ownDeposit + htbAmount + siteEquity;
  const depositState = targetPrice > 0
    ? depositAmount + 0.01 >= targetPrice * fhsRules.minimumDepositRate
    : null;
  const fundingGap = targetPrice === null || typeof mortgageAmount !== 'number'
    ? null
    : roundHousePurchaseMoney(Math.max(0, targetPrice - ownDeposit - mortgageAmount - htbAmount - siteEquity));
  const maximumShare = usingHtb ? fhsRules.maximumShareWithHtb : fhsRules.maximumShareWithoutHtb;
  const maximumEquityAmount = targetPrice === null ? 0 : roundHousePurchaseMoney(targetPrice * maximumShare);
  const minimumEquityAmount = targetPrice === null
    ? fhsRules.minimumEquityAmount
    : roundHousePurchaseMoney(Math.max(fhsRules.minimumEquityAmount, targetPrice * fhsRules.minimumEquityShare));
  const gapState = fundingGap === null
    ? null
    : fundingGap >= minimumEquityAmount && fundingGap <= maximumEquityAmount;

  const criteria = [
    criterion('applicant_age', `Every applicant is over ${fhsRules.minimumApplicantAge}`, ageState,
      detailForState(ageState, {
        pass: `Every applicant is recorded as over ${fhsRules.minimumApplicantAge}.`,
        fail: `At least one applicant is not over ${fhsRules.minimumApplicantAge}, which the FHS applicant-age rule requires.`,
        unknown: 'Enter every applicant\u2019s age.'
      })),
    criterion('buyer_status', 'Every applicant is a first-time or eligible fresh-start buyer', buyerState,
      detailForState(buyerState, {
        pass: 'Every applicant is recorded as a first-time buyer or a fresh-start buyer with no retained interest in a previous property.',
        fail: 'At least one applicant is recorded as a previous owner who does not meet the encoded fresh-start conditions.',
        unknown: 'Confirm each applicant\u2019s buyer status and, for a fresh-start applicant, whether any interest in a previous property is retained.'
      })),
    criterion('right_to_reside', 'Every applicant has a right to reside in Ireland', resideState,
      detailForState(resideState, {
        pass: 'Every applicant is recorded as having a right to reside in Ireland.',
        fail: 'At least one applicant is recorded as not having a right to reside in Ireland.',
        unknown: 'Confirm each applicant\u2019s right to reside in Ireland.'
      })),
    criterion('participating_lender', 'Mortgage is from a participating lender', lenderState,
      detailForState(lenderState, {
        pass: 'The selected lender is encoded as an FHS participating lender.',
        fail: 'The selected lender is not currently encoded as an FHS participating lender.',
        unknown: 'Select the mortgage lender.'
      })),
    criterion('mortgage_approval', 'Mortgage approval is confirmed', approvalState,
      detailForState(approvalState, {
        pass: 'The mortgage approval is recorded as confirmed.',
        fail: 'The mortgage approval is recorded as not confirmed.',
        unknown: 'Obtain or confirm mortgage approval to complete this criterion.'
      })),
    criterion('maximum_mortgage', 'Maximum available mortgage is being borrowed', maximumState,
      detailForState(maximumState, {
        pass: 'The lender amount is recorded as the maximum mortgage available.',
        fail: 'The lender amount is recorded as less than the maximum mortgage available under the scheme rules.',
        unknown: 'Confirm whether the lender amount is the maximum mortgage available under the scheme rules.'
      })),
    criterion('no_macro_prudential_exception', 'No macro-prudential exception is used', mpeState,
      detailForState(mpeState, {
        pass: 'The mortgage is recorded as using no macro-prudential exception.',
        fail: unexplainedAboveStandard
          ? 'The lender amount exceeds the standard income ceiling without a confirmed exception; FHS cannot be illustrated as eligible.'
          : 'A macro-prudential exception is recorded; the encoded FHS rules require no exception.',
        unknown: 'Confirm whether a macro-prudential exception applies.'
      })),
    criterion('qualifying_property', 'Property type is within the encoded FHS routes', propertyState,
      detailForState(propertyState, {
        pass: inputs.acquisitionType === 'tenant_purchase'
          ? 'The tenant-purchase route is selected and receipt of the required tenant notice is confirmed.'
          : 'The selected new-build or self-build acquisition is within the encoded FHS property routes.',
        fail: inputs.acquisitionType === 'tenant_purchase'
          ? 'The tenant-purchase route is selected but the required tenant notice is recorded as not received.'
          : 'The selected acquisition is outside the encoded new-build, self-build and eligible tenant-purchase routes.',
        unknown: inputs.acquisitionType === 'tenant_purchase'
          ? 'Confirm receipt of the required tenant notice.'
          : 'Select a qualifying new-build, self-build or eligible tenant purchase.'
      })),
    criterion('principal_home', 'Property will be the principal home', mainHomeState,
      detailForState(mainHomeState, {
        pass: 'The property is recorded as the applicant\u2019s principal home.',
        fail: 'The property is not recorded as the applicant\u2019s principal home, which FHS requires.',
        unknown: 'Confirm whether the property will be the applicant\u2019s principal home.'
      })),
    criterion('price_ceiling', 'Property is within the local-authority and dwelling-type ceiling', ceilingState,
      detailForState(ceilingState, {
        pass: `The target value of \u20ac${targetPrice?.toLocaleString('en-IE')} is within the encoded \u20ac${propertyCeiling?.toLocaleString('en-IE')} ceiling.`,
        fail: `The target value of \u20ac${targetPrice?.toLocaleString('en-IE')} exceeds the encoded \u20ac${propertyCeiling?.toLocaleString('en-IE')} ceiling.`,
        unknown: targetPrice === null
          ? 'Enter the target property value to test the FHS price ceiling.'
          : (!priceEntry
              ? 'Select the local authority to identify the FHS price ceiling.'
              : 'Select the dwelling type to identify the FHS price ceiling.')
      })),
    criterion('minimum_deposit', `Deposit or eligible site equity reaches ${(fhsRules.minimumDepositRate * 100).toFixed(0)}%`, depositState,
      detailForState(depositState, {
        pass: `The illustrated eligible deposit contribution of \u20ac${depositAmount.toLocaleString('en-IE')} meets the \u20ac${roundHousePurchaseMoney(targetPrice * fhsRules.minimumDepositRate).toLocaleString('en-IE')} minimum.`,
        fail: `The illustrated eligible deposit contribution of \u20ac${depositAmount.toLocaleString('en-IE')} is below the \u20ac${roundHousePurchaseMoney(targetPrice * fhsRules.minimumDepositRate).toLocaleString('en-IE')} minimum.`,
        unknown: 'Enter a target property value to test the minimum deposit.'
      })),
    criterion('equity_range', `Funding gap is between the minimum and ${(maximumShare * 100).toFixed(0)}% maximum equity`, gapState,
      detailForState(gapState, {
        pass: `The illustrated gap of \u20ac${fundingGap?.toLocaleString('en-IE')} is within the encoded \u20ac${minimumEquityAmount.toLocaleString('en-IE')}\u2013\u20ac${maximumEquityAmount.toLocaleString('en-IE')} equity range.`,
        fail: `The illustrated gap of \u20ac${fundingGap?.toLocaleString('en-IE')} is outside the encoded \u20ac${minimumEquityAmount.toLocaleString('en-IE')}\u2013\u20ac${maximumEquityAmount.toLocaleString('en-IE')} equity range.`,
        unknown: 'Enter a target property value and mortgage amount to test the FHS equity range.'
      }))
  ];

  const summary = summarizeCriteria(criteria);
  let status;
  if (fundingGap === 0 && summary.failed.every((entry) => entry.id === 'equity_range')) {
    status = 'not_applicable';
  } else if (summary.failed.length > 0) {
    status = 'unlikely_eligible';
  } else if (summary.unknown.length > 0) {
    status = 'more_information_required';
  } else {
    status = 'potentially_eligible';
  }

  const potentialAmount = (status === 'potentially_eligible' || status === 'more_information_required') && fundingGap !== null
    ? roundHousePurchaseMoney(fundingGap)
    : 0;
  const confirmedInput = inputs.firstHomeScheme.applicationStatus === 'confirmed'
    ? inputs.firstHomeScheme.confirmedEquityAmount
    : 0;
  const confirmedAmount = (status === 'potentially_eligible' || status === 'more_information_required')
    ? roundHousePurchaseMoney(Math.min(
      confirmedInput,
      maximumEquityAmount,
      fundingGap === null ? maximumEquityAmount : fundingGap
    ))
    : 0;
  const serviceChargeBasis = confirmedAmount || potentialAmount;
  const serviceChargeTimeline = fhsRules.serviceChargeBands.map((band) => ({
    ...band,
    annualAmount: roundHousePurchaseMoney(serviceChargeBasis * band.rate)
  }));

  return {
    id: 'first_home_scheme',
    label: 'First Home Scheme',
    status,
    eligible: status === 'potentially_eligible' ? true : (status === 'unlikely_eligible' ? false : null),
    rawConfirmedAmount: inputs.firstHomeScheme.confirmedEquityAmount,
    confirmedAmount,
    potentialAmount,
    fundingGap,
    equityPercentage: targetPrice > 0 && fundingGap !== null ? fundingGap / targetPrice : null,
    minimumEquityAmount,
    maximumEquityAmount,
    maximumShare,
    usingHtb,
    priceCeiling: propertyCeiling,
    priceCeilingEntry: priceEntry ? {
      code: priceEntry.code,
      localAuthority: priceEntry.localAuthority,
      propertyType,
      ceiling: propertyCeiling,
      effectiveDate: priceEntry.effectiveDate,
      verifiedOn: priceEntry.verifiedOn,
      sourceUrl: priceEntry.sourceUrl
    } : null,
    participatingLender,
    serviceChargeTimeline,
    criteria,
    passedCriteria: summary.passedCriteria,
    failedCriteria: summary.failedCriteria,
    unansweredCriteria: summary.unansweredCriteria,
    missingInformation: summary.missingInformation,
    effectiveDate: fhsRules.effectiveDate,
    verifiedOn: fhsRules.verifiedOn,
    sources: [...fhsRules.sources],
    warnings: [
      'The First Home Scheme takes an equity share rather than providing a conventional loan.',
      'If the home rises or falls in value, the euro redemption amount generally rises or falls with it.',
      'Service charges can apply from year six.'
    ]
  };
}
