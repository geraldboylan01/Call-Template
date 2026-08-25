/**
 * ACTIVE CALL SESSION LOOKUP — LIVE LANE ONLY.
 *
 * Production calls are always driven by ConsumerLiveSession. The previous
 * controlled realtime Durable Object is retained elsewhere for historical
 * reference and old test fixtures, but it must never be selected here as a
 * deployment fallback.
 */

export function conversationLaneStub(env, leaseId) {
  const namespace = env.CONSUMER_LIVE_SESSIONS;
  if (!namespace
    || typeof namespace.idFromName !== 'function'
    || typeof namespace.get !== 'function') return null;
  return namespace.get(namespace.idFromName(`consumer-live/${leaseId}`));
}
