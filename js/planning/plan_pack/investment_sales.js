import { computeTaxYear } from '../tax/engine.js';
import { resolveTaxRules } from '../tax/resolve.js';
import { renderTaxDisclosures } from '../tax/disclosures.js';
import { cloneJson } from '../utils.js';
import { missing, people, LaterStage } from './chapters.js';
import { fail, finiteJson } from './schema.js';

/** One route's complete sale batch; never reuse an alternative's nextState. */
export function priceInvestmentSales(profile, assetIds, calculationDate, taxStatus, openingState) {
  if (new Set(assetIds).size !== assetIds.length) fail('/routes', 'an investment can be sold only once in a route.');
  if (!assetIds.length) return { netProceeds: 0, grossProceeds: 0, tax: 0, sales: [], disclosures: [] };
  if (!taxStatus) missing('/planningInputs/householdTaxStatus', 'State the tax status before pricing investment sales.');
  const year = Number(calculationDate.slice(0, 4));
  const owners = people(profile);
  const events = assetIds.map(assetId => {
    const index = profile.assets.findIndex(asset => asset.assetId === assetId);
    const asset = profile.assets[index];
    const path = '/household/assets/' + index;
    if (!asset || asset.type !== 'investment') fail('/routes', 'sellAsset must name an existing investment asset.');
    if (asset.investmentTaxTreatment !== 'ordinary_cgt') throw new LaterStage(path + '/investmentTaxTreatment',
      'Confirm an ordinary CGT investment. Fund/ETF exit tax and unknown tax treatment are not priced as CGT.', 'B2', 'requires_sale_tax_adapter');
    if (!asset.currentValue || asset.currentValue.currency !== 'EUR') missing(path + '/currentValue', 'Supply the current EUR market value.');
    if (!asset.ownerIds.length || asset.ownerIds.length > 2 || new Set(asset.ownerIds).size !== asset.ownerIds.length || asset.ownerIds.some(id => !owners.some(p => p.personId === id))) missing(path + '/ownerIds', 'Name the actual people who own the investment once each.');
    for (const field of ['baseCost', 'sellingCosts']) if (asset[field] && asset[field].currency !== 'EUR') missing(path + '/' + field, 'Supply a EUR amount; no currency conversion is inferred.');
    const basis = asset.baseCost ? 'stated' : 'assumed_zero';
    return { type: 'investmentDisposal', personId: asset.ownerIds.length === 2 ? 'joint' : asset.ownerIds[0],
      disposalDate: calculationDate, proceeds: asset.currentValue.amount,
      acquisitionCost: asset.baseCost?.amount ?? 0, acquisitionCostBasis: basis,
      sellingCosts: asset.sellingCosts?.amount ?? 0,
      ...(asset.acquisitionDate ? { acquisitionDate: asset.acquisitionDate } : {}) };
  });
  const input = { year, status: taxStatus, people: owners.map(p => ({ id: p.personId, age: p.age })), items: [], events };
  const taxRun = computeTaxYear({ input, ...(openingState ? { state: cloneJson(openingState) } : {}) });
  const capital = taxRun.result.capitalGains;
  const sales = capital.disposals.map((disposal, index) => ({ assetId: assetIds[index], grossProceeds: events[index].proceeds,
    baseCost: events[index].acquisitionCost, baseCostBasis: events[index].acquisitionCostBasis,
    sellingCosts: events[index].sellingCosts, tax: disposal.tax, netProceeds: disposal.netProceedsAfterTax }));
  return finiteJson({ input, result: capital, nextState: taxRun.nextState, sales,
    grossProceeds: sales.reduce((sum, sale) => sum + sale.grossProceeds, 0),
    netProceeds: sales.reduce((sum, sale) => sum + sale.netProceeds, 0), tax: capital.total,
    disclosures: renderTaxDisclosures(taxRun.result.disclosures.filter(row => row.code.startsWith('CGT_')), { rules: resolveTaxRules(year) }) });
}
