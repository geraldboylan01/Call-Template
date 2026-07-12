import { DEFAULT_HOUSE_PURCHASE_RULES } from './config.js';

export function roundHousePurchaseMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Calculate Irish residential stamp duty using progressive dated bands.
 * The second argument may be the rules object itself or an options object:
 * { rules, mode: 'rules'|'custom', customStampDuty }.
 */
export function calculateStampDuty(propertyPrice, options = {}) {
  if (typeof propertyPrice !== 'number' || !Number.isFinite(propertyPrice) || propertyPrice < 0) {
    throw new Error('propertyPrice must be a finite number greater than or equal to 0.');
  }

  const looksLikeRules = options && options.stampDuty && !options.rules;
  const rules = looksLikeRules ? options : (options.rules || DEFAULT_HOUSE_PURCHASE_RULES);
  const mode = looksLikeRules ? 'rules' : (options.mode || options.stampDutyMode || 'rules');
  const customStampDuty = looksLikeRules ? null : (options.customStampDuty ?? null);

  if (mode === 'custom') {
    if (typeof customStampDuty !== 'number' || !Number.isFinite(customStampDuty) || customStampDuty < 0) {
      throw new Error('customStampDuty must be a finite number greater than or equal to 0 in custom mode.');
    }
    return roundHousePurchaseMoney(customStampDuty);
  }
  if (mode !== 'rules' && mode !== 'calculated') {
    throw new Error('stamp duty mode must be "rules" or "custom".');
  }

  const bands = rules?.stampDuty?.bands;
  if (!Array.isArray(bands) || bands.length === 0) {
    throw new Error('House-purchase rules must include stampDuty.bands.');
  }

  let remaining = propertyPrice;
  let previousLimit = 0;
  let duty = 0;
  bands.forEach((band) => {
    if (remaining <= 0) return;
    const upper = band.upTo === null ? Infinity : band.upTo;
    const width = upper === Infinity ? remaining : Math.max(0, upper - previousLimit);
    const taxable = Math.min(remaining, width);
    duty += taxable * band.rate;
    remaining -= taxable;
    previousLimit = upper;
  });
  return roundHousePurchaseMoney(duty);
}

export function calculatePurchaseCosts(inputs, propertyPrice, rules = DEFAULT_HOUSE_PURCHASE_RULES) {
  const stampDuty = calculateStampDuty(propertyPrice, {
    rules,
    mode: inputs.purchaseCosts.stampDutyMode,
    customStampDuty: inputs.purchaseCosts.customStampDuty
  });
  const nonStampCosts = inputs.purchaseCosts.legalAndConveyancing
    + inputs.purchaseCosts.valuation
    + inputs.purchaseCosts.surveyOrEngineer
    + inputs.purchaseCosts.movingAndFurnishing
    + inputs.purchaseCosts.contingency;
  return {
    stampDuty,
    legalAndConveyancing: inputs.purchaseCosts.legalAndConveyancing,
    valuation: inputs.purchaseCosts.valuation,
    surveyOrEngineer: inputs.purchaseCosts.surveyOrEngineer,
    movingAndFurnishing: inputs.purchaseCosts.movingAndFurnishing,
    contingency: inputs.purchaseCosts.contingency,
    nonStampCosts: roundHousePurchaseMoney(nonStampCosts),
    total: roundHousePurchaseMoney(stampDuty + nonStampCosts)
  };
}

