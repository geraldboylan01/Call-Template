// This offer is shown after an analysis, not on the public homepage. Its
// version binds the user's request to the terms shown at that point.
export const EDUCATION_CALL = Object.freeze({
  version: 'private-education-call-v1',
  leadSource: 'consumer-education-call',
  priceMinor: 10000,
  currency: 'EUR',
  priceLabel: '€100',
  durationMinutes: 40,
  platform: 'Zoom',
  heading: 'Talk through your results with Gerry.',
  description: 'Discuss your figures, assumptions and modelled outcomes with Gerry Boylan, the person who built Planéir.',
  action: 'Request a call with Gerry'
});

export function isPrivateEducationCall(lead) {
  return lead?.source === EDUCATION_CALL.leadSource;
}

export function educationCallScheduleIntroduction(lead) {
  return isPrivateEducationCall(lead)
    ? `I can offer the following time for your private education call (${EDUCATION_CALL.priceLabel} for ${EDUCATION_CALL.durationMinutes} minutes on Zoom):`
    : 'I can offer the following time for the free education call:';
}

export function educationCallDuration(lead, legacyDefault = 30) {
  return isPrivateEducationCall(lead) ? EDUCATION_CALL.durationMinutes : legacyDefault;
}
