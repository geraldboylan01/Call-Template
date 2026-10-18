// This offer is shown after an analysis, not on the public homepage. Its
// version binds the user's request to the terms shown at that point.
export const EDUCATION_CALL_V1 = Object.freeze({
  version: 'private-education-call-v1',
  leadSource: 'consumer-education-call',
  priceMinor: 10000,
  currency: 'EUR',
  priceLabel: '€100',
  durationMinutes: 40,
  platform: 'Zoom',
  heading: 'Talk through your results with Gerry.',
  description: 'Discuss your figures, assumptions and modelled outcomes with Gerry Boylan, the person who built Planeir.',
  action: 'Request a call with Gerry'
});

export const EDUCATION_CALL = Object.freeze({
  ...EDUCATION_CALL_V1,
  version: 'private-education-call-v2',
  priceMinor: 9999,
  priceLabel: '€99.99',
  action: 'Choose a walkthrough time',
  timezone: 'Europe/Dublin',
  holdHours: 24,
  horizonDays: 28
});

export function getEducationCallOffer(version) {
  if (version === EDUCATION_CALL.version) return EDUCATION_CALL;
  if (version === EDUCATION_CALL_V1.version) return EDUCATION_CALL_V1;
  return null;
}

export function educationCallOffer(lead) {
  const snapshot = lead?.offerSnapshot || lead?.offer || {};
  const version = lead?.callOfferVersion || snapshot.version;
  const offer = version === EDUCATION_CALL.version ? EDUCATION_CALL : EDUCATION_CALL_V1;
  const priceMinor = Number(snapshot.priceMinor ?? snapshot.amountCents ?? offer.priceMinor);
  return { ...offer, ...snapshot, priceMinor, priceLabel: new Intl.NumberFormat('en-IE', { style: 'currency', currency: snapshot.currency || offer.currency }).format(priceMinor / 100) };
}

export function isPrivateEducationCall(lead) {
  return lead?.source === EDUCATION_CALL.leadSource;
}

export function educationCallScheduleIntroduction(lead) {
  const offer = educationCallOffer(lead);
  return isPrivateEducationCall(lead)
    ? `I can offer the following time for your private education call (${offer.priceLabel} for ${offer.durationMinutes} minutes on Zoom):`
    : 'I can offer the following time for the free education call:';
}

export function educationCallDuration(lead, legacyDefault = 30) {
  return isPrivateEducationCall(lead) ? educationCallOffer(lead).durationMinutes : legacyDefault;
}
