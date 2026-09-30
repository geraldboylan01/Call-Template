// Shared by the browser and Worker. A new recording always needs a fresh,
// affirmative choice. Never infer this permission from the case-video consent.
export const VOICE_CONSENT_VERSION = 'case-voice-publication-v1';
export const VOICE_CONSENT_TEXT = 'I agree that Gerry may edit and play this voice note in a case review published on YouTube and planeir.ie. I understand that people may recognise my voice, even if my name is not shown.';
export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
export const VOICE_MAX_DURATION_MS = 120_000;
export const VOICE_TYPES = Object.freeze({
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/webm': 'webm',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav'
});
export function hasVoicePublicationConsent(value) {
  return value?.consentPublication === true && value?.consentVersion === VOICE_CONSENT_VERSION;
}
