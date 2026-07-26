import {
  PLANEIR_ASSUMPTIONS,
  approvedCollegeScenarios,
  assumptionRecord
} from '../planeir_assumptions.js';
import { computeCollegeFundingProjection } from '../../college_funding_math.js';
import {
  createModuleRunResult,
  findGoal,
  getAssumption,
  missing,
  readinessFromMissing
} from './common.js';

export const COLLEGE_FUNDING_ADAPTER_VERSION = '1.0.0';

function isRelevant(profile) {
  if (getAssumption(profile, 'collegeFunding.requested') === true) return true;
  if (findGoal(profile, 'fund_education')) return true;
  // Legacy saved profiles used assess_decision with an education title.
  return Boolean(findGoal(profile, 'assess_decision')?.title?.match(/college|education|university/i));
}

export function getCollegeFundingReadiness(profile) {
  if (!isRelevant(profile)) return readinessFromMissing([], { relevant: false });
  const moduleIds = ['college_funding'];
  const requiredMissing = [];
  if (profile.dependants.length === 0) {
    requiredMissing.push(missing('/dependants', 'Add each child or dependant to include.', moduleIds));
  }
  profile.dependants.forEach((dependant, index) => {
    if (typeof dependant.currentAge !== 'number') {
      requiredMissing.push(missing(`/dependants/${index}/currentAge`, 'Add the current age for college timing.', moduleIds));
    }
  });
  // Cost scenarios are centrally approved Planéir assumptions, so the client is
  // never asked to supply a cost basis they have no way of knowing.
  const assumptionsUsed = [
    assumptionRecord('collegeCosts'),
    assumptionRecord('educationInflation'),
    assumptionRecord('collegeStartAge'),
    assumptionRecord('collegeDuration')
  ];
  return readinessFromMissing(requiredMissing, {
    assumptionsUsed,
    warnings: [PLANEIR_ASSUMPTIONS.collegeFunding.disclosure]
  });
}

export function buildCollegeFundingInput(profile) {
  const settings = getAssumption(profile, 'collegeFunding', {});
  const college = PLANEIR_ASSUMPTIONS.collegeFunding;
  return {
    currentYear: Number(profile.assumptions.calculationDateIso.slice(0, 4)),
    // Education inflation is deliberately higher than general inflation.
    inflationRate: PLANEIR_ASSUMPTIONS.inflation.educationRate,
    children: profile.dependants.map((dependant, index) => ({
      id: dependant.dependantId,
      title: dependant.displayName || `Child ${index + 1}`,
      currentAge: dependant.currentAge,
      collegeStartAge: college.startAge,
      collegeDurationYears: college.durationYears,
      // Per-child scenario selection where the household has expressed one.
      ...(typeof settings.scenarioByChild?.[dependant.dependantId] === 'string'
        ? { scenarioId: settings.scenarioByChild[dependant.dependantId] }
        : {})
    })),
    scenarios: approvedCollegeScenarios()
  };
}

export async function runCollegeFundingAnalysis(input, context) {
  const projection = computeCollegeFundingProjection(input);
  return createModuleRunResult({
    moduleId: 'college_funding',
    moduleVersion: context.moduleVersion,
    input,
    context,
    projection,
    semanticResult: {
      currency: context.baseCurrency || 'EUR',
      firstCollegeYear: projection.debug.collegeStartYear,
      finalCollegeYear: projection.debug.collegeEndYear,
      fundingPeriodYears: projection.debug.fundingPeriodYears,
      costTodayRange: projection.debug.todayRange,
      nominalCostRange: projection.debug.nominalRange,
      peakAnnualCostRange: projection.debug.peakAnnualCostRange
    }
  });
}
