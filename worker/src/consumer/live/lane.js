/**
 * Which conversation lane owns a meeting.
 *
 * The live lane and the v1/v2 realtime lane are alternative conversation
 * layers over the SAME infrastructure: the same lease table, the same consent,
 * the same cost ledger, the same provider call. Only the Durable Object that
 * drives the conversation differs.
 *
 * `CONSUMER_LIVE_VOICE_ENABLED` is a deployment-wide switch, so exactly one
 * lane is active for any meeting a deployment starts. Resolving the namespace
 * from config here — rather than threading a lane argument through every call
 * site — keeps activation, control and close all pointing at the same object
 * without a per-lease discriminator that could drift out of step.
 */

import { getConsumerConfig } from '../config.js';

export function conversationLaneStub(env, leaseId) {
  const live = getConsumerConfig(env).liveVoiceEnabled === true;
  const namespace = live ? env.CONSUMER_LIVE_SESSIONS : env.CONSUMER_REALTIME_SESSIONS;
  const prefix = live ? 'consumer-live' : 'consumer-realtime';
  if (!namespace
    || typeof namespace.idFromName !== 'function'
    || typeof namespace.get !== 'function') return null;
  return namespace.get(namespace.idFromName(`${prefix}/${leaseId}`));
}
