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
  const scenarios = getAssumption(profile, 'collegeFunding.scenarios');
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    requiredMissing.push(missing(
      '/assumptions/values/collegeFunding/scenarios',
      'Add at least one explicit annual-cost scenario; consumer defaults are not yet approved.',
      moduleIds
    ));
  }
  const assumptionsUsed = [];
  if (typeof profile.assumptions.inflationRate !== 'number') {
    assumptionsUsed.push({ key: 'inflationRate', value: 0.02, reason: 'Existing college engine default; review before activation.' });
  }
  if (!Number.isInteger(getAssumption(profile, 'collegeFunding.startAge'))) {
    assumptionsUsed.push({ key: 'collegeStartAge', value: 18, reason: 'Default start age for a future consumer release.' });
  }
  if (!Number.isInteger(getAssumption(profile, 'collegeFunding.durationYears'))) {
    assumptionsUsed.push({ key: 'collegeDurationYears', value: 4, reason: 'Default duration for a future consumer release.' });
  }
  return readinessFromMissing(requiredMissing, {
    assumptionsUsed,
    warnings: ['College costs must use reviewed, date-versioned scenarios before this module is enabled for consumers.']
  });
}

export function buildCollegeFundingInput(profile) {
  const settings = getAssumption(profile, 'collegeFunding', {});
  return {
    currentYear: Number(profile.assumptions.calculationDateIso.slice(0, 4)),
    inflationRate: profile.assumptions.inflationRate ?? 0.02,
    children: profile.dependants.map((dependant, index) => ({
      id: dependant.dependantId,
      title: dependant.displayName || `Child ${index + 1}`,
      currentAge: dependant.currentAge,
      collegeStartAge: Number.isInteger(settings.startAge) ? settings.startAge : 18,
      collegeDurationYears: Number.isInteger(settings.durationYears) ? settings.durationYears : 4
    })),
    scenarios: settings.scenarios
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

