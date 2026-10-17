import { includeAnsweredSections, normalizeApplication, pruneToVisible } from '../case_application/schema.js';

export const DEMO_POLICY = Object.freeze({
  version: 'demo-v1', privacyNoticeId: 'demo-privacy-v1', termsId: 'demo-terms-v1',
  privacyUrl: 'https://planeir.ie/privacy/', termsUrl: 'https://planeir.ie/terms/'
});
export const DEMO_ACKNOWLEDGEMENTS = Object.freeze(['adultConfirmed', 'educationAcknowledged', 'privacyNoticeAcknowledged', 'termsAccepted']);
export const DEMO_SAVED = 'Your demo request is saved. We’ll email you when access is available. You can update your information using your private link.';
export const DEMO_CONFIRMED = 'Your information is confirmed and saved. Analysis generation is not connected yet.';

export function demoAcknowledgements(values) {
  if (DEMO_ACKNOWLEDGEMENTS.some(key => values?.[key] !== true)) throw new Error('Read and confirm each statement before saving your information.');
  return { ...DEMO_POLICY, ...Object.fromEntries(DEMO_ACKNOWLEDGEMENTS.map(key => [key, true])) };
}

export function normalizeDemoPayload(raw) {
  const fullName = String(raw?.contact?.fullName || '').trim().replace(/\s+/g, ' ');
  const email = String(raw?.contact?.email || '').trim().toLowerCase();
  if (!fullName || fullName.length > 120) throw new Error('Add your name, using no more than 120 characters.');
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (raw?.acknowledgements?.version !== DEMO_POLICY.version) throw new Error('Refresh the page and read the current demo notices.');
  const acknowledgements = demoAcknowledgements(raw.acknowledgements);
  const information = pruneToVisible(includeAnsweredSections(normalizeApplication(raw?.information)));
  delete information.videoName;
  if (information.household?.age !== undefined && information.household.age < 18) throw new Error('The demo is for adults aged 18 or older.');
  return { format: 'planeir.demo-request.v1', contact: { fullName, email }, information, acknowledgements };
}
